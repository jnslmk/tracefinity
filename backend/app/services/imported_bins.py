"""Planning-only STL imports.

User-uploaded meshes are measured, normalized and stored verbatim (as a
canonical binary STL) so they can be planned around but never edited, never
host a traced cutout, and never be reported as a verified physical
interface. Parsing is deliberately self-contained: no mesh library and no
external resolver is consulted, so a hostile file can only ever produce a
rejected upload, never a fetch or a code path outside this module.
"""

from __future__ import annotations

import math
import os
import struct
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app.constants import MAX_BIN_GRID_CELLS, MAX_BIN_GRID_UNITS, MIN_BIN_GRID_UNITS
from app.services.stl_generator_manifold import GF_HALF_GRID, GF_HEIGHT_UNIT, LIP_D0, LIP_D1, LIP_D2

MAX_IMPORT_BYTES = 25 * 1024 * 1024
MAX_IMPORT_TRIANGLES = 1_000_000
MIN_EXTENT_MM = 0.1
FOOTPRINT_TOLERANCE_MM = 0.75
HEIGHT_TOLERANCE_MM = 0.75

# stacking lip adds a fixed band above the nominal wall top
LIP_HEIGHT_MM = LIP_D0 + LIP_D1 + LIP_D2

_BINARY_RECORD = np.dtype([("normal", "<f4", 3), ("vertices", "<f4", (3, 3)), ("attr", "<u2")])


class StlImportError(ValueError):
    """Rejected upload; the message is safe to return to the client."""


@dataclass
class ImportedModel:
    """Validated, normalized import ready to persist and plan around."""

    stl_bytes: bytes
    width_mm: float
    depth_mm: float
    height_mm: float
    grid_x: float
    grid_y: float
    height_units: int
    stacking_lip: bool
    half_grid_base: bool
    warnings: list[str] = field(default_factory=list)


def parse_stl_bytes(data: bytes) -> np.ndarray:
    """Parse a bounded ASCII or binary STL into an (n, 3, 3) triangle array.

    The binary layout is recognised by its exact record length and is checked
    *first*: an STL header is arbitrary bytes and may itself start with
    ``solid``/``facet`` text, so no header heuristic may run before the size
    check or a valid binary export would be misread as ASCII.
    """
    if len(data) < 15:
        raise StlImportError("file is too small to be an STL")
    if len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        if count and 84 + 50 * count == len(data):
            if count > MAX_IMPORT_TRIANGLES:
                raise StlImportError("STL contains more triangles than the importer accepts")
            return _parse_binary(data, count)
    return _parse_ascii(data)


def _parse_binary(data: bytes, count: int) -> np.ndarray:
    triangles = np.frombuffer(data, dtype=_BINARY_RECORD, count=count, offset=84)["vertices"]
    return triangles.astype(np.float64)


def _parse_ascii(data: bytes) -> np.ndarray:
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        raise StlImportError("file is neither a binary nor an ASCII STL")
    if "vertex" not in text or "facet" not in text:
        raise StlImportError("file is neither a binary nor an ASCII STL")
    vertices: list[tuple[float, float, float]] = []
    for line in text.splitlines():
        if not line.lstrip().startswith("vertex"):
            continue
        parts = line.split()
        if len(parts) < 4:
            raise StlImportError("STL contains a malformed vertex line")
        try:
            vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
        except ValueError:
            raise StlImportError("STL contains a non-numeric vertex coordinate")
        if len(vertices) > MAX_IMPORT_TRIANGLES * 3:
            raise StlImportError("STL contains more triangles than the importer accepts")
    if not vertices:
        raise StlImportError("STL contains no triangles")
    if len(vertices) % 3:
        raise StlImportError("STL vertex count is not a multiple of three")
    return np.asarray(vertices, dtype=np.float64).reshape(-1, 3, 3)


def normalize_triangles(triangles: np.ndarray) -> tuple[np.ndarray, tuple[float, float, float]]:
    """Center X/Y and drop Z-min to zero, matching generated STL coordinates."""
    flat = triangles.reshape(-1, 3)
    minimum = flat.min(axis=0)
    maximum = flat.max(axis=0)
    offset = np.array([(minimum[0] + maximum[0]) / 2.0, (minimum[1] + maximum[1]) / 2.0, minimum[2]])
    return triangles - offset, (maximum - minimum)


def triangles_to_binary_stl(triangles: np.ndarray) -> bytes:
    """Serialize normalized float64 triangles as a little-endian binary STL."""
    count = len(triangles)
    cross = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    lengths = np.linalg.norm(cross, axis=1)
    lengths[lengths == 0] = 1.0
    normals = cross / lengths[:, None]
    records = np.zeros(count, dtype=_BINARY_RECORD)
    records["normal"] = normals.astype("<f4")
    records["vertices"] = triangles.astype("<f4")
    return b"\x00" * 80 + struct.pack("<I", count) + records.tobytes()


