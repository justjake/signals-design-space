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
 * stay gated on the record's LIFECYCLE field — the plain path pays nothing.
 *
 * ID-KEYED AND HANDLE-FREE (reclamation plan §2 — built here so the
 * reclamation stage lands on it):
 *  - THE DORMANT OWNER: the user's callback is stored in the atom's own
 *    record `fns` COLUMN SLOT at construction (index.ts — atoms never use
 *    that slot; it is engine memory addressed by id, cleared by the
 *    record-free path like every column). No map entry exists while
 *    dormant.
 *  - REHYDRATION: a watched transition on a lifecycle-flagged record with
 *    no active entry reads the callback from the fns slot and creates a
 *    fresh ACTIVE record (this map's entry) — the engine holds the record
 *    strongly exactly WHILE THE LIFECYCLE IS ACTIVE (watched, or with a
 *    pending flap-damped shift): an atom with an active lifecycle effect
 *    is observable machinery whose cleanup MUST run at unmount regardless
 *    of handle reachability.
 *  - DORMANCY: when the cleanup has run and no shift is pending, the
 *    active entry DELETES — releasing the context and any pending cleanup.
 *    (That deletion site is reclamation's retry trigger for lifecycle
 *    atoms when stage S5R lands.)
 *  - The ACTIVE CONTEXT routes state/set/update BY ID through the engine
 *    write path (index.ts `__lifecycleWrite`) — the engine never stores a
 *    handle reference of its own; the callback pins only what the user's
 *    closure captures, exactly as long as the RECORD lives.
 */

import { E, NodeField, RecordGeom, engineEpoch, fns, untracked } from './graph.js';
import { __lifecycleWrite, type AtomCtx } from './index.js';
import type { NodeId } from './graph.js';

export type LifecycleState = {
	/** The atom's record id (the map key, carried for the dormancy delete). */
	id: NodeId;
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

/** ACTIVE lifecycle records by id (watched, or with a pending shift) — see
 * the module header for the dormant/active/rehydration story. */
export const lifecycleStates = new Map<NodeId, LifecycleState>();
let lifecycleQueue: LifecycleState[] = [];
let lifecycleFlushScheduled = false;

/** Test-only (`__resetEngineForTest`): drop every active record and the
 * queue; the scheduled flush (if any) is engine-epoch guarded and goes
 * inert. @internal */
export function __resetLifecycleForTest(): void {
	lifecycleStates.clear();
	lifecycleQueue = [];
	// lifecycleFlushScheduled stays as-is: the pending microtask (if one is
	// in flight) clears it when it fires and bails on the epoch guard.
}

function scheduleLifecycleFlush(): void {
	if (lifecycleFlushScheduled) {
		return;
	}
	lifecycleFlushScheduled = true;
	// ENGINE-EPOCH GUARD (cross-reset microtask discipline): a flush
	// scheduled by a dead test must not run user effects into the next
	// test's engine.
	const epoch = engineEpoch;
	queueMicrotask(() => {
		lifecycleFlushScheduled = false;
		if (epoch !== engineEpoch) {
			return;
		}
		const queue = lifecycleQueue;
		lifecycleQueue = [];
		for (const state of queue) {
			state.scheduled = false;
			if (state.wantMounted === state.isMounted) {
				maybeDropDormant(state);
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
				maybeDropDormant(state);
			}
		}
	});
}

/** The dormancy transition: cleanup ran (or the flap netted out), nothing
 * pending — the ACTIVE record deletes; the dormant owner (the fns-slot
 * callback) is all that remains. */
function maybeDropDormant(state: LifecycleState): void {
	if (state.refs <= 0 && !state.isMounted && !state.scheduled) {
		lifecycleStates.delete(state.id);
	}
}

/** The active context — built at rehydration, id-keyed, handle-free (see
 * the module header). */
function makeLifecycleCtx(id: NodeId): AtomCtx<unknown> {
	return {
		get state(): unknown {
			return untracked(() => E.read(id));
		},
		set(value: unknown): void {
			__lifecycleWrite(id, 0, value);
		},
		update(fn: (current: unknown) => unknown): void {
			__lifecycleWrite(id, 1, fn);
		},
	};
}

function lifecycleShift(id: NodeId, delta: -1 | 1): void {
	let state = lifecycleStates.get(id);
	if (state === undefined) {
		if (delta < 0) {
			return; // release without an active record: dormant already
		}
		// REHYDRATION: read the dormant owner off the record's fns slot. A
		// watched transition can only arrive for a live record (observation
		// is a tracked read, which is handle-mediated). Gate on the record's
		// LIFECYCLE field (D1) — only atoms constructed with the effect
		// option carry it, so a computed's getter in the same fns column can
		// never masquerade as a lifecycle callback.
		if (E.buffer()[id + NodeField.LIFECYCLE] !== 1) {
			return; // no lifecycle effect on this record
		}
		const fn = fns[id >> RecordGeom.ID_TO_FN_SHIFT];
		if (typeof fn !== 'function') {
			return; // dormant owner already cleared (record freed mid-flight)
		}
		state = {
			id,
			effect: fn as (ctx: AtomCtx<unknown>) => void | (() => void),
			ctx: makeLifecycleCtx(id),
			cleanup: undefined,
			refs: 0,
			wantMounted: false,
			isMounted: false,
			scheduled: false,
		};
		lifecycleStates.set(id, state);
	}
	state.refs += delta;
	const wantMounted = state.refs > 0;
	if (state.wantMounted === wantMounted) {
		if (!wantMounted) maybeDropDormant(state);
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
 * engine's observation index when a watcher over an engine atom's node
 * flips live; a no-op for atoms carrying no observed-lifecycle effect.
 * Direct callbacks only — observation transitions are NOT TraceEvents and
 * never enter the engine's event/lockstep stream. @internal
 */
export function __lifecycleRetain(id: NodeId): void {
	lifecycleShift(id, 1);
}

/** @internal */
export function __lifecycleRelease(id: NodeId): void {
	lifecycleShift(id, -1);
}
