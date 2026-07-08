/**
 * signals-royale-fm1 — a concurrent-ready signals engine built on immutable
 * snapshot worlds. Canonical state lives in a versioned reactive graph;
 * speculative state (React transitions) lives in batches of write intents
 * that replay onto the canonical base; render passes pin snapshots, and a
 * commit is a fold of intents onto whatever base is current — the rebase is
 * the replay.
 */
import './async.ts';
import { Atom, Computed, EffectNode, EffectScope, type AtomOptions } from './core.ts';
import * as core from './core.ts';

export {
	Atom,
	Computed,
	EffectNode,
	EffectScope,
	Watcher,
	startBatch,
	endBatch,
	untracked,
	currentEpoch,
	setExternalObserverCount,
	setWriteGuard,
	pinCount as pinCountForTest,
	UNSET,
	type AtomOptions,
	type Epoch,
	type NodeVersion,
	type TraceId,
} from './core.ts';

export {
	Batch,
	Snapshot,
	commitBatch,
	committed,
	currentAmbientBatch,
	discardBatch,
	isPending,
	latest,
	listOpenBatches,
	onDraftWrite,
	openBatch,
	refresh,
	setCommittedViewLookup,
	update,
	withAmbientBatch,
	withSnapshot,
	write,
	type BatchId,
	type BatchStatus,
	type Readable,
	type WriteIntent,
} from './worlds.ts';

export { Tracer, formatEvent, type TraceEvent } from './tracer.ts';
export { useAsync, isSettledThenable } from './async.ts';

/** Create a writable atom. A function initial value is a lazy initializer:
 * it runs once, untracked, at first read/write/subscription — never at
 * construction. */
export function atom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
	return new Atom(initial, opts);
}

/** Create a lazy, cached, equality-cutoff computed. The function receives
 * `use`, which unwraps a settled thenable or parks the evaluation on it
 * (pending is graph state, not control flow). */
export function computed<T>(
	fn: (use: <U>(t: PromiseLike<U>) => U) => T,
	opts?: { equals?: (a: T, b: T) => boolean; label?: string },
): Computed<T> {
	return new Computed(fn, opts);
}

/** Run `fn` now and again whenever a dependency's canonical value changes.
 * Returns a disposer. The return value of `fn` is its cleanup. Effects
 * observe canonical state only — never speculative transition drafts. */
export function effect(fn: () => unknown): () => void {
	const node = new EffectNode(fn);
	return () => node.dispose();
}

/** Run `fn`, collecting every effect (and nested scope) it creates; the
 * returned disposer tears the whole collection down. */
export function effectScope(fn: () => void): () => void {
	const scope = new EffectScope(fn);
	return () => scope.dispose();
}

/** Synchronous write coalescing: effects run once, at the outermost end. */
export function batch<T>(fn: () => T): T {
	core.startBatch();
	try {
		return fn();
	} finally {
		core.endBatch();
	}
}

// ---------------------------------------------------------------------------
// SSR

/** Serialize the current values of `atoms` under app-supplied keys. Atoms
 * whose lazy initializer never ran are omitted (serialization is not a
 * read). */
export function serializeAtomState(
	atoms: Record<string, Atom<unknown>>,
	replacer?: (key: string, value: unknown) => unknown,
): string {
	const out: Record<string, unknown> = {};
	for (const [key, a] of Object.entries(atoms)) {
		if (a.value !== core.UNSET) out[key] = a.value;
	}
	return JSON.stringify(out, replacer);
}

/** Install serialized state onto a fresh engine's atoms. Install is not a
 * write: no notifications, no equality checks, and lazy initializers do not
 * run (the installed value simply becomes the base). */
export function initializeAtomState(
	json: string,
	atoms: Record<string, Atom<unknown>>,
	reviver?: (key: string, value: unknown) => unknown,
): void {
	const data = JSON.parse(json, reviver) as Record<string, unknown>;
	installState(data, atoms);
}

/** Install plain values onto atoms without write semantics. */
export function installState(
	data: Record<string, unknown>,
	atoms: Record<string, Atom<unknown>>,
): void {
	for (const [key, value] of Object.entries(data)) {
		const a = atoms[key];
		if (a !== undefined) a.install(value);
	}
}
