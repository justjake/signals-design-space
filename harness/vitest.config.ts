import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['conformance/**/*.spec.ts'],
		watch: false,
	},
});
