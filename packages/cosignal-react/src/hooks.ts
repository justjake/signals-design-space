/**
 * cosignal-react — the hook surface: useSignal, useComputed, useReducerAtom,
 * useSignalEffect, startSignalTransition, plus registerCosignalReact — the
 * activation call that arms the logged engine (`cosignal/logged`) and
 * couples it to a protocol-v1 React build via the Shim.
 *
 * Watcher lifecycle, shared by the subscription hooks (a watcher is the
 * engine's record of one subscribed component instance): render mints (or
 * re-tracks) a watcher in the current pass's world, so the component reads
 * the view of the render it is part of; the layout effect claims the
 * subscription after commit (StrictMode's double-mount nets to one live
 * watcher via microtask-debounced unsubscription); the mount fixup — the
 * engine's commit-time reconciliation of a freshly mounted component
 * against updates that were in flight while it mounted — runs inside the
 * bridge at the commit edge, and its corrective re-renders and urgent
 * corrections reach React as pre-paint setStates through the shim.
 */

import * as React from 'react';
import { Atom, ReducerAtom, SuspendedRead, registerReactBridge } from 'cosignal/logged';
import type { AnyNode, AtomNode, ComputedNode, CosignalBridge, RootId } from 'cosignal/logged';
import { Shim, getActiveShim, setActiveShim, type BoundCtx, type WatcherTarget } from './shim.js';

// ---- activation -------------------------------------------------------------------

export type CosignalReactHandle = {
	bridge: CosignalBridge;
	shim: Shim;
	dispose: () => void;
};

/**
 * Activates the bindings: arms the logged engine's write recording (once
 * per process) and subscribes the shim to the external-runtime protocol
 * events. Call during app setup, after importing react-dom/client (the
 * renderer must have registered its protocol provider first), before
 * rendering any root; throws on stock React — see assertForkProtocol.
 * `opts.bridge` injects a pre-built bridge (tests use
 * `__newBridgeForTest()` instances).
 */
