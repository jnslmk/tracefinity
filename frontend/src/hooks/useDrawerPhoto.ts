'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  createProjectSketch,
  getImageUrl,
  getProject,
  proposeDrawerOutline,
  setCorners,
  updateProjectSketch,
  uploadImage,
} from '@/lib/api'
import { outlineToPolygons, polygonsToOutline, validateOutline } from '@/lib/drawerOutline'
import type { DrawerPhotoCalibration, PaperSize, PhotoWarning, Point, Polygon, ProjectSketch } from '@/types'

export type DrawerPhotoStep = 'upload' | 'corners' | 'floor' | 'review'

const DEFAULT_CORNERS_MARGIN = 0.08

function defaultCorners(width: number, height: number): Point[] {
  const mx = width * DEFAULT_CORNERS_MARGIN
  const my = height * DEFAULT_CORNERS_MARGIN
  return [
    { x: mx, y: my }, { x: width - mx, y: my },
    { x: width - mx, y: height - my }, { x: mx, y: height - my },
  ]
}

/** A first editable ring, so the local path always traces over a real outline. */
function floorRect(width: number, height: number): Polygon {
  const inset = 0.03
  const mx = width * inset
  const my = height * inset
  return {
    id: 'drawer-outline',
    label: 'Floor boundary',
    finger_holes: [],
    interior_rings: [],
    points: [
      { x: mx, y: my }, { x: width - mx, y: my },
      { x: width - mx, y: height - my }, { x: mx, y: height - my },
    ],
  }
}

function exclusionSquare(width: number, height: number, index: number): Polygon {
  const side = Math.max(20, Math.min(width, height) * 0.15)
  const cx = width / 2
  const cy = height / 2
  return {
    id: `drawer-exclusion-${Date.now()}-${index}`,
    label: `Exclusion ${index}`,
    finger_holes: [],
    interior_rings: [],
    points: [
      { x: cx - side / 2, y: cy - side / 2 }, { x: cx + side / 2, y: cy - side / 2 },
      { x: cx + side / 2, y: cy + side / 2 }, { x: cx - side / 2, y: cy + side / 2 },
    ],
  }
}

/**
 * The photo-derived drawer boundary state machine: upload and calibrate the
 * photo, pick the interior floor, get a candidate from the provider (or trace
 * locally over the same photo), review and accept it onto the plan.
 */
