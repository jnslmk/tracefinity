"""Photo-derived drawer plans: source lifecycle, boundary persistence and the candidate endpoint."""

from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image

import app.api.routes as routes
from app.models.schemas import CornersRequest, Point, Polygon, Session
from app.services.ai_tracer import AITracer
from tests.test_bin_projects import _api_client

CORNERS = [
    {"x": 10, "y": 10}, {"x": 390, "y": 12}, {"x": 388, "y": 290}, {"x": 8, "y": 288},
]
SQUARE_MM = [{"x": 0, "y": 0}, {"x": 80, "y": 0}, {"x": 80, "y": 80}, {"x": 0, "y": 80}]


def _calibrated_session(tmp_path, session_id: str = "session-1", scale_factor: float = 0.1):
    processed = tmp_path / "default" / "processed"
    processed.mkdir(parents=True, exist_ok=True)
    image_path = processed / f"{session_id}_corrected.png"
    Image.new("RGB", (400, 300), "white").save(image_path)
    uploads = tmp_path / "default" / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    original_path = uploads / f"{session_id}.png"
    Image.new("RGB", (800, 600), "white").save(original_path)
    routes.get_stores("default")[0].set(session_id, Session(
        id=session_id,
        corrected_image_path=f"default/processed/{session_id}_corrected.png",
        original_image_path=f"default/uploads/{session_id}.png",
        paper_size="a4",
        corners=[Point(**corner) for corner in CORNERS],
        scale_factor=scale_factor,
    ))
    return image_path


def _project_with_photo_plan(client):
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()
    response = client.post(
        f"/api/bin-projects/{project['id']}/sketches",
        json={"source_session_id": "session-1", "source_seed": {"x": 120, "y": 90}},
    )
    assert response.status_code == 200
    return project["id"], response.json()


def test_a_photo_source_persists_calibration_seed_and_a_covering_grid(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)

    _, sketch = _project_with_photo_plan(client)

    assert sketch["source"]["session_id"] == "session-1"
    assert sketch["source"]["scale_factor"] == pytest.approx(0.1)
    assert sketch["source"]["image_width"] == 400
    assert sketch["source"]["image_height"] == 300
    assert sketch["source"]["seed"] == {"x": 120.0, "y": 90.0}
    # 400px * 0.1mm = 40mm -> a 1 unit (42mm) grid covers the frame
    assert sketch["target_grid_x"] == 1.0
    assert sketch["target_grid_y"] == 1.0
    assert sketch["outline"] is None
    assert sketch["fit_clearance_mm"] == 0
    assert sketch["grid_alignment"] == {"origin_x_mm": 0.0, "origin_y_mm": 0.0, "rotation_deg": 0.0}


def test_a_photo_source_requires_a_calibrated_session(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()

    response = client.post(
        f"/api/bin-projects/{project['id']}/sketches",
        json={"source_session_id": "missing"},
    )

    assert response.status_code == 400
    assert client.get(f"/api/bin-projects/{project['id']}").json()["sketches"] == []


def test_rectangular_plans_keep_working_without_a_source(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()

    sketch = client.post(f"/api/bin-projects/{project['id']}/sketches", json={}).json()

    assert sketch["outline"] is None
    assert sketch["source"] is None
    assert sketch["fit_clearance_mm"] == 0


def test_a_rejected_boundary_leaves_the_saved_plan_untouched(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)
    project_id, sketch = _project_with_photo_plan(client)
    url = f"/api/bin-projects/{project_id}/sketches/{sketch['id']}"

    collinear = client.patch(url, json={"outline": {
        "points": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 20, "y": 0}], "interior_rings": [],
    }})
    self_crossing = client.patch(url, json={"outline": {
        "points": [
            {"x": 0, "y": 0}, {"x": 8, "y": 0}, {"x": 8, "y": 8}, {"x": 4, "y": 8},
            {"x": 4, "y": 2}, {"x": 6, "y": 2}, {"x": 6, "y": 8}, {"x": 0, "y": 8},
        ],
        "interior_rings": [],
    }})

    assert collinear.status_code == 400
    assert self_crossing.status_code == 400
    assert client.get(f"/api/bin-projects/{project_id}").json()["sketches"][0]["outline"] is None


