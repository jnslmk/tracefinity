import asyncio
import hashlib
import io
import json
import logging
import math
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image
from pydantic import Field
from starlette.requests import Request

logger = logging.getLogger(__name__)

from app.auth import get_user_id, require_instance_admin
from app.config import ensure_user_dirs, settings
from app.constants import GF_GRID, MAX_BIN_GRID_CELLS, MAX_BIN_GRID_UNITS
from app.models.schemas import (
    DEFAULT_SKETCH_NAME,
    BaseModel,
    BinConfig,
    BinDefaults,
    BinListResponse,
    BinModel,
    BinPreviewTool,
    BinProject,
    BinProjectBinsRequest,
    BinProjectCreateBinRequest,
    BinProjectCreateRequest,
    BinProjectDetail,
    BinProjectListResponse,
    BinProjectToolsRequest,
    BinProjectUpdateRequest,
    BinSummary,
    BinUpdateRequest,
    CaptureCrop,
    CornersRequest,
    CornersResponse,
    CreateBinRequest,
    DrawerGridAlignment,
    DrawerOutline,
    DrawerOutlineCandidateRequest,
    DrawerOutlineCandidateResponse,
    DrawerPhotoCalibration,
    FingerHole,
    GenerateRequest,
    GenerateResponse,
    ImportedBinModel,
    PhotoStation,
    PhotoStationCreateRequest,
    PhotoStationListResponse,
    PhotoStationSuggestion,
    PhotoStationSuggestionsResponse,
    PhotoStationUpdateRequest,
    PlacedTool,
    Point,
    Polygon,
    PolygonsRequest,
    ProjectHealthResponse,
    ProjectSketch,
    ProjectSketchCreateRequest,
    ProjectSketchUpdateRequest,
    RedetectCornersResponse,
    ReuseCornersRequest,
    ReuseCornersResponse,
    SaveToolsRequest,
    SaveToolsResponse,
    Session,
    SessionListResponse,
    SessionSummary,
    SessionUpdateRequest,
    StackActionRequest,
    StatusResponse,
    Tool,
    ToolDetailResponse,
    ToolListResponse,
    ToolSummary,
    ToolUpdateRequest,
    TraceRequest,
    TraceResponse,
    UploadResponse,
)
from app.services.ai_tracer import AITracer
from app.services.bin_service import sync_placed_tools
from app.services.bin_store import BinStore
from app.services.drawer_outline import point_in_polygon, ring_from_points, validate_outline
from app.services.geometry import optimal_rotation_angle as _optimal_rotation_angle
from app.services.image_ingest import ImageTooLargeError, ingest_image
from app.services.image_processor import ImageProcessor
from app.services.image_service import generate_tool_thumbnail
from app.services.imported_bins import (
    MAX_IMPORT_BYTES,
    StlImportError,
    process_import,
    store_import_asset,
)
from app.services.photo_checks import check_photo, extract_focal_length_35mm
from app.services.photo_station_store import PhotoStationStore
from app.services.pocket_depths import mating_increment_mm, needs_mating_increment, resolved_overrides
from app.services.polygon_scaler import PolygonScaler, ScaledFingerHole, ScaledPolygon
from app.services.project_service import (
    add_bin_to_project,
    add_project_to_tools,
    drop_bins_from_layout,
    get_sketch,
    health_response,
    make_project_detail,
    make_project_summary,
    project_health,
    remove_bin_from_all_projects,
    remove_bin_from_project,
    remove_project_from_tools,
    repair_project_links,
    transform_moved_stacks,
    validate_bin_layout,
)
from app.services.project_store import ProjectStore
from app.services.session_store import SessionStore
from app.services.stl_generator_manifold import STL_GEOMETRY_VERSION, ManifoldSTLGenerator
from app.services.store_errors import StoreClosedError
from app.services.tool_namer import name_polygons
from app.services.tool_store import ToolStore
from app.services.toolbox_planning import (
    assess_bin,
    assess_plan,
    footprint,
    generation_polygons,
    height_proposals,
    support_problem,
)
from app.services.tracer_registry import TRACER_LABELS, tracer_kind, validate_tracer_ids

router = APIRouter()

# Heuristic mismatch score combining a label penalty with bbox and point deltas measured in mm.
SOURCE_POLYGON_MATCH_MAX_SCORE = 80.0

# Fail fast for misspelled TRACERS values without loading local model weights.
validate_tracer_ids(settings.available_tracers)

# per-user store registry
_store_cache: dict[str, tuple[SessionStore, ToolStore, BinStore]] = {}
_project_store_cache: dict[str, ProjectStore] = {}
_photo_station_store_cache: dict[str, PhotoStationStore] = {}

# serialises store creation against user deletion so a store cannot be
# built from files that are mid-rmtree (issue #160). locks are never
# removed; the dict is bounded by the number of user ids seen.
_user_locks: dict[str, threading.Lock] = {}
_user_locks_guard = threading.Lock()


def user_lock(user_id: str) -> threading.Lock:
    with _user_locks_guard:
        return _user_locks.setdefault(user_id, threading.Lock())


def get_stores(user_id: str) -> tuple[SessionStore, ToolStore, BinStore]:
    with user_lock(user_id):
        if user_id not in _store_cache:
            user_path = settings.storage_path / user_id
            ensure_user_dirs(user_path)
            _store_cache[user_id] = (
                SessionStore(user_path),
                ToolStore(user_path),
                BinStore(user_path),
            )
        return _store_cache[user_id]


def get_project_store(user_id: str) -> ProjectStore:
    with user_lock(user_id):
        if user_id not in _project_store_cache:
            user_path = settings.storage_path / user_id
            ensure_user_dirs(user_path)
            _project_store_cache[user_id] = ProjectStore(user_path)
        return _project_store_cache[user_id]


def get_photo_station_store(user_id: str) -> PhotoStationStore:
    with user_lock(user_id):
        if user_id not in _photo_station_store_cache:
            user_path = settings.storage_path / user_id
            ensure_user_dirs(user_path)
            _photo_station_store_cache[user_id] = PhotoStationStore(user_path)
        return _photo_station_store_cache[user_id]


def _require_photo_stations_enabled():
    if not settings.photo_stations:
        raise HTTPException(status_code=404, detail="photo stations not found")


def _user_path(user_id: str) -> Path:
    # defence-in-depth: even if get_user_id is bypassed, block escaping storage root
    result = (settings.storage_path / user_id).resolve()
    if not result.is_relative_to(settings.storage_path.resolve()):
        raise HTTPException(status_code=400, detail="invalid user path")
    return result


def _reject_imported_mutation(bin_data: BinModel) -> None:
    """Imported geometry is planning-only: config, tools and text are read-only."""
    if bin_data.imported_model is not None:
        raise HTTPException(
            status_code=400,
            detail="imported bins are read-only; only the name and project can be changed",
        )


