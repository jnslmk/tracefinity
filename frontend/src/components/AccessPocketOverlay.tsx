'use client'

import type { AccessPocket } from '@/types'
import { pocketDisplay } from '@/lib/accessPockets'

interface Props {
  pockets: AccessPocket[]
  selectedId?: string
  binChamfer: number
  maxDepth: number
  interactive: boolean
  handleR: number
  handleStroke: number
  onPocketMouseDown: (id: string) => (e: React.MouseEvent) => void
  onPocketRotateMouseDown: (id: string) => (e: React.MouseEvent) => void
  onPocketResizeMouseDown: (id: string, corner: number) => (e: React.MouseEvent) => void
  onPocketClick: (id: string, e: React.MouseEvent) => void
  stopClick: (e: React.MouseEvent) => void
}

/**
 * Renders bin-local access pockets plus their nominal/finishing outlines.
 * The dashed envelope is the widened opening produced by the opening-edge
 * finish; the solid outline is the nominal (usable) size.
 */
export function AccessPocketOverlay({
  pockets,
  selectedId,
  binChamfer,
  maxDepth,
  interactive,
  handleR,
  handleStroke,
  onPocketMouseDown,
  onPocketRotateMouseDown,
  onPocketResizeMouseDown,
  onPocketClick,
  stopClick,
}: Props) {
  return (
    <>
      {pockets.map(pocket => {
        const d = pocketDisplay(pocket, binChamfer, maxDepth)
        const isSelected = interactive && selectedId === pocket.id
        const fill = isSelected ? 'rgba(56, 189, 248, 0.55)' : 'rgba(45, 212, 191, 0.38)'
        const stroke = isSelected ? 'rgb(125, 211, 252)' : 'rgb(45, 212, 191)'
        const cursor = interactive ? 'cursor-move' : 'pointer-events-none'
        const common = {
          fill,
          stroke,
          strokeWidth: isSelected ? 3 : 1,
          className: cursor,
          'data-testid': `access-pocket-${pocket.id}`,
          role: 'img',
          'aria-label': `${pocket.shape === 'scoop' ? 'Rounded scoop' : 'Rectangular'} access pocket, ${pocket.length.toFixed(0)} by ${pocket.width.toFixed(0)} by ${pocket.depth.toFixed(1)} millimetres`,
          onMouseDown: interactive ? onPocketMouseDown(pocket.id) : undefined,
          onClick: (e: React.MouseEvent) => onPocketClick(pocket.id, e),
        } as const
        const shapeNode = d.shape === 'ellipse' ? (
          <ellipse {...common} cx={d.cx} cy={d.cy} rx={d.length / 2} ry={d.width / 2} />
        ) : (
          <rect
            {...common}
            x={d.cx - d.length / 2}
            y={d.cy - d.width / 2}
            width={d.length}
            height={d.width}
            rx={d.cornerRadius}
            ry={d.cornerRadius}
          />
        )
        return (
          <g key={pocket.id} data-testid={`access-pocket-group-${pocket.id}`}>
            {d.envelope && (
              <rect
                x={d.cx - d.envelope.length / 2}
                y={d.cy - d.envelope.width / 2}
                width={d.envelope.length}
                height={d.envelope.width}
                rx={d.envelope.radius}
                ry={d.envelope.radius}
                fill="none"
                stroke="rgb(250, 204, 21)"
                strokeWidth={1}
                strokeDasharray="4,3"
                className="pointer-events-none"
                transform={`rotate(${d.rotation} ${d.cx} ${d.cy})`}
                data-testid={`access-pocket-envelope-${pocket.id}`}
              />
            )}
            <g transform={d.rotation !== 0 ? `rotate(${d.rotation} ${d.cx} ${d.cy})` : undefined}>
              <title>
                {pocket.shape === 'scoop' ? 'Rounded scoop' : 'Rectangular'} access pocket
              </title>
              {shapeNode}
              {isSelected && (() => {
                const halfL = d.length / 2
                const halfW = d.width / 2
                const corners = [
                  { x: d.cx - halfL, y: d.cy - halfW },
                  { x: d.cx + halfL, y: d.cy - halfW },
                  { x: d.cx + halfL, y: d.cy + halfW },
                  { x: d.cx - halfL, y: d.cy + halfW },
                ]
                const handleSize = handleR * 1.6
                const rotateHandle = { x: d.cx, y: d.cy - halfW - handleR * 2.4 }
                return (
                  <g>
                    <rect
                      x={d.cx - halfL} y={d.cy - halfW}
                      width={d.length} height={d.width}
                      fill="none" stroke="rgb(125, 211, 252)" strokeWidth={handleStroke}
                      strokeDasharray={`${handleR * 0.4},${handleR * 0.25}`}
                      className="pointer-events-none"
                    />
                    {corners.map((corner, index) => (
                      <rect
                        key={index}
                        x={corner.x - handleSize / 2} y={corner.y - handleSize / 2}
                        width={handleSize} height={handleSize}
                        fill="rgb(15, 23, 42)" stroke="rgb(125, 211, 252)" strokeWidth={handleStroke}
                        className="cursor-nwse-resize"
                        data-testid={`access-pocket-resize-${pocket.id}-${index}`}
                        onMouseDown={onPocketResizeMouseDown(pocket.id, index)}
                        onClick={stopClick}
                      />
                    ))}
                    <line
                      x1={d.cx} y1={d.cy - halfW} x2={rotateHandle.x} y2={rotateHandle.y}
                      stroke="rgb(125, 211, 252)" strokeWidth={handleStroke}
                      className="pointer-events-none"
                    />
                    <circle
                      cx={rotateHandle.x} cy={rotateHandle.y} r={handleR}
                      fill="rgb(15, 23, 42)" stroke="rgb(125, 211, 252)" strokeWidth={handleStroke}
                      className="cursor-rotate"
                      data-testid={`access-pocket-rotate-${pocket.id}`}
                      onMouseDown={onPocketRotateMouseDown(pocket.id)}
                      onClick={stopClick}
                    />
                  </g>
                )
              })()}
            </g>
          </g>
        )
      })}
    </>
  )
}
