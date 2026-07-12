/**
 * flushSync rows: RCC-SP3 in both shapes — excluding a pending deferred
 * batch (hold), and useState parity while quiet.
 */
import { expect, test } from '../fixtures'
import { applyExpectation } from '../expectations'
import { armTextTrace, gotoApp, readTextTrace } from '../helpers'

test('RCC-SP3.flushsync-hold: a synchronous flush excludes the pending deferred batch', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-SP3.flushsync-hold', entry)
	await gotoApp(page, entry)
	await armTextTrace(page, 'count')

	const epoch = await page.evaluate(() => {
		const before = window.__store.read('count') as number
		return window.__store.holdTransition({ count: before + 10 }).epoch
	})
	await expect(page.getByTestId('count')).toHaveText('0')

	// flushSync commits urgently: all-old with respect to the deferred
	// batch — the +1 lands on committed state, never on the pending 10.
	await page.getByTestId('flushsync-increment').click()
	await expect(page.getByTestId('count')).toHaveText('1')
	// The deferred batch survived the flush: the gate is still pending.
	await expect(page.getByTestId('gate-a')).not.toHaveAttribute('data-epoch', String(epoch))

	await page.evaluate(() => window.__store.releaseHold())
	await expect(page.getByTestId('count')).toHaveText('11')
	await expect(page.getByTestId('gate-a')).toHaveAttribute('data-epoch', String(epoch))

	const trace = await readTextTrace(page, 'count')
	expect(trace, `committed sequence: ${trace.join(',')}`).not.toContain('10')
})

test('RCC-SP3.flushsync-quiet: signal and useState mirrors agree in every frame across flushSync', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-SP3.flushsync-quiet', entry)
	await gotoApp(page, entry)

	await page.getByTestId('mirror-write').click()
	await expect(page.getByTestId('mirror')).toHaveText('1:1:1')
	await page.getByTestId('mirror-write').click()
	await expect(page.getByTestId('mirror')).toHaveText('2:2:2')

	// Every committed frame the probe ever painted: signal half === state
	// half, including the frames forced synchronously by flushSync.
	const frames = await page.evaluate(() => window.__store.mirrorFrames)
	for (const frame of frames) {
		expect(
			frame.signal,
			`signal/useState divergence in a committed frame: ${JSON.stringify(frame)}`,
		).toBe(frame.state)
	}
})
