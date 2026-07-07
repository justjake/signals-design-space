/**
 * cosignal-react — the hook surface: useSignal, useComputed, useReducerAtom,
 * useSignalEffect, startSignalTransition, plus registerCosignalReact — the
 * activation call that couples `cosignal`'s one module-level engine to a
 * protocol React build via the Shim (whose constructor attaches the engine
 * driver — the seam that arms write classification and world routing).
 *
 * Watcher lifecycle, shared by the subscription hooks (a watcher is the
 * engine's record of one subscribed component instance): render creates (or
 * re-tracks) a watcher in the current render's world, so the component reads
 * the view of the render it is part of; the layout effect claims the
 * subscription after commit (StrictMode's double-mount nets to one live
 * watcher via microtask-debounced unsubscription); the mount fixup — the
 * engine's commit-time reconciliation of a freshly mounted component
 * against updates that were in flight while it mounted — runs inside the
 * engine at the commit edge, and its corrective re-renders and urgent
 * corrections reach React as pre-paint setStates through the shim.
 */

import * as React from 'react';
import { Atom, BATCH_NONE, Computed, ReducerAtom, engine } from 'cosignal';
import type { AnyNode, CosignalEngine, RootId } from 'cosignal';
import { ROOT_UNKNOWN, Shim, getActiveShim, setActiveShim, unregisterShim, type BoundCtx, type WatcherTarget } from './shim.js';

// ---- activation -------------------------------------------------------------------

export type CosignalReactHandle = {
	/** THE engine surface (the same module-level object `cosignal` exports as
	 * `engine`; the field keeps the bindings' historical name). */
	bridge: CosignalEngine;
	shim: Shim;
	dispose: () => void;
};

/**
 * Activates the bindings: attaches the engine driver (write classification,
 * world routing, delivery listeners — the Shim constructor's job) and
 * subscribes the shim to the external-runtime protocol events. Call during
 * app setup, after importing react-dom/client (the renderer must have
 * registered its protocol provider first), before rendering any root;
 * throws on stock React — see assertForkPresent. One registration at a
 * time: dispose the handle before registering again. Dispose releases the
 * React-side registrations only — the engine's driver slot is cleared only
 * by the test-only engine reset (`__resetEngineForTest`), so tests reset
 * the engine between registrations.
 */
export function registerCosignalReact(): CosignalReactHandle {
	if (getActiveShim() !== undefined) {
		throw new Error('cosignal-react: already registered (dispose the previous registration first).');
	}
	const shim = new Shim();
	setActiveShim(shim);
	return {
		bridge: engine,
		shim,
		dispose: () => {
			shim.dispose();
			unregisterShim(shim); // clears the slot only if it still points at this shim — never a successor's registration
		},
	};
}

export function requireShim(): Shim {
	const shim = getActiveShim();
	if (shim === undefined) {
		throw new Error('cosignal-react: registerCosignalReact() must run before using cosignal hooks.');
	}
	return shim;
}

// ---- signal sources ---------------------------------------------------------------------
// (Kernel `Computed` handles ARE the supported derived
// type. `useComputed` returns a real `Computed`; standalone `Computed`
// instances route to the render's world through the core's computed-read
// seam and subscribe through `useSignal` exactly like atoms.)

export type SignalSource<T> = Atom<T> | ReducerAtom<T, unknown> | Computed<T>;

function resolveNode(shim: Shim, signal: SignalSource<unknown>): AnyNode {
	if (signal instanceof Atom) return shim.nodeForAtom(signal as Atom<unknown>);
	if (signal instanceof Computed) return shim.bridge.nodeForComputed(signal as Computed<unknown>);
	throw new Error('cosignal-react: useSignal accepts Atom/ReducerAtom/Computed handles (useComputed results are Computed handles).');
}

// ---- useSignal --------------------------------------------------------------------------

type SignalRec = {
	node: AnyNode;
	watcherId: number | undefined;
	target: WatcherTarget;
	pendingUnsub: boolean;
	root: RootId | undefined;
	lastValue: unknown;
};

type SignalRefState = { current: SignalRec | null; retired: SignalRec[] };

