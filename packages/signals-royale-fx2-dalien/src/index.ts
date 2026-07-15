/**
 * signals-royale-fx2-dalien — a concurrent signal engine designed to ride React's
 * own scheduling machinery instead of forking it.
 *
 * Base state lives in a conventional signal graph (lazy cached
 * computeds, effects, batching). Concurrency is a thin overlay: writes
 * issued inside a React transition become DRAFTS (ordered logs of write
 * intents), and readers resolve values in a WORLD — base state plus
 * the drafts a specific render pass is allowed to see. Draft intents
 * replay over the live base value, so urgent writes rebase pending
 * transitions by construction. See worlds.ts for the full model.
 */

import {
	type CellNode,
	type DerivedNode,
	type EqualsFn,
	type Flags,
	ReactiveNode,
	type UseFn,
	Flag,
	NodeSlot,
	UNINITIALIZED,
	assertSignalReadAllowed,
	assertSignalWriteAllowed,
	activeWorldSourceConsumer,
	activeEvaluation,
	flushLifetimeTransitions,
	getActiveConsumer,
	isUninitialized,
	initializeCell,
	initializeDerived,
	makeEffect,
	makeScope,
	peekCell,
	readCell,
	readDerived,
	resetGraphForBenchmark,
	runUpdater,
	trackWorldRead,
	startBatch as graphStartBatch,
	endBatch as graphEndBatch,
	batch as graphBatch,
	untracked as graphUntracked,
	useImpl,
	writeCell,
	graphMemory,
} from './graph.ts'
import { type ResolvedState, type ErrorBox, type Suspension, asyncPlaneUsed, isErrorBox } from './asyncs.ts'
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

export interface AtomOptions<T> {
	equals?: EqualsFn<T>
	label?: string
	/**
	 * Runs when the atom gains its first subscriber of any kind; the cleanup
	 * runs when the last subscriber of every kind is gone.
	 */
	onObserved?: (ctx: { get(): T; set(v: T): void }) => void | (() => void)
}

export interface ComputedOptions<T> {
	equals?: EqualsFn<T>
	label?: string
}

export type Atom<in out T> = {
	get(): T
	set(value: T): void
	update(fn: (prev: T) => T): void
	peek(): T
}

const Atom = class<T> extends ReactiveNode implements CellNode<T> {
	declare value: T | typeof UNINITIALIZED
	declare initializer: (() => T) | undefined
	declare equals: EqualsFn<T>
	declare lifetime: CellNode<T>['lifetime']
	declare lifetimeCleanup: (() => void) | undefined
	declare lifetimeActive: boolean
	/** @internal Compatibility alias; the handle itself owns the internals. */
	get node(): this {
		return this
	}
	constructor(initial: T | (() => T), opts?: AtomOptions<T>) {
		super()
		initializeCell(this, initial, opts)
	}
	/**
	 * Base-state read (tracked inside computations); in a draft evaluation,
	 * resolves that evaluation's own world.
	 */
	get(): T {
		const world = getCurrentWorld()
		if (world !== null) {
			// Inside a draft evaluation every read resolves that world.
			const state = resolveState(this, world)
			trackWorldRead(this)
			return state.value as T
		}
		return readCell(this)
	}
	set(value: T): void {
		set(this, value)
	}
	/**
	 * Functional update. Inside a transition the function is recorded and
	 * REPLAYS against each world's base value (React updater-queue rules).
	 */
	update(fn: (prev: T) => T): void {
		update(this, fn)
	}
	/** Untracked base-state read. */
	peek(): T {
		const world = getCurrentWorld()
		if (world !== null) {
			return resolveStateUntracked(this, world).value as T
		}
		return peekCell(this)
	}
}

/** A signal whose dispatches replay through one reducer fixed at creation. */
export type ReducerAtom<S, A> = Atom<S> & {
	dispatch(action: A): void
}

type ReducerAtomNode<S, A> = ReducerAtom<S, A> & CellNode<S> & {
	reduce: (state: S, action: A) => S
}

function dispatchReducer<S, A>(this: ReducerAtomNode<S, A>, action: A): void {
	const reduce = this.reduce
	this.update((state) => reduce(state, action))
}

export type Computed<out T> = {
	get(): T
	peek(): T
}

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

