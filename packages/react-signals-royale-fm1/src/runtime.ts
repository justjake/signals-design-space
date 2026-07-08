/**
 * The React-side runtime: connects the signal engine's worlds to the signal
 * seam exported by the forked react-dom.
 *
 * Division of labor:
 * - React reports lanes as opaque numbers (pass start, per-root commit, the
 *   DOM mutation window) and answers which lane a write issued right now
 *   would take.
 * - This runtime owns batch identity: it maps React transitions to engine
 *   batches, lanes to batches, pins a snapshot world per root per render
 *   pass, folds batches canonically when their lanes commit, and maintains
 *   per-root committed views.
 */
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import {
	Atom,
	Batch,
	Computed,
	Snapshot,
	commitBatch,
	currentEpoch,
	listOpenBatches,
	onDraftWrite,
	openBatch,
	setCommittedViewLookup,
	setWriteGuard,
	traceEvent,
	setCurrentCause,
	update as engineUpdate,
	withAmbientBatch,
	write as engineWrite,
	type Readable,
} from 'signals-royale-fm1';

type Lane = number;

interface SeamClient {
	unstable_registerSignalSeamRuntime(rt: object | null): void;
	unstable_currentUpdateLane(): Lane;
	unstable_currentRenderInfo(): null | { container: unknown; lanes: Lane };
	unstable_runWithPinnedLane<R>(lane: Lane, fn: () => R): R;
}

const seam = ReactDOMClient as unknown as SeamClient;

