'use client'

import { PolygonEditor } from '@/components/PolygonEditor'
import type { PolygonEditorAction } from '@/components/PolygonEditor'
import { outlineBounds, outlineArea, outlinePerimeter, polygonsToOutline, validateOutline } from '@/lib/drawerOutline'
import type { Point, Polygon } from '@/types'

const OUTLINE_ID = 'drawer-outline'
const GRID_UNIT = 42

interface Props {
  imageUrl: string
  polygons: Polygon[]
  onPolygonsChange: (polygons: Polygon[]) => void
  /** millimetres per corrected-image pixel; null until the photo is calibrated */
  scaleFactor: number | null
  seed: Point | null
  /** Next polygon list for an added obstruction; the editor pushes it onto history. */
  createExclusion: (polygons: Polygon[]) => Polygon[] | null
  /** Next polygon list for a reset outline; the editor pushes it onto history. */
  resetOutline: () => Polygon[] | null
}

/**
 * Review the boundary and its exclusions over the corrected photo. The first
 * polygon is the floor; every later polygon is an obstruction punched out of
 * it. It is a real trace over the calibrated photo -- never a blank canvas or
 * an imported authored outline.
 */
export function DrawerOutlineEditor({
  imageUrl,
  polygons,
  onPolygonsChange,
  scaleFactor,
  seed,
  createExclusion,
  resetOutline,
}: Props) {
  // the actions run through the editor's own history, so Add and Reset undo like
  // any vertex edit; the floor boundary itself cannot be deleted
  const actions: PolygonEditorAction[] = [
    { label: 'Add obstruction', create: createExclusion },
    { label: 'Reset to rectangle', create: resetOutline },
  ]

  const outline = polygonsToOutline(polygons)
  const problem = outline ? validateOutline(outline) : 'trace the floor boundary before accepting'
  const bounds = outline ? outlineBounds(outline) : null
  const scale = scaleFactor ?? 1
  const widthMm = bounds ? (bounds.x1 - bounds.x0) * scale : 0
  const depthMm = bounds ? (bounds.y1 - bounds.y0) * scale : 0
  const areaMm2 = outline ? outlineArea(outline) * scale * scale : 0

  return (
    <div className="flex flex-col h-full min-h-0 gap-2">
      <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
        <span className="text-[11px] text-text-muted">
          {polygons.length > 1
            ? `${polygons.length - 1} obstruction${polygons.length === 2 ? '' : 's'} excluded`
            : 'No obstructions excluded'}
        </span>
        {seed && <span className="text-[11px] text-text-muted">Floor selected on the photo</span>}
      </div>

      <div className="flex-1 min-h-0">
        <PolygonEditor
          imageUrl={imageUrl}
          polygons={polygons}
          onPolygonsChange={onPolygonsChange}
          editable
          lockedIds={[OUTLINE_ID]}
          initialActiveId={OUTLINE_ID}
          actions={actions}
        />
      </div>
      <div className="flex-shrink-0 truncate text-[11px] leading-tight text-text-secondary" title="Boundary measurements">
        {problem ? (
          <p role="alert" className="text-amber-500">{problem}</p>
        ) : (
          <p className="truncate">
            <span className="text-text-muted">Extent</span>{' '}
            {widthMm.toFixed(1)} × {depthMm.toFixed(1)} mm
            {' · '}
            <span className="text-text-muted">Area</span>{' '}
            {(areaMm2 / 100).toFixed(1)} cm² ({(areaMm2 / (GRID_UNIT * GRID_UNIT)).toFixed(2)} grid units)
            {outline && <> · <span className="text-text-muted">Perimeter</span> {(outlinePerimeter(outline) * scale).toFixed(1)} mm</>}
          </p>
        )}
      </div>
    </div>
  )
}
