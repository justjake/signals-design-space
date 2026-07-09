/**
 * React hooks over the signals-royale-fm2 engine.
 *
 * The subscribing hooks share one shape: a bump counter (useReducer) forces
 * a re-render, and the render body re-reads the engine with the ambient
 * world the host installed for this render pass. Values are never stored in
 * React state, so React's own update-queue replay (urgent-first, then
 * rebase) automatically re-resolves each pass against the right world.
 */
import * as React from 'react';
import {
	atom,
	computed,
	effect,
	read,
	committed,
	isPending,
	subscribeNode,
	untracked,
	emitTrace,
	currentCauseId,
	type Atom,
	type AtomOptions,
	type Computed,
	type Readable,
} from 'signals-royale-fm2';
import {
	getCurrentRenderContainer,
	getView,
	openLaneBatches,
	recordCommitted,
	runUrgent,
	runWithLane,
	type LaneBatch,
} from './host.ts';

const bump = (c: number) => c + 1;

/**
 * Claim an engine subscription at commit. Draft pokes are re-dispatched on
 * the owning batch's lane so the update joins that transition's commit;
 * canonical pokes dispatch urgently. `urgentOnly` collapses every poke to an
 * urgent dispatch (pending probes must stay visible while transitions park).
 */
function useSubscription<T>(
	x: Readable<T>,
	urgentOnly: boolean,
	rendered: unknown,
	readNow: () => unknown,
): void {
	const [, force] = React.useReducer(bump, 0);
	React.useEffect(() => {
		const unsub = subscribeNode(x, (b) => {
			emitTrace('deliver', currentCauseId(), { node: x, batch: b ? b.id : 0 });
			if (b !== null && !urgentOnly) runWithLane((b as LaneBatch).lane ?? 0, force);
			else runUrgent(force);
		});
		// Post-subscribe fixup: the subscription starts now, but the render
		// that owns it read earlier. Re-poke urgently if canonical moved in
		// between, and join any transition batch already in flight so this
		// component re-renders inside that batch's commit, never beside it.
		let current: unknown;
		try {
			current = untracked(readNow);
		} catch {
			current = rendered; // pending read: the subscription poke will follow
		}
		if (!Object.is(current, rendered)) force();
		if (!urgentOnly) {
			for (const b of openLaneBatches()) runWithLane(b.lane, force);
		}
		return unsub;
		// The fixup intentionally closes over the claiming render only.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [x, urgentOnly]);
}

/** Subscribe to a signal or computed and read it in this render's world. */
export function useValue<T>(x: Readable<T>): T {
	const value = read(x);
	useSubscription(x, false, value, () => read(x));
	const [container] = React.useState(getCurrentRenderContainer);
	// Runs at every commit of this component: what the screen now shows for
	// `x` on this root. Suspended and discarded renders never get here.
	React.useLayoutEffect(() => {
		recordCommitted(container, x, value);
	});
	return value;
}

/** True while newer data (a draft or a refetch) loads behind the value shown. */
export function useIsPending<T>(x: Readable<T>): boolean {
	const pending = untracked(() => isPending(x));
	useSubscription(x, true, pending, () => isPending(x));
	return pending;
}

/** What this component's own root has committed to the screen for `x`. */
export function useCommitted<T>(x: Readable<T>): T {
	const [container] = React.useState(getCurrentRenderContainer);
	const [, force] = React.useReducer(bump, 0);
	React.useEffect(() => {
		const view = getView(container) as (ReturnType<typeof getView> & {
			listeners?: Set<() => void>;
		}) | null;
		view?.listeners?.add(force);
		const unsub = subscribeNode(x, () => force());
		return () => {
			view?.listeners?.delete(force);
			unsub();
		};
	}, [x, container]);
	return committed(x, getView(container));
}

/** Memoize a computed over `fn`; recreated when `deps` change. */
export function useComputed<T>(fn: () => T, deps: unknown[]): T {
	const fnRef = React.useRef(fn);
	fnRef.current = fn;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const c = React.useMemo(() => computed<T>(() => fnRef.current()), deps);
	return useValue(c);
}

/** Run an engine effect for the component's lifetime (committed values only). */
export function useSignalEffect(fn: () => void | (() => void)): void {
	const fnRef = React.useRef(fn);
	fnRef.current = fn;
	React.useEffect(() => effect(() => fnRef.current()), []);
}

/** A component-owned atom, reclaimed after unmount. */
export function useAtom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	return React.useMemo(() => atom(initial, opts), []);
}

export type { Atom, Computed, Readable };
