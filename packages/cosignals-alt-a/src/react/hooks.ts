/**
 * The hook surface (§4.5/§13), deliberately THIN: this engine already owns
 * worlds, visibility, per-root committed views, broadcast lanes, and the
 * post-subscribe fixup — so the hooks only (1) read `.state` during render
 * (the bridge keeps the engine's ambient read context on RENDER, so a plain
 * read resolves the pass's world Wp), (2) claim an engine watcher at the
 * commit edge via `engine.subscribeWithFixup` (which runs the §13.2
 * world-aware fixup and entangles corrections itself), and (3) route
 * committed effects through `engine.committedEffect` (per-root views,
 * §13.4). Broadcast lane inheritance needs nothing here: the engine fires
 * watcher callbacks inside registry batch scopes, so the hook's
 * setState lands in the writing batch's own lanes automatically.
 */
import * as React from 'react'
import type { Container, CosignalEngine, SignalHandle, WatcherHandle } from '../engine'
import {
	isErrorBox,
	isSuspendedBox,
	type AtomOptions,
	type ComputedCtx,
	type CosignalAPI,
} from '../api'
import { attachReactBridge, type ReactBridgeHandle } from './bridge'

// ---- registration -----------------------------------------------------------------

export type AltAReactHandle = {
	api: CosignalAPI
	engine: CosignalEngine
	bridge: ReactBridgeHandle
	dispose(): void
}

let active: AltAReactHandle | undefined

/**
 * Activates the bindings for one engine composition: attaches the real-React
 * bridge (write classification, pass lifecycle, per-root commits) and makes
 * the hooks serve this API. Call after importing react-dom/client, before
 * rendering any root. Throws on stock React.
 */
export function registerAltAReact(api: CosignalAPI, react?: unknown): AltAReactHandle {
	if (active !== undefined) {
		throw new Error(
			'cosignals-alt-a/react: already registered — dispose the previous registration first.',
		)
	}
	const bridge = attachReactBridge(api.engine, react)
	const handle: AltAReactHandle = {
		api,
		engine: api.engine,
		bridge,
		dispose(): void {
			bridge.dispose()
			if (active === handle) {
				active = undefined
			}
		},
	}
	active = handle
	return handle
}

function requireActive(): AltAReactHandle {
	if (active === undefined) {
		throw new Error('cosignals-alt-a/react: registerAltAReact() must run before using the hooks.')
	}
	return active
}

// ---- sources ---------------------------------------------------------------------

/** Anything readable: the §4 classes (with `.handle`) or a raw engine handle. */
export type SignalSource<T> = { readonly state: T } & ({ handle: SignalHandle } | { id: number })

function handleOf(source: SignalSource<unknown>): SignalHandle {
	return 'handle' in source ? source.handle : source
}

/** Read for render: §4 class getters already unbox (throw errors, suspend on
 * thenables); raw engine handles hand back §11.3 boxes — unbox here so a
 * suspended computed suspends the component either way. */
function readForRender<T>(source: SignalSource<T>, isTransitionRender: () => boolean): T {
	// THE CONTEXT-SENSITIVE TWO-LEVEL SUSPENSE RULE (owner amendment):
	//  (a) transition render pass → ALWAYS hand the thenable to React.use():
	//      React holds old UI natively (no flash) and the transition waits
	//      for settlement — use(P) consumers and signals consumers suspend on
	//      the same promise, so they commit together (no tearing, no early
	//      stale commit);
	//  (b) urgent/sync render with a latest → serve latest (+ isPending as
	//      the indicator opt-in) — no fallback flash;
	//  (c) never-settled → suspend everywhere.
	// §4 class getters implement the same rule; raw engine handles unbox here.
	const v = source.state
	if (isErrorBox(v)) {
		throw v.error
	}
	if (isSuspendedBox(v)) {
		if (v.hasLatest && !isTransitionRender()) {
			return v.latest as T
		}
		throw v.gate // settlement-ordered, identity-stable (see SuspendedBox.gate)
	}
	return v
}

// ---- useSignal --------------------------------------------------------------------

type WatchRec = {
	handleId: number
	watcher: WatcherHandle | undefined
	pendingUnsub: boolean
	rendered: { pin: number; tokens: readonly number[]; value: unknown; container?: Container }
}

/**
 * Subscribes the component to a signal and returns its value for the current
 * render's world (§13.2). The render read is a plain `.state` — the bridge
 * keeps the ambient context on RENDER during passes, so world resolution is
 * entirely engine-side. The commit-phase layout effect claims an engine
 * watcher through `subscribeWithFixup`, whose two world-aware checks close
 * the render→subscribe gap (urgent pre-paint correction; entangled
 * corrective re-renders into still-pending batches).
 */