def _validated_outline(outline: DrawerOutline | None) -> DrawerOutline | None:
    """Reject a boundary that is not finite, simple and non-empty before it is saved."""
    if outline is None:
        return None
    try:
        validate_outline(
            ring_from_points(outline.points),
            [ring_from_points(ring) for ring in outline.interior_rings],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return outline


def _plan_photo_dir(user_id: str, sketch_id: str) -> Path:
    root = _user_path(user_id) / "projects"
    target = (root / sketch_id).resolve()
    if target.parent != root.resolve() or target.name != sketch_id:
        raise HTTPException(status_code=400, detail="invalid plan source path")
    return target


def _remove_plan_source(user_id: str, sketch_id: str, source: DrawerPhotoCalibration | None) -> None:
    """Best-effort removal of only this source's owned files, never a session or another plan.

    Disposal of obsolete copies runs after the matching metadata commit, so a
    filesystem error here must not turn a committed replacement into a failed
    request: a leftover unreferenced copy is harmless, a misreported failure is
    not. The images still committed to the plan are never among those removed.
    """
    if source is None:
        return
    try:
        owner = _plan_photo_dir(user_id, sketch_id)
        parents = set()
        for url in (source.original_image_url, source.corrected_image_url):
            if not url:
                continue
            path = Path(_abs(url.removeprefix("/storage/"))).resolve()
            if path.is_relative_to(owner):
                path.unlink(missing_ok=True)
                parents.add(path.parent)
        for parent in parents:
            if parent != owner and parent.exists() and not any(parent.iterdir()):
                parent.rmdir()
    except OSError:
        logger.warning("could not remove an obsolete plan source for sketch %s", sketch_id, exc_info=True)


def _calibration_from_session(
    session_id: str,
    user_id: str,
    seed: Point | None = None,
    sketch_id: str | None = None,
) -> DrawerPhotoCalibration:
    """Read calibration; adoption stages validated images at a new owned address.

    No currently referenced file is overwritten. The caller commits the matching
    calibration and removes the staged source on a failed metadata write.
    """
    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session or not session.corrected_image_path or not session.scale_factor:
        raise HTTPException(status_code=400, detail="calibrate the photo before using it as a plan source")
    if not session.paper_size or not session.corners:
        raise HTTPException(status_code=400, detail="the photo session has no paper calibration")
    up = _user_path(user_id)
    corrected_src = _abs(session.corrected_image_path)
    original_src = _abs(session.original_image_path) if session.original_image_path else None

    target = None
    try:
        if sketch_id:
            if not original_src or not Path(original_src).is_file():
                raise HTTPException(status_code=400, detail="the uncorrected source photo is no longer available")
            target = _plan_photo_dir(user_id, sketch_id) / str(uuid.uuid4())
            target.mkdir(parents=True)
            corrected_dst = target / f"corrected{Path(corrected_src).suffix or '.jpg'}"
            original_dst = target / f"original{Path(original_src).suffix or '.jpg'}"
            shutil.copy2(corrected_src, corrected_dst)
            shutil.copy2(original_src, original_dst)
            corrected_src, original_src = str(corrected_dst), str(original_dst)
            with Image.open(original_src) as im:
                im.load()

        with Image.open(corrected_src) as im:
            im.load()
            image_width, image_height = im.size
        return DrawerPhotoCalibration(
            session_id=session.id,
            corrected_image_url=f"/storage/{_rel(corrected_src, up)}",
            original_image_url=f"/storage/{_rel(original_src, up)}" if original_src else None,
            image_width=image_width,
            image_height=image_height,
            paper_size=session.paper_size,
            scale_factor=session.scale_factor,
            corners=session.corners,
            seed=seed,
        )
    except Exception:
        if target is not None:
            # the caller reports the original failure; a leftover staged copy is
            # unreferenced, and rmtree must not replace that failure with its own
            shutil.rmtree(target, ignore_errors=True)
        raise


ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif"}
MAX_UPLOAD_DIM = 2048
CAPTURE_CROP_ORIGIN_TOLERANCE = 0.001
CAPTURE_CROP_SIZE_TOLERANCE = 0.001
CAPTURE_CROP_MAX_BOUND = 1.0 + CAPTURE_CROP_SIZE_TOLERANCE


def _is_full_capture_crop(crop: CaptureCrop | None) -> bool:
    if crop is None:
        return True
    return (
        crop.x <= CAPTURE_CROP_ORIGIN_TOLERANCE
        and crop.y <= CAPTURE_CROP_ORIGIN_TOLERANCE
        and crop.width >= 1.0 - CAPTURE_CROP_SIZE_TOLERANCE
        and crop.height >= 1.0 - CAPTURE_CROP_SIZE_TOLERANCE
    )


def _parse_capture_crop(value: str | None) -> CaptureCrop | None:
    if not value:
        return None
    try:
        crop = CaptureCrop.model_validate(json.loads(value))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid capture area") from exc
    if crop.x + crop.width > CAPTURE_CROP_MAX_BOUND or crop.y + crop.height > CAPTURE_CROP_MAX_BOUND:
        raise HTTPException(status_code=400, detail="capture area is outside the image")
    return crop


image_processor = ImageProcessor()

# one AITracer per local model so each can cache its loaded model
_tracers: dict[str, AITracer] = {}


def _ingest_with_limits(
    content: bytes,
    ext: str,
    max_dim: int | None = None,
    capture_crop: CaptureCrop | None = None,
) -> tuple[bytes, str, float]:
    try:
        return ingest_image(
            content,
            ext,
            max_dim,
            max_pixels=settings.max_image_pixels,
            capture_crop=capture_crop,
        )
    except ImageTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc


def _remote_token(tracer_id: str) -> str | None:
    return settings.replicate_api_token if tracer_id == "replicate" else settings.fal_key


def _get_tracer(tracer_id: str | None = None) -> AITracer:
    """get or create a tracer for the given ID."""
    tid = tracer_id or settings.available_tracers[0]
    if tid not in _tracers:
        kind = tracer_kind(tid)
        if kind == "gemini":
            _tracers[tid] = AITracer(
                model=settings.gemini_image_model,
                openrouter_key=settings.openrouter_api_key,
                openrouter_image_model=settings.openrouter_image_model,
            )
        elif kind == "remote":
            token = _remote_token(tid)
            model = settings.replicate_model if tid == "replicate" else settings.fal_model
            _tracers[tid] = AITracer(
                saliency_tracer=tid,
                remote_model=model,
                remote_token=token,
                fal_operating_resolution=settings.fal_operating_resolution,
                replicate_resolution=settings.replicate_resolution,
            )
        else:
            _tracers[tid] = AITracer(saliency_tracer=tid)
    return _tracers[tid]


polygon_scaler = PolygonScaler()
stl_generator = ManifoldSTLGenerator()
STL_GENERATION_QUEUE_TIMEOUT_SECONDS = 5.0
_stl_generation_semaphore = (
    threading.BoundedSemaphore(settings.stl_generation_concurrency)
    if settings.stl_generation_concurrency is not None
    else None
)


def _rel(abs_path: str | Path, user_path: Path) -> str:
    """store path relative to storage root (includes user_id prefix)"""
    return Path(abs_path).resolve().relative_to(Path(settings.storage_path).resolve()).as_posix()


def _abs(rel_path: str | None) -> str | None:
    """resolve stored relative path back to absolute"""
    if not rel_path:
        return None
    return str(settings.storage_path / rel_path)


def _safe_unlink(rel_path: str | None):
    abs_path = _abs(rel_path)
    if abs_path:
        Path(abs_path).unlink(missing_ok=True)


def _copy_station_image(user_id: str, source_path: str | Path | None, station_id: str) -> str | None:
    if not source_path:
        return None
    source = Path(source_path)
    if not source.exists():
        return None

    up = _user_path(user_id)
    station_dir = up / "station-photos"
    station_dir.mkdir(parents=True, exist_ok=True)
    target = station_dir / f"{station_id}{source.suffix}"
    shutil.copy2(source, target)
    return _rel(target, up)


MAX_STATION_DIMENSION_DELTA_PERCENT = 2.0
STATION_DRIFT_WARNING_PERCENT = 1.5


def _image_dimensions(content: bytes) -> tuple[int, int]:
    img = Image.open(io.BytesIO(content))
    return img.size


def _session_image_dimensions(session: Session) -> tuple[int, int]:
    if not session.original_image_width or not session.original_image_height:
        raise HTTPException(status_code=400, detail="session has no upload dimensions")
    return session.original_image_width, session.original_image_height


def _create_photo_station(
    user_id: str,
    session: Session,
    name: str,
    paper_size: str | None,
    corners: list[Point] | None,
    source_image_path: str | Path | None = None,
) -> PhotoStation:
    if not corners or len(corners) != 4 or not paper_size:
        raise HTTPException(status_code=400, detail="session must have confirmed corners")

    image_width, image_height = _session_image_dimensions(session)
    now = _now_iso()
    station_id = str(uuid.uuid4())
    source_image = source_image_path or _abs(session.original_image_path)
    station = PhotoStation(
        id=station_id,
        name=name.strip() or f"Station {now[:10]}",
        image_width=image_width,
        image_height=image_height,
        image_path=_copy_station_image(user_id, source_image, station_id),
        capture_crop=session.capture_crop,
        paper_size=paper_size,
        corners=corners,
        created_at=now,
        updated_at=now,
    )
    get_photo_station_store(user_id).set(station.id, station)
    return station


def _dimension_delta_percent(station_value: int, session_value: int) -> float:
    if station_value <= 0:
        return 100.0
    return abs(session_value - station_value) / station_value * 100.0


def _scaled_station_corners(station: PhotoStation, image_width: int, image_height: int) -> list[Point]:
    sx = image_width / station.image_width
    sy = image_height / station.image_height
    return [Point(x=p.x * sx, y=p.y * sy) for p in station.corners]


def _station_suggestion(station: PhotoStation, session: Session) -> PhotoStationSuggestion:
    image_width, image_height = _session_image_dimensions(session)
    width_delta = _dimension_delta_percent(station.image_width, image_width)
    height_delta = _dimension_delta_percent(station.image_height, image_height)
    max_delta = max(width_delta, height_delta)
    match_status = "exact" if width_delta == 0 and height_delta == 0 else "near" if max_delta <= MAX_STATION_DIMENSION_DELTA_PERCENT else "far"

    warnings: list[str] = []
    if match_status == "near":
        warnings.append("Image size differs from the saved station. Check corners before continuing.")
    elif match_status == "far":
        warnings.append("Image size differs too much from the saved station.")

    max_corner_drift_px: float | None = None
    max_corner_drift_percent: float | None = None
    if session.corners and len(session.corners) == 4:
        scaled = _scaled_station_corners(station, image_width, image_height)
        deltas = [
            math.hypot(detected.x - saved.x, detected.y - saved.y)
            for detected, saved in zip(session.corners, scaled)
        ]
        max_corner_drift_px = max(deltas) if deltas else 0.0
        diagonal = math.hypot(image_width, image_height)
        max_corner_drift_percent = (max_corner_drift_px / diagonal * 100.0) if diagonal else 0.0
        if max_corner_drift_percent >= STATION_DRIFT_WARNING_PERCENT:
            warnings.append("Detected paper corners differ from this station.")
    elif session.corners is None:
        warnings.append("No paper was detected in this upload. Reused corners must be checked manually.")

    return PhotoStationSuggestion(
        station=station,
        match_status=match_status,
        width_delta_percent=round(width_delta, 3),
        height_delta_percent=round(height_delta, 3),
        max_corner_drift_px=round(max_corner_drift_px, 2) if max_corner_drift_px is not None else None,
        max_corner_drift_percent=round(max_corner_drift_percent, 3) if max_corner_drift_percent is not None else None,
        warnings=warnings,
    )


def _translate_points(points: list[Point], dx: float, dy: float) -> list[Point]:
    return [Point(x=p.x + dx, y=p.y + dy) for p in points]


def _translate_finger_holes(holes: list[FingerHole], dx: float, dy: float) -> list[FingerHole]:
    return [fh.model_copy(update={"x": fh.x + dx, "y": fh.y + dy}) for fh in holes]


def _polygon_source_transform(poly: Polygon, scale_factor: float) -> tuple[float, float] | None:
    """return image-pixel origin in the centered tool's mm coordinate space."""
    points_mm = [(p.x * scale_factor, p.y * scale_factor) for p in poly.points]
    if not points_mm:
        return None
    xs = [p[0] for p in points_mm]
    ys = [p[1] for p in points_mm]
    cx = (min(xs) + max(xs)) / 2
    cy = (min(ys) + max(ys)) / 2
    return -cx, -cy


def _bounds_mm(points: list[Point]) -> tuple[float, float, float, float] | None:
    if not points:
        return None
    xs = [p.x for p in points]
    ys = [p.y for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def _source_polygon_score(tool: Tool, candidate: list[Point], label: str) -> float:
    score = 0.0 if label == tool.name else 25.0
    tool_bounds = _bounds_mm(tool.points)
    candidate_bounds = _bounds_mm(candidate)
    if tool_bounds and candidate_bounds:
        tool_min_x, tool_min_y, tool_max_x, tool_max_y = tool_bounds
        cand_min_x, cand_min_y, cand_max_x, cand_max_y = candidate_bounds
        score += abs((tool_max_x - tool_min_x) - (cand_max_x - cand_min_x))
        score += abs((tool_max_y - tool_min_y) - (cand_max_y - cand_min_y))
    if len(tool.points) == len(candidate):
        total = 0.0
        for a, b in zip(tool.points, candidate):
            total += math.hypot(a.x - b.x, a.y - b.y)
        score += total / max(1, len(candidate))
    else:
        score += min(30.0, abs(len(tool.points) - len(candidate)) * 0.5)
    return score


def _find_source_polygon(tool: Tool, session: Session) -> Polygon | None:
    if not session.polygons:
        return None
    if tool.source_polygon_id:
        for poly in session.polygons:
            if poly.id == tool.source_polygon_id:
                return poly
    if not session.scale_factor:
        return None

    best: tuple[float, Polygon] | None = None
    for poly in session.polygons:
        centered, _, _ = polygon_scaler.scale_and_centre(poly, session.scale_factor)
        if not centered:
            continue
        score = _source_polygon_score(tool, centered, poly.label)
        if best is None or score < best[0]:
            best = (score, poly)

    return best[1] if best and best[0] < SOURCE_POLYGON_MATCH_MAX_SCORE else None


def _tool_image_context(tool: Tool, sessions: SessionStore, load_missing_dimensions: bool = True) -> tuple[dict, bool] | tuple[None, bool]:
    updated = False
    image_path = tool.source_image_path
    width = tool.source_image_width
    height = tool.source_image_height
    transform = tool.source_image_transform if tool.source_image_transform and len(tool.source_image_transform) == 6 else None

    if (
        (not image_path or transform is None)
        and tool.source_session_id
    ):
        session = sessions.get(tool.source_session_id)
        if session and session.corrected_image_path and session.scale_factor:
            poly = _find_source_polygon(tool, session)
            source_origin = _polygon_source_transform(poly, session.scale_factor) if poly else None
            if source_origin:
                image_path = session.corrected_image_path
                if tool.source_image_path != image_path:
                    tool.source_image_path = image_path
                    updated = True
                transform = [
                    session.scale_factor, 0.0, 0.0, session.scale_factor,
                    source_origin[0], source_origin[1],
                ]
                if tool.source_image_transform != transform:
                    tool.source_image_transform = transform
                    updated = True

    if not image_path or transform is None:
        return None, updated

    abs_path = _abs(image_path)
    if not abs_path or not Path(abs_path).exists():
        return None, updated

    if width is None or height is None:
        if not load_missing_dimensions:
            return None, updated
        try:
            with Image.open(abs_path) as img:
                width, height = img.size
            if tool.source_image_width != width or tool.source_image_height != height:
                tool.source_image_width = width
                tool.source_image_height = height
                updated = True
        except Exception:
            return None, updated

    return {
        "image_url": f"/storage/{image_path}",
        "image_width": width,
        "image_height": height,
        "origin_x_mm": transform[4],
        "origin_y_mm": transform[5],
        "scale_factor": math.hypot(transform[0], transform[1]),
        "transform": transform,
    }, updated


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_bin_from_tools(
    bin_id: str,
    name: str | None,
    project_id: str | None,
    tool_ids: list[str],
    user_tools: ToolStore,
    default_config: BinDefaults | None = None,
) -> BinModel:
    placed: list[PlacedTool] = []
    all_points_mm: list[tuple[float, float]] = []

    for tool_id in tool_ids:
        tool = user_tools.get(tool_id)
        if not tool:
            raise HTTPException(status_code=404, detail=f"tool {tool_id} not found")

        all_points_mm.extend([(p.x, p.y) for p in tool.points])
        placed.append(PlacedTool(
            id=str(uuid.uuid4()),
            tool_id=tool_id,
            name=tool.name,
            points=list(tool.points),
            finger_holes=list(tool.finger_holes),
            interior_rings=list(tool.interior_rings),
        ))

    if default_config is None:
        # a brand new bin derives per-tool depths unless saved defaults say otherwise
        default_config = BinDefaults(cutout_depth_mode="automatic")
    bc = BinConfig(**default_config.model_dump(exclude={"text_labels"}), text_labels=[])
    if all_points_mm:
        all_xs = [p[0] for p in all_points_mm]
        all_ys = [p[1] for p in all_points_mm]
        tool_width = max(all_xs) - min(all_xs)
        tool_height = max(all_ys) - min(all_ys)

        clearance = bc.cutout_clearance
        wall = bc.wall_thickness
        needed_w = tool_width + 2 * clearance + 2 * wall + 0.5
        needed_h = tool_height + 2 * clearance + 2 * wall + 0.5

        # snap to 0.5 units when half-grid is on, whole units otherwise
        if bc.half_grid_base:
            half = GF_GRID / 2
            grid_x = max(1.0, math.ceil(needed_w / half) * 0.5)
            grid_y = max(1.0, math.ceil(needed_h / half) * 0.5)
        else:
            grid_x = max(1.0, math.ceil(needed_w / GF_GRID))
            grid_y = max(1.0, math.ceil(needed_h / GF_GRID))
        grid_cells = math.ceil(grid_x) * math.ceil(grid_y)
        if grid_x > MAX_BIN_GRID_UNITS or grid_y > MAX_BIN_GRID_UNITS or grid_cells > MAX_BIN_GRID_CELLS:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"selected tools require a {grid_x:g}x{grid_y:g} grid ({grid_cells} cells); "
                    f"bins support up to {MAX_BIN_GRID_UNITS:g} units per axis and "
                    f"{MAX_BIN_GRID_CELLS} cells total"
                ),
            )
        bc.grid_x = grid_x
        bc.grid_y = grid_y
        bc.partial_bins_values = [True] * (math.ceil(bc.grid_x) * math.ceil(bc.grid_y))

        bin_w = bc.grid_x * GF_GRID
        bin_h = bc.grid_y * GF_GRID
        bbox_cx = (min(all_xs) + max(all_xs)) / 2
        bbox_cy = (min(all_ys) + max(all_ys)) / 2
        offset_x = bin_w / 2 - bbox_cx
        offset_y = bin_h / 2 - bbox_cy
        for pt in placed:
            pt.points = _translate_points(pt.points, offset_x, offset_y)
            pt.finger_holes = _translate_finger_holes(pt.finger_holes, offset_x, offset_y)
            pt.interior_rings = [_translate_points(ring, offset_x, offset_y) for ring in pt.interior_rings]

    return BinModel(
        id=bin_id,
        name=name,
        project_id=project_id,
        bin_config=bc,
        placed_tools=placed,
        created_at=_now_iso(),
    )


def _run_generate(
    scaled: list[ScaledPolygon],
    gen_req: GenerateRequest,
    entity_id: str,
    user_path: Path,
    input_hash: str,
    user_id: str,
    store: SessionStore | BinStore,
) -> GenerateResponse:
    """shared STL generation with caching, splitting, and zipping"""
    input_hash = f"{STL_GEOMETRY_VERSION}:{input_hash}"
    # in-flight guard: the request captured its store before any awaits or
    # threadpool hops; refuse to write outputs once the user is deleted
    store.ensure_open()
    output_path = user_path / "outputs" / f"{entity_id}.stl"
    hash_path = user_path / "outputs" / f"{entity_id}.hash"
    threemf_path = user_path / "outputs" / f"{entity_id}.3mf"
    zip_path = user_path / "outputs" / f"{entity_id}_parts.zip"
    insert_path = user_path / "outputs" / f"{entity_id}_insert.stl"

    def cached_response() -> GenerateResponse | None:
        if not (output_path.exists() and hash_path.exists() and hash_path.read_text() == input_hash):
            return None
        part_paths = sorted(user_path.glob(f"outputs/{entity_id}_part*.stl"))
        # cache hits rewrite nothing, so refresh mtimes or the retention
        # sweep could purge artefacts a live page was just handed urls for
        for artefact in (output_path, hash_path, threemf_path, zip_path, insert_path, *part_paths):
            try:
                os.utime(artefact)
            except FileNotFoundError:
                pass
        stl_urls = [f"/storage/{user_id}/outputs/{p.name}" for p in part_paths]
        insert_stl_url = (
            f"/storage/{user_id}/outputs/{entity_id}_insert.stl"
            if insert_path.exists() else None
        )
        cached_warning = None
        if getattr(gen_req, 'insert_enabled', False) and not insert_path.exists():
            cached_warning = "Insert generation failed. Try re-tracing the tools or adjusting their placement."
        return GenerateResponse(
            stl_url=f"/storage/{user_id}/outputs/{entity_id}.stl",
            stl_urls=stl_urls,
            threemf_url=f"/storage/{user_id}/outputs/{entity_id}.3mf" if threemf_path.exists() else None,
            split_count=max(1, len(stl_urls)),
            zip_url=f"/storage/{user_id}/outputs/{entity_id}_parts.zip" if zip_path.exists() else None,
            insert_stl_url=insert_stl_url,
            warning=cached_warning,
        )

    cached = cached_response()
    if cached is not None:
        return cached

    # generation is CPU- and memory-intensive. When configured, briefly wait
    # for a process-wide slot instead of tying up a threadpool worker forever.
    if _stl_generation_semaphore is not None:
        acquired = _stl_generation_semaphore.acquire(
            timeout=STL_GENERATION_QUEUE_TIMEOUT_SECONDS
        )
        if not acquired:
            raise HTTPException(
                status_code=503,
                detail="STL generation is busy; try again shortly.",
                headers={"Retry-After": str(int(STL_GENERATION_QUEUE_TIMEOUT_SECONDS))},
            )
        try:
            # the store may have been closed while this request waited.
            store.ensure_open()
            # an identical request may also have populated the cache.
            cached = cached_response()
            if cached is not None:
                return cached
            return _generate_uncached(
                scaled,
                gen_req,
                entity_id,
                user_path,
                input_hash,
                user_id,
                output_path,
                hash_path,
                threemf_path,
                zip_path,
                insert_path,
            )
        finally:
            _stl_generation_semaphore.release()

    return _generate_uncached(
        scaled,
        gen_req,
        entity_id,
        user_path,
        input_hash,
        user_id,
        output_path,
        hash_path,
        threemf_path,
        zip_path,
        insert_path,
    )


