/**
 * Height-layer logic for the drawer sketch: the distinct bin base elevations an
 * assessed plan actually reaches, and which bins are visible at one of them.
 *
 * Elevations come only from assessed `z_mm`. A 5+3+2 stack reaches 0/35/56 mm
 * only when the printed parts really mate that way, so nominal bin heights are
 * never summed here to guess a level: an imported solid whose mating datum
 * differs would silently gain levels it cannot rest on.
 */

/**
 * Two base elevations closer than this are the same physical level. Assessed
 * z_mm values come from summing independent bin heights, so equal levels can
 * differ in the last floating point digits.
 */
export const LEVEL_EPSILON_MM = 0.01

/** One bin base elevation reachable in the current plan. */
export interface HeightLayer {
  /** Millimetres above the floor datum. */
  z_mm: number
  /** The same elevation in 7 mm gridfinity units. */
  units: number
}

/** The part of an assessed placement that decides its layer. */
export interface ElevationPlacement {
  placement_id: string
  z_mm: number
  external_height_mm: number
}

export function isSameLevel(a: number, b: number, epsilon = LEVEL_EPSILON_MM): boolean {
  return Math.abs(a - b) <= epsilon
}

/**
 * Distinct base elevations, ascending. The floor (0 mm) is always a level: new
 * and dropped bins rest on it. Near-equal values collapse into one level and
 * anything within epsilon of the floor reads as floor level.
 */
export function heightLayers(zValues: readonly number[]): HeightLayer[] {
  // sorting first keeps the lowest value of each cluster, so a level is named by
  // a stable elevation instead of whichever float noise happened to arrive first
  const sorted = [0, ...zValues.filter(z => Number.isFinite(z) && z >= 0)].sort((a, b) => a - b)
  const levels: number[] = []
  for (const z of sorted) {
    const previous = levels[levels.length - 1]
    if (previous === undefined || !isSameLevel(previous, z)) levels.push(z)
  }
  return levels.map(z_mm => ({ z_mm, units: z_mm / 7 }))
}

/**
 * Carry the chosen elevation across assessments: keep the same level when it
 * survives a refresh, otherwise clamp to the nearest survivor so removing an
 * upper bin drops the view onto what is left. `null` means show every level and
 * stays `null`.
 */
export function resolveLayerSelection(selected: number | null, layers: readonly HeightLayer[]): number | null {
  if (selected === null || layers.length === 0) return null
  const exact = layers.find(layer => isSameLevel(layer.z_mm, selected))
  if (exact) return exact.z_mm
  return layers.reduce((nearest, layer) => (
    Math.abs(layer.z_mm - selected) < Math.abs(nearest.z_mm - selected) ? layer : nearest
  )).z_mm
}

/**
 * Half-open occupancy test on [z_mm, z_mm + external_height_mm): a tall bin
 * spanning the elevation stays visible, one whose top ends at or below it
 * disappears. A bin always occupies its own base plane, even when the
 * assessment reported no external height.
 */
export function occupiesElevation(
  placement: Pick<ElevationPlacement, 'z_mm' | 'external_height_mm'>,
  z: number,
  epsilon = LEVEL_EPSILON_MM,
): boolean {
  const { z_mm, external_height_mm } = placement
  if (!Number.isFinite(z_mm) || !Number.isFinite(external_height_mm)) return false
  if (isSameLevel(z_mm, z, epsilon)) return true
  return z_mm < z && z < z_mm + external_height_mm
}

/**
 * Ids of the assessed placements visible at one elevation. A placement the
 * assessment does not describe is never visible: its layer is unknown, and
 * guessing one would invent a datum.
 */
export function occupyingPlacementIds(placements: readonly ElevationPlacement[], z: number): Set<string> {
  return new Set(
    placements
      .filter(placement => occupiesElevation(placement, z))
      .map(placement => placement.placement_id),
  )
}

/**
 * Whether an assessment describes exactly the placements on the draft. Layer
 * selection stays disabled while they disagree so a stale assessment cannot
 * build levels the current plan does not have.
 */
export function assessmentCoversDraft(draftIds: readonly string[], assessedIds: readonly string[]): boolean {
  if (draftIds.length !== assessedIds.length) return false
  const assessed = new Set(assessedIds)
  return draftIds.every(id => assessed.has(id))
}
