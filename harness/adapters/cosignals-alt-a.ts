/**
 * Adapter for packages/cosignals-alt-a (variant A of the
 * react-concurrent-signals-arena-alt-a spec: monotonic write-gate activation).
 * Routes through the package's default-engine public API — Atom/Computed
 * option-object constructors with `.state` getters and `.set` — so
 * conformance and benches measure the surface applications use, policy
 * wrapper (error/suspense boxing) included.
 */
import {
	Atom,
	Computed,
	effect,
	effectScope,
	endBatch,
	startBatch,
	untracked,
} from 'cosignals-alt-a'
import type { FrameworkAdapter } from './types'

const adapter: FrameworkAdapter = {
	name: 'cosignals-alt-a',
	signal(initialValue) {
		const a = new Atom({ state: initialValue })
		return {
			read: () => a.state,
			write: (v) => a.set(v),
		}
	},
	computed(fn) {
		const c = new Computed({ fn })
		return { read: () => c.state }
	},
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked,
}

export default adapter
