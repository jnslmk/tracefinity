// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useHistory } from './useHistory'

afterEach(cleanup)

describe('useHistory', () => {
  it('retains the first edit after undo and discards the old redo branch', () => {
    let value = 0
    const { result } = renderHook(() => useHistory(value, next => { value = next }))

    act(() => result.current.set(1))
    act(() => result.current.set(2))
    act(() => result.current.undo())
    expect(value).toBe(1)

    act(() => result.current.set(3))
    expect(result.current.entries).toEqual([0, 1, 3])
    expect(result.current.canRedo).toBe(false)
    act(() => result.current.undo())
    expect(value).toBe(1)
    act(() => result.current.redo())
    expect(value).toBe(3)
  })

  it('applies sequential actions consistently before React rerenders', () => {
    let value = 0
    const { result } = renderHook(() => useHistory(0, next => { value = next }, 3))

    act(() => {
      const history = result.current
      history.set(1)
      history.set(2)
      history.set(3)
      history.undo()
      history.undo()
      history.redo()
      history.set(4)
      history.undo()
      history.redo()
    })

    expect(value).toBe(4)
    expect(result.current.entries).toEqual([1, 2, 4])
    expect(result.current.index).toBe(2)
    expect(result.current.canRedo).toBe(false)
  })

  it('isolates stored snapshots from input and restored-value mutations', () => {
    const initial = { points: [{ x: 0, y: 1 }] }
    let value = initial
    const { result } = renderHook(() => useHistory(initial, next => { value = next }))
    const edit = { points: [{ x: 2, y: 3 }] }

    act(() => result.current.set(edit))
    initial.points[0].x = 90
    edit.points[0].x = 99
    act(() => result.current.undo())
    expect(value).toEqual({ points: [{ x: 0, y: 1 }] })
    value.points[0].x = 100
    act(() => result.current.redo())
    expect(value).toEqual({ points: [{ x: 2, y: 3 }] })
    value.points[0].x = 200
    act(() => result.current.undo())
    expect(value).toEqual({ points: [{ x: 0, y: 1 }] })
  })

  it('resets to a cloned baseline and removes both previous history and redo', () => {
    let value = { width: 1 }
    const { result } = renderHook(() => useHistory(value, next => { value = next }))
    act(() => {
      result.current.set({ width: 2 })
      result.current.set({ width: 3 })
      result.current.undo()
    })
    const baseline = { width: 8 }
    act(() => result.current.reset(baseline))
    baseline.width = 90

    expect(result.current.entries).toEqual([{ width: 8 }])
    expect(result.current.index).toBe(0)
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
    act(() => {
      result.current.set({ width: 9 })
      result.current.undo()
    })
    expect(value).toEqual({ width: 8 })
  })

  it('does not infer history from changes to the initial argument', () => {
    let initial = 1
    let value = 1
    const { result, rerender } = renderHook(() => useHistory(initial, next => { value = next }))
    act(() => result.current.set(2))
    initial = 99
    rerender()
    act(() => result.current.undo())
    expect(value).toBe(1)
  })

  it.each(['input', 'textarea', 'select', 'contenteditable'])('leaves %s shortcuts to the browser', tag => {
    let value = 1
    const { result } = renderHook(() => useHistory(1, next => { value = next }))
    act(() => result.current.set(2))
    const element = document.createElement(tag === 'contenteditable' ? 'div' : tag)
    if (tag === 'contenteditable') {
      element.setAttribute('contenteditable', 'true')
      element.appendChild(document.createElement('span'))
    }
    document.body.appendChild(element)
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => (element.firstElementChild ?? element).dispatchEvent(event))
    element.remove()

    expect(event.defaultPrevented).toBe(false)
    expect(result.current.index).toBe(1)
    expect(value).toBe(1)
  })

  it('supports case-insensitive Ctrl/Cmd undo and Shift redo outside text fields', () => {
    let value = 0
    const { result } = renderHook(() => useHistory(0, next => { value = next }))
    act(() => result.current.set(1))
    const undo = new KeyboardEvent('keydown', { key: 'Z', metaKey: true, cancelable: true })
    act(() => window.dispatchEvent(undo))
    expect(undo.defaultPrevented).toBe(true)
    expect(value).toBe(0)
    const redo = new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, cancelable: true })
    act(() => window.dispatchEvent(redo))
    expect(redo.defaultPrevented).toBe(true)
    expect(value).toBe(1)
  })

  it('disables direct and keyboard undo/redo without losing history', () => {
    let enabled = true
    let value = 0
    const { result, rerender } = renderHook(() => useHistory(0, next => { value = next }, 10, { enabled }))
    act(() => {
      result.current.set(1)
      result.current.set(2)
      result.current.undo()
    })
    expect(value).toBe(1)
    enabled = false
    rerender()
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true })
    act(() => {
      result.current.undo()
      result.current.redo()
      window.dispatchEvent(event)
    })
    expect(value).toBe(1)
    expect(result.current.index).toBe(1)
    expect(event.defaultPrevented).toBe(false)
    enabled = true
    rerender()
    act(() => result.current.redo())
    expect(value).toBe(2)
  })
})
