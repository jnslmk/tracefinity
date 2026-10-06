"""Measured drawer-floor polygon geometry.

A drawer plan's boundary lives in drawer-space millimetres (x to the right, y
downwards) from the corrected-photo origin. The outer ring is the usable floor;
interior rings are excluded obstructions (walls, bosses, hinges, latches). The
2D floor, the 3D floor, planning warnings, container-fit clearance and automatic
packing all test containment through this module, so one rule decides whether a
footprint is covered -- corners alone are not enough, because a concave notch or
an interior hole can leave every corner inside while the footprint is not covered.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence

from app.constants import GF_GRID as GRID_UNIT

Ring = list[tuple[float, float]]
Rect = tuple[float, float, float, float]  # x0, y0, x1, y1

# tolerance for "touching" comparisons; measurements are millimetres, a micron
# is far below anything a photo-derived boundary can resolve
EPS = 1e-6
AREA_EPS = 1e-3  # mm^2
MIN_RING_POINTS = 3


def ring_from_points(points: Iterable) -> Ring:
    """Convert schema Points (or pairs) into plain ``(x, y)`` tuples."""
    ring: Ring = []
    for point in points:
        if isinstance(point, (tuple, list)):
            ring.append((float(point[0]), float(point[1])))
        else:
            ring.append((float(point.x), float(point.y)))
    return ring


def ring_area(ring: Sequence[tuple[float, float]]) -> float:
    """Signed shoelace area; positive for clockwise winding in y-down space."""
    total = 0.0
    for i, (x0, y0) in enumerate(ring):
        x1, y1 = ring[(i + 1) % len(ring)]
        total += x0 * y1 - x1 * y0
    return total / 2.0


def polygon_area(outer: Sequence[tuple[float, float]], holes: Sequence[Sequence[tuple[float, float]]] = ()) -> float:
    """Usable area of the boundary: outer ring minus its interior rings."""
    return abs(ring_area(outer)) - sum(abs(ring_area(hole)) for hole in holes)


def point_in_ring(point: tuple[float, float], ring: Sequence[tuple[float, float]]) -> bool:
    """Ray-cast membership. Points on the boundary are undefined, not inside."""
    x, y = point
    inside = False
    count = len(ring)
    for i in range(count):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % count]
        if (y0 > y) != (y1 > y):
            x_cross = (x1 - x0) * (y - y0) / (y1 - y0) + x0
            if x < x_cross:
                inside = not inside
    return inside


def _on_ring_edge(point: tuple[float, float], ring: Sequence[tuple[float, float]]) -> bool:
    """True when the point lies on one of the ring's edges."""
    count = len(ring)
    for i in range(count):
        a, b = ring[i], ring[(i + 1) % count]
        if abs(_orient(a, b, point)) <= EPS and _on_segment(a, b, point):
            return True
    return False


def point_in_ring_closed(point: tuple[float, float], ring: Sequence[tuple[float, float]]) -> bool:
    """Membership including the boundary: a footprint vertex on the floor edge is covered."""
    return point_in_ring(point, ring) or _on_ring_edge(point, ring)


def point_in_polygon(
    point: tuple[float, float],
    outer: Sequence[tuple[float, float]],
    holes: Sequence[Sequence[tuple[float, float]]] = (),
) -> bool:
    """Usable-floor membership.

    The outer ring counts its own boundary, so a nominal footprint touching the
    floor edge is still covered at zero clearance; an exclusion does not, so a
    footprint merely grazing an obstruction is not pushed out.
    """
    if not point_in_ring_closed(point, outer):
        return False
    return not any(
        point_in_ring(point, hole) and not _on_ring_edge(point, hole)
        for hole in holes
    )


def _orient(a, b, c) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(a, b, p) -> bool:
    return (
        min(a[0], b[0]) - EPS <= p[0] <= max(a[0], b[0]) + EPS
        and min(a[1], b[1]) - EPS <= p[1] <= max(a[1], b[1]) + EPS
        and abs(_orient(a, b, p)) <= EPS
    )


