import { describe, it, expect } from 'vitest'
import type { Point } from '@/types'
import { simplifyPolygon } from './svg'

function pointInRing(ring: Point[], p: Point): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

describe('simplifyPolygon', () => {
  it('drops sub-tolerance trace noise while retaining a larger tool feature', () => {
    const points = [
      { x: 0, y: 0 }, { x: 5, y: -0.1 }, { x: 10, y: 0 },
      { x: 15, y: -2 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
    ]
    const simplified = simplifyPolygon(points, 0.3)
    expect(pointInRing(simplified, { x: 5, y: -0.05 })).toBe(false)
    expect(pointInRing(simplified, { x: 15, y: -1 })).toBe(true)
    expect(pointInRing(simplified, { x: 10, y: 10 })).toBe(true)
  })
})
