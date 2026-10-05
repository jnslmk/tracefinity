import asyncio

import cv2
import numpy as np
from shapely.geometry import Point, Polygon

from app.services.ai_tracer import AITracer


def test_trace_keeps_thin_tools_but_rejects_mask_specks(tmp_path, monkeypatch):
    mask = np.full((1538, 2048), 255, dtype=np.uint8)
    cv2.fillPoly(mask, [np.array([
        (100, 100), (500, 85), (500, 89),
        (110, 100), (500, 115), (500, 119),
    ], dtype=np.int32)], 0)
    cv2.rectangle(mask, (700, 100), (850, 300), 0, -1)
    cv2.rectangle(mask, (1000, 100), (1004, 104), 0, -1)
    mask_path = tmp_path / "mask.png"
    original_path = tmp_path / "photo.png"
    cv2.imwrite(str(mask_path), mask)
    cv2.imwrite(str(original_path), np.full((1538, 2048, 3), 255, dtype=np.uint8))

    async def generated_mask(*args, **kwargs):
        return str(mask_path)

    tracer = AITracer()
    monkeypatch.setattr(tracer, "_generate_mask_gemini", generated_mask)
    outlines, _ = asyncio.run(tracer.trace_tools(str(original_path), api_key=""))
    shapes = [Polygon([(p.x, p.y) for p in outline.points]) for outline in outlines]

    assert len(shapes) == 2
    tweezers = next(shape for shape in shapes if shape.bounds[0] < 200)
    assert tweezers.covers(Point(300, 93))
    assert tweezers.covers(Point(300, 109))
    assert tweezers.covers(Point(110, 100))
    assert not tweezers.covers(Point(300, 100))
    assert tweezers.bounds[2] >= 490
