import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
		watch: false,
		// GC-leak tests (tests/gc-leaks.spec.ts) drive real collections and
		// FinalizationRegistry callbacks; --expose-gc makes globalThis.gc
		// available in every worker (harmless for the rest of the suite).
		pool: 'forks',
		execArgv: ['--expose-gc'],
	},
});
