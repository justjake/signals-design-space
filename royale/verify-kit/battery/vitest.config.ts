import { defineConfig } from 'vitest/config'

export default defineConfig({
	// The battery never imports 'react': JSX compiles to React.createElement
	// against the per-file `const React = adapter.React` binding, so every
	// element is created by the entrant's own build.
	oxc: {
		jsx: {
			runtime: 'classic',
			pragma: 'React.createElement',
			pragmaFrag: 'React.Fragment',
		},
	},
	test: {
		include: ['battery.spec.tsx'],
		// Entrant engines are module singletons; forks give each file a clean
		// process. --expose-gc keeps parity with the entrants' own leak suites.
		pool: 'forks',
		execArgv: ['--expose-gc'],
		// Scenario 12 (time slicing) runs outside act() against the real
		// scheduler and needs wall-clock headroom.
		testTimeout: 30_000,
	},
})
