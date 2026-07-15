/**
 * React hooks over the Solid core.
 *
 * Subscription discipline (the leak-safe two-phase read):
 * - Render reads values through `renderRead` (probe-tracked, zero residue).
 * - The commit's layout effect links the component's persistent reader node
 *   to the deps the render read, and runs the post-subscribe fixup: if the
 *   value moved in the rendered world between render and subscribe, or if a
 *   live deferred world disagrees with what was rendered, a corrective
 *   re-render is delivered in that world's own batch (via runInBatch), so it
 *   renders and commits WITH the batch instead of tearing beside it.
 * - Unmount releases the reader via a microtask-debounced disposal so
 *   StrictMode's simulated unmount+remount nets out to one live reader.
 */
import * as React from 'react'
import {
	activeBridge,
	attachBridge,
	PENDING,
	renderRead,
	type BridgeHandle,
	type ForkReact,
} from './bridge.js'
import {
	createReader,
	disposeReader,
	probeRead,
	syncReaderDeps,
	type DepNode,
	type ReaderNode,
} from './reader.js'
import { isPending as solidIsPending, latest as solidLatest, staleValues } from './solid/core.js'
import { NotReadyError } from './solid/error.js'
import { dispose } from './solid/owner.js'
import {
	activeTransition,
	currentTransition,
	setActiveTransition,
	type Transition,
} from './solid/scheduler.js'
import { $REFRESH } from './solid/constants.js'
import { createRoot } from './solid/owner.js'
import {
	createMemo,
	createSignal,
	createTrackedEffect,
	type Accessor,
	type MemoOptions,
	type Setter,
	type ComputeFunction,
} from './solid/signals.js'
import type { Computed } from './solid/types.js'

export function registerConcurrentSolidReact(react?: unknown): BridgeHandle {
	const b = attachBridge(react ?? React)
	return { errors: b.errors, dispose: () => b.dispose() }
}

interface SelectorEntry {
	reader: ReaderNode
	bump: () => void
	selector: () => unknown
	deps: DepNode[]
	world: Transition | null
	rendered: unknown // value, PENDING, or the thrown error
	releaseQueued: boolean
	disposed: boolean
}

/**
 * Evaluate `selector` in `world` for comparison purposes: pending collapses
 * to the PENDING sentinel, a thrown error to the error value itself.
 */
function probeValueInWorld(selector: () => unknown, world: Transition | null): unknown {
	const prev = activeTransition
	setActiveTransition(world ? currentTransition(world) : null)
	try {
		return staleValues(() => probeRead(selector)).value
	} catch (e) {
		return e instanceof NotReadyError ? PENDING : e
	} finally {
		setActiveTransition(prev ? currentTransition(prev) : null)
	}
}

function commitEntry(entry: SelectorEntry): void {
	entry.releaseQueued = false
	syncReaderDeps(entry.reader, entry.deps)
	const bridge = activeBridge()
	// Fixup 1: the rendered world moved between render and subscribe.
	const now = probeValueInWorld(entry.selector, entry.world)
	if (!Object.is(now, entry.rendered) && now !== PENDING) {
		if (bridge) {
			bridge.deliver(entry.bump, entry.world)
		} else {
			entry.bump()
		}
	}
	// Fixup 2: a live deferred world (not the one we rendered) disagrees with
	// what this commit shows — e.g. this component mounted urgently while a
	// transition is pending. Deliver the correction inside that batch so the
	// component joins the transition's own commit.
	if (bridge) {
		const renderedRoot = entry.world ? currentTransition(entry.world) : null
		const seen = new Set<Transition>()
		for (const rec of bridge.worlds.values()) {
			const root = currentTransition(rec.transition)
			if (root === renderedRoot || seen.has(root)) {
				continue
			}
			seen.add(root)
			const val = probeValueInWorld(entry.selector, root)
			if (!Object.is(val, entry.rendered) && val !== PENDING) {
				bridge.deliver(entry.bump, root)
			}
		}
	}
}

function scheduleRelease(entry: SelectorEntry): void {
	entry.releaseQueued = true
	queueMicrotask(() => {
		if (!entry.releaseQueued || entry.disposed) {
			return
		}
		entry.disposed = true
		disposeReader(entry.reader)
	})
}

/**
 * Subscribe this component to every reactive read inside `selector` and
 * return its value, resolved in the world of the current render pass
 * (committed values for urgent renders, staged values for transition
 * renders). Pending first loads suspend with a node-held stable thenable;
 * initialized-but-refetching values serve stale content instead.
 */
