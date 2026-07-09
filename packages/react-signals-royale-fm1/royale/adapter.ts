/** RoyaleAdapter: the shared cross-entrant battery's view of this entry. */
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { act } from 'react';
import { flushSync } from 'react-dom';
import {
	Atom,
	Computed,
	atom,
	batch,
	committed,
	computed,
	effect,
	initializeAtomState,
	isPending,
	latest,
	refresh,
	serializeAtomState,
	untracked,
	type Readable,
} from 'signals-royale-fm1';
import {
	onDomMutation,
	register,
	resetForTest,
	set as runtimeSet,
	startTransitionWrite,
	update as runtimeUpdate,
	useCommitted,
	useComputed,
	useIsPending,
	useSignalEffect,
	useValue,
} from '../src/index.ts';
import { trace, type RoyaleTraceView } from '../src/trace.ts';

export interface RoyaleHandle {
	errors: unknown[];
	dispose(): void;
}

/** Positional keys: serialize(atoms) on one engine pairs with
 * initialize(json, atoms) on a fresh one by array position. */
function keysFor(atoms: unknown[]): Record<string, Atom<unknown>> {
	const out: Record<string, Atom<unknown>> = {};
	atoms.forEach((a, i) => {
		out[String(i)] = a as Atom<unknown>;
	});
	return out;
}

const adapter = {
	slug: 'fm1',
	React,
	ReactDOMClient,
	act: async <T,>(fn: () => T | Promise<T>): Promise<undefined> => {
		await act(fn);
		return undefined;
	},
	flushSync,
	register(): RoyaleHandle {
		return register();
	},
	resetForTest(): void {
		resetForTest();
	},
	atom<T>(
		initial: T | (() => T),
		opts?: {
			equals?(a: T, b: T): boolean;
			onObserved?(ctx: { get(): T; set(v: T): void }): void | (() => void);
			label?: string;
		},
	): unknown {
		return atom(initial, opts);
	},
	set(a: unknown, v: unknown): void {
		runtimeSet(a as Atom<unknown>, v);
	},
	update(a: unknown, fn: (prev: unknown) => unknown): void {
		runtimeUpdate(a as Atom<unknown>, fn);
	},
	computed<T>(
		fn: (use: <U>(t: PromiseLike<U>) => U) => T,
		opts?: { equals?(a: T, b: T): boolean; label?: string },
	): unknown {
		return computed(fn, opts);
	},
	read(x: unknown): unknown {
		// Tracked canonical read: inside an engine effect this records the
		// dependency (drafts stay hidden because effects never run inside a
		// render pass's snapshot).
		return (x as Readable<unknown>).get();
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
		refresh(x as Readable<unknown>);
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
		return serializeAtomState(keysFor(atoms));
	},
	initialize(json: string, atoms: unknown[]): void {
		initializeAtomState(json, keysFor(atoms));
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
		return trace();
	},
	onDomMutation(cb: (phase: 'start' | 'stop', container: Element) => void): () => void {
		return onDomMutation(cb);
	},
};

export type { RoyaleTraceView };
export default adapter;
export { adapter };
