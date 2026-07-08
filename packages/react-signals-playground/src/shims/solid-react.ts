/**
 * `concurrent-solid-react` behind the common shim interface.
 *
 * This implementation hosts Solid 2.0's reactive core in React, and its
 * shapes differ from the cosignals family in three ways the shim absorbs:
 * - Signals are `[get, set]` accessor pairs, not objects — createAtom wraps
 *   the pair in the interface's `.state` surface.
 * - Transition membership is decided at write time (the bridge asks React
 *   which batch each write belongs to), so React's own startTransition IS
 *   the transition surface; the package exports no wrapper to import.
 * - The package's useSignalEffect takes no `deps` (a tracked effect always
 *   calls the latest closure through a ref), so the interface's deps-aware
 *   variant is rebuilt here from the same engine primitives the package
 *   hook uses (createRoot + createTrackedEffect inside React.useEffect).
 *
 * Deriveds would naturally be Solid memos, but they currently run DEGRADED
 * as unmemoized tracked reads — see createComputed for the engine issue
 * (dirty-heap lockup on urgent writes with memo-subscribed components) and
 * the reference-stability machinery that replaces the memo cache.
 */
import * as React from 'react';
import {
	createRoot,
	createSignal,
	createTrackedEffect,
	registerConcurrentSolidReact,
	useSelector,
	type Accessor,
	type Setter,
} from 'concurrent-solid-react';
import type { ReadableSignal, TransitionHoldStyle, WritableSignal } from './interface';

export const name = 'concurrent-solid-react';

// Originally measured in the playground's Playwright suite: a foreign
// promise thrown from a component inside a transition render did NOT hold
// this bridge's transition open — it froze ALL commits (urgent ones
// included) until the promise resolved, and React then recovered with a
// synchronous root render plus a recoverable-error report. Re-measured
// 2026-07-08 by the verification battery (battery/, FIND-THENABLE.gate):
// against current engine sources — with this shim's memo degradation in
// place — the freeze no longer reproduces; thrown promises (native or
// foreign thenable) hold the transition exactly like the suspense-style
// implementations. defer-write stays for the app's navigation flow because
// this bridge's own Suspense integration is still built around its async
// machinery (async memos whose pending reads surface as node-held
// thenables), not thenables thrown mid-render by app code; the battery
// exercises both styles and pins the currently-working hold.
export const transitionHoldStyle: TransitionHoldStyle = 'defer-write';

export function register(): void {
	// The handle is intentionally dropped: registration lives for the page,
	// and dispose() only matters for tests that re-register.
	registerConcurrentSolidReact();
}

/** Adapter from Solid's [get, set] accessor pair to the interface's object surface. */
class SolidAtom<T> implements WritableSignal<T> {
	constructor(
		private readonly read: Accessor<T>,
		private readonly write: Setter<T>,
	) {}
	get state(): T {
		return this.read();
	}
	set(next: T): void {
		// Always hand the setter an updater: Solid setters treat a bare
		// function argument as an updater, so a function-typed T would
		// otherwise be called instead of stored.
		this.write(() => next);
	}
	update(fn: (current: T) => T): void {
		this.write(fn);
	}
}

export function createAtom<T>(initial: T, label?: string): WritableSignal<T> {
	const [read, write] = createSignal<T>(initial as Exclude<T, Function>, { name: label });
	return new SolidAtom<T>(read, write);
}

/** Structural equality for stabilizing derived results: arrays and plain
 * objects compare by content, everything else by Object.is. Derived values
 * here are small (row-index arrays, {index, value} records), so recursion
 * depth and cost stay trivial. */
function isSameShape(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!isSameShape(a[i], b[i])) return false;
		}
		return true;
	}
	if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
		const keysA = Object.keys(a);
		const keysB = Object.keys(b);
		if (keysA.length !== keysB.length) return false;
		for (const key of keysA) {
			if (!isSameShape((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
				return false;
			}
		}
		return true;
	}
	return false;
}

/** How many distinct derived results to keep per derived: the committed
 * world plus a couple of live transition worlds. */
const STABLE_RING_SIZE = 3;

/**
 * Reference stability without a memo: recomputing on every read returns a
 * fresh array/object each time, but the bridge's post-commit fixup compares
 * reads by Object.is — an ever-fresh reference for unchanged content reads
 * as "the value moved" on every commit and loops the corrective re-render.
 * A memo provides that stability by caching; this ring provides it by
 * structural lookup, keeping one slot per world so committed and pending
 * values don't evict each other.
 */
function createStableRing<T>(): (next: T) => T {
	const ring: T[] = [];
	return (next: T): T => {
		for (const held of ring) {
			if (isSameShape(held, next)) return held;
		}
		ring.unshift(next);
		if (ring.length > STABLE_RING_SIZE) ring.pop();
		return next;
	};
}

export function createComputed<T>(fn: () => T, label?: string): ReadableSignal<T> {
	// DEGRADED: an unmemoized derived — each read runs `fn` and tracks its
	// signal reads directly, with no Solid memo node in the graph.
	//
	// Why (as of the engine sources current on 2026-07-08): with any React
	// component subscribed to a memo, one urgent signal write outside a live
	// transition locks the page — the bridge's shared render-probe node is
	// left parked in the engine's dirty heap with cleared flags, the heap's
	// remove-guard skips it, and the flush loop can never drain that level.
	// Package tests pass (they always write inside transitions or without
	// memo-subscribed components); the package is out of scope to patch
	// here. Memos are the only trigger, so deriveds compute on read until
	// the engine fix lands — costlier (no caching) but correct: same values,
	// same tracking, no graph heights.
	void label;
	const stable = createStableRing<T>();
	return {
		get state(): T {
			return stable(fn());
		},
	};
}

export function useSignal<T>(signal: ReadableSignal<T>): T {
	// useSelector resolves the read in the current render pass's world
	// (committed for urgent passes, staged for transition passes) and
	// subscribes the component through the bridge's two-phase reader.
	return useSelector(() => signal.state);
}

export function useComputed<T>(fn: () => T, deps: readonly unknown[]): T {
	// DEGRADED alongside createComputed (see there): the package's
	// useComputed creates a component-owned memo, which re-triggers the
	// heap lockup. An unmemoized selector keeps the contract's observable
	// behavior — signal reads tracked, re-render on change, fresh `deps`
	// closure every render — and drops only the caching. The stable ring
	// (component-owned here) provides the reference stability the memo
	// used to.
	void deps;
	const stableRef = React.useRef<((next: T) => T) | null>(null);
	if (stableRef.current === null) stableRef.current = createStableRing<T>();
	const stable = stableRef.current;
	return useSelector<T>(() => stable(fn()));
}

export function useSignalEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
	const fnRef = React.useRef(fn);
	fnRef.current = fn;
	// Same construction as the package's own useSignalEffect — a tracked
	// effect (committed-world reads only; runs held while a transition is
	// live, released at its commit) inside a disposable root — but keyed on
	// `deps` so changed React values re-establish tracking, matching the
	// interface's useEffect-like deps contract (undefined = every render).
	React.useEffect(
		() =>
			createRoot((disposeRoot: () => void) => {
				createTrackedEffect(() => fnRef.current());
				return disposeRoot;
			}),
		deps === undefined ? undefined : [...deps],
	);
}

export function startSignalTransition(scope: () => void): void {
	// Write-time classification: every engine write asks React for the
	// current batch, so the plain React transition scope already routes the
	// writes inside `scope` into a deferred Solid transition.
	React.startTransition(scope);
}
