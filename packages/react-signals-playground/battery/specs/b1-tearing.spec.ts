/**
 * Core read-consistency rows: RCC §3.1 (reads and tearing) plus the
 * late-write no-splice pin. Manifest rows: RCC-RT1.scope-read, RCC-RT3.*,
 * RCC-RT5.*, RCC-RT2.late-write.
 */
import { expect, test } from '../fixtures'
import { applyExpectation } from '../expectations'
import {
	armTextTrace,
	armTornWatch,
	clockTicks,
	gotoApp,
	holdNavigate,
	readTextTrace,
	releaseAndSettle,
	settleNav,
	testidText,
	tornFlips,
} from '../helpers'

test('RCC-RT1.scope-read: a transition scope reading its own write; ambient reads stay per-ruling', async ({
	page,
	entry,
}) => {
	const expectation = applyExpectation(test, 'RCC-RT1.scope-read', entry)
	await gotoApp(page, entry)
	const probe = await page.evaluate(() => window.__store.transitionScopeProbe('storeOnly', 41))

	if (expectation.kind === 'variant') {
		// royale-fx2 hides drafts from bare reads, including reads in the
		// transition callback that staged the write.
		expect(probe).toEqual({ inScope: 0, ambient: 0 })
	} else if (entry.label === 'cosignals') {
		// RT4-newest family: ambient pre-commit reads include the staged write.
		expect(probe).toEqual({ inScope: 41, ambient: 41 })
	} else {
		// ambient-W0 family: the scope reads its own draft, ambient does not.
		expect(probe).toEqual({ inScope: 41, ambient: 0 })
	}

	// Whatever the world rules, the write itself is L1/L2 state: it commits.
	await expect(async () => {
		expect(await page.evaluate(() => window.__store.read('storeOnly'))).toBe(41)
	}).toPass({ timeout: 5000 })
})

test('RCC-RT3.hold: urgent writes commit alone while a held transition stays invisible', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT3.hold', entry)
	await gotoApp(page, entry)
	await armTornWatch(page)
	await armTextTrace(page, 'count')

	await page.evaluate(() => {
		const before = window.__store.read('count') as number
		window.__store.holdTransition({ count: before + 10 })
	})
	// The transition is held: committed count unmoved, no fallback anywhere
	// (the old gate content stays on screen), the page stays live.
	await expect(page.getByTestId('count')).toHaveText('0')
	await expect(page.getByTestId('gate-a-fallback')).toHaveCount(0)
	expect(await clockTicks(page), 'clock froze during a held transition').toBe(true)

	await page.getByTestId('increment').click()
	await expect(page.getByTestId('count')).toHaveText('1')

	await page.evaluate(() => window.__store.releaseHold())
	await expect(page.getByTestId('count')).toHaveText('11')

	const trace = await readTextTrace(page, 'count')
	expect(trace, `committed sequence leaked the pending write: ${trace.join(',')}`).not.toContain(
		'10',
	)
	expect(await tornFlips(page)).toBe(0)
})

test('RCC-RT3.sliced: an urgent write mid-slice never reveals the transition write set', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT3.sliced', entry)
	await gotoApp(page, entry)
	// Heavy readers make the transition render a wide, interruptible window.
	await page.evaluate(() => window.__store.setLatticeWork(10))
	await page.getByTestId('lattice-show-plain').click()
	await expect(page.getByTestId('lattice')).toBeVisible({ timeout: 20_000 })
	await armTextTrace(page, 'count')

	await page.evaluate(() => {
		const before = window.__store.read('count') as number
		window.__store.transitionWrite('count', before + 10)
		window.__store.increment('count', 'urgent')
	})
	await expect(page.getByTestId('count')).toHaveText('11', { timeout: 30_000 })

	const trace = await readTextTrace(page, 'count')
	// The urgent +1 must never appear fused with the excluded transition
	// write: '10' alone on screen means the pending set leaked into an
	// urgent frame (RT3's forbidden mix).
	expect(trace, `committed sequence: ${trace.join(',')}`).not.toContain('10')
	expect(trace[trace.length - 1]).toBe('11')
})

test('RCC-RT3.nav-hold: the app-level hold — urgent controls commit while navigation is pending', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT3.nav-hold', entry)
	await gotoApp(page, entry)
	await armTornWatch(page)
	await holdNavigate(page, 'table')

	// Held: chrome answers for the target, page body stays on the old view.
	expect(await testidText(page, 'addr')).toBe('app://lab/table')
	await expect(page.getByTestId('view-panel')).toHaveAttribute('data-view', 'dashboard')
	await expect(page.locator('.browser-page')).toHaveClass(/stale/)
	expect(await clockTicks(page), 'clock froze while navigation held').toBe(true)

	await page.getByTestId('increment').click()
	await expect(page.getByTestId('count')).toHaveText('1')
	expect(await testidText(page, 'pending')).toBe('yes')
	await page.getByTestId('toggle-evens').click()
	await expect(page.getByTestId('toggle-evens')).toHaveAttribute('aria-pressed', 'true')

	await releaseAndSettle(page, 'table')
	expect(await testidText(page, 'addr')).toBe('app://lab/table')
	expect(await tornFlips(page)).toBe(0)
})

