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

// The playground's "suspend async" control parks the `asyncData` computed on a
// pending promise. Guards the suspended-node UI: the node reads as suspended
// and the inspector shows "suspended at <time>". The right-docked panel overlays
// this control at the test viewport width, so trigger it with a DOM-level click.
test('suspended node: suspend-async surfaces a suspended node with a suspended-at time', async ({ page }) => {
	await page.goto('/royale-fx2/?devtools')
	const panel = page.locator('.signals-devtools-root')
	await panel.locator('.nodelist tbody tr').first().waitFor()

	await page.getByTestId('arm-async').evaluate((el) => (el as HTMLButtonElement).click())
	// fx2 keeps serving the last settled value while pending — the stale value
	// stays on screen (no fallback flash), and devtools shows the node suspended.
	await expect(page.getByTestId('async-value')).toHaveText('idle')

	// The engine node is suspended, and the inspector reports when.
	await expect.poll(async () =>
		page.evaluate(() =>
			(globalThis as unknown as { __SIGNALS_DEVTOOLS__: { search(q: string, n: number): Array<{ label?: string; status: string }> } }).__SIGNALS_DEVTOOLS__
				.search('', 500)
				.some((n) => n.label === 'asyncData' && n.status === 'suspended'),
		),
	).toBe(true)

	await panel.locator('.nodelist tbody tr').filter({ hasText: 'asyncData' }).first().click()
	await expect(panel.locator('.inspector')).toContainText('suspended at')

	// Resolving clears it: the value renders 'loaded'.
	await page.getByTestId('arm-async').evaluate((el) => (el as HTMLButtonElement).click())
	await expect(page.getByTestId('async-value')).toHaveText('loaded')
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
