/**
 * Suspense/resource rows: RCC-SU1 (promise stability, no refetch livelock),
 * RCC-SU3 (keyed resources, interleaved holds), RCC-SU5 (settle-replay,
 * cold boot), RCC-CR3.superseded-nav.
 */
import { expect, test } from '../fixtures';
import { applyExpectation } from '../expectations';
import { gotoApp, holdNavigate, releaseAndSettle, settleNav, testidText } from '../helpers';

/** Creations per epoch from the fetch log. */
async function fetchCreations(page: import('@playwright/test').Page): Promise<Map<number, number>> {
	const log = await page.evaluate(() => window.__store.fetchLog);
	const creations = new Map<number, number>();
	for (const entry of log) {
		if (entry.event === 'create') creations.set(entry.epoch, (creations.get(entry.epoch) ?? 0) + 1);
	}
	return creations;
}

test('RCC-SU1.stable-promise: a held navigation with urgent churn never refetches (one creation per epoch)', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-SU1.stable-promise', entry);
	await gotoApp(page, entry);
	await holdNavigate(page, 'table');

	// Urgent churn forces the pending transition to re-render and re-throw
	// repeatedly; a stability bug would create a resource per retry.
	for (let i = 0; i < 3; i++) {
		await page.getByTestId('increment').click();
		await page.waitForTimeout(100);
	}
	await expect(page.getByTestId('count')).toHaveText('3');
	await releaseAndSettle(page, 'table');

	const creations = await fetchCreations(page);
	for (const [epoch, count] of creations) {
		expect(count, `navigation #${epoch} created ${count} resources`).toBe(1);
	}
	// UM4.replay rides here: replayed/interrupted renders were idempotent —
	// no duplicate resource creation despite many re-renders during the hold.
});

test('RCC-SU3.nav-keyed: two in-flight navigations keep distinct per-epoch resources', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-SU3.nav-keyed', entry);
	await gotoApp(page, entry);
	await holdNavigate(page, 'table');
	// Supersede while held: a second navigation with its own resource.
	await page.getByTestId('view-tab-detail').click();
	await expect(page.getByTestId('addr')).toHaveText('app://lab/detail');

	// Release settles both held resources; the committed result must be the
	// newest epoch's view — never a mix of the two.
	await page.getByTestId('release').click();
	await settleNav(page, 'detail');
	const epochText = await testidText(page, 'data-epoch');
	expect(epochText).toBe('nav #2');

	const creations = await fetchCreations(page);
	expect(creations.get(1), 'first navigation resource').toBe(1);
	expect(creations.get(2), 'second navigation resource').toBe(1);
});

test('RCC-SU3.interleaved-gates: two held transitions never alias; the joint commit lands both whole', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-SU3.interleaved-gates', entry);
	await gotoApp(page, entry);

	// Two separate tasks on purpose: same-task transitions share one batch
	// (AT1), and this row needs two distinct pending batches.
	await page.evaluate(() => window.__store.holdTransition({ count: 10 }));
	await page.waitForTimeout(50);
	await page.evaluate(() => window.__store.holdTransitionB({ pairA: 5, pairB: 5 }));
	await expect(page.getByTestId('count')).toHaveText('0');
	await expect(page.getByTestId('pair')).toHaveText('0:0');

	// Host fact, pinned 2026-07-08 identically on all four implementations
	// and in BOTH release orders: two component-level suspended transitions
	// on one root entangle — releasing one gate commits NOTHING until the
	// other resolves. (Per-node keyed independence — alt-a#7/alt-b#6 —
	// lives at engine resource level; the package suites referee it.)
	await page.evaluate(() => window.__store.releaseHoldB());
	await page.waitForTimeout(400);
	await expect(page.getByTestId('pair')).toHaveText('0:0');
	await expect(page.getByTestId('count')).toHaveText('0');

	// What SU3 forbids is ALIASING: when the joint commit lands, each
	// batch's writes arrive whole and separate — never mixed, never lost.
	await page.evaluate(() => window.__store.releaseHold());
	await expect(page.getByTestId('count')).toHaveText('10');
	await expect(page.getByTestId('pair')).toHaveText('5:5');
	expect(await page.evaluate(() => window.__store.pairTorn)).toEqual([]);
});

test('RCC-SU5.settle-replay: a timed navigation holds without a fallback flash and settles once', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-SU5.settle-replay', entry);
	await gotoApp(page, entry);
	// Watch for any Suspense fallback appearing inside the page area.
	await page.evaluate(() => {
		(window as unknown as { __fallbacks: number }).__fallbacks = 0;
		const target = document.querySelector('.browser-page');
		if (target === null) throw new Error('no .browser-page');
		new MutationObserver(() => {
			if (document.querySelector('.browser-page .pageload') !== null) {
				(window as unknown as { __fallbacks: number }).__fallbacks += 1;
			}
		}).observe(target, { childList: true, subtree: true });
	});

	await page.getByTestId('latency-250ms').click();
	await page.getByTestId('view-tab-table').click();
	await settleNav(page, 'table');

	const fallbacks = await page.evaluate(
		() => (window as unknown as { __fallbacks: number }).__fallbacks,
	);
	expect(fallbacks, 'the transition dropped to the Suspense fallback').toBe(0);
	// Settled data replays synchronously: the committed page shows its epoch.
	expect(await testidText(page, 'data-epoch')).toBe('nav #1');
	const creations = await fetchCreations(page);
	expect(creations.get(1)).toBe(1);
});

test('RCC-SU5.cold-boot: the initial page never suspends (epoch-0 data is part of first paint)', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-SU5.cold-boot', entry);
	await gotoApp(page, entry);
	await expect(page.getByTestId('view-panel')).toHaveAttribute('data-view', 'dashboard');
	expect(await testidText(page, 'data-epoch')).toBe('nav #0');
	await expect(page.locator('.browser-page .pageload')).toHaveCount(0);
});

test('RCC-CR3.superseded-nav: a superseded held navigation keeps its data and its timeline record', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-CR3.superseded-nav', entry);
	await gotoApp(page, entry);
	await holdNavigate(page, 'table');
	await page.getByTestId('view-tab-detail').click();
	await page.getByTestId('release').click();
	await settleNav(page, 'detail');

	// Abandonment discards rendering, never data: both resources were
	// created and settled (fetch log), and the first navigation's timeline
	// record survives, marked superseded.
	const log = await page.evaluate(() => window.__store.fetchLog);
	const settled = log.filter((entry) => entry.event === 'settle').map((entry) => entry.epoch);
	expect(settled).toContain(1);
	expect(settled).toContain(2);
	const records = await page.locator('[data-testid="timeline-record"]').allTextContents();
	expect(
		records.some((text) => text.includes('superseded')),
		`no superseded record in: ${records.join(' | ')}`,
	).toBe(true);
});