function makeRec(node: AnyNode, bump: () => void): SignalRec {
	return {
		node,
		watcherId: undefined,
		target: { bump, live: false },
		pendingUnsub: false,
		root: undefined,
		lastValue: undefined,
	};
}

/**
 * Subscribes the component to an atom (or a useComputed result) and returns
 * its value in the world of the render the component is part of: a
 * transition render sees the transition's pending value, an urgent render
 * sees committed state, and every component in one render pass sees the
 * same frozen view — no frame can mix old and new state. The component
 * re-renders whenever the value changes in some batch's world, and that
 * re-render is scheduled in the batch's own lane, so it stays part of the
 * update that caused it.
 *
 * Mounting is the subtle case. A component can mount while other updates
 * are in flight, and its subscription only activates at commit — so writes
 * could slip by unobserved between its render and its commit. The layout
 * effect below claims the subscription, and the bridge's mount fixup (run
 * at the commit edge) closes the window: for every still-live batch that
 * touched relevant state but was not part of this component's render, a
 * corrective re-render is scheduled into that batch's own lane via the
 * protocol's unstable_runInBatch — the component joins the pending update
 * instead of revealing it early or missing it — and one comparison against
 * committed-state-as-of-now catches anything that committed or retired
 * during the window, fixed urgently before paint.
 */
export function useSignal<T>(signal: SignalSource<T>): T {
	const shim = requireShim();
	const node = resolveNode(shim, signal as SignalSource<unknown>);
	const [, force] = React.useReducer((c: number) => c + 1, 0);
	const ref = React.useRef<SignalRefState | null>(null);
	if (ref.current === null) ref.current = { current: null, retired: [] };
	const state = ref.current;

	// Signal identity changed across renders: queue the old subscription for
	// teardown (finalized at the next layout effect) and create a fresh one.
	if (state.current !== null && state.current.node !== node) {
		state.retired.push(state.current);
		state.current = null;
	}
	if (state.current === null) state.current = makeRec(node, () => force());
	const rec = state.current;

	const rendering = shim.renderingRoot();
	const bridge = shim.bridge;
	let value: unknown;
	if (rendering?.renderPass !== undefined && rendering.renderPass.state !== 'ended') {
		const render = rendering.renderPass;
		rec.root = rendering.id;
		const w = rec.watcherId === undefined ? undefined : bridge.watchers.get(rec.watcherId);
		if (w === undefined) {
			// Mount: create the watcher in this render's world; the value it renders
			// is captured so the commit-edge fixup can compare against it.
			value = shim.hookRead(() => {
				const created = bridge.mountWatcher(render.id, node, 'w?');
				created.name = `w${created.id}`;
				rec.watcherId = created.id;
				shim.targets.set(created.id, rec.target);
				shim.noteCreated(rendering, created.id);
				return created.lastRenderedValue;
			});
		} else if (w.live) {
			// Re-render: re-arm the watcher's delivery dedup and read this render's world.
			bridge.renderWatcher(render.id, w.id);
			value = shim.hookRead(() => bridge.renderValue(node, render));
		} else {
			// Reveal-shaped re-render (previously hidden content shown again, e.g.
			// React Activity/Offscreen): adopt the dormant watcher into this render
			// so the commit-edge mount fixup reconciles it — against batches this
			// render did not include, and against committed state — as if it were
			// a fresh mount.
			bridge.adoptRevealedMount(render.id, w.id);
			shim.noteCreated(rendering, w.id);
			value = shim.hookRead(() => bridge.renderValue(node, render));
		}
	} else {
		// Render outside a tracked render pass (defensive): unrouted newest read.
		value = shim.hookRead(() => bridge.newestValue(node));
	}
	rec.lastValue = value;

	React.useLayoutEffect(() => {
		shim.claimWatcher(rec);
		for (const old of state.retired.splice(0)) shim.finalizeUnsub(old);
		return () => {
			// Microtask-debounced unsubscribe. In development StrictMode React
			// mounts, unmounts, and remounts each component to surface unsafe
			// effects; the unmount's cleanup and the remount's claim both run
			// synchronously inside the commit, before this microtask fires, so
			// the pair nets out to one live subscription instead of a teardown
			// plus a fresh subscribe. Activity hide/reveal cancels the same way.
			rec.pendingUnsub = true;
			queueMicrotask(() => {
				// The disposed guard is the cross-reset guard: tests dispose the
				// shim before resetting the ONE engine, and a microtask crossing
				// that boundary would tear down a watcher id inside a fresh
				// composition it never belonged to. A disposed shim's pending
				// unsubscribes died with its targets.
				if (!shim.disposed && rec.pendingUnsub) shim.finalizeUnsub(rec);
			});
		};
	}, [shim, rec]);

	return value as T;
}