export function useSignal<T>(source: SignalSource<T>): T {
	const { engine } = requireActive()
	const h = handleOf(source)
	const [, force] = React.useReducer((c: number) => c + 1, 0)
	const ref = React.useRef<{ current: WatchRec | null; retired: WatchRec[] } | null>(null)
	if (ref.current === null) {
		ref.current = { current: null, retired: [] }
	}
	const state = ref.current
	if (state.current !== null && state.current.handleId !== h.id) {
		state.retired.push(state.current)
		state.current = null
	}
	if (state.current === null) {
		state.current = {
			handleId: h.id,
			watcher: undefined,
			pendingUnsub: false,
			rendered: { pin: 0, tokens: [], value: undefined },
		}
	}
	const rec = state.current

	const value = readForRender(source, engine.policy.inTransitionRender)
	// Remember the rendered world for the commit-edge fixup (§13.2).
	const info = engine.renderInfo()
	rec.rendered =
		info !== undefined
			? { pin: info.pin, tokens: info.tokens, value, container: info.container }
			: { pin: engine.debug.seqCounter(), tokens: [], value }

	React.useLayoutEffect(() => {
		rec.pendingUnsub = false
		for (const old of state.retired.splice(0)) {
			old.watcher?.dispose()
			old.watcher = undefined
		}
		if (rec.watcher === undefined) {
			// The engine runs the fixup and entangles corrections itself; the
			// callback only bumps (already inside the right runInBatch scope).
			rec.watcher = engine.subscribeWithFixup(h, rec.rendered, () => force())
		}
		return () => {
			// Microtask-debounced unsubscribe: StrictMode's synchronous
			// unmount+remount pair nets to one live watcher.
			rec.pendingUnsub = true
			queueMicrotask(() => {
				if (rec.pendingUnsub) {
					rec.watcher?.dispose()
					rec.watcher = undefined
					rec.pendingUnsub = false
				}
			})
		}
	}, [engine, rec, h.id])

	return value
}

// ---- useAtom / useReducerAtom ------------------------------------------------------

/** Component-owned atom (§4.5): like useState but the value is a signal any
 * computed can read. Created on mount, reclaimed after unmount. */
export function useAtom<T>(
	options: AtomOptions<T>,
): InstanceType<CosignalAPI['Atom']> & { state: T } {
	const { api, engine } = requireActive()
	const [atom] = React.useState(() => new api.Atom<T>(options))
	React.useEffect(
		() => () => {
			queueMicrotask(() => {
				// A never-materialized lazy atom has no engine node: reclaiming
				// would RUN the initializer just to mint-and-free. Skip it.
				if ((atom as { materialized?: boolean }).materialized === false) {
					return
				}
				engine.reclaim(atom.handle) // after StrictMode settles
			})
		},
		[engine, atom],
	)
	return atom as InstanceType<CosignalAPI['Atom']> & { state: T }
}

/** Component-owned reducer atom (§4.5): [value, dispatch] with useReducer
 * parity — actions replay per world (§12.2). */
export function useReducerAtom<S, A>(
	reducer: (state: S, action: A) => S,
	initial: S,
): [S, (action: A) => void] {
	const { api } = requireActive()
	const [record] = React.useState(() => ({
		atom: new api.ReducerAtom<S, A>({ state: initial, reducer }),
	}))
	const value = useSignal<S>(record.atom)
	const dispatch = React.useCallback((action: A) => record.atom.dispatch(action), [record])
	return [value, dispatch]
}

// ---- useComputed ------------------------------------------------------------------

/**
 * Like useMemo, but re-renders the component when a signal read inside `fn`
 * changes (§4.5). `fn` closes over props/state freely — that is what `deps`
 * is for; signal reads are auto-tracked and NOT listed in deps. A changed fn
 * takes effect only through changed deps (nodes' functions are immutable —
 * worlds replay evaluations).
 */
export function useComputed<T>(
	fn: (ctx: ComputedCtx<T>) => T,
	deps: readonly unknown[],
	options?: { isEqual?: (a: T, b: T) => boolean; label?: string },
): T {
	const { api, engine } = requireActive()
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const computed = React.useMemo(
		() => new api.Computed<T>({ fn, isEqual: options?.isEqual, label: options?.label }),
		[api, ...deps],
	)
	const prevRef = React.useRef<{ handle: SignalHandle } | null>(null)
	React.useEffect(() => {
		const prev = prevRef.current
		prevRef.current = computed
		if (prev !== null && prev !== computed) {
			engine.reclaim(prev.handle) // superseded node: deterministic reclaim (§14.2)
		}
		return undefined
	}, [engine, computed])
	return useSignal<T>(computed)
}

