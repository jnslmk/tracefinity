"""Bin-local finger-access pockets: schema boundaries and generated geometry.

These cover the physical shape (curved scoop vs. straight extrusion, opening-edge
finish, floor/wall protection), the validation boundaries, and end-to-end
persistence and pocket-only generation through the API.
"""

import math

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.api.routes as routes
from app.config import ensure_user_dirs, settings
from app.main import app
from app.models.schemas import AccessPocket, GenerateRequest
from app.services.stl_generator_manifold import (
    GF_BASE_HEIGHT,
    GF_GRID,
    GF_HEIGHT_UNIT,
    ManifoldSTLGenerator,
    _build_access_pocket,
    _resolve_access_pocket_edge,
)

# --- validation boundaries ---

def test_defaults_match_contract():
    pocket = AccessPocket(id="p", x=10, y=10)
    assert pocket.shape == "rectangle"
    assert pocket.edge == "inherit"
    assert (pocket.corner_radius, pocket.bottom_radius) == (0.0, 0.0)


@pytest.mark.parametrize("kwargs", [
    {"length": 0}, {"width": -1}, {"depth": 0},
    {"length": float("inf")}, {"y": float("nan")},
])
def test_rejects_non_finite_and_non_positive_sizes(kwargs):
    with pytest.raises(ValidationError):
        AccessPocket(id="p", **{"x": 0.0, "y": 0.0, **kwargs})


def test_rejects_impossible_corner_and_bottom_radii():
    with pytest.raises(ValidationError):
        AccessPocket(id="p", x=0, y=0, length=20, width=10, corner_radius=6)
    with pytest.raises(ValidationError):
        AccessPocket(id="p", x=0, y=0, length=40, width=40, depth=5, bottom_radius=6)
    # a corner radius at exactly half the smaller dimension is allowed
    AccessPocket(id="p", x=0, y=0, length=20, width=10, corner_radius=5)


def test_rejects_edge_size_at_or_beyond_depth():
    with pytest.raises(ValidationError):
        AccessPocket(id="p", x=0, y=0, depth=5, edge="chamfer", edge_size=5)
    # inherit is not bounded here; the generator clamps the bin chamfer instead
    AccessPocket(id="p", x=0, y=0, depth=5, edge="inherit", edge_size=5)


def test_scoop_has_no_redundant_radii():
    with pytest.raises(ValidationError):
        AccessPocket(id="p", x=0, y=0, shape="scoop", corner_radius=2)
    with pytest.raises(ValidationError):
        AccessPocket(id="p", x=0, y=0, shape="scoop", bottom_radius=2)
    scoop = AccessPocket(id="p", x=0, y=0, shape="scoop")
    assert scoop.shape == "scoop"


# --- opening-edge resolution ---

def test_sharp_edge_overrides_the_bin_chamfer():
    pocket = AccessPocket(id="p", x=0, y=0, edge="sharp")
    assert _resolve_access_pocket_edge(pocket, bin_chamfer=3.0, depth=10) is None


def test_inherit_uses_and_clamps_the_bin_chamfer():
    pocket = AccessPocket(id="p", x=0, y=0, edge="inherit")
    assert _resolve_access_pocket_edge(pocket, bin_chamfer=3.0, depth=10) == ("chamfer", 3.0)
    # a shallow pocket clamps the chamfer, never the usable opening
    assert _resolve_access_pocket_edge(pocket, bin_chamfer=8.0, depth=5) == ("chamfer", 4.0)
    assert _resolve_access_pocket_edge(pocket, bin_chamfer=0.0, depth=10) is None


def test_explicit_edge_kind_and_clamp():
    pocket = AccessPocket(id="p", x=0, y=0, edge="fillet", edge_size=2.0)
    assert _resolve_access_pocket_edge(pocket, bin_chamfer=0.0, depth=10) == ("fillet", 2.0)
    # an inherit chamfer on a shallow pocket is clamped below the depth
    shallow = AccessPocket(id="p", x=0, y=0, edge="inherit")
    kind, size = _resolve_access_pocket_edge(shallow, bin_chamfer=8.0, depth=5)
    assert kind == "chamfer" and size < 5


