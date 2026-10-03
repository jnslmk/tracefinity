"""Original-outline placement, validation and fit-first scoring for both engines."""
from __future__ import annotations

import math
import time
from dataclasses import dataclass

from shapely.affinity import rotate, translate
from shapely.geometry import Polygon

TOLERANCE = 1e-6
ANGLES = (0, 90, 180, 270, 45, 135, 225, 315,
          15, 105, 195, 285, 30, 120, 210, 300,
          60, 150, 240, 330, 75, 165, 255, 345)


class LayoutGeometryError(RuntimeError):
    """Finite inputs whose requested rigid placement cannot survive arithmetic."""


@dataclass(init=False)
class PlacedItem:
    """A rigid placement; parent responses need scalars, not a GEOS reconstruction."""

    tool_id: str
    name: str
    x: float
    y: float
    rotation: float
    polygon: Polygon

    def __init__(self, tool_id, name, x, y, rotation, polygon):
        self.tool_id, self.name = tool_id, name
        self.x, self.y, self.rotation = x, y, rotation
        self._polygon = polygon
        self._bounds = self._area = None
        self._source = self._pose = None
        self.context = {}
        self.fitted = False

    @classmethod
    def from_validated(cls, row, source, context):
        """Materialize only scalar data emitted by our original-geometry worker."""
        item = cls(source["id"], source["name"], row["x"], row["y"], row["rotation"], None)
        item._bounds = tuple(row["bounds"])
        item._area = row["area"]
        item._source = source
        item._pose = (item.x, item.y, item.rotation)
        item.context = context
        item.fitted = row["fitted"]
        return item

    @property
    def polygon(self):
        if self._polygon is None:
            from shapely import from_wkb

            original = self._source.get("_polygon")
            if original is None:
                original = from_wkb(bytes.fromhex(self._source["wkb"]))
                self._source["_polygon"] = original
            x, y, angle = self._pose
            rotated = rotate(original, angle % 360.0, origin=(0, 0))
            left, top, _, _ = rotated.bounds
            self._polygon = translate(rotated, x - left, y - top)
        return self._polygon

    @polygon.setter
    def polygon(self, polygon):
        self._polygon = polygon
        self._bounds = self._area = None
        self._source = self._pose = None

    @property
    def bounds(self):
        if self._bounds is None:
            self._bounds = self.polygon.bounds
        return self._bounds

    @property
    def area(self):
        if self._area is None:
            self._area = self.polygon.area
        return self._area

    def shift(self, dx, dy):
        """A common translation is an isometry; no proposal needs re-validation."""
        self.x += dx
        self.y += dy
        left, top, right, bottom = self.bounds
        self._bounds = (left + dx, top + dy, right + dx, bottom + dy)
        if self._pose is not None:
            x, y, angle = self._pose
            self._pose = (x + dx, y + dy, angle)
        if self._polygon is not None and (dx or dy):
            self._polygon = translate(self._polygon, dx, dy)


def layout_bounds(placed: list[PlacedItem]) -> tuple[float, float, float, float]:
    if not placed:
        return (0.0, 0.0, 0.0, 0.0)
    bounds = [item.bounds for item in placed]
    return (min(b[0] for b in bounds), min(b[1] for b in bounds),
            max(b[2] for b in bounds), max(b[3] for b in bounds))


def layout_efficiency(placed: list[PlacedItem]) -> float:
    left, top, right, bottom = layout_bounds(placed)
    area = (right - left) * (bottom - top)
    return sum(item.area for item in placed) / area if area > 0 else 0.0


