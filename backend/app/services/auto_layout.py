"""Auto-layout service: greedy bottom-left packing with rotation search."""
from __future__ import annotations

import math
from dataclasses import dataclass
from itertools import chain

from shapely.affinity import rotate, translate
from shapely.geometry import Polygon, box
from shapely.prepared import PreparedGeometry, prep

ANGLE_STEP = 5.0  # rotation screening resolution in degrees
REFINE_ANGLES = 4  # best screened angles re-searched on the full grid
# edge-contact candidates stand 1um off the obstacle: they are derived from the
# obstacle bounds, and a strict intersects() test rejects exact contact, making
# float noise decide whether a touch is legal
HUG_EPS = 1e-6


@dataclass
class PlacedItem:
    tool_id: str
    name: str
    x: float  # min corner of the placed polygon, mm
    y: float
    rotation: float  # absolute orientation in degrees
    polygon: Polygon


def auto_layout(
    tools: list[dict],
    clearance: float = 1.0,
    step: float = 2.0,
    max_search: float = 400.0,
    bin_width: float | None = None,
    bin_depth: float | None = None,
) -> list[PlacedItem]:
    """Greedy bottom-left packing, trying many rotations to fit the target.

    Args:
        tools: List of dicts with keys: id, name, polygon (Shapely Polygon)
        clearance: Minimum distance between tools in mm
        step: Search grid step in mm
        max_search: Maximum layout extent in mm when no bin target is given
        bin_width: Target bin width in mm; placements stay inside when they fit
        bin_depth: Target bin depth in mm

    Returns:
        List of PlacedItem; x/y is the minimum corner of the placed polygon and
        rotation the absolute orientation in degrees. The layout is packed into
        the (0, 0) corner.
    """
    step = max(1, int(step))
    target_w = bin_width if bin_width and bin_width > 0 else None
    target_d = bin_depth if bin_depth and bin_depth > 0 else None
    bin_box = box(0.0, 0.0, target_w, target_d) if target_w and target_d else None

    placed: list[PlacedItem] = []
    # obstacle = polygon grown by clearance; its bbox pre-filters shape tests
    obstacles: list[tuple[tuple[float, float, float, float], PreparedGeometry]] = []
    # running layout bounds (min_x, min_y, max_x, max_y) of placed polygons
    lay = [0.0, 0.0, 0.0, 0.0]

    for tool in tools:
        if tool["polygon"].is_empty:
            continue  # empty outline cannot be placed

        # screen every rotation on cheap contact positions, then re-search the
        # most promising angles on the full grid
        screened: list[tuple[tuple, float]] = []
        for rotation in _angles(ANGLE_STEP):
            rotated = rotate(tool["polygon"], rotation, origin=(0, 0))
            minx, miny, maxx, maxy = rotated.bounds
            if math.isnan(minx):
                continue  # degenerate outline cannot be placed
            w, h = maxx - minx, maxy - miny
            hit = _best_fit(
                rotated, minx, miny, w, h,
                _hug_positions(obstacles, w, h, target_w, target_d),
                obstacles, lay, bin_box, target_w, target_d,
            )
            if hit is not None:
                screened.append((hit[0], rotation))
        screened.sort(key=lambda s: s[0])

        best_key = None
        best = None  # (x, y, rotation, polygon)
        for _, rotation in screened[:REFINE_ANGLES]:
            rotated = rotate(tool["polygon"], rotation, origin=(0, 0))
            minx, miny, maxx, maxy = rotated.bounds
            w, h = maxx - minx, maxy - miny
            hit = _best_fit(
                rotated, minx, miny, w, h,
                chain(
                    _hug_positions(obstacles, w, h, target_w, target_d),
                    _grid_positions(lay, w, h, clearance, step, max_search, target_w, target_d),
                ),
                obstacles, lay, bin_box, target_w, target_d,
            )
            if hit is not None and (best_key is None or hit[0] < best_key):
                best_key = hit[0]
                best = (hit[1], hit[2], hit[3], rotation)

        if best is not None:
            x, y, polygon, rotation = best
            placed.append(PlacedItem(tool["id"], tool["name"], x, y, rotation, polygon))
            bx0, by0, bx1, by1 = polygon.bounds
            lay[0] = min(lay[0], bx0)
            lay[1] = min(lay[1], by0)
            lay[2] = max(lay[2], bx1)
            lay[3] = max(lay[3], by1)
            grown = polygon.buffer(clearance)
            obstacles.append((grown.bounds, prep(grown)))

    if placed:
        # pack the layout into the origin corner
        dx, dy = -lay[0], -lay[1]
        for p in placed:
            p.x += dx
            p.y += dy
            p.polygon = translate(p.polygon, dx, dy)

    return placed


