/**
 * Adapter for cosignal with a HOST ATTACHED and IDLE (One Core gate):
 * `registerReactBridge()` attaches the concurrent engine's bridge at load —
 * arming the host write/read seams in the public methods — but no protocol
 * events are ever fed, no batches are opened, and no atoms are
 * bridge-registered. The gate: "host attached, zero batches" semantics must
 * be exactly sync semantics — the 179-case conformance suite must observe
 * DIRECT behavior through the armed seams. Routes through the same public
 * class API as the `cosignal` adapter.
 */
import * as lib from 'cosignal';
import type { FrameworkAdapter } from './types';

lib.registerReactBridge(); // attach the host; it stays idle forever

const adapter: FrameworkAdapter = {
	name: 'cosignal-logged',
	signal(initialValue) {
		const a = new lib.Atom(initialValue);
		return {
			read: () => a.state,
			write: (v) => a.set(v),
		};
	},
	computed(fn) {
		const c = new lib.Computed(fn);
		return { read: () => c.state };
	},
	effect: lib.effect,
	effectScope: lib.effectScope,
	startBatch: lib.startBatch,
	endBatch: lib.endBatch,
	untracked: lib.untracked,
};

export default adapter;
