"""Automatic per-tool cutout depths.

A measured tool must sit just deep enough that the bin stacked on top clears it
by the configured stacking clearance, and the exported solid must match the
planning assessment. Depths that cannot be reached, or that a custom override
makes too shallow, must warn instead of claiming a stack-safe bin.
"""

import pytest
import trimesh
from pydantic import ValidationError

import app.api.routes as routes
from app.models.schemas import BinConfig, BinModel, GenerateRequest, PlacedTool, Tool
from app.services.pocket_depths import mating_increment_mm
from app.services.stl_generator_manifold import GF_HEIGHT_UNIT
from app.services.toolbox_planning import assess_bin
from tests.test_bin_projects import _api_client
from tests.test_max_cutout_depth import _surface_z


def _square(size: float, x: float = 0.0, y: float = 0.0):
    return [
        {"x": x, "y": y}, {"x": x + size, "y": y},
        {"x": x + size, "y": y + size}, {"x": x, "y": y + size},
    ]


def _tools(*measured):
    return {
        tool_id: Tool(id=tool_id, name=tool_id, points=_square(20), thickness_mm=thickness)
        for tool_id, thickness in measured
    }


def _auto_config(**overrides):
    config = BinConfig(grid_x=2, grid_y=1, height_units=4, magnets=False,
                       cutout_depth=20, cutout_depth_mode="automatic", stacking_clearance_mm=1)
    for key, value in overrides.items():
        setattr(config, key, value)
    return config


def _envelopes(config, placements, tools):
    assessment = assess_bin(BinModel(id="bin", bin_config=config, placed_tools=placements), tools, gap=0)
    return assessment, {envelope["id"]: envelope for envelope in assessment["envelopes"]}


def _placements(pairs):
    return [
        PlacedTool(id=placement_id, tool_id=tool_id, name=tool_id, points=_square(20, x, y))
        for placement_id, tool_id, x, y in pairs
    ]