def test_an_accepted_boundary_round_trips_without_losing_placements(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)
    project_id, sketch = _project_with_photo_plan(client)
    url = f"/api/bin-projects/{project_id}/sketches/{sketch['id']}"
    accepted = {
        "points": SQUARE_MM,
        "interior_rings": [[{"x": 20, "y": 20}, {"x": 40, "y": 20}, {"x": 40, "y": 40}, {"x": 20, "y": 40}]],
    }

    response = client.patch(url, json={
        "outline": accepted,
        "fit_clearance_mm": 2,
        "grid_alignment": {"origin_x_mm": 3, "origin_y_mm": -4, "rotation_deg": 12.5},
        "source_seed": {"x": 150, "y": 120},
    })

    assert response.status_code == 200
    routes._project_store_cache.clear()
    saved = client.get(f"/api/bin-projects/{project_id}").json()["sketches"][0]
    assert [(p["x"], p["y"]) for p in saved["outline"]["points"]] == [(0.0, 0.0), (80.0, 0.0), (80.0, 80.0), (0.0, 80.0)]
    assert len(saved["outline"]["interior_rings"]) == 1
    assert saved["fit_clearance_mm"] == 2
    assert saved["grid_alignment"] == {"origin_x_mm": 3.0, "origin_y_mm": -4.0, "rotation_deg": 12.5}
    assert saved["source"]["session_id"] == "session-1"
    assert saved["source"]["seed"] == {"x": 150.0, "y": 120.0}


def test_outline_candidate_is_session_scoped_and_creates_no_plan(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)
    monkeypatch.setattr(routes.settings, "google_api_key", "test-key")
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()
    url = f"/api/bin-projects/{project['id']}/sketches/outline/candidate"

    async def fake_floor(self, image_path, api_key, mask_output_path=None, before_mask_write=None, focus=None):
        if before_mask_write:
            before_mask_write()
        polygon = Polygon(
            id="floor",
            label="drawer floor",
            points=[Point(x=10, y=10), Point(x=100, y=10), Point(x=100, y=80), Point(x=10, y=80)],
            interior_rings=[[Point(x=40, y=30), Point(x=50, y=30), Point(x=50, y=40), Point(x=40, y=40)]],
        )
        return polygon, mask_output_path

    monkeypatch.setattr(AITracer, "trace_drawer_floor", fake_floor)

    accepted = client.post(url, json={"session_id": "session-1", "seed": {"x": 20, "y": 20}})
    rejected = client.post(url, json={"session_id": "session-1", "seed": {"x": 45, "y": 35}})

    assert accepted.status_code == 200
    outline = accepted.json()["outline"]
    # corrected-image pixels become millimetres through the session scale factor
    assert [(p["x"], p["y"]) for p in outline["points"]] == [(1.0, 1.0), (10.0, 1.0), (10.0, 8.0), (1.0, 8.0)]
    assert outline["interior_rings"][0][0] == {"x": 4.0, "y": 3.0}
    # a seed that lands in the exclusion is not the floor the user picked
    assert rejected.status_code == 400
    assert accepted.json()["image_width"] == 400
    # reviewing a candidate must not leave an abandoned plan behind
    assert client.get(f"/api/bin-projects/{project['id']}").json()["sketches"] == []


