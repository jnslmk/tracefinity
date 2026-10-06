// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DrawerSketchCanvas } from '@/components/DrawerSketchCanvas'

afterEach(cleanup)

it('draws the whole offset, non-cardinal floor grid beyond the legacy rectangle', () => {
  // An 84x84mm floor in grid-local [-42,42] x [-21,63], turned 30 degrees
  // about (63,42). Literal drawer-space vertices keep this fixture independent
  // of the production transform used to derive scan/render bounds.
  const outline = {
    points: [
      { x: 37.1269330411, y: 2.8134665205 },
      { x: 109.8730669589, y: 44.8134665205 },
      { x: 67.8730669589, y: 117.5596004384 },
      { x: -4.8730669589, y: 75.5596004384 },
    ],
    interior_rings: [],
  }
  const { container } = render(createElement(DrawerSketchCanvas, {
    bins: new Map(), placements: [], drawerX: 1, drawerY: 1,
    selectedPlacementId: null, overlapping: new Set<string>(), outOfBounds: new Set<string>(),
    onSelect: vi.fn(), onMove: vi.fn(), onDropBin: vi.fn(),
    outline, gridOriginMm: { x: 63, y: 42 }, gridRotationDeg: 30,
  }))
  const lines = [...container.querySelectorAll('line')]
  const vertical = lines.filter(line => line.getAttribute('x1') === line.getAttribute('x2'))
  const horizontal = lines.filter(line => line.getAttribute('y1') === line.getAttribute('y2'))
  expect(Math.min(...vertical.map(line => Number(line.getAttribute('x1'))))).toBeCloseTo(-42)
  expect(Math.max(...vertical.map(line => Number(line.getAttribute('x1'))))).toBeCloseTo(42)
  for (const line of vertical) {
    expect(Number(line.getAttribute('y1'))).toBeCloseTo(-21)
    expect(Number(line.getAttribute('y2'))).toBeCloseTo(63)
  }
  expect(Math.min(...horizontal.map(line => Number(line.getAttribute('y1'))))).toBeCloseTo(-21)
  expect(Math.max(...horizontal.map(line => Number(line.getAttribute('y1'))))).toBeCloseTo(63)
  expect(container.querySelector('g[clip-path]')).not.toBeNull()
  expect(container.querySelector('g[transform]')?.getAttribute('transform')).toBe('translate(63 42) rotate(30)')
})
