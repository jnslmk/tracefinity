'use client'

import { useCallback, useEffect, useState } from 'react'
import { assessProjectSketch } from '@/lib/api'
import type { ProjectSketch, ToolboxAssessment } from '@/types'

export function useToolboxPlanning(projectId: string, sketchId: string, draft: Partial<ProjectSketch>, enabled: boolean) {
  const [assessment, setAssessment] = useState<ToolboxAssessment | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(v => v + 1), [])
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])
  useEffect(() => {
    let cancelled = false
    setAssessment(null)
    setError(null)
    if (!enabled) return
    const timer = setTimeout(() => {
      assessProjectSketch(projectId, sketchId, draft).then(result => {
        if (!cancelled) setAssessment(result)
      }).catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Assessment failed') })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [projectId, sketchId, draft, enabled, revision])
  return { assessment, error, refresh }
}
