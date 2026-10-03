// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectSpaceUsage } from './ProjectSpaceUsage'
import { assessProjectSketch, getProject } from '@/lib/api'
import { setTheme } from '@/hooks/useTheme'
import type { BinProject, PlanPlacementAssessment, ToolboxAssessment } from '@/types'

vi.mock('@/lib/api', () => ({ getProject: vi.fn(), assessProjectSketch: vi.fn() }))

const project: BinProject = {
  id: 'project', name: 'Toolbox', description: null, status: 'active', tool_ids: [],
  bin_ids: ['bin', 'other'], placed_tool_ids: [], unplaced_tool_ids: [],
  sketches: [{
    id: 'drawer', name: 'Whole drawer', target_grid_x: 8, target_grid_y: 4,
    container_width_mm: 200, container_depth_mm: 100, container_height_mm: 70,
    bin_layout: [
      { id: 'root', bin_id: 'other', x: 0, y: 0, rotation: 0, color: null },
      { id: 'upper', bin_id: 'bin', x: 0, y: 0, rotation: 0, color: null, support_id: 'root' },
    ], created_at: null, updated_at: null,
  }],
  default_bin_config: null, notes: null, created_at: null, updated_at: null,
}
function assessment(status: ToolboxAssessment['status']): ToolboxAssessment {
  return {
    status, geometry_revision: 'revision', bins: [],
    violations: status === 'invalid' ? [{ code: 'ceiling', message: 'Bin exterior interferes with the closed lid' }] : [],
    unresolved: status === 'uncertain' ? ['Tool thickness is unknown'] : [],
    missing_tool_ids: [], unhoused_tool_ids: [], placements: [], grid_x: 4.5, grid_y: 2,
    width_mm: 200, depth_mm: 100, height_mm: 70, safety_clearance_mm: 0,
    residual_width_mm: 11, residual_depth_mm: 16, occupied_floor_units: 2,
    free_cells: [], free_regions: [], stacks: [],
  }
}
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.resetAllMocks() })

it('shows the complete plan’s floor union and physical limits, and never claims stale fit while saving or reassessing', async () => {
  localStorage.setItem('theme', 'dark')
  vi.mocked(getProject).mockResolvedValue(project)
  vi.mocked(assessProjectSketch).mockResolvedValueOnce(assessment('verified'))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const panel = (savedRevision: string, pending = false) => <QueryClientProvider client={client}>
    <ProjectSpaceUsage projectId="project" binId="bin" savedRevision={savedRevision} pending={pending} />
  </QueryClientProvider>
  const view = render(panel('initial'))
  await screen.findByText('Fits')
  expect(screen.getByText('200 mm')).toBeTruthy()
  expect(screen.getByText('100 mm')).toBeTruthy()
  expect(screen.getByText('Floor used 17.6%')).toBeTruthy()
  expect(screen.getByText('2 / 11.34 grid units')).toBeTruthy()
  expect(screen.getByText('2 / 2 project bins placed')).toBeTruthy()

  view.rerender(panel('initial', true))
  expect(screen.queryByText('Fits')).toBeNull()
  expect(screen.getByText('Updating project fit…')).toBeTruthy()
  const { promise, resolve } = Promise.withResolvers<ToolboxAssessment>()
  vi.mocked(assessProjectSketch).mockReturnValueOnce(promise)
  view.rerender(panel('saved'))
  await screen.findByText('Updating project fit…')
  await act(async () => { resolve(assessment('invalid')) })
  await screen.findByText('Does not fit')
  expect(screen.getByText('Bin exterior interferes with the closed lid')).toBeTruthy()

  vi.mocked(assessProjectSketch).mockResolvedValueOnce(assessment('uncertain'))
  view.rerender(panel('uncertain'))
  await screen.findByText('Fit uncertain')
  expect(screen.queryByText('Fits')).toBeNull()

  vi.mocked(assessProjectSketch).mockRejectedValueOnce(new Error('Assessment offline'))
  view.rerender(panel('failed'))
  await screen.findByText('Fit unavailable')
  expect(screen.getByRole('alert').textContent).toBe('Assessment offline')
  expect(screen.queryByText('Fits')).toBeNull()
})