# --- geometry ---

def _slice_area(local, z):
    section = local.slice(z)
    return 0.0 if section.is_empty() else section.area()


def test_rectangle_pocket_removes_nominal_volume():
    pocket = AccessPocket(id="r", x=0, y=0, length=30, width=20, depth=10)
    local = _build_access_pocket(pocket, depth=10, edge=None)
    assert local.status().name == "NoError"
    # sharp-cornered rectangle: exactly length * width * depth
    assert local.volume() == pytest.approx(6000, rel=0.01)


def test_opening_edge_finish_widens_the_rim_not_the_usable_space():
    sharp = AccessPocket(id="s", x=0, y=0, length=30, width=20, depth=10, edge="sharp")
    chamfer = AccessPocket(id="c", x=0, y=0, length=30, width=20, depth=10, edge="chamfer", edge_size=2.0)
    sharp_local = _build_access_pocket(sharp, depth=10, edge=None)
    chamfer_local = _build_access_pocket(chamfer, depth=10, edge=("chamfer", 2.0))
    # at the floor the two are identical (finishing only expands the opening)
    assert _slice_area(chamfer_local, -10 + 1e-3) == pytest.approx(
        _slice_area(sharp_local, -10 + 1e-3), rel=0.01
    )
    # at the rim the chamfered opening is larger by the widen amount
    assert _slice_area(chamfer_local, -1e-3) > _slice_area(sharp_local, -1e-3) + 100
    assert chamfer_local.volume() > sharp_local.volume()


def test_rectangle_bottom_radius_rolls_the_floor():
    plain = _build_access_pocket(
        AccessPocket(id="a", x=0, y=0, length=40, width=40, depth=10), depth=10, edge=None
    )
    filleted = _build_access_pocket(
        AccessPocket(id="b", x=0, y=0, length=40, width=40, depth=10, bottom_radius=4),
        depth=10, edge=None,
    )
    # the filleted floor cross-section is smaller at the very bottom and equal above the roll
    assert _slice_area(filleted, -9.999) < _slice_area(plain, -9.999) - 100
    assert _slice_area(filleted, -5) == pytest.approx(_slice_area(plain, -5), rel=0.01)


def test_scoop_is_a_curved_half_sausage_not_an_extrusion():
    length, width, depth = 36.0, 20.0, 8.0
    local = _build_access_pocket(
        AccessPocket(id="s", x=0, y=0, shape="scoop", length=length, width=width, depth=depth),
        depth=depth, edge=None,
    )
    assert local.status().name == "NoError"
    # cross-sections shrink with depth: a genuine curved trough, not a prism
    top = _slice_area(local, -1e-3)
    mid = _slice_area(local, -depth / 2)
    floor = _slice_area(local, -depth + 1e-3)
    assert top > mid > floor > 0
    # plan footprint at the rim is the requested stadium (length x width)
    radius = width / 2
    expected_top = (length - width) * width + math.pi * radius * radius
    assert top == pytest.approx(expected_top, rel=0.03)
    # volume matches the half-capsule squashed to the requested depth
    straight = length - width
    expected_volume = (0.5 * math.pi * radius ** 2 * straight + (2 / 3) * math.pi * radius ** 3) * (depth / radius)
    assert local.volume() == pytest.approx(expected_volume, rel=0.05)


