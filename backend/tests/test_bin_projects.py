import math

import manifold3d as mf
import pytest
import trimesh
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.api.routes as routes
from app.config import ensure_user_dirs, settings
from app.main import app
from app.models.schemas import (
    BinConfig,
    BinModel,
    BinProject,
    BinProjectBinsRequest,
    BinProjectCreateBinRequest,
    BinProjectCreateRequest,
    BinProjectToolsRequest,
    BinProjectUpdateRequest,
    GenerateRequest,
    PlacedTool,
    ProjectBinPlacement,
    ProjectSketch,
    TextLabel,
    Tool,
)
from app.services.bin_store import BinStore
from app.services.polygon_scaler import PolygonScaler, ScaledFingerHole, ScaledPolygon
from app.services.project_service import project_health, project_status, repair_project_links
from app.services.project_store import ProjectStore
from app.services.stl_generator_manifold import ManifoldSTLGenerator
from app.services.tool_store import ToolStore
from app.services.toolbox_planning import assess_bin
from tests.test_max_cutout_depth import _surface_z


def test_old_project_records_get_defaults():
    project = BinProject.model_validate({
        "id": "project-1",
        "name": "Top drawer",
    })

    assert project.description is None
    assert project.tool_ids == []
    assert project.bin_ids == []
    assert project.status == "active"
    assert project.sketches == []
    assert project.default_bin_config is None
    assert project.notes is None


def test_project_metadata_round_trips():
    project = BinProject.model_validate({
        "id": "project-1",
        "name": "Top drawer",
        "description": "Metric tools",
        "status": "ready_to_print",
        "tool_ids": ["tool-1", "tool-2"],
        "bin_ids": ["bin-1"],
        "sketches": [{"id": "sketch-1", "name": "Top drawer", "target_grid_x": 4, "target_grid_y": 5}],
        "default_bin_config": {"grid_x": 3, "grid_y": 2},
        "notes": "print first bin as test",
        "created_at": "2026-05-10T00:00:00",
        "updated_at": "2026-05-10T00:00:01",
    })
    data = project.model_dump()

    assert data["tool_ids"] == ["tool-1", "tool-2"]
    assert data["bin_ids"] == ["bin-1"]
    assert data["status"] == "ready_to_print"
    assert data["sketches"][0]["target_grid_x"] == 4
    assert data["sketches"][0]["name"] == "Top drawer"
    assert data["default_bin_config"]["grid_x"] == 3
    assert data["notes"] == "print first bin as test"


def test_project_requests_support_clearable_fields():
    create_req = BinProjectCreateRequest(
        name="Top drawer",
        tool_ids=["tool-1"],
        default_bin_config=BinConfig(grid_x=4, grid_y=3, magnet_diameter=6.2, bed_size=220),
    )
    update_req = BinProjectUpdateRequest(description=None, notes=None)
    tools_req = BinProjectToolsRequest(tool_ids=["tool-1", "tool-2"])
    bins_req = BinProjectBinsRequest(bin_ids=["bin-1"], import_tools=True)
    bin_req = BinProjectCreateBinRequest(
        name="Top drawer bin",
        tool_ids=["tool-1"],
        bin_config=BinConfig(magnet_diameter=6.4, bed_size=210),
    )

    assert create_req.tool_ids == ["tool-1"]
    assert create_req.default_bin_config.grid_x == 4
    assert create_req.default_bin_config.magnet_diameter == 6.2
    assert create_req.default_bin_config.bed_size == 220
    assert "description" in update_req.model_fields_set
    assert "notes" in update_req.model_fields_set
    assert tools_req.tool_ids == ["tool-1", "tool-2"]
    assert bins_req.import_tools is True
    assert bin_req.tool_ids == ["tool-1"]
    assert bin_req.bin_config.magnet_diameter == 6.4


def test_project_store_round_trips(tmp_path):
    store = ProjectStore(tmp_path)
    project = BinProject(id="project-1", name="Top drawer", tool_ids=["tool-1"])

    store.set(project.id, project)
    reloaded = ProjectStore(tmp_path)

    assert reloaded.get("project-1").name == "Top drawer"
    assert reloaded.get("project-1").tool_ids == ["tool-1"]


def test_project_store_delete_keeps_other_projects(tmp_path):
    store = ProjectStore(tmp_path)
    store.set("project-1", BinProject(id="project-1", name="Top drawer"))
    store.set("project-2", BinProject(id="project-2", name="Bottom drawer"))

    deleted = store.delete("project-1")

    assert deleted.name == "Top drawer"
    assert store.get("project-1") is None
    assert store.get("project-2").name == "Bottom drawer"


def test_project_status_tracks_placed_and_unplaced():
    project = BinProject(id="project-1", name="Top drawer", tool_ids=["tool-1", "tool-2", "tool-3"])
    linked_bins = [
        BinModel(
            id="bin-1",
            placed_tools=[
                PlacedTool(id="pt-1", tool_id="tool-1", name="Tool 1", points=[]),
                PlacedTool(id="pt-2", tool_id="tool-2", name="Tool 2", points=[]),
            ],
        ),
        BinModel(
            id="bin-2",
            placed_tools=[
                PlacedTool(id="pt-3", tool_id="tool-2", name="Tool 2 duplicate", points=[]),
                PlacedTool(id="pt-4", tool_id="other-tool", name="Other", points=[]),
            ],
        ),
    ]

    status = project_status(project, linked_bins)

    assert status["placed_tool_ids"] == ["tool-1", "tool-2"]
    assert status["unplaced_tool_ids"] == ["tool-3"]


def _tool(tool_id: str, project_ids: list[str] | None = None) -> Tool:
    return Tool(
        id=tool_id,
        name=tool_id,
        points=[
            {"x": 0, "y": 0},
            {"x": 10, "y": 0},
            {"x": 10, "y": 10},
        ],
        project_ids=project_ids or [],
    )


def _api_client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_path", tmp_path)
    monkeypatch.setattr(routes.settings, "storage_path", tmp_path)
    routes._store_cache.clear()
    routes._project_store_cache.clear()
    ensure_user_dirs(tmp_path / "default")
    return TestClient(app)


def _seed_tool(tool_id: str):
    _, tool_store, _ = routes.get_stores("default")
    tool_store.set(tool_id, _tool(tool_id))