// ---- useSignalEffect ---------------------------------------------------------------

/**
 * Like useEffect, but also re-runs when the COMMITTED value of anything it
 * tracked changes (§13.4): reads inside `fn` resolve the owning root's
 * committed view and re-fire after that root's commits — never pending
 * state. `deps` changes re-run it through React's own machinery.
 */
export function useSignalEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
	const { engine, bridge } = requireActive()
	const containerRef = React.useRef<Container>(undefined)
	const ctx = bridge.engine === engine ? engine.renderInfo() : undefined
	if (ctx !== undefined) {
		containerRef.current = ctx.container
	}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	React.useEffect(
		() => engine.committedEffect(containerRef.current, fn),
		deps === undefined ? undefined : [engine, ...deps],
	)
}

// ---- useCommitted -------------------------------------------------------------------

/**
 * Reactive committed read (§13.4 family): renders what is ON SCREEN — the
 * owning root's committed view of `source` — and re-renders after commits
 * that change it. The reactive counterpart of api.committed; drafts and
 * pending state never appear (a committed pending box serves its carried
 * latest, or undefined before first settlement).
 */
export function useCommitted<T>(source: SignalSource<T>): T | undefined {
	const { api, engine, bridge } = requireActive()
	const h = handleOf(source)
	const containerRef = React.useRef<Container>(undefined)
	const ctx = bridge.engine === engine ? engine.renderInfo() : undefined
	if (ctx !== undefined) {
		containerRef.current = ctx.container
	}
	const [, force] = React.useReducer((c: number) => c + 1, 0)
	const value = api.committed<T>(h, containerRef.current)
	// Two subscriptions close the loop:
	//  - a W0 effect DRIVES renders when the value changes (a lone
	//    useCommitted consumer otherwise never re-renders — no watcher, no
	//    commit, no committed movement);
	//  - the committedEffect recheck advances the render one more step
	//    after each commit (the render that a W0 change forces still reads
	//    the PRE-commit view — "on screen" trails by exactly one commit).
	// eslint-disable-next-line react-hooks/exhaustive-deps
	React.useEffect(() => {
		let first = true
		const disposeW0 = engine.effect(() => {
			void (h as { state?: unknown }).state // raw read: boxes never throw
			if (first) {
				return // the mount run
			}
			force()
		})
		first = false
		let firstCommitted = true
		const disposeCommitted = engine.committedEffect(containerRef.current, () => {
			// Tracked committed read: registers the leaf dependency set the
			// recheck watches.
			void (h as { state?: unknown }).state
			if (firstCommitted) {
				firstCommitted = false
				return
			}
			force()
		})
		return () => {
			disposeW0()
			disposeCommitted()
		}
	}, [engine, h.id])
	return value
}

// ---- useIsPending -------------------------------------------------------------------

/** Reactive pending indicator: flips only on pending↔settled transitions of
 * the source (the api.isPending probe subscribed like any signal). */
export function useIsPending(source: SignalSource<unknown>): boolean {
	const { api } = requireActive()
	const probe = React.useMemo(() => api.pendingProbe(handleOf(source)), [api, source])
	return useSignal<boolean>(probe)
}

// ---- transitions --------------------------------------------------------------------

/**
 * `startTransition` plus the engine's `batch()` (§13.6): the batch groups
 * the scope's walks and broadcasts into one drain (one setState per watcher
 * per batch), and every write inside classifies into the transition through
 * the ordinary write classifier. Returning a promise keeps the transition
 * pending until it settles (React async-action semantics — the fork retires
 * the batch at settlement). Not required for correctness — plain
 * startTransition works — this is the throughput helper.
 */
export function startSignalTransition(scope: () => unknown): void {
	const { api } = requireActive()
	React.startTransition((): void => {
		let result: unknown
		api.batch(() => {
			result = scope()
		})
		return result as undefined // a thenable keeps the action pending
	})
}

/** `useTransition` wrapped the same way; `isPending` is React's own. */
export function useSignalTransition(): [boolean, (scope: () => unknown) => void] {
	const { api } = requireActive()
	const [isPending, start] = React.useTransition()
	const startSignal = React.useCallback(
		(scope: () => unknown) => {
			start((): void => {
				let result: unknown
				api.batch(() => {
					result = scope()
				})
				return result as undefined
			})
		},
		[api, start],
	)
	return [isPending, startSignal]
}
