"""Export topology must survive STL's float32 coordinate precision.

Boolean seams and dense curved pocket boundaries can contain triangles that
collapse when quantized. Manifold must normalize those triangles with their
neighbors; coordinate-grid welding plus independent face deletion can tear
otherwise closed meshes.
"""
import math
from pathlib import Path

import numpy as np
import pytest
import trimesh

from app.models.schemas import GenerateRequest
from app.services.polygon_scaler import PolygonScaler, ScaledPolygon
from app.services.stl_generator_manifold import ManifoldSTLGenerator, _manifold_to_trimesh


def _boundary_edge_count(mesh) -> int:
    _, counts = np.unique(mesh.edges_sorted, axis=0, return_counts=True)
    return int((counts == 1).sum())


def test_a_stacking_lip_bin_at_six_grid_units_has_no_boundary_holes(tmp_path: Path):
    """Below grid_y=6 (252mm) this config exports clean; at and above it, the
    unpatched merge tolerance used to leave a 3-edge hole in the lip notch
    seam. No tool polygons needed -- the defect is in the shell/lip geometry
    itself."""
    config = GenerateRequest(
        grid_x=2, grid_y=6, height_units=4, magnets=False, stacking_lip=True,
    )
    body, _ = ManifoldSTLGenerator().generate_bin([], config, str(tmp_path / "bin.stl"))
    tm = _manifold_to_trimesh(body)

    assert _boundary_edge_count(tm) == 0
    assert tm.is_watertight


def test_dense_smoothed_overlapping_pockets_export_as_a_closed_solid(tmp_path: Path):
    angles = np.linspace(0, 2 * math.pi, 360, endpoint=False)
    traced = [
        (60 + round(35 * math.cos(a) * 5) / 5, 70 + round(20 * math.sin(a) * 5) / 5)
        for a in angles
    ]
    scaler = PolygonScaler()
    pockets = [
        scaler.prepare_for_generation(
            ScaledPolygon(str(i), [(x + dx, y + dy) for x, y in traced], ""),
            1.3, smoothed=True,
        )
        for i, (dx, dy) in enumerate([(0.0, 0.0), (20.001, 10.001)])
    ]
    path = tmp_path / "curved-pockets.stl"
    body, _ = ManifoldSTLGenerator().generate_bin(
        pockets,
        GenerateRequest(grid_x=3, grid_y=6, height_units=6, magnets=False, stacking_lip=True),
        str(path),
    )
    printed = trimesh.load_mesh(path)
    assert printed.is_watertight
    assert printed.is_winding_consistent
    assert printed.volume == pytest.approx(body.volume(), rel=1e-6)
    np.testing.assert_allclose(
        printed.bounds, np.asarray(body.bounding_box()).reshape(2, 3), atol=0.001,
    )
