/**
 * cosignal-react — the v1 hook surface (spec §3.2/§3.3/§3.4/§3.5):
 * useSignal, useComputed (deps-keyed recreation, cut C3), useReducerAtom,
 * useSignalEffect (committed-for-root, §5.11), startSignalTransition
 * (ActionScope, §3.5), plus registerCosignalReact — the binding activation
 * that arms the LOGGED engine and couples it to the fork via the Shim.
 *
 * Watcher lifecycle (§5.10/§5.11): render mints/tracks the watcher in the
 * current pass's world (rendered-world read); the layout effect claims the
 * subscription (StrictMode double-mount nets to one via microtask-debounced
 * unsubscription); the mount fixup itself runs bridge-side at the commit's
 * pass end — the pinned baseline site — and its correctives/urgent
 * corrections arrive as pre-paint setStates through the shim.
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
 * Activates the bindings (spec §3.2 `registerReactBridge(fork)` spelling):
 * arms the LOGGED engine (once per process via cosignal's public rule) and
 * subscribes the fork shim. Call during app setup, after importing
 * react-dom/client, before rendering any root. `opts.bridge` injects a
 * pre-built bridge (tests use `__newBridgeForTest()` instances).
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

// ---- bound computed handle (§3.3) ---------------------------------------------------

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
			'Standalone Computed instances are not world-routable in v1 (kernel read routing is SPK-R) — wrap the computation in useComputed.',
	);
}

// ---- useSignal (§3.2, §5.10, §5.11) --------------------------------------------------

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

/** Throws the capsule thenable so React suspends (§5.8 render-read tail). */
function readSuspending(fn: () => unknown): unknown {
	try {
		return fn();
	} catch (err) {
		if (err instanceof SuspendedRead) throw err.thenable;
		throw err;
	}
}

/**
 * Subscribe + rendered-world read + mount fixup wiring (§5.10 with the
 * oracle errata — the fixup itself runs bridge-side at the commit edge).
 */
export function useSignal<T>(signal: SignalSource<T>): T {
	const shim = requireShim();
	const node = resolveNode(shim, signal as SignalSource<unknown>);
	const [, force] = React.useReducer((c: number) => c + 1, 0);
	const ref = React.useRef<SignalRefState | null>(null);
	if (ref.current === null) ref.current = { current: null, retired: [] };
	const state = ref.current;

	// Signal identity changed across renders: retire the old subscription (it
	// finalizes at the next layout effect) and mint a fresh one.
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
			// Mount: mint the watcher in this pass's world (§5.10 render capture).
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
			// Re-render: dedup bits re-arm; value = this pass's world (§5.9/§5.3).
			bridge.renderWatcher(pass.id, w.id);
			value = readSuspending(() => shim.evaluateSuspending(() => bridge.passValue(node, pass)));
		} else {
			// Reveal-shaped re-render (Offscreen/Activity): adopt into this pass —
			// its commit runs the fixup with a failing pass-id conjunct (§5.10).
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
			// Microtask-debounced unsubscribe: StrictMode's double-mount and
			// Activity hide/reveal net out before the debounce fires (§5.11).
			rec.pendingUnsub = true;
			queueMicrotask(() => {
				if (rec.pendingUnsub) shim.finalizeUnsub(rec);
			});
		};
	}, [shim, rec]);

	return value as T;
}

// ---- useComputed (§3.3 — deps-keyed recreation, cut C3) ------------------------------

let nextComputedSerial = 1;

/**
 * useMemo semantics applied to node identity: equal deps return the existing
 * node (nothing minted); changed deps create a fresh node capturing the new
 * closure in WIP hook state — commit adopts it, discard drops it. The node's
 * evaluating function is immutable for its whole life.
 */
export function useComputed<T>(fn: (ctx: BoundCtx<T>) => T, deps: readonly unknown[]): BoundComputed<T> {
	const shim = requireShim();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	return React.useMemo(
		() => new BoundComputed<T>(shim.makeComputedNode(`useComputed#${nextComputedSerial++}`, fn, deps), shim),
		// The user's deps ARE the memo key (cut C3): fn changes ride deps.
		[shim, ...deps],
	);
}

// ---- useReducerAtom (§3.2) -----------------------------------------------------------

let warnedReducerSwap = false;

/**
 * Creates the reducer atom once for the component's lifetime; the reducer is
 * fixed at creation (§3.1) — a render passing a different reducer function
 * does not swap it (dev-warns once). Returns [value, dispatch] with
 * useReducer parity scoped to stable reducers.
 */
export function useReducerAtom<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, (action: A) => void] {
	const [record] = React.useState(() => ({ atom: new ReducerAtom<S, A>(reducer, initial), reducer }));
	if (record.reducer !== reducer && !warnedReducerSwap) {
		warnedReducerSwap = true;
		// eslint-disable-next-line no-console
		console.warn('cosignal: useReducerAtom reducers are fixed at creation (§3.2) — remount with a key to change reducers.');
	}
	const value = useSignal(record.atom as unknown as Atom<S>);
	const dispatch = React.useCallback((action: A) => record.atom.dispatch(action), [record]);
	return [value, dispatch];
}

// ---- useSignalEffect (§3.2 / §5.11) ---------------------------------------------------

/**
 * Observes committed-for-root state only: the effect body's signal reads
 * resolve in the committed world of the component's root, and the effect
 * re-fires when a durable flip (retirement, per-root commit, settlement,
 * root commit) moves any of its (node, fingerprint) snapshot pairs. Deps
 * changes ride React's native effect re-fire.
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

// ---- startSignalTransition (§3.5) ------------------------------------------------------

export type ActionScope = {
	/** Classifies the write into the action's token, from anywhere (§3.2). */
	set<T>(atom: Atom<T>, value: T): void;
	dispatch<S, A>(atom: ReducerAtom<S, A>, action: A): void;
};

/**
 * Starts a transition action with React parity (§3.5): writes in the
 * synchronous prefix classify into the action's token; the returned thenable
 * parks the token until settlement (the fork retires it then); raw post-await
 * writes are ambient (React parity); scope writes classify explicitly and
 * throw once the action settles.
 */
export function startSignalTransition(fn: (scope: ActionScope) => unknown): void {
	const shim = requireShim();
	React.startTransition((): void => {
		const forkToken = React.unstable_getCurrentWriteBatch();
		const tokenId = forkToken === 0 ? undefined : shim.bridgeTokenFor(forkToken, { action: true });
		const scope: ActionScope = {
			set: (atom, value) => {
				if (tokenId === undefined) throw new Error('cosignal: no transition batch context (fork provider missing).');
				shim.scopeWrite(tokenId, shim.nodeForAtom(atom as Atom<unknown>), { kind: 'set', value });
			},
			dispatch: (atom, action) => {
				if (tokenId === undefined) throw new Error('cosignal: no transition batch context (fork provider missing).');
				shim.scopeWrite(tokenId, shim.nodeForAtom(atom as unknown as Atom<unknown>), { kind: 'dispatch', action });
			},
		};
		// Returning fn's thenable parks the transition lane (React async action);
		// the fork then retires the token at settlement (§4.1 fact 3).
		return fn(scope) as undefined;
	});
}
