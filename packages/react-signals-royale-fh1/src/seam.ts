/**
 * The host side of the signal seam.
 *
 * React (forked) publishes a small channel on its shared internals: raw lane
 * facts (pass start, root updated, commit, mutation bracket), two queries
 * (current write lane, current render container), and one control (a pinned
 * transition lane). This module turns those facts into engine concepts:
 *
 * - every transition lane with signal writes gets one engine Batch;
 * - every render pass gets one World (cutoff latched at pass start, plus the
 *   batches whose lanes the pass renders);
 * - every commit advances that root's committed cutoff and retires the
 *   batches whose lanes it finished.
 */
import * as React from 'react';
import {
	Batch,
	createBatch,
	liveBatches,
	makeWorld,
	World,
	currentSeq,
	setCommittedCutoffProvider,
	setRenderWorldProvider,
	setStampProvider,
	setWriteGuard,
	emit,
	tracing,
	setCause,
	withCause,
	type WriteSeq,
} from 'signals-royale-fh1';

type Lanes = number;

interface SignalSeam {
	runtime: {
		onPassStart(container: unknown, lanes: Lanes): void;
		onRootUpdated(container: unknown, lanes: Lanes): void;
		onCommit(container: unknown, committedLanes: Lanes, remainingLanes: Lanes): void;
		onMutation(container: unknown, active: boolean): void;
	} | null;
	getWriteLane: (() => number) | null;
	getRenderContainer: (() => unknown) | null;
	pinnedTransitionLane: number;
}

interface ReactInternals {
	signalSeam?: SignalSeam;
	/** The ambient transition scope (React's own field). */
	T: unknown;
}

function internalsOf(react: unknown): ReactInternals {
	const r = react as Record<string, unknown>;
	const internals = (r.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ??
		r.__CLIENT_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED) as ReactInternals | undefined;
	if (internals === undefined) {
		throw new Error('react-signals-royale-fh1: this React build exposes no client internals');
	}
	return internals;
}

export interface Host {
	seam: SignalSeam;
	internals: ReactInternals;
	batchByLane: Map<number, Batch>;
	batchRoots: WeakMap<Batch, Set<unknown>>;
	worldByRoot: Map<unknown, World>;
	commitCutoffByRoot: Map<unknown, WriteSeq>;
	mutationSubs: Set<(phase: 'start' | 'stop', container: Element) => void>;
	committedProbes: Map<unknown, Set<() => void>>;
	errors: unknown[];
}

let host: Host | null = null;

export function getHost(): Host {
	if (host === null) {
		throw new Error(
			'react-signals-royale-fh1: register() has not run — call register() before rendering',
		);
	}
	return host;
}

export function tryGetHost(): Host | null {
	return host;
}

/** Attach the runtime to the seam. Idempotent per process. Throws loudly on a
 * React build without the signal-seam protocol. */
export function register(): Host {
	if (host !== null) {
		installProviders(host);
		return host;
	}
	const internals = internalsOf(React);
	const seam = internals.signalSeam;
	if (seam === undefined || typeof seam !== 'object' || seam === null) {
		throw new Error(
			'react-signals-royale-fh1: this React build does not implement the signal seam. ' +
				'Build React from the patches/ series in this package (see build.sh).',
		);
	}
	const h: Host = {
		seam,
		internals,
		batchByLane: new Map(),
		batchRoots: new WeakMap(),
		worldByRoot: new Map(),
		commitCutoffByRoot: new Map(),
		mutationSubs: new Set(),
		committedProbes: new Map(),
		errors: [],
	};
	seam.runtime = {
		onPassStart(container, lanes) {
			const prev = h.worldByRoot.get(container);
			if (prev !== undefined) prev.release();
			if (lanes === 0) {
				h.worldByRoot.delete(container);
				return;
			}
			const ids: number[] = [];
			for (const [lane, b] of h.batchByLane) {
				if ((lane & lanes) !== 0) ids.push(b.id);
			}
			h.worldByRoot.set(container, makeWorld(ids));
			if (tracing) emit('pass-start', undefined, { batches: ids });
		},
		onRootUpdated(container, lanes) {
			for (const [lane, b] of h.batchByLane) {
				if ((lane & lanes) !== 0) {
					let roots = h.batchRoots.get(b);
					if (roots === undefined) {
						roots = new Set();
						h.batchRoots.set(b, roots);
					}
					roots.add(container);
				}
			}
		},
		onCommit(container, committedLanes, remainingLanes) {
			const commitEv = tracing ? emit('root-commit') : 0;
			const prevCause = commitEv !== 0 ? setCause(commitEv) : -1;
			try {
				for (const [lane, b] of [...h.batchByLane]) {
					if ((lane & committedLanes) !== 0) {
						h.batchByLane.delete(lane);
						b.retire();
					} else if ((lane & remainingLanes) === 0) {
						// The lane vanished from this root without committing.
						const roots = h.batchRoots.get(b);
						if (roots !== undefined && roots.has(container)) {
							roots.delete(container);
							if (roots.size === 0) {
								h.batchByLane.delete(lane);
								b.discard();
							}
						}
					}
				}
			} finally {
				if (prevCause !== -1) setCause(prevCause);
			}
			h.commitCutoffByRoot.set(container, currentSeq());
			const world = h.worldByRoot.get(container);
			if (world !== undefined) {
				world.release();
				h.worldByRoot.delete(container);
				if (tracing) emit('pass-end', undefined, { disposition: 'commit' });
			}
			const probes = h.committedProbes.get(container);
			if (probes !== undefined) {
				for (const probe of [...probes]) probe();
			}
		},
		onMutation(container, active) {
			for (const cb of [...h.mutationSubs]) {
				cb(active ? 'start' : 'stop', container as Element);
			}
		},
	};
	installProviders(h);
	host = h;
	return h;
}