def test_scoop_depth_is_independent_of_width():
    wide_shallow = _build_access_pocket(
        AccessPocket(id="a", x=0, y=0, shape="scoop", length=36, width=20, depth=4),
        depth=4, edge=None,
    )
    deep = _build_access_pocket(
        AccessPocket(id="b", x=0, y=0, shape="scoop", length=36, width=20, depth=10),
        depth=10, edge=None,
    )
    # same rim footprint regardless of depth
    assert _slice_area(wide_shallow, -1e-3) == pytest.approx(_slice_area(deep, -1e-3), rel=0.03)
    assert deep.volume() > wide_shallow.volume()
    assert wide_shallow.bounding_box()[5] == pytest.approx(0.0, abs=1e-3)
    assert wide_shallow.bounding_box()[2] == pytest.approx(-4.0, abs=1e-3)


# --- assembled bin: floor, wall and disabled-cell protection ---

def _bin_volume(config):
    body, _ = ManifoldSTLGenerator().generate_bin([], config, None)
    return body


def test_pocket_depth_clamped_to_protected_floor():
    base = GenerateRequest(grid_x=2, grid_y=2, height_units=4)
    baseline = _bin_volume(base).volume()
    deep = base.model_copy(deep=True)
    deep.access_pockets = [AccessPocket(id="deep", x=GF_GRID, y=GF_GRID, length=30, width=20, depth=500)]
    body = _bin_volume(deep)
    max_depth = 4 * GF_HEIGHT_UNIT - GF_BASE_HEIGHT - 2
    removed = baseline - body.volume()
    assert removed == pytest.approx(30 * 20 * max_depth, rel=0.02)
    # material remains below the pocket floor
    assert body.slice(GF_BASE_HEIGHT + 0.001).area() > 0


def test_pocket_at_the_edge_does_not_breach_the_wall():
    base = GenerateRequest(grid_x=2, grid_y=2, height_units=4)
    body_before = _bin_volume(base)
    edge = base.model_copy(deep=True)
    edge.access_pockets = [
        AccessPocket(id="edge", x=2, y=GF_GRID, length=30, width=20, depth=8)
    ]
    body_after = _bin_volume(edge)
    # outer bounding box is unchanged: the cutter was clipped to the interior
    assert body_after.bounding_box()[:3] == body_before.bounding_box()[:3]
    # less material removed than an unclipped pocket would take
    removed = body_before.volume() - body_after.volume()
    assert 0 < removed < 30 * 20 * 8 * 0.6


def test_pocket_only_bin_still_exports_a_solid():
    config = GenerateRequest(grid_x=2, grid_y=2, height_units=4)
    config.access_pockets = [
        AccessPocket(id="a", x=GF_GRID, y=GF_GRID, length=30, width=20, depth=8),
        AccessPocket(id="b", x=GF_GRID, y=GF_GRID, shape="scoop", length=32, width=18, depth=6),
    ]
    body = _bin_volume(config)
    assert body.status().name == "NoError"
    assert body.volume() > 0


def _material_volume(body, x0, x1, y0, y1, z0, z1):
    import manifold3d as mf

    probe = mf.Manifold.cube((x1 - x0, y1 - y0, z1 - z0), center=True).translate(
        ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    )
    return (body ^ probe).volume()


def _partition_probe():
    return (-22.6, -21.0, -10.0, 10.0, GF_BASE_HEIGHT, GF_BASE_HEIGHT + 8)


def _three_by_three(connect: bool, retain: bool) -> GenerateRequest:
    values = [True] * 9
    values[4] = False  # centre UI cell disabled
    return GenerateRequest(
        grid_x=3, grid_y=3, height_units=4, magnets=False,
        partial_bins=True, partial_bins_values=values,
        partial_bins_connect=connect, partial_bins_retain_wall=retain,
    )


def test_pocket_preserves_the_partition_next_to_a_disabled_cell():
    config = _three_by_three(connect=True, retain=True)
    baseline = _bin_volume(config)
    probe = _partition_probe()
    assert _material_volume(baseline, *probe) > 200

    pocketed = config.model_copy(deep=True)
    pocketed.access_pockets = [AccessPocket(id="p", x=31, y=63, length=30, width=20, depth=8)]
    body = _bin_volume(pocketed)
    # the cutter footprint crosses the enabled/disabled boundary; the retained
    # partition strip must survive
    assert _material_volume(body, *probe) == pytest.approx(
        _material_volume(baseline, *probe), rel=1e-6
    )


