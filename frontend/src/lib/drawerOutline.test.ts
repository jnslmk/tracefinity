import { describe, expect, it } from 'vitest'
import {
  footprintCorners,
  outlineArea,
  outlineBounds,
  outlinePerimeter,
  outlineToPolygons,
  pointInOutline,
  polygonsToOutline,
  rectInsideOutline,
  ringArea,
  rotatePoint,
  shapeInsideOutline,
  validateOutline,
} from '@/lib/drawerOutline'
import type { DrawerOutline, Point } from '@/types'

const ring = (...pairs: [number, number][]): Point[] => pairs.map(([x, y]) => ({ x, y }))
const outline = (points: Point[], interiorRings: Point[][] = []): DrawerOutline => ({
  points,
  interior_rings: interiorRings,
})

const square = outline(ring([0, 0], [100, 0], [100, 100], [0, 100]))

describe('ring metrics', () => {
  it('measures area, bounds and perimeter', () => {
    expect(ringArea(square.points)).toBeCloseTo(10000)
    expect(outlineArea(square)).toBeCloseTo(10000)
    expect(outlinePerimeter(square)).toBeCloseTo(400)
    expect(outlineBounds(square)).toEqual({ x0: 0, y0: 0, x1: 100, y1: 100 })
  })

  it('subtracts interior exclusions from the area', () => {
    const holed = outline(square.points, [ring([20, 20], [40, 20], [40, 40], [20, 40])])
    expect(outlineArea(holed)).toBeCloseTo(9600)
  })
})

describe('point membership', () => {
  it('treats a hole as outside the floor', () => {
    const holed = outline(square.points, [ring([20, 20], [40, 20], [40, 40], [20, 40])])
    expect(pointInOutline({ x: 10, y: 10 }, holed)).toBe(true)
    expect(pointInOutline({ x: 30, y: 30 }, holed)).toBe(false)
    expect(pointInOutline({ x: 200, y: 30 }, holed)).toBe(false)
  })
})

describe('rect containment', () => {
  it('accepts a rectangle fully inside and rejects one crossing an edge', () => {
    expect(rectInsideOutline({ x0: 10, y0: 10, x1: 90, y1: 90 }, square)).toBe(true)
    expect(rectInsideOutline({ x0: 90, y0: 10, x1: 110, y1: 90 }, square)).toBe(false)
  })

  it('rejects a rectangle over a concavity even with corners inside', () => {
    // a slit cut in from the bottom edge
    const slit = outline(ring([0, 0], [100, 0], [100, 100], [60, 100], [60, 40], [40, 40], [40, 100], [0, 100]))
    expect(rectInsideOutline({ x0: 20, y0: 20, x1: 80, y1: 80 }, slit, 2)).toBe(false)
    expect(rectInsideOutline({ x0: 2, y0: 2, x1: 38, y1: 38 }, slit, 0)).toBe(true)
  })

  it('rejects a rectangle covering an exclusion', () => {
    const holed = outline(square.points, [ring([20, 20], [40, 20], [40, 40], [20, 40])])
    expect(rectInsideOutline({ x0: 1, y0: 1, x1: 15, y1: 15 }, holed)).toBe(true)
    expect(rectInsideOutline({ x0: 10, y0: 10, x1: 50, y1: 50 }, holed)).toBe(false)
  })

  it('grows the footprint by the clearance so it cannot touch the boundary', () => {
    expect(rectInsideOutline({ x0: 10, y0: 10, x1: 50, y1: 50 }, square, 0)).toBe(true)
    expect(rectInsideOutline({ x0: 10, y0: 10, x1: 50, y1: 50 }, square, 5)).toBe(true)
    expect(rectInsideOutline({ x0: 0, y0: 0, x1: 10, y1: 60 }, square, 5)).toBe(false)
  })

  it('measures the clearance as a Euclidean gap to a diagonal edge', () => {
    // a 45 degree obstruction at x+y=110: the footprint corner (52,52) is
    // 6/sqrt(2) = 4.2426mm away, so 4mm fits while an axis-wise expansion of 4mm
    // would push the corner past the line
    const hole = [ring([60, 50], [50, 60], [60, 60])]
    const holed = outline(square.points, hole)

    expect(rectInsideOutline({ x0: 10, y0: 10, x1: 52, y1: 52 }, holed)).toBe(true)
    expect(rectInsideOutline({ x0: 10, y0: 10, x1: 52, y1: 52 }, holed, 4)).toBe(true)
    expect(rectInsideOutline({ x0: 10, y0: 10, x1: 52, y1: 52 }, holed, 5)).toBe(false)
  })

  it('rejects a footprint that coincides with an exclusion', () => {
    const hole = [ring([20, 20], [60, 20], [60, 60], [20, 60])]
    const holed = outline(square.points, hole)

    // a shared corner is harmless contact
    expect(rectInsideOutline({ x0: 0, y0: 0, x1: 20, y1: 20 }, holed)).toBe(true)
    // the footprint equal to the exclusion is not floor at all
    expect(rectInsideOutline({ x0: 20, y0: 20, x1: 60, y1: 60 }, holed)).toBe(false)
  })

  it('allows a footprint inside a concave exclusion notch to share its edges', () => {
    // the U hole wraps the notch; its area centroid sits inside the footprint,
    // so the interior side of a shared edge must come from the hole's winding
    const outer = outline(ring([0, 0], [210, 0], [210, 210], [0, 210]))
    const uHole = [ring([42, 42], [168, 42], [168, 168], [126, 168], [126, 84], [84, 84], [84, 168], [42, 168])]
    const notched = outline(outer.points, uHole)

    expect(rectInsideOutline({ x0: 84, y0: 84, x1: 126, y1: 168 }, notched)).toBe(true)
    expect(rectInsideOutline({ x0: 84, y0: 84, x1: 126, y1: 168 }, notched, 1)).toBe(false)
  })
})

