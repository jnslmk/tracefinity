"""Containment geometry for photo-derived drawer boundaries.

A footprint is only covered when the whole rectangle is inside the usable floor:
corners inside are not enough, because a concave notch or an interior exclusion
can cross an edge while every corner stays inside.
"""

import math

import pytest

from app.services.drawer_outline import (
    MIN_RING_POINTS,
    cell_inside,
    footprint_corners,
    point_in_polygon,
    polygon_area,
    rect_inside,
    ring_area,
    ring_from_points,
    rotate_point,
    shape_inside,
    validate_outline,
)

SQUARE = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]
# a thin slit cut in from the bottom edge; a footprint over it has all four
# corners inside the outline
SLIT = [
    (0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (60.0, 100.0),
    (60.0, 40.0), (40.0, 40.0), (40.0, 100.0), (0.0, 100.0),
]
HOLE = [[(20.0, 20.0), (40.0, 20.0), (40.0, 40.0), (20.0, 40.0)]]


def test_ring_area_is_absolute_and_signed_by_winding():
    assert ring_area(SQUARE) == pytest.approx(10000)
    assert ring_area(list(reversed(SQUARE))) == pytest.approx(-10000)


def test_polygon_area_subtracts_exclusions():
    assert polygon_area(SQUARE, HOLE) == pytest.approx(9600)


def test_point_membership_respects_exclusions():
    assert point_in_polygon((10.0, 10.0), SQUARE)
    assert point_in_polygon((30.0, 30.0), SQUARE, HOLE) is False
    assert point_in_polygon((150.0, 10.0), SQUARE) is False


def test_rect_inside_accepts_contained_and_rejects_crossing():
    assert rect_inside((10.0, 10.0, 90.0, 90.0), SQUARE)
    assert rect_inside((90.0, 10.0, 110.0, 90.0), SQUARE) is False


def test_concavity_with_corners_inside_is_not_covered():
    # corners of (40..80, 40..80) are all inside the slit outline, but both slit
    # walls cross it
    assert rect_inside((10.0, 10.0, 35.0, 35.0), SLIT)
    assert rect_inside((20.0, 20.0, 80.0, 80.0), SLIT) is False


def test_exclusion_inside_the_footprint_is_not_covered():
    assert rect_inside((1.0, 1.0, 15.0, 15.0), SQUARE, HOLE)
    assert rect_inside((10.0, 10.0, 35.0, 35.0), SQUARE, HOLE) is False


def test_grid_rotation_aligns_a_footprint_with_a_rotated_drawer_edge():
    # a 90x45mm usable rectangle turned 30 degrees: the drawer edge is not parallel
    # to the reference paper, so the grid has to turn with it
    outer = [rotate_point(point, math.radians(30)) for point in
             [(0.0, 0.0), (90.0, 0.0), (90.0, 45.0), (0.0, 45.0)]]

    aligned = footprint_corners((0.0, 0.0), 30.0, 0.0, 0.0, 2.0, 1.0)
    orthogonal = footprint_corners((0.0, 0.0), 90.0, 0.0, 0.0, 2.0, 1.0)

    assert shape_inside(aligned, outer)
    assert shape_inside(orthogonal, outer) is False
    assert shape_inside(aligned, outer, clearance=5.0) is False


def test_fit_clearance_requires_a_gap_from_the_footprint():
    assert rect_inside((10.0, 10.0, 50.0, 50.0), SQUARE, clearance=5)
    assert rect_inside((0.0, 0.0, 10.0, 60.0), SQUARE, clearance=5) is False


def test_clearance_is_a_euclidean_gap_to_a_diagonal_edge():
    # a 45 degree obstruction at x+y=110: the footprint corner (52,52) is
    # 6/sqrt(2) = 4.2426mm away, so 4mm fits and 5mm does not even though the
    # axis-wise expansion of 4mm would push the corner past the line
    hole = [[(60.0, 50.0), (50.0, 60.0), (60.0, 60.0)]]

    assert rect_inside((10.0, 10.0, 52.0, 52.0), SQUARE, hole) is True
    assert rect_inside((10.0, 10.0, 52.0, 52.0), SQUARE, hole, clearance=4.0) is True
    assert rect_inside((10.0, 10.0, 52.0, 52.0), SQUARE, hole, clearance=5.0) is False


def test_exclusion_exactly_matching_the_footprint_is_rejected():
    hole = [[(20.0, 20.0), (60.0, 20.0), (60.0, 60.0), (20.0, 60.0)]]

    # a shared corner is harmless contact
    assert rect_inside((0.0, 0.0, 20.0, 20.0), SQUARE, hole) is True
    # the footprint equal to the exclusion is not floor at all
    assert rect_inside((20.0, 20.0, 60.0, 60.0), SQUARE, hole) is False


def test_validate_rejects_nested_exclusions():
    outer = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]
    big = [[(20.0, 20.0), (80.0, 20.0), (80.0, 80.0), (20.0, 80.0)]]
    small = [[(30.0, 30.0), (40.0, 30.0), (40.0, 40.0), (30.0, 40.0)]]

    with pytest.raises(ValueError, match="overlap"):
        validate_outline(outer, big + small)


