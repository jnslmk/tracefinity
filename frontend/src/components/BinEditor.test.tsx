// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { AccessPocket, PlacedTool } from '@/types'
import { BinEditor } from './BinEditor'
import { SNAP_GRID } from '@/lib/constants'
import type { GridSizingMode } from '@/lib/constants'

const baseProps = {
  placedTools: [],
  onPlacedToolsChange: () => {},
  textLabels: [],
  onTextLabelsChange: () => {},
  accessPockets: [],
  onAccessPocketsChange: () => {},
  gridX: 2,
  gridY: 2,
  partialBins: false,
  partialBinsValues: [false, false],
  wallThickness: 1.6,
  defaultCutoutDepth: 10,
  maxCutoutDepth: 20,
}

describe('BinEditor snap to grid', () => {
  afterEach(cleanup)

  it('defaults to off', () => {
    render(<BinEditor {...baseProps} />)

    expect(screen.getByTitle(`Snap to ${SNAP_GRID}mm grid (off)`)).toBeTruthy()
  })

  it('can be toggled on', () => {
    render(<BinEditor {...baseProps} />)

    fireEvent.click(screen.getByTitle(`Snap to ${SNAP_GRID}mm grid (off)`))

    expect(screen.getByTitle(`Snap to ${SNAP_GRID}mm grid (on)`)).toBeTruthy()
  })
})

const tool: PlacedTool = {
  id: 'placed-tool',
  tool_id: 'library-tool',
  name: 'Wrench',
  points: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 20 }, { x: 10, y: 20 }],
  rotation: 0,
  finger_holes: [{ id: 'hole', x: 15, y: 15, radius: 2, shape: 'cylinder' }],
  interior_rings: [[{ x: 12, y: 12 }, { x: 14, y: 12 }, { x: 14, y: 14 }]],
}

function pendingResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  const fetchMock = vi.fn<typeof fetch>(() => promise)
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    finish: async (
      unfitted: string[] = [], ok = true, gridX: number | null = null,
      placements: { tool_id: string; placement_id?: string; name: string; x: number; y: number; rotation: number }[] = [
        { tool_id: tool.tool_id, name: tool.name, x: 2, y: 3, rotation: 90 },
      ],
      unfittedPlacementIds?: string[],
    ) => {
      await act(async () => {
        resolve({
          ok,
          json: async () => ok ? {
            placements,
            bounds: [2, 3, 12, 23], efficiency: 1, unfitted_tool_ids: unfitted,
            unfitted_placement_ids: unfittedPlacementIds,
            grid_x: gridX,
          } : { detail: 'Packing service unavailable' },
        } as Response)
      })
    },
  }
}

