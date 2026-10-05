// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { AccessPocket } from '@/types'
import { AccessPocketControls } from './AccessPocketControls'

const pocket = (over: Partial<AccessPocket> = {}): AccessPocket => ({
  id: 'p1', shape: 'rectangle', x: 42, y: 42, length: 30, width: 20, depth: 8,
  rotation: 0, edge: 'inherit', edge_size: 1, corner_radius: 0, bottom_radius: 0,
  ...over,
})

function renderControls(pocketValue: AccessPocket, overrides: Partial<Parameters<typeof AccessPocketControls>[0]> = {}) {
  const onChange = vi.fn()
  const props = {
    pocket: pocketValue, binChamfer: 0, maxDepth: 21.25,
    onChange, onDuplicate: vi.fn(), onDelete: vi.fn(),
    ...overrides,
  }
  function Harness() {
    const [value, setValue] = useState(pocketValue)
    const { onChange: _onChange, pocket: _pocket, ...rest } = props
    return (
      <AccessPocketControls
        {...rest}
        pocket={value}
        onChange={(updates, label) => { onChange(updates, label); setValue(prev => ({ ...prev, ...updates })) }}
      />
    )
  }
  render(<Harness />)
  return props
}

describe('AccessPocketControls', () => {
  afterEach(cleanup)

  it('shows exact dimensions and the rectangle Geometry section', () => {
    renderControls(pocket())
    expect(screen.getByLabelText('Access pocket settings')).toBeTruthy()
    expect((screen.getByLabelText('Length (mm)') as HTMLInputElement).value).toBe('30')
    expect((screen.getByLabelText('Angle (°)') as HTMLInputElement).value).toBe('0')
    expect(screen.getByText('Geometry')).toBeTruthy()
    expect(screen.getByLabelText('Corner radius')).toBeTruthy()
    expect(screen.getByLabelText('Bottom radius')).toBeTruthy()
  })

  it('commits exact dimension edits', () => {
    const { onChange } = renderControls(pocket())
    const length = screen.getByLabelText('Length (mm)')
    fireEvent.change(length, { target: { value: '45' } })
    fireEvent.blur(length)
    expect(onChange).toHaveBeenCalledWith({ length: 45 }, 'Resize pocket')
  })

  it('caps the depth field at the protected-floor maximum', () => {
    renderControls(pocket({ depth: 40 }), { maxDepth: 21.25 })
    expect((screen.getByLabelText('Depth (mm)') as HTMLInputElement).max).toBe('21.25')
  })

  it('clamps a depth above the protected-floor maximum and explains the adjustment', () => {
    const { onChange } = renderControls(pocket({ depth: 40 }), { maxDepth: 21.25 })
    const depth = screen.getByLabelText('Depth (mm)')
    fireEvent.change(depth, { target: { value: '999' } })
    fireEvent.blur(depth)
    expect(onChange).toHaveBeenCalledWith({ depth: 21.25 }, 'Change pocket depth')
    const message = screen.getByRole('status').textContent ?? ''
    expect(message).toContain('999')
    expect(message).toContain('21.25')
    expect(message).toContain('protected-floor maximum')
  })

  it('explains a clamped entry on any geometry field', () => {
    const { onChange } = renderControls(pocket())
    const width = screen.getByLabelText('Width (mm)')
    fireEvent.change(width, { target: { value: '900' } })
    fireEvent.blur(width)
    expect(onChange).toHaveBeenCalledWith({ width: 400 }, 'Resize pocket')
    expect(screen.getByRole('status').textContent).toContain('900')
    expect(screen.getByRole('status').textContent).toContain('400')
  })

  it('reveals an edge-size field only for an explicit chamfer or fillet', () => {
    renderControls(pocket())
    expect(screen.queryByLabelText('Chamfer size (mm)')).toBeNull()
    fireEvent.change(screen.getByLabelText('Opening edge'), { target: { value: 'chamfer' } })
    expect(screen.getByLabelText('Chamfer size (mm)')).toBeTruthy()
  })

  it('switches to a scoop with the contract defaults and clears the radii', () => {
    const { onChange } = renderControls(pocket({ corner_radius: 3 }))
    fireEvent.click(screen.getByRole('button', { name: 'Rounded scoop' }))
    expect(onChange).toHaveBeenCalledWith(
      { shape: 'scoop', edge: 'fillet', edge_size: 1, corner_radius: 0, bottom_radius: 0 },
      'Change pocket shape',
    )
  })

  it('hides the rectangle Geometry section for a scoop', () => {
    renderControls(pocket({ shape: 'scoop' }))
    expect(screen.queryByText('Geometry')).toBeNull()
    expect(screen.getByText(/curved-bottom trough/)).toBeTruthy()
  })

  it('exposes the effective depth and opening-edge finish', () => {
    renderControls(pocket({ depth: 40 }), { maxDepth: 21.25 })
    const note = screen.getByText(/Effective depth 21.25mm/)
    expect(note.textContent).toMatch(/clamped from 40.00mm/)
  })

  it('shows a validation error instead of silently changing geometry', () => {
    renderControls(pocket({ corner_radius: 11 }))
    expect(screen.getByRole('alert').textContent).toMatch(/Corner radius/)
  })

  it('offers duplicate and delete actions', () => {
    const onDuplicate = vi.fn()
    const onDelete = vi.fn()
    renderControls(pocket(), { onDuplicate, onDelete })
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDuplicate).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
  })
})
