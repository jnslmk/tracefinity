"""Packing invariants for the auto-layout service."""

import pytest
from shapely.geometry import Polygon

from app.services.auto_layout import auto_layout, layout_bounds


def _box(x0, y0, x1, y1):
    return Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])


def test_layout_keeps_clearance_and_reports_min_corner():
    tools = [
        {"id": "a", "name": "a", "polygon": _box(-30, -10, 30, 10)},
        {"id": "b", "name": "b", "polygon": _box(-15, -40, 15, 40)},
        {"id": "c", "name": "c", "polygon": Polygon([(0, 0), (40, 0), (40, 10), (20, 10), (20, 25), (0, 25)])},
    ]
    placed = auto_layout(tools, clearance=2.0)

    assert [p.tool_id for p in placed] == ["a", "b", "c"]
    for p in placed:
        # x/y must be the placed polygon's min corner: the bin editor aligns
        # each tool's min corner to the reported position
        bx0, by0, _, _ = p.polygon.bounds
        assert (p.x, p.y) == pytest.approx((bx0, by0))
        assert 0.0 <= p.rotation < 360.0

    for i, a in enumerate(placed):
        for b in placed[i + 1:]:
            assert a.polygon.distance(b.polygon) >= 2.0 - 0.01

    minx, miny, _, _ = layout_bounds(placed)
    assert (minx, miny) == pytest.approx((0.0, 0.0))


def test_layout_stays_inside_bin_target():
    tools = [
        {"id": "a", "name": "a", "polygon": _box(-30, -10, 30, 10)},
        {"id": "b", "name": "b", "polygon": _box(-15, -40, 15, 40)},
        {"id": "c", "name": "c", "polygon": _box(-25, -12, 25, 12)},
    ]
    placed = auto_layout(tools, clearance=1.0, bin_width=140.0, bin_depth=120.0)

    assert len(placed) == 3
    for p in placed:
        x0, y0, x1, y1 = p.polygon.bounds
        assert x0 >= -1e-6 and y0 >= -1e-6
        assert x1 <= 140.0 + 1e-6 and y1 <= 120.0 + 1e-6


def test_long_tool_fits_square_bin_by_rotating():
    # 60x10 fits a 50x50 bin only at an angle: the packer must try rotations
    tools = [{"id": "long", "name": "long", "polygon": _box(-30, -5, 30, 5)}]
    placed = auto_layout(tools, clearance=0.0, bin_width=50.0, bin_depth=50.0)

    assert len(placed) == 1
    x0, y0, x1, y1 = placed[0].polygon.bounds
    assert x1 - x0 <= 50.0 + 1e-6 and y1 - y0 <= 50.0 + 1e-6
    assert placed[0].rotation not in (0.0, 90.0, 180.0, 270.0)


def test_layout_is_dense():
    # three identical bars must close-pack: the bbox cannot exceed the ideal
    tools = [{"id": c, "name": c, "polygon": _box(-25, -10, 25, 10)} for c in "abc"]
    placed = auto_layout(tools, clearance=0.0)

    minx, miny, maxx, maxy = layout_bounds(placed)
    assert (maxx - minx) * (maxy - miny) == pytest.approx(3000.0, rel=0.01)


def test_empty_outline_is_skipped():
    tools = [
        {"id": "empty", "name": "empty", "polygon": Polygon()},
        {"id": "real", "name": "real", "polygon": _box(0, 0, 10, 10)},
    ]
    placed = auto_layout(tools)
    assert [p.tool_id for p in placed] == ["real"]
