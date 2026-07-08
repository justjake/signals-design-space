/**
 * `cosignals` (+ `cosignals-react`) behind the common shim interface.
 *
 * The exported useSignal accepts the interface's structural signal types
 * while the bridge's own hook dispatches on the concrete kernel classes.
 * The casts are sound by construction: createAtom/createComputed below are
 * the only producers of the app's signal handles, so every handle really is
 * an Atom/Computed instance.
 */
import { Atom, Computed } from 'cosignals';
import {
	registerCosignalReact,
	startSignalTransition,
	useComputed as bridgeUseComputed,
	useSignal as bridgeUseSignal,
	useSignalEffect as bridgeUseSignalEffect,
	type SignalSource,
} from 'cosignals-react';
import type { ReadableSignal, TransitionHoldStyle, WritableSignal } from './interface';

export const name = 'cosignals';

// Verified in the playground's Playwright suite: a promise thrown from a
// component inside a transition render keeps the transition pending while
// urgent updates keep committing, exactly like stock React semantics.
export const transitionHoldStyle: TransitionHoldStyle = 'suspense';

export function register(): void {
	// The handle is intentionally dropped: registration lives for the page,
	// and dispose() only matters for tests that re-register.
	registerCosignalReact();
}

export function createAtom<T>(initial: T, label?: string): WritableSignal<T> {
	return new Atom(initial, { label });
}

export function createComputed<T>(fn: () => T, label?: string): ReadableSignal<T> {
	return new Computed(fn, { label });
}

export function useSignal<T>(signal: ReadableSignal<T>): T {
	return bridgeUseSignal(signal as unknown as SignalSource<T>);
}

export function useComputed<T>(fn: () => T, deps: readonly unknown[]): T {
	// This bridge splits the concerns: useComputed memoizes a Computed handle
	// on deps, and subscription goes through useSignal like any other signal.
	return bridgeUseSignal(bridgeUseComputed(fn, deps));
}

export function useSignalEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
	bridgeUseSignalEffect(fn, deps);
}

// Direct re-export: the bridge's scope type (() => unknown, for async
// actions) is wider than the interface's () => void, so it conforms as is.
export { startSignalTransition };
