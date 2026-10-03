'use client'

import { useCallback, useEffect, useState } from 'react'
import { Breadcrumb } from '@/components/Breadcrumb'
import { BinPreview3D } from '@/components/BinPreview3D'
import { Alert } from '@/components/Alert'
import { downloadExport } from '@/lib/download'
import { generateBinStl, getImageUrl, updateBin } from '@/lib/api'
import { useProjectSource } from '@/hooks/useProjectSource'
import type { BinData } from '@/types'
import { Check, Download, Loader2, TriangleAlert } from 'lucide-react'
import { GRID_UNIT } from '@/lib/constants'

interface Props {
  bin: BinData
}

/**
 * Read-only view of a planning-only uploaded bin. The stored mesh is shown
 * as-is; there is no editor, no tool placement and no config mutation. The
 * only write available is renaming the bin. Dimensions and the nominal grid
 * are detected approximations, so fit and stacking are never reported as
 * verified here.
 */
export function ImportedBinView({ bin }: Props) {
  const projectSource = useProjectSource('Bins')
  const metadata = bin.imported_model
  const [name, setName] = useState(bin.name || '')
  const [savingName, setSavingName] = useState(false)
  const [nameSaved, setNameSaved] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [stlUrl, setStlUrl] = useState<string | null>(null)
  const [stlError, setStlError] = useState<string | null>(null)
  const [stlVersion, setStlVersion] = useState(0)

  const loadStl = useCallback(async () => {
    setStlError(null)
    try {
      const result = await generateBinStl(bin.id)
      setStlUrl(getImageUrl(result.stl_url))
      setStlVersion(v => v + 1)
    } catch (err) {
      setStlError(err instanceof Error ? err.message : 'could not load STL')
    }
  }, [bin.id])

  useEffect(() => {
    loadStl()
  }, [loadStl])

  useEffect(() => {
    setName(bin.name || '')
  }, [bin.name])

  async function handleRename(value: string) {
    setSavingName(true)
    setNameError(null)
    try {
      await updateBin(bin.id, { name: value })
      setName(value)
      setNameSaved(true)
      setTimeout(() => setNameSaved(false), 2000)
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'rename failed')
    } finally {
      setSavingName(false)
    }
  }

  const versionedUrl = stlUrl ? `${stlUrl}?v=${stlVersion}` : null

  return (
    <div className="h-[calc(100vh-44px)] flex">
      <div className="w-[200px] flex-shrink-0 bg-surface border-r border-border flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-3 space-y-3">
          <div className="glass rounded-[10px] px-3 py-3">
            <div className="flex items-center gap-2 mb-2">
              <Breadcrumb segments={[
                { label: projectSource.rootLabel, href: projectSource.rootHref },
                { label: name || 'Untitled', editable: true, onEdit: handleRename },
              ]} />
              {savingName && <Loader2 className="w-3 h-3 animate-spin text-text-muted flex-shrink-0" />}
              {nameSaved && !nameError && <Check className="w-3 h-3 text-green-400 flex-shrink-0" />}
              {nameError && !savingName && (
                <TriangleAlert className="w-3 h-3 text-red-400 flex-shrink-0" aria-label="Rename not saved" />
              )}
            </div>
            <p className="text-[10px] text-text-muted">
              Planning-only uploaded model. The geometry is stored as-is: it cannot be edited and no tools or cutouts can be added to it.
            </p>
            {nameError && (
              <div role="alert" className="mt-2 rounded-[8px] border border-red-800 bg-red-900/20 px-2 py-1.5 text-[11px] text-red-300">
                {nameError}
              </div>
            )}
          </div>

          {metadata && (
            <div className="glass rounded-[10px] px-3 py-3">
              <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[1.5px] mb-2">Detected size</h3>
              <div className="text-[11px] text-text-secondary space-y-0.5">
                <div className="flex justify-between"><span>Width</span><span>{metadata.width_mm.toFixed(1)} mm</span></div>
                <div className="flex justify-between"><span>Depth</span><span>{metadata.depth_mm.toFixed(1)} mm</span></div>
                <div className="flex justify-between"><span>Height</span><span>{metadata.height_mm.toFixed(1)} mm</span></div>
              </div>
              <p className="mt-2 text-[10px] text-text-muted">Bounding box of the uploaded mesh, not a measured physical bin.</p>
            </div>
          )}

          <div className="glass rounded-[10px] px-3 py-3">
            <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[1.5px] mb-2">Nominal grid</h3>
            <div className="text-[11px] text-text-secondary space-y-0.5">
              <div className="flex justify-between"><span>Cells</span><span>{bin.bin_config.grid_x} × {bin.bin_config.grid_y}</span></div>
              <div className="flex justify-between"><span>Footprint</span><span>{bin.bin_config.grid_x * GRID_UNIT} × {bin.bin_config.grid_y * GRID_UNIT} mm</span></div>
            </div>
          </div>

          {metadata && metadata.warnings.length > 0 && (
            <div className="glass rounded-[10px] px-3 py-3">
              <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[1.5px] mb-2">Warnings</h3>
              <ul className="text-[11px] space-y-1 list-disc pl-4 text-amber-600 dark:text-amber-400">
                {metadata.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="glass rounded-[10px] px-3 py-3">
            <p className="text-[10px] text-text-muted">
              Fit and stacking are unverified. The detected size and grid come from the uploaded geometry; they are not proof that this bin fits a drawer or stacks with its neighbours.
            </p>
          </div>
        </div>

        <div className="p-3 flex-shrink-0 space-y-1.5">
          {stlError && <Alert variant="error">{stlError}</Alert>}
          <button
            type="button"
            disabled={!stlUrl}
            onClick={() => { if (stlUrl) downloadExport(stlUrl, loadStl).catch(() => setStlError('download failed')) }}
            className="btn-primary w-full py-2 text-[11px] font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            Download STL
          </button>
        </div>
      </div>

      <div className="flex-1 min-w-0 bg-surface flex flex-col">
        <div className="px-3 py-2 border-b border-border flex-shrink-0">
          <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-[1.5px]">Uploaded model</h3>
        </div>
        <div className="flex-1 min-h-0 relative bg-inset">
          {versionedUrl ? (
            <BinPreview3D
              stlUrl={versionedUrl}
              onLoadError={() => {
                setStlError('The uploaded model could not be loaded. It may have been removed from storage.')
                setStlUrl(null)
              }}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-text-muted text-xs gap-2">
              {stlError ? (
                <>
                  <span className="max-w-xs px-4 text-center">Model unavailable.</span>
                  <button type="button" onClick={loadStl} className="btn-secondary px-2.5 py-1 text-[11px]">
                    Retry
                  </button>
                </>
              ) : (
                <>
                  <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
                  <span>Loading model…</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
