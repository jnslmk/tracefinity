// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectSpaceUsage } from './ProjectSpaceUsage'
import { getProject, planBinHeight } from '@/lib/api'
import { getDefaultBinConfig } from '@/lib/binDefaults'
import type { BinConfig, BinHeightPlanning, BinProject, PlacedTool, ToolEnvelope } from '@/types'

vi.mock('@/lib/api', () => ({ getProject: vi.fn(), planBinHeight: vi.fn() }))

const config: BinConfig = { ...getDefaultBinConfig(), grid_x: 3, grid_y: 1, height_units: 4, stacking_lip: false, insert_enabled: false }
const tool: PlacedTool = {
  id: 'placed-tool', tool_id: 'tool', name: 'Pliers', points: [],
  finger_holes: [], interior_rings: [], rotation: 0,
}
const project: BinProject = {
  id: 'project', name: 'Toolbox', description: null, status: 'active', tool_ids: ['tool'],
  bin_ids: ['bin', 'other'], placed_tool_ids: [], unplaced_tool_ids: [],
  sketches: [{
    id: 'drawer', name: 'Whole drawer', target_grid_x: 1, target_grid_y: 1,
    container_width_mm: 130, container_depth_mm: 50, container_height_mm: 70, safety_clearance_mm: 2,
    bin_layout: [
      { id: 'root', bin_id: 'other', x: 0, y: 0, rotation: 0, color: null },
      { id: 'overlap', bin_id: 'other', x: 0, y: 0, rotation: 90, color: null },
      { id: 'upper', bin_id: 'bin', x: 50, y: -50, rotation: 90, color: null, support_id: 'root' },
      { id: 'copy', bin_id: 'bin', x: 0, y: 0, rotation: 0, color: null, support_id: 'upper' },
    ], created_at: null, updated_at: null,
  }],
  default_bin_config: null, notes: null, created_at: null, updated_at: null,
}

function envelope(overrides: Partial<ToolEnvelope> = {}): ToolEnvelope {
  return {
    id: tool.id, tool_id: tool.tool_id, name: tool.name, points: [], interior_rings: [],
    thickness_mm: 10, effective_depth_mm: 4, resting_z_mm: 25, seating_verified: true,
    insert_height_mm: 2, top_mm: 35, clearance_mm: null, ...overrides,
  }
}

function planning(overrides: Partial<BinHeightPlanning['assessment']> = {}): BinHeightPlanning {
  return {
    assessment: {
      status: 'verified', external_height_mm: 30, stack_increment_mm: 28,
      clearance_mm: null, limiting_tool_id: null, missing_tool_ids: [], envelopes: [], violations: [],
      ...overrides,
    },
    alternatives: [],
  }
}

function drawer(overrides: Partial<BinProject['sketches'][number]>): BinProject {
  return { ...project, sketches: [{ ...project.sketches[0], ...overrides }] }
}

const clients: QueryClient[] = []
beforeEach(() => {
  localStorage.setItem('theme', 'dark')
  vi.mocked(getProject).mockResolvedValue(project)
  vi.mocked(planBinHeight).mockResolvedValue(planning())
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.resetAllMocks()
})