def _generate_uncached(
    scaled: list[ScaledPolygon],
    gen_req: GenerateRequest,
    entity_id: str,
    user_path: Path,
    input_hash: str,
    user_id: str,
    output_path: Path,
    hash_path: Path,
    threemf_path: Path,
    zip_path: Path,
    insert_path: Path,
) -> GenerateResponse:
    """Generate and persist an STL after cache and concurrency checks."""
    threemf_path.unlink(missing_ok=True)
    for old in user_path.glob(f"outputs/{entity_id}_part*.stl"):
        old.unlink(missing_ok=True)
    zip_path.unlink(missing_ok=True)
    insert_path.unlink(missing_ok=True)

    bin_body, text_body = stl_generator.generate_bin(scaled, gen_req, str(output_path), str(threemf_path))

    stl_urls: list[str] = []
    zip_url = None
    output_dir = str(user_path / "outputs")
    part_paths = stl_generator.export_split_parts(
        bin_body, text_body, gen_req, gen_req.bed_size, output_dir, entity_id
    )
    if part_paths:
        stl_urls = [f"/storage/{user_id}/outputs/{Path(p).name}" for p in part_paths]
        part_bytes = [(Path(p).name, Path(p).read_bytes()) for p in part_paths]
        with zipfile.ZipFile(str(zip_path), 'w', zipfile.ZIP_DEFLATED) as zf:
            for fname, data in part_bytes:
                zf.writestr(fname, data)
        zip_url = f"/storage/{user_id}/outputs/{entity_id}_parts.zip"

    insert_stl_url = None
    warning = None
    if getattr(gen_req, 'insert_enabled', False) and scaled:
        bin_width = gen_req.grid_x * GF_GRID
        bin_depth = gen_req.grid_y * GF_GRID
        offset_x = -bin_width / 2
        offset_y = -bin_depth / 2
        try:
            success = stl_generator.generate_insert(scaled, gen_req, str(insert_path), offset_x, offset_y)
        except Exception:
            logger.exception("insert generation crashed")
            success = False
        if success:
            insert_stl_url = f"/storage/{user_id}/outputs/{entity_id}_insert.stl"
            if zip_path.exists():
                with zipfile.ZipFile(str(zip_path), 'a') as zf:
                    zf.write(str(insert_path), f"{entity_id}_insert.stl")
            else:
                with zipfile.ZipFile(str(zip_path), 'w', zipfile.ZIP_DEFLATED) as zf:
                    zf.write(str(output_path), f"{entity_id}.stl")
                    zf.write(str(insert_path), f"{entity_id}_insert.stl")
                zip_url = f"/storage/{user_id}/outputs/{entity_id}_parts.zip"
        else:
            warning = "Insert generation failed. Try re-tracing the tools or adjusting their placement."

    hash_path.write_text(input_hash)

    threemf_url = None
    if threemf_path.exists():
        threemf_url = f"/storage/{user_id}/outputs/{entity_id}.3mf"

    return GenerateResponse(
        stl_url=f"/storage/{user_id}/outputs/{entity_id}.stl",
        stl_urls=stl_urls,
        threemf_url=threemf_url,
        split_count=max(1, len(stl_urls)),
        zip_url=zip_url,
        insert_stl_url=insert_stl_url,
        warning=warning,
    )


@router.post("/upload", response_model=UploadResponse)
async def upload_image(
    request: Request,
    image: UploadFile = File(...),
    station_id: str | None = Form(None),
    capture_crop: str | None = Form(None),
    user_id: str = Depends(get_user_id),
):
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="file must be an image")

    user_sessions, _, _ = get_stores(user_id)
    up = _user_path(user_id)

    session_id = str(uuid.uuid4())
    ext = Path(image.filename or "image.jpg").suffix.lower() or ".jpg"
    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="unsupported image format")

    if station_id or capture_crop:
        _require_photo_stations_enabled()

    max_bytes = settings.max_upload_mb * 1024 * 1024
    content = await image.read()
    if len(content) > max_bytes:
        raise HTTPException(status_code=413, detail=f"file too large (max {settings.max_upload_mb}MB)")

    # exif is dropped when the image is re-encoded, so read it first
    focal_length = extract_focal_length_35mm(content)

    station = None
    if station_id:
        station = get_photo_station_store(user_id).get(station_id)
        if not station:
            raise HTTPException(status_code=404, detail="photo station not found")

    requested_crop = _parse_capture_crop(capture_crop)
    applied_crop = requested_crop if requested_crop is not None else station.capture_crop if station else None

    ingest_crop = None if _is_full_capture_crop(applied_crop) else applied_crop
    content, ext, _ = _ingest_with_limits(
        content, ext, MAX_UPLOAD_DIM, capture_crop=ingest_crop
    )
    image_width, image_height = _image_dimensions(content)
    image_path = up / "uploads" / f"{session_id}{ext}"

    paper_size = None
    applied_station_id = None
    if station:
        width_delta = _dimension_delta_percent(station.image_width, image_width)
        height_delta = _dimension_delta_percent(station.image_height, image_height)
        if max(width_delta, height_delta) > MAX_STATION_DIMENSION_DELTA_PERCENT:
            raise HTTPException(status_code=400, detail="photo station image size differs too much from this upload")

        corner_points = _scaled_station_corners(station, image_width, image_height)
        paper_size = station.paper_size
        applied_station_id = station.id

    # the awaited read can outlive a concurrent account deletion; refuse
    # to write into the deleted user's tree
    user_sessions.ensure_open()
    image_path.write_bytes(content)

    if station:
        station.last_used_at = _now_iso()
        get_photo_station_store(user_id).set(station.id, station)
    else:
        corners = image_processor.detect_paper_corners(str(image_path))
        corner_points = [Point(x=c[0], y=c[1]) for c in corners] if corners else None

    user_sessions.set(session_id, Session(
        id=session_id,
        created_at=_now_iso(),
        original_image_path=_rel(image_path, up),
        original_image_width=image_width,
        original_image_height=image_height,
        capture_crop=None if _is_full_capture_crop(applied_crop) else applied_crop,
        corners=corner_points,
        focal_length_35mm=focal_length,
        paper_size=paper_size,
    ))

    return UploadResponse(
        session_id=session_id,
        image_url=f"/storage/{user_id}/uploads/{session_id}{ext}",
        detected_corners=corner_points,
        image_width=image_width,
        image_height=image_height,
        corner_source="station" if applied_station_id else "detected" if corner_points else "none",
        station_id=applied_station_id,
    )


@router.post("/sessions/{session_id}/corners", response_model=CornersResponse)
async def set_corners(request: Request, session_id: str, req: CornersRequest, user_id: str = Depends(get_user_id)):
    if req.save_station_name is not None:
        _require_photo_stations_enabled()

    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session or not session.original_image_path:
        raise HTTPException(status_code=404, detail="session not found")

    corners = [(p.x, p.y) for p in req.corners]

    # advisory photo checks run against the original before it is deleted
    photo_warnings = []
    try:
        with Image.open(_abs(session.original_image_path)) as im:
            img_w, img_h = im.size
        photo_warnings = check_photo(
            corners, img_w, img_h, req.paper_size, session.focal_length_35mm
        )
    except Exception:
        logger.exception("photo checks skipped")

    output_path, scale_factor = image_processor.apply_perspective_correction(
        _abs(session.original_image_path), corners, req.paper_size
    )

    # resize the corrected image to save storage; adjust scale_factor so
    # pixel→mm conversion stays correct after the image shrinks.
    corrected_bytes = Path(output_path).read_bytes()
    ext = Path(output_path).suffix
    corrected_bytes, _, ds_ratio = _ingest_with_limits(corrected_bytes, ext, MAX_UPLOAD_DIM)
    Path(output_path).write_bytes(corrected_bytes)
    if ds_ratio < 1.0:
        scale_factor /= ds_ratio

    up = _user_path(user_id)
    orig_path = _abs(session.original_image_path)
    created_station: PhotoStation | None = None
    if req.save_station_name is not None:
        created_station = _create_photo_station(
            user_id=user_id,
            session=session,
            name=req.save_station_name,
            paper_size=req.paper_size,
            corners=req.corners,
            source_image_path=orig_path,
        )

    # the original is discarded with the correction unless the caller is keeping
    # it as a plan source (the drawer photo flow sets retain_original)
    if not req.retain_original and orig_path:
        Path(orig_path).unlink(missing_ok=True)
    session.corrected_image_path = _rel(output_path, up)
    if not req.retain_original:
        session.original_image_path = None
    session.corners = req.corners
    session.paper_size = req.paper_size
    session.scale_factor = scale_factor
    session.photo_warnings = photo_warnings or None
    user_sessions.set(session_id, session)

    return CornersResponse(
        corrected_image_url=f"/storage/{session.corrected_image_path}",
        scale_factor=scale_factor,
        warnings=photo_warnings,
        station=created_station,
    )


@router.post("/sessions/{session_id}/redetect-corners", response_model=RedetectCornersResponse)
async def redetect_corners(request: Request, session_id: str, user_id: str = Depends(get_user_id)):
    _require_photo_stations_enabled()

    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session or not session.original_image_path:
        raise HTTPException(status_code=404, detail="session original image not found")

    detected = image_processor.detect_paper_corners(_abs(session.original_image_path))
    if not detected:
        raise HTTPException(status_code=422, detail="paper corners not detected")

    corners = [Point(x=c[0], y=c[1]) for c in detected]
    session.corners = corners
    user_sessions.set(session_id, session)
    return RedetectCornersResponse(corners=corners)


@router.get("/photo-stations", response_model=PhotoStationListResponse)
async def list_photo_stations(request: Request, user_id: str = Depends(get_user_id)):
    _require_photo_stations_enabled()

    store = get_photo_station_store(user_id)
    stations = list(store.all().values())
    stations.sort(key=lambda s: s.updated_at or s.created_at or "", reverse=True)
    return PhotoStationListResponse(stations=stations)


@router.get("/photo-stations/{station_id}", response_model=PhotoStation)
async def get_photo_station(request: Request, station_id: str, user_id: str = Depends(get_user_id)):
    _require_photo_stations_enabled()

    station = get_photo_station_store(user_id).get(station_id)
    if not station:
        raise HTTPException(status_code=404, detail="photo station not found")
    return station


@router.post("/photo-stations", response_model=PhotoStation)
async def create_photo_station(request: Request, req: PhotoStationCreateRequest, user_id: str = Depends(get_user_id)):
    _require_photo_stations_enabled()

    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")

    station = _create_photo_station(
        user_id=user_id,
        session=session,
        name=req.name,
        paper_size=req.paper_size or session.paper_size,
        corners=req.corners or session.corners,
    )
    return station


@router.patch("/photo-stations/{station_id}", response_model=PhotoStation)
async def update_photo_station(request: Request, station_id: str, req: PhotoStationUpdateRequest, user_id: str = Depends(get_user_id)):
    _require_photo_stations_enabled()

    store = get_photo_station_store(user_id)
    station = store.get(station_id)
    if not station:
        raise HTTPException(status_code=404, detail="photo station not found")

    if req.name is not None:
        station.name = req.name.strip() or station.name
    if req.paper_size is not None:
        station.paper_size = req.paper_size
    if req.corners is not None:
        if len(req.corners) != 4:
            raise HTTPException(status_code=400, detail="station corners must contain four points")
        station.corners = req.corners
    station.updated_at = _now_iso()
    store.set(station.id, station)
    return station


@router.delete("/photo-stations/{station_id}", response_model=StatusResponse)
async def delete_photo_station(request: Request, station_id: str, user_id: str = Depends(get_user_id)):
    _require_photo_stations_enabled()

    station = get_photo_station_store(user_id).delete(station_id)
    if not station:
        raise HTTPException(status_code=404, detail="photo station not found")
    _safe_unlink(station.image_path)
    return StatusResponse(status="deleted")


@router.get("/sessions/{session_id}/station-suggestions", response_model=PhotoStationSuggestionsResponse)
async def list_photo_station_suggestions(request: Request, session_id: str, user_id: str = Depends(get_user_id)):
    _require_photo_stations_enabled()

    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")

    stations = list(get_photo_station_store(user_id).all().values())
    if not session.original_image_width or not session.original_image_height:
        return PhotoStationSuggestionsResponse(suggestions=[], station_count=len(stations))

    suggestions = [
        _station_suggestion(station, session)
        for station in stations
    ]
    suggestions = [suggestion for suggestion in suggestions if suggestion.match_status != "far"]
    suggestions.sort(
        key=lambda suggestion: max(
            suggestion.width_delta_percent,
            suggestion.height_delta_percent,
            suggestion.max_corner_drift_percent or 0.0,
        )
    )
    return PhotoStationSuggestionsResponse(suggestions=suggestions, station_count=len(stations))


