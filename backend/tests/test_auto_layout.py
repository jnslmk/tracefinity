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


@pytest.mark.parametrize(
    ("outlines", "config", "unfitted"),
    [
        ({"large": _box(0, 0, 60, 60)}, {"grid_x": 1, "grid_y": 1}, {"large"}),
        (
            {"a": _box(0, 0, 30, 30), "b": _box(0, 0, 30, 30)},
            {"grid_x": 1, "grid_y": 1},
            {"b"},
        ),
        ({"long": _box(0, 0, 45, 5)}, {"grid_x": 1, "grid_y": 1}, set()),
        (
            {"small": _box(0, 0, 10, 10), "empty": Polygon()},
            {"grid_x": 1, "grid_y": 1},
            {"empty"},
        ),
        (
            {"large": _box(0, 0, 60, 60), "empty": Polygon()},
            None,
            {"empty"},
        ),
    ],
)
def test_endpoint_reports_final_layout_fit(tmp_path, monkeypatch, outlines, config, unfitted):
    from fastapi.testclient import TestClient
    from shapely.affinity import rotate, translate

    import app.api.routes as routes
    from app.config import ensure_user_dirs, settings
    from app.main import app
    from app.models.schemas import Tool

    monkeypatch.setattr(settings, "storage_path", tmp_path)
    monkeypatch.setattr(routes, "_store_cache", {})
    ensure_user_dirs(tmp_path / "default")
    _, tools, _ = routes.get_stores("default")
    for tool_id, outline in outlines.items():
        tools.set(tool_id, Tool(
            id=tool_id,
            name=tool_id,
            points=[{"x": x, "y": y} for x, y in list(outline.exterior.coords)[:-1]],
        ))

    response = TestClient(app).post("/api/bins/auto-layout", json={
        "tool_ids": list(outlines),
        "clearance": 0,
        "bin_config": config,
    })
    assert response.status_code == 200
    data = response.json()
    assert set(data["unfitted_tool_ids"]) == unfitted
    assert {p["tool_id"] for p in data["placements"]} == set(outlines) - {"empty"}
    if config:
        # Default 1x1 bin: 41.5mm exterior, 2.6mm lip inset on each side.
        for placement in data["placements"]:
            outline = rotate(outlines[placement["tool_id"]], placement["rotation"])
            x0, y0, _, _ = outline.bounds
            final = translate(outline, placement["x"] - x0, placement["y"] - y0)
            x0, y0, x1, y1 = final.bounds
            fits = x0 >= 2.85 - 1e-6 and y0 >= 2.85 - 1e-6 and x1 <= 39.15 + 1e-6 and y1 <= 39.15 + 1e-6
            assert fits == (placement["tool_id"] not in unfitted)
        if "long" in outlines:
            assert data["placements"][0]["rotation"] not in (0, 90, 180, 270)
