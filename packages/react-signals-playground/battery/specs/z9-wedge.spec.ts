/**
 * Wedge-class rows, isolated in the last spec file: some of these
 * deliberately drive a known main-thread wedge (the alt-b filter/rows
 * update loop). Every blocking step runs page-side under a watchdog; on a
 * hang the live stack is captured over CDP and attached before the
 * assertion decides what the hang means for this implementation.
 *
 * Manifest rows: FIND-EQUAL-SAFE, FIND-SOLID-HEAP, FIND-THENABLE.nav,
 * FIND-THENABLE.gate, FIND-ALTB-WEDGE.filter, FIND-ALTB-WEDGE.rows.
 * Ordering within this file is least- to most-destructive.
 */
import { expect, test } from '../fixtures'
import { applyExpectation } from '../expectations'
import {
	clockTicks,
	dispatchFilterInput,
	gotoApp,
	holdNavigate,
	rafHealth,
	releaseAndSettle,
	testidText,
	withWatchdog,
} from '../helpers'

// A wedged page cannot produce a meaningful screenshot (the wedge-stack
// attachment is the evidence), and post-failure teardown against a spinning
// renderer must stay cheap — so this file caps its own budget.
test.use({ screenshot: 'off' })
test.describe.configure({ timeout: 45_000 })

test('FIND-EQUAL-SAFE: equality-cutoff urgent writes during a held navigation never wedge', async ({
	page,
	entry,
}, testInfo) => {
	applyExpectation(test, 'FIND-EQUAL-SAFE', entry)
	await gotoApp(page, entry)
	await holdNavigate(page, 'table')

	// The wedge's positive boundary: counter and evens toggle are pinned
	// safe on every implementation, alt-b included.
	const outcome = await withWatchdog(page, testInfo, 'equal-safe-writes', 5000, () =>
		page.evaluate(() => {
			document.querySelector<HTMLButtonElement>('[data-testid="increment"]')?.click()
			document.querySelector<HTMLButtonElement>('[data-testid="toggle-evens"]')?.click()
		}),
	)
	expect(outcome.wedged, `wedged: ${outcome.stack?.join(' | ')}`).toBe(false)
	await expect(page.getByTestId('count')).toHaveText('1')
	await expect(page.getByTestId('toggle-evens')).toHaveAttribute('aria-pressed', 'true')
	await releaseAndSettle(page, 'table')
})

test('FIND-SOLID-HEAP: urgent write outside any transition with derived-subscribed components stays live', async ({
	page,
	entry,
}, testInfo) => {
	applyExpectation(test, 'FIND-SOLID-HEAP', entry)
	await gotoApp(page, entry)
	// Dashboard subscribes doubled/parity/scaled deriveds — the trio that
	// parked solid-react's render probe in its dirty heap before the shim
	// degraded memos. This row pins the workaround: signal + derived +
	// urgent write with no transition open.
	await expect(page.getByTestId('view-panel')).toHaveAttribute('data-view', 'dashboard')

	const outcome = await withWatchdog(page, testInfo, 'urgent-write-no-transition', 5000, () =>
		page.evaluate(() => {
			document.querySelector<HTMLButtonElement>('[data-testid="increment"]')?.click()
		}),
	)
	expect(outcome.wedged, `wedged: ${outcome.stack?.join(' | ')}`).toBe(false)
	await expect(page.getByTestId('count')).toHaveText('1')
	await expect(page.getByTestId('doubled')).toHaveText('2')

	const health = await rafHealth(page, 800)
	expect(health, 'main thread too blocked to even run the rAF probe').not.toBeNull()
	expect(health!.framesPerSec, 'rAF cadence collapsed after the urgent write').toBeGreaterThan(10)
	expect(await clockTicks(page)).toBe(true)
})

test('FIND-THENABLE.nav: foreign thenables on route resources leave the navigation hold intact', async ({
	page,
	entry,
}, testInfo) => {
	applyExpectation(test, 'FIND-THENABLE.nav', entry)
	await gotoApp(page, entry)
	await page.evaluate(() => window.__store.setForeignThenable(true))
	await holdNavigate(page, 'table')

	// suspense impls throw the foreign thenable from the page area;
	// defer-write never throws it (it awaits the real promise) — either
	// way the hold must behave exactly like the native-Promise hold.
	expect(await clockTicks(page), 'clock froze under a foreign-thenable hold').toBe(true)
	const outcome = await withWatchdog(page, testInfo, 'thenable-nav-urgent', 5000, () =>
		page.evaluate(() => {
			document.querySelector<HTMLButtonElement>('[data-testid="increment"]')?.click()
		}),
	)
	expect(outcome.wedged, `wedged: ${outcome.stack?.join(' | ')}`).toBe(false)
	await expect(page.getByTestId('count')).toHaveText('1')
	await releaseAndSettle(page, 'table')
})

