/**
 * Async values: pending and error are graph state, not control flow.
 *
 * A computed that touches an unresolved thenable through `use` parks: its
 * evaluation ends in a pending box holding one stable promise that read sites
 * rethrow (Suspense boundaries retry against the same promise, so nothing
 * refetches). Every thenable touched before the park registers here first, so
 * parallel fetches all start on the first evaluation. Settlement behaves as a
 * write: it invalidates the parked computeds and propagates through the graph
 * inside one flush scope.
 */
import {
	Computed,
	bumpEpoch,
	currentCause,
	emitTrace,
	endBatch,
	isThenable,
	setCurrentCause,
	setOnPark,
	setUseThenable,
	startBatch,
} from './core.ts';
import { Snapshot, setSnapshotUseThenable } from './worlds.ts';

type ThenableState =
	| { status: 'pending' }
	| { status: 'fulfilled'; value: unknown }
	| { status: 'rejected'; error: unknown };

const thenables = new WeakMap<PromiseLike<unknown>, ThenableState>();
/** Computeds parked on each thenable, invalidated at settlement. */
const parked = new WeakMap<PromiseLike<unknown>, Set<Computed<unknown>>>();

function track(t: PromiseLike<unknown>): ThenableState {
	let state = thenables.get(t);
	if (state === undefined) {
		state = { status: 'pending' };
		thenables.set(t, state);
		t.then(
			(value) => settle(t, { status: 'fulfilled', value }),
			(error) => settle(t, { status: 'rejected', error }),
		);
	}
	return state;
}

function settle(t: PromiseLike<unknown>, next: ThenableState): void {
	thenables.set(t, next);
	const waiters = parked.get(t);
	parked.delete(t);
	if (waiters === undefined || waiters.size === 0) return;
	const prevCause = setCurrentCause(
		emitTrace !== null ? emitTrace('settle', currentCause, { status: next.status }) : undefined,
	);
	// Settlement is a write: invalidate and propagate in one flush scope.
	bumpEpoch();
	startBatch();
	try {
		for (const c of waiters) {
			c.checkEpoch = 0;
			c.seenRefresh = c.refreshVersion - 1; // force the next ensure to recompute
			c.markStale();
			// Re-evaluate now even without live subscribers: a suspended React
			// boundary holds this computed's park promise, and only a recompute
			// that leaves the pending state resolves it (the retry signal).
			c.ensure();
		}
	} finally {
		endBatch();
		setCurrentCause(prevCause);
	}
}

/** Unwrap a settled thenable or park the evaluation on it. */
function use<U>(t: PromiseLike<U>): U {
	const state = track(t);
	if (state.status === 'fulfilled') return state.value as U;
	if (state.status === 'rejected') throw state.error;
	throw t;
}

/** Register the parked computed when core catches the thrown thenable. */
function onPark(c: Computed<unknown>, t: PromiseLike<unknown>): void {
	let set = parked.get(t);
	if (set === undefined) {
		set = new Set();
		parked.set(t, set);
	}
	set.add(c);
}

setUseThenable(use);
setOnPark(onPark);
// Snapshot evaluations share thenable state (a draft evaluation that parks on
// a fetch must not refetch when the canonical evaluation runs, and vice
// versa); the snapshot itself re-evaluates per pass, so parking is per-read.
setSnapshotUseThenable((snapshot: Snapshot) => use);

/** True when `x` is a thenable this registry has seen settle. */
export function isSettledThenable(t: PromiseLike<unknown>): boolean {
	const s = thenables.get(t);
	return s !== undefined && s.status !== 'pending';
}

export { use as useAsync };