function renderPanel(options: { config?: BinConfig; tools?: PlacedTool[]; projectId?: string | null; pending?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const panel = (next = options) => <QueryClientProvider client={client}>
    <ProjectSpaceUsage projectId={next.projectId === undefined ? 'project' : next.projectId}
      binId="bin" config={next.config ?? config} placedTools={next.tools ?? []} pending={next.pending ?? false} />
  </QueryClientProvider>
  return { ...render(panel()), panel, client }
}

function dimensions() {
  return within(screen.getByRole('region', { name: 'Bin dimensions and drawer fit' }))
}

function expectDimension(label: string, value: number) {
  const valueText = dimensions().getByText(label).nextElementSibling?.textContent ?? ''
  expect(Number.parseFloat(valueText)).toBe(value)
}

function expectFit(label: string, status: 'fits' | 'exceeds' | 'unknown' | 'none') {
  const value = dimensions().getByText(label).nextElementSibling
  expect(value?.tagName).toBe('DD')
  expect(value?.getAttribute('data-fit')).toBe(status)
  const meaning = status === 'none' ? /no (?:project|drawer)|not (?:checked|evaluated|compared)|without.*(?:project|drawer)/i
    : new RegExp(status, 'i')
  expect(value?.getAttribute('title')).toMatch(new RegExp(label, 'i'))
  expect(value?.getAttribute('title')).toMatch(meaning)
  expect(value?.textContent).toMatch(meaning)
}

async function ready(height = 30) {
  await screen.findByRole('link', { name: 'Whole drawer' })
  await waitFor(() => expectDimension('Height', height))
}

it.each([
  { name: 'unrotated footprint', width: 130, depth: 50, gridX: 1, gridY: 1, tooLarge: false },
  { name: 'rotated footprint', width: 50, depth: 130, gridX: 1, gridY: 1, tooLarge: false },
  { name: 'neither orientation despite generous target grids', width: 120, depth: 50, gridX: 100, gridY: 100, tooLarge: true },
  { name: 'target-grid fallback', width: null, depth: null, gridX: 3, gridY: 1, tooLarge: false },
])('checks the $name independently of saved positions, rotations, other bins and support stacks', async ({ width, depth, gridX, gridY, tooLarge }) => {
  vi.mocked(getProject).mockResolvedValue(drawer({
    container_width_mm: width, container_depth_mm: depth, target_grid_x: gridX, target_grid_y: gridY,
  }))
  renderPanel()
  await ready()
  expectDimension('Width', 126)
  expectDimension('Depth', 42)
  expectFit('Width', tooLarge ? 'exceeds' : 'fits')
  expectFit('Depth', 'fits')
  expectFit('Height', 'fits')
  if (width === 50) {
    for (const label of ['Width', 'Depth']) {
      expect(dimensions().getByText(label).nextElementSibling?.getAttribute('title')).toMatch(/rotat/i)
    }
  }
  const warning = screen.queryByText(/too large in either orientation/i)
  expect(Boolean(warning)).toBe(tooLarge)
  expect(screen.queryByText(/^fits$/i)).toBeNull()
  expect(screen.queryByText(/loaded bin exceeds/i)).toBeNull()
  const links = screen.getAllByRole('link')
  expect(links).toHaveLength(1)
  expect(links[0].getAttribute('href')).toBe('/projects/project/sketch/drawer')
  expect(screen.getByText(`${width ?? 126} × ${depth ?? 42} × 70 mm`)).toBeTruthy()
  expect(screen.queryByRole('meter')).toBeNull()
  expect(screen.queryByText(/floor used|project bins placed|physical issues|unresolved checks/i)).toBeNull()
})

it.each([
  { name: 'standalone exterior', assessment: planning({ external_height_mm: 72 }), insert: false, excess: '4.0' },
  { name: 'known tool top', assessment: planning({ envelopes: [envelope({ top_mm: 75 })] }), insert: false, excess: '7.0' },
  { name: 'insert resting surface with unknown tool thickness', assessment: planning({
    status: 'uncertain', envelopes: [envelope({ thickness_mm: null, top_mm: null, resting_z_mm: 74 })],
  }), insert: true, excess: '6.0' },
])('warns when the $name plus the drawer safety gap exceeds usable height', async ({ assessment, insert, excess }) => {
  vi.mocked(planBinHeight).mockResolvedValue(assessment)
  renderPanel({ config: { ...config, insert_enabled: insert, insert_height: 2 }, tools: [tool] })
  await ready(assessment.assessment.external_height_mm)
  const warning = await screen.findByText(/loaded bin exceeds usable height/i)
  expect(warning.textContent).toContain(`${excess} mm`)
  expectFit('Width', 'fits')
  expectFit('Depth', 'fits')
  expectFit('Height', 'exceeds')
  expect(screen.queryByText(/too large in either orientation/i)).toBeNull()
})

it.each([
  { name: 'tool thickness with inserts disabled', project: project, assessment: planning({ status: 'uncertain', envelopes: [envelope({ thickness_mm: null, top_mm: null, resting_z_mm: 74 })] }) },
  { name: 'tool seating', project: project, assessment: planning({ status: 'invalid', envelopes: [envelope({ seating_verified: false, top_mm: 100 })] }) },
  { name: 'missing tool envelope', project: project, assessment: planning({ status: 'uncertain', missing_tool_ids: ['tool'] }) },
  { name: 'drawer height', project: drawer({ container_height_mm: null }), assessment: planning({ envelopes: [envelope({ top_mm: 100 })] }) },
  { name: 'drawer footprint', project: drawer({ container_width_mm: null, target_grid_x: null }), assessment: planning() },
])('keeps unknown $name explicit instead of claiming a fit or failure', async scenario => {
  vi.mocked(getProject).mockResolvedValue(scenario.project)
  vi.mocked(planBinHeight).mockResolvedValue(scenario.assessment)
  renderPanel({ tools: [tool] })
  await ready()
  expect(dimensions().getByText(scenario.name === 'drawer footprint' ? /drawer footprint unknown/i
    : scenario.name === 'drawer height' ? /usable drawer height unknown/i : /loaded bin height unknown/i)).toBeTruthy()
  expect(screen.queryByText(/loaded bin exceeds|too large in either orientation|^fits$/i)).toBeNull()
  expectFit('Width', scenario.name === 'drawer footprint' ? 'unknown' : 'fits')
  expectFit('Depth', scenario.name === 'drawer footprint' ? 'unknown' : 'fits')
  expectFit('Height', 'unknown')
  if (scenario.name === 'drawer height') expect(screen.getByText('130 × 50 × ? mm')).toBeTruthy()
})

it('retains known failures with unknown measurements and aggregates drawer plans as exceeds, then unknown, then fits', async () => {
  const fittingDrawer = { ...project.sketches[0], id: 'fitting', name: 'Roomy drawer', container_height_mm: 90 }
  const unknownDrawer = {
    ...project.sketches[0], id: 'unknown', name: 'Unmeasured drawer',
    container_width_mm: null, target_grid_x: null, container_height_mm: null,
  }
  vi.mocked(getProject).mockResolvedValue({
    ...project, sketches: [fittingDrawer, unknownDrawer, { ...project.sketches[0], container_width_mm: 120 }],
  })
  vi.mocked(planBinHeight).mockResolvedValue(planning({
    status: 'uncertain', external_height_mm: 72, envelopes: [envelope({ thickness_mm: null, top_mm: null })],
  }))
  const view = renderPanel({ tools: [tool] })
  await ready(72)
  expect(screen.getByText(/too large in either orientation/i)).toBeTruthy()
  expect(screen.getByText(/loaded bin exceeds usable height/i).textContent).toContain('4.0 mm')
  expect(dimensions().getAllByText(/loaded bin height unknown/i).length).toBeGreaterThan(0)
  expectFit('Width', 'exceeds')
  expectFit('Depth', 'unknown')
  expectFit('Height', 'exceeds')

  vi.mocked(getProject).mockResolvedValue({ ...project, sketches: [fittingDrawer, unknownDrawer] })
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['project-space'] }) })
  await waitFor(() => {
    expectFit('Width', 'unknown')
    expectFit('Depth', 'unknown')
    expectFit('Height', 'unknown')
  })

  vi.mocked(getProject).mockResolvedValue({ ...project, sketches: [fittingDrawer] })
  vi.mocked(planBinHeight).mockResolvedValue(planning({ external_height_mm: 72, envelopes: [envelope()] }))
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: ['project-space'] })
    await view.client.invalidateQueries({ queryKey: ['bin-height-planning'] })
  })
  await waitFor(() => {
    expectFit('Width', 'fits')
    expectFit('Depth', 'fits')
    expectFit('Height', 'fits')
  })
})

