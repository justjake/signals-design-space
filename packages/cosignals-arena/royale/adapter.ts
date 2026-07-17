/** This package's adapter for the shared cross-entrant test battery. */
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import {
	attachTracer,
	batch,
	createComputed,
	effect,
	isPending,
	latest,
	nodeOf,
	read,
	set,
	createAtom,
	untracked,
	update,
	type Atom,
	type AtomOptions,
	type Signal,
} from 'cosignals-arena'
import { initializeAtomState, serializeAtomState } from 'cosignals-arena/ssr'
import {
	registerReactSignals,
	resetReactSignalsForTest,
	startSignalTransition,
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

const NEVER_EQUAL = (): boolean => false

const adapter = {
	slug: 'cosignals-arena',
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
	// committed()/useCommitted are intentionally absent: the committed view
	// is implicit (base state; screens converge at retirement), matching how
	// Solid and React expose no committed-view query either. Battery cases
	// that require the capability skip against this adapter.
	isPending(x: unknown): boolean {
		return isPending(x as Signal<unknown>)
	},
	effect(fn: () => void | (() => void)): () => void {
		// The battery's effect is a single tracked body with an optional
		// cleanup. Run the body as the compute (battery bodies read but never
		// write signals); its fresh return value is the cleanup the handler
		// installs. Never-equal delivery keeps one handler run per re-run.
		return effect(() => fn(), (cleanup) => cleanup, { equals: NEVER_EQUAL })
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
		// Same autorun shape as effect() above, latest-ref'd so re-renders
		// refresh the body without re-creating the effect.
		const latest = React.useRef(fn)
		latest.current = fn
		useSignalEffect(
			() => ({
				watch: () => latest.current(),
				run: (cleanup) => cleanup,
				equals: NEVER_EQUAL,
			}),
			[],
		)
	},
	useIsPending(x: unknown): boolean {
		return useIsPending(x as Signal<unknown>)
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
