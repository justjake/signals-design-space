/**
 * RoyaleAdapter: the tournament's cross-entrant verification surface,
 * mapped onto signals-royale-fh2 + react-signals-royale-fh2.
 */
import * as React from 'react';
import { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
	atom,
	batch,
	committed,
	computed,
	effect,
	initializeAtomState,
	isPending,
	latest,
	read,
	refresh,
	serializeAtomState,
	set,
	untracked,
	update,
	type Atom,
	type AtomOptions,
	type Computed,
	type Readable,
	type Use,
} from 'signals-royale-fh2';
import {
	onDomMutation,
	registerReactSignals,
	resetReactSignalsForTest,
	startTransitionWrite,
	traceView,
	useCommitted,
	useComputed,
	useIsPending,
	useSignalEffect,
	useValue,
	type ReactSignalsHandle,
} from '../src/index';

export interface RoyaleHandle {
	errors: unknown[];
	dispose(): void;
}

export interface RoyaleTraceView {
	whyLastDelivery(x: unknown): string[];
	events(): Array<{ id: number; kind: string; cause?: number }>;
	stop(): void;
}

const adapter = {
	slug: 'fh2',
	React,
	ReactDOMClient,
	act: act as <T>(fn: () => T | Promise<T>) => Promise<undefined>,
	flushSync,

	register(): RoyaleHandle {
		const handle: ReactSignalsHandle = registerReactSignals();
		return handle;
	},
	resetForTest(): void {
		resetReactSignalsForTest();
	},

	atom<T>(
		initial: T | (() => T),
		opts?: {
			equals?(a: T, b: T): boolean;
			onObserved?(ctx: { get(): T; set(v: T): void }): void | (() => void);
			label?: string;
		},
	): unknown {
		const options: AtomOptions<T> = {
			equals: opts?.equals,
			label: opts?.label,
			effect: opts?.onObserved,
		};
		return atom(initial, options);
	},
	set(a: unknown, v: unknown): void {
		set(a as Atom<unknown>, v);
	},
	update(a: unknown, fn: (prev: unknown) => unknown): void {
		update(a as Atom<unknown>, fn);
	},
	computed<T>(
		fn: (use: <U>(t: PromiseLike<U>) => U) => T,
		opts?: { equals?(a: T, b: T): boolean; label?: string },
	): unknown {
		return computed<T>((use: Use) => fn(use), opts);
	},
	read(x: unknown): unknown {
		return read(x as Readable<unknown>);
	},
	latest(x: unknown): unknown {
		return latest(x as Readable<unknown>);
	},
	committed(x: unknown, container?: unknown): unknown {
		return committed(x as Readable<unknown>, container);
	},
	isPending(x: unknown): boolean {
		return isPending(x as Readable<unknown>);
	},
	refresh(x: unknown): void {
		refresh(x as Computed<unknown>);
	},
	effect(fn: () => void | (() => void)): () => void {
		return effect(fn);
	},
	batch(fn: () => void): void {
		batch(fn);
	},
	untracked<T>(fn: () => T): T {
		return untracked(fn);
	},
	serialize(atoms: unknown[]): string {
		return serializeAtomState(atoms as Array<Atom<unknown>>);
	},
	initialize(json: string, atoms: unknown[]): void {
		initializeAtomState(json, atoms as Array<Atom<unknown>>);
	},

	useValue(x: unknown): unknown {
		return useValue(x as Readable<unknown>);
	},
	useComputed<T>(fn: () => T, deps: unknown[]): T {
		return useComputed(fn, deps);
	},
	useSignalEffect(fn: () => void | (() => void)): void {
		useSignalEffect(fn);
	},
	useIsPending(x: unknown): boolean {
		return useIsPending(x as Readable<unknown>);
	},
	useCommitted(x: unknown): unknown {
		return useCommitted(x as Readable<unknown>);
	},
	startTransitionWrite(scope: () => void): void {
		startTransitionWrite(scope);
	},

	trace(): RoyaleTraceView {
		return traceView();
	},
	onDomMutation(cb: (phase: 'start' | 'stop', container: Element) => void): () => void {
		return onDomMutation(cb);
	},
};

export default adapter;
