'use client'

import { useQuery } from '@tanstack/react-query'
import { Check, TriangleAlert, X } from 'lucide-react'
import { assessProjectSketch, getProject } from '@/lib/api'
import { GRID_UNIT } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import type { BinProject, ProjectSketch } from '@/types'

interface Props {
  projectId: string
  binId: string
  savedRevision: string
  pending: boolean
}

function PlanSpace({ project, sketch, binId, savedRevision, pending }: Omit<Props, 'projectId'> & { project: BinProject; sketch: ProjectSketch }) {
  const { theme } = useTheme()
  const { data: assessment, isFetching, error } = useQuery({
    queryKey: ['project-space-assessment', project.id, sketch, binId, savedRevision],
    queryFn: () => assessProjectSketch(project.id, sketch.id, {}),
    enabled: !pending,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
  const updating = pending || isFetching || !assessment
  const status = error ? 'uncertain' : updating ? 'uncertain' : assessment.status
  const tone = status === 'verified'
    ? theme === 'dark' ? 'text-green-400' : 'text-green-700'
    : status === 'invalid'
      ? theme === 'dark' ? 'text-red-400' : 'text-red-700'
      : theme === 'dark' ? 'text-amber-400' : 'text-amber-700'
  const Icon = status === 'verified' ? Check : status === 'invalid' ? X : TriangleAlert
  const width = sketch.container_width_mm ?? (sketch.target_grid_x == null ? null : sketch.target_grid_x * GRID_UNIT)
  const depth = sketch.container_depth_mm ?? (sketch.target_grid_y == null ? null : sketch.target_grid_y * GRID_UNIT)
  const area = width !== null && depth !== null ? width * depth : null
  const usedArea = assessment ? assessment.occupied_floor_units * GRID_UNIT ** 2 : null
  const coverage = area && usedArea !== null ? usedArea / area * 100 : null
  const placedBinIds = new Set(sketch.bin_layout.map(placement => placement.bin_id))
  const height = assessment?.placements.length ? Math.max(...assessment.placements.map(placement => placement.top_mm)) : 0

  return (
    <div className="border-t border-border pt-2 space-y-1.5">
      <a href={`/projects/${project.id}/sketch/${sketch.id}`} className="block text-accent hover:underline break-words">{sketch.name || 'Untitled plan'}</a>
      <div className="space-y-0.5 tabular-nums">
        <div className="flex justify-between gap-2"><span>Width</span><span>{width ?? '?'} mm</span></div>
        <div className="flex justify-between gap-2"><span>Depth</span><span>{depth ?? '?'} mm</span></div>
        <div className="flex justify-between gap-2"><span>Usable height</span><span>{sketch.container_height_mm ?? '?'} mm</span></div>
      </div>
      <p role="status" className={cn('flex items-center gap-1 font-medium', tone)}>
        <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
        {error ? 'Fit unavailable' : updating ? 'Updating project fit…' : status === 'verified' ? 'Fits' : status === 'invalid' ? 'Does not fit' : 'Fit uncertain'}
      </p>
      {error ? <p role="alert">{error.message}</p> : !updating && assessment && <>
        {coverage !== null && <>
          <p className={cn('tabular-nums', tone)}>Floor used {coverage.toFixed(1)}%</p>
          <div role="meter" aria-label={`${sketch.name || 'Plan'} floor occupied`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={coverage}
            className="h-1.5 rounded-full bg-elevated overflow-hidden">
            <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.min(100, coverage)}%`, backgroundColor: 'currentColor' }} />
          </div>
          <p className="tabular-nums">{assessment.occupied_floor_units} / {(area! / GRID_UNIT ** 2).toFixed(2)} grid units</p>
          <p className="tabular-nums">Free grid {assessment.free_cells.length / 4} units</p>
        </>}
        <p className="tabular-nums">Loaded height {height.toFixed(1)} mm{assessment.safety_clearance_mm > 0 && ` + ${assessment.safety_clearance_mm} mm gap`}</p>
        {(assessment.violations.length > 0 || assessment.unresolved.length > 0) && <details className={tone}>
          <summary className="cursor-pointer">{assessment.violations.length + assessment.unresolved.length} fit issue(s)</summary>
          <div className="mt-1 space-y-1">
            {assessment.violations.map((violation, index) => <p key={index}>{violation.message}</p>)}
            {assessment.unresolved.map((reason, index) => <p key={index}>{reason}</p>)}
          </div>
        </details>}
      </>}
      <p>{placedBinIds.size} / {project.bin_ids.length} project bins placed</p>
      {!placedBinIds.has(binId) && <p className="text-text-muted">This bin is not in this plan.</p>}
    </div>
  )
}

export function ProjectSpaceUsage({ projectId, binId, savedRevision, pending }: Props) {
  const { data: project, error, isFetching } = useQuery({
    queryKey: ['project-space', projectId],
    queryFn: () => getProject(projectId),
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
  return (
    <section aria-label="Project space" className="glass rounded-[10px] p-3 text-[11px] text-text-secondary space-y-2">
      <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[1.5px]">Project space</h3>
      {error ? <p role="alert">Project space unavailable: {error.message}</p> : !project ? <p role="status">Loading project space…</p> : <>
        <p>All bins in each drawer plan</p>
        {project.sketches.length === 0 && <p>No project area defined. <a href={`/projects/${projectId}`} className="text-accent hover:underline">Add a drawer plan</a>.</p>}
        {project.sketches.map(sketch => <PlanSpace key={sketch.id} project={project} sketch={sketch} binId={binId} savedRevision={savedRevision} pending={pending || isFetching} />)}
      </>}
    </section>
  )
}
