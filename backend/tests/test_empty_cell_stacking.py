"""Empty-cell stacking lips: a standard 1x1 lip on every cutout-free full cell.

These drive the real generator with plausible bin configs and read the printed
solids back, so lip presence, its z-band, dormancy, cell eligibility and the
seating of a smaller bin are checked on geometry instead of internal wiring.
"""

import manifold3d as mf
import pytest
import trimesh
from fastapi.testclient import TestClient

import app.api.routes as routes
from app.config import ensure_user_dirs, settings
from app.main import app
from app.models.schemas import AccessPocket, GenerateRequest, TextLabel
from app.services.polygon_scaler import PolygonScaler, ScaledFingerHole, ScaledPolygon
from app.services.stl_generator_manifold import (
    GF_GRID,
    GF_HEIGHT_UNIT,
    ManifoldSTLGenerator,
    _bin_top_z,
    _build_shell,
    _cell_center,
    _empty_cell_lip_origins,
    _manifold_to_trimesh,
)

SCALER = PolygonScaler()
GENERATOR = ManifoldSTLGenerator()


def _config(**overrides) -> GenerateRequest:
    defaults = dict(
        grid_x=3,
        grid_y=3,
        height_units=4,
        magnets=False,
        stacking_lip=True,
        stacking_lip_empty_cells=True,
        bed_size=0,
    )
    defaults.update(overrides)
    return GenerateRequest(**defaults)


def _layout_xy(config: GenerateRequest, x_mm: float, y_mm: float) -> tuple[float, float]:
    """Manifold coordinates to bin layout mm (origin top-left, Y down)."""
    return (x_mm + config.grid_x * GF_GRID / 2, config.grid_y * GF_GRID / 2 - y_mm)


def _square_tool(config, cx_mm, cy_mm, w=30.0, h=30.0, tool_id="tool") -> ScaledPolygon:
    """Prepared square cutout centred at a manifold position, via the real pipeline."""
    px, py = _layout_xy(config, cx_mm, cy_mm)
    outline = ScaledPolygon(
        tool_id,
        [(px - w / 2, py - h / 2), (px + w / 2, py - h / 2), (px + w / 2, py + h / 2), (px - w / 2, py + h / 2)],
        tool_id,
    )
    return SCALER.prepare_for_generation(outline, config.cutout_clearance, smoothed=False)


def _tool_in_cell(config, ix, iy, size=30.0) -> ScaledPolygon:
    cx, cy = _cell_center(ix, iy, config.grid_x, config.grid_y)
    return _square_tool(config, cx, cy, size, size, f"tool-{ix}-{iy}")


def _generate(config, polygons=None, tmp_path=None, name="bin"):
    path = str(tmp_path / f"{name}.stl") if tmp_path is not None else None
    return GENERATOR.generate_bin(list(polygons or []), config, path)


def _rect_area(body, x0, x1, y0, y1, z) -> float:
    """Printed area inside a manifold-space rectangle at height z."""
    probe = mf.CrossSection.square((x1 - x0, y1 - y0), center=True).translate(
        ((x0 + x1) / 2, (y0 + y1) / 2)
    )
    section = body.slice(z)
    return 0.0 if section.is_empty() else (section ^ probe).area()


def _cell_area(body, config, ix, iy, z) -> float:
    """Printed area inside a cell's 42mm square at height z."""
    cx, cy = _cell_center(ix, iy, config.grid_x, config.grid_y)
    return _rect_area(body, cx - GF_GRID / 2, cx + GF_GRID / 2, cy - GF_GRID / 2, cy + GF_GRID / 2, z)


# --- the feature itself ---


def test_every_cutout_free_full_cell_gets_a_lip(tmp_path):
    config = _config()
    wall_top = config.height_units * GF_HEIGHT_UNIT
    body, _ = _generate(config, tmp_path=tmp_path)
    plain, _ = _generate(_config(stacking_lip_empty_cells=False), tmp_path=tmp_path, name="plain")

    # the interior cell carries lip material just above the floor face and
    # nothing once past the lip top
    assert _cell_area(body, config, 1, 1, wall_top + 1.0) > 200.0
    assert _cell_area(body, config, 1, 1, wall_top + 5.0) == pytest.approx(0.0, abs=1e-6)
    # all nine cells are cutout-free, so all nine gain material
    assert body.volume() > plain.volume() + 5000.0
    assert len(body.decompose()) == 1
    # the untouched outer lip still defines the overall height
    assert body.bounding_box()[5] == pytest.approx(_bin_top_z(config, wall_top))

    mesh = _manifold_to_trimesh(body)
    assert mesh.is_watertight


def test_setting_is_dormant_without_the_stacking_lip(tmp_path):
    off = _config(stacking_lip=False, stacking_lip_empty_cells=False)
    on, _ = _generate(_config(stacking_lip=False), tmp_path=tmp_path, name="on")
    off_body, _ = _generate(off, tmp_path=tmp_path, name="off")

    wall_top = 4 * GF_HEIGHT_UNIT
    assert on.volume() == pytest.approx(off_body.volume(), abs=1e-6)
    assert _cell_area(on, off, 1, 1, wall_top + 1.0) == 0.0


