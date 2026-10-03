'use client'

import { useEffect, useState } from 'react'
import { previewToolOutlines, type OutlinePreview, type OutlinePreviewInput } from '@/lib/api'

export function useOutlinePreview(outlines: OutlinePreviewInput[]) {
  // Key the result to the complete geometry, not array identity: drag renders
  // must never paint an old response as the current smoothed contour.
  const key = JSON.stringify(outlines)
  const [result, setResult] = useState<{
    key: string; outlines?: OutlinePreview[]; error?: string
  } | null>(null)

  useEffect(() => {
    if (key === '[]') return
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => {
      previewToolOutlines(JSON.parse(key) as OutlinePreviewInput[], controller.signal)
        .then(prepared => {
          if (!cancelled) setResult({ key, outlines: prepared })
        })
        .catch(error => {
          if (!cancelled) setResult({ key, error: error instanceof Error ? error.message : 'Request failed' })
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [key])

  if (key === '[]') return { outlines: undefined, status: null }
  if (result?.key !== key) return { outlines: undefined, status: 'Updating smoothed preview…' }
  return {
    outlines: result.outlines,
    status: result.error ? `Smoothed preview unavailable: ${result.error}` : null,
  }
}
