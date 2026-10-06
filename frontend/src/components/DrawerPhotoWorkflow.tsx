'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert } from '@/components/Alert'
import { Breadcrumb } from '@/components/Breadcrumb'
import { ImageUploader } from '@/components/ImageUploader'
import { PaperCornerEditor } from '@/components/PaperCornerEditor'
import { PhotoWarningsBanner } from '@/components/PhotoWarningsBanner'
import { DrawerOutlineEditor } from '@/components/DrawerOutlineEditor'
import { Loader2, Sparkles } from 'lucide-react'
import { getAvailableKeys } from '@/lib/api'
import { useDrawerPhoto } from '@/hooks/useDrawerPhoto'
import type { PaperSize, Point } from '@/types'

const PAPER_SIZE_OPTIONS: { value: PaperSize; label: string }[] = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'Letter' },
  { value: 'a3', label: 'A3' },
  { value: 'tabloid', label: 'Tabloid' },
]

/** Click the interior floor on the corrected photo. Positive selection, not a guess. */
function FloorPicker({ imageUrl, seed, onPick }: { imageUrl: string; seed: Point | null; onPick: (point: Point) => void }) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  function handleClick(event: React.MouseEvent) {
    const img = imgRef.current
    if (!img || !size.width || !size.height) return
    const rect = img.getBoundingClientRect()
    onPick({
      x: ((event.clientX - rect.left) / rect.width) * size.width,
      y: ((event.clientY - rect.top) / rect.height) * size.height,
    })
  }

  const markerRadius = Math.max(6, Math.max(size.width, size.height) / 80)

  return (
    <div className="relative inline-block">
      <img
        ref={imgRef}
        src={imageUrl}
        alt="Corrected drawer photo"
        onClick={handleClick}
        onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        className="max-h-[65vh] w-auto rounded-lg cursor-crosshair select-none"
      />
      {seed && size.width > 0 && (
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox={`0 0 ${size.width} ${size.height}`}
          preserveAspectRatio="none"
        >
          <circle cx={seed.x} cy={seed.y} r={markerRadius} fill="none" stroke="#22c55e" strokeWidth={markerRadius / 3} />
        </svg>
      )}
    </div>
  )
}

