"""Derived toolbox diagnostics. Only measurements and support relationships persist."""

import hashlib
import json
import math
from copy import copy, deepcopy

from app.models.schemas import BinPreviewTool, BinSummary, GenerateRequest
from app.services.bin_service import sync_placed_tools
from app.services.polygon_scaler import PolygonScaler, ScaledFingerHole, ScaledPolygon
from app.services.stl_generator_manifold import (
    GF_BASE_HEIGHT,
    GF_HEIGHT_UNIT,
    assess_printed_bin,
    bin_vertical_geometry,
)


def footprint(placement, config):
    return (config.grid_y, config.grid_x) if placement.rotation in (90, 270) else (config.grid_x, config.grid_y)


def support_problem(lower, upper, bins, physical):
    a, b = bins[lower.bin_id].bin_config, bins[upper.bin_id].bin_config
    if (lower.x, lower.y, *footprint(lower, a)) != (upper.x, upper.y, *footprint(upper, b)):
        return "Stack members must have aligned matching footprints after rotation"
    # an imported model has no verified mating geometry: only alignment can be
    # checked, and the physical interface stays uncertain rather than verified
    if bins[lower.bin_id].imported_model or bins[upper.bin_id].imported_model:
        return None
    if not a.stacking_lip:
        return "Supporting bin has no stacking lip"
    if a.half_grid_base != b.half_grid_base:
        return "Full-grid and half-grid bases are not verified mating interfaces"
    if any(c.partial_bins and not all(c.partial_bins_values) for c in (a, b)):
        return "Partial-bin support cannot be established"
    return physical["support_error"]


def generation_polygons(bin_data, tools, prepare=True):
    scaler = PolygonScaler()
    polygons = []
    for placed in bin_data.placed_tools:
        source = tools.get(placed.tool_id)
        polygon = ScaledPolygon(
            placed.id, [(p.x, p.y) for p in placed.points], placed.name,
            [ScaledFingerHole.from_finger_hole(h) for h in placed.finger_holes],
            [[(p.x, p.y) for p in ring] for ring in placed.interior_rings],
            depth_override=placed.depth_override,
        )
        polygons.append(scaler.prepare_for_generation(
            polygon, bin_data.bin_config.cutout_clearance,
            smoothed=bool(source and source.smoothed), smooth_level=source.smooth_level if source else .5,
        ) if prepare else polygon)
    return polygons


_ASSESS_CACHE: dict[str, dict] = {}
_ASSESS_CACHE_LIMIT = 32
_PROPOSAL_CACHE: dict[str, dict] = {}


def _planning_key(bin_data, tools, gap=0, upper_config=None, relative_rotation=0):
    # Only placed geometry and referenced measurements affect physical planning.
    content = {
        "bin": bin_data.model_dump(include={"bin_config", "placed_tools", "text_labels", "imported_model"}),
        "tools": {
            tool_id: tools[tool_id].model_dump(include={"name", "thickness_mm", "smoothed", "smooth_level"})
            for tool_id in sorted({placed.tool_id for placed in bin_data.placed_tools})
            if tool_id in tools
        },
        "gap": gap,
        "upper": upper_config.model_dump() if upper_config else None,
        "rotation": relative_rotation,
    }
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _cache_result(cache, key, result):
    # ponytail: bounded FIFO; independent whole-proposal entries outlive candidate
    # eviction, and copies keep inspectable responses private to each caller.
    if key not in cache and len(cache) >= _ASSESS_CACHE_LIMIT:
        cache.pop(next(iter(cache)))
    cache[key] = deepcopy(result)
    return result


def imported_assessment(bin_data):
    """Planning view of an imported model: bounding box only, never verified.

    No envelopes are fabricated, no mating geometry is claimed, and the
    conservative stack increment is the measured bounding-box height.
    """
    model = bin_data.imported_model
    return {
        "external_height_mm": model.height_mm,
        "stack_increment_mm": model.height_mm,
        "support_error": None,
        "seating_errors": {},
        "envelopes": [],
        "missing_tool_ids": [],
        "limiting_tool_id": None,
        "clearance_mm": None,
        "violations": [],
        "status": "uncertain",
        "imported": True,
        "import_warnings": list(model.warnings),
    }


