// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PolygonEditor } from './PolygonEditor'
import { ToolCaptureAdvice } from './ToolCaptureAdvice'
import type { CaptureFrame, Polygon } from '@/types'

beforeEach(() => {
  vi.stubGlobal('Image', class {
    naturalWidth = 1000
    naturalHeight = 800
    onload: (() => void) | null = null
    set src(_value: string) { this.onload?.() }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([false, true])('visibly highlights an included outline from named advice without altering selection or editing (active=%s)', async active => {
  const polygons: Polygon[] = [{
    id: 'pliers', label: 'Pliers', finger_holes: [], interior_rings: [],
    points: [{ x: 400, y: 300 }, { x: 600, y: 300 }, { x: 500, y: 500 }],
  }, {
    id: 'wrench', label: 'Wrench', finger_holes: [], interior_rings: [],
    points: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }],
  }]
  const included = new Set(polygons.map(polygon => polygon.id))
  const frame: CaptureFrame = {
    source_width: 1000, source_height: 800,
    corrected_to_source: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    optical_center: { x: 500, y: 400 }, full_frame_width: 1000, full_frame_height: 800,
  }
  const changed = vi.fn()
  const inclusionChanged = vi.fn()
  function EditorWithAdvice() {
    const [hovered, setHovered] = useState<string | null>(null)
    return <>
      <ToolCaptureAdvice polygons={polygons} captureFrame={frame}
        hoveredPolygon={hovered} onHoveredChange={setHovered} />
      <PolygonEditor imageUrl="/capture.png" polygons={polygons}
        included={included} onIncludedChange={inclusionChanged}
        initialActiveId={active ? 'pliers' : null}
        hovered={hovered} onHoveredChange={setHovered} onPolygonsChange={changed} />
    </>
  }
  const { container } = render(<EditorWithAdvice />)
  await waitFor(() => expect(container.querySelector('svg image')).not.toBeNull())
  const outlines = container.querySelectorAll('svg:has(image) > g > path.cursor-pointer')
  const target = outlines[0]
  const neighbor = outlines[1]
  const originalStroke = target.getAttribute('stroke')
  const originalWidth = Number(target.getAttribute('stroke-width'))
  const originalPath = target.getAttribute('d')
  const neighborStroke = neighbor.getAttribute('stroke')
  const neighborWidth = neighbor.getAttribute('stroke-width')
  const vertexCount = container.querySelectorAll('circle[fill="transparent"]').length
  expect(vertexCount).toBe(active ? 3 : 0)
  const advice = screen.getByRole('button', { name: 'Highlight Pliers outline' })

  function expectHighlight() {
    expect(target.getAttribute('stroke')).not.toBe(originalStroke)
    expect(Number(target.getAttribute('stroke-width'))).toBeGreaterThan(originalWidth)
    expect(neighbor.getAttribute('stroke')).toBe(neighborStroke)
    expect(neighbor.getAttribute('stroke-width')).toBe(neighborWidth)
    expect(target.getAttribute('d')).toBe(originalPath)
    expect(container.querySelectorAll('circle[fill="transparent"]').length).toBe(vertexCount)
    expect(changed).not.toHaveBeenCalled()
    expect(inclusionChanged).not.toHaveBeenCalled()
    expect([...included]).toEqual(['pliers', 'wrench'])
  }

  fireEvent.mouseEnter(advice)
  expectHighlight()
  fireEvent.mouseLeave(advice)
  expect(target.getAttribute('stroke')).toBe(originalStroke)
  expect(Number(target.getAttribute('stroke-width'))).toBe(originalWidth)
  act(() => advice.focus())
  expect(document.activeElement).toBe(advice)
  expectHighlight()
  // Leaving a focused control must not erase keyboard outline linkage.
  fireEvent.mouseLeave(advice)
  expectHighlight()
  fireEvent.click(advice)
  expectHighlight()
  act(() => advice.blur())
  expect(target.getAttribute('stroke')).toBe(originalStroke)
  expect(Number(target.getAttribute('stroke-width'))).toBe(originalWidth)
  expect(container.querySelectorAll('circle[fill="transparent"]').length).toBe(vertexCount)
  expect(changed).not.toHaveBeenCalled()
  expect(inclusionChanged).not.toHaveBeenCalled()
})
