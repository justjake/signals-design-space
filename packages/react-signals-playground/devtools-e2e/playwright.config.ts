/**
 * Devtools e2e for the playground. Separate from the verification `battery/`
 * on purpose: the battery runs a production build across every engine entry
 * (minified component names, no devtools), whereas the devtools panel is an
 * cosignals/dalien-only dev tool whose whole value is readable component names and
 * causal chains. So this drives the DEV server (names preserved) and just the
 * cosignals page with the panel open (?devtools), exercising the real app
 * workload — the same one the screenshots come from.
 *
 * Release CI also runs this config against a production preview built from
 * npm tarballs. That mode omits render-causality.spec.ts because its React
 * component names and Bippy render events are development-only signals.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const PORT = 5273
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const production = process.env.DEVTOOLS_E2E_PRODUCTION === '1'

export default defineConfig({
	testDir: fileURLToPath(new URL('.', import.meta.url)),
	testMatch: '**/*.spec.ts',
	testIgnore: production ? '**/render-causality.spec.ts' : undefined,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: !!process.env.CI,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: [['list']],
	use: {
		baseURL: `http://localhost:${PORT}`,
		screenshot: 'only-on-failure',
	},
	projects: [{ name: 'chromium' }],
	webServer: {
		command: production
			? `pnpm build && pnpm preview --port ${PORT} --strictPort`
			: `pnpm dev --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/cosignals/`,
		cwd: packageDir,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
})
