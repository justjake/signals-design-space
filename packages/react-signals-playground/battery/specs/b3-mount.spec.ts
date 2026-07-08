/**
 * Mount-window and lifecycle rows: RCC-RT6.* (mount mid-flight), the alt-b
 * mount-world agreement shape, RCC-OL2 (unmounted silence), RCC-WP1 (two
 * roots).
 */
import { expect, test } from '../fixtures';
import { applyExpectation } from '../expectations';
import { gotoApp, holdNavigate, releaseAndSettle, testidText } from '../helpers';

test('RCC-RT6.mount-mid-nav-hold: a probe mounted during a held navigation paints committed values', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT6.mount-mid-nav-hold', entry);
	await gotoApp(page, entry);
	await page.getByTestId('increment').click();
	await expect(page.getByTestId('count')).toHaveText('1');
	await holdNavigate(page, 'table');

	// Urgent mount while the navigation transition is pending.
	await page.getByTestId('mount-probe-toggle').click();
	await expect(page.getByTestId('mount-probe')).toBeAttached();
	await expect(page.getByTestId('mount-probe')).toHaveAttribute('data-count', '1');
	await expect(page.getByTestId('mount-probe')).toHaveAttribute('data-doubled', '2');

	// Every committed probe frame so far: internally consistent, and never
	// showing the pending route ahead of the app's own committed view.
	const pendingLog = await page.evaluate(() => window.__store.mountProbeLog);
	expect(pendingLog.length).toBeGreaterThan(0);
	for (const frame of pendingLog) {
		expect(frame.consistent, `torn probe frame: ${JSON.stringify(frame)}`).toBe(true);
		expect(frame.view, 'the probe revealed the pending route early').toBe('dashboard');
	}

	await releaseAndSettle(page, 'table');
	// The probe joins the transition's own commit: it converges to the new view.
	await expect(async () => {
		const log = await page.evaluate(() => window.__store.mountProbeLog);
		expect(log.some((frame) => frame.view === 'table')).toBe(true);
	}).toPass({ timeout: 5000 });
	const settledLog = await page.evaluate(() => window.__store.mountProbeLog);
	for (const frame of settledLog) {
		expect(frame.consistent, `torn probe frame: ${JSON.stringify(frame)}`).toBe(true);
	}
});

test('RCC-RT6.mount-mid-count-hold: a probe mounted during a held count transition never shows the draft', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT6.mount-mid-count-hold', entry);
	await gotoApp(page, entry);
	await page.evaluate(() => {
		const before = window.__store.read('count') as number;
		window.__store.holdTransition({ count: before + 10 });
	});
	await expect(page.getByTestId('count')).toHaveText('0');

	await page.getByTestId('mount-probe-toggle').click();
	await expect(page.getByTestId('mount-probe')).toBeAttached();
	// Committed world only: never the pending 10.
	await expect(page.getByTestId('mount-probe')).toHaveAttribute('data-count', '0');
	await expect(page.getByTestId('mount-probe')).toHaveAttribute('data-doubled', '0');

	await page.evaluate(() => window.__store.releaseHold());
	await expect(page.getByTestId('count')).toHaveText('10');
	await expect(page.getByTestId('mount-probe')).toHaveAttribute('data-count', '10');
	const log = await page.evaluate(() => window.__store.mountProbeLog);
	for (const frame of log) {
		expect(frame.consistent, `torn probe frame: ${JSON.stringify(frame)}`).toBe(true);
		expect([0, 10], `probe painted a value outside committed history: ${frame.count}`).toContain(
			frame.count,
		);
	}
});

test('RCC-RT5/6.alt-b-mount-world: readers mounted by a value-writing transition agree in their first commit', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-RT5/6.alt-b-mount-world', entry);
	await gotoApp(page, entry);
	// One transition both writes the value and mounts 20 readers of it: the
	// commit that reveals the readers must show them all agreeing. Which
	// world that joint commit shows (alt-b's suite pins "the pending one")
	// is per-implementation; the same-commit agreement is what RT5/RT6
	// demand, and the latch owns that check.
	await page.evaluate(() =>
		window.__store.transitionWriteMany({ count: 7, latticeMode: 'plain' }),
	);
	await expect(page.getByTestId('lattice')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('lattice-main')).toHaveText('7');
	const values = await page.$$eval('[data-lat]', (els) =>
		els.map((el) => el.getAttribute('data-lat')),
	);
	expect(new Set(values).size, `readers disagreed at mount: ${values.join(',')}`).toBe(1);
	expect(values[0]).toBe('7');
	const lattice = await page.evaluate(() => window.__store.lattice);
	expect(lattice.torn).toEqual([]);
});

test('RCC-OL2.unmounted-silence: an unmounted probe receives nothing after teardown', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-OL2.unmounted-silence', entry);
	await gotoApp(page, entry);
	await page.getByTestId('mount-probe-toggle').click();
	await expect(page.getByTestId('mount-probe')).toBeAttached();
	await page.getByTestId('increment').click();
	await expect(page.getByTestId('mount-probe')).toHaveAttribute('data-count', '1');

	const before = await page.evaluate(() => ({
		renders: window.__store.renderCounts['mount-probe'] ?? 0,
		logged: window.__store.mountProbeLog.length,
	}));
	await page.getByTestId('mount-probe-toggle').click();
	await expect(page.getByTestId('mount-probe')).toHaveCount(0);

	await page.getByTestId('increment').click();
	await page.getByTestId('increment').click();
	await expect(page.getByTestId('count')).toHaveText('3');
	await page.waitForTimeout(200);

	const after = await page.evaluate(() => ({
		renders: window.__store.renderCounts['mount-probe'] ?? 0,
		logged: window.__store.mountProbeLog.length,
	}));
	expect(after, 'the unmounted probe still rendered or ran effects').toEqual(before);
});

test('RCC-WP1.two-roots: a second root over the same atoms converges (simultaneity not asserted)', async ({
	page,
	entry,
}) => {
	applyExpectation(test, 'RCC-WP1.two-roots', entry);
	await gotoApp(page, entry);
	await page.evaluate(() => window.__store.mountSecondRoot());
	await expect(page.getByTestId('second-root-count')).toHaveText('0');

	await page.getByTestId('increment').click();
	// WP1's declared scope: per-root self-consistency and convergence, never
	// atomic multi-root frames — so both roots must AGREE eventually, and
	// nothing here compares them within one paint.
	await expect(page.getByTestId('count')).toHaveText('1');
	await expect(page.getByTestId('second-root-count')).toHaveText('1');

	await page.evaluate(() => window.__store.transitionWrite('count', 5));
	await expect(page.getByTestId('count')).toHaveText('5');
	await expect(page.getByTestId('second-root-count')).toHaveText('5');

	await page.evaluate(() => window.__store.unmountSecondRoot());
	await expect(page.getByTestId('second-root-count')).toHaveCount(0);
	// Writes after the second root's teardown reach the surviving root only.
	await page.getByTestId('increment').click();
	await expect(page.getByTestId('count')).toHaveText('6');
});
