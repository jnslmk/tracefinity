"""Regression for #213: on a bright sheet against a dark background U2-Net
returns the sheet as the salient object, and blacking it out left nothing
for paper detection to find."""

import cv2
import numpy as np
import pytest

from app.services.image_processor import ImageProcessor


@pytest.mark.parametrize("sheet", [(150, 200, 1050, 1400), (350, 450, 850, 1150)])
@pytest.mark.parametrize("salient_object", ["sheet", "tool"])
def test_dark_background_sheet_survives_saliency_mask(
    tmp_path, monkeypatch, sheet, salient_object
):
    image = np.full((1600, 1200, 3), 30, np.uint8)
    cv2.rectangle(image, sheet[:2], sheet[2:], (245, 245, 245), -1)
    cv2.rectangle(image, (500, 600), (700, 800), (25, 25, 25), -1)
    path = tmp_path / "photo.png"
    cv2.imwrite(str(path), image)

    # Supply the external model's two possible interpretations of this scene.
    mask = np.zeros(image.shape[:2], np.uint8)
    if salient_object == "sheet":
        cv2.rectangle(mask, sheet[:2], sheet[2:], 255, -1)
    else:
        cv2.rectangle(mask, (500, 600), (700, 800), 255, -1)
    processor = ImageProcessor.__new__(ImageProcessor)
    processor._tool_mask_session = object()
    monkeypatch.setattr(processor, "_get_tool_mask", lambda _path: mask)

    corners = processor.detect_paper_corners(str(path))

    expected = [
        (sheet[0], sheet[1]), (sheet[2], sheet[1]),
        (sheet[2], sheet[3]), (sheet[0], sheet[3]),
    ]
    assert corners is not None
    np.testing.assert_allclose(corners, expected, atol=15)

