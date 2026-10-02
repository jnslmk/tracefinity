import { describe, it, expect } from 'vitest'
import type { Point } from '@/types'
import { smoothEpsilon, simplifyPolygon, smoothPathData } from './svg'

function denseRectangle(width: number, height: number, pointsPerEdge = 200): Point[] {
  const points: Point[] = []
  for (let i = 0; i < pointsPerEdge; i++) points.push({ x: width * i / pointsPerEdge, y: 0 })
  for (let i = 0; i < pointsPerEdge; i++) points.push({ x: width, y: height * i / pointsPerEdge })
  for (let i = 0; i < pointsPerEdge; i++) points.push({ x: width - width * i / pointsPerEdge, y: height })
  for (let i = 0; i < pointsPerEdge; i++) points.push({ x: 0, y: height - height * i / pointsPerEdge })
  return points
}

function pathPoints(path: string): Point[] {
  return [...path.matchAll(/[ML]\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }))
}

function lowerEdgeYAt(points: Point[], x: number): number {
  const intersections: number[] = []
  for (let i = 0; i < points.length; i++) {
    const p0 = points[i]
    const p1 = points[(i + 1) % points.length]
    if (p0.x === p1.x || x < Math.min(p0.x, p1.x) || x > Math.max(p0.x, p1.x)) continue
    const t = (x - p0.x) / (p1.x - p0.x)
    intersections.push(p0.y + t * (p1.y - p0.y))
  }
  return Math.min(...intersections)
}

describe('smoothEpsilon', () => {
  // must mirror backend polygon_scaler.smooth_epsilon exactly: absolute mm,
  // independent of tool size (trace noise does not scale with the tool)
  it('returns absolute values matching the backend', () => {
    expect(smoothEpsilon(0)).toBeCloseTo(0.3, 6)
    expect(smoothEpsilon(0.5)).toBeCloseTo(0.9, 6)
    expect(smoothEpsilon(1)).toBeCloseTo(1.5, 6)
  })

  it('is monotonic in level', () => {
    const eps = [0, 0.25, 0.5, 0.75, 1].map(smoothEpsilon)
    expect([...eps].sort((a, b) => a - b)).toEqual(eps)
  })
})

describe('simplifyPolygon', () => {
  it('removes near-collinear points within epsilon', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0.01 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ]
    const out = simplifyPolygon(pts, 0.3)
    expect(out.length).toBe(4)
  })
})

describe('smoothPathData', () => {
  it('preserves long straight edges away from corners', () => {
    const raw = denseRectangle(84, 20)
    const simplified = simplifyPolygon(raw, smoothEpsilon(0.5))

    const smoothed = pathPoints(smoothPathData(simplified))

    expect(lowerEdgeYAt(smoothed, 20)).toBeLessThanOrEqual(0.1)
  })
})

// A densely sampled edge carrying a bump and a notch shallower than the level 1
// smoothing tolerance: the simplifier drops both.
function tracedWithTip(): Point[] {
  const top: Point[] = []
  for (let i = 0; i <= 10; i++) top.push({ x: 6 * i, y: 0 })
  top[5] = { x: 30, y: -1.4 }
  top[7] = { x: 42, y: 1.4 }
  return [...top, { x: 60, y: 40 }, { x: 0, y: 40 }]
}

function pathRings(path: string): Point[][] {
  return path.split('Z').map(segment => pathPoints(segment)).filter(ring => ring.length >= 3)
}

function pointInRing(ring: Point[], p: Point): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

// the emitted subpaths are wound so the nonzero fill rule paints their union:
// the two outer rings add winding, interior rings subtract it.
function painted(rings: Point[][], p: Point): boolean {
  let winding = 0
  rings.forEach((ring, index) => {
    if (pointInRing(ring, p)) winding += index < 2 ? 1 : -1
  })
  return winding !== 0
}

describe('smoothPathData non-eroding union', () => {
  const raw = tracedWithTip()
  const simplified = simplifyPolygon(raw, smoothEpsilon(1))

  it('paints the traced tip the simplifier dropped', () => {
    const rings = pathRings(smoothPathData(simplified, undefined, 1, raw))

    expect(rings.length).toBe(2)
    // the tip is outside the smoothed ring, so only the traced ring covers it
    expect(pointInRing(rings[0], { x: 30, y: -1.2 })).toBe(false)
    expect(painted(rings, { x: 30, y: -1.2 })).toBe(true)
    expect(painted(rings, { x: 30, y: -2.5 })).toBe(false)
  })

  it('still paints the material smoothing added', () => {
    const rings = pathRings(smoothPathData(simplified, undefined, 1, raw))

    // the bridged notch sits outside the traced ring but inside the smoothed one
    expect(painted(rings, { x: 42, y: 1.2 })).toBe(true)
  })

  it('keeps an island hollow when both rings agree it is empty', () => {
    const hole = [
      { x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 30 }, { x: 20, y: 30 },
    ]
    const rings = pathRings(smoothPathData(simplified, [hole], 1, raw))

    expect(rings.length).toBe(4)
    expect(painted(rings, { x: 30, y: 25 })).toBe(false)
    expect(painted(rings, { x: 30, y: 10 })).toBe(true)
  })
})
