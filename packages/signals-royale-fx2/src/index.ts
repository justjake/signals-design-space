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
	Lane,
	NO_EVENT,
	UNINITIALIZED,
	assertSignalReadAllowed,
	assertSignalWriteAllowed,
	activeConsumer,
	activeEvaluation,
	currentCause,
	currentWorld,
	flushLifetimeTransitions,
	isUninitialized,
	makeEffect,
	peekAtom,
	readAtom,
	readComputed,
	resetEffectLanes,
	runUpdater,
	untracked as graphUntracked,
	emitEvent,
	writeAtom,
} from './graph.ts'
import {
	type ErrorBox,
	type ResolvedState,
	type Suspension,
	baseUse,
	unwrapResolved,
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
	currentPark,
	draftsAffecting,
	discardAllDrafts,
	latestWorld,
	peekWorldMemo,
	pokeRebasedAtom,
	resolveState,
	resolveStateUntracked,
	setAmbientClassifier,
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

/** A writable reactive value. */
export type Atom<in out T> = {
	/** Tracked read: inside a computed, an effect source, or a subscribed
	 * component this registers a dependency. Returns base state — committed
	 * values plus urgent writes, drafts hidden — or, inside a render pass
	 * or draft evaluation, that context's own world. */
	get(): T
	/** Write through the equality cutoff (equal writes are dropped). Inside
	 * a React transition the write is recorded into the transition's draft
	 * and stays invisible to base readers until it commits. */
	set(value: T): void
	/** Functional update. Inside a transition the function itself is
	 * recorded and replays against each world's starting value, the way
	 * React replays queued useState updaters — keep it pure. */
	update(fn: (prev: T) => T): void
	/** Read the current value without registering a dependency. */
	peek(): T
}

// A class expression keeps the public structural Atom type separate from
// the private constructor while giving the runtime value the same name.
const Atom = class<T> implements AtomNode<T> {
	declare flags: Flags
	declare changedAtGraphChange: GraphChangeClock
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
	// World evaluations run untracked — their staleness evidence is the
	// certificate, not graph edges — so only the base branch registers a
	// dependency. (User-facing contracts live on the public Atom type.)
	get(): T {
		const world = currentWorld
		if (world !== null) {
			// Every read within a selected world resolves that same world.
			return resolveState(this, world).value as T
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
		const world = currentWorld
		if (world !== null) {
			return resolveStateUntracked(this, world).value as T
		}
		return peekAtom(this)
	}
}

/** An atom whose dispatches replay through one reducer fixed at creation. */
export type ReducerAtom<S, A> = Atom<S> & {
	/** Apply `action` through the reducer — recorded and replayed per
	 * world like update(), so keep the reducer pure. */
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
	/** Tracked, cached read: registers a dependency and recomputes only if
	 * one changed. An async computed returns its settled value, serves the
	 * previous settled value while a refetch is pending (isPending is the
	 * indicator), throws its stable pending promise when nothing has
	 * settled yet (React Suspense catches it), and rethrows errors. */
	get(): T
	/** get() without registering a dependency — same world selection and
	 * async behavior. */
	peek(): T
}

/** Computeds are plain node records. Every record points at this shared
 * function instead of allocating a get closure; TypeScript erases the
 * fake `this` parameter and normal method-call syntax supplies the node.
 * World resolutions unwrap under the ambient park (an enclosing draft
 * evaluation forwards pendingness; a render serves stale or suspends) —
 * the same rule for tracked get() and untracked peek(), so the two cannot
 * drift on async behavior. */
function getComputed<T>(this: Computed<T> & ComputedNode<T>): T {
	const world = currentWorld
	if (world !== null) {
		// Every read within a selected world resolves that same world.
		return unwrapResolved(resolveState(this, world), currentPark) as T
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
	const world = currentWorld
	if (world !== null) {
		return unwrapResolved(resolveStateUntracked(this, world), currentPark) as T
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

/** Finish a computed read that found the node in an async state: park an
 * evaluating consumer on the suspension (pending forwards), then apply the
 * shared unwrap — rethrow errors, serve stale data when a settled value
 * exists, otherwise suspend (first load). */
function unwrapAsyncRead<T>(node: ComputedNode<T>): T {
	if ((node.flags & Flag.AsyncSuspended) !== 0) {
		const consumer = activeConsumer
		if (consumer !== null) {
			// baseUse parks the consumer and throws; it never returns here.
			baseUse((node.throwable as Suspension).promise, consumer)
		}
	}
	return unwrapResolved(node, null) as T
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
	let world = currentWorld
	if (world === null) {
		if (activeConsumer !== null) {
			// A base-state evaluation is running. Its world is base state, and
			// this read is a real dependency: track it so a later change to x
			// re-runs the consumer rather than leaving it permanently stale.
			world = BASE_WORLD
			if ((node.flags & Flag.KindAtom) !== 0) {
				readAtom(node as AtomNode<unknown>)
			} else {
				readComputed(node as ComputedNode<unknown>)
			}
		} else {
			world = renderWorld() ?? latestWorld()
		}
	}
	const st = resolveState(node, world)
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
	return isPendingPassive(nodeOf(x), currentWorld ?? renderWorld())
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
	// transitive: a computed over a pending source is itself pending. The
	// closure walk is the same one late-subscription repair uses.
	return draftsAffecting(node).length !== 0
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
		if (emitEvent !== null) {
			emitEvent('callback-error', activeEvaluation, currentCause, { error, phase: 'updater' })
		}
		throw error
	}
	const rebased = appendUrgentIntent(atom, 'update', fn)
	const changed = writeAtom(atom, next, 'update')
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

/** When an effect's signal-triggered re-runs drain. Setup runs (creation,
 * or a React deps change) are synchronous and unaffected. */
export type EffectSchedule = 'sync' | 'useLayoutEffect' | 'useEffect'

/** Options accepted by effect(). `equals` and `label` configure the
 * compute exactly as on createComputed; the same `equals` also gates
 * delivery, comparing fresh settled values against the last-handled one. */
export interface EffectOptions<T> extends ComputedOptions<T> {
	/** Which React phase runs signal-triggered re-runs ('useLayoutEffect'
	 * or 'useEffect'); 'sync' (default) runs them inside the settling
	 * flush. */
	schedule?: EffectSchedule
}

/** Element-wise (arrays) or own-key-wise (plain objects) Object.is, one
 * level deep. The default cutoff for tuple and record effect sources,
 * whose computes rebuild their container on every run. */
export function shallowEquals(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) {
		return true
	}
	if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
		return false
	}
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) {
			return false
		}
		for (let i = 0; i < a.length; i++) {
			if (!Object.is(a[i], b[i])) {
				return false
			}
		}
		return true
	}
	if (Array.isArray(b)) {
		return false
	}
	const keysA = Object.keys(a)
	if (keysA.length !== Object.keys(b).length) {
		return false
	}
	for (const key of keysA) {
		if (
			!Object.prototype.hasOwnProperty.call(b, key) ||
			!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
		) {
			return false
		}
	}
	return true
}

/** The value a signal handle produces. */
export type SignalValue<S> = S extends Signal<infer V> ? V : never

/** Signal container sources map to same-shaped value containers: a tuple
 * of signals yields a tuple of values, a record yields a record. */
export type SignalValues<S> = { -readonly [K in keyof S]: SignalValue<S[K]> }

/** A signal handle: an object whose flags carry an engine kind bit.
 * Distinguishes handles from plain objects (a record source) without
 * duck-typing on `get`, which Map and foreign reactives would satisfy. */
function isSignalHandle(x: object): x is Signal<unknown> {
	return (
		typeof (x as { flags?: unknown }).flags === 'number' &&
		((x as { flags: number }).flags & (Flag.KindAtom | Flag.KindComputed)) !== 0
	)
}

/**
 * An effect is a source and a handler with different rules.
 *
 * The source declares what the effect reacts to:
 * - a compute function — tracked dynamically, cached, cut off by equals,
 *   async-capable through use(), handed its previous value; its evaluation
 *   state lives on the effect node, not a separate computed node;
 * - a signal — shorthand for reading it (cutoff Object.is);
 * - a tuple or record of signals — shorthand for reading each into a
 *   same-shaped container (cutoff shallowEquals, since the container is
 *   rebuilt every run; an explicit equals overrides).
 *
 * `handler` runs untracked with the settled (value, previous-handled)
 * pair when that value changes. It may return a cleanup that runs before
 * the next handler run and at disposal. Reads inside the handler are
 * deliberately untracked — a value the effect should react to belongs in
 * the source.
 *
 * The first run is synchronous at creation when the compute settles
 * immediately; a parked first evaluation fires its first handler at
 * settlement, on the schedule. Parking is silent (the previous value
 * keeps serving; isPending is the indicator), settlement fires only when
 * the settled value differs from the last-handled one, and a compute
 * error rethrows from the drain site without calling the handler.
 *
 * Effects observe base state only: a drafted write is invisible, and a
 * transition reaches every effect exactly once, at retirement, through
 * the normal write path. See docs/effects.md for the full contract.
 */
export function effect<T>(
	compute: (use: UseFn, previous: T | undefined) => T,
	handler: (value: T, previous: T | undefined) => void | (() => void),
	opts?: EffectOptions<T>,
): () => void
export function effect<S extends Signal<any>>(
	source: S,
	handler: (value: SignalValue<S>, previous: SignalValue<S> | undefined) => void | (() => void),
	opts?: EffectOptions<SignalValue<S>>,
): () => void
export function effect<const S extends readonly Signal<any>[]>(
	sources: S,
	handler: (values: SignalValues<S>, previous: SignalValues<S> | undefined) => void | (() => void),
	opts?: EffectOptions<SignalValues<S>>,
): () => void
export function effect<S extends Record<string, Signal<any>>>(
	sources: S,
	handler: (values: SignalValues<S>, previous: SignalValues<S> | undefined) => void | (() => void),
	opts?: EffectOptions<SignalValues<S>>,
): () => void
export function effect(
	source:
		| ((use: UseFn, previous: any) => unknown)
		| Signal<any>
		| readonly Signal<any>[]
		| Record<string, Signal<any>>,
	handler: (value: any, previous: any) => void | (() => void),
	opts?: EffectOptions<any>,
): () => void {
	const schedule = opts?.schedule
	const lane =
		schedule === 'useLayoutEffect'
			? Lane.UseLayoutEffect
			: schedule === 'useEffect'
				? Lane.UseEffect
				: Lane.Sync
	let compute: (use: UseFn, previous: unknown) => unknown
	let equals = opts?.equals as EqualsFn<unknown> | undefined
	if (typeof source === 'function') {
		compute = source
	} else if (isSignalHandle(source)) {
		compute = () => source.get()
	} else if (Array.isArray(source)) {
		const sources = source as readonly Signal<unknown>[]
		compute = () => {
			const values = new Array<unknown>(sources.length)
			for (let i = 0; i < sources.length; i++) {
				values[i] = sources[i]!.get()
			}
			return values
		}
		equals ??= shallowEquals
	} else {
		const record = source as Record<string, Signal<unknown>>
		const keys = Object.keys(record)
		compute = () => {
			const values: Record<string, unknown> = {}
			for (const key of keys) {
				values[key] = record[key]!.get()
			}
			return values
		}
		equals ??= shallowEquals
	}
	return makeEffect(compute, handler, lane, equals, opts?.label)
}

export {
	makeScope as effectScope,
	batch,
	startBatch,
	endBatch,
	untracked,
	flushScheduledEffects,
} from './graph.ts'

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
	resetEffectLanes()
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