def assess_bin(bin_data, tools, gap=0, upper_config=None, relative_rotation=0, prepared=None):
    key = _planning_key(bin_data, tools, gap, upper_config, relative_rotation)
    cached = _ASSESS_CACHE.get(key)
    if cached is not None:
        return deepcopy(cached)
    result = _assess_bin(bin_data, tools, gap, upper_config, relative_rotation, prepared)
    return _cache_result(_ASSESS_CACHE, key, result)


def _assess_bin(bin_data, tools, gap=0, upper_config=None, relative_rotation=0, prepared=None):
    if bin_data.imported_model is not None:
        return imported_assessment(bin_data)
    config = bin_data.bin_config
    request = GenerateRequest.model_validate({
        **config.model_dump(), "text_labels": [label.model_dump() for label in config.text_labels + bin_data.text_labels],
    })
    if prepared is None:
        prepared = generation_polygons(bin_data, tools)
    else:
        # Shape preparation is depth-independent. Never mutate shared prepared
        # polygons when trying a candidate with different pocket overrides.
        prepared = [copy(polygon) for polygon in prepared]
        for polygon, placed in zip(prepared, bin_data.placed_tools):
            polygon.depth_override = placed.depth_override
    geometry = assess_printed_bin(
        prepared,
        generation_polygons(bin_data, tools, prepare=False), request,
        GenerateRequest.model_validate(upper_config.model_dump()) if upper_config else None, relative_rotation,
    )
    envelopes, missing, violations = [], [], []
    for placed in bin_data.placed_tools:
        tool = tools.get(placed.tool_id)
        thickness = tool.thickness_mm if tool else None
        if thickness is None:
            missing.append(placed.tool_id)
        physical = bin_vertical_geometry(config, placed.depth_override)
        physical["stack_increment_mm"] = geometry["stack_increment_mm"]
        seating_error = geometry["seating_errors"].get(placed.id)
        if seating_error:
            physical["resting_z_mm"] = None
            physical["effective_depth_mm"] = None
            violations.append({"code": "tool_seating", "tool_id": placed.tool_id, "message": f"{placed.name}: {seating_error}"})
        insert_clearance = None if physical["resting_z_mm"] is None else geometry["stack_increment_mm"] - physical["resting_z_mm"] - gap
        if config.insert_enabled and insert_clearance is not None and insert_clearance < -1e-7:
            violations.append({"code": "insert_clearance", "tool_id": placed.tool_id,
                               "message": f"{placed.name} insert interferes with the upper-bin underside",
                               "clearance_mm": insert_clearance})
        insert_height = config.insert_height if config.insert_enabled else 0
        top = None if thickness is None or physical["resting_z_mm"] is None else physical["resting_z_mm"] + thickness
        clearance = None if top is None else geometry["stack_increment_mm"] - top - gap
        envelopes.append({
            "id": placed.id, "tool_id": placed.tool_id, "name": tool.name if tool else placed.name,
            "points": [p.model_dump() for p in placed.points],
            "interior_rings": [[p.model_dump() for p in ring] for ring in placed.interior_rings],
            "thickness_mm": thickness, "insert_height_mm": insert_height, "seating_verified": not seating_error,
            **physical, "top_mm": top, "clearance_mm": clearance,
        })
        if clearance is not None and clearance < -1e-7:
            violations.append({"code": "tool_clearance", "tool_id": placed.tool_id,
                               "message": f"{placed.name} exceeds the upper-bin underside clearance", "clearance_mm": clearance})
    known = [e for e in envelopes if e["clearance_mm"] is not None]
    limiting = min(known, key=lambda e: e["clearance_mm"]) if known else None
    if not config.stacking_lip:
        violations.append({"code": "stacking_lip", "message": "Bin has no stacking lip"})
    if config.partial_bins and not all(config.partial_bins_values):
        violations.append({"code": "partial_support", "message": "Partial-bin stacking support cannot be established"})
    if geometry["support_error"]:
        violations.append({"code": "support_geometry", "message": geometry["support_error"]})
    return {**geometry, "envelopes": envelopes, "missing_tool_ids": list(dict.fromkeys(missing)),
            "limiting_tool_id": limiting["tool_id"] if limiting else None,
            "clearance_mm": limiting["clearance_mm"] if limiting else None,
            "violations": violations,
            "status": "invalid" if violations else "uncertain" if missing else "verified"}


