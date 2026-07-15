/** `signals-royale-fx2` behind the common shim interface. */
import { useRef } from 'react'
import { createRoot as createReactRoot } from 'react-dom/client'
import {
	createAtom as createRoyaleAtom,
	createComputed as createRoyaleComputed,
	type Atom,
	type Computed,
} from 'signals-royale-fx2'
import {
	registerReactSignals,
	startSignalTransition,
	useComputed,
	useSignalEffect as useRoyaleSignalEffect,
	useValue,
	wrapCreateRoot,
} from 'signals-royale-fx2/react'
import type { ReadableSignal, TransitionHoldStyle, WritableSignal } from './interface'

export const name = 'signals-royale-fx2'
export const transitionHoldStyle: TransitionHoldStyle = 'suspense'
export const createRoot = wrapCreateRoot(createReactRoot as never)

export function register(): void {
	registerReactSignals()
}

class RoyaleAtom<T> implements WritableSignal<T> {
	constructor(readonly signal: Atom<T>) {}
	get state(): T {
		return this.signal.get()
	}
	set(next: T): void {
		this.signal.set(next)
	}
	update(fn: (current: T) => T): void {
		this.signal.update(fn)
	}
}

class RoyaleComputed<T> implements ReadableSignal<T> {
	constructor(readonly signal: Computed<T>) {}
	get state(): T {
		return this.signal.get()
	}
}

export function createAtom<T>(initial: T, label?: string): WritableSignal<T> {
	return new RoyaleAtom(createRoyaleAtom(initial, { label }))
}

export function createComputed<T>(fn: () => T, label?: string): ReadableSignal<T> {
	return new RoyaleComputed(createRoyaleComputed(fn, { label }))
}

export function useSignal<T>(signal: ReadableSignal<T>): T {
	return useValue((signal as RoyaleAtom<T> | RoyaleComputed<T>).signal)
}

/**
 * The interface's split (compute, handler, deps) shape desugars to fx2's
 * factory form: one spec object per deps window.
 */
export function useSignalEffect<T>(
	compute: () => T,
	handler: (value: T, previous: T | undefined) => void | (() => void),
	deps?: readonly unknown[],
): void {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useRoyaleSignalEffect(() => ({ watch: compute, run: handler }), deps ?? [])
}

export { startSignalTransition, useComputed }
