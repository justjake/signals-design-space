// Vite+ (vp) workspace root config. Additive: the pnpm/vitest/tsc toolchain
// keeps working unchanged; this file only teaches `vp test` / `vp check` /
// `vp run` about the repo. See https://viteplus.dev/config.
//
// Deliberately dependency-free (no `import { defineConfig } from 'vite-plus'`):
// the local `vite-plus` package is not installed so that pnpm-lock.yaml stays
// untouched. `vp` loads this plain object with its bundled toolchain. If we
// later commit to Vite+, `vp install -D -w vite-plus@<vp version>` restores
// the typed `defineConfig` form.

// Vendored code, git submodules, generated results, and prose that Vite+
// tooling must never touch. This is a shared working tree: `vp check --fix`
// or `vp fmt` (write mode) must not be run wholesale — use `vp check`
// (check-only) instead.
const vendored = [
	'vendor/**',
	'upstream-alien-signals/**',
	'milomg-reactivity-benchmark/**',
	'tb-reactivity-benchmark/**',
	'daishi-concurrent-benchmark/**',
	'packages/dalien-signals/**',
	'fork/**',
	'design-loop/**',
	'monitor-design/**',
	'plans/**',
	'research/**',
	'reviews/**',
	'spec/**',
	'harness/results/**',
	'**/dist/**',
	'**/*.md',
];

export default {
	test: {
		// `vp test` at the repo root runs exactly these suites, each with its
		// own existing vitest.config.ts (vitest 4 projects). Per-package
		// `pnpm test` / `pnpm -C harness conformance` are unaffected.
		projects: [
			'./harness',
			'./packages/cosignals-alt-a',
			'./packages/cosignals-alt-b',
		],
	},
	fmt: {
		// Match the prevailing repo style so `vp check` reports minimal drift.
		useTabs: true,
		singleQuote: true,
		semi: true,
		ignorePatterns: vendored,
	},
	lint: {
		ignorePatterns: vendored,
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
};
