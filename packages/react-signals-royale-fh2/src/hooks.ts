/**
 * Hooks: each subscribed component instance is its own engine subscriber.
 *
 * Reading is a two-channel design built on stock hook machinery:
 * - `useSyncExternalStore` carries canonical (urgent) deliveries and — via
 *   React's own store-consistency pass — guarantees a render that raced a
 *   write is corrected synchronously inside the same commit.
 * - A `useReducer` forcer carries draft deliveries: the engine notifies the
 *   subscriber synchronously inside the writer's transition scope (or with
 *   the owning batch's lane forced), so React schedules exactly this fiber
 *   on exactly that lane. That is what makes a correction land inside the
 *   owning batch's commit instead of beside it.
 *
 * The snapshot function is world-aware: during a render pass it resolves
 * the pass's world (committed base plus the batches React is rendering);
 * outside render it resolves the subscriber root's open pass if one exists
 * (React's pre-commit consistency probe), else canonical state.
 */
import * as React from 'react';
import {
	type Atom,
	type AtomOptions,
	type Batch,
	type Computed,
	type Readable,
	AsyncError,
	atom,
	committed,
	computed,
	debugId,
	effect,
	emit,
	isPending,
	isPendingValue,
	onPendingFlip,
	pendingBatchesFor,
	readInWorld,
	reportCommittedValue,
	retryThenable,
	settledHistory,
	subscribe as engineSubscribe,
	tracing,
	worldStamp,
} from 'signals-royale-fh2';
import { getSeam, onRootCommit, renderingPass, snapshotPass } from './runtime';
import type { SignalsFiberRoot } from 'react-dom/client';

interface Store {
	subscribe: (cb: () => void) => () => void;
	getSnapshot: () => unknown;
	force: (() => void) | null;
	root: SignalsFiberRoot | null;
	lastDeliveryEvent: number;
	cacheKey: string;
	cacheVal: unknown;
}

function makeStore(x: Readable<unknown>): Store {
	const store: Store = {
		force: null,
		root: null,
		lastDeliveryEvent: 0,
		cacheKey: '',
		cacheVal: undefined,
		getSnapshot() {
			const pass = renderingPass() ?? snapshotPass(store.root);
			const batches = pass === null ? [] : pass.batches;
			if (batches.length === 0) {
				return readInWorld(x, batches);
			}
			const stamp = worldStamp(batches);
			if (store.cacheKey !== stamp) {
				store.cacheKey = stamp;
				store.cacheVal = readInWorld(x, batches);
			}
			return store.cacheVal;
		},
		subscribe(onStoreChange: () => void) {
			const seam = getSeam();
			const handle = engineSubscribe(x, (d) => {
				store.lastDeliveryEvent = handle.lastDeliveryEvent();
				if (d.batch === null) {
					onStoreChange(); // canonical: urgent, React classifies ambiently
				} else {
					// Draft: schedule exactly this fiber on the owning
					// batch's lane, so the re-render rides that batch.
					const batch = d.batch;
					seam.runWithLane(batch.key as number, () => store.force?.());
				}
			});
			// A batch opened before this subscriber existed still owes it a
			// draft render: join each live batch that will change this value.
			for (const b of pendingBatchesFor(x)) {
				seam.runWithLane(b.key as number, () => store.force?.());
			}
			return () => {
				handle.dispose();
			};
		},
	};
	return store;
}

/** Boundary policy for a pending value at a React read site: a transition
 * render hands React the thenable (the transition holds); an urgent render
 * with settled history serves the stale value; never-settled suspends. */
function resolveAtBoundary<T>(x: Readable<T>, v: unknown): T {
	if (isPendingValue(v)) {
		const pass = renderingPass();
		const batches: Batch[] = pass === null ? [] : pass.batches;
		if (batches.length === 0) {
			const history = settledHistory(x);
			if (history.has) {
				return history.value as T;
			}
		}
		throw retryThenable(x, batches);
	}
	if (v instanceof AsyncError) {
		throw v;
	}
	return v as T;
}

const bump = (c: number): number => c + 1;

/** Subscribing read: resolves the render pass's world; claims its engine
 * subscription at commit with post-subscribe fixup. */
export function useValue<T>(x: Readable<T>): T {
	const [, force] = React.useReducer(bump, 0);
	const store = React.useMemo(() => makeStore(x as Readable<unknown>), [x]);
	store.force = force;
	const pass = renderingPass();
	if (pass !== null) {
		store.root = pass.root;
	}
	const v = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
	if (tracing()) {
		emit('render', { tid: debugId(x) }, store.lastDeliveryEvent || undefined);
	}
	const shown = resolveAtBoundary(x, v);
	// Committed-view ground truth: this effect runs exactly when this render
	// reached the screen (suspended and discarded renders never report).
	const container = store.root?.containerInfo;
	React.useEffect(() => {
		reportCommittedValue(container, x as Readable<unknown>, shown);
	});
	return shown;
}

/** A component-owned memoized computed; recreated when `deps` change. */
export function useComputed<T>(fn: () => T, deps: unknown[]): T {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const c = React.useMemo(() => computed<T>(() => fn()), deps);
	return useValue(c);
}

/** Runs an engine effect for the component's lifetime: re-runs when the
 * canonical (committed-plus-urgent) values it reads change; cleanup runs
 * between runs and at unmount. Never observes speculative drafts. */
export function useSignalEffect(fn: () => void | (() => void)): void {
	const ref = React.useRef(fn);
	ref.current = fn;
	React.useEffect(() => effect(() => ref.current()), []);
}

/** True while newer data for `x` loads behind stale content. */
export function useIsPending(x: Readable<unknown>): boolean {
	const store = React.useMemo(
		() => ({
			subscribe: (cb: () => void) => onPendingFlip(cb),
			getSnapshot: () => isPending(x),
		}),
		[x],
	);
	return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** What is on screen in this component's own root. */
export function useCommitted<T>(x: Readable<T>): T {
	const rootRef = React.useRef<SignalsFiberRoot | null>(null);
	const pass = renderingPass();
	if (pass !== null) {
		rootRef.current = pass.root;
	}
	const store = React.useMemo(
		() => ({
			subscribe(cb: () => void) {
				const offCommit = onRootCommit(cb);
				const sub = engineSubscribe(x as Readable<unknown>, () => cb());
				return () => {
					offCommit();
					sub.dispose();
				};
			},
			getSnapshot: () => committed(x, rootRef.current?.containerInfo),
		}),
		[x],
	);
	return React.useSyncExternalStore(store.subscribe, store.getSnapshot) as T;
}

/** A component-owned atom, reclaimed after unmount. */
export function useAtom<T>(initial: T | (() => T), options?: AtomOptions<T>): Atom<T> {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	return React.useMemo(() => atom(initial, options), []);
}

/** Marries React's startTransition with an engine batch: every write inside
 * the scope classifies into the draft batch keyed by the transition's lane
 * and commits with that transition. */
export function startTransitionWrite(scope: () => void): void {
	React.startTransition(() => {
		scope();
	});
}

export type { Computed };
