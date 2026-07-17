/**
 * Devtools e2e for the playground. Separate from the verification `battery/`
 * on purpose: the battery runs a production build across every engine entry
 * (minified component names, no devtools), whereas the devtools panel is an
 * fx2/dalien-only dev tool whose whole value is readable component names and
 * causal chains. So this drives the DEV server (names preserved) and just the
 * royale-fx2 page with the panel open (?devtools), exercising the real app
 * workload — the same one the screenshots come from.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const PORT = 5273
const packageDir = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
	testDir: fileURLToPath(new URL('.', import.meta.url)),
	testMatch: '**/*.spec.ts',
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
		command: `pnpm dev --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/royale-fx2/`,
		cwd: packageDir,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
})
