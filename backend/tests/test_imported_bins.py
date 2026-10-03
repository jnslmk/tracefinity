"""Importing user STLs as read-only planning bins.

These tests cover the upload contract end to end: bounded parsing, dimension
detection, read-only enforcement, project linking, retained assets, and the
deliberately uncertain assessment an imported model produces.
"""

import os
import struct
import time as _time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.api.routes as routes
from app.config import ensure_user_dirs, settings
from app.main import app
from app.models.schemas import (
    BinConfig,
    BinModel,
    BinProject,
    ImportedBinModel,
    ProjectBinPlacement,
    ProjectSketch,
)
from app.services.imported_bins import (
    StlImportError,
    detect_footprint,
    detect_height,
    process_import,
)
from app.services.output_retention import sweep_expired_outputs
from app.services.toolbox_planning import assess_plan


def _binary_stl(triangles) -> bytes:
    out = bytearray(b"\x00" * 80 + struct.pack("<I", len(triangles)))
    for triangle in triangles:
        out += struct.pack("<3f", 0.0, 0.0, 0.0)
        for vertex in triangle:
            out += struct.pack("<3f", *vertex)
        out += struct.pack("<H", 0)
    return bytes(out)


def _ascii_stl(triangles) -> bytes:
    lines = ["solid test"]
    for triangle in triangles:
        lines.append("  facet normal 0 0 0")
        lines.append("    outer loop")
        for vertex in triangle:
            lines.append(f"      vertex {vertex[0]} {vertex[1]} {vertex[2]}")
        lines.append("    endloop")
        lines.append("  endfacet")
    lines.append("endsolid test")
    return "\n".join(lines).encode("ascii")


def _box(width: float, depth: float, height: float, z0: float = 0.0, cx: float = 0.0, cy: float = 0.0):
    x0, x1 = cx - width / 2, cx + width / 2
    y0, y1 = cy - depth / 2, cy + depth / 2
    z0, z1 = z0, z0 + height
    corners = [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]
    faces = [
        (0, 2, 1), (0, 3, 2),  # bottom
        (4, 5, 6), (4, 6, 7),  # top
        (0, 1, 5), (0, 5, 4),
        (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6),
        (3, 0, 4), (3, 4, 7),
    ]
    return [tuple(corners[i] for i in face) for face in faces]


def _api_client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_path", tmp_path)
    monkeypatch.setattr(routes.settings, "storage_path", tmp_path)
    routes._store_cache.clear()
    routes._project_store_cache.clear()
    ensure_user_dirs(tmp_path / "default")
    return TestClient(app)


def _upload(client, data: bytes, name: str | None = None, project_id: str | None = None):
    form = {}
    if name is not None:
        form["name"] = name
    if project_id is not None:
        form["project_id"] = project_id
    return client.post(
        "/api/bins/import",
        files={"file": ("model.stl", data, "application/octet-stream")},
        data=form,
    )


# --- pure parsing/detection ---

def test_detects_full_and_half_grid_footprints():
    assert detect_footprint(41.5) == (1.0, True)
    assert detect_footprint(83.5) == (2.0, True)
    assert detect_footprint(62.5) == (1.5, True)
    # nonstandard width rounds up to a conservative footprint and warns
    units, standard = detect_footprint(50.0)
    assert units == 1.5 and standard is False
    assert units * 42 - 0.5 >= 50.0


def test_detects_body_height_and_stacking_lip():
    assert detect_height(28.0) == (4, False, True)
    assert detect_height(32.4) == (4, True, True)  # 4 units + 4.4mm lip
    units, lip, standard = detect_height(50.0)
    assert standard is False
    assert units * 7 + (4.4 if lip else 0) >= 50.0  # conservative, never shorter