def test_concave_exclusion_allows_shared_edge_contact_at_zero_clearance():
    # U-shaped exclusion: its area centroid (105, 99) falls inside the notch the
    # footprint occupies, so the footprint's interior side at a shared edge must
    # be read from the hole's winding, not from that centroid
    outer = [(0.0, 0.0), (210.0, 0.0), (210.0, 210.0), (0.0, 210.0)]
    u_hole = [[
        (42.0, 42.0), (168.0, 42.0), (168.0, 168.0), (126.0, 168.0),
        (126.0, 84.0), (84.0, 84.0), (84.0, 168.0), (42.0, 168.0),
    ]]

    # the footprint is the floor inside the notch: its vertices lie on hole
    # edges, its edges run along hole edges, and no hole segment enters it
    assert rect_inside((84.0, 84.0, 126.0, 168.0), outer, u_hole) is True
    # positive Euclidean clearance still rejects even the shared edges
    assert rect_inside((84.0, 84.0, 126.0, 168.0), outer, u_hole, clearance=1.0) is False


def test_cell_inside_uses_the_same_rule():
    assert cell_inside(20.0, 20.0, 20.0, SQUARE)
    assert cell_inside(15.0, 15.0, 20.0, SQUARE, HOLE) is False


def test_validate_accepts_a_simple_polygon_with_exclusions():
    validate_outline(SQUARE)
    validate_outline(SQUARE, HOLE)


def test_validate_rejects_degenerate_rings():
    with pytest.raises(ValueError, match="at least"):
        validate_outline([(0.0, 0.0), (10.0, 0.0)])
    with pytest.raises(ValueError, match="no area"):
        validate_outline([(0.0, 0.0), (10.0, 0.0), (20.0, 0.0)])
    assert MIN_RING_POINTS == 3


def test_validate_rejects_self_crossing_rings():
    bowtie_with_area = [
        (0.0, 0.0), (8.0, 0.0), (8.0, 8.0), (4.0, 8.0),
        (4.0, 2.0), (6.0, 2.0), (6.0, 8.0), (0.0, 8.0),
    ]
    with pytest.raises(ValueError, match="crosses itself"):
        validate_outline(bowtie_with_area)


def test_validate_rejects_exclusions_outside_or_crossing():
    outside = [[(200.0, 200.0), (220.0, 200.0), (220.0, 220.0), (200.0, 220.0)]]
    with pytest.raises(ValueError, match="not inside"):
        validate_outline(SQUARE, outside)
    crossing = [[(-10.0, 20.0), (30.0, 20.0), (30.0, 40.0), (-10.0, 40.0)]]
    with pytest.raises(ValueError):
        validate_outline(SQUARE, crossing)


def test_ring_from_points_accepts_schema_points():
    class PointLike:
        def __init__(self, x, y):
            self.x = x
            self.y = y

    assert ring_from_points([PointLike(1, 2), PointLike(3, 4)]) == [(1.0, 2.0), (3.0, 4.0)]
