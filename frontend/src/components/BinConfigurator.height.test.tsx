// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BinHeightPlanner } from './BinConfigurator'
import { FACTORY_BIN_CONFIG } from '@/lib/binDefaults'
import { planBinHeight } from '@/lib/api'
import type { BinConfig, BinHeightPlanning, PlacedTool } from '@/types'

vi.mock('@/lib/api', () => ({ planBinHeight: vi.fn() }))

const TOOL: PlacedTool = {
  id: 'placement-1', tool_id: 'tool-1', name: 'Wrench',
  points: [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }],
  finger_holes: [], interior_rings: [], rotation: 0,
}

function planning(thickness = 14, config = FACTORY_BIN_CONFIG, tools = [TOOL]): BinHeightPlanning {
  return {
    assessment: {
      status: 'verified', external_height_mm: 30, stack_increment_mm: 28,
      clearance_mm: 1, limiting_tool_id: TOOL.tool_id, missing_tool_ids: [], violations: [],
      envelopes: tools.map(tool => ({
        ...tool, thickness_mm: thickness, effective_depth_mm: 15, resting_z_mm: 5,
        seating_verified: true, insert_height_mm: 0, top_mm: 5 + thickness, clearance_mm: 1,
      })),
    },
    alternatives: [{
      strategy: 'deeper_pockets', complete: true, reason: null,
      bin_config: { ...config, height_units: thickness === 14 ? 3 : 4 }, placed_tools: tools,
    }],
  }
}

