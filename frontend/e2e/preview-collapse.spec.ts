import { test, expect } from '@playwright/test'

test('collapsing the 3D preview frees canvas space without resetting editor state', async ({ page }) => {
  await page.setViewportSize({ width: 948, height: 943 })
  const response = await page.request.post('http://localhost:8000/api/bins', {
    data: { name: 'Preview collapse test' },
  })
  expect(response.ok()).toBeTruthy()
  const { id } = await response.json()

  try {
    await page.goto(`/bins/${id}`)
    const editor = page.getByTestId('bin-editor')
    const preview = page.locator('#bin-3d-preview')
    const hide = page.getByRole('button', { name: 'Hide 3D preview', exact: true })
    await expect(hide).toBeVisible()
    await expect(preview).toBeVisible()
    const originalWidth = (await editor.boundingBox())!.width

    await page.getByRole('button', { name: 'Snap', exact: true }).click()
    const snapDistance = page.getByTitle('Snap distance (mm) — how far apart the snap grid points are')
    await snapDistance.fill('7')
    await snapDistance.press('Enter')

    await hide.click()
    const show = page.getByRole('button', { name: 'Show 3D preview', exact: true })
    await expect(show).toHaveAttribute('aria-expanded', 'false')
    await expect(preview).toBeHidden()
    await expect(page.getByTestId('bin-canvas')).toBeVisible()
    expect((await editor.boundingBox())!.width).toBeGreaterThan(originalWidth + 200)
    await expect(snapDistance).toHaveValue('7')

    await show.focus()
    await show.press('Space')
    await expect(hide).toHaveAttribute('aria-expanded', 'true')
    await expect(preview).toBeVisible()
    expect((await editor.boundingBox())!.width).toBe(originalWidth)
    await expect(snapDistance).toHaveValue('7')
  } finally {
    await page.request.delete(`http://localhost:8000/api/bins/${id}`)
  }
})
