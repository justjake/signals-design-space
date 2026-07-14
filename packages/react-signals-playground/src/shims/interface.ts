/**
 * The one contract every implementation shim satisfies. App code imports
 * this surface (as values) from '#concurrent-signals-shim' and never names a
 * concrete implementation; the selector module (./index.ts) binds that
 * specifier to exactly one implementation per page.
 *
 * The surface is the least common denominator of the three bridges:
 * - signal creation: writable atoms and derived (computed) values
 * - render subscription: useSignal, useComputed
 * - committed-world side effects: useSignalEffect
 * - transitions: startSignalTransition
 * - root creation: installs any implementation-specific root provider
 * Implementation-specific extras (pending probes, reducer atoms, async
 * actions) stay on the packages' own entrypoints; a page that needs them is
 * no longer implementation-agnostic and should import the package directly.
 */
import type { ReactNode } from 'react'

/**
 * How an implementation keeps a navigation-style transition open while the
 * destination's async data is still in flight.
 *
 * - 'suspense': a component rendered inside the transition may throw the
 *   pending data's promise (React Suspense). React keeps the transition
 *   open — committed UI stays on screen and interactive, urgent updates
 *   keep landing — and finishes it when the promise resolves. This is how
 *   React's own startTransition behaves over suspending data reads.
 * - 'defer-write': thrown promises inside transition renders are not safe
 *   on this implementation; the app should await the data first and only
 *   then run the transition's writes. The pending window is app-derived
 *   state (compare an urgently-written target against the transitionally
 *   written current value); no render ever suspends.
 */
export type TransitionHoldStyle = 'suspense' | 'defer-write'

/** A readable reactive value: an atom or a derived value. */
export interface ReadableSignal<T> {
	readonly state: T
}

/** A writable reactive value (an atom). */
export interface WritableSignal<T> extends ReadableSignal<T> {
	/** Replace the value. */
	set(next: T): void
	/** Functional update; `fn` must be pure (implementations replay it per pending world). */
	update(fn: (current: T) => T): void
}

export interface ConcurrentSignalsShim {
	/** Implementation display name — rendered by the app so a page proves which engine drives it. */
	readonly name: string

	/**
	 * Couples the implementation's engine to the patched React build's
	 * external-runtime protocol. Call exactly once per page, after importing
	 * react-dom/client (the renderer registers its protocol provider at
	 * module init) and before rendering any root. Throws on stock React.
	 */
	register(): void

	/** Create a React root with any provider required by this implementation. */
	createRoot(container: Element): {
		render(node: ReactNode): void
		unmount(): void
	}

	/** A module-level writable signal. */
	createAtom<T>(initial: T, label?: string): WritableSignal<T>

	/**
	 * A module-level derived signal: `fn`'s signal reads are tracked and the
	 * value recomputes when they change. `fn` must be pure.
	 */
	createComputed<T>(fn: () => T, label?: string): ReadableSignal<T>

	/**
	 * Subscribes the component to a signal and returns its value for the
	 * current render's world: a transition render sees pending state, an
	 * urgent render sees committed state, and no render mixes the two.
	 */
	useSignal<T>(signal: ReadableSignal<T>): T

	/**
	 * Component-scoped derived value: like useMemo, but the component also
	 * re-renders when a signal read inside `fn` changes. Signal reads are
	 * tracked automatically and do NOT belong in `deps`; `deps` covers the
	 * ordinary React values `fn` closes over (props, state).
	 */
	useComputed<T>(fn: () => T, deps: readonly unknown[]): T

	/**
	 * Committed-value side effect, split into a pure tracked compute and a
	 * handler that runs with the computed (value, previous) pair and may
	 * return a cleanup. Signal reads that should re-run the effect belong in
	 * `compute`; writes and other side effects belong in `handler`. Effects
	 * track what the user actually sees, never pending transition state.
	 *
	 * The split is the shape every implementation can express: autorun-style
	 * effects compose it by running the handler inside their tracked body,
	 * while a split-effect implementation (fx2) cannot express the reverse —
	 * a single body that both tracks and writes.
	 */
	useSignalEffect<T>(
		compute: () => T,
		handler: (value: T, previous: T | undefined) => void | (() => void),
		deps?: readonly unknown[],
	): void

	/**
	 * React's startTransition with the implementation's write batching:
	 * signal writes inside `scope` classify into the transition's batch, so
	 * the resulting renders are non-urgent and urgent updates keep landing
	 * in between.
	 */
	startSignalTransition(scope: () => void): void

	/** How to hold a transition open on in-flight async data; see TransitionHoldStyle. */
	readonly transitionHoldStyle: TransitionHoldStyle
}
