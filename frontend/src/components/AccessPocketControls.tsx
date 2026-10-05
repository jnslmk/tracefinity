'use client'

import { useEffect, useRef, useState } from 'react'
import type { AccessPocket, AccessPocketEdge, AccessPocketShape } from '@/types'
import { effectivePocketDepth, resolvePocketEdge, validatePocket } from '@/lib/accessPockets'

interface Props {
  pocket: AccessPocket
  binChamfer: number
  maxDepth: number
  onChange: (updates: Partial<AccessPocket>, label?: string) => void
  onDuplicate: () => void
  onDelete: () => void
}

const EDGE_LABELS: Record<AccessPocketEdge, string> = {
  inherit: 'Inherit bin chamfer',
  sharp: 'Sharp',
  chamfer: '45° chamfer',
  fillet: 'Round (fillet)',
}

const fieldClass = 'w-full rounded border border-glass-border bg-surface px-1.5 py-1 text-text-primary focus-visible:outline-2 focus-visible:outline-accent'

/**
 * A numeric field that selects its whole value on focus, so typing replaces the
 * existing number instead of appending to it, and clamps to min/max on commit.
 * A clamped entry is explained instead of silently adjusted.
 */
function NumberField({ label, value, min, max, step, limitHint, onCommit }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  limitHint?: string
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [adjustment, setAdjustment] = useState<string | null>(null)
  const committed = useRef(value)

  useEffect(() => {
    const incoming = String(value)
    if (incoming !== text && value !== committed.current) {
      setText(incoming)
      committed.current = value
    }
    // intentionally excluding `text`: only external value changes resync the field
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const commit = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') return
    const parsed = parseFloat(trimmed)
    if (Number.isNaN(parsed)) return
    const next = Math.max(min, Math.min(max, parsed))
    setText(String(next))
    committed.current = next
    setAdjustment(parsed !== next
      ? `Requested ${parsed} — using ${next} (${limitHint ?? `limit ${min}–${max}`})`
      : null)
    onCommit(next)
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">
        {label}
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={text}
          onFocus={event => event.currentTarget.select()}
          onChange={event => setText(event.target.value)}
          onBlur={event => commit(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              commit(event.currentTarget.value)
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              setText(String(committed.current))
              event.currentTarget.blur()
            }
          }}
          className={fieldClass}
        />
      </label>
      {adjustment && (
        <span role="status" className="text-[9px] font-normal normal-case tracking-normal text-amber-300">
          {adjustment}
        </span>
      )}
    </div>
  )
}

/**
 * Exact numeric controls for the selected access pocket. Radii and the
 * opening-edge size are shown here rather than folded into the shape so the
 * generated geometry is never changed silently.
 */