// ---- useComputed ------------------------------------------------------------------------

let nextComputedSerial = 1;

/**
 * A derived value scoped to the component, with useMemo semantics applied to
 * node identity: while `deps` are equal you keep the same node (nothing is
 * created); when `deps` change, a fresh node capturing the new closure is
 * created in work-in-progress hook state — kept if the render commits,
 * dropped if the render is discarded. Returns a real kernel `Computed`
 * handle whose `.state` reads in the current render's
 * world through the core's computed-read seam.
 *
 * Recreating instead of swapping the function in place is deliberate: a
 * node's evaluating function must stay immutable for the node's whole life,
 * because pending worlds replay evaluation — if a live node's function
 * could change, one world could observe another closure's output. A changed
 * function therefore only takes effect through changed deps (the useMemo
 * rule). Inside `fn`, ctx.previous is a hint carrying the last committed
 * value (possibly stale or undefined) and ctx.use reads async data
 * (suspending the component via React Suspense while pending) in two forms:
 * `ctx.use(promise)` for a promise the app's data layer caches, and
 * `ctx.use(key, factory)` for a request cached per key on the node itself.
 * The keyed cache lives exactly as long as the node: deps changes (and
 * discarded mount attempts, which throw away hook state) recreate the node
 * and refetch — React's own useMemo/uncached-promise lifecycle.
 *
 * Reclamation: when a deps change commits, the SUPERSEDED handle's
 * kernel record is disposed after the commit (a passive effect keyed on the
 * handle — by then every subscription hook re-keyed to the replacement), so
 * kernel ids recycle deterministically per deps change; the record's
 * generation stamp makes the reuse sound. Discarded render attempts drop
 * their created handle with the discarded hook state; the record recovers
 * through the garbage-collection reclamation path once the handle is
 * collected.
 */
export function useComputed<T>(fn: (ctx: BoundCtx<T>) => T, deps: readonly unknown[]): Computed<T> {
	const shim = requireShim();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const handle = React.useMemo(
		() => {
			const c = new Computed<T>(fn, { label: `useComputed#${nextComputedSerial++}` });
			shim.bridge.nodeForComputed(c as Computed<unknown>); // allocate engine content + wrap for world evaluation
			return c;
		},
		// The user's deps ARE the memo key: a changed fn takes effect only with changed deps.
		[shim, ...deps],
	);
	const prevRef = React.useRef<Computed<T> | null>(null);
	React.useEffect(() => {
		const prev = prevRef.current;
		prevRef.current = handle;
		if (prev !== null && prev !== handle) shim.bridge.disposeComputed(prev as Computed<unknown>);
	}, [shim, handle]);
	return handle;
}

// ---- useReducerAtom -----------------------------------------------------------------------

let warnedReducerSwap = false;

/**
 * [value, dispatch] with useReducer parity, backed by an atom created once
 * for the component's lifetime. The reducer is fixed at creation and must
 * be pure: dispatched actions are stored and replayed to compute each
 * world's value, so an impure or swapped reducer would let worlds disagree
 * about the same history. A render passing a different reducer function
 * does not swap it (warns once in development; remount with a `key` to
 * change reducers).
 */
export function useReducerAtom<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, (action: A) => void] {
	const [record] = React.useState(() => ({ atom: new ReducerAtom<S, A>(reducer, initial), reducer }));
	if (record.reducer !== reducer && !warnedReducerSwap) {
		warnedReducerSwap = true;
		// eslint-disable-next-line no-console
		console.warn('cosignal: useReducerAtom reducers are fixed at creation — remount with a key to change reducers.');
	}
	const value = useSignal(record.atom as unknown as Atom<S>);
	const dispatch = React.useCallback((action: A) => record.atom.dispatch(action), [record]);
	return [value, dispatch];
}