def height_proposals(bin_data, tools, gap=0):
    key = _planning_key(bin_data, tools, gap)
    cached = _PROPOSAL_CACHE.get(key)
    if cached is not None:
        return deepcopy(cached)
    prepared = generation_polygons(bin_data, tools)
    current = assess_bin(bin_data, tools, gap, prepared=prepared)
    alternatives = []
    measured = [e for e in current["envelopes"] if e["thickness_mm"] is not None]
    measured_by_id = {e["id"]: e for e in measured}
    for strategy in ("deeper_pockets", "raised_rim"):
        candidates = []
        if measured and not current["seating_errors"]:
            requested = max(e["thickness_mm"] + gap for e in measured)
            units_start, rim_start = 1, 0
            if strategy == "deeper_pockets":
                insert_h = bin_data.bin_config.insert_height if bin_data.bin_config.insert_enabled else 0
                # ponytail: bodies whose pocket floor cannot reach the thickest
                # tool fail the clearance check analytically; skip them
                while units_start < 21 and units_start * GF_HEIGHT_UNIT - GF_BASE_HEIGHT - 2 < requested + insert_h - 1e-6:
                    units_start += 1
            else:
                limits = [e["top_mm"] + gap for e in current["envelopes"] if e["top_mm"] is not None]
                if bin_data.bin_config.insert_enabled:
                    limits += [e["resting_z_mm"] + gap for e in current["envelopes"] if e["resting_z_mm"] is not None]
                wall_top = bin_data.bin_config.height_units * GF_HEIGHT_UNIT
                need = max(limits, default=0.0)
                # ponytail: rims below this cannot clear the tools even with an
                # ideal zero-drop mating; skipped rims can only fail
                while rim_start < 21 and wall_top + rim_start * GF_HEIGHT_UNIT < need - 1e-6:
                    rim_start += 1
            for units in (range(units_start, 21) if strategy == "deeper_pockets" else [bin_data.bin_config.height_units]):
                rims = [0] if strategy == "deeper_pockets" else range(rim_start, 21)
                for rim in rims:
                    candidate = bin_data.model_copy(update={
                        "bin_config": bin_data.bin_config.model_copy(),
                        "placed_tools": [p.model_copy() for p in bin_data.placed_tools],
                    })
                    candidate.bin_config.height_units = units
                    candidate.bin_config.rim_units = rim
                    candidate.bin_config.stacking_lip = True
                    changes = []
                    if strategy == "deeper_pockets":
                        candidate.bin_config.cutout_depth = max(0.25, requested)
                        for placed in candidate.placed_tools:
                            envelope = measured_by_id.get(placed.id)
                            if placed.depth_override is not None and envelope:
                                depth = max(placed.depth_override, envelope["thickness_mm"] + gap)
                                if depth != placed.depth_override:
                                    changes.append({"id": placed.id, "from_mm": placed.depth_override, "to_mm": depth})
                                    placed.depth_override = depth
                    if candidate.bin_config.cutout_depth > 200 or any(p.depth_override is not None and p.depth_override > 200 for p in candidate.placed_tools):
                        continue
                    result = assess_bin(candidate, tools, gap, prepared=prepared)
                    mating_drop = units * 7 - result["stack_increment_mm"]
                    if strategy == "deeper_pockets" and mating_drop > 1e-7 and result["violations"]:
                        candidate.bin_config.cutout_depth = max(0.25, max(e["thickness_mm"] + gap + mating_drop for e in measured))
                        changes = []
                        for placed, original in zip(candidate.placed_tools, bin_data.placed_tools):
                            envelope = measured_by_id.get(placed.id)
                            if original.depth_override is not None and envelope:
                                placed.depth_override = max(original.depth_override, envelope["thickness_mm"] + gap + mating_drop)
                                if placed.depth_override != original.depth_override:
                                    changes.append({"id": placed.id, "from_mm": original.depth_override, "to_mm": placed.depth_override})
                        if candidate.bin_config.cutout_depth > 200 or any(p.depth_override is not None and p.depth_override > 200 for p in candidate.placed_tools):
                            continue
                        result = assess_bin(candidate, tools, gap, prepared=prepared)
                    if not result["violations"]:
                        candidates.append((result["external_height_mm"], candidate, result, changes))
                        break
                if candidates:
                    break
        if candidates:
            _, candidate, result, changes = candidates[0]
            alternatives.append({"strategy": strategy, "complete": not current["missing_tool_ids"],
                                 "bin_config": candidate.bin_config.model_dump(),
                                 "placed_tools": [p.model_dump() for p in candidate.placed_tools],
                                 "override_changes": changes, "external_height_mm": result["external_height_mm"],
                                 "clearance_mm": result["clearance_mm"], "reason": None})
        else:
            alternatives.append({"strategy": strategy, "complete": False, "bin_config": None,
                                 "reason": "Fix unresolved pocket-floor seating before proposing height" if current["seating_errors"] else "No measured tools" if not measured else "No fit within 20u body / 20u rim and supported intact stacking interfaces"})
    return _cache_result(_PROPOSAL_CACHE, key, {"assessment": current, "alternatives": alternatives})


