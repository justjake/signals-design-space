/**
 * `cosignals-alt-b` behind the common shim interface.
 *
 * Signal classes live on the package root; hooks and registration live on
 * the './react' entrypoint, both over the same module-singleton engine. The
 * useSignal cast is sound by construction: createAtom/createComputed below
 * are the only producers of the app's signal handles, so every handle
 * really is an engine class instance (carrying the `.id` the hooks
 * dispatch on).
 */
import {
	Atom,
	Computed,
	startSignalTransition as engineStartSignalTransition,
	type SignalLike,
} from 'cosignals-alt-b'
import {
	registerAltBReact,
	useComputed as bridgeUseComputed,
	useSignal as bridgeUseSignal,
	useSignalEffect as bridgeUseSignalEffect,
} from 'cosignals-alt-b/react'
import type { ReadableSignal, TransitionHoldStyle, WritableSignal } from './interface'
import { useSplitEffectFromAutorun } from './split-effect'

export { createRoot } from 'react-dom/client'

export const name = 'cosignals-alt-b'

// The hold itself works: a thrown promise keeps the transition pending and
// urgent updates commit. Known engine issue (kept visible on purpose, not
// routed around): while a transition is held this way, an urgent write that
// CHANGES a derived value's output — e.g. the playground's table filter —
// locks the page in an infinite update loop. Writes whose deriveds come out
// equal (equality cutoff) are unaffected.
export const transitionHoldStyle: TransitionHoldStyle = 'suspense'

export function register(): void {
	registerAltBReact()
}

export function createAtom<T>(initial: T, label?: string): WritableSignal<T> {
	return new Atom<T>({ state: initial, label })
}

export function createComputed<T>(fn: () => T, label?: string): ReadableSignal<T> {
	return new Computed<T>({ fn, label })
}

export function useSignal<T>(signal: ReadableSignal<T>): T {
	return bridgeUseSignal(signal as unknown as SignalLike & { state: T })
}

export function useComputed<T>(fn: () => T, deps: readonly unknown[]): T {
	return bridgeUseComputed(fn, deps)
}

export function useSignalEffect<T>(
	compute: () => T,
	handler: (value: T, previous: T | undefined) => void | (() => void),
	deps?: readonly unknown[],
): void {
	useSplitEffectFromAutorun(bridgeUseSignalEffect, compute, handler, deps)
}

export function startSignalTransition(scope: () => void): void {
	// The engine helper returns the transition's batch token for test
	// harnesses; the common surface has no use for it.
	engineStartSignalTransition(scope)
}