// ---- useSignalEffect ----------------------------------------------------------------------

/**
 * An effect whose signal reads resolve in the committed world of the
 * component's root — never pending state. Effects perform side effects
 * (network, imperative DOM, logging), and side effects must track what the
 * user actually sees: a pending transition may still be discarded, and a
 * side effect cannot be un-run. The effect re-fires (cleanup, then run)
 * when a durable change moves any value it read during its last run — the
 * root committing UI that includes a batch, a batch retiring, an async
 * action settling. `deps` changes re-run it through React's own useEffect
 * machinery, exactly like useEffect.
 */
export function useSignalEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
	const shim = requireShim();
	const rootRef = React.useRef<RootId | undefined>(undefined);
	const rendering = shim.renderingRoot();
	if (rendering !== undefined) rootRef.current = rendering.id; // idempotent render capture
	// eslint-disable-next-line react-hooks/exhaustive-deps
	React.useEffect(() => {
		const root = rootRef.current ?? ROOT_UNKNOWN;
		let cleanup: void | (() => void);
		let disposed = false;
		const id = shim.registerEffect(root, () => {
			if (disposed) return;
			if (typeof cleanup === 'function') cleanup();
			fire();
		});
		const fire = (): void => {
			shim.captureEffectRun(id, () => {
				cleanup = fn();
			});
		};
		fire();
		return () => {
			disposed = true;
			shim.unregisterEffect(id);
			if (typeof cleanup === 'function') cleanup();
		};
	}, deps === undefined ? undefined : [shim, ...deps]);
}

// ---- startSignalTransition ------------------------------------------------------------------

/**
 * Starts a transition action with the exact rule React's own startTransition
 * has. (A transition marks an update as non-urgent: React renders it in the
 * background while urgent updates keep landing and committing in between.)
 * `fn` receives no arguments and needs no special API: inside its
 * synchronous part the protocol's write-batch context IS the action's batch,
 * so ordinary `atom.set` / `atom.update` / `ReducerAtom.dispatch` calls
 * classify into it through the one write classifier — exactly like every
 * other write. Returning a promise parks the batch until it settles (React
 * async-action semantics), so pending state stays pending across the whole
 * action. Writes after an `await` classify like any other write at that
 * moment — urgent unless re-wrapped in a fresh startTransition — because
 * the async continuation runs on a fresh call stack with no ambient
 * transition context: the same rule, for the same reason, as React's own
 * transitions (a bare post-await write while an action is pending gets a
 * development warning).
 */
export function startSignalTransition(fn: () => unknown): void {
	const shim = requireShim();
	// BATCH_NONE ("no renderer provider registered") is unreachable once a
	// renderer has loaded, and it is a global condition — none here means
	// none inside the transition scope too. The dev check throws HERE, before
	// React.startTransition, because startTransition reports a sync throw
	// from its scope as an uncaught error instead of propagating it.
	if (shim.devChecks && React.unstable_getCurrentWriteBatch() === BATCH_NONE) {
		throw new Error('cosignal: no transition batch context — the renderer did not provide an external-runtime write batch.');
	}
	React.startTransition((): void => {
		// The action's batch context is React's own transition scope: inside
		// this callback unstable_getCurrentWriteBatch() returns the
		// transition batch's id — the engine BatchId the shim's allocator
		// handed out at the batch's creation — and the shim's classifier
		// routes every write executed here into that batch.
		const batchId = React.unstable_getCurrentWriteBatch();
		// Upgrade the batch to action semantics NOW (parked — kept pending —
		// until the action settles), before fn writes anything: the parked
		// batch holds the pending window open for the action's whole life,
		// even for an action that only writes after its first await. With no
		// batch context (BATCH_NONE, dev checks off) there is no batch to park:
		// the action runs and its writes classify as they land — ordinary
		// no-context writes, the same fall-through as the write classifier —
		// rather than creating a parked batch nothing could ever settle.
		if (batchId !== BATCH_NONE) shim.upgradeToAction(batchId);
		// Returning fn's thenable keeps the transition pending until it settles
		// (React async-action semantics); the protocol host retires the batch
		// at settlement, which is when its writes become permanent history.
		return fn() as undefined;
	});
}