@router.post("/sessions/{session_id}/reuse-corners", response_model=ReuseCornersResponse)
async def reuse_photo_station_corners(request: Request, session_id: str, req: ReuseCornersRequest, user_id: str = Depends(get_user_id)):
    _require_photo_stations_enabled()

    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session or not session.original_image_path:
        raise HTTPException(status_code=404, detail="session not found")

    store = get_photo_station_store(user_id)
    station = store.get(req.station_id)
    if not station:
        raise HTTPException(status_code=404, detail="photo station not found")

    suggestion = _station_suggestion(station, session)
    if suggestion.match_status == "far":
        raise HTTPException(status_code=400, detail="photo station image size differs too much from this upload")

    image_width, image_height = _session_image_dimensions(session)
    reused_corners = _scaled_station_corners(station, image_width, image_height)
    session.corners = reused_corners
    session.paper_size = station.paper_size
    user_sessions.set(session_id, session)

    station.last_used_at = _now_iso()
    store.set(station.id, station)

    return ReuseCornersResponse(
        corners=reused_corners,
        paper_size=station.paper_size,
        suggestion=suggestion,
    )


@router.get("/version")
async def get_version():
    """return the running app version (baked into the image, "dev" locally).

    404 when SHOW_APP_VERSION=false so nothing is disclosed.
    """
    if not settings.show_app_version:
        raise HTTPException(status_code=404)
    return {"version": settings.app_version}


@router.get("/api-keys")
async def get_available_keys(user_id: str = Depends(get_user_id)):
    """return available tracers and provider info.

    identity is resolved per mode like every other data route: this reports
    instance configuration, including whether cloud keys are set, so native
    mode must not hand it to an unauthenticated caller.
    """
    tracers = settings.available_tracers
    has_cloud = bool(settings.google_api_key) or bool(settings.openrouter_api_key)
    has_saliency = settings.primary_is_saliency
    primary = tracers[0] if tracers else None
    return {
        # google: server can trace without a user-supplied key (cloud env key, local, or remote)
        "google": has_cloud or has_saliency,
        "provider": tracer_kind(primary) if primary else None,
        "provider_label": TRACER_LABELS.get(primary, primary) if primary else None,
        # the drawer photo flow is cloud-only: its effective availability and
        # destination are the configured key's, not the primary tool tracer's
        "drawer_cloud": bool(settings.openrouter_api_key or settings.google_api_key),
        "drawer_provider_label": (
            "Gemini via OpenRouter" if settings.openrouter_api_key
            else "Gemini API" if settings.google_api_key
            else None
        ),
        "tracers": [
            {"id": t, "label": TRACER_LABELS.get(t, t)}
            for t in tracers
        ],
        "photo_stations": settings.photo_stations,
    }


@router.post("/sessions/{session_id}/trace", response_model=TraceResponse)
async def trace_tools(
    request: Request,
    session_id: str,
    req: TraceRequest,
    user_id: str = Depends(get_user_id),
):
    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session or not session.corrected_image_path:
        raise HTTPException(status_code=400, detail="must set corners first")

    tracer_id = req.tracer or settings.available_tracers[0]
    if tracer_id not in settings.available_tracers:
        raise HTTPException(status_code=400, detail=f"tracer '{tracer_id}' not available")

    api_key = settings.google_api_key or req.api_key
    if tracer_id == "gemini" and not api_key and not settings.openrouter_api_key:
        raise HTTPException(status_code=400, detail="no api key provided")

    if tracer_kind(tracer_id) == "remote":
        if not _remote_token(tracer_id):
            env = "REPLICATE_API_TOKEN" if tracer_id == "replicate" else "FAL_KEY"
            raise HTTPException(status_code=400, detail=f"{tracer_id} token not set; set {env}")

    up = _user_path(user_id)
    mask_output_path = str(up / "processed" / f"{session_id}_mask.png")

    tracer = _get_tracer(tracer_id)
    corrected_image_path = _abs(session.corrected_image_path)
    try:
        polygons, mask_path = await tracer.trace_tools(
            corrected_image_path,
            api_key,
            mask_output_path,
            # abort the mask write (and the dir recreation it implies) if
            # the user was deleted while the model call was in flight
            before_mask_write=user_sessions.ensure_open,
        )
    except StoreClosedError:
        raise
    except TimeoutError:
        label = TRACER_LABELS.get(tracer_id, tracer_id)
        logging.warning("%s timed out", tracer_id)
        raise HTTPException(status_code=504, detail=f"{label} timed out; the model may be overloaded. Try again shortly.")
    except Exception as e:
        error_msg = str(e)
        if "insufficient_quota" in error_msg or "exceeded" in error_msg.lower():
            raise HTTPException(status_code=402, detail="API quota exceeded - check your billing")
        if "invalid_api_key" in error_msg or "Incorrect API key" in error_msg:
            raise HTTPException(status_code=401, detail="Invalid API key")
        if "rate_limit" in error_msg.lower():
            raise HTTPException(status_code=429, detail="Rate limited - try again shortly")
        if tracer_kind(tracer_id) == "remote":
            label = TRACER_LABELS.get(tracer_id, tracer_id)
            logging.error("%s provider error: %s", tracer_id, error_msg[:500], exc_info=True)
            raise HTTPException(status_code=502, detail=f"{label} provider error; try again shortly.")
        logging.error("ai tracing failed: %s", error_msg[:500], exc_info=True)
        detail = f"AI tracing failed ({type(e).__name__}: {error_msg[:200]})"
        raise HTTPException(status_code=500, detail=detail)

    polygons = await name_polygons(corrected_image_path, polygons)
    session.polygons = polygons
    session.mask_image_path = _rel(mask_path, up) if mask_path else None
    user_sessions.set(session_id, session)

    mask_url = None
    if mask_path:
        mask_url = f"/storage/{user_id}/processed/{session_id}_mask.png"

    return TraceResponse(
        polygons=polygons,
        mask_url=mask_url,
    )


@router.post("/sessions/{session_id}/trace-mask", response_model=TraceResponse)
async def trace_from_mask(
    request: Request,
    session_id: str,
    mask: UploadFile,
    user_id: str = Depends(get_user_id),
):
    """trace contours from a user-uploaded mask image"""
    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session or not session.corrected_image_path:
        raise HTTPException(status_code=400, detail="must set corners first")

    if not mask.content_type or not mask.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="file must be an image")

    up = _user_path(user_id)

    content = await mask.read()
    mask_ext = Path(mask.filename or "mask.png").suffix.lower() or ".png"
    if mask_ext not in ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="unsupported image format")
    content, mask_ext, _ = _ingest_with_limits(content, mask_ext)
    mask_path = up / "processed" / f"{session_id}_mask.png"
    # the awaited read can outlive a concurrent account deletion; refuse
    # to write into the deleted user's tree
    user_sessions.ensure_open()
    mask_path.write_bytes(content)

    corrected_image_path = _abs(session.corrected_image_path)
    contours = _get_tracer()._trace_mask(str(mask_path), corrected_image_path)

    if not contours:
        raise HTTPException(status_code=400, detail="no tool outlines found in mask")

    polygons = []
    for i, (exterior, holes) in enumerate(contours):
        polygons.append(Polygon(
            id=str(uuid.uuid4()),
            points=[Point(x=p[0], y=p[1]) for p in exterior],
            interior_rings=[[Point(x=p[0], y=p[1]) for p in hole] for hole in holes],
            label=f"tool {i + 1}",
        ))

    polygons = await name_polygons(corrected_image_path, polygons)
    session.polygons = polygons
    session.mask_image_path = _rel(mask_path, up)
    user_sessions.set(session_id, session)

    return TraceResponse(
        polygons=polygons,
        mask_url=f"/storage/{user_id}/processed/{session_id}_mask.png",
    )


@router.put("/sessions/{session_id}/polygons", response_model=StatusResponse)
async def update_polygons(request: Request, session_id: str, req: PolygonsRequest, user_id: str = Depends(get_user_id)):
    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")

    session.polygons = req.polygons
    user_sessions.set(session_id, session)
    return StatusResponse(status="ok")


@router.post("/sessions/{session_id}/generate", response_model=GenerateResponse)
def generate_stl(request: Request, session_id: str, req: GenerateRequest, user_id: str = Depends(get_user_id)):
    user_sessions, _, _ = get_stores(user_id)
    up = _user_path(user_id)
    session = user_sessions.get(session_id)
    if not session or not session.scale_factor:
        raise HTTPException(status_code=400, detail="must trace tools first")

    polygons = req.polygons if req.polygons else session.polygons
    if not polygons:
        raise HTTPException(status_code=400, detail="no polygons to generate from")

    input_hash = hashlib.md5(json.dumps(req.model_dump(), sort_keys=True, default=str).encode()).hexdigest()

    scaled = polygon_scaler.scale_to_mm(polygons, session.scale_factor)
    scaled = [
        polygon_scaler.prepare_for_generation(p, req.cutout_clearance, smoothed=False)
        for p in scaled
    ]

    response = _run_generate(scaled, req, session_id, up, input_hash, user_id, user_sessions)

    output_path = up / "outputs" / f"{session_id}.stl"
    fresh_session = user_sessions.get(session_id)
    if fresh_session:
        fresh_session.stl_path = _rel(output_path, up)
        user_sessions.set(session_id, fresh_session)

    return response


@router.get("/sessions", response_model=SessionListResponse)
async def list_sessions(request: Request, user_id: str = Depends(get_user_id)):
    user_sessions, _, _ = get_stores(user_id)
    all_sessions = user_sessions.all()
    summaries = []
    for sid, session in all_sessions.items():
        thumbnail_url = None
        if session.corrected_image_path:
            thumbnail_url = f"/storage/{session.corrected_image_path}"
        elif session.original_image_path:
            thumbnail_url = f"/storage/{session.original_image_path}"

        summaries.append(SessionSummary(
            id=sid,
            name=session.name,
            description=session.description,
            tags=session.tags or [],
            created_at=session.created_at,
            thumbnail_url=thumbnail_url,
            tool_count=len(session.polygons) if session.polygons else 0,
            has_stl=session.stl_path is not None,
        ))

    summaries.sort(key=lambda s: s.created_at or "", reverse=True)
    return SessionListResponse(sessions=summaries)


@router.get("/sessions/{session_id}")
async def get_session(request: Request, session_id: str, user_id: str = Depends(get_user_id)):
    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    return session


@router.patch("/sessions/{session_id}", response_model=StatusResponse)
async def update_session(request: Request, session_id: str, req: SessionUpdateRequest, user_id: str = Depends(get_user_id)):
    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")

    if req.name is not None:
        session.name = req.name
    if req.description is not None:
        session.description = req.description
    if req.tags is not None:
        session.tags = req.tags
    if req.layout is not None:
        session.layout = req.layout
    user_sessions.set(session_id, session)
    return StatusResponse(status="ok")


