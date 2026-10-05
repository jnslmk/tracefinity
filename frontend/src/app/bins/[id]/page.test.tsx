// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FACTORY_BIN_CONFIG } from '@/lib/binDefaults'
import { getBin, updateBin } from '@/lib/api'
import type { PlacedTool, TextLabel } from '@/types'
import BinPage from './page'

const square = {
  id: 'square', name: 'Square tool', smoothed: false, smooth_level: 0,
  points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }],
  finger_holes: [], interior_rings: [],
}
const squares = [
  square,
  { ...square, id: 'square-2', name: 'Second square' },
  { ...square, id: 'square-3', name: 'Third square' },
]
const tall = {
  ...square, id: 'tall', name: 'Tall tool',
  points: [{ x: 0, y: 0 }, { x: 110, y: 0 }, { x: 110, y: 120 }, { x: 0, y: 120 }],
}

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'bin' }),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/components/BinPreview3D', () => ({ BinPreview3D: () => null }))
vi.mock('@/lib/api', async () => ({
  ...await vi.importActual<Record<string, unknown>>('@/lib/api'),
  getBin: vi.fn(async () => ({
    id: 'bin', name: 'Test bin', project_id: null, bin_config: FACTORY_BIN_CONFIG,
    placed_tools: [], text_labels: [], stl_path: null, created_at: null,
  })),
  listTools: async () => [...squares, tall],
  getTool: async (id: string) => [...squares, tall].find(tool => tool.id === id),
  updateBin: vi.fn().mockResolvedValue(undefined),
  generateBinStl: vi.fn().mockResolvedValue({ stl_url: '/fixture.stl' }),
  planBinHeight: async () => ({
    alternatives: [],
    assessment: {
      status: 'uncertain', external_height_mm: 30, stack_increment_mm: 28,
      clearance_mm: null, limiting_tool_id: null, missing_tool_ids: [], envelopes: [], violations: [],
    },
  }),
}))

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('theme', 'dark')
  vi.mocked(updateBin).mockClear()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('keeps the chosen depth through adding tools, packing, recentering and too-tall overflow', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><BinPage /></QueryClientProvider>)
  fireEvent.change(await screen.findByLabelText('Grid sizing'), { target: { value: 'fixed_depth' } })
  const width = screen.getByLabelText('Grid Width') as HTMLInputElement
  const depth = screen.getByLabelText('Grid Depth') as HTMLInputElement
  fireEvent.change(depth, { target: { value: '2' } })
  for (const tool of squares) {
    fireEvent.click((await screen.findByText(tool.name, { selector: 'button span' })).closest('button')!)
    // The empty bin already has these dimensions; wait for each asynchronous add.
    await screen.findByLabelText(`Remove ${tool.name} from bin`)
  }
  expect(width.value).toBe('2')
  expect(depth.value).toBe('2')
  expect(screen.queryByRole('alert', { hidden: true })).toBeNull()

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      placements: squares.map((tool, index) => ({
        tool_id: tool.id, name: tool.name, x: 5 + index * 53, y: 5, rotation: 0,
      })),
      bounds: [5, 5, 161, 55], efficiency: 1, unfitted_tool_ids: [], grid_x: 4,
    }),
  }))
  fireEvent.click(screen.getByText('Auto-arrange', { selector: 'button' }))
  await waitFor(() => expect(width.value).toBe('4'))
  expect(depth.value).toBe('2')
  // Flush another render/effect pass: automatic sizing must not undo the server width.
  await act(async () => {})
  expect(width.value).toBe('4')

  fireEvent.click(screen.getByText('Recenter', { selector: 'button' }))
  expect(width.value).toBe('4')
  expect(depth.value).toBe('2')
  for (const tool of squares.slice(1)) {
    fireEvent.click(screen.getByLabelText(`Remove ${tool.name} from bin`))
  }
  await waitFor(() => expect(width.value).toBe('2'))
  fireEvent.click(screen.getByText(tall.name, { selector: 'button span' }).closest('button')!)
  await screen.findByLabelText(`Remove ${tall.name} from bin`)
  await waitFor(() => expect(width.value).toBe('3'))
  expect(depth.value).toBe('2')
  expect(screen.getByRole('alert', { hidden: true })).toBeTruthy()
  client.clear()
})

