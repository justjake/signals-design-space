/**
 * RoyaleAdapter for signals-royale-fh1 — the shared cross-entrant battery
 * drives everything through this surface.
 */
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';
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
	serializeAtomState,
	initializeAtomState,
	lastDeliveryEvent,
	startTrace,
	__resetEngine,
	type Atom,
	type AtomOptions,
	type Node,
	type Use,
} from 'signals-royale-fh1';
import {
	register,
	resetHostForTest,
	startTransitionWrite,
	onDomMutation,
} from '../src/index';
import {
	useValue,
	useComputed,
	useSignalEffect,
	useIsPending,
	useCommitted,
} from '../src/hooks';

export interface RoyaleHandle {
	errors: unknown[];
	dispose(): void;
}

export interface RoyaleTraceView {
	whyLastDelivery(x: unknown): string[];
	events(): Array<{ id: number; kind: string; cause?: number }>;
	stop(): void;
}

function keysFor(atoms: unknown[]): Record<string, Atom<unknown>> {
	const rec: Record<string, Atom<unknown>> = {};
	atoms.forEach((a, i) => {
		rec[String(i)] = a as Atom<unknown>;
	});
	return rec;
}

const adapter = {
	slug: 'fh1',
	React,
	ReactDOMClient,
	act: act as <T>(fn: () => T | Promise<T>) => Promise<undefined>,
	flushSync,

	register(): RoyaleHandle {
		const host = register();
		return {
			errors: host.errors,
			dispose() {
				resetHostForTest();
			},
		};
	},
	resetForTest(): void {
		__resetEngine();
		resetHostForTest();
		register();
	},

	atom<T>(
		initial: T | (() => T),
		opts?: {
			equals?(a: T, b: T): boolean;
			onObserved?(ctx: { get(): T; set(v: T): void }): void | (() => void);
			label?: string;
		},
	): unknown {
		const engineOpts: AtomOptions<T> = {
			equals: opts?.equals,
			label: opts?.label,
			effect: opts?.onObserved,
		};
		return atom(initial, engineOpts);
	},
	set(a: unknown, v: unknown): void {
		(a as Atom<unknown>).set(v);
	},
	update(a: unknown, fn: (prev: unknown) => unknown): void {
		(a as Atom<unknown>).update(fn);
	},
	computed<T>(
		fn: (use: <U>(t: PromiseLike<U>) => U) => T,
		opts?: { equals?(a: T, b: T): boolean; label?: string },
	): unknown {
		return computed(fn as (use: Use) => T, opts);
	},
	read(x: unknown): unknown {
		return read(x as Node);
	},
	latest(x: unknown): unknown {
		return latest(x as Node);
	},
	committed(x: unknown, container?: unknown): unknown {
		return committed(x as Node, container);
	},
	isPending(x: unknown): boolean {
		return isPending(x as Node);
	},
	refresh(x: unknown): void {
		refresh(x as Node);
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
		return useValue(x as Node);
	},
	useComputed<T>(fn: () => T, deps: unknown[]): T {
		return useComputed(fn, deps);
	},
	useSignalEffect(fn: () => void | (() => void)): void {
		useSignalEffect(fn);
	},
	useIsPending(x: unknown): boolean {
		return useIsPending(x as Node);
	},
	useCommitted(x: unknown): unknown {
		return useCommitted(x as Node);
	},
	startTransitionWrite(scope: () => void): void {
		startTransitionWrite(scope);
	},

	trace(): RoyaleTraceView {
		const t = startTrace();
		return {
			whyLastDelivery(x: unknown): string[] {
				const ev = lastDeliveryEvent(x as Node);
				return ev === 0 ? [] : t.explain(ev);
			},
			events(): Array<{ id: number; kind: string; cause?: number }> {
				return t
					.events()
					.map((e) => ({ id: e.id, kind: e.kind, cause: e.cause === 0 ? undefined : e.cause }));
			},
			stop(): void {
				t.stop();
			},
		};
	},
	onDomMutation(cb: (phase: 'start' | 'stop', container: Element) => void): () => void {
		return onDomMutation(cb);
	},
};

export default adapter;