it('hides cached loaded-height results while saving and checking a changed draft', async () => {
  vi.mocked(planBinHeight).mockResolvedValue(planning({ envelopes: [envelope({ top_mm: 75 })] }))
  const view = renderPanel({ tools: [tool] })
  await ready()
  await screen.findByText(/loaded bin exceeds usable height/i)
  expectFit('Height', 'exceeds')
  view.rerender(view.panel({ tools: [tool], pending: true }))
  expect(screen.queryByText(/loaded bin exceeds usable height/i)).toBeNull()
  expect(dimensions().getByText(/checking/i)).toBeTruthy()
  expectDimension('Height', 28)
  expectFit('Width', 'fits')
  expectFit('Depth', 'fits')
  expectFit('Height', 'unknown')
  expect(planBinHeight).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('link', { name: 'Whole drawer' })).toBeTruthy()

  const current = Promise.withResolvers<BinHeightPlanning>()
  vi.mocked(planBinHeight).mockReturnValue(current.promise)
  view.rerender(view.panel({ config: { ...config, height_units: 5 }, tools: [tool] }))
  expectDimension('Height', 35)
  expect(screen.queryByText(/loaded bin exceeds usable height/i)).toBeNull()
  expect(dimensions().getByText(/checking/i)).toBeTruthy()
  expectFit('Height', 'unknown')
  await act(async () => { current.resolve(planning({ external_height_mm: 31 })) })
  await ready(31)
  expect(screen.queryByText(/loaded bin exceeds usable height/i)).toBeNull()
  expectFit('Height', 'unknown')
})

