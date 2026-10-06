import type { BinSummary, DrawerOutline, Point, ProjectBinPlacement } from '@/types'
import { GRID_UNIT } from '@/lib/constants'
import { footprintCorners, outlineBounds, shapeInsideOutline, toGridLocal } from '@/lib/drawerOutline'
import type { Rect } from '@/lib/drawerOutline'

// drawer plans live in gridfinity units; a bin snaps to half units exactly when
// its own base is a half grid, otherwise to full units
export const FULL_GRID_SNAP = 1
export const HALF_GRID_SNAP = 0.5

/** Colour used for placements without a highlight colour, in both the 2D and 3D views. */
export const DEFAULT_BIN_COLOR = '#5ab4de'

export const PLACEMENT_COLORS = [
  '#ff6384', // red
  '#4bc0c0', // teal
  '#ff9f40', // orange
  '#9966ff', // purple
  '#ffcd56', // yellow
  '#c9cbcf', // grey
] as const

export const DRAWER_GRID_MIN = 1
export const DRAWER_GRID_MAX = 40
export const DEFAULT_DRAWER_GRID_X = 6
export const DEFAULT_DRAWER_GRID_Y = 4

export const PLACEMENT_ROTATIONS = [0, 90, 180, 270] as const
export type PlacementRotation = (typeof PLACEMENT_ROTATIONS)[number]

/** Half-grid bases sit on 21mm cells, so those bins may be placed on half units. */
export function snapForBin(bin: Pick<BinSummary, 'half_grid_base'> | undefined): number {
  return bin?.half_grid_base ? HALF_GRID_SNAP : FULL_GRID_SNAP
}

/**
 * Approximate bin height in mm: 7mm per unit plus the stacking lip. Only used
 * for the placeholder block shown until a bin's real model has been generated.
 */
export function binHeightMm(heightUnits: number): number {
  return heightUnits * 7 + 4.4
}

export interface UnitRect {
  x: number
  y: number
  w: number
  h: number
}

export function snapUnits(value: number, snap: number = FULL_GRID_SNAP): number {
  return Math.round(value / snap) * snap + 0
}

export function clampDrawerGrid(value: number): number {
  return Math.min(DRAWER_GRID_MAX, Math.max(DRAWER_GRID_MIN, snapUnits(value, HALF_GRID_SNAP)))
}

export function normalizeRotation(rotation: number | undefined): PlacementRotation {
  return PLACEMENT_ROTATIONS.includes(rotation as PlacementRotation)
    ? rotation as PlacementRotation
    : 0
}

export function nextRotation(rotation: number): PlacementRotation {
  const index = PLACEMENT_ROTATIONS.indexOf(rotation as PlacementRotation)
  return PLACEMENT_ROTATIONS[(index + 1) % PLACEMENT_ROTATIONS.length]
}

/** True when the rotation exchanges the bin's width and depth. */
export function isQuarterTurn(rotation: number): boolean {
  return rotation === 90 || rotation === 270
}

/** Bin footprint in grid units, swapped on quarter turns. */
export function binFootprint(bin: Pick<BinSummary, 'grid_x' | 'grid_y'>, rotation = 0): { w: number; h: number } {
  return isQuarterTurn(rotation)
    ? { w: bin.grid_y, h: bin.grid_x }
    : { w: bin.grid_x, h: bin.grid_y }
}

export function placementRect(
  placement: ProjectBinPlacement,
  bin: Pick<BinSummary, 'grid_x' | 'grid_y'>,
): UnitRect {
  const { w, h } = binFootprint(bin, placement.rotation)
  return { x: placement.x, y: placement.y, w, h }
}

export function rectsOverlap(a: UnitRect, b: UnitRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function rectFitsDrawer(rect: UnitRect, drawerX: number, drawerY: number): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= drawerX && rect.y + rect.h <= drawerY
}

/**
 * A photo-derived floor boundary plus the grid frame it sits in. Absent means
 * a rectangular plan, where the drawer extents are the only containment rule.
 * The frame turns with `rotationDeg`, so a drawn footprint is a rotated
 * rectangle and is tested as one.
 */
export interface DrawerFootprint {
  outline: DrawerOutline | null
  originXmm: number
  originYmm: number
  rotationDeg: number
  fitClearanceMm: number
}

