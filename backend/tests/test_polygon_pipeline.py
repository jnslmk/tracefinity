"""Tests for the cutout preparation pipeline: smoothing/simplification must
run before clearance so the requested clearance is never consumed."""
import numpy as np
import pytest
from shapely.geometry import Point as SPPoint
from shapely.geometry import Polygon as SP

from app.services.polygon_scaler import (
    PolygonScaler,
    ScaledFingerHole,
    ScaledPolygon,
    smooth_epsilon,
)


def _dense_square(side: float, pts_per_edge: int = 200) -> list[tuple[float, float]]:
    pts = []
    for i in range(pts_per_edge):
        pts.append((side * i / pts_per_edge, 0.0))
    for i in range(pts_per_edge):
        pts.append((side, side * i / pts_per_edge))
    for i in range(pts_per_edge):
        pts.append((side - side * i / pts_per_edge, side))
    for i in range(pts_per_edge):
        pts.append((0.0, side - side * i / pts_per_edge))
    return pts


def _dense_rectangle(
    width: float, height: float, pts_per_edge: int = 200
) -> list[tuple[float, float]]:
    pts = []
    for i in range(pts_per_edge):
        pts.append((width * i / pts_per_edge, 0.0))
    for i in range(pts_per_edge):
        pts.append((width, height * i / pts_per_edge))
    for i in range(pts_per_edge):
        pts.append((width - width * i / pts_per_edge, height))
    for i in range(pts_per_edge):
        pts.append((0.0, height - height * i / pts_per_edge))
    return pts


def _min_clearance(reference: SP, cut: SP, samples: int = 1500) -> float:
    """worst signed distance from the reference outline to the cut outline."""
    worst = float("inf")
    for d in np.linspace(0, reference.exterior.length, samples, endpoint=False):
        p = reference.exterior.interpolate(float(d))
        dist = cut.exterior.distance(p)
        if not cut.contains(p):
            dist = -dist
        worst = min(worst, dist)
    return worst


@pytest.fixture
def scaler():
    return PolygonScaler()


def _sp(points) -> ScaledPolygon:
    return ScaledPolygon("t", points, "t")


class TestSmoothEpsilon:
    def test_absolute_not_size_scaled(self):
        # epsilon reflects trace noise (absolute mm), not tool size
        assert smooth_epsilon(0.0) == pytest.approx(0.3)
        assert smooth_epsilon(0.5) == pytest.approx(0.9)
        assert smooth_epsilon(1.0) == pytest.approx(1.5)

    def test_monotonic(self):
        levels = [0.0, 0.25, 0.5, 0.75, 1.0]
        eps = [smooth_epsilon(lv) for lv in levels]
        assert eps == sorted(eps)


class TestPrepareForGeneration:
    def test_smoothing_preserves_long_straight_edges(self, scaler):
        raw = _dense_rectangle(84.0, 20.0)

        prepared = scaler.prepare_for_generation(
            _sp(raw), 0.0, smoothed=True, smooth_level=0.5
        )

        assert SP(prepared.points_mm).covers(SPPoint(20.0, 0.1))

    def test_smoothed_clearance_measured_from_smoothed_shape(self, scaler):
        """pocket must equal the previewed (smoothed) shape grown by clearance."""
        raw = _dense_square(141.4)
        clearance = 1.0
        prepared = scaler.prepare_for_generation(
            _sp(raw), clearance, smoothed=True, smooth_level=0.5
        )
        reference = SP(scaler.smooth(_sp(raw), level=0.5).points_mm)
        cut = SP(prepared.points_mm)

        worst = _min_clearance(reference, cut)
        assert worst >= clearance - 0.1, f"clearance eaten: worst {worst:.3f}mm"
        # and not over-grown either. The union keeps the traced corners sharp,
        # and clearance uses a mitre join, so bound it with the same join.
        assert cut.within(reference.buffer(clearance, join_style=2).buffer(0.01))

    def test_unsmoothed_clearance_contains_raw(self, scaler):
        raw = _dense_square(80.0)
        prepared = scaler.prepare_for_generation(
            _sp(raw), 1.0, smoothed=False, smooth_level=0.5
        )
        cut = SP(prepared.points_mm)
        raw_poly = SP(raw)
        # simplify tolerance is 0.3mm, so at least 0.65mm of the 1.0mm survives
        assert cut.contains(raw_poly.buffer(0.65))
        # mitre join keeps corners sharp; bound with a mitre buffer too
        assert cut.within(raw_poly.buffer(1.35, join_style=2))

    def test_zero_clearance_smoothed_matches_smooth(self, scaler):
        raw = _dense_square(60.0)
        prepared = scaler.prepare_for_generation(
            _sp(raw), 0.0, smoothed=True, smooth_level=0.5
        )
        smoothed = scaler.smooth(_sp(raw), level=0.5)
        assert SP(prepared.points_mm).symmetric_difference(
            SP(smoothed.points_mm)
        ).area == pytest.approx(0.0, abs=1e-6)

    def test_interior_ring_island_shrinks(self, scaler):
        outer = _dense_square(60.0)
        ring = [(20.0, 20.0), (40.0, 20.0), (40.0, 40.0), (20.0, 40.0)]
        poly = ScaledPolygon("t", outer, "t", interior_rings_mm=[ring])
        prepared = scaler.prepare_for_generation(poly, 1.0, smoothed=False, smooth_level=0.5)
        assert prepared.interior_rings_mm, "island lost"
        island = SP(prepared.interior_rings_mm[0])
        # clearance grows the cutout, which shrinks the island
        assert island.area < SP(ring).area

    def test_erosion_bounded_for_large_tools(self, scaler):
        """absolute epsilon keeps a 300mm-diagonal circle's chord sagitta small,
        and the smoothed outline must still cover it at every level."""
        r = 106.0  # ~300mm diagonal bbox
        raw = [
            (r * np.cos(a) + r, r * np.sin(a) + r)
            for a in np.linspace(0, 2 * np.pi, 720, endpoint=False)
        ]
        traced = SP(raw)
        for level in (0.5, 1.0):
            smoothed = SP(scaler.smooth(_sp(raw), level=level).points_mm)
            assert traced.difference(smoothed).area == pytest.approx(0.0, abs=1e-6)


