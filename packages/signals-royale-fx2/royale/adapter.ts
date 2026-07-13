/** This package's adapter for the shared cross-entrant test battery. */
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import {
	attachTracer,
	batch,
	committed,
	createComputed,
	effect,
	initializeAtomState,
	isPending,
	latest,
	nodeOf,
	read,
	serializeAtomState,
	set,
	createAtom,
	untracked,
	update,
	type Atom,
	type AtomOptions,
	type Signal,
	type UseFn,
} from 'signals-royale-fx2'
import {
	registerReactSignals,
	resetReactSignalsForTest,
	startSignalTransition,
	useCommitted,
	useComputed,
	useIsPending,
	useSignalEffect,
	useValue,
	wrapCreateRoot,
} from '../src/react/index.ts'

export interface RoyaleHandle {
	dispose(): void
}

export interface RoyaleTraceView {
	whyLastDelivery(x: unknown): string[]
	events(): Array<{ id: number; kind: string; cause?: number; error?: unknown }>
	dropped(): number
	stop(): void
}

const adapter = {
	slug: 'fx2',
	React,
	ReactDOMClient: { createRoot: wrapCreateRoot(createRoot as never) },
	act: act,
	flushSync: (fn: () => void) => flushSync(fn),

	register(): RoyaleHandle {
		return registerReactSignals()
	},
	resetForTest(): void {
		resetReactSignalsForTest()
	},

	atom<T>(
		initial: T | (() => T),
		opts?: {
			equals?(a: T, b: T): boolean
			onObserved?(ctx: { get(): T; set(v: T): void }): void | (() => void)
			label?: string
		},
	): unknown {
		return createAtom(initial, opts as AtomOptions<T>)
	},
	set(a: unknown, v: unknown): void {
		set(a as Atom<unknown>, v)
	},
	update(a: unknown, fn: (prev: unknown) => unknown): void {
		update(a as Atom<unknown>, fn)
	},
	computed<T>(
		fn: (use: <U>(t: PromiseLike<U>) => U) => T,
		opts?: { equals?(a: T, b: T): boolean; label?: string },
	): unknown {
		return createComputed(fn, opts)
	},
	read(x: unknown): unknown {
		return read(x as Signal<unknown>)
	},
	latest(x: unknown): unknown {
		return latest(x as Signal<unknown>)
	},
	committed(x: unknown, container?: unknown): unknown {
		return committed(x as Signal<unknown>, container as object | undefined)
	},
	isPending(x: unknown): boolean {
		return isPending(x as Signal<unknown>)
	},
	effect(fn: () => void | (() => void)): () => void {
		return effect(fn)
	},
	batch(fn: () => void): void {
		batch(fn)
	},
	untracked<T>(fn: () => T): T {
		return untracked(fn)
	},
	serialize(atoms: unknown[]): string {
		return serializeAtomState(atoms as Atom<unknown>[])
	},
	initialize(json: string, atoms: unknown[]): void {
		initializeAtomState(json, atoms as Atom<unknown>[])
	},

	useValue(x: unknown): unknown {
		return useValue(x as Signal<unknown>)
	},
	useComputed<T>(fn: () => T, deps: unknown[]): T {
		return useComputed(fn, deps)
	},
	useSignalEffect(fn: () => void | (() => void)): void {
		useSignalEffect(fn)
	},
	useIsPending(x: unknown): boolean {
		return useIsPending(x as Signal<unknown>)
	},
	useCommitted(x: unknown): unknown {
		return useCommitted(x as Signal<unknown>)
	},
	startTransitionWrite(scope: () => void): void {
		startSignalTransition(scope)
	},

	trace(): RoyaleTraceView {
		const t = attachTracer()
		return {
			whyLastDelivery(x: unknown): string[] {
				return t.whyLastDelivery(nodeOf(x as Signal<unknown>))
			},
			events(): Array<{ id: number; kind: string; cause?: number; error?: unknown }> {
				const events: Array<{ id: number; kind: string; cause?: number; error?: unknown }> = []
				for (const event of t.events()) {
					events.push({
						id: event.id,
						kind: event.kind,
						cause: event.cause === 0 ? undefined : event.cause,
						error: event.error,
					})
				}
				return events
			},
			dropped(): number {
				return t.dropped
			},
			stop(): void {
				t.stop()
			},
		}
	},
	// onDomMutation is intentionally absent: bracketing React's DOM
	// mutation phase needs reconciler cooperation, and this package runs
	// on stock React by design.
}

export default adapter
