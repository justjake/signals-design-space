/**
 * signals-royale-fm2 — a concurrent signal engine for React.
 *
 * The engine is React-free: it models writable atoms, cached computeds,
 * effects, and "worlds" (overlay views of pending concurrent write batches).
 * The companion package react-signals-royale-fm2 maps React render passes
 * and commits onto these primitives.
 */

import {
	AtomNode,
	ComputedNode,
	EffectNode,
	EffectScope,
	CommittedView,
	committedRead,
	latestOf,
	isPendingOf,
	type AtomOptions,
	type ComputedOptions,
	type UseFn,
} from './core.ts';

export {
	AtomNode,
	ComputedNode,
	EffectNode,
	EffectScope,
	CommittedView,
	Suspension,
	isSuspension,
	batch,
	startBatch,
	endBatch,
	untracked,
	createBatch,
	getBatch,
	openBatchCount,
	retireBatch,
	abortBatch,
	runInWriteBatch,
	currentWriteBatchId,
	withWorld,
	setAmbientWorld,
	getAmbientWorld,
	subscribeNode,
	setWriteGuard,
	createCommittedView,
	flushLifetimeEffects,
	resetForTest,
	type World,
	type WorldBatch,
	type BatchId,
	type AtomOptions,
	type ComputedOptions,
	type UseFn,
	type Equals,
	type ExternalListener,
} from './core.ts';

export {
	startTrace,
	emitTrace,
	withCause,
	currentCauseId,
	type Tracer,
	type TraceEvent,
	type TraceEventId,
} from './tracer.ts';

/** A writable reactive cell. */
export type Atom<T> = AtomNode<T>;
/** A lazy, cached derivation. */
export type Computed<T> = ComputedNode<T>;
/** Anything readable: an atom or a computed. */
export type Readable<T> = AtomNode<T> | ComputedNode<T>;

/**
 * Create a writable atom. A function-valued `initial` is a lazy initializer:
 * it runs once, untracked, at first read/write/subscription.
 */
export function atom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
	return new AtomNode(initial, opts);
}

/**
 * Create a computed. The function receives `use` for async reads: `use(p)`
 * unwraps a thenable, parking the evaluation as pending until it settles.
 */
export function computed<T>(fn: (use: UseFn) => T, opts?: ComputedOptions<T>): Computed<T> {
	return new ComputedNode(fn, opts);
}

/** Run `fn` now and on every canonical dependency change; returns a disposer. */
export function effect(fn: () => void | (() => void)): () => void {
	const e = new EffectNode(fn);
	return () => e.dispose();
}

/** Collect effects created inside `fn` for one-call disposal. */
export function effectScope(fn: () => void): () => void {
	const s = new EffectScope();
	s.run(fn);
	return () => s.dispose();
}

/** Canonical read: committed state plus applied urgent writes; drafts hidden. */
export function read<T>(x: Readable<T>): T {
	return x.read();
}

/** Newest intent, including transition drafts. Never suspends once settled. */
export function latest<T>(x: Readable<T>): T {
	return latestOf(x);
}

/**
 * What is on screen. With a view (one per React root), atoms resolve through
 * that root's committed snapshot; without one, canonical state. Never
 * subscribes.
 */
export function committed<T>(x: Readable<T>, view?: CommittedView | null): T {
	return committedRead(x, view ?? null);
}

/** True while newer data loads (or drafts sit) behind the visible value. */
export function isPending<T>(x: Readable<T>): boolean {
	return isPendingOf(x);
}

/** Force a refetch with unchanged inputs; the stale value keeps serving. */
export function refresh<T>(x: Readable<T>): void {
	if (x instanceof ComputedNode) x.refresh();
}

/** Write an atom (classified by the ambient write batch). */
export function set<T>(a: Atom<T>, value: T): void {
	a.set(value);
}

/** Functional update; replays against each world's base value at retirement. */
export function update<T>(a: Atom<T>, fn: (prev: T) => T): void {
	a.update(fn);
}

// ---------------------------------------------------------------------------
// SSR
// ---------------------------------------------------------------------------

/** The structural surface SSR needs from an atom (any value type). */
export interface SerializableAtom {
	read(): unknown;
	install(value: unknown): void;
}

/** Serialize atom values under app-supplied keys. */
export function serializeAtomState(
	atoms: Record<string, SerializableAtom>,
	replacer?: (key: string, value: unknown) => unknown,
): string {
	const out: Record<string, unknown> = {};
	for (const [key, a] of Object.entries(atoms)) out[key] = committedRead(a, null);
	return JSON.stringify(out, replacer);
}

/** Install serialized values into matching atoms (install, not write). */
export function initializeAtomState(
	json: string,
	atoms: Record<string, SerializableAtom>,
	reviver?: (key: string, value: unknown) => unknown,
): void {
	const data = JSON.parse(json, reviver) as Record<string, unknown>;
	for (const [key, a] of Object.entries(atoms)) {
		if (Object.prototype.hasOwnProperty.call(data, key)) a.install(data[key]);
	}
}

/**
 * Install one value directly. Does not run the lazy initializer and does not
 * count as a write: no equality check, no notification, no draft.
 */
export function installState<T>(a: Atom<T>, value: T): void {
	a.install(value);
}
