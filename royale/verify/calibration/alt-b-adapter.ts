/**
 * RoyaleAdapter over the incumbent cosignals-alt-b, for calibrating the
 * shared battery. Honest mappings only: where alt-b lacks an adapter member
 * outright, the closest engine-level equivalent is used and the gap is
 * documented at the member. This file is orchestrator tooling — entrants
 * never see it.
 */
import * as React from 'react'
import { act } from 'react'
import * as ReactDOMClient from 'react-dom/client'
import { flushSync } from 'react-dom'
import {
	Atom,
	Computed,
	__resetEngineForTests,
	batch,
	committed as committedRead,
	effect,
	installState,
	isPending as isPendingRead,
	latest as latestRead,
	refresh as refreshNode,
	startSignalTransition,
	untracked,
	__debug,
	type SignalLike,
} from 'cosignals-alt-b'
import {
	registerAltBReact,
	serializeAtomState,
	initializeAtomState,
	useSignal,
	useComputed as useComputedAltB,
	useCommitted as useCommittedAltB,
	useIsPending as useIsPendingAltB,
	useSignalEffect as useSignalEffectAltB,
	type AltBReactHandle,
} from 'cosignals-alt-b/react'
import { PackedTracer, startTracing, stopTracing } from 'cosignals-alt-b/trace'
import type { RoyaleAdapter, RoyaleHandle, RoyaleTraceView } from '../battery/royale-types'

type ReactWithReset = typeof React & { unstable_resetBatchRegistryForTest?: () => void }

type Sig = SignalLike & { state: unknown }

let registration: { alt: AltBReactHandle; handle: RoyaleHandle } | undefined

function scrub(): void {
	;(React as ReactWithReset).unstable_resetBatchRegistryForTest?.()
	__resetEngineForTests()
}

function ensureRegistered(): { alt: AltBReactHandle; handle: RoyaleHandle } {
	if (registration === undefined) {
		scrub()
		const alt = registerAltBReact()
		const errors: unknown[] = []
		const handle: RoyaleHandle = {
			errors,
			dispose() {
				if (registration?.alt === alt) {
					alt.dispose()
					registration = undefined
				}
			},
		}
		registration = { alt, handle }
	}
	return registration
}

/** Push adapter-plumbing failures into the active handle's error channel. */
function reportError(err: unknown): void {
	registration?.handle.errors.push(err)
}

// ---- causality trace ---------------------------------------------------------------
//
// Mapping gaps (alt-b's tracer is engine-scoped, not bindings-scoped):
// - no root-commit / effect-run / component-render event kinds exist; the
//   closest delivery record is 'broadcast' (a watcher notification — the
//   setState behind a component re-render). whyLastDelivery walks from the
//   latest broadcast for the node.
// - suspense settlement appears as the settlement write's log events, not a
//   dedicated kind.
// - DIRECT-mode (fully quiescent urgent) writes bypass the traced overlay by
//   design; scenarios exercising the trace do so with a live batch, where
//   every write is LOGGED and traced.
function makeTraceView(): RoyaleTraceView {
	const tracer: PackedTracer = startTracing({ mode: 'ring', capacity: 1 << 16 })
	const fmt = (e: { id: number; kindName: string; node: number; world: number; cause: number }) =>
		`#${e.id} ${e.kindName} node=${e.node} world=${e.world} cause=${e.cause === 0 ? 'root' : `#${e.cause}`}`
	return {
		whyLastDelivery(x: unknown): string[] {
			const id = (x as Sig).id
			// broadcast records carry the watched node id in args[1]; args[0]
			// is 0 when the watcher actually fired (a delivery) and 1 when the
			// per-world cutoff suppressed it — only deliveries answer "why did
			// this component re-render".
			const all = tracer.events()
			for (let i = all.length - 1; i >= 0; i--) {
				const e = all[i]
				if (e.kindName === 'broadcast' && e.args[1] === id && e.args[0] === 0) {
					return tracer.causeChain(e.id).map(fmt)
				}
			}
			return []
		},
		events() {
			return tracer
				.events()
				.map((e) => ({ id: e.id, kind: e.kindName, cause: e.cause === 0 ? undefined : e.cause }))
		},
		stop() {
			stopTracing()
		},
	}
}

// ---- the adapter -------------------------------------------------------------------

