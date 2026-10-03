"""Packing invariants for the auto-layout service."""

import math
import time

import pytest
from shapely.geometry import Polygon

from app.services.auto_layout import auto_layout, layout_bounds


def _box(x0, y0, x1, y1):
    return Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])


def test_layout_keeps_clearance_and_reports_min_corner():
    from shapely.affinity import rotate, translate

    tools = [
        {"id": "a", "name": "a", "polygon": _box(-30, -10, 30, 10)},
        {"id": "b", "name": "b", "polygon": _box(-15, -40, 15, 40)},
        {"id": "c", "name": "c", "polygon": Polygon([(0, 0), (40, 0), (40, 10), (20, 10), (20, 25), (0, 25)])},
    ]
    placed = auto_layout(tools, clearance=2.0)

    assert {p.tool_id for p in placed} == {"a", "b", "c"}
    for p in placed:
        # x/y must be the placed polygon's min corner: the bin editor aligns
        # each tool's min corner to the reported position
        bx0, by0, _, _ = p.polygon.bounds
        assert (p.x, p.y) == pytest.approx((bx0, by0))
        assert 0.0 <= p.rotation < 360.0
        original = next(tool["polygon"] for tool in tools if tool["id"] == p.tool_id)
        rotated = rotate(original, p.rotation, origin=(0, 0))
        left, top, _, _ = rotated.bounds
        expected = translate(rotated, p.x - left, p.y - top)
        assert p.polygon.symmetric_difference(expected).area < 1e-8

    for i, a in enumerate(placed):
        for b in placed[i + 1:]:
            assert a.polygon.intersection(b.polygon).area == 0
            assert a.polygon.distance(b.polygon) >= 2.0 - 1e-6


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


@pytest.mark.parametrize("algorithm", ["raster", "packingsolver", "auto"])
def test_long_tool_fits_square_bin_by_rotating(algorithm):
    # 60x10 fits a 50x50 bin only at an angle: the packer must try rotations
    tools = [{"id": "long", "name": "long", "polygon": _box(-30, -5, 30, 5)}]
    placed = auto_layout(tools, clearance=0.0, bin_width=50.0, bin_depth=50.0,
                         algorithm=algorithm, time_budget_seconds=2)

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


def test_large_target_does_not_exhaust_proxy_time_budget():
    # A detailed outline in a mostly empty bin used to trigger hundreds of
    # thousands of translations and polygon differences, timing out the proxy.
    outline = Polygon([
        (60 * math.cos(i * math.tau / 144), 20 * math.sin(i * math.tau / 144))
        for i in range(144)
    ])
    started = time.monotonic()
    placed = auto_layout(
        [{"id": "ellipse", "name": "ellipse", "polygon": outline}],
        bin_width=600, bin_depth=500, time_budget_seconds=2,
    )
    assert time.monotonic() - started < 2.45
    item, = placed
    assert item.polygon.area == pytest.approx(outline.area)
    assert item.polygon.bounds[0] >= -1e-6 and item.polygon.bounds[1] >= -1e-6
    assert item.polygon.bounds[2] <= 600
    assert item.polygon.bounds[3] <= 500


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
    assert data["grid_x"] is None
    reported_unfitted = set(data["unfitted_tool_ids"])
    assert len(reported_unfitted) == len(unfitted)
    assert reported_unfitted <= set(outlines)
    assert {p["tool_id"] for p in data["placements"]} == set(outlines) - {"empty"}
    final_outlines = []
    for placement in data["placements"]:
        original = rotate(outlines[placement["tool_id"]], placement["rotation"])
        left, top, _, _ = original.bounds
        final_outlines.append(translate(original, placement["x"] - left, placement["y"] - top))
    for index, final in enumerate(final_outlines):
        for other in final_outlines[index + 1:]:
            assert final.intersection(other).area < 1e-8
    if config:
        # Default 1x1 bin: 41.5mm exterior, 2.6mm lip inset on each side.
        for placement in data["placements"]:
            outline = rotate(outlines[placement["tool_id"]], placement["rotation"])
            x0, y0, _, _ = outline.bounds
            final = translate(outline, placement["x"] - x0, placement["y"] - y0)
            x0, y0, x1, y1 = final.bounds
            fits = x0 >= 2.85 - 1e-6 and y0 >= 2.85 - 1e-6 and x1 <= 39.15 + 1e-6 and y1 <= 39.15 + 1e-6
            assert fits == (placement["tool_id"] not in reported_unfitted)
        if "long" in outlines:
            assert data["placements"][0]["rotation"] not in (0, 90, 180, 270)