def test_process_import_normalizes_and_measures():
    model = process_import(_binary_stl(_box(83.5, 41.5, 28.0, z0=5.0, cx=12.0, cy=-7.0)))

    assert (round(model.width_mm, 3), round(model.depth_mm, 3), round(model.height_mm, 3)) == (83.5, 41.5, 28.0)
    assert (model.grid_x, model.grid_y, model.height_units, model.stacking_lip) == (2.0, 1.0, 4, False)
    assert model.warnings == []
    # stored mesh is centered in X/Y with Z-min at zero
    _count = struct.unpack_from("<I", model.stl_bytes, 80)[0]
    assert _count == 12
    coords = [struct.unpack_from("<3f", model.stl_bytes, 84 + 50 * i + 12 + 12 * v) for i in range(_count) for v in range(3)]
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    zs = [c[2] for c in coords]
    assert max(abs(min(xs)), abs(max(xs))) == pytest.approx(41.75, abs=1e-4)
    assert min(zs) == pytest.approx(0.0, abs=1e-4)
    assert max(zs) == pytest.approx(28.0, abs=1e-3)


def test_process_import_accepts_ascii():
    model = process_import(_ascii_stl(_box(41.5, 41.5, 35.0)))
    assert (model.grid_x, model.grid_y, model.height_units) == (1.0, 1.0, 5)


def test_process_import_keeps_binary_with_solid_facet_header():
    original = _binary_stl(_box(83.5, 41.5, 28.0))
    # real exporters put arbitrary text in the 80-byte header, including
    # "solid"/"facet"; the exact record length must win over any header shape
    mutated = b"solid facet exported bin".ljust(80, b" ") + original[80:]
    assert mutated[80:] == original[80:]

    model = process_import(mutated)

    assert (round(model.width_mm, 3), round(model.depth_mm, 3), round(model.height_mm, 3)) == (83.5, 41.5, 28.0)
    assert (model.grid_x, model.grid_y, model.height_units) == (2.0, 1.0, 4)


def test_process_import_rejects_rejectable_meshes():
    with pytest.raises(StlImportError):
        process_import(b"not an stl at all")
    with pytest.raises(StlImportError):
        process_import(_ascii_stl([((0.0, 0.0, 0.0), (float("nan"), 0.0, 0.0), (1.0, 1.0, 1.0))]))
    with pytest.raises(StlImportError):
        process_import(_binary_stl(_box(40.0, 40.0, 0.0)))  # zero height
    with pytest.raises(StlImportError):
        process_import(_binary_stl(_box(1200.0, 1200.0, 28.0)))  # beyond supported bounds


def test_process_import_rejects_overflowing_derived_extents():
    # coordinates are each finite, but max-min overflows float64 to infinity
    triangles = [((-1e308, -1e308, 0.0), (1e308, 0.0, 1.0), (0.0, 1e308, 2.0))]
    with pytest.raises(StlImportError):
        process_import(_ascii_stl(triangles))


# --- HTTP contract ---

def test_import_creates_read_only_bin_with_metadata(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)

    resp = _upload(client, _binary_stl(_box(83.5, 41.5, 28.0)), name="Imported bin")

    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Imported bin"
    assert body["imported_model"] == {
        "width_mm": pytest.approx(83.5),
        "depth_mm": pytest.approx(41.5),
        "height_mm": pytest.approx(28.0),
        "warnings": [],
    }
    assert (body["bin_config"]["grid_x"], body["bin_config"]["grid_y"], body["bin_config"]["height_units"]) == (2.0, 1.0, 4)
    assert body["placed_tools"] == []
    asset = tmp_path / "default" / "imports" / f"{body['id']}.stl"
    assert asset.is_file()

    listed = client.get("/api/bins").json()["bins"]
    assert listed[0]["imported_model"]["width_mm"] == pytest.approx(83.5)


