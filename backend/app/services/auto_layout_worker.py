"""Short-lived optimizer process. JSON-lines stdout carries validated incumbents."""
from __future__ import annotations

import json
import math
import sys
import time


def _native_shape(ps, ring):
    points = list(ring.coords)[:-1]
    area2 = sum(a[0] * b[1] - a[1] * b[0] for a, b in zip(points, points[1:] + points[:1]))
    if area2 < 0:
        points.reverse()
    return ps.Shape([ps.ShapeElement(start=ps.Point(*a), end=ps.Point(*b))
                     for a, b in zip(points, points[1:] + points[:1])])


def solve_native(geometry, width, depth, deadline, emit, best_layout):
    # Import and native preprocessing belong to the parent's overall deadline.
    import packingsolver.irregular as ps

    from app.services.auto_layout_geometry import layout_bounds

    shapes = []
    for index in geometry.movable:
        if time.monotonic() >= deadline:
            return
        polygon = geometry.tools[index]["polygon"]
        outer = _native_shape(ps, polygon.exterior)
        shapes.append(ps.ShapeWithHoles(outer, [_native_shape(ps, ring) for ring in polygon.interiors]))
    defects = [
        ps.ShapeWithHoles(_native_shape(ps, pin.polygon.exterior),
                          [_native_shape(ps, ring) for ring in pin.polygon.interiors])
        for pin in geometry.fixed.values()
    ]
    native_all_fit = geometry.auto_width and all(geometry.inside(item.polygon) for item in best_layout())

    def callback(output):
        nonlocal native_all_fit
        if time.monotonic() >= deadline:
            return
        solution = output.solution
        packet = geometry.packet(list(geometry.fixed.values()))
        if solution.number_of_different_bins():
            for item in solution.bin(0).items:
                if item.mirror:
                    return  # Mirroring is never an accepted output transform.
                native_index = item.item_type_id
                angle = item.angle % 360.0
                if not 0 <= native_index < len(geometry.movable) or not math.isfinite(angle):
                    return
                index = geometry.movable[native_index]
                # bl_corner is a TRANSLATION of a polygon rotated around zero,
                # not the minimum corner expected by the bin editor.
                left, top, _, _ = geometry.rotated(index, angle).bounds
                packet.append([index, item.bl_corner.x + left, item.bl_corner.y + top, angle])
        accepted = emit(packet)
        if accepted is not None and len(packet) == len(geometry.tools):
            native_all_fit = True

    def run(objective, bin_width, bin_depth, limit):
        if time.monotonic() >= deadline:
            return
        subdeadline = min(deadline, time.monotonic() + limit)
        builder = ps.InstanceBuilder()
        builder.set_objective(objective)
        builder.set_item_item_minimum_spacing(geometry.clearance)
        rectangle = ps.Shape([
            ps.ShapeElement(start=ps.Point(*a), end=ps.Point(*b))
            for a, b in zip([(0, 0), (bin_width, 0), (bin_width, bin_depth), (0, bin_depth)],
                            [(bin_width, 0), (bin_width, bin_depth), (0, bin_depth), (0, 0)])
        ])
        bin_id = builder.add_bin_type(rectangle, copies=1, item_bin_minimum_spacing=0.0)
        for defect in defects:
            if time.monotonic() >= subdeadline:
                return
            defect_id = builder.add_defect(bin_id, 0, defect)
            # Defect spacing is independent of bin-wall spacing in the bindings.
            builder.set_item_defect_minimum_spacing(bin_id, defect_id, geometry.clearance)
        for shape in shapes:
            if time.monotonic() >= subdeadline:
                return
            builder.add_item_type(shape, allowed_rotations=[(0.0, 360.0, False)],
                                  profit=1.0, copies=1, copies_min=0 if objective == ps.Objective.Knapsack else 1)
        instance = builder.build()
        remaining = subdeadline - time.monotonic()
        if remaining <= 0:
            return
        parameters = ps.OptimizeParameters()
        parameters.verbosity_level = 0
        parameters.use_tree_search = True
        parameters.use_local_search = False
        parameters.use_milp_raster = False
        # Area-ratio approximation affects proposals only. Original vertices are
        # used in every callback's containment, pair clearance and bbox score.
        parameters.initial_maximum_approximation_ratio = 0.05
        parameters.not_anytime_maximum_approximation_ratio = 0.05
        parameters.new_solution_callback = callback
        parameters.time_limit = remaining
        callback(ps.optimize(instance, parameters))

    # Do not reserve sequential slices before finding an all-fit layout. The
    # unit-profit Knapsack receives the entire remaining initial search budget.
    if not native_all_fit:
        run(ps.Objective.Knapsack, width, depth, max(0.0, deadline - time.monotonic()))
    if not native_all_fit and not geometry.auto_width:
        return
    # Spend any remainder on compact proposals, including equal-count partial
    # fits. The shared score always rejects sacrificing a fitted tool for width.
    turn = 0
    total_area = sum(tool["polygon"].area for tool in geometry.tools)
    partial_width = width
    while time.monotonic() < deadline:
        incumbent = best_layout()
        if geometry.auto_width:
            incumbent = [item for item in incumbent if geometry.inside(item.polygon)]
        left, top, right, bottom = layout_bounds(incumbent)
        packed_width, packed_depth = (right, bottom) if geometry.fixed else (right - left, bottom - top)
        if not geometry.auto_width and packed_width * packed_depth <= total_area + 1e-9:
            return  # Original disjoint area is a proven bbox lower bound.
        if geometry.auto_width:
            if native_all_fit:
                objective = ps.Objective.OpenDimensionX
                candidate_width = width
            else:
                if packed_width <= 0:
                    return
                objective = ps.Objective.Knapsack
                partial_width = min(partial_width, packed_width) * 0.98
                candidate_width = partial_width
                if geometry.fixed:
                    _, _, fixed_right, _ = layout_bounds(list(geometry.fixed.values()))
                    candidate_width = max(candidate_width, fixed_right)
            candidate_depth = depth
        elif turn % 3 == 0:
            objective = ps.Objective.OpenDimensionY
            candidate_width, candidate_depth = min(width, packed_width), depth
        elif turn % 3 == 1:
            objective = ps.Objective.OpenDimensionX
            candidate_width, candidate_depth = width, min(depth, packed_depth)
        else:
            objective = ps.Objective.Knapsack
            candidate_width = min(width, packed_width) * 0.98
            candidate_depth = min(depth, packed_depth) * 0.98
            if geometry.fixed:
                _, _, fixed_right, fixed_bottom = layout_bounds(list(geometry.fixed.values()))
                candidate_width = max(candidate_width, fixed_right)
                candidate_depth = max(candidate_depth, fixed_bottom)
        run(objective, candidate_width, candidate_depth, min(0.5, deadline - time.monotonic()))
        turn += 1


