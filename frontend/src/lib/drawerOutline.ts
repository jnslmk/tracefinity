import type { DrawerOutline, Point, Polygon } from '@/types'
import { GRID_UNIT } from '@/lib/constants'

/**
 * Drawer-floor polygon maths, mirroring backend `drawer_outline.py`.
 *
 * A footprint is only covered when the whole rectangle is inside the usable
 * floor: corners inside are not enough, because a concave notch or an interior
 * exclusion can cross an edge while every corner stays inside. The 2D floor,
 * the 3D floor, warnings, packing and the area stats all use these functions so
 * the preview and the backend assessment agree.
 */

export interface Rect { x0: number; y0: number; x1: number; y1: number }

const EPS = 1e-6
const AREA_EPS = 1e-3

export function ringArea(ring: Point[]): number {
  let total = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    total += a.x * b.y - b.x * a.y
  }
  return total / 2
}

export function outlineArea(outline: DrawerOutline): number {
  return Math.abs(ringArea(outline.points)) -
    outline.interior_rings.reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0)
}

export function outlinePerimeter(outline: DrawerOutline): number {
  const run = (ring: Point[]) => {
    let total = 0
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      total += Math.hypot(b.x - a.x, b.y - a.y)
    }
    return total
  }
  return run(outline.points) + outline.interior_rings.reduce((sum, ring) => sum + run(ring), 0)
}

export function outlineBounds(outline: DrawerOutline): Rect {
  const xs = outline.points.map(p => p.x)
  const ys = outline.points.map(p => p.y)
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

export function pointInRing(point: Point, ring: Point[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if ((a.y > point.y) !== (b.y > point.y)) {
      const xCross = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      if (point.x < xCross) inside = !inside
    }
  }
  return inside
}

/** True when the point lies on one of the ring's edges. */
function onRingEdge(point: Point, ring: Point[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    if (Math.abs(orient(a, b, point)) <= EPS && onSegment(a, b, point)) return true
  }
  return false
}

/**
 * Usable-floor membership: the outer ring counts its own boundary (a nominal
 * footprint touching the floor edge is covered at zero clearance) while an
 * exclusion does not (grazing an obstruction does not push a footprint out).
 */
export function pointInOutline(point: Point, outline: DrawerOutline): boolean {
  if (!pointInRing(point, outline.points) && !onRingEdge(point, outline.points)) return false
  return !outline.interior_rings.some(ring => pointInRing(point, ring) && !onRingEdge(point, ring))
}

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) - EPS <= p.x && p.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= p.y && p.y <= Math.max(a.y, b.y) + EPS &&
    Math.abs(orient(a, b, p)) <= EPS
  )
}

export function segmentsIntersect(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
  const d1 = orient(b0, b1, a0)
  const d2 = orient(b0, b1, a1)
  const d3 = orient(a0, a1, b0)
  const d4 = orient(a0, a1, b1)
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
      ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true
  }
  return (
    (Math.abs(d1) <= EPS && onSegment(b0, b1, a0)) ||
    (Math.abs(d2) <= EPS && onSegment(b0, b1, a1)) ||
    (Math.abs(d3) <= EPS && onSegment(a0, a1, b0)) ||
    (Math.abs(d4) <= EPS && onSegment(a0, a1, b1))
  )
}

export function ringIsSimple(ring: Point[]): boolean {
  const count = ring.length
  if (count < 3) return false
  const edges: [Point, Point][] = ring.map((p, i) => [p, ring[(i + 1) % count]])
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (j === i + 1 || (i === 0 && j === count - 1)) continue
      if (segmentsIntersect(edges[i][0], edges[i][1], edges[j][0], edges[j][1])) return false
    }
  }
  return true
}

function ringsCross(a: Point[], b: Point[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i]
    const a1 = a[(i + 1) % a.length]
    for (let j = 0; j < b.length; j++) {
      const b0 = b[j]
      const b1 = b[(j + 1) % b.length]
      if (segmentsIntersect(a0, a1, b0, b1)) return true
    }
  }
  return false
}