function deferred() {
  let resolve!: (value: BinHeightPlanning) => void
  let reject!: (error: Error) => void
  const promise = new Promise<BinHeightPlanning>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const clients: QueryClient[] = []
beforeEach(() => {
  localStorage.setItem('theme', 'dark')
  vi.mocked(planBinHeight).mockReset().mockResolvedValue(planning())
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.useRealTimers()
})

function renderPlanner(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  clients.push(client)
  const onApply = vi.fn().mockResolvedValue(undefined)
  const onRemove = vi.fn()
  const panel = (config: BinConfig = FACTORY_BIN_CONFIG, tools: PlacedTool[] = [TOOL]) => (
    <QueryClientProvider client={client}>
      <BinHeightPlanner binId="bin-1" config={config} placedTools={tools} onApply={onApply} onRemove={onRemove} />
    </QueryClientProvider>
  )
  return { ...render(panel()), client, onApply, onRemove, panel }
}

async function ready() {
  await screen.findByText('14 mm · 2 u')
  await waitFor(() => expect((screen.getByRole('button', { name: 'Auto-set bin height' }) as HTMLButtonElement).disabled).toBe(false))
}

function expectCannotApply(onApply: Mock) {
  const button = screen.getByRole('button', { name: /height|fit/ }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(onApply).not.toHaveBeenCalled()
}

describe('height planning reuse', () => {
  it('shows cached measurements immediately on reopen while revalidating shared tools', async () => {
    const first = renderPlanner()
    await ready()
    first.unmount()
    const refresh = deferred()
    vi.mocked(planBinHeight).mockReturnValue(refresh.promise)
    const reopened = renderPlanner(first.client)
    expect(screen.getByText('14 mm · 2 u')).toBeTruthy()
    expectCannotApply(reopened.onApply)
    expect(screen.getByRole('button', { name: 'Updating fit…' })).toBeTruthy()
    await act(async () => refresh.resolve(planning(21)))
    await screen.findByText('21 mm · 3 u')
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-set bin height' }))
    await waitFor(() => expect(reopened.onApply).toHaveBeenCalledWith(expect.objectContaining({ bin_config: expect.objectContaining({ height_units: 4 }) })))
  })

  it('retains measurements on focus, deduplicates refreshes, and applies only updated fit', async () => {
    const view = renderPlanner()
    await ready()
    const refresh = deferred()
    vi.mocked(planBinHeight).mockReturnValue(refresh.promise)
    fireEvent(window, new Event('focus'))
    await screen.findByRole('button', { name: 'Updating fit…' })
    fireEvent(window, new Event('focus'))
    expect(screen.getByText('14 mm · 2 u')).toBeTruthy()
    expectCannotApply(view.onApply)
    expect(planBinHeight).toHaveBeenCalledTimes(2)
    await act(async () => refresh.resolve(planning(21)))
    await screen.findByText('21 mm · 3 u')
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-set bin height' }))
    await waitFor(() => expect(view.onApply).toHaveBeenCalledWith(expect.objectContaining({ bin_config: expect.objectContaining({ height_units: 4 }) })))
  })

  it('does not restart an in-flight request for content-equivalent rerenders or remounts', async () => {
    const request = deferred()
    vi.mocked(planBinHeight).mockReturnValue(request.promise)
    const view = renderPlanner()
    view.rerender(view.panel({ ...FACTORY_BIN_CONFIG }, [{ ...TOOL, points: TOOL.points.map(point => ({ ...point })) }]))
    view.unmount()
    renderPlanner(view.client)
    await act(async () => request.resolve(planning()))
    await ready()
    expect(planBinHeight).toHaveBeenCalledTimes(1)
  })

  it.each(['config', 'tools'] as const)('invalidates old fit immediately when %s change and ignores late responses', async changed => {
    const view = renderPlanner()
    await ready()
    const oldRefresh = deferred()
    const current = deferred()
    vi.mocked(planBinHeight).mockReturnValueOnce(oldRefresh.promise).mockReturnValueOnce(current.promise)
    fireEvent(window, new Event('focus'))
    await screen.findByRole('button', { name: 'Updating fit…' })
    vi.useFakeTimers()
    const config = { ...FACTORY_BIN_CONFIG, cutout_depth: 11 }
    const tools = [{ ...TOOL, depth_override: 11 }]
    view.rerender(view.panel(changed === 'config' ? config : FACTORY_BIN_CONFIG, changed === 'tools' ? tools : [TOOL]))
    expectCannotApply(view.onApply)
    expect(screen.queryByText('14 mm · 2 u')).toBeNull()
    await act(async () => {
      oldRefresh.resolve(planning(28))
      await vi.advanceTimersByTimeAsync(199)
    })
    expect(planBinHeight).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('28 mm · 4 u')).toBeNull()
    expectCannotApply(view.onApply)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    await act(async () => {
      current.resolve(planning(21, changed === 'config' ? config : FACTORY_BIN_CONFIG, changed === 'tools' ? tools : [TOOL]))
      await vi.advanceTimersByTimeAsync(1)
    })
    vi.useRealTimers()
    await screen.findByText('21 mm · 3 u')
    fireEvent.click(screen.getByRole('button', { name: 'Auto-set bin height' }))
    await waitFor(() => expect(view.onApply).toHaveBeenCalledWith(expect.objectContaining({
      bin_config: expect.objectContaining({ height_units: 4, ...(changed === 'config' ? { cutout_depth: 11 } : {}) }),
      placed_tools: changed === 'tools' ? tools : [TOOL],
    })))
  })

  it('debounces a quick return to a cached draft before allowing its refreshed proposal', async () => {
    const view = renderPlanner()
    await ready()
    const refresh = deferred()
    vi.mocked(planBinHeight).mockReturnValue(refresh.promise)
    vi.useFakeTimers()
    view.rerender(view.panel({ ...FACTORY_BIN_CONFIG, cutout_depth: 11 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    view.rerender(view.panel({ ...FACTORY_BIN_CONFIG }))
    expect(screen.getByText('14 mm · 2 u')).toBeTruthy()
    expectCannotApply(view.onApply)
    await act(async () => { await vi.advanceTimersByTimeAsync(199) })
    expect(planBinHeight).toHaveBeenCalledTimes(1)
    expectCannotApply(view.onApply)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(planBinHeight).toHaveBeenCalledTimes(2)
    await act(async () => {
      refresh.resolve(planning(21))
      await vi.advanceTimersByTimeAsync(1)
    })
    vi.useRealTimers()
    await screen.findByText('21 mm · 3 u')
    fireEvent.click(screen.getByRole('button', { name: 'Auto-set bin height' }))
    await waitFor(() => expect(view.onApply).toHaveBeenCalledWith(expect.objectContaining({ bin_config: expect.objectContaining({ height_units: 4 }) })))
  })

  it('reports application failures and permits retrying the current verified proposal', async () => {
    const view = renderPlanner()
    await ready()
    view.onApply.mockRejectedValueOnce(new Error('Could not save height'))
    fireEvent.click(screen.getByRole('button', { name: 'Auto-set bin height' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not save height')
    fireEvent.click(screen.getByRole('button', { name: 'Auto-set bin height' }))
    await waitFor(() => expect(view.onApply).toHaveBeenCalledTimes(2))
    expect(screen.getByText('14 mm · 2 u')).toBeTruthy()
  })

  it('keeps known values and removal usable after a failed refresh, without applying unverified fit', async () => {
    const view = renderPlanner()
    await ready()
    vi.mocked(planBinHeight).mockRejectedValue(new Error('Shared tool refresh failed'))
    fireEvent(window, new Event('focus'))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Shared tool refresh failed')
    expect(screen.getByText('14 mm · 2 u')).toBeTruthy()
    expectCannotApply(view.onApply)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Wrench from bin' }))
    expect(view.onRemove).toHaveBeenCalledWith(TOOL.id)
    vi.mocked(planBinHeight).mockResolvedValue(planning(21))
    fireEvent(window, new Event('focus'))
    await screen.findByText('21 mm · 3 u')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