/** Scan/render bounds in grid units, independent of the legacy display size. */
export function drawerGridBounds(drawerX: number, drawerY: number, footprint?: DrawerFootprint | null): Rect {
  if (!footprint?.outline) return { x0: 0, y0: 0, x1: drawerX, y1: drawerY }
  const origin = { x: footprint.originXmm, y: footprint.originYmm }
  const bounds = outlineBounds({
    points: footprint.outline.points.map(point => toGridLocal(point, origin, footprint.rotationDeg)),
    interior_rings: [],
  })
  return {
    x0: bounds.x0 / GRID_UNIT, y0: bounds.y0 / GRID_UNIT,
    x1: bounds.x1 / GRID_UNIT, y1: bounds.y1 / GRID_UNIT,
  }
}

/** True when the footprint clears the boundary's concavities, holes and fit clearance. */
export function rectFitsFootprint(
  rect: UnitRect,
  drawerX: number,
  drawerY: number,
  footprint?: DrawerFootprint | null,
): boolean {
  // A photo boundary is authoritative; the legacy rectangle is not a fit limit.
  if (footprint?.outline) {
    const corners = footprintCorners(
      { x: footprint.originXmm, y: footprint.originYmm },
      footprint.rotationDeg,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
    )
    return shapeInsideOutline(corners, footprint.outline, footprint.fitClearanceMm)
  }
  return rectFitsDrawer(rect, drawerX, drawerY)
}

/** Clamp to the floor's grid-frame bounds; containment still reports notches/holes. */
export function clampToDrawer(
  rect: UnitRect, drawerX: number, drawerY: number, snap = HALF_GRID_SNAP,
  footprint?: DrawerFootprint | null,
): { x: number; y: number } {
  const bounds = drawerGridBounds(drawerX, drawerY, footprint)
  return {
    x: Math.max(Math.ceil((bounds.x0 - 1e-9) / snap) * snap, Math.min(rect.x, Math.floor((bounds.x1 - rect.w + 1e-9) / snap) * snap)) + 0,
    y: Math.max(Math.ceil((bounds.y0 - 1e-9) / snap) * snap, Math.min(rect.y, Math.floor((bounds.y1 - rect.h + 1e-9) / snap) * snap)) + 0,
  }
}

/**
 * Map a point from bin-space mm to drawer-space mm, honouring the placement rotation.
 * Both views draw with y pointing down, so rotations are clockwise on screen.
 */
export function binPointToDrawerMm(
  point: Point,
  placement: ProjectBinPlacement,
  bin: Pick<BinSummary, 'grid_x' | 'grid_y'>,
): Point {
  const originX = placement.x * GRID_UNIT
  const originY = placement.y * GRID_UNIT
  const binWidth = bin.grid_x * GRID_UNIT
  const binDepth = bin.grid_y * GRID_UNIT

  switch (placement.rotation) {
    case 90:
      return { x: originX + binDepth - point.y, y: originY + point.x }
    case 180:
      return { x: originX + binWidth - point.x, y: originY + binDepth - point.y }
    case 270:
      return { x: originX + point.y, y: originY + binWidth - point.x }
    default:
      return { x: originX + point.x, y: originY + point.y }
  }
}

/**
 * Offset in mm that moves a bin model back into its footprint after rotating it
 * about the drawer's vertical axis. Used by the 3D view, where x/z mirror the
 * drawer's x/y.
 */
export function rotationOffsetMm(
  rotation: number,
  bin: Pick<BinSummary, 'grid_x' | 'grid_y'>,
): { dx: number; dz: number } {
  const binWidth = bin.grid_x * GRID_UNIT
  const binDepth = bin.grid_y * GRID_UNIT

  switch (rotation) {
    case 90:
      return { dx: binDepth, dz: 0 }
    case 180:
      return { dx: binWidth, dz: binDepth }
    case 270:
      return { dx: 0, dz: binWidth }
    default:
      return { dx: 0, dz: 0 }
  }
}

/** Grid-line positions across a grid-frame interval, including partial edges. */
export function gridLines(units: number, start = 0): number[] {
  const lines: number[] = []
  const step = 0.5
  for (let i = Math.ceil((start - 1e-9) / step); i <= Math.floor((units + 1e-9) / step); i++) {
    lines.push(i * step + 0)
  }
  if (!lines.includes(start)) lines.unshift(start + 0)
  if (!lines.includes(units)) lines.push(units + 0)
  return lines
}

