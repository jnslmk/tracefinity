import { expect, test } from '@playwright/test'
import { readFileSync } from 'fs'
import path from 'path'

const API = 'http://localhost:8000/api'

// Real sessions, library tools, bins, persistence and STL generation. No planner mocks.
test('measured toolbox height, explicit proposal, supported stack and reload', async ({ page }) => {
  test.setTimeout(180_000)
  let sessionId: string | undefined
  let toolId: string | undefined
  let projectId: string | undefined
  const binIds: string[] = []
  try {
    const upload = await page.request.post(`${API}/upload`, { multipart: {
      image: { name: 'tool.jpg', mimeType: 'image/jpeg', buffer: readFileSync(path.join(__dirname, 'fixtures', 'tool.jpg')) },
    } })
    expect(upload.status()).toBe(200)
    const uploaded = await upload.json()
    sessionId = uploaded.session_id
    expect(uploaded.image_width).toBeGreaterThan(0)
    expect(uploaded.image_height).toBeGreaterThan(0)
    // Paper corners measured from this fixture, scaled to the ingested image.
    // Manual corners use the same real contract when automatic detection is absent.
    const corners = uploaded.detected_corners?.length === 4 ? uploaded.detected_corners : [
      [.196, .137], [.865, .127], [.879, .84], [.224, .858],
    ].map(([x, y]) => ({ x: x * uploaded.image_width, y: y * uploaded.image_height }))
    const corrected = await page.request.post(`${API}/sessions/${sessionId}/corners`, { data: { corners, paper_size: 'a4' } })
    expect(corrected.status()).toBe(200)
    expect((await page.request.put(`${API}/sessions/${sessionId}/polygons`, { data: { polygons: [{
      id: 'toolbox-outline', label: 'Toolbox thickness fixture',
      points: [{ x: 300, y: 300 }, { x: 500, y: 300 }, { x: 500, y: 500 }, { x: 300, y: 500 }],
    }] } })).status()).toBe(200)
    const saved = await page.request.post(`${API}/sessions/${sessionId}/save-tools`, { data: {} })
    expect(saved.status()).toBe(200)
    toolId = (await saved.json()).tool_ids[0]
    await page.goto(`/tools/${toolId}`)
    const measurementSaved = page.waitForResponse(response => response.url().endsWith(`/tools/${toolId}`) && response.request().method() === 'PUT' && response.status() === 200 && response.request().postDataJSON().thickness_mm === 12)
    await page.getByLabel('Tool thickness (mm)', { exact: true }).fill('12')
    await measurementSaved
    expect((await (await page.request.get(`${API}/tools/${toolId}`)).json()).thickness_mm).toBe(12)

    const projectResponse = await page.request.post(`${API}/bin-projects`, { data: { name: 'Isolated toolbox browser scenario', tool_ids: [toolId] } })
    expect(projectResponse.status()).toBe(200)
    projectId = (await projectResponse.json()).id
    const lowerResponse = await page.request.post(`${API}/bins`, { data: {
      name: 'Lower measured bin', project_id: projectId, tool_ids: [toolId],
      bin_config: { height_units: 4, cutout_depth: 5, magnets: false },
    } })
    expect(lowerResponse.status()).toBe(200)
    const lowerId = (await lowerResponse.json()).id
    binIds.push(lowerId)
    await page.goto(`/bins/${lowerId}`)
    const heightPanel = page.getByRole('region', { name: 'Fit height to tools' })
    await expect(heightPanel.getByLabel('Does not fit', { exact: true })).toBeVisible()
    await expect(heightPanel.getByRole('button', { name: 'Auto-set bin height' })).toBeEnabled()
    const proposalSaved = page.waitForResponse(response => response.url().endsWith(`/bins/${lowerId}`) && response.request().method() === 'PUT' && response.status() === 200 && response.request().postDataJSON().bin_config?.height_units === 3)
    await heightPanel.getByRole('button', { name: 'Auto-set bin height' }).focus()
    await page.keyboard.press('Enter')
    await proposalSaved
    const lower = await (await page.request.get(`${API}/bins/${lowerId}`)).json()
    expect(lower.bin_config.cutout_depth).toBe(12)
    expect(lower.bin_config.height_units).toBe(3)
    await expect(heightPanel.getByLabel('Fits', { exact: true })).toBeVisible()
    const upperResponse = await page.request.post(`${API}/bins`, { data: {
      name: 'Upper measured bin', project_id: projectId, tool_ids: [toolId], bin_config: lower.bin_config,
    } })
    expect(upperResponse.status()).toBe(200)
    const upper = await upperResponse.json()
    const upperId = upper.id
    binIds.push(upperId)
    const initialGridX = lower.bin_config.grid_x + upper.bin_config.grid_x
    const gridY = Math.max(lower.bin_config.grid_y, upper.bin_config.grid_y)
    const widthMm = initialGridX * 42 + 16
    const depthMm = gridY * 42
    const stackX = upper.bin_config.grid_x
    const sketchResponse = await page.request.post(`${API}/bin-projects/${projectId}/sketches`, { data: { name: 'Closed-lid plan', target_grid_x: initialGridX, target_grid_y: gridY } })
    expect(sketchResponse.status()).toBe(200)
    const sketchId = (await sketchResponse.json()).id
    const sketchUrl = `${API}/bin-projects/${projectId}/sketches/${sketchId}`
    expect((await page.request.patch(sketchUrl, { data: { bin_layout: [
      { id: 'lower', bin_id: lowerId, x: 0, y: 0 }, { id: 'upper', bin_id: upperId, x: lower.bin_config.grid_x, y: 0 },
    ] } })).status()).toBe(200)
    const browserUrl = `/projects/${projectId}/sketch/${sketchId}`
    await page.goto(browserUrl)
    await page.getByLabel('Usable width (mm)', { exact: true }).fill(String(widthMm))
    await page.getByLabel('Usable depth (mm)', { exact: true }).fill(String(depthMm))
    await page.getByLabel('Container height units').fill('10')
    await page.getByLabel('Safety clearance (mm)', { exact: true }).fill('0')
    await expect(page.getByTestId('plan-fit-status')).toHaveText(/verified/)
    const upperMember = page.getByRole('button', { name: /Placement 2: Upper measured bin/ })
    await upperMember.focus()
    await page.keyboard.press('Enter')
    const stacked = page.waitForResponse(response => response.url().includes('/placements/upper/stack-action') && response.status() === 200)
    await page.getByLabel('Stack on placement').selectOption('lower')
    await stacked
    await expect(page.getByTestId('plan-fit-status')).toHaveText(/verified/)
    const assessed = await (await page.request.post(sketchUrl + '/assessment', { data: {} })).json()
    expect(assessed.occupied_floor_units).toBe(lower.bin_config.grid_x * lower.bin_config.grid_y)
    expect(assessed.placements.find((p: { placement_id: string }) => p.placement_id === 'upper').z_mm).toBe(21)

    const lowerMember = page.getByRole('button', { name: /Placement 1: Lower measured bin/ })
    await lowerMember.focus()
    await page.keyboard.press('Enter')
    await expect(lowerMember).toHaveAttribute('aria-pressed', 'true')
    await page.getByLabel('Stack X').fill(String(stackX))
    await expect(page.getByTestId('plan-fit-status')).toHaveText(/verified/)
    await page.getByRole('button', { name: 'Side clearance', exact: true }).click()
    await expect(page.getByRole('img', { name: 'Side clearance diagram' })).toBeVisible()
    await expect(page.getByText(/Closed lid ceiling 70 mm/)).toBeVisible()
    const meshes = binIds.map(id => page.waitForResponse(response => response.url().includes(`/outputs/${id}.stl`) && response.status() === 200))
    await page.getByRole('button', { name: '3D', exact: true }).click()
    await Promise.all(meshes)
    await expect(page.locator('canvas')).toBeVisible()
    await expect(page.getByText('Approximate block: geometry pending or unavailable')).toHaveCount(0)
    await expect(page.getByText(/Toolbox thickness fixture — conservative envelope/).first()).toBeVisible()
    await page.getByLabel('Usable height (mm)', { exact: true }).fill('40')
    await expect(page.getByTestId('plan-fit-status')).toHaveText(/invalid/)
    await expect(page.getByRole('region', { name: 'Toolbox fit diagnostics' }).getByRole('alert').filter({ hasText: /closed lid/ }).first()).toBeVisible()
    const restored = page.waitForResponse(response => response.url() === sketchUrl && response.request().method() === 'PATCH' && response.status() === 200 && response.request().postDataJSON().container_height_mm === 70)
    await page.getByLabel('Usable height (mm)', { exact: true }).fill('70')
    await restored
    await expect(page.getByTestId('plan-fit-status')).toHaveText(/verified/)
    expect((await page.request.put(`${API}/tools/${toolId}`, { data: { thickness_mm: 100 } })).status()).toBe(200)
    await page.getByRole('button', { name: 'Reassess shared tools and bins' }).click()
    await expect(page.getByTestId('plan-fit-status')).toHaveText(/invalid/)
    await page.getByRole('button', { name: 'Side clearance', exact: true }).click()
    const diagram = page.getByRole('img', { name: 'Side clearance diagram' })
    await expect.poll(() => diagram.evaluate(element => {
      const svg = element as SVGSVGElement
      const bounds = svg.viewBox.baseVal
      const rectangles = Array.from(svg.querySelectorAll('rect')).map(rectangle => rectangle.getBBox())
      const contents = Array.from(svg.querySelectorAll<SVGGraphicsElement>('rect, text')).map(item => item.getBBox())
      return rectangles.some(rectangle => rectangle.y < 0) &&
        contents.every(item => item.y >= bounds.y && item.y + item.height <= bounds.y + bounds.height)
    })).toBe(true)
    expect((await page.request.put(`${API}/tools/${toolId}`, { data: { thickness_mm: 12 } })).status()).toBe(200)
    await page.getByRole('button', { name: 'Reassess shared tools and bins' }).click()
    await expect(page.getByTestId('plan-fit-status')).toHaveText(/verified/)
    await page.reload()
    await expect(page.getByLabel('Usable height (mm)', { exact: true })).toHaveValue('70')
    await expect(page.getByLabel('Safety clearance (mm)', { exact: true })).toHaveValue('0')
    await expect(page.getByTestId('plan-fit-status')).toHaveText(/verified/)
    const reloaded = await (await page.request.get(`${API}/bin-projects/${projectId}`)).json()
    const plan = reloaded.sketches.find((s: { id: string }) => s.id === sketchId)
    expect(plan.bin_layout.find((p: { id: string }) => p.id === 'upper').support_id).toBe('lower')
    expect(plan.bin_layout.map((p: { x: number }) => p.x)).toEqual([stackX, stackX])

    // Missing measurements must not turn the one-click action into a false fit.
    expect((await page.request.put(`${API}/tools/${toolId}`, { data: { thickness_mm: null } })).status()).toBe(200)
    await page.goto(`/bins/${lowerId}`)
    await expect(heightPanel.getByLabel('Fit unknown', { exact: true })).toBeVisible()
    await expect(heightPanel.getByRole('button', { name: 'Auto-set bin height' })).toBeDisabled()
    expect((await page.request.put(`${API}/tools/${toolId}`, { data: { thickness_mm: 12 } })).status()).toBe(200)
    await page.reload()
    await expect(heightPanel.getByLabel('Fits', { exact: true })).toBeVisible()
    const removalSaved = page.waitForResponse(response => response.url().endsWith(`/bins/${lowerId}`) && response.request().method() === 'PUT' && response.status() === 200 && response.request().postDataJSON().placed_tools?.length === 0)
    await heightPanel.getByRole('button', { name: 'Remove Toolbox thickness fixture from bin' }).focus()
    await page.keyboard.press('Enter')
    await removalSaved
    await page.reload()
    await expect(heightPanel.getByRole('listitem')).toHaveCount(0)
    await expect(heightPanel.getByRole('button', { name: 'Auto-set bin height' })).toBeDisabled()
    expect((await page.request.get(`${API}/tools/${toolId}`)).status()).toBe(200)
  } finally {
    await page.goto('about:blank')
    for (const id of binIds) await page.request.delete(`${API}/bins/${id}`)
    if (projectId) await page.request.delete(`${API}/bin-projects/${projectId}`)
    if (toolId) await page.request.delete(`${API}/tools/${toolId}`)
    if (sessionId) await page.request.delete(`${API}/sessions/${sessionId}`)
  }
})
