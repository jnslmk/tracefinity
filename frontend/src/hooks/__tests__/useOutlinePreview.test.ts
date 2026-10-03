// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { OutlinePreview, OutlinePreviewInput } from '@/lib/api'

interface Pending {
  resolve: (outlines: OutlinePreview[]) => void
  reject: (error: Error) => void
}
const { pending } = vi.hoisted(() => ({ pending: [] as Pending[] }))
vi.mock('@/lib/api', () => ({
  previewToolOutlines: vi.fn(() => new Promise<OutlinePreview[]>((resolve, reject) => {
    pending.push({ resolve, reject })
  })),
}))
import { useOutlinePreview } from '../useOutlinePreview'

const outline: OutlinePreviewInput = {
  id: 'tool', label: '', points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }],
  interior_rings: [], smoothed: true, smooth_level: 0.5,
}

beforeEach(() => { pending.length = 0; vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

async function startRequest() {
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
}

describe('useOutlinePreview', () => {
  it('never exposes a response for superseded geometry as the current contour', async () => {
    const { result, rerender } = renderHook(
      ({ input }) => useOutlinePreview(input), { initialProps: { input: [outline] } },
    )
    await startRequest()
    rerender({ input: [{ ...outline, smooth_level: 1 }] })
    expect(result.current.outlines).toBeUndefined()
    expect(result.current.status).not.toBeNull()
    await startRequest()
    await act(async () => { pending[1].resolve([{ ...outline, id: 'current' }]) })
    expect(result.current.outlines?.[0].id).toBe('current')
    await act(async () => { pending[0].resolve([{ ...outline, id: 'obsolete' }]) })
    expect(result.current.outlines?.[0].id).toBe('current')
    expect(result.current.status).toBeNull()
  })

  it('makes request failure visible instead of treating the raw outline as smoothed', async () => {
    const { result } = renderHook(() => useOutlinePreview([outline]))
    await startRequest()
    await act(async () => { pending[0].reject(new Error('Service unavailable')) })
    expect(result.current.outlines).toBeUndefined()
    expect(result.current.status).toContain('unavailable')
  })
})
