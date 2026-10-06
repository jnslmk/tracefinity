'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Bounds, GizmoHelper, GizmoViewport, Html, OrbitControls, useBounds } from '@react-three/drei'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { ArrowRight, ArrowUp, Box, CircleDot, RotateCcw, Triangle } from 'lucide-react'
import type { BinSummary, DrawerOutline, Point, ProjectBinPlacement, ToolEnvelope, ToolboxAssessment } from '@/types'
import { GRID_UNIT } from '@/lib/constants'
import { DEFAULT_BIN_COLOR, binFootprint, drawerGridBounds, placementRect, rotationOffsetMm } from '@/lib/drawerLayout'
import { footprintCorners, outlineBounds, shapeInsideOutline } from '@/lib/drawerOutline'
import { useBinStlUrls } from '@/hooks/useBinStlUrls'

interface Props {
  bins: Map<string, BinSummary>
  placements: ProjectBinPlacement[]
  drawerX: number
  drawerY: number
  selectedPlacementId: string | null
  overlapping: Set<string>
  outOfBounds: Set<string>
  assessment: ToolboxAssessment | null
  onSelect: (placementId: string | null) => void
  /** Measured floor boundary in drawer millimetres. */
  outline?: DrawerOutline | null
  /** Grid frame anchored at this drawer-space origin. */
  gridOriginMm?: Point
  /** Grid turn about its origin, degrees clockwise. */
  gridRotationDeg?: number
}

type CameraView = 'home' | 'top' | 'front' | 'right' | 'fit'
type RenderMode = 'solid' | 'edges'

const BIN_OVERLAP_COLOR = '#ef4444'
const BIN_OUT_OF_BOUNDS_COLOR = '#f59e0b'
const VIEW_EVENT = 'drawer-sketch-view'

/** Darkened variant of a bin colour, used for its contour lines. */
function edgeColor(color: string): string {
  return `#${new THREE.Color(color).multiplyScalar(0.35).getHexString()}`
}

/** Lighter variant of a bin colour, marking the selected placement. */
function selectedColor(color: string): string {
  return `#${new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.45).getHexString()}`
}

// three.js is y-up: drawer x maps to x, drawer y (top down) maps to z.
// geometry is declared as JSX so react-three-fiber owns the dispose lifecycle.