export function registerCosignalReact(opts?: { bridge?: CosignalBridge }): CosignalReactHandle {
	if (getActiveShim() !== undefined) {
		throw new Error('cosignal-react: already registered (dispose the previous registration first).');
	}
	const bridge = opts?.bridge ?? registerReactBridge();
	if (bridge.mode !== 'logged') bridge.registerBridge();
	const shim = new Shim(bridge);
	setActiveShim(shim);
	return {
		bridge,
		shim,
		dispose: () => {
			shim.dispose();
			if (getActiveShim() === undefined) setActiveShim(undefined);
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

// ---- bound computed handle ------------------------------------------------------------

/** The handle useComputed returns: a world-routed readable signal. */
export class BoundComputed<T> {
	/** @internal */
	readonly _node: ComputedNode;
	/** @internal */
	readonly _shim: Shim;
	constructor(node: ComputedNode, shim: Shim) {
		this._node = node;
		this._shim = shim;
	}
	/** World-routed read (frame > effect capture > pass world > newest). */
	get state(): T {
		return this._shim.routeComputedRead(this._node) as T;
	}
}

export type SignalSource<T> = Atom<T> | ReducerAtom<T, unknown> | BoundComputed<T>;

function resolveNode(shim: Shim, signal: SignalSource<unknown>): AnyNode {
	if (signal instanceof BoundComputed) {
		if (signal._shim !== shim) throw new Error('cosignal-react: BoundComputed belongs to a disposed registration.');
		return signal._node;
	}
	if (signal instanceof Atom) return shim.nodeForAtom(signal as Atom<unknown>);
	throw new Error(
		'cosignal-react: useSignal accepts Atom/ReducerAtom handles or useComputed results. ' +
			"Standalone Computed instances cannot be routed to a render's world — wrap the computation in useComputed.",
	);
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

/** Unwraps a pending read's SuspendedRead carrier into its thenable and throws that, so React suspends the component. */
function readSuspending(fn: () => unknown): unknown {
	try {
		return fn();
	} catch (err) {
		if (err instanceof SuspendedRead) throw err.thenable;
		throw err;
	}
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
	// teardown (finalized at the next layout effect) and mint a fresh one.
	if (state.current !== null && state.current.node !== node) {
		state.retired.push(state.current);
		state.current = null;
	}
	if (state.current === null) state.current = makeRec(node, () => force());
	const rec = state.current;

	const rendering = shim.renderingRoot();
	const bridge = shim.bridge;
	let value: unknown;
	if (rendering?.pass !== undefined && rendering.pass.state !== 'ended') {
		const pass = rendering.pass;
		rec.root = rendering.id;
		const w = rec.watcherId === undefined ? undefined : bridge.watchers.get(rec.watcherId);
		if (w === undefined) {
			// Mount: mint the watcher in this pass's world; the value it renders
			// is captured so the commit-edge fixup can compare against it.
			value = readSuspending(() =>
				shim.evaluateSuspending(() => {
					const minted = bridge.mountWatcher(pass.id, node, 'w?');
					minted.name = `w${minted.id}`;
					rec.watcherId = minted.id;
					shim.targets.set(minted.id, rec.target);
					shim.noteMinted(rendering, minted.id);
					return minted.lastRenderedValue;
				}),
			);
		} else if (w.live) {
			// Re-render: re-arm the watcher's delivery dedup and read this pass's world.
			bridge.renderWatcher(pass.id, w.id);
			value = readSuspending(() => shim.evaluateSuspending(() => bridge.passValue(node, pass)));
		} else {
			// Reveal-shaped re-render (previously hidden content shown again, e.g.
			// React Activity/Offscreen): adopt the dormant watcher into this pass
			// so the commit-edge mount fixup reconciles it — against batches this
			// render did not include, and against committed state — as if it were
			// a fresh mount.
			bridge.adoptMount(pass.id, w.id);
			shim.noteMinted(rendering, w.id);
			value = readSuspending(() => shim.evaluateSuspending(() => bridge.passValue(node, pass)));
		}
	} else {
		// Render outside a tracked pass (defensive): unrouted newest read.
		value = readSuspending(() => shim.evaluateSuspending(() => bridge.newestValue(node)));
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
				if (rec.pendingUnsub) shim.finalizeUnsub(rec);
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
 * minted); when `deps` change, a fresh node capturing the new closure is
 * created in work-in-progress hook state — adopted if the render commits,
 * dropped if the render is discarded. Returns a handle whose `.state` reads
 * in the current render's world.
 *
 * Recreating instead of swapping the function in place is deliberate: a
 * node's evaluating function must stay immutable for the node's whole life,
 * because pending worlds replay evaluation — if a live node's function
 * could change, one world could observe another closure's output. A changed
 * function therefore only takes effect through changed deps (the useMemo
 * rule). Inside `fn`, ctx.previous is a hint carrying the last committed
 * value (possibly stale or undefined) and ctx.use(thenable) reads async
 * data, suspending the component via React Suspense while pending.
 */
export function useComputed<T>(fn: (ctx: BoundCtx<T>) => T, deps: readonly unknown[]): BoundComputed<T> {
	const shim = requireShim();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	return React.useMemo(
		() => new BoundComputed<T>(shim.makeComputedNode(`useComputed#${nextComputedSerial++}`, fn, deps), shim),
		// The user's deps ARE the memo key: a changed fn takes effect only with changed deps.
		[shim, ...deps],
	);
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
		const root = rootRef.current ?? 'root-unknown';
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

export type ActionScope = {
	/** Classifies the write into the action's batch, from anywhere — including after an await. Throws once the action has settled. */
	set<T>(atom: Atom<T>, value: T): void;
	dispatch<S, A>(atom: ReducerAtom<S, A>, action: A): void;
};

/**
 * Starts a transition action with the exact rule React's own startTransition
 * has. (A transition marks an update as non-urgent: React renders it in the
 * background while urgent updates keep landing and committing in between.)
 * Writes in the synchronous part of `fn` classify into the transition's
 * batch and render as one pending update. Returning a promise parks the
 * batch until it settles (React async-action semantics), so pending state
 * stays pending across the whole action. Writes after an `await` are
 * urgent/ambient unless re-wrapped, because the async continuation runs on
 * a fresh call stack with no ambient transition context — the same rule,
 * for the same reason, as React's own transitions; use the ActionScope
 * passed to `fn` (`scope.set` / `scope.dispatch`) to classify them into the
 * action's batch explicitly. Scope methods throw once the action settles.
 */
export function startSignalTransition(fn: (scope: ActionScope) => unknown): void {
	const shim = requireShim();
	React.startTransition((): void => {
		const forkToken = React.unstable_getCurrentWriteBatch();
		const tokenId = forkToken === 0 ? undefined : shim.bridgeTokenFor(forkToken, { action: true });
		const scope: ActionScope = {
			set: (atom, value) => {
				if (tokenId === undefined) throw new Error('cosignal: no transition batch context — the renderer did not provide an external-runtime write batch.');
				shim.scopeWrite(tokenId, shim.nodeForAtom(atom as Atom<unknown>), { kind: 'set', value });
			},
			dispatch: (atom, action) => {
				if (tokenId === undefined) throw new Error('cosignal: no transition batch context — the renderer did not provide an external-runtime write batch.');
				shim.scopeWrite(tokenId, shim.nodeForAtom(atom as unknown as Atom<unknown>), { kind: 'dispatch', action });
			},
		};
		// Returning fn's thenable keeps the transition pending until it settles
		// (React async-action semantics); the protocol host retires the batch
		// at settlement, which is when its writes become permanent history.
		return fn(scope) as undefined;
	});
}