@router.delete("/sessions/{session_id}", response_model=StatusResponse)
async def delete_session(request: Request, session_id: str, user_id: str = Depends(get_user_id)):
    user_sessions, _, _ = get_stores(user_id)
    up = _user_path(user_id)
    session = user_sessions.delete(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")

    for rel in [
        session.original_image_path,
        session.corrected_image_path,
        session.mask_image_path,
        session.stl_path,
    ]:
        _safe_unlink(rel)
    # Drawer candidates generated from a session belong to that session.
    (up / "processed" / f"{session_id}_drawer_mask.png").unlink(missing_ok=True)

    if session.stl_path:
        Path(_abs(session.stl_path)).with_suffix(".3mf").unlink(missing_ok=True)
        for part_file in up.glob(f"outputs/{session_id}_part*.stl"):
            part_file.unlink(missing_ok=True)
        zip_path = up / "outputs" / f"{session_id}_parts.zip"
        zip_path.unlink(missing_ok=True)

    return StatusResponse(status="deleted")


@router.get("/sessions/{session_id}/debug")
async def debug_session(request: Request, session_id: str, user_id: str = Depends(get_user_id)):
    """generate debug images showing contour detection steps"""
    user_sessions, _, _ = get_stores(user_id)
    up = _user_path(user_id)
    session = user_sessions.get(session_id)
    if not session or not session.corrected_image_path:
        raise HTTPException(status_code=404, detail="session not found or no corrected image")

    debug_dir = up / "debug" / session_id
    debug_dir.mkdir(parents=True, exist_ok=True)

    results = image_processor.debug_contour_detection(
        _abs(session.corrected_image_path), debug_dir
    )

    for key in results:
        if isinstance(results[key], str) and results[key].endswith(".jpg"):
            results[key] = f"/storage/{user_id}/debug/{session_id}/{results[key]}"

    return results


@router.get("/files/{session_id}/bin.stl")
async def download_stl(request: Request, session_id: str, user_id: str = Depends(get_user_id)):
    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session or not session.stl_path:
        raise HTTPException(status_code=404, detail="stl not found")

    stl_abs = _abs(session.stl_path)
    if not Path(stl_abs).exists():
        raise HTTPException(status_code=404, detail="stl expired; regenerate the bin")

    return FileResponse(
        stl_abs,
        media_type="application/sla",
        filename=f"tracefinity-{session_id[:8]}.stl",
    )


@router.get("/files/{session_id}/bin_parts.zip")
async def download_zip(request: Request, session_id: str, user_id: str = Depends(get_user_id)):
    up = _user_path(user_id)
    zip_path = up / "outputs" / f"{session_id}_parts.zip"
    if not zip_path.exists():
        user_sessions, _, _ = get_stores(user_id)
        session = user_sessions.get(session_id)
        if session and session.stl_path:
            raise HTTPException(status_code=404, detail="zip expired; regenerate the bin")
        raise HTTPException(status_code=404, detail="zip not found")

    return FileResponse(
        str(zip_path),
        media_type="application/zip",
        filename=f"tracefinity-{session_id[:8]}-parts.zip",
    )


@router.get("/files/{session_id}/bin.3mf")
async def download_threemf(request: Request, session_id: str, user_id: str = Depends(get_user_id)):
    user_sessions, _, _ = get_stores(user_id)
    session = user_sessions.get(session_id)
    if not session or not session.stl_path:
        raise HTTPException(status_code=404, detail="3mf not found")

    threemf_path = Path(_abs(session.stl_path)).with_suffix(".3mf")
    if not threemf_path.exists():
        raise HTTPException(status_code=404, detail="3mf expired; regenerate the bin")

    return FileResponse(
        str(threemf_path),
        media_type="application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
        filename=f"tracefinity-{session_id[:8]}.3mf",
    )


# --- tool library ---


class OutlinePreviewPolygon(Polygon):
    smoothed: bool = True
    smooth_level: float = Field(default=0.5, ge=0, le=1, allow_inf_nan=False)


@router.post("/tools/preview-outline", response_model=list[Polygon])
def preview_tool_outlines(
    outlines: list[OutlinePreviewPolygon], user_id: str = Depends(get_user_id),
):
    """Shared zero-clearance contours for unsaved tool and bin previews."""
    if len(outlines) > 100 or sum(
        len(outline.points) + sum(map(len, outline.interior_rings))
        for outline in outlines
    ) > 100_000:
        raise HTTPException(status_code=422, detail="Too many outline vertices")
    prepared = []
    for outline in outlines:
        if len(outline.points) < 3 or any(len(ring) < 3 for ring in outline.interior_rings):
            raise HTTPException(status_code=422, detail="Outline rings need at least three points")
        polygon = ScaledPolygon(
            outline.id, [(p.x, p.y) for p in outline.points], outline.label,
            interior_rings_mm=[
                [(p.x, p.y) for p in ring] for ring in outline.interior_rings
            ],
        )
        contour = polygon_scaler.prepare_for_generation(
            polygon, 0.0, outline.smoothed, outline.smooth_level,
        )
        prepared.append(outline.model_copy(update={
            "points": [Point(x=x, y=y) for x, y in contour.points_mm],
            "interior_rings": [
                [Point(x=x, y=y) for x, y in ring]
                for ring in contour.interior_rings_mm
            ],
        }))
    return prepared


@router.get("/tools", response_model=ToolListResponse)
async def list_tools(request: Request, user_id: str = Depends(get_user_id)):
    user_sessions, user_tools, _ = get_stores(user_id)
    all_tools = user_tools.all()
    summaries = []
    for tid, tool in all_tools.items():
        thumb_url = None
        if tool.thumbnail_path and Path(_abs(tool.thumbnail_path)).exists():
            thumb_url = f"/storage/{tool.thumbnail_path}"
        image_context, _ = _tool_image_context(tool, user_sessions, load_missing_dimensions=False)
        summaries.append(ToolSummary(
            id=tid,
            name=tool.name,
            thickness_mm=tool.thickness_mm,
            created_at=tool.created_at,
            point_count=len(tool.points),
            points=tool.points,
            interior_rings=tool.interior_rings,
            smoothed=tool.smoothed,
            smooth_level=tool.smooth_level,
            thumbnail_url=thumb_url,
            image_transform=tool.source_image_transform,
            image_context=image_context,
            category=tool.category,
            drawer=tool.drawer,
            tags=tool.tags,
            project_ids=tool.project_ids,
            review_status=tool.review_status,
            needs_cleanup=tool.needs_cleanup,
        ))
    summaries.sort(key=lambda t: t.created_at or "", reverse=True)
    return ToolListResponse(tools=summaries)


@router.get("/tools/{tool_id}", response_model=ToolDetailResponse)
async def get_tool(request: Request, tool_id: str, user_id: str = Depends(get_user_id)):
    user_sessions, user_tools, _ = get_stores(user_id)
    tool = user_tools.get(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail="tool not found")
    data = tool.model_dump()
    image_context, updated = _tool_image_context(tool, user_sessions)
    if updated:
        user_tools.set(tool_id, tool)
        data = tool.model_dump()
    data["image_context"] = image_context
    return data


@router.put("/tools/{tool_id}", response_model=StatusResponse)
async def update_tool(request: Request, tool_id: str, req: ToolUpdateRequest, user_id: str = Depends(get_user_id)):
    _, user_tools, _ = get_stores(user_id)
    tool = user_tools.get(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail="tool not found")
    tool = tool.model_copy(deep=True)
    if "thickness_mm" in req.model_fields_set:
        tool.thickness_mm = req.thickness_mm

    if req.name is not None:
        tool.name = req.name
    if req.points is not None:
        tool.points = req.points
    if req.finger_holes is not None:
        tool.finger_holes = req.finger_holes
    if req.interior_rings is not None:
        tool.interior_rings = req.interior_rings
    if req.smoothed is not None:
        tool.smoothed = req.smoothed
    if req.smooth_level is not None:
        tool.smooth_level = req.smooth_level
    if req.source_image_transform is not None:
        tool.source_image_transform = req.source_image_transform
    if "category" in req.model_fields_set:
        tool.category = req.category
    if "drawer" in req.model_fields_set:
        tool.drawer = req.drawer
    if req.tags is not None:
        tool.tags = req.tags
    if req.project_ids is not None:
        tool.project_ids = req.project_ids
    if "review_status" in req.model_fields_set:
        tool.review_status = req.review_status
    if req.needs_cleanup is not None:
        tool.needs_cleanup = req.needs_cleanup
    user_tools.set(tool_id, tool)
    return StatusResponse(status="ok")


@router.post("/tools/{tool_id}/auto-rotate")
async def auto_rotate_tool(request: Request, tool_id: str, user_id: str = Depends(get_user_id)):
    _, user_tools, _ = get_stores(user_id)
    tool = user_tools.get(tool_id)
    if not tool or not tool.points:
        raise HTTPException(status_code=404, detail="tool not found")
    pts = [(p.x, p.y) for p in tool.points]
    angle = _optimal_rotation_angle(pts)
    return {"angle": angle}


@router.delete("/tools/{tool_id}", response_model=StatusResponse)
async def delete_tool(request: Request, tool_id: str, user_id: str = Depends(get_user_id)):
    _, user_tools, _ = get_stores(user_id)
    tool = user_tools.delete(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail="tool not found")
    return StatusResponse(status="deleted")


@router.get("/files/tools/{tool_id}/tool.svg")
async def download_tool_svg(request: Request, tool_id: str, user_id: str = Depends(get_user_id)):
    _, user_tools, _ = get_stores(user_id)
    tool = user_tools.get(tool_id)
    if not tool or not tool.points:
        raise HTTPException(status_code=404, detail="tool not found")

    points_mm = [(p.x, p.y) for p in tool.points]
    interior_rings_mm = [[(p.x, p.y) for p in ring] for ring in tool.interior_rings]
    fholes = [ScaledFingerHole.from_finger_hole(fh) for fh in tool.finger_holes]
    sp = ScaledPolygon(tool.id, points_mm, tool.name, fholes, interior_rings_mm)

    if tool.smoothed:
        sp = polygon_scaler.smooth(sp, level=tool.smooth_level)
    else:
        sp = polygon_scaler.simplify(sp)

    xs = [p[0] for p in sp.points_mm]
    ys = [p[1] for p in sp.points_mm]
    pad = 1.0
    min_x, max_x = min(xs) - pad, max(xs) + pad
    min_y, max_y = min(ys) - pad, max(ys) + pad
    w = max_x - min_x
    h = max_y - min_y

    # outer polygon
    pts = " ".join(f"{x:.4f},{y:.4f}" for x, y in sp.points_mm)
    paths = f'  <polygon points="{pts}" fill="black" stroke="none"/>\n'

    # interior holes
    for ring in sp.interior_rings_mm:
        ring_pts = " ".join(f"{x:.4f},{y:.4f}" for x, y in ring)
        paths += f'  <polygon points="{ring_pts}" fill="white" stroke="none"/>\n'

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg"'
        f' width="{w:.4f}mm" height="{h:.4f}mm"'
        f' viewBox="{min_x:.4f} {min_y:.4f} {w:.4f} {h:.4f}">\n'
        f'{paths}'
        f'</svg>\n'
    )

    safe_name = tool.name.replace('"', '').replace('/', '-') if tool.name else "tool"
    return Response(
        content=svg,
        media_type="image/svg+xml",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}.svg"',
            "Cache-Control": "no-cache",
        },
    )


@router.post("/sessions/{session_id}/save-tools", response_model=SaveToolsResponse)
async def save_tools_from_session(request: Request, session_id: str, body: SaveToolsRequest = SaveToolsRequest(), user_id: str = Depends(get_user_id)):
    """convert session polygons to library tools (px -> mm, centered at origin)"""
    user_sessions, user_tools, _ = get_stores(user_id)
    up = _user_path(user_id)
    session = user_sessions.get(session_id)
    if not session or not session.scale_factor or not session.polygons:
        raise HTTPException(status_code=400, detail="session has no traced polygons")

    sf = session.scale_factor
    tool_ids = []

    polys = session.polygons
    if body.polygon_ids is not None:
        id_set = set(body.polygon_ids)
        polys = [p for p in polys if p.id in id_set]

    src_img = None
    if session.corrected_image_path:
        try:
            src_img = Image.open(_abs(session.corrected_image_path))
        except Exception:
            pass

    for poly in polys:
        centered, fholes, interior_rings = polygon_scaler.scale_and_centre(poly, sf)
        if not centered:
            continue

        tool_id = str(uuid.uuid4())
        source_transform = _polygon_source_transform(poly, sf)

        thumbnail_path = None
        if src_img:
            thumb_abs = generate_tool_thumbnail(src_img, poly.points, tool_id, up / "tools")
            if thumb_abs:
                thumbnail_path = _rel(thumb_abs, up)

        user_tools.set(tool_id, Tool(
            id=tool_id,
            name=poly.label,
            points=centered,
            finger_holes=fholes,
            interior_rings=interior_rings,
            source_session_id=session_id,
            source_polygon_id=poly.id,
            source_image_path=session.corrected_image_path,
            source_image_width=src_img.width if src_img else None,
            source_image_height=src_img.height if src_img else None,
            source_image_transform=(
                [sf, 0.0, 0.0, sf, source_transform[0], source_transform[1]]
                if source_transform else None
            ),
            thumbnail_path=thumbnail_path,
            created_at=_now_iso(),
        ))
        tool_ids.append(tool_id)

    return SaveToolsResponse(tool_ids=tool_ids)


# --- bin projects ---

@router.get("/bin-projects", response_model=BinProjectListResponse)
async def list_bin_projects(request: Request, user_id: str = Depends(get_user_id)):
    project_store = get_project_store(user_id)
    _, _, user_bins = get_stores(user_id)
    summaries = [
        make_project_summary(project, user_bins)
        for project in project_store.all().values()
    ]
    summaries.sort(key=lambda p: p.updated_at or p.created_at or "", reverse=True)
    return BinProjectListResponse(projects=summaries)


@router.post("/bin-projects", response_model=BinProject)
async def create_bin_project(request: Request, req: BinProjectCreateRequest, user_id: str = Depends(get_user_id)):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="project name is required")

    project_store = get_project_store(user_id)
    _, user_tools, _ = get_stores(user_id)
    for tool_id in req.tool_ids:
        if not user_tools.get(tool_id):
            raise HTTPException(status_code=404, detail=f"tool {tool_id} not found")

    project_id = str(uuid.uuid4())
    now = _now_iso()
    project = BinProject(
        id=project_id,
        name=name,
        description=req.description,
        status=req.status,
        tool_ids=list(dict.fromkeys(req.tool_ids)),
        default_bin_config=req.default_bin_config,
        notes=req.notes,
        created_at=now,
        updated_at=now,
    )
    project_store.set(project_id, project)
    add_project_to_tools(project_id, project.tool_ids, user_tools)
    return project


@router.get("/bin-projects/{project_id}", response_model=BinProjectDetail)
async def get_bin_project(request: Request, project_id: str, user_id: str = Depends(get_user_id)):
    project = get_project_store(user_id).get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    _, _, user_bins = get_stores(user_id)
    return make_project_detail(project, user_bins)


@router.patch("/bin-projects/{project_id}", response_model=BinProjectDetail)
async def update_bin_project(
    request: Request,
    project_id: str,
    req: BinProjectUpdateRequest,
    user_id: str = Depends(get_user_id),
):
    project_store = get_project_store(user_id)
    project = project_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    _, _, user_bins = get_stores(user_id)

    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="project name is required")
        project.name = name
    if "description" in req.model_fields_set:
        project.description = req.description
    if "status" in req.model_fields_set and req.status is not None:
        project.status = req.status
    if "default_bin_config" in req.model_fields_set:
        project.default_bin_config = req.default_bin_config
    if "notes" in req.model_fields_set:
        project.notes = req.notes

    project.updated_at = _now_iso()
    project_store.set(project_id, project)
    return make_project_detail(project, user_bins)


