"""Planning reuse must preserve the same physically verified answers."""

import pytest

from app.models.schemas import BinConfig, BinModel, ImportedBinModel, PlacedTool, TextLabel, Tool
from app.services import toolbox_planning as planning


@pytest.fixture
def planning_calls(monkeypatch):
    monkeypatch.setattr(planning, "_ASSESS_CACHE", {})
    monkeypatch.setattr(planning, "_PROPOSAL_CACHE", {})
    calls = {"polygons": 0, "preparation": 0, "physical": 0}
    targets = (
        (planning, "generation_polygons", "polygons"),
        (planning.PolygonScaler, "prepare_for_generation", "preparation"),
        (planning, "assess_printed_bin", "physical"),
    )
    for owner, name, counter in targets:
        original = getattr(owner, name)

        def counted(*args, _original=original, _counter=counter, **kwargs):
            calls[_counter] += 1
            return _original(*args, **kwargs)

        monkeypatch.setattr(owner, name, counted)
    return calls


def _inputs():
    points = [{"x": x, "y": y} for x, y in [(11, 11), (31, 11), (31, 31), (11, 31)]]
    tool = Tool(id="tool", name="Square", points=points, thickness_mm=12)
    data = BinModel(
        id="bin", bin_config=BinConfig(grid_x=1, grid_y=1, height_units=4, magnets=False),
        placed_tools=[PlacedTool(id="placement", tool_id=tool.id, name=tool.name, points=points, depth_override=8)],
    )
    return data, {tool.id: tool}


def test_warm_proposals_survive_assessment_eviction_and_ignore_storage_metadata(planning_calls):
    data, tools = _inputs()
    cold = planning.height_proposals(data, tools, gap=1)
    envelope = cold["assessment"]["envelopes"][0]
    assert envelope["resting_z_mm"] == pytest.approx(20)
    assert envelope["top_mm"] == pytest.approx(32)
    assert envelope["clearance_mm"] == pytest.approx(-5)
    deeper, rim = cold["alternatives"]
    assert deeper["complete"] and rim["complete"]
    assert deeper["placed_tools"][0]["depth_override"] == pytest.approx(13)
    assert deeper["bin_config"]["height_units"] == 3
    assert rim["bin_config"]["rim_units"] == 1
    assert rim["placed_tools"][0]["depth_override"] == 8
    assert data.placed_tools[0].depth_override == 8

    before = dict(planning_calls)
    assert planning.assess_bin(data, tools, gap=1) == cold["assessment"]
    assert planning_calls == before
    # Candidate assessments can be evicted independently of the whole proposal.
    planning._ASSESS_CACHE.clear()
    before = dict(planning_calls)
    assert planning.height_proposals(data, tools, gap=1) == cold
    assert planning_calls == before

    other_bin = data.model_copy(deep=True)
    other_bin.id = "another-users-bin"
    other_bin.name = "Renamed bin"
    other_bin.project_id = "another-users-project"
    other_bin.created_at = "2026-10-03"
    other_bin.stl_path = "other-user/private.stl"
    tools["unplaced"] = Tool(id="unplaced", name="Unused", points=[], thickness_mm=99)
    tools["tool"].source_session_id = "another-session"
    tools["tool"].source_image_path = "private-photo.png"
    tools["tool"].tags = ["updated"]
    assert planning.height_proposals(other_bin, tools, gap=1) == cold
    assert planning_calls == before

    # Callers may edit an inspectable proposal; no cached object is shared.
    cold["alternatives"][0]["placed_tools"][0]["depth_override"] = 99
    cold["assessment"]["envelopes"][0]["name"] = "corrupted"
    warm = planning.height_proposals(other_bin, tools, gap=1)
    assert warm["alternatives"][0]["placed_tools"][0]["depth_override"] == 13
    assert warm["assessment"]["envelopes"][0]["name"] == "Square"
    assert planning_calls == before

    tools["tool"].thickness_mm = 16
    changed = planning.height_proposals(other_bin, tools, gap=1)
    assert planning_calls["preparation"] > before["preparation"]
    assert planning_calls["physical"] > before["physical"]
    assert changed["assessment"]["envelopes"][0]["top_mm"] == pytest.approx(36)
    assert changed["alternatives"][0]["placed_tools"][0]["depth_override"] == 17


