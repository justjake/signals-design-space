/**
 * signals-royale-fx2 — the public API: atoms, computeds, effects, and
 * the read/write functions that connect them to React transitions.
 *
 * Base state lives in a conventional signal graph (graph.ts: lazy cached
 * computeds, effects, batching). React-transition support is a thin
 * overlay on top (worlds.ts): writes issued inside a transition are
 * recorded into a draft instead of hitting the atom, and readers resolve
 * values in a world — base state plus the drafts a specific render pass
 * is allowed to see. See the worlds.ts header for the full model; this
 * file only decides which path each read and write takes.
 */

import {
	type AtomNode,
	type ComputedNode,
	type EqualsFn,
	type Flags,
	type GraphChangeClock,
	type Link,
	type ProducerNode,
	type TraceEventId,
	type UseFn,
	Flag,
	NO_EVENT,
	UNINITIALIZED,
	assertSignalReadAllowed,
	assertSignalWriteAllowed,
	activeWorldSourceConsumer,
	activeEvaluation,
	currentCause,
	flushLifetimeTransitions,
	getActiveConsumer,
	isUninitialized,
	makeEffect,
	makeScope,
	peekAtom,
	readAtom,
	readComputed,
	runUpdater,
	trackWorldRead,
	startBatch as graphStartBatch,
	endBatch as graphEndBatch,
	batch as graphBatch,
	untracked as graphUntracked,
	traceHook,
	writeAtom,
} from './graph.ts'
import {
	type ErrorBox,
	type ResolvedState,
	type Suspension,
	baseUse,
} from './asyncs.ts'
import {
	type Draft,
	type DraftId,
	type World,
	BASE_WORLD,
	appendDraftIntent,
	appendUrgentIntent,
	atomHasDraftIntents,
	classifyWrite,
	committedWorldOf,
	computedHasDraftIntents,
	discardAllDrafts,
	getCurrentPark,
	getCurrentWorld,
	latestWorld,
	draftsAffecting,
	peekWorldMemo,
	pokeRebasedAtom,
	resolveState,
	resolveStateUntracked,
	setAmbientClassifier,
	trackWorldSources,
	unwrapForEval,
	worldOf,
} from './worlds.ts'
import { attachTracer, getActiveTracer, Tracer, type TraceEvent } from './tracer.ts'

// ---------------------------------------------------------------------------
// Public handle types
// ---------------------------------------------------------------------------

/** Options accepted by createAtom(). */
export interface AtomOptions<T> {
	/** Value equality for the cutoff; defaults to Object.is. */
	equals?: EqualsFn<T>
	/** Debug name shown in trace output. */
	label?: string
	/** Runs when the atom gains its first subscriber of any kind; the cleanup
	 * runs when the last subscriber of every kind is gone. */
	onObserved?: (ctx: { get(): T; set(v: T): void }) => void | (() => void)
}

/** Options accepted by createComputed(). */
export interface ComputedOptions<T> {
	/** Value equality for the cutoff; defaults to Object.is. */
	equals?: EqualsFn<T>
	/** Debug name shown in trace output. */
	label?: string
}

/** A writable reactive value. get() inside a computed, effect, or
 * subscribed component registers a dependency; peek() reads without
 * registering. */
export type Atom<in out T> = {
	get(): T
	set(value: T): void
	update(fn: (prev: T) => T): void
	peek(): T
}

