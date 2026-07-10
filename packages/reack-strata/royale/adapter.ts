import * as React from 'react'
import { act } from 'react'
import { flushSync } from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import {
	Atom,
	Computed,
	batch,
	defaultRuntime,
	effect,
	initializeAtomState,
	isPending,
	latest,
	refresh,
	serializeAtomState,
	untracked,
	type Signal,
} from 'strata-signals'
import { trace, type CausalityLog } from '../../strata/src/trace.js'
import {
	committed,
	errors,
	onDomMutation,
	resetForTest,
	startSignalTransition,
	useCommitted,
	useComputed,
	useIsPending,
	useSignal,
	useSignalEffect,
} from '../src/index.js'
import type {
	RoyaleAdapter,
	RoyaleHandle,
	RoyaleTraceView,
} from '../../../royale/verify/battery/royale-types.js'

let activeTrace: CausalityLog | undefined
const handle: RoyaleHandle = {
	errors,
	dispose() {},
}

const adapter: RoyaleAdapter = {
	slug: 'strata',
	React,
	ReactDOMClient,
	act: act as RoyaleAdapter['act'],
	flushSync,

	register(): RoyaleHandle {
		return handle
	},

	resetForTest(): void {
		activeTrace?.stop()
		activeTrace = undefined
		resetForTest()
	},

	atom<T>(
		initial: T | (() => T),
		options?: {
			equals?(a: T, b: T): boolean
			onObserved?(context: { get(): T; set(value: T): void }): void | (() => void)
			label?: string
		},
	): unknown {
		return new Atom(initial, {
			equals: options?.equals,
			effect: options?.onObserved,
			label: options?.label,
		})
	},

	set(value: unknown, next: unknown): void {
		;(value as Atom<unknown>).set(next)
	},

	update(value: unknown, fn: (previous: unknown) => unknown): void {
		;(value as Atom<unknown>).update(fn)
	},

	computed<T>(
		fn: (use: <U>(thenable: PromiseLike<U>) => U) => T,
		options?: { equals?(a: T, b: T): boolean; label?: string },
	): unknown {
		return new Computed((context) => fn(context.use), options)
	},

	read(value: unknown): unknown {
		return (value as Signal).state
	},

	latest(value: unknown): unknown {
		return latest(value as Signal)
	},

	committed(value: unknown, container?: unknown): unknown {
		return committed(value as Signal, container as object | undefined)
	},

	isPending(value: unknown): boolean {
		return isPending(value as Signal)
	},

	refresh(value: unknown): void {
		refresh(value as Signal)
	},

	effect,
	batch,
	untracked,

	serialize(values: unknown[]): string {
		const atoms: Record<string, Atom<any>> = {}
		for (let i = 0; i < values.length; i++) {
			atoms[String(i)] = values[i] as Atom<any>
		}
		return serializeAtomState(atoms)
	},

	initialize(json: string, values: unknown[]): void {
		const atoms: Record<string, Atom<any>> = {}
		for (let i = 0; i < values.length; i++) {
			atoms[String(i)] = values[i] as Atom<any>
		}
		initializeAtomState(json, atoms)
	},

	useValue(value: unknown): unknown {
		return useSignal(value as Signal)
	},

	useComputed<T>(fn: () => T, deps: unknown[]): T {
		return useComputed(fn, deps)
	},

	useSignalEffect(fn: () => void | (() => void)): void {
		useSignalEffect(fn, [])
	},

	useIsPending(value: unknown): boolean {
		return useIsPending(value as Signal)
	},

	useCommitted(value: unknown): unknown {
		return useCommitted(value as Signal)
	},

	startTransitionWrite(scope: () => void): void {
		startSignalTransition(scope)
	},

	trace(): RoyaleTraceView {
		activeTrace?.stop()
		const log = trace(defaultRuntime, 1 << 16)
		activeTrace = log
		return {
			whyLastDelivery(value: unknown): string[] {
				const chain = log.why(value as object)
				const result: string[] = []
				for (let i = 0; i < chain.length; i++) {
					const event = chain[i]!
					result.push(
						`#${event.id} ${event.kind}${
							event.target === undefined ? '' : ` ${event.target}`
						} cause=${event.cause === 0 ? 'root' : `#${event.cause}`}`,
					)
				}
				return result
			},
			events() {
				const events = log.events()
				const result: Array<{ id: number; kind: string; cause?: number }> = []
				for (let i = 0; i < events.length; i++) {
					const event = events[i]!
					result.push({
						id: event.id,
						kind: event.kind,
						cause: event.cause === 0 ? undefined : event.cause,
					})
				}
				return result
			},
			stop(): void {
				log.stop()
				if (activeTrace === log) {
					activeTrace = undefined
				}
			},
		}
	},

	onDomMutation,
}

export default adapter
