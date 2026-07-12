/**
 * Adapter for @lab/arena-host-fused (SP1b fusion-isolation spike). Owned by
 * the spike agent — customize freely, but keep the exported shape: `default`
 * FrameworkAdapter.
 *
 * Imported by relative path (not workspace package) so that adding this
 * framework does not require touching harness/package.json.
 */
import * as lib from '../../libs/arena-host-fused/src/index'
import type { FrameworkAdapter } from './types'

const adapter: FrameworkAdapter = {
	name: 'arena-host-fused',
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
