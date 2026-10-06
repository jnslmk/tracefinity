import { describe, expect, it } from 'vitest'
import type { BinSummary, DrawerOutline, ProjectBinPlacement } from '@/types'
import { GRID_UNIT } from '@/lib/constants'
import { rotatePoint } from '@/lib/drawerOutline'
import {
  HALF_GRID_SNAP,
  autoArrange,
  binById,
  binFootprint,
  binPointToDrawerMm,
  clampDrawerGrid,
  clampToDrawer,
  drawerStats,
  drawerGridBounds,
  findFreeSpot,
  findLayoutConflicts,
  nextRotation,
  gridLines,
  placementRect,
  rectFitsFootprint,
  rectsOverlap,
  rotationOffsetMm,
  snapForBin,
  snapUnits,
  transformStack,
} from '@/lib/drawerLayout'

function bin(id: string, gridX: number, gridY: number, name = id, halfGridBase = false): BinSummary {
  return {
    id,
    name,
    project_id: 'project-1',
    created_at: null,
    tool_ids: [],
    tool_count: 0,
    has_stl: false,
    grid_x: gridX,
    grid_y: gridY,
    height_units: 4,
    half_grid_base: halfGridBase,
    preview_tools: [],
  }
}

function placement(binId: string, x: number, y: number, rotation = 0, id = `${binId}-${x}-${y}`): ProjectBinPlacement {
  return { id, bin_id: binId, x, y, rotation, color: null }
}

describe('snapping and clamping', () => {
  it('snaps to full units by default', () => {
    expect(snapUnits(1.3)).toBe(1)
    expect(snapUnits(1.6)).toBe(2)
  })

  it('snaps to half units when asked', () => {
    expect(snapUnits(1.3, HALF_GRID_SNAP)).toBe(1.5)
    expect(snapUnits(1.1, HALF_GRID_SNAP)).toBe(1)
  })

  it('canonicalizes zero in snapped, clamped and rendered coordinates without losing negative cells', () => {
    expect(snapUnits(-0)).toBe(0)
    expect(snapUnits(-.1)).toBe(0)
    expect(snapUnits(-.1, HALF_GRID_SNAP)).toBe(0)
    expect(snapUnits(-1.1)).toBe(-1)
    expect(snapUnits(-.6, HALF_GRID_SNAP)).toBe(-.5)
    expect(clampToDrawer({ x: -0, y: -1, w: 1, h: 1 }, 2, 2)).toEqual({ x: 0, y: 0 })
    expect(gridLines(1)).toEqual([0, .5, 1])
    expect(gridLines(-0, -1)).toEqual([-1, -.5, 0])
  })

  it('takes the snap step from the bin base', () => {
    expect(snapForBin(bin('a', 2, 2))).toBe(1)
    expect(snapForBin(bin('a', 2, 2, 'a', true))).toBe(HALF_GRID_SNAP)
    expect(snapForBin(undefined)).toBe(1)
  })

  it('clamps drawer sizes into the supported range', () => {
    expect(clampDrawerGrid(0.2)).toBe(1)
    expect(clampDrawerGrid(3.4)).toBe(3.5)
    expect(clampDrawerGrid(99)).toBe(40)
  })

  it('keeps a bin inside the drawer', () => {
    expect(clampToDrawer({ x: 5, y: -2, w: 2, h: 1 }, 6, 4)).toEqual({ x: 4, y: 0 })
  })
})

describe('rotations', () => {
  it('cycles through all four quarter turns', () => {
    expect(nextRotation(0)).toBe(90)
    expect(nextRotation(90)).toBe(180)
    expect(nextRotation(180)).toBe(270)
    expect(nextRotation(270)).toBe(0)
  })

  it('swaps width and height only on quarter turns', () => {
    expect(binFootprint(bin('a', 3, 1))).toEqual({ w: 3, h: 1 })
    expect(binFootprint(bin('a', 3, 1), 90)).toEqual({ w: 1, h: 3 })
    expect(binFootprint(bin('a', 3, 1), 180)).toEqual({ w: 3, h: 1 })
    expect(binFootprint(bin('a', 3, 1), 270)).toEqual({ w: 1, h: 3 })
  })

  it('builds rects from placements', () => {
    expect(placementRect(placement('a', 1, 2, 90), bin('a', 3, 1))).toEqual({ x: 1, y: 2, w: 1, h: 3 })
  })

  it('detects overlap only when areas intersect', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(true)
    expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })).toBe(false)
  })
})

