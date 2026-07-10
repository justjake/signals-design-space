// Vite+ `vp pack` (tsdown) pilot for the cosignal const-enum compile step.
// Additive: vitest still uses vitest.config.ts (it takes precedence over this
// file), and package.json exports still point at ./src — dist/ is a pilot
// artifact only. Dependency-free plain object; see root vite.config.ts.
export default {
	pack: {
		entry: {
			index: 'src/index.ts',
			tracing: 'src/tracing.ts',
			'debug/layout.debug': 'src/debug/layout.debug.ts',
		},
		format: ['esm'],
		dts: true,
		sourcemap: true,
		outDir: 'dist',
	},
}
