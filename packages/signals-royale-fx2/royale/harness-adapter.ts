/** Test-only adapter for the shared conformance and benchmark harnesses. */
import { SkipTest } from 'reactive-framework-test-suite'
import {
	createAtom,
	createComputed,
	effect,
	effectScope,
	endBatch,
	installState,
	startBatch,
	untracked,
} from '../src/index.ts'
import { SignalWriteForbidden } from '../src/graph.ts'

const adapter = {
	name: 'signals-royale-fx2',
	signal<T>(initialValue: T) {
		// The engine treats function-valued initials as lazy initializers; the
		// harness stores plain values, including functions, so opt out here.
		const s = createAtom(initialValue)
		if (typeof initialValue === 'function') {
			installState(s, initialValue)
		}
		return {
			read: () => s.get(),
			write(value: T) {
				try {
					s.set(value)
				} catch (error) {
					if (
						error instanceof SignalWriteForbidden &&
						error.message === 'writes inside computeds are forbidden'
					) {
						throw new SkipTest('computed writes are disabled by policy')
					}
					throw error
				}
			},
		}
	},
	computed<T>(fn: () => T) {
		const c = createComputed(fn)
		return { read: () => c.get() }
	},
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked,
}

export default adapter
