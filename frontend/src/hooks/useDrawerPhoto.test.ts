// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { DrawerOutline, ProjectSketch } from '@/types'
import { useDrawerPhoto } from './useDrawerPhoto'

const oldOutline: DrawerOutline = {
  points: [{ x: 2, y: 2 }, { x: 20, y: 2 }, { x: 20, y: 20 }, { x: 2, y: 20 }],
  interior_rings: [],
}
const newOutline: DrawerOutline = {
  points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 40 }, { x: 10, y: 40 }],
  interior_rings: [],
}

function savedPlan(): ProjectSketch {
  return {
    id: 'plan', name: 'Photo plan', target_grid_x: 1, target_grid_y: 1, bin_layout: [],
    outline: oldOutline, fit_clearance_mm: 0, created_at: null, updated_at: null,
    source: {
      session_id: 'deleted-session', corrected_image_url: '/storage/default/projects/plan/old/corrected.png',
      original_image_url: '/storage/default/projects/plan/old/original.png',
      image_width: 400, image_height: 300, scale_factor: .1, paper_size: 'letter',
      corners: [{ x: 10, y: 10 }, { x: 390, y: 10 }, { x: 390, y: 290 }, { x: 10, y: 290 }],
      seed: { x: 100, y: 100 },
    },
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Stub only HTTP and image decoding, not the hook/API client under test. The old
// session really is unavailable; pending and owned sources yield different masks.
function installApi() {
  let saved = savedPlan()
  let pending = false
  let refuseCandidate = false
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://local').pathname
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    requests.push({ path, method, body })
    if (path === '/api/bin-projects/project' && method === 'GET') return jsonResponse({ sketches: [saved] })
    if (path === saved.source?.original_image_url) return new Response(new Blob(['original pixels'], { type: 'image/png' }))
    if (path === '/api/upload') {
      pending = true
      return jsonResponse({ session_id: 'pending-session', image_url: '/storage/default/uploads/pending.png', image_width: 800, image_height: 600 })
    }
    if (path === '/api/sessions/pending-session/corners' && pending) {
      return jsonResponse({ corrected_image_url: '/storage/default/processed/pending.png', scale_factor: .5, warnings: [] })
    }
    if (path.endsWith('/outline/candidate')) {
      if (refuseCandidate) return jsonResponse({ detail: 'no interior floor found' }, 400)
      const replacement = body.session_id === 'pending-session' && pending
      return jsonResponse({ outline: replacement ? newOutline : oldOutline, mask_url: null, image_width: replacement ? 160 : 400, image_height: replacement ? 100 : 300 })
    }
    if (path === '/api/bin-projects/project/sketches/plan' && method === 'PATCH') {
      if (body.source_session_id && (body.source_session_id !== 'pending-session' || !pending)) {
        return jsonResponse({ detail: 'calibrate the photo before using it as a plan source' }, 400)
      }
      saved = {
        ...saved, outline: body.outline as DrawerOutline, fit_clearance_mm: body.fit_clearance_mm as number,
        source: body.source_session_id ? {
          ...saved.source!, session_id: 'pending-session', scale_factor: .5, image_width: 160, image_height: 100,
          corrected_image_url: '/storage/default/projects/plan/new/corrected.png',
          original_image_url: '/storage/default/projects/plan/new/original.png',
        } : saved.source,
      }
      return jsonResponse(saved)
    }
    return jsonResponse({ detail: 'session not found' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('Image', class {
    naturalWidth = 160
    naturalHeight = 100
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_url: string) { queueMicrotask(() => this.onload?.()) }
  })
  return { requests, saved: () => saved, refuse: () => { refuseCandidate = true } }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('saved drawer photo source transitions', () => {
  it('edits and accepts an owned boundary after its trace session has been deleted', async () => {
    const api = installApi()
    const { result } = renderHook(() => useDrawerPhoto('project', 'plan'))
    await waitFor(() => expect(result.current.step).toBe('review'))
    act(() => {
      result.current.setPolygons(result.current.polygons.map(p => ({ ...p, points: p.points.map(point => ({ x: point.x + 10, y: point.y })) })))
      result.current.setFitClearanceMm(3)
    })
    let accepted: ProjectSketch | null = null
    await act(async () => { accepted = await result.current.accept() })
    expect(accepted).not.toBeNull()
    const patch = api.requests.find(r => r.method === 'PATCH')!
    expect(patch.body).not.toHaveProperty('source_session_id')
    expect(api.saved().source?.session_id).toBe('deleted-session')
    expect(api.saved().outline?.points[0]).toEqual({ x: 3, y: 2 })
    expect(api.saved().fit_clearance_mm).toBe(3)
    expect(api.requests.some(r => r.path.includes('deleted-session'))).toBe(false)
  })

  it.each(['replacement', 'recalibration'] as const)('traces and accepts the pending %s in its displayed metric frame', async mode => {
    const api = installApi()
    const before = api.saved()
    const { result } = renderHook(() => useDrawerPhoto('project', 'plan'))
    await waitFor(() => expect(result.current.step).toBe('review'))
    if (mode === 'replacement') {
      act(() => result.current.restartCapture())
      await act(async () => { await result.current.upload(new File(['new pixels'], 'new.png', { type: 'image/png' })) })
    } else {
      await act(async () => { await result.current.recalibrate() })
      expect(result.current.originalUrl).toContain('/storage/default/uploads/pending.png')
      expect(result.current.corners).toEqual(before.source?.corners)
      expect(result.current.paperSize).toBe('letter')
    }
    expect(result.current.step).toBe('corners')
    expect(api.saved()).toEqual(before)
    await act(async () => { await result.current.applyCorners('letter') })
    expect(result.current.correctedUrl).toContain('/storage/default/processed/pending.png')
    expect(result.current.scaleFactor).toBe(.5)
    act(() => result.current.selectSeed({ x: 40, y: 30 }))
    expect(api.requests.some(r => r.path.endsWith('/outline/candidate'))).toBe(false)
    await act(async () => { await result.current.generate({ x: 40, y: 30 }) })
    expect(result.current.polygons[0].points).toEqual([
      { x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 80 }, { x: 20, y: 80 },
    ])
    expect(api.saved()).toEqual(before)
    await act(async () => { await result.current.accept() })
    expect(api.saved().id).toBe('plan')
    expect(api.saved().outline).toEqual(newOutline)
    expect(api.saved().source?.scale_factor).toBe(.5)
    expect(api.requests.filter(r => r.method === 'POST' && r.path.endsWith('/sketches'))).toHaveLength(0)
    await act(async () => { await result.current.accept() })
    const patches = api.requests.filter(r => r.method === 'PATCH')
    expect(patches[0].body.source_session_id).toBe('pending-session')
    expect(patches[1].body).not.toHaveProperty('source_session_id')
  })

  it('leaves the owned source and outline untouched when a replacement proposal fails', async () => {
    const api = installApi()
    const before = api.saved()
    const { result } = renderHook(() => useDrawerPhoto('project', 'plan'))
    await waitFor(() => expect(result.current.step).toBe('review'))
    act(() => result.current.restartCapture())
    await act(async () => { await result.current.upload(new File(['new'], 'new.png', { type: 'image/png' })) })
    await act(async () => { await result.current.applyCorners('a4') })
    api.refuse()
    await act(async () => { await result.current.generate({ x: 40, y: 30 }) })
    expect(result.current.error).toBe('no interior floor found')
    expect(result.current.step).toBe('floor')
    expect(api.saved()).toEqual(before)
    expect(api.requests.some(r => r.method === 'PATCH')).toBe(false)
  })
})