def test_paper_only_candidate_outside_selected_floor_preserves_the_saved_project(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)
    project_id, sketch = _project_with_photo_plan(client)
    sketch_url = f"/api/bin-projects/{project_id}/sketches/{sketch['id']}"
    assert client.patch(sketch_url, json={"outline": {"points": SQUARE_MM, "interior_rings": []}}).status_code == 200
    project_url = f"/api/bin-projects/{project_id}"
    before = client.get(project_url).json()
    owner = tmp_path / "default" / "projects" / sketch["id"]
    source_files = {path: path.read_bytes() for path in owner.rglob("*") if path.is_file()}
    monkeypatch.setattr(routes.settings, "google_api_key", None)
    monkeypatch.setattr(routes.settings, "openrouter_api_key", "test-key")
    monkeypatch.setattr(routes, "_tracers", {"gemini": AITracer(
        openrouter_key="test-key", openrouter_image_model="google/gemini-3-pro-image",
    )})

    async def paper_only_mask(self, image_bytes, mime_type, prompt):
        mask = np.zeros((300, 400, 3), np.uint8)
        cv2.rectangle(mask, (100, 70), (290, 210), (255, 255, 255), -1)
        return cv2.imencode(".png", mask)[1].tobytes()

    monkeypatch.setattr(AITracer, "_mask_via_openrouter", paper_only_mask)
    response = client.post(
        f"{project_url}/sketches/outline/candidate",
        json={"sketch_id": sketch["id"], "seed": {"x": 220, "y": 245}},
    )

    # Real mask inversion, contour extraction and outer-ring containment reject
    # paper above the selected floor, without replacing the accepted boundary.
    assert response.status_code == 400
    assert "does not include the floor you selected" in response.json()["detail"]
    assert tuple(cv2.imread(str(owner / "drawer_mask.png"))[245, 220]) == (255, 255, 255)
    assert {path: path.read_bytes() for path in source_files} == source_files
    routes._project_store_cache.clear()
    assert client.get(project_url).json() == before


def test_corner_requests_discard_the_original_unless_a_plan_keeps_it():
    # ordinary tool tracing must keep its old image lifecycle
    assert CornersRequest(corners=[Point(x=0, y=0)], paper_size="a4").retain_original is False
    assert CornersRequest(corners=[Point(x=0, y=0)], paper_size="a4", retain_original=True).retain_original is True


