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
 * Deriveds are real Solid memos. (They ran degraded as unmemoized tracked
 * reads while the engine had a dirty-heap lockup on urgent writes with
 * memo-subscribed components; that engine bug is fixed and the degradation
 * is gone.)
 */
import * as React from 'react'
import {
	createMemo,
	createRoot,
	createSignal,
	createTrackedEffect,
	registerConcurrentSolidReact,
	useComputed as packageUseComputed,
	useSelector,
	type Accessor,
	type Setter,
} from 'concurrent-solid-react'
import type { ReadableSignal, TransitionHoldStyle, WritableSignal } from './interface'

export { createRoot } from 'react-dom/client'

export const name = 'concurrent-solid-react'

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
export const transitionHoldStyle: TransitionHoldStyle = 'defer-write'

export function register(): void {
	// The handle is intentionally dropped: registration lives for the page,
	// and dispose() only matters for tests that re-register.
	registerConcurrentSolidReact()
}

/** Adapter from Solid's [get, set] accessor pair to the interface's object surface. */
class SolidAtom<T> implements WritableSignal<T> {
	constructor(
		private readonly read: Accessor<T>,
		private readonly write: Setter<T>,
	) {}
	get state(): T {
		return this.read()
	}
	set(next: T): void {
		// Always hand the setter an updater: Solid setters treat a bare
		// function argument as an updater, so a function-typed T would
		// otherwise be called instead of stored.
		this.write(() => next)
	}
	update(fn: (current: T) => T): void {
		this.write(fn)
	}
}

export function createAtom<T>(initial: T, label?: string): WritableSignal<T> {
	const [read, write] = createSignal<T>(initial as Exclude<T, Function>, { name: label })
	return new SolidAtom<T>(read, write)
}

export function createComputed<T>(fn: () => T, label?: string): ReadableSignal<T> {
	// A real Solid memo, hosted in a page-lifetime root so it is owned (an
	// unowned memo in this engine is lazy+autodispose: it tears down whenever
	// its last subscriber leaves and refetches on revival, which is wasteful
	// churn for module-scope deriveds that live as long as the page).
	const accessor = createRoot(() => createMemo(fn, label ? { name: label } : undefined))
	return {
		get state(): T {
			return accessor()
		},
	}
}

export function useSignal<T>(signal: ReadableSignal<T>): T {
	// useSelector resolves the read in the current render pass's world
	// (committed for urgent passes, staged for transition passes) and
	// subscribes the component through the bridge's two-phase reader.
	return useSelector(() => signal.state)
}

export function useComputed<T>(fn: () => T, deps: readonly unknown[]): T {
	// The package's component-owned memo: signal reads inside `fn` are
	// tracked reactively (not part of `deps`); `deps` recreates the node
	// like useMemo.
	return packageUseComputed<T>(fn, [...deps])
}

export function useSignalEffect<T>(
	compute: () => T,
	handler: (value: T, previous: T | undefined) => void | (() => void),
	deps?: readonly unknown[],
): void {
	const fnRef = React.useRef({ compute, handler })
	fnRef.current = { compute, handler }
	const previous = React.useRef<T | undefined>(undefined)
	// Same construction as the package's own useSignalEffect — a tracked
	// effect (committed-world reads only; runs held while a transition is
	// live, released at its commit) inside a disposable root — but keyed on
	// `deps` so changed React values re-establish tracking, matching the
	// interface's useEffect-like deps contract (undefined = every render).
	// The interface's split shape composes on it: the handler runs inside
	// the tracked body, so reads track exactly as the fused form did.
	React.useEffect(
		() =>
			createRoot((disposeRoot: () => void) => {
				createTrackedEffect(() => {
					const value = fnRef.current.compute()
					const cleanup = fnRef.current.handler(value, previous.current)
					previous.current = value
					return cleanup
				})
				return disposeRoot
			}),
		deps === undefined ? undefined : [...deps],
	)
}

export function startSignalTransition(scope: () => void): void {
	// Write-time classification: every engine write asks React for the
	// current batch, so the plain React transition scope already routes the
	// writes inside `scope` into a deferred Solid transition.
	React.startTransition(scope)
}
