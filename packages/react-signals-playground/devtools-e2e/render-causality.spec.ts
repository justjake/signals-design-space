import { expect, test } from '@playwright/test'

// Render causality is a core, always-on devtools feature: renders come from the
// real React fiber tree (bippy), not the engine, and each render chains back
// through the notify to the state change that triggered the pass — so a "+1
// urgent" click reads as one cascade rooted at the write, with real component
// names, never a flock of uncaused renders. This guards that end to end against
// the actual playground workload.

type DevGlobal = {
	events(filter: { classes?: string[] }, limit: number): Array<{ id: number; kind: string; node: number | undefined; data: { component?: string; reason?: string } }>
	causeChain(id: number): Array<{ kind: string }>
	counts(): { events: number }
}

test('render causality: fiber-sourced renders on the royale-fx2 app chain to the write', async ({ page }) => {
	// ?devtools mounts the panel (open) and attaches the collector before first render.
	await page.goto('/royale-fx2/?devtools')
	await expect(page.locator('.signals-devtools-root')).toBeVisible()

	// A plain urgent write to `count`, read across several components.
	await page.getByTestId('increment').click()
	await page.getByTestId('increment').click()
	await page.waitForFunction(() => {
		const c = (globalThis as unknown as { __SIGNALS_DEVTOOLS__?: DevGlobal }).__SIGNALS_DEVTOOLS__
		return !!c && c.events({ classes: ['render'] }, 10).length > 0
	})

	const facts = await page.evaluate(() => {
		const c = (globalThis as unknown as { __SIGNALS_DEVTOOLS__: DevGlobal }).__SIGNALS_DEVTOOLS__
		const renders = c.events({ classes: ['render'] }, 800)
		const names = new Set(renders.map((r) => r.data.component).filter(Boolean))
		return {
			total: renders.length,
			// Every render is fiber-sourced: no engine node, a real component name.
			allFiberSourced: renders.every((r) => r.node === undefined && typeof r.data.component === 'string'),
			// Dev build preserves names — a real PascalCase component, not a mangled letter.
			hasRealName: [...names].some((n) => typeof n === 'string' && n.length > 2 && /^[A-Z][a-z]/.test(n)),
			// Cascade: a render whose cause is itself a render — a child render
			// chained to its parent's render (regardless of the child's own reason).
			hasCascade: renders.some((r) => c.causeChain(r.id).filter((e) => e.kind === 'render').length >= 2),
			// Signal → render: some render's cause chain reaches the count write.
			chainsToWrite: renders.some((r) => c.causeChain(r.id).some((e) => e.kind === 'set' || e.kind === 'update')),
			// No feedback loop: the panel is itself a React app that re-renders on
			// every flush, but bippy excludes its own root — so none of the panel's
			// own components ever appear as render events. (The urgent clock ticks
			// continuously here, so a stable-count check would be unreliable; this
			// is the direct assertion that self-exclusion holds.)
			panelLeaked: renders.some((r) => ['GraphView', 'LogView', 'CauseSpine', 'ThemeDialog', 'StackTrace'].includes(r.data.component ?? '')),
		}
	})

	expect(facts.total).toBeGreaterThan(0)
	expect(facts.allFiberSourced).toBe(true) // engine's own render events are suppressed
	expect(facts.hasRealName).toBe(true) // component names, not minified
	expect(facts.hasCascade).toBe(true) // parent → child cascade recorded
	expect(facts.chainsToWrite).toBe(true) // rooted at the state change
	expect(facts.panelLeaked).toBe(false) // the panel's own renders are excluded — no loop
})
