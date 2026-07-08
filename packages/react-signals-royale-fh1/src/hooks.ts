/**
 * React hooks over the engine.
 *
 * A subscribing hook renders through the current pass's World (so sibling
 * readers agree and transitions stay invisible until their commit), claims its
 * engine subscription in an effect at commit, and fixes up any drift that
 * happened in between. A subscriber arriving while a transition batch is live
 * joins that batch's own lane, so its correction commits WITH the transition.
 */
import * as React from 'react';
import {
	atom,
	computed,
	effect,
	isPending,
	committed,
	read,
	readInWorld,
	subscribeHook,
	untracked,
	liveBatches,
	makeWorld,
	hasSettled,
	lastSettled,
	PendingValue,
	tracing,
	emit,
	withCause,
	type Atom,
	type AtomOptions,
	type Computed,
	type HookPoke,
	type Node,
} from 'signals-royale-fh1';
import {
	currentRenderWorld,
	currentRenderContainer,
	getHost,
	runInBatch,
	runUrgent,
} from './seam';

const bump = (c: number): number => c + 1;

/** A join probe that could not produce a value (its world is pending). */
const JOIN_PENDING: unique symbol = Symbol('join-pending');

interface ValueBox {
	value: unknown;
	/** The value this hook last actually put on screen (renders that never
	 * commit — suspended or discarded passes — do not update it). */
	committedValue: unknown;
	deliveryEv: number;
}

/** Read a signal or computed and re-render when it changes. Resolves the
 * render pass's own world; the two-level suspend-vs-stale rule applies at
 * this boundary: a transition render hands React the thenable, an urgent
 * render with settled history serves the stale value (isPending is the
 * indicator), and a never-settled read suspends everywhere. */
export function useValue<T>(x: Node<T>): T {
	const [, force] = React.useReducer(bump, 0);
	const world = currentRenderWorld();
	let value: T;
	try {
		value = world !== null ? (readInWorld(x, world) as T) : untracked(() => read(x));
	} catch (e) {
		if (e instanceof PendingValue) {
			if (world !== null && world.batches.length > 0) throw e.thenable;
			if (hasSettled(x)) value = lastSettled(x) as T;
			else throw e.thenable;
		} else {
			throw e;
		}
	}
	const box = React.useRef<ValueBox | null>(null);
	if (box.current === null) box.current = { value, committedValue: value, deliveryEv: 0 };
	box.current.value = value;
	React.useLayoutEffect(() => {
		box.current!.committedValue = box.current!.value;
	});
	if (tracing && box.current.deliveryEv !== 0) {
		const ev = box.current.deliveryEv;
		box.current.deliveryEv = 0;
		withCause(ev, () => emit('component-render'));
	}
	React.useEffect(() => {
		const state = box.current!;
		const poke: HookPoke = (stamp, ev) => {
			state.deliveryEv = ev;
			// Routing by stamp:
			// - live draft poke: arrives synchronously inside the writer's own
			//   transition scope; force unconditionally so the update schedules
			//   on that batch's lane.
			// - retirement/rollback poke: ignored here — every subscriber's root
			//   already carries that batch's lane (the draft poke or the join
			//   fixup put it there), so React's own retry of the lane converges
			//   it; an urgent nudge would tear per-root committed views.
			// - urgent poke: re-render only when the canonical value drifted
			//   from what this hook has on screen.
			if (stamp !== 0) {
				if (liveBatches.get(stamp)?.state === 0) force();
				return;
			}
			let canonical: unknown;
			try {
				canonical = untracked(() => read(x));
			} catch (e) {
				canonical =
					e instanceof PendingValue && hasSettled(x) ? lastSettled(x) : state.committedValue;
			}
			if (!Object.is(canonical, state.committedValue)) force();
		};
		const unsub = subscribeHook(x, poke);
		// Post-subscribe fixup: a canonical change between render and commit.
		let canonical: unknown;
		try {
			canonical = untracked(() => read(x));
		} catch (e) {
			canonical = e instanceof PendingValue && hasSettled(x) ? lastSettled(x) : state.value;
		}
		if (!Object.is(canonical, state.value)) force();
		// Join live batches: this subscriber must appear in their commits.
		for (const b of liveBatches.values()) {
			const w = makeWorld([b.id]);
			let inBatch: unknown;
			try {
				inBatch = readInWorld(x, w);
			} catch {
				inBatch = JOIN_PENDING;
			} finally {
				w.release();
			}
			if (!Object.is(inBatch, canonical)) {
				runInBatch(b, () => force());
			}
		}
		return unsub;
	}, [x]);
	return value;
}

/** True while newer data loads behind the value being shown. Flips are
 * delivered urgently even when the cause lives inside a parked transition. */
export function useIsPending(x: Node): boolean {
	const [, force] = React.useReducer(bump, 0);
	const p = isPending(x);
	const box = React.useRef(p);
	box.current = p;
	React.useEffect(() => {
		const poke: HookPoke = () => {
			if (isPending(x) !== box.current) runUrgent(force);
		};
		const unsub = subscribeHook(x, poke);
		if (isPending(x) !== box.current) runUrgent(force);
		return unsub;
	}, [x]);
	return p;
}

/** What this component's own root has committed for `x`; updates at that
 * root's commits. */
export function useCommitted<T>(x: Node<T>): T {
	const [, force] = React.useReducer(bump, 0);
	const containerRef = React.useRef<unknown>(null);
	const renderContainer = currentRenderContainer();
	if (renderContainer !== null) containerRef.current = renderContainer;
	const value = committed(x, containerRef.current ?? undefined) as T;
	const box = React.useRef(value);
	box.current = value;
	React.useEffect(() => {
		const h = getHost();
		const container = containerRef.current;
		const probe = () => {
			let cur: unknown;
			try {
				cur = committed(x, container ?? undefined);
			} catch {
				cur = box.current;
			}
			if (!Object.is(cur, box.current)) runUrgent(force);
		};
		let probes = h.committedProbes.get(container);
		if (probes === undefined) {
			probes = new Set();
			h.committedProbes.set(container, probes);
		}
		probes.add(probe);
		return () => {
			probes.delete(probe);
		};
	}, [x]);
	return value;
}

/** A derived value recomputed when `deps` change, subscribed like useValue. */
export function useComputed<T>(fn: () => T, deps: unknown[]): T {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const c = React.useMemo(() => computed(fn), deps);
	return useValue(c as Computed<T>);
}

/** Run an engine effect for the lifetime of the component. It re-runs when
 * the canonical (committed ∪ urgent) values it read change; the returned
 * cleanup runs before each re-run and at unmount. Transition drafts are never
 * visible to it. */
export function useSignalEffect(fn: () => void | (() => void)): void {
	React.useEffect(() => effect(fn), []);
}

/** A component-owned atom, reclaimed after unmount. */
export function useAtom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
	const [a] = React.useState(() => atom(initial, opts));
	return a;
}

/** React useTransition married to engine write classification: writes inside
 * `startWrite` become one deferred batch that commits with the transition. */
export function useTransitionWrite(): [boolean, (scope: () => void) => void] {
	const [pending, start] = React.useTransition();
	const startWrite = React.useCallback((scope: () => void) => {
		start(() => {
			scope();
		});
	}, []);
	return [pending, startWrite];
}