class LayoutGeometry:
    """One request's originals and cached rotated outlines, never simplified."""

    def __init__(self, tools: list[dict], clearance: float, width: float | None, depth: float | None,
                 auto_width: bool = False, fixed_placements: list[dict] | None = None, deadline: float = math.inf):
        self.tools = tools
        self.clearance = clearance
        self.width = width
        self.depth = depth
        self.auto_width = auto_width
        self._rotations: dict[tuple[int, float], Polygon] = {}
        self.indices = {tool["id"]: index for index, tool in enumerate(tools)}
        if fixed_placements and (width is None or depth is None
                                 or not math.isfinite(width) or not math.isfinite(depth)
                                 or width <= 0 or depth <= 0):
            raise LayoutGeometryError("pinned placements require positive finite usable bin dimensions")
        self.fixed: dict[int, PlacedItem] = {}
        for pin in fixed_placements or []:
            if time.monotonic() >= deadline:
                raise TimeoutError
            tool_id = pin["tool_id"]
            if tool_id not in self.indices:
                raise LayoutGeometryError(f"pinned tool {tool_id} must be a requested tool with a valid outline")
            index = self.indices[tool_id]
            if index in self.fixed:
                raise LayoutGeometryError(f"pinned tool {tool_id} is specified more than once")
            x, y, angle = pin["x"], pin["y"], pin["rotation"]
            if any(type(value) not in (int, float) or not math.isfinite(value) for value in (x, y, angle)):
                raise LayoutGeometryError(f"pinned tool {tool_id} needs finite x, y and rotation")
            item = self.place(index, x, y, angle)
            # Keep the user's absolute angle and corner, including whole turns.
            item.x, item.y, item.rotation = x, y, angle
            if not self.inside(item.polygon):
                raise LayoutGeometryError(f"pinned tool {tool_id} is outside the usable bin interior; move it inside or unpin it")
            if not self.collision_free(item.polygon, list(self.fixed.values()), deadline):
                if time.monotonic() >= deadline:
                    raise TimeoutError
                raise LayoutGeometryError(f"pinned tool {tool_id} overlaps or is closer than tool padding to another pin; move it or unpin it")
            self.fixed[index] = item
        self.movable = [index for index in range(len(tools)) if index not in self.fixed]

    def rotated(self, index: int, angle: float) -> Polygon:
        key = (index, angle % 360.0)
        if key not in self._rotations:
            # Native critical angles are continuous; bound their cache as well.
            if len(self._rotations) >= max(128, len(self.tools) * len(ANGLES) * 2):
                self._rotations.clear()
            original = self.tools[index]["polygon"]
            self._rotations[key] = original if key[1] == 0 else rotate(original, key[1], origin=(0, 0))
        return self._rotations[key]

    def place(self, index: int, x: float, y: float, angle: float) -> PlacedItem:
        rotated = self.rotated(index, angle)
        x0, y0, x1, y1 = rotated.bounds
        polygon = translate(rotated, x - x0, y - y0)
        tool = self.tools[index]
        left, top, right, bottom = polygon.bounds
        original_area = tool["polygon"].area
        if (polygon.is_empty or not polygon.is_valid
                or any(not math.isfinite(value) for value in (left, top, right, bottom, polygon.area))
                or abs((right - left) - (x1 - x0)) > TOLERANCE
                or abs((bottom - top) - (y1 - y0)) > TOLERANCE
                or abs(polygon.area - original_area) > max(TOLERANCE ** 2, original_area * 1e-9)):
            raise LayoutGeometryError("requested dimensions or spacing cannot preserve the original outlines safely")
        # Use resulting bounds, not the requested corner's rounded value.
        return PlacedItem(tool["id"], tool["name"], left, top, angle % 360.0, polygon)

    def inside(self, polygon: Polygon) -> bool:
        if self.width is None or self.depth is None:
            return True
        left, top, right, bottom = polygon.bounds
        return (left >= -TOLERANCE and top >= -TOLERANCE
                and right <= self.width + TOLERANCE and bottom <= self.depth + TOLERANCE)

    def collision_free(self, polygon: Polygon, previous: list[PlacedItem], deadline: float = math.inf) -> bool:
        left, top, right, bottom = polygon.bounds
        for item in previous:
            if time.monotonic() >= deadline:
                return False
            x0, y0, x1, y1 = item.polygon.bounds
            if (right + self.clearance < x0 or x1 + self.clearance < left
                    or bottom + self.clearance < y0 or y1 + self.clearance < top):
                continue
            # Touching edges at zero clearance are legal; overlapping interiors
            # are not. No native approximation ratio becomes a physical tolerance.
            if polygon.relate_pattern(item.polygon, "T********"):
                return False
            if polygon.distance(item.polygon) + TOLERANCE < self.clearance:
                return False
        return True

    def validate(self, packet: list, deadline: float = math.inf) -> list[PlacedItem] | None:
        """Reject the entire proposal on malformed, outside or colliding originals."""
        if not isinstance(packet, list) or len(packet) > len(self.tools):
            return None
        seen = set()
        placed = list(self.fixed.values())
        for row in packet:
            if time.monotonic() >= deadline:
                return None
            if not isinstance(row, (list, tuple)) or len(row) != 4:
                return None
            index, x, y, angle = row
            if (type(index) is not int or not 0 <= index < len(self.tools) or index in seen
                    or any(type(value) not in (int, float) or not math.isfinite(value) for value in (x, y, angle))):
                return None
            if index in self.fixed:
                pin = self.fixed[index]
                if (x, y, angle) != (pin.x, pin.y, pin.rotation):
                    return None
                seen.add(index)
                continue
            try:
                item = self.place(index, x, y, angle)
            except LayoutGeometryError:
                return None
            if not self.inside(item.polygon) or not self.collision_free(item.polygon, placed, deadline):
                return None
            seen.add(index)
            placed.append(item)
        return placed

    def complete(self, placed: list[PlacedItem], deadline: float = math.inf) -> list[PlacedItem]:
        """Keep every valid requested outline as a separated diagnostic placement."""
        if time.monotonic() >= deadline:
            raise TimeoutError
        result = list(self.fixed.values()) + [item for item in placed if self.indices[item.tool_id] not in self.fixed]
        ids = {item.tool_id for item in result}
        _, _, right, _ = layout_bounds(result)
        if self.width is not None:
            right = max(right, self.width)
        for index, tool in enumerate(self.tools):
            if time.monotonic() >= deadline:
                raise TimeoutError
            if tool["id"] in ids:
                continue
            x = right + self.clearance + TOLERANCE if result or self.width is not None else 0.0
            item = self.place(index, x, 0.0, 0.0)
            result.append(item)
            right = item.polygon.bounds[2]
        # Stable consumer order is cheap, but is not part of the packing objective.
        result.sort(key=lambda item: self.indices[item.tool_id])
        return result

    def score(self, placed: list[PlacedItem]) -> tuple[int, float]:
        fitted = [item for item in placed if self.inside(item.polygon)]
        left, top, right, bottom = layout_bounds(fitted if self.auto_width else placed)
        extent = (right if self.fixed else right - left) if self.auto_width else (right - left) * (bottom - top)
        if not math.isfinite(extent):
            raise LayoutGeometryError("requested layout dimensions exceed safe geometric arithmetic")
        # Diagnostic outlines must not affect the occupied-width objective.
        return (-len(fitted), extent)

    def packet(self, placed: list[PlacedItem]) -> list[list]:
        return [[self.indices[item.tool_id], item.x, item.y, item.rotation]
                for item in placed if self.inside(item.polygon)]

    def seed(self, deadline: float) -> list[PlacedItem]:
        """Cheap geometric shelves, not an unbudgeted invocation of an optimizer."""
        if self.fixed:
            return self.complete(list(self.fixed.values()), deadline)
        best = None
        best_score = None
        for vertical in (False, True):
            if time.monotonic() >= deadline:
                break
            placed = []
            cursor = line = thickness = 0.0
            right = bottom = 0.0
            for index in range(len(self.tools)):
                if time.monotonic() >= deadline:
                    break
                choices = []
                # Cardinals handle shelves; diagonals also seed a long tool in a
                # square. The raster engine searches the remaining 15-degree poses.
                for angle in (0, 90, 45, 135):
                    if time.monotonic() >= deadline:
                        break
                    x0, y0, x1, y1 = self.rotated(index, angle).bounds
                    along, across = (y1 - y0, x1 - x0) if vertical else (x1 - x0, y1 - y0)
                    limit = self.depth if vertical else self.width
                    other_limit = self.width if vertical else self.depth
                    for start, offset, old_thickness in ((cursor, line, thickness),
                                                          (0.0, line + thickness + self.clearance + TOLERANCE, 0.0)):
                        if start == 0 and offset != line and not placed:
                            continue
                        if limit is not None and start + along > limit + TOLERANCE:
                            continue
                        if other_limit is not None and offset + across > other_limit + TOLERANCE:
                            continue
                        x, y = (offset, start) if vertical else (start, offset)
                        occupied_width = max(right, x + x1 - x0)
                        extent = occupied_width if self.auto_width else occupied_width * max(bottom, y + y1 - y0)
                        if not math.isfinite(extent):
                            continue
                        choices.append((extent, offset, start, angle, along, across, old_thickness))
                if not choices:
                    continue
                _, line, start, angle, along, across, old_thickness = min(choices)
                x, y = (line, start) if vertical else (start, line)
                item = self.place(index, x, y, angle)
                placed.append(item)
                _, _, new_right, new_bottom = item.polygon.bounds
                right, bottom = max(right, new_right), max(bottom, new_bottom)
                cursor = start + along + self.clearance + TOLERANCE
                thickness = max(old_thickness, across)
            try:
                candidate = self.complete(placed, deadline)
                score = self.score(candidate)
            except LayoutGeometryError:
                continue
            except TimeoutError:
                if best is None:
                    raise
                break
            if best_score is None or score < best_score:
                best, best_score = candidate, score
        return best if best is not None else self.complete([], deadline)

