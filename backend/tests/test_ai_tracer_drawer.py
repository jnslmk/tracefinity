"""The drawer-floor candidate: the mask's largest region is the floor, its holes are obstructions."""

import asyncio

import cv2
import numpy as np
import pytest

from app.services.ai_tracer import AITracer
from app.services.drawer_outline import point_in_polygon, ring_from_points


def test_trace_drawer_floor_returns_the_floor_ring_with_obstructions(tmp_path, monkeypatch):
    image_path = tmp_path / "corrected.png"
    cv2.imwrite(str(image_path), np.full((240, 320, 3), 200, np.uint8))

    # the model marks the floor WHITE against a black case; the tracer inverts it
    mask = np.zeros((240, 320, 3), np.uint8)
    cv2.rectangle(mask, (30, 20), (290, 220), (255, 255, 255), -1)
    cv2.rectangle(mask, (140, 100), (180, 140), (0, 0, 0), -1)

    async def fake_google(self, image_bytes, mime_type, prompt, api_key):
        return cv2.imencode(".png", mask)[1].tobytes()

    monkeypatch.setattr(AITracer, "_mask_via_google", fake_google)
    output_path = str(tmp_path / "drawer_mask.png")

    polygon, mask_path = asyncio.run(
        AITracer().trace_drawer_floor(str(image_path), "key", output_path)
    )

    assert mask_path == output_path
    assert polygon is not None
    assert min(p.x for p in polygon.points) == pytest.approx(30, abs=3)
    assert max(p.x for p in polygon.points) == pytest.approx(290, abs=3)
    assert min(p.y for p in polygon.points) == pytest.approx(20, abs=3)
    assert max(p.y for p in polygon.points) == pytest.approx(220, abs=3)
    assert len(polygon.interior_rings) == 1


def test_trace_drawer_floor_returns_nothing_when_no_floor_is_marked(tmp_path, monkeypatch):
    image_path = tmp_path / "corrected.png"
    cv2.imwrite(str(image_path), np.full((120, 120, 3), 200, np.uint8))

    async def fake_google(self, image_bytes, mime_type, prompt, api_key):
        # nothing marked as floor: the model returned an all-black case
        return cv2.imencode(".png", np.zeros((120, 120, 3), np.uint8))[1].tobytes()

    monkeypatch.setattr(AITracer, "_mask_via_google", fake_google)

    polygon, _ = asyncio.run(AITracer().trace_drawer_floor(str(image_path), "key"))

    assert polygon is None


def test_selected_floor_keeps_full_scene_context_and_obstructions(tmp_path, monkeypatch):
    image_path = tmp_path / "corrected.png"
    cv2.imwrite(str(image_path), np.full((200, 600, 3), 200, np.uint8))
    source_bytes = image_path.read_bytes()
    mask = np.zeros((200, 600, 3), np.uint8)
    cv2.rectangle(mask, (30, 20), (570, 180), (255, 255, 255), -1)
    cv2.rectangle(mask, (280, 80), (320, 120), (0, 0, 0), -1)

    async def fake_openrouter(self, image_bytes, mime_type, prompt):
        provider_input = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        assert provider_input.shape[:2] == (200, 600)
        assert np.all(provider_input[:, :30] == 200)
        assert np.all(provider_input[:, 570:] == 200)
        assert tuple(provider_input[150, 300]) == (0, 0, 255)
        assert "red cross" in prompt
        assert "x=300.0, y=150.0" in prompt
        return cv2.imencode(".png", mask)[1].tobytes()

    monkeypatch.setattr(AITracer, "_mask_via_openrouter", fake_openrouter)
    output_path = str(tmp_path / "drawer_mask.png")
    tracer = AITracer(openrouter_key="test-key", openrouter_image_model="google/gemini-3-pro-image")
    polygon, _ = asyncio.run(
        tracer.trace_drawer_floor(str(image_path), "key", output_path, focus=(300, 150))
    )
    assert image_path.read_bytes() == source_bytes

    native = cv2.imread(output_path)
    assert np.all(native[:, :20] == 255)
    assert np.all(native[:, 580:] == 255)
    assert polygon is not None
    assert min(p.x for p in polygon.points) == pytest.approx(30, abs=3)
    assert max(p.x for p in polygon.points) == pytest.approx(570, abs=3)
    assert len(polygon.interior_rings) == 1
    outer = ring_from_points(polygon.points)
    holes = [ring_from_points(ring) for ring in polygon.interior_rings]
    # Both ends of the floor lie outside the old seed-centred square crop.
    assert point_in_polygon((50, 150), outer, holes)
    assert point_in_polygon((550, 150), outer, holes)
    assert point_in_polygon((300, 150), outer, holes)
    assert not point_in_polygon((300, 100), outer, holes)


def test_floor_selection_annotation_uses_downscaled_provider_coordinates(tmp_path, monkeypatch):
    image_path = tmp_path / "corrected.png"
    cv2.imwrite(str(image_path), np.full((800, 2400, 3), 200, np.uint8))

    async def fake_openrouter(self, image_bytes, mime_type, prompt):
        provider_input = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        assert provider_input.shape[:2] == (682, 2048)
        assert tuple(provider_input[512, 1536]) == (0, 0, 255)
        assert tuple(provider_input[600, 1800]) == (200, 200, 200)
        assert "x=1536.0, y=511.5" in prompt
        return cv2.imencode(".png", np.zeros((682, 2048, 3), np.uint8))[1].tobytes()

    monkeypatch.setattr(AITracer, "_mask_via_openrouter", fake_openrouter)
    tracer = AITracer(openrouter_key="test-key", openrouter_image_model="google/gemini-3-pro-image")
    polygon, _ = asyncio.run(tracer.trace_drawer_floor(str(image_path), "key", focus=(1800, 600)))

    assert polygon is None