def test_option_off_preserves_the_published_geometry(tmp_path):
    # a caller that never sets the field must match an explicit false
    untouched = GenerateRequest(
        grid_x=3, grid_y=3, height_units=4, magnets=False, stacking_lip=True, bed_size=0
    )
    off = _config(stacking_lip_empty_cells=False)
    plain, _ = _generate(untouched, tmp_path=tmp_path, name="plain")
    off_body, _ = _generate(off, tmp_path=tmp_path, name="off")
    on_body, _ = _generate(_config(), tmp_path=tmp_path, name="on")

    assert off_body.volume() == pytest.approx(plain.volume(), abs=1e-6)
    assert on_body.volume() > off_body.volume()


# --- eligibility follows the real cutters ---


def test_tool_pocket_removes_only_its_own_cells_lip(tmp_path):
    config = _config()
    wall_top = config.height_units * GF_HEIGHT_UNIT
    body, _ = _generate(config, [_tool_in_cell(config, 1, 1)], tmp_path=tmp_path)

    assert _cell_area(body, config, 1, 1, wall_top + 1.0) == 0.0
    assert _cell_area(body, config, 0, 1, wall_top + 1.0) > 200.0


def test_prepared_clearance_pushes_a_neighbour_pocket_into_the_cell(tmp_path):
    wall_top = 4 * GF_HEIGHT_UNIT
    areas = {}
    for clearance in (0.0, 2.0):
        config = _config(cutout_clearance=clearance)
        # raw left edge at x=22, outside the centre cell's [-21, 21] square
        body, _ = _generate(
            config, [_square_tool(config, 42.0, 0.0, 40.0, 30.0)], tmp_path=tmp_path,
            name=f"clear-{clearance}",
        )
        areas[clearance] = _cell_area(body, config, 1, 1, wall_top + 1.0)

    assert areas[0.0] > 200.0
    assert areas[2.0] == 0.0


def test_finger_hole_from_a_neighbour_tool_removes_the_lip(tmp_path):
    config = _config()
    wall_top = config.height_units * GF_HEIGHT_UNIT
    tool = _square_tool(config, 42.0, 0.0)  # occupies cell (2, 1) only
    fh_x, fh_y = _layout_xy(config, 23.0, 0.0)  # scoop at the tool's left edge
    tool.finger_holes = [ScaledFingerHole("fh", fh_x, fh_y, 7.0, shape="circle")]

    blocked, _ = _generate(config, [tool], tmp_path=tmp_path, name="hole")
    control, _ = _generate(config, [_square_tool(config, 42.0, 0.0)], tmp_path=tmp_path, name="plain")

    assert _cell_area(blocked, config, 1, 1, wall_top + 1.0) == 0.0
    assert _cell_area(control, config, 1, 1, wall_top + 1.0) > 200.0


def test_chamfer_widening_removes_the_lip(tmp_path):
    wall_top = 4 * GF_HEIGHT_UNIT
    areas = {}
    for chamfer in (0.0, 3.0):
        config = _config(cutout_chamfer=chamfer)
        body, _ = _generate(
            config, [_square_tool(config, 42.0, 0.0, 40.0, 30.0)], tmp_path=tmp_path,
            name=f"chamfer-{chamfer}",
        )
        areas[chamfer] = _cell_area(body, config, 1, 1, wall_top + 1.0)

    assert areas[0.0] > 200.0
    assert areas[3.0] == 0.0


def test_access_pocket_opening_finish_removes_the_lip(tmp_path):
    wall_top = 4 * GF_HEIGHT_UNIT
    areas = {}
    for edge in ("sharp", "fillet"):
        config = _config()
        px, py = _layout_xy(config, 42.0, 0.0)
        config = config.model_copy(update={"access_pockets": [
            AccessPocket(
                id="p", shape="rectangle", x=px, y=py, length=40.0, width=40.0,
                depth=12.0, edge=edge, edge_size=3.0,
            )
        ]})
        body, _ = _generate(config, tmp_path=tmp_path, name=f"pocket-{edge}")
        areas[edge] = _cell_area(body, config, 1, 1, wall_top + 1.0)

    assert areas["sharp"] > 200.0
    assert areas["fillet"] == 0.0


@pytest.mark.parametrize("emboss", [True, False])
def test_text_label_removes_the_cell_lip(tmp_path, emboss):
    config = _config()
    wall_top = config.height_units * GF_HEIGHT_UNIT
    lx, ly = _layout_xy(config, 0.0, 0.0)
    config = config.model_copy(update={"text_labels": [
        TextLabel(id="l", text="AB", x=lx, y=ly, font_size=8.0, emboss=emboss)
    ]})
    body, _ = _generate(config, tmp_path=tmp_path, name=f"label-{emboss}")

    assert _cell_area(body, config, 1, 1, wall_top + 1.0) == 0.0
    assert _cell_area(body, config, 0, 1, wall_top + 1.0) > 200.0