def test_import_rejects_oversized_payload(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    monkeypatch.setattr(routes, "MAX_IMPORT_BYTES", 100)

    assert _upload(client, b"\x00" * 400).status_code == 413


def test_import_warns_but_accepts_nonstandard_dimensions(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)

    resp = _upload(client, _binary_stl(_box(50.0, 50.0, 20.0)))

    assert resp.status_code == 200
    body = resp.json()
    assert body["imported_model"]["warnings"]
    assert body["bin_config"]["grid_x"] * 42 - 0.5 >= 50.0


def test_import_requires_supported_planning_bounds(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)

    resp = _upload(client, _binary_stl(_box(1200.0, 1200.0, 28.0)))

    assert resp.status_code == 400
    assert not (tmp_path / "default" / "imports").exists()


def test_import_rejects_overflowing_extents_with_controlled_400(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    data = _ascii_stl([((-1e308, -1e308, 0.0), (1e308, 0.0, 1.0), (0.0, 1e308, 2.0))])

    resp = _upload(client, data)

    assert resp.status_code == 400
    assert not (tmp_path / "default" / "imports").exists()


def test_imported_bin_metadata_survives_retention_sweep(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    body = _upload(client, _binary_stl(_box(83.5, 41.5, 28.0))).json()

    asset = tmp_path / "default" / "imports" / f"{body['id']}.stl"
    stale = _time.time() - 10 * 3600
    os.utime(asset, (stale, stale))
    # prove the sweep actually runs by planting a regenerable output beside it
    outputs = tmp_path / "default" / "outputs"
    outputs.mkdir(exist_ok=True)
    expired = outputs / "old.stl"
    expired.write_bytes(b"x")
    os.utime(expired, (stale, stale))

    removed = sweep_expired_outputs(tmp_path, retention_hours=1)

    assert removed == 1
    assert not expired.exists()
    assert asset.exists()  # imports are not regenerable and must be retained


def test_imported_bin_is_read_only_but_can_be_renamed_and_linked(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Drawer"}).json()
    body = _upload(client, _binary_stl(_box(83.5, 41.5, 28.0)), project_id=project["id"]).json()

    assert client.put(f"/api/bins/{body['id']}", json={"bin_config": {"grid_x": 4}}).status_code == 400
    assert client.put(f"/api/bins/{body['id']}", json={"placed_tools": []}).status_code == 400
    assert client.put(f"/api/bins/{body['id']}", json={"text_labels": [{"id": "t1", "text": "x", "x": 0, "y": 0}]}).status_code == 400

    renamed = client.put(f"/api/bins/{body['id']}", json={"name": "Renamed"})
    assert renamed.status_code == 200
    assert client.get(f"/api/bins/{body['id']}").json()["name"] == "Renamed"

    detail = client.get(f"/api/bin-projects/{project['id']}").json()
    assert body["id"] in detail["bin_ids"]
    assert client.put(f"/api/bins/{body['id']}", json={"project_id": None}).status_code == 200


def test_import_validates_project_ownership(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)

    resp = _upload(client, _binary_stl(_box(83.5, 41.5, 28.0)), project_id="missing-project")

    assert resp.status_code == 404
    assert not (tmp_path / "default" / "imports").exists()


def test_import_cleans_up_asset_when_persisting_fails(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    monkeypatch.setattr(routes.BinStore, "set", lambda self, bid, b: (_ for _ in ()).throw(OSError("disk full")))

    with pytest.raises(OSError):
        _upload(client, _binary_stl(_box(83.5, 41.5, 28.0)))

    imports = tmp_path / "default" / "imports"
    assert not imports.exists() or not list(imports.iterdir())


def test_imported_generate_returns_the_uploaded_asset(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    body = _upload(client, _binary_stl(_box(83.5, 41.5, 28.0))).json()
    asset = tmp_path / "default" / "imports" / f"{body['id']}.stl"
    original = asset.read_bytes()

    resp = client.post(f"/api/bins/{body['id']}/generate")

    assert resp.status_code == 200
    assert resp.json()["stl_url"] == f"/storage/default/imports/{body['id']}.stl"
    assert asset.read_bytes() == original  # served, not regenerated
    assert not (tmp_path / "default" / "outputs" / f"{body['id']}.stl").exists()

    download = client.get(f"/api/files/bins/{body['id']}/bin.stl")
    assert download.status_code == 200
    assert download.content == original


def test_imported_bin_assessment_is_uncertain_bbox_only(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    body = _upload(client, _binary_stl(_box(83.5, 41.5, 28.0))).json()

    assessment = client.get(f"/api/bins/{body['id']}").json()["height_assessment"]

    assert assessment["status"] == "uncertain"
    assert assessment["imported"] is True
    assert assessment["envelopes"] == []
    assert assessment["support_error"] is None
    assert assessment["seating_errors"] == {}
    assert assessment["external_height_mm"] == pytest.approx(28.0)
    assert assessment["stack_increment_mm"] == pytest.approx(28.0)


def test_imported_aligned_stack_plans_with_unverified_interface(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Drawer"}).json()
    lower = _upload(client, _binary_stl(_box(83.5, 41.5, 28.0)), project_id=project["id"]).json()
    upper = _upload(client, _binary_stl(_box(83.5, 41.5, 28.0)), project_id=project["id"]).json()

    sketch = client.post(f"/api/bin-projects/{project['id']}/sketches", json={"name": "Plan"}).json()
    layout = [
        {"id": "p-lower", "bin_id": lower["id"], "x": 0, "y": 0, "rotation": 0},
        {"id": "p-upper", "bin_id": upper["id"], "x": 0, "y": 0, "rotation": 0, "support_id": "p-lower"},
    ]
    patched = client.patch(
        f"/api/bin-projects/{project['id']}/sketches/{sketch['id']}",
        json={"bin_layout": layout, "container_height_mm": 200},
    )
    assert patched.status_code == 200

    plan = client.post(
        f"/api/bin-projects/{project['id']}/sketches/{sketch['id']}/assessment",
        json={"container_height_mm": 200},
    ).json()

    placements = {p["placement_id"]: p for p in plan["placements"]}
    assert placements["p-upper"]["support_compatible"] is None
    assert placements["p-lower"]["z_mm"] == 0
    # the upper elevation is the conservative bounding-box increment, not a
    # verified lip interface
    assert placements["p-upper"]["z_mm"] == pytest.approx(28.0)
    assert any("imported" in message.lower() for message in plan["unresolved"])
    assert plan["status"] == "uncertain"


def test_import_asset_path_cannot_escape_user_directory(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)

    body = _upload(client, _binary_stl(_box(83.5, 41.5, 28.0))).json()
    stored = Path(tmp_path / body["stl_path"])

    assert stored.is_file()
    assert stored.parent.name == "imports"
    assert stored.parent.parent.name == "default"


def test_import_rolls_back_bin_and_project_link_when_persisting_link_fails(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Drawer"}).json()
    projects_before = (tmp_path / "default" / "bin-projects.json").read_text()

    def failing_link(project_store, project_id, bin_id):
        # mimic the real helper: it mutates the live project record before its
        # own store write, which is exactly what a link failure leaves behind
        live = project_store.get(project_id)
        live.bin_ids.append(bin_id)
        raise OSError("project store write failed")

    monkeypatch.setattr(routes, "add_bin_to_project", failing_link)

    with pytest.raises(OSError):
        _upload(client, _binary_stl(_box(83.5, 41.5, 28.0)), project_id=project["id"])

    # no published bin, no dangling project link, no orphaned asset
    assert client.get("/api/bins").json()["bins"] == []
    live = routes.get_project_store("default").get(project["id"])
    assert live.bin_ids == []
    assert (tmp_path / "default" / "bin-projects.json").read_text() == projects_before
    imports = tmp_path / "default" / "imports"
    assert not imports.exists() or not list(imports.iterdir())


def test_missing_imported_asset_reports_reupload_not_regenerate(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    body = _upload(client, _binary_stl(_box(83.5, 41.5, 28.0))).json()
    Path(tmp_path / body["stl_path"]).unlink()

    download = client.get(f"/api/files/bins/{body['id']}/bin.stl")
    assert download.status_code == 404
    assert "re-upload" in download.json()["detail"]

    generate = client.post(f"/api/bins/{body['id']}/generate")
    assert generate.status_code == 404
    assert "missing" in generate.json()["detail"]


# --- planning trust semantics for imported interfaces ---

class _BinStoreStub:
    def __init__(self, bins):
        self._bins = bins

    def all(self):
        return dict(self._bins)


class _ToolStoreStub:
    def all(self):
        return {}


def _imported_bin(bin_id, height_mm, units):
    return BinModel(
        id=bin_id,
        bin_config=BinConfig(grid_x=2, grid_y=1, height_units=units, stacking_lip=True),
        imported_model=ImportedBinModel(width_mm=83.5, depth_mm=41.5, height_mm=height_mm),
    )


def _generated_bin(bin_id, units):
    return BinModel(id=bin_id, bin_config=BinConfig(grid_x=2, grid_y=1, height_units=units, stacking_lip=True))


def _stacked_layout(ids):
    return [
        ProjectBinPlacement(id=ids[0], bin_id=ids[0], x=0, y=0),
        *[
            ProjectBinPlacement(id=bin_id, bin_id=bin_id, x=0, y=0, support_id=ids[i - 1])
            for i, bin_id in enumerate(ids[1:], start=1)
        ],
    ]


def _plan(bins, container_height_mm, bin_ids):
    project = BinProject(id="project-1", name="Drawer", bin_ids=bin_ids)
    sketch = ProjectSketch(
        id="sketch-1",
        name="Plan",
        container_width_mm=200,
        container_depth_mm=200,
        container_height_mm=container_height_mm,
        bin_layout=_stacked_layout(bin_ids),
    )
    return assess_plan(project, sketch, _BinStoreStub(bins), _ToolStoreStub())


def test_imported_stack_ceiling_excess_is_uncertain_not_invalid():
    bins = {
        "b1": _imported_bin("b1", 39.4, 5),
        "b2": _imported_bin("b2", 25.4, 3),
        "b3": _imported_bin("b3", 18.4, 2),
    }

    plan = _plan(bins, container_height_mm=70, bin_ids=["b1", "b2", "b3"])

    placements = {p["placement_id"]: p for p in plan["placements"]}
    assert placements["b1"]["z_mm"] == 0
    assert placements["b2"]["z_mm"] == pytest.approx(39.4)
    assert placements["b3"]["z_mm"] == pytest.approx(64.8)
    # conservative bbox elevation exceeds 70mm, but the interface is unverified
    assert not [v for v in plan["violations"] if v["code"] == "ceiling"]
    assert plan["status"] == "uncertain"
    assert any("Estimated ceiling" in message for message in plan["unresolved"])


def test_imported_floor_bin_exterior_excess_stays_definite():
    bins = {"b1": _imported_bin("b1", 80.0, 10)}

    plan = _plan(bins, container_height_mm=70, bin_ids=["b1"])

    assert plan["status"] == "invalid"
    assert any(v["code"] == "ceiling" and "exterior" in v["message"] for v in plan["violations"])


def test_generated_bin_above_imported_lower_keeps_ceiling_uncertain():
    bins = {
        "b1": _imported_bin("b1", 39.4, 5),
        "b2": _generated_bin("b2", 4),
    }

    plan = _plan(bins, container_height_mm=70, bin_ids=["b1", "b2"])

    placements = {p["placement_id"]: p for p in plan["placements"]}
    assert placements["b2"]["z_mm"] == pytest.approx(39.4)  # conservative imported increment
    assert not [v for v in plan["violations"] if v["code"] == "ceiling"]
    assert plan["status"] == "uncertain"
    assert any("Estimated ceiling" in message for message in plan["unresolved"])


def test_generated_floor_bin_exterior_excess_stays_definite():
    bins = {"b1": _generated_bin("b1", 11)}

    plan = _plan(bins, container_height_mm=70, bin_ids=["b1"])

    assert plan["status"] == "invalid"
    assert any(v["code"] == "ceiling" and "exterior" in v["message"] for v in plan["violations"])
