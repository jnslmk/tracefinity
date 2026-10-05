"""Tests for per-cutout depth override in stl_generator_manifold."""
import pytest

from app.models.schemas import BinParams
from app.services.stl_generator_manifold import _resolve_pocket_depth


class TestResolvePocketDepth:
    def test_no_override_uses_global(self):
        bp = BinParams(cutout_depth=20)
        assert _resolve_pocket_depth(None, bp, max_depth=100) == 20.0

    def test_override_takes_precedence(self):
        bp = BinParams(cutout_depth=20)
        assert _resolve_pocket_depth(8, bp, max_depth=100) == 8.0

    def test_override_clamped_to_min(self):
        bp = BinParams(cutout_depth=20)
        assert _resolve_pocket_depth(2, bp, max_depth=100) == 5.0

    def test_override_clamped_to_max(self):
        bp = BinParams(cutout_depth=20)
        assert _resolve_pocket_depth(150, bp, max_depth=100) == 100.0

    def test_global_clamped_to_max(self):
        bp = BinParams(cutout_depth=200)
        assert _resolve_pocket_depth(None, bp, max_depth=50) == 50.0

    def test_insert_height_added_to_global(self):
        bp = BinParams(cutout_depth=20, insert_enabled=True, insert_height=2.5)
        assert _resolve_pocket_depth(None, bp, max_depth=100) == 22.5

    def test_insert_height_added_to_override(self):
        bp = BinParams(cutout_depth=20, insert_enabled=True, insert_height=2.5)
        assert _resolve_pocket_depth(10, bp, max_depth=100) == 12.5

    def test_insert_disabled_ignores_insert_height(self):
        bp = BinParams(cutout_depth=20, insert_enabled=False, insert_height=5.0)
        assert _resolve_pocket_depth(None, bp, max_depth=100) == 20.0

    def test_zero_override_is_clamped_to_min(self):
        bp = BinParams(cutout_depth=20)
        assert _resolve_pocket_depth(0, bp, max_depth=100) == 5.0


class TestAccessPocketDepth:
    def test_pocket_depth_uses_the_same_protected_floor_max(self):
        from app.models.schemas import AccessPocket
        from app.services.stl_generator_manifold import _make_access_pocket_cutters

        config = BinParams(grid_x=2, grid_y=2, height_units=4)
        wall_top = 4 * 7
        max_depth = wall_top - 4.75 - 2
        pocket = AccessPocket(id="p", x=42, y=42, length=10, width=10, depth=999)
        cutters = _make_access_pocket_cutters(
            [pocket], config, wall_top_z=wall_top, max_depth=max_depth,
            offset_x=-42.0, offset_y=-42.0,
        )
        assert cutters is not None
        # the cutter bottoms out at the protected floor, never below it
        assert cutters.bounding_box()[2] == pytest.approx(wall_top - max_depth, abs=0.05)
