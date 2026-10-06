'use client'

import { Suspense, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { Alert } from '@/components/Alert'
import { DrawerPhotoWorkflow } from '@/components/DrawerPhotoWorkflow'
import { Loader2 } from 'lucide-react'
import { getProject } from '@/lib/api'

function PhotoPlanContent() {
  const params = useParams()
  const searchParams = useSearchParams()
  const projectId = params.id as string
  const sketchId = searchParams.get('sketchId')
  const [projectName, setProjectName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getProject(projectId)
      .then(project => { if (!cancelled) setProjectName(project.name) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load project') })
    return () => { cancelled = true }
  }, [projectId])

  if (error) return <div className="max-w-md mx-auto py-12"><Alert variant="error">{error}</Alert></div>
  if (!projectName) {
    return (
      <div className="flex items-center justify-center py-12 gap-2 text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span>Loading project…</span>
      </div>
    )
  }

  return <DrawerPhotoWorkflow projectId={projectId} projectName={projectName} sketchId={sketchId} />
}

export default function DrawerPhotoPage() {
  return (
    <Suspense fallback={null}>
      <PhotoPlanContent />
    </Suspense>
  )
}
