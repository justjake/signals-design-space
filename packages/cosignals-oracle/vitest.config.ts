import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// Fuzz runs are seeded and deterministic but not instant.
		testTimeout: 120_000,
	},
})