function DrawerFloor({ drawerX, drawerY, outline, originXmm, originYmm, rotationDeg }: {
  drawerX: number
  drawerY: number
  outline: DrawerOutline | null
  originXmm: number
  originYmm: number
  rotationDeg: number
}) {
  const widthMm = drawerX * GRID_UNIT
  const depthMm = drawerY * GRID_UNIT
  const origin = useMemo(() => ({ x: originXmm, y: originYmm }), [originXmm, originYmm])

  // the measured boundary becomes the floor itself: its concavities and holes are
  // real floor edges, not a rectangle with an outline drawn over it
  const floorGeometry = useMemo(() => {
    if (!outline) return null
    const shape = new THREE.Shape(outline.points.map(p => new THREE.Vector2(p.x, -p.y)))
    shape.holes = outline.interior_rings.map(ring => new THREE.Path(ring.map(p => new THREE.Vector2(p.x, -p.y))))
    const geometry = new THREE.ShapeGeometry(shape)
    geometry.rotateX(-Math.PI / 2)
    return geometry
  }, [outline])
  useEffect(() => () => floorGeometry?.dispose(), [floorGeometry])

  const gridPositions = useMemo(() => {
    const positions: number[] = []
    // one closed loop per half-unit cell, so a turned grid stays a clipped grid
    // instead of lines that run off the floor
    const bounds = drawerGridBounds(drawerX, drawerY, {
      outline, originXmm, originYmm, rotationDeg, fitClearanceMm: 0,
    })
    const ix0 = outline ? Math.floor((bounds.x0 + 1e-9) * 2) : 0
    const iy0 = outline ? Math.floor((bounds.y0 + 1e-9) * 2) : 0
    const ix1 = outline ? Math.ceil((bounds.x1 - 1e-9) * 2) : Math.round(drawerX * 2)
    const iy1 = outline ? Math.ceil((bounds.y1 - 1e-9) * 2) : Math.round(drawerY * 2)
    for (let iy = iy0; iy < iy1; iy++) {
      for (let ix = ix0; ix < ix1; ix++) {
        const corners = footprintCorners(origin, rotationDeg, ix / 2, iy / 2, 0.5, 0.5)
        if (outline && !shapeInsideOutline(corners, outline)) continue
        for (let i = 0; i < 4; i++) {
          const a = corners[i]
          const b = corners[(i + 1) % 4]
          positions.push(a.x, 0.2, a.y, b.x, 0.2, b.y)
        }
      }
    }
    return new Float32Array(positions)
  }, [drawerX, drawerY, outline, origin, originXmm, originYmm, rotationDeg])

  return (
    <group>
      {floorGeometry ? (
        <mesh geometry={floorGeometry}>
          <meshStandardMaterial color="#27272a" roughness={1} metalness={0} side={THREE.DoubleSide} />
        </mesh>
      ) : (
        <mesh position={[originXmm + widthMm / 2, 0, originYmm + depthMm / 2]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[widthMm, depthMm]} />
          <meshStandardMaterial color="#27272a" roughness={1} metalness={0} />
        </mesh>
      )}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[gridPositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#3f3f46" />
      </lineSegments>
    </group>
  )
}

/**
 * Loads the generated bin STL and normalises it to a y-up model whose corner
 * sits at the origin, so it lines up with the drawer grid like the 2D sketch.
 * Rendering matches the bin page preview: solid body plus sharp contour lines.
 */
function BinStlModel({ url, color, renderMode, fallback, widthMm, depthMm }: {
  url: string
  color: string
  renderMode: RenderMode
  fallback: React.ReactNode
  widthMm: number
  depthMm: number
}) {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null)
  const [edges, setEdges] = useState<THREE.EdgesGeometry | null>(null)

  useEffect(() => {
    let disposed = false
    let loadedGeo: THREE.BufferGeometry | null = null
    let loadedEdges: THREE.EdgesGeometry | null = null

    new STLLoader().load(
      url,
      geo => {
        if (disposed) { geo.dispose(); return }
        // STL is z-up; match the drawer axes and put the footprint corner at the origin.
        // Generated STLs are already corner-aligned, uploaded ones are centred in X/Y,
        // so centre on the mesh's own bounding box before placing it in the grid cell.
        geo.rotateX(-Math.PI / 2)
        geo.computeBoundingBox()
        const box = geo.boundingBox!
        geo.translate(
          widthMm / 2 - (box.min.x + box.max.x) / 2,
          -box.min.y,
          depthMm / 2 - (box.min.z + box.max.z) / 2,
        )
        geo.computeVertexNormals()
        loadedGeo = geo
        loadedEdges = new THREE.EdgesGeometry(geo, 30)
        setGeometry(geo)
        setEdges(loadedEdges)
      },
      undefined,
      error => {
        if (disposed) return
        console.error('drawer plan: STL load error', url, error)
        setGeometry(null)
      },
    )

    return () => {
      disposed = true
      loadedGeo?.dispose()
      loadedEdges?.dispose()
      setGeometry(null)
      setEdges(null)
    }
  }, [url, widthMm, depthMm])

  if (!geometry) return <>{fallback}</>

  return (
    <>
      {renderMode === 'solid' ? (
        <mesh geometry={geometry}>
          <meshStandardMaterial color={color} metalness={0} roughness={0.7} />
        </mesh>
      ) : (
        <mesh geometry={geometry}>
          <meshStandardMaterial color="#27272a" metalness={0} roughness={1} transparent opacity={0.3} />
        </mesh>
      )}
      {edges && (
        <lineSegments geometry={edges}>
          <lineBasicMaterial color={renderMode === 'solid' ? edgeColor(color) : color} linewidth={1} />
        </lineSegments>
      )}
    </>
  )
}

function BinBlock({ widthMm, depthMm, heightMm, color }: {
  widthMm: number
  depthMm: number
  heightMm: number
  color: string
}) {
  return (
    <mesh position={[widthMm / 2, heightMm / 2, depthMm / 2]}>
      <boxGeometry args={[widthMm, heightMm, depthMm]} />
      <meshStandardMaterial color={color} roughness={0.7} metalness={0} transparent opacity={0.45} />
    </mesh>
  )
}

