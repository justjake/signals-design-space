/**
 * Core transition/write-path rows: RCC-UM1 (rebase), RCC-CR1 (no lost
 * writes), RCC-UM2 (render-phase writes), RCC-PR1/PR2 (sync pricing),
 * RCC-SP5 (over-notification bounds), RCC-CR3 (data persistence).
 */
import { expect, test } from '../fixtures'
import { applyExpectation } from '../expectations'
import { armTextTrace, gotoApp, readTextTrace } from '../helpers'

test('RCC-UM1.rebase: transition +10 and urgent +1 in one task — urgent first, rebased fold after', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-UM1.rebase', entry)
	await gotoApp(page, entry)
	await armTextTrace(page, 'count')

	await page.evaluate(() => {
		document.querySelector<HTMLButtonElement>('[data-testid="increment-transition"]')?.click()
		document.querySelector<HTMLButtonElement>('[data-testid="increment"]')?.click()
	})
	await expect(page.getByTestId('count')).toHaveText('11')

	const trace = await readTextTrace(page, 'count')
	// The urgent +1 commits alone first; the transition folds its +10 on
	// top in dispatch order. '10' alone would be the pending write leaking
	// into an urgent frame.
	expect(trace, `committed sequence: ${trace.join(',')}`).toContain('1')
	expect(trace).not.toContain('10')
	expect(trace[trace.length - 1]).toBe('11')
})

test('RCC-CR1.no-lost-writes: interleaved urgent bursts and a transition write land exactly once each', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-CR1.no-lost-writes', entry)
	await gotoApp(page, entry)

	await page.evaluate(() => {
		for (let i = 0; i < 10; i++) window.__store.increment('count', 'urgent')
		window.__store.increment('count', 'transition')
		for (let i = 0; i < 10; i++) window.__store.increment('count', 'urgent')
	})
	// 21 pure +1 updaters dispatched; every one must fold exactly once.
	await expect(page.getByTestId('count')).toHaveText('21')
	await expect(async () => {
		expect(await page.evaluate(() => window.__store.read('count'))).toBe(21)
	}).toPass({ timeout: 5000 })
})

test('RCC-UM2.render-write: a render-phase write to shared state is rejected', async ({
	page,
	entry,
	errors,
}) => {
	applyExpectation(test, 'RCC-UM2.render-write', entry)
	// The rejecting implementations throw into the error boundary, and React
	// reports boundary-caught errors on the console; that report IS the
	// correct behavior here.
	errors.allow(/render|write/i, 'UM2: the rejection error itself is the expected outcome')
	await gotoApp(page, entry)

	await page.getByTestId('render-write-toggle').click()
	await expect(page.getByTestId('render-write-outcome')).toBeVisible()
	const outcome = await page.evaluate(
		() => document.querySelector('[data-testid="render-write-outcome"]')?.textContent ?? '',
	)
	// Correct behavior: rejected, and the victim atom never moved.
	// solid-react FINDING: 'wrote-without-error' and the write landed.
	expect(outcome, 'render-phase write was accepted').toMatch(/^rejected:/)
	expect(await page.evaluate(() => window.__store.read('renderWriteVictim'))).toBe(0)
})

test('RCC-PR1.quiet: an urgent-only session never manufactures pending state', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-PR1.quiet', entry)
	await gotoApp(page, entry)
	await armTextTrace(page, 'pending')

	await page.getByTestId('increment').click()
	await page.getByTestId('toggle-evens').click()
	await page.getByTestId('filter-input').fill('3')
	await page.getByTestId('filter-input').fill('')
	await page.getByTestId('add-rows').click()
	await expect(page.getByTestId('count')).toHaveText('1')
	await expect(page.getByTestId('row-total')).toHaveText('3500 rows')

	const pendingStates = await readTextTrace(page, 'pending')
	expect(new Set(pendingStates), 'quiet writes flipped the pending flag').toEqual(new Set(['no']))
	await expect(page.getByTestId('errors')).toHaveCount(0)
})

test('RCC-PR2.quiet-then-defer: a deferred update starts from already-advanced committed state', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-PR2.quiet-then-defer', entry)
	await gotoApp(page, entry)

	// Quiet writes are permanent the moment they land.
	await page.evaluate(() => window.__store.write('count', 5))
	await expect(page.getByTestId('count')).toHaveText('5')

	await page.evaluate(() => {
		const before = window.__store.read('count') as number
		window.__store.holdTransition({ count: before + 10 })
	})
	// No window where the quiet 5 reads as pending: committed stays 5.
	await expect(page.getByTestId('count')).toHaveText('5')
	await page.evaluate(() => window.__store.releaseHold())
	await expect(page.getByTestId('count')).toHaveText('15')
})

test('RCC-SP5.over-notify: renders stay bounded and value-correct through an urgent burst', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-SP5.over-notify', entry)
	await gotoApp(page, entry)
	await page.getByTestId('lattice-show-plain').click()
	await expect(page.getByTestId('lattice')).toBeVisible({ timeout: 20_000 })

	for (let i = 0; i < 5; i++) {
		await page.getByTestId('increment').click()
	}
	await expect(page.getByTestId('lattice-main')).toHaveText('5')
	const values = await page.$$eval('[data-lat]', (els) =>
		els.map((el) => el.getAttribute('data-lat')),
	)
	expect(new Set(values)).toEqual(new Set(['5']))

	// SP5 tolerates over-notification but demands boundedness: a reader may
	// render a few times per write (speculative pass + commit), never
	// unboundedly. Mount + 5 writes with slack: 20 invocations per reader.
	const renderCounts = await page.evaluate(() => window.__store.renderCounts)
	for (let i = 0; i < 20; i++) {
		const renders = renderCounts[`lattice-${i}`] ?? 0
		expect(renders, `lattice-${i} rendered ${renders}× for 5 writes`).toBeLessThanOrEqual(20)
		expect(renders).toBeGreaterThan(0)
	}
})

test('RCC-CR3.store-only: a transition writing only unobserved state still persists its data', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-CR3.store-only', entry)
	await gotoApp(page, entry)
	// storeOnly has no subscriber anywhere — no component, no effect. CR3:
	// persistence never depends on who was subscribed.
	await page.evaluate(() => window.__store.transitionWrite('storeOnly', 77))
	await expect(async () => {
		expect(await page.evaluate(() => window.__store.read('storeOnly'))).toBe(77)
	}).toPass({ timeout: 5000 })
})
