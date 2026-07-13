/**
 * daishi-concurrent-benchmark ports (all 10 levels), driven against the
 * five playground implementations through the shim surface. The lattice is
 * the testkit port of daishi's counter grid: 20 readers + a per-commit
 * equality latch + a main mirror, with a syncWork knob standing in for
 * syncBlock's ~20ms per component.
 *
 * Fidelity notes: the original suite's "finally on mount" assertions (tests
 * 2/8) were documented no-ops (an unawaited evaluate as a text matcher);
 * these ports assert real value equality — stronger on purpose. Levels
 * sharing one schedule run as one scenario citing both row ids
 * (1+3, 2+4, 7+9, 8+10): "finally" is the settle assertion, "temporarily"
 * is the same run's latch verdict.
 */
import { expect, test } from '../fixtures'
import { applyExpectation } from '../expectations'
import { armTextTrace, gotoApp, readTextTrace } from '../helpers'

async function latticeValues(page: import('@playwright/test').Page): Promise<string[]> {
	return page.$$eval('[data-lat]', (els) => els.map((el) => el.getAttribute('data-lat') ?? ''))
}

test('DAISHI-1/DAISHI-3: no tearing (finally + temporarily) on update with transition', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'DAISHI-1', entry)
	await gotoApp(page, entry)
	await page.getByTestId('lattice-show-plain').click()
	await expect(page.getByTestId('lattice')).toBeVisible({ timeout: 20_000 })
	await expect(page.getByTestId('lattice-main')).toHaveText('0')

	for (let i = 0; i < 5; i++) {
		await page.getByTestId('increment-one-transition').click()
		await page.waitForTimeout(100)
	}
	// Finally: every reader and the main mirror settle at exactly 5.
	await expect(page.getByTestId('lattice-main')).toHaveText('5', { timeout: 10_000 })
	expect(new Set(await latticeValues(page))).toEqual(new Set(['5']))
	// Temporarily: the per-commit latch never saw a disagreeing frame.
	const lattice = await page.evaluate(() => window.__store.lattice)
	expect(lattice.checks).toBeGreaterThan(0)
	expect(lattice.torn).toEqual([])
})

test('DAISHI-2/DAISHI-4: no tearing (finally + temporarily) on mount with transition', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'DAISHI-2', entry)
	await gotoApp(page, entry)
	// Outside-React interval mutation, then a transition mounts 20 heavy
	// readers mid-stream (daishi's startAutoIncrement + transitionShow).
	await page.evaluate(() => window.__store.startAutoIncrement(50, 'urgent'))
	await page.waitForTimeout(100)
	await page.evaluate(() => window.__store.setLatticeWork(10))
	await page.getByTestId('lattice-show-plain').click()
	await expect(page.getByTestId('lattice')).toBeVisible({ timeout: 30_000 })
	await page.waitForTimeout(1000)
	await page.evaluate(() => window.__store.stopAutoIncrement())
	await page.waitForTimeout(500)

	// Finally (stronger than the original's no-op check): all readers, the
	// main mirror, and the app's count tile agree on one settled value.
	const settled = await page.evaluate(
		() => document.querySelector('[data-testid="count"]')?.textContent ?? '',
	)
	expect(Number(settled)).toBeGreaterThan(0)
	await expect(page.getByTestId('lattice-main')).toHaveText(settled)
	expect(new Set(await latticeValues(page))).toEqual(new Set([settled]))
	// Temporarily: no PAINTED commit during the mount-under-fire tore —
	// daishi's own passive-effect mechanism (the strict layout latch is the
	// RCC instrument; solid-react's finding shows up in both).
	const lattice = await page.evaluate(() => window.__store.lattice)
	expect(lattice.passiveChecks).toBeGreaterThan(0)
	expect(lattice.tornPassive).toEqual([])
})

test('DAISHI-5 (RCC-SP1.interruptibility): clicks stay responsive while 20 readers cost 20ms each', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'DAISHI-5', entry)
	await gotoApp(page, entry)
	await page.evaluate(() => window.__store.setLatticeWork(20))
	await page.getByTestId('lattice-show-plain').click()
	await expect(page.getByTestId('lattice')).toBeVisible({ timeout: 30_000 })

	// A naive synchronous re-render costs ~400ms (20 × 20ms). daishi's bar:
	// the click turn averages < 300ms because transition renders slice and
	// yield instead of blocking the handler's task.
	const delays: number[] = []
	for (let i = 0; i < 5; i++) {
		const delay = await page.evaluate(() => {
			const start = performance.now()
			document.querySelector<HTMLButtonElement>('[data-testid="increment-one-transition"]')?.click()
			return performance.now() - start
		})
		delays.push(delay)
		await page.waitForTimeout(100)
	}
	const average = delays.reduce((sum, d) => sum + d, 0) / delays.length
	expect(
		average,
		`click-turn delays: ${delays.map((d) => Math.round(d)).join(',')}ms`,
	).toBeLessThan(300)
	// The burst still lands exactly (UM4.replay: interrupted renders replay
	// without losing or doubling updates).
	await expect(page.getByTestId('lattice-main')).toHaveText('5', { timeout: 30_000 })
})

