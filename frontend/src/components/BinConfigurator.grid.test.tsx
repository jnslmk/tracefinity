// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BinConfigurator } from './BinConfigurator'
import { FACTORY_BIN_CONFIG } from '@/lib/binDefaults'
import type { GridSizingMode } from '@/lib/constants'

afterEach(cleanup)
beforeEach(() => localStorage.setItem('theme', 'dark'))

function row(label: string) {
  return within(screen.getByText(label, { exact: true }).parentElement!)
}

it.each([
  ['Grid Width', 'Grid Depth', 16, 5.5],
  ['Grid Depth', 'Grid Width', 14, 7],
])('keeps the other thumb stationary when changing %s and respects the cell limit', (changed, unchanged, limit, otherValue) => {
  function Configurator() {
    const [config, setConfig] = useState({ ...FACTORY_BIN_CONFIG, grid_x: 7, grid_y: 5.5 })
    return <BinConfigurator config={config} onChange={setConfig} />
  }
  render(<Configurator />)
  const slider = row(changed).getByRole('slider') as HTMLInputElement
  const other = row(unchanged).getByRole('slider') as HTMLInputElement
  const otherMax = other.max
  const otherPosition = other.style.getPropertyValue('--slider-pct')

  fireEvent.change(slider, { target: { value: '8' } })
  expect(other.value).toBe(String(otherValue))
  expect(other.max).toBe(otherMax)
  expect(other.style.getPropertyValue('--slider-pct')).toBe(otherPosition)

  fireEvent.change(slider, { target: { value: '25' } })
  expect(slider.value).toBe(String(limit))
  expect((row(changed).getByRole('spinbutton') as HTMLInputElement).value).toBe(String(limit))
  expect(other.value).toBe(String(otherValue))
})

it('keeps depth editable with auto width and permits deeper bins by reducing width to the cell cap', () => {
  function Configurator() {
    const [config, setConfig] = useState({ ...FACTORY_BIN_CONFIG, grid_x: 25, grid_y: 4 })
    const [mode, setMode] = useState<GridSizingMode>('auto')
    return <BinConfigurator config={config} onChange={setConfig} gridSizingMode={mode} onGridSizingModeChange={setMode} />
  }
  render(<Configurator />)
  const width = row('Grid Width').getByRole('slider') as HTMLInputElement
  const depth = row('Grid Depth').getByRole('slider') as HTMLInputElement
  expect(width.disabled).toBe(true)
  expect(depth.disabled).toBe(true)
  fireEvent.change(screen.getByRole('combobox', { name: 'Grid sizing' }), { target: { value: 'fixed_depth' } })
  expect(width.disabled).toBe(true)
  expect(depth.disabled).toBe(false)
  fireEvent.change(depth, { target: { value: '25' } })
  expect(depth.value).toBe('25')
  expect(width.value).toBe('4')
  fireEvent.change(screen.getByRole('combobox', { name: 'Grid sizing' }), { target: { value: 'fixed' } })
  expect(width.disabled).toBe(false)
  expect(depth.disabled).toBe(false)
})