describe('binPointToDrawerMm', () => {
  const wide = bin('a', 3, 1)
  const w = 3 * GRID_UNIT
  const d = GRID_UNIT

  it('offsets by the placement origin', () => {
    const point = binPointToDrawerMm({ x: 10, y: 5 }, placement('a', 1, 2), bin('a', 2, 2))
    expect(point).toEqual({ x: GRID_UNIT + 10, y: 2 * GRID_UNIT + 5 })
  })

  it('maps every corner into the rotated footprint', () => {
    // the bin's top-left corner travels clockwise around the footprint
    expect(binPointToDrawerMm({ x: 0, y: 0 }, placement('a', 0, 0, 90), wide)).toEqual({ x: d, y: 0 })
    expect(binPointToDrawerMm({ x: 0, y: 0 }, placement('a', 0, 0, 180), wide)).toEqual({ x: w, y: d })
    expect(binPointToDrawerMm({ x: 0, y: 0 }, placement('a', 0, 0, 270), wide)).toEqual({ x: 0, y: w })
  })

  it('keeps rotated content inside the footprint', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const { w: fw, h: fh } = binFootprint(wide, rotation)
      for (const corner of [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }]) {
        const mapped = binPointToDrawerMm(corner, placement('a', 0, 0, rotation), wide)
        expect(mapped.x).toBeGreaterThanOrEqual(0)
        expect(mapped.y).toBeGreaterThanOrEqual(0)
        expect(mapped.x).toBeLessThanOrEqual(fw * GRID_UNIT)
        expect(mapped.y).toBeLessThanOrEqual(fh * GRID_UNIT)
      }
    }
  })
})

describe('rotationOffsetMm', () => {
  it('shifts a rotated model back into its footprint', () => {
    const wide = bin('a', 3, 1)
    expect(rotationOffsetMm(0, wide)).toEqual({ dx: 0, dz: 0 })
    expect(rotationOffsetMm(90, wide)).toEqual({ dx: GRID_UNIT, dz: 0 })
    expect(rotationOffsetMm(180, wide)).toEqual({ dx: 3 * GRID_UNIT, dz: GRID_UNIT })
    expect(rotationOffsetMm(270, wide)).toEqual({ dx: 0, dz: 3 * GRID_UNIT })
  })
})

describe('findLayoutConflicts', () => {
  it('flags overlapping and out-of-bounds placements by placement id', () => {
    const bins = binById([bin('a', 2, 2), bin('b', 2, 2)])
    const { overlapping, outOfBounds } = findLayoutConflicts(
      [placement('a', 0, 0, 0, 'p1'), placement('b', 1, 0, 0, 'p2'), placement('a', 5, 0, 0, 'p3')],
      bins,
      6,
      4,
    )

    expect(overlapping).toEqual(new Set(['p1', 'p2']))
    expect(outOfBounds).toEqual(new Set(['p3']))
  })

  it('treats copies of one bin as separate placements', () => {
    const bins = binById([bin('a', 1, 1)])
    const { overlapping } = findLayoutConflicts(
      [placement('a', 0, 0, 0, 'p1'), placement('a', 2, 0, 0, 'p2')],
      bins,
      6,
      4,
    )

    expect(overlapping.size).toBe(0)
  })

  it('ignores placements for bins that are gone', () => {
    const { overlapping, outOfBounds } = findLayoutConflicts([placement('missing', 0, 0)], binById([]), 6, 4)

    expect(overlapping.size).toBe(0)
    expect(outOfBounds.size).toBe(0)
  })
})

