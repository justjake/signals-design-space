import { expect, test } from '@playwright/test'

// Panel smoke + canvas gestures, ported from the old devtools-package demo e2e
// so deleting that demo loses no coverage. Drives the real playground app with
// the panel open (?devtools) on both engine pages.

for (const page_ of [
	{ path: '/royale-fx2/?devtools', engine: 'fx2' },
	{ path: '/royale-fx2-dalien/?devtools', engine: 'fx2-dalien' },
] as const) {
	test(`panel shows the live ${page_.engine} graph + log and updates on interaction`, async ({ page }) => {
		await page.goto(page_.path)
		const panel = page.locator('.signals-devtools-root')
		await expect(panel).toBeVisible()

		// Graph is the default tab: nodes are discovered, listed, inspectable.
		// `doubled` is a computed, registered at load (its compute is traced);
		// `count` is an atom that only appears once written, so assert on doubled.
		await expect(panel.getByRole('button', { name: 'Graph', exact: true })).toHaveAttribute('aria-current', 'page')
		await expect(panel).toContainText('doubled')
		await panel.locator('.nodelist tbody tr').filter({ hasText: 'doubled' }).first().click()
		await expect(panel).toContainText('Value')
		await expect(panel).toContainText('Upstream')
		await expect(panel).toContainText('Downstream')

		// Log tab: real entries with verbatim kind strings (computes at load).
		await panel.getByRole('button', { name: 'Log', exact: true }).click()
		await expect(panel).toContainText('compute')
		const rowsBefore = await panel.locator('.log tbody tr').count()

		// A +1 urgent write produces new activity the panel captures.
		await page.getByTestId('increment').click()
		await expect.poll(async () => panel.locator('.log tbody tr').count()).toBeGreaterThan(rowsBefore)
	})
}

test('graph trackpad gestures keep the pinch focal point fixed and scroll to pan', async ({ page }) => {
	await page.goto('/royale-fx2/?devtools')
	await expect(page.locator('.signals-devtools-root')).toBeVisible()
	const svg = page.locator('.canvas-wrap svg')
	await expect(svg).toBeVisible()

	const result = await svg.evaluate((element) => {
		const graph = element as SVGSVGElement
		const box = graph.getBoundingClientRect()
		const clientX = Math.round(box.left + box.width * 0.3)
		const clientY = Math.round(box.top + box.height * 0.4)
		const pointAtGesture = () => {
			const matrix = graph.getScreenCTM()
			if (matrix === null) throw new Error('SVG has no screen transform')
			const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
			return { x: point.x, y: point.y }
		}
		const viewBox = () => graph.viewBox.baseVal
		return new Promise<{
			before: { point: { x: number; y: number }; width: number }
			afterPinch: { point: { x: number; y: number }; x: number; y: number; width: number; height: number }
			afterPan: { x: number; y: number; width: number; height: number }
		}>((resolve) => {
			const before = { point: pointAtGesture(), width: viewBox().width }
			// ctrl+wheel = trackpad pinch (zoom in).
			graph.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, clientX, clientY, bubbles: true, cancelable: true }))
			requestAnimationFrame(() => {
				const afterPinch = { point: pointAtGesture(), x: viewBox().x, y: viewBox().y, width: viewBox().width, height: viewBox().height }
				// plain wheel = pan.
				graph.dispatchEvent(new WheelEvent('wheel', { deltaX: 12, deltaY: 18, bubbles: true, cancelable: true }))
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						resolve({ before, afterPinch, afterPan: { x: viewBox().x, y: viewBox().y, width: viewBox().width, height: viewBox().height } })
					}),
				)
			})
		})
	})

	expect(result.afterPinch.width).toBeLessThan(result.before.width) // pinch zoomed in
	expect(result.afterPinch.point.x).toBeCloseTo(result.before.point.x, 4) // focal point fixed
	expect(result.afterPinch.point.y).toBeCloseTo(result.before.point.y, 4)
	expect(result.afterPan.width).toBeCloseTo(result.afterPinch.width, 6) // pan doesn't zoom
	expect(result.afterPan.x).toBeGreaterThan(result.afterPinch.x) // scrolled to pan
	expect(result.afterPan.y).toBeGreaterThan(result.afterPinch.y)
})
