import { useState, useCallback, useEffect, useRef } from 'react'
import { MAX_HISTORY } from '@/lib/constants'

export function useHistory<T>(
  initial: T,
  onChange: (value: T) => void,
  maxEntries: number = MAX_HISTORY,
  { enabled = true }: { enabled?: boolean } = {}
): {
  set: (value: T) => void
  undo: () => void
  redo: () => void
  reset: (value: T) => void
  entries: T[]
  index: number
  canUndo: boolean
  canRedo: boolean
} {
  const [history, setHistory] = useState(() => ({ entries: [structuredClone(initial)], index: 0 }))
  // Commands share the latest snapshot even when React batches several actions.
  const historyRef = useRef(history)
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  const updateHistory = useCallback((next: typeof history) => {
    historyRef.current = next
    setHistory(next)
  }, [])

  const set = useCallback((value: T) => {
    const { entries, index } = historyRef.current
    const next = [...entries.slice(0, index + 1), structuredClone(value)].slice(-Math.max(1, maxEntries))
    updateHistory({ entries: next, index: next.length - 1 })
  }, [maxEntries, updateHistory])

  const reset = useCallback((value: T) => {
    updateHistory({ entries: [structuredClone(value)], index: 0 })
  }, [updateHistory])

  const undo = useCallback(() => {
    const { entries, index } = historyRef.current
    if (!enabled || index === 0) return
    updateHistory({ entries, index: index - 1 })
    onChangeRef.current(structuredClone(entries[index - 1]))
  }, [enabled, updateHistory])

  const redo = useCallback(() => {
    const { entries, index } = historyRef.current
    if (!enabled || index === entries.length - 1) return
    updateHistory({ entries, index: index + 1 })
    onChangeRef.current(structuredClone(entries[index + 1]))
  }, [enabled, updateHistory])

  useEffect(() => {
    if (!enabled) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.altKey) return
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, undo, redo])

  return {
    set, undo, redo, reset,
    entries: history.entries,
    index: history.index,
    canUndo: history.index > 0,
    canRedo: history.index < history.entries.length - 1,
  }
}
