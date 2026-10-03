'use client'

import { useQuery } from '@tanstack/react-query'
import { Check, TriangleAlert, X } from 'lucide-react'
import { assessProjectSketch, getProject } from '@/lib/api'
import { GRID_UNIT } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import type { BinProject, FitViolation, ProjectSketch } from '@/types'

interface Props {
  projectId: string
  binId: string
  savedRevision: string
  pending: boolean
}

function physicalIssues(violations: FitViolation[]) {
  const issues: { placementId?: string; violations: FitViolation[] }[] = []
  const heightIssues = new Map<string, typeof issues[number]>()
  for (const violation of violations) {
    const placementId = violation.placement_id
    if (placementId && (violation.code === 'ceiling' || violation.code === 'insert_ceiling')) {
      let issue = heightIssues.get(placementId)
      if (!issue) {
        issue = { placementId, violations: [] }
        heightIssues.set(placementId, issue)
        issues.push(issue)
      }
      issue.violations.push(violation)
    } else {
      issues.push({ violations: [violation] })
    }
  }
  return issues
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
  const height = assessment?.placements.length ? Math.max(...assessment.placements.map(placement => placement.top_mm)) : null
  const issues = physicalIssues(assessment?.violations ?? [])
  const planHref = `/projects/${project.id}/sketch/${sketch.id}`

  return (
    <div className="border-t border-border pt-2 space-y-1.5">
      <a href={planHref} className="block text-accent hover:underline break-words">{sketch.name || 'Untitled plan'}</a>
      <a href={planHref} className="block text-accent hover:underline">Inspect / adjust bin placements</a>
      <div className="space-y-0.5 tabular-nums">
        <div className="flex justify-between gap-2"><span>Width</span><span>{width ?? '?'} mm</span></div>
        <div className="flex justify-between gap-2"><span>Depth</span><span>{depth ?? '?'} mm</span></div>
        <div className="flex justify-between gap-2"><span>Usable height</span><span>{sketch.container_height_mm == null ? 'Unknown' : `${sketch.container_height_mm} mm`}</span></div>
      </div>
      <p role="status" className={cn('flex items-center gap-1 font-medium', tone)}>
        <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
        {error ? 'Fit unavailable' : updating ? 'Updating project fit…' : status === 'verified' ? 'Fits' : status === 'invalid' ? 'Does not fit' : 'Fit uncertain'}
      </p>
      {error ? <p role="alert">{error.message}</p> : !updating && assessment && <>
        {coverage !== null && <>
          <p className="tabular-nums">Floor used {coverage.toFixed(1)}%</p>
          <div role="meter" aria-label={`${sketch.name || 'Plan'} floor occupied`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={coverage}
            className="h-1.5 rounded-full bg-elevated overflow-hidden">
            <div className="h-full rounded-full bg-text-secondary" style={{ width: `${Math.min(100, coverage)}%` }} />
          </div>
          <p className="tabular-nums">{assessment.occupied_floor_units} / {(area! / GRID_UNIT ** 2).toFixed(2)} grid units</p>
          <p className="tabular-nums">Free grid {assessment.free_cells.length / 4} units</p>
          {assessment.violations.some(violation => violation.code === 'boundary') && <p>Occupancy counts only the area inside the drawer; a bin extends beyond its boundary.</p>}
        </>}
        <p className="tabular-nums">Assessed loaded height {height === null ? 'unknown' : `${height.toFixed(1)} mm`}{assessment.safety_clearance_mm > 0 && ` + ${assessment.safety_clearance_mm} mm safety gap`}</p>
        {assessment.unresolved.length > 0 && <p>Unknown measurements and unverified checks remain unresolved, not known failures. Loaded height uses available assessment data.</p>}
        {issues.length === 0 && assessment.unresolved.length > 0 && <p>0 physical issues</p>}
        {issues.length > 0 && <details className={tone}>
          <summary className="cursor-pointer">{issues.length} physical issue{issues.length === 1 ? '' : 's'}</summary>
          <div className="mt-1 space-y-1">
            {issues.map((issue, index) => {
              const placement = assessment.placements.find(item => item.placement_id === issue.placementId)
              const savedPlacement = sketch.bin_layout.find(item => item.id === issue.placementId)
              const bin = assessment.bins.find(item => item.id === savedPlacement?.bin_id)
              const copies = savedPlacement ? sketch.bin_layout.filter(item => item.bin_id === savedPlacement.bin_id) : []
              const copyNumber = copies.findIndex(item => item.id === issue.placementId) + 1
              return issue.placementId ? <details key={index} className={cn('break-words', tone)}>
                <summary className="cursor-pointer">Closed-lid height · {bin?.name || 'Bin'}{copies.length > 1 ? ` · Copy ${copyNumber}` : !bin?.name ? ` · Placement ${savedPlacement ? sketch.bin_layout.indexOf(savedPlacement) + 1 : index + 1}` : ''}</summary>
                <div className="mt-1 space-y-1">
                  <p className="tabular-nums">Usable drawer height {assessment.height_mm === null ? 'unknown' : `${assessment.height_mm} mm`}; required loaded height {placement ? `${placement.top_mm.toFixed(1)} mm` : 'unknown'} + {assessment.safety_clearance_mm} mm safety gap.</p>
                  <p>Inspect this bin placement and its support stack in the saved drawer plan.</p>
                  {issue.violations.map((violation, detailIndex) => <div key={detailIndex}>
                    <p>{violation.message}</p>
                    {violation.clearance_mm !== undefined && <p className="tabular-nums">
                      Ceiling clearance {violation.clearance_mm.toFixed(2)} mm.
                    </p>}
                  </div>)}
                  {placement?.envelopes.filter(envelope => issue.violations.some(violation => violation.tool_id === envelope.tool_id)).map(envelope => <div key={envelope.id}>
                    <a href={`/tools/${envelope.tool_id}`} className="text-accent hover:underline">{envelope.name}</a>
                    <p className="tabular-nums">Thickness {envelope.thickness_mm === null ? 'unknown' : `${envelope.thickness_mm} mm`}; resting height {envelope.resting_z_mm === null ? 'unknown' : `${envelope.resting_z_mm.toFixed(1)} mm`}; top {envelope.top_mm === null ? 'unknown' : `${envelope.top_mm.toFixed(1)} mm`}.</p>
                  </div>)}
                </div>
              </details> : <p key={index} className={cn('break-words', tone)}>{issue.violations[0].message}</p>
            })}
          </div>
        </details>}
        {assessment.unresolved.length > 0 && <details className={theme === 'dark' ? 'text-amber-400' : 'text-amber-700'}>
          <summary className="cursor-pointer">{assessment.unresolved.length} unresolved check{assessment.unresolved.length === 1 ? '' : 's'}</summary>
          <div className="mt-1 space-y-1">
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
        <p>All bin placements in saved drawer plans, not tool arrangement.</p>
        {project.sketches.length === 0 && <p>No project area defined. <a href={`/projects/${projectId}`} className="text-accent hover:underline">Add a drawer plan</a>.</p>}
        {project.sketches.map(sketch => <PlanSpace key={sketch.id} project={project} sketch={sketch} binId={binId} savedRevision={savedRevision} pending={pending || isFetching} />)}
      </>}
    </section>
  )
}
