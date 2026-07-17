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

test('react render channel: bippy records the component cascade, no panel feedback loop', async ({ page }) => {
	// ?react=1 mounts a real React tree (Parent → List → Leaf) and turns the
	// render channel on, so bippy has app fibers to observe.
	await page.goto('/?react=1')
	const panel = page.getByTestId('panel')
	await panel.getByRole('button', { name: 'Log', exact: true }).click()

	// A parent state change cascades to the children.
	await page.getByTestId('react-inc').click()
	await page.getByTestId('react-inc').click()

	// The channel captured the real component tree with reasons: Parent changed
	// state, its descendants rendered because the parent did (the cascade).
	await expect(panel).toContainText('Parent')
	await expect(panel).toContainText('Leaf')
	await expect(panel).toContainText('parent rendered')

	// No feedback loop: the panel re-renders on every flush, but bippy excludes
	// its own root, so event growth stops once interaction stops. Sample twice
	// with a settle in between — a loop would keep growing on its own.
	const count = () => page.evaluate(() => (globalThis as { __SIGNALS_DEVTOOLS__?: { counts(): { events: number } } }).__SIGNALS_DEVTOOLS__!.counts().events)
	const first = await count()
	await page.waitForTimeout(400)
	const second = await count()
	expect(second).toBe(first) // stable with no interaction → no self-feeding loop
})