describe('findFreeSpot', () => {
  it('returns the first free cell scanning rows', () => {
    const spot = findFreeSpot(bin('b', 2, 1), [{ x: 0, y: 0, w: 2, h: 2 }], 4, 4)

    expect(spot).toEqual({ x: 2, y: 0, rotation: 0 })
  })

  it('uses half steps only for half-grid bins', () => {
    const occupied = [{ x: 0, y: 0, w: 1.5, h: 4 }]

    expect(findFreeSpot(bin('b', 1, 1), occupied, 4, 4)).toEqual({ x: 2, y: 0, rotation: 0 })
    expect(findFreeSpot(bin('b', 1, 1, 'b', true), occupied, 4, 4)).toEqual({ x: 1.5, y: 0, rotation: 0 })
  })

  it('falls back to a rotated footprint', () => {
    expect(findFreeSpot(bin('b', 3, 1), [], 1, 4)).toEqual({ x: 0, y: 0, rotation: 90 })
  })

  it('keeps the exact preferred rotation, not just its footprint', () => {
    for (const rotation of [0, 90, 180, 270]) {
      expect(findFreeSpot(bin('b', 3, 1), [], 4, 4, { rotation })).toMatchObject({ rotation })
    }
  })

  it('falls back to the other orientation when the preferred one does not fit', () => {
    // a 3x1 bin only fits upright in a 1x4 drawer
    expect(findFreeSpot(bin('b', 3, 1), [], 1, 4, { rotation: 180 })).toMatchObject({ rotation: 270 })
    expect(findFreeSpot(bin('b', 3, 1), [], 4, 1, { rotation: 90 })).toMatchObject({ rotation: 180 })
  })

  it('treats an unknown rotation as 0', () => {
    expect(findFreeSpot(bin('b', 1, 1), [], 4, 4, { rotation: 45 })).toMatchObject({ rotation: 0 })
  })

  it('returns null when the bin does not fit', () => {
    expect(findFreeSpot(bin('b', 5, 5), [], 4, 4)).toBeNull()
  })
})

describe('autoArrange', () => {
  it('packs the largest bins first and reports what did not fit', () => {
    const bins = binById([bin('small', 1, 1), bin('large', 2, 2), bin('huge', 6, 6)])
    const placements = [
      placement('small', 0, 0, 0, 'p-small'),
      placement('large', 0, 0, 0, 'p-large'),
      placement('huge', 0, 0, 0, 'p-huge'),
    ]

    const result = autoArrange(placements, bins, 3, 2)

    expect(result.placements.map(p => p.id)).toEqual(['p-large', 'p-small', 'p-huge'])
    expect(result.placements[0]).toMatchObject({ bin_id: 'large', x: 0, y: 0, rotation: 0 })
    expect(result.placements[1]).toMatchObject({ bin_id: 'small', x: 2, y: 0, rotation: 0 })
    expect(result.unfittedIds).toEqual(['p-huge'])
  })

  it('never removes a placement that does not fit', () => {
    const bins = binById([bin('a', 3, 2), bin('b', 3, 2)])
    const placements = [
      placement('a', 0, 0, 0, 'p-a'),
      { ...placement('b', 1, 0, 180, 'p-b'), color: '#ff6384' },
    ]

    const result = autoArrange(placements, bins, 3, 2)

    expect(result.placements).toHaveLength(2)
    expect(result.unfittedIds).toEqual(['p-b'])
    // the unfitted copy stays exactly where it was, colour and all
    expect(result.placements.find(p => p.id === 'p-b')).toEqual(placements[1])
  })

  it('flags what did not fit through the regular conflict checks', () => {
    const bins = binById([bin('a', 3, 2), bin('b', 3, 2)])
    const placements = [placement('a', 0, 0, 0, 'p-a'), placement('b', 0, 0, 0, 'p-b')]

    const result = autoArrange(placements, bins, 3, 2)
    const { overlapping, outOfBounds } = findLayoutConflicts(result.placements, bins, 3, 2)

    for (const id of result.unfittedIds) {
      expect(overlapping.has(id) || outOfBounds.has(id)).toBe(true)
    }
  })

  it('leaves placements of bins that are not loaded untouched', () => {
    const bins = binById([bin('a', 1, 1)])
    const orphan = placement('gone', 4, 3, 90, 'p-gone')

    const result = autoArrange([placement('a', 2, 2, 0, 'p-a'), orphan], bins, 6, 4)

    expect(result.placements).toContainEqual(orphan)
    expect(result.unfittedIds).toEqual([])
  })

  it('keeps each placement orientation', () => {
    const bins = binById([bin('a', 3, 1), bin('b', 3, 1)])
    const placements = [placement('a', 0, 0, 180, 'p-a'), placement('b', 0, 2, 270, 'p-b')]

    const result = autoArrange(placements, bins, 4, 4)

    expect(result.placements.find(p => p.id === 'p-a')?.rotation).toBe(180)
    expect(result.placements.find(p => p.id === 'p-b')?.rotation).toBe(270)
  })

  it('keeps copies of the same bin apart', () => {
    const bins = binById([bin('a', 2, 1)])
    const placements = [
      placement('a', 0, 0, 0, 'p1'),
      placement('a', 0, 0, 0, 'p2'),
      placement('a', 0, 0, 0, 'p3'),
    ]

    const result = autoArrange(placements, bins, 4, 4)
    const { overlapping } = findLayoutConflicts(result.placements, bins, 4, 4)

    expect(result.placements).toHaveLength(3)
    expect(overlapping.size).toBe(0)
  })
})

