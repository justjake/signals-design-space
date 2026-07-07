/**
 * The OBSERVED LIFECYCLE (AtomOptions.effect): the "first subscriber
 * attached / last one detached" callback an atom can carry, counted over
 * the UNION of consumer kinds — kernel subscribers (live computed chains,
 * core effect()s: one ref per non-host kernel link to the atom, fed by the
 * kernel's linkInsert/unlink through `lifecycleWatched`/`lifecycleUnwatched`)
 * and bridge watchers (subscribed React components: one ref per live
 * watcher, fed by the concurrent engine's observation index through
 * `__lifecycleRetain`/`__lifecycleRelease`). The effect runs on the union's
 * 0→1 transition and the cleanup on its 1→0; both run through a microtask
 * queue so observe/unobserve flaps within one tick coalesce to nothing
 * REGARDLESS of which consumer kind produced them (StrictMode double-mount
 * netting, watcher claim/debounced-unsub, remount handoffs). Atoms without
 * the effect option never enter the state map, and the kernel hot paths
 * stay gated on the record's LIFECYCLE field — the unregistered path pays
 * nothing. The state map is registered by the Atom constructor (index.ts),
 * which builds each atom's ctx.
 */

import type { AtomCtx } from './index.js';
import type { NodeId } from './graph.js';

// ---- observed lifecycle (AtomOptions.effect) -----------------------------------
// Observation is ONE state per registered atom, counted over the UNION of
// consumer kinds. Two kinds feed the refcount:
//   - the kernel liveness arm: one ref per NON-HOST kernel link to the atom
//     (linkInsert +1 / unlink -1, guarded by NodeField.LIFECYCLE, D1 —
//     HOST_OWNED computed subscribers are excluded: the host observation
//     index below is their arm);
//   - bridge watchers (the engine's record of one subscribed React
//     component), one ref per live watcher: the watcher liveness setter in
//     ./concurrent.ts calls __lifecycleRetain/__lifecycleRelease.
// The effect runs on the union's 0→1 transition and the cleanup on its 1→0;
// both run through a microtask queue so observe/unobserve flaps within one
// tick coalesce to nothing REGARDLESS of which consumer kind produced them
// (StrictMode double-mount netting, watcher claim/debounced-unsub, remount
// handoffs). Atoms without the effect option never enter this map, and the
// kernel hot paths stay gated on the LIFECYCLE field — the unregistered path
// pays nothing.

export type LifecycleState = {
	effect: (ctx: AtomCtx<unknown>) => void | (() => void);
	ctx: AtomCtx<unknown>;
	cleanup: (() => void) | undefined;
	/** Union refcount: kernel liveness bit (0/1) + one per live bridge watcher. */
	refs: number;
	/** Desired state as of the last union transition (refs > 0). */
	wantMounted: boolean;
	/** Actual state (effect has run and not been cleaned up). */
	isMounted: boolean;
	scheduled: boolean;
};

export const lifecycleStates = new Map<NodeId, LifecycleState>();
let lifecycleQueue: LifecycleState[] = [];
let lifecycleFlushScheduled = false;

function scheduleLifecycleFlush(): void {
	if (lifecycleFlushScheduled) {
		return;
	}
	lifecycleFlushScheduled = true;
	queueMicrotask(() => {
		lifecycleFlushScheduled = false;
		const queue = lifecycleQueue;
		lifecycleQueue = [];
		for (const state of queue) {
			state.scheduled = false;
			if (state.wantMounted === state.isMounted) {
				continue; // flap coalesced within one tick
			}
			if (state.wantMounted) {
				state.isMounted = true;
				const result = state.effect(state.ctx);
				state.cleanup = typeof result === 'function' ? result : undefined;
			} else {
				state.isMounted = false;
				const cleanup = state.cleanup;
				state.cleanup = undefined;
				if (cleanup !== undefined) {
					cleanup();
				}
			}
		}
	});
}

function lifecycleShift(id: NodeId, delta: -1 | 1): void {
	const state = lifecycleStates.get(id);
	if (state === undefined) {
		return;
	}
	state.refs += delta;
	const wantMounted = state.refs > 0;
	if (state.wantMounted === wantMounted) {
		return; // interior transition (1↔2, …): the union's edge did not move
	}
	state.wantMounted = wantMounted;
	if (!state.scheduled) {
		state.scheduled = true;
		lifecycleQueue.push(state);
		scheduleLifecycleFlush();
	}
}

// Hoisted function declarations: the kernel calls these from linkInsert /
// unwatched, which are defined earlier in the module. Each is a strict edge
// of the liveness bit (SUBS empty↔non-empty), so the kernel's contribution
// to the union refcount is exactly 0 or 1.
export function lifecycleWatched(id: NodeId): void {
	lifecycleShift(id, 1);
}

export function lifecycleUnwatched(id: NodeId): void {
	lifecycleShift(id, -1);
}

/**
 * Bridge watcher retain/release — the second consumer kind feeding the
 * observation union (the first is the kernel liveness bit). Called by the
 * engine's observation index (./concurrent.ts) when a watcher over a registered
 * atom's node flips live; a no-op for atoms carrying no observed-lifecycle
 * effect. Direct callbacks only — observation transitions are NOT
 * TraceEvents and never enter the engine's event/lockstep stream. @internal
 */
export function __lifecycleRetain(id: NodeId): void {
	lifecycleShift(id, 1);
}

/** @internal */
export function __lifecycleRelease(id: NodeId): void {
	lifecycleShift(id, -1);
}