def test_outline_candidate_rejects_an_unknown_session(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    monkeypatch.setattr(routes.settings, "google_api_key", "test-key")
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()

    response = client.post(
        f"/api/bin-projects/{project['id']}/sketches/outline/candidate",
        json={"session_id": "missing", "seed": {"x": 5, "y": 5}},
    )

    assert response.status_code == 400


def test_a_plan_owns_its_source_and_survives_the_session(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)
    monkeypatch.setattr(routes.settings, "google_api_key", "test-key")
    project_id, sketch = _project_with_photo_plan(client)

    owned = f"/storage/default/projects/{sketch['id']}/"
    assert sketch["source"]["corrected_image_url"].startswith(owned)
    assert sketch["source"]["original_image_url"].startswith(owned)
    assert Path(routes._abs(sketch["source"]["corrected_image_url"].removeprefix("/storage/"))).exists()
    assert Path(routes._abs(sketch["source"]["original_image_url"].removeprefix("/storage/"))).exists()

    async def fake_floor(self, image_path, api_key, mask_output_path=None, before_mask_write=None, focus=None):
        assert Path(image_path).is_relative_to(tmp_path / "default" / "projects" / sketch["id"])
        assert focus == (20.0, 20.0)  # the positive floor choice reaches the provider request
        polygon = Polygon(
            id="floor",
            label="drawer floor",
            points=[Point(x=10, y=10), Point(x=100, y=10), Point(x=100, y=80), Point(x=10, y=80)],
            interior_rings=[],
        )
        return polygon, mask_output_path

    monkeypatch.setattr(AITracer, "trace_drawer_floor", fake_floor)

    # the trace session is gone; the saved plan still re-derives its boundary
    routes.get_stores("default")[0].delete("session-1")
    response = client.post(
        f"/api/bin-projects/{project_id}/sketches/outline/candidate",
        json={"sketch_id": sketch["id"], "seed": {"x": 20, "y": 20}},
    )

    assert response.status_code == 200


def test_drawer_cloud_availability_is_reported_separately_from_the_tool_tracer(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)
    monkeypatch.setattr(routes.settings, "tracers", "isnet")
    monkeypatch.setattr(routes.settings, "google_api_key", None)
    monkeypatch.setattr(routes.settings, "openrouter_api_key", None)

    local_only = client.get("/api/api-keys").json()
    assert local_only["google"] is True  # a local saliency tracer can still trace tools
    assert local_only["drawer_cloud"] is False
    assert local_only["drawer_provider_label"] is None

    # with a local-only tracer the photo candidate is refused, not silently mocked
    project = client.post("/api/bin-projects", json={"name": "Top drawer"}).json()
    refused = client.post(
        f"/api/bin-projects/{project['id']}/sketches/outline/candidate",
        json={"session_id": "session-1", "seed": {"x": 20, "y": 20}},
    )
    assert refused.status_code == 400
    assert "locally" in refused.json()["detail"]

    monkeypatch.setattr(routes.settings, "openrouter_api_key", "test-key")
    cloud = client.get("/api/api-keys").json()
    assert cloud["drawer_cloud"] is True
    assert cloud["drawer_provider_label"] == "Gemini via OpenRouter"


@pytest.mark.parametrize("failure", ["original-copy", "corrected-decode", "original-decode", "metadata"])
def test_failed_source_replacement_keeps_the_saved_metric_frame_and_photos(tmp_path, monkeypatch, failure):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)
    project_id, sketch = _project_with_photo_plan(client)
    url = f"/api/bin-projects/{project_id}/sketches/{sketch['id']}"
    assert client.patch(url, json={"outline": {"points": SQUARE_MM, "interior_rings": []}}).status_code == 200
    before = client.get(f"/api/bin-projects/{project_id}").json()["sketches"][0]
    owner = tmp_path / "default" / "projects" / sketch["id"]
    files = {p: p.read_bytes() for p in owner.rglob("*") if p.is_file()}
    replacement = _calibrated_session(tmp_path, "session-2", 0.5)
    Image.new("RGB", (160, 100), "red").save(replacement)

    with monkeypatch.context() as failing:
        if failure == "original-copy":
            copy = routes.shutil.copy2

            def fail_original(src, dst):
                if Path(src).parent.name == "uploads":
                    raise OSError("copy interrupted")
                return copy(src, dst)

            failing.setattr(routes.shutil, "copy2", fail_original)
        elif failure == "metadata":
            def fail_save():
                raise OSError("metadata write interrupted")

            failing.setattr(routes.get_project_store("default"), "_save", fail_save)
        else:
            bad_path = replacement if failure == "corrected-decode" else tmp_path / "default" / "uploads" / "session-2.png"
            bad_path.write_bytes(b"not an image")
        with pytest.raises(OSError):
            client.patch(url, json={
                "source_session_id": "session-2",
                "outline": {"points": SQUARE_MM, "interior_rings": []},
                "fit_clearance_mm": 2,
            })

    assert client.get(f"/api/bin-projects/{project_id}").json()["sketches"][0] == before
    routes._project_store_cache.clear()
    assert client.get(f"/api/bin-projects/{project_id}").json()["sketches"][0] == before
    assert {p: p.read_bytes() for p in owner.rglob("*") if p.is_file()} == files