def test_pocket_preserves_the_partition_without_connect_mode():
    config = _three_by_three(connect=False, retain=False)
    baseline = _bin_volume(config)
    probe = _partition_probe()
    assert _material_volume(baseline, *probe) > 200

    pocketed = config.model_copy(deep=True)
    pocketed.access_pockets = [AccessPocket(id="p", x=31, y=63, length=30, width=20, depth=8)]
    body = _bin_volume(pocketed)
    assert _material_volume(body, *probe) == pytest.approx(
        _material_volume(baseline, *probe), rel=1e-6
    )


def test_pocket_preserves_a_disabled_corner_retained_wall():
    values = [True, True, True, False]  # UI (0,0) top-left disabled
    config = GenerateRequest(
        grid_x=2, grid_y=2, height_units=4, magnets=False,
        partial_bins=True, partial_bins_values=values,
        partial_bins_connect=True, partial_bins_retain_wall=True,
    )
    baseline = _bin_volume(config)
    probe = (-41.5, -39.5, 10.0, 30.0, GF_BASE_HEIGHT, GF_BASE_HEIGHT + 8)
    assert _material_volume(baseline, *probe) > 200

    pocketed = config.model_copy(deep=True)
    pocketed.access_pockets = [AccessPocket(id="p", x=2, y=21, length=30, width=20, depth=8)]
    body = _bin_volume(pocketed)
    assert _material_volume(body, *probe) == pytest.approx(
        _material_volume(baseline, *probe), rel=1e-6
    )


# --- persistence and isolation through the API ---

def _api_client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_path", tmp_path)
    monkeypatch.setattr(routes.settings, "storage_path", tmp_path)
    routes._store_cache.clear()
    routes._project_store_cache.clear()
    ensure_user_dirs(tmp_path / "default")
    return TestClient(app)


def test_pockets_persist_and_load_with_the_bin(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    created = client.post("/api/bins", json={"name": "Pocket bin"}).json()
    pockets = [
        {"id": "p1", "x": 20, "y": 30, "length": 30, "width": 20, "depth": 8},
        {"id": "p2", "x": 60, "y": 30, "shape": "scoop", "length": 32, "width": 18, "depth": 6},
    ]
    config = {**created["bin_config"], "access_pockets": pockets}
    updated = client.put(f"/api/bins/{created['id']}", json={"bin_config": config})
    assert updated.status_code == 200

    loaded = client.get(f"/api/bins/{created['id']}").json()
    stored = loaded["bin_config"]["access_pockets"]
    assert [p["id"] for p in stored] == ["p1", "p2"]
    assert stored[0]["shape"] == "rectangle" and stored[1]["shape"] == "scoop"
    assert stored[1]["width"] == 18 and stored[1]["depth"] == 6
    # a different bin is unaffected
    other = client.post("/api/bins", json={"name": "Plain bin"}).json()
    assert other["bin_config"]["access_pockets"] == []


def test_pocket_only_bin_generates_but_empty_bin_does_not(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    created = client.post("/api/bins", json={"name": "Pocket only"}).json()
    empty = client.post(f"/api/bins/{created['id']}/generate")
    assert empty.status_code == 400

    config = {
        **created["bin_config"],
        "access_pockets": [{"id": "p1", "x": 42, "y": 42, "length": 30, "width": 20, "depth": 8}],
    }
    client.put(f"/api/bins/{created['id']}", json={"bin_config": config})
    generated = client.post(f"/api/bins/{created['id']}/generate")
    assert generated.status_code == 200
    assert generated.json()["stl_url"].endswith(".stl")