/** Return a user-facing problem, or null when the boundary is usable. */
export function validateOutline(outline: DrawerOutline): string | null {
  const rings: [string, Point[]][] = [
    ['the outline', outline.points],
    ...outline.interior_rings.map((ring, i): [string, Point[]] => [`exclusion ${i + 1}`, ring]),
  ]
  for (const [label, ring] of rings) {
    if (ring.length < 3) return `${label} needs at least 3 points`
    if (ring.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return `${label} has a non-finite point`
    if (Math.abs(ringArea(ring)) < AREA_EPS) return `${label} encloses no area`
    if (!ringIsSimple(ring)) return `${label} crosses itself`
  }
  for (let i = 0; i < outline.interior_rings.length; i++) {
    const hole = outline.interior_rings[i]
    if (!hole.every(p => pointInRing(p, outline.points))) return `exclusion ${i + 1} is not inside the outline`
    if (ringsCross(hole, outline.points)) return `exclusion ${i + 1} crosses the outline`
    for (let j = i + 1; j < outline.interior_rings.length; j++) {
      const other = outline.interior_rings[j]
      if (ringsCross(hole, other)) return `exclusions ${i + 1} and ${j + 1} overlap`
      // nested rings cross nothing but subtract twice and render as an island
      if (hole.some(p => pointInRing(p, other)) || other.some(p => pointInRing(p, hole))) {
        return `exclusions ${i + 1} and ${j + 1} overlap`
      }
    }
  }
  return null
}

/**
 * Rotate about the origin in y-down space (positive turns clockwise on screen).
 * Mirrors the backend so preview and assessment agree on a turned grid.
 */
export function rotatePoint(point: Point, radians: number): Point {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos }
}

/** Convert a drawer-space point into the grid frame (anchor + turn). */
export function toGridLocal(point: Point, origin: Point, rotationDeg: number): Point {
  const offset = { x: point.x - origin.x, y: point.y - origin.y }
  return rotatePoint(offset, (-rotationDeg * Math.PI) / 180)
}

/** The four corners of a grid footprint in drawer millimetres. */
export function footprintCorners(
  origin: Point,
  rotationDeg: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Point[] {
  const radians = (rotationDeg * Math.PI) / 180
  const local: Point[] = [
    { x: x * GRID_UNIT, y: y * GRID_UNIT },
    { x: (x + w) * GRID_UNIT, y: y * GRID_UNIT },
    { x: (x + w) * GRID_UNIT, y: (y + h) * GRID_UNIT },
    { x: x * GRID_UNIT, y: (y + h) * GRID_UNIT },
  ]
  return local.map(point => {
    const rotated = rotatePoint(point, radians)
    return { x: origin.x + rotated.x, y: origin.y + rotated.y }
  })
}

/** Strictly-inside test for a convex footprint; boundary points are not inside. */
function pointInShape(point: Point, points: Point[]): boolean {
  let sign = 0
  for (let i = 0; i < points.length; i++) {
    const cross = orient(points[i], points[(i + 1) % points.length], point)
    if (Math.abs(cross) <= EPS) return false
    const current = cross > 0 ? 1 : -1
    if (sign !== 0 && current !== sign) return false
    sign = current
  }
  return sign !== 0
}

/** True when any part of the segment lies strictly inside the convex footprint. */
function segmentEntersShape(a: Point, b: Point, points: Point[]): boolean {
  const count = points.length
  const winding = ringArea(points) > 0 ? 1 : -1
  const dx = b.x - a.x
  const dy = b.y - a.y
  let tEnter = 0
  let tExit = 1
  let alongBoundary = false
  for (let i = 0; i < count; i++) {
    const p0 = points[i]
    const p1 = points[(i + 1) % count]
    const offset = winding * orient(p0, p1, a)
    const slope = winding * ((p1.x - p0.x) * dy - (p1.y - p0.y) * dx)
    if (Math.abs(slope) <= EPS) {
      if (offset < -EPS) return false
      if (Math.abs(offset) <= EPS) alongBoundary = true
      continue
    }
    const t = -offset / slope
    if (slope > 0) tEnter = Math.max(tEnter, t)
    else tExit = Math.min(tExit, t)
    if (tEnter > tExit) return false
  }
  if (tExit - tEnter <= EPS) return false
  return !alongBoundary
}

/**
 * True when a convex footprint is covered by the usable floor. Vertices inside
 * are not enough: a notch or exclusion edge can pass through the footprint while
 * every vertex stays inside. Only an edge entering the footprint's *interior*
 * breaks coverage, so a nominal footprint touching the boundary is covered at
 * zero clearance. `clearance` is the Euclidean gap every boundary edge must keep,
 * not a per-axis expansion.
 */
export function shapeInsideOutline(points: Point[], outline: DrawerOutline, clearance = 0): boolean {
  if (points.length < 3 || !points.every(point => pointInOutline(point, outline))) return false
  for (const ring of [outline.points, ...outline.interior_rings]) {
    for (let i = 0; i < ring.length; i++) {
      if (segmentEntersShape(ring[i], ring[(i + 1) % ring.length], points)) return false
    }
  }
  for (const hole of outline.interior_rings) {
    if (hole.some(point => pointInShape(point, points))) return false
    // an exclusion sharing a boundary edge, both interiors on the same side,
    // coincides with the footprint instead of merely touching it
    if (sharesInteriorSide(points, hole)) return false
  }
  if (clearance > 0) {
    for (const ring of [outline.points, ...outline.interior_rings]) {
      for (let i = 0; i < ring.length; i++) {
        const a0 = ring[i]
        const a1 = ring[(i + 1) % ring.length]
        for (let j = 0; j < points.length; j++) {
          if (segmentDistance(a0, a1, points[j], points[(j + 1) % points.length]) < clearance - EPS) return false
        }
      }
    }
  }
  return true
}

function ringCentroid(ring: Point[]): Point {
  const area = ringArea(ring)
  if (Math.abs(area) < EPS) return ring[0]
  let cx = 0
  let cy = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const cross = a.x * b.y - b.x * a.y
    cx += (a.x + b.x) * cross
    cy += (a.y + b.y) * cross
  }
  return { x: cx / (6 * area), y: cy / (6 * area) }
}

