import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
		// The engine is a module singleton; tests reset it explicitly via
		// __resetEngineForTests(). Keep everything in one worker per file
		// (vitest default: isolated module registry per file) — fine.
		//
		// GC-leak tests (test/gc-leaks.test.ts) drive real collections and
		// FinalizationRegistry callbacks; --expose-gc makes globalThis.gc
		// available in every worker (harmless for the rest of the suite).
		pool: 'forks',
		execArgv: ['--expose-gc'],
	},
})