def segments_intersect(a0, a1, b0, b1) -> bool:
    """True when the two closed segments share any point."""
    d1 = _orient(b0, b1, a0)
    d2 = _orient(b0, b1, a1)
    d3 = _orient(a0, a1, b0)
    d4 = _orient(a0, a1, b1)
    if ((d1 > EPS and d2 < -EPS) or (d1 < -EPS and d2 > EPS)) and (
        (d3 > EPS and d4 < -EPS) or (d3 < -EPS and d4 > EPS)
    ):
        return True
    return (
        (abs(d1) <= EPS and _on_segment(b0, b1, a0))
        or (abs(d2) <= EPS and _on_segment(b0, b1, a1))
        or (abs(d3) <= EPS and _on_segment(a0, a1, b0))
        or (abs(d4) <= EPS and _on_segment(a0, a1, b1))
    )


def ring_is_simple(ring: Sequence[tuple[float, float]]) -> bool:
    """False when any pair of non-adjacent edges crosses."""
    count = len(ring)
    if count < MIN_RING_POINTS:
        return False
    edges = [(ring[i], ring[(i + 1) % count]) for i in range(count)]
    for i in range(count):
        for j in range(i + 1, count):
            if j in (i, i + 1) or (i == 0 and j == count - 1):
                continue
            if segments_intersect(edges[i][0], edges[i][1], edges[j][0], edges[j][1]):
                return False
    return True


def _rings_cross(a: Sequence[tuple[float, float]], b: Sequence[tuple[float, float]]) -> bool:
    for i in range(len(a)):
        a0, a1 = a[i], a[(i + 1) % len(a)]
        for j in range(len(b)):
            b0, b1 = b[j], b[(j + 1) % len(b)]
            if segments_intersect(a0, a1, b0, b1):
                return True
    return False


def validate_outline(
    outer: Sequence[tuple[float, float]],
    holes: Sequence[Sequence[tuple[float, float]]] = (),
) -> None:
    """Raise ``ValueError`` unless the boundary is a finite, simple, non-empty polygon.

    Every message is user-facing: the API turns it into a 400 and the saved plan
    is left untouched.
    """
    for label, ring in [("outline", outer), *[(f"exclusion {i + 1}", h) for i, h in enumerate(holes)]]:
        if len(ring) < MIN_RING_POINTS:
            raise ValueError(f"{label} needs at least {MIN_RING_POINTS} points")
        if any(not (math.isfinite(x) and math.isfinite(y)) for x, y in ring):
            raise ValueError(f"{label} contains a non-finite point")
        if abs(ring_area(ring)) < AREA_EPS:
            raise ValueError(f"{label} encloses no area")
        if not ring_is_simple(ring):
            raise ValueError(f"{label} crosses itself")
    if abs(ring_area(outer)) < AREA_EPS:
        raise ValueError("outline encloses no area")

    for i, hole in enumerate(holes):
        if not all(point_in_ring(p, outer) for p in hole):
            raise ValueError(f"exclusion {i + 1} is not inside the outline")
        if _rings_cross(hole, outer):
            raise ValueError(f"exclusion {i + 1} crosses the outline")
        for j in range(i + 1, len(holes)):
            if _rings_cross(hole, holes[j]):
                raise ValueError(f"exclusions {i + 1} and {j + 1} overlap")
            # nested rings cross nothing but subtract twice and render as an island
            if any(point_in_ring(p, holes[j]) for p in hole) or any(point_in_ring(p, hole) for p in holes[j]):
                raise ValueError(f"exclusions {i + 1} and {j + 1} overlap")