describe('BinEditor auto-arrange feedback', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('counts down the submitted budget without treating its expiry as completion and resets on retry', async () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    const request = pendingResponse()
    render(<BinEditor {...baseProps} placedTools={[tool]} onPlacedToolsChange={onChange} />)
    fireEvent.click(screen.getByText('Advanced'))
    const budget = screen.getByLabelText('Compute time (seconds)')
    fireEvent.change(budget, { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    const progress = screen.getByRole('progressbar', { name: 'Estimated compute time elapsed' }) as HTMLProgressElement
    expect(progress.max).toBe(2)
    expect(progress.value).toBe(0)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(progress.value).toBe(1)
    fireEvent.change(budget, { target: { value: '10' } })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(progress.value).toBe(2)
    expect(progress.max).toBe(2)
    expect(screen.getByRole('button', { name: 'Arranging…' }).hasAttribute('disabled')).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
    await request.finish()
    expect(screen.queryByRole('progressbar')).toBeNull()
    const retry = pendingResponse()
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    const fresh = screen.getByRole('progressbar') as HTMLProgressElement
    expect(fresh.max).toBe(10)
    expect(fresh.value).toBe(0)
    await retry.finish([], false)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows pending work, applies overflow safely, and clears the last-run warning on a fitting rerun', async () => {
    function Editor({ gridX = 2 }: { gridX?: number }) {
      const [tools, setTools] = useState([tool])
      return <BinEditor {...baseProps} gridX={gridX} placedTools={tools} onPlacedToolsChange={setTools} />
    }
    const request = pendingResponse()
    const { rerender } = render(<Editor />)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Arranging…' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Arranging…' }))
    expect(request.fetchMock).toHaveBeenCalledTimes(1)
    await request.finish([tool.tool_id])
    const warning = screen.getByRole('status')
    expect(warning.textContent).toContain('2 × 2')
    expect(warning.textContent).toContain('1 tool')
    expect(warning.textContent).toContain('Wrench')
    expect(warning.textContent).toContain('Increase the grid size or remove tools')
    rerender(<Editor gridX={3} />)
    expect(screen.getByRole('status').textContent).toContain('requested 2 × 2 grid')

    const fitting = pendingResponse()
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    await fitting.finish()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Auto-arrange' }).hasAttribute('disabled')).toBe(false)
  })

  it('retains tool geometry on failure and allows another attempt', async () => {
    const onChange = vi.fn()
    const request = pendingResponse()
    render(<BinEditor {...baseProps} placedTools={[tool]} onPlacedToolsChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    await request.finish([], false)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Packing service unavailable')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Auto-arrange' }).hasAttribute('disabled')).toBe(false)
  })

  it.each(['', '-1', '1e309'])('keeps the layout and blocks invalid padding %j until corrected', async value => {
    const onChange = vi.fn()
    const request = pendingResponse()
    render(<BinEditor {...baseProps} placedTools={[tool]} onPlacedToolsChange={onChange} />)
    const padding = screen.getByRole('spinbutton', { name: 'Tool padding (mm)' })
    fireEvent.change(padding, { target: { value } })
    expect(padding.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('Enter a finite number of 0 or more')
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    expect(request.fetchMock).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(padding, { target: { value: '0' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    await request.finish()
    expect(onChange.mock.calls[0][0][0].points[0]).toEqual({ x: 12, y: 3 })
    expect(JSON.parse(String(request.fetchMock.mock.calls[0][1]?.body)).clearance).toBe(0)
  })

  it.each([true, false])('discards a stale padding result (success: %s) and applies a fresh run', async ok => {
    const onChange = vi.fn()
    const stale = pendingResponse()
    render(<BinEditor {...baseProps} placedTools={[tool]} onPlacedToolsChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tool padding (mm)' }), { target: { value: '4.5' } })
    await stale.finish([tool.tool_id], ok)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    const fresh = pendingResponse()
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    await fresh.finish()
    expect(onChange.mock.calls[0][0][0].rotation).toBe(90)
    expect(JSON.parse(String(fresh.fetchMock.mock.calls[0][1]?.body)).clearance).toBe(4.5)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each(['', '0.49', '60.01', '1e309'])('keeps the layout and blocks invalid compute time %j until corrected', async value => {
    const onChange = vi.fn()
    const request = pendingResponse()
    render(<BinEditor {...baseProps} placedTools={[tool]} onPlacedToolsChange={onChange} />)
    // jsdom does not activate native popovers; exercise draft state via its label.
    const budget = screen.getByLabelText('Compute time (seconds)')
    fireEvent.change(budget, { target: { value } })
    expect(budget.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('button', { name: 'Auto-arrange' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('alert', { hidden: true })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    expect(request.fetchMock).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(budget, { target: { value: '0.5' } })
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    await request.finish()
    expect(onChange.mock.calls[0][0][0].points[0]).toEqual({ x: 12, y: 3 })
  })

  it.each([
    ['Algorithm', 'raster', true],
    ['Algorithm', 'packingsolver', false],
    ['Compute time (seconds)', '60', true],
    ['Compute time (seconds)', '', false],
  ] as const)('discards pending results after changing %s to %j (success: %s)', async (label, value, ok) => {
    const onChange = vi.fn()
    const stale = pendingResponse()
    render(<BinEditor {...baseProps} placedTools={[tool]} onPlacedToolsChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    const control = screen.getByLabelText(label)
    fireEvent.change(control, { target: { value } })
    await stale.finish([tool.tool_id], ok)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/Packing service unavailable/)).toBeNull()
    if (value === '') {
      expect(screen.getByRole('alert', { hidden: true })).toBeTruthy()
      expect(control.getAttribute('aria-invalid')).toBe('true')
    } else {
      expect(screen.queryByRole('alert', { hidden: true })).toBeNull()
    }

    if (value === '') fireEvent.change(control, { target: { value: '5' } })
    const fresh = pendingResponse()
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    await fresh.finish()
    expect(onChange.mock.calls[0][0][0].rotation).toBe(90)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each(['grid', 'layout'])('discards late results after the %s changes', async change => {
    const onChange = vi.fn()
    const request = pendingResponse()
    const tools = [tool]
    const { rerender } = render(<BinEditor {...baseProps} placedTools={tools} onPlacedToolsChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    rerender(<BinEditor {...baseProps} gridX={change === 'grid' ? 3 : 2}
      placedTools={change === 'layout' ? [{ ...tool, rotation: 45 }] : tools} onPlacedToolsChange={onChange} />)
    await request.finish([tool.tool_id])
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Auto-arrange' }).hasAttribute('disabled')).toBe(false)
  })

  it('rotates and translates pockets and rings with the packed outline', async () => {
    const onChange = vi.fn()
    const request = pendingResponse()
    render(<BinEditor {...baseProps} placedTools={[tool]} onPlacedToolsChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    await request.finish()
    const arranged: PlacedTool = onChange.mock.calls[0][0][0]
    expect(arranged.rotation).toBe(90)
    expect(arranged.points[0].x).toBeCloseTo(12)
    expect(arranged.points[0].y).toBeCloseTo(3)
    expect(arranged.finger_holes[0].x).toBeCloseTo(7)
    expect(arranged.finger_holes[0].y).toBeCloseTo(8)
    expect(arranged.interior_rings[0][0].x).toBeCloseTo(10)
    expect(arranged.interior_rings[0][0].y).toBeCloseTo(5)
  })

  it('keeps pinned geometry intact while packing other tools and accepting fixed-depth width', async () => {
    const anchor: PlacedTool = { ...tool, id: 'anchor', tool_id: 'anchor-library', name: 'Anchor', pinned: true, rotation: 37 }
    const onArrange = vi.fn()
    const request = pendingResponse()
    render(<BinEditor {...baseProps} placedTools={[anchor, tool]} gridSizingMode="fixed_depth" onAutoArrange={onArrange} />)
    expect(screen.getByRole('img', { name: 'Anchor: pinned for auto-arrange' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Recenter' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    const body = JSON.parse(request.fetchMock.mock.calls[0][1]!.body as string)
    expect(body.fixed_placements).toEqual([{ tool_id: 'anchor-library', placement_id: 'anchor', x: 10, y: 10, rotation: 37 }])
    await request.finish([], true, 4.5, [
      { tool_id: anchor.tool_id, name: anchor.name, x: 40, y: 50, rotation: 0 },
      { tool_id: tool.tool_id, name: tool.name, x: 2, y: 3, rotation: 90 },
    ])
    const [updated, width] = onArrange.mock.calls[0]
    expect(width).toBe(4.5)
    expect(updated[0]).toBe(anchor)
    expect(updated[0].points).toBe(anchor.points)
    expect(updated[0].finger_holes).toBe(anchor.finger_holes)
    expect(updated[0].interior_rings).toBe(anchor.interior_rings)
    expect(updated[1].rotation).toBe(90)
    expect(updated[1].points[0]).toEqual({ x: 12, y: 3 })
  })

  it('pins repeated library copies independently and arranges only the released instance', async () => {
    const first = { ...tool, id: 'first-copy' }
    const second = {
      ...tool, id: 'second-copy',
      points: tool.points.map(point => ({ x: point.x + 25, y: point.y })),
      finger_holes: tool.finger_holes.map(hole => ({ ...hole, x: hole.x + 25 })),
      interior_rings: tool.interior_rings.map(ring => ring.map(point => ({ x: point.x + 25, y: point.y }))),
    }
    const third = { ...tool, id: 'third-tool', tool_id: 'other-library', name: 'Hammer' }
    const changed = vi.fn()
    function Editor() {
      const [tools, setTools] = useState([first, second, third])
      const update = (next: PlacedTool[]) => { changed(next); setTools(next) }
      return <BinEditor {...baseProps} placedTools={tools} onPlacedToolsChange={update} onAutoArrange={update} />
    }
    const request = pendingResponse()
    const { container } = render(<Editor />)
    const select = (index: number) => {
      fireEvent.mouseDown(container.querySelectorAll('path.cursor-move')[index])
      fireEvent.mouseUp(window)
    }
    select(0)
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    select(1)
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    expect(changed.mock.lastCall![0].map((copy: PlacedTool) => !!copy.pinned)).toEqual([true, true, false])
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    const pinnedBody = JSON.parse(request.fetchMock.mock.calls[0][1]!.body as string)
    expect(pinnedBody.placement_ids).toEqual(['first-copy', 'second-copy', 'third-tool'])
    expect(pinnedBody.fixed_placements.map((pin: { placement_id: string }) => pin.placement_id)).toEqual(['first-copy', 'second-copy'])
    await request.finish([], true, null, [
      { tool_id: third.tool_id, placement_id: third.id, name: third.name, x: 40, y: 30, rotation: 0 },
    ])
    const bothPinned = changed.mock.lastCall![0]
    expect(bothPinned[0].points).toBe(first.points)
    expect(bothPinned[1].points).toBe(second.points)
    expect(bothPinned[2].points[0]).toEqual({ x: 40, y: 30 })

    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }))
    const before = changed.mock.lastCall![0]
    expect(before.map((copy: PlacedTool) => !!copy.pinned)).toEqual([true, false, false])
    const released = pendingResponse()
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    const releasedBody = JSON.parse(released.fetchMock.mock.calls[0][1]!.body as string)
    expect(releasedBody.fixed_placements).toEqual([
      { tool_id: tool.tool_id, placement_id: first.id, x: 10, y: 10, rotation: 0 },
    ])
    await released.finish([], true, null, [
      { tool_id: tool.tool_id, placement_id: second.id, name: tool.name, x: 2, y: 3, rotation: 90 },
      { tool_id: third.tool_id, placement_id: third.id, name: third.name, x: 45, y: 35, rotation: 0 },
      { tool_id: tool.tool_id, placement_id: first.id, name: tool.name, x: 60, y: 60, rotation: 180 },
    ])
    const arranged = changed.mock.lastCall![0]
    expect(arranged[0]).toBe(before[0])
    expect(arranged[1].rotation).toBe(90)
    expect(arranged[1].points[0]).toEqual({ x: 12, y: 3 })
    expect(arranged[1].finger_holes[0]).toMatchObject({ x: 7, y: 8 })
    expect(arranged[1].interior_rings[0][0]).toEqual({ x: 10, y: 5 })
    expect(arranged[2].points[0]).toEqual({ x: 45, y: 35 })
  })

  it('reports only the unfitted instance when another copy of its library tool fits', async () => {
    const copy = { ...tool, id: 'unfitted-copy', name: 'Spare wrench' }
    const onArrange = vi.fn()
    const request = pendingResponse()
    render(<BinEditor {...baseProps} placedTools={[tool, copy]} onAutoArrange={onArrange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    await request.finish([tool.tool_id], true, null, [
      { tool_id: tool.tool_id, placement_id: tool.id, name: tool.name, x: 2, y: 3, rotation: 90 },
      { tool_id: copy.tool_id, placement_id: copy.id, name: copy.name, x: 90, y: 3, rotation: 0 },
    ], [copy.id])
    const updated = onArrange.mock.calls[0][0]
    expect(updated[0].rotation).toBe(90)
    expect(updated[1].points[0]).toEqual({ x: 90, y: 3 })
    expect(screen.getByRole('status').textContent).toContain('1 tool')
    expect(screen.getByRole('status').textContent).toContain('Spare wrench')
    expect(screen.getByRole('status').textContent).not.toContain('Wrench')
  })

  it('pin and unpin toggles invalidate an arrangement that was already pending', async () => {
    const onArrange = vi.fn()
    function Editor() {
      const [tools, setTools] = useState([tool])
      return <BinEditor {...baseProps} placedTools={tools} onPlacedToolsChange={setTools} onAutoArrange={onArrange} />
    }
    const request = pendingResponse()
    const { container } = render(<Editor />)
    fireEvent.mouseDown(container.querySelector('path.cursor-move')!)
    fireEvent.mouseUp(window)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    expect(screen.getByRole('button', { name: 'Unpin' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('img', { name: 'Wrench: pinned for auto-arrange' })).toBeTruthy()
    await request.finish()
    expect(onArrange).not.toHaveBeenCalled()
    const next = pendingResponse()
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }))
    await next.finish()
    expect(onArrange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Pin' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('img', { name: 'Wrench: pinned for auto-arrange' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Recenter' }).hasAttribute('disabled')).toBe(false)
  })

  it('allows pinned tools to be dragged and rotated and rejects a result during a pending drag frame', async () => {
    const onArrange = vi.fn()
    let frame!: FrameRequestCallback
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const onChange = vi.fn()
    function Editor() {
      const [tools, setTools] = useState<PlacedTool[]>([{ ...tool, pinned: true }])
      return <BinEditor {...baseProps} placedTools={tools} onPlacedToolsChange={updated => { onChange(updated); setTools(updated) }} onAutoArrange={onArrange} />
    }
    const request = pendingResponse()
    const { container } = render(<Editor />)
    const svg = screen.getByTestId('bin-canvas')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 742, height: 702 } as DOMRect)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    fireEvent.mouseDown(container.querySelector('path.cursor-move')!, { clientX: 90, clientY: 90 })
    fireEvent.mouseMove(window, { clientX: 170, clientY: 130 })
    await request.finish()
    expect(onArrange).not.toHaveBeenCalled()
    act(() => frame(0))
    fireEvent.mouseUp(window)
    const dragged = onChange.mock.calls[0][0][0]
    expect(dragged.pinned).toBe(true)
    expect(dragged.points[0]).toEqual({ x: 20, y: 15 })
    expect(dragged.finger_holes[0]).toMatchObject({ x: 25, y: 20 })
    expect(dragged.interior_rings[0][0]).toEqual({ x: 22, y: 17 })
    // Rotate 90 degrees about the translated centroid (30, 20).
    fireEvent.mouseDown(container.querySelector('rect.cursor-rotate')!, { clientX: 330, clientY: 170 })
    fireEvent.mouseMove(window, { clientX: 250, clientY: 250 })
    act(() => frame(0))
    fireEvent.mouseUp(window)
    const rotated = onChange.mock.calls[1][0][0]
    expect(rotated.pinned).toBe(true)
    expect(rotated.rotation).toBeCloseTo(90)
    expect(rotated.points[0].x).toBeCloseTo(35)
    expect(rotated.points[0].y).toBeCloseTo(10)
  })

  it('applies the computed width with packed geometry and reports overflow against that width', async () => {
    function Editor() {
      const [tools, setTools] = useState([tool])
      const [gridX, setGridX] = useState(2)
      return <>
        <output aria-label="Grid dimensions">{gridX} × 2</output>
        <BinEditor {...baseProps} placedTools={tools} gridX={gridX} gridSizingMode="fixed_depth"
          halfGridBase stackingLip cutoutClearance={0.7}
          onAutoArrange={(updated, width) => { setTools(updated); setGridX(width!) }} />
      </>
    }
    const request = pendingResponse()
    render(<Editor />)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    await request.finish([tool.tool_id], true, 4.5)
    expect(screen.getByLabelText('Grid dimensions').textContent).toBe('4.5 × 2')
    const warning = screen.getByRole('status', { name: '' })
    expect(warning.textContent).toContain('4.5 × 2')
    expect(warning.textContent).toContain(tool.name)
  })

  it.each([
    ['mode', true], ['depth', true], ['mode', false], ['depth', false],
  ] as const)('rejects a pending auto-width result when %s changes (success: %s)', async (change, ok) => {
    const onArrange = vi.fn()
    const request = pendingResponse()
    const tools = [tool]
    const { rerender } = render(<BinEditor {...baseProps} placedTools={tools}
      gridSizingMode="fixed_depth" onAutoArrange={onArrange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    rerender(<BinEditor {...baseProps} placedTools={tools} gridY={change === 'depth' ? 3 : 2}
      gridSizingMode={(change === 'mode' ? 'fixed' : 'fixed_depth') as GridSizingMode} onAutoArrange={onArrange} />)
    await request.finish([tool.tool_id], ok, 4)
    expect(onArrange).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

const pocket = (over: Partial<AccessPocket> = {}): AccessPocket => ({
  id: 'p1', shape: 'rectangle', x: 21, y: 21, length: 30, width: 20, depth: 8,
  rotation: 0, edge: 'inherit', edge_size: 1, corner_radius: 0, bottom_radius: 0,
  ...over,
})

function PocketEditor({ initial = [] as AccessPocket[], onChange = () => {} }: {
  initial?: AccessPocket[]
  onChange?: (pockets: AccessPocket[]) => void
}) {
  const [pockets, setPockets] = useState(initial)
  return (
    <BinEditor
      {...baseProps}
      accessPockets={pockets}
      onAccessPocketsChange={next => { onChange(next); setPockets(next) }}
    />
  )
}

function frameController() {
  let frame!: FrameRequestCallback
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1 }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return () => act(() => frame(0))
}

describe('BinEditor access pockets', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('places a pocket at the clicked position when the pocket tool is active', () => {
    const onChange = vi.fn()
    vi.stubGlobal('PointerEvent', MouseEvent)
    render(<PocketEditor onChange={onChange} />)
    const svg = screen.getByTestId('bin-canvas')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 742, height: 702 } as DOMRect)
    fireEvent.click(screen.getByRole('button', { name: 'Pocket' }))
    fireEvent.pointerDown(svg, { clientX: 178, clientY: 178, button: 0 })
    fireEvent.pointerUp(window, { clientX: 178, clientY: 178 })
    fireEvent.click(svg, { clientX: 10 + 21 * 8, clientY: 10 + 21 * 8 })
    expect(onChange).toHaveBeenCalled()
    const added = onChange.mock.calls.at(-1)![0] as AccessPocket[]
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ shape: 'rectangle', x: 21, y: 21, length: 30, width: 20 })
    expect(screen.getByLabelText('Access pocket settings')).toBeTruthy()
  })

  it('previews a drawn pocket and commits the release dimensions once, in either direction', () => {
    const advanceFrame = frameController()
    vi.stubGlobal('PointerEvent', MouseEvent)
    const onChange = vi.fn()
    render(<PocketEditor onChange={onChange} />)
    const svg = screen.getByTestId('bin-canvas')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 742, height: 702 } as DOMRect)
    fireEvent.click(screen.getByRole('button', { name: 'Pocket' }))
    fireEvent.pointerDown(svg, { clientX: 410, clientY: 330, button: 0 })
    fireEvent.pointerMove(window, { clientX: 170, clientY: 90 })
    advanceFrame()
    expect(screen.getByText('30.0 × 30.0 mm')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
    // Release before the next animation frame: its coordinates must win.
    fireEvent.pointerMove(window, { clientX: 90, clientY: 170 })
    fireEvent.pointerUp(window, { clientX: 90, clientY: 170 })
    fireEvent.click(svg, { clientX: 90, clientY: 170 })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0][0]).toMatchObject({
      x: 30, y: 30, length: 40, width: 20, shape: 'rectangle',
    })
    expect((screen.getByLabelText('Length (mm)') as HTMLInputElement).value).toBe('40')
  })

  it.each(['escape', 'pointercancel'])('discards an unfinished pocket on %s', cancel => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const onChange = vi.fn()
    render(<PocketEditor onChange={onChange} />)
    const svg = screen.getByTestId('bin-canvas')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 742, height: 702 } as DOMRect)
    fireEvent.click(screen.getByRole('button', { name: 'Pocket' }))
    fireEvent.pointerDown(svg, { clientX: 170, clientY: 170, button: 0 })
    if (cancel === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.pointerCancel(window)
    fireEvent.pointerUp(window, { clientX: 330, clientY: 330 })
    expect(onChange).not.toHaveBeenCalled()
    expect(svg.querySelector('[data-testid^="access-pocket-group-"]')).toBeNull()
  })

  it('snaps drawn corners, clamps the endpoint to the bin and keeps a thin drag usable', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const onChange = vi.fn()
    render(<PocketEditor onChange={onChange} />)
    const svg = screen.getByTestId('bin-canvas')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 742, height: 702 } as DOMRect)
    fireEvent.click(screen.getByTitle(`Snap to ${SNAP_GRID}mm grid (off)`))
    fireEvent.click(screen.getByRole('button', { name: 'Pocket' }))
    fireEvent.pointerDown(svg, { clientX: 10 + 21 * 8, clientY: 10 + 22 * 8, button: 0 })
    fireEvent.pointerUp(window, { clientX: 10 + 100 * 8, clientY: 10 + 22 * 8 })
    expect(onChange.mock.calls[0][0][0]).toMatchObject({ x: 52, y: 20, length: 64, width: 1 })
  })

  it('selects a pocket and edits it through the controls', () => {
    const onChange = vi.fn()
    render(<PocketEditor initial={[pocket()]} onChange={onChange} />)
    fireEvent.mouseDown(screen.getByTestId('access-pocket-p1'))
    fireEvent.mouseUp(window)
    const length = screen.getByLabelText('Length (mm)')
    fireEvent.change(length, { target: { value: '40' } })
    fireEvent.blur(length)
    expect(onChange.mock.calls.at(-1)![0][0].length).toBe(40)
  })

  it('moves a pocket with the mouse', () => {
    const advanceFrame = frameController()
    const onChange = vi.fn()
    render(<PocketEditor initial={[pocket({ x: 21, y: 21 })]} onChange={onChange} />)
    const svg = screen.getByTestId('bin-canvas')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 742, height: 702 } as DOMRect)
    fireEvent.mouseDown(screen.getByTestId('access-pocket-p1'), { clientX: 10 + 21 * 8, clientY: 10 + 21 * 8 })
    fireEvent.mouseMove(window, { clientX: 10 + 31 * 8, clientY: 10 + 21 * 8 })
    advanceFrame()
    fireEvent.mouseUp(window)
    expect(onChange.mock.calls.at(-1)![0][0]).toMatchObject({ x: 31, y: 21 })
  })

  it('resizes a pocket from a corner handle with the opposite corner fixed', () => {
    const advanceFrame = frameController()
    const onChange = vi.fn()
    render(<PocketEditor initial={[pocket()]} onChange={onChange} />)
    const svg = screen.getByTestId('bin-canvas')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 742, height: 702 } as DOMRect)
    fireEvent.mouseDown(screen.getByTestId('access-pocket-p1'))
    fireEvent.mouseUp(window)
    const handle = screen.getByTestId('access-pocket-resize-p1-2')
    fireEvent.mouseDown(handle, { clientX: 10 + 36 * 8, clientY: 10 + 31 * 8 })
    fireEvent.mouseMove(window, { clientX: 10 + 46 * 8, clientY: 10 + 36 * 8 })
    advanceFrame()
    fireEvent.mouseUp(window)
    const resized = onChange.mock.calls.at(-1)![0][0] as AccessPocket
    expect(resized.length).toBeCloseTo(40)
    expect(resized.width).toBeCloseTo(25)
  })

  it('rotates a pocket about its centre', () => {
    const advanceFrame = frameController()
    const onChange = vi.fn()
    render(<PocketEditor initial={[pocket({ x: 42, y: 42 })]} onChange={onChange} />)
    const svg = screen.getByTestId('bin-canvas')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 742, height: 702 } as DOMRect)
    fireEvent.mouseDown(screen.getByTestId('access-pocket-p1'))
    fireEvent.mouseUp(window)
    fireEvent.mouseDown(screen.getByTestId('access-pocket-rotate-p1'), { clientX: 10 + 52 * 8, clientY: 10 + 42 * 8 })
    fireEvent.mouseMove(window, { clientX: 10 + 42 * 8, clientY: 10 + 52 * 8 })
    advanceFrame()
    fireEvent.mouseUp(window)
    expect(onChange.mock.calls.at(-1)![0][0].rotation).toBeCloseTo(90)
  })

  it('persists an edited shallow scoop depth through the duplicate and shape-switch flow', () => {
    const onChange = vi.fn()
    render(<PocketEditor initial={[pocket({ depth: 12, corner_radius: 3, bottom_radius: 4, rotation: 20 })]} onChange={onChange} />)
    const commit = (label: string, value: string) => {
      const input = screen.getByLabelText(label)
      fireEvent.change(input, { target: { value } })
      fireEvent.blur(input)
    }
    fireEvent.mouseDown(screen.getByTestId('access-pocket-p1'))
    fireEvent.mouseUp(window)
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rounded scoop' }))
    commit('Length (mm)', '42')
    commit('Depth (mm)', '8')
    const pockets = onChange.mock.calls.at(-1)![0] as AccessPocket[]
    const scoop = pockets.find(value => value.shape === 'scoop')!
    expect(scoop.depth).toBe(8)
    expect(scoop.length).toBe(42)
  })

  it('duplicates and deletes the selected pocket', () => {
    const onChange = vi.fn()
    render(<PocketEditor initial={[pocket()]} onChange={onChange} />)
    fireEvent.mouseDown(screen.getByTestId('access-pocket-p1'))
    fireEvent.mouseUp(window)
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(onChange.mock.calls.at(-1)![0]).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onChange.mock.calls.at(-1)![0]).toHaveLength(1)
  })
})
