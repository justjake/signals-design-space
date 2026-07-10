/**
 * Host-baseline rows, run only by the react-control project against the
 * vanilla-React /control/ page (useState + startTransition + Suspense on
 * the same patched React build — no signals engine loads).
 *
 * Purpose: behavior observed identically on all four implementations is
 * attributed here. If a control row's pinned behavior ever changes, the
 * matching implementation rows (they cite each other) must be re-examined
 * before blaming any engine.
 */
import { expect, test } from '../fixtures'

async function gotoControl(page: import('@playwright/test').Page): Promise<void> {
	await page.goto('/control/')
	await expect(page.getByTestId('impl-name')).toHaveText('react-control')
}

async function clockTicksOnControl(page: import('@playwright/test').Page): Promise<boolean> {
	const before = await page.getByTestId('control-clock').textContent()
	return page
		.waitForFunction(
			(prev) => document.querySelector('[data-testid="control-clock"]')?.textContent !== prev,
			before,
			{ timeout: 2000 },
		)
		.then(() => true)
		.catch(() => false)
}

for (const order of ['B-first', 'A-first'] as const) {
	test(`CTRL-ENTANGLE.${order}: two suspended transitions entangle in vanilla React (${order} release)`, async ({
		page,
	}) => {
		await gotoControl(page)

		// Two transitions in separate tasks, each writing its own useState
		// value and suspending on its own held promise — the same schedule
		// the implementation battery runs as RCC-SU3.interleaved-gates.
		await page.evaluate(() => window.__control.holdA())
		await page.waitForTimeout(60)
		await page.evaluate(() => window.__control.holdB())
		await expect(page.getByTestId('value-a')).toHaveText('0')
		await expect(page.getByTestId('value-b')).toHaveText('0')
		// Committed UI stays live while both transitions are held.
		expect(await clockTicksOnControl(page)).toBe(true)

		// The host fact this row pins: releasing ONE gate commits NOTHING —
		// React renders the pending transition lanes jointly, and the retry
		// still suspends on the unresolved gate. Identical in both orders.
		const first = (order === 'B-first' ? 'releaseB' : 'releaseA') as 'releaseA' | 'releaseB'
		const second = (order === 'B-first' ? 'releaseA' : 'releaseB') as 'releaseA' | 'releaseB'
		await page.evaluate((fn) => window.__control[fn](), first)
		await page.waitForTimeout(400)
		await expect(page.getByTestId('value-a')).toHaveText('0')
		await expect(page.getByTestId('value-b')).toHaveText('0')

		// Releasing the second gate lands BOTH write sets, whole.
		await page.evaluate((fn) => window.__control[fn](), second)
		await expect(page.getByTestId('value-a')).toHaveText('10')
		await expect(page.getByTestId('value-b')).toHaveText('5')
	})
}
