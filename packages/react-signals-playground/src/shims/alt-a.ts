/**
 * `cosignals-alt-a` behind the common shim interface.
 *
 * This implementation's API is a bundle created per engine; the browser
 * shape is the package's module-singleton `defaultApi`, and registration
 * couples that bundle's engine to React. The useSignal cast is sound by
 * construction: createAtom/createComputed below are the only producers of
 * the app's signal handles, so every handle really is an api class instance
 * (carrying the `.handle` the bridge dispatches on).
 */
import { defaultApi } from 'cosignals-alt-a'
import {
	registerAltAReact,
	startSignalTransition,
	useComputed as bridgeUseComputed,
	useSignal as bridgeUseSignal,
	useSignalEffect as bridgeUseSignalEffect,
	type SignalSource,
} from 'cosignals-alt-a/react'
import type { ReadableSignal, TransitionHoldStyle, WritableSignal } from './interface'

export { createRoot } from 'react-dom/client'

export const name = 'cosignals-alt-a'

// Verified in the playground's Playwright suite: a promise thrown from a
// component inside a transition render keeps the transition pending while
// urgent updates keep committing, exactly like stock React semantics.
export const transitionHoldStyle: TransitionHoldStyle = 'suspense'

export function register(): void {
	registerAltAReact(defaultApi)
}

export function createAtom<T>(initial: T, label?: string): WritableSignal<T> {
	return new defaultApi.Atom<T>({ state: initial, label })
}

export function createComputed<T>(fn: () => T, label?: string): ReadableSignal<T> {
	return new defaultApi.Computed<T>({ fn, label })
}

export function useSignal<T>(signal: ReadableSignal<T>): T {
	return bridgeUseSignal(signal as unknown as SignalSource<T>)
}

export function useComputed<T>(fn: () => T, deps: readonly unknown[]): T {
	return bridgeUseComputed(fn, deps)
}

export function useSignalEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
	bridgeUseSignalEffect(fn, deps)
}

// Direct re-export: the bridge's scope type (() => unknown, for async
// actions) is wider than the interface's () => void, so it conforms as is.
export { startSignalTransition }
