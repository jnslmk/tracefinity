// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DrawerOutlineEditor } from './DrawerOutlineEditor'
import type { Polygon } from '@/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.stubGlobal('Image', class {
    naturalWidth = 1000
    naturalHeight = 750
    onload: (() => void) | null = null
    set src(_value: string) { this.onload?.() }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 750, width: 1000, height: 750,
    toJSON: () => ({}),
  })
})

it('lets the floor boundary be dragged immediately and undone without allowing its deletion', async () => {
  const original: Polygon[] = [{
    id: 'drawer-outline', label: 'Floor', finger_holes: [], interior_rings: [],
    points: [{ x: 100, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 650 }, { x: 100, y: 650 }],
  }]
  const changed = vi.fn()
  function Editor() {
    const [polygons, setPolygons] = useState(original)
    return <DrawerOutlineEditor imageUrl="/floor.jpg" polygons={polygons}
      onPolygonsChange={next => { changed(next); setPolygons(next) }}
      scaleFactor={0.4} seed={null} createExclusion={() => null} resetOutline={() => original} />
  }
  const { container } = render(<Editor />)
  await waitFor(() => expect(container.querySelector('circle[fill="transparent"]')).not.toBeNull())
  // jsdom has no SVG screen transform; exercise the editor's rectangle mapping.
  Object.defineProperty(container.querySelector('svg:has(image)'), 'getScreenCTM', { value: () => null })
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  fireEvent.mouseDown(container.querySelector('circle[fill="transparent"]')!, { button: 0 })
  fireEvent.mouseMove(window, { clientX: 250, clientY: 200 })
  fireEvent.mouseUp(window)
  expect(changed.mock.lastCall?.[0][0].points).toEqual([
    { x: 250, y: 200 }, { x: 900, y: 100 }, { x: 900, y: 650 }, { x: 100, y: 650 },
  ])
  fireEvent.click(screen.getByTitle('Undo (Ctrl+Z)'))
  expect(changed.mock.lastCall?.[0]).toEqual(original)
})

it('adds obstruction vertices, ignores Delete in inputs, and undoes deletion without deleting the floor', async () => {
  const floor: Polygon = {
    id: 'drawer-outline', label: 'Floor', finger_holes: [], interior_rings: [],
    points: [{ x: 100, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 650 }, { x: 100, y: 650 }],
  }
  const obstruction: Polygon = {
    id: 'obstruction', label: 'Obstruction', finger_holes: [], interior_rings: [],
    points: [{ x: 300, y: 300 }, { x: 700, y: 300 }, { x: 700, y: 500 }, { x: 300, y: 500 }],
  }
  const changed = vi.fn()
  function Editor() {
    const [polygons, setPolygons] = useState([floor])
    return <>
      <input aria-label="Clearance" />
      <DrawerOutlineEditor imageUrl="/floor.jpg" polygons={polygons}
        onPolygonsChange={next => { changed(next); setPolygons(next) }}
        scaleFactor={0.4} seed={null} createExclusion={next => [...next, obstruction]} resetOutline={() => [floor]} />
    </>
  }
  const { container } = render(<Editor />)
  await waitFor(() => expect(container.querySelector('svg image')).not.toBeNull())
  Object.defineProperty(container.querySelector('svg:has(image)'), 'getScreenCTM', { value: () => null })
  fireEvent.click(screen.getByRole('button', { name: 'Add obstruction' }))
  expect(container.querySelector('circle[fill="transparent"]')?.getAttribute('cx')).toBe('300')
  fireEvent.click(screen.getByTitle('Add vertex'))
  const rings = container.querySelectorAll('svg:has(image) > g')
  // Add a vertex to the floor while the obstruction is selected, then to the obstruction.
  fireEvent.click(rings[0].querySelector('line')!, { clientX: 500, clientY: 100 })
  expect(changed.mock.lastCall?.[0][0].points).toEqual([
    { x: 100, y: 100 }, { x: 500, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 650 }, { x: 100, y: 650 },
  ])
  fireEvent.click(rings[1].querySelector('line')!, { clientX: 500, clientY: 300 })
  const edited = changed.mock.lastCall?.[0] as Polygon[]
  expect(edited[1].points).toEqual([
    { x: 300, y: 300 }, { x: 500, y: 300 }, { x: 700, y: 300 }, { x: 700, y: 500 }, { x: 300, y: 500 },
  ])
  fireEvent.keyDown(screen.getByLabelText('Clearance'), { key: 'Delete' })
  expect(changed.mock.lastCall?.[0]).toEqual(edited)
  fireEvent.keyDown(window, { key: 'Delete' })
  expect(changed.mock.lastCall?.[0]).toEqual([edited[0]])
  fireEvent.click(screen.getByTitle('Undo (Ctrl+Z)'))
  expect(changed.mock.lastCall?.[0]).toEqual(edited)
  fireEvent.click(screen.getByTitle('Redo (Ctrl+Shift+Z)'))
  expect(changed.mock.lastCall?.[0]).toEqual([edited[0]])
  fireEvent.click(screen.getByTitle('Move vertices'))
  fireEvent.keyDown(window, { key: 'Delete' })
  expect(changed.mock.lastCall?.[0]).toEqual([edited[0]])
})