def test_accepting_a_replacement_switches_source_and_calibration_then_removes_old_copies(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)
    project_id, sketch = _project_with_photo_plan(client)
    old_paths = [Path(routes._abs(sketch["source"][key].removeprefix("/storage/")))
                 for key in ("corrected_image_url", "original_image_url")]
    replacement = _calibrated_session(tmp_path, "session-2", 0.5)
    Image.new("RGB", (160, 100), "red").save(replacement)

    response = client.patch(f"/api/bin-projects/{project_id}/sketches/{sketch['id']}", json={
        "source_session_id": "session-2",
        "source_seed": {"x": 40, "y": 30},
        "outline": {"points": SQUARE_MM, "interior_rings": []},
    })

    assert response.status_code == 200
    accepted = response.json()
    assert accepted["id"] == sketch["id"]
    assert accepted["source"]["scale_factor"] == 0.5
    assert (accepted["source"]["image_width"], accepted["source"]["image_height"]) == (160, 100)
    assert all(not p.exists() for p in old_paths)
    assert client.delete("/api/sessions/session-2").status_code == 200
    for key in ("corrected_image_url", "original_image_url"):
        assert Path(routes._abs(accepted["source"][key].removeprefix("/storage/"))).is_file()
    assert client.patch(f"/api/bin-projects/{project_id}/sketches/{sketch['id']}", json={"fit_clearance_mm": 3}).status_code == 200


def test_obsolete_source_cleanup_failure_does_not_fail_a_committed_replacement(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)
    project_id, sketch = _project_with_photo_plan(client)
    old_paths = [Path(routes._abs(sketch["source"][key].removeprefix("/storage/")))
                 for key in ("corrected_image_url", "original_image_url")]
    replacement = _calibrated_session(tmp_path, "session-2", 0.5)
    Image.new("RGB", (160, 100), "red").save(replacement)

    # Obsolete-copy disposal runs after the matching metadata commit, so a
    # filesystem error there must not turn a committed replacement into an error
    # response that strands the plan on the old source.
    def fail_rmdir(self):
        raise OSError("obsolete source directory busy")

    monkeypatch.setattr(Path, "rmdir", fail_rmdir)

    response = client.patch(f"/api/bin-projects/{project_id}/sketches/{sketch['id']}", json={
        "source_session_id": "session-2",
        "source_seed": {"x": 40, "y": 30},
        "outline": {"points": SQUARE_MM, "interior_rings": []},
    })

    assert response.status_code == 200
    accepted = response.json()
    assert accepted["source"]["session_id"] == "session-2"
    assert accepted["source"]["scale_factor"] == 0.5
    # the response returns the committed source and its images are the referenced ones
    for key in ("corrected_image_url", "original_image_url"):
        assert Path(routes._abs(accepted["source"][key].removeprefix("/storage/"))).is_file()
    assert all(not path.exists() for path in old_paths)
    routes._project_store_cache.clear()
    assert client.get(f"/api/bin-projects/{project_id}").json()["sketches"][0]["source"]["scale_factor"] == 0.5