def drawer_point(point, placement, config):
    x, y = point["x"], point["y"]
    w, d = config.grid_x * 42, config.grid_y * 42
    x, y = {0: (x, y), 90: (d-y, x), 180: (w-x, d-y), 270: (y, w-x)}[placement.rotation]
    return {"x": x + placement.x * 42, "y": y + placement.y * 42}


def assess_plan(project, sketch, user_bins, user_tools):
    bins = {key: value.model_copy(deep=True) for key, value in user_bins.all().items()}
    for bin_data in bins.values():
        sync_placed_tools(bin_data, user_tools)
    tools = user_tools.all()
    width = sketch.container_width_mm if sketch.container_width_mm is not None else (sketch.target_grid_x * 42 if sketch.target_grid_x is not None else None)
    depth = sketch.container_depth_mm if sketch.container_depth_mm is not None else (sketch.target_grid_y * 42 if sketch.target_grid_y is not None else None)
    gx = math.floor(width / 21) / 2 if sketch.container_width_mm is not None else sketch.target_grid_x
    gy = math.floor(depth / 21) / 2 if sketch.container_depth_mm is not None else sketch.target_grid_y
    by_id = {p.id: p for p in sketch.bin_layout}
    bin_assessments = {}
    for p in sketch.bin_layout:
        if p.bin_id not in bins:
            continue
        upper = next((q for q in sketch.bin_layout if q.support_id == p.id), None)
        upper_data = bins.get(upper.bin_id) if upper else None
        # an imported upper has no generated mating geometry, so passing its
        # nominal config would let the lower bin's assessment falsely verify
        # the interface against a synthetic shell
        upper_config = None if upper_data is None or upper_data.imported_model else upper_data.bin_config
        bin_assessments[p.id] = assess_bin(
            bins[p.bin_id], tools, sketch.safety_clearance_mm, upper_config,
            (upper.rotation - p.rotation) % 360 if upper else 0,
        )
    elevations, roots = {}, {}
    violations, unresolved, results = [], [], []
    missing, housed = set(), set()
    if width is None or depth is None or sketch.container_height_mm is None:
        unresolved.append("Usable container width, depth or height is unknown")

    def elevation(p):
        if p.id in elevations:
            return elevations[p.id]
        if p.support_id:
            lower = by_id[p.support_id]
            elevations[p.id] = elevation(lower) + bin_assessments[lower.id]["stack_increment_mm"]
            roots[p.id] = roots[lower.id]
        else:
            elevations[p.id], roots[p.id] = 0, p.id
        return elevations[p.id]

    def elevation_uncertain(placement) -> bool:
        """True when a placement's conservative height is not a known elevation.

        Uncertainty enters wherever the interface below is an uploaded model:
        its mating height is unverified, so the placement's Z (and any ceiling
        excess derived from it) is an estimate, not a proven collision. A root
        imported bin sits at Z=0 with an exactly measured height, so it stays
        definite.
        """
        node, seen = placement, set()
        while node is not None and node.id not in seen:
            seen.add(node.id)
            if node.support_id is None:
                return False
            lower = by_id.get(node.support_id)
            if lower is None:
                return True
            node_bin = bins.get(node.bin_id)
            lower_bin = bins.get(lower.bin_id)
            if (node_bin is not None and node_bin.imported_model is not None) or (
                lower_bin is not None and lower_bin.imported_model is not None
            ):
                return True
            node = lower
        return False

    rectangles = []
    for p in sketch.bin_layout:
        bin_data = bins.get(p.bin_id)
        if not bin_data:
            unresolved.append(f"Missing bin {p.bin_id}")
            continue
        z = elevation(p)
        config = bin_data.bin_config
        assessment = bin_assessments[p.id]
        missing.update(assessment["missing_tool_ids"])
        housed.update(pt.tool_id for pt in bin_data.placed_tools)
        w, h = footprint(p, config)
        if width is not None and (p.x+w)*42 > width+1e-7 or depth is not None and (p.y+h)*42 > depth+1e-7:
            violations.append({"code": "boundary", "placement_id": p.id, "message": "Bin footprint exceeds the usable container bounds"})
        compatible = None
        if p.support_id:
            problem = support_problem(by_id[p.support_id], p, bins, bin_assessments[p.support_id])
            if problem:
                compatible = False
                violations.append({"code": "support", "placement_id": p.id, "message": problem})
            elif bins[by_id[p.support_id].bin_id].imported_model or bin_data.imported_model:
                # alignment verified, physical interface is not
                unresolved.append(
                    "A stack joins an imported model; the physical mating interface is unverified"
                )
            else:
                compatible = True
        uncertain_elevation = elevation_uncertain(p)
        upper = next((q for q in sketch.bin_layout if q.support_id == p.id), None)
        if upper:
            interface_violations = [v for v in assessment["violations"] if v["code"] in ("tool_clearance", "insert_clearance")]
            upper_data = bins.get(upper.bin_id)
            if upper_data is not None and upper_data.imported_model is not None:
                # the underside above is an uploaded mesh, so these figures came
                # from a synthetic same-shape upper, not from the real one
                if interface_violations:
                    unresolved.append(f"Clearance to the imported bin stacked above placement {p.id} is unverified")
            else:
                violations.extend({**v, "placement_id": p.id} for v in interface_violations)
        violations.extend({**v, "placement_id": p.id} for v in assessment["violations"] if v["code"] == "tool_seating")
        top = max([z + assessment["external_height_mm"], *[z+(e["top_mm"] if e["top_mm"] is not None else e["resting_z_mm"]) for e in assessment["envelopes"] if e["resting_z_mm"] is not None]])
        headroom = None if sketch.container_height_mm is None else sketch.container_height_mm - top - sketch.safety_clearance_mm
        estimated_excess = False
        if config.insert_enabled and sketch.container_height_mm is not None:
            for envelope in assessment["envelopes"]:
                if envelope["resting_z_mm"] is None:
                    continue
                insert_headroom = sketch.container_height_mm-z-envelope["resting_z_mm"]-sketch.safety_clearance_mm
                if insert_headroom < -1e-7 and not uncertain_elevation:
                    violations.append({"code": "insert_ceiling", "placement_id": p.id, "tool_id": envelope["tool_id"],
                                       "message": f"{envelope['name']} insert interferes with the closed lid",
                                       "clearance_mm": insert_headroom})
                elif insert_headroom < -1e-7:
                    estimated_excess = True
        if headroom is not None and headroom < -1e-7:
            if uncertain_elevation:
                estimated_excess = True
            else:
                colliding_tools = [e for e in assessment["envelopes"] if e["top_mm"] is not None and z+e["top_mm"]+sketch.safety_clearance_mm > sketch.container_height_mm+1e-7]
                for envelope in colliding_tools:
                    violations.append({"code": "ceiling", "placement_id": p.id, "tool_id": envelope["tool_id"],
                                       "message": f"{envelope['name']} envelope interferes with the closed lid",
                                       "clearance_mm": sketch.container_height_mm-z-envelope["top_mm"]-sketch.safety_clearance_mm})
                if z+assessment["external_height_mm"]+sketch.safety_clearance_mm > sketch.container_height_mm+1e-7:
                    violations.append({"code": "ceiling", "placement_id": p.id, "message": "Bin exterior interferes with the closed lid", "clearance_mm": headroom})
        if estimated_excess:
            # the elevation is a conservative estimate over an unverified imported
            # interface, so this excess is expected, not a known collision
            unresolved.append(
                f"Estimated ceiling clearance for placement {p.id} is uncertain: it rests on an imported model "
                "whose assembled mating height is unverified"
            )
        envelopes = [{**e, "points": [drawer_point(pt, p, config) for pt in e["points"]],
                      "interior_rings": [[drawer_point(pt, p, config) for pt in ring] for ring in e["interior_rings"]],
                      "resting_z_mm": None if e["resting_z_mm"] is None else z+e["resting_z_mm"], "top_mm": None if e["top_mm"] is None else z+e["top_mm"]} for e in assessment["envelopes"]]
        results.append({"placement_id": p.id, "root_id": roots[p.id], "z_mm": z, "top_mm": top,
                        "headroom_mm": headroom, "support_compatible": compatible, **{k: v for k, v in assessment.items() if k not in ("envelopes", "violations", "status")}, "envelopes": envelopes})
        rectangles.append((p, w, h))
    for i, (a, aw, ah) in enumerate(rectangles):
        for b, bw, bh in rectangles[i+1:]:
            if roots[a.id] != roots[b.id] and a.x < b.x+bw and b.x < a.x+aw and a.y < b.y+bh and b.y < a.y+ah:
                violations.append({"code": "overlap", "placement_id": a.id, "other_placement_id": b.id, "message": "Independent stack footprints collide"})
    floor = [(p, w, h) for p, w, h in rectangles if not p.support_id]
    free_cells, occupied = [], 0
    if gx is not None and gy is not None:
        for iy in range(int(gy*2)):
            for ix in range(int(gx*2)):
                x, y = ix/2, iy/2
                if any(x < p.x+w and p.x < x+.5 and y < p.y+h and p.y < y+.5 for p, w, h in floor):
                    occupied += .25
                else:
                    free_cells.append({"x": x, "y": y, "w": .5, "h": .5})
    # ponytail: flood-fill half-grid cells; no speculative packing solver.
    remaining = {(cell["x"], cell["y"]) for cell in free_cells}
    regions = []
    while remaining:
        start = min(remaining)
        remaining.remove(start)
        region, pending = [start], [start]
        while pending:
            x, y = pending.pop()
            for neighbor in ((x+.5,y),(x-.5,y),(x,y+.5),(x,y-.5)):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    region.append(neighbor)
                    pending.append(neighbor)
        regions.append({"area_units": len(region)*.25, "cells": [{"x": x,"y": y} for x,y in region]})
    unhoused = [tid for tid in project.tool_ids if tid not in housed]
    if missing:
        unresolved.append("Tool thickness is unknown for one or more placed tools")
    if unhoused:
        unresolved.append("Project tools still need housing in this plan")
    return {"status": "invalid" if violations else "uncertain" if unresolved else "verified",
            "bins": [BinSummary(
                id=b.id, name=b.name, project_id=b.project_id, created_at=b.created_at,
                tool_ids=[p.tool_id for p in b.placed_tools], tool_count=len(b.placed_tools),
                has_stl=b.stl_path is not None, grid_x=b.bin_config.grid_x, grid_y=b.bin_config.grid_y,
                height_units=b.bin_config.height_units, half_grid_base=b.bin_config.half_grid_base,
                preview_tools=[BinPreviewTool(points=p.points, interior_rings=p.interior_rings) for p in b.placed_tools],
                imported_model=b.imported_model,
            ).model_dump() for b in bins.values() if b.id in project.bin_ids or b.project_id == project.id],
            "geometry_revision": hashlib.sha256(json.dumps([
                {"bin": bins[bid].model_dump(exclude={"stl_path"}), "smoothing": [
                    (p.tool_id, tools[p.tool_id].smoothed, tools[p.tool_id].smooth_level)
                    for p in bins[bid].placed_tools if p.tool_id in tools
                ]} for bid in sorted({p.bin_id for p in sketch.bin_layout}) if bid in bins
            ], sort_keys=True).encode()).hexdigest(),
            "violations": violations, "unresolved": unresolved, "missing_tool_ids": sorted(missing),
            "unhoused_tool_ids": unhoused, "placements": results,
            "grid_x": gx, "grid_y": gy, "width_mm": width, "depth_mm": depth,
            "height_mm": sketch.container_height_mm, "safety_clearance_mm": sketch.safety_clearance_mm,
            "residual_width_mm": None if width is None or gx is None else width-gx*42,
            "residual_depth_mm": None if depth is None or gy is None else depth-gy*42,
            "occupied_floor_units": occupied, "free_cells": free_cells, "free_regions": regions,
            "stacks": [{"root_id": p.id, "headroom_mm": min((r["headroom_mm"] for r in results if r["root_id"] == p.id and r["headroom_mm"] is not None), default=None)} for p,_,_ in floor]}
