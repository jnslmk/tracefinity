"""Paper boundaries must exclude bright wood and metal tools crossing an edge."""

import cv2
import numpy as np
import pytest

from app.services.image_processor import ImageProcessor


@pytest.mark.parametrize("scale", [0.5, 1.0, 2.0])
def test_sheet_on_bright_wood_with_protruding_tools(tmp_path, scale):
    image = np.full((1000, 800, 3), (110, 190, 225), np.uint8)
    for y in range(0, 1000, 100):
        cv2.rectangle(image, (0, y), (799, y + 40), (135, 210, 245), -1)
    expected = np.array([(200, 250), (550, 265), (530, 760), (180, 745)])
    cv2.fillPoly(image, [expected.astype(np.int32)], (220, 215, 210))
    # A silver caliper crosses the top edge; its wide head lies off the paper.
    cv2.rectangle(image, (280, 160), (295, 520), (225, 225, 225), -1)
    cv2.rectangle(image, (250, 150), (325, 175), (225, 225, 225), -1)
    # Dark objects obscure the sheet without hiding its four corners.
    cv2.rectangle(image, (410, 330), (490, 470), (35, 35, 35), -1)
    cv2.rectangle(image, (360, 570), (475, 670), (40, 40, 40), -1)
    cv2.rectangle(image, (265, 710), (280, 820), (40, 40, 40), -1)
    # A separate white object must not enlarge the paper's bounding rectangle.
    cv2.rectangle(image, (270, 850), (330, 950), (220, 220, 220), -1)
    image = cv2.resize(image, None, fx=scale, fy=scale)
    path = tmp_path / "photo.png"
    cv2.imwrite(str(path), image)
    processor = ImageProcessor.__new__(ImageProcessor)
    processor._tool_mask_session = None

    corners = processor.detect_paper_corners(str(path))

    assert corners is not None
    np.testing.assert_allclose(corners, expected * scale, atol=8 * scale)
