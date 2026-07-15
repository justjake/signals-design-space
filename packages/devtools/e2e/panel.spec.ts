import { expect, test } from '@playwright/test'

test('inline panel shows the live fx2 graph + log and updates on interaction', async ({ page }) => {
	await page.goto('/')
	const panel = page.getByTestId('panel')

	// Log is the default tab: real entries with fx2's verbatim kind strings
	// and the node that produced them.
	await expect(panel).toContainText('write')
	await expect(panel).toContainText('compute')
	await expect(panel).toContainText('effect-run')
	await expect(panel).toContainText('count')

	// Graph tab: the nodes are discovered and inspectable.
	await panel.getByRole('button', { name: 'Graph', exact: true }).click()
	await expect(panel).toContainText('doubled')
	await panel.getByRole('button', { name: 'doubled', exact: true }).first().click()
	await expect(panel).toContainText('Value')
	await expect(panel).toContainText('Dependencies')

	// The live app works and the panel reflects new activity. count starts at
	// 1 (initial write), so doubled is 2.
	const out = page.getByTestId('out')
	await expect(out).toHaveText('2')

	await panel.getByRole('button', { name: 'Log', exact: true }).click()
	const rowsBefore = await panel.locator('.sd-table tbody tr').count()

	await page.getByTestId('inc').click()
	await expect(out).toHaveText('4') // doubled recomputed live in the app

	// The devtools captured the new activity: more log rows than before.
	await expect
		.poll(async () => panel.locator('.sd-table tbody tr').count())
		.toBeGreaterThan(rowsBefore)
})