test('FIND-THENABLE.gate: a thrown foreign thenable holds the transition open on every implementation', async ({
	page,
	entry,
}, testInfo) => {
	// History: solid-react's shim documents a commit freeze for thrown
	// promises, measured against an earlier engine snapshot. Retested
	// 2026-07-08: the hold works on all four, so this row pins the working
	// behavior — if the freeze ever comes back, this goes red.
	applyExpectation(test, 'FIND-THENABLE.gate', entry)
	await gotoApp(page, entry)
	await page.evaluate(() => {
		window.__store.setForeignThenable(true)
		const before = window.__store.read('count') as number
		window.__store.holdTransition({ count: before + 10 })
	})

	// The hold must be indistinguishable from a native-Promise hold:
	// committed UI live, urgent commits landing.
	expect(await clockTicks(page, 2500), 'commits froze under the thrown foreign thenable').toBe(true)
	const outcome = await withWatchdog(page, testInfo, 'thenable-gate-urgent', 5000, () =>
		page.evaluate(() => {
			document.querySelector<HTMLButtonElement>('[data-testid="increment"]')?.click()
		}),
	)
	expect(outcome.wedged, `wedged: ${outcome.stack?.join(' | ')}`).toBe(false)
	await expect(page.getByTestId('count')).toHaveText('1')

	await page.evaluate(() => window.__store.releaseHold())
	await expect(page.getByTestId('count')).toHaveText('11')
})

test('FIND-ALTB-WEDGE.filter: value-changing derived write during a held navigation (alt-b wedges)', async ({
	page,
	entry,
	errors,
}, testInfo) => {
	applyExpectation(test, 'FIND-ALTB-WEDGE.filter', entry)
	if (entry.label === 'alt-b') {
		errors.allow(/.*/, 'FINDING: the wedge may surface arbitrary late errors while spinning')
	}
	await gotoApp(page, entry)
	await holdNavigate(page, 'table')

	// The filter write changes visibleRows/visibleCount output — the wedge
	// class. Dispatched page-side: a wedged handler would block Playwright's
	// own actionability machinery, so the watchdog owns the timeout.
	const outcome = await withWatchdog(page, testInfo, 'filter-during-hold', 5000, () =>
		dispatchFilterInput(page, '9'),
	)
	expect(
		outcome.wedged,
		`main thread wedged in an update loop: ${outcome.stack?.slice(0, 8).join(' | ')}`,
	).toBe(false)

	// Still healthy (non-alt-b): the filter committed and the hold survives.
	expect(await clockTicks(page)).toBe(true)
	expect(await testidText(page, 'pending')).toBe('yes')
	await releaseAndSettle(page, 'table')
})

test('FIND-ALTB-WEDGE.rows: add-rows during a held navigation (alt-b wedges, same class)', async ({
	page,
	entry,
	errors,
}, testInfo) => {
	applyExpectation(test, 'FIND-ALTB-WEDGE.rows', entry)
	if (entry.label === 'alt-b') {
		errors.allow(/.*/, 'FINDING: the wedge may surface arbitrary late errors while spinning')
	}
	await gotoApp(page, entry)
	await holdNavigate(page, 'table')

	const outcome = await withWatchdog(page, testInfo, 'add-rows-during-hold', 5000, () =>
		page.evaluate(() => {
			document.querySelector<HTMLButtonElement>('[data-testid="add-rows"]')?.click()
		}),
	)
	expect(
		outcome.wedged,
		`main thread wedged in an update loop: ${outcome.stack?.slice(0, 8).join(' | ')}`,
	).toBe(false)

	await expect(page.getByTestId('row-total')).toHaveText('3500 rows')
	expect(await testidText(page, 'pending')).toBe('yes')
	await releaseAndSettle(page, 'table')
})
