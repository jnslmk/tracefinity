'use client'

import { useState, useRef, useCallback, useEffect, useId } from 'react'
import { AlertTriangle, LayoutGrid, LoaderCircle } from 'lucide-react'
import type { AccessPocket, PlacedTool, TextLabel } from '@/types'
import { snapToGrid as snapToGridUtil } from '@/lib/svg'
import { GRID_UNIT, DISPLAY_SCALE, SNAP_GRID } from '@/lib/constants'
import type { GridSizingMode } from '@/lib/constants'
import { BinEditorToolbar } from '@/components/BinEditorToolbar'
import { BinEditorCanvas } from '@/components/BinEditorCanvas'
import { AccessPocketControls } from '@/components/AccessPocketControls'
import { clampPocket, defaultPocket, resizePocketFromCorner } from '@/lib/accessPockets'

interface Props {
  placedTools: PlacedTool[]
  onPlacedToolsChange: (tools: PlacedTool[], label?: string) => void
  textLabels: TextLabel[]
  onTextLabelsChange: (labels: TextLabel[], label?: string) => void
  accessPockets: AccessPocket[]
  onAccessPocketsChange: (pockets: AccessPocket[], label?: string) => void
  binChamfer?: number
  gridX: number
  gridY: number
  partialBins: boolean
  partialBinsValues: boolean[]
  wallThickness: number
  stackingLip?: boolean
  defaultCutoutDepth: number
  maxCutoutDepth: number
  depthMode?: 'automatic' | 'uniform' | null
  halfGridBase?: boolean
  cutoutClearance?: number
  gridSizingMode?: GridSizingMode
  onAutoArrange?: (tools: PlacedTool[], gridX: number | null) => void
  onEditTool?: (toolId: string) => void
  smoothedToolIds?: Set<string>
  onToggleSmoothed?: (toolId: string, smoothed: boolean) => void
  smoothLevels?: Map<string, number>
  onSmoothLevelChange?: (toolId: string, level: number) => void
  onDraggingChange?: (dragging: boolean) => void
  historyRevision?: number
}

type Tool = 'select' | 'text' | 'pocket'

interface AutoLayoutPlacement {
  tool_id: string
  placement_id?: string
  name: string
  x: number
  y: number
  rotation: number
}

interface AutoLayoutResult {
  placements: AutoLayoutPlacement[]
  bounds: [number, number, number, number]
  efficiency: number
  unfitted_tool_ids: string[]
  unfitted_placement_ids?: string[]
  grid_x: number | null
}

type Selection =
  | { type: 'tool'; toolId: string }
  | { type: 'hole'; toolId: string; holeId: string }
  | { type: 'label'; labelId: string }
  | { type: 'pocket'; pocketId: string }
  | null

type DragState =
  | { type: 'tool'; toolId: string; startX: number; startY: number; origPoints: { x: number; y: number }[]; origHoles: { id: string; x: number; y: number }[]; origInteriorRings: { x: number; y: number }[][] }
  | { type: 'rotate'; toolId: string; centerX: number; centerY: number; startAngle: number; origRotation: number; origPoints: { x: number; y: number }[]; origHoles: { id: string; x: number; y: number }[]; origInteriorRings: { x: number; y: number }[][] }
  | { type: 'label'; labelId: string; startX: number; startY: number; origX: number; origY: number }
  | { type: 'rotate-label'; labelId: string; centerX: number; centerY: number; startAngle: number; origRotation: number }
  | { type: 'pocket'; pocketId: string; startX: number; startY: number; origX: number; origY: number }
  | { type: 'pocket-resize'; pocketId: string; corner: number; origPocket: AccessPocket }
  | { type: 'pocket-rotate'; pocketId: string; centerX: number; centerY: number; startAngle: number; origRotation: number }
  | { type: 'pocket-draw'; pocket: AccessPocket; startX: number; startY: number; clientX: number; clientY: number; pointerId: number }
  | null