export function useSelector<T>(selector: () => T): T {
	const [, force] = React.useReducer((c: number) => (c + 1) | 0, 0)
	const ref = React.useRef<SelectorEntry | null>(null)
	if (ref.current === null || ref.current.disposed) {
		const entry: SelectorEntry = {
			reader: undefined as unknown as ReaderNode,
			bump: () => force(),
			selector: () => undefined,
			deps: [],
			world: null,
			rendered: undefined,
			releaseQueued: false,
			disposed: false,
		}
		entry.reader = createReader('useSelector', (urgent) => {
			const bridge = activeBridge()
			if (bridge) {
				bridge.deliver(entry.bump, urgent ? null : undefined, urgent)
			} else {
				entry.bump()
			}
		})
		ref.current = entry
	}
	const entry = ref.current
	entry.selector = selector

	let r = renderRead(selector)
	entry.deps = r.deps
	entry.world = r.world
	entry.rendered = r.errored ? r.error : r.value

	React.useLayoutEffect(() => {
		commitEntry(entry)
	})
	React.useLayoutEffect(() => () => scheduleRelease(entry), [])

	if (r.errored) {
		throw r.error
	}
	// Pending: hand the node-held thenable to React. `use()` (conditional call
	// is legal) suspends on an unsettled thenable and returns when it has
	// already settled — in which case the engine's settlement write has landed
	// and a re-read produces the value. Cap retries defensively; if the value
	// is still pending after a re-read (a new fetch started), suspend on the
	// new wait.
	const reactUse = (React as { use?: (t: PromiseLike<unknown>) => unknown }).use
	for (let attempt = 0; r.value === PENDING && attempt < 2; attempt++) {
		if (typeof reactUse !== 'function') {
			throw r.thenable
		}
		reactUse(r.thenable!)
		r = renderRead(selector)
		entry.deps = r.deps
		entry.world = r.world
		entry.rendered = r.errored ? r.error : r.value
		if (r.errored) {
			throw r.error
		}
	}
	if (r.value === PENDING) {
		throw r.thenable
	}
	return r.value
}

/** Read one accessor (see useSelector). */
export function useSignal<T>(accessor: Accessor<T>): T {
	return useSelector(accessor)
}

/**
 * Reactive "is this expression showing stale data while newer async is in
 * flight?" — false on first load, true during refetches (Solid's isPending).
 */
export function useIsPending(fn: () => unknown): boolean {
	return useSelector(() => solidIsPending(fn))
}

/**
 * Read through the in-flight overlay (Solid's latest): never suspends after
 * first load.
 */
export function useLatest<T>(fn: () => T): T {
	return useSelector(() => solidLatest(fn))
}

// Backstop for renders React discarded before any commit: when the holder is
// collected, the node it owned is unlinked from the graph. Deterministic
// disposal still happens in unmount cleanup for the committed path.
const reclaimRegistry = new FinalizationRegistry<Computed<any>>((node) => {
	try {
		dispose(node)
	} catch {
		/* the graph may already be gone in teardown */
	}
})

interface ComputedHolder<T> {
	accessor: Accessor<T>
	node: Computed<T>
	deps: React.DependencyList
	stale: ComputedHolder<T> | null
}

function reclaimHolder<T>(holder: ComputedHolder<T>): void {
	reclaimRegistry.unregister(holder)
	dispose(holder.node as Computed<unknown>)
}

function depsEqual(a: React.DependencyList, b: React.DependencyList): boolean {
	return a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
}

/**
 * A component-owned Solid memo (async-capable: return a promise/iterable and
 * the component suspends/serves-stale per the two-level rule). Signal reads
 * inside `fn` are tracked reactively and must NOT be listed in `deps`; `deps`
 * re-creates the node like useMemo. Disposed on unmount; a disposed node
 * revives automatically if React re-reads it (StrictMode remount).
 */
export function useComputed<T>(
	fn: ComputeFunction<undefined | T, T>,
	deps: React.DependencyList,
	options?: MemoOptions<T>,
): T {
	const ref = React.useRef<ComputedHolder<T> | null>(null)
	if (ref.current === null || !depsEqual(ref.current.deps, deps)) {
		const accessor = createMemo<T>(fn, options)
		const holder: ComputedHolder<T> = {
			accessor,
			node: (accessor as any)[$REFRESH] as Computed<T>,
			deps: [...deps],
			stale: ref.current,
		}
		reclaimRegistry.register(holder, holder.node, holder)
		ref.current = holder
	}
	const holder = ref.current
	React.useLayoutEffect(() => {
		if (holder.stale) {
			reclaimHolder(holder.stale)
			holder.stale = null
		}
	})
	React.useEffect(
		() => () => {
			if (ref.current) {
				reclaimHolder(ref.current)
				ref.current = null
			}
		},
		[],
	)
	return useSelector(holder.accessor)
}

/**
 * A component-owned signal, read reactively. Returns [value, setter]; the
 * setter participates in write classification like any signal write.
 */
export function useSignalState<T>(initial: T): [T, Setter<T>] {
	const [holder] = React.useState(() => {
		const [get, set] = createSignal<T>(initial as Exclude<T, Function>)
		return { get, set }
	})
	const value = useSelector(holder.get)
	return [value, holder.set]
}

/**
 * An effect that re-runs when the signals it reads change — observing
 * committed values only. Under the hood this is a Solid tracked effect:
 * during a live transition its re-runs are held in the transition's stash
 * (E10) and released at React's commit, so it can never see pending state.
 * May return a cleanup, which runs before each re-run and on unmount.
 */
export function useSignalEffect(fn: () => void | (() => void)): void {
	const fnRef = React.useRef(fn)
	fnRef.current = fn
	React.useEffect(() => {
		return createRoot((disposeRoot: () => void) => {
			createTrackedEffect(() => fnRef.current())
			return disposeRoot
		})
	}, [])
}

/**
 * React.useTransition, for symmetry: signal writes inside the callback are
 * classified into the transition automatically (write-time batch probing).
 */
export function useSignalTransition(): [boolean, (scope: () => void) => void] {
	const [pending, start] = React.useTransition()
	return [pending, start]
}
