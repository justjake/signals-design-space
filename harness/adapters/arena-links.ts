/**
 * Adapter for @lab/arena-links. Owned by the arena-links implementation
 * agent — customize freely, but keep the exported shape: `default`
 * FrameworkAdapter.
 */
import * as lib from '@lab/arena-links'
import type { FrameworkAdapter } from './types'

const adapter: FrameworkAdapter = {
	name: 'arena-links',
	signal(initialValue) {
		const s = lib.signal(initialValue)
		return {
			read: () => s(),
			write: (v) => s(v),
		}
	},
	computed(fn) {
		const c = lib.computed(fn)
		return { read: () => c() }
	},
	effect: lib.effect,
	effectScope: lib.effectScope,
	startBatch: lib.startBatch,
	endBatch: lib.endBatch,
	untracked: lib.untracked,
}

export default adapter