it.each(['height planning', 'project'] as const)('keeps dimensions and drawer links when %s refresh rejects rather than displaying stale loaded-height failure', async query => {
  vi.mocked(planBinHeight).mockResolvedValue(planning({ envelopes: [envelope({ top_mm: 75 })] }))
  const view = renderPanel({ tools: [tool] })
  await ready()
  await screen.findByText(/loaded bin exceeds usable height/i)
  const refreshed = Promise.withResolvers<never>()
  if (query === 'height planning') vi.mocked(planBinHeight).mockReturnValue(refreshed.promise)
  else vi.mocked(getProject).mockReturnValue(refreshed.promise)
  let invalidation: Promise<void> | undefined
  await act(async () => {
    invalidation = view.client.invalidateQueries({ queryKey: [query === 'height planning' ? 'bin-height-planning' : 'project-space'] })
  })
  await waitFor(() => {
    expectFit('Width', query === 'project' ? 'unknown' : 'fits')
    expectFit('Depth', query === 'project' ? 'unknown' : 'fits')
    expectFit('Height', 'unknown')
  })
  await act(async () => {
    refreshed.reject(new Error(`${query} offline`))
    await invalidation
  })
  await screen.findByText(/unavailable/i)
  expectDimension('Width', 126)
  expectDimension('Depth', 42)
  expectDimension('Height', query === 'height planning' ? 28 : 30)
  expect(screen.getByRole('link', { name: 'Whole drawer' }).getAttribute('href')).toBe('/projects/project/sketch/drawer')
  expect(screen.queryByText(/loaded bin exceeds usable height|^fits$/i)).toBeNull()
  expectFit('Width', query === 'project' ? 'unknown' : 'fits')
  expectFit('Depth', query === 'project' ? 'unknown' : 'fits')
  expectFit('Height', 'unknown')
})

it('keeps dimensions available when the project request rejects', async () => {
  vi.mocked(getProject).mockRejectedValue(new Error('Project offline'))
  renderPanel()
  expectFit('Width', 'unknown')
  expectFit('Depth', 'unknown')
  expectFit('Height', 'unknown')
  await screen.findByText(/unavailable/i)
  await waitFor(() => expectDimension('Height', 30))
  expectDimension('Width', 126)
  expectDimension('Depth', 42)
  expect(screen.queryByText(/loaded bin exceeds|too large in either orientation/i)).toBeNull()
  expectFit('Width', 'unknown')
  expectFit('Depth', 'unknown')
  expectFit('Height', 'unknown')
})

it('renders dimensions without a project request or project error when no project is assigned', async () => {
  renderPanel({ projectId: null })
  await waitFor(() => expectDimension('Height', 30))
  expect(screen.getByRole('heading', { name: 'Dimensions & fit' })).toBeTruthy()
  expectDimension('Width', 126)
  expectDimension('Depth', 42)
  expectFit('Width', 'none')
  expectFit('Depth', 'none')
  expectFit('Height', 'none')
  expect(getProject).not.toHaveBeenCalled()
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.queryByText(/project.*unavailable|too large in either orientation|loaded bin exceeds|^fits$/i)).toBeNull()
})