it.each([[80.1, false], [80.3, true]] as const)('checks pinned bottom edge %smm against the actual fixed-depth interior', async (bottom, overflow) => {
  vi.mocked(getBin).mockResolvedValueOnce({
    id: 'bin', name: 'Test bin', project_id: null, bin_config: FACTORY_BIN_CONFIG,
    text_labels: [], stl_path: null, created_at: null,
    placed_tools: [{
      id: 'pinned-square', tool_id: square.id, name: square.name, pinned: true,
      rotation: 0, finger_holes: [], interior_rings: [],
      points: square.points.map(point => ({ x: point.x + 5, y: point.y + bottom - 50 })),
    }],
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><BinPage /></QueryClientProvider>)
  fireEvent.change(await screen.findByLabelText('Grid sizing'), { target: { value: 'fixed_depth' } })
  const depth = screen.getByLabelText('Grid Depth') as HTMLInputElement
  fireEvent.change(depth, { target: { value: '2' } })
  expect(depth.value).toBe('2')
  expect(screen.queryByRole('alert', { hidden: true }) !== null).toBe(overflow)
  client.clear()
})

it('undoes and redoes the complete packed layout and width, then branches on a new edit', async () => {
  const tool: PlacedTool = {
    id: 'custom-placement', tool_id: 'custom-tool', name: 'Custom tool', rotation: 0,
    points: square.points.map(point => ({ x: point.x + 17, y: point.y + 17 })),
    finger_holes: [{ id: 'hole', x: 25, y: 30, radius: 3, depth_override: 7 }],
    interior_rings: [[{ x: 30, y: 30 }, { x: 34, y: 30 }, { x: 32, y: 34 }]],
    depth_override: 12,
  }
  const pinned: PlacedTool = {
    id: 'pinned-placement', tool_id: 'pinned-tool', name: 'Pinned tool', pinned: true,
    rotation: 0, finger_holes: [], interior_rings: [],
    points: [{ x: 65, y: 40 }, { x: 75, y: 40 }, { x: 75, y: 50 }, { x: 65, y: 50 }],
  }
  const label: TextLabel = {
    id: 'label', text: 'Keep me', x: 8, y: 9, rotation: 15,
    font_size: 4, depth: 0.8, emboss: false,
  }
  const before = {
    name: 'Test bin',
    bin_config: { ...FACTORY_BIN_CONFIG, partial_bins: true, partial_bins_values: [true, false, true, true] },
    placed_tools: [tool, pinned], text_labels: [label],
  }
  vi.mocked(getBin).mockResolvedValueOnce({
    ...structuredClone(before),
    id: 'bin', project_id: null, stl_path: null, created_at: null,
  })
  vi.useFakeTimers()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  await act(async () => {
    render(<QueryClientProvider client={client}><BinPage /></QueryClientProvider>)
  })
  const sizing = screen.getByLabelText('Grid sizing')
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  fireEvent.change(sizing, { target: { value: 'fixed_depth' } })
  fireEvent.click(screen.getByText('Action history'))
  const width = screen.getByLabelText('Grid Width') as HTMLInputElement
  // Grid sizing is session-only; unchanged config/geometry does not schedule a save.
  expect(updateBin).not.toHaveBeenCalled()
  const beforePath = screen.getByTestId('bin-canvas').querySelector('path')!.getAttribute('d')

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      placements: [{ tool_id: tool.tool_id, placement_id: tool.id, name: tool.name, x: 10, y: 9, rotation: 90 }],
      bounds: [10, 9, 75, 59], efficiency: 1,
      unfitted_tool_ids: [], unfitted_placement_ids: [], grid_x: 4,
    }),
  }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
  })
  expect(width.value).toBe('4')
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(vi.mocked(updateBin).mock.calls.at(-1)?.[1].bin_config?.grid_x).toBe(4)
  const packed = structuredClone(vi.mocked(updateBin).mock.calls.at(-1)![1])
  const packedPath = screen.getByTestId('bin-canvas').querySelector('path')!.getAttribute('d')
  expect(packed.placed_tools![0].rotation).toBe(90)
  expect(packed.placed_tools![1]).toEqual(pinned)
  expect(packed.text_labels).toEqual([label])
  expect(packed.bin_config!.partial_bins_values).toEqual(Array(8).fill(true))
  expect(packedPath).not.toBe(beforePath)

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await act(async () => {})
  expect(width.value).toBe('2')
  expect(screen.getByTestId('bin-canvas').querySelector('path')!.getAttribute('d')).toBe(beforePath)
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(vi.mocked(updateBin).mock.calls.at(-1)?.[1]).toEqual(before)
  expect(screen.getByRole('list', { name: 'Bin action history' }).textContent).toContain('Auto-arrange tools · Undone')

  fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
  await act(async () => {})
  expect(width.value).toBe('4')
  expect(screen.getByTestId('bin-canvas').querySelector('path')!.getAttribute('d')).toBe(packedPath)
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(vi.mocked(updateBin).mock.calls.at(-1)?.[1]).toEqual(packed)

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  fireEvent.change(screen.getByLabelText('Grid sizing'), { target: { value: 'fixed' } })
  expect((screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('list', { name: 'Bin action history' }).textContent).not.toContain('Auto-arrange tools')
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect((screen.getByLabelText('Grid sizing') as HTMLSelectElement).value).toBe('fixed_depth')
  expect(width.value).toBe('2')
  client.clear()
})

