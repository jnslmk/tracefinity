// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { PlacedTool } from '@/types'
import { BinEditor } from './BinEditor'
import { SNAP_GRID } from '@/lib/constants'

const baseProps = {
  placedTools: [],
  onPlacedToolsChange: () => {},
  textLabels: [],
  onTextLabelsChange: () => {},
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
  const fetchMock = vi.fn(() => promise)
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    finish: async (unfitted: string[] = [], ok = true) => {
      await act(async () => {
        resolve({
          ok,
          json: async () => ok ? {
            placements: [{ tool_id: tool.tool_id, name: tool.name, x: 2, y: 3, rotation: 90 }],
            bounds: [2, 3, 12, 23], efficiency: 1, unfitted_tool_ids: unfitted,
          } : { detail: 'Packing service unavailable' },
        } as Response)
      })
    },
  }
}

describe('BinEditor auto-arrange feedback', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('shows pending work, applies overflow safely, and clears the last-run warning on a fitting rerun', async () => {
    function Editor({ gridX = 2 }: { gridX?: number }) {
      const [tools, setTools] = useState([tool])
      return <BinEditor {...baseProps} gridX={gridX} placedTools={tools} onPlacedToolsChange={setTools} />
    }
    const request = pendingResponse()
    const { rerender } = render(<Editor />)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange' }))
    expect(screen.getByRole('status').textContent).toContain('Finding an efficient layout')
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
})