function PlacedBin({
  bin,
  placement,
  color,
  stlUrl,
  renderMode,
  onSelect,
  physical,
}: {
  bin: BinSummary
  placement: ProjectBinPlacement
  color: string
  stlUrl?: string
  renderMode: RenderMode
  onSelect: (placementId: string) => void
  physical: { z_mm: number; external_height_mm: number }
}) {
  const rect = placementRect(placement, bin)
  const footprint = binFootprint(bin, placement.rotation)
  const offset = rotationOffsetMm(placement.rotation, bin)
  // Uploaded bins carry no verified elevation; fall back to the bounding-box
  // height from their import metadata rather than a nominal grid height.
  const fallbackHeightMm = bin.imported_model?.height_mm ?? physical.external_height_mm
  const block = (<>
    <BinBlock
      widthMm={bin.grid_x * GRID_UNIT}
      depthMm={bin.grid_y * GRID_UNIT}
      heightMm={fallbackHeightMm}
      color={color}
    />
    <Html center position={[bin.grid_x * GRID_UNIT / 2, fallbackHeightMm + 5, bin.grid_y * GRID_UNIT / 2]}>
      <span className="text-[10px] bg-surface text-text-primary whitespace-nowrap px-1">Approximate block: geometry pending or unavailable</span>
    </Html>
  </>)

  const outlinePositions = useMemo(() => {
    const w = footprint.w * GRID_UNIT
    const d = footprint.h * GRID_UNIT
    return new Float32Array([
      0, 0.3, 0,
      w, 0.3, 0,
      w, 0.3, d,
      0, 0.3, d,
    ])
  }, [footprint.w, footprint.h])

  return (
    <group
      position={[rect.x * GRID_UNIT, physical.z_mm, rect.y * GRID_UNIT]}
      onClick={event => { event.stopPropagation(); onSelect(placement.id) }}
    >
      {/* rotate the model about the drawer's vertical axis, then shift it back into its footprint */}
      <group position={[offset.dx, 0, offset.dz]} rotation={[0, -placement.rotation * Math.PI / 180, 0]}>
        {stlUrl
          ? <BinStlModel url={stlUrl} color={color} renderMode={renderMode} fallback={block} widthMm={bin.grid_x * GRID_UNIT} depthMm={bin.grid_y * GRID_UNIT} />
          : block}
      </group>
      {/* footprint outline keeps overlaps readable even behind a solid model */}
      <lineLoop>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[outlinePositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} />
      </lineLoop>
    </group>
  )
}

function ToolEnvelopeMesh({ envelope, insert = false }: { envelope: ToolEnvelope; insert?: boolean }) {
  const height = insert ? envelope.insert_height_mm : envelope.thickness_mm
  const geometry = useMemo(() => {
    if (height === null || height <= 0 || envelope.resting_z_mm === null || envelope.points.length < 3) return null
    const shape = new THREE.Shape(envelope.points.map(p => new THREE.Vector2(p.x, -p.y)))
    shape.holes = envelope.interior_rings.map(ring => new THREE.Path(ring.map(p => new THREE.Vector2(p.x, -p.y))))
    const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 })
    geo.rotateX(-Math.PI / 2)
    return geo
  }, [envelope, height])
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry || height === null || envelope.resting_z_mm === null) return null
  const center = envelope.points.reduce((sum, p) => ({ x: sum.x + p.x / envelope.points.length, y: sum.y + p.y / envelope.points.length }), { x: 0, y: 0 })
  return <group position={[0, envelope.resting_z_mm - (insert ? height! : 0), 0]}>
    <mesh geometry={geometry}><meshStandardMaterial color={insert ? '#81bce0' : '#e5b854'} transparent opacity={0.35} depthWrite={false} side={THREE.DoubleSide} /></mesh>
    <Html center position={[center.x, height! + 3, center.y]} style={{ pointerEvents: 'none' }}>
      <span className="text-[10px] whitespace-nowrap bg-surface/90 text-text-primary px-1">{insert ? 'Insert for ' : ''}{envelope.name} — conservative envelope</span>
    </Html>
  </group>
}

