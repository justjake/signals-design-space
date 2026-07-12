/**
 * Adapter for packages/signals-royale-fx2 — the productionized Signals
 * Royale champion (forkless concurrent React signals; two-tier
 * watched/unwatched graph; reducer-only notifications). The package ships
 * its own adapter for this harness's contract; this file re-exports it with
 * one conformance shim: fx2 forbids writes inside computeds by policy, and
 * the suite's sanctioned way to declare a disabled capability is throwing
 * SkipTest from the operation (the package's own conformance spec does the
 * same conversion).
 */
import { SkipTest } from 'reactive-framework-test-suite'
import type { AdapterSignal, FrameworkAdapter } from './types'
import adapter from '../../packages/signals-royale-fx2/royale/harness-adapter.ts'
import { SignalWriteForbidden } from '../../packages/signals-royale-fx2/src/graph.ts'

const shimmed: FrameworkAdapter = {
	...(adapter as unknown as FrameworkAdapter),
	// Result rows must carry the harness slug ('fx2') so the ratio tables can
	// join them; the package's own adapter self-identifies by its npm name.
	name: 'fx2',
	signal<T>(initialValue: T): AdapterSignal<T> {
		const signal = (adapter as unknown as FrameworkAdapter).signal(initialValue)
		return {
			read: signal.read,
			write(value: T) {
				try {
					signal.write(value)
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
}

export default shimmed