// A class expression keeps the public structural Atom type separate from
// the private constructor while giving the runtime value the same name.
const Atom = class<T> implements AtomNode<T> {
	declare flags: Flags
	declare changedAtGraphChange: GraphChangeClock
	declare throwable: ErrorBox | Suspension | null
	declare subs: Link | undefined
	declare subsTail: Link | undefined
	declare observerCount: number
	declare causeEvent: TraceEventId
	declare label: string | undefined
	declare value: T | typeof UNINITIALIZED
	declare initializer: (() => T) | undefined
	declare equals: EqualsFn<T>
	declare lifetime: ((ctx: { get(): T; set(v: T): void }) => void | (() => void)) | undefined
	declare lifetimeCleanup: (() => void) | undefined
	declare lifetimeActive: boolean
	declare worldMemos: Map<string, unknown> | undefined

	constructor(initial: T | (() => T), opts?: AtomOptions<T>) {
		const lazyInit = typeof initial === 'function'
		this.flags = Flag.KindAtom
		this.changedAtGraphChange = 0
		this.throwable = null
		this.subs = undefined
		this.subsTail = undefined
		this.observerCount = 0
		this.causeEvent = NO_EVENT
		this.label = opts?.label
		this.value = lazyInit ? UNINITIALIZED : initial
		this.initializer = lazyInit ? (initial as () => T) : undefined
		this.equals = opts?.equals ?? Object.is
		this.lifetime = opts?.onObserved
		this.lifetimeCleanup = undefined
		this.lifetimeActive = false
		this.worldMemos = undefined
	}
	/** Tracked read. An active world (draft evaluation or committed-root
	 * effect) selects that world; otherwise this reads base state. */
	get(): T {
		const world = getCurrentWorld()
		if (world !== null) {
			// Every read within a selected world resolves that same world.
			const state = resolveState(this, world)
			trackWorldRead(this)
			return state.value as T
		}
		return readAtom(this)
	}
	set(value: T): void {
		set(this, value)
	}
	/** Functional update. Inside a transition the function itself is
	 * recorded and later replays against each world's starting value, the
	 * way React replays queued useState updaters. */
	update(fn: (prev: T) => T): void {
		update(this, fn)
	}
	/** Read the current world without registering a graph dependency. */
	peek(): T {
		const world = getCurrentWorld()
		if (world !== null) {
			return resolveStateUntracked(this, world).value as T
		}
		return peekAtom(this)
	}
}

/** An atom whose dispatches replay through one reducer fixed at creation. */
export type ReducerAtom<S, A> = Atom<S> & {
	dispatch: (action: A) => void
}

type ReducerAtomNode<S, A> = ReducerAtom<S, A> & {
	reduce: (state: S, action: A) => S
}

/** Shared by every reducer atom, avoiding one dispatch closure per atom.
 * TypeScript erases the fake `this` parameter. */
function dispatchReducer<S, A>(this: ReducerAtomNode<S, A>, action: A): void {
	const reduce = this.reduce
	this.update((state) => reduce(state, action))
}

/** A cached value derived from atoms and other computeds; recomputes
 * only when read after a dependency changed. */
export type Computed<out T> = {
	get(): T
	peek(): T
}

/** Apply computed read semantics to one world resolution. Kept separate so
 * tracked get() and untracked peek() cannot drift on async behavior. */
function unwrapComputedWorldState<T>(state: ResolvedState): T {
	const park = getCurrentPark()
	if (park !== null) {
		return unwrapForEval(state, park) as T
	}
	if ((state.flags & Flag.AsyncError) !== 0) {
		throw (state.throwable as ErrorBox).error
	}
	if ((state.flags & Flag.AsyncSuspended) !== 0 && isUninitialized(state.value)) {
		throw (state.throwable as Suspension).promise
	}
	return state.value as T
}

/** Computeds are plain node records. Every record points at this shared
 * function instead of allocating a get closure; TypeScript erases the
 * fake `this` parameter and normal method-call syntax supplies the node. */
function getComputed<T>(this: Computed<T> & ComputedNode<T>): T {
	const world = getCurrentWorld()
	if (world !== null) {
		// Every read within a selected world resolves that same world.
		const state = resolveState(this, world)
		trackWorldRead(this)
		if (activeWorldSourceConsumer !== null) {
			trackWorldSources(this, world)
		}
		return unwrapComputedWorldState<T>(state)
	}
	const value = readComputed(this)
	if ((this.flags & Flag.AsyncMask) !== 0) {
		return unwrapAsyncRead(this)
	}
	return value
}

/** Shared untracked counterpart to getComputed, likewise stored directly
 * on every computed record. */
function peekComputed<T>(this: Computed<T> & ComputedNode<T>): T {
	const world = getCurrentWorld()
	if (world !== null) {
		return unwrapComputedWorldState<T>(resolveStateUntracked(this, world))
	}
	return graphUntracked(() => this.get())
}

/** Any reactive value that can be tracked automatically. */
export type Signal<T> = Atom<T> | Computed<T>

export function createAtom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
	return new Atom(initial, opts)
}

