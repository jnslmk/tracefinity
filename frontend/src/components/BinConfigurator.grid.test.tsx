// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BinConfigurator } from './BinConfigurator'
import { FACTORY_BIN_CONFIG } from '@/lib/binDefaults'

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
