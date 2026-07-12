import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const build = fileURLToPath(new URL('./react-build/', import.meta.url))

export default defineConfig({
	resolve: {
		alias: {
			react: `${build}react`,
			'react-dom': `${build}react-dom`,
			scheduler: `${build}scheduler`,
			'strata-signals': fileURLToPath(new URL('../strata/src/index.ts', import.meta.url)),
		},
	},
	test: {
		include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
		watch: false,
		pool: 'forks',
		execArgv: ['--expose-gc'],
	},
})