it('keeps native text undo and discards a pending auto-arrange when history restores only a label', async () => {
  const tool: PlacedTool = {
    id: 'placement', tool_id: 'custom-tool', name: 'Custom tool', rotation: 0,
    points: square.points.map(point => ({ x: point.x + 17, y: point.y + 17 })),
    finger_holes: [], interior_rings: [],
  }
  const label: TextLabel = {
    id: 'label', text: 'Original', x: 8, y: 9, rotation: 0, font_size: 4, depth: 0.8, emboss: false,
  }
  vi.mocked(getBin).mockResolvedValueOnce({
    id: 'bin', name: 'Test bin', project_id: null, stl_path: null, created_at: null,
    bin_config: FACTORY_BIN_CONFIG, placed_tools: [tool], text_labels: [label],
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><BinPage /></QueryClientProvider>)
  const text = await screen.findByText('Original', { selector: 'text' })
  fireEvent.click(screen.getByText('Action history'))
  fireEvent.mouseDown(text.previousElementSibling!)
  fireEvent.mouseUp(window)
  const input = screen.getByPlaceholderText('Label text')
  fireEvent.change(input, { target: { value: 'Edited' } })
  fireEvent.keyDown(input, { key: 'z', ctrlKey: true })
  expect(screen.getByText('Edited', { selector: 'text' })).toBeTruthy()

  let finish!: (value: unknown) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve })))
  const beforePath = screen.getByTestId('bin-canvas').querySelector('path')!.getAttribute('d')
  fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
  await screen.findByText('Arranging tools…')
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(screen.getByText('Original', { selector: 'text' })).toBeTruthy()
  await act(async () => finish({
    ok: true,
    json: async () => ({
      placements: [{ tool_id: tool.tool_id, placement_id: tool.id, name: tool.name, x: 60, y: 60, rotation: 90 }],
      bounds: [60, 60, 110, 110], efficiency: 0, unfitted_tool_ids: [tool.tool_id], grid_x: null,
    }),
  }))
  expect(screen.getByTestId('bin-canvas').querySelector('path')!.getAttribute('d')).toBe(beforePath)
  expect(screen.queryByText(/Last auto-arrange/)).toBeNull()
  expect(screen.queryByText('Arranging tools…')).toBeNull()
  expect(screen.getByRole('list', { name: 'Bin action history' }).textContent).not.toContain('Auto-arrange tools')
  expect((screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(false)
  client.clear()
})
