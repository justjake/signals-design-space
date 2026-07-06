import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// The engine is a module singleton; tests reset it explicitly via
		// __resetEngineForTests(). Keep everything in one worker per file
		// (vitest default: isolated module registry per file) — fine.
	},
});