function installProviders(h: Host): void {
	setStampProvider(() => {
		const lane = h.seam.getWriteLane === null ? 0 : h.seam.getWriteLane();
		if (lane === 0) return null;
		let b = h.batchByLane.get(lane);
		if (b === undefined) {
			b = createBatch();
			b.meta = lane;
			h.batchByLane.set(lane, b);
			scheduleBatchProbe(h, b, lane);
		}
		return b;
	});
	setWriteGuard(() => {
		if (h.seam.getRenderContainer !== null && h.seam.getRenderContainer() !== null) {
			throw new Error(
				'react-signals-royale-fh1: writing a signal during render is not allowed. ' +
					'Move the write into an event handler or an effect.',
			);
		}
	});
	setCommittedCutoffProvider((container?: unknown) => {
		if (container !== undefined) {
			return h.commitCutoffByRoot.get(container) ?? currentSeq();
		}
		return currentSeq();
	});
	// A direct latest() call in a component body resolves the pass's own world.
	setRenderWorldProvider(currentRenderWorld);
}

/** A batch whose transition never scheduled React work on any root would
 * otherwise stay live forever; two microtasks after creation (past React's
 * own scheduling microtask) an orphan batch retires directly. */
function scheduleBatchProbe(h: Host, b: Batch, lane: number): void {
	queueMicrotask(() => {
		queueMicrotask(() => {
			if (b.state !== 0) return;
			const roots = h.batchRoots.get(b);
			if (roots === undefined || roots.size === 0) {
				h.batchByLane.delete(lane);
				b.retire();
			}
		});
	});
}

/** The world the currently executing render pass reads through; null when not
 * rendering (or when this root has no pass world). */
export function currentRenderWorld(): World | null {
	const h = host;
	if (h === null || h.seam.getRenderContainer === null) return null;
	const container = h.seam.getRenderContainer();
	if (container === null) return null;
	return h.worldByRoot.get(container) ?? null;
}

export function currentRenderContainer(): unknown {
	const h = host;
	if (h === null || h.seam.getRenderContainer === null) return null;
	return h.seam.getRenderContainer();
}

/** Run `fn` so the React updates it schedules land INSIDE the given batch's
 * own lane and commit with it. A retired batch falls back to an urgent run. */
export function runInBatch(b: Batch, fn: () => void): void {
	const h = getHost();
	const lane = b.meta as number | null;
	if (b.state !== 0 || lane === null || lane === 0) {
		runUrgent(fn);
		return;
	}
	const prev = h.seam.pinnedTransitionLane;
	h.seam.pinnedTransitionLane = lane;
	try {
		React.startTransition(() => b.run(fn));
	} finally {
		h.seam.pinnedTransitionLane = prev;
	}
}

/** Run `fn` outside any ambient transition, so its updates stay urgent even
 * when called from inside a transition scope (isPending flips must be
 * urgently visible while the owning transition parks). */
export function runUrgent(fn: () => void): void {
	const h = getHost();
	const prevT = h.internals.T;
	h.internals.T = null;
	try {
		fn();
	} finally {
		h.internals.T = prevT;
	}
}

/** Subscribe to the exact window in which React mutates the DOM per commit. */
export function onDomMutation(
	cb: (phase: 'start' | 'stop', container: Element) => void,
): () => void {
	const h = getHost();
	h.mutationSubs.add(cb);
	return () => {
		h.mutationSubs.delete(cb);
	};
}

/** Marry React startTransition with engine write classification: writes in
 * the scope become one deferred batch that commits with the transition. */
export function startTransitionWrite(scope: () => void): void {
	React.startTransition(scope);
}

/** Host registry scrub for tests. The engine reset runs separately. */
export function resetHostForTest(): void {
	const h = host;
	if (h === null) return;
	for (const w of h.worldByRoot.values()) w.release();
	h.worldByRoot.clear();
	h.batchByLane.clear();
	h.commitCutoffByRoot.clear();
	h.mutationSubs.clear();
	h.committedProbes.clear();
	h.errors.length = 0;
	liveBatches.clear();
}