function segmentsOverlap(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
  const dx = a1.x - a0.x
  const dy = a1.y - a0.y
  const [lo, hi] = Math.abs(dx) >= Math.abs(dy)
    ? [Math.min(a0.x, a1.x), Math.max(a0.x, a1.x)]
    : [Math.min(a0.y, a1.y), Math.max(a0.y, a1.y)]
  const [bLo, bHi] = Math.abs(dx) >= Math.abs(dy)
    ? [Math.min(b0.x, b1.x), Math.max(b0.x, b1.x)]
    : [Math.min(b0.y, b1.y), Math.max(b0.y, b1.y)]
  return Math.min(hi, bHi) - Math.max(lo, bLo) > EPS
}

function sharesInteriorSide(points: Point[], hole: Point[]): boolean {
  const footprintCentroid = ringCentroid(points)
  // the exclusion's interior side of its own edge follows its winding, not its
  // area centroid: a U-shaped hole can wrap around the footprint and place its
  // centroid inside it while the shared edge is still harmless contact
  const interiorSign = ringArea(hole) > 0 ? 1 : -1
  for (let i = 0; i < hole.length; i++) {
    const h0 = hole[i]
    const h1 = hole[(i + 1) % hole.length]
    for (let j = 0; j < points.length; j++) {
      const p0 = points[j]
      const p1 = points[(j + 1) % points.length]
      if (Math.abs(orient(h0, h1, p0)) > EPS || Math.abs(orient(h0, h1, p1)) > EPS) continue
      if (!segmentsOverlap(h0, h1, p0, p1)) continue
      if (interiorSign * orient(h0, h1, footprintCentroid) > 0) return true
    }
  }
  return false
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq <= EPS) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Euclidean distance between two segments; zero when they touch or cross. */
function segmentDistance(a0: Point, a1: Point, b0: Point, b1: Point): number {
  if (segmentsIntersect(a0, a1, b0, b1)) return 0
  return Math.min(
    pointSegmentDistance(a0, b0, b1),
    pointSegmentDistance(a1, b0, b1),
    pointSegmentDistance(b0, a0, a1),
    pointSegmentDistance(b1, a0, a1),
  )
}

/** True when an axis-aligned rectangle is covered and keeps `clearance`. */
export function rectInsideOutline(rect: Rect, outline: DrawerOutline, clearance = 0): boolean {
  if (rect.x1 - rect.x0 <= EPS || rect.y1 - rect.y0 <= EPS) return false
  return shapeInsideOutline(
    [
      { x: rect.x0, y: rect.y0 }, { x: rect.x1, y: rect.y0 },
      { x: rect.x1, y: rect.y1 }, { x: rect.x0, y: rect.y1 },
    ],
    outline,
    clearance,
  )
}

/** Split a saved boundary into editable polygons: outer first, then exclusions. */
export function outlineToPolygons(outline: DrawerOutline): Polygon[] {
  return [
    { id: 'drawer-outline', label: 'Floor boundary', points: outline.points, finger_holes: [], interior_rings: [] },
    ...outline.interior_rings.map((ring, i) => ({
      id: `drawer-exclusion-${i + 1}`,
      label: `Exclusion ${i + 1}`,
      points: ring,
      finger_holes: [],
      interior_rings: [],
    })),
  ]
}

/** Recombine editable polygons into a boundary; later polygons are exclusions. */
export function polygonsToOutline(polygons: Polygon[]): DrawerOutline | null {
  const usable = polygons.filter(p => p.points.length >= 3)
  if (usable.length === 0) return null
  return {
    points: usable[0].points,
    interior_rings: usable.slice(1).map(p => p.points),
  }
}
