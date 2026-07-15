/**
 * Committed-effect rows: RCC-EF1 (effects observe committed state only),
 * RCC-EF2 (boundary coalescing). Effect-log assertions treat entries as a
 * multiset per boundary — never a cross-effect sequence (EF4 tolerance).
 */
import { expect, test } from '../fixtures'
import { applyExpectation } from '../expectations'
import { gotoApp, holdNavigate, releaseAndSettle } from '../helpers'
import type { EffectLogEntry } from '../../src/testkit'

const LEGACY_SPLIT_EFFECTS = new Set(['cosignals', 'alt-a', 'alt-b'])

function entriesFor(log: readonly EffectLogEntry[], probe: string): EffectLogEntry[] {
	return log.filter((entry) => entry.probe === probe)
}

test('RCC-EF1.committed-only: the route effect never observes a pending navigation', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-EF1.committed-only', entry)
	await gotoApp(page, entry)
	await holdNavigate(page, 'table')

	// Urgent churn while held: plenty of commits, none of them the route flip.
	await page.getByTestId('increment').click()
	await expect(page.getByTestId('count')).toHaveText('1')
	await page.waitForTimeout(200)
	let routeValues = await page.evaluate(() =>
		window.__store.effectLog.filter((e) => e.probe === 'route').map((e) => e.value),
	)
	expect(routeValues, 'the effect saw the pending route').not.toContain('table')

	await releaseAndSettle(page, 'table')
	await expect(async () => {
		routeValues = await page.evaluate(() =>
			window.__store.effectLog.filter((e) => e.probe === 'route').map((e) => e.value),
		)
		expect(routeValues).toContain('table')
	}).toPass({ timeout: 5000 })
	// EF2: the flip fired exactly once at the settle boundary.
	expect(routeValues.filter((value) => value === 'table')).toHaveLength(1)
})

test('RCC-EF1.count-hold: the count effect never observes the held draft', async ({
	page,
	entry,
}) => {
	const expectation = applyExpectation(test, 'RCC-EF1.count-hold', entry)
	await gotoApp(page, entry)

	await page.evaluate(() => {
		const before = window.__store.read('count') as number
		window.__store.holdTransition({ count: before + 10 })
	})
	await page.getByTestId('increment').click()
	await expect(page.getByTestId('count')).toHaveText('1')
	await page.waitForTimeout(200)

	let countValues = await page.evaluate(() =>
		window.__store.effectLog.filter((e) => e.probe === 'count').map((e) => e.value),
	)
	// EF1 proper — no ruling divergence anywhere: the pending draft is
	// invisible to committed effects.
	expect(countValues, 'the effect saw the pending draft').not.toContain(10)
	if (expectation.kind === 'variant') {
		// solid-react holds tracked effects while a transition is live and
		// flushes at its commit — the urgent flip arrives late, never early.
		expect(countValues, 'held effects fired mid-transition anyway').not.toContain(1)
	} else {
		expect(countValues, 'the committed urgent flip never fired').toContain(1)
	}

	await page.evaluate(() => window.__store.releaseHold())
	await expect(page.getByTestId('count')).toHaveText('11')
	await expect(async () => {
		countValues = await page.evaluate(() =>
			window.__store.effectLog.filter((e) => e.probe === 'count').map((e) => e.value),
		)
		expect(countValues).toContain(11)
	}).toPass({ timeout: 5000 })
	expect(countValues, 'the draft leaked into an effect at some point').not.toContain(10)
})

test('RCC-EF2.coalesce: several writes in one handler produce one effect run at the final value', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-EF2.coalesce', entry)
	await gotoApp(page, entry)

	const before = await page.evaluate(
		() => window.__store.effectLog.filter((e) => e.probe === 'count').length,
	)
	await page.evaluate(() => {
		window.__store.write('count', 1)
		window.__store.write('count', 2)
		window.__store.write('count', 3)
	})
	await expect(page.getByTestId('count')).toHaveText('3')
	await page.waitForTimeout(200)

	const after = await page.evaluate(() =>
		window.__store.effectLog.filter((e) => e.probe === 'count').map((e) => e.value),
	)
	const fresh = after.slice(before)
	expect(fresh, 'member writes did not coalesce to one boundary run').toEqual([3])
})

test('legacy split-effect composition preserves previous values, cleanup order, and deps', async ({
	page,
	entry,
}) => {
	test.skip(!LEGACY_SPLIT_EFFECTS.has(entry.label), 'only the three autorun bridge shims share this composition')
	await gotoApp(page, entry)

	const log = () => page.evaluate(() => window.__store.splitEffectLog)
	await page.evaluate(() => window.__store.write('splitEffectMounted', true))
	await expect.poll(log).toEqual([{ event: 'run', dep: 0, value: 0 }])

	await page.evaluate(() => window.__store.write('splitEffectValue', 1))
	await expect.poll(log).toEqual([
		{ event: 'run', dep: 0, value: 0 },
		{ event: 'cleanup', dep: 0, value: 0 },
		{ event: 'run', dep: 0, value: 1, previous: 0 },
	])

	await page.evaluate(() => window.__store.write('splitEffectRender', 1))
	await expect.poll(log).toHaveLength(3)

	await page.evaluate(() => window.__store.write('splitEffectDep', 1))
	await expect.poll(log).toEqual([
		{ event: 'run', dep: 0, value: 0 },
		{ event: 'cleanup', dep: 0, value: 0 },
		{ event: 'run', dep: 0, value: 1, previous: 0 },
		{ event: 'cleanup', dep: 0, value: 1 },
		{ event: 'run', dep: 1, value: 1, previous: 1 },
	])

	await page.evaluate(() => window.__store.write('splitEffectValue', 2))
	await expect.poll(log).toEqual([
		{ event: 'run', dep: 0, value: 0 },
		{ event: 'cleanup', dep: 0, value: 0 },
		{ event: 'run', dep: 0, value: 1, previous: 0 },
		{ event: 'cleanup', dep: 0, value: 1 },
		{ event: 'run', dep: 1, value: 1, previous: 1 },
		{ event: 'cleanup', dep: 1, value: 1 },
		{ event: 'run', dep: 1, value: 2, previous: 1 },
	])

	await page.evaluate(() => window.__store.write('splitEffectMounted', false))
	await expect.poll(log).toHaveLength(8)
	expect((await log()).at(-1)).toEqual({ event: 'cleanup', dep: 1, value: 2 })

	await page.evaluate(() => window.__store.write('splitEffectMounted', true))
	await expect.poll(log).toHaveLength(9)
	expect((await log()).at(-1)).toEqual({ event: 'run', dep: 1, value: 2 })
})