@router.delete("/bin-projects/{project_id}", response_model=StatusResponse)
async def delete_bin_project(request: Request, project_id: str, user_id: str = Depends(get_user_id)):
    project_store = get_project_store(user_id)
    _, user_tools, user_bins = get_stores(user_id)
    project = project_store.delete(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    for sketch in project.sketches:
        owned = _plan_photo_dir(user_id, sketch.id)
        if owned.exists():
            shutil.rmtree(owned)

    remove_project_from_tools(project_id, project.tool_ids, user_tools)
    for bid, bin_data in user_bins.all().items():
        if bin_data.project_id == project_id or bid in project.bin_ids:
            bin_data.project_id = None
            user_bins.set(bid, bin_data)

    return StatusResponse(status="deleted")


@router.post("/bin-projects/{project_id}/tools", response_model=BinProjectDetail)
async def add_tools_to_bin_project(
    request: Request,
    project_id: str,
    req: BinProjectToolsRequest,
    user_id: str = Depends(get_user_id),
):
    project_store = get_project_store(user_id)
    project = project_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    _, user_tools, user_bins = get_stores(user_id)
    for tool_id in req.tool_ids:
        if not user_tools.get(tool_id):
            raise HTTPException(status_code=404, detail=f"tool {tool_id} not found")

    existing = set(project.tool_ids)
    for tool_id in req.tool_ids:
        if tool_id not in existing:
            project.tool_ids.append(tool_id)
            existing.add(tool_id)
    project.updated_at = _now_iso()
    project_store.set(project_id, project)
    add_project_to_tools(project_id, req.tool_ids, user_tools)
    return make_project_detail(project, user_bins)


@router.delete("/bin-projects/{project_id}/tools/{tool_id}", response_model=BinProjectDetail)
async def remove_tool_from_bin_project(
    request: Request,
    project_id: str,
    tool_id: str,
    user_id: str = Depends(get_user_id),
):
    project_store = get_project_store(user_id)
    project = project_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    if tool_id in project.tool_ids:
        project.tool_ids = [tid for tid in project.tool_ids if tid != tool_id]
        project.updated_at = _now_iso()
        project_store.set(project_id, project)

    _, user_tools, user_bins = get_stores(user_id)
    remove_project_from_tools(project_id, [tool_id], user_tools)
    return make_project_detail(project, user_bins)


@router.post("/bin-projects/{project_id}/sketches", response_model=ProjectSketch)
async def create_project_sketch(
    request: Request,
    project_id: str,
    req: ProjectSketchCreateRequest = ProjectSketchCreateRequest(),
    user_id: str = Depends(get_user_id),
):
    project_store = get_project_store(user_id)
    project = project_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    project = project.model_copy(deep=True)

    name = (req.name or "").strip() or f"{DEFAULT_SKETCH_NAME} {len(project.sketches) + 1}"
    now = _now_iso()
    sketch = ProjectSketch(
        name=name,
        target_grid_x=req.target_grid_x,
        target_grid_y=req.target_grid_y,
        outline=_validated_outline(req.outline),
        grid_alignment=req.grid_alignment or DrawerGridAlignment(),
        fit_clearance_mm=req.fit_clearance_mm or 0,
        **req.model_dump(include={"container_width_mm", "container_depth_mm", "container_height_mm", "safety_clearance_mm"}),
        created_at=now,
        updated_at=now,
    )
    # the plan adopts its own copy of the source, so nothing here depends on the
    # trace session staying alive; a rejected session leaves no sketch behind
    if req.source_session_id:
        sketch.source = _calibration_from_session(req.source_session_id, user_id, req.source_seed, sketch.id)
        if req.target_grid_x is None and req.target_grid_y is None:
            # a grid covering the whole corrected frame is the starting point;
            # aligning it to a real drawer edge is the user's next step
            sketch.target_grid_x = min(40.0, max(1.0, math.ceil(sketch.source.image_width * sketch.source.scale_factor / 21) / 2))
            sketch.target_grid_y = min(40.0, max(1.0, math.ceil(sketch.source.image_height * sketch.source.scale_factor / 21) / 2))
    project.sketches.append(sketch)
    project.updated_at = now
    try:
        project_store.set(project_id, project)
    except Exception:
        _remove_plan_source(user_id, sketch.id, sketch.source)
        raise
    return sketch


@router.patch("/bin-projects/{project_id}/sketches/{sketch_id}", response_model=ProjectSketch)
async def update_project_sketch(
    request: Request,
    project_id: str,
    sketch_id: str,
    req: ProjectSketchUpdateRequest,
    user_id: str = Depends(get_user_id),
):
    project_store = get_project_store(user_id)
    project = project_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    project = project.model_copy(deep=True)
    sketch = get_sketch(project, sketch_id)
    previous_source = sketch.source
    _, _, user_bins = get_stores(user_id)

    name = None
    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="sketch name is required")
    layout = None
    if "bin_layout" in req.model_fields_set:
        moved = transform_moved_stacks(sketch.bin_layout, req.bin_layout or [])
        layout = validate_bin_layout(project, moved, user_bins)
    # validate every replacement before mutating the copy so a rejected update
    # leaves the saved plan exactly as it was
    outline = _validated_outline(req.outline) if "outline" in req.model_fields_set else sketch.outline
    if req.source_session_id:
        source = _calibration_from_session(req.source_session_id, user_id, req.source_seed, sketch.id)
    elif req.source_seed is not None and sketch.source is not None:
        source = sketch.source.model_copy(update={"seed": req.source_seed})
    else:
        source = sketch.source

    if name is not None:
        sketch.name = name
    if "target_grid_x" in req.model_fields_set:
        sketch.target_grid_x = req.target_grid_x
    if "target_grid_y" in req.model_fields_set:
        sketch.target_grid_y = req.target_grid_y
    for field in ("container_width_mm", "container_depth_mm", "container_height_mm", "safety_clearance_mm"):
        if field in req.model_fields_set:
            setattr(sketch, field, getattr(req, field))
    if layout is not None:
        sketch.bin_layout = layout
    sketch.outline = outline
    sketch.source = source
    if "grid_alignment" in req.model_fields_set:
        sketch.grid_alignment = req.grid_alignment or DrawerGridAlignment()
    if "fit_clearance_mm" in req.model_fields_set:
        sketch.fit_clearance_mm = req.fit_clearance_mm or 0

    sketch.updated_at = _now_iso()
    project.updated_at = sketch.updated_at
    try:
        project_store.set(project_id, project)
    except Exception:
        if req.source_session_id:
            _remove_plan_source(user_id, sketch.id, source)
        raise
    if req.source_session_id:
        _remove_plan_source(user_id, sketch.id, previous_source)
    return sketch


@router.post(
    "/bin-projects/{project_id}/sketches/outline/candidate",
    response_model=DrawerOutlineCandidateResponse,
)
async def propose_drawer_outline(
    request: Request,
    project_id: str,
    req: DrawerOutlineCandidateRequest,
    user_id: str = Depends(get_user_id),
):
    """Ask Gemini (through the existing tracer adapter) for the interior floor.

    Candidates can be reviewed before any plan exists; only explicit acceptance
    persists the outline. Seed containment rejects disconnected regions, not an
    enclosing exterior: semantic floor correctness still needs user review.
    """
    project = get_project_store(user_id).get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    if req.sketch_id:
        # a saved plan owns its adopted source, so boundary work needs no live session
        sketch = get_sketch(project, req.sketch_id)
        if sketch.source is None:
            raise HTTPException(status_code=400, detail="this drawer plan has no source photo")
        calibration = sketch.source
    elif req.session_id:
        calibration = _calibration_from_session(req.session_id, user_id)
    else:
        raise HTTPException(status_code=400, detail="a drawer plan or a calibrated photo is required")

    tracer_id = req.tracer or "gemini"
    if tracer_kind(tracer_id) != "gemini":
        raise HTTPException(status_code=400, detail="the photo candidate needs the Gemini provider; trace the boundary locally instead")
    if not settings.google_api_key and not settings.openrouter_api_key:
        raise HTTPException(status_code=400, detail="no Gemini or OpenRouter API key is configured; trace the boundary locally instead")
    api_key = settings.google_api_key or req.api_key
    if not api_key and not settings.openrouter_api_key:
        raise HTTPException(status_code=400, detail="no api key provided")

    user_sessions, _, _ = get_stores(user_id)
    up = _user_path(user_id)
    corrected_image_path = _abs(calibration.corrected_image_url.removeprefix("/storage/"))
    if not corrected_image_path or not Path(corrected_image_path).exists():
        raise HTTPException(status_code=400, detail="the source photo is no longer available; trace the boundary locally")
    # A saved-source candidate belongs to its plan; a pending-source candidate
    # belongs to its session. Neither mask is part of the adopted source.
    mask_output_path = str(
        _plan_photo_dir(user_id, req.sketch_id) / "drawer_mask.png"
        if req.sketch_id else up / "processed" / f"{calibration.session_id}_drawer_mask.png"
    )
    tracer = _get_tracer(tracer_id)

    def ensure_candidate_owner():
        user_sessions.ensure_open()
        if req.sketch_id:
            current = get_project_store(user_id).get(project_id)
            current_sketch = next((s for s in current.sketches if s.id == req.sketch_id), None) if current else None
            if current_sketch is None or current_sketch.source != calibration:
                raise ValueError("the saved source changed while tracing; generate from its current photo")
        elif user_sessions.get(req.session_id) is None:
            raise ValueError("the photo session was deleted while tracing")

    try:
        polygon, mask_path = await tracer.trace_drawer_floor(
            corrected_image_path,
            api_key,
            mask_output_path,
            before_mask_write=ensure_candidate_owner,
            # The adapter communicates this floor point in provider-input coordinates.
            focus=(req.seed.x, req.seed.y),
        )
    except StoreClosedError:
        raise
    except TimeoutError:
        raise HTTPException(status_code=504, detail="Gemini timed out; the model may be overloaded. Try again shortly.")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        error_msg = str(e)
        if "insufficient_quota" in error_msg or "exceeded" in error_msg.lower():
            raise HTTPException(status_code=402, detail="API quota exceeded - check your billing")
        if "invalid_api_key" in error_msg or "Incorrect API key" in error_msg:
            raise HTTPException(status_code=401, detail="Invalid API key")
        if "rate_limit" in error_msg.lower():
            raise HTTPException(status_code=429, detail="Rate limited - try again shortly")
        logging.error("drawer floor tracing failed: %s", error_msg[:500], exc_info=True)
        raise HTTPException(status_code=500, detail=f"AI tracing failed ({type(e).__name__}: {error_msg[:200]})")

    if polygon is None:
        raise HTTPException(status_code=400, detail="no interior floor found; select the floor again or trace the boundary locally")

    floor_outer = ring_from_points(polygon.points)
    floor_holes = [ring_from_points(ring) for ring in polygon.interior_rings]
    if not point_in_polygon((req.seed.x, req.seed.y), floor_outer, floor_holes):
        raise HTTPException(status_code=400, detail="the generated boundary does not include the floor you selected; try again or trace the boundary locally")

    scale = calibration.scale_factor
    outline = _validated_outline(DrawerOutline(
        points=[Point(x=p.x * scale, y=p.y * scale) for p in polygon.points],
        interior_rings=[[Point(x=p.x * scale, y=p.y * scale) for p in ring] for ring in polygon.interior_rings],
    ))

    mask_url = None
    if mask_path:
        mask_url = f"/storage/{_rel(mask_path, up)}"
    return DrawerOutlineCandidateResponse(
        outline=outline,
        mask_url=mask_url,
        image_width=calibration.image_width,
        image_height=calibration.image_height,
    )


@router.post("/bin-projects/{project_id}/sketches/{sketch_id}/placements/{placement_id}/stack-action", response_model=ProjectSketch)
async def project_stack_action(project_id: str, sketch_id: str, placement_id: str, req: StackActionRequest, user_id: str = Depends(get_user_id)):
    store = get_project_store(user_id)
    original = store.get(project_id)
    if not original:
        raise HTTPException(status_code=404, detail="project not found")
    project = original.model_copy(deep=True)
    sketch = get_sketch(project, sketch_id)
    _, user_tools, user_bins = get_stores(user_id)
    layout = validate_bin_layout(project, req.bin_layout if req.bin_layout is not None else sketch.bin_layout, user_bins)
    layout = [p.model_copy(deep=True) for p in layout]
    previous_interfaces = {p.id: (p.support_id, p.x, p.y, p.rotation) for p in layout}
    by_id = {p.id: p for p in layout}
    selected = by_id.get(placement_id)
    if not selected:
        raise HTTPException(status_code=404, detail="placement not found")
    child = next((p for p in layout if p.support_id == selected.id), None)
    if req.action == "remove_substack":
        removed = {p.id for p in layout if p.bin_id == selected.bin_id} if req.remove_bin_copies else {selected.id}
        while True:
            descendants = {p.id for p in layout if p.support_id in removed}
            if descendants <= removed:
                break
            removed.update(descendants)
        layout = [p for p in layout if p.id not in removed]
    elif req.action == "remove_reconnect":
        removed = {p.id for p in layout if p.bin_id == selected.bin_id} if req.remove_bin_copies else {selected.id}
        for p in layout:
            while p.support_id in removed:
                p.support_id = by_id[p.support_id].support_id
        layout = [p for p in layout if p.id not in removed]
    elif req.action == "stack_on":
        support = by_id.get(req.support_id)
        if not support or support.id == selected.id:
            raise HTTPException(status_code=400, detail="select another placement as support")
        if selected.support_id:
            raise HTTPException(status_code=400, detail="only a floor root can be stacked")
        members = {selected.id}
        while True:
            descendants = {p.id for p in layout if p.support_id in members}
            if descendants <= members:
                break
            members.update(descendants)
        for p in layout:
            if p.id in members:
                p.x, p.y = support.x, support.y
                if footprint(p, user_bins.get(p.bin_id).bin_config) != footprint(support, user_bins.get(support.bin_id).bin_config):
                    p.rotation = (p.rotation + 90) % 360
        selected.support_id = support.id
    else:
        lower = selected if req.action == "move_up" else by_id.get(selected.support_id)
        upper = child if req.action == "move_up" else selected
        if not lower or not upper:
            raise HTTPException(status_code=400, detail="no neighboring stack member in that direction")
        above = next((p for p in layout if p.support_id == upper.id), None)
        upper.support_id, lower.support_id = lower.support_id, upper.id
        if above:
            above.support_id = lower.id
    layout = validate_bin_layout(project, layout, user_bins)
    bins = user_bins.all()
    for p in layout:
        if p.support_id and previous_interfaces.get(p.id) != (p.support_id, p.x, p.y, p.rotation):
            lower = next(q for q in layout if q.id == p.support_id)
            lower_data = bins[lower.bin_id].model_copy(deep=True)
            sync_placed_tools(lower_data, user_tools)
            physical = assess_bin(lower_data, user_tools.all(), upper_config=bins[p.bin_id].bin_config,
                                  relative_rotation=(p.rotation-lower.rotation) % 360)
            problem = support_problem(lower, p, bins, physical)
            if problem:
                raise HTTPException(status_code=400, detail=problem)
    sketch.bin_layout = layout
    sketch.updated_at = project.updated_at = _now_iso()
    store.set(project_id, project)
    return sketch


@router.post("/bin-projects/{project_id}/sketches/{sketch_id}/assessment")
def assess_project_sketch(
    project_id: str, sketch_id: str,
    req: ProjectSketchUpdateRequest = ProjectSketchUpdateRequest(),
    user_id: str = Depends(get_user_id),
):
    project = get_project_store(user_id).get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    sketch = get_sketch(project, sketch_id).model_copy(deep=True)
    _, user_tools, user_bins = get_stores(user_id)
    for field, value in req.model_dump(exclude_unset=True, exclude={
        "bin_layout", "outline", "grid_alignment", "fit_clearance_mm", "source_session_id", "source_seed",
    }).items():
        setattr(sketch, field, value)
    if "outline" in req.model_fields_set:
        sketch.outline = _validated_outline(req.outline)
    if "grid_alignment" in req.model_fields_set:
        sketch.grid_alignment = req.grid_alignment or DrawerGridAlignment()
    if "fit_clearance_mm" in req.model_fields_set:
        sketch.fit_clearance_mm = req.fit_clearance_mm or 0
    if "bin_layout" in req.model_fields_set:
        sketch.bin_layout = validate_bin_layout(project, req.bin_layout or [], user_bins)
    else:
        validate_bin_layout(project, sketch.bin_layout, user_bins)
    return assess_plan(project, sketch, user_bins, user_tools)