def test_project_create_bin_derives_placed_status_without_persisting_state(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _seed_tool("tool-1")

    project_resp = client.post("/api/bin-projects", json={"name": "Top drawer", "tool_ids": ["tool-1"]})
    assert project_resp.status_code == 200
    project_id = project_resp.json()["id"]

    bin_resp = client.post(f"/api/bin-projects/{project_id}/create-bin", json={"tool_ids": ["tool-1"]})
    assert bin_resp.status_code == 200

    detail = client.get(f"/api/bin-projects/{project_id}").json()

    assert detail["placed_tool_ids"] == ["tool-1"]
    assert detail["unplaced_tool_ids"] == []


def test_project_placed_status_updates_when_bin_contents_change(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _seed_tool("tool-1")

    project = client.post("/api/bin-projects", json={"name": "Top drawer", "tool_ids": ["tool-1"]}).json()
    bin_data = client.post("/api/bins", json={"name": "Working bin", "project_id": project["id"], "tool_ids": ["tool-1"]}).json()

    assert client.get(f"/api/bin-projects/{project['id']}").json()["placed_tool_ids"] == ["tool-1"]

    update_resp = client.put(f"/api/bins/{bin_data['id']}", json={"placed_tools": []})
    assert update_resp.status_code == 200
    detail = client.get(f"/api/bin-projects/{project['id']}").json()

    assert detail["placed_tool_ids"] == []
    assert detail["unplaced_tool_ids"] == ["tool-1"]


def test_project_update_round_trips_default_bin_config(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()

    update_resp = client.patch(f"/api/bin-projects/{project['id']}", json={
        "default_bin_config": {
            "magnet_diameter": 6.2,
            "magnet_depth": 2.8,
            "magnet_corners_only": True,
            "bed_size": 220,
        },
    })

    assert update_resp.status_code == 200
    updated_config = update_resp.json()["default_bin_config"]
    assert updated_config["magnet_diameter"] == 6.2
    assert updated_config["magnet_depth"] == 2.8
    assert updated_config["magnet_corners_only"] is True
    assert updated_config["bed_size"] == 220
    detail_config = client.get(f"/api/bin-projects/{project['id']}").json()["default_bin_config"]
    assert detail_config == updated_config

    clear_resp = client.patch(f"/api/bin-projects/{project['id']}", json={"default_bin_config": None})

    assert clear_resp.status_code == 200
    assert clear_resp.json()["default_bin_config"] is None


def test_create_bin_accepts_default_bin_config(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)

    resp = client.post("/api/bins", json={
        "name": "Magnet test",
        "bin_config": {
            "magnet_diameter": 6.2,
            "magnet_depth": 2.8,
            "magnet_corners_only": True,
            "bed_size": 220,
        },
    })

    assert resp.status_code == 200
    bin_config = resp.json()["bin_config"]
    assert bin_config["magnet_diameter"] == 6.2
    assert bin_config["magnet_depth"] == 2.8
    assert bin_config["magnet_corners_only"] is True
    assert bin_config["bed_size"] == 220


def test_project_create_bin_uses_request_config_before_project_default(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _seed_tool("tool-1")

    project = client.post("/api/bin-projects", json={
        "name": "Top drawer",
        "tool_ids": ["tool-1"],
        "default_bin_config": {"magnet_diameter": 6.2, "bed_size": 220},
    }).json()

    project_default_resp = client.post(
        f"/api/bin-projects/{project['id']}/create-bin",
        json={"tool_ids": ["tool-1"]},
    )
    override_resp = client.post(
        f"/api/bin-projects/{project['id']}/create-bin",
        json={
            "name": "Override bin",
            "tool_ids": ["tool-1"],
            "bin_config": {"magnet_diameter": 6.4, "bed_size": 210},
        },
    )

    assert project_default_resp.status_code == 200
    assert project_default_resp.json()["bin_config"]["magnet_diameter"] == 6.2
    assert project_default_resp.json()["bin_config"]["bed_size"] == 220
    assert override_resp.status_code == 200
    assert override_resp.json()["bin_config"]["magnet_diameter"] == 6.4
    assert override_resp.json()["bin_config"]["bed_size"] == 210


def test_project_health_reports_and_repairs_safe_link_mismatches(tmp_path):
    project_store = ProjectStore(tmp_path)
    tool_store = ToolStore(tmp_path)
    bin_store = BinStore(tmp_path)

    tool_store.set("tool-1", _tool("tool-1"))
    tool_store.set("tool-extra", _tool("tool-extra", ["project-1"]))
    bin_store.set("bin-1", BinModel(id="bin-1", project_id=None))
    bin_store.set("bin-2", BinModel(id="bin-2", project_id="project-1"))
    project = BinProject(
        id="project-1",
        name="Top drawer",
        tool_ids=["tool-1", "missing-tool"],
        bin_ids=["bin-1", "missing-bin"],
    )
    project_store.set(project.id, project)

    issues = project_health(project, tool_store, bin_store)

    assert {issue.code for issue in issues} >= {
        "missing_tool",
        "missing_bin",
        "tool_missing_project_id",
        "tool_extra_project_id",
        "bin_missing_project_id",
    }

    repaired = repair_project_links(project_store, project, tool_store, bin_store)

    assert repaired.tool_ids == ["tool-1"]
    assert "missing-bin" not in repaired.bin_ids
    assert "bin-2" in repaired.bin_ids
    assert tool_store.get("tool-1").project_ids == ["project-1"]
    assert tool_store.get("tool-extra").project_ids == []
    assert bin_store.get("bin-1").project_id == "project-1"


def test_project_health_reports_outside_bin_tools():
    project = BinProject(id="project-1", name="Top drawer", tool_ids=["tool-1"], bin_ids=["bin-1"])
    class ToolStoreStub:
        def all(self):
            return {"tool-1": _tool("tool-1", ["project-1"]), "tool-2": _tool("tool-2")}
    class BinStoreStub:
        def all(self):
            return {
                "bin-1": BinModel(
                    id="bin-1",
                    project_id="project-1",
                    placed_tools=[PlacedTool(id="pt-1", tool_id="tool-2", name="Tool 2", points=[])],
                )
            }

    issues = project_health(project, ToolStoreStub(), BinStoreStub())

    assert any(issue.code == "outside_tool" and not issue.repairable for issue in issues)


def test_project_bin_placement_validates_grid_offsets():
    placement = ProjectBinPlacement(bin_id="bin-1", x=2.5, y=0, rotation=270)

    assert placement.x == 2.5
    assert placement.rotation == 270
    assert placement.id
    with pytest.raises(ValidationError):
        ProjectBinPlacement(bin_id="bin-1", x=0.3)
    assert ProjectBinPlacement(bin_id="bin-1", x=-1, y=42).x == -1
    with pytest.raises(ValidationError):
        ProjectBinPlacement(bin_id="bin-1", x=float("inf"))
    with pytest.raises(ValidationError):
        ProjectBinPlacement(bin_id="bin-1", rotation=45)


def test_project_bin_placement_validates_colour():
    assert ProjectBinPlacement(bin_id="bin-1", color="#A1B2C3").color == "#a1b2c3"
    assert ProjectBinPlacement(bin_id="bin-1").color is None
    with pytest.raises(ValidationError):
        ProjectBinPlacement(bin_id="bin-1", color="red")
    with pytest.raises(ValidationError):
        ProjectBinPlacement(bin_id="bin-1", color="#abc")


def test_project_bin_placements_get_distinct_ids():
    first = ProjectBinPlacement(bin_id="bin-1")
    second = ProjectBinPlacement(bin_id="bin-1")

    assert first.id != second.id


def test_sketch_target_grid_covers_drawer_sized_grids():
    sketch = ProjectSketch(target_grid_x=12, target_grid_y=7.5)

    assert sketch.target_grid_x == 12
    assert sketch.target_grid_y == 7.5
    assert sketch.name == "Drawer plan"
    with pytest.raises(ValidationError):
        ProjectSketch(target_grid_x=41)


def test_legacy_project_layout_becomes_a_sketch():
    project = BinProject.model_validate({
        "id": "project-1",
        "name": "Top drawer",
        "target_grid_x": 6,
        "target_grid_y": 4,
        "bin_layout": [{"id": "p1", "bin_id": "bin-1", "x": 1, "y": 0, "rotation": 90}],
        "created_at": "2026-05-10T00:00:00",
    })

    assert len(project.sketches) == 1
    sketch = project.sketches[0]
    assert sketch.name == "Drawer plan"
    assert sketch.target_grid_x == 6
    assert sketch.target_grid_y == 4
    assert [p.bin_id for p in sketch.bin_layout] == ["bin-1"]
    assert sketch.id
    assert "target_grid_x" not in project.model_dump()


def test_project_without_legacy_layout_stays_empty():
    project = BinProject.model_validate({"id": "project-1", "name": "Top drawer", "bin_layout": []})

    assert project.sketches == []


def test_sketch_layout_round_trips_through_patch(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()
    bin_data = client.post("/api/bins", json={"name": "Bin A", "project_id": project["id"]}).json()
    sketch = client.post(f"/api/bin-projects/{project['id']}/sketches", json={"name": "Top"}).json()

    resp = client.patch(f"/api/bin-projects/{project['id']}/sketches/{sketch['id']}", json={
        "target_grid_x": 6,
        "target_grid_y": 4,
        "bin_layout": [
            {"id": "placement-1", "bin_id": bin_data["id"], "x": 1.5, "y": 2, "rotation": 90, "color": "#4ade80"}
        ],
    })

    assert resp.status_code == 200
    assert resp.json()["target_grid_x"] == 6
    placement = resp.json()["bin_layout"][0]
    assert placement["id"] == "placement-1" and placement["bin_id"] == bin_data["id"]
    assert (placement["x"], placement["y"], placement["rotation"]) == (1.5, 2, 90)
    assert placement["color"] == "#4ade80"
    stored = client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]
    assert stored["bin_layout"][0]["x"] == 1.5
    assert stored["bin_layout"][0]["id"] == placement["id"]
    assert (stored["bin_layout"][0]["y"], stored["bin_layout"][0]["rotation"]) == (2, 90)
    assert stored["bin_layout"][0]["color"] == "#4ade80"
    assert stored["name"] == "Top"


def test_project_holds_several_sketches(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()

    first = client.post(f"/api/bin-projects/{project['id']}/sketches", json={}).json()
    second = client.post(f"/api/bin-projects/{project['id']}/sketches", json={"target_grid_x": 8}).json()

    detail = client.get(f"/api/bin-projects/{project['id']}").json()
    summary = next(p for p in client.get("/api/bin-projects").json()["projects"] if p["id"] == project["id"])

    assert first["name"] == "Drawer plan 1"
    assert second["name"] == "Drawer plan 2"
    assert second["target_grid_x"] == 8
    assert [s["id"] for s in detail["sketches"]] == [first["id"], second["id"]]
    assert summary["sketch_count"] == 2

    delete_resp = client.delete(f"/api/bin-projects/{project['id']}/sketches/{first['id']}")
    remaining = client.get(f"/api/bin-projects/{project['id']}").json()["sketches"]

    assert delete_resp.status_code == 200
    assert [s["id"] for s in remaining] == [second["id"]]
    assert client.patch(
        f"/api/bin-projects/{project['id']}/sketches/{first['id']}", json={"name": "gone"}
    ).status_code == 404


def test_sketch_layout_rejects_unlinked_bins_and_duplicate_placement_ids(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()
    linked = client.post("/api/bins", json={"name": "Bin A", "project_id": project["id"]}).json()
    loose = client.post("/api/bins", json={"name": "Bin B"}).json()
    sketch = client.post(f"/api/bin-projects/{project['id']}/sketches", json={}).json()

    unlinked_resp = client.patch(f"/api/bin-projects/{project['id']}/sketches/{sketch['id']}", json={
        "bin_layout": [{"bin_id": loose["id"], "x": 0, "y": 0}],
    })
    duplicate_resp = client.patch(f"/api/bin-projects/{project['id']}/sketches/{sketch['id']}", json={
        "bin_layout": [
            {"id": "same", "bin_id": linked["id"], "x": 0, "y": 0},
            {"id": "same", "bin_id": linked["id"], "x": 1, "y": 0},
        ],
    })

    assert unlinked_resp.status_code == 400
    assert duplicate_resp.status_code == 400
    assert client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]["bin_layout"] == []


def test_sketch_layout_allows_the_same_bin_more_than_once(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()
    bin_data = client.post("/api/bins", json={"name": "Bin A", "project_id": project["id"]}).json()
    sketch = client.post(f"/api/bin-projects/{project['id']}/sketches", json={}).json()

    resp = client.patch(f"/api/bin-projects/{project['id']}/sketches/{sketch['id']}", json={
        "bin_layout": [
            {"bin_id": bin_data["id"], "x": 0, "y": 0},
            {"bin_id": bin_data["id"], "x": 2, "y": 0, "rotation": 180},
        ],
    })

    assert resp.status_code == 200
    layout = resp.json()["bin_layout"]
    assert [p["bin_id"] for p in layout] == [bin_data["id"], bin_data["id"]]
    assert layout[0]["id"] != layout[1]["id"]
    assert layout[1]["rotation"] == 180


def test_sketch_layout_drops_placements_when_bin_leaves_project(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()
    kept = client.post("/api/bins", json={"name": "Bin A", "project_id": project["id"]}).json()
    detached = client.post("/api/bins", json={"name": "Bin B", "project_id": project["id"]}).json()
    deleted = client.post("/api/bins", json={"name": "Bin C", "project_id": project["id"]}).json()
    sketch = client.post(f"/api/bin-projects/{project['id']}/sketches", json={}).json()

    client.patch(f"/api/bin-projects/{project['id']}/sketches/{sketch['id']}", json={
        "bin_layout": [
            {"bin_id": kept["id"], "x": 0, "y": 0},
            {"bin_id": kept["id"], "x": 1, "y": 0},
            {"bin_id": detached["id"], "x": 2, "y": 0},
            {"bin_id": deleted["id"], "x": 4, "y": 0},
        ],
    })
    client.delete(f"/api/bin-projects/{project['id']}/bins/{detached['id']}")
    client.delete(f"/api/bins/{deleted['id']}")

    layout = client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]["bin_layout"]

    assert [p["bin_id"] for p in layout] == [kept["id"], kept["id"]]


def test_repair_drops_stale_layout_placements(tmp_path):
    project_store = ProjectStore(tmp_path)
    tool_store = ToolStore(tmp_path)
    bin_store = BinStore(tmp_path)
    bin_store.set("bin-1", BinModel(id="bin-1", project_id="project-1"))
    project = BinProject(
        id="project-1",
        name="Top drawer",
        bin_ids=["bin-1"],
        sketches=[ProjectSketch(bin_layout=[
            ProjectBinPlacement(bin_id="bin-1", x=0, y=0),
            ProjectBinPlacement(bin_id="missing-bin", x=1, y=0),
        ])],
    )
    project_store.set(project.id, project)

    repaired = repair_project_links(project_store, project, tool_store, bin_store)

    assert [p.bin_id for p in repaired.sketches[0].bin_layout] == ["bin-1"]


def test_bin_summary_exposes_grid_and_height_for_sketching(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    client.post("/api/bins", json={
        "name": "Bin A",
        "bin_config": {"grid_x": 3, "grid_y": 1, "height_units": 6, "half_grid_base": True},
    })

    summary = client.get("/api/bins").json()["bins"][0]

    assert summary["grid_x"] == 3
    assert summary["grid_y"] == 1
    assert summary["height_units"] == 6
    assert summary["half_grid_base"] is True


def test_legacy_migration_id_is_stable_across_loads():
    record = {
        "id": "project-1",
        "name": "Top drawer",
        "target_grid_x": 6,
        "bin_layout": [{"id": "p1", "bin_id": "bin-1", "x": 1, "y": 0}],
    }

    first = BinProject.model_validate(record)
    second = BinProject.model_validate(record)

    assert first.sketches[0].id == second.sketches[0].id
    # a different project must not collide with it
    other = BinProject.model_validate({**record, "id": "project-2"})
    assert other.sketches[0].id != first.sketches[0].id


def test_rejected_sketch_update_leaves_nothing_behind(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()
    loose = client.post("/api/bins", json={"name": "Bin B"}).json()
    sketch = client.post(
        f"/api/bin-projects/{project['id']}/sketches",
        json={"name": "Top", "target_grid_x": 4, "target_grid_y": 4},
    ).json()

    resp = client.patch(f"/api/bin-projects/{project['id']}/sketches/{sketch['id']}", json={
        "name": "Renamed",
        "target_grid_x": 8,
        "bin_layout": [{"bin_id": loose["id"], "x": 0, "y": 0}],
    })

    assert resp.status_code == 400
    # an unrelated write flushes the whole store, so a partial change would persist
    client.patch(f"/api/bin-projects/{project['id']}", json={"notes": "unrelated"})
    routes._project_store_cache.clear()
    stored = client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]

    assert stored["name"] == "Top"
    assert stored["target_grid_x"] == 4
    assert stored["bin_layout"] == []


def _toolbox_workflow(tmp_path, monkeypatch, thickness=10):
    client = _api_client(tmp_path, monkeypatch)
    _seed_tool("tool-1")
    assert client.put("/api/tools/tool-1", json={"thickness_mm": thickness}).status_code == 200
    project = client.post("/api/bin-projects", json={"name": "Toolbox", "tool_ids": ["tool-1"]}).json()
    bins = [client.post("/api/bins", json={
        "project_id": project["id"], "tool_ids": ["tool-1"],
        "bin_config": {"grid_x": 1, "grid_y": 1, "height_units": 4, "magnets": False},
    }).json() for _ in range(2)]
    sketch = client.post(f"/api/bin-projects/{project['id']}/sketches", json={
        "name": "Measured toolbox", "container_width_mm": 100, "container_depth_mm": 84,
        "container_height_mm": 70, "safety_clearance_mm": 1,
    }).json()
    url = f"/api/bin-projects/{project['id']}/sketches/{sketch['id']}"
    layout = [{"id": "lower", "bin_id": bins[0]["id"], "x": 0, "y": 0},
              {"id": "upper", "bin_id": bins[1]["id"], "x": 0, "y": 0, "support_id": "lower"}]
    assert client.patch(url, json={"bin_layout": layout}).status_code == 200
    return client, project, bins, url, layout


def _printed_bin(client, bin_id, tmp_path):
    data = client.get(f"/api/bins/{bin_id}").json()
    _, tools, _ = routes.get_stores("default")
    scaler = PolygonScaler()
    polygons = []
    for placed in data["placed_tools"]:
        source = tools.get(placed["tool_id"])
        raw = ScaledPolygon(
            placed["id"], [(p["x"], p["y"]) for p in placed["points"]], placed["name"],
            [ScaledFingerHole.from_finger_hole(h) for h in PlacedTool.model_validate(placed).finger_holes],
            [[(p["x"], p["y"]) for p in ring] for ring in placed["interior_rings"]],
            depth_override=placed["depth_override"],
        )
        polygons.append(scaler.prepare_for_generation(
            raw, data["bin_config"]["cutout_clearance"], smoothed=source.smoothed, smooth_level=source.smooth_level,
        ))
    config = GenerateRequest.model_validate({
        **data["bin_config"], "text_labels": data["bin_config"]["text_labels"] + data["text_labels"],
    })
    path = tmp_path / f"printed-{bin_id}.stl"
    body, text = ManifoldSTLGenerator().generate_bin(polygons, config, str(path))
    return body + text if text else body, trimesh.load_mesh(path)


def test_tool_measurement_preserves_omission_clears_null_and_survives_reload(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _seed_tool("tool-1")
    assert client.get("/api/tools/tool-1").json()["thickness_mm"] is None
    assert client.put("/api/tools/tool-1", json={"thickness_mm": 12.5}).status_code == 200
    assert client.put("/api/tools/tool-1", json={"name": "Measured"}).status_code == 200
    assert client.get("/api/tools").json()["tools"][0]["thickness_mm"] == 12.5
    routes._store_cache.clear()
    assert client.get("/api/tools/tool-1").json()["thickness_mm"] == 12.5
    assert client.put("/api/tools/tool-1", json={"thickness_mm": None}).status_code == 200
    routes._store_cache.clear()
    assert client.get("/api/tools/tool-1").json()["thickness_mm"] is None
    for value in ("0", "-1", "NaN", "Infinity"):
        assert client.put("/api/tools/tool-1", content='{"thickness_mm":' + value + '}',
                          headers={"Content-Type": "application/json"}).status_code == 422
    assert client.get("/api/tools/tool-1").json()["thickness_mm"] is None


def test_toolbox_fit_persists_inputs_not_assessments_and_counts_floor_union(tmp_path, monkeypatch):
    client, project, bins, url, layout = _toolbox_workflow(tmp_path, monkeypatch)
    result = client.post(url + "/assessment", json={}).json()
    assert result["status"] == "verified"
    assert result["occupied_floor_units"] == 1
    assert sum(r["area_units"] for r in result["free_regions"]) == 3
    assert result["residual_width_mm"] == 16
    assert result["unhoused_tool_ids"] == []
    assert result["placements"][1]["z_mm"] == 28
    assert result["stacks"][0]["headroom_mm"] == pytest.approx(8.6)
    routes._project_store_cache.clear()
    routes._store_cache.clear()
    saved = client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]
    assert saved["container_height_mm"] == 70
    assert saved["bin_layout"][1]["support_id"] == "lower"
    assert "status" not in saved
    assert "z_mm" not in saved["bin_layout"][1]
    assert client.post(url + "/assessment", json={}).json()["status"] == "verified"
    assert client.patch(url, json={"container_width_mm": 41}).status_code == 200
    invalid = client.post(url + "/assessment", json={}).json()
    assert any(v["code"] == "boundary" for v in invalid["violations"])
    assert len(client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]["bin_layout"]) == 2
    assert client.patch(url, json={"container_width_mm": None, "container_depth_mm": None, "container_height_mm": None}).status_code == 200
    assert client.post(url + "/assessment", json={}).json()["status"] == "uncertain"
    assert client.post(url + "/assessment", json={}).json()["placements"][1]["z_mm"] == 28


@pytest.mark.parametrize("offset,status", [(-0.01, "invalid"), (0, "verified"), (0.01, "verified")])
def test_toolbox_ceiling_threshold_uses_generated_external_height(tmp_path, monkeypatch, offset, status):
    client, _, bins, url, _ = _toolbox_workflow(tmp_path, monkeypatch)
    for bin_data in bins:
        config = {**bin_data["bin_config"], "height_units": 5}
        assert client.put(f"/api/bins/{bin_data['id']}", json={"bin_config": config}).status_code == 200
    # Two nominal 5u bodies sum to 70mm but their assembled exterior reaches 74.4mm.
    assert client.post(url + "/assessment", json={}).json()["status"] == "invalid"
    result = client.post(url + "/assessment", json={"container_height_mm": 75.4 + offset}).json()
    assert result["status"] == status
    assert result["stacks"][0]["headroom_mm"] == pytest.approx(offset)


@pytest.mark.parametrize("offset,status", [(-0.01, "verified"), (0, "verified"), (0.01, "invalid")])
def test_toolbox_upper_bin_tool_clearance_threshold(tmp_path, monkeypatch, offset, status):
    client, _, _, url, _ = _toolbox_workflow(tmp_path, monkeypatch, thickness=19 + offset)
    # Effective default pocket depth is 20mm; a configured 1mm gap leaves 19mm.
    result = client.post(url + "/assessment", json={}).json()
    assert result["status"] == status
    assert result["placements"][0]["clearance_mm"] == pytest.approx(-offset)


def test_missing_measurements_do_not_hide_known_ceiling_failure_or_unhoused_tools(tmp_path, monkeypatch):
    client, project, bins, url, _ = _toolbox_workflow(tmp_path, monkeypatch, thickness=100)
    _seed_tool("unknown")
    client.post(f"/api/bin-projects/{project['id']}/tools", json={"tool_ids": ["unknown"]})
    extra = client.post("/api/bins", json={"project_id": project["id"], "tool_ids": ["unknown"]}).json()
    result = client.post(url + "/assessment", json={}).json()
    assert result["status"] == "invalid"
    assert result["unhoused_tool_ids"] == ["unknown"]  # linked elsewhere is not housed
    assert any(v["code"] == "ceiling" for v in result["violations"])
    placed = bins[1]["placed_tools"] + extra["placed_tools"]
    assert client.put(f"/api/bins/{bins[1]['id']}", json={"placed_tools": placed}).status_code == 200
    result = client.post(url + "/assessment", json={}).json()
    assert result["status"] == "invalid"
    assert result["missing_tool_ids"] == ["unknown"]
    assert any(v["code"] == "ceiling" for v in result["violations"])
    assert client.put("/api/tools/tool-1", json={"thickness_mm": 5}).status_code == 200
    assert client.post(url + "/assessment", json={}).json()["status"] == "uncertain"


def test_invalid_support_graph_is_rejected_without_replacing_saved_work(tmp_path, monkeypatch):
    client, project, bins, url, layout = _toolbox_workflow(tmp_path, monkeypatch)
    other = client.post(f"/api/bin-projects/{project['id']}/sketches", json={}).json()
    for bad in (
        [{**layout[0], "support_id": "upper"}, layout[1]],
        [layout[0], {**layout[1], "support_id": "absent"}],
        [layout[0], layout[1], {"id": "copy", "bin_id": bins[1]["id"], "support_id": "lower"}],
    ):
        assert client.patch(url, json={"bin_layout": bad}).status_code == 400
    assert client.patch(url.rsplit("/", 1)[0] + "/" + other["id"], json={"bin_layout": [layout[1]]}).status_code == 400
    saved = client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]["bin_layout"]
    assert [p["id"] for p in saved] == ["lower", "upper"]
    assert saved[1]["support_id"] == "lower"


def test_stack_actions_move_rotate_reorder_remove_and_keep_library_bins(tmp_path, monkeypatch):
    client, project, bins, url, layout = _toolbox_workflow(tmp_path, monkeypatch)
    # A root-only API edit carries its unchanged descendants.
    moved = client.patch(url, json={"bin_layout": [{**layout[0], "x": 1, "rotation": 90}, layout[1]]}).json()
    assert [(p["x"], p["rotation"]) for p in moved["bin_layout"]] == [(1, 90), (1, 90)]
    reordered = client.post(url + "/placements/lower/stack-action", json={"action": "move_up"}).json()
    assert next(p for p in reordered["bin_layout"] if p["id"] == "upper")["support_id"] is None
    assert next(p for p in reordered["bin_layout"] if p["id"] == "lower")["support_id"] == "upper"
    removed = client.post(url + "/placements/upper/stack-action", json={"action": "remove_reconnect"}).json()
    assert [p["id"] for p in removed["bin_layout"]] == ["lower"]
    assert removed["bin_layout"][0]["support_id"] is None
    assert all(client.get(f"/api/bins/{b['id']}").status_code == 200 for b in bins)
    copy_layout = removed["bin_layout"] + [{"id": "copy", "bin_id": bins[0]["id"], "x": 0, "y": 0}]
    client.patch(url, json={"bin_layout": copy_layout})
    stacked = client.post(url + "/placements/copy/stack-action", json={"action": "stack_on", "support_id": "lower"}).json()
    assert next(p for p in stacked["bin_layout"] if p["id"] == "copy")["support_id"] == "lower"
    deleted = client.post(url + "/placements/lower/stack-action", json={"action": "remove_substack"}).json()
    assert deleted["bin_layout"] == []
    assert client.get(f"/api/bin-projects/{project['id']}").json()["bin_ids"] == [b["id"] for b in bins]


@pytest.mark.parametrize("config_change", [
    {"stacking_lip": False},
    {"partial_bins": True, "grid_x": 2, "partial_bins_values": [True, False]},
])
def test_unsupported_interfaces_cannot_be_verified_or_applied(tmp_path, monkeypatch, config_change):
    client, _, bins, url, _ = _toolbox_workflow(tmp_path, monkeypatch)
    client.put(f"/api/bins/{bins[0]['id']}", json={"bin_config": {**bins[0]["bin_config"], **config_change}})
    result = client.post(url + "/assessment", json={}).json()
    assert result["status"] == "invalid"
    assert any(v["code"] == "support" for v in result["violations"])
    # Removing an affected sub-stack remains possible even with a broken interface.
    assert client.post(url + "/placements/upper/stack-action", json={"action": "remove_substack"}).status_code == 200
    independent = [{"id": "new", "bin_id": bins[1]["id"], "x": 1, "y": 0}, {"id": "lower", "bin_id": bins[0]["id"]}]
    assert client.patch(url, json={"bin_layout": independent}).status_code == 200
    assert client.post(url + "/placements/new/stack-action", json={"action": "stack_on", "support_id": "lower"}).status_code == 400


def test_rotated_matching_rectangles_and_detaching_support_repairs_descendants(tmp_path, monkeypatch):
    client, project, bins, url, layout = _toolbox_workflow(tmp_path, monkeypatch)
    client.put(f"/api/bins/{bins[0]['id']}", json={"bin_config": {**bins[0]["bin_config"], "grid_x": 2, "grid_y": 1}})
    client.put(f"/api/bins/{bins[1]['id']}", json={"bin_config": {**bins[1]["bin_config"], "grid_x": 1, "grid_y": 2}})
    client.patch(url, json={"bin_layout": [layout[0], {**layout[1], "rotation": 90}]})
    assert client.post(url + "/assessment", json={}).json()["status"] == "verified"
    client.delete(f"/api/bin-projects/{project['id']}/bins/{bins[0]['id']}")
    assert client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]["bin_layout"] == []
    assert client.get(f"/api/bins/{bins[1]['id']}").status_code == 200


def test_height_proposals_are_inspectable_explicit_and_reassess_shared_plans(tmp_path, monkeypatch):
    client, _, bins, url, _ = _toolbox_workflow(tmp_path, monkeypatch, thickness=30)
    target = bins[0]
    override = [{**p, "depth_override": 8} for p in target["placed_tools"]]
    client.put(f"/api/bins/{target['id']}", json={"placed_tools": override})
    before = client.get(f"/api/bins/{target['id']}").json()
    proposals = client.get(f"/api/bins/{target['id']}/height-planning?safety_clearance_mm=1").json()
    assert client.get(f"/api/bins/{target['id']}").json()["bin_config"] == before["bin_config"]
    deeper, rim = proposals["alternatives"]
    assert deeper["complete"] and rim["complete"]
    assert deeper["bin_config"]["height_units"] == 6
    assert deeper["override_changes"][0]["from_mm"] == 8
    assert deeper["override_changes"][0]["to_mm"] == 31
    assert rim["placed_tools"][0]["depth_override"] == 8
    assert rim["bin_config"]["height_units"] == 4
    assert rim["bin_config"]["rim_units"] == 4
    assert client.put(f"/api/bins/{target['id']}", json={
        "bin_config": deeper["bin_config"], "placed_tools": deeper["placed_tools"],
    }).status_code == 200
    assessment = client.post(url + "/assessment", json={}).json()
    assert assessment["placements"][0]["clearance_mm"] >= 0
    assert assessment["placements"][1]["z_mm"] == 42
    assert any(v["code"] == "ceiling" for v in assessment["violations"])
    client.put("/api/tools/tool-1", json={"thickness_mm": None})
    incomplete = client.get(f"/api/bins/{target['id']}/height-planning").json()
    assert all(not p["complete"] for p in incomplete["alternatives"])
    client.put("/api/tools/tool-1", json={"thickness_mm": 1000})
    impossible = client.get(f"/api/bins/{target['id']}/height-planning").json()
    assert all(p["bin_config"] is None and p["reason"] for p in impossible["alternatives"])


@pytest.mark.parametrize("field", ["container_width_mm", "container_depth_mm", "container_height_mm", "safety_clearance_mm"])
def test_invalid_container_measurement_keeps_saved_layout(tmp_path, monkeypatch, field):
    client, project, _, url, _ = _toolbox_workflow(tmp_path, monkeypatch)
    assert client.patch(url, json={field: -1}).status_code == 422
    assert client.patch(url, content='{\"' + field + '\":NaN}', headers={"Content-Type": "application/json"}).status_code == 422
    assert len(client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]["bin_layout"]) == 2


def test_wide_pocket_height_minimum_accounts_for_base_descending_into_pocket(tmp_path, monkeypatch):
    client, _, bins, url, _ = _toolbox_workflow(tmp_path, monkeypatch, thickness=12)
    assert client.put("/api/tools/tool-1", json={
        "points": [{"x": x, "y": y} for x, y in [(-18, -18), (18, -18), (18, 18), (-18, 18)]],
        "smoothed": False,
    }).status_code == 200
    for data in bins:
        assert client.put(f"/api/bins/{data['id']}", json={"placed_tools": [
            {**placed, "rotation": 0, "points": [{"x": x, "y": y} for x, y in [(3, 3), (39, 3), (39, 39), (3, 39)]]}
            for placed in data["placed_tools"]
        ]}).status_code == 200
    current = client.post(url + "/assessment", json={}).json()
    lower, _ = _printed_bin(client, bins[0]["id"], tmp_path)
    upper, upper_mesh = _printed_bin(client, bins[1]["id"], tmp_path)
    z = current["placements"][1]["z_mm"]
    assert (lower ^ upper.translate((0, 0, z))).volume() < 1e-4
    assert (lower ^ upper.translate((0, 0, z-.02))).volume() > 1e-4
    target = bins[0]["id"]
    proposal = client.get(f"/api/bins/{target}/height-planning?safety_clearance_mm=1").json()["alternatives"][0]
    assert proposal["bin_config"]["height_units"] == 3
    assert client.put(f"/api/bins/{target}", json={
        "bin_config": proposal["bin_config"], "placed_tools": proposal["placed_tools"],
    }).status_code == 200
    fitted = client.post(url + "/assessment", json={}).json()
    assert fitted["status"] == "verified"
    lower, lower_mesh = _printed_bin(client, target, tmp_path)
    z = fitted["placements"][1]["z_mm"]
    assert (lower ^ upper.translate((0, 0, z))).volume() < 1e-4
    assert (lower ^ upper.translate((0, 0, z-.02))).volume() > 1e-4
    clearance = upper_mesh.bounds[0, 2] + z - _surface_z(lower_mesh) - 12 - 1
    assert clearance == pytest.approx(0, abs=1e-5)
    assert fitted["placements"][0]["clearance_mm"] == pytest.approx(clearance, abs=1e-5)
    shallower = {**proposal["bin_config"], "cutout_depth": proposal["bin_config"]["cutout_depth"]-.01}
    probe = client.post(f"/api/bins/{target}/height-planning?safety_clearance_mm=1", json={
        "bin_config": shallower, "placed_tools": proposal["placed_tools"],
    }).json()["assessment"]
    assert any(v["code"] == "tool_clearance" and v["clearance_mm"] < 0 for v in probe["violations"])


@pytest.mark.parametrize("offset", [-.01, 0, .01])
def test_known_insert_ceiling_collision_with_missing_tool_thickness(tmp_path, monkeypatch, offset):
    client, _, bins, url, layout = _toolbox_workflow(tmp_path, monkeypatch, thickness=None)
    target = bins[0]
    # A shallow pocket makes a supported insert extend above the printed bin.
    config = {**target["bin_config"], "height_units": 1, "insert_enabled": True, "insert_height": 5}
    placed = [{**p, "depth_override": 2} for p in target["placed_tools"]]
    assert client.put(f"/api/bins/{target['id']}", json={"bin_config": config, "placed_tools": placed}).status_code == 200
    _, mesh = _printed_bin(client, target["id"], tmp_path)
    insert_path = tmp_path / "insert.stl"
    raw = ScaledPolygon("insert", [(p["x"], p["y"]) for p in placed[0]["points"]], "Insert")
    assert ManifoldSTLGenerator().generate_insert([raw], GenerateRequest.model_validate(config), str(insert_path), -21, -21)
    insert = trimesh.load_mesh(insert_path)
    insert_top = _surface_z(mesh) + insert.bounds[1, 2]-insert.bounds[0, 2]
    assert insert_top > mesh.bounds[1, 2]
    assert client.patch(url, json={"container_height_mm": insert_top+1+offset, "bin_layout": [layout[0]]}).status_code == 200
    assessment = client.post(url + "/assessment", json={}).json()
    assert assessment["status"] == ("invalid" if offset < 0 else "uncertain")
    assert assessment["missing_tool_ids"] == ["tool-1"]
    assert any(v["code"] == "insert_ceiling" for v in assessment["violations"]) == (offset < 0)


@pytest.mark.parametrize("offset", [-.01, 0, .01])
def test_known_insert_upper_bin_collision_with_missing_tool_thickness(tmp_path, monkeypatch, offset):
    client, _, bins, url, _ = _toolbox_workflow(tmp_path, monkeypatch, thickness=None)
    target = bins[0]
    # The clamped 2u pocket permits crossing the base boundary with legal inserts.
    config = {**target["bin_config"], "height_units": 2, "insert_enabled": True, "insert_height": 6.25+offset}
    placed = [{**p, "depth_override": 2} for p in target["placed_tools"]]
    assert client.put(f"/api/bins/{target['id']}", json={"bin_config": config, "placed_tools": placed}).status_code == 200
    lower, lower_mesh = _printed_bin(client, target["id"], tmp_path)
    upper, upper_mesh = _printed_bin(client, bins[1]["id"], tmp_path)
    insert_path = tmp_path / "insert.stl"
    raw = ScaledPolygon("insert", [(p["x"], p["y"]) for p in placed[0]["points"]], "Insert")
    assert ManifoldSTLGenerator().generate_insert([raw], GenerateRequest.model_validate(config), str(insert_path), -21, -21)
    insert = trimesh.load_mesh(insert_path)
    insert_height = insert.bounds[1, 2] - insert.bounds[0, 2]
    assessment = client.post(url + "/assessment", json={}).json()
    z = assessment["placements"][1]["z_mm"]
    assert (lower ^ upper.translate((0, 0, z))).volume() < 1e-4
    assert (lower ^ upper.translate((0, 0, z-.02))).volume() > 1e-4
    clearance = z + upper_mesh.bounds[0, 2] - _surface_z(lower_mesh) - insert_height - 1
    assert assessment["placements"][0]["envelopes"][0]["resting_z_mm"] == pytest.approx(_surface_z(lower_mesh) + insert_height)
    assert clearance == pytest.approx(-offset, abs=1e-5)
    assert assessment["status"] == ("invalid" if clearance < -1e-5 else "uncertain")
    assert assessment["missing_tool_ids"] == ["tool-1"]
    assert any(v["code"] == "insert_clearance" for v in assessment["violations"]) == (offset > 0)


def test_insert_override_minimum_uses_single_insert_allowance(tmp_path, monkeypatch):
    client, _, bins, url, _ = _toolbox_workflow(tmp_path, monkeypatch, thickness=5)
    target = bins[0]
    placed = [{**p, "depth_override": 2} for p in target["placed_tools"]]
    config = {**target["bin_config"], "insert_enabled": True, "insert_height": 4}
    assert client.put(f"/api/bins/{target['id']}", json={"bin_config": config, "placed_tools": placed}).status_code == 200
    deeper, rim = client.get(f"/api/bins/{target['id']}/height-planning?safety_clearance_mm=1").json()["alternatives"]
    assert deeper["bin_config"]["height_units"] == 3
    assert deeper["placed_tools"][0]["depth_override"] == 6
    assert rim["bin_config"]["height_units"] == 4 and rim["bin_config"]["rim_units"] == 1
    assert rim["placed_tools"][0]["depth_override"] == 2
    assert client.put(f"/api/bins/{target['id']}", json={
        "bin_config": deeper["bin_config"], "placed_tools": deeper["placed_tools"],
    }).status_code == 200
    fitted = client.post(url + "/assessment", json={}).json()
    assert fitted["status"] == "verified"
    _, mesh = _printed_bin(client, target["id"], tmp_path)
    envelope = fitted["placements"][0]["envelopes"][0]
    assert envelope["resting_z_mm"] == pytest.approx(_surface_z(mesh) + 4)
    assert envelope["top_mm"] == pytest.approx(_surface_z(mesh) + 4 + 5)
    assert envelope["clearance_mm"] == pytest.approx(0, abs=1e-6)


def test_embossed_label_prevents_intact_mating_and_api_rejects_attachment(tmp_path, monkeypatch):
    client, project, bins, url, layout = _toolbox_workflow(tmp_path, monkeypatch)
    lower_id, upper_id = [data["id"] for data in bins]
    config = {**bins[0]["bin_config"], "text_labels": [
        TextLabel(id="label", text="M", x=6, y=21, font_size=5, depth=1, emboss=True).model_dump(),
    ]}
    assert client.put(f"/api/bins/{lower_id}", json={"bin_config": config}).status_code == 200
    lower, _ = _printed_bin(client, lower_id, tmp_path)
    upper, _ = _printed_bin(client, upper_id, tmp_path)
    assert (lower ^ upper.translate((0, 0, 28))).volume() > 1e-4
    assessment = client.post(url + "/assessment", json={}).json()
    assert assessment["status"] == "invalid"
    assert assessment["placements"][1]["support_compatible"] is False
    z = assessment["placements"][1]["z_mm"]
    assert (lower ^ upper.translate((0, 0, z))).volume() < 1e-4
    assert (lower ^ upper.translate((0, 0, z-.02))).volume() > 1e-4
    floors = [layout[0], {**layout[1], "x": 1, "support_id": None}]
    assert client.patch(url, json={"bin_layout": floors}).status_code == 200
    response = client.post(url + "/placements/upper/stack-action", json={"action": "stack_on", "support_id": "lower"})
    assert response.status_code == 400
    saved = client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]["bin_layout"]
    assert saved[1]["support_id"] is None and saved[1]["x"] == 1
    planning = client.get(f"/api/bins/{lower_id}/height-planning?safety_clearance_mm=1").json()
    assert planning["alternatives"][0]["bin_config"] is None
    assert planning["alternatives"][1]["bin_config"]["rim_units"] == 1


def test_finger_hole_removing_printed_lip_is_not_verified_or_attachable(tmp_path, monkeypatch):
    client, project, bins, url, layout = _toolbox_workflow(tmp_path, monkeypatch)
    for data in bins:
        placed = [{**p, "rotation": 0, "points": [{"x": x, "y": y} for x, y in [(16, 16), (26, 16), (26, 26)]]} for p in data["placed_tools"]]
        assert client.put(f"/api/bins/{data['id']}", json={"placed_tools": placed}).status_code == 200
    assert client.put("/api/tools/tool-1", json={"finger_holes": [
        {"id": "breach", "x": 24, "y": 5, "radius": 6, "shape": "circle"},
    ]}).status_code == 200
    lower, _ = _printed_bin(client, bins[0]["id"], tmp_path)
    reference, _ = ManifoldSTLGenerator().generate_bin([], GenerateRequest.model_validate(bins[0]["bin_config"]), None)
    assert (reference.trim_by_plane((0, 0, 1), 28.02) - lower).volume() > .01
    assessment = client.post(url + "/assessment", json={}).json()
    assert assessment["status"] == "invalid"
    assert assessment["placements"][1]["support_compatible"] is False
    assert any(v["code"] == "support" for v in assessment["violations"])
    floors = [layout[0], {**layout[1], "x": 1, "support_id": None}]
    assert client.patch(url, json={"bin_layout": floors}).status_code == 200
    rejected = client.post(url + "/placements/upper/stack-action", json={"action": "stack_on", "support_id": "lower"})
    assert rejected.status_code == 400
    saved = client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]["bin_layout"]
    assert saved[1]["support_id"] is None and saved[1]["x"] == 1


def test_smoothed_tip_seats_at_default_clearance():
    """The simplifier drops a convex feature shallower than its tolerance, so the
    smoothed outline alone misses it. The printed pocket must still cover the
    traced outline, or the tool rests on the material left at the tip instead of
    on its pocket floor. Both rings are centred in a 3x3 bin."""
    top = [(6.0 * i, 0.0) for i in range(11)]
    top[5] = (30.0, -1.4)
    top[7] = (42.0, 1.4)
    points = [(x + 33.0, y + 43.7) for x, y in top + [(60.0, 40.0), (0.0, 40.0)]]
    tool = Tool(
        id="tip", name="Sharp tip", thickness_mm=6, smoothed=True, smooth_level=1.0,
        points=[{"x": x, "y": y} for x, y in points],
    )
    placed = PlacedTool(id="tip-1", tool_id=tool.id, name=tool.name, points=tool.points)
    bin_data = BinModel(id="bin", bin_config=BinConfig(
        grid_x=3, grid_y=3, height_units=4, cutout_clearance=1.0, cutout_depth=12, magnets=False,
    ), placed_tools=[placed])

    assessment = assess_bin(bin_data, {tool.id: tool})

    assert assessment["seating_errors"] == {}, assessment["seating_errors"]
    assert assessment["envelopes"][0]["seating_verified"]


@pytest.mark.parametrize("kind", ["undersized", "wall", "outside"])
def test_unseated_tool_has_no_claimed_floor_or_optimistic_lid_clearance(tmp_path, monkeypatch, kind):
    client, _, bins, url, layout = _toolbox_workflow(tmp_path, monkeypatch)
    target = bins[0]
    if kind == "undersized":
        assert client.put("/api/tools/tool-1", json={
            "points": [{"x": x, "y": y} for x, y in [(-19, -19), (19, -19), (19, 19), (-19, 19)]],
            "smoothed": False,
        }).status_code == 200
        points = [(2, 2), (40, 2), (40, 40), (2, 40)]
    else:
        shift = 20 if kind == "wall" else 40
        points = [(16+shift, 16), (26+shift, 16), (26+shift, 26)]
    placed = [{**p, "rotation": 0, "points": [{"x": x, "y": y} for x, y in points]} for p in target["placed_tools"]]
    assert client.put(f"/api/bins/{target['id']}", json={"placed_tools": placed}).status_code == 200
    assert client.patch(url, json={"container_height_mm": 40, "bin_layout": [layout[0]]}).status_code == 200
    printed, mesh = _printed_bin(client, target["id"], tmp_path)
    footprint = mf.CrossSection([[(x-21, -(y-21)) for x, y in points]], mf.FillRule.EvenOdd)
    if kind == "outside":
        assert min(x-21 for x, _ in points) > mesh.bounds[1, 0]
    else:
        floor = _surface_z(mesh, *( (16, 4) if kind == "wall" else (0, 0) ))
        assert (footprint ^ printed.slice(floor+.01)).area() > .01
    assessment = client.post(url + "/assessment", json={}).json()
    assert assessment["status"] == "invalid"
    assert any(v["code"] == "tool_seating" and v["tool_id"] == "tool-1" for v in assessment["violations"])
    envelope = assessment["placements"][0]["envelopes"][0]
    assert envelope["seating_verified"] is False
    assert envelope["resting_z_mm"] is None and envelope["top_mm"] is None and envelope["clearance_mm"] is None
    planning = client.get(f"/api/bins/{target['id']}/height-planning?safety_clearance_mm=1").json()
    assert all(p["bin_config"] is None for p in planning["alternatives"])


@pytest.mark.parametrize("half_grid", [False, True])
@pytest.mark.parametrize("offset,status", [(-.01, "invalid"), (0, "verified"), (.01, "verified")])
def test_raised_rotated_stack_ceiling_boundary_matches_printed_contact(tmp_path, monkeypatch, half_grid, offset, status):
    client, _, bins, url, layout = _toolbox_workflow(tmp_path, monkeypatch)
    for index, data in enumerate(bins):
        config = {**data["bin_config"], "rim_units": 1, "half_grid_base": half_grid,
                  "grid_x": 2 if index == 0 else 1, "grid_y": 1 if index == 0 else 2}
        assert client.put(f"/api/bins/{data['id']}", json={"bin_config": config}).status_code == 200
    assert client.patch(url, json={"bin_layout": [layout[0], {**layout[1], "rotation": 90}]}).status_code == 200
    lower, _ = _printed_bin(client, bins[0]["id"], tmp_path)
    upper, upper_mesh = _printed_bin(client, bins[1]["id"], tmp_path)
    upper = upper.rotate((0, 0, -90))
    initial = client.post(url + "/assessment", json={}).json()
    z = initial["placements"][1]["z_mm"]
    assert (lower ^ upper.translate((0, 0, z))).volume() < 1e-4
    assert (lower ^ upper.translate((0, 0, z-.02))).volume() > 1e-4
    ceiling = z + upper_mesh.bounds[1, 2] + 1 + offset
    assert client.patch(url, json={"container_height_mm": ceiling}).status_code == 200
    final = client.post(url + "/assessment", json={}).json()
    assert final["status"] == status
    assert final["stacks"][0]["headroom_mm"] == pytest.approx(offset, abs=1e-5)


def test_photo_boundary_drives_containment_free_space_and_clearance(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()
    bin_data = client.post("/api/bins", json={
        "name": "Bin A",
        "project_id": project["id"],
        "bin_config": {"grid_x": 1, "grid_y": 1, "height_units": 4, "magnets": False},
    }).json()
    sketch = client.post(f"/api/bin-projects/{project['id']}/sketches", json={
        "name": "Photo plan",
        "container_width_mm": 84,
        "container_depth_mm": 84,
        "container_height_mm": 70,
    }).json()
    url = f"/api/bin-projects/{project['id']}/sketches/{sketch['id']}"

    # the boundary reaches past the grid but excludes the bottom-right quadrant
    outline = {
        "points": [
            {"x": -5, "y": -5}, {"x": 89, "y": -5}, {"x": 89, "y": 50},
            {"x": 50, "y": 50}, {"x": 50, "y": 89}, {"x": -5, "y": 89},
        ],
        "interior_rings": [],
    }
    inside = [{"id": "inside", "bin_id": bin_data["id"], "x": 0, "y": 0}]
    assert client.patch(url, json={"outline": outline, "bin_layout": inside}).status_code == 200

    result = client.post(url + "/assessment", json={}).json()
    assert result["status"] == "verified", result
    assert result["floor_area_units"] == pytest.approx(7315 / (42 * 42), rel=1e-4)
    # 21mm half-cells: rows y in [0,21) and [21,42) are 4 cells wide, rows
    # [42,63) and [63,84) only 2 (the missing quadrant), so 12 cells = 3.0 units
    assert result["usable_area_units"] == pytest.approx(3.0)
    assert not any(cell["x"] >= 1 and cell["y"] >= 1 for cell in result["free_cells"])

    # the missing quadrant is not floor even though the rectangle is wide enough
    outside = [{"id": "outside", "bin_id": bin_data["id"], "x": 1, "y": 1}]
    outside_result = client.post(url + "/assessment", json={"bin_layout": outside}).json()
    assert any(v["code"] == "boundary" for v in outside_result["violations"])

    # a footprint nearer the boundary than the fit clearance is not covered
    clearance_result = client.post(url + "/assessment", json={"fit_clearance_mm": 10}).json()
    assert any(v["code"] == "boundary" for v in clearance_result["violations"])

    # clearing the boundary restores the rectangular rule
    cleared = client.patch(url, json={"outline": None, "fit_clearance_mm": 0}).json()
    assert cleared["outline"] is None
    rectangular = client.post(url + "/assessment", json={"bin_layout": outside}).json()
    assert not any(v["code"] == "boundary" for v in rectangular["violations"])


@pytest.mark.parametrize("rotation,origin,local_floor,position", [
    (0, (0, 0), [(0, 0), (84, 0), (84, 84), (0, 84)], (0, 0)),
    (30, (63, 42), [(-42, -21), (42, -21), (42, 63), (-42, 63)], (-1, 0)),
])
def test_photo_floor_capacity_and_placements_ignore_the_legacy_rectangle(tmp_path, monkeypatch, rotation, origin, local_floor, position):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Floor authority"}).json()
    bin_data = client.post("/api/bins", json={
        "name": "Wide bin", "project_id": project["id"],
        "bin_config": {"grid_x": 2, "grid_y": 1, "height_units": 4, "magnets": False},
    }).json()
    angle = math.radians(rotation)
    points = [{"x": origin[0] + x * math.cos(angle) - y * math.sin(angle),
               "y": origin[1] + x * math.sin(angle) + y * math.cos(angle)} for x, y in local_floor]
    sketch = client.post(f"/api/bin-projects/{project['id']}/sketches", json={
        "target_grid_x": 1, "target_grid_y": 1,
        "outline": {"points": points, "interior_rings": []},
        "grid_alignment": {"origin_x_mm": origin[0], "origin_y_mm": origin[1], "rotation_deg": rotation},
        "container_height_mm": 70,
    }).json()
    url = f"/api/bin-projects/{project['id']}/sketches/{sketch['id']}"
    accepted = client.patch(url, json={"bin_layout": [
        {"id": "wide", "bin_id": bin_data["id"], "x": position[0], "y": position[1]},
    ]})
    assert accepted.status_code == 200
    routes._project_store_cache.clear()
    assert client.get(f"/api/bin-projects/{project['id']}").json()["sketches"][0]["bin_layout"][0]["x"] == position[0]
    result = client.post(url + "/assessment", json={}).json()
    assert not any(v["code"] == "boundary" for v in result["violations"])
    assert result["usable_area_units"] == pytest.approx(4)
    assert result["occupied_floor_units"] == pytest.approx(2)
    assert len(result["free_cells"]) == 8
    assert result["floor_area_units"] == pytest.approx(4)
    if rotation:
        assert min(cell["x"] for cell in result["free_cells"]) == -1
        assert min(cell["y"] for cell in result["free_cells"]) == -.5
    rectangular = client.post(url + "/assessment", json={"outline": None}).json()
    assert any(v["code"] == "boundary" for v in rectangular["violations"])
