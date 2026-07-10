/**
 * Shared battery fixtures.
 *
 * - `entry`: which implementation this project drives (set per project in
 *   playwright.config.ts). Tests read entry.label/holdStyle to key
 *   per-implementation expectations.
 * - `errors`: the console/pageerror budget. Every test gets a collector; at
 *   teardown any error not explicitly allowed fails the test. Findings that
 *   legitimately produce errors call `errors.allow(pattern, why)` up front,
 *   so the allowance is visible in the spec next to the scenario it excuses.
 *
 * Each test gets a fresh page/context (Playwright default), so engine
 * module-singletons never leak state between scenarios.
 */
import { expect, test as base } from '@playwright/test'
import { ENTRIES, type BatteryEntry } from './entries'

export interface ErrorBudget {
	/** Excuse errors matching `pattern`; `why` documents the finding or tolerance. */
	allow(pattern: RegExp, why: string): void
	/** Everything collected so far (allowed or not), for assertions on expected errors. */
	readonly consoleErrors: readonly string[]
	readonly pageErrors: readonly string[]
}

interface BatteryFixtures {
	errors: ErrorBudget
}

interface BatteryOptions {
	entry: BatteryEntry
}

export const test = base.extend<BatteryFixtures & BatteryOptions>({
	// Default keeps `playwright test` usable without a project filter; the
	// config always overrides this per project.
	entry: [ENTRIES[0]!, { option: true }],

	errors: [
		async ({ page }, use, testInfo) => {
			const consoleErrors: string[] = []
			const pageErrors: string[] = []
			const allowances: { pattern: RegExp; why: string }[] = []
			page.on('console', (message) => {
				if (message.type() === 'error') {
					consoleErrors.push(message.text())
				}
			})
			page.on('pageerror', (error) => pageErrors.push(String(error)))

			await use({
				allow: (pattern, why) => allowances.push({ pattern, why }),
				consoleErrors,
				pageErrors,
			})

			const all = [
				...consoleErrors.map((text) => `console.error: ${text}`),
				...pageErrors.map((text) => `pageerror: ${text}`),
			]
			if (all.length > 0) {
				await testInfo.attach('page-errors', {
					body: all.join('\n\n'),
					contentType: 'text/plain',
				})
			}
			const unexpected = all.filter(
				(text) => !allowances.some((allowance) => allowance.pattern.test(text)),
			)
			expect(
				unexpected,
				'console/pageerror budget exceeded (use errors.allow for expected findings)',
			).toEqual([])
		},
		{ auto: true },
	],
})

export { expect }
export type { BatteryEntry }
