// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DrawerOutlineEditor } from './DrawerOutlineEditor'
import type { Polygon } from '@/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('lets the floor boundary be dragged immediately and undone without allowing its deletion', async () => {
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
