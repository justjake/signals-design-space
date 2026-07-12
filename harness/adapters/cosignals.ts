/**
 * Adapter for packages/cosignals (the cosignals v1 DIRECT build: donor arena
 * kernel + policy layer). Routes through the public class API — Atom /
 * Computed `.state` getters and `.set` — so conformance and benches measure
 * the surface applications use, policy wrapper included.
 */
import * as lib from 'cosignals'
import type { FrameworkAdapter } from './types'

const adapter: FrameworkAdapter = {
	name: 'cosignals',
	signal(initialValue) {
		const a = new lib.Atom(initialValue)
		return {
			read: () => a.state,
			write: (v) => a.set(v),
		}
	},
	computed(fn) {
		const c = new lib.Computed(fn)
		return { read: () => c.state }
	},
	effect: lib.effect,
	effectScope: lib.effectScope,
	startBatch: lib.startBatch,
	endBatch: lib.endBatch,
	untracked: lib.untracked,
}

export default adapter
