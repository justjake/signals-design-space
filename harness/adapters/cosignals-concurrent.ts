/**
 * Adapter for cosignals with a DRIVER ATTACHED and IDLE (One Core gate):
 * `attachDriver()` installs an idle driver at load — every public write now
 * makes the driver's one foreign call (which answers "no batch context")
 * and every read consults the (always-undefined) ambient world — but no
 * protocol events are ever fed and no batches are opened. The gate:
 * "driver attached, zero batches" semantics must be exactly sync semantics
 * — the 179-case conformance suite must observe DIRECT behavior through
 * the attached paths. Routes through the same public class API as the
 * `cosignals` adapter.
 */
import * as lib from 'cosignals'
import type { FrameworkAdapter } from './types'

lib.attachDriver({ currentBatch: () => lib.BATCH_NONE, worldFor: () => undefined }) // attach the driver; it stays idle forever

const adapter: FrameworkAdapter = {
	name: 'cosignals-concurrent',
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