def _traced_with_tip() -> list[tuple[float, float]]:
    """A densely sampled edge carrying a bump and a notch smaller than the
    smoothing tolerance. The simplifier drops both, so the smoothed outline
    alone under-covers the bump and over-covers the notch."""
    top = [(6.0 * i, 0.0) for i in range(11)]
    top[5] = (30.0, -1.4)
    top[7] = (42.0, 1.4)
    return top + [(60.0, 40.0), (0.0, 40.0)]


class TestNonErodingSmooth:
    """Smoothing may round and straighten, but it must never uncover the traced
    outline: the pocket is cut from the smoothed shape, so an eroded patch leaves
    the tool resting on a ledge instead of on its pocket floor."""

    LEVELS = (0.0, 0.5, 1.0)

    @pytest.mark.parametrize("level", LEVELS)
    def test_smoothed_region_still_covers_traced_outline(self, scaler, level):
        traced = SP(_traced_with_tip())
        smoothed = SP(scaler.smooth(_sp(_traced_with_tip()), level=level).points_mm)
        assert traced.difference(smoothed).area == pytest.approx(0.0, abs=1e-6)

    @pytest.mark.parametrize("level", LEVELS)
    def test_island_never_grows_back_into_traced_outline(self, scaler, level):
        ring = [(20.0, 20.0), (40.0, 20.0), (40.0, 30.0), (20.0, 30.0)]
        poly = ScaledPolygon("t", _traced_with_tip(), "t", interior_rings_mm=[ring])
        smoothed = scaler.smooth(poly, level=level)
        traced = SP(_traced_with_tip(), holes=[ring])
        cut = SP(smoothed.points_mm, holes=smoothed.interior_rings_mm)
        assert traced.difference(cut).area == pytest.approx(0.0, abs=1e-6)

    def test_smoothing_still_fills_the_notch_it_bridges(self, scaler):
        """The result is not the traced outline verbatim: material the
        smoothing added is kept."""
        traced = SP(_traced_with_tip())
        smoothed = SP(scaler.smooth(_sp(_traced_with_tip()), level=1.0).points_mm)
        assert smoothed.area > traced.area
        assert smoothed.covers(SPPoint(42.0, 1.2))

    def test_bump_the_simplifier_dropped_is_covered(self, scaler):
        raw = _traced_with_tip()
        simplified = SP(
            scaler.simplify(_sp(raw), tolerance_mm=smooth_epsilon(1.0)).points_mm
        )
        assert not simplified.contains(SPPoint(30.0, -1.2))
        smoothed = SP(scaler.smooth(_sp(raw), level=1.0).points_mm)
        assert smoothed.covers(SPPoint(30.0, -1.2))

    def test_default_clearance_pocket_covers_traced_outline(self, scaler):
        traced = SP(_traced_with_tip())
        prepared = scaler.prepare_for_generation(
            _sp(_traced_with_tip()), 1.0, smoothed=True, smooth_level=0.5
        )
        assert traced.difference(SP(prepared.points_mm)).area == pytest.approx(
            0.0, abs=1e-6
        )

    def test_metadata_survives_the_envelope_union(self, scaler):
        poly = ScaledPolygon("tool-1", _traced_with_tip(), "Cutter")
        poly.finger_holes = [ScaledFingerHole("h1", 5.0, 5.0, 2.0)]
        poly.depth_override = 7.5

        result = scaler.smooth(poly, level=0.5)

        assert (result.id, result.label, result.depth_override) == (
            "tool-1", "Cutter", 7.5,
        )
        assert result.finger_holes is poly.finger_holes
