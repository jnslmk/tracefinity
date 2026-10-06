'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { getImageUrl, getProject, listBins, stackAction, updateProjectSketch } from '@/lib/api'
import type { BinProject, BinSummary, ContainerLimits, DrawerGridAlignment, DrawerOutline, DrawerPhotoCalibration, ProjectBinPlacement, ProjectSketch } from '@/types'
import { Alert } from '@/components/Alert'
import { Breadcrumb } from '@/components/Breadcrumb'
import { NumericInput } from '@/components/NumericInput'
import { BIN_DRAG_MIME, DrawerSketchCanvas } from '@/components/DrawerSketchCanvas'
import { DrawerSketch3D } from '@/components/DrawerSketch3D'
import { useDebouncedSave } from '@/hooks/useDebouncedSave'
import { useToolboxPlanning } from '@/hooks/useToolboxPlanning'
import { GRID_UNIT } from '@/lib/constants'
import type { DrawerFootprint } from '@/lib/drawerLayout'
import {
  DEFAULT_DRAWER_GRID_X,
  DEFAULT_DRAWER_GRID_Y,
  DRAWER_GRID_MAX,
  DRAWER_GRID_MIN,
  DEFAULT_BIN_COLOR,
  PLACEMENT_COLORS,
  autoArrange,
  binById,
  binFootprint,
  clampToDrawer,
  drawerGridBounds,
  drawerStats,
  findFreeSpot,
  findLayoutConflicts,
  nextRotation,
  placementRect,
  stackRoot,
  transformStack,
  snapForBin,
  snapUnits,
} from '@/lib/drawerLayout'
import { outlineArea, outlineBounds, outlinePerimeter } from '@/lib/drawerOutline'
import { assessmentCoversDraft, heightLayers, occupyingPlacementIds, resolveLayerSelection } from '@/lib/drawerLayers'
import { binLabel } from '@/lib/projectSelectors'
import { cn } from '@/lib/utils'
import { AlertTriangle, Box, Check, Copy, Grid2x2, LayoutGrid, Loader2, Palette, Plus, RotateCw, Sparkles, Trash2, TriangleAlert, X } from 'lucide-react'

type ViewMode = '2d' | 'side' | '3d'

function ColorSwatches({ value, onChange }: { value: string | null; onChange: (color: string | null) => void }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <button
        type="button"
        onClick={() => onChange(null)}
        className={cn(
          'w-4 h-4 rounded-full border transition-transform hover:scale-110 cursor-pointer',
          value === null ? 'border-text-primary' : 'border-border-subtle',
        )}
        style={{ backgroundColor: DEFAULT_BIN_COLOR }}
        title="Default colour"
      />
      {PLACEMENT_COLORS.map(color => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          className={cn(
            'w-4 h-4 rounded-full border transition-transform hover:scale-110 cursor-pointer',
            value === color ? 'border-text-primary' : 'border-border-subtle',
          )}
          style={{ backgroundColor: color }}
          title={color}
        />
      ))}
    </div>
  )
}