def test_boundary_and_clearance_acceptance_and_original_recalibration_after_session_deletion(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    # Paper detection is not under test and must not load/download local weights.
    monkeypatch.setattr(routes.image_processor, "detect_paper_corners", lambda _: None)
    _calibrated_session(tmp_path)
    project_id, sketch = _project_with_photo_plan(client)
    assert client.delete("/api/sessions/session-1").status_code == 200
    url = f"/api/bin-projects/{project_id}/sketches/{sketch['id']}"
    edited = client.patch(url, json={
        "outline": {"points": SQUARE_MM, "interior_rings": []},
        "fit_clearance_mm": 2,
        "source_seed": {"x": 140, "y": 100},
    })
    assert edited.status_code == 200
    assert edited.json()["source"]["corrected_image_url"] == sketch["source"]["corrected_image_url"]
    assert edited.json()["fit_clearance_mm"] == 2

    # The browser reopens this owned original via normal upload and the shared
    # paper editor. No old session endpoint is involved.
    original = Path(routes._abs(sketch["source"]["original_image_url"].removeprefix("/storage/")))
    upload = client.post("/api/upload", files={"image": ("original.png", original.read_bytes(), "image/png")})
    assert upload.status_code == 200
    pending_id = upload.json()["session_id"]
    corrected = client.post(f"/api/sessions/{pending_id}/corners", json={
        "corners": sketch["source"]["corners"], "paper_size": sketch["source"]["paper_size"], "retain_original": True,
    })
    assert corrected.status_code == 200
    # Until Accept the previous image, calibration, outline and clearance survive.
    assert client.get(f"/api/bin-projects/{project_id}").json()["sketches"][0] == edited.json()
    accepted = client.patch(url, json={
        "source_session_id": pending_id, "outline": {"points": SQUARE_MM, "interior_rings": []}, "fit_clearance_mm": 2,
    })
    assert accepted.status_code == 200
    assert accepted.json()["source"]["session_id"] == pending_id
    assert accepted.json()["source"]["scale_factor"] == corrected.json()["scale_factor"]
    assert client.delete(f"/api/sessions/{pending_id}").status_code == 200
    assert client.patch(url, json={"fit_clearance_mm": 4}).status_code == 200


def test_deletion_cleans_only_owned_plan_photos_and_candidate_masks(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)
    project_id, first = _project_with_photo_plan(client)
    second = client.post(f"/api/bin-projects/{project_id}/sketches", json={"source_session_id": "session-1"}).json()
    other_project, other_plan = _project_with_photo_plan(client)
    tool_photo = tmp_path / "default" / "processed" / "tool-photo.png"
    tool_photo.write_bytes(b"tool-owned-photo")
    session_mask = tmp_path / "default" / "processed" / "session-1_drawer_mask.png"
    session_mask.write_bytes(b"session-candidate")
    for plan in (first, second, other_plan):
        (tmp_path / "default" / "projects" / plan["id"] / "drawer_mask.png").write_bytes(b"plan-candidate")

    assert client.delete("/api/sessions/session-1").status_code == 200
    assert not session_mask.exists()
    assert client.delete(f"/api/bin-projects/{project_id}/sketches/{first['id']}").status_code == 200
    assert not (tmp_path / "default" / "projects" / first["id"]).exists()
    assert (tmp_path / "default" / "projects" / second["id"] / "drawer_mask.png").exists()
    assert client.delete(f"/api/bin-projects/{project_id}").status_code == 200
    assert not (tmp_path / "default" / "projects" / second["id"]).exists()
    assert client.get(f"/api/bin-projects/{other_project}").status_code == 200
    assert (tmp_path / "default" / "projects" / other_plan["id"] / "drawer_mask.png").exists()
    for key in ("corrected_image_url", "original_image_url"):
        assert Path(routes._abs(other_plan["source"][key].removeprefix("/storage/"))).is_file()
    assert tool_photo.read_bytes() == b"tool-owned-photo"


@pytest.mark.parametrize("owner", ["session", "plan"])
def test_candidate_cannot_recreate_images_after_its_owner_is_deleted(tmp_path, monkeypatch, owner):
    client = _api_client(tmp_path, monkeypatch)
    _calibrated_session(tmp_path)
    project_id, sketch = _project_with_photo_plan(client)
    monkeypatch.setattr(routes.settings, "google_api_key", "test-key")
    monkeypatch.setattr(routes, "_get_tracer", lambda _: AITracer())

    async def provider(self, image_bytes, mime_type, prompt, api_key):
        if owner == "session":
            await routes.delete_session(None, "session-1", user_id="default")
        else:
            await routes.delete_project_sketch(None, project_id, sketch["id"], user_id="default")
        return cv2.imencode(".png", np.zeros((300, 300, 3), np.uint8))[1].tobytes()

    monkeypatch.setattr(AITracer, "_mask_via_google", provider)
    target = {"session_id": "session-1"} if owner == "session" else {"sketch_id": sketch["id"]}
    response = client.post(f"/api/bin-projects/{project_id}/sketches/outline/candidate", json={
        **target, "seed": {"x": 100, "y": 100},
    })
    assert response.status_code == 400
    assert not (tmp_path / "default" / "processed" / "session-1_drawer_mask.png").exists()
    assert not (tmp_path / "default" / "projects" / sketch["id"] / "drawer_mask.png").exists()
