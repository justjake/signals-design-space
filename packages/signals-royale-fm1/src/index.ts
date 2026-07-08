/**
 * signals-royale-fm1 — a concurrent-ready signals engine built on immutable
 * snapshot worlds. Canonical state lives in a versioned reactive graph;
 * speculative state (React transitions) lives in worlds that replay write
 * intents onto the canonical base; render passes pin immutable snapshots.
 */
import { Atom, Computed, EffectNode, EffectScope, type AtomOptions } from './core.ts';

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
	type AtomOptions,
} from './core.ts';

/** Create a writable atom. A function initial value is a lazy initializer:
 * it runs once, untracked, at first read/write/subscription. */
export function atom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
	return new Atom(initial, opts);
}

/** Create a lazy, cached, equality-cutoff computed. The function receives
 * `use`, which unwraps a settled thenable or parks the evaluation on it. */
export function computed<T>(
	fn: (use: <U>(t: PromiseLike<U>) => U) => T,
	opts?: { equals?: (a: T, b: T) => boolean; label?: string },
): Computed<T> {
	return new Computed(fn, opts);
}

/** Run `fn` now and again whenever a dependency's canonical value changes.
 * Returns a disposer. The return value of `fn` is its cleanup. */
export function effect(fn: () => void | (() => void)): () => void {
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
	const { startBatch, endBatch } = coreBatch;
	startBatch();
	try {
		return fn();
	} finally {
		endBatch();
	}
}

import * as coreBatch from './core.ts';
