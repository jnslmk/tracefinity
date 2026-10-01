"""Measure exported pocket floors instead of duplicating the depth formula."""

import numpy as np
import pytest
import trimesh
from pydantic import ValidationError

from app.models.schemas import BinConfig, BinModel, GenerateRequest, PlacedTool, Tool
from app.services.polygon_scaler import PolygonScaler, ScaledFingerHole, ScaledPolygon
from app.services.stl_generator_manifold import ManifoldSTLGenerator
from app.services.toolbox_planning import assess_bin


def _surface_z(mesh, x=0, y=0):
    """Find the upward-facing horizontal surface at a point in bin coordinates."""
    triangles = mesh.triangles[mesh.face_normals[:, 2] > 0.99]
    points = np.column_stack((np.full(len(triangles), x), np.full(len(triangles), y), triangles[:, 0, 2]))
    barycentric = trimesh.triangles.points_to_barycentric(triangles, points)
    heights = triangles[np.all(barycentric >= -1e-6, axis=1), 0, 2]
    assert len(heights), "no pocket floor at measurement point"
    assert np.ptp(heights) < 1e-5
    return heights[0]


def _generate(tmp_path, config, override=None, finger_depth=None):
    holes = [] if finger_depth is None else [
        ScaledFingerHole("finger", 34, 21, 2, shape="cylinder", depth_override=finger_depth)
    ]
    poly = ScaledPolygon(
        "square", [(11, 11), (31, 11), (31, 31), (11, 31)], "Square",
        depth_override=override, finger_holes=holes,
    )
    output = tmp_path / "bin.stl"
    body, _ = ManifoldSTLGenerator().generate_bin([poly], config, str(output))
    mesh = trimesh.load_mesh(output)
    assert mesh.is_watertight
    assert body.volume() > 0
    return mesh


@pytest.mark.parametrize("lip,rim", [(False, 0), (True, 0), (True, 2)])
@pytest.mark.parametrize("height,requested", [(2, 7), (3, 14)])
def test_requested_depth_survives_lip_and_raised_rim(tmp_path, lip, rim, height, requested):
    config = GenerateRequest(grid_x=1, grid_y=1, height_units=height, cutout_depth=requested,
                             stacking_lip=lip, rim_units=rim)
    mesh = _generate(tmp_path, config)
    floor = _surface_z(mesh)
    assert height * 7 - floor == pytest.approx(requested)
    assert floor - 4.75 == pytest.approx(2.25)
    assert mesh.bounds[1, 2] == pytest.approx(height * 7 + rim * 7 + (4.4 if lip else 0))


@pytest.mark.parametrize("lip", [False, True])
@pytest.mark.parametrize("height,maximum", [(1, 0.25), (2, 7.25), (3, 14.25), (4, 21.25)])
@pytest.mark.parametrize("override", [None, 200])
def test_global_and_feature_limits_preserve_floor(tmp_path, lip, height, maximum, override):
    config = GenerateRequest(grid_x=1, grid_y=1, height_units=height,
                             cutout_depth=200 if override is None else 5, stacking_lip=lip)
    mesh = _generate(tmp_path, config, override=override, finger_depth=200)
    for x in (0, 13):  # tool pocket and independently overridden finger hole
        floor = _surface_z(mesh, x=x)
        assert height * 7 - floor == pytest.approx(maximum)
        assert floor - 4.75 == pytest.approx(2)


@pytest.mark.parametrize("override", [None, 6])
@pytest.mark.parametrize("height,insert,expected", [(2, 1, 7), (2, 2, 7.25), (1, 1, 0.25)])
def test_insert_allowance_respects_physical_limit(tmp_path, override, height, insert, expected):
    config = GenerateRequest(grid_x=1, grid_y=1, height_units=height,
                             cutout_depth=6 if override is None else 5,
                             insert_enabled=True, insert_height=insert)
    mesh = _generate(tmp_path, config, override=override)
    floor = _surface_z(mesh)
    assert height * 7 - floor == pytest.approx(expected)
    assert floor >= 6.75 - 1e-5


def test_shallow_depth_round_trips_through_saved_config(tmp_path):
    config = GenerateRequest(grid_x=1, grid_y=1, height_units=1, cutout_depth=0.25)
    restored = GenerateRequest.model_validate_json(config.model_dump_json())
    assert restored.cutout_depth == 0.25
    assert _surface_z(_generate(tmp_path, restored)) == pytest.approx(6.75)


@pytest.mark.parametrize("depth", [0, 0.24, 201])
def test_depth_schema_rejects_out_of_range_values(depth):
    with pytest.raises(ValidationError, match="cutout depth must be between"):
        GenerateRequest(cutout_depth=depth)


