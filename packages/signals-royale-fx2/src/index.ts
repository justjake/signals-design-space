/**
 * signals-royale-fx2 — the public API: signals, computeds, effects, and
 * the read/write functions that connect them to React transitions.
 *
 * Base state lives in a conventional signal graph (graph.ts: lazy cached
 * computeds, effects, batching). React-transition support is a thin
 * overlay on top (worlds.ts): writes issued inside a transition are
 * recorded into a draft instead of hitting the cell, and readers resolve
 * values in a world — base state plus the drafts a specific render pass
 * is allowed to see. See the worlds.ts header for the full model; this
 * file only decides which path each read and write takes.
 */

import {
	type BatchPass,
	type CellNode,
	type DerivedNode,
	type EqualsFn,
	type Flags,
	type GraphChangeClock,
	type Link,
	type PokePass,
	type ReactiveNode,
	type TraceEventId,
	type UseFn,
	Flag,
	NO_EVENT,
	UNINITIALIZED,
	assertSignalReadAllowed,
	assertSignalWriteAllowed,
	activeEvaluation,
	flushLifetimeTransitions,
	getActiveConsumer,
	isUninitialized,
	makeEffect,
	makeScope,
	peekCell,
	readCell,
	readDerived,
	runUpdater,
	startBatch as graphStartBatch,
	endBatch as graphEndBatch,
	batch as graphBatch,
	untracked as graphUntracked,
	useImpl,
	writeCell,
} from './graph.ts'
import { type DerivedState, type ErrorBox, type Suspension, isErrorBox } from './asyncs.ts'
import {
	type Draft,
	type DraftId,
	type World,
	BASE_WORLD,
	appendDraftIntent,
	appendUrgentIntent,
	cellHasDraftIntents,
	classifyWrite,
	committedWorldOf,
	discardAllDrafts,
	getCurrentPark,
	getCurrentWorld,
	latestWorld,
	draftsAffecting,
	peekWorldMemo,
	pokeRebasedCell,
	resolveState,
	setAmbientClassifier,
	unwrapForEval,
	worldOf,
} from './worlds.ts'
import { attachTracer, getActiveTracer, Tracer, type TraceEvent } from './tracer.ts'

// ---------------------------------------------------------------------------
// Public handle types
// ---------------------------------------------------------------------------

export interface SignalOptions<T> {
	equals?: EqualsFn<T>
	label?: string
	/** Runs when the atom gains its first subscriber of any kind; the cleanup
	 * runs when the last subscriber of every kind is gone. */
	onObserved?: (ctx: { get(): T; set(v: T): void }) => void | (() => void)
}

export interface ComputedOptions<T> {
	equals?: EqualsFn<T>
	label?: string
}

export type Signal<in out T> = {
	get(): T
	set(value: T): void
	update(fn: (prev: T) => T): void
	peek(): T
}