describe('drawerStats', () => {
  it('sums used units across placements and counts unplaced bins', () => {
    const bins = [bin('a', 2, 2), bin('b', 1, 1), bin('c', 3, 1)]

    const stats = drawerStats(
      [placement('a', 0, 0, 0, 'p1'), placement('a', 2, 0, 0, 'p2'), placement('b', 4, 0, 0, 'p3')],
      bins,
      6,
      4,
    )

    expect(stats.drawerUnits).toBe(24)
    expect(stats.usedUnits).toBe(9)
    expect(stats.freeUnits).toBe(15)
    expect(stats.coverage).toBeCloseTo(9 / 24)
    expect(stats.placementCount).toBe(3)
    expect(stats.placedBinCount).toBe(2)
    expect(stats.unplacedBinCount).toBe(1)
  })
})

describe('supported stacks', () => {
  const lower = placement('a', 0, 0, 0, 'lower')
  const upper = { ...placement('a', 0, 0, 0, 'upper'), support_id: 'lower' }
  const bins = [bin('a', 2, 1), bin('b', 1, 1)]

  it('counts a stack and overlapping floor copies as a union, not extra capacity', () => {
    const stats = drawerStats([lower, upper, placement('a', 0, 0, 0, 'copy')], bins, 4, 2)
    expect(stats.usedUnits).toBe(2)
    expect(stats.freeUnits).toBe(6)
    const conflicts = findLayoutConflicts([lower, upper], binById(bins), 4, 2)
    expect(conflicts.overlapping.size).toBe(0)
    expect(findLayoutConflicts([lower, upper, placement('a', 0, 0, 0, 'copy')], binById(bins), 4, 2).overlapping.has('copy')).toBe(true)
  })

  it('moves and rotates every member without changing relative orientation', () => {
    const result = transformStack([lower, { ...upper, rotation: 180 }], 'upper', 1, 1, 90)
    expect(result.map(p => [p.id, p.x, p.y, p.rotation])).toEqual([['lower', 1, 1, 90], ['upper', 1, 1, 270]])
    expect(result[1].support_id).toBe('lower')
  })

  it('preserves stacks while auto-arranging independent floor placements', () => {
    const result = autoArrange([lower, upper, placement('b', 0, 0, 0, 'independent')], binById(bins), 4, 2)
    expect(result.placements).toContainEqual(lower)
    expect(result.placements).toContainEqual(upper)
    expect(findLayoutConflicts(result.placements, binById(bins), 4, 2).overlapping.size).toBe(0)
  })

  it('never rounds a non-grid container edge upward while clamping', () => {
    expect(clampToDrawer({ x: 3, y: 0, w: 1, h: 1 }, 100 / 42, 2, 1).x).toBe(1)
    expect(clampToDrawer({ x: 3, y: 0, w: 1, h: 1 }, 100 / 42, 2, .5).x).toBe(1)
    expect(findFreeSpot(bin('large', 2.5, 1), [], 100 / 42, 2)).toBeNull()
  })
})

