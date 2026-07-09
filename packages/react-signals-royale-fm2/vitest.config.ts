import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		pool: 'forks',
		execArgv: ['--expose-gc'],
		include: ['tests/**/*.spec.{ts,tsx}'],
	},
});