const Signal = class<T> implements CellNode<T> {
	declare flags: Flags
	declare changedAtGraphChange: GraphChangeClock
	declare throwable: ErrorBox | Suspension | null
	declare subs: Link | undefined
	declare subsTail: Link | undefined
	declare deps: Link | undefined
	declare depsTail: Link | undefined
	declare observerCount: number
	declare causeEvent: TraceEventId
	declare label: string | undefined
	declare value: T | typeof UNINITIALIZED
	declare initializer: (() => T) | undefined
	declare equals: EqualsFn<T>
	declare batchPass: BatchPass
	declare lifetime: ((ctx: { get(): T; set(v: T): void }) => void | (() => void)) | undefined
	declare lifetimeCleanup: (() => void) | undefined
	declare lifetimeActive: boolean
	declare worldMemos: Map<string, unknown> | undefined
	declare pokePass: PokePass

	constructor(initial: T | (() => T), opts?: SignalOptions<T>) {
		const lazyInit = typeof initial === 'function'
		this.flags = Flag.KindCell
		this.changedAtGraphChange = 0
		this.throwable = null
		this.subs = undefined
		this.subsTail = undefined
		this.deps = undefined
		this.depsTail = undefined
		this.observerCount = 0
		this.causeEvent = NO_EVENT
		this.label = opts?.label
		this.value = lazyInit ? UNINITIALIZED : (initial as T)
		this.initializer = lazyInit ? (initial as () => T) : undefined
		this.equals = opts?.equals ?? Object.is
		this.batchPass = 0
		this.lifetime = opts?.onObserved
		this.lifetimeCleanup = undefined
		this.lifetimeActive = false
		this.worldMemos = undefined
		this.pokePass = 0
	}
	/** Base-state read, tracked as a dependency inside computations. Inside
	 * a draft-world evaluation, resolves that evaluation's own world
	 * instead. */
	get(): T {
		const world = getCurrentWorld()
		if (world !== null) {
			// Inside a draft evaluation every read resolves that world.
			return unwrapForEval(resolveState(this, world), getCurrentPark()!) as T
		}
		return readCell(this)
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
	/** Untracked base-state read. */
	peek(): T {
		return peekCell(this)
	}
}

/** A signal whose dispatches replay through one reducer fixed at creation. */
export type ReducerAtom<S, A> = Signal<S> & {
	dispatch: (action: A) => void
}

type ReducerSignal<S, A> = ReducerAtom<S, A> & {
	reduce: (state: S, action: A) => S
}

function dispatchReducer<S, A>(this: ReducerSignal<S, A>, action: A): void {
	const reduce = this.reduce
	this.update((state) => reduce(state, action))
}

export type Computed<out T> = {
	get(): T
	peek(): T
}

type ComputedNode<T> = Computed<T> & DerivedNode<T>

function getComputed<T>(this: ComputedNode<T>): T {
	const world = getCurrentWorld()
	if (world !== null) {
		// Inside a draft evaluation every read resolves that world.
		return unwrapForEval(resolveState(this, world), getCurrentPark()!) as T
	}
	const value = readDerived(this)
	if ((this.flags & Flag.AsyncMask) !== 0) {
		return unwrapAsyncRead(this as DerivedNode<unknown>) as T
	}
	return value
}

function peekComputed<T>(this: ComputedNode<T>): T {
	return graphUntracked(() => this.get())
}

export type Readable<T> = Signal<T> | Computed<T>
/** @internal Accepts any handle regardless of value-type variance. */
type AnyReadable = Signal<any> | Computed<any>

export function signal<T>(initial: T | (() => T), opts?: SignalOptions<T>): Signal<T> {
	return new Signal(initial, opts)
}

export function reducerAtom<S, A>(
	reduce: (state: S, action: A) => S,
	initial: S | (() => S),
	opts?: SignalOptions<S>,
): ReducerAtom<S, A> {
	const node = new Signal(initial, opts) as unknown as ReducerSignal<S, A>
	node.reduce = reduce
	node.dispatch = dispatchReducer
	return node
}

export function computed<T>(
	fn: (use: UseFn, previous: T | undefined) => T,
	opts?: ComputedOptions<T>,
): Computed<T> {
	const node: ComputedNode<T> = {
		flags: Flag.KindDerived | Flag.StaleDirty,
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
export function nodeOf(x: AnyReadable): ReactiveNode {
	const node = x as unknown as ReactiveNode
	if ((node.flags & (Flag.KindCell | Flag.KindDerived)) !== 0) {
		return node
	}
	throw new TypeError('expected a signal or computed handle')
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Finish a computed read that found the node in an async state: rethrow
 * errors, park an evaluating consumer on the suspension, serve stale data
 * when a settled value exists, otherwise suspend (first load). */
function unwrapAsyncRead(node: DerivedNode<unknown>): unknown {
	if ((node.flags & Flag.AsyncError) !== 0) {
		throw (node.throwable as ErrorBox).error
	}
	const suspension = node.throwable as Suspension
	const consumer = getActiveConsumer()
	if (consumer !== null && (consumer.flags & Flag.KindDerived) !== 0) {
		// Pending forwards: park the evaluating computed on this suspension.
		useImpl(suspension.promise, consumer as DerivedNode<unknown>)
	}
	if (!isUninitialized(node.value)) {
		return node.value
	} // stale serves
	throw suspension.promise // never settled: suspend
}

/** The value slot of a state view, with the uninitialized sentinel
 * normalized to undefined — latest() and committed() never suspend, so a
 * suspended state with no settled value reads as undefined there. */
function stateValue(st: DerivedState): unknown {
	return isUninitialized(st.value) ? undefined : st.value
}

/** The newest view of x: base state plus every live draft. Never
 * suspends. That meaning only applies outside any evaluation or render —
 * inside one, latest() resolves that context's own world instead, because
 * reading ahead of your world would tear: a draft evaluation sees its
 * draft's world, a base-state computed or effect sees base state, and a
 * render pass sees the pass's world. */
export function latest<T>(x: Readable<T>): T {
	const node = nodeOf(x)
	let world = getCurrentWorld()
	if (world === null) {
		if (getActiveConsumer() !== null) {
			// A base-state evaluation (computed or effect) is running. Its
			// world is base state, and this read is a real dependency: track
			// it so a later change to x re-runs the consumer rather than
			// leaving it permanently stale.
			world = BASE_WORLD
			if ((node.flags & Flag.KindCell) !== 0) {
				readCell(node as CellNode<unknown>)
			} else {
				readDerived(node as DerivedNode<unknown>)
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

/** What the committed screen shows for x — per root when a container is
 * given, base state otherwise. Never subscribes, never suspends. */
export function committed<T>(x: Readable<T>, container?: object): T {
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

/** Committed-view snapshot with stable identity, used by the React
 * bindings' useCommitted: the value, or the ErrorBox itself — identity-
 * stable for the whole error span — whose error the caller rethrows. */
export function committedSnapshot(node: ReactiveNode, container: object | undefined): unknown {
	const st = resolveState(node, committedWorldOf(container))
	if ((st.flags & Flag.AsyncError) !== 0) {
		return st.throwable
	}
	return stateValue(st)
}

/** True while newer data exists behind what is on screen — a pending
 * transition draft on this atom, or an async refetch loading behind a
 * stale value. Passive by contract: never evaluates, never refetches,
 * never suspends. */
export function isPending(x: AnyReadable): boolean {
	return isPendingPassive(nodeOf(x), getCurrentWorld() ?? renderWorld())
}

/** Node-level pendingness probe, also used by the React bindings'
 * useIsPending. `world` scopes the suspended-memo check; null means
 * ambient. */
export function isPendingPassive(node: ReactiveNode, world: World | null): boolean {
	assertSignalReadAllowed()
	if ((node.flags & Flag.KindCell) !== 0) {
		return cellHasDraftIntents(node as CellNode<unknown>)
	}
	if ((node.flags & Flag.KindDerived) === 0) {
		return false
	}
	// Pending means "stale data exists while newer data loads". A
	// suspension with settled history is pending; a first load is not — it
	// has no stale data to indicate over, and suspending is Suspense's
	// job, not the indicator's.
	if ((node.flags & Flag.AsyncSuspended) !== 0) {
		return !isUninitialized((node as DerivedNode<unknown>).value)
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
	return draftsAffecting(node).length > 0
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

export function set<T>(x: Signal<T>, value: T): void {
	assertSignalWriteAllowed()
	guardRenderWrite()
	const cell = x as unknown as CellNode<unknown>
	const draft = classifyWrite()
	if (draft !== null) {
		appendDraftIntent(draft, cell, 'set', value)
		return
	}
	// Urgent write: base state moves now, and pending worlds will replay
	// the intent in dispatch order.
	const rebased = appendUrgentIntent(cell, 'set', value)
	const changed = writeCell(cell, value)
	// When the write was a base-state no-op (equality) but the cell has
	// pending drafts, the drafted replays still changed — their audiences
	// must hear about it even though no wave ran.
	if (rebased && !changed) {
		pokeRebasedCell(cell)
	}
}

export function update<T>(x: Signal<T>, fn: (prev: T) => T): void {
	assertSignalWriteAllowed()
	guardRenderWrite()
	const cell = x as unknown as CellNode<unknown>
	const draft = classifyWrite()
	if (draft !== null) {
		appendDraftIntent(draft, cell, 'update', fn)
		return
	}
	const next = runUpdater(fn, peekCell(cell) as T)
	const rebased = appendUrgentIntent(cell, 'update', fn)
	const changed = writeCell(cell, next)
	if (rebased && !changed) {
		pokeRebasedCell(cell)
	}
}

export function read<T>(x: Readable<T>): T {
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
type AtomMap = Record<string, Signal<any>> | Signal<any>[]

function atomEntries(atoms: AtomMap): Array<[string, Signal<unknown>]> {
	return Array.isArray(atoms)
		? atoms.map((a, i) => [String(i), a] as [string, Signal<unknown>])
		: Object.entries(atoms)
}

/** Serialize base atom state under app-supplied keys. */
export function serializeAtomState(
	atoms: AtomMap,
	replacer?: (key: string, value: unknown) => unknown,
): string {
	const out: Record<string, unknown> = {}
	for (const [key, atom] of atomEntries(atoms)) {
		out[key] = peekCell(atom as unknown as CellNode<unknown>)
	}
	return JSON.stringify(out, replacer as never)
}

/** Install a value without running lazy initializers and without counting
 * as a write: no propagation, no equality check, no effects. */
export function installState<T>(atom: Signal<T>, value: T): void {
	assertSignalWriteAllowed()
	const cell = atom as unknown as CellNode<T>
	cell.initializer = undefined
	cell.value = value
}

export function initializeAtomState(
	json: string,
	atoms: AtomMap,
	reviver?: (key: string, value: unknown) => unknown,
): void {
	const data = JSON.parse(json, reviver as never) as Record<string, unknown>
	for (const [key, atom] of atomEntries(atoms)) {
		if (Object.prototype.hasOwnProperty.call(data, key)) {
			installState(atom, data[key])
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

export type { DerivedState, ErrorBox, Suspension, World, DraftId, Draft, UseFn, EqualsFn, Flags }
/** For consumers reading DerivedState views directly: the Flag bit
 * constants (test async bits via Flag.AsyncMask/AsyncError/
 * AsyncSuspended), the error-box identity check, and the uninitialized
 * sentinel test. */
export { Flag, isErrorBox, isUninitialized }
export { BASE_WORLD }
