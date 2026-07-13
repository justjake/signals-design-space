/**
 * RCC-RT4 in BOTH variants. Each implementation runs exactly the variant it
 * is ruled (or discovered) to follow and skips the other with the ruling as
 * the annotation — see the manifest's implementation table for provenance:
 * cosignals → newest (scenario R15); alt-a/alt-b → drafts-hidden
 * (ambient-W0); solid-react and royale-fx2 → drafts-hidden.
 */
import { expect, test } from '../fixtures'
import { applyExpectation } from '../expectations'
import { gotoApp } from '../helpers'

test('RCC-RT4-newest: an outside-render read during a pending transition sees the pending write', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT4-newest', entry)
	await gotoApp(page, entry)

	const during = await page.evaluate(() => {
		const before = window.__store.read('count') as number
		window.__store.holdTransition({ count: before + 10 })
		// A foreign call stack (evaluate), no render in sight: RT4 says this
		// read observes newest state — the pending write included.
		return { before, read: window.__store.read('count') as number }
	})
	expect(during.read).toBe(during.before + 10)
	// The pending write is still invisible to the committed UI.
	await expect(page.getByTestId('count')).toHaveText(String(during.before))

	await page.evaluate(() => window.__store.releaseHold())
	await expect(page.getByTestId('count')).toHaveText(String(during.before + 10))
})

test('RCC-RT4-drafts-hidden: an outside-render read during a pending transition sees committed state only', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT4-drafts-hidden', entry)
	await gotoApp(page, entry)

	if (entry.holdStyle === 'suspense') {
		const during = await page.evaluate(() => {
			const before = window.__store.read('count') as number
			window.__store.holdTransition({ count: before + 10 })
			return { before, read: window.__store.read('count') as number }
		})
		expect(during.read, 'ambient read leaked the pending draft').toBe(during.before)

		await page.evaluate(() => window.__store.releaseHold())
		await expect(page.getByTestId('count')).toHaveText(String(during.before + 10))
		expect(await page.evaluate(() => window.__store.read('count'))).toBe(during.before + 10)
	} else {
		// defer-write cannot hold on a gate; a CPU-heavy transition render
		// opens the pending window instead. Both probes run in one evaluate
		// turn, so the DOM snapshot proves the reads happened while pending.
		await page.evaluate(() => window.__store.setLatticeWork(10))
		await page.getByTestId('lattice-show-plain').click()
		await expect(page.getByTestId('lattice')).toBeVisible({ timeout: 20_000 })

		const during = await page.evaluate(async () => {
			const before = window.__store.read('count') as number
			window.__store.transitionWrite('count', before + 10)
			const atOnce = window.__store.read('count') as number
			await new Promise((resolve) => setTimeout(resolve, 30))
			return {
				before,
				atOnce,
				midWindow: window.__store.read('count') as number,
				domStillOld:
					document.querySelector('[data-testid="count"]')?.textContent === String(before),
			}
		})
		expect(during.domStillOld, 'pending window closed before the probe read').toBe(true)
		expect(during.atOnce, 'ambient read leaked the staged draft').toBe(during.before)
		expect(during.midWindow).toBe(during.before)

		await expect(page.getByTestId('count')).toHaveText(String(during.before + 10), {
			timeout: 30_000,
		})
		expect(await page.evaluate(() => window.__store.read('count'))).toBe(during.before + 10)
	}
})