@router.get("/bins/{bin_id}/height-planning")
@router.post("/bins/{bin_id}/height-planning")
def bin_height_planning(bin_id: str, req: BinUpdateRequest = BinUpdateRequest(), safety_clearance_mm: float = 0, user_id: str = Depends(get_user_id)):
    if not math.isfinite(safety_clearance_mm) or safety_clearance_mm < 0:
        raise HTTPException(status_code=400, detail="safety clearance must be finite and non-negative")
    _, user_tools, user_bins = get_stores(user_id)
    bin_data = user_bins.get(bin_id)
    if not bin_data:
        raise HTTPException(status_code=404, detail="bin not found")
    if bin_data.imported_model is not None:
        # uploaded geometry cannot be re-cut, so there are no proposals to make
        return {"assessment": assess_bin(bin_data, user_tools.all(), safety_clearance_mm), "alternatives": []}
    bin_data = bin_data.model_copy(deep=True)
    if req.bin_config is not None:
        bin_data.bin_config = req.bin_config
    if req.placed_tools is not None:
        bin_data.placed_tools = req.placed_tools
    sync_placed_tools(bin_data, user_tools)
    return height_proposals(bin_data, user_tools.all(), safety_clearance_mm)


@router.delete("/bin-projects/{project_id}/sketches/{sketch_id}", response_model=StatusResponse)
async def delete_project_sketch(
    request: Request,
    project_id: str,
    sketch_id: str,
    user_id: str = Depends(get_user_id),
):
    project_store = get_project_store(user_id)
    project = project_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    project = project.model_copy(deep=True)
    get_sketch(project, sketch_id)

    project.sketches = [sketch for sketch in project.sketches if sketch.id != sketch_id]
    project.updated_at = _now_iso()
    project_store.set(project_id, project)
    owned = _plan_photo_dir(user_id, sketch_id)
    if owned.exists():
        shutil.rmtree(owned)
    return StatusResponse(status="deleted")


@router.get("/bin-projects/{project_id}/health", response_model=ProjectHealthResponse)
async def get_bin_project_health(request: Request, project_id: str, user_id: str = Depends(get_user_id)):
    project = get_project_store(user_id).get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    _, user_tools, user_bins = get_stores(user_id)
    return health_response(project_health(project, user_tools, user_bins))


@router.post("/bin-projects/{project_id}/repair", response_model=ProjectHealthResponse)
async def repair_bin_project(request: Request, project_id: str, user_id: str = Depends(get_user_id)):
    project_store = get_project_store(user_id)
    project = project_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    _, user_tools, user_bins = get_stores(user_id)
    repaired = repair_project_links(project_store, project, user_tools, user_bins)
    return health_response(project_health(repaired, user_tools, user_bins))


@router.post("/bin-projects/{project_id}/bins", response_model=BinProjectDetail)
async def add_bins_to_bin_project(
    request: Request,
    project_id: str,
    req: BinProjectBinsRequest,
    user_id: str = Depends(get_user_id),
):
    project_store = get_project_store(user_id)
    project = project_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    _, user_tools, user_bins = get_stores(user_id)
    bin_ids = list(dict.fromkeys(req.bin_ids))
    for bin_id in bin_ids:
        bin_data = user_bins.get(bin_id)
        if not bin_data:
            raise HTTPException(status_code=404, detail=f"bin {bin_id} not found")
        if bin_data.project_id and bin_data.project_id != project_id and not req.allow_reassign:
            raise HTTPException(status_code=400, detail=f"bin {bin_id} already belongs to another project")

    existing_tools = set(project.tool_ids)
    for bin_id in bin_ids:
        bin_data = user_bins.get(bin_id)
        if bin_data.project_id and bin_data.project_id != project_id:
            remove_bin_from_project(project_store, bin_data.project_id, bin_id)
        bin_data.project_id = project_id
        user_bins.set(bin_id, bin_data)
        if bin_id not in project.bin_ids:
            project.bin_ids.append(bin_id)

        if req.import_tools:
            importable_tool_ids: list[str] = []
            for placed in bin_data.placed_tools:
                if placed.tool_id and placed.tool_id not in existing_tools:
                    if not user_tools.get(placed.tool_id):
                        continue
                    project.tool_ids.append(placed.tool_id)
                    existing_tools.add(placed.tool_id)
                if placed.tool_id and user_tools.get(placed.tool_id):
                    importable_tool_ids.append(placed.tool_id)
            add_project_to_tools(project_id, importable_tool_ids, user_tools)

    project.updated_at = _now_iso()
    project_store.set(project_id, project)
    return make_project_detail(project, user_bins)


@router.delete("/bin-projects/{project_id}/bins/{bin_id}", response_model=BinProjectDetail)
async def detach_bin_from_bin_project(
    request: Request,
    project_id: str,
    bin_id: str,
    user_id: str = Depends(get_user_id),
):
    project_store = get_project_store(user_id)
    project = project_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    _, _, user_bins = get_stores(user_id)
    bin_data = user_bins.get(bin_id)
    if bin_id in project.bin_ids:
        project.bin_ids = [bid for bid in project.bin_ids if bid != bin_id]
    drop_bins_from_layout(project, {bin_id})
    if bin_data and bin_data.project_id == project_id:
        bin_data.project_id = None
        user_bins.set(bin_id, bin_data)

    project.updated_at = _now_iso()
    project_store.set(project_id, project)
    return make_project_detail(project, user_bins)


@router.post("/bin-projects/{project_id}/create-bin", response_model=BinModel)
async def create_bin_from_project(
    request: Request,
    project_id: str,
    req: BinProjectCreateBinRequest = BinProjectCreateBinRequest(),
    user_id: str = Depends(get_user_id),
):
    project_store = get_project_store(user_id)
    project = project_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    _, user_tools, user_bins = get_stores(user_id)
    tool_ids = project.tool_ids if req.tool_ids is None else req.tool_ids
    outside_project = [tid for tid in tool_ids if tid not in project.tool_ids]
    if outside_project:
        raise HTTPException(status_code=400, detail="all tools must belong to project")

    bin_id = str(uuid.uuid4())
    bin_data = _build_bin_from_tools(
        bin_id=bin_id,
        name=req.name or project.name,
        project_id=project_id,
        tool_ids=tool_ids,
        user_tools=user_tools,
        default_config=req.bin_config or project.default_bin_config,
    )
    user_bins.set(bin_id, bin_data)
    add_bin_to_project(project_store, project_id, bin_id)
    return bin_data


# --- bins ---

@router.get("/bins", response_model=BinListResponse)
async def list_bins(request: Request, user_id: str = Depends(get_user_id)):
    _, _, user_bins = get_stores(user_id)
    all_bins = user_bins.all()
    summaries = []
    for bid, bin_data in all_bins.items():
        summaries.append(BinSummary(
            id=bid,
            name=bin_data.name,
            project_id=bin_data.project_id,
            created_at=bin_data.created_at,
            tool_ids=[pt.tool_id for pt in bin_data.placed_tools],
            tool_count=len(bin_data.placed_tools),
            has_stl=bin_data.stl_path is not None,
            grid_x=bin_data.bin_config.grid_x,
            grid_y=bin_data.bin_config.grid_y,
            height_units=bin_data.bin_config.height_units,
            half_grid_base=bin_data.bin_config.half_grid_base,
            preview_tools=[BinPreviewTool(points=pt.points, interior_rings=pt.interior_rings) for pt in bin_data.placed_tools],
            imported_model=bin_data.imported_model,
        ))
    summaries.sort(key=lambda b: b.created_at or "", reverse=True)
    return BinListResponse(bins=summaries)


@router.get("/bins/{bin_id}")
async def get_bin(request: Request, bin_id: str, user_id: str = Depends(get_user_id)):
    _, user_tools, user_bins = get_stores(user_id)
    bin_data = user_bins.get(bin_id)
    if not bin_data:
        raise HTTPException(status_code=404, detail="bin not found")

    if sync_placed_tools(bin_data, user_tools):
        user_bins.set(bin_id, bin_data)

    return {**bin_data.model_dump(), "height_assessment": assess_bin(bin_data, user_tools.all())}


@router.post("/bins", response_model=BinModel)
async def create_bin(request: Request, req: CreateBinRequest, user_id: str = Depends(get_user_id)):
    _, user_tools, user_bins = get_stores(user_id)
    project_store = get_project_store(user_id)
    if req.project_id and not project_store.get(req.project_id):
        raise HTTPException(status_code=404, detail=f"project {req.project_id} not found")
    bin_id = str(uuid.uuid4())
    bin_data = _build_bin_from_tools(
        bin_id=bin_id,
        name=req.name,
        project_id=req.project_id,
        tool_ids=req.tool_ids,
        user_tools=user_tools,
        default_config=req.bin_config,
    )
    user_bins.set(bin_id, bin_data)
    add_bin_to_project(project_store, req.project_id, bin_id)
    return bin_data


IMPORT_DIR_NAME = "imports"


@router.post("/bins/import", response_model=BinModel)
async def import_bin(
    request: Request,
    file: UploadFile = File(...),
    name: str | None = Form(None),
    project_id: str | None = Form(None),
    user_id: str = Depends(get_user_id),
):
    """Import a user STL as a read-only planning bin (mm, Z-up)."""
    _, _, user_bins = get_stores(user_id)
    project_store = get_project_store(user_id)
    if project_id and not project_store.get(project_id):
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")

    # bound the read before allocating: one byte over the cap is enough to reject
    content = await file.read(MAX_IMPORT_BYTES + 1)
    if len(content) > MAX_IMPORT_BYTES:
        raise HTTPException(status_code=413, detail="STL exceeds the 25 MiB upload limit")
    try:
        model = await asyncio.to_thread(process_import, content)
    except StlImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    bin_id = str(uuid.uuid4())
    up = _user_path(user_id)
    asset_path = up / IMPORT_DIR_NAME / f"{bin_id}.stl"
    try:
        await asyncio.to_thread(store_import_asset, asset_path, model.stl_bytes)
    except OSError:
        logger.exception("failed to store imported STL for bin %s", bin_id)
        raise HTTPException(status_code=500, detail="failed to store imported model")

    bin_config = BinConfig(
        grid_x=model.grid_x,
        grid_y=model.grid_y,
        height_units=model.height_units,
        stacking_lip=model.stacking_lip,
        half_grid_base=model.half_grid_base,
    )
    bin_data = BinModel(
        id=bin_id,
        name=(name or "").strip()[:200] or (Path(file.filename or "").stem[:200] or None),
        project_id=project_id,
        bin_config=bin_config,
        imported_model=ImportedBinModel(
            width_mm=model.width_mm,
            depth_mm=model.depth_mm,
            height_mm=model.height_mm,
            warnings=model.warnings,
        ),
        stl_path=_rel(asset_path, up),
        created_at=_now_iso(),
    )
    # linking mutates the live project record before its store write, and the
    # project may even be deleted during the awaited parse, so snapshot the
    # link state and restore it if publishing fails
    project = project_store.get(project_id) if project_id else None
    prior_bin_ids = list(project.bin_ids) if project is not None else None
    prior_updated_at = project.updated_at if project is not None else None
    try:
        user_bins.set(bin_id, bin_data)
        add_bin_to_project(project_store, project_id, bin_id)
    except Exception:
        if project is not None:
            project.bin_ids = prior_bin_ids
            project.updated_at = prior_updated_at
        try:
            user_bins.delete(bin_id)
        except Exception:
            logger.exception("failed to roll back imported bin %s", bin_id)
        asset_path.unlink(missing_ok=True)
        raise
    return bin_data


class FixedPlacement(BaseModel):
    tool_id: str
    placement_id: str | None = Field(default=None, min_length=1)
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    rotation: float = Field(allow_inf_nan=False)


class AutoLayoutRequest(BaseModel):
    tool_ids: list[str] = []
    placement_ids: list[str] | None = None
    clearance: float = 1.0
    bin_config: BinConfig | None = None
    auto_width: bool = False
    algorithm: Literal["auto", "raster", "packingsolver"] = "auto"
    time_budget_seconds: float = Field(default=5.0, ge=0.5, le=60.0, allow_inf_nan=False)
    fixed_placements: list[FixedPlacement] = Field(default_factory=list)


class AutoLayoutResponse(BaseModel):
    placements: list[dict]
    bounds: tuple[float, float, float, float]
    efficiency: float
    unfitted_tool_ids: list[str] = []
    unfitted_placement_ids: list[str] = Field(default_factory=list)
    grid_x: float | None = None


