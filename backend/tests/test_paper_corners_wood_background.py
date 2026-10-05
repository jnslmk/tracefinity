"""Paper boundaries must exclude bright wood and metal tools crossing an edge."""

from pathlib import Path

import cv2
import numpy as np
import pytest

from app.services.image_processor import ImageProcessor


@pytest.mark.parametrize("paper_color", [(220, 215, 210), (250, 195, 165)])
@pytest.mark.parametrize("scale", [0.5, 1.0, 2.0])
def test_sheet_on_bright_wood_with_protruding_tools(tmp_path, scale, paper_color):
    image = np.full((1000, 800, 3), (110, 190, 225), np.uint8)
    for y in range(0, 1000, 100):
        cv2.rectangle(image, (0, y), (799, y + 40), (135, 210, 245), -1)
    expected = np.array([(200, 250), (550, 265), (530, 760), (180, 745)])
    cv2.fillPoly(image, [expected.astype(np.int32)], paper_color)
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


@pytest.mark.parametrize("exposure", [0.65, 0.85, 1.0])
@pytest.mark.parametrize("scale", [0.5, 1.0, 2.0])
@pytest.mark.parametrize(
    ("photo", "expected"),
    [
        ("paper_cool_cast", [(91, 199), (444, 200), (444, 450), (94, 450)]),
        ("paper_cool_cast_drill", [(218, 258), (509, 258), (510, 667), (219, 668)]),
        ("paper_wood_caliper", [(289, 250), (609, 263), (590, 710), (271, 697)]),
        ("paper_wood_pliers", [(287, 246), (595, 256), (581, 688), (279, 681)]),
    ],
)
def test_real_photos_keep_corners_on_the_sheet(tmp_path, photo, expected, scale, exposure):
    image = cv2.imread(str(Path(__file__).parent / "fixtures" / f"{photo}.jpg"))
    image = cv2.resize(image, None, fx=scale, fy=scale)
    image = (image.astype(np.float32) * exposure).astype(np.uint8)
    path = tmp_path / "photo.png"
    cv2.imwrite(str(path), image)
    processor = ImageProcessor.__new__(ImageProcessor)
    processor._tool_mask_session = None

    corners = processor.detect_paper_corners(str(path))

    assert corners is not None
    # Hand-labelled sheet corners, not detector-generated snapshots.
    np.testing.assert_allclose(corners, np.array(expected) * scale, atol=10 * scale)


@pytest.mark.parametrize("scene", ["black", "tools_without_paper"])
def test_missing_sheet_does_not_produce_calibration_corners(tmp_path, scene):
    if scene == "black":
        image = np.zeros((800, 1000, 3), np.uint8)
    else:
        image = cv2.imread(
            str(Path(__file__).parent / "fixtures" / "paper_cool_cast_drill.jpg")
        )[:, 550:]
    path = tmp_path / "photo.png"
    cv2.imwrite(str(path), image)
    processor = ImageProcessor.__new__(ImageProcessor)
    processor._tool_mask_session = None

    assert processor.detect_paper_corners(str(path)) is None
