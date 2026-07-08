import { defineConfig } from 'vitest/config';

export default defineConfig({
	// The vendored Solid core reads the __DEV__ compile-time flag. Tests run
	// with dev diagnostics ON so misuse (writes during render, etc.) fails loudly.
	define: {
		__DEV__: 'true',
	},
	test: {
		include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
		watch: false,
		pool: 'forks',
	},
});
