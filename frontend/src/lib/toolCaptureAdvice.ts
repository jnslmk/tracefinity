import type { CaptureFrame, Point } from '@/types'

export type ToolCaptureAssessment =
  | { status: 'unavailable'; reason: 'missing-frame' | 'invalid-frame' | 'invalid-outline' }
  | { status: 'assessed'; edgeContact: boolean; outerFrame: boolean }

/** Position only: a paper-plane warp cannot measure tool height or outline error. */
export function assessToolCapture(
  points: readonly Point[],
  frame: CaptureFrame | null | undefined,
): ToolCaptureAssessment {
  if (!frame) return { status: 'unavailable', reason: 'missing-frame' }
  const unavailable = (reason: 'invalid-frame' | 'invalid-outline'): ToolCaptureAssessment => ({ status: 'unavailable', reason })
  if (
    !Number.isInteger(frame.source_width) || frame.source_width <= 0 ||
    !Number.isInteger(frame.source_height) || frame.source_height <= 0 ||
    !Number.isFinite(frame.full_frame_width) || frame.full_frame_width <= 0 ||
    !Number.isFinite(frame.full_frame_height) || frame.full_frame_height <= 0 ||
    !frame.optical_center || !Number.isFinite(frame.optical_center.x) || !Number.isFinite(frame.optical_center.y)
  ) return unavailable('invalid-frame')

  const matrix = frame.corrected_to_source
  if (!Array.isArray(matrix) || matrix.length !== 3 || matrix.some(row =>
    !Array.isArray(row) || row.length !== 3 || row.some(value => !Number.isFinite(value)),
  )) return unavailable('invalid-frame')
  const magnitude = Math.max(...matrix.flat().map(Math.abs))
  if (magnitude === 0) return unavailable('invalid-frame')
  const [a, b, c] = matrix.map(row => row.map(value => value / magnitude))
  const determinant = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
  if (!Number.isFinite(determinant) || determinant === 0) return unavailable('invalid-frame')
  if (!Array.isArray(points) || points.length < 3) return unavailable('invalid-outline')

  let edgeContact = false
  let outerFrame = false
  let denominatorSign = 0
  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return unavailable('invalid-outline')
    const denominator = c[0] * point.x + c[1] * point.y + c[2]
    const denominatorScale = Math.abs(c[0] * point.x) + Math.abs(c[1] * point.y) + Math.abs(c[2])
    if (!Number.isFinite(denominator) || Math.abs(denominator) <= Number.EPSILON * denominatorScale) return unavailable('invalid-outline')
    // An outline crossing the projective horizon has no usable finite source boundary.
    if (denominatorSign && denominatorSign !== Math.sign(denominator)) return unavailable('invalid-outline')
    denominatorSign = Math.sign(denominator)
    const x = (a[0] * point.x + a[1] * point.y + a[2]) / denominator
    const y = (b[0] * point.x + b[1] * point.y + b[2]) / denominator
    if (!Number.isFinite(x) || !Number.isFinite(y)) return unavailable('invalid-outline')
    edgeContact ||= x <= 2 || y <= 2 || x >= frame.source_width - 2 || y >= frame.source_height - 2
    const position = Math.max(
      Math.abs(x - frame.optical_center.x) / (frame.full_frame_width / 2),
      Math.abs(y - frame.optical_center.y) / (frame.full_frame_height / 2),
    )
    if (!Number.isFinite(position)) return unavailable('invalid-outline')
    outerFrame ||= position >= 0.7
  }
  return { status: 'assessed', edgeContact, outerFrame }
}