def detect_footprint(mm: float) -> tuple[float, bool]:
    """Detect a gridfinity footprint axis; conservative and never smaller."""
    half_units = (mm + 0.5) / GF_HALF_GRID
    nearest = round(half_units)
    if nearest >= 2 and abs(half_units - nearest) * GF_HALF_GRID <= FOOTPRINT_TOLERANCE_MM:
        return nearest / 2.0, True
    return math.ceil(max(half_units, 2.0)) / 2.0, False


def detect_height(mm: float) -> tuple[int, bool, bool]:
    """Detect body height units and whether a stacking lip accounts for the rest."""
    options: list[tuple[float, int, bool]] = []
    for units in range(1, 21):
        options.append((units * GF_HEIGHT_UNIT, units, False))
        options.append((units * GF_HEIGHT_UNIT + LIP_HEIGHT_MM, units, True))
    nearest = min(options, key=lambda option: abs(option[0] - mm))
    if abs(nearest[0] - mm) <= HEIGHT_TOLERANCE_MM:
        return nearest[1], nearest[2], True
    feasible = [option for option in options if option[0] >= mm - 1e-9]
    if not feasible:
        raise StlImportError("imported model is taller than the supported 20-unit maximum")
    _, units, lip = min(feasible, key=lambda option: option[0])
    return units, lip, False


def process_import(data: bytes) -> ImportedModel:
    """Validate, normalize and classify an uploaded STL.

    Raises StlImportError with a client-safe message for every rejection.
    """
    if len(data) > MAX_IMPORT_BYTES:
        raise StlImportError("STL exceeds the 25 MiB upload limit")
    triangles = parse_stl_bytes(data)
    if len(triangles) == 0:
        raise StlImportError("STL contains no triangles")
    if not np.isfinite(triangles).all():
        raise StlImportError("STL contains non-finite coordinates")

    with np.errstate(over="ignore"):
        # an extreme-but-finite input can overflow to infinity here; the
        # isfinite check below turns that into a controlled rejection
        normalized, extents = normalize_triangles(triangles)
    # finite coordinates can still produce an infinite measured extent (e.g.
    # -1e308 to 1e308 overflows float64), and downstream grid math would then
    # raise; reject the derived extent before any footprint math or export
    if not np.isfinite(extents).all() or not np.isfinite(normalized).all():
        raise StlImportError("STL dimensions are too large to be represented")
    width, depth, height = (float(extents[0]), float(extents[1]), float(extents[2]))
    if min(width, depth, height) <= MIN_EXTENT_MM:
        raise StlImportError("STL has no positive extent on every axis")

    grid_x, width_standard = detect_footprint(width)
    grid_y, depth_standard = detect_footprint(depth)
    height_units, stacking_lip, height_standard = detect_height(height)
    half_grid_base = (grid_x * 2) % 2 != 0 or (grid_y * 2) % 2 != 0

    if grid_x < MIN_BIN_GRID_UNITS or grid_y < MIN_BIN_GRID_UNITS:
        raise StlImportError("imported model is smaller than the supported 1-unit minimum footprint")
    if grid_x > MAX_BIN_GRID_UNITS or grid_y > MAX_BIN_GRID_UNITS:
        raise StlImportError(
            f"imported model needs a {grid_x:g}x{grid_y:g} grid; bins support up to "
            f"{MAX_BIN_GRID_UNITS:g} units per axis"
        )
    if math.ceil(grid_x) * math.ceil(grid_y) > MAX_BIN_GRID_CELLS:
        raise StlImportError(
            f"imported model exceeds the supported {MAX_BIN_GRID_CELLS}-cell planning footprint"
        )

    warnings: list[str] = []
    if not width_standard:
        warnings.append(
            f"measured width {width:.1f}mm is not a standard 42/21mm grid footprint; "
            f"planning uses a conservative {grid_x:g}-unit footprint"
        )
    if not depth_standard:
        warnings.append(
            f"measured depth {depth:.1f}mm is not a standard 42/21mm grid footprint; "
            f"planning uses a conservative {grid_y:g}-unit footprint"
        )
    if not height_standard:
        warnings.append(
            f"measured height {height:.1f}mm is not a standard 7mm multiple; "
            f"planning uses a conservative {height_units * GF_HEIGHT_UNIT + (LIP_HEIGHT_MM if stacking_lip else 0):.1f}mm height"
        )

    return ImportedModel(
        stl_bytes=triangles_to_binary_stl(normalized),
        width_mm=width,
        depth_mm=depth,
        height_mm=height,
        grid_x=grid_x,
        grid_y=grid_y,
        height_units=height_units,
        stacking_lip=stacking_lip,
        half_grid_base=half_grid_base,
        warnings=warnings,
    )


def store_import_asset(path: Path, data: bytes) -> None:
    """Atomically publish an import; a crash leaves either no file or the whole file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(dir=path.parent, prefix=".import_", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        Path(temp_path).replace(path)
    except Exception:
        Path(temp_path).unlink(missing_ok=True)
        raise