export function DrawerPhotoWorkflow({ projectId, projectName, sketchId }: {
  projectId: string
  projectName: string
  sketchId: string | null
}) {
  const router = useRouter()
  const photo = useDrawerPhoto(projectId, sketchId)
  const [providerLabel, setProviderLabel] = useState<string | null>(null)
  const { paperSize, setPaperSize } = photo
  const [accepting, setAccepting] = useState(false)
  const reviewing = photo.step === 'review' && !!photo.correctedUrl

  useEffect(() => {
    getAvailableKeys()
      .then(keys => setProviderLabel(keys.drawer_cloud ? (keys.drawer_provider_label ?? 'a remote model') : null))
      .catch(() => setProviderLabel(null))
  }, [])


  async function handleAccept() {
    setAccepting(true)
    const updated = await photo.accept()
    setAccepting(false)
    if (updated) router.push(`/projects/${projectId}/sketch/${updated.id}`)
  }

  return (
    <div className={reviewing ? 'h-[calc(100vh-44px)] flex flex-col w-full' : 'max-w-5xl mx-auto p-4 space-y-4'}>
      <div className={reviewing ? 'contents' : 'space-y-4'}>
      {!reviewing && (
      <>
      <Breadcrumb segments={[
        { label: projectName, href: `/projects/${projectId}` },
        { label: 'New plan from photo', href: `/projects/${projectId}/sketch/photo` },
      ]} />
      <div className="space-y-1">
        <h1 className="text-lg text-text-primary">Drawer plan from photo</h1>
        <p className="text-[11px] text-text-muted">
          Calibrate the photo, select the interior floor, then review the boundary. The photo is a source for measurement only:
          the plan stores its own boundary and never becomes a tool.
        </p>
      </div>
      </>
      )}
      {(photo.error || photo.warnings.length > 0) && (
      <div className={reviewing ? 'px-4 pt-3 space-y-3 shrink-0' : 'space-y-3'}>
      {photo.error && <Alert variant="error">{photo.error}</Alert>}
      {photo.warnings.length > 0 && <PhotoWarningsBanner warnings={photo.warnings} onDismiss={photo.clearWarnings} />}
      </div>
      )}
      </div>
      {photo.step === 'upload' && (
        <div className="space-y-3">
          <ImageUploader onUpload={file => void photo.upload(file)} disabled={photo.busy} />
          <p className="text-[11px] text-text-muted">
            Lay the reference sheet flat on the drawer floor. The sheet sets the metric scale for the whole frame, so the
            boundary can extend beyond it. No photo leaves your instance until you choose a remote provider.
          </p>
        </div>
      )}

      {photo.step === 'corners' && photo.originalUrl && (
        <div className="space-y-3">
          <div className="h-[60vh]">
            <PaperCornerEditor
              imageUrl={photo.originalUrl}
              corners={photo.corners}
              onCornersChange={photo.setCornerPoints}
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-[11px] text-text-secondary">
              Paper size
              <select
                aria-label="Paper size"
                value={paperSize}
                onChange={event => setPaperSize(event.target.value as PaperSize)}
                className="ml-2 bg-elevated border border-border rounded px-2 py-1"
              >
                {PAPER_SIZE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void photo.applyCorners(paperSize)}
              disabled={photo.busy || photo.corners.length !== 4}
              className="btn-primary px-3 py-1.5 text-[11px]"
            >
              {photo.busy && <Loader2 className="w-3 h-3 animate-spin inline mr-1" />}
              Correct photo
            </button>
          </div>
        </div>
      )}

      {photo.step === 'floor' && photo.correctedUrl && (
        <div className="space-y-3">
          <p className="text-[11px] text-text-secondary">
            Click a point on the <strong>interior floor</strong> of the drawer — not the walls, the case exterior, or an
            obstruction. Nothing is sent anywhere by selecting it; the boundary is built only when you choose a method below.
          </p>
          <div className="flex items-start gap-3">
            <FloorPicker imageUrl={photo.correctedUrl} seed={photo.seed} onPick={photo.selectSeed} />
            <div className="flex-1 min-w-0 space-y-3 text-[11px] text-text-secondary">
              <div className="glass rounded-[10px] p-3 space-y-2">
                <p className="font-semibold text-text-primary">Generate boundary</p>
                {providerLabel ? (
                  <>
                    <p>
                      Sends this photo to <strong>{providerLabel}</strong> (through the configured provider, e.g. Gemini on
                      OpenRouter) for a proposed boundary. The proposal is an editable starting point, not a verdict: it can
                      follow the case walls, rim or exterior instead of the interior floor, so inspect it and correct the
                      vertices and exclusions — or trace locally — before Accept.
                    </p>
                    <p className="text-text-muted">
                      The photo leaves this instance. Destination and retention belong to that provider: Tracefinity does not
                      control how long the request or its images are kept and cannot guarantee deletion. Choose the local path
                      if that is unacceptable.
                    </p>
                    <button
                      type="button"
                      onClick={() => photo.seed && void photo.generate(photo.seed)}
                      disabled={!photo.seed || photo.busy}
                      className="btn-primary px-3 py-1.5 inline-flex items-center gap-1"
                    >
                      <Sparkles className="w-3 h-3" />
                      Use {providerLabel}
                    </button>
                  </>
                ) : (
                  <p role="status">No remote provider is configured, so the local path is the only one available.</p>
                )}
              </div>
              <div className="glass rounded-[10px] p-3 space-y-2">
                <p className="font-semibold text-text-primary">Trace locally (no key)</p>
                <p>
                  Traces the boundary directly over the calibrated photo: no request leaves this instance. You add, remove and
                  drag vertices, add obstruction rings, zoom and pan, and undo or redo.
                </p>
                <button
                  type="button"
                  onClick={() => photo.seed && void photo.startManual(photo.seed)}
                  disabled={!photo.seed || photo.busy}
                  className="btn-secondary px-3 py-1.5"
                >
                  Trace locally
                </button>
              </div>
              {photo.busy && <p role="status" className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Working…</p>}
            </div>
          </div>
          <button type="button" onClick={photo.restartCapture} disabled={photo.busy} className="btn-secondary px-2 py-1 text-[11px]">
            Use a different photo
          </button>
        </div>
      )}
      {photo.step === 'review' && photo.correctedUrl && (
        <div className="flex-1 flex flex-col md:flex-row min-h-0">
          <aside className="md:w-[240px] shrink-0 bg-surface border-b md:border-b-0 md:border-r border-border overflow-y-auto max-h-[35vh] md:max-h-none px-3 py-2 space-y-3">
            <Breadcrumb segments={[
              { label: projectName, href: `/projects/${projectId}` },
              { label: 'Photo plan', href: `/projects/${projectId}/sketch/photo` },
            ]} />
            <div>
              <h2 className="text-sm text-text-primary">Drag the handles to follow the inside floor.</h2>
              <p className="text-[11px] text-text-secondary">Choose Add vertex (+), then click an edge to insert a point. Select an obstruction and press Del to remove it. Undo restores edits.</p>
              <p className="text-[11px] text-text-secondary">Scroll to zoom. Hold Space and drag to pan.</p>
            </div>
            <label className="block text-[11px] text-text-secondary">
              Container-fit clearance (mm)
              <input
                aria-label="Container-fit clearance"
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={photo.fitClearanceMm}
                onChange={event => {
                  const value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 0) photo.setFitClearanceMm(value)
                }}
                className="mt-1 w-20 bg-elevated border border-border rounded px-2 py-1 block"
              />
            </label>
            <div className="flex flex-col items-start gap-2">
            <button
              type="button"
              onClick={() => void handleAccept()}
              disabled={accepting || photo.busy}
              className="btn-primary px-3 py-1.5 text-[11px] inline-flex items-center gap-1"
            >
              {accepting && <Loader2 className="w-3 h-3 animate-spin" />}
              Accept boundary and open the plan
            </button>
            {photo.canRecalibrate && (
              <button type="button" onClick={() => void photo.recalibrate()} disabled={photo.busy} className="btn-secondary px-2 py-1 text-[11px]">
                Recalibrate saved original
              </button>
            )}
            <button type="button" onClick={photo.restartCapture} disabled={photo.busy} className="btn-secondary px-2 py-1 text-[11px]">
              Use a different photo
            </button>
          {sketchId && (
            <button type="button" disabled={photo.busy || accepting} onClick={() => router.push(`/projects/${projectId}/sketch/${sketchId}`)}
              className="btn-secondary px-2 py-1 text-[11px]">
              Cancel edits and return to saved plan
            </button>
          )}
          </div>
          </aside>
          <div className="flex-1 min-w-0 min-h-0 bg-base p-3">
            <DrawerOutlineEditor
              imageUrl={photo.correctedUrl}
              polygons={photo.polygons}
              onPolygonsChange={photo.setPolygons}
              scaleFactor={photo.scaleFactor}
              seed={photo.seed}
              createExclusion={photo.createExclusion}
              resetOutline={photo.resetOutline}
            />
          </div>
        </div>
      )}
      {sketchId && !reviewing && (
        <button type="button" disabled={photo.busy || accepting} onClick={() => router.push(`/projects/${projectId}/sketch/${sketchId}`)}
          className="btn-secondary px-2 py-1 text-[11px]">
          Cancel edits and return to saved plan
        </button>
      )}
    </div>
  )
}