function newPlacementId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `placement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export default function ProjectSketchPage() {
  const params = useParams()
  const router = useRouter()
  const projectId = params.id as string
  const sketchId = params.sketchId as string

  const [project, setProject] = useState<BinProject | null>(null)
  const [sketch, setSketch] = useState<ProjectSketch | null>(null)
  const [bins, setBins] = useState<BinSummary[]>([])
  const [placements, setPlacements] = useState<ProjectBinPlacement[]>([])
  const [drawerX, setDrawerX] = useState<number | null>(null)
  const [drawerY, setDrawerY] = useState<number | null>(null)
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null)
  const [colorPickerBinId, setColorPickerBinId] = useState<string | null>(null)
  // what the last auto-arrange could not fit; "kept" ids stay in the plan, "skipped"
  // bins were never added because the plan was empty
  const [arrangeMisfits, setArrangeMisfits] = useState<{ kind: 'kept' | 'skipped'; ids: string[] } | null>(null)
  const [view, setView] = useState<ViewMode>('2d')
  // null shows every level; a number pins the canvas to one assessed base elevation
  const [layerElevation, setLayerElevation] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [container, setContainer] = useState<ContainerLimits>({ container_width_mm: null, container_depth_mm: null, container_height_mm: null, safety_clearance_mm: 0 })
  const [outline, setOutline] = useState<DrawerOutline | null>(null)
  const [gridOrigin, setGridOrigin] = useState<DrawerGridAlignment>({ origin_x_mm: 0, origin_y_mm: 0, rotation_deg: 0 })
  const [fitClearanceMm, setFitClearanceMm] = useState(0)
  const [sourcePhoto, setSourcePhoto] = useState<DrawerPhotoCalibration | null>(null)
  const [showPhoto, setShowPhoto] = useState(true)
  const [actionBusy, setActionBusy] = useState(false)
  const [removeDialogId, setRemoveDialogId] = useState<string | null>(null)
  const [removeBinCopies, setRemoveBinCopies] = useState(false)
  const saveFlight = useRef<Promise<unknown>>(Promise.resolve())
  const removeDialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (removeDialogId) removeDialogRef.current?.showModal() }, [removeDialogId])
  const draft = useMemo(
    () => ({ ...container, target_grid_x: drawerX, target_grid_y: drawerY, bin_layout: placements, outline, grid_alignment: gridOrigin, fit_clearance_mm: fitClearanceMm }),
    [container, drawerX, drawerY, placements, outline, gridOrigin, fitClearanceMm],
  )
  // the boundary, its grid frame and the fit clearance drive warnings, packing and stats
  const footprint = useMemo<DrawerFootprint>(
    () => ({ outline, originXmm: gridOrigin.origin_x_mm, originYmm: gridOrigin.origin_y_mm, rotationDeg: gridOrigin.rotation_deg, fitClearanceMm }),
    [outline, gridOrigin, fitClearanceMm],
  )
  const { assessment, error: assessmentError, refresh: refreshAssessment } = useToolboxPlanning(projectId, sketchId, draft, Boolean(sketch))
  useEffect(() => {
    async function load() {
      try {
        const [projectData, allBins] = await Promise.all([getProject(projectId), listBins()])
        const sketchData = projectData.sketches.find(entry => entry.id === sketchId)
        setProject(projectData)
        setBins(allBins.filter(bin => bin.project_id === projectData.id || projectData.bin_ids.includes(bin.id)))
        if (!sketchData) {
          setError('drawer plan not found')
          return
        }
        setSketch(sketchData)
        setPlacements(sketchData.bin_layout)
        setDrawerX(sketchData.target_grid_x)
        setDrawerY(sketchData.target_grid_y)
        setContainer({ container_width_mm: sketchData.container_width_mm ?? null, container_depth_mm: sketchData.container_depth_mm ?? null, container_height_mm: sketchData.container_height_mm ?? null, safety_clearance_mm: sketchData.safety_clearance_mm ?? 0 })
        setOutline(sketchData.outline ?? null)
        setGridOrigin(sketchData.grid_alignment ?? { origin_x_mm: 0, origin_y_mm: 0, rotation_deg: 0 })
        setFitClearanceMm(sketchData.fit_clearance_mm ?? 0)
        setSourcePhoto(sketchData.source ?? null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load project')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [projectId, sketchId])

  const hasDrawer = Boolean(outline) || ((container.container_width_mm != null || drawerX !== null) && (container.container_depth_mm != null || drawerY !== null))
  const gridX = container.container_width_mm != null ? container.container_width_mm / GRID_UNIT : drawerX ?? DEFAULT_DRAWER_GRID_X
  const gridY = container.container_depth_mm != null ? container.container_depth_mm / GRID_UNIT : drawerY ?? DEFAULT_DRAWER_GRID_Y
  const gridBounds = useMemo(() => drawerGridBounds(gridX, gridY, footprint), [gridX, gridY, footprint])

  const currentBins = assessment?.bins ?? bins
  const binMap = useMemo(() => binById(currentBins), [currentBins])
  const placementCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const placement of placements) {
      counts.set(placement.bin_id, (counts.get(placement.bin_id) || 0) + 1)
    }
    return counts
  }, [placements])
  const { overlapping, outOfBounds } = useMemo(
    () => findLayoutConflicts(placements, binMap, gridX, gridY, footprint),
    [placements, binMap, gridX, gridY, footprint],
  )
  const stats = useMemo(() => drawerStats(placements, currentBins, Math.floor(gridX * 2) / 2, Math.floor(gridY * 2) / 2, footprint), [placements, currentBins, gridX, gridY, footprint])
  const outlineExtent = useMemo(() => (outline ? outlineBounds(outline) : null), [outline])
  const outlineAreaMm2 = useMemo(() => (outline ? outlineArea(outline) : 0), [outline])
  const outlinePerimeterMm = useMemo(() => (outline ? outlinePerimeter(outline) : 0), [outline])
  // the source photo is anchored to drawer millimetres at the origin, so moving
  // the grid anchor never moves it relative to the boundary
  const sourceImage = useMemo(() => (sourcePhoto ? {
    url: getImageUrl(sourcePhoto.corrected_image_url),
    widthMm: sourcePhoto.image_width * sourcePhoto.scale_factor,
    heightMm: sourcePhoto.image_height * sourcePhoto.scale_factor,
  } : null), [sourcePhoto])
  const sideBaseline = assessment?.height_mm ?? Math.max(70, ...(assessment?.placements.map(p => p.top_mm) ?? []))
  const sideMinY = Math.min(-15, sideBaseline - Math.max(0, ...(assessment?.placements.map(p => p.top_mm) ?? [])) - 15)
  const selectedPlacement = placements.find(placement => placement.id === selectedPlacementId) || null

  // Levels come only from an assessment that describes exactly the placements on
  // the draft, so a stale or failed one cannot invent a layer the plan lacks.
  const draftMatchesAssessment = assessment !== null && assessmentCoversDraft(
    placements.map(placement => placement.id),
    assessment.placements.map(item => item.placement_id),
  )
  const layers = useMemo(
    () => (draftMatchesAssessment && assessment
      ? heightLayers(assessment.placements.map(item => item.z_mm))
      : []),
    [assessment, draftMatchesAssessment],
  )
  // carry the chosen elevation across refreshes; a removed level clamps to its nearest survivor
  useEffect(() => {
    if (layers.length === 0) return
    setLayerElevation(previous => resolveLayerSelection(previous, layers))
  }, [layers])
  const visiblePlacementIds = useMemo(
    () => (layerElevation === null || !draftMatchesAssessment || !assessment
      ? null
      : occupyingPlacementIds(assessment.placements, layerElevation)),
    [assessment, draftMatchesAssessment, layerElevation],
  )
  const visiblePlacements = useMemo(
    () => (visiblePlacementIds === null ? placements : placements.filter(placement => visiblePlacementIds.has(placement.id))),
    [placements, visiblePlacementIds],
  )
  const visibleAssessedPlacements = useMemo(
    () => (!assessment || visiblePlacementIds === null
      ? assessment?.placements ?? []
      : assessment.placements.filter(item => visiblePlacementIds.has(item.placement_id))),
    [assessment, visiblePlacementIds],
  )
  // a filtered-out bin must not stay selected: its controls would edit what is off screen
  useEffect(() => {
    if (visiblePlacementIds !== null && selectedPlacementId !== null && !visiblePlacementIds.has(selectedPlacementId)) {
      setSelectedPlacementId(null)
    }
  }, [visiblePlacementIds, selectedPlacementId])

  // a "kept" notice only stays while some of those placements still exist and still conflict
  const arrangeNotice = useMemo(() => {
    if (!arrangeMisfits) return null
    if (arrangeMisfits.kind === 'skipped') {
      const count = arrangeMisfits.ids.length
      return `${count} bin${count !== 1 ? 's' : ''} did not fit into the drawer and ${count !== 1 ? 'were' : 'was'} not placed.`
    }
    const present = new Set(placements.map(placement => placement.id))
    const count = arrangeMisfits.ids.filter(id => present.has(id) && (overlapping.has(id) || outOfBounds.has(id))).length
    if (count === 0) return null
    return `${count} placement${count !== 1 ? 's' : ''} did not fit and kept ${count !== 1 ? 'their' : 'its'} position, marked with a dashed outline.`
  }, [arrangeMisfits, placements, overlapping, outOfBounds])

  // a rejection must reach the hook: catching it here would report the plan as saved
  const { saving, saved, error: saveError, flush } = useDebouncedSave(
    async () => {
      if (!project || !sketch) return
      const snapshot = draft
      const flight = saveFlight.current.catch(() => {}).then(() => updateProjectSketch(project.id, sketch.id, snapshot))
      saveFlight.current = flight
      await flight
    },
    [project, sketch, draft],
    400,
    { skipInitial: true },
  )

  const flushRef = useRef(flush)
  useEffect(() => { flushRef.current = flush }, [flush])
  useEffect(() => () => { flushRef.current() }, [])

  async function handleStackAction(placementId: string, action: 'stack_on' | 'remove_substack' | 'remove_reconnect' | 'move_up' | 'move_down', supportId?: string) {
    if (actionBusy) return
    setActionBusy(true)
    try {
      await flush()
      await saveFlight.current
      const updated = await stackAction(projectId, sketchId, placementId, action, placements, supportId, removeDialogId === placementId && removeBinCopies)
      setPlacements(updated.bin_layout)
      setRemoveDialogId(null)
      if (!updated.bin_layout.some(p => p.id === selectedPlacementId)) setSelectedPlacementId(null)
      // a stack action moves bins between elevations, so show every level to make
      // the new arrangement inspectable; a same-elevation XY move keeps the layer
      if (action === 'stack_on' || action === 'move_up' || action === 'move_down') setLayerElevation(null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Stack action failed; saved placements are unchanged')
    } finally {
      setActionBusy(false)
    }
  }

  async function handleRename(name: string) {
    if (!project || !sketch) return
    setSketch({ ...sketch, name })
    try {
      const updated = await updateProjectSketch(project.id, sketch.id, { name })
      setSketch(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to rename drawer plan')
    }
  }


  const occupiedRects = useCallback((current: ProjectBinPlacement[], exceptPlacementId?: string) => (
    current
      .filter(placement => placement.id !== exceptPlacementId)
      .flatMap(placement => {
        const bin = binMap.get(placement.bin_id)
        return bin ? [placementRect(placement, bin)] : []
      })
  ), [binMap])

  // a new copy of a bin inherits the highlight its siblings already use
  const colorForBin = useCallback((binId: string) => (
    placements.find(placement => placement.bin_id === binId)?.color ?? null
  ), [placements])

  const handleMove = useCallback((placementId: string, x: number, y: number) => {
    setPlacements(prev => {
      const root = stackRoot(prev, placementId)
      const snap = snapForBin(root ? binMap.get(root.bin_id) : undefined)
      return transformStack(prev, placementId, snapUnits(x, snap), snapUnits(y, snap))
    })
  }, [binMap])

  const handleDropBin = useCallback((binId: string, x: number, y: number) => {
    const placementId = newPlacementId()
    setSelectedPlacementId(placementId)
    setPlacements(prev => [...prev, { id: placementId, bin_id: binId, x, y, rotation: 0, color: null }])
    // a dropped bin rests on the floor; showing all levels keeps it from vanishing
    if (layerElevation !== null && layerElevation > 0) setLayerElevation(null)
  }, [layerElevation])

  const handlePlaceInFreeSpot = useCallback((binId: string) => {
    const bin = binMap.get(binId)
    if (!bin) return
    const placementId = newPlacementId()
    setSelectedPlacementId(placementId)
    // the free spot is derived inside the updater so rapid clicks never stack bins
    setPlacements(prev => {
      const spot = findFreeSpot(bin, occupiedRects(prev), gridX, gridY, { footprint })
      return [...prev, {
        id: placementId,
        bin_id: binId,
        x: spot?.x ?? 0,
        y: spot?.y ?? 0,
        rotation: spot?.rotation ?? 0,
        color: colorForBin(binId),
      }]
    })
    // a new copy rests on the floor; showing all levels keeps it from vanishing
    if (layerElevation !== null && layerElevation > 0) setLayerElevation(null)
  }, [binMap, gridX, gridY, occupiedRects, colorForBin, layerElevation, footprint])

  const handleDuplicate = useCallback((placementId: string) => {
    const source = placements.find(placement => placement.id === placementId)
    if (!source) return
    const bin = binMap.get(source.bin_id)
    if (!bin) return
    const copyId = newPlacementId()
    setSelectedPlacementId(copyId)
    setPlacements(prev => {
      const spot = findFreeSpot(bin, occupiedRects(prev), gridX, gridY, { rotation: source.rotation, footprint })
      return [...prev, {
        ...source,
        id: copyId,
        support_id: null,
        x: spot?.x ?? source.x,
        y: spot?.y ?? source.y,
        rotation: spot?.rotation ?? source.rotation,
      }]
    })
    // the copy is re-seated on the floor; showing all levels keeps it from vanishing
    if (layerElevation !== null && layerElevation > 0) setLayerElevation(null)
  }, [placements, binMap, gridX, gridY, occupiedRects, layerElevation, footprint])

  const handleSetColor = useCallback((placementId: string, color: string | null) => {
    setPlacements(prev => prev.map(placement => (
      placement.id === placementId ? { ...placement, color } : placement
    )))
  }, [])

  const handleSetBinColor = useCallback((binId: string, color: string | null) => {
    setPlacements(prev => prev.map(placement => (
      placement.bin_id === binId ? { ...placement, color } : placement
    )))
  }, [])

  const handleRemove = useCallback((placementId: string) => {
    if (placements.some(p => p.support_id === placementId)) {
      setRemoveDialogId(placementId)
      setRemoveBinCopies(false)
      return
    }
    setPlacements(prev => prev.filter(placement => placement.id !== placementId))
    setSelectedPlacementId(prev => (prev === placementId ? null : prev))
  }, [placements])

  const handleRemoveBin = useCallback((binId: string) => {
    const source = placements.find(p => p.bin_id === binId && placements.some(q => q.support_id === p.id))
    if (source) {
      setRemoveDialogId(source.id)
      setRemoveBinCopies(true)
      return
    }
    setPlacements(prev => prev.filter(p => p.bin_id !== binId))
    setSelectedPlacementId(null)
  }, [placements])

  const handleRotate = useCallback((placementId: string) => {
    setPlacements(prev => {
      const root = stackRoot(prev, placementId)
      if (!root) return prev
      const bin = binMap.get(root.bin_id)
      const rotation = nextRotation(root.rotation)
      if (!bin) return prev
      const { w, h } = binFootprint(bin, rotation)
      const clamped = clampToDrawer({ x: root.x, y: root.y, w, h }, gridX, gridY, snapForBin(bin), footprint)
      return transformStack(prev, root.id, clamped.x, clamped.y, rotation)
    })
  }, [binMap, gridX, gridY, footprint])

  const handleAutoArrange = useCallback(() => {
    const seeding = placements.length === 0
    const input = seeding
      ? currentBins.map(bin => ({ id: newPlacementId(), bin_id: bin.id, x: 0, y: 0, rotation: 0, color: null }))
      : placements
    const result = autoArrange(input, binMap, gridX, gridY, footprint)
    const unfitted = new Set(result.unfittedIds)
    const count = unfitted.size

    // seeds were never part of the plan, so the ones that do not fit are simply not
    // added; an existing plan keeps every placement and only shows what did not fit
    setPlacements(seeding ? result.placements.filter(placement => !unfitted.has(placement.id)) : result.placements)
    setArrangeMisfits(count === 0 ? null : { kind: seeding ? 'skipped' : 'kept', ids: result.unfittedIds })
    setSelectedPlacementId(null)
  }, [placements, currentBins, binMap, gridX, gridY, footprint])

  const handleEnableDrawer = useCallback(() => {
    setDrawerX(DEFAULT_DRAWER_GRID_X)
    setDrawerY(DEFAULT_DRAWER_GRID_Y)
  }, [])

  const handleDisableDrawer = useCallback(() => {
    setDrawerX(null)
    setDrawerY(null)
    setArrangeMisfits(null)
    setContainer({ container_width_mm: null, container_depth_mm: null, container_height_mm: null, safety_clearance_mm: 0 })
  }, [])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!selectedPlacementId || actionBusy || removeDialogId) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        handleRemove(selectedPlacementId)
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        handleRotate(selectedPlacementId)
      }
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault()
        handleDuplicate(selectedPlacementId)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedPlacementId, handleRemove, handleRotate, handleDuplicate, actionBusy, removeDialogId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 gap-2 text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span>Loading drawer plan...</span>
      </div>
    )
  }

  if (!project || !sketch) {
    return (
      <div className="max-w-md mx-auto py-12 space-y-3">
        <Alert variant="error">{error || 'drawer plan not found'}</Alert>
        <button
          type="button"
          onClick={() => router.push(`/projects/${projectId}`)}
          className="btn-secondary w-full px-2 py-1.5 text-[11px]"
        >
          Back to project
        </button>
      </div>
    )
  }

  const conflictCount = overlapping.size + outOfBounds.size
  const selectedBin = selectedPlacement ? binMap.get(selectedPlacement.bin_id) : null

  // slider position 0 is "show all"; 1..n are the layers in ascending elevation
  const layerIndex = layerElevation === null
    ? 0
    : Math.max(1, layers.findIndex(layer => layer.z_mm === layerElevation) + 1)
  const layerPercent = layers.length > 0 ? (layerIndex / layers.length) * 100 : 100
  const assessmentStatus = assessment?.status ?? null
  const layerValueText = layerElevation === null
    ? `Showing all ${layers.length} bin base levels`
    : `Level ${layerIndex} of ${layers.length}, base ${layerElevation.toFixed(1)} mm or ${(layerElevation / 7).toFixed(1)} units`

  return (
    <div className="h-[calc(100vh-44px)] flex" inert={actionBusy}>
      {/* sidebar: drawer size, space usage, project bins */}
      <div className="w-[240px] flex-shrink-0 bg-surface border-r border-border flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-3 space-y-3">
          <div className="glass rounded-[10px] px-3 py-3">
            <div className="flex items-center gap-2 mb-3">
              <Breadcrumb segments={[
                { label: project.name, href: `/projects/${project.id}` },
                { label: sketch.name, editable: true, onEdit: handleRename },
              ]} />
              {saving && <Loader2 className="w-3 h-3 animate-spin text-text-muted flex-shrink-0" />}
              {saved && !saveError && <Check className="w-3 h-3 text-green-400 flex-shrink-0" />}
              {saveError && !saving && (
                <TriangleAlert
                  className="w-3 h-3 text-red-400 flex-shrink-0"
                  aria-label="Changes not saved"
                />
              )}
            </div>
            {saveError && (
              <div role="alert" className="mb-3 rounded-[8px] border border-red-800 bg-red-900/20 px-2 py-1.5 text-[11px] text-red-300">
                Changes are not being saved. Recent edits to this plan will be lost if you leave the page.
              </div>
            )}

            <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[1.5px] mb-2">Drawer size</h3>
            <fieldset className="space-y-2 mb-3 text-[11px] text-text-secondary">
              <legend className="font-semibold text-text-primary">Usable container measurements</legend>
              {([['container_width_mm', 'Usable width (mm)'], ['container_depth_mm', 'Usable depth (mm)'], ['container_height_mm', 'Usable height (mm)'], ['safety_clearance_mm', 'Safety clearance (mm)']] as const).map(([field, label]) => (
                <label key={field} className="block">{label}
                  <input aria-label={label} type="number" min={field === 'safety_clearance_mm' ? 0 : .01} step=".1"
                    value={container[field] ?? ''} className="w-full bg-elevated border border-border rounded px-2 py-1"
                    onChange={event => {
                      const value = event.target.value === '' && field !== 'safety_clearance_mm' ? null : Number(event.target.value)
                      if (value === null || (Number.isFinite(value) && (field === 'safety_clearance_mm' ? value >= 0 : value > 0))) setContainer(prev => ({ ...prev, [field]: value }))
                    }} />
                </label>
              ))}
              <label className="block">Height units (7 mm)
                <input aria-label="Container height units" type="number" min=".01" step=".5"
                  value={container.container_height_mm == null ? '' : container.container_height_mm / 7}
                  className="w-full bg-elevated border border-border rounded px-2 py-1"
                  onChange={event => { const v = Number(event.target.value); if (event.target.value === '') setContainer(prev => ({ ...prev, container_height_mm: null })); else if (Number.isFinite(v) && v > 0) setContainer(prev => ({ ...prev, container_height_mm: v * 7 })) }} />
              </label>
              <p>Floor datum: supporting surface beneath the lowest bin bases. Subtract installed baseplate or liner elevation from floor-to-closed-lid height. 10u means 70 mm, not guaranteed fit. Zero gap is not a manufacturing tolerance.</p>
              <button type="button" className="btn-secondary px-2 py-1" onClick={() => setContainer({ container_width_mm: null, container_depth_mm: null, container_height_mm: null, safety_clearance_mm: 0 })}>Clear physical limits</button>
              <p>{outline ? 'The measured floor controls horizontal fit; these rectangular dimensions do not restrict photo-plan packing or grids.' : 'Millimetre dimensions take precedence over grid controls. Clearing limits preserves placements.'}</p>
            </fieldset>
            {hasDrawer ? (
              <div className="space-y-2">
                <label className="text-[11px] text-text-secondary flex items-center justify-between gap-2">
                  Width
                  <NumericInput
                    value={gridX}
                    disabled={container.container_width_mm != null}
                    min={DRAWER_GRID_MIN}
                    max={DRAWER_GRID_MAX}
                    step={0.5}
                    onChange={setDrawerX}
                    className="w-16 px-1.5 py-1 text-[11px] bg-elevated border border-border-subtle rounded-[7px] text-text-primary outline-none focus:border-accent"
                  />
                </label>
                <label className="text-[11px] text-text-secondary flex items-center justify-between gap-2">
                  Depth
                  <NumericInput
                    value={gridY}
                    disabled={container.container_depth_mm != null}
                    min={DRAWER_GRID_MIN}
                    max={DRAWER_GRID_MAX}
                    step={0.5}
                    onChange={setDrawerY}
                    className="w-16 px-1.5 py-1 text-[11px] bg-elevated border border-border-subtle rounded-[7px] text-text-primary outline-none focus:border-accent"
                  />
                </label>
                <p className="text-[10px] text-text-muted">
                  {outline ? `Legacy rectangle ${gridX} × ${gridY} units (not a fit or scan limit)` : `${gridX} × ${gridY} units · ${(gridX * GRID_UNIT).toFixed(0)} × ${(gridY * GRID_UNIT).toFixed(0)} mm`}
                </p>
                <button
                  type="button"
                  onClick={handleDisableDrawer}
                  className="btn-secondary w-full px-2 py-1 text-[11px]"
                >
                  Clear drawer size
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] text-text-secondary">
                  Optional. Set a drawer size to plan where the project bins go.
                </p>
                <button
                  type="button"
                  onClick={handleEnableDrawer}
                  className="btn-primary w-full px-2 py-1.5 text-[11px]"
                >
                  Set drawer size
                </button>
              </div>
            )}
          </div>

          {outline && (
            <section aria-label="Measured boundary" className="glass rounded-[10px] px-3 py-3 space-y-2 text-[11px] text-text-secondary">
              <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[1.5px]">Measured boundary</h3>
              <p>
                Extent{' '}
                <span className="tabular-nums">
                  {outlineExtent ? (outlineExtent.x1 - outlineExtent.x0).toFixed(1) : '?'} × {outlineExtent ? (outlineExtent.y1 - outlineExtent.y0).toFixed(1) : '?'} mm
                </span>
                {' · '}area <span className="tabular-nums">{(outlineAreaMm2 / 100).toFixed(1)} cm² ({(outlineAreaMm2 / (GRID_UNIT * GRID_UNIT)).toFixed(2)} units)</span>
                {' · '}perimeter <span className="tabular-nums">{outlinePerimeterMm.toFixed(1)} mm</span>
              </p>
              <p className="text-text-muted">
                The extent is a bounding box, not the containment geometry: concavities and exclusions decide what a footprint
                covers. This boundary is photo-derived and its physical fit is unverified — check the real drawer edge.
              </p>
              <label className="block">Container-fit clearance (mm)
                <input
                  aria-label="Container-fit clearance"
                  type="number" min={0} max={100} step={.5}
                  value={fitClearanceMm}
                  className="w-full bg-elevated border border-border rounded px-2 py-1"
                  onChange={event => {
                    const value = Number(event.target.value)
                    if (Number.isFinite(value) && value >= 0) setFitClearanceMm(value)
                  }}
                />
              </label>
              <p className="text-text-muted">Separate from the vertical safety clearance: the gap kept around a footprint at the boundary.</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">Grid origin X (mm)
                  <input
                    aria-label="Grid origin X" type="number" step={1}
                    value={gridOrigin.origin_x_mm}
                    className="w-full bg-elevated border border-border rounded px-2 py-1"
                    onChange={event => {
                      const value = Number(event.target.value)
                      if (Number.isFinite(value) && Math.abs(value) <= 500) setGridOrigin(prev => ({ ...prev, origin_x_mm: value }))
                    }}
                  />
                </label>
                <label className="block">Grid origin Y (mm)
                  <input
                    aria-label="Grid origin Y" type="number" step={1}
                    value={gridOrigin.origin_y_mm}
                    className="w-full bg-elevated border border-border rounded px-2 py-1"
                    onChange={event => {
                      const value = Number(event.target.value)
                      if (Number.isFinite(value) && Math.abs(value) <= 500) setGridOrigin(prev => ({ ...prev, origin_y_mm: value }))
                    }}
                  />
                </label>
              </div>
              <label className="block">Grid rotation (deg, clockwise)
                <input
                  aria-label="Grid rotation" type="number" step={0.5} min={-180} max={180}
                  value={gridOrigin.rotation_deg}
                  className="w-full bg-elevated border border-border rounded px-2 py-1"
                  onChange={event => {
                    const value = Number(event.target.value)
                    if (Number.isFinite(value) && Math.abs(value) <= 180) setGridOrigin(prev => ({ ...prev, rotation_deg: value }))
                  }}
                />
              </label>
              <p className="text-text-muted">Turn the grid to a straight drawer edge that is not parallel to the reference paper, then anchor it. Placements still snap to half or full units and rotate in 90° steps inside the grid.</p>
              {sourceImage && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={showPhoto} onChange={event => setShowPhoto(event.target.checked)} />
                  Show source photo
                </label>
              )}
              <button
                type="button"
                className="btn-secondary w-full px-2 py-1"
                onClick={() => router.push(`/projects/${project.id}/sketch/photo?sketchId=${sketch.id}`)}
              >
                Edit source photo or boundary
              </button>
            </section>
          )}

          {hasDrawer && <section aria-label="Height layers" className="glass rounded-[10px] px-3 py-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[1.5px]">Height layer</h3>
              <button
                type="button"
                onClick={() => setLayerElevation(null)}
                aria-pressed={layerElevation === null}
                className={cn(
                  'rounded-[7px] px-2 py-0.5 text-[10px] transition-colors cursor-pointer',
                  layerElevation === null ? 'bg-accent-muted text-accent' : 'glass-sm text-text-secondary hover:bg-glass-hover',
                )}
              >
                Show all
              </button>
            </div>
            {assessmentError ? (
              <p role="alert" className="text-[11px] text-text-secondary">
                Assessment failed, so no bin base elevation can be verified. Layer selection stays off: {assessmentError}
              </p>
            ) : !assessment ? (
              <p role="status" className="text-[11px] text-text-secondary">
                Assessing the current plan. Layer selection unlocks once it has an assessment.
              </p>
            ) : !draftMatchesAssessment ? (
              <p role="status" className="text-[11px] text-text-secondary">
                The latest assessment does not describe the current draft, so layer selection stays off. Reassess shared tools and bins to unlock it.
              </p>
            ) : (
              <div className="space-y-1.5">
                <input
                  type="range"
                  min={0}
                  max={layers.length}
                  step={1}
                  value={layerIndex}
                  onChange={event => setLayerElevation(layers[Number(event.target.value) - 1]?.z_mm ?? null)}
                  aria-label="Bin base elevation layer"
                  aria-valuetext={layerValueText}
                  className="w-full"
                  style={{ '--slider-pct': `${layerPercent}%` } as React.CSSProperties}
                />
                <p role="status" className="text-[11px] text-text-secondary tabular-nums">
                  {layerElevation === null
                    ? `All ${layers.length} level${layers.length !== 1 ? 's' : ''} · ${placements.length} bin${placements.length !== 1 ? 's' : ''}`
                    : `Level ${layerIndex} of ${layers.length} · ${layerElevation.toFixed(1)} mm · ${(layerElevation / 7).toFixed(1)}u · ${visiblePlacements.length} of ${placements.length} bins visible`}
                </p>
                {assessmentStatus !== null && assessmentStatus !== 'verified' && (
                  <p className="text-[10px] text-amber-500">
                    Assessment is {assessmentStatus}: these elevations are conservative approximations, not verified mating datums.
                  </p>
                )}
                <p className="text-[10px] text-text-muted">
                  Elevations come from the assessment. A bin spanning a level stays visible; one ending at it does not.
                </p>
              </div>
            )}
            <p className="text-[10px] text-text-muted mt-2">
              New and dropped bins always rest on the floor, so an upper level hides them. Choose Show all or level 1 to see them again.
            </p>
          </section>}

          <section aria-label="Toolbox fit diagnostics" className="glass rounded-[10px] p-3 text-[11px] text-text-secondary space-y-2">
            <button type="button" onClick={refreshAssessment} className="btn-secondary px-2 py-1">Reassess shared tools and bins</button>
            {assessmentError && <p role="alert">{assessmentError}</p>}
            {!assessment && !assessmentError && <p role="status">Assessing current plan…</p>}
            {assessment && <>
              <p role="status" data-testid="plan-fit-status">Fit: {assessment.status}</p>
              {!outline && <p>Usable grid {assessment.grid_x ?? 'unknown'} × {assessment.grid_y ?? 'unknown'}; residual edge strips {assessment.residual_width_mm?.toFixed(1) ?? '?'} × {assessment.residual_depth_mm?.toFixed(1) ?? '?'} mm.</p>}
              {outline && <p>Measured boundary: {assessment.floor_area_units?.toFixed(2) ?? '?'} grid units of floor, {assessment.usable_area_units.toFixed(2)} usable in whole half-cells, {assessment.fit_clearance_mm} mm fit clearance. The boundary, not a rectangle, decides what fits; the photo cannot verify physical fit.</p>}
              <p>Occupied floor {assessment.occupied_floor_units} units; free {assessment.free_cells.length / 4} units in {assessment.free_regions.length} connected regions.</p>
              {assessment.free_regions.map((region, i) => <p key={i}>Free region {i + 1}: {region.area_units} units (not a packing guarantee)</p>)}
              {assessment.violations.map((v, i) => <p role="alert" key={i}>{v.message}{v.clearance_mm !== undefined ? ` (${v.clearance_mm.toFixed(2)} mm)` : ''} {v.placement_id && `Placement ${v.placement_id}`}</p>)}
              {assessment.unresolved.map((reason, i) => <p key={i}>Unresolved: {reason}</p>)}
              {assessment.missing_tool_ids.map(id => <a key={id} className="block text-accent" href={`/tools/${id}`}>Measure tool {id}</a>)}
              {assessment.unhoused_tool_ids.map(id => <p key={id}>Not housed in this plan: {id}</p>)}
              {assessment.stacks.map(stack => <p key={stack.root_id}>Stack {stack.root_id.slice(0, 8)} headroom: {stack.headroom_mm?.toFixed(2) ?? 'unknown'} mm</p>)}
              <p>Fit is conditional on measured resting thickness, conservative envelopes, gap and intact support. Physically check printed parts.</p>
              {selectedPlacementId && assessment.placements.filter(p => p.placement_id === selectedPlacementId).map(p => {
                // an imported stack can sit on a support whose interface is not confirmed:
                // that is not a floor seat, so a null verdict may not read as "floor"
                const support = p.support_compatible === null
                  ? (selectedPlacement?.support_id ? 'unverified' : 'floor')
                  : p.support_compatible ? 'compatible' : 'incompatible'
                return <div key={p.placement_id} className="border-t border-border pt-2">
                  <p>Selected elevation {p.z_mm.toFixed(2)} mm; top {p.top_mm.toFixed(2)} mm; headroom {p.headroom_mm?.toFixed(2) ?? 'unknown'} mm. Support {support}.</p>
                  {p.envelopes.map(e => <p key={e.id}>{e.name}: {!e.seating_verified ? 'resting elevation cannot be established' : e.thickness_mm == null ? 'unknown thickness' : `${e.thickness_mm} mm conservative envelope; rests at ${e.resting_z_mm?.toFixed(2)} mm; upper-bin clearance ${e.clearance_mm?.toFixed(2)} mm`}{e.tool_id === p.limiting_tool_id ? ' (limiting tool)' : ''}</p>)}
                </div>
              })}
            </>}
          </section>
          {placements.length > 0 && <section aria-label="Stack members" className="glass rounded-[10px] p-3 text-[11px] space-y-2">
            <h3 className="font-semibold text-text-primary">Select every stack member</h3>
            {visiblePlacementIds !== null && <p className="text-[10px] text-text-muted">
              Members hidden by the selected height layer cannot be selected here until you show all levels.
            </p>}
            {placements.map((p, i) => {
              const hidden = visiblePlacementIds !== null && !visiblePlacementIds.has(p.id)
              return <button key={p.id} type="button" aria-pressed={selectedPlacementId === p.id} disabled={hidden}
                title={hidden ? 'Hidden at the selected height layer' : undefined}
                className={cn('btn-secondary block w-full px-2 py-1 text-left', hidden && 'opacity-40 cursor-default')}
                onClick={() => setSelectedPlacementId(p.id)}>
                Placement {i + 1}: {binMap.get(p.bin_id)?.name || p.bin_id} · {p.support_id ? 'supported' : 'floor'}
              </button>
            })}
          </section>}
          {hasDrawer && (
            <div className="glass rounded-[10px] px-3 py-3">
              <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[1.5px] mb-2">Space usage</h3>
              <div className="text-[11px] text-text-secondary space-y-0.5">
                <div className="flex justify-between"><span>Used</span><span>{stats.usedUnits} / {stats.drawerUnits} units</span></div>
                <div className="flex justify-between"><span>Free</span><span>{stats.freeUnits} units</span></div>
                <div className="flex justify-between"><span>Placements</span><span>{stats.placementCount}</span></div>
              </div>
              <div className="mt-2 h-1.5 w-full rounded-full bg-elevated overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${Math.min(100, stats.coverage * 100)}%` }} />
              </div>
              {conflictCount > 0 && (
                <p className="mt-2 text-[10px] text-amber-500 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                  {[
                    overlapping.size > 0 ? `${overlapping.size} overlapping` : null,
                    outOfBounds.size > 0 ? `${outOfBounds.size} outside drawer` : null,
                  ].filter(Boolean).join(' · ')}
                </p>
              )}
              {arrangeNotice && (
                <div role="status" className="mt-2 flex items-start gap-1 text-[10px] text-amber-500">
                  <span className="flex-1">{arrangeNotice}</span>
                  <button
                    type="button"
                    onClick={() => setArrangeMisfits(null)}
                    className="flex-shrink-0 hover:text-text-primary cursor-pointer"
                    title="Dismiss"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  onClick={handleAutoArrange}
                  disabled={currentBins.length === 0}
                  className="btn-secondary flex-1 px-2 py-1 text-[11px] inline-flex items-center justify-center gap-1"
                  title="Repack the current placements, largest bin first"
                >
                  <Sparkles className="w-3 h-3" />
                  Auto arrange
                </button>
                <button
                  type="button"
                  onClick={() => { setPlacements([]); setSelectedPlacementId(null); setArrangeMisfits(null) }}
                  disabled={placements.length === 0}
                  className="btn-secondary px-2 py-1 text-[11px]"
                  title="Remove all bins from the drawer"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}

          <div className="glass rounded-[10px] px-3 py-3">
            <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[1.5px] mb-2">
              Project bins ({currentBins.length})
            </h3>
            {currentBins.length === 0 ? (
              <p className="text-[11px] text-text-muted">
                No bins in this project yet. Create bins on the project page first.
              </p>
            ) : (
              <div className="space-y-1.5">
                {currentBins.map(bin => {
                  const count = placementCounts.get(bin.id) || 0
                  const binColor = colorForBin(bin.id)
                  const colorsOpen = colorPickerBinId === bin.id
                  return (
                    <div
                      key={bin.id}
                      draggable={hasDrawer}
                      onDragStart={e => {
                        e.dataTransfer.setData(BIN_DRAG_MIME, bin.id)
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      className={cn(
                        'glass-sm rounded-[7px] px-2 py-1.5 border border-transparent',
                        hasDrawer ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] text-text-primary truncate">{binLabel(bin)}</span>
                          <span className="block text-[10px] text-text-muted truncate">
                            {bin.grid_x}x{bin.grid_y} · {bin.height_units}u · {bin.tool_count} tool{bin.tool_count !== 1 ? 's' : ''}
                            {bin.half_grid_base ? ' · ½ grid' : ''}
                          </span>
                        </span>
                        {count > 0 && (
                          <span
                            className="text-[10px] text-accent bg-accent-muted rounded-full px-1.5 py-px flex-shrink-0"
                            title={`${count} placed in the drawer`}
                          >
                            {count}x
                          </span>
                        )}
                        {hasDrawer && (
                          <span className="flex items-center gap-0.5 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => setColorPickerBinId(prev => (prev === bin.id ? null : bin.id))}
                              className={cn(
                                'p-0.5 rounded-[7px] transition-colors cursor-pointer',
                                colorsOpen ? 'text-accent' : 'text-text-muted hover:text-accent',
                              )}
                              title="Highlight colour"
                            >
                              <Palette className="w-3 h-3" style={binColor ? { color: binColor } : undefined} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handlePlaceInFreeSpot(bin.id)}
                              className="p-0.5 text-text-muted hover:text-accent rounded-[7px] transition-colors cursor-pointer"
                              title="Place another copy in the first free spot"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                            {count > 0 && (
                              <button
                                type="button"
                                onClick={() => handleRemoveBin(bin.id)}
                                className="p-0.5 text-text-muted hover:text-accent rounded-[7px] transition-colors cursor-pointer"
                                title="Remove all copies from the drawer"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </span>
                        )}
                      </div>
                      {colorsOpen && (
                        <div className="mt-1.5 pt-1.5 border-t border-border-subtle">
                          <ColorSwatches
                            value={binColor}
                            onChange={color => handleSetBinColor(bin.id, color)}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="p-3 flex-shrink-0 space-y-1.5">
          {error && <Alert variant="error">{error}</Alert>}
          <button
            type="button"
            onClick={async () => {
              await flush()
              router.push(`/projects/${project.id}`)
            }}
            className="btn-secondary w-full px-2 py-1.5 text-[11px]"
          >
            Back to project
          </button>
        </div>
      </div>

      {/* main: 2D / 3D drawer view */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-shrink-0 bg-surface border-b border-border px-3 py-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            {([['2d', '2D top down', LayoutGrid], ['side', 'Side clearance', LayoutGrid], ['3d', '3D', Box]] as const).map(([mode, label, Icon]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                className={cn(
                  'rounded-[7px] px-2.5 py-1 text-[11px] flex items-center gap-1.5 transition-colors cursor-pointer',
                  view === mode ? 'bg-accent-muted text-accent' : 'glass-sm text-text-secondary hover:bg-glass-hover',
                )}
              >
                <Icon className="w-3 h-3" />
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-text-muted truncate">
            {hasDrawer
              ? 'Drag bins in · drag to move · R rotates · D duplicates · Delete removes'
              : 'Set a drawer size to start planning'}
          </p>
        </div>

        <div className="flex-1 min-h-0 relative bg-inset">
          {!hasDrawer ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-text-muted">
              <Grid2x2 className="w-8 h-8" />
              <p className="text-xs">No drawer size set for this project.</p>
              <button type="button" onClick={handleEnableDrawer} className="btn-primary px-3 py-1.5 text-xs">
                Set drawer size
              </button>
            </div>
          ) : view === '2d' ? (
            <DrawerSketchCanvas
              bins={binMap}
              placements={visiblePlacements}
              drawerX={gridX}
              drawerY={gridY}
              selectedPlacementId={selectedPlacementId}
              overlapping={overlapping}
              outOfBounds={outOfBounds}
              onSelect={setSelectedPlacementId}
              onMove={handleMove}
              onDropBin={handleDropBin}
              assessment={assessment}
              outline={outline}
              gridOriginMm={{ x: gridOrigin.origin_x_mm, y: gridOrigin.origin_y_mm }}
              gridRotationDeg={gridOrigin.rotation_deg}
              sourceImage={sourceImage}
              showSource={showPhoto}
            />
          ) : view === 'side' ? (
            <div className="w-full h-full p-6">
              <p className="text-text-secondary text-xs mb-3">Side clearance diagram: conservative tool envelopes and bin extents. Use 3D for actual generated surfaces.</p>
              {!assessment ? <p role="status">Assessment pending</p> : <svg role="img" aria-label="Side clearance diagram" className="w-full h-[80%]"
                viewBox={`${gridBounds.x0 * GRID_UNIT - 5} ${sideMinY} ${(gridBounds.x1 - gridBounds.x0) * GRID_UNIT + 10} ${sideBaseline + 15 - sideMinY}`}>
                {assessment.height_mm != null && <>
                  <line x1={gridBounds.x0 * GRID_UNIT} x2={gridBounds.x1 * GRID_UNIT} y1="0" y2="0" stroke="var(--color-text-primary)" strokeDasharray="4 2" />
                  <text x={gridBounds.x0 * GRID_UNIT} y="-5" fontSize="5" fill="var(--color-text-primary)">Closed lid ceiling {assessment.height_mm} mm</text>
                </>}
                {visibleAssessedPlacements.map(p => {
                  const placement = placements.find(item => item.id === p.placement_id)
                  const bin = placement && binMap.get(placement.bin_id)
                  if (!placement || !bin) return null
                  const baseline = sideBaseline
                  return <g key={p.placement_id} onClick={() => setSelectedPlacementId(p.placement_id)}>
                    <rect x={placement.x * GRID_UNIT} y={baseline-p.z_mm-p.external_height_mm} width={binFootprint(bin, placement.rotation).w * GRID_UNIT}
                      height={p.external_height_mm} fill={placement.color || DEFAULT_BIN_COLOR} fillOpacity=".2" stroke="var(--color-text-primary)" />
                    <text x={placement.x * GRID_UNIT + 2} y={baseline-p.z_mm-2} fontSize="5" fill="var(--color-text-primary)">{bin.name || bin.id.slice(0,8)} · Z {p.z_mm.toFixed(1)} mm</text>
                    {p.envelopes.filter(e => e.top_mm !== null && e.points.length > 0).map(e => <g key={e.id}>
                      <rect x={Math.min(...e.points.map(pt => pt.x))} y={baseline-e.top_mm!} width={Math.max(...e.points.map(pt => pt.x))-Math.min(...e.points.map(pt => pt.x))}
                        height={e.thickness_mm!} fill="#e5b854" fillOpacity=".4" stroke="var(--color-text-primary)" />
                      <text x={Math.min(...e.points.map(pt => pt.x))} y={baseline-e.top_mm!-1} fontSize="4" fill="var(--color-text-primary)">{e.name} (conservative envelope)</text>
                    </g>)}
                    {p.envelopes.filter(e => e.insert_height_mm > 0 && e.resting_z_mm !== null && e.points.length > 0).map(e => <g key={`insert-${e.id}`}>
                      <rect x={Math.min(...e.points.map(pt => pt.x))} y={baseline-e.resting_z_mm!} width={Math.max(...e.points.map(pt => pt.x))-Math.min(...e.points.map(pt => pt.x))}
                        height={e.insert_height_mm} fill="#81bce0" fillOpacity=".5" stroke="var(--color-text-primary)" />
                      <text x={Math.min(...e.points.map(pt => pt.x))} y={baseline-e.resting_z_mm!-1} fontSize="4" fill="var(--color-text-primary)">Insert for {e.name} (conservative envelope)</text>
                    </g>)}
                  </g>
                })}
              </svg>}
            </div>
          ) : (
            <DrawerSketch3D
              bins={binMap}
              placements={visiblePlacements}
              drawerX={gridX}
              drawerY={gridY}
              selectedPlacementId={selectedPlacementId}
              overlapping={overlapping}
              outOfBounds={outOfBounds}
              assessment={assessment}
              onSelect={setSelectedPlacementId}
              outline={outline}
              gridOriginMm={{ x: gridOrigin.origin_x_mm, y: gridOrigin.origin_y_mm }}
              gridRotationDeg={gridOrigin.rotation_deg}
            />
          )}

          {/* floating controls for the selected placement */}
          {hasDrawer && selectedPlacement && selectedBin && (
            <div className="absolute bottom-3.5 left-3.5 right-3.5 z-20 glass-toolbar px-3 py-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-text-secondary truncate max-w-[200px]">
                {binLabel(selectedBin)}
              </span>
              <span className="text-[10px] text-text-muted">
                {selectedPlacement.x} / {selectedPlacement.y} · {selectedPlacement.rotation}°
              </span>
              <label className="text-[11px]">Stack on
                <select aria-label="Stack on placement" value="" className="bg-elevated border border-border rounded ml-1"
                  onChange={event => { if (event.target.value) handleStackAction(selectedPlacement.id, 'stack_on', event.target.value) }}>
                  <option value="">Choose support</option>
                  {placements.filter(p => p.id !== selectedPlacement.id && !p.support_id && !placements.some(q => q.support_id === p.id)).map((p, i) => <option key={p.id} value={p.id}>Support {i + 1}: {binMap.get(p.bin_id)?.name || p.bin_id}</option>)}
                  {placements.filter(p => p.id !== selectedPlacement.id && p.support_id && !placements.some(q => q.support_id === p.id)).map(p => <option key={p.id} value={p.id}>Top: {binMap.get(p.bin_id)?.name || p.bin_id}</option>)}
                </select>
              </label>
              <button type="button" className="btn-secondary px-2 py-1 text-[11px]" onClick={() => handleStackAction(selectedPlacement.id, 'move_up')}>Move up in stack</button>
              <button type="button" className="btn-secondary px-2 py-1 text-[11px]" onClick={() => handleStackAction(selectedPlacement.id, 'move_down')}>Move down in stack</button>
              <label className="text-[11px]">Stack X<input aria-label="Stack X" type="number" step={selectedBin.half_grid_base ? .5 : 1} min="0" max="40" value={stackRoot(placements, selectedPlacement.id)?.x ?? 0}
                className="w-12 bg-elevated border border-border rounded" onChange={e => { const root = stackRoot(placements, selectedPlacement.id); const v = Number(e.target.value); if (root && Number.isFinite(v) && v >= 0 && v <= 40) handleMove(root.id, v, root.y) }} /></label>
              <label className="text-[11px]">Stack Y<input aria-label="Stack Y" type="number" step={selectedBin.half_grid_base ? .5 : 1} min="0" max="40" value={stackRoot(placements, selectedPlacement.id)?.y ?? 0}
                className="w-12 bg-elevated border border-border rounded" onChange={e => { const root = stackRoot(placements, selectedPlacement.id); const v = Number(e.target.value); if (root && Number.isFinite(v) && v >= 0 && v <= 40) handleMove(root.id, root.x, v) }} /></label>
              <button
                type="button"
                onClick={() => handleRotate(selectedPlacement.id)}
                className="p-1 text-text-muted hover:text-accent rounded-[7px] transition-colors cursor-pointer"
                title="Rotate 90 degrees (R)"
              >
                <RotateCw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleDuplicate(selectedPlacement.id)}
                className="p-1 text-text-muted hover:text-accent rounded-[7px] transition-colors cursor-pointer"
                title="Duplicate (D)"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleRemove(selectedPlacement.id)}
                className="btn-danger-icon"
                title="Remove from drawer (Delete)"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <span className="w-px h-4 bg-border-subtle" />
              <ColorSwatches
                value={selectedPlacement.color}
                onChange={color => handleSetColor(selectedPlacement.id, color)}
              />
            </div>
          )}
          {removeDialogId && <dialog ref={removeDialogRef} aria-label="Remove stack member"
            onCancel={event => { if (actionBusy) event.preventDefault(); else setRemoveDialogId(null) }}
            className="fixed inset-0 bg-surface/95 text-text-primary rounded p-4 max-w-lg">
            <div inert={actionBusy} className="space-y-3">
              <p>Remove {removeBinCopies ? 'all copies of this bin' : 'this placement'} and upper sub-stacks, or reconnect the upper bins to remaining supports after compatibility checks? Library bins are retained.</p>
              <button type="button" className="btn-secondary px-3 py-2" onClick={() => handleStackAction(removeDialogId, 'remove_substack')}>Remove upper sub-stack</button>
              <button type="button" className="btn-secondary px-3 py-2" onClick={() => handleStackAction(removeDialogId, 'remove_reconnect')}>Remove and reconnect</button>
              <button type="button" className="btn-secondary px-3 py-2" onClick={() => setRemoveDialogId(null)}>Cancel</button>
              {error && <p role="alert">{error}</p>}
            </div>
          </dialog>}
        </div>
      </div>
    </div>
  )
}
