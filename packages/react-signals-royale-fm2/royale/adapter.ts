/** RoyaleAdapter for the shared cross-entrant battery. */
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { act } from 'react';
import { flushSync } from 'react-dom';
import {
	atom,
	computed,
	effect,
	batch,
	untracked,
	read,
	latest,
	committed,
	isPending,
	refresh,
	set,
	update,
	serializeAtomState,
	initializeAtomState,
	type Atom,
	type AtomOptions,
	type Computed,
	type Readable,
	type UseFn,
} from 'signals-royale-fm2';
import {
	register,
	resetForTest,
	startTransitionWrite,
	onDomMutation,
	getView,
} from '../src/host.ts';
import {
	useValue,
	useComputed,
	useSignalEffect,
	useIsPending,
	useCommitted,
} from '../src/hooks.ts';
import { traceView } from '../src/trace.ts';

type AnyReadable = Readable<unknown>;

function keyed(atoms: unknown[]): Record<string, Atom<unknown>> {
	const rec: Record<string, Atom<unknown>> = {};
	atoms.forEach((a, i) => (rec[String(i)] = a as Atom<unknown>));
	return rec;
}

const adapter = {
	slug: 'fm2',
	React,
	ReactDOMClient,
	act: act as <T>(fn: () => T | Promise<T>) => Promise<undefined>,
	flushSync,
	register,
	resetForTest,
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
		return computed<T>(fn as (use: UseFn) => T, opts);
	},
	// The RoyaleAdapter contract types value reads as `any` so battery JSX can
	// interpolate them as children.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	read: (x: unknown): any => read(x as AnyReadable),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	latest: (x: unknown): any => latest(x as AnyReadable),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	committed: (x: unknown, container?: unknown): any =>
		committed(x as AnyReadable, container === undefined ? null : getView(container)),
	isPending: (x: unknown) => isPending(x as AnyReadable),
	refresh: (x: unknown) => refresh(x as AnyReadable),
	effect,
	batch(fn: () => void): void {
		batch(fn);
	},
	untracked,
	serialize: (atoms: unknown[]) => serializeAtomState(keyed(atoms)),
	initialize: (json: string, atoms: unknown[]) => initializeAtomState(json, keyed(atoms)),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	useValue: (x: unknown): any => useValue(x as AnyReadable),
	useComputed,
	useSignalEffect,
	useIsPending: (x: unknown) => useIsPending(x as AnyReadable),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	useCommitted: (x: unknown): any => useCommitted(x as AnyReadable),
	startTransitionWrite,
	trace: traceView,
	onDomMutation,
};

export default adapter;
export type { Computed };
