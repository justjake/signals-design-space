/**
 * React hooks over the runtime: every hook resolves the current render
 * pass's world when reading, and claims its engine subscription at commit
 * (an effect) with a post-subscribe fixup for values that moved between
 * render and commit — and for open transitions the new subscriber must join.
 */
import * as React from 'react';
import {
	Atom,
	Computed,
	Watcher,
	atom as createAtom,
	computed as createComputed,
	effect as engineEffect,
	isPending,
	type AtomOptions,
	type Readable,
} from 'signals-royale-fm1';
import {
	currentRenderContainer,
	joinOpenBatches,
	onCommit,
	onPendingMaybeChanged,
	readInRenderWorld,
	subscribe,
	type Subscriber,
} from './runtime.ts';

/** Subscribing read: resolves the render pass's world; claims the engine
 * subscription at commit. */
export function useValue<T>(node: Readable<T>): T {
	const [, force] = React.useReducer((c: number) => c + 1, 0);
	const container = React.useRef<unknown>(null);
	if (container.current === null) container.current = currentRenderContainer();
	const value = readInRenderWorld(node);
	const rendered = React.useRef<T>(value);
	rendered.current = value;

	React.useEffect(() => {
		const sub: Subscriber = {
			node: node as Readable<unknown>,
			container: container.current,
			force,
			kind: 'value',
		};
		const unsubscribe = subscribe(sub);
		// The engine watcher delivers canonical changes; skip the wake-up when
		// this component already rendered the new value.
		const watcher = new Watcher(node as Readable<unknown>, () => {
			if (!Object.is(safePeek(node), rendered.current)) force();
		});
		// Post-subscribe fixup: the canonical value may have moved between
		// render and this commit; and open transitions this node participates
		// in need this new subscriber to join their eventual commit.
		if (!Object.is(safePeek(node), rendered.current)) force();
		joinOpenBatches(node as Readable<unknown>, force);
		return () => {
			unsubscribe();
			watcher.dispose();
		};
	}, [node]);

	return value;
}

function safePeek<T>(node: Readable<T>): T | undefined {
	try {
		return node.peek();
	} catch {
		// Pending or error states compare unequal to any rendered value.
		return undefined;
	}
}

/** A computed whose function is recreated when `deps` change, read like
 * useValue. */
export function useComputed<T>(fn: () => T, deps: unknown[]): T {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const node = React.useMemo(() => createComputed(fn), deps);
	return useValue(node);
}

/** Re-runs on committed-value changes of its dependencies; cleanup honored.
 * Effects observe canonical state only. */
export function useSignalEffect(fn: () => void | (() => void)): void {
	const fnRef = React.useRef(fn);
	fnRef.current = fn;
	React.useEffect(() => {
		return engineEffect(() => fnRef.current());
	}, []);
}

/** Cheap flip-only probe: true while newer data loads behind stale. */
export function useIsPending(node: Readable<unknown>): boolean {
	const [pending, setPending] = React.useState(() => isPending(node));
	React.useEffect(() => {
		const probe = () => setPending(isPending(node));
		probe();
		// Runtime probes cover transition drafts and commits; the engine
		// watcher covers async pending flips (refresh, settlement).
		const disposeProbe = onPendingMaybeChanged(probe);
		const watcher = new Watcher(node as Readable<unknown>, probe);
		return () => {
			disposeProbe();
			watcher.dispose();
		};
	}, [node]);
	return pending;
}

/** What is on screen for this component's root, updated at that root's
 * commits. */
export function useCommitted<T>(node: Readable<T>): T | undefined {
	const container = React.useRef<unknown>(null);
	if (container.current === null) container.current = currentRenderContainer();
	const read = () => committedForContainer(node, container.current);
	const [value, setValue] = React.useState<T | undefined>(read);
	React.useEffect(() => {
		setValue(read());
		return onCommit((committedContainer) => {
			if (committedContainer === container.current) setValue(read());
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [node]);
	return value;
}

import { committed as engineCommitted } from 'signals-royale-fm1';
function committedForContainer<T>(node: Readable<T>, container: unknown): T | undefined {
	return engineCommitted(node, container ?? undefined);
}

/** A component-owned atom, reclaimed after unmount. */
export function useAtom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
	const ref = React.useRef<Atom<T> | null>(null);
	if (ref.current === null) {
		ref.current = createAtom(
			typeof initial === 'function' ? () => (initial as () => T)() : initial,
			opts,
		);
	}
	return ref.current;
}

/** useTransition married to an engine batch: writes inside `start`'s scope
 * record into the transition's batch and commit with it. */
export function useTransitionWrite(): [boolean, (scope: () => void) => void] {
	const [isPendingTransition, startTransition] = React.useTransition();
	const start = React.useCallback(
		(scope: () => void) => {
			startTransition(() => {
				scope();
			});
		},
		[startTransition],
	);
	return [isPendingTransition, start];
}

export type { Readable, Atom, Computed };