@pytest.mark.parametrize("height,depth,override,insert,rim,lip", [
    (4, 20, None, 0, 0, True),
    (4, 20, 8, 0, 0, True),
    (2, 200, None, 0, 0, True),
    (1, 200, 200, 1, 0, True),
    (4, 20, 8, 2, 0, True),
    (4, 20, 8, 2, 3, True),
    (4, 20, 8, 0, 3, False),
])
def test_planning_envelope_resting_height_matches_printed_surfaces(tmp_path, height, depth, override, insert, rim, lip):
    config = GenerateRequest(grid_x=1, grid_y=1, height_units=height, cutout_depth=depth,
                             insert_enabled=insert > 0, insert_height=insert or 1,
                             rim_units=rim, stacking_lip=lip, magnets=False)
    mesh = _generate(tmp_path, config, override)
    points = [{"x": 11, "y": 11}, {"x": 31, "y": 11}, {"x": 31, "y": 31}, {"x": 11, "y": 31}]
    tool = Tool(id="tool", name="Square", points=points, thickness_mm=12)
    bin_data = BinModel(id="bin", bin_config=BinConfig.model_validate(config.model_dump()),
                        placed_tools=[PlacedTool(id="placement", tool_id=tool.id, name=tool.name,
                                                 points=points, depth_override=override)])
    assessment = assess_bin(bin_data, {tool.id: tool}, gap=1)
    insert_surface = 0
    if insert:
        insert_path = tmp_path / "insert.stl"
        poly = ScaledPolygon("square", [(p["x"], p["y"]) for p in points], "Square", depth_override=override)
        assert ManifoldSTLGenerator().generate_insert([poly], config, str(insert_path), -21, -21)
        insert_mesh = trimesh.load_mesh(insert_path)
        insert_surface = insert_mesh.bounds[1, 2] - insert_mesh.bounds[0, 2]
    rest = _surface_z(mesh) + insert_surface
    assert assessment["envelopes"][0]["resting_z_mm"] == pytest.approx(rest)
    assert assessment["envelopes"][0]["top_mm"] == pytest.approx(rest + 12)
    assert assessment["external_height_mm"] == pytest.approx(mesh.bounds[1, 2])
    if not lip:
        assert assessment["status"] == "invalid"


@pytest.mark.parametrize("rim,half_grid,wide", [(0, False, False), (1, False, False), (3, False, False), (0, True, False), (2, True, False), (0, False, True)])
def test_planned_mating_position_contacts_generated_surface_without_intersection(tmp_path, rim, half_grid, wide):
    config = GenerateRequest(grid_x=1, grid_y=1, height_units=4, rim_units=rim,
                             half_grid_base=half_grid, cutout_depth=8, cutout_clearance=.2, magnets=False)
    points = [(3, 3), (39, 3), (39, 39), (3, 39)] if wide else [(11, 11), (31, 11), (31, 31), (11, 31)]
    poly = ScaledPolygon("tool", points, "Tool")
    prepared = PolygonScaler().prepare_for_generation(poly, config.cutout_clearance, smoothed=False)
    generator = ManifoldSTLGenerator()
    lower, _ = generator.generate_bin([prepared], config, str(tmp_path / "lower.stl"))
    upper, _ = generator.generate_bin([], config, str(tmp_path / "upper.stl"))
    tool = Tool(id="tool", name="Tool", points=[{"x": x, "y": y} for x, y in poly.points_mm], thickness_mm=12, smoothed=False)
    data = BinModel(id="bin", bin_config=BinConfig.model_validate(config.model_dump()), placed_tools=[
        PlacedTool(id="p", tool_id=tool.id, name=tool.name, points=tool.points),
    ])
    assessment = assess_bin(data, {tool.id: tool}, gap=.5)
    z = assessment["stack_increment_mm"]
    # Independent solids establish the actual assembly: one cannot lower the
    # upper bin further without intersecting the printed floor or mating collar.
    assert (lower ^ upper.translate((0, 0, z))).volume() == pytest.approx(0, abs=1e-4)
    assert (lower ^ upper.translate((0, 0, z - .02))).volume() > 1e-4
    lower_mesh = trimesh.load_mesh(tmp_path / "lower.stl")
    upper_mesh = trimesh.load_mesh(tmp_path / "upper.stl")
    underside = upper_mesh.bounds[0, 2] + z
    tool_top = _surface_z(lower_mesh) + tool.thickness_mm
    assert assessment["envelopes"][0]["clearance_mm"] == pytest.approx(underside - tool_top - .5)
    assert z + upper_mesh.bounds[1, 2] != pytest.approx(assessment["external_height_mm"] * 2)


@pytest.mark.parametrize("half_grid", [False, True])
@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_raised_rectangular_mating_matches_rotated_generated_upper_base(tmp_path, half_grid, rotation):
    lower_config = GenerateRequest(grid_x=2, grid_y=1, height_units=4, rim_units=1,
                                   half_grid_base=half_grid, magnets=False, cutout_depth=8, cutout_clearance=.2)
    upper_config = lower_config.model_copy(update={"grid_x": 1, "grid_y": 2}) if rotation in (90, 270) else lower_config
    raw = ScaledPolygon("tool", [(32, 11), (52, 11), (52, 31), (32, 31)], "Tool")
    prepared = PolygonScaler().prepare_for_generation(raw, lower_config.cutout_clearance, smoothed=False)
    lower, _ = ManifoldSTLGenerator().generate_bin([prepared], lower_config, str(tmp_path / "lower.stl"))
    upper, _ = ManifoldSTLGenerator().generate_bin([], upper_config, str(tmp_path / "upper.stl"))
    upper = upper.rotate((0, 0, -rotation))
    tool = Tool(id="tool", name="Tool", points=[{"x": x, "y": y} for x, y in raw.points_mm], thickness_mm=5, smoothed=False)
    data = BinModel(id="bin", bin_config=BinConfig.model_validate(lower_config.model_dump()), placed_tools=[
        PlacedTool(id="p", tool_id=tool.id, name=tool.name, points=tool.points),
    ])
    assessment = assess_bin(data, {tool.id: tool}, upper_config=BinConfig.model_validate(upper_config.model_dump()),
                            relative_rotation=rotation)
    z = assessment["stack_increment_mm"]
    assert assessment["status"] == "verified"
    assert (lower ^ upper.translate((0, 0, z))).volume() < 1e-4
    assert (lower ^ upper.translate((0, 0, z-.02))).volume() > 1e-4
