/**
 * Adapter for @lab/control. Owned by the control implementation agent —
 * customize freely, but keep the exported shape: `default` FrameworkAdapter.
 */
import * as lib from '@lab/control'
import type { FrameworkAdapter } from './types'

const adapter: FrameworkAdapter = {
	name: 'control',
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
	// Auto-wired if your library exports `untracked<T>(fn: () => T): T`;
	// without it the conformance suite skips the untracked section.
	untracked: (lib as { untracked?: <T>(fn: () => T) => T }).untracked,
}

export default adapter