@router.post("/bins/auto-layout", response_model=AutoLayoutResponse)
def auto_layout_bin(req: AutoLayoutRequest, user_id: str = Depends(get_user_id)):
    """Compute an auto-layout for the given tools without creating a bin."""
    deadline = time.monotonic() + req.time_budget_seconds
    if not math.isfinite(req.clearance) or req.clearance < 0:
        raise HTTPException(status_code=400, detail="tool padding must be finite and non-negative")
    if req.auto_width and req.bin_config is None:
        raise HTTPException(status_code=400, detail="auto width requires bin_config with a fixed grid_y")
    if req.fixed_placements and req.bin_config is None:
        raise HTTPException(status_code=400, detail="pinned placements require bin_config to validate the usable interior")
    instance_ids = req.placement_ids if req.placement_ids is not None else req.tool_ids
    if req.placement_ids is not None and (
        len(instance_ids) != len(req.tool_ids)
        or any(not identity.strip() for identity in instance_ids)
        or len(set(instance_ids)) != len(instance_ids)
    ):
        raise HTTPException(status_code=400, detail="placement_ids must contain one unique nonempty string per tool_ids entry")
    library_ids = dict(zip(instance_ids, req.tool_ids))
    pins_by_id = {}
    for pin in req.fixed_placements:
        identity = pin.placement_id if req.placement_ids is not None else pin.tool_id
        if req.placement_ids is None and pin.placement_id is not None:
            raise HTTPException(status_code=400, detail="pinned placement_id requires placement_ids")
        if identity not in library_ids or library_ids[identity] != pin.tool_id:
            raise HTTPException(status_code=400, detail="each pin must identify a requested placement and its matching tool_id")
        if identity in pins_by_id:
            raise HTTPException(status_code=400, detail="each pinned placement must be specified only once")
        pins_by_id[identity] = pin
    pinned_ids = set(pins_by_id)
    if req.bin_config and any(not math.isfinite(value) for value in (
        req.bin_config.wall_thickness, req.bin_config.cutout_clearance,
    )):
        raise HTTPException(status_code=400, detail="wall thickness and cutout clearance must be finite")

    from app.services.auto_layout import (
        LayoutBusyError,
        LayoutEngineError,
        LayoutInputError,
        auto_layout,
        layout_bounds,
        layout_efficiency,
    )
    from app.services.auto_layout_geometry import LayoutGeometryError

    try:
        placed = auto_layout(
            [],
            clearance=req.clearance,
            bin_width=None,
            bin_depth=None,
            algorithm=req.algorithm,
            time_budget_seconds=req.time_budget_seconds,
            auto_width=req.auto_width,
            _deadline=deadline,
            _stored_request={"storage_path": str((settings.storage_path / user_id).absolute()),
                             "request": req},
        )
    except LayoutInputError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except LayoutGeometryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (LayoutBusyError, LayoutEngineError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if not placed:
        raise HTTPException(status_code=400, detail="no tools to layout")
    context = placed[0].context
    bin_depth = context["depth"]
    offset_x, offset_y = context["offset_x"], context["offset_y"]
    width_cap = context["width_cap"]

    bounds = layout_bounds(placed)
    fitted_ids = {p.tool_id for p in placed if p.fitted}
    computed_grid_x = None
    if req.auto_width:
        fitted = [p for p in placed if p.tool_id in fitted_ids]
        left, top, right, bottom = layout_bounds(fitted)
        step = 0.5 if req.bin_config.half_grid_base else 1.0
        computed_grid_x = min(width_cap, max(1.0, math.ceil(
            ((right if pinned_ids else right - left) + 2 * offset_x - 1e-6) / (GF_GRID * step)
        ) * step))
        if not pinned_ids:
            # Without anchors, center only after choosing the final width.
            offset_x = (computed_grid_x * GF_GRID - right - left) / 2
            offset_y += (bin_depth - bottom - top) / 2
    placements = [{
        "tool_id": library_ids[p.tool_id],
        **({"placement_id": p.tool_id} if req.placement_ids is not None else {}),
        "name": p.name,
        "x": pins_by_id[p.tool_id].x if p.tool_id in pins_by_id else p.x + offset_x,
        "y": pins_by_id[p.tool_id].y if p.tool_id in pins_by_id else p.y + offset_y,
        "rotation": p.rotation,
    } for p in placed]
    return AutoLayoutResponse(
        placements=placements,
        bounds=(bounds[0] + offset_x, bounds[1] + offset_y, bounds[2] + offset_x, bounds[3] + offset_y),
        efficiency=layout_efficiency(placed),
        unfitted_tool_ids=[tid for identity, tid in zip(instance_ids, req.tool_ids) if identity not in fitted_ids],
        unfitted_placement_ids=[identity for identity in instance_ids if identity not in fitted_ids]
        if req.placement_ids is not None else [],
        grid_x=computed_grid_x,
    )


@router.put("/bins/{bin_id}", response_model=StatusResponse)
async def update_bin(request: Request, bin_id: str, req: BinUpdateRequest, user_id: str = Depends(get_user_id)):
    _, _, user_bins = get_stores(user_id)
    project_store = get_project_store(user_id)
    bin_data = user_bins.get(bin_id)
    if not bin_data:
        raise HTTPException(status_code=404, detail="bin not found")

    old_project_id = bin_data.project_id
    if bin_data.imported_model is not None and req.model_fields_set & {"bin_config", "placed_tools", "text_labels"}:
        _reject_imported_mutation(bin_data)
    if req.name is not None:
        bin_data.name = req.name
    if "project_id" in req.model_fields_set:
        if req.project_id and not project_store.get(req.project_id):
            raise HTTPException(status_code=404, detail=f"project {req.project_id} not found")
        bin_data.project_id = req.project_id
    if req.bin_config is not None:
        bin_data.bin_config = req.bin_config
    if req.placed_tools is not None:
        bin_data.placed_tools = req.placed_tools
    if req.text_labels is not None:
        bin_data.text_labels = req.text_labels
    user_bins.set(bin_id, bin_data)
    if old_project_id != bin_data.project_id:
        remove_bin_from_project(project_store, old_project_id, bin_id)
        add_bin_to_project(project_store, bin_data.project_id, bin_id)
    return StatusResponse(status="ok")


@router.delete("/bins/{bin_id}", response_model=StatusResponse)
async def delete_bin(request: Request, bin_id: str, user_id: str = Depends(get_user_id)):
    _, _, user_bins = get_stores(user_id)
    project_store = get_project_store(user_id)
    up = _user_path(user_id)
    bin_data = user_bins.delete(bin_id)
    if not bin_data:
        raise HTTPException(status_code=404, detail="bin not found")
    remove_bin_from_project(project_store, bin_data.project_id, bin_id)
    remove_bin_from_all_projects(project_store, bin_id)

    if bin_data.stl_path:
        stl_abs = Path(_abs(bin_data.stl_path))
        stl_abs.unlink(missing_ok=True)
        stl_abs.with_suffix(".3mf").unlink(missing_ok=True)
        stl_abs.with_suffix(".hash").unlink(missing_ok=True)
    for f in up.glob(f"outputs/{bin_id}_part*.stl"):
        f.unlink(missing_ok=True)
    (up / "outputs" / f"{bin_id}_parts.zip").unlink(missing_ok=True)
    (up / "outputs" / f"{bin_id}_insert.stl").unlink(missing_ok=True)

    return StatusResponse(status="deleted")


@router.post("/bins/{bin_id}/generate", response_model=GenerateResponse)
def generate_bin_stl(request: Request, bin_id: str, user_id: str = Depends(get_user_id)):
    _, user_tools, user_bins = get_stores(user_id)
    up = _user_path(user_id)
    bin_data = user_bins.get(bin_id)
    if not bin_data:
        raise HTTPException(status_code=404, detail="bin not found")
    if bin_data.imported_model is not None:
        # the upload is the model: return the stored asset, never regenerate
        if not bin_data.stl_path or not Path(_abs(bin_data.stl_path)).exists():
            raise HTTPException(status_code=404, detail="imported model file is missing")
        url = f"/storage/{bin_data.stl_path}"
        return GenerateResponse(stl_url=url, stl_urls=[url])
    bin_data = bin_data.model_copy(deep=True)
    sync_placed_tools(bin_data, user_tools)
    if not bin_data.placed_tools and not bin_data.bin_config.access_pockets:
        raise HTTPException(status_code=400, detail="bin has no tools or access pockets")

    bc = bin_data.bin_config

    # include source tool smoothed state and measured thickness in the hash so
    # toggling either invalidates cache; thickness drives automatic depths
    smoothed_flags = {}
    for pt in bin_data.placed_tools:
        src = user_tools.get(pt.tool_id)
        smoothed_flags[pt.tool_id] = {
            "smoothed": src.smoothed if src else False,
            "smooth_level": src.smooth_level if src else 0.5,
            "thickness_mm": src.thickness_mm if src else None,
        }
    input_data = {
        "bin_config": bc.model_dump(),
        "placed_tools": [pt.model_dump() for pt in bin_data.placed_tools],
        "text_labels": [tl.model_dump() for tl in bin_data.text_labels],
        "smoothed_flags": smoothed_flags,
    }
    input_hash = hashlib.md5(json.dumps(input_data, sort_keys=True, default=str).encode()).hexdigest()

    gen_req = GenerateRequest(
        grid_x=bc.grid_x,
        grid_y=bc.grid_y,
        height_units=bc.height_units,
        magnets=bc.magnets,
        magnet_diameter=bc.magnet_diameter,
        magnet_depth=bc.magnet_depth,
        magnet_corners_only=bc.magnet_corners_only,
        stacking_lip=bc.stacking_lip,
        stacking_lip_empty_cells=bc.stacking_lip_empty_cells,
        rim_units=bc.rim_units,
        wall_thickness=bc.wall_thickness,
        cutout_depth=bc.cutout_depth,
        cutout_depth_mode=bc.cutout_depth_mode,
        stacking_clearance_mm=bc.stacking_clearance_mm,
        cutout_clearance=bc.cutout_clearance,
        insert_enabled=bc.insert_enabled,
        insert_height=bc.insert_height,
        insert_clearance=bc.insert_clearance,
        cutout_chamfer=bc.cutout_chamfer,
        partial_bins=bc.partial_bins,
        partial_bins_values=bc.partial_bins_values,
        partial_bins_connect=bc.partial_bins_connect,
        partial_bins_retain_wall=bc.partial_bins_retain_wall,
        text_labels=bc.text_labels + bin_data.text_labels,
        bed_size=bc.bed_size,
        half_grid_base=bc.half_grid_base,
        access_pockets=bc.access_pockets,
    )

    # a standalone export has no bin above it: the bin's own shell provides the
    # authoritative mating increment for its automatic depths
    increment = mating_increment_mm(gen_req) if needs_mating_increment(bc, bin_data.placed_tools) else None
    overrides = resolved_overrides(bc, bin_data.placed_tools, user_tools.all(), increment)
    scaled = generation_polygons(bin_data, user_tools.all(), overrides=overrides)

    response = _run_generate(scaled, gen_req, bin_id, up, input_hash, user_id, user_bins)

    output_path = up / "outputs" / f"{bin_id}.stl"
    fresh = user_bins.get(bin_id)
    if fresh:
        fresh.stl_path = _rel(output_path, up)
        user_bins.set(bin_id, fresh)

    return response


def _bin_stem(bin_data) -> str:
    """Standardized filename stem: Name_XuYuHu_Dmm-tracefinity"""
    bc = bin_data.bin_config
    raw = (bin_data.name or "bin").strip()
    safe = re.sub(r"[^\w\-]", "_", raw).strip("_") or "bin"
    gx = f"{bc.grid_x:g}"
    gy = f"{bc.grid_y:g}"
    return f"{safe}_{gx}u{gy}u{bc.height_units}u_{int(bc.cutout_depth)}mm-tracefinity"


# bin file downloads
@router.get("/files/bins/{bin_id}/bin.stl")
async def download_bin_stl(request: Request, bin_id: str, user_id: str = Depends(get_user_id)):
    _, _, user_bins = get_stores(user_id)
    bin_data = user_bins.get(bin_id)
    if not bin_data or not bin_data.stl_path:
        raise HTTPException(status_code=404, detail="stl not found")
    stl_abs = _abs(bin_data.stl_path)
    if not Path(stl_abs).exists():
        if bin_data.imported_model is not None:
            # an upload cannot be regenerated; ask for the file back instead
            raise HTTPException(status_code=404, detail="imported model file is missing; re-upload the STL to restore it")
        raise HTTPException(status_code=404, detail="stl expired; regenerate the bin")
    return FileResponse(
        stl_abs,
        media_type="application/sla",
        filename=f"{_bin_stem(bin_data)}.stl",
    )


@router.get("/files/bins/{bin_id}/bin_parts.zip")
async def download_bin_zip(request: Request, bin_id: str, user_id: str = Depends(get_user_id)):
    _, _, user_bins = get_stores(user_id)
    up = _user_path(user_id)
    bin_data = user_bins.get(bin_id)
    zip_path = up / "outputs" / f"{bin_id}_parts.zip"
    if not zip_path.exists():
        if bin_data and bin_data.stl_path:
            raise HTTPException(status_code=404, detail="zip expired; regenerate the bin")
        raise HTTPException(status_code=404, detail="zip not found")
    fname = f"{_bin_stem(bin_data)}-parts.zip" if bin_data else f"{bin_id[:8]}-parts.zip"
    return FileResponse(
        str(zip_path),
        media_type="application/zip",
        filename=fname,
    )


@router.get("/files/bins/{bin_id}/bin.3mf")
async def download_bin_threemf(request: Request, bin_id: str, user_id: str = Depends(get_user_id)):
    _, _, user_bins = get_stores(user_id)
    bin_data = user_bins.get(bin_id)
    if not bin_data or not bin_data.stl_path:
        raise HTTPException(status_code=404, detail="3mf not found")
    threemf_path = Path(_abs(bin_data.stl_path)).with_suffix(".3mf")
    if not threemf_path.exists():
        raise HTTPException(status_code=404, detail="3mf expired; regenerate the bin")
    return FileResponse(
        str(threemf_path),
        media_type="application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
        filename=f"{_bin_stem(bin_data)}.3mf",
    )


@router.get("/files/bins/{bin_id}/bin_insert.stl")
async def download_bin_insert(request: Request, bin_id: str, user_id: str = Depends(get_user_id)):
    _, _, user_bins = get_stores(user_id)
    up = _user_path(user_id)
    bin_data = user_bins.get(bin_id)
    insert_path = up / "outputs" / f"{bin_id}_insert.stl"
    if not insert_path.exists():
        if bin_data and bin_data.stl_path:
            raise HTTPException(status_code=404, detail="insert stl expired; regenerate the bin")
        raise HTTPException(status_code=404, detail="insert stl not found")
    fname = f"{_bin_stem(bin_data)}-insert.stl" if bin_data else f"{bin_id[:8]}-insert.stl"
    return FileResponse(
        str(insert_path),
        media_type="application/sla",
        filename=fname,
    )


def _dir_size(path: Path) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for f in filenames:
            total += os.path.getsize(os.path.join(dirpath, f))
    return total


STORAGE_STATS_TTL_SECONDS = 60
_storage_stats_cache: tuple[Path, float, dict] | None = None
_storage_stats_lock = threading.Lock()


def _storage_stats_snapshot(storage: Path) -> dict:
    """Return briefly cached storage totals without overlapping filesystem scans."""
    global _storage_stats_cache

    now = time.monotonic()
    with _storage_stats_lock:
        if _storage_stats_cache is not None:
            cached_path, cached_at, cached_result = _storage_stats_cache
            if cached_path == storage and now - cached_at < STORAGE_STATS_TTL_SECONDS:
                return cached_result

        users = [d for d in storage.iterdir() if d.is_dir()]
        per_user = []
        total = 0
        for user_dir in sorted(users):
            size = _dir_size(user_dir)
            total += size
            per_user.append({"userId": user_dir.name, "bytes": size})

        result = {"totalBytes": total, "users": per_user}
        _storage_stats_cache = (storage, now, result)
        return result


@router.get("/admin/storage-stats", dependencies=[Depends(require_instance_admin)])
def storage_stats():
    return _storage_stats_snapshot(settings.storage_path)
