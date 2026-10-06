"""Route-level tests for photo warnings on upload and corner correction."""

import io
import json

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import ExifTags, Image

import app.api.routes as routes
from app.config import ensure_user_dirs
from app.main import app
from app.models.schemas import CaptureFrame, Point, Session
from app.services.session_store import SessionStore
from tests.conftest import corners_for_height


def _client(tmp_path, monkeypatch):
    monkeypatch.setattr(routes.settings, "storage_path", tmp_path)
    routes._store_cache.clear()
    ensure_user_dirs(tmp_path / "default")
    return TestClient(app)


def _jpeg_bytes(w: int, h: int, f35: float | None) -> bytes:
    img = Image.new("RGB", (w, h), "white")
    buf = io.BytesIO()
    if f35 is not None:
        exif = Image.Exif()
        exif.get_ifd(ExifTags.IFD.Exif)[ExifTags.Base.FocalLengthIn35mmFilm] = int(f35)
        img.save(buf, format="JPEG", exif=exif)
    else:
        img.save(buf, format="JPEG")
    return buf.getvalue()


def test_upload_stores_focal_length_from_exif(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(
        routes.image_processor, "detect_paper_corners", lambda path: None
    )

    resp = client.post(
        "/api/upload",
        files={"image": ("photo.jpg", _jpeg_bytes(800, 600, 26.0), "image/jpeg")},
    )
    assert resp.status_code == 200
    sessions, _, _ = routes.get_stores("default")
    assert sessions.get(resp.json()["session_id"]).focal_length_35mm == 26.0


def test_upload_without_exif_stores_no_focal_length(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(
        routes.image_processor, "detect_paper_corners", lambda path: None
    )

    resp = client.post(
        "/api/upload",
        files={"image": ("photo.jpg", _jpeg_bytes(800, 600, None), "image/jpeg")},
    )
    assert resp.status_code == 200
    sessions, _, _ = routes.get_stores("default")
    assert sessions.get(resp.json()["session_id"]).focal_length_35mm is None


def test_upload_rejects_image_over_pixel_limit(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(routes.settings, "max_image_pixels", 100)

    resp = client.post(
        "/api/upload",
        files={"image": ("photo.jpg", _jpeg_bytes(11, 10, None), "image/jpeg")},
    )

    assert resp.status_code == 413
    assert resp.json() == {"detail": "image has 110 pixels; maximum is 100"}


def test_upload_focal_length_survives_downscale(tmp_path, monkeypatch):
    """exif is stripped when the image is re-encoded; extraction must happen first."""
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(
        routes.image_processor, "detect_paper_corners", lambda path: None
    )
    monkeypatch.setattr(routes, "MAX_UPLOAD_DIM", 400)

    resp = client.post(
        "/api/upload",
        files={"image": ("photo.jpg", _jpeg_bytes(800, 600, 26.0), "image/jpeg")},
    )
    assert resp.status_code == 200
    sessions, _, _ = routes.get_stores("default")
    assert sessions.get(resp.json()["session_id"]).focal_length_35mm == 26.0


def _seed_session_with_upload(tmp_path, monkeypatch, f35):
    client = _client(tmp_path, monkeypatch)
    uploads = tmp_path / "default" / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    (uploads / "s1.jpg").write_bytes(_jpeg_bytes(800, 600, None))
    sessions, _, _ = routes.get_stores("default")
    sessions.set("s1", Session(
        id="s1",
        original_image_path="default/uploads/s1.jpg",
        focal_length_35mm=f35,
    ))
    return client, sessions


def test_corners_returns_and_persists_warnings(tmp_path, monkeypatch):
    client, sessions = _seed_session_with_upload(tmp_path, monkeypatch, f35=26.0)
    corners = corners_for_height(250.0, 26.0, 800, 600)

    resp = client.post(
        "/api/sessions/s1/corners",
        json={
            "corners": [{"x": x, "y": y} for x, y in corners],
            "paper_size": "a4",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "camera_too_close" in [w["code"] for w in body["warnings"]]
    assert "camera_too_close" in [w.code for w in sessions.get("s1").photo_warnings]


def test_corners_without_focal_length_is_graceful(tmp_path, monkeypatch):
    client, sessions = _seed_session_with_upload(tmp_path, monkeypatch, f35=None)
    corners = corners_for_height(250.0, 26.0, 800, 600)

    resp = client.post(
        "/api/sessions/s1/corners",
        json={
            "corners": [{"x": x, "y": y} for x, y in corners],
            "paper_size": "a4",
        },
    )
    assert resp.status_code == 200
    assert "camera_too_close" not in [w["code"] for w in resp.json()["warnings"]]


def test_corners_succeeds_when_photo_checks_raise(tmp_path, monkeypatch):
    """a broken check must not fail perspective correction."""
    client, sessions = _seed_session_with_upload(tmp_path, monkeypatch, f35=26.0)

    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(routes, "check_photo", boom)
    corners = corners_for_height(250.0, 26.0, 800, 600)

    resp = client.post(
        "/api/sessions/s1/corners",
        json={
            "corners": [{"x": x, "y": y} for x, y in corners],
            "paper_size": "a4",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["warnings"] == []
    assert sessions.get("s1").photo_warnings is None


@pytest.mark.parametrize(("corners", "retain_original", "crop"), [
    ([(190, 140), (660, 110), (700, 470), (150, 450)], False, None),
    ([(310, 80), (590, 120), (650, 500), (250, 460)], True,
     {"x": 0.6, "y": 0.2, "width": 0.4, "height": 0.8}),
])
def test_corners_retains_actual_source_mapping_after_resize_and_reload(
    tmp_path, monkeypatch, corners, retain_original, crop,
):
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(routes.settings, "photo_stations", True)
    monkeypatch.setattr(routes.image_processor, "detect_paper_corners", lambda _: None)
    # Cropped upload is still 800x600; metadata must use that ingested source,
    # while its estimated lens center may lie outside the crop.
    source_size = (2000, 750) if crop else (800, 600)
    image = np.full((source_size[1], source_size[0], 3), 255, dtype=np.uint8)
    source_point = (390, 300)
    marker_point = (1590, 450) if crop else source_point
    cv2.circle(image, marker_point, 10, (255, 0, 0), -1)
    success, encoded = cv2.imencode(".png", image)
    assert success
    upload = client.post(
        "/api/upload",
        data={"capture_crop": json.dumps(crop)} if crop else {},
        files={"image": ("capture.png", encoded.tobytes(), "image/png")},
    )
    assert upload.status_code == 200
    session_id = upload.json()["session_id"]
    sessions, _, _ = routes.get_stores("default")
    original_path = tmp_path / sessions.get(session_id).original_image_path
    monkeypatch.setattr(routes, "MAX_UPLOAD_DIM", 507)
    actual_warp = cv2.warpPerspective
    observed = {}

    def record_warp(image, matrix, size, *args, **kwargs):
        observed["matrix"] = matrix.copy()
        observed["size"] = size
        return actual_warp(image, matrix, size, *args, **kwargs)

    monkeypatch.setattr(cv2, "warpPerspective", record_warp)
    response = client.post(f"/api/sessions/{session_id}/corners", json={
        "corners": [{"x": x, "y": y} for x, y in corners],
        "paper_size": "a4",
        "retain_original": retain_original,
    })
    assert response.status_code == 200
    frame = response.json()["capture_frame"]
    assert (frame["source_width"], frame["source_height"]) == (800, 600)
    corrected = tmp_path / sessions.get(session_id).corrected_image_path
    with Image.open(corrected) as image:
        final_width, final_height = image.size
    assert max(final_width, final_height) == 507
    warped_width, warped_height = observed["size"]
    assert warped_width / final_width != warped_height / final_height
    assert observed["matrix"][0, 2] != 0 or observed["matrix"][1, 2] != 0
    assert np.any(observed["matrix"][2, :2] != 0)  # genuinely projective

    inverse = np.asarray(frame["corrected_to_source"])
    # Ground the mapping in the forward matrix that actually rendered the
    # pixels, including paper corners and a known off-paper original location.
    for x, y in [*corners, source_point, (20, 280)]:
        warped = observed["matrix"] @ [x, y, 1]
        final = [
            warped[0] / warped[2] * final_width / warped_width,
            warped[1] / warped[2] * final_height / warped_height,
            1,
        ]
        restored = inverse @ final
        np.testing.assert_allclose(restored[:2] / restored[2], [x, y], atol=1e-7)

    # Also observe the real rendered fiducial, not just matrix composition.
    pixels = cv2.imread(str(corrected))
    ys, xs = np.nonzero(
        (pixels[:, :, 0] > 180) & (pixels[:, :, 1] < 80) & (pixels[:, :, 2] < 80)
    )
    assert len(xs) > 0
    restored = inverse @ [xs.mean(), ys.mean(), 1]
    np.testing.assert_allclose(restored[:2] / restored[2], source_point, atol=2)
    if crop:
        assert frame["optical_center"] == pytest.approx({"x": -200, "y": 225})
        assert frame["full_frame_width"] == pytest.approx(2000)
        assert frame["full_frame_height"] == pytest.approx(750)
    else:
        assert frame["optical_center"] == {"x": 400, "y": 300}
        assert frame["full_frame_width"] == 800
        assert frame["full_frame_height"] == 600
    assert original_path.exists() is retain_original
    persisted = SessionStore(tmp_path / "default").get(session_id)
    assert persisted.capture_frame.model_dump() == frame
    # Drop cached stores so GET has to deserialize the on-disk session, even
    # when the original capture was discarded.
    routes._store_cache.clear()
    reopened = client.get(f"/api/sessions/{session_id}")
    assert reopened.status_code == 200
    assert reopened.json()["capture_frame"] == frame
    assert reopened.json()["scale_factor"] == response.json()["scale_factor"]


def test_capture_frame_rejects_unusable_mapping_and_dimensions():
    valid = {
        "source_width": 800, "source_height": 600,
        "corrected_to_source": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        "optical_center": Point(x=400, y=300),
        "full_frame_width": 800, "full_frame_height": 600,
    }
    for field, value in [
        ("source_width", 0), ("source_height", 1.5),
        ("full_frame_width", float("inf")), ("full_frame_height", -1),
        ("corrected_to_source", [[1, 0], [0, 1], [0, 0]]),
        ("corrected_to_source", [[float("nan"), 0, 0], [0, 1, 0], [0, 0, 1]]),
        ("corrected_to_source", [[1, 0, 0], [0, 0, 0], [0, 0, 1]]),
    ]:
        with pytest.raises(ValueError):
            CaptureFrame.model_validate({**valid, field: value})


def test_legacy_session_returns_nullable_capture_frame(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    (tmp_path / "default" / "sessions.json").write_text(json.dumps({"legacy": {"id": "legacy"}}))
    response = client.get("/api/sessions/legacy")
    assert response.status_code == 200
    assert response.json()["capture_frame"] is None