it('groups tool, insert and exterior ceiling failures for one placement and retains their original details', async () => {
  const fit = assessment('invalid')
  fit.safety_clearance_mm = 2
  fit.placements = [{
    placement_id: 'upper', root_id: 'root', z_mm: 40, top_mm: 80,
    headroom_mm: -12, external_height_mm: 40, support_compatible: true,
    clearance_mm: null, limiting_tool_id: 'tool', envelopes: [{
      id: 'placed-tool', tool_id: 'tool', name: 'Pliers', points: [], interior_rings: [],
      thickness_mm: 10, effective_depth_mm: 4, resting_z_mm: 70,
      seating_verified: true, insert_height_mm: 2, top_mm: 80, clearance_mm: null,
    }, {
      id: 'placed-wrench', tool_id: 'wrench', name: 'Wrench', points: [], interior_rings: [],
      thickness_mm: 8, effective_depth_mm: 4, resting_z_mm: 70,
      seating_verified: true, insert_height_mm: 2, top_mm: 78, clearance_mm: null,
    }],
  }]
  fit.violations = [
    { code: 'ceiling', placement_id: 'upper', tool_id: 'tool', message: 'Pliers envelope interferes with the closed lid', clearance_mm: -12 },
    { code: 'ceiling', placement_id: 'upper', tool_id: 'wrench', message: 'Wrench envelope interferes with the closed lid', clearance_mm: -10 },
    { code: 'insert_ceiling', placement_id: 'upper', tool_id: 'tool', message: 'Pliers insert interferes with the closed lid', clearance_mm: -2 },
    { code: 'ceiling', placement_id: 'upper', message: 'Bin exterior interferes with the closed lid', clearance_mm: -12 },
  ]
  vi.mocked(getProject).mockResolvedValue(project)
  vi.mocked(assessProjectSketch).mockResolvedValue(fit)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}>
    <ProjectSpaceUsage projectId="project" binId="bin" savedRevision="saved" pending={false} />
  </QueryClientProvider>)
  await screen.findByText('Does not fit')
  expect(screen.getByText('1 physical issue')).toBeTruthy()
  fireEvent.click(screen.getByText('1 physical issue'))
  const disclosure = screen.getByText('Pliers envelope interferes with the closed lid').closest('details')!
  const summary = disclosure.querySelector('summary')!
  expect(disclosure.open).toBe(false)
  fireEvent.click(summary)
  expect(disclosure.open).toBe(true)
  for (const violation of fit.violations) {
    expect(within(disclosure).getByText(violation.message)).toBeTruthy()
  }
  expect(within(disclosure).getByText('Usable drawer height 70 mm; required loaded height 80.0 mm + 2 mm safety gap.')).toBeTruthy()
  expect(within(disclosure).getByText('Thickness 10 mm; resting height 70.0 mm; top 80.0 mm.')).toBeTruthy()
  expect(within(disclosure).getByRole('link', { name: 'Pliers' }).getAttribute('href')).toBe('/tools/tool')
  expect(within(disclosure).getByText('Thickness 8 mm; resting height 70.0 mm; top 78.0 mm.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Inspect / adjust bin placements' }).getAttribute('href')).toBe('/projects/project/sketch/drawer')
})

it('keeps repeated placements, independent checks and unidentified violations separate from unresolved checks', async () => {
  const repeatedProject: BinProject = {
    ...project,
    sketches: [{ ...project.sketches[0], bin_layout: project.sketches[0].bin_layout.map(item => ({ ...item, bin_id: 'bin' })) }],
  }
  const fit = assessment('invalid')
  const placement: PlanPlacementAssessment = {
    placement_id: 'root', root_id: 'root', z_mm: 0, top_mm: 80,
    headroom_mm: -10, external_height_mm: 80, support_compatible: null,
    clearance_mm: null, limiting_tool_id: null, envelopes: [{
      id: 'unknown-tool', tool_id: 'unknown-tool', name: 'Unmeasured tool', points: [], interior_rings: [],
      thickness_mm: null, effective_depth_mm: 4, resting_z_mm: 80,
      seating_verified: true, insert_height_mm: 2, top_mm: null, clearance_mm: null,
    }],
  }
  fit.placements = [placement, { ...placement, placement_id: 'upper' }]
  fit.violations = [
    { code: 'ceiling', placement_id: 'upper', message: 'Upper tool exceeds lid' },
    { code: 'insert_ceiling', placement_id: 'upper', message: 'Upper insert exceeds lid' },
    { code: 'insert_ceiling', placement_id: 'root', tool_id: 'unknown-tool', message: 'Root insert exceeds lid' },
    { code: 'ceiling', placement_id: 'root', message: 'Root exterior exceeds lid' },
    { code: 'boundary', placement_id: 'upper', message: 'Footprint exceeds drawer bounds' },
    { code: 'overlap', placement_id: 'upper', other_placement_id: 'root', message: 'Independent stacks collide' },
    { code: 'tool_seating', placement_id: 'upper', tool_id: 'tool', message: 'Tool cannot sit in pocket' },
    { code: 'ceiling', message: 'Unidentified exterior exceeds lid' },
    { code: 'insert_ceiling', message: 'Unidentified insert exceeds lid' },
    { code: 'ceiling', placement_id: '', message: 'Empty placement ID exceeds lid' },
  ]
  fit.unresolved = ['Tool thickness is unknown', 'Imported support interface is unverified']
  vi.mocked(getProject).mockResolvedValue(repeatedProject)
  vi.mocked(assessProjectSketch).mockResolvedValue(fit)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}>
    <ProjectSpaceUsage projectId="project" binId="bin" savedRevision="saved" pending={false} />
  </QueryClientProvider>)
  await screen.findByText('Does not fit')
  expect(screen.getByText('8 physical issues')).toBeTruthy()
  expect(screen.getByText('2 unresolved checks')).toBeTruthy()
  const upper = screen.getByText('Upper tool exceeds lid').closest('details')!
  const root = screen.getByText('Root insert exceeds lid').closest('details')!
  expect(upper).not.toBe(root)
  expect(upper.querySelector('summary')!.textContent).not.toBe(root.querySelector('summary')!.textContent)
  expect(within(upper).getByText('Upper tool exceeds lid')).toBeTruthy()
  expect(within(upper).getByText('Upper insert exceeds lid')).toBeTruthy()
  expect(within(upper).queryByText('Root insert exceeds lid')).toBeNull()
  expect(within(root).getByText('Root insert exceeds lid')).toBeTruthy()
  expect(within(root).getByText('Thickness unknown; resting height 80.0 mm; top unknown.')).toBeTruthy()
  expect(within(root).getByText('Root exterior exceeds lid')).toBeTruthy()
  expect(within(root).queryByText('Upper tool exceeds lid')).toBeNull()
  const physical = screen.getByText('8 physical issues').closest('details')!
  for (const violation of fit.violations.slice(4)) {
    expect(screen.getByText(violation.message).closest('details')).toBe(physical)
  }
  const unresolved = screen.getByText('2 unresolved checks').closest('details')!
  expect(within(physical).queryByText('Tool thickness is unknown')).toBeNull()
  fireEvent.click(screen.getByText('2 unresolved checks'))
  expect(unresolved.open).toBe(true)
  fit.unresolved.forEach(reason => expect(within(unresolved).getByText(reason)).toBeTruthy())
  expect(screen.getByText('Occupancy counts only the area inside the drawer; a bin extends beyond its boundary.')).toBeTruthy()
})