def _prepare(request):
    """Canonical storage/model/bin preparation, isolated under the same deadline."""
    from pathlib import Path

    from shapely import from_wkb
    from shapely.geometry import Polygon

    from app.services.auto_layout import LayoutInputError
    from app.services.auto_layout_geometry import LayoutGeometryError

    context = {"width": request["width"], "depth": request["depth"],
               "auto_width": request.get("auto_width", False), "has_fixed": bool(request.get("fixed_placements")),
               "offset_x": 0.0, "offset_y": 0.0, "width_cap": None}
    pins = request.get("fixed_placements", [])
    records = []
    stored = request.get("stored_request")
    if stored is None:
        for record in request.get("tools", []):
            if time.monotonic() >= request["deadline"]:
                raise TimeoutError
            records.append({"id": record["id"], "name": record["name"],
                            "polygon": from_wkb(bytes.fromhex(record["wkb"]))})
    else:
        from app.constants import GF_GRID, MAX_BIN_GRID_CELLS, MAX_BIN_GRID_UNITS
        from app.models.schemas import BinConfig
        from app.services.tool_store import ToolStore

        req = stored["request"]
        identities = req.get("placement_ids") or req["tool_ids"]
        pin_map = {pin.get("placement_id") if req.get("placement_ids") is not None else pin["tool_id"]: pin
                   for pin in req.get("fixed_placements", [])}
        store = ToolStore(Path(stored["storage_path"]))
        for identity, tool_id in zip(identities, req["tool_ids"]):
            if time.monotonic() >= request["deadline"]:
                raise TimeoutError
            tool = store.get(tool_id)
            if tool is None:
                raise LayoutInputError(404, f"tool {tool_id} not found")
            if len(tool.points) < 3:
                if identity in pin_map:
                    raise LayoutInputError(400, f"pinned tool {tool_id} has a degenerate outline; repair it or unpin it")
                continue
            try:
                polygon = Polygon([(point.x, point.y) for point in tool.points],
                                  [[(point.x, point.y) for point in ring] for ring in tool.interior_rings])
            except ValueError:
                if identity in pin_map:
                    raise LayoutInputError(400, f"pinned tool {tool_id} has a degenerate outline; repair it or unpin it")
                continue
            records.append({"id": identity, "name": tool.name, "polygon": polygon})
        if req.get("bin_config") is not None:
            from app.services.stl_generator_manifold import _interior_clip_rect

            config = BinConfig.model_validate(req["bin_config"])
            if context["auto_width"]:
                width_cap = min(MAX_BIN_GRID_UNITS, MAX_BIN_GRID_CELLS // math.ceil(config.grid_y))
                context["width_cap"] = width_cap
                config = config.model_copy(update={"grid_x": width_cap})
            rect = _interior_clip_rect(config)
            margin = config.cutout_clearance if context["auto_width"] else 0.0
            context["width"] = rect.bounds[2] - rect.bounds[0] - 2 * margin
            context["depth"] = rect.bounds[3] - rect.bounds[1] - 2 * margin
            context["offset_x"] = (config.grid_x * GF_GRID - context["width"]) / 2
            context["offset_y"] = (config.grid_y * GF_GRID - context["depth"]) / 2
        pins = [{"tool_id": identity, "x": pin["x"] - context["offset_x"],
                 "y": pin["y"] - context["offset_y"], "rotation": pin["rotation"]}
                for identity, pin in pin_map.items()]
        context["has_fixed"] = bool(pins)
    width, depth = context["width"], context["depth"]
    if context["auto_width"] and (width is None or depth is None or not math.isfinite(width)
                                  or not math.isfinite(depth) or width <= 0 or depth <= 0):
        raise LayoutGeometryError("auto width requires positive finite width cap and fixed depth")
    if width is None or depth is None or width <= 0 or depth <= 0:
        context["width"] = context["depth"] = None
    valid, seen = [], set()
    for record in records:
        if time.monotonic() >= request["deadline"]:
            raise TimeoutError
        polygon = record["polygon"]
        if (record["id"] in seen or polygon.is_empty or not polygon.is_valid or polygon.area <= 0
                or any(not math.isfinite(value) for value in polygon.bounds)):
            continue
        if not math.isfinite(polygon.area):
            raise LayoutGeometryError("original outline dimensions exceed safe geometric arithmetic")
        valid.append(record)
        seen.add(record["id"])
    return valid, pins, context


def _send(packet):
    from app.services.auto_layout import _MAX_FRAME_BYTES

    encoded = json.dumps(packet, separators=(",", ":"), allow_nan=False)
    if len(encoded) > _MAX_FRAME_BYTES:
        raise RuntimeError("original outline exceeds bounded layout transport capacity")
    print(encoded, flush=True)


def main():
    from app.services.auto_layout_geometry import LayoutGeometry, LayoutGeometryError

    request = json.load(sys.stdin)
    deadline = request["deadline"]
    if time.monotonic() >= deadline:
        return
    # Both selected processes already exist before any original/bin preparation
    # or seed. Load the actual chosen optimizer, not a hidden preparatory placer.
    if sys.argv[1] == "raster":
        from app.services.auto_layout_raster import solve
    else:
        import packingsolver.irregular  # noqa: F401

    tools, pins, context = _prepare(request)
    geometry = LayoutGeometry(tools, request["clearance"], context["width"], context["depth"],
                              auto_width=context["auto_width"], fixed_placements=pins, deadline=deadline)
    for index, tool in enumerate(tools):
        if time.monotonic() >= deadline:
            return
        _send({"event": "source", "index": index,
               "source": {"id": tool["id"], "name": tool["name"], "wkb": tool["polygon"].wkb_hex}})
    _send({"event": "prepared", "context": context})
    best = geometry.seed(deadline) if geometry.tools else []
    best_score = geometry.score(best)

    def publish(items):
        # These scalars belong to the exact original polygons already validated
        # in this killable process. No transformed polygon is copied per packet.
        _send({"event": "incumbent", "items": [
            {"index": geometry.indices[item.tool_id], "x": item.x, "y": item.y, "rotation": item.rotation,
             "bounds": list(item.bounds), "area": item.area, "fitted": geometry.inside(item.polygon)}
            for item in items
        ]})

    publish(best)

    def emit(packet):
        nonlocal best, best_score
        checked = geometry.validate(packet, deadline)
        if checked is None:
            return None
        if geometry.width is not None and len(checked) < -best_score[0]:
            return checked
        try:
            completed = geometry.complete(checked, deadline)
            score = geometry.score(completed)
        except (TimeoutError, LayoutGeometryError):
            return None
        if score < best_score and time.monotonic() < deadline:
            best, best_score = completed, score
            publish(best)  # Improvement is retained before presentation centering.
        return checked

    if not geometry.movable:
        return
    bounds = [tool["polygon"].bounds for tool in tools]
    width = geometry.width or sum(bound[2] - bound[0] + geometry.clearance + 1e-6 for bound in bounds)
    depth = geometry.depth or sum(bound[3] - bound[1] + geometry.clearance + 1e-6 for bound in bounds)
    if sys.argv[1] == "raster":
        solve(geometry, width, depth, deadline, emit)
    else:
        solve_native(geometry, width, depth, deadline, emit, lambda: best)


def entrypoint():
    from app.services.auto_layout import LayoutInputError
    from app.services.auto_layout_geometry import LayoutGeometryError

    try:
        main()
        return 0
    except TimeoutError:
        return 0  # Normal deadline expiry; retain any already streamed incumbent.
    except LayoutInputError as exc:
        _send({"error": str(exc), "status_code": exc.status_code})
    except LayoutGeometryError as exc:
        _send({"error": str(exc), "status_code": 400})
    except Exception as exc:
        _send({"error": f"{type(exc).__name__}: {exc}"})
    return 1


if __name__ == "__main__":
    sys.exit(entrypoint())
