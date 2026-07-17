import { expect, test } from '@playwright/test'

// Both engines expose the same public API and `/debug` contract; the demo
// picks by query param and the panel behaves identically over either.
for (const engine of ['fx2', 'fx2-dalien'] as const) {
	test(`inline panel shows the live ${engine} graph + log and updates on interaction`, async ({ page }) => {
		await page.goto(engine === 'fx2' ? '/' : '/?engine=dalien')
		const panel = page.getByTestId('panel')
		await expect(page.getByTestId('engine')).toHaveText(engine)

		// Graph is the default tab: nodes are discovered, listed, and inspectable.
		await expect(panel.getByRole('button', { name: 'Graph', exact: true })).toHaveAttribute('aria-current', 'page')
		await expect(panel).toContainText('doubled')
		// Click the node-list row to inspect it (the whole row selects).
		await panel.locator('.nodelist tbody tr').filter({ hasText: 'doubled' }).first().click()
		await expect(panel).toContainText('Value')
		await expect(panel).toContainText('Upstream')
		await expect(panel).toContainText('Downstream')

		// The live app works and the panel reflects new activity. count starts at
		// 1 (initial write), so doubled is 2.
		const out = page.getByTestId('out')
		await expect(out).toHaveText('2')

		// Log tab: real entries with the engine's verbatim kind strings and node
		// names.
		await panel.getByRole('button', { name: 'Log', exact: true }).click()
		await expect(panel).toContainText('set')
		await expect(panel).toContainText('compute')
		await expect(panel).toContainText('effect')
		await expect(panel).toContainText('count')

		const rowsBefore = await panel.locator('.log tbody tr').count()

		await page.getByTestId('inc').click()
		await expect(out).toHaveText('4') // doubled recomputed live in the app

		// The devtools captured the new activity: more log rows than before.
		await expect.poll(async () => panel.locator('.log tbody tr').count()).toBeGreaterThan(rowsBefore)
	})
}

test('graph trackpad gestures keep pinch focal point fixed and scroll to pan', async ({ page }) => {
	await page.goto('/')
	const svg = page.getByTestId('panel').locator('.canvas-wrap svg')
	await expect(svg).toBeVisible()

	const result = await svg.evaluate((element) => {
		const graph = element as SVGSVGElement
		const box = graph.getBoundingClientRect()
		// WheelEvent coordinates are integer CSS pixels in Chromium.
		const clientX = Math.round(box.left + box.width * 0.3)
		const clientY = Math.round(box.top + box.height * 0.4)
		const pointAtGesture = () => {
			const matrix = graph.getScreenCTM()
			if (matrix === null) throw new Error('SVG has no screen transform')
			const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
			return { x: point.x, y: point.y }
		}
		const viewBox = () => graph.viewBox.baseVal
		const before = { point: pointAtGesture(), x: viewBox().x, y: viewBox().y, width: viewBox().width, height: viewBox().height }

		const pinch = { clientX, clientY, deltaY: -8, ctrlKey: true, bubbles: true, cancelable: true }
		graph.dispatchEvent(new WheelEvent('wheel', pinch))
		graph.dispatchEvent(new WheelEvent('wheel', pinch))

		return new Promise<{
			before: typeof before
			afterPinch: typeof before
			afterPan: typeof before
		}>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
			const afterPinch = { point: pointAtGesture(), x: viewBox().x, y: viewBox().y, width: viewBox().width, height: viewBox().height }
			graph.dispatchEvent(new WheelEvent('wheel', { deltaX: 12, deltaY: 18, bubbles: true, cancelable: true }))
			requestAnimationFrame(() => requestAnimationFrame(() => {
				resolve({
					before,
					afterPinch,
					afterPan: { point: pointAtGesture(), x: viewBox().x, y: viewBox().y, width: viewBox().width, height: viewBox().height },
				})
			}))
		})))
	})

	expect(result.afterPinch.width).toBeLessThan(result.before.width)
	expect(result.afterPinch.point.x).toBeCloseTo(result.before.point.x, 4)
	expect(result.afterPinch.point.y).toBeCloseTo(result.before.point.y, 4)
	expect(result.afterPan.width).toBeCloseTo(result.afterPinch.width, 6)
	expect(result.afterPan.height).toBeCloseTo(result.afterPinch.height, 6)
	expect(result.afterPan.x).toBeGreaterThan(result.afterPinch.x)
	expect(result.afterPan.y).toBeGreaterThan(result.afterPinch.y)
})

// Render causality is a core, always-on feature: renders come from the real
// React fiber tree (bippy), not the engine, and chain back through the notify to
// the state change that triggered the pass. This guards that end to end.
test('render causality: renders are fiber-sourced and chain to the signal change', async ({ page }) => {
	// ?react=1 mounts a signal-driven React tree (Reader reads `count`, with Leaf
	// children); a write wakes it and React re-renders the subtree.
	await page.goto('/?react=1')
	const panel = page.getByTestId('panel')
	await panel.getByRole('button', { name: 'Log', exact: true }).click()

	await page.getByTestId('react-inc').click()
	await page.getByTestId('react-inc').click()

	// Renders are attributed to real components, and the no-prop child re-rendered
	// because its parent did — the cascade, straight from the fiber tree.
	await expect(panel).toContainText('Reader')
	await expect(panel).toContainText('Cascaded')
	await expect(panel).toContainText('parent rendered')

	type DevGlobal = {
		events(filter: { classes?: string[] }, limit: number): Array<{ id: number; kind: string; node: number | undefined; data: { component?: string } }>
		causeChain(id: number): Array<{ kind: string }>
		counts(): { events: number }
	}
	// Signal → render causality: a Reader render's cause chain reaches the write.
	const chainsToWrite = await page.evaluate(() => {
		const c = (globalThis as unknown as { __SIGNALS_DEVTOOLS__: DevGlobal }).__SIGNALS_DEVTOOLS__
		const renders = c.events({ classes: ['render'] }, 200).filter((e) => e.data.component === 'Reader')
		return renders.length > 0 && renders.some((r) => c.causeChain(r.id).some((e) => e.kind === 'set'))
	})
	expect(chainsToWrite).toBe(true)

	// The engine's own render events are suppressed — every render carries a
	// component (bippy), none carries an engine node.
	const allFiberSourced = await page.evaluate(() =>
		(globalThis as unknown as { __SIGNALS_DEVTOOLS__: DevGlobal }).__SIGNALS_DEVTOOLS__
			.events({ classes: ['render'] }, 200)
			.every((e) => e.node === undefined && typeof e.data.component === 'string'),
	)
	expect(allFiberSourced).toBe(true)

	// No feedback loop: the panel re-renders on every flush, but bippy excludes
	// its own root, so with no interaction the event count is stable.
	const first = await page.evaluate(() => (globalThis as unknown as { __SIGNALS_DEVTOOLS__: DevGlobal }).__SIGNALS_DEVTOOLS__.counts().events)
	await page.waitForTimeout(400)
	const second = await page.evaluate(() => (globalThis as unknown as { __SIGNALS_DEVTOOLS__: DevGlobal }).__SIGNALS_DEVTOOLS__.counts().events)
	expect(second).toBe(first)
})
