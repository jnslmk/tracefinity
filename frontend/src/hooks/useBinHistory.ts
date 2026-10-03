import { useCallback, useRef } from 'react'
import { useHistory } from '@/hooks/useHistory'
import type { BinConfig, PlacedTool, TextLabel } from '@/types'
import type { GridSizingMode } from '@/lib/constants'

export interface BinSnapshot {
  config: BinConfig
  placedTools: PlacedTool[]
  textLabels: TextLabel[]
  name: string
  gridSizingMode: GridSizingMode
}

type BinAction = BinSnapshot & { label: string }

export function useBinHistory(snapshot: BinSnapshot, onRestore: (value: BinSnapshot) => void, enabled: boolean) {
  const pendingAction = useRef<string | null>(null)
  const initialized = useRef(false)
  const restore = useCallback((value: BinAction) => {
    pendingAction.current = null
    onRestore(value)
  }, [onRestore])
  const history = useHistory<BinAction>({ ...snapshot, label: 'Opened bin' }, restore, undefined, { enabled })
  const { reset: resetHistory } = history

  const reset = useCallback((value: BinSnapshot) => {
    pendingAction.current = null
    initialized.current = true
    resetHistory({ ...value, label: 'Opened bin' })
  }, [resetHistory])

  const mark = useCallback((label: string) => {
    pendingAction.current = label
  }, [])

  // The page calls this after its sizing effect; per-frame drag changes stay pending.
  const commit = () => {
    if (!enabled || !initialized.current || !pendingAction.current) return
    const previous = history.entries[history.index]
    const label = pendingAction.current
    pendingAction.current = null
    if (JSON.stringify({ ...snapshot, label: previous.label }) !== JSON.stringify(previous)) history.set({ ...snapshot, label })
  }

  return { ...history, reset, mark, commit }
}