def test_heterogeneous_measured_tools_get_minimal_individual_depths(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _, tool_store, _ = routes.get_stores("default")
    for tool_id, thickness in (("thin", 4), ("thick", 18)):
        tool_store.set(tool_id, Tool(id=tool_id, name=tool_id, points=_square(20), thickness_mm=thickness))

    bin_data = client.post("/api/bins", json={
        "name": "Automatic", "bin_config": {"grid_x": 2, "grid_y": 1, "height_units": 4, "magnets": False,
                                            "cutout_depth_mode": "automatic", "stacking_clearance_mm": 1},
    }).json()
    bin_id = bin_data["id"]
    placements = _placements([("a", "thin", 10, 10), ("b", "thick", 52, 10)])
    assert client.put(f"/api/bins/{bin_id}", json={"placed_tools": [p.model_dump() for p in placements]}).status_code == 200

    stored = client.get(f"/api/bins/{bin_id}").json()
    assert stored["bin_config"]["cutout_depth_mode"] == "automatic"
    # derived depths never become stored manual overrides
    assert [p["depth_override"] for p in stored["placed_tools"]] == [None, None]

    tools = {tool_id: tool_store.get(tool_id) for tool_id in ("thin", "thick")}
    assessment, envelopes = _envelopes(BinConfig.model_validate(stored["bin_config"]), placements, tools)
    assert assessment["status"] == "verified"
    # shallowest pocket that still leaves the configured clearance: thickness + 1mm
    assert envelopes["a"]["effective_depth_mm"] == pytest.approx(5)
    assert envelopes["b"]["effective_depth_mm"] == pytest.approx(19)
    assert envelopes["a"]["clearance_mm"] == pytest.approx(1)
    assert envelopes["b"]["clearance_mm"] == pytest.approx(1)

    # the exported solid must rest the tools on the same pocket floors
    assert client.post(f"/api/bins/{bin_id}/generate").status_code == 200
    mesh = trimesh.load_mesh(tmp_path / "default" / "outputs" / f"{bin_id}.stl")
    wall_top = stored["bin_config"]["height_units"] * GF_HEIGHT_UNIT
    assert _surface_z(mesh, x=-22, y=1) == pytest.approx(wall_top - 5, abs=1e-4)
    assert _surface_z(mesh, x=20, y=1) == pytest.approx(wall_top - 19, abs=1e-4)


def test_automatic_depths_follow_the_generated_mating_increment():
    tools = _tools(("thick", 18))
    rimmed = _auto_config(rim_units=1)
    assessment, envelopes = _envelopes(rimmed, _placements([("b", "thick", 10, 10)]), tools)
    increment = mating_increment_mm(GenerateRequest.model_validate({**rimmed.model_dump(), "text_labels": []}))
    wall_top = rimmed.height_units * GF_HEIGHT_UNIT
    # the raised rim is a real mating surface, not a nominal 7mm lip
    assert increment != pytest.approx(wall_top + GF_HEIGHT_UNIT)
    assert assessment["stack_increment_mm"] == pytest.approx(increment)
    assert envelopes["b"]["effective_depth_mm"] == pytest.approx(wall_top - increment + 18 + 1)
    assert envelopes["b"]["clearance_mm"] == pytest.approx(1)
    assert envelopes["b"]["effective_depth_mm"] < 19


def test_uniform_mode_ignores_but_keeps_custom_depths():
    tools = _tools(("thin", 4), ("mid", 10))
    placements = [p.model_copy(update={"depth_override": 8}) for p in _placements([("a", "thin", 10, 10), ("b", "mid", 52, 10)])]
    uniform = _auto_config(cutout_depth_mode="uniform", cutout_depth=12)
    assessment, envelopes = _envelopes(uniform, placements, tools)
    assert assessment["status"] == "verified"
    assert envelopes["a"]["effective_depth_mm"] == pytest.approx(12)
    assert envelopes["b"]["effective_depth_mm"] == pytest.approx(12)
    # the stored overrides are untouched, so leaving uniform restores them
    assert [p.depth_override for p in placements] == [8, 8]

    legacy = _auto_config(cutout_depth_mode=None, cutout_depth=20)
    _, legacy_envelopes = _envelopes(legacy, placements, tools)
    assert legacy_envelopes["a"]["effective_depth_mm"] == pytest.approx(8)
    assert legacy_envelopes["b"]["effective_depth_mm"] == pytest.approx(8)


def test_pre_feature_records_keep_their_override_behaviour():
    assert BinConfig().cutout_depth_mode is None
    assert BinConfig.model_validate({"grid_x": 2, "cutout_depth": 20}).cutout_depth_mode is None
    automatic = BinConfig.model_validate({"grid_x": 2, "cutout_depth_mode": "automatic", "stacking_clearance_mm": 1.5})
    assert BinConfig.model_validate_json(automatic.model_dump_json()).cutout_depth_mode == "automatic"
    assert automatic.stacking_clearance_mm == 1.5
    assert PlacedTool(id="p", tool_id="t", name="t", points=[]).depth_mode is None


def test_unknown_thickness_falls_back_to_the_global_depth_and_stays_unverified():
    tools = _tools(("measured", 4))
    tools["bare"] = Tool(id="bare", name="bare", points=_square(20))
    assessment, envelopes = _envelopes(_auto_config(), _placements([("a", "bare", 10, 10), ("b", "measured", 52, 10)]), tools)
    assert assessment["status"] == "uncertain"
    assert assessment["missing_tool_ids"] == ["bare"]
    # unverified fallback: the configured depth, with no claimed clearance
    assert envelopes["a"]["effective_depth_mm"] == pytest.approx(20)
    assert envelopes["a"]["clearance_mm"] is None
    assert envelopes["b"]["effective_depth_mm"] == pytest.approx(5)


def test_impossible_automatic_depth_reports_the_shortfall():
    tools = _tools(("thick", 18))
    short = _auto_config(height_units=1)
    assessment, envelopes = _envelopes(short, _placements([("b", "thick", 10, 10)]), tools)
    assert assessment["status"] == "invalid"
    codes = {violation["code"] for violation in assessment["violations"]}
    assert "automatic_depth_unsupported" in codes
    unsupported = next(v for v in assessment["violations"] if v["code"] == "automatic_depth_unsupported")
    assert unsupported["clearance_mm"] < 0
    assert "19.00mm pocket" in unsupported["message"]
    # the protected floor was respected even though the tool cannot clear
    assert envelopes["b"]["effective_depth_mm"] == pytest.approx(7 - 4.75 - 2)


def test_bin_geometry_change_recomputes_the_derived_depth():
    tools = _tools(("thick", 18))
    tight = _auto_config(height_units=2)
    loose = _auto_config(height_units=4)
    tight_assessment, tight_envelopes = _envelopes(tight, _placements([("b", "thick", 10, 10)]), tools)
    loose_assessment, loose_envelopes = _envelopes(loose, _placements([("b", "thick", 10, 10)]), tools)
    assert tight_envelopes["b"]["effective_depth_mm"] == pytest.approx(14 - 4.75 - 2)
    assert tight_assessment["status"] == "invalid"
    assert loose_envelopes["b"]["effective_depth_mm"] == pytest.approx(19)
    assert loose_envelopes["b"]["clearance_mm"] == pytest.approx(1)
    assert loose_assessment["status"] == "verified"


def test_too_shallow_custom_depth_warns_in_automatic_mode():
    tools = _tools(("thick", 18))
    placements = _placements([("b", "thick", 10, 10)])
    placements[0].depth_mode = "custom"
    placements[0].depth_override = 5
    assessment, _ = _envelopes(_auto_config(), placements, tools)
    assert assessment["status"] == "invalid"
    shallow = next(v for v in assessment["violations"] if v["code"] == "custom_depth_too_shallow")
    assert shallow["tool_id"] == "thick"
    assert shallow["clearance_mm"] < 0


def test_insert_allowance_is_part_of_the_derived_depth():
    tools = _tools(("thin", 4))
    config = _auto_config(insert_enabled=True, insert_height=3)
    assessment, envelopes = _envelopes(config, _placements([("a", "thin", 10, 10)]), tools)
    assert assessment["status"] == "verified"
    assert envelopes["a"]["effective_depth_mm"] == pytest.approx(4 + 3 + 1)
    assert envelopes["a"]["clearance_mm"] == pytest.approx(1)


def test_changed_shared_measurement_invalidates_the_cached_export(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _, tool_store, _ = routes.get_stores("default")
    tool_store.set("thin", Tool(id="thin", name="thin", points=_square(20), thickness_mm=4))
    bin_id = client.post("/api/bins", json={
        "name": "Automatic", "bin_config": {"grid_x": 2, "grid_y": 1, "height_units": 4, "magnets": False,
                                            "cutout_depth_mode": "automatic", "stacking_clearance_mm": 1},
    }).json()["id"]
    placements = _placements([("a", "thin", 10, 10)])
    assert client.put(f"/api/bins/{bin_id}", json={"placed_tools": [p.model_dump() for p in placements]}).status_code == 200

    wall_top = 4 * GF_HEIGHT_UNIT
    assert client.post(f"/api/bins/{bin_id}/generate").status_code == 200
    first = trimesh.load_mesh(tmp_path / "default" / "outputs" / f"{bin_id}.stl")
    assert _surface_z(first, x=-22, y=1) == pytest.approx(wall_top - 5, abs=1e-4)

    assert client.put("/api/tools/thin", json={"thickness_mm": 10}).status_code == 200
    assert client.post(f"/api/bins/{bin_id}/generate").status_code == 200
    second = trimesh.load_mesh(tmp_path / "default" / "outputs" / f"{bin_id}.stl")
    assert _surface_z(second, x=-22, y=1) == pytest.approx(wall_top - 11, abs=1e-4)


@pytest.mark.parametrize("field,value", [
    ("stacking_clearance_mm", -0.5),
    ("stacking_clearance_mm", 10.5),
    ("stacking_clearance_mm", float("nan")),
])
def test_new_numeric_fields_are_validated(field, value):
    with pytest.raises(ValidationError):
        BinConfig(grid_x=2, grid_y=1, **{field: value})


def test_depth_mode_values_are_validated():
    with pytest.raises(ValidationError):
        BinConfig(grid_x=2, grid_y=1, cutout_depth_mode="per_tool")
    with pytest.raises(ValidationError):
        PlacedTool(id="p", tool_id="t", name="t", points=[], depth_mode="legacy")