export function AccessPocketControls({ pocket, binChamfer, maxDepth, onChange, onDuplicate, onDelete }: Props) {
  const isScoop = pocket.shape === 'scoop'
  const depth = effectivePocketDepth(pocket, maxDepth)
  const finish = resolvePocketEdge(pocket, binChamfer, maxDepth)
  const error = validatePocket(pocket, maxDepth)
  const halfMax = Math.max(0.5, Math.min(pocket.length, pocket.width) / 2)
  const depthClamped = pocket.depth > maxDepth + 1e-9
  const edgeClamped = pocket.edge_size > depth - 0.01 + 1e-9 && (pocket.edge === 'chamfer' || pocket.edge === 'fillet')

  const setShape = (shape: AccessPocketShape) => {
    if (shape === pocket.shape) return
    if (shape === 'scoop') {
      onChange({ shape, edge: 'fillet', edge_size: 1, corner_radius: 0, bottom_radius: 0 }, 'Change pocket shape')
    } else {
      onChange({ shape, edge: 'inherit', corner_radius: 0, bottom_radius: 0 }, 'Change pocket shape')
    }
  }

  return (
    <section
      aria-label="Access pocket settings"
      className="w-60 rounded-xl border border-glass-border bg-surface p-3 text-[11px] text-text-secondary shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[1.5px] text-text-muted">Access pocket</p>
        <div className="flex gap-1">
          <button type="button" onClick={onDuplicate}
            className="rounded px-2 py-1 text-text-secondary hover:bg-[rgba(255,255,255,0.05)] cursor-pointer focus-visible:outline-2 focus-visible:outline-accent">
            Duplicate
          </button>
          <button type="button" onClick={onDelete}
            className="rounded px-2 py-1 text-red-400 hover:bg-red-900/20 cursor-pointer focus-visible:outline-2 focus-visible:outline-accent">
            Delete
          </button>
        </div>
      </div>

      <div role="group" aria-label="Pocket shape" className="mb-3 flex overflow-hidden rounded-[6px] border border-glass-border">
        {(['rectangle', 'scoop'] as const).map(shape => (
          <button
            key={shape}
            type="button"
            aria-pressed={pocket.shape === shape}
            onClick={() => setShape(shape)}
            className={`flex-1 px-2 py-1 text-[10px] font-medium cursor-pointer ${pocket.shape === shape ? 'bg-accent-muted text-accent' : 'text-text-muted hover:text-text-secondary'}`}
          >
            {shape === 'rectangle' ? 'Rectangle' : 'Rounded scoop'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Length (mm)" value={pocket.length} min={1} max={400} step={0.5}
          onCommit={value => onChange({ length: value }, 'Resize pocket')} />
        <NumberField label="Width (mm)" value={pocket.width} min={1} max={400} step={0.5}
          onCommit={value => onChange({ width: value }, 'Resize pocket')} />
        <NumberField label="Depth (mm)" value={pocket.depth} min={0.25} max={Math.max(0.25, maxDepth)} step={0.25}
          limitHint="protected-floor maximum"
          onCommit={value => onChange({ depth: value }, 'Change pocket depth')} />
        <NumberField label="Angle (°)" value={pocket.rotation} min={-180} max={180} step={1}
          onCommit={value => onChange({ rotation: value }, 'Rotate pocket')} />
      </div>

      {/* Opening-edge choices: inherit the bin chamfer, sharp, 45° chamfer or round. */}
      <label className="mt-3 flex flex-col gap-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">
        Opening edge
        <select
          aria-label="Opening edge"
          value={pocket.edge}
          onChange={event => onChange({ edge: event.target.value as AccessPocketEdge }, 'Change pocket edge')}
          className={fieldClass}
        >
          {(Object.keys(EDGE_LABELS) as AccessPocketEdge[]).map(edge => (
            <option key={edge} value={edge}>{EDGE_LABELS[edge]}</option>
          ))}
        </select>
      </label>
      {(pocket.edge === 'chamfer' || pocket.edge === 'fillet') && (
        <div className="mt-2">
          <NumberField
            label={pocket.edge === 'chamfer' ? 'Chamfer size (mm)' : 'Fillet radius (mm)'}
            value={pocket.edge_size} min={0} max={Math.max(0, depth - 0.01)} step={0.25}
            onCommit={value => onChange({ edge_size: value }, 'Change pocket edge size')}
          />
        </div>
      )}

      {!isScoop && (
        <fieldset className="mt-3 rounded-lg border border-glass-border p-2">
          <legend className="px-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Geometry</legend>
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="Corner radius" value={pocket.corner_radius} min={0} max={halfMax} step={0.5}
              onCommit={value => onChange({ corner_radius: value }, 'Change pocket corner radius')} />
            <NumberField label="Bottom radius" value={pocket.bottom_radius} min={0} max={Math.min(depth, halfMax)} step={0.5}
              onCommit={value => onChange({ bottom_radius: value }, 'Change pocket bottom radius')} />
          </div>
        </fieldset>
      )}

      {isScoop && (
        <p className="mt-3 text-[10px] text-text-muted">
          Rounded scoop: a curved-bottom trough with rounded ends. Width and depth are independent, so it can be shallow.
        </p>
      )}

      <p className="mt-2 text-[10px] text-text-muted">
        {`Effective depth ${depth.toFixed(2)}mm`}
        {depthClamped ? ` (clamped from ${pocket.depth.toFixed(2)}mm to protect the floor)` : ''}
        {` · opening edge ${finish.kind === 'sharp' ? 'sharp' : `${finish.kind} ${finish.size.toFixed(2)}mm`}`}
        {edgeClamped ? ' (size clamped to the pocket depth)' : ''}
      </p>

      {error && (
        <p role="alert" className="mt-2 rounded border border-amber-700/60 bg-amber-900/20 px-2 py-1 text-[10px] text-amber-300">
          {error}
        </p>
      )}
    </section>
  )
}
