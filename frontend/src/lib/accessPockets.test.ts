import { describe, expect, it } from 'vitest'
import type { AccessPocket } from '@/types'
import {
  clampPocket,
  defaultPocket,
  effectivePocketDepth,
  pocketCorners,
  pocketDisplay,
  resizePocketFromCorner,
  resolvePocketEdge,
  validatePocket,
} from '@/lib/accessPockets'

const pocket = (over: Partial<AccessPocket> = {}): AccessPocket => ({
  id: 'p1', shape: 'rectangle', x: 42, y: 42, length: 30, width: 20, depth: 8,
  rotation: 0, edge: 'inherit', edge_size: 1, corner_radius: 0, bottom_radius: 0,
  ...over,
})

describe('resolvePocketEdge', () => {
  it('sharp always overrides the bin chamfer', () => {
    expect(resolvePocketEdge(pocket({ edge: 'sharp' }), 3, 20)).toEqual({ kind: 'sharp', size: 0 })
  })

  it('inherit follows the bin chamfer and is sharp when it is off', () => {
    expect(resolvePocketEdge(pocket(), 0, 20)).toEqual({ kind: 'sharp', size: 0 })
    expect(resolvePocketEdge(pocket(), 3, 20)).toEqual({ kind: 'chamfer', size: 3 })
  })

  it('clamps an inherited chamfer below the pocket depth', () => {
    expect(resolvePocketEdge(pocket({ depth: 5 }), 8, 20)).toEqual({ kind: 'chamfer', size: 4 })
  })

  it('keeps explicit chamfer and fillet distinct and clamped', () => {
    expect(resolvePocketEdge(pocket({ edge: 'fillet', edge_size: 2 }), 0, 20)).toEqual({ kind: 'fillet', size: 2 })
    expect(resolvePocketEdge(pocket({ edge: 'chamfer', edge_size: 2 }), 0, 20)).toEqual({ kind: 'chamfer', size: 2 })
  })
})

describe('effectivePocketDepth', () => {
  it('clamps to the protected-floor maximum without going below the minimum', () => {
    expect(effectivePocketDepth(pocket({ depth: 50 }), 21.25)).toBe(21.25)
    expect(effectivePocketDepth(pocket({ depth: 0.1 }), 21.25)).toBe(0.25)
  })
})

describe('validatePocket', () => {
  it('accepts a default rectangle and rejects impossible radii', () => {
    expect(validatePocket(pocket(), 20)).toBeNull()
    expect(validatePocket(pocket({ corner_radius: 11 }), 20)).toMatch(/Corner radius/)
    expect(validatePocket(pocket({ bottom_radius: 9 }), 20)).toMatch(/Bottom radius/)
  })

  it('rejects radii and edge sizes that do not apply', () => {
    expect(validatePocket(pocket({ shape: 'scoop', corner_radius: 1 }), 20)).toMatch(/intrinsic curvature/)
    expect(validatePocket(pocket({ edge: 'chamfer', edge_size: 8 }), 20)).toMatch(/smaller than the pocket depth/)
    expect(validatePocket(pocket({ length: Number.NaN }), 20)).toMatch(/finite/)
  })
})

describe('clampPocket', () => {
  it('keeps a live edit within the generator limits', () => {
    const clamped = clampPocket(pocket({ depth: 50, corner_radius: 12 }), 21.25)
    expect(clamped.depth).toBe(21.25)
    expect(clamped.corner_radius).toBe(10)
  })

  it('clears the redundant radii on a scoop', () => {
    const clamped = clampPocket(pocket({ shape: 'scoop', corner_radius: 4, bottom_radius: 4 }), 20)
    expect(clamped.corner_radius).toBe(0)
    expect(clamped.bottom_radius).toBe(0)
  })

  it('clamps an explicit opening-edge size below the pocket depth', () => {
    const rect = clampPocket(pocket({ edge: 'chamfer', edge_size: 50, depth: 8 }), 21.25)
    expect(rect.edge_size).toBeCloseTo(7.99)
    const scoop = clampPocket(pocket({ shape: 'scoop', edge: 'fillet', edge_size: 50, depth: 8 }), 21.25)
    expect(scoop.edge_size).toBeCloseTo(7.99)
  })
})

describe('defaultPocket', () => {
  it('matches the contract defaults', () => {
    expect(defaultPocket('rectangle', 1, 2)).toMatchObject({
      shape: 'rectangle', x: 1, y: 2, corner_radius: 0, bottom_radius: 0, edge: 'inherit',
    })
    expect(defaultPocket('scoop', 1, 2)).toMatchObject({ shape: 'scoop', edge: 'fillet', edge_size: 1 })
  })
})

describe('pocketDisplay', () => {
  it('scales the nominal outline and omits the envelope for a sharp edge', () => {
    const display = pocketDisplay(pocket(), 0, 20)
    expect(display).toMatchObject({ cx: 336, cy: 336, length: 240, width: 160, cornerRadius: 0, envelope: null })
  })

  it('adds the finishing envelope when the opening edge is widened', () => {
    const display = pocketDisplay(pocket(), 3, 20)
    expect(display.envelope).toMatchObject({ length: 240 + 48, width: 160 + 48, radius: 0 + 24, size: 24 })
  })

  it('describes the scoop plan shape as a capsule or an ellipse', () => {
    expect(pocketDisplay(pocket({ shape: 'scoop' }), 0, 20).shape).toBe('capsule')
    expect(pocketDisplay(pocket({ shape: 'scoop', length: 12, width: 20 }), 0, 20).shape).toBe('ellipse')
  })
})

describe('pocketCorners and resize', () => {
  it('lists the four nominal corners in bin space', () => {
    expect(pocketCorners(pocket({ x: 0, y: 0, length: 40, width: 20 }))).toEqual([
      { x: -20, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 10 }, { x: -20, y: 10 },
    ])
  })

  it('resizes from a dragged corner with the opposite corner fixed', () => {
    const resized = resizePocketFromCorner(pocket({ x: 0, y: 0, length: 20, width: 10 }), 2, 30, 25)
    expect(resized).toMatchObject({ x: 10, y: 10, length: 40, width: 30 })
  })

  it('floors a collapsed resize at the minimum size', () => {
    const resized = resizePocketFromCorner(pocket({ x: 0, y: 0, length: 20, width: 10 }), 2, -10, -5)
    expect(resized.length).toBe(1)
    expect(resized.width).toBe(1)
  })
})
