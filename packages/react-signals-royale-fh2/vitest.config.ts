import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'jsdom',
		include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
		pool: 'forks',
		execArgv: ['--expose-gc'],
		watch: false,
	},
});
