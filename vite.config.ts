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
// tooling must never touch. Whole-repo format and lint passes operate only on
// the remaining first-party source.
const vendored = [
	'vendor/**',
	'upstream-alien-signals/**',
	'milomg-reactivity-benchmark/**',
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
	'**/src/debug/layout.debug.ts',
	'**/dist/**',
	'**/*.md',
]

export default {
	test: {
		// `vp test` at the repo root runs exactly these suites, each with its
		// own existing vitest.config.ts (vitest 4 projects). Per-package
		// `pnpm test` / `pnpm -C harness conformance` are unaffected.
		projects: ['./harness', './packages/cosignals-alt-a', './packages/cosignals-alt-b'],
	},
	fmt: {
		// Tabs render at two columns; statements do not end in semicolons.
		useTabs: true,
		tabWidth: 2,
		singleQuote: true,
		semi: false,
		ignorePatterns: vendored,
	},
	lint: {
		ignorePatterns: vendored,
		rules: {
			curly: 'error',
			'typescript/no-unnecessary-type-assertion': 'error',
		},
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
}