const adapter: RoyaleAdapter = {
	slug: 'alt-b-calibration',
	React,
	ReactDOMClient: ReactDOMClient as RoyaleAdapter['ReactDOMClient'],
	act: act as RoyaleAdapter['act'],
	flushSync,

	register(): RoyaleHandle {
		return ensureRegistered().handle
	},

	resetForTest(): void {
		stopTracing()
		if (registration !== undefined) {
			registration.alt.dispose()
			registration = undefined
		}
		scrub()
	},

	atom<T>(
		initial: T | (() => T),
		opts?: {
			equals?(a: T, b: T): boolean
			onObserved?(ctx: { get(): T; set(v: T): void }): void | (() => void)
			label?: string
		},
	): unknown {
		return new Atom<T>({
			state: initial,
			isEqual: opts?.equals,
			label: opts?.label,
			effect:
				opts?.onObserved === undefined
					? undefined
					: (ctx) => opts.onObserved!({ get: () => ctx.peek(), set: (v) => ctx.set(v) }),
		})
	},

	set(a: unknown, v: unknown): void {
		;(a as Atom<unknown>).set(v)
	},

	update(a: unknown, fn: (prev: unknown) => unknown): void {
		;(a as Atom<unknown>).update(fn)
	},

	computed<T>(
		fn: (use: <U>(t: PromiseLike<U>) => U) => T,
		opts?: { equals?(a: T, b: T): boolean; label?: string },
	): unknown {
		return new Computed<T>({
			fn: (ctx) => fn(ctx.use),
			isEqual: opts?.equals,
			label: opts?.label,
		})
	},

	read(x: unknown): unknown {
		return (x as Sig).state
	},

	latest(x: unknown): unknown {
		return latestRead(x as Sig)
	},

	committed(x: unknown, container?: unknown): unknown {
		if (container === undefined) {
			return committedRead(x as Sig)
		}
		// Per-root committed view: the bindings key views by the protocol's
		// container object, which is the DOM element handed to createRoot.
		const { alt } = ensureRegistered()
		return alt.bindings.readRootCommitted(container, () => committedRead(x as Sig))
	},

	isPending(x: unknown): boolean {
		// GAP (documented): alt-b's isPending is async-shaped — true only while
		// a suspended box holds stale data. A plain transition-written atom is
		// never "pending" here; RULES scenario 2 expects it to be. The honest
		// mapping keeps alt-b's semantics; the divergence stays visible in
		// calibration.
		return isPendingRead(x as SignalLike)
	},

	refresh(x: unknown): void {
		refreshNode(x as SignalLike)
	},

	effect,
	batch(fn: () => void): void {
		batch(fn)
	},
	untracked,

	serialize(atoms: unknown[]): string {
		const record: Record<string, Atom<unknown>> = {}
		atoms.forEach((a, i) => {
			record[String(i)] = a as Atom<unknown>
		})
		return serializeAtomState(record)
	},

	initialize(json: string, atoms: unknown[]): void {
		const record: Record<string, Atom<unknown>> = {}
		atoms.forEach((a, i) => {
			record[String(i)] = a as Atom<unknown>
		})
		initializeAtomState(json, record)
	},

	useValue(x: unknown): unknown {
		return useSignal(x as Sig)
	},

	useComputed<T>(fn: () => T, deps: unknown[]): T {
		return useComputedAltB(fn, deps)
	},

	useSignalEffect(fn: () => void | (() => void)): void {
		useSignalEffectAltB(fn, [])
	},

	useIsPending(x: unknown): boolean {
		return useIsPendingAltB(x as SignalLike)
	},

	useCommitted(x: unknown): unknown {
		return useCommittedAltB(x as Sig)
	},

	startTransitionWrite(scope: () => void): void {
		startSignalTransition(scope)
	},

	trace(): RoyaleTraceView {
		return makeTraceView()
	},

	onDomMutation(cb: (phase: 'start' | 'stop', container: Element) => void): () => void {
		const { alt } = ensureRegistered()
		// The fork re-emits React's before/after-mutation edges per root
		// commit; container is root.containerInfo (the createRoot element).
		return alt.fork.subscribeToExternalRuntime({
			onBeforeMutation(container) {
				try {
					cb('start', container as Element)
				} catch (err) {
					reportError(err)
				}
			},
			onAfterMutation(container) {
				try {
					cb('stop', container as Element)
				} catch (err) {
					reportError(err)
				}
			},
		})
	},
}

// Keep __debug reachable for ad-hoc calibration digging (not used by the battery).
void __debug

export default adapter