export function binById(bins: BinSummary[]): Map<string, BinSummary> {
  return new Map(bins.map(bin => [bin.id, bin]))
}

export function stackRoot(placements: ProjectBinPlacement[], id: string): ProjectBinPlacement | undefined {
  let current = placements.find(p => p.id === id)
  const seen = new Set<string>()
  while (current?.support_id && !seen.has(current.id)) {
    seen.add(current.id)
    current = placements.find(p => p.id === current!.support_id)
  }
  return current
}

export function upperSubstack(placements: ProjectBinPlacement[], id: string): Set<string> {
  const ids = new Set([id])
  for (let previous = -1; previous !== ids.size;) {
    previous = ids.size
    placements.forEach(p => { if (p.support_id && ids.has(p.support_id)) ids.add(p.id) })
  }
  return ids
}

export function transformStack(placements: ProjectBinPlacement[], id: string, x: number, y: number, rotation?: number): ProjectBinPlacement[] {
  const root = stackRoot(placements, id)
  if (!root) return placements
  const members = upperSubstack(placements, root.id)
  const delta = rotation === undefined ? 0 : rotation - root.rotation
  return placements.map(p => members.has(p.id) ? {
    ...p, x, y, rotation: normalizeRotation((p.rotation + delta + 360) % 360),
  } : p)
}

/** Placement ids that overlap another bin or stick out of the drawer. */
export function findLayoutConflicts(
  placements: ProjectBinPlacement[],
  bins: Map<string, BinSummary>,
  drawerX: number,
  drawerY: number,
  footprint?: DrawerFootprint | null,
): { overlapping: Set<string>; outOfBounds: Set<string> } {
  const overlapping = new Set<string>()
  const outOfBounds = new Set<string>()
  const rects: { id: string; rect: UnitRect }[] = []

  for (const placement of placements) {
    const bin = bins.get(placement.bin_id)
    if (!bin) continue
    const rect = placementRect(placement, bin)
    if (!rectFitsFootprint(rect, drawerX, drawerY, footprint)) outOfBounds.add(placement.id)
    rects.push({ id: placement.id, rect })
  }

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (stackRoot(placements, rects[i].id)?.id !== stackRoot(placements, rects[j].id)?.id && rectsOverlap(rects[i].rect, rects[j].rect)) {
        overlapping.add(rects[i].id)
        overlapping.add(rects[j].id)
      }
    }
  }

  return { overlapping, outOfBounds }
}

/**
 * First free position for a bin, scanning row by row in snap steps.
 * Returns null when the bin does not fit next to the occupied rects.
 */
export function findFreeSpot(
  bin: Pick<BinSummary, 'grid_x' | 'grid_y' | 'half_grid_base'>,
  occupied: UnitRect[],
  drawerX: number,
  drawerY: number,
  options: { rotation?: number; footprint?: DrawerFootprint | null } = {},
): { x: number; y: number; rotation: PlacementRotation } | null {
  const snap = snapForBin(bin)
  const preferred = normalizeRotation(options.rotation)
  const rotations: PlacementRotation[] = [preferred, nextRotation(preferred)]
  const bounds = drawerGridBounds(drawerX, drawerY, options.footprint)

  for (const rotation of rotations) {
    const { w, h } = binFootprint(bin, rotation)
    if (w > bounds.x1 - bounds.x0 + 1e-9 || h > bounds.y1 - bounds.y0 + 1e-9) continue
    for (let y = Math.ceil((bounds.y0 - 1e-9) / snap) * snap; y <= bounds.y1 - h + 1e-9; y += snap) {
      for (let x = Math.ceil((bounds.x0 - 1e-9) / snap) * snap; x <= bounds.x1 - w + 1e-9; x += snap) {
        const rect = { x: snapUnits(x, snap), y: snapUnits(y, snap), w, h }
        if (!rectFitsFootprint(rect, drawerX, drawerY, options.footprint)) continue
        if (!occupied.some(other => rectsOverlap(rect, other))) {
          return { x: rect.x, y: rect.y, rotation }
        }
      }
    }
  }
  return null
}

/**
 * Pack the given placements into the drawer, largest bin first. Placements keep
 * their ids so repeated copies of a bin survive.
 *
 * Nothing is ever removed: a placement that finds no free spot keeps its
 * previous position and is reported in `unfittedIds`. It then necessarily
 * overlaps an arranged bin or sticks out of the drawer, so the conflict
 * highlighting shows the user exactly what did not fit.
 */
