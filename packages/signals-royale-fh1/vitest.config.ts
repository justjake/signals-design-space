import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.spec.ts'],
		watch: false,
		pool: 'forks',
		poolOptions: {
			forks: {
				execArgv: ['--expose-gc'],
			},
		},
	},
});