test('RCC-RT5.lattice: every committed frame agrees across 20 readers under transition increments', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT5.lattice', entry)
	await gotoApp(page, entry)
	await page.getByTestId('lattice-show-plain').click()
	await expect(page.getByTestId('lattice')).toBeVisible({ timeout: 20_000 })

	for (let i = 0; i < 5; i++) {
		await page.getByTestId('increment-one-transition').click()
		await page.waitForTimeout(100)
	}
	await expect(page.getByTestId('lattice-main')).toHaveText('5', { timeout: 20_000 })
	await expect(page.getByTestId('count')).toHaveText('5')

	const lattice = await page.evaluate(() => window.__store.lattice)
	expect(lattice.checks, 'the commit latch never ran').toBeGreaterThan(0)
	expect(lattice.torn, 'torn committed frames recorded by the latch').toEqual([])
	// Final agreement across every reader (daishi's "finally" assertion).
	const values = await page.$$eval('[data-lat]', (els) =>
		els.map((el) => el.getAttribute('data-lat')),
	)
	expect(new Set(values).size).toBe(1)
	expect(values[0]).toBe('5')
})

test('RCC-RT5.cross-hook: the consistency verdict never tears through the standard drive', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT5.cross-hook', entry)
	await gotoApp(page, entry)
	await armTornWatch(page)

	await page.getByTestId('latency-250ms').click()
	await page.getByTestId('view-tab-table').click()
	await settleNav(page, 'table')
	await page.getByTestId('filter-input').fill('7')
	await page.waitForTimeout(150)
	await page.getByTestId('filter-input').fill('')
	await page.getByTestId('add-rows').click()
	await page.getByTestId('reseed-transition').click()
	await page.getByTestId('increment').click()
	await page.getByTestId('increment').click()
	await expect(page.getByTestId('count')).toHaveText('2')
	await page.waitForTimeout(300)

	expect(await tornFlips(page)).toBe(0)
	expect(await testidText(page, 'consistency')).toBe('consistent')
	expect(await testidText(page, 'torn-count')).toBe('torn 0')
	await expect(page.getByTestId('errors')).toHaveCount(0)
})

test('RCC-RT5.double-read: one component reading one atom through two hooks never disagrees', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT5.double-read', entry)
	await gotoApp(page, entry)
	await armTextTrace(page, 'double-read')

	for (let i = 0; i < 5; i++) {
		await page.getByTestId('increment').click()
	}
	await expect(page.getByTestId('count')).toHaveText('5')

	const trace = await readTextTrace(page, 'double-read')
	for (const frame of trace) {
		const [first, second] = frame.split('/')
		expect(second, `intra-render disagreement committed: "${frame}"`).toBe(first)
	}
	await expect(page.getByTestId('double-read')).toHaveAttribute('data-agree', 'yes')
})

test('RCC-RT2.late-write: a write landing while a transition is pending is never spliced into it', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT2.late-write', entry)
	await gotoApp(page, entry)
	await armTextTrace(page, 'count')

	const epoch = await page.evaluate(() => window.__store.holdTransition({ count: 10 }).epoch)
	await expect(page.getByTestId('count')).toHaveText('0')
	// The late write: urgent, while the transition is pending.
	await page.evaluate(() => window.__store.write('count', 5))
	await expect(page.getByTestId('count')).toHaveText('5')

	await page.evaluate(() => window.__store.releaseHold())
	// Writes fold in dispatch order: the transition's set(10) rebases UNDER
	// the later urgent set(5), so the settled value is 5 — and the released
	// gate's committed epoch proves the transition really retired rather
	// than staying parked.
	await expect(page.getByTestId('gate-a')).toHaveAttribute('data-epoch', String(epoch))
	await expect(page.getByTestId('count')).toHaveText('5')

	// The forbidden third disposition (UM1): the pending 10 spliced into a
	// frame ahead of the late write. The committed sequence must never show
	// 10 at all — old, late-write, and the fold repaints 5.
	const trace = await readTextTrace(page, 'count')
	expect(trace, `committed sequence: ${trace.join(',')}`).toEqual(['0', '5'])
})