def test_disabled_partial_cell_keeps_no_lip(tmp_path):
    config = _config(
        partial_bins=True,
        partial_bins_values=[True] * 4 + [False] + [True] * 4,
        partial_bins_connect=True,
    )
    wall_top = config.height_units * GF_HEIGHT_UNIT
    body, _ = _generate(config, tmp_path=tmp_path)

    assert _cell_area(body, config, 1, 1, wall_top + 1.0) == 0.0
    assert _cell_area(body, config, 0, 0, wall_top + 1.0) > 200.0


def test_fractional_trailing_cell_has_no_lip(tmp_path):
    config = _config(grid_x=1.5, grid_y=2)
    wall_top = config.height_units * GF_HEIGHT_UNIT
    body, _ = _generate(config, tmp_path=tmp_path)

    assert _cell_area(body, config, 0, 0, wall_top + 1.0) > 200.0
    # the 21mm trailing band (x 12..27 stays clear of the bin's own outer lip)
    assert _rect_area(body, 12.0, 27.0, -20.0, 20.0, wall_top + 1.0) == 0.0
    assert _empty_cell_lip_origins(config, wall_top) == [(-10.5, -21.0), (-10.5, 21.0)]


def test_rim_units_lift_the_cell_lip(tmp_path):
    wall_top = 4 * GF_HEIGHT_UNIT
    plain = _config(rim_units=0)
    raised = _config(rim_units=1)
    plain_body, _ = _generate(plain, tmp_path=tmp_path, name="flat")
    raised_body, _ = _generate(raised, tmp_path=tmp_path, name="raised")

    assert _cell_area(plain_body, plain, 1, 1, wall_top + 1.0) > 200.0
    assert _cell_area(plain_body, plain, 1, 1, wall_top + 6.0) == 0.0
    # collar above the floor face, lip on top of it, nothing past its top
    assert _cell_area(raised_body, raised, 1, 1, wall_top + 3.0) > 300.0
    assert _cell_area(raised_body, raised, 1, 1, wall_top + 9.0) > 200.0
    assert _cell_area(raised_body, raised, 1, 1, wall_top + 12.0) == 0.0


# --- a smaller bin seats in the cell lips ---


def test_smaller_bin_base_seats_in_interior_cell_lips(tmp_path):
    config = _config(grid_x=4, grid_y=4)
    wall_top = config.height_units * GF_HEIGHT_UNIT
    body, _ = _generate(config, tmp_path=tmp_path)

    single = _build_shell(GenerateRequest(
        grid_x=1, grid_y=1, height_units=1, magnets=False, stacking_lip=True, bed_size=0,
    ))
    for ix, iy in ((1, 1), (2, 1), (2, 2)):
        cx, cy = _cell_center(ix, iy, config.grid_x, config.grid_y)
        seated = single.translate((cx, cy, wall_top))
        assert (body ^ seated).volume() == pytest.approx(0.0, abs=1e-6)
        assert (body.slice(wall_top - 1e-4) ^ seated.slice(wall_top)).area() > 1000.0

    # a multi-base-cell upper bin seats across two adjacent cell lips
    wide = _build_shell(GenerateRequest(
        grid_x=2, grid_y=1, height_units=1, magnets=False, stacking_lip=True, bed_size=0,
    ))
    x1, y1 = _cell_center(1, 1, config.grid_x, config.grid_y)
    x2, _ = _cell_center(2, 1, config.grid_x, config.grid_y)
    seated_wide = wide.translate(((x1 + x2) / 2, y1, wall_top))
    assert (body ^ seated_wide).volume() == pytest.approx(0.0, abs=1e-6)
    assert (body.slice(wall_top - 1e-4) ^ seated_wide.slice(wall_top)).area() > 2000.0


# --- saved-bin generation honours the setting ---


def _api_client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_path", tmp_path)
    monkeypatch.setattr(routes.settings, "storage_path", tmp_path)
    routes._store_cache.clear()
    routes._project_store_cache.clear()
    ensure_user_dirs(tmp_path / "default")
    return TestClient(app)


def test_saved_bin_generation_honours_the_setting(tmp_path, monkeypatch):
    client = _api_client(tmp_path, monkeypatch)
    created = client.post("/api/bins", json={"name": "Stacker"}).json()
    bin_id = created["id"]
    base = {
        **created["bin_config"],
        "grid_x": 2,
        "grid_y": 2,
        "access_pockets": [
            {"id": "p1", "x": 21, "y": 21, "length": 10, "width": 10, "depth": 6}
        ],
    }

    volumes = {}
    for flag in (False, True):
        updated = client.put(
            f"/api/bins/{bin_id}",
            json={"bin_config": {**base, "stacking_lip_empty_cells": flag}},
        )
        assert updated.status_code == 200
        generated = client.post(f"/api/bins/{bin_id}/generate")
        assert generated.status_code == 200
        assert generated.json()["stl_url"].endswith(".stl")
        mesh = trimesh.load_mesh(tmp_path / "default" / "outputs" / f"{bin_id}.stl")
        volumes[flag] = mesh.volume

    assert volumes[True] > volumes[False]