def _angles(step_deg: float) -> list[float]:
    return [i * step_deg for i in range(int(round(360 / step_deg)))]


def _hug_positions(obstacles, w, h, target_w, target_d):
    """Candidate min corners: the origin plus positions hugging an obstacle
    edge or a bin wall, where a bottom-left placement can touch the layout.

    # ponytail: bbox-edge contacts only; nesting under overhangs needs obstacle
    vertex candidates, quadratic in outline vertex count. Angles outside the
    top REFINE_ANGLES are ranked on these contacts alone."""
    xs = {0.0}
    ys = {0.0}
    for (bx0, by0, bx1, by1), _ in obstacles:
        xs.update((bx1 + HUG_EPS, bx0 - w - HUG_EPS))
        ys.update((by1 + HUG_EPS, by0 - h - HUG_EPS))
    if target_w:
        xs.add(target_w - w - HUG_EPS)  # against the far wall, staying inside
    if target_d:
        ys.add(target_d - h - HUG_EPS)
    return ((x, y) for y in sorted(ys) for x in sorted(xs))


def _grid_positions(lay, w, h, clearance, step, max_search, target_w, target_d):
    """Full search grid: the target bin, or the current layout extent plus the
    tool size when no target is given (past that a placement can only grow the
    bounding box)."""
    x_max = target_w if target_w else min(max_search, lay[2] + w + clearance + step)
    y_max = target_d if target_d else min(max_search, lay[3] + h + clearance + step)
    xs = range(0, int(x_max) + 1, step)
    ys = range(0, int(y_max) + 1, step)
    return ((x, y) for y in ys for x in xs)


def _score_key(lay, x, y, w, h, candidate, bin_box, target_w, target_d):
    """Least area outside the target bin, then smallest layout bounding box,
    then bottom-left."""
    bbox_area = (max(lay[2], x + w) - min(lay[0], x)) * (max(lay[3], y + h) - min(lay[1], y))
    outside = 0.0
    if bin_box is not None and (x < 0 or y < 0 or x + w > target_w or y + h > target_d):
        outside = candidate.difference(bin_box).area
    return (outside, bbox_area, y, x)


def _best_fit(rotated, minx, miny, w, h, positions, obstacles, lay, bin_box, target_w, target_d):
    """Return (key, x, y, polygon) for the best-scoring collision-free
    position, or None when every position collides."""
    best = None
    for x, y in positions:
        candidate = translate(rotated, x - minx, y - miny)
        near = [grown for (bx0, by0, bx1, by1), grown in obstacles if x <= bx1 and x + w >= bx0 and y <= by1 and y + h >= by0]
        if any(grown.intersects(candidate) for grown in near):
            continue
        key = _score_key(lay, x, y, w, h, candidate, bin_box, target_w, target_d)
        if best is None or key < best[0]:
            best = (key, x, y, candidate)
    return best


def layout_bounds(placed: list[PlacedItem]) -> tuple[float, float, float, float]:
    """Return (min_x, min_y, max_x, max_y) of all placed items."""
    if not placed:
        return (0.0, 0.0, 0.0, 0.0)
    all_polys = [p.polygon for p in placed]
    return (
        min(p.bounds[0] for p in all_polys),
        min(p.bounds[1] for p in all_polys),
        max(p.bounds[2] for p in all_polys),
        max(p.bounds[3] for p in all_polys),
    )


def layout_efficiency(placed: list[PlacedItem]) -> float:
    """Return packing efficiency as ratio of tool area to bounding box area."""
    if not placed:
        return 0.0
    tool_area = sum(p.polygon.area for p in placed)
    minx, miny, maxx, maxy = layout_bounds(placed)
    bbox_area = (maxx - minx) * (maxy - miny)
    return tool_area / bbox_area if bbox_area > 0 else 0.0
