'use client'

import { useId } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/Alert'
import { PHOTO_GUIDE_URL } from '@/components/PhotoWarningsBanner'
import { assessToolCapture } from '@/lib/toolCaptureAdvice'
import type { CaptureFrame, Polygon } from '@/types'

interface Props {
  polygons: Polygon[]
  captureFrame: CaptureFrame | null | undefined
  hoveredPolygon: string | null
  onHoveredChange: (id: string | null) => void
}

export function ToolCaptureAdvice({ polygons, captureFrame, hoveredPolygon, onHoveredChange }: Props) {
  const adviceId = useId()
  return (
    <section aria-label="Tool capture advice" className="space-y-2 text-xs">
      <h3 className="font-semibold text-text-primary">Capture advice</h3>
      <p className="text-text-secondary">
        Position heuristic only, not measured outline error. Tool heights, blur/segmentation and lens distortion remain unassessed; camera distance only has EXIF advisory checks where available. No position flags does not certify accuracy.
      </p>
      {!captureFrame && (
        <Alert variant="info">Position advice unavailable for this older capture.</Alert>
      )}
      <ul className="space-y-2">
        {polygons.map((polygon, index) => {
          const name = polygon.label.trim() || `tool ${index + 1}`
          const assessment = assessToolCapture(polygon.points, captureFrame)
          const descriptionId = `${adviceId}-${polygon.id}`
          return (
            <li key={polygon.id} className="space-y-1">
              <button
                type="button"
                aria-label={`Highlight ${name} outline`}
                aria-describedby={descriptionId}
                onMouseEnter={() => onHoveredChange(polygon.id)}
                onMouseLeave={event => {
                  if (document.activeElement !== event.currentTarget) onHoveredChange(null)
                }}
                onFocus={() => onHoveredChange(polygon.id)}
                onBlur={() => onHoveredChange(null)}
                onClick={() => onHoveredChange(polygon.id)}
                className={`max-w-full break-words rounded px-2 py-1 text-left font-semibold focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${hoveredPolygon === polygon.id ? 'bg-elevated text-text-primary' : 'text-text-secondary hover:bg-elevated'}`}
              >
                {name}
              </button>
              <div id={descriptionId} className="px-2 text-text-secondary space-y-1">
                {assessment.status === 'unavailable' ? (
                  <p>{assessment.reason === 'missing-frame' ? 'Position advice unavailable.' : 'Position advice unavailable for this outline: capture mapping or points are unusable.'}</p>
                ) : (
                  <>
                    {assessment.edgeContact && (
                      <p>Potentially clipped at the original capture edge: check completeness; rephotograph if parts are missing. Edge contact alone does not prove clipping; thick tools may also be affected.</p>
                    )}
                    {assessment.outerFrame && (
                      <p>Outer-frame position: rephotograph centered if thick or raised. Thin, flat tools may be acceptable, but are not verified accurate.</p>
                    )}
                    {!assessment.edgeContact && !assessment.outerFrame && <p>No position flags.</p>}
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      <details className="text-text-secondary">
        <summary className="cursor-pointer text-text-primary">How to rephotograph</summary>
        <p className="mt-1.5">
          Place a raised tool under the actual lens, keep the camera parallel to the paper, move farther away while retaining enough real detail, and keep all four paper corners visible. Cropping a corner tool from the same photo is not recapture.
        </p>
      </details>
      <p className="text-text-secondary">
        <Link href="/" className="underline underline-offset-2">Upload a new capture</Link>
        {' · '}
        <a href={PHOTO_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Photo guide</a>
      </p>
    </section>
  )
}
