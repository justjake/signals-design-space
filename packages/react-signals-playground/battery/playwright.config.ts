/**
 * The verification battery's Playwright config. One project per
 * implementation entry, all running the same specs against a fresh
 * production build served by vite preview — so a report line reads
 * `RCC-RT5 [alt-b]` and CI never depends on a checked-in dist/.
 *
 * Determinism decisions:
 * - Bundled Chromium only (no channel: 'chrome'): the browser version is
 *   pinned by the exact @playwright/test version in package.json, so every
 *   machine and CI run drives the identical engine.
 * - workers: 1, fullyParallel: false: scenarios measure timing (pending
 *   windows, interruptibility) and some deliberately wedge a page's main
 *   thread; a parallel wedged renderer burning a core would skew its
 *   neighbors' clocks.
 * - Spec files run in filename order; the wedge-prone specs live in
 *   z9-wedge.spec.ts so anything they break happens after every clean
 *   scenario has reported.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'
import { ENTRIES, type BatteryEntry } from './entries'

const PREVIEW_PORT = 4599
const packageDir = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig<{ entry: BatteryEntry }>({
	testDir: fileURLToPath(new URL('./specs', import.meta.url)),
	outputDir: fileURLToPath(new URL('./test-results', import.meta.url)),
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	// Retries would hide flakes in exactly the timing-sensitive behavior this
	// battery exists to pin; a flaky scenario is a bug in the scenario.
	retries: 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
	timeout: 90_000,
	expect: { timeout: 10_000 },
	use: {
		baseURL: `http://localhost:${PREVIEW_PORT}`,
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure',
	},
	projects: [
		...ENTRIES.map((entry) => ({
			name: entry.label,
			use: { entry },
			testIgnore: '**/k1-host-control.spec.ts',
		})),
		{
			// The vanilla-React host-baseline group: drives the /control/ page
			// (useState + startTransition + Suspense on the same patched React
			// build, no signals engine), so behavior shared by all five
			// implementations can be attributed to React or to the engines.
			name: 'react-control',
			testMatch: '**/k1-host-control.spec.ts',
		},
	],
	webServer: {
		// Fresh build every run: the battery verifies source, never a stale dist.
		command: `pnpm build && pnpm preview --port ${PREVIEW_PORT} --strictPort`,
		url: `http://localhost:${PREVIEW_PORT}/`,
		cwd: packageDir,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
	},
})