def test_consumed_inputs_invalidate_assessments_and_proposals(planning_calls):
    data, tools = _inputs()
    # Missing thickness avoids candidate search while exercising real seating.
    tools["tool"].thickness_mm = None
    initial = planning.height_proposals(data, tools)
    assert initial["assessment"]["envelopes"][0]["seating_verified"]
    before = planning_calls["physical"]

    changes = [
        lambda: setattr(tools["tool"], "name", "Renamed tool"),
        lambda: setattr(tools["tool"], "smoothed", False),
        lambda: setattr(tools["tool"], "smooth_level", .8),
        lambda: setattr(data.placed_tools[0], "depth_override", 9),
        lambda: setattr(data.placed_tools[0], "name", "Renamed placement"),
        lambda: setattr(data.placed_tools[0], "rotation", 90),
        lambda: setattr(data.placed_tools[0].points[0], "x", 12),
        lambda: setattr(data.bin_config, "cutout_clearance", 1.5),
        lambda: setattr(data.bin_config, "cutout_depth", 18),
        lambda: setattr(data.bin_config, "height_units", 5),
        lambda: setattr(data.bin_config, "insert_enabled", True),
    ]
    for change in changes:
        change()
        result = planning.height_proposals(data, tools)
        assert planning_calls["physical"] > before
        before = planning_calls["physical"]
        assert result["assessment"]["envelopes"][0]["name"] == "Renamed tool"
        assert planning.height_proposals(data, tools) == result
        assert planning_calls["physical"] == before

    label = {"id": "label", "text": "A", "x": 21, "y": 21}

    data.text_labels = [TextLabel(**label)]
    planning.height_proposals(data, tools)
    assert planning_calls["physical"] > before
    before = planning_calls["physical"]
    data.bin_config.text_labels = [TextLabel(**{**label, "id": "config-label", "text": "B"})]
    planning.height_proposals(data, tools)
    assert planning_calls["physical"] > before
    before = planning_calls["physical"]
    planning.height_proposals(data, tools, gap=2)
    assert planning_calls["physical"] > before

    upper = BinConfig(grid_x=1, grid_y=1, magnets=False)
    before = planning_calls["physical"]
    first = planning.assess_bin(data, tools, upper_config=upper)
    assert planning_calls["physical"] > before
    before = planning_calls["physical"]
    assert planning.assess_bin(data, tools, upper_config=upper) == first
    assert planning_calls["physical"] == before
    upper.half_grid_base = True
    planning.assess_bin(data, tools, upper_config=upper)
    assert planning_calls["physical"] > before
    before = planning_calls["physical"]
    planning.assess_bin(data, tools, upper_config=upper, relative_rotation=90)
    assert planning_calls["physical"] > before


def test_fifo_eviction_retains_other_warm_answers(planning_calls, monkeypatch):
    monkeypatch.setattr(planning, "_ASSESS_CACHE_LIMIT", 3)
    data, tools = _inputs()
    answers = [planning.assess_bin(data, tools, gap=gap) for gap in range(4)]
    before = dict(planning_calls)
    assert planning.assess_bin(data, tools, gap=1) == answers[1]
    assert planning.assess_bin(data, tools, gap=3) == answers[3]
    assert planning_calls == before
    planning.assess_bin(data, tools, gap=0)
    assert planning_calls["physical"] == before["physical"] + 1
    assert len(planning._ASSESS_CACHE) == 3
    answers[1]["envelopes"][0]["thickness_mm"] = 999
    assert planning.assess_bin(data, tools, gap=1)["envelopes"][0]["thickness_mm"] == 12


def test_prepared_depth_is_request_local_and_imported_measurements_stay_current(planning_calls):
    data, tools = _inputs()
    prepared = planning.generation_polygons(data, tools)
    candidate = data.model_copy(deep=True)
    candidate.placed_tools[0].depth_override = 13
    changed = planning.assess_bin(candidate, tools, prepared=prepared)
    assert changed["envelopes"][0]["resting_z_mm"] == pytest.approx(15)
    assert prepared[0].depth_override == 8
    original = planning.assess_bin(data, tools, prepared=prepared)
    assert original["envelopes"][0]["resting_z_mm"] == pytest.approx(20)
    assert prepared[0].depth_override == 8

    imported = BinModel(id="imported", imported_model=ImportedBinModel(width_mm=42, depth_mm=42, height_mm=35))
    first = planning.assess_bin(imported, {})
    assert first["status"] == "uncertain" and first["external_height_mm"] == 35
    first["import_warnings"].append("caller-only")
    assert planning.assess_bin(imported, {})["import_warnings"] == []
    imported.imported_model.height_mm = 42
    imported.imported_model.warnings = ["Unverified interface"]
    changed = planning.assess_bin(imported, {})
    assert changed["external_height_mm"] == 42
    assert changed["import_warnings"] == ["Unverified interface"]
