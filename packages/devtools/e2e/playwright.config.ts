import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const PORT = 5599
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
		command: `pnpm exec vite --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/`,
		cwd: packageDir,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
})