def rect_inside(
    rect: Rect,
    outer: Sequence[tuple[float, float]],
    holes: Sequence[Sequence[tuple[float, float]]] = (),
    clearance: float = 0.0,
) -> bool:
    """True when the rectangle is covered by the usable floor with ``clearance``.

    ``clearance`` is a Euclidean gap in millimetres to every boundary edge, so a
    corner does not have to retreat by ``clearance`` along both axes (a wall at
    45 degrees takes only ``clearance``/sqrt(2) per axis). Corners inside are
    necessary but not sufficient: an edge entering the rectangle, or an exclusion
    overlapping it, means part of the footprint is not floor.
    """
    x0, y0, x1, y1 = rect
    if x1 - x0 <= EPS or y1 - y0 <= EPS:
        return False
    return shape_inside(
        [(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
        outer,
        holes,
        clearance,
    )


def cell_inside(
    x_mm: float,
    y_mm: float,
    size_mm: float,
    outer: Sequence[tuple[float, float]],
    holes: Sequence[Sequence[tuple[float, float]]] = (),
    clearance: float = 0.0,
) -> bool:
    return rect_inside((x_mm, y_mm, x_mm + size_mm, y_mm + size_mm), outer, holes, clearance)


def rotate_point(point: tuple[float, float], radians: float) -> tuple[float, float]:
    """Rotate about the origin in y-down space (positive turns clockwise on screen)."""
    cos_a, sin_a = math.cos(radians), math.sin(radians)
    x, y = point
    return (x * cos_a - y * sin_a, x * sin_a + y * cos_a)


def footprint_corners(
    origin: tuple[float, float],
    rotation_deg: float,
    x_units: float,
    y_units: float,
    w_units: float,
    h_units: float,
) -> list[tuple[float, float]]:
    """The four corners of a grid footprint in drawer millimetres.

    The grid frame is anchored at ``origin`` and turned by ``rotation_deg``, so a
    footprint follows the drawer edge it was aligned to instead of the drawer
    axes. Clearance is applied by the containment test, not baked in here.
    """
    radians = math.radians(rotation_deg)
    local = (
        (x_units * GRID_UNIT, y_units * GRID_UNIT),
        ((x_units + w_units) * GRID_UNIT, y_units * GRID_UNIT),
        ((x_units + w_units) * GRID_UNIT, (y_units + h_units) * GRID_UNIT),
        (x_units * GRID_UNIT, (y_units + h_units) * GRID_UNIT),
    )
    corners = []
    for point in local:
        rx, ry = rotate_point(point, radians)
        corners.append((origin[0] + rx, origin[1] + ry))
    return corners


def shape_inside(
    points: Sequence[tuple[float, float]],
    outer: Sequence[tuple[float, float]],
    holes: Sequence[Sequence[tuple[float, float]]] = (),
    clearance: float = 0.0,
) -> bool:
    """True when a convex footprint is covered by the usable floor.

    Vertices inside are necessary but not sufficient: a concave notch or an
    exclusion edge can pass through the footprint while every vertex stays
    inside. Only an edge entering the footprint's *interior* breaks coverage, so
    a nominal footprint touching the boundary is covered at zero clearance.
    ``clearance`` is the Euclidean gap every boundary edge must keep from the
    footprint, not a per-axis expansion.
    """
    if len(points) < 3 or any(not point_in_polygon(p, outer, holes) for p in points):
        return False
    for ring in (outer, *holes):
        for i in range(len(ring)):
            if _segment_enters_shape(ring[i], ring[(i + 1) % len(ring)], points):
                return False
    for hole in holes:
        for point in hole:
            if _point_in_shape(point, points):
                return False
        # an exclusion sharing a boundary edge, with both interiors on the same
        # side, coincides with the footprint instead of merely touching it
        if _shares_interior_side(points, hole):
            return False
    if clearance > 0:
        for ring in (outer, *holes):
            for i in range(len(ring)):
                a0, a1 = ring[i], ring[(i + 1) % len(ring)]
                for j in range(len(points)):
                    if _segment_distance(a0, a1, points[j], points[(j + 1) % len(points)]) < clearance - EPS:
                        return False
    return True


def _ring_centroid(ring: Sequence[tuple[float, float]]) -> tuple[float, float]:
    """Area centroid; inside a convex ring, and a usable interior-side witness."""
    area = ring_area(ring)
    if abs(area) < EPS:
        return ring[0]
    cx = cy = 0.0
    for i, (x0, y0) in enumerate(ring):
        x1, y1 = ring[(i + 1) % len(ring)]
        cross = x0 * y1 - x1 * y0
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    return cx / (6 * area), cy / (6 * area)


def _segments_overlap(a0, a1, b0, b1) -> bool:
    """Positive-length overlap of two collinear segments."""
    dx = a1[0] - a0[0]
    dy = a1[1] - a0[1]
    if abs(dx) >= abs(dy):
        lo, hi = sorted((a0[0], a1[0]))
        blo, bhi = sorted((b0[0], b1[0]))
    else:
        lo, hi = sorted((a0[1], a1[1]))
        blo, bhi = sorted((b0[1], b1[1]))
    return min(hi, bhi) - max(lo, blo) > EPS


def _shares_interior_side(points: Sequence[tuple[float, float]], hole: Sequence[tuple[float, float]]) -> bool:
    """True when the footprint and the exclusion share a boundary edge and overlap.

    The exclusion's interior side of one of its own edges is fixed by the ring's
    winding, not by its area centroid: a U-shaped exclusion can wrap around the
    footprint so its centroid lands inside the footprint while the shared edge is
    still harmless contact. The footprint covers excluded material only when its
    interior lies on the hole's interior side of the shared edge.
    """
    footprint_centroid = _ring_centroid(points)
    interior_sign = 1.0 if ring_area(hole) > 0 else -1.0
    count = len(points)
    for i in range(len(hole)):
        h0 = hole[i]
        h1 = hole[(i + 1) % len(hole)]
        for j in range(count):
            p0 = points[j]
            p1 = points[(j + 1) % count]
            if abs(_orient(h0, h1, p0)) > EPS or abs(_orient(h0, h1, p1)) > EPS:
                continue
            if not _segments_overlap(h0, h1, p0, p1):
                continue
            if interior_sign * _orient(h0, h1, footprint_centroid) > 0:
                return True
    return False


def _point_segment_distance(p, a, b) -> float:
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length_sq = dx * dx + dy * dy
    if length_sq <= EPS:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length_sq))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def _segment_distance(a0, a1, b0, b1) -> float:
    """Euclidean distance between two segments; zero when they touch or cross."""
    if segments_intersect(a0, a1, b0, b1):
        return 0.0
    return min(
        _point_segment_distance(a0, b0, b1),
        _point_segment_distance(a1, b0, b1),
        _point_segment_distance(b0, a0, a1),
        _point_segment_distance(b1, a0, a1),
    )


