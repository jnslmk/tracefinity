import { describe, expect, it } from 'vitest'

import {
  LEVEL_EPSILON_MM,
  assessmentCoversDraft,
  heightLayers,
  occupyingPlacementIds,
  occupiesElevation,
  resolveLayerSelection,
} from './drawerLayers'
import type { ElevationPlacement } from './drawerLayers'

const placed = (
  placementId: string,
  z_mm: number,
  external_height_mm: number,
): ElevationPlacement => ({ placement_id: placementId, z_mm, external_height_mm })

describe('heightLayers', () => {
  it('lists the elevations an assessed 5+3+2 stack reaches, floor included', () => {
    expect(heightLayers([0, 35, 56]).map(layer => layer.z_mm)).toEqual([0, 35, 56])
  })

  it('collapses floating point noise into one level', () => {
    const noisy = 0.1 + 0.2 + 34.7
    expect(heightLayers([noisy, 35.0000001, 35])).toEqual([
      { z_mm: 0, units: 0 },
      { z_mm: 35, units: 5 },
    ])
  })

  it('snaps an elevation within epsilon of the floor down to floor level', () => {
    expect(heightLayers([LEVEL_EPSILON_MM / 2]).map(layer => layer.z_mm)).toEqual([0])
  })

  it('ignores elevations that cannot exist', () => {
    expect(heightLayers([NaN, -12, -0.001]).map(layer => layer.z_mm)).toEqual([0])
  })
})

describe('occupiesElevation', () => {
  it('treats [base, top) as half-open: a bin owns its base but not its top', () => {
    const bin = placed('a', 0, 35)
    expect(occupiesElevation(bin, 0)).toBe(true)
    expect(occupiesElevation(bin, 34.999)).toBe(true)
    expect(occupiesElevation(bin, 35)).toBe(false)
  })

  it('keeps a tall bin visible at every level it spans', () => {
    const tall = placed('tall', 0, 56)
    expect(occupiesElevation(tall, 0)).toBe(true)
    expect(occupiesElevation(tall, 35)).toBe(true)
    expect(occupiesElevation(tall, 56)).toBe(false)
  })

  it('shows a bin at its own base even when no external height was assessed', () => {
    expect(occupiesElevation(placed('unknown', 35, 0), 35)).toBe(true)
    expect(occupiesElevation(placed('unknown', 35, 0), 0)).toBe(false)
  })
})

describe('occupyingPlacementIds', () => {
  it('shows bins spanning the elevation and drops the one terminating at it', () => {
    const placements = [
      placed('floor-only', 0, 35),
      placed('spanning', 0, 56),
      placed('top', 56, 21),
    ]

    expect(occupyingPlacementIds(placements, 34)).toEqual(new Set(['floor-only', 'spanning']))
    expect(occupyingPlacementIds(placements, 35)).toEqual(new Set(['spanning']))
  })
})

describe('resolveLayerSelection', () => {
  const layers = heightLayers([0, 35, 56])

  it('keeps show-all as show-all and the same level across a refresh', () => {
    expect(resolveLayerSelection(null, layers)).toBe(null)
    expect(resolveLayerSelection(35, heightLayers([0, 35, 56]))).toBe(35)
  })

  it('clamps to the nearest surviving level when the selected one is removed', () => {
    expect(resolveLayerSelection(56, heightLayers([0, 35]))).toBe(35)
    expect(resolveLayerSelection(35, heightLayers([0]))).toBe(0)
  })

  it('falls back to show-all when no level can be verified', () => {
    expect(resolveLayerSelection(35, [])).toBe(null)
  })
})

describe('assessmentCoversDraft', () => {
  it('matches only when the assessment describes exactly the draft placements', () => {
    expect(assessmentCoversDraft(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(assessmentCoversDraft(['a', 'b'], ['a'])).toBe(false)
    expect(assessmentCoversDraft(['a'], ['a', 'b'])).toBe(false)
    expect(assessmentCoversDraft(['a', 'b'], ['a', 'c'])).toBe(false)
    expect(assessmentCoversDraft([], [])).toBe(true)
  })
})