@pytest.mark.parametrize("clearance", [None, 0, 4.5])
def test_endpoint_keeps_selected_outline_gap(tmp_path, monkeypatch, clearance):
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
    outlines = {tool_id: _box(-5, -5, 5, 5) for tool_id in "abc"}
    for tool_id, outline in outlines.items():
        tools.set(tool_id, Tool(
            id=tool_id,
            name=tool_id,
            points=[{"x": x, "y": y} for x, y in list(outline.exterior.coords)[:-1]],
        ))
    request = {"tool_ids": list(outlines), "bin_config": {"grid_x": 2, "grid_y": 2}}
    if clearance is not None:
        request["clearance"] = clearance

    response = TestClient(app).post("/api/bins/auto-layout", json=request)
    assert response.status_code == 200
    assert response.json()["unfitted_tool_ids"] == []
    final = []
    for placement in response.json()["placements"]:
        outline = rotate(outlines[placement["tool_id"]], placement["rotation"])
        x0, y0, _, _ = outline.bounds
        final.append(translate(outline, placement["x"] - x0, placement["y"] - y0))
    left = min(outline.bounds[0] for outline in final)
    top = min(outline.bounds[1] for outline in final)
    right = max(outline.bounds[2] for outline in final)
    bottom = max(outline.bounds[3] for outline in final)
    assert (left + right) / 2 == pytest.approx(42)
    assert (top + bottom) / 2 == pytest.approx(42)
    expected_gap = 1 if clearance is None else clearance
    gaps = []
    for index, outline in enumerate(final):
        for other in final[index + 1:]:
            assert outline.intersection(other).area == pytest.approx(0)
            gaps.append(outline.distance(other))
    assert min(gaps) >= expected_gap - 1e-6


@pytest.mark.parametrize("clearance", [-1, "NaN", "Infinity", "-Infinity"])
def test_endpoint_rejects_invalid_outline_gap(clearance):
    from fastapi.testclient import TestClient

    from app.main import app

    response = TestClient(app).post("/api/bins/auto-layout", json={"clearance": clearance})
    assert response.status_code == 400
    assert response.json()["detail"] == "tool padding must be finite and non-negative"


