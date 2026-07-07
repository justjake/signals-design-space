import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.spec.ts'],
		watch: false,
		// Reclamation probes (tests/reclaim.spec.ts) drive real collections
		// and FinalizationRegistry callbacks; --expose-gc makes globalThis.gc
		// available in every worker (harmless for the rest of the suite).
		pool: 'forks',
		execArgv: ['--expose-gc'],
	},
});