function ArrangeProgress({ timeBudget }: { timeBudget: number }) {
  // ponytail: estimate from the submitted budget; no server step reporting.
  const [budget] = useState(timeBudget)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const startedAt = performance.now()
    const timer = setInterval(() => {
      const seconds = Math.min(budget, (performance.now() - startedAt) / 1000)
      setElapsed(seconds)
      if (seconds >= budget) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [budget])

  return (
    <div className="mt-3" aria-live="off">
      <progress
        aria-label="Estimated compute time elapsed"
        max={budget}
        value={elapsed}
        className="block h-1.5 w-full overflow-hidden rounded-full border-0 bg-glass-border appearance-none [&::-webkit-progress-bar]:bg-glass-border [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent"
      />
      <p className="mt-1.5 text-xs text-text-secondary tabular-nums">
        {elapsed < budget ? `Estimated: ~${Math.ceil(budget - elapsed)}s left` : 'Waiting for result…'}
      </p>
    </div>
  )
}

export function BinEditor({
  placedTools,
  onPlacedToolsChange,
  textLabels,
  onTextLabelsChange,
  accessPockets,
  onAccessPocketsChange,
  binChamfer = 0,
  gridX,
  gridY,
  partialBins,
  partialBinsValues,
  wallThickness,
  stackingLip,
  defaultCutoutDepth,
  maxCutoutDepth,
  depthMode,
  halfGridBase,
  cutoutClearance = 0,
  gridSizingMode = 'fixed',
  onAutoArrange,
  onEditTool,
  smoothedToolIds,
  onToggleSmoothed,
  smoothLevels,
  onSmoothLevelChange,
  onDraggingChange,
  historyRevision = 0,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [activeTool, setActiveTool] = useState<Tool>('select')
  const [dragging, setDragging] = useState<DragState>(null)
  const [pendingPocket, setPendingPocket] = useState<AccessPocket | null>(null)
  const suppressPocketClick = useRef(false)
  const [snapEnabled, setSnapEnabled] = useState(false)
  const [snapGrid, setSnapGrid] = useState(SNAP_GRID)
  const [arranging, setArranging] = useState(false)
  const [toolPadding, setToolPadding] = useState('1')
  const paddingDescriptionId = useId()
  const padding = Number(toolPadding)
  const paddingValid = toolPadding.trim() !== '' && Number.isFinite(padding) && padding >= 0
  const [arrangeAlgorithm, setArrangeAlgorithm] = useState('auto')
  const [computeTime, setComputeTime] = useState('5')
  const computeDescriptionId = useId()
  const advancedSettingsId = useId()
  const timeBudget = Number(computeTime)
  const computeTimeValid = computeTime.trim() !== '' && Number.isFinite(timeBudget) && timeBudget >= 0.5 && timeBudget <= 60
  const [arrangeError, setArrangeError] = useState<string | null>(null)
  const [arrangeWarning, setArrangeWarning] = useState<{
    names: string[]; gridX: number; gridY: number
  } | null>(null)
  const arrangePendingRef = useRef(false)
  const arrangeInputVersion = useRef(0)
  const arrangeAbortRef = useRef<AbortController | null>(null)
  const arrangeConfig = JSON.stringify([gridX, gridY, wallThickness, stackingLip, partialBins, partialBinsValues, halfGridBase, cutoutClearance, gridSizingMode, toolPadding, arrangeAlgorithm, computeTime])
  useEffect(() => {
    arrangeInputVersion.current += 1
    setArrangeError(null)
    return () => { arrangeInputVersion.current += 1 }
  }, [placedTools, textLabels, arrangeConfig, historyRevision])
  useEffect(() => {
    arrangeAbortRef.current?.abort()
    arrangeAbortRef.current = null
    arrangePendingRef.current = false
    setArranging(false)
    setArrangeWarning(null)
    setSelection(null)
    setPendingLabel(null)
    setEditingLabelId(null)
    setPendingPocket(null)
    setDragging(prev => prev?.type === 'pocket-draw' ? null : prev)
  }, [historyRevision])
  const [pendingLabel, setPendingLabel] = useState<{ x: number; y: number } | null>(null)
  const [pendingText, setPendingText] = useState('')
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const pendingInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const rafRef = useRef<number | null>(null)

  const toolsRef = useRef(placedTools)
  const onChangeRef = useRef(onPlacedToolsChange)
  const textLabelsRef = useRef(textLabels)
  const onTextLabelsChangeRef = useRef(onTextLabelsChange)
  const pocketsRef = useRef(accessPockets)
  const onPocketsChangeRef = useRef(onAccessPocketsChange)
  useEffect(() => { toolsRef.current = placedTools }, [placedTools])
  useEffect(() => { onChangeRef.current = onPlacedToolsChange }, [onPlacedToolsChange])
  useEffect(() => { textLabelsRef.current = textLabels }, [textLabels])
  useEffect(() => { onTextLabelsChangeRef.current = onTextLabelsChange }, [onTextLabelsChange])
  useEffect(() => { pocketsRef.current = accessPockets }, [accessPockets])
  useEffect(() => { onPocketsChangeRef.current = onAccessPocketsChange }, [onAccessPocketsChange])

  useEffect(() => { onDraggingChange?.(dragging !== null) }, [dragging, onDraggingChange])

  const binWidthMm = gridX * GRID_UNIT
  const hasPins = placedTools.some(tool => tool.pinned)
  const binHeightMm = gridY * GRID_UNIT
  const displayWidth = binWidthMm * DISPLAY_SCALE
  const displayHeight = binHeightMm * DISPLAY_SCALE

  const viewBoxShort = Math.min(displayWidth, displayHeight) + 30
  const handleR = Math.max(14, Math.min(28, viewBoxShort * 0.04))
  const handleOffset = handleR * 2.5
  const handleStroke = Math.max(1.5, handleR * 0.1)

  const getAllBounds = useCallback(() => {
    if (placedTools.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const tool of placedTools) {
      for (const p of tool.points) {
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x)
        maxY = Math.max(maxY, p.y)
      }
    }
    return { minX, minY, maxX, maxY }
  }, [placedTools])

  const handleRecenter = useCallback(() => {
    if (hasPins) return
    arrangeInputVersion.current += 1
    const bounds = getAllBounds()
    const targetCenterX = binWidthMm / 2
    const targetCenterY = binHeightMm / 2
    const currentCenterX = (bounds.minX + bounds.maxX) / 2
    const currentCenterY = (bounds.minY + bounds.maxY) / 2
    const dx = targetCenterX - currentCenterX
    const dy = targetCenterY - currentCenterY

    const updated = placedTools.map(tool => ({
      ...tool,
      points: tool.points.map(p => ({ x: p.x + dx, y: p.y + dy })),
      finger_holes: tool.finger_holes.map(fh => ({ ...fh, x: fh.x + dx, y: fh.y + dy })),
      interior_rings: (tool.interior_rings ?? []).map(ring =>
        ring.map(p => ({ x: p.x + dx, y: p.y + dy }))
      ),
    }))
    onPlacedToolsChange(updated, 'Recenter tools')
  }, [hasPins, getAllBounds, binWidthMm, binHeightMm, placedTools, onPlacedToolsChange])

  const handleAutoArrange = useCallback(async () => {
    if (placedTools.length === 0 || dragging || arrangePendingRef.current || !paddingValid || !computeTimeValid) return
    arrangePendingRef.current = true
    const controller = new AbortController()
    arrangeAbortRef.current = controller
    const inputVersion = arrangeInputVersion.current
    setArranging(true)
    setArrangeError(null)
    setArrangeWarning(null)
    try {
      const res = await fetch('/api/bins/auto-layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify({
          tool_ids: placedTools.map(t => t.tool_id),
          placement_ids: placedTools.map(t => t.id),
          fixed_placements: placedTools.filter(tool => tool.pinned).map(tool => ({
            tool_id: tool.tool_id,
            placement_id: tool.id,
            x: Math.min(...tool.points.map(point => point.x)),
            y: Math.min(...tool.points.map(point => point.y)),
            rotation: tool.rotation || 0,
          })),
          clearance: padding,
          algorithm: arrangeAlgorithm,
          time_budget_seconds: timeBudget,
          auto_width: gridSizingMode === 'fixed_depth',
          // The backend derives the usable interior from these geometry settings.
          bin_config: {
            grid_x: gridX, grid_y: gridY, wall_thickness: wallThickness,
            stacking_lip: stackingLip, half_grid_base: halfGridBase,
            cutout_clearance: cutoutClearance,
          },
        }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        throw new Error(detail?.detail || 'Auto-arrange failed')
      }
      const data: AutoLayoutResult = await res.json()
      if (inputVersion !== arrangeInputVersion.current) return
      const placements = new Map(data.placements.filter(p => p.placement_id !== undefined).map(p => [p.placement_id, p]))
      const legacyPlacements = new Map(data.placements.filter(p => p.placement_id === undefined).map(p => [p.tool_id, p]))

      const updated = placedTools.map(tool => {
        if (tool.pinned) return tool
        const placement = placements.get(tool.id) ?? legacyPlacements.get(tool.tool_id)
        if (!placement || tool.points.length === 0) return tool

        // rotate about the tool centre to the placement's absolute rotation
        const delta = (placement.rotation - (tool.rotation || 0)) * (Math.PI / 180)
        const cos = Math.cos(delta)
        const sin = Math.sin(delta)
        const cx = tool.points.reduce((sum, p) => sum + p.x, 0) / tool.points.length
        const cy = tool.points.reduce((sum, p) => sum + p.y, 0) / tool.points.length
        const rotate = (p: { x: number; y: number }) => {
          const dx = p.x - cx
          const dy = p.y - cy
          return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
        }
        const points = tool.points.map(rotate)

        // the API position is the rotated polygon's minimum corner
        let minX = Infinity
        let minY = Infinity
        for (const p of points) {
          minX = Math.min(minX, p.x)
          minY = Math.min(minY, p.y)
        }
        const shiftX = placement.x - minX
        const shiftY = placement.y - minY

        return {
          ...tool,
          rotation: placement.rotation,
          points: points.map(p => ({ x: p.x + shiftX, y: p.y + shiftY })),
          finger_holes: tool.finger_holes.map(fh => {
            const p = rotate(fh)
            return { ...fh, x: p.x + shiftX, y: p.y + shiftY }
          }),
          interior_rings: (tool.interior_rings ?? []).map(ring => {
            const rotated = ring.map(rotate)
            return rotated.map(p => ({ x: p.x + shiftX, y: p.y + shiftY }))
          }),
        }
      })
      const computedWidth = gridSizingMode === 'fixed_depth' ? data.grid_x : null
      if (onAutoArrange) onAutoArrange(updated, computedWidth)
      else onPlacedToolsChange(updated, 'Auto-arrange tools')
      const unfitted = new Set(data.unfitted_placement_ids ?? data.unfitted_tool_ids)
      if (unfitted.size > 0) {
        setArrangeWarning({
          names: placedTools.filter(tool => unfitted.has(data.unfitted_placement_ids !== undefined ? tool.id : tool.tool_id)).map(tool => tool.name),
          gridX: computedWidth ?? gridX,
          gridY,
        })
      }
    } catch (err) {
      if (!controller.signal.aborted && inputVersion === arrangeInputVersion.current) {
        setArrangeError(err instanceof Error ? err.message : 'Auto-arrange failed')
      }
    } finally {
      if (arrangeAbortRef.current === controller) {
        arrangeAbortRef.current = null
        arrangePendingRef.current = false
        setArranging(false)
      }
    }
  }, [placedTools, dragging, onPlacedToolsChange, onAutoArrange, gridX, gridY, wallThickness, stackingLip, halfGridBase, cutoutClearance, gridSizingMode, padding, paddingValid, arrangeAlgorithm, timeBudget, computeTimeValid])

  const screenToMm = useCallback((clientX: number, clientY: number) => {
    if (!svgRef.current) return { x: 0, y: 0 }
    const rect = svgRef.current.getBoundingClientRect()
    const viewBoxWidth = displayWidth + 70
    const viewBoxHeight = displayHeight + 30
    const scaleX = viewBoxWidth / rect.width
    const scaleY = viewBoxHeight / rect.height
    const scale = Math.max(scaleX, scaleY)
    const offsetX = (rect.width * scale - viewBoxWidth) / 2
    const offsetY = (rect.height * scale - viewBoxHeight) / 2
    const svgX = (clientX - rect.left) * scale - offsetX - 10
    const svgY = (clientY - rect.top) * scale - offsetY - 10
    return { x: svgX / DISPLAY_SCALE, y: svgY / DISPLAY_SCALE }
  }, [displayWidth, displayHeight])

  const snapToGrid = useCallback((v: number) => {
    if (!snapEnabled) return v
    return snapToGridUtil(v, snapGrid)
  }, [snapEnabled, snapGrid])

  const handleToolMouseDown = (toolId: string) => (e: React.MouseEvent) => {
    if (activeTool !== 'select') return
    e.stopPropagation()
    const tool = placedTools.find(t => t.id === toolId)
    if (!tool) return

    arrangeInputVersion.current += 1
    setSelection({ type: 'tool', toolId })
    const pos = screenToMm(e.clientX, e.clientY)
    setDragging({
      type: 'tool',
      toolId,
      startX: pos.x,
      startY: pos.y,
      origPoints: tool.points.map(p => ({ x: p.x, y: p.y })),
      origHoles: tool.finger_holes.map(fh => ({ id: fh.id, x: fh.x, y: fh.y })),
      origInteriorRings: (tool.interior_rings ?? []).map(ring => ring.map(p => ({ x: p.x, y: p.y }))),
    })
  }

  const stopClick = (e: React.MouseEvent) => e.stopPropagation()
  const stopClickUnlessText = (e: React.MouseEvent) => { if (activeTool === 'select') e.stopPropagation() }

  const handleRotateMouseDown = (toolId: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    const tool = placedTools.find(t => t.id === toolId)
    if (!tool) return
    arrangeInputVersion.current += 1

    const pos = screenToMm(e.clientX, e.clientY)
    const centerX = tool.points.reduce((sum, p) => sum + p.x, 0) / tool.points.length
    const centerY = tool.points.reduce((sum, p) => sum + p.y, 0) / tool.points.length
    const startAngle = Math.atan2(pos.y - centerY, pos.x - centerX)

    setDragging({
      type: 'rotate', toolId,
      centerX, centerY, startAngle,
      origRotation: tool.rotation || 0,
      origPoints: tool.points.map(p => ({ x: p.x, y: p.y })),
      origHoles: tool.finger_holes.map(fh => ({ id: fh.id, x: fh.x, y: fh.y })),
      origInteriorRings: (tool.interior_rings ?? []).map(ring => ring.map(p => ({ x: p.x, y: p.y }))),
    })
  }

  const handleLabelMouseDown = (labelId: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    const label = textLabels.find(l => l.id === labelId)
    if (!label) return

    setSelection({ type: 'label', labelId })
    const pos = screenToMm(e.clientX, e.clientY)
    setDragging({
      type: 'label', labelId,
      startX: pos.x, startY: pos.y,
      origX: label.x, origY: label.y,
    })
  }

  const handleLabelRotateMouseDown = (labelId: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    const label = textLabels.find(l => l.id === labelId)
    if (!label) return

    const pos = screenToMm(e.clientX, e.clientY)
    const startAngle = Math.atan2(pos.y - label.y, pos.x - label.x)
    setDragging({
      type: 'rotate-label', labelId,
      centerX: label.x, centerY: label.y,
      startAngle, origRotation: label.rotation,
    })
  }

  const handleLabelDoubleClick = (labelId: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    const label = textLabels.find(l => l.id === labelId)
    if (!label) return
    setEditingLabelId(labelId)
    setEditingText(label.text)
    setSelection({ type: 'label', labelId })
  }

  const commitEditingLabel = useCallback(() => {
    if (!editingLabelId) return
    const trimmed = editingText.trim()
    if (trimmed) {
      onTextLabelsChange(textLabels.map(l =>
        l.id === editingLabelId ? { ...l, text: trimmed } : l
      ), 'Edit label text')
    } else {
      onTextLabelsChange(textLabels.filter(l => l.id !== editingLabelId), 'Remove label')
      setSelection(null)
    }
    setEditingLabelId(null)
    setEditingText('')
  }, [editingLabelId, editingText, textLabels, onTextLabelsChange])

  useEffect(() => {
    if (editingLabelId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingLabelId])

  const pointInRing = useCallback((px: number, py: number, ring: { x: number; y: number }[]) => {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].x, yi = ring[i].y
      const xj = ring[j].x, yj = ring[j].y
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
        inside = !inside
      }
    }
    return inside
  }, [])

  const isInsideCutout = useCallback((px: number, py: number) => {
    for (const tool of toolsRef.current) {
      if (!pointInRing(px, py, tool.points)) continue
      let inIsland = false
      for (const ring of (tool.interior_rings ?? [])) {
        if (pointInRing(px, py, ring)) { inIsland = true; break }
      }
      if (!inIsland) return true
    }
    return false
  }, [pointInRing])

  const drawnPocket = useCallback((drag: Extract<DragState, { type: 'pocket-draw' }>, clientX: number, clientY: number) => {
    if (Math.hypot(clientX - drag.clientX, clientY - drag.clientY) < 3) return drag.pocket
    const pos = screenToMm(clientX, clientY)
    const x = Math.max(0, Math.min(binWidthMm, snapToGrid(pos.x)))
    const y = Math.max(0, Math.min(binHeightMm, snapToGrid(pos.y)))
    return clampPocket({
      ...drag.pocket,
      x: (drag.startX + x) / 2, y: (drag.startY + y) / 2,
      length: Math.abs(x - drag.startX), width: Math.abs(y - drag.startY),
    }, maxCutoutDepth)
  }, [screenToMm, snapToGrid, binWidthMm, binHeightMm, maxCutoutDepth])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging) return
    if (dragging.type === 'pocket-draw' && 'pointerId' in e && e.pointerId !== dragging.pointerId) return
    arrangeInputVersion.current += 1
    const clientX = e.clientX
    const clientY = e.clientY

    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const pos = screenToMm(clientX, clientY)
      const currentTools = toolsRef.current
      const onChange = onChangeRef.current
      const currentLabels = textLabelsRef.current
      const onLabelsChange = onTextLabelsChangeRef.current
      const currentPockets = pocketsRef.current
      const onPocketsChange = onPocketsChangeRef.current

      if (dragging.type === 'pocket-draw') {
        setPendingPocket(drawnPocket(dragging, clientX, clientY))
      } else if (dragging.type === 'tool') {
        const origCenterX = dragging.origPoints.reduce((sum, p) => sum + p.x, 0) / dragging.origPoints.length
        const origCenterY = dragging.origPoints.reduce((sum, p) => sum + p.y, 0) / dragging.origPoints.length
        const rawDx = pos.x - dragging.startX
        const rawDy = pos.y - dragging.startY
        const newCenterX = snapToGrid(origCenterX + rawDx)
        const newCenterY = snapToGrid(origCenterY + rawDy)
        const dx = newCenterX - origCenterX
        const dy = newCenterY - origCenterY
        const updated = currentTools.map(tool => {
          if (tool.id !== dragging.toolId) return tool
          return {
            ...tool,
            points: dragging.origPoints.map(p => ({ x: p.x + dx, y: p.y + dy })),
            finger_holes: tool.finger_holes.map(fh => {
              const orig = dragging.origHoles.find(h => h.id === fh.id)
              if (!orig) return fh
              return { ...fh, x: orig.x + dx, y: orig.y + dy }
            }),
            interior_rings: dragging.origInteriorRings.map(ring =>
              ring.map(p => ({ x: p.x + dx, y: p.y + dy }))
            ),
          }
        })
        onChange(updated, 'Move tool')
      } else if (dragging.type === 'rotate') {
        const currentAngle = Math.atan2(pos.y - dragging.centerY, pos.x - dragging.centerX)
        const deltaAngle = currentAngle - dragging.startAngle
        const cos = Math.cos(deltaAngle)
        const sin = Math.sin(deltaAngle)
        const cx = dragging.centerX
        const cy = dragging.centerY

        const deltaDeg = deltaAngle * (180 / Math.PI)
        const updated = currentTools.map(tool => {
          if (tool.id !== dragging.toolId) return tool
          return {
            ...tool,
            rotation: (dragging.origRotation + deltaDeg) % 360,
            points: dragging.origPoints.map(p => {
              const pdx = p.x - cx
              const pdy = p.y - cy
              return { x: cx + pdx * cos - pdy * sin, y: cy + pdx * sin + pdy * cos }
            }),
            finger_holes: tool.finger_holes.map(fh => {
              const orig = dragging.origHoles.find(h => h.id === fh.id)
              if (!orig) return fh
              const fdx = orig.x - cx
              const fdy = orig.y - cy
              return { ...fh, x: cx + fdx * cos - fdy * sin, y: cy + fdx * sin + fdy * cos }
            }),
            interior_rings: dragging.origInteriorRings.map(ring =>
              ring.map(p => {
                const pdx = p.x - cx
                const pdy = p.y - cy
                return { x: cx + pdx * cos - pdy * sin, y: cy + pdx * sin + pdy * cos }
              })
            ),
          }
        })
        onChange(updated, 'Rotate tool')
      } else if (dragging.type === 'label') {
        const dx = pos.x - dragging.startX
        const dy = pos.y - dragging.startY
        const newX = snapToGrid(dragging.origX + dx)
        const newY = snapToGrid(dragging.origY + dy)
        // prevent straddling: label must stay in the same zone it started in
        const wasInCutout = isInsideCutout(dragging.origX, dragging.origY)
        const nowInCutout = isInsideCutout(newX, newY)
        if (wasInCutout !== nowInCutout) return
        const updated = currentLabels.map(l => {
          if (l.id !== dragging.labelId) return l
          return { ...l, x: newX, y: newY }
        })
        onLabelsChange(updated, 'Move label')
      } else if (dragging.type === 'rotate-label') {
        const currentAngle = Math.atan2(pos.y - dragging.centerY, pos.x - dragging.centerX)
        const deltaAngle = (currentAngle - dragging.startAngle) * (180 / Math.PI)
        const updated = currentLabels.map(l => {
          if (l.id !== dragging.labelId) return l
          return { ...l, rotation: (dragging.origRotation + deltaAngle) % 360 }
        })
        onLabelsChange(updated, 'Rotate label')
      } else if (dragging.type === 'pocket') {
        const newX = snapToGrid(dragging.origX + (pos.x - dragging.startX))
        const newY = snapToGrid(dragging.origY + (pos.y - dragging.startY))
        onPocketsChange(
          currentPockets.map(p => p.id === dragging.pocketId ? { ...p, x: newX, y: newY } : p),
          'Move pocket',
        )
      } else if (dragging.type === 'pocket-resize') {
        onPocketsChange(
          currentPockets.map(p => p.id === dragging.pocketId
            ? clampPocket(resizePocketFromCorner(dragging.origPocket, dragging.corner, pos.x, pos.y), maxCutoutDepth)
            : p),
          'Resize pocket',
        )
      } else if (dragging.type === 'pocket-rotate') {
        const currentAngle = Math.atan2(pos.y - dragging.centerY, pos.x - dragging.centerX)
        const deltaAngle = (currentAngle - dragging.startAngle) * (180 / Math.PI)
        onPocketsChange(
          currentPockets.map(p => p.id === dragging.pocketId
            ? { ...p, rotation: (dragging.origRotation + deltaAngle) % 360 }
            : p),
          'Rotate pocket',
        )
      }
    })
  }, [dragging, screenToMm, snapToGrid, isInsideCutout, maxCutoutDepth, drawnPocket])

  const handleMouseUp = useCallback((e: MouseEvent) => {
    if (dragging?.type === 'pocket-draw' && 'pointerId' in e && e.pointerId !== dragging.pointerId) return
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (dragging?.type === 'pocket-draw') {
      const pocket = drawnPocket(dragging, e.clientX, e.clientY)
      onPocketsChangeRef.current([...pocketsRef.current, pocket], 'Add pocket')
      setPendingPocket(null)
      setSelection({ type: 'pocket', pocketId: pocket.id })
      setActiveTool('select')
    }
    setDragging(null)
  }, [dragging, drawnPocket])

  useEffect(() => {
    if (!dragging) return
    if (dragging.type === 'pocket-draw') {
      const cancel = (event?: PointerEvent) => {
        if (event && event.pointerId !== dragging.pointerId) return
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = null
        setPendingPocket(null)
        setDragging(null)
      }
      const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel() }
      window.addEventListener('pointermove', handleMouseMove)
      window.addEventListener('pointerup', handleMouseUp)
      window.addEventListener('pointercancel', cancel)
      window.addEventListener('keydown', onKeyDown)
      return () => {
        window.removeEventListener('pointermove', handleMouseMove)
        window.removeEventListener('pointerup', handleMouseUp)
        window.removeEventListener('pointercancel', cancel)
        window.removeEventListener('keydown', onKeyDown)
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragging, handleMouseMove, handleMouseUp])

  const handleDeleteTool = () => {
    if (selection?.type !== 'tool') return
    onPlacedToolsChange(placedTools.filter(t => t.id !== selection.toolId), 'Remove tool')
    setSelection(null)
  }

  const handleDeleteLabel = () => {
    if (selection?.type !== 'label') return
    onTextLabelsChange(textLabels.filter(l => l.id !== selection.labelId), 'Remove label')
    setSelection(null)
  }

  const commitPendingLabel = useCallback(() => {
    if (!pendingLabel || !pendingText.trim()) {
      setPendingLabel(null)
      setPendingText('')
      return
    }
    const newLabel: TextLabel = {
      id: `tl-${Date.now()}`,
      text: pendingText.trim(),
      x: pendingLabel.x,
      y: pendingLabel.y,
      font_size: 5,
      rotation: 0,
      emboss: true,
      depth: 0.5,
    }
    onTextLabelsChange([...textLabels, newLabel], 'Add label')
    setSelection({ type: 'label', labelId: newLabel.id })
    setPendingLabel(null)
    setPendingText('')
  }, [pendingLabel, pendingText, textLabels, onTextLabelsChange])

  const handleBackgroundPointerDown = (e: React.PointerEvent) => {
    suppressPocketClick.current = false
    if (activeTool !== 'pocket' || e.button !== 0 || e.isPrimary === false || dragging) return
    const pos = screenToMm(e.clientX, e.clientY)
    if (pos.x < 0 || pos.x > binWidthMm || pos.y < 0 || pos.y > binHeightMm) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const x = Math.max(0, Math.min(binWidthMm, snapToGrid(pos.x)))
    const y = Math.max(0, Math.min(binHeightMm, snapToGrid(pos.y)))
    const pocket = clampPocket(defaultPocket('rectangle', x, y), maxCutoutDepth)
    suppressPocketClick.current = true
    setSelection(null)
    setPendingPocket(pocket)
    setDragging({ type: 'pocket-draw', pocket, startX: x, startY: y, clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId })
  }

  const handleBackgroundClick = (e: React.MouseEvent) => {
    if (suppressPocketClick.current) {
      suppressPocketClick.current = false
      return
    }
    if (activeTool === 'text') {
      if (pendingLabel) {
        commitPendingLabel()
        return
      }
      const pos = screenToMm(e.clientX, e.clientY)
      if (pos.x >= 0 && pos.x <= binWidthMm && pos.y >= 0 && pos.y <= binHeightMm) {
        setPendingLabel({ x: snapToGrid(pos.x), y: snapToGrid(pos.y) })
        setPendingText('')
      }
      return
    }

    if (activeTool === 'pocket') {
      const pos = screenToMm(e.clientX, e.clientY)
      if (pos.x >= 0 && pos.x <= binWidthMm && pos.y >= 0 && pos.y <= binHeightMm) {
        const pocket = clampPocket(defaultPocket('rectangle', snapToGrid(pos.x), snapToGrid(pos.y)), maxCutoutDepth)
        onAccessPocketsChange([...accessPockets, pocket], 'Add pocket')
        setSelection({ type: 'pocket', pocketId: pocket.id })
        setActiveTool('select')
      }
      return
    }

    setSelection(null)
  }

  useEffect(() => {
    if (pendingLabel && pendingInputRef.current) {
      pendingInputRef.current.focus()
    }
  }, [pendingLabel])

  const selectedLabel = selection?.type === 'label'
    ? textLabels.find(l => l.id === selection.labelId)
    : null

  const selectedTool = selection?.type === 'tool'
    ? placedTools.find(t => t.id === selection.toolId)
    : null

  const selectedHole = selection?.type === 'hole'
    ? placedTools
        .find(t => t.id === selection.toolId)
        ?.finger_holes.find(fh => fh.id === selection.holeId)
    : null

  const selectedPocket = selection?.type === 'pocket'
    ? accessPockets.find(p => p.id === selection.pocketId) ?? null
    : null

  const updateSelectedLabel = (updates: Partial<TextLabel>) => {
    if (selection?.type !== 'label') return
    onTextLabelsChange(textLabels.map(l => {
      if (l.id !== selection.labelId) return l
      return { ...l, ...updates }
    }), 'Change label settings')
  }

  const setCutoutDepthOverride = (toolId: string, depth: number | null) => {
    onPlacedToolsChange(placedTools.map(t =>
      t.id === toolId ? {
        ...t,
        depth_override: depth,
        // typing a depth in an automatic bin pins that tool to its own value;
        // clearing it hands the tool back to the derived depth
        ...(depthMode === 'automatic' ? { depth_mode: depth == null ? null : 'custom' as const } : {}),
      } : t
    ), 'Change cutout depth')
  }

  const setDepthMode = (toolId: string, mode: 'automatic' | 'custom') => {
    // the stored override is kept either way, so switching back restores it
    onPlacedToolsChange(placedTools.map(t =>
      t.id === toolId ? { ...t, depth_mode: mode } : t
    ), 'Change cutout depth mode')
  }

  const setHoleDepthOverride = (toolId: string, holeId: string, depth: number | null) => {
    onPlacedToolsChange(placedTools.map(t => {
      if (t.id !== toolId) return t
      return {
        ...t,
        finger_holes: t.finger_holes.map(fh =>
          fh.id === holeId ? { ...fh, depth_override: depth } : fh
        ),
      }
    }), 'Change finger-hole depth')
  }

  const handleHoleClick = (toolId: string, holeId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelection({ type: 'hole', toolId, holeId })
  }

  const updateSelectedPocket = (updates: Partial<AccessPocket>, label = 'Change pocket') => {
    if (selection?.type !== 'pocket') return
    onAccessPocketsChange(
      accessPockets.map(pocket =>
        pocket.id === selection.pocketId ? clampPocket({ ...pocket, ...updates }, maxCutoutDepth) : pocket
      ),
      label,
    )
  }

  const handlePocketClick = (pocketId: string, e: React.MouseEvent) => {
    if (activeTool !== 'select') return
    e.stopPropagation()
    setSelection({ type: 'pocket', pocketId })
  }

  const handlePocketMouseDown = (pocketId: string) => (e: React.MouseEvent) => {
    if (activeTool !== 'select') return
    e.stopPropagation()
    const pocket = accessPockets.find(p => p.id === pocketId)
    if (!pocket) return
    arrangeInputVersion.current += 1
    setSelection({ type: 'pocket', pocketId })
    const pos = screenToMm(e.clientX, e.clientY)
    setDragging({ type: 'pocket', pocketId, startX: pos.x, startY: pos.y, origX: pocket.x, origY: pocket.y })
  }

  const handlePocketResizeMouseDown = (pocketId: string, corner: number) => (e: React.MouseEvent) => {
    e.stopPropagation()
    const pocket = accessPockets.find(p => p.id === pocketId)
    if (!pocket) return
    setSelection({ type: 'pocket', pocketId })
    setDragging({ type: 'pocket-resize', pocketId, corner, origPocket: { ...pocket } })
  }

  const handlePocketRotateMouseDown = (pocketId: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    const pocket = accessPockets.find(p => p.id === pocketId)
    if (!pocket) return
    const pos = screenToMm(e.clientX, e.clientY)
    const startAngle = Math.atan2(pos.y - pocket.y, pos.x - pocket.x)
    setSelection({ type: 'pocket', pocketId })
    setDragging({
      type: 'pocket-rotate', pocketId,
      centerX: pocket.x, centerY: pocket.y, startAngle, origRotation: pocket.rotation,
    })
  }

  const handleDuplicatePocket = () => {
    if (selection?.type !== 'pocket') return
    const pocket = accessPockets.find(p => p.id === selection.pocketId)
    if (!pocket) return
    const copy = { ...pocket, id: `${pocket.id}-copy-${Date.now().toString(36)}`, x: pocket.x + 6, y: pocket.y + 6 }
    onAccessPocketsChange([...accessPockets, copy], 'Duplicate pocket')
    setSelection({ type: 'pocket', pocketId: copy.id })
  }

  const handleDeletePocket = () => {
    if (selection?.type !== 'pocket') return
    onAccessPocketsChange(accessPockets.filter(p => p.id !== selection.pocketId), 'Remove pocket')
    setSelection(null)
  }

  const handleEditingLabelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEditingLabel()
    if (e.key === 'Escape') { setEditingLabelId(null); setEditingText('') }
  }

  const handlePendingLabelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitPendingLabel()
    if (e.key === 'Escape') { setPendingLabel(null); setPendingText('') }
  }

  return (
    <div className="h-full w-full relative">
      {/* floating toolbar */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 glass-toolbar px-1.5 py-1 flex flex-wrap justify-center items-center gap-0.5 gap-y-1.5 w-max max-w-[calc(100%-1.5rem)]">
        <BinEditorToolbar
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          snapEnabled={snapEnabled}
          setSnapEnabled={setSnapEnabled}
          snapGrid={snapGrid}
          setSnapGrid={setSnapGrid}
          handleRecenter={handleRecenter}
          recenterDisabled={hasPins}
          selectedTool={selectedTool ?? null}
          selectedLabel={selectedLabel ?? null}
          selectedHole={selectedHole ?? null}
          selectedHoleToolId={selection?.type === 'hole' ? selection.toolId : null}
          onEditTool={onEditTool}
          onRemoveTool={handleDeleteTool}
          onTogglePinned={() => {
            if (!selectedTool) return
            arrangeInputVersion.current += 1
            onPlacedToolsChange(placedTools.map(tool =>
              tool.id === selectedTool.id ? { ...tool, pinned: !tool.pinned } : tool
            ), selectedTool.pinned ? 'Unpin tool' : 'Pin tool')
          }}
          onRemoveLabel={handleDeleteLabel}
          smoothedToolIds={smoothedToolIds}
          smoothLevels={smoothLevels}
          onToggleSmoothed={onToggleSmoothed}
          onSmoothLevelChange={onSmoothLevelChange}
          onUpdateLabel={updateSelectedLabel}
          defaultCutoutDepth={defaultCutoutDepth}
          maxCutoutDepth={maxCutoutDepth}
          onSetCutoutDepthOverride={setCutoutDepthOverride}
          onSetHoleDepthOverride={setHoleDepthOverride}
          binDepthMode={depthMode}
          onSetDepthMode={setDepthMode}
        />
        {placedTools.length > 0 && (
          <>
            <div className="w-px h-4 bg-glass-border mx-1 flex-shrink-0" />
            <label className="flex items-center gap-1.5 px-2 text-[11px] text-text-secondary whitespace-nowrap">
              Tool padding (mm)
              <input
                type="number"
                min={0}
                step="any"
                required
                value={toolPadding}
                onChange={event => setToolPadding(event.target.value)}
                aria-invalid={!paddingValid}
                aria-describedby={paddingDescriptionId}
                className="w-16 min-w-0 rounded border border-glass-border bg-surface px-1.5 py-1 text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
              />
            </label>
            <button
              onClick={handleAutoArrange}
              disabled={arranging || dragging !== null || !paddingValid || !computeTimeValid}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap text-text-muted hover:text-text-secondary hover:bg-[rgba(255,255,255,0.03)] disabled:text-text-primary disabled:cursor-wait disabled:hover:bg-transparent"
              title="Pack the placed tools into an efficient layout"
            >
              {arranging
                ? <LoaderCircle aria-hidden="true" className="w-3.5 h-3.5 motion-safe:animate-spin" />
                : <LayoutGrid aria-hidden="true" className="w-3.5 h-3.5" />}
              {arranging ? 'Arranging…' : 'Auto-arrange'}
            </button>
            <button
              type="button"
              popoverTarget={advancedSettingsId}
              className="px-2.5 py-1.5 rounded-[7px] text-[11px] font-medium text-text-secondary hover:bg-[rgba(255,255,255,0.03)] cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
            >
              Advanced
            </button>
            <div
              id={advancedSettingsId}
              popover="auto"
              role="group"
              aria-label="Advanced auto-arrange settings"
              className="fixed top-3 bottom-auto left-1/2 right-auto -translate-x-1/2 m-0 w-[min(32rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-xl border border-glass-border bg-surface p-3 text-[11px] text-text-secondary shadow-lg"
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="font-medium text-text-primary">Auto-arrange settings</p>
                <button
                  type="button"
                  popoverTarget={advancedSettingsId}
                  popoverTargetAction="hide"
                  aria-label="Close advanced auto-arrange settings"
                  className="rounded px-2 py-1 text-text-secondary hover:bg-[rgba(255,255,255,0.03)] cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Close
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex flex-wrap items-center gap-1.5 max-w-full">
                  Algorithm
                  <select
                    value={arrangeAlgorithm}
                    onChange={event => setArrangeAlgorithm(event.target.value)}
                    className="min-w-0 shrink-0 max-w-full rounded border border-glass-border bg-surface px-1.5 py-1 text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <option value="auto">Automatic</option>
                    <option value="raster">Raster</option>
                    <option value="packingsolver">PackingSolver</option>
                  </select>
                </label>
                <label className="flex flex-wrap items-center gap-1.5 max-w-full">
                  Compute time (seconds)
                  <input
                    type="number"
                    min={0.5}
                    max={60}
                    step="any"
                    required
                    value={computeTime}
                    onChange={event => setComputeTime(event.target.value)}
                    aria-invalid={!computeTimeValid}
                    aria-describedby={computeDescriptionId}
                    className="w-16 min-w-0 shrink-0 rounded border border-glass-border bg-surface px-1.5 py-1 text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </label>
                <p id={computeDescriptionId} className="basis-full text-xs text-text-primary" role={computeTimeValid ? undefined : 'alert'}>
                  {computeTimeValid
                    ? '0.5–60 seconds total. More time can help, but does not guarantee a better fit.'
                    : 'Enter a finite compute time from 0.5 to 60 seconds.'}
                </p>
              </div>
            </div>
            <p id={paddingDescriptionId} className={paddingValid ? 'sr-only' : 'basis-full px-2 py-1 text-xs text-text-primary'} role={paddingValid ? undefined : 'alert'}>
              {paddingValid
                ? 'Minimum edge-to-edge gap between tool outlines, separate from cutout fit clearance.'
                : 'Enter a finite number of 0 or more for tool padding in millimetres.'}
            </p>
          </>
        )}
      </div>
      {(arranging || arrangeError || arrangeWarning) && (
        <div className="fixed bottom-3 left-3 right-3 sm:absolute sm:top-24 sm:bottom-auto z-30 sm:z-20 flex justify-center pointer-events-none">
          {arranging ? (
            <div role="status" className="flex items-start gap-2 sm:gap-3 rounded-xl border border-glass-border bg-surface px-3 sm:px-4 py-3 shadow-lg w-full max-w-md text-text-primary">
              <LoaderCircle aria-hidden="true" className="w-5 h-5 shrink-0 text-accent motion-safe:animate-spin" />
              <div className="min-w-0 flex-1 break-words">
                <p className="text-sm font-medium">Arranging tools…</p>
                <p className="text-xs text-text-secondary mt-1">Finding an efficient layout for {placedTools.length} {placedTools.length === 1 ? 'tool' : 'tools'}.</p>
                <ArrangeProgress timeBudget={timeBudget} />
              </div>
            </div>
          ) : arrangeError ? (
            <div role="alert" className="rounded-xl border border-glass-border bg-surface px-4 py-3 shadow-lg max-w-md text-sm text-text-primary">
              <p className="font-medium">Auto-arrange failed</p>
              <p className="text-xs text-text-secondary mt-1">{arrangeError}. Your layout was kept. Try again.</p>
            </div>
          ) : arrangeWarning && (
            <div role="status" className="flex items-start gap-3 rounded-xl border border-glass-border bg-surface px-4 py-3 shadow-lg max-w-md text-text-primary">
              <AlertTriangle aria-hidden="true" className="w-5 h-5 shrink-0 text-accent" />
              <div>
                <p className="text-sm font-medium">Last auto-arrange: no fitting layout found for the requested {arrangeWarning.gridX} × {arrangeWarning.gridY} grid</p>
                <p className="text-xs text-text-secondary mt-1">{arrangeWarning.names.length} {arrangeWarning.names.length === 1 ? 'tool did' : 'tools did'} not fit in that run: {arrangeWarning.names.join(', ')}.</p>
                <p className="text-xs text-text-secondary mt-1">The arrangement was applied. Increase the grid size or remove tools, then auto-arrange again to check the current grid.</p>
                <button type="button" onClick={() => setArrangeWarning(null)} className="pointer-events-auto mt-2 text-xs font-medium text-text-primary underline underline-offset-2 cursor-pointer">Dismiss</button>
              </div>
            </div>
          )}
        </div>
      )}
      {selectedPocket && (
        <div className="absolute top-3 right-3 z-20 max-h-[calc(100%-1.5rem)] overflow-y-auto">
          <AccessPocketControls
            pocket={selectedPocket}
            binChamfer={binChamfer}
            maxDepth={maxCutoutDepth}
            onChange={updateSelectedPocket}
            onDuplicate={handleDuplicatePocket}
            onDelete={handleDeletePocket}
          />
        </div>
      )}
      <BinEditorCanvas
        svgRef={svgRef}
        displayWidth={displayWidth}
        displayHeight={displayHeight}
        gridX={gridX}
        gridY={gridY}
        partialBins={partialBins}
        partialBinsValues={partialBinsValues}
        wallThickness={wallThickness}
        placedTools={placedTools}
        selection={selection}
        onHoleClick={handleHoleClick}
        textLabels={textLabels}
        editingLabelId={editingLabelId}
        editingText={editingText}
        pendingLabel={pendingLabel}
        pendingLabelText={pendingText}
        smoothedToolIds={smoothedToolIds}
        smoothLevels={smoothLevels}
        activeTool={activeTool}
        binWidthMm={binWidthMm}
        binHeightMm={binHeightMm}
        defaultCutoutDepth={defaultCutoutDepth}
        halfGridBase={halfGridBase}
        accessPockets={accessPockets}
        pendingPocket={pendingPocket}
        binChamfer={binChamfer}
        pocketMaxDepth={maxCutoutDepth}
        onPocketMouseDown={handlePocketMouseDown}
        onPocketRotateMouseDown={handlePocketRotateMouseDown}
        onPocketResizeMouseDown={handlePocketResizeMouseDown}
        onPocketClick={handlePocketClick}
        handleR={handleR}
        handleStroke={handleStroke}
        handleOffset={handleOffset}
        pendingInputRef={pendingInputRef}
        editInputRef={editInputRef}
        handleToolMouseDown={handleToolMouseDown}
        handleRotateMouseDown={handleRotateMouseDown}
        handleLabelMouseDown={handleLabelMouseDown}
        handleLabelRotateMouseDown={handleLabelRotateMouseDown}
        handleLabelDoubleClick={handleLabelDoubleClick}
        handleBackgroundClick={handleBackgroundClick}
        handleBackgroundPointerDown={handleBackgroundPointerDown}
        stopClick={stopClick}
        stopClickUnlessText={stopClickUnlessText}
        onEditingTextChange={setEditingText}
        onEditingLabelKeyDown={handleEditingLabelKeyDown}
        onEditingLabelBlur={commitEditingLabel}
        onPendingTextChange={setPendingText}
        onPendingLabelKeyDown={handlePendingLabelKeyDown}
        onPendingLabelBlur={commitPendingLabel}
      />
    </div>
  )
}
