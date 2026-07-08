import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.spec.ts'],
		watch: false,
		pool: 'forks',
		execArgv: ['--expose-gc'],
	},
});
