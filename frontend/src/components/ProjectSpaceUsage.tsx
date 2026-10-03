'use client'

import { useQuery } from '@tanstack/react-query'
import { getProject, planBinHeight } from '@/lib/api'
import { GRID_UNIT } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import type { BinConfig, PlacedTool } from '@/types'

interface Props {
  projectId?: string | null
  binId: string
  config: BinConfig
  placedTools: PlacedTool[]
  pending: boolean
}

export function ProjectSpaceUsage({ projectId, binId, config, placedTools, pending }: Props) {
  const { theme } = useTheme()
  const { data: planning, error: heightError, fetchStatus: heightFetchStatus } = useQuery({
    queryKey: ['bin-height-planning', binId, config, placedTools],
    queryFn: () => planBinHeight(binId, config, placedTools),
    enabled: !pending,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
  const { data: project, error: projectError, fetchStatus: projectFetchStatus } = useQuery({
    queryKey: ['project-space', projectId],
    queryFn: () => getProject(projectId!),
    enabled: !!projectId,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
  const assessment = !pending && heightFetchStatus === 'idle' && !heightError ? planning?.assessment : undefined
  const width = config.grid_x * GRID_UNIT
  const depth = config.grid_y * GRID_UNIT
  const nominalHeight = config.height_units * 7 + (config.stacking_lip ? config.rim_units * 7 + 4.4 : 0)
  let loadedHeight = assessment?.external_height_mm ?? 0
  let loadedHeightUnknown = !assessment || assessment.missing_tool_ids.length > 0
  if (assessment) {
    loadedHeightUnknown ||= placedTools.some(tool => !assessment.envelopes.some(envelope => envelope.id === tool.id))
    // ponytail: standalone lower bounds only; drawer placements and stack support belong on the drawer page.
    for (const envelope of assessment.envelopes) {
      if (!envelope.seating_verified || envelope.resting_z_mm === null) {
        loadedHeightUnknown = true
        continue
      }
      if (config.insert_enabled) loadedHeight = Math.max(loadedHeight, envelope.resting_z_mm)
      if (envelope.top_mm === null || envelope.thickness_mm === null) loadedHeightUnknown = true
      else loadedHeight = Math.max(loadedHeight, envelope.top_mm)
    }
  }
  const warningTone = theme === 'dark' ? 'text-red-400' : 'text-red-700'
  const unknownTone = theme === 'dark' ? 'text-amber-400' : 'text-amber-700'
  const linkClass = 'text-accent hover:underline break-words focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
  const projectReady = projectFetchStatus === 'idle' && !projectError
  const fitTone = {
    fits: theme === 'dark' ? 'text-green-400' : 'text-green-700',
    exceeds: warningTone,
    unknown: unknownTone,
    none: undefined,
  }
  const drawers = project?.sketches.map(sketch => {
    const drawerWidth = sketch.container_width_mm ?? (sketch.target_grid_x == null ? null : sketch.target_grid_x * GRID_UNIT)
    const drawerDepth = sketch.container_depth_mm ?? (sketch.target_grid_y == null ? null : sketch.target_grid_y * GRID_UNIT)
    const drawerHeight = sketch.container_height_mm ?? null
    const footprintKnown = drawerWidth !== null && drawerDepth !== null
    const directFailures = [drawerWidth !== null && width > drawerWidth, drawerDepth !== null && depth > drawerDepth] as const
    const rotatedFailures = [drawerDepth !== null && width > drawerDepth, drawerWidth !== null && depth > drawerWidth] as const
    const rotated = footprintKnown
      && Number(rotatedFailures[0]) + Number(rotatedFailures[1]) < Number(directFailures[0]) + Number(directFailures[1])
    const footprintFailures = rotated ? rotatedFailures : directFailures
    const excessHeight = assessment && drawerHeight !== null ? loadedHeight + (sketch.safety_clearance_mm ?? 0) - drawerHeight : null
    return {
      sketch, drawerWidth, drawerDepth, drawerHeight, rotated, excessHeight,
      footprintKnown,
      failsBothOrientations: directFailures.some(Boolean) && rotatedFailures.some(Boolean),
      widthFit: !footprintKnown ? 'unknown' : footprintFailures[0] ? 'exceeds' : 'fits',
      depthFit: !footprintKnown ? 'unknown' : footprintFailures[1] ? 'exceeds' : 'fits',
      heightFit: excessHeight !== null && excessHeight > 1e-7 ? 'exceeds'
        : excessHeight === null || loadedHeightUnknown ? 'unknown' : 'fits',
    } as const
  }) ?? []
  const dimensionRows = [
    { label: 'Width', value: `${width} mm`, fitKey: 'widthFit', rotatedLimit: 'depth' },
    { label: 'Depth', value: `${depth} mm`, fitKey: 'depthFit', rotatedLimit: 'width' },
    { label: 'Height', value: `${(assessment?.external_height_mm ?? nominalHeight).toFixed(1)} mm${!assessment ? ' (nominal)' : ''}`, fitKey: 'heightFit', rotatedLimit: null },
  ] as const

  return (
    <section aria-label="Bin dimensions and drawer fit" className="glass rounded-[10px] p-3 text-[11px] text-text-secondary space-y-2">
      <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[1.5px]">Dimensions &amp; fit</h3>
      <dl className="space-y-0.5 tabular-nums">
        {dimensionRows.map(({ label, value, fitKey, rotatedLimit }) => {
          const fit = !projectId ? 'none' : !projectReady || !project ? 'unknown' : drawers.length === 0 ? 'none'
            : drawers.some(drawer => drawer[fitKey] === 'exceeds') ? 'exceeds'
            : drawers.some(drawer => drawer[fitKey] === 'unknown') ? 'unknown' : 'fits'
          const status = fit === 'fits' ? 'Fits all drawer plans' : fit === 'exceeds' ? 'Exceeds at least one drawer plan'
            : fit === 'unknown' ? 'Drawer fit unknown' : 'No drawer fit comparison'
          const title = `${label}: ${status}${rotatedLimit && projectReady && drawers.some(drawer => drawer.rotated)
            ? `. Compared with drawer ${rotatedLimit} for 90° rotation where selected` : ''}`
          return (
            <div key={label} className="flex justify-between gap-2">
              <dt>{label}</dt>
              <dd data-fit={fit} className={fitTone[fit]} title={title}>{value}<span className="sr-only"> — {title}</span></dd>
            </div>
          )
        })}
      </dl>
      {!assessment && <p role="status" className={unknownTone}>{heightError && !pending ? 'Height unavailable' : 'Checking height…'}</p>}
      {!!projectId && <>
        {!projectReady || !project ? <p role="status" className={unknownTone}>{projectError ? 'Drawer fit unavailable' : 'Checking drawer fit…'}</p>
          : project.sketches.length === 0 && <p>No drawer defined.</p>}
        {drawers.map(({ sketch, drawerWidth, drawerDepth, drawerHeight, footprintKnown, failsBothOrientations, excessHeight }) => {
          const notices = projectReady ? [
            failsBothOrientations ? { text: 'Too large in either orientation', failure: true } : null,
            !footprintKnown ? { text: 'Drawer footprint unknown', failure: false } : null,
            excessHeight !== null && excessHeight > 1e-7 ? { text: `Loaded bin exceeds usable height by ${excessHeight.toFixed(1)} mm`, failure: true } : null,
            drawerHeight === null ? { text: 'Usable drawer height unknown', failure: false } : null,
            assessment && loadedHeightUnknown ? { text: 'Loaded bin height unknown', failure: false } : null,
          ] : []
          return (
            <div key={sketch.id} className="border-t border-border pt-2 space-y-0.5">
              <a href={`/projects/${projectId}/sketch/${sketch.id}`} className={linkClass}>{sketch.name || 'Untitled drawer'}</a>
              <p className="tabular-nums" aria-label="Drawer width × depth × usable height">{drawerWidth ?? '?'} × {drawerDepth ?? '?'} × {drawerHeight ?? '?'} mm</p>
              {notices.map(notice => notice && <p key={notice.text} role="status" className={cn('break-words', notice.failure ? warningTone : unknownTone)}>{notice.text}</p>)}
            </div>
          )
        })}
      </>}
    </section>
  )
}
