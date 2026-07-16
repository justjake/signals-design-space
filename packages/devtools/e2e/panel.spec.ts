import { expect, test } from '@playwright/test'

test('inline panel shows the live fx2 graph + log and updates on interaction', async ({ page }) => {
	await page.goto('/')
	const panel = page.getByTestId('panel')

	// Graph is the default tab: nodes are discovered, listed, and inspectable.
	await expect(panel.getByRole('button', { name: 'Graph', exact: true })).toHaveAttribute('aria-current', 'page')
	await expect(panel).toContainText('doubled')
	// Click the node-list row to inspect it (the whole row selects).
	await panel.locator('.nodelist tbody tr').filter({ hasText: 'doubled' }).first().click()
	await expect(panel).toContainText('Value')
	await expect(panel).toContainText('Upstream')
	await expect(panel).toContainText('Downstream')

	// The live app works and the panel reflects new activity. count starts at
	// 1 (initial write), so doubled is 2.
	const out = page.getByTestId('out')
	await expect(out).toHaveText('2')

	// Log tab: real entries with fx2's verbatim kind strings and node names.
	await panel.getByRole('button', { name: 'Log', exact: true }).click()
	await expect(panel).toContainText('set')
	await expect(panel).toContainText('compute')
	await expect(panel).toContainText('effect')
	await expect(panel).toContainText('count')

	const rowsBefore = await panel.locator('.log tbody tr').count()

	await page.getByTestId('inc').click()
	await expect(out).toHaveText('4') // doubled recomputed live in the app

	// The devtools captured the new activity: more log rows than before.
	await expect.poll(async () => panel.locator('.log tbody tr').count()).toBeGreaterThan(rowsBefore)
})