export function reducerAtom<S, A>(
	reduce: (state: S, action: A) => S,
	initial: S | (() => S),
	opts?: AtomOptions<S>,
): ReducerAtom<S, A> {
	const node = new Atom(initial, opts) as unknown as ReducerAtomNode<S, A>
	node.reduce = reduce
	node.dispatch = dispatchReducer
	return node
}

export function createComputed<T>(
	fn: (use: UseFn, previous: T | undefined) => T,
	opts?: ComputedOptions<T>,
): Computed<T> {
	const node: Computed<T> & ComputedNode<T> = {
		flags: Flag.KindComputed | Flag.StaleDirty,
		changedAtGraphChange: 0,
		throwable: null,
		subs: undefined,
		subsTail: undefined,
		deps: undefined,
		depsTail: undefined,
		observerCount: 0,
		causeEvent: NO_EVENT,
		label: opts?.label,
		value: UNINITIALIZED,
		fn,
		equals: opts?.equals ?? Object.is,
		validAtGraphChange: 0,
		worldMemos: undefined,
		pokePass: 0,
		get: getComputed,
		peek: peekComputed,
	}
	return node
}

/** @internal Resolve a handle to its engine node. */
export function nodeOf(x: Signal<any>): ProducerNode {
	const node = x as unknown as ProducerNode
	if ((node.flags & (Flag.KindAtom | Flag.KindComputed)) !== 0) {
		return node
	}
	throw new TypeError('expected an atom or computed handle')
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Finish a computed read that found the node in an async state: rethrow
 * errors, park an evaluating consumer on the suspension, serve stale data
 * when a settled value exists, otherwise suspend (first load). */
function unwrapAsyncRead<T>(node: ComputedNode<T>): T {
	if ((node.flags & Flag.AsyncError) !== 0) {
		throw (node.throwable as ErrorBox).error
	}
	const suspension = node.throwable as Suspension
	const consumer = getActiveConsumer()
	if (consumer !== null && (consumer.flags & Flag.KindComputed) !== 0) {
		// Pending forwards: park the evaluating computed on this suspension.
		baseUse(suspension.promise, consumer as ComputedNode<unknown>)
	}
	if (!isUninitialized(node.value)) {
		return node.value as T
	} // stale serves
	throw suspension.promise // never settled: suspend
}

/** The value slot of a state view, with the uninitialized sentinel
 * normalized to undefined — latest() and committed() never suspend, so a
 * suspended state with no settled value reads as undefined there. */
function stateValue(st: ResolvedState): unknown {
	return isUninitialized(st.value) ? undefined : st.value
}

/** Read the newest view of x: base state plus every live draft. Never
 * suspends. That meaning only applies outside any evaluation or render —
 * inside one, latest() resolves that context's own world instead, because
 * reading ahead of your world would tear: a draft evaluation sees its
 * draft's world, a base-state computed or effect sees base state, and a
 * render pass sees the pass's world. */
export function latest<T>(x: Signal<T>): T {
	const node = nodeOf(x)
	let world = getCurrentWorld()
	const trackSelectedWorld = world !== null
	if (world === null) {
		if (getActiveConsumer() !== null) {
			// A base-state evaluation (computed or effect) is running. Its
			// world is base state, and this read is a real dependency: track
			// it so a later change to x re-runs the consumer rather than
			// leaving it permanently stale.
			world = BASE_WORLD
			if ((node.flags & Flag.KindAtom) !== 0) {
				readAtom(node as AtomNode<unknown>)
			} else {
				readComputed(node as ComputedNode<unknown>)
			}
		} else {
			world = renderWorld() ?? latestWorld()
		}
	} else {
		// Scheduled React effects select their root's committed world before
		// running. That world selection must not turn latest() into an
		// untracked read; trackWorldRead is a no-op outside a watcher.
		trackWorldRead(node)
	}
	const st = resolveState(node, world)
	if (
		trackSelectedWorld &&
		activeWorldSourceConsumer !== null &&
		(node.flags & Flag.KindComputed) !== 0
	) {
		trackWorldSources(node, world)
	}
	if ((st.flags & Flag.AsyncError) !== 0) {
		throw (st.throwable as ErrorBox).error
	}
	return stateValue(st) as T
}

/** What the committed screen shows for x — per root when a container is
 * given, base state otherwise. Never subscribes, never suspends. */
export function committed<T>(x: Signal<T>, container?: object): T {
	const node = nodeOf(x)
	if (activeEvaluation === node) {
		throw new Error(`cycle detected in computed${node.label ? ` "${node.label}"` : ''}`)
	}
	if (activeEvaluation !== null) {
		throw new Error(
			'committed() cannot be read inside a computed; read the dependency normally or use the previous argument for self history',
		)
	}
	const st = resolveState(node, committedWorldOf(container))
	if ((st.flags & Flag.AsyncError) !== 0) {
		throw (st.throwable as ErrorBox).error
	}
	return stateValue(st) as T
}

/** True while newer data exists behind what is on screen — a pending
 * transition draft on this atom, or an async refetch loading behind a
 * stale value. Passive by contract: never evaluates, never refetches,
 * never suspends. */
export function isPending(x: Signal<any>): boolean {
	return isPendingPassive(nodeOf(x), getCurrentWorld() ?? renderWorld())
}

/** Node-level pendingness probe, also used by the React bindings'
 * useIsPending. `world` scopes the suspended-memo check; null means
 * ambient. */
export function isPendingPassive(node: ProducerNode, world: World | null): boolean {
	assertSignalReadAllowed()
	if ((node.flags & Flag.KindAtom) !== 0) {
		return atomHasDraftIntents(node as AtomNode<unknown>)
	}
	if ((node.flags & Flag.KindComputed) === 0) {
		return false
	}
	// Pending means "stale data exists while newer data loads". A
	// suspension with settled history is pending; a first load is not — it
	// has no stale data to indicate over, and suspending is Suspense's
	// job, not the indicator's.
	if ((node.flags & Flag.AsyncSuspended) !== 0) {
		return !isUninitialized((node as ComputedNode<unknown>).value)
	}
	if (world !== null && world.drafts.length > 0) {
		const memo = peekWorldMemo(node, world.sig)
		if (memo !== undefined && (memo.flags & Flag.AsyncSuspended) !== 0) {
			return !isUninitialized(memo.value)
		}
	}
	// A drafted input anywhere in the dependency closure means newer data
	// is pending behind this computed's base value. Pendingness is
	// transitive: a computed over a pending source is itself pending.
	return computedHasDraftIntents(node as ComputedNode<unknown>)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Installed by the React bindings: throws when called during a render. */
let renderWriteGuard: (() => void) | null = null
export function setRenderWriteGuard(fn: (() => void) | null): void {
	renderWriteGuard = fn
}
function guardRenderWrite(): void {
	renderWriteGuard?.()
}

export function set<T>(x: Atom<T>, value: T): void {
	assertSignalWriteAllowed()
	guardRenderWrite()
	const atom = x as unknown as AtomNode<unknown>
	const draft = classifyWrite()
	if (draft !== null) {
		appendDraftIntent(draft, atom, 'set', value)
		return
	}
	// Urgent write: base state moves now, and pending worlds will replay
	// the intent in dispatch order.
	const rebased = appendUrgentIntent(atom, 'set', value)
	const changed = writeAtom(atom, value)
	// When the write was a base-state no-op (equality) but the atom has
	// pending drafts, the drafted replays still changed — their audiences
	// must hear about it even though no wave ran.
	if (rebased && !changed) {
		pokeRebasedAtom(atom)
	}
}

export function update<T>(x: Atom<T>, fn: (prev: T) => T): void {
	assertSignalWriteAllowed()
	guardRenderWrite()
	const atom = x as unknown as AtomNode<unknown>
	const draft = classifyWrite()
	if (draft !== null) {
		appendDraftIntent(draft, atom, 'update', fn)
		return
	}
	const previous = peekAtom(atom) as T
	let next: T
	try {
		next = runUpdater(fn, previous)
	} catch (error) {
		if (traceHook !== null) {
			traceHook('callback-error', activeEvaluation, currentCause, { error, phase: 'updater' })
		}
		throw error
	}
	const rebased = appendUrgentIntent(atom, 'update', fn)
	const changed = writeAtom(atom, next)
	if (rebased && !changed) {
		pokeRebasedAtom(atom)
	}
}

export function read<T>(x: Signal<T>): T {
	nodeOf(x) // validate the handle before dispatching to its read method
	return x.get()
}

// ---------------------------------------------------------------------------
// Effects, batching, untracked
// ---------------------------------------------------------------------------

export const effect: (fn: () => void | (() => void)) => () => void = makeEffect
export const effectScope: (fn: () => void) => () => void = makeScope
export const batch: <T>(fn: () => T) => T = graphBatch
export const startBatch: () => void = graphStartBatch
export const endBatch: () => void = graphEndBatch
export const untracked: <T>(fn: () => T) => T = graphUntracked

// ---------------------------------------------------------------------------
// SSR
// ---------------------------------------------------------------------------

/** Atoms under app-supplied keys: positional (array) or named (record). */
type AtomMap = Record<string, Atom<any>> | Atom<any>[]

/** Serialize base atom state under app-supplied keys. */
export function serializeAtomState(
	atoms: AtomMap,
	replacer?: (key: string, value: unknown) => unknown,
): string {
	const out: Record<string, unknown> = {}
	if (Array.isArray(atoms)) {
		for (let i = 0; i < atoms.length; i++) {
			out[i] = peekAtom(atoms[i] as unknown as AtomNode<unknown>)
		}
	} else {
		for (const key in atoms) {
			if (Object.prototype.hasOwnProperty.call(atoms, key)) {
				out[key] = peekAtom(atoms[key] as unknown as AtomNode<unknown>)
			}
		}
	}
	return JSON.stringify(out, replacer)
}

/** Install a value without running lazy initializers and without counting
 * as a write: no propagation, no equality check, no effects. */
export function installState<T>(atom: Atom<T>, value: T): void {
	assertSignalWriteAllowed()
	const node = atom as unknown as AtomNode<T>
	node.initializer = undefined
	node.value = value
}

export function initializeAtomState(
	json: string,
	atoms: AtomMap,
	reviver?: (key: string, value: unknown) => unknown,
): void {
	const data = JSON.parse(json, reviver) as Record<string, unknown>
	if (Array.isArray(atoms)) {
		for (let i = 0; i < atoms.length; i++) {
			if (Object.prototype.hasOwnProperty.call(data, i)) {
				installState(atoms[i], data[i])
			}
		}
	} else {
		for (const key in atoms) {
			if (
				Object.prototype.hasOwnProperty.call(atoms, key) &&
				Object.prototype.hasOwnProperty.call(data, key)
			) {
				installState(atoms[key], data[key])
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

export { attachTracer, getActiveTracer, Tracer }
export type { TraceEvent }

// ---------------------------------------------------------------------------
// Render-world provider, installed by the ./react bindings (which import
// engine modules directly — the react directory is part of this library).
// ---------------------------------------------------------------------------

/** Answers "what world is rendering right now":
 * - draft ids: the current render pass declared its world and the
 *   declaration is still valid;
 * - 'base': a component render is executing but no valid declaration
 *   exists (it expired or belongs to another pass). Plain latest() and
 *   isPending() calls must then fall back to base state — wrong-toward-
 *   base is safe, while reading a stale world or reading ahead into live
 *   drafts is not;
 * - null: no render is executing, so ambient reads see the newest view.
 * A provider function rather than a sticky setter, because only the React
 * host knows when React is rendering and which declarations a pass
 * refreshed. */
let renderWorldProvider: (() => readonly DraftId[] | 'base' | null) | null = null

export function setRenderWorldProvider(
	fn: (() => readonly DraftId[] | 'base' | null) | null,
): void {
	renderWorldProvider = fn
}

function renderWorld(): World | null {
	if (renderWorldProvider === null) {
		return null
	}
	const ids = renderWorldProvider()
	if (ids === null) {
		return null
	}
	if (ids === 'base') {
		return BASE_WORLD
	}
	return worldOf(ids)
}

/** Test seam: discard live drafts, settle pending lifetime transitions,
 * drop ambient classification, detach any tracer. Existing atoms stay
 * valid. */
export function resetEngineForTest(): void {
	discardAllDrafts()
	flushLifetimeTransitions()
	setAmbientClassifier(null)
	setRenderWriteGuard(null)
	renderWorldProvider = null
	getActiveTracer()?.stop()
}

export type { ResolvedState, Suspension, World, DraftId, Draft, UseFn, EqualsFn, Flags }
/** For consumers reading ResolvedState views directly: the Flag bit
 * constants (test async bits via Flag.AsyncMask/AsyncError/
 * AsyncSuspended) and the uninitialized sentinel test. */
export { Flag, isUninitialized }
export { BASE_WORLD }
