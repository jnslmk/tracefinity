import type { AccessPocket, AccessPocketShape } from '@/types'
import { DISPLAY_SCALE } from '@/lib/constants'

// Keeps pocket geometry non-degenerate and grabbable, mirroring the backend floor.
export const MIN_ACCESS_POCKET_SIZE_MM = 1
export const MIN_ACCESS_POCKET_DEPTH_MM = 0.25

export interface PocketEdgeFinish {
  kind: 'sharp' | 'chamfer' | 'fillet'
  size: number
}

/** Depth the generator will actually cut, after the protected-floor clamp. */
export function effectivePocketDepth(pocket: AccessPocket, maxDepth: number): number {
  return Math.min(maxDepth, Math.max(MIN_ACCESS_POCKET_DEPTH_MM, pocket.depth))
}

/**
 * Resolve the opening-edge finish the generator applies. Mirrors
 * `_resolve_access_pocket_edge` on the backend: `sharp` always overrides the
 * bin chamfer, `inherit` follows it, and explicit sizes clamp to the pocket.
 */
export function resolvePocketEdge(
  pocket: AccessPocket,
  binChamfer: number,
  maxDepth: number,
): PocketEdgeFinish {
  const depth = effectivePocketDepth(pocket, maxDepth)
  if (pocket.edge === 'sharp') return { kind: 'sharp', size: 0 }
  if (pocket.edge === 'inherit') {
    if (!Number.isFinite(binChamfer) || binChamfer <= 0) return { kind: 'sharp', size: 0 }
    const size = Math.min(binChamfer, Math.max(0, depth - 1))
    return size > 1e-9 ? { kind: 'chamfer', size } : { kind: 'sharp', size: 0 }
  }
  const size = Math.min(pocket.edge_size, Math.max(0, depth - 0.01))
  return size > 1e-9 ? { kind: pocket.edge, size } : { kind: 'sharp', size: 0 }
}

/** Geometry errors the backend would reject, surfaced so nothing is silently changed. */
export function validatePocket(pocket: AccessPocket, maxDepth: number): string | null {
  const dims = [pocket.length, pocket.width, pocket.depth, pocket.rotation, pocket.edge_size,
    pocket.corner_radius, pocket.bottom_radius]
  if (dims.some(value => !Number.isFinite(value))) return 'Pocket dimensions must be finite numbers'
  if (pocket.length < MIN_ACCESS_POCKET_SIZE_MM || pocket.width < MIN_ACCESS_POCKET_SIZE_MM) {
    return `Length and width must be at least ${MIN_ACCESS_POCKET_SIZE_MM}mm`
  }
  if (pocket.depth < MIN_ACCESS_POCKET_DEPTH_MM) return 'Depth must be greater than 0'
  if (pocket.edge_size < 0 || pocket.corner_radius < 0 || pocket.bottom_radius < 0) {
    return 'Radii and edge size cannot be negative'
  }
  if (pocket.shape === 'scoop') {
    if (pocket.corner_radius > 0 || pocket.bottom_radius > 0) {
      return 'A rounded scoop has intrinsic curvature; corner and bottom radius do not apply'
    }
    return null
  }
  const half = Math.min(pocket.length, pocket.width) / 2
  if (pocket.corner_radius > half + 1e-9) {
    return `Corner radius cannot exceed ${half.toFixed(1)}mm for this opening`
  }
  if (pocket.bottom_radius > Math.min(pocket.depth, half) + 1e-9) {
    return 'Bottom radius cannot exceed the depth or half the smaller opening dimension'
  }
  if ((pocket.edge === 'chamfer' || pocket.edge === 'fillet') && pocket.edge_size >= pocket.depth) {
    return 'Opening-edge size must be smaller than the pocket depth'
  }
  return null
}

/**
 * Clamp a pocket into the ranges the backend accepts. Used for live drags so
 * the editor never sends geometry that would be rejected, while typed values
 * surface their own validation error instead.
 */
