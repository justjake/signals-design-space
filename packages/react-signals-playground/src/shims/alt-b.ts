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
} from 'cosignals-alt-b';
import {
	registerAltBReact,
	useComputed as bridgeUseComputed,
	useSignal as bridgeUseSignal,
	useSignalEffect as bridgeUseSignalEffect,
} from 'cosignals-alt-b/react';
import type { ReadableSignal, WritableSignal } from './interface';

export const name = 'cosignals-alt-b';

export function register(): void {
	registerAltBReact();
}

export function createAtom<T>(initial: T, label?: string): WritableSignal<T> {
	return new Atom<T>({ state: initial, label });
}

export function createComputed<T>(fn: () => T, label?: string): ReadableSignal<T> {
	return new Computed<T>({ fn, label });
}

export function useSignal<T>(signal: ReadableSignal<T>): T {
	return bridgeUseSignal(signal as unknown as SignalLike & { state: T });
}

export function useComputed<T>(fn: () => T, deps: readonly unknown[]): T {
	return bridgeUseComputed(fn, deps);
}

export function useSignalEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
	bridgeUseSignalEffect(fn, deps);
}

export function startSignalTransition(scope: () => void): void {
	// The engine helper returns the transition's batch token for test
	// harnesses; the common surface has no use for it.
	engineStartSignalTransition(scope);
}