describe('turned grid', () => {
  it('turns the footprint with the grid so an edge off the paper axes still fits', () => {
    // a 90x45mm floor turned 30 degrees
    const outer = outline(ring([0, 0], [90, 0], [90, 45], [0, 45]).map(p => rotatePoint(p, Math.PI / 6)))

    const aligned = footprintCorners({ x: 0, y: 0 }, 30, 0, 0, 2, 1)
    const orthogonal = footprintCorners({ x: 0, y: 0 }, 90, 0, 0, 2, 1)

    expect(shapeInsideOutline(aligned, outer)).toBe(true)
    expect(shapeInsideOutline(orthogonal, outer)).toBe(false)
    // nominal contact is fine at zero clearance, but the gap must be Euclidean
    expect(shapeInsideOutline(aligned, outer, 5)).toBe(false)
  })
})

describe('validation', () => {
  it('accepts a simple polygon with exclusions inside', () => {
    expect(validateOutline(square)).toBeNull()
    expect(validateOutline(outline(square.points, [ring([20, 20], [40, 20], [40, 40], [20, 40])]))).toBeNull()
  })

  it('rejects degenerate, self-crossing and out-of-place rings', () => {
    expect(validateOutline(outline(ring([0, 0], [10, 0])))).toMatch(/3 points/)
    expect(validateOutline(outline(ring([0, 0], [10, 0], [20, 0])))).toMatch(/no area/)
    // an edge that touches a non-adjacent edge is not a simple ring
    expect(validateOutline(outline(ring([0, 0], [8, 0], [8, 8], [4, 8], [4, 2], [6, 2], [6, 8], [0, 8]))))
      .toMatch(/crosses itself/)
    expect(validateOutline(outline(square.points, [ring([200, 200], [220, 200], [220, 220], [200, 220])])))
      .toMatch(/not inside/)
  })

  it('rejects nested exclusions', () => {
    const big = ring([20, 20], [80, 20], [80, 80], [20, 80])
    const small = ring([30, 30], [40, 30], [40, 40], [30, 40])

    expect(validateOutline(outline(square.points, [big, small]))).toMatch(/overlap/)
  })
})

describe('polygon round trip', () => {
  it('splits a boundary into editable rings and recombines it', () => {
    const holed = outline(square.points, [ring([20, 20], [40, 20], [40, 40], [20, 40])])
    const polygons = outlineToPolygons(holed)
    expect(polygons).toHaveLength(2)

    expect(polygonsToOutline(polygons)).toEqual(holed)
    expect(polygonsToOutline([])).toBeNull()
  })
})
