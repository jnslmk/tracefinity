// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectSpaceUsage } from './ProjectSpaceUsage'
import { assessProjectSketch, getProject } from '@/lib/api'
import type { BinProject, ToolboxAssessment } from '@/types'

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