export function useDrawerPhoto(projectId: string, initialSketchId: string | null) {
  const [step, setStep] = useState<DrawerPhotoStep>('upload')
  const [sketchId, setSketchId] = useState<string | null>(initialSketchId)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Only a pending capture/recalibration session is adopted on Accept. Saved
  // sources never depend on their historical (possibly deleted) session.
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [savedSource, setSavedSource] = useState<DrawerPhotoCalibration | null>(null)
  const [paperSize, setPaperSize] = useState<PaperSize>('a4')
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [corners, setCornerPoints] = useState<Point[]>([])

  const [correctedUrl, setCorrectedUrl] = useState<string | null>(null)
  const [correctedSize, setCorrectedSize] = useState({ width: 0, height: 0 })
  const [scaleFactor, setScaleFactor] = useState<number | null>(null)
  const [warnings, setWarnings] = useState<PhotoWarning[]>([])

  const [seed, setSeed] = useState<Point | null>(null)
  const [polygons, setPolygons] = useState<Polygon[]>([])
  const [fitClearanceMm, setFitClearanceMm] = useState(0)

  // resume an existing photo-derived plan: its saved boundary and calibration load
  useEffect(() => {
    if (!initialSketchId) return
    let cancelled = false
    getProject(projectId).then(project => {
      if (cancelled) return
      const sketch = project.sketches.find(item => item.id === initialSketchId) as ProjectSketch | undefined
      if (!sketch?.source) return
      setCorrectedUrl(getImageUrl(sketch.source.corrected_image_url))
      setCorrectedSize({ width: sketch.source.image_width, height: sketch.source.image_height })
      setScaleFactor(sketch.source.scale_factor)
      setSavedSource(sketch.source)
      setOriginalUrl(sketch.source.original_image_url ? getImageUrl(sketch.source.original_image_url) : null)
      setCornerPoints(sketch.source.corners)
      setPaperSize(sketch.source.paper_size)
      setSessionId(null)
      setSeed(sketch.source.seed)
      setFitClearanceMm(sketch.fit_clearance_mm ?? 0)
      if (sketch.outline) {
        const scale = sketch.source.scale_factor
        const toPx = (p: Point) => ({ x: p.x / scale, y: p.y / scale })
        setPolygons(outlineToPolygons({
          points: sketch.outline.points.map(toPx),
          interior_rings: sketch.outline.interior_rings.map(ring => ring.map(toPx)),
        }))
      }
      setStep('review')
    }).catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load the plan source')
    })
    return () => { cancelled = true }
  }, [projectId, initialSketchId])

  const upload = useCallback(async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const result = await uploadImage(file)
      setSessionId(result.session_id)
      setOriginalUrl(getImageUrl(result.image_url))
      setCornerPoints(result.detected_corners ?? defaultCorners(result.image_width ?? 1000, result.image_height ?? 1000))
      setCorrectedUrl(null)
      setScaleFactor(null)
      setCorrectedSize({ width: 0, height: 0 })
      setSeed(null)
      setPolygons([])
      setStep('corners')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed')
    } finally {
      setBusy(false)
    }
  }, [])

  /** Reopen the owned, uncorrected original, not the historical trace session. */
  const recalibrate = useCallback(async () => {
    if (!savedSource?.original_image_url) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(getImageUrl(savedSource.original_image_url), { credentials: 'include' })
      if (!response.ok) throw new Error('the saved original photo could not be loaded')
      const blob = await response.blob()
      const name = savedSource.original_image_url.split('/').pop() ?? 'original.jpg'
      const result = await uploadImage(new File([blob], name, { type: blob.type }))
      setSessionId(result.session_id)
      setOriginalUrl(getImageUrl(result.image_url))
      setCornerPoints(savedSource.corners)
      setPaperSize(savedSource.paper_size)
      setCorrectedUrl(null)
      setScaleFactor(null)
      setCorrectedSize({ width: 0, height: 0 })
      setSeed(null)
      setPolygons([])
      setWarnings([])
      setStep('corners')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to reopen the original photo')
    } finally {
      setBusy(false)
    }
  }, [savedSource])

  const applyCorners = useCallback(async (size: PaperSize) => {
    if (!sessionId) return
    setBusy(true)
    setError(null)
    try {
      const result = await setCorners(sessionId, corners, size, true)
      const url = getImageUrl(result.corrected_image_url)
      const sizePx = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
        image.onerror = () => reject(new Error('the corrected photo could not be loaded'))
        image.src = url
      })
      // Switch the image and its metric frame together; never reuse old-source
      // pixels or a boundary measured against a previous calibration.
      setCorrectedUrl(url)
      setScaleFactor(result.scale_factor)
      setCorrectedSize(sizePx)
      setPaperSize(size)
      setWarnings(result.warnings ?? [])
      setSeed(null)
      setPolygons([])
      setStep('floor')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to correct the photo')
    } finally {
      setBusy(false)
    }
  }, [sessionId, corners])

  /** Record the user's positive floor selection; choosing it never calls a provider. */
  const selectSeed = useCallback((point: Point) => {
    setSeed(point)
    setError(null)
  }, [])

  // generating or tracing happens entirely in this component: no plan is saved
  // until the user accepts, so a refused candidate never leaves an abandoned plan
  const generate = useCallback(async (selected: Point, tracer?: string) => {
    if (!sketchId && !sessionId) {
      setError('calibrate the photo first')
      return
    }
    setBusy(true)
    setError(null)
    setSeed(selected)
    try {
      const candidate = await proposeDrawerOutline(
        projectId,
        sessionId ? { sessionId } : { sketchId: sketchId as string },
        selected,
        { tracer },
      )
      const scale = scaleFactor
      if (!scale) throw new Error('the photo has no metric scale')
      const toPx = (p: Point) => ({ x: p.x / scale, y: p.y / scale })
      setPolygons(outlineToPolygons({
        points: candidate.outline.points.map(toPx),
        interior_rings: candidate.outline.interior_rings.map(ring => ring.map(toPx)),
      }))
      setStep('review')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the provider could not propose a boundary')
    } finally {
      setBusy(false)
    }
  }, [projectId, sketchId, sessionId, scaleFactor])

  /** Local, key-free path: trace the boundary by hand over the calibrated photo. */
  const startManual = useCallback((selected: Point) => {
    setError(null)
    setSeed(selected)
    setPolygons(correctedSize.width > 0 ? [floorRect(correctedSize.width, correctedSize.height)] : [])
    setStep('review')
  }, [correctedSize])

  /** Build the next polygon list for an added obstruction ring. */
  const createExclusion = useCallback((polygons: Polygon[]): Polygon[] | null => {
    if (correctedSize.width <= 0) return null
    return [...polygons, exclusionSquare(correctedSize.width, correctedSize.height, polygons.length)]
  }, [correctedSize])

  /** Build the reset polygon list: a fresh editable rectangle over the photo. */
  const resetOutline = useCallback((): Polygon[] | null => {
    if (correctedSize.width <= 0) return null
    return [floorRect(correctedSize.width, correctedSize.height)]
  }, [correctedSize])

  /** Persist the boundary; creates the plan on first accept, updates it afterwards. */
  const accept = useCallback(async (): Promise<ProjectSketch | null> => {
    if (!scaleFactor || (!sketchId && !sessionId)) return null
    const outline = polygonsToOutline(polygons)
    if (!outline) {
      setError('trace at least one outline before accepting the boundary')
      return null
    }
    const problem = validateOutline(outline)
    if (problem) {
      setError(problem)
      return null
    }
    const toMm = (p: Point) => ({ x: p.x * scaleFactor, y: p.y * scaleFactor })
    const payload = {
      outline: {
        points: outline.points.map(toMm),
        interior_rings: outline.interior_rings.map(ring => ring.map(toMm)),
      },
      fit_clearance_mm: fitClearanceMm,
      ...(sessionId ? { source_session_id: sessionId } : {}),
      ...(seed ? { source_seed: seed } : {}),
    }
    setBusy(true)
    setError(null)
    try {
      const updated = sketchId
        ? await updateProjectSketch(projectId, sketchId, payload)
        : await createProjectSketch(projectId, payload)
      setSketchId(updated.id)
      setSessionId(null)
      if (updated.source) {
        setSavedSource(updated.source)
        setCorrectedUrl(getImageUrl(updated.source.corrected_image_url))
        setOriginalUrl(updated.source.original_image_url ? getImageUrl(updated.source.original_image_url) : null)
      }
      return updated
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the boundary was rejected; the saved plan is unchanged')
      return null
    } finally {
      setBusy(false)
    }
  }, [projectId, sketchId, sessionId, polygons, scaleFactor, fitClearanceMm, seed])

  const clearWarnings = useCallback(() => setWarnings([]), [])

  const restartCapture = useCallback(() => {
    setStep('upload')
    setOriginalUrl(null)
    setCorrectedUrl(null)
    setCorrectedSize({ width: 0, height: 0 })
    setScaleFactor(null)
    setCornerPoints([])
    setSessionId(null)
    setSeed(null)
    setPolygons([])
    setWarnings([])
    setError(null)
  }, [])

  return {
    step, setStep, busy, error,
    originalUrl, corners, setCornerPoints, paperSize, setPaperSize,
    correctedUrl, scaleFactor, warnings, clearWarnings,
    seed, polygons, setPolygons, fitClearanceMm, setFitClearanceMm, selectSeed,
    upload, applyCorners, generate, startManual, accept, restartCapture, recalibrate,
    canRecalibrate: Boolean(savedSource?.original_image_url),
    createExclusion, resetOutline,
  }
}