export function autoArrange(
  placements: ProjectBinPlacement[],
  bins: Map<string, BinSummary>,
  drawerX: number,
  drawerY: number,
  footprint?: DrawerFootprint | null,
): { placements: ProjectBinPlacement[]; unfittedIds: string[] } {
  const stackMembers = new Set(placements.filter(p => p.support_id).flatMap(p => [p.id, p.support_id!]))
  const preserved = placements.filter(p => stackMembers.has(p.id))
  const ordered = placements
    .filter(placement => bins.has(placement.bin_id) && !stackMembers.has(placement.id))
    .sort((a, b) => {
      const binA = bins.get(a.bin_id)!
      const binB = bins.get(b.bin_id)!
      const areaDiff = binB.grid_x * binB.grid_y - binA.grid_x * binA.grid_y
      if (areaDiff !== 0) return areaDiff
      return (binA.name || binA.id).localeCompare(binB.name || binB.id)
    })

  const arranged: ProjectBinPlacement[] = []
  const unfitted: ProjectBinPlacement[] = []
  const occupied: UnitRect[] = preserved.filter(p => !p.support_id).flatMap(p => {
    const bin = bins.get(p.bin_id)
    return bin ? [placementRect(p, bin)] : []
  })

  for (const placement of ordered) {
    const bin = bins.get(placement.bin_id)!
    const spot = findFreeSpot(bin, occupied, drawerX, drawerY, { rotation: placement.rotation, footprint })
    if (!spot) {
      unfitted.push(placement)
      continue
    }
    const placed = { ...placement, x: spot.x, y: spot.y, rotation: spot.rotation }
    arranged.push(placed)
    occupied.push(placementRect(placed, bin))
  }

  // placements of bins that are not loaded cannot be measured; leave them untouched
  const unknown = placements.filter(placement => !bins.has(placement.bin_id) && !stackMembers.has(placement.id))

  return {
    placements: [...preserved, ...arranged, ...unfitted, ...unknown],
    unfittedIds: unfitted.map(placement => placement.id),
  }
}

export interface DrawerStats {
  drawerUnits: number
  usedUnits: number
  freeUnits: number
  coverage: number
  placementCount: number
  placedBinCount: number
  unplacedBinCount: number
}

export function drawerStats(
  placements: ProjectBinPlacement[],
  bins: BinSummary[],
  drawerX: number,
  drawerY: number,
  footprint?: DrawerFootprint | null,
): DrawerStats {
  const byId = binById(bins)
  const known = placements.filter(placement => byId.has(placement.bin_id))
  const placedBinIds = new Set(known.map(placement => placement.bin_id))
  const roots = known.filter(p => !p.support_id).map(p => placementRect(p, byId.get(p.bin_id)!))
  let usedUnits = 0
  let drawerUnits = 0
  const bounds = drawerGridBounds(drawerX, drawerY, footprint)
  const x0 = footprint?.outline ? Math.floor((bounds.x0 + 1e-9) * 2) / 2 : 0
  const y0 = footprint?.outline ? Math.floor((bounds.y0 + 1e-9) * 2) / 2 : 0
  for (let y = y0; y < bounds.y1 - 1e-9; y += .5) {
    for (let x = x0; x < bounds.x1 - 1e-9; x += .5) {
      const w = footprint?.outline ? .5 : Math.min(.5, bounds.x1 - x)
      const h = footprint?.outline ? .5 : Math.min(.5, bounds.y1 - y)
      if (footprint?.outline) {
        // only floor the boundary actually covers is available or occupied
        const corners = footprintCorners(
          { x: footprint.originXmm, y: footprint.originYmm },
          footprint.rotationDeg, x, y, w, h,
        )
        if (!shapeInsideOutline(corners, footprint.outline, footprint.fitClearanceMm)) continue
      }
      drawerUnits += w * h
      if (roots.some(rect => rectsOverlap(rect, { x, y, w, h }))) usedUnits += w * h
    }
  }

  return {
    drawerUnits,
    usedUnits,
    freeUnits: Math.max(0, drawerUnits - usedUnits),
    coverage: drawerUnits > 0 ? usedUnits / drawerUnits : 0,
    placementCount: known.length,
    placedBinCount: placedBinIds.size,
    unplacedBinCount: bins.length - placedBinIds.size,
  }
}
