import { describe, expect, it } from 'vitest'
import { assessToolCapture } from '@/lib/toolCaptureAdvice'
import type { CaptureFrame, Point } from '@/types'

const frame: CaptureFrame = {
  source_width: 1000,
  source_height: 800,
  corrected_to_source: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  optical_center: { x: 500, y: 400 },
  full_frame_width: 1000,
  full_frame_height: 800,
}
const outline = (x: number, y: number): Point[] => [
  { x, y }, { x: x + 1, y }, { x, y: y + 1 },
]
const assessed = (edgeContact: boolean, outerFrame: boolean) => ({ status: 'assessed', edgeContact, outerFrame })

describe('assessToolCapture', () => {
  it('distinguishes original-edge contact, conditional outer-frame advice and no position flags', () => {
    expect(assessToolCapture(outline(500, 400), frame)).toEqual(assessed(false, false))
    expect(assessToolCapture(outline(848, 400), frame)).toEqual(assessed(false, false))
    expect(assessToolCapture(outline(849, 400), frame)).toEqual(assessed(false, true))
    expect(assessToolCapture(outline(150, 400), frame)).toEqual(assessed(false, true))
    expect(assessToolCapture(outline(500, 120), frame)).toEqual(assessed(false, true))
    expect(assessToolCapture(outline(500, 679), frame)).toEqual(assessed(false, true))
    for (const points of [outline(2, 400), outline(997, 400), outline(500, 2), outline(500, 797)]) {
      expect(assessToolCapture(points, frame)).toEqual(assessed(true, true))
    }
    expect(assessToolCapture(outline(3, 400), frame)).toEqual(assessed(false, true))
  })

  it('uses a projective, turned, offset source mapping rather than corrected-image position', () => {
    const projective: CaptureFrame = {
      ...frame,
      corrected_to_source: [[0, 2, -100], [3, 0, -200], [0.002, 0, 1]],
    }
    // (200, 720) maps to (957.14, 285.71); (200, 750) to (1000, 285.71).
    expect(assessToolCapture(outline(200, 500), projective)).toEqual(assessed(false, false))
    expect(assessToolCapture(outline(200, 720), projective)).toEqual(assessed(false, true))
    expect(assessToolCapture(outline(200, 750), projective)).toEqual(assessed(true, true))
    // Same photographed outlines after x shrinks by 1/2 and y by 2/5.
    const resized: CaptureFrame = {
      ...frame,
      corrected_to_source: [[0, 5, -100], [6, 0, -200], [0.004, 0, 1]],
    }
    const resizedPoints = outline(200, 720).map(({ x, y }) => ({ x: x / 2, y: y * 2 / 5 }))
    expect(assessToolCapture(resizedPoints, resized)).toEqual(assessed(false, true))
  })

  it('uses the pre-crop optical center and spans but still checks cropped source edges', () => {
    const cropped: CaptureFrame = {
      ...frame,
      optical_center: { x: -250, y: 400 },
      full_frame_width: 2500,
    }
    expect(assessToolCapture(outline(500, 400), cropped)).toEqual(assessed(false, false))
    expect(assessToolCapture(outline(700, 400), cropped)).toEqual(assessed(false, true))
    expect(assessToolCapture(outline(2, 400), cropped)).toEqual(assessed(true, false))
  })

  it('leaves absent or unusable capture data unknown without a center fallback', () => {
    expect(assessToolCapture(outline(500, 400), undefined)).toEqual({ status: 'unavailable', reason: 'missing-frame' })
    expect(assessToolCapture(outline(500, 400), null)).toEqual({ status: 'unavailable', reason: 'missing-frame' })
    const invalidFrames: CaptureFrame[] = [
      { ...frame, source_width: 0 },
      { ...frame, source_height: 1.5 },
      { ...frame, full_frame_width: Infinity },
      { ...frame, full_frame_height: -1 },
      { ...frame, optical_center: { x: NaN, y: 400 } },
      { ...frame, corrected_to_source: [[1, 0, 0], [0, 0, 0], [0, 0, 1]] },
      { ...frame, corrected_to_source: [[NaN, 0, 0], [0, 1, 0], [0, 0, 1]] },
      { ...frame, corrected_to_source: [[1, 0], [0, 1], [0, 0]] as unknown as CaptureFrame['corrected_to_source'] },
    ]
    for (const invalid of invalidFrames) {
      expect(assessToolCapture(outline(500, 400), invalid)).toEqual({ status: 'unavailable', reason: 'invalid-frame' })
    }
  })

  it('does not partially assess empty, invalid or projectively unbounded outlines', () => {
    for (const points of [[], [{ x: 0, y: 0 }], [...outline(2, 400), { x: NaN, y: 0 }]]) {
      expect(assessToolCapture(points, frame)).toEqual({ status: 'unavailable', reason: 'invalid-outline' })
    }
    const horizon: CaptureFrame = { ...frame, corrected_to_source: [[1, 0, 0], [0, 1, 0], [1, 0, -10]] }
    expect(assessToolCapture(outline(10, 20), horizon)).toEqual({ status: 'unavailable', reason: 'invalid-outline' })
    expect(assessToolCapture([{ x: 9, y: 20 }, { x: 11, y: 20 }, { x: 11, y: 21 }], horizon)).toEqual({ status: 'unavailable', reason: 'invalid-outline' })
  })
})

it('reassesses edited geometry without changing the saved outline', () => {
  const points = outline(500, 400)
  const before = points.map(point => ({ ...point }))
  expect(assessToolCapture(points, frame)).toEqual(assessed(false, false))
  expect(points).toEqual(before)
  const moved = points.map(point => ({ x: point.x + 400, y: point.y }))
  expect(assessToolCapture(moved, frame)).toEqual(assessed(false, true))
  expect(points).toEqual(before)
})