test('DAISHI-6: wip-state branching — previous state while pending, 1 → 2 → 6', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'DAISHI-6', entry)
	await gotoApp(page, entry)
	await page.getByTestId('lattice-show-plain').click()
	await expect(page.getByTestId('lattice')).toBeVisible({ timeout: 20_000 })

	// Committed baseline: 1.
	await page.getByTestId('increment-one-transition').click()
	await expect(page.getByTestId('lattice-main')).toHaveText('1')
	await expect(page.getByTestId('count')).toHaveText('1')

	// Two more transition increments, held open by heavy reader renders
	// (30ms × 20 readers ≈ 600ms per transition pass).
	await armTextTrace(page, 'lattice-main')
	await page.evaluate(() => window.__store.setLatticeWork(30))
	await page.getByTestId('increment-one-transition').click()
	await page.waitForTimeout(100)
	await page.evaluate(() => {
		document.querySelector<HTMLButtonElement>('[data-testid="increment-one-transition"]')?.click()
	})

	// One atomic page turn: snapshot the wip-invisible state and dispatch
	// the urgent double before the pending transitions can settle —
	// Playwright round-trips between steps would hand the page enough
	// main-thread time to finish the ~600ms transition render.
	const wip = await page.evaluate(() => {
		const main = document.querySelector('[data-testid="lattice-main"]')?.textContent
		const reader = document.querySelector('[data-lat]')?.getAttribute('data-lat')
		document.querySelector<HTMLButtonElement>('[data-testid="double-urgent"]')?.click()
		return { main, reader }
	})
	// While pending: previous state stayed displayed (the wip branch was
	// invisible). The urgent double computes against committed state
	// (1*2=2), excluding the two pending increments; the settled fold
	// applies every write in dispatch order: ((1+1)+1)*2 = 6.
	expect(wip).toEqual({ main: '1', reader: '1' })
	await expect(page.getByTestId('lattice-main')).toHaveText('6', { timeout: 30_000 })
	expect(new Set(await latticeValues(page))).toEqual(new Set(['6']))

	const trace = await readTextTrace(page, 'lattice-main')
	expect(trace, `committed sequence: ${trace.join(',')}`).toContain('2')
	for (const forbidden of ['3', '4', '12']) {
		expect(trace, `out-of-order fold painted ${forbidden}`).not.toContain(forbidden)
	}
	const lattice = await page.evaluate(() => window.__store.lattice)
	expect(lattice.torn).toEqual([])
})

test('DAISHI-7/DAISHI-9: useDeferredValue — no tearing (finally + temporarily) on update', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'DAISHI-7', entry)
	await gotoApp(page, entry)
	await page.getByTestId('lattice-show-deferred').click()
	await expect(page.getByTestId('lattice')).toBeVisible({ timeout: 20_000 })

	// Urgent increments; deferral comes from each reader's useDeferredValue.
	for (let i = 0; i < 5; i++) {
		await page.getByTestId('increment').click()
		await page.waitForTimeout(100)
	}
	await expect(page.getByTestId('count')).toHaveText('5')
	await expect(async () => {
		expect(new Set(await latticeValues(page))).toEqual(new Set(['5']))
	}).toPass({ timeout: 10_000 })
	const lattice = await page.evaluate(() => window.__store.lattice)
	expect(lattice.torn).toEqual([])
})

test('DAISHI-8/DAISHI-10: useDeferredValue — no tearing (finally + temporarily) on mount', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'DAISHI-8', entry)
	await gotoApp(page, entry)
	await page.evaluate(() => window.__store.startAutoIncrement(50, 'urgent'))
	await page.waitForTimeout(100)
	await page.evaluate(() => window.__store.setLatticeWork(10))
	await page.getByTestId('lattice-show-deferred').click()
	await expect(page.getByTestId('lattice')).toBeVisible({ timeout: 30_000 })
	await page.waitForTimeout(1000)
	await page.evaluate(() => window.__store.stopAutoIncrement())

	// Deferred readers converge to the settled count once the stream stops.
	const settled = await page.evaluate(
		() => document.querySelector('[data-testid="count"]')?.textContent ?? '',
	)
	await expect(async () => {
		expect(new Set(await latticeValues(page))).toEqual(new Set([settled]))
	}).toPass({ timeout: 10_000 })
	const lattice = await page.evaluate(() => window.__store.lattice)
	expect(lattice.tornPassive).toEqual([])
})