interface SharedInternals {
	T: object | null;
}
const reactInternals = (
	React as unknown as Record<string, SharedInternals | undefined>
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

// ---------------------------------------------------------------------------
// Runtime state

/** A component (or hook instance) subscribed to a node. */
export interface Subscriber {
	node: Readable<unknown>;
	container: unknown;
	/** Schedule an urgent re-render. */
	force: () => void;
	/** The node version/value delivered by the last committed render; used to
	 * skip redundant corrective renders. */
	kind: 'value' | 'pending' | 'committed';
}

interface RootState {
	snapshot: Snapshot | null;
	/** Canonical epoch at this root's last commit (its committed view). */
	commitEpoch: number;
	commitCount: number;
}

const laneBatches = new Map<Lane, Set<Batch>>();
const batchLane = new Map<Batch, Lane>();
const transitionBatches = new WeakMap<object, Batch>();
const roots = new Map<unknown, RootState>();
/** Subscribers per atom (direct) — computed subscribers are reached through
 * the engine's live links. */
const atomSubs = new Map<Atom<unknown>, Set<Subscriber>>();
const nodeSubs = new Map<Readable<unknown>, Set<Subscriber>>();
const mutationListeners = new Set<(phase: 'start' | 'stop', container: Element) => void>();
const commitListeners = new Set<(container: unknown) => void>();
/** isPending-style probes: re-checked urgently after any draft write, commit,
 * or discard. */
const pendingProbes = new Set<() => void>();

let registered: { errors: unknown[]; dispose(): void } | null = null;
let disposeDraftListener: (() => void) | null = null;

function rootState(container: unknown): RootState {
	let state = roots.get(container);
	if (state === undefined) {
		state = { snapshot: null, commitEpoch: currentEpoch(), commitCount: 0 };
		roots.set(container, state);
	}
	return state;
}

// ---------------------------------------------------------------------------
// Registration

/** Install the runtime into the forked React. Fails loudly on a stock React
 * build (the seam entry points simply do not exist there). Idempotent per
 * process. */
export function register(): { errors: unknown[]; dispose(): void } {
	if (registered !== null) return registered;
	if (typeof seam.unstable_registerSignalSeamRuntime !== 'function') {
		throw new Error(
			'react-signals-royale-fm1 requires the signal-seam React fork: ' +
				'react-dom/client does not export unstable_registerSignalSeamRuntime. ' +
				'Build React from the patches/ series in this package.',
		);
	}
	const errors: unknown[] = [];
	seam.unstable_registerSignalSeamRuntime({
		onPassStart,
		onPassCommit,
		onMutationPhase,
	});
	disposeDraftListener = onDraftWrite(handleDraftWrite);
	setWriteGuard(() => {
		if (seam.unstable_currentRenderInfo() !== null) {
			throw new Error(
				'Writing to an atom during render is not allowed. Move the write ' +
					'into an event handler or an effect.',
			);
		}
	});
	setCommittedViewLookup((container) => roots.get(container)?.commitEpoch ?? null);
	registered = {
		errors,
		dispose() {
			seam.unstable_registerSignalSeamRuntime(null);
			disposeDraftListener?.();
			setWriteGuard(null);
			registered = null;
		},
	};
	return registered;
}

/** Test seam: scrub per-root and per-batch registries. */
export function resetForTest(): void {
	laneBatches.clear();
	batchLane.clear();
	for (const state of roots.values()) state.snapshot?.release();
	roots.clear();
	atomSubs.clear();
	nodeSubs.clear();
	pendingProbes.clear();
	commitListeners.clear();
	mutationListeners.clear();
}

// ---------------------------------------------------------------------------
// Write classification

/** The engine batch for a write issued right now: React transition context
 * maps to one batch per transition, keyed by the transition instance so
 * async continuations keep their batch. */
export function currentWriteBatch(): Batch | null {
	const transition = reactInternals?.T ?? null;
	if (transition === null) return null;
	let batch = transitionBatches.get(transition);
	if (batch === undefined || batch.status !== 'open') {
		batch = openBatch();
		transitionBatches.set(transition, batch);
		const lane = seam.unstable_currentUpdateLane();
		batchLane.set(batch, lane);
		let set = laneBatches.get(lane);
		if (set === undefined) laneBatches.set(lane, (set = new Set()));
		set.add(batch);
	}
	return batch;
}

/** Classified write: urgent outside a transition, a recorded intent inside. */
export function set<T>(a: Atom<T>, v: T): void {
	withAmbientBatch(currentWriteBatch(), () => engineWrite(a, v));
}

/** Functional update that replays against each world's base value. */
export function update<T>(a: Atom<T>, fn: (prev: T) => T): void {
	withAmbientBatch(currentWriteBatch(), () => engineUpdate(a, fn));
}

/** Marry React startTransition with an engine batch: writes inside the scope
 * record into the transition's batch and commit with it. */
export function startTransitionWrite(scope: () => void): void {
	React.startTransition(() => {
		scope();
	});
}

// ---------------------------------------------------------------------------
// Draft delivery (a transition write must re-render its subscribers on the
// transition's lane; we are inside the transition scope when this fires, so
// plain setState calls take that lane)

function handleDraftWrite(atom: Atom<unknown>, batch: Batch): void {
	const cause = traceEvent('draft-write', { batch: batch.id, label: atom.label });
	const prev = setCurrentCause(cause);
	try {
		if (batch.status === 'open') {
			forEachAffectedSubscriber(atom, (sub) => {
				traceEvent('deliver', { label: labelOf(sub.node) });
				sub.force();
			});
		} else {
			// Rollback of a discarded batch: re-notify anyone who saw it, now
			// urgently (the transition context is gone).
			forEachAffectedSubscriber(atom, (sub) => sub.force());
		}
		schedulePendingProbes();
	} finally {
		setCurrentCause(prev);
	}
}

/** Walk the live graph from `atom` to every subscribed hook instance:
 * direct atom subscribers plus subscribers of computeds reachable through
 * the engine's live links. */
function forEachAffectedSubscriber(atom: Atom<unknown>, fn: (sub: Subscriber) => void): void {
	const seen = new Set<object>();
	const visit = (node: Readable<unknown>): void => {
		if (seen.has(node)) return;
		seen.add(node);
		const subs = nodeSubs.get(node);
		if (subs !== undefined) subs.forEach(fn);
		node.subs.forEach((consumer) => {
			if (consumer instanceof Computed) visit(consumer as Computed<unknown>);
		});
	};
	visit(atom);
}

function labelOf(node: Readable<unknown>): string | undefined {
	return node.label;
}

/** isPending probes flip urgently even when raised inside a transition: the
 * microtask escapes the transition scope. */
function schedulePendingProbes(): void {
	queueMicrotask(() => {
		pendingProbes.forEach((probe) => probe());
	});
}

// ---------------------------------------------------------------------------
// Seam events

function onPassStart(container: unknown, lanes: Lanes): void {
	const state = rootState(container);
	const previous = state.snapshot;
	state.snapshot = null;
	if (lanes !== 0) {
		const batches: Batch[] = [];
		for (const [lane, set] of laneBatches) {
			if ((lane & lanes) !== 0) {
				for (const b of set) {
					if (b.status === 'open') batches.push(b);
				}
			}
		}
		batches.sort((a, b) => a.id - b.id);
		const snapshot = new Snapshot(batches, batches.length > 0);
		// Pin before releasing the pass this one replaces: a transient
		// zero-pin moment would drop the canonical history other roots'
		// committed views still read through.
		snapshot.pin();
		state.snapshot = snapshot;
		traceEvent('pass-start', { lanes, batches: batches.map((b) => b.id) }, undefined);
	}
	previous?.release();
}

type Lanes = number;

function onPassCommit(container: unknown, lanes: Lanes, remainingLanes: Lanes): void {
	const state = rootState(container);
	state.snapshot?.release();
	state.snapshot = null;
	const cause = traceEvent('root-commit', { lanes }, undefined);
	const prevCause = setCurrentCause(cause);
	try {
		// Retire the batches these lanes carried (fold intents canonically).
		// The fold runs under the batch's own lane pin: subscribers on OTHER
		// roots woken by the canonical change re-render inside the batch's
		// pending pass there — a corrective render lands inside the owning
		// batch's commit, never beside it.
		for (const [lane, batchSet] of laneBatches) {
			if ((lane & lanes) === 0) continue;
			seam.unstable_runWithPinnedLane(lane, () => {
				for (const b of batchSet) commitBatch(b);
			});
			if ((lane & remainingLanes) === 0) laneBatches.delete(lane);
		}
		// Advance this root's committed view: everything canonical up to this
		// moment (including the folds above) is now on this root's screen.
		state.commitEpoch = currentEpoch();
		state.commitCount++;
		commitListeners.forEach((l) => l(container));
		schedulePendingProbes();
	} finally {
		setCurrentCause(prevCause);
	}
}

function onMutationPhase(phase: 'start' | 'stop', container: unknown): void {
	mutationListeners.forEach((l) => l(phase, container as Element));
}

// ---------------------------------------------------------------------------
// Render-time world resolution

/** The world the current render pass reads: the pass snapshot when the fork
 * is rendering this root, canonical otherwise. */
export function currentRenderSnapshot(): Snapshot | null {
	const info = seam.unstable_currentRenderInfo();
	if (info === null) return null;
	return roots.get(info.container)?.snapshot ?? null;
}

export function currentRenderContainer(): unknown {
	return seam.unstable_currentRenderInfo()?.container ?? null;
}

/** Read `node` in the current render pass's world. */
export function readInRenderWorld<T>(node: Readable<T>): T {
	const snapshot = currentRenderSnapshot();
	if (snapshot === null) {
		return node.peek();
	}
	if (node instanceof Atom) return snapshot.readAtom(node);
	return snapshot.readComputed(node as Computed<T>);
}

// ---------------------------------------------------------------------------
// Subscriptions (claimed by hooks at commit)

export function subscribe(sub: Subscriber): () => void {
	let set = nodeSubs.get(sub.node);
	if (set === undefined) nodeSubs.set(sub.node, (set = new Set()));
	set.add(sub);
	if (sub.node instanceof Atom) {
		let aset = atomSubs.get(sub.node as Atom<unknown>);
		if (aset === undefined) atomSubs.set(sub.node as Atom<unknown>, (aset = new Set()));
		aset.add(sub);
	}
	return () => {
		set.delete(sub);
		if (set.size === 0) nodeSubs.delete(sub.node);
		if (sub.node instanceof Atom) {
			const aset = atomSubs.get(sub.node as Atom<unknown>);
			if (aset !== undefined) {
				aset.delete(sub);
				if (aset.size === 0) atomSubs.delete(sub.node as Atom<unknown>);
			}
		}
	};
}

/** Post-subscribe fixup for a component that mounted while transitions were
 * pending: schedule a re-render on each open batch's lane so the new
 * subscriber joins those batches' commits instead of tearing beside them. */
export function joinOpenBatches(node: Readable<unknown>, force: () => void): void {
	for (const batch of listOpenBatches()) {
		if (batch.touched.size === 0) continue;
		if (!batchTouches(batch, node)) continue;
		const lane = batchLane.get(batch as Batch);
		if (lane === undefined) continue;
		seam.unstable_runWithPinnedLane(lane, force);
	}
}

function batchTouches(batch: Batch, node: Readable<unknown>): boolean {
	if (node instanceof Atom) return batch.touched.has(node as Atom<unknown>);
	// Probe the computed's recorded dependency graph.
	const seen = new Set<object>();
	const stack: Readable<unknown>[] = [node];
	while (stack.length > 0) {
		const cursor = stack.pop()!;
		if (seen.has(cursor)) continue;
		seen.add(cursor);
		if (cursor instanceof Atom) {
			if (batch.touched.has(cursor as Atom<unknown>)) return true;
		} else {
			for (const d of (cursor as Computed<unknown>).deps) stack.push(d as Readable<unknown>);
		}
	}
	return false;
}

export function onCommit(listener: (container: unknown) => void): () => void {
	commitListeners.add(listener);
	return () => commitListeners.delete(listener);
}

export function onPendingMaybeChanged(probe: () => void): () => void {
	pendingProbes.add(probe);
	return () => pendingProbes.delete(probe);
}

/** Userland DOM mutation window: fires start/stop around exactly React's DOM
 * mutation phase per root commit. */
export function onDomMutation(
	cb: (phase: 'start' | 'stop', container: Element) => void,
): () => void {
	mutationListeners.add(cb);
	return () => mutationListeners.delete(cb);
}