function DrawerModels({ bins, placements, selectedPlacementId, overlapping, outOfBounds, assessment, renderMode, onSelect }: Props & { assessment: ToolboxAssessment; renderMode: RenderMode }) {
  const { stlUrls, pendingCount } = useBinStlUrls(placements.map(p => p.bin_id), true)
  return <>
    {placements.map(placement => {
      const bin = bins.get(placement.bin_id)
      const physical = assessment.placements.find(p => p.placement_id === placement.id)
      if (!bin || !physical) return null
      const base = overlapping.has(placement.id) ? BIN_OVERLAP_COLOR : outOfBounds.has(placement.id) ? BIN_OUT_OF_BOUNDS_COLOR : placement.color || DEFAULT_BIN_COLOR
      return <group key={placement.id}>
        <PlacedBin bin={bin} placement={placement} physical={physical} color={selectedPlacementId === placement.id ? selectedColor(base) : base}
          stlUrl={stlUrls.get(bin.id)} renderMode={renderMode} onSelect={onSelect} />
        {physical.envelopes.map(envelope => <ToolEnvelopeMesh key={envelope.id} envelope={envelope} />)}
        {physical.envelopes.filter(envelope => envelope.insert_height_mm > 0).map(envelope => <ToolEnvelopeMesh key={`insert-${envelope.id}`} envelope={envelope} insert />)}
      </group>
    })}
    <Html position={[0, 0, 0]} style={{ pointerEvents: 'none' }}>
      <span className="text-[10px] whitespace-nowrap bg-surface text-text-primary">{pendingCount ? `Generating ${pendingCount} models` : 'Blocks, if present, are not verified geometry'}</span>
    </Html>
  </>
}

// sits inside <Bounds>, listens for view commands via custom event
function CameraController({ fitKey }: { fitKey: string }) {
  const bounds = useBounds()
  const { camera } = useThree()
  const controls = useThree(s => s.controls) as { target?: THREE.Vector3; update?: () => void } | null
  const fittedKeyRef = useRef<string | null>(null)

  // Refit whenever the visible content changes. The assessment arrives after the
  // first render, so a one-shot fit only ever measured the floor and left taller
  // stacked bins above the viewport. The guard is inside the timer so a Bounds
  // identity change (controls mounting) reschedules instead of cancelling the fit.
  useEffect(() => {
    const t = setTimeout(() => {
      if (fittedKeyRef.current === fitKey) return
      fittedKeyRef.current = fitKey
      bounds.refresh().fit()
    }, 50)
    return () => clearTimeout(t)
  }, [bounds, fitKey])

  useEffect(() => {
    function handleView(e: Event) {
      const view = (e as CustomEvent<CameraView>).detail
      // pivot on the framed content centre, not the floor, so elevated stacks
      // stay in frame for every preset
      const pivot = controls?.target?.clone() ?? new THREE.Vector3(0, 0, 0)
      const dist = camera.position.distanceTo(pivot) || 400

      switch (view) {
        case 'home':
          camera.position.set(pivot.x, pivot.y + dist * 0.7, pivot.z + dist * 0.7)
          break
        case 'top':
          camera.position.set(pivot.x, pivot.y + dist, pivot.z + 0.01)
          break
        case 'front':
          camera.position.set(pivot.x, pivot.y + 0.01, pivot.z + dist)
          break
        case 'right':
          camera.position.set(pivot.x + dist, pivot.y + 0.01, pivot.z + 0.01)
          break
        case 'fit':
          bounds.refresh().fit()
          return
      }

      camera.lookAt(pivot)
      controls?.update?.()
    }

    window.addEventListener(VIEW_EVENT, handleView)
    return () => window.removeEventListener(VIEW_EVENT, handleView)
  }, [bounds, camera, controls])

  return null
}

const viewButtons: { view: CameraView; icon: typeof Box; label: string }[] = [
  { view: 'home', icon: RotateCcw, label: 'Home' },
  { view: 'top', icon: ArrowUp, label: 'Top' },
  { view: 'front', icon: CircleDot, label: 'Front' },
  { view: 'right', icon: ArrowRight, label: 'Right' },
  { view: 'fit', icon: Box, label: 'Fit' },
]