@pytest.fixture
def auto_width_request(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    import app.api.routes as routes
    from app.config import ensure_user_dirs, settings
    from app.main import app
    from app.models.schemas import Tool

    monkeypatch.setattr(settings, "storage_path", tmp_path)
    monkeypatch.setattr(routes, "_store_cache", {})
    ensure_user_dirs(tmp_path / "default")
    _, store, _ = routes.get_stores("default")
    client = TestClient(app)

    def request(outlines, config, algorithm="auto"):
        for tool_id, outline in outlines.items():
            store.set(tool_id, Tool(
                id=tool_id, name=tool_id,
                points=[{"x": x, "y": y} for x, y in list(outline.exterior.coords)[:-1]],
            ))
        response = client.post("/api/bins/auto-layout", json={
            "tool_ids": list(outlines), "bin_config": config, "auto_width": True,
            "algorithm": algorithm, "clearance": 0, "time_budget_seconds": 2,
        })
        assert response.status_code == 200, response.text
        return response.json()

    return request


def _assert_auto_width_interior(data, outlines, config):
    from shapely.affinity import rotate, translate

    from app.constants import GF_GRID
    from app.models.schemas import BinConfig
    from app.services.stl_generator_manifold import _interior_clip_rect

    chosen = BinConfig(**{**config, "grid_x": data["grid_x"]})
    clip = translate(_interior_clip_rect(chosen), chosen.grid_x * GF_GRID / 2, chosen.grid_y * GF_GRID / 2)
    usable = clip.buffer(-chosen.cutout_clearance)
    final = []
    for placement in data["placements"]:
        outline = rotate(outlines[placement["tool_id"]], placement["rotation"])
        x, y, _, _ = outline.bounds
        polygon = translate(outline, placement["x"] - x, placement["y"] - y)
        assert usable.buffer(1e-6).covers(polygon) == (placement["tool_id"] not in data["unfitted_tool_ids"])
        for previous in final:
            assert polygon.intersection(previous).area < 1e-6
        final.append(polygon)


@pytest.mark.parametrize("algorithm", ["auto", "raster", "packingsolver"])
@pytest.mark.parametrize("old_width", [1, 10])
def test_auto_width_expands_or_shrinks_without_changing_depth(auto_width_request, algorithm, old_width):
    outlines = {tool_id: _box(0, 0, 50, 50) for tool_id in "abc"}
    config = {"grid_x": old_width, "grid_y": 2}
    data = auto_width_request(outlines, config, algorithm)
    assert data["grid_x"] == 4
    assert data["unfitted_tool_ids"] == []
    _assert_auto_width_interior(data, outlines, config)


@pytest.mark.parametrize(("half_grid", "expected"), [(False, 2), (True, 1.5)])
def test_auto_width_snaps_with_physical_margins(auto_width_request, half_grid, expected):
    outlines = {"box": _box(0, 0, 50, 50)}
    config = {"grid_x": 1, "grid_y": 2, "half_grid_base": half_grid,
              "stacking_lip": False, "wall_thickness": 5, "cutout_clearance": 1}
    data = auto_width_request(outlines, config)
    assert data["grid_x"] == expected
    _assert_auto_width_interior(data, outlines, config)


@pytest.mark.parametrize("algorithm", ["auto", "raster", "packingsolver"])
def test_auto_width_cannot_expand_fixed_depth(auto_width_request, algorithm):
    outlines = {"too-deep": _box(0, 0, 80, 80), "fits": _box(0, 0, 20, 20)}
    config = {"grid_x": 1, "grid_y": 2}
    data = auto_width_request(outlines, config, algorithm)
    assert data["grid_x"] == 1
    assert data["unfitted_tool_ids"] == ["too-deep"]
    _assert_auto_width_interior(data, outlines, config)


@pytest.mark.parametrize(("depth", "side", "count"), [(1, 30, 40), (5, 150, 6)])
def test_auto_width_respects_axis_and_cell_caps(auto_width_request, depth, side, count):
    outlines = {str(index): _box(0, 0, side, side) for index in range(count)}
    config = {"grid_x": 1, "grid_y": depth}
    data = auto_width_request(outlines, config)
    assert 1 <= data["grid_x"] <= 25
    assert math.ceil(data["grid_x"]) * math.ceil(depth) <= 100
    assert data["unfitted_tool_ids"]
    assert len(data["unfitted_tool_ids"]) < count
    _assert_auto_width_interior(data, outlines, config)


@pytest.mark.parametrize(("config", "status"), [
    (None, 400),
    ({"grid_y": 0}, 422),
    ({"grid_x": 26, "grid_y": 1}, 422),
    ({"grid_x": 5, "grid_y": 25}, 422),
    ({"grid_y": 2, "wall_thickness": "NaN"}, 400),
    ({"grid_y": 2, "cutout_clearance": "NaN"}, 400),
])
def test_auto_width_rejects_invalid_request(config, status):
    from fastapi.testclient import TestClient

    from app.main import app

    response = TestClient(app).post("/api/bins/auto-layout", json={"auto_width": True, "bin_config": config})
    assert response.status_code == status


def test_auto_width_prefers_narrower_occupied_bounds_over_smaller_area():
    from app.services.auto_layout_geometry import LayoutGeometry

    tools = [{"id": tool_id, "name": tool_id, "polygon": _box(0, 0, 10, 10)} for tool_id in "abc"]
    geometry = LayoutGeometry(tools, 0, 100, 100, auto_width=True)
    shorter = geometry.complete(geometry.validate([[0, 0, 0, 0], [1, 10, 0, 0]]))
    narrower = geometry.complete(geometry.validate([[0, 0, 0, 0], [1, 0, 30, 0]]))
    assert geometry.score(narrower) == (-2, 10)
    assert geometry.score(narrower) < geometry.score(shorter)
    more_fitted = geometry.validate([[0, 0, 0, 0], [1, 10, 0, 0], [2, 20, 0, 0]])
    assert geometry.score(more_fitted) < geometry.score(narrower)


@pytest.fixture
def pinned_client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    import app.api.routes as routes
    from app.config import ensure_user_dirs, settings
    from app.main import app
    from app.models.schemas import Tool

    monkeypatch.setattr(settings, "storage_path", tmp_path)
    monkeypatch.setattr(routes, "_store_cache", {})
    ensure_user_dirs(tmp_path / "default")
    _, tools, bins = routes.get_stores("default")
    for tool_id in ("anchor", "other"):
        tools.set(tool_id, Tool(id=tool_id, name=tool_id, points=[
            {"x": x, "y": y} for x, y in [(0, 0), (10, 0), (10, 10), (0, 10)]
        ]))
    tools.set("empty", Tool(id="empty", name="empty", points=[]))
    return TestClient(app), bins


@pytest.mark.parametrize("auto_width", [False, True])
@pytest.mark.parametrize("all_pinned", [False, True])
def test_endpoint_preserves_pin_in_bin_coordinates_and_sizes_from_anchor(pinned_client, auto_width, all_pinned):
    client, _ = pinned_client
    pin = {"tool_id": "anchor", "x": 100.25, "y": 20.5, "rotation": 387}
    response = client.post("/api/bins/auto-layout", json={
        "tool_ids": ["anchor"] if all_pinned else ["anchor", "other"],
        "bin_config": {"grid_x": 10, "grid_y": 2}, "auto_width": auto_width,
        "fixed_placements": [pin], "time_budget_seconds": 2,
    })
    assert response.status_code == 200, response.text
    data = response.json()
    anchor = next(p for p in data["placements"] if p["tool_id"] == "anchor")
    assert {key: anchor[key] for key in pin} == pin
    assert data["unfitted_tool_ids"] == []
    if auto_width:
        assert data["grid_x"] == 3
    else:
        assert data["grid_x"] is None


@pytest.mark.parametrize(("pins", "tool_ids", "config", "status"), [
    ([{"tool_id": "anchor", "x": 1, "y": 10, "rotation": 0}], ["anchor"], {}, 400),
    ([{"tool_id": "anchor", "x": 10, "y": 10, "rotation": 0},
      {"tool_id": "other", "x": 20.5, "y": 10, "rotation": 0}], ["anchor", "other"], {}, 400),
    ([{"tool_id": "anchor", "x": 10, "y": 10, "rotation": 0},
      {"tool_id": "other", "x": 15, "y": 10, "rotation": 0}], ["anchor", "other"], {}, 400),
    ([{"tool_id": "anchor", "x": 10, "y": 10, "rotation": 0}] * 2, ["anchor"], {}, 400),
    ([{"tool_id": "empty", "x": 10, "y": 10, "rotation": 0}], ["empty"], {}, 400),
    ([{"tool_id": "other", "x": 10, "y": 10, "rotation": 0}], ["anchor"], {}, 400),
    ([{"tool_id": "missing", "x": 10, "y": 10, "rotation": 0}], ["missing"], {}, 404),
    ([{"tool_id": "anchor", "x": "NaN", "y": 10, "rotation": 0}], ["anchor"], {}, 422),
    ([{"tool_id": "anchor", "x": 10, "y": "Infinity", "rotation": 0}], ["anchor"], {}, 422),
    ([{"tool_id": "anchor", "x": 10, "y": 10, "rotation": "-Infinity"}], ["anchor"], {}, 422),
    ([{"tool_id": "anchor", "x": 10, "y": 10, "rotation": 0}], ["anchor"], None, 400),
])
def test_endpoint_rejects_invalid_pins_without_relocating_them(pinned_client, pins, tool_ids, config, status):
    client, _ = pinned_client
    response = client.post("/api/bins/auto-layout", json={
        "tool_ids": tool_ids, "fixed_placements": pins, "bin_config": config,
    })
    assert response.status_code == status


def test_pin_flag_survives_save_reload_and_library_sync(pinned_client):
    import app.api.routes as routes
    from app.models.schemas import BinModel, PlacedTool

    client, bins = pinned_client
    bins.set("bin", BinModel(id="bin", placed_tools=[
        PlacedTool(id="placement", tool_id="anchor", name="anchor", points=[
            {"x": 10, "y": 10}, {"x": 20, "y": 10}, {"x": 20, "y": 20}, {"x": 10, "y": 20},
        ]),
    ]))
    legacy = client.get("/api/bins/bin").json()["placed_tools"][0]
    assert legacy["pinned"] is False
    response = client.put("/api/bins/bin", json={"placed_tools": [{**legacy, "pinned": True}]})
    assert response.status_code == 200
    routes._store_cache.clear()
    reloaded = client.get("/api/bins/bin").json()["placed_tools"][0]
    assert reloaded["pinned"] is True
    response = client.put("/api/bins/bin", json={"placed_tools": [{**reloaded, "pinned": False}]})
    assert response.status_code == 200
    routes._store_cache.clear()
    assert client.get("/api/bins/bin").json()["placed_tools"][0]["pinned"] is False


@pytest.mark.parametrize("pin_both", [False, True])
def test_endpoint_pins_duplicate_library_copies_independently(pinned_client, pin_both):
    from shapely.affinity import rotate, translate

    client, _ = pinned_client
    pins = [{"tool_id": "anchor", "placement_id": "first", "x": 10.25, "y": 20.5, "rotation": 387}]
    if pin_both:
        pins.append({"tool_id": "anchor", "placement_id": "second", "x": 50.25, "y": 30.5, "rotation": 90})
    response = client.post("/api/bins/auto-layout", json={
        "tool_ids": ["anchor", "anchor", "other"],
        "placement_ids": ["first", "second", "third"],
        "fixed_placements": pins, "bin_config": {"grid_x": 3, "grid_y": 2},
        "time_budget_seconds": 2,
    })
    assert response.status_code == 200, response.text
    data = response.json()
    placements = {p["placement_id"]: p for p in data["placements"]}
    assert {key: p["tool_id"] for key, p in placements.items()} == {
        "first": "anchor", "second": "anchor", "third": "other",
    }
    assert data["unfitted_tool_ids"] == []
    for pin in pins:
        assert {key: placements[pin["placement_id"]][key] for key in pin} == pin
    outlines = []
    for placement in placements.values():
        polygon = rotate(_box(0, 0, 10, 10), placement["rotation"], origin=(0, 0))
        left, top, _, _ = polygon.bounds
        polygon = translate(polygon, placement["x"] - left, placement["y"] - top)
        for previous in outlines:
            assert polygon.intersection(previous).area < 1e-6
            assert polygon.distance(previous) >= 1 - 1e-6
        outlines.append(polygon)


def test_endpoint_reports_unfitted_copy_when_its_sibling_fits(pinned_client):
    import app.api.routes as routes
    from app.models.schemas import Tool

    client, _ = pinned_client
    _, tools, _ = routes.get_stores("default")
    tools.set("anchor", Tool(id="anchor", name="anchor", points=[
        {"x": x, "y": y} for x, y in [(0, 0), (30, 0), (30, 30), (0, 30)]
    ]))
    response = client.post("/api/bins/auto-layout", json={
        "tool_ids": ["anchor", "anchor", "anchor"],
        "placement_ids": ["first", "second", "third"],
        "fixed_placements": [{
            "tool_id": "anchor", "placement_id": "first", "x": 3, "y": 3, "rotation": 0,
        }],
        "bin_config": {"grid_x": 1, "grid_y": 1}, "time_budget_seconds": 2,
    })
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["unfitted_tool_ids"] == ["anchor", "anchor"]
    assert data["unfitted_placement_ids"] == ["second", "third"]
    assert {p["placement_id"] for p in data["placements"]} == {"first", "second", "third"}


@pytest.mark.parametrize(("identities", "pin"), [
    (["first"], None),
    (["first", "first"], None),
    (["first", " "], None),
    (["first", "second"], {"tool_id": "anchor"}),
    (["first", "second"], {"tool_id": "anchor", "placement_id": "missing"}),
    (["first", "second"], {"tool_id": "other", "placement_id": "first"}),
    (None, {"tool_id": "anchor", "placement_id": "first"}),
])
def test_endpoint_rejects_invalid_instance_identity(pinned_client, identities, pin):
    client, _ = pinned_client
    response = client.post("/api/bins/auto-layout", json={
        "tool_ids": ["anchor", "anchor"], "placement_ids": identities,
        "fixed_placements": [{**pin, "x": 10, "y": 10, "rotation": 0}] if pin else [],
        "bin_config": {"grid_x": 2, "grid_y": 2},
    })
    assert response.status_code == 400, response.text
