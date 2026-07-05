/**
 * Adapter for the cosignal LOGGED twin entry with the bridge ARMED but QUIET
 * (spec §7 twin-build gate; task gate "LOGGED quiet"): `registerReactBridge()`
 * swaps the operation table to the logged one at load, no fork events are ever
 * fed, and no atoms are bridge-registered — so the 179-case conformance suite
 * must observe exactly DIRECT semantics through the swapped table. Routes
 * through the same public class API as the `cosignal` adapter.
 */
import * as lib from 'cosignal/logged';
import type { FrameworkAdapter } from './types';

lib.registerReactBridge(); // arm the table; the bridge stays quiet forever

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