export function DrawerSketch3D({
  bins,
  placements,
  drawerX,
  drawerY,
  selectedPlacementId,
  overlapping,
  outOfBounds,
  assessment,
  onSelect,
  outline = null,
  gridOriginMm = { x: 0, y: 0 },
  gridRotationDeg = 0,
}: Props) {
  const [renderMode, setRenderMode] = useState<RenderMode>('solid')
  const floorBounds = outline ? outlineBounds(outline) : {
    x0: gridOriginMm.x, y0: gridOriginMm.y,
    x1: gridOriginMm.x + drawerX * GRID_UNIT, y1: gridOriginMm.y + drawerY * GRID_UNIT,
  }
  const widthMm = floorBounds.x1 - floorBounds.x0
  const depthMm = floorBounds.y1 - floorBounds.y0
  const centerXmm = (floorBounds.x0 + floorBounds.x1) / 2
  const centerYmm = (floorBounds.y0 + floorBounds.y1) / 2
  const span = Math.max(widthMm, depthMm)
  const originXmm = gridOriginMm.x
  const originYmm = gridOriginMm.y

  // changes whenever the framed content changes: drawer size, assessment revision,
  // ceiling height, or any placement's elevation/top, so the camera refits when
  // stacked or imported bins are added instead of framing the floor alone
  const fitKey = useMemo(() => [
    drawerX,
    drawerY,
    originXmm,
    originYmm,
    gridRotationDeg,
    outline ? JSON.stringify(outline) : 'rect',
    assessment?.geometry_revision ?? 'none',
    assessment?.height_mm ?? 'none',
    assessment ? assessment.placements.map(p => `${p.placement_id}:${p.z_mm}:${p.top_mm}`).join(',') : '',
  ].join('|'), [drawerX, drawerY, originXmm, originYmm, gridRotationDeg, outline, assessment])

  const dispatchView = useCallback((view: CameraView) => {
    window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: view }))
  }, [])

  return (
    <div className="w-full h-full min-h-[300px] relative">
      <Canvas
        camera={{ position: [0, span * 0.85, span * 0.85], fov: 50, near: 1, far: span * 20 }}
        style={{ background: '#0d0d0f' }}
        onPointerMissed={() => onSelect(null)}
      >
        <hemisphereLight args={['#e8f8ff', '#8899aa', 1.4]} />
        <directionalLight position={[widthMm, span * 1.5, depthMm]} intensity={0.7} />

        <Suspense fallback={null}>
          <Bounds clip margin={1.15}>
            <group position={[-centerXmm, 0, -centerYmm]}>
              <DrawerFloor drawerX={drawerX} drawerY={drawerY} outline={outline} originXmm={originXmm} originYmm={originYmm} rotationDeg={gridRotationDeg} />
              {/* the grid frame turns with the drawer edge; drawer x maps to three x, drawer y to three z */}
              <group position={[originXmm, 0, originYmm]} rotation={[0, (-gridRotationDeg * Math.PI) / 180, 0]}>
                {assessment && <DrawerModels key={assessment.geometry_revision} bins={bins} placements={placements}
                  drawerX={drawerX} drawerY={drawerY} selectedPlacementId={selectedPlacementId} overlapping={overlapping}
                  outOfBounds={outOfBounds} assessment={assessment} renderMode={renderMode} onSelect={onSelect} />}
              </group>
              {assessment?.height_mm != null && <mesh position={[centerXmm, assessment.height_mm, centerYmm]}>
                <boxGeometry args={[widthMm, .3, depthMm]} />
                <meshStandardMaterial color="#e57474" transparent opacity={.12} depthWrite={false} />
              </mesh>}
            </group>
            <CameraController fitKey={fitKey} />
          </Bounds>
        </Suspense>

        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport labelColor="white" axisHeadScale={0.8} />
        </GizmoHelper>
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={span * 0.15}
          maxDistance={span * 4}
          makeDefault
        />
      </Canvas>

      <div className="absolute top-3 left-3 flex gap-1">
        <p className="text-[11px] bg-surface/90 text-text-primary p-1 max-w-64">
          {!assessment ? 'Assessment pending: preview is not verified.' : `Ceiling: ${assessment.height_mm ?? 'unknown'} mm. Gold tools and blue inserts are labelled conservative envelopes, not reconstructed solids.`}
        </p>
        {viewButtons.map(({ view, icon: Icon, label }) => (
          <button
            key={view}
            onClick={() => dispatchView(view)}
            className="p-1.5 rounded bg-surface/80 hover:bg-elevated text-text-secondary hover:text-text-primary transition-colors"
            title={label}
          >
            <Icon className="w-4 h-4" />
          </button>
        ))}
        <div className="w-px bg-border mx-0.5" />
        <button
          onClick={() => setRenderMode(m => m === 'solid' ? 'edges' : 'solid')}
          className={`p-1.5 rounded transition-colors ${
            renderMode === 'edges'
              ? 'bg-accent-muted text-accent'
              : 'bg-surface/80 hover:bg-elevated text-text-secondary hover:text-text-primary'
          }`}
          title="Toggle edges"
        >
          <Triangle className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