export function clampPocket(pocket: AccessPocket, maxDepth: number): AccessPocket {
  const shape = pocket.shape
  let length = Math.max(MIN_ACCESS_POCKET_SIZE_MM, Number.isFinite(pocket.length) ? pocket.length : MIN_ACCESS_POCKET_SIZE_MM)
  let width = Math.max(MIN_ACCESS_POCKET_SIZE_MM, Number.isFinite(pocket.width) ? pocket.width : MIN_ACCESS_POCKET_SIZE_MM)
  const depth = Math.min(maxDepth, Math.max(MIN_ACCESS_POCKET_DEPTH_MM, Number.isFinite(pocket.depth) ? pocket.depth : MIN_ACCESS_POCKET_DEPTH_MM))
  const rotation = Number.isFinite(pocket.rotation) ? pocket.rotation : 0
  const edgeSize = pocket.edge === 'chamfer' || pocket.edge === 'fillet'
    ? Math.min(Math.max(0, pocket.edge_size), Math.max(0, depth - 0.01))
    : Math.max(0, pocket.edge_size)
  if (shape === 'scoop') {
    return { ...pocket, length, width, depth, rotation, edge_size: edgeSize, corner_radius: 0, bottom_radius: 0 }
  }
  const half = Math.min(length, width) / 2
  return {
    ...pocket, length, width, depth, rotation,
    corner_radius: Math.min(Math.max(0, pocket.corner_radius), half),
    bottom_radius: Math.min(Math.max(0, pocket.bottom_radius), Math.min(depth, half)),
    edge_size: edgeSize,
  }
}

export function defaultPocket(shape: AccessPocketShape, x: number, y: number): AccessPocket {
  const id = `pocket-${shape}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  if (shape === 'scoop') {
    return {
      id, shape, x, y, length: 32, width: 18, depth: 8, rotation: 0,
      edge: 'fillet', edge_size: 1, corner_radius: 0, bottom_radius: 0,
    }
  }
  return {
    id, shape, x, y, length: 30, width: 20, depth: 12, rotation: 0,
    edge: 'inherit', edge_size: 1, corner_radius: 0, bottom_radius: 0,
  }
}

export interface PocketDisplay {
  cx: number
  cy: number
  length: number
  width: number
  cornerRadius: number
  shape: 'rectangle' | 'capsule' | 'ellipse'
  rotation: number
  envelope: { length: number; width: number; radius: number; size: number } | null
}

/**
 * Plan-view geometry for the editor overlay. The nominal outline is the size
 * before finishing; the envelope is the widened opening the finish produces.
 */
export function pocketDisplay(
  pocket: AccessPocket,
  binChamfer: number,
  maxDepth: number,
  scale: number = DISPLAY_SCALE,
): PocketDisplay {
  const length = pocket.length * scale
  const width = pocket.width * scale
  const isScoop = pocket.shape === 'scoop'
  const shape: PocketDisplay['shape'] = !isScoop
    ? 'rectangle'
    : pocket.length >= pocket.width ? 'capsule' : 'ellipse'
  const cornerRadius = isScoop ? width / 2 : pocket.corner_radius * scale
  const finish = resolvePocketEdge(pocket, binChamfer, maxDepth)
  const size = finish.kind === 'sharp' ? 0 : finish.size * scale
  const envelope = size > 0
    ? { length: length + 2 * size, width: width + 2 * size, radius: cornerRadius + size, size }
    : null
  return {
    cx: pocket.x * scale,
    cy: pocket.y * scale,
    length,
    width,
    cornerRadius,
    shape,
    rotation: pocket.rotation,
    envelope,
  }
}

/** The four nominal corners in bin-space mm, in local (length, width) order. */
export function pocketCorners(pocket: AccessPocket): { x: number; y: number }[] {
  const rot = pocket.rotation * Math.PI / 180
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const hl = pocket.length / 2
  const hw = pocket.width / 2
  return [
    { x: -hl, y: -hw },
    { x: hl, y: -hw },
    { x: hl, y: hw },
    { x: -hl, y: hw },
  ].map(({ x, y }) => ({
    x: pocket.x + x * cos - y * sin,
    y: pocket.y + x * sin + y * cos,
  }))
}

/**
 * Resize from a dragged corner: the opposite corner stays fixed, the dragged
 * corner follows the mouse, and length/width are measured in local space. The
 * centre is the anchor-mouse midpoint.
 */
export function resizePocketFromCorner(
  pocket: AccessPocket,
  cornerIndex: number,
  mouseX: number,
  mouseY: number,
): AccessPocket {
  const corners = pocketCorners(pocket)
  const anchor = corners[(cornerIndex + 2) % 4]
  const rot = pocket.rotation * Math.PI / 180
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const dx = mouseX - anchor.x
  const dy = mouseY - anchor.y
  const localLength = dx * cos + dy * sin
  const localWidth = -dx * sin + dy * cos
  return {
    ...pocket,
    x: (anchor.x + mouseX) / 2,
    y: (anchor.y + mouseY) / 2,
    length: Math.max(MIN_ACCESS_POCKET_SIZE_MM, Math.abs(localLength)),
    width: Math.max(MIN_ACCESS_POCKET_SIZE_MM, Math.abs(localWidth)),
  }
}
