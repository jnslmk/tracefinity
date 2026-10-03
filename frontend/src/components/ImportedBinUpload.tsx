'use client'

import { useRef, useState } from 'react'
import { Loader2, Upload, X } from 'lucide-react'
import { importBin } from '@/lib/api'
import type { BinData } from '@/types'
import { Alert } from '@/components/Alert'

function formatMm(value: number) {
  return `${value.toFixed(1)} mm`
}

interface Props {
  /** Link the uploaded bin to this project immediately so it is plan-placeable. */
  projectId?: string | null
  /** Called once with the created bin, so the caller can refresh its collection. */
  onImported: (bin: BinData) => void
  /** Optional follow-up action (e.g. open the new bin) offered in the result panel. */
  onOpen?: (bin: BinData) => void
}

/**
 * Planning-only STL upload. The mesh is stored as-is (normalised, not editable)
 * and reported with detected dimensions and any nonstandard-geometry warnings.
 */
export function ImportedBinUpload({ projectId, onImported, onOpen }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BinData | null>(null)

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.stl')) {
      setError('Only .stl files can be imported.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const bin = await importBin(file, { name: file.name.replace(/\.stl$/i, ''), project_id: projectId ?? null })
      setResult(bin)
      onImported(bin)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed')
    } finally {
      setPending(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const metadata = result?.imported_model

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={pending}
          className="btn-secondary px-2.5 py-1 text-[11px] inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {pending ? 'Uploading…' : 'Upload STL'}
        </button>
        <span className="text-[10px] text-text-muted">STL · millimetres · Z-up</span>
        <input
          ref={inputRef}
          type="file"
          accept=".stl"
          aria-label="Import bin STL"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
          }}
        />
      </div>

      <p className="text-[10px] text-text-muted">
        The mesh is used as-is for planning. It is not editable and no cutouts or tools can be added to it.
      </p>

      {error && <Alert variant="error">{error}</Alert>}

      {result && metadata && (
        <div className="glass-sm rounded-[7px] border border-border-subtle px-2.5 py-2 space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[11px] text-text-primary truncate">
              {result.name || `Bin ${result.id.slice(0, 8)}`} imported
            </p>
            <button
              type="button"
              onClick={() => setResult(null)}
              className="p-0.5 text-text-muted hover:text-text-primary transition-colors cursor-pointer flex-shrink-0"
              aria-label="Dismiss import result"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="text-[10px] text-text-secondary space-y-0.5">
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Detected size</span>
              <span>{formatMm(metadata.width_mm)} × {formatMm(metadata.depth_mm)} × {formatMm(metadata.height_mm)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Nominal grid</span>
              <span>{result.bin_config.grid_x} × {result.bin_config.grid_y}</span>
            </div>
          </div>
          {metadata.warnings.length > 0 && (
            <ul className="text-[10px] space-y-0.5 list-disc pl-4 text-amber-600 dark:text-amber-400">
              {metadata.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-text-muted">
            Fit and stacking are unverified: the size above is the uploaded mesh&apos;s bounding box, not a measured bin.
          </p>
          {onOpen && (
            <button
              type="button"
              onClick={() => onOpen(result)}
              className="text-[10px] text-accent hover:underline cursor-pointer"
            >
              Open bin
            </button>
          )}
        </div>
      )}
    </div>
  )
}