def _point_in_shape(point: tuple[float, float], points: Sequence[tuple[float, float]]) -> bool:
    """Strictly-inside test for a convex footprint; boundary points are not inside."""
    count = len(points)
    sign = 0
    for i in range(count):
        cross = _orient(points[i], points[(i + 1) % count], point)
        if abs(cross) <= EPS:
            return False
        current = 1 if cross > 0 else -1
        if sign and current != sign:
            return False
        sign = current
    return sign != 0


def _segment_enters_shape(a, b, points: Sequence[tuple[float, float]]) -> bool:
    """True when any part of the segment lies strictly inside the convex footprint.

    The segment is clipped against the footprint's half-planes; a run that only
    touches the boundary (a shared corner or a collinear edge) does not enter.
    """
    count = len(points)
    winding = 1.0 if ring_area(points) > 0 else -1.0
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    t_enter, t_exit = 0.0, 1.0
    along_boundary = False
    for i in range(count):
        p0 = points[i]
        p1 = points[(i + 1) % count]
        offset = winding * _orient(p0, p1, a)
        slope = winding * ((p1[0] - p0[0]) * dy - (p1[1] - p0[1]) * dx)
        if abs(slope) <= EPS:
            if offset < -EPS:
                return False
            if abs(offset) <= EPS:
                along_boundary = True
            continue
        t = -offset / slope
        if slope > 0:
            t_enter = max(t_enter, t)
        else:
            t_exit = min(t_exit, t)
        if t_enter > t_exit:
            return False
    if t_exit - t_enter <= EPS:
        return False
    return not along_boundary
