/** `cosignals-arena` — the arena fork — behind the common shim interface. */
import { useRef } from 'react'
import { createRoot as createReactRoot } from 'react-dom/client'
import {
	createAtom as createCosignalsAtom,
	createComputed as createCosignalsComputed,
	type Atom,
	type Computed,
} from 'cosignals-arena'
import {
	registerReactSignals,
	startSignalTransition,
	useComputed,
	useSignalEffect as useCosignalsSignalEffect,
	useValue,
	wrapCreateRoot,
} from 'cosignals-arena/react'
import type { ReadableSignal, TransitionHoldStyle, WritableSignal } from './interface'

export const name = 'cosignals-arena'
export const transitionHoldStyle: TransitionHoldStyle = 'suspense'
export const createRoot = wrapCreateRoot(createReactRoot as never)

export function register(): void {
	registerReactSignals()
}

class CosignalsAtom<T> implements WritableSignal<T> {
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

class CosignalsComputed<T> implements ReadableSignal<T> {
	constructor(readonly signal: Computed<T>) {}
	get state(): T {
		return this.signal.get()
	}
}

export function createAtom<T>(initial: T, label?: string): WritableSignal<T> {
	return new CosignalsAtom(createCosignalsAtom(initial, { label }))
}

export function createComputed<T>(fn: () => T, label?: string): ReadableSignal<T> {
	return new CosignalsComputed(createCosignalsComputed(fn, { label }))
}

export function useSignal<T>(signal: ReadableSignal<T>): T {
	return useValue((signal as CosignalsAtom<T> | CosignalsComputed<T>).signal)
}

/**
 * A suspending computed: while parked its node carries cosignals's AsyncSuspended
 * flag, which the devtools reports as a "suspended" node. `toggle` parks it on
 * a fresh pending promise (bumping `epoch` re-runs the body so it re-parks) and,
 * called again, resolves that promise so the body reruns to 'loaded'.
 */
export function createSuspending(): {
	pending: ReadableSignal<boolean>
	value: ReadableSignal<string>
	toggle(): void
} {
	const epoch = createCosignalsAtom(0, { label: 'asyncEpoch' })
	const pending = createCosignalsAtom(false, { label: 'asyncPending' })
	let deferred: { promise: Promise<void>; resolve: () => void } | undefined
	const value = createCosignalsComputed<string>(
		(use) => {
			epoch.get()
			if (deferred === undefined) return 'idle'
			use(deferred.promise)
			return 'loaded'
		},
		{ label: 'asyncData' },
	)
	return {
		pending: new CosignalsAtom(pending),
		value: new CosignalsComputed(value),
		toggle(): void {
			if (pending.get()) {
				deferred?.resolve()
				pending.set(false)
				return
			}
			let resolve!: () => void
			deferred = { promise: new Promise<void>((r) => (resolve = r)), resolve }
			pending.set(true)
			epoch.update((e) => e + 1)
		},
	}
}

/**
 * The interface's split (compute, handler, deps) shape desugars to cosignals's
 * factory form: one spec object per deps window.
 */
export function useSignalEffect<T>(
	compute: () => T,
	handler: (value: T, previous: T | undefined) => void | (() => void),
	deps?: readonly unknown[],
): void {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useCosignalsSignalEffect(() => ({ watch: compute, run: handler }), deps ?? [])
}

export { startSignalTransition, useComputed }
