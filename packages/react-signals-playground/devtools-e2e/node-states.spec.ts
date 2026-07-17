import { expect, test } from '@playwright/test'

// The playground's "arm error" control throws from the `errorBoom` computed
// (caught by a boundary so the page survives). Guards the errored-node UI:
// the node reads as errored and the inspector shows "errored at <time>".
test('errored node: arm-error surfaces an errored node with an errored-at time', async ({ page }) => {
	await page.goto('/royale-fx2/?devtools')
	const panel = page.locator('.signals-devtools-root')
	await panel.locator('.nodelist tbody tr').first().waitFor()

	await page.getByTestId('arm-error').click()
	await expect(page.getByTestId('boom-caught')).toBeVisible() // boundary caught the throw; page alive

	// The engine node is errored, and the inspector reports when.
	await expect.poll(async () =>
		page.evaluate(() =>
			(globalThis as unknown as { __SIGNALS_DEVTOOLS__: { search(q: string, n: number): Array<{ label?: string; status: string }> } }).__SIGNALS_DEVTOOLS__
				.search('', 500)
				.some((n) => n.label === 'errorBoom' && n.status === 'error'),
		),
	).toBe(true)

	await panel.locator('.nodelist tbody tr').filter({ hasText: 'errorBoom' }).first().click()
	await expect(panel.locator('.inspector')).toContainText('errored at')
})

// Effects show up as soon as the urgent counter changes (an effect reacts to it).
test('effect nodes: a +1 urgent produces effect nodes', async ({ page }) => {
	await page.goto('/royale-fx2/?devtools')
	const panel = page.locator('.signals-devtools-root')
	await panel.locator('.nodelist tbody tr').first().waitFor()
	await page.getByTestId('increment').click()
	await expect.poll(async () =>
		page.evaluate(() => (globalThis as unknown as { __SIGNALS_DEVTOOLS__: { counts(): { byKind: { effect?: number } } } }).__SIGNALS_DEVTOOLS__.counts().byKind.effect ?? 0),
	).toBeGreaterThan(0)
})
