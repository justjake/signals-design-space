/**
 * Async action and transition-batch rows: RCC-AT1 (sync writes join one
 * batch), RCC-AT2/AT4/WP4 (post-await bare write is urgent; the parked
 * prefix retires at settlement), RCC-AT3 (re-wrapped continuation rejoins).
 */
import { expect, test } from '../fixtures';
import { applyExpectation } from '../expectations';
import { gotoApp } from '../helpers';

test('RCC-AT1.sync-writes-join: two atoms written in one transition scope commit together', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-AT1.sync-writes-join', entry);
	await gotoApp(page, entry);

	await page.evaluate(() => window.__store.holdTransition({ pairA: 1, pairB: 1 }));
	// Held: neither write visible.
	await expect(page.getByTestId('pair')).toHaveText('0:0');
	await page.evaluate(() => window.__store.releaseHold());
	await expect(page.getByTestId('pair')).toHaveText('1:1');

	// The layout-effect latch saw every committed frame: none mixed.
	expect(await page.evaluate(() => window.__store.pairTorn)).toEqual([]);
});

test('RCC-AT2.post-await-urgent: the bare post-await write commits urgently while the prefix stays parked', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-AT2.post-await-urgent', entry);
	await gotoApp(page, entry);

	await page.evaluate(() => window.__store.beginAsyncAction());
	// AT1/AT4: the sync prefix joined the action's batch and is parked.
	await expect(page.getByTestId('action-sync')).toHaveText('0');

	await page.evaluate(() => window.__store.settleAsyncAction());
	// AT2/WP4: the continuation's bare write is ambient/urgent — it commits
	// now, while the prefix is still pending (the action gate is unreleased).
	await expect(page.getByTestId('action-post')).toHaveText('1');
	await expect(page.getByTestId('action-sync')).toHaveText('0');

	await page.evaluate(() => window.__store.releaseAsyncAction());
	await expect(page.getByTestId('action-sync')).toHaveText('1');
});

test('RCC-AT3.rejoin: a re-wrapped continuation write commits with the pending batch, not alone', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-AT3.rejoin', entry);
	await gotoApp(page, entry);

	await page.evaluate(() => window.__store.beginAsyncAction());
	await page.evaluate(() => window.__store.settleAsyncAction());
	// The continuation issued BOTH writes: the bare one commits urgently…
	await expect(page.getByTestId('action-post')).toHaveText('1');
	// …while the re-wrapped one (startSignalTransition in the continuation)
	// stays with the still-parked deferred work (pinned 2026-07-08 on all
	// four implementations).
	await expect(page.getByTestId('action-rejoin')).toHaveText('0');
	await expect(page.getByTestId('action-sync')).toHaveText('0');

	await page.evaluate(() => window.__store.releaseAsyncAction());
	await expect(page.getByTestId('action-rejoin')).toHaveText('1');
	await expect(page.getByTestId('action-sync')).toHaveText('1');
});
