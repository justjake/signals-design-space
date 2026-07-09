import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.spec.{ts,tsx}'],
		watch: false,
		pool: 'forks',
		execArgv: ['--expose-gc'],
		testTimeout: 30_000,
	},
});