const Computed = class<T> extends ReactiveNode implements DerivedNode<T> {
	declare value: T | typeof UNINITIALIZED
	declare fn: DerivedNode<T>['fn']
	declare equals: EqualsFn<T>
	constructor(fn: (use: UseFn, previous: T | undefined) => T, opts?: ComputedOptions<T>) {
		super()
		initializeDerived(this, fn, opts)
	}
	get(): T {
		const world = getCurrentWorld()
		if (world !== null) {
			const state = resolveState(this, world)
			trackWorldRead(this)
			if (activeWorldSourceConsumer !== null) {
				trackWorldSources(this, world)
			}
			return unwrapComputedWorldState<T>(state)
		}
		const value = readDerived(this)
		if (asyncPlaneUsed && (graphMemory[this.id + NodeSlot.Flags] & Flag.AsyncMask) !== 0) {
			return unwrapAsyncRead(this as DerivedNode<unknown>) as T
		}
		return value
	}
	peek(): T {
		const world = getCurrentWorld()
		if (world !== null) {
			return unwrapComputedWorldState<T>(resolveStateUntracked(this, world))
		}
		return graphUntracked(() => this.get())
	}
}

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
	return new Computed(fn, opts)
}

/** @internal Resolve a handle to its engine node. */
export function nodeOf(x: Signal<any>): ReactiveNode {
	const node = x as unknown as ReactiveNode
	if (typeof node.id !== 'number') {
		throw new TypeError('expected a signal or computed handle')
	}
	return node
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Cold tail of a computed read that is in an async state: rethrow errors,
 * park an evaluating consumer on the suspension, serve stale data when a
 * settled value exists, otherwise suspend (first load).
 */
function unwrapAsyncRead(node: DerivedNode<unknown>): unknown {
	if ((graphMemory[node.id + NodeSlot.Flags] & Flag.AsyncError) !== 0) {
		throw (node.throwable as ErrorBox).error
	}
	const suspension = node.throwable as Suspension
	const consumer = getActiveConsumer()
	if (consumer !== null && (graphMemory[consumer.id + NodeSlot.Flags] & Flag.KindDerived) !== 0) {
		// Pending forwards: park the evaluating computed on this suspension.
		useImpl(suspension.promise, consumer as DerivedNode<unknown>)
	}
	if (!isUninitialized(node.value)) {
		return node.value
	} // stale serves
	throw suspension.promise // never settled: suspend
}

/**
 * The value slot of a state view, sentinel normalized: a suspended state
 * with no settled value reads as undefined on the never-suspending channels
 * (latest, committed).
 */
function stateValue(st: ResolvedState): unknown {
	return isUninitialized(st.value) ? undefined : st.value
}

/**
 * Newest intent: base state plus every live draft; never suspends. That is
 * the AMBIENT meaning — inside an evaluation context, latest() resolves that
 * context's own world instead, because reading ahead of your world is a
 * tear: a draft evaluation sees its draft world, a base-state computed or
 * effect evaluation sees base state, a render pass sees the pass's world.
 */
export function latest<T>(x: Signal<T>): T {
	const node = nodeOf(x)
	let world = getCurrentWorld()
	if (world === null) {
		if (getActiveConsumer() !== null) {
			// A base-state evaluation (computed or effect) is running. Its context
			// world is the base world, and this read is a real dependency: track it so
			// a later change to x re-runs the consumer rather than leaving it
			// permanently stale.
			world = BASE_WORLD
			if ((graphMemory[node.id + NodeSlot.Flags] & Flag.KindCell) !== 0) {
				readCell(node as CellNode<unknown>)
			} else {
				readDerived(node as DerivedNode<unknown>)
			}
		} else {
			world = renderWorld() ?? latestWorld()
		}
	} else {
		trackWorldRead(node)
	}
	const st = resolveState(node, world)
	if (
		activeWorldSourceConsumer !== null &&
		(graphMemory[node.id + NodeSlot.Flags] & Flag.KindDerived) !== 0
	) {
		trackWorldSources(node, world)
	}
	if ((st.flags & Flag.AsyncError) !== 0) {
		throw (st.throwable as ErrorBox).error
	}
	return stateValue(st) as T
}

/** What is on screen: per-root when a container is given. Never subscribes. */
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

/**
 * Committed-view snapshot with stable identity: the value, or the ErrorBox
 * itself (identity-stable for the whole error span — see isErrorBox) whose
 * error the caller rethrows. The React bindings' useCommitted snapshot.
 */
export function committedSnapshot(node: ReactiveNode, container: object | undefined): unknown {
	const st = resolveState(node, committedWorldOf(container))
	if ((st.flags & Flag.AsyncError) !== 0) {
		return st.throwable
	}
	return stateValue(st)
}

/**
 * Cheap flip-only probe: true while newer data exists behind what is on
 * screen — a pending transition draft on this atom, or an async refetch
 * loading behind a stale value. Passive by contract: never evaluates,
 * never refetches, never suspends.
 */
export function isPending(x: Signal<any>): boolean {
	return isPendingPassive(nodeOf(x), getCurrentWorld() ?? renderWorld())
}

/**
 * Node-level pendingness probe; `world` scopes the suspended-memo check
 * (null = ambient). The React bindings' useIsPending snapshot.
 */
export function isPendingPassive(node: ReactiveNode, world: World | null): boolean {
	assertSignalReadAllowed()
	const flags = graphMemory[node.id + NodeSlot.Flags]
	if ((flags & Flag.KindCell) !== 0) {
		return cellHasDraftIntents(node as CellNode<unknown>)
	}
	if ((flags & Flag.KindDerived) === 0) {
		return false
	}
	// Pending means "stale data exists while newer data loads" (Solid 2.0's
	// rule): a suspension with settled history is pending; a FIRST LOAD is
	// not — it has no stale data to indicate over, and suspending is
	// Suspense's job, not the indicator's.
	if ((flags & Flag.AsyncSuspended) !== 0) {
		return !isUninitialized((node as DerivedNode<unknown>).value)
	}
	if (world !== null && world.drafts.length > 0) {
		const memo = peekWorldMemo(node, world.sig)
		if (memo !== undefined && (memo.flags & Flag.AsyncSuspended) !== 0) {
			return !isUninitialized(memo.value)
		}
	}
	// A drafted input anywhere in the dependency closure means newer data is
	// pending behind this computed's base value — transitive, like Solid's
	// status forwarding: a computed over a pending source is itself pending.
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

export function set<T>(x: Atom<T>, value: T): void {
	assertSignalWriteAllowed()
	guardRenderWrite()
	const cell = x as unknown as CellNode<unknown>
	const draft = classifyWrite()
	if (draft !== null) {
		appendDraftIntent(draft, cell, 'set', value)
		return
	}
	// Urgent: base state moves now; pending worlds replay it in dispatch order.
	const rebased = appendUrgentIntent(cell, 'set', value)
	const changed = writeCell(cell, value)
	// Equality cutoff with pending drafts: base state did not move (no wave
	// ran) but the drafted replays did — their audiences must still hear it.
	if (rebased && !changed) {
		pokeRebasedCell(cell)
	}
}

export function update<T>(x: Atom<T>, fn: (prev: T) => T): void {
	assertSignalWriteAllowed()
	guardRenderWrite()
	const cell = x as unknown as CellNode<T>
	const draft = classifyWrite()
	if (draft !== null) {
		appendDraftIntent(draft, cell as CellNode<unknown>, 'update', fn)
		return
	}
	const next = runUpdater(fn, peekCell(cell))
	const rebased = appendUrgentIntent(cell as CellNode<unknown>, 'update', fn)
	const changed = writeCell(cell, next)
	if (rebased && !changed) {
		pokeRebasedCell(cell as CellNode<unknown>)
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
export { resetGraphForBenchmark }

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
			out[i] = peekCell(atoms[i] as unknown as CellNode<unknown>)
		}
	} else {
		for (const key in atoms) {
			if (Object.prototype.hasOwnProperty.call(atoms, key)) {
				out[key] = peekCell(atoms[key] as unknown as CellNode<unknown>)
			}
		}
	}
	return JSON.stringify(out, replacer as never)
}

/**
 * Install a value without running lazy initializers and without counting
 * as a write: no propagation, no equality check, no effects.
 */
export function installState<T>(atom: Atom<T>, value: T): void {
	assertSignalWriteAllowed()
	const node = atom as unknown as CellNode<T>
	node.initializer = undefined
	node.value = value
}

export function initializeAtomState(
	json: string,
	atoms: AtomMap,
	reviver?: (key: string, value: unknown) => unknown,
): void {
	const data = JSON.parse(json, reviver as never) as Record<string, unknown>
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
// Render-world provider (installed by the ./react bindings, which import
// engine modules directly — the react directory is part of the library).
// ---------------------------------------------------------------------------

/**
 * Installed by the bindings: answers "what world is rendering right now".
 * - draft ids: the pass's world was noted by this pass and is still valid;
 * - 'base': a component render is executing but no valid note exists
 *   (the note expired or belongs to another pass) — plain latest()/
 *   isPending() must fall back to BASE rather than read a stale world
 *   or read ahead into live drafts;
 * - null: no render is executing — ambient reads see newest intent.
 * A provider (not a sticky setter) because only the host knows when React
 * is rendering and which notes a pass refreshed.
 */
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

/**
 * Reset seam for tests: discard live drafts, settle lifetime flaps, drop
 * ambient classification, detach any tracer. Existing atoms stay valid.
 */
export function resetEngineForTest(): void {
	discardAllDrafts()
	flushLifetimeTransitions()
	setAmbientClassifier(null)
	setRenderWriteGuard(null)
	renderWorldProvider = null
	getActiveTracer()?.stop()
}

export type { ResolvedState, ErrorBox, Suspension, World, DraftId, Draft, UseFn, EqualsFn, Flags }
/**
 * The ResolvedState read protocol: the Flag bit constants (test async bits
 * via Flag.AsyncMask/AsyncError/AsyncSuspended), the error-box identity
 * check, and the never-settled sentinel test.
 */
export { Flag, isErrorBox, isUninitialized }
export { BASE_WORLD }