describe('photo-derived boundary', () => {
  const outline = (points: [number, number][], interiorRings: [number, number][][] = []): DrawerOutline => ({
    points: points.map(([x, y]) => ({ x, y })),
    interior_rings: interiorRings.map(ring => ring.map(([x, y]) => ({ x, y }))),
  })
  const fp = (outlineValue: DrawerOutline, fitClearanceMm = 0, rotationDeg = 0) => ({
    outline: outlineValue,
    originXmm: 0,
    originYmm: 0,
    rotationDeg,
    fitClearanceMm,
  })

  // the boundary sits just outside a 2x2 grid; the obstruction lies over cell (1,1)
  const withHole = outline([[-5, -5], [89, -5], [89, 89], [-5, 89]], [[[50, 50], [60, 50], [60, 60], [50, 60]]])
  // a thin slit cut in from the bottom edge, between the two bottom cells' corners
  const slit = outline([[-5, -5], [89, -5], [89, 89], [60, 89], [60, 40], [52, 40], [52, 89], [-5, 89]])
  const frame = outline([[-5, -5], [89, -5], [89, 89], [-5, 89]])

  it('rejects a footprint over a concavity even though every corner is inside', () => {
    expect(rectFitsFootprint({ x: 0, y: 0, w: 1, h: 1 }, 2, 2, fp(slit))).toBe(true)
    expect(rectFitsFootprint({ x: 1, y: 1, w: 1, h: 1 }, 2, 2, fp(slit))).toBe(false)
  })

  it('rejects a footprint covering an interior exclusion', () => {
    expect(rectFitsFootprint({ x: 0, y: 0, w: 1, h: 1 }, 2, 2, fp(withHole))).toBe(true)
    expect(rectFitsFootprint({ x: 1, y: 1, w: 1, h: 1 }, 2, 2, fp(withHole))).toBe(false)
  })

  it('keeps the fit clearance out of the boundary', () => {
    expect(rectFitsFootprint({ x: 0, y: 0, w: 1, h: 1 }, 2, 2, fp(frame, 0))).toBe(true)
    expect(rectFitsFootprint({ x: 0, y: 0, w: 1, h: 1 }, 2, 2, fp(frame, 3))).toBe(true)
    expect(rectFitsFootprint({ x: 0, y: 0, w: 1, h: 1 }, 2, 2, fp(frame, 10))).toBe(false)
  })

  it('flags placements outside the boundary as out of bounds', () => {
    const bins = binById([bin('a', 1, 1)])
    const { outOfBounds } = findLayoutConflicts(
      [placement('a', 0, 0, 0, 'inside'), placement('a', 1, 1, 0, 'obstructed')],
      bins, 2, 2, fp(withHole),
    )

    expect(outOfBounds).toEqual(new Set(['obstructed']))
  })

  it('never lets automatic packing choose a spot outside the boundary', () => {
    const bins = binById([bin('a', 1, 1)])
    const occupied = [{ x: 0, y: 0, w: 1, h: 1 }, { x: 1, y: 0, w: 1, h: 1 }, { x: 0, y: 1, w: 1, h: 1 }]

    // the rectangle-only rule would happily pick the obstructed corner
    expect(findFreeSpot(bin('a', 1, 1), occupied, 2, 2)).toEqual({ x: 1, y: 1, rotation: 0 })
    expect(findFreeSpot(bin('a', 1, 1), occupied, 2, 2, { footprint: fp(withHole) })).toBeNull()

    const result = autoArrange([
      placement('a', 0, 0, 0, 'p1'), placement('a', 0, 0, 0, 'p2'),
      placement('a', 0, 0, 0, 'p3'), placement('a', 0, 0, 0, 'p4'),
    ], bins, 2, 2, fp(withHole))

    expect(result.placements).toHaveLength(4)
    expect(result.unfittedIds).toHaveLength(1)
    for (const placed of result.placements) {
      if (result.unfittedIds.includes(placed.id)) continue
      expect(rectFitsFootprint(placementRect(placed, bins.get('a')!), 2, 2, fp(withHole))).toBe(true)
    }
  })

  it('measures available floor from the boundary, not the rectangle', () => {
    const stats = drawerStats([placement('a', 0, 0, 0, 'p1')], [bin('a', 1, 1)], 2, 2, fp(withHole))

    // 16 half-cells in the 2x2 grid; the 10x10mm hole sits inside cell (1,1) only,
    // whose four corners bracket it, so 15 cells x 0.25 = 3.75 units of floor
    expect(stats.drawerUnits).toBe(3.75)
    expect(stats.usedUnits).toBe(1)
  })

  it('turns the footprint with the grid so a drawer edge off the paper axes still fits', () => {
    // a 90x45mm floor turned exactly 30 degrees: only the grid sharing that turn
    // fits a 2x1 bin whose corner and edges land on the floor's own corner/edges
    const turned = outline(
      ([[0, 0], [90, 0], [90, 45], [0, 45]] as [number, number][]).map(([x, y]) => {
        const point = rotatePoint({ x, y }, Math.PI / 6)
        return [point.x, point.y] as [number, number]
      }),
    )

    expect(rectFitsFootprint({ x: 0, y: 0, w: 2, h: 1 }, 3, 3, fp(turned, 0, 30))).toBe(true)
    expect(rectFitsFootprint({ x: 0, y: 0, w: 2, h: 1 }, 3, 3, fp(turned, 0, 0))).toBe(false)
    // nominal contact is fine at zero clearance, but the fit gap is Euclidean
    expect(rectFitsFootprint({ x: 0, y: 0, w: 2, h: 1 }, 3, 3, fp(turned, 5, 30))).toBe(false)
  })

  it('lets the measured boundary, not the display grid, decide for a photo plan', () => {
    // An 84x84mm floor inside a stored 1x1 legacy display rectangle still fits
    // a 2x1 bin: scans and capacity must cover the same floor as containment.
    const floor = outline([[0, 0], [84, 0], [84, 84], [0, 84]])

    expect(rectFitsFootprint({ x: 0, y: 0, w: 2, h: 1 }, 1, 1, fp(floor))).toBe(true)
    expect(rectFitsFootprint({ x: 0, y: 0, w: 2, h: 1 }, 1, 1, null)).toBe(false)
    expect(findFreeSpot(bin('large', 2, 1), [], 1, 1, { footprint: fp(floor) })).toEqual({ x: 0, y: 0, rotation: 0 })
    const arranged = autoArrange([placement('large', 9, 9)], binById([bin('large', 2, 1)]), 1, 1, fp(floor))
    expect(arranged.unfittedIds).toEqual([])
    expect(arranged.placements[0]).toMatchObject({ x: 0, y: 0 })
    expect(drawerStats(arranged.placements, [bin('large', 2, 1)], 1, 1, fp(floor))).toMatchObject({
      drawerUnits: 4, usedUnits: 2, freeUnits: 2,
    })
  })

  it('scans, clamps and renders negative cells in the current offset, non-cardinal frame', () => {
    const origin = { x: 63, y: 42 }
    const points = [
      { x: -42, y: -21 }, { x: 42, y: -21 }, { x: 42, y: 63 }, { x: -42, y: 63 },
    ].map(p => {
      const turned = rotatePoint(p, Math.PI / 6)
      return { x: turned.x + origin.x, y: turned.y + origin.y }
    })
    const footprint = { outline: { points, interior_rings: [] }, originXmm: 63, originYmm: 42, rotationDeg: 30, fitClearanceMm: 0 }
    const bounds = drawerGridBounds(1, 1, footprint)
    expect(bounds.x0).toBeCloseTo(-1)
    expect(bounds.y0).toBeCloseTo(-.5)
    expect(bounds.x1).toBeCloseTo(1)
    expect(bounds.y1).toBeCloseTo(1.5)
    expect(gridLines(1, -1)).toEqual([-1, -.5, 0, .5, 1])
    expect(findFreeSpot(bin('large', 2, 1), [], 1, 1, { footprint })).toEqual({ x: -1, y: 0, rotation: 0 })
    expect(clampToDrawer({ x: -1, y: 0, w: 2, h: 1 }, 1, 1, 1, footprint)).toEqual({ x: -1, y: 0 })
    expect(clampToDrawer({ x: 3, y: -3, w: 1, h: 1 }, 1, 1, .5, footprint)).toEqual({ x: 0, y: -.5 })
    expect(drawerStats([placement('large', -1, 0)], [bin('large', 2, 1)], 1, 1, footprint)).toMatchObject({
      drawerUnits: 4, usedUnits: 2, freeUnits: 2,
    })
  })
})