it.each(['light', 'dark'] as const)('keeps occupancy neutral and unknown height distinct from failure in the %s theme', async theme => {
  act(() => { setTheme(theme) })
  const unknownProject: BinProject = {
    ...project, sketches: [{ ...project.sketches[0], container_height_mm: null }],
  }
  const unknown = assessment('uncertain')
  unknown.height_mm = null
  unknown.unresolved = ['Usable container height is unknown', 'Tool thickness is unknown']
  vi.mocked(getProject).mockResolvedValue(unknownProject)
  vi.mocked(assessProjectSketch).mockResolvedValueOnce(unknown)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const panel = (savedRevision: string) => <QueryClientProvider client={client}>
    <ProjectSpaceUsage projectId="project" binId="bin" savedRevision={savedRevision} pending={false} />
  </QueryClientProvider>
  const view = render(panel('unknown'))
  const status = await screen.findByText('Fit uncertain')
  expect(status.className).toContain(theme === 'dark' ? 'text-amber-400' : 'text-amber-700')
  expect(screen.queryByText('Does not fit')).toBeNull()
  expect(screen.getByText('0 physical issues')).toBeTruthy()
  expect(screen.getByText('2 unresolved checks')).toBeTruthy()
  expect(screen.getByText('Unknown')).toBeTruthy()
  expect(screen.getByText('Assessed loaded height unknown')).toBeTruthy()
  const floor = screen.getByText('Floor used 17.6%')
  const meter = screen.getByRole('meter')
  const floorClass = floor.className
  const fillClass = meter.firstElementChild!.className
  expect(fillClass).toContain('bg-text-secondary')
  expect(Number(meter.getAttribute('aria-valuenow'))).toBeCloseTo(17.64)

  vi.mocked(assessProjectSketch).mockResolvedValueOnce(assessment('invalid'))
  view.rerender(panel('known-failure'))
  const failure = await screen.findByText('Does not fit')
  expect(failure.className).toContain(theme === 'dark' ? 'text-red-400' : 'text-red-700')
  expect(screen.getByText('1 physical issue')).toBeTruthy()
  expect(screen.queryByText('2 unresolved checks')).toBeNull()
  expect(screen.getByText('Floor used 17.6%').className).toBe(floorClass)
  expect(screen.getByRole('meter').firstElementChild!.className).toBe(fillClass)

  vi.mocked(assessProjectSketch).mockResolvedValueOnce(assessment('verified'))
  view.rerender(panel('verified'))
  await screen.findByText('Fits')
  expect(screen.queryByText('Does not fit')).toBeNull()
  expect(screen.getByText('Floor used 17.6%').className).toBe(floorClass)
  expect(screen.getByRole('meter').firstElementChild!.className).toBe(fillClass)
})
