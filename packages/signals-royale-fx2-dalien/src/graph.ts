/**
 * The base reactive graph: writable signals, cached computeds, effects.
 *
 * Design notes
 *
 * - Push-pull: writes push a small "dirty" wave through WATCHED edges only;
 *   reads pull values and validate caches by comparing clock readings.
 *   A computed recomputes only when some dependency actually changed after
 *   the computed's last validation (dep.changedAtGraphChange strictly
 *   greater than sub.validAtGraphChange), which is what gives exact
 *   evaluation counts and equality cutoff.
 * - Watched vs unwatched: a computed is linked into its dependencies'
 *   subscriber lists only while something observes it (an effect chain, a
 *   React subscription, or another watched computed). An unwatched computed
 *   holds references dependency-ward only, so dropping the last user
 *   reference makes the whole chain collectible — no registry needed for
 *   reads. Unwatched computeds validate lazily on read against the global
 *   graph change clock.
 * - Effects are the only long-lived graph roots a user can leak by dropping
 *   the disposer without calling it; a FinalizationRegistry on the disposer
 *   reclaims those.
 *
 * Counter taxonomy — every numeric counter is one of two kinds, and the
 * name says which:
 *
 * - …ChangeClock: monotone logical clock; ticks when its event class
 *   happens. Records never hold private counters — they hold READINGS of a
 *   clock: validAt<Clock> ("proven current as of") and changedAt<Clock>
 *   ("last real change"). Every staleness question is one comparison:
 *   dep.changedAt<Clock> > sub.validAt<Clock> means changed-since-validated
 *   (strictly greater — equal readings mean that very validation already
 *   consumed the change).
 * - …Pass: identity of a dynamic scope (an evaluation, a walk); saved and
 *   restored on nesting, so NEVER compare for order — equality means
 *   membership in the pass now running.
 */

import type { ErrorBox, Suspension } from './asyncs.ts'
import type { DraftId } from './worlds.ts'

export type EqualsFn<T> = (a: T, b: T) => boolean

/** Weak number brand. Plain numbers assign in, so creation and increment
 * stay cast-free (`let x: EvalPass = 1; x++`), but a value of one brand
 * does not assign to a slot or parameter of another — counter mixups are
 * type errors. The symbol is declared, never created: purely type-level,
 * and the runtime representation stays a plain number. */
declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]?: B }

/** Monotone logical clock: ticks on every base-state change — writes AND
 * settlements. Validation shortcut for unwatched reads. */
export type GraphChangeClock = Brand<number, 'GraphChangeClock'>
export type TraceEventId = Brand<number, 'TraceEventId'>
/** Identity of one evaluation pass; monotonic, never reused (see
 * evalPassCounter). */
export type EvalPass = Brand<number, 'EvalPass'>
/** Identity of one poke walk; monotonic, never reused, so no per-walk
 * clearing is needed (same discipline as EvalPass). */
export type PokePass = Brand<number, 'PokePass'>
export type BatchPass = Brand<number, 'BatchPass'>

/**
 * One flag bit. `Flag` names a bit; `Flags` (the stored word) stays a
 * branded number because TS5 types const enum unions as the enum, which
 * would force a cast on every |= / &= composition. esbuild inlines members
 * within this file and compiles cross-file consumers to object lookups —
 * the same cost as a const object — while tsc-compiled consumers inline
 * everywhere.
 */
export const enum Flag {
	// Kinds: exactly one, set at creation, never changed.
	/** Writable source. */
	KindCell = 0b0000_0000_0001,
	/** Cached computed. */
	KindDerived = 0b0000_0000_0010,
	/** Subscriber (alien-signals' name): an effect, a store subscription, or
	 * a scope anchor. */
	Watching = 0b0000_0000_0100,

	// Watch capabilities: creation-fixed, Watching nodes only; dispatch
	// routes on these bits, never on callback presence. Component
	// subscription = Watching|WatchRender|WatchDraft; engine effect =
	// Watching|WatchRunEffect; scope anchor = Watching alone.
	/** Schedule into the render-notify queue, delivered after effects
	 * settle; the subscriber's notify predicate decides whether the delivery
	 * becomes a re-render. */
	WatchRender = 0b0000_0000_1000,
	/** Schedule into the validated effect queue (runs the body). */
	WatchRunEffect = 0b0000_0001_0000,
	/** Draft pings and wakes reach this watcher; absent = base-state-only
	 * (every engine effect today). */
	WatchDraft = 0b0000_0010_0000,

	// Staleness: an exclusive pair; writes clear the whole field before
	// setting, so a single-bit test reads the exact state.
	/** Possibly stale: confirm dependency changedAt readings before
	 * recomputing. */
	StaleCheck = 0b0000_0100_0000,
	/** Definitely stale: recompute on next pull. */
	StaleDirty = 0b0000_1000_0000,

	// Async value plane: an exclusive pair; both clear = plain value.
	/** Latest evaluation threw; node.throwable holds the ErrorBox to
	 * rethrow. */
	AsyncError = 0b0001_0000_0000,
	/** Latest evaluation parked; node.throwable holds the Suspension. */
	AsyncSuspended = 0b0010_0000_0000,

	// State.
	/** Double role by kind. Cells/deriveds: mirror of observerCount > 0 —
	 * promote (0→1) sets it, demote (1→0) clears it; the count stays
	 * authoritative, the bit is the one-load hot-path test. Watchers: ALIVE —
	 * set at creation, cleared at dispose, so disposal = Watching set,
	 * Watched clear. */
	Watched = 0b0100_0000_0000,
	/** Watcher sits in a flush queue. */
	Scheduled = 0b1000_0000_0000,
	/** Canonical derived evaluation in progress. */
	Computing = 0b1_0000_0000_0000,
	/** Draft-world derived evaluation in progress. Separate because only a
	 * canonical evaluation refreshes the graph-validation watermark. */
	DraftComputing = 0b100_0000_0000_0000,
	/** This record's owner is registered with the node finalizer. Deriveds
	 * always are (their records own dep links a dead handle must free). An
	 * unregistered cell's record is owned by its incoming links alone: when
	 * the last one drops the record detaches instead (see freeLink), so it never
	 * needs the registry — and must never be freed by it. */
	Registered = 0b1000_0000_0000_0000,

	/** Both staleness bits; (flags & StaleMask) === 0 is the Clean state. */
	StaleMask = StaleCheck | StaleDirty,
	/** Both value-plane bits; (flags & AsyncMask) === 0 is the plain-value
	 * state — how DerivedState views are read (see asyncs.ts). */
	AsyncMask = AsyncError | AsyncSuspended,
	/** Either kind of derived evaluation; any re-entry is a cycle. */
	ComputingMask = Computing | DraftComputing,
}
/** The stored per-node word: a composition of Flag bits. */
export type Flags = Brand<number, 'Flags'>

/** Nodes and links are pre-multiplied offsets into one interleaved arena. */
export type ReactiveNodeId = Brand<number, 'ReactiveNodeId'>
export type Link = Brand<number, 'Link'>

/** Node and link records are both 8 words. The changed-at clock reading is
 * a Float64 value in words 6-7, read through the graphClocks view; the
 * remaining per-node fields the record cannot fit live in side columns
 * indexed by record number (validation watermark, observer count, causal
 * event, walk passes, generation). */
export const enum NodeSlot {
	Flags = 0,
	Deps = 1,
	/** Reserved; the live cursor is the handle depsTail field. */
	DepsTail = 2,
	Subs = 3,
	SubsTail = 4,
	RefCount = 5,
	ChangedAt = 6,
	FreeNext = Deps,
}

/** The two clock readings are Float64 values read through the graphClocks
 * view. A record id is a word offset; id >> WordsPerClock is the record's
 * first f64 slot, and the NodeSlot word offsets halve into f64 slot
 * offsets. */
export const enum ClockSlot {
	/** log2(words per f64): converts a word offset into an f64 slot. */
	Shift = 1,
	ChangedAt = NodeSlot.ChangedAt >> Shift,
}

export const enum LinkSlot {
	LinkEvalPass = 0,
	LinkDep = 1,
	LinkSub = 2,
	LinkPrevSub = 3,
	LinkNextSub = 4,
	LinkNextDep = 5,
	LinkInSubs = 6,
	FreeNext = 7,
}

export abstract class ReactiveNode {
	declare readonly id: ReactiveNodeId
	/** Dependency-list append cursor for the evaluation in progress. A handle
	 * field, not a record slot: every touch site holds the handle, and the
	 * cursor is hit twice per tracked read — one property load beats an id
	 * load plus an indexed load. */
	declare depsTail: Link
	declare throwable: ErrorBox | Suspension | null
	declare label: string | undefined
	declare worldMemos: Map<string, unknown> | null
	get flags(): Flags {
		return M[this.id + NodeSlot.Flags]
	}
	set flags(value: Flags) {
		M[this.id + NodeSlot.Flags] = value
	}
	get changedAtGraphChange(): GraphChangeClock {
		return graphClocks[(this.id >> ClockSlot.Shift) + ClockSlot.ChangedAt]
	}
	set changedAtGraphChange(value: GraphChangeClock) {
		graphClocks[(this.id >> ClockSlot.Shift) + ClockSlot.ChangedAt] = value
	}
	get subs(): Link | undefined {
		return M[this.id + NodeSlot.Subs] || undefined
	}
	get deps(): Link | undefined {
		return M[this.id + NodeSlot.Deps] || undefined
	}
	get observerCount(): number {
		return observerColumn[this.id >> RECORD_SHIFT]
	}
	get causeEvent(): TraceEventId {
		return causeColumn[this.id >> RECORD_SHIFT]
	}
	set causeEvent(value: TraceEventId) {
		causeColumn[this.id >> RECORD_SHIFT] = value
	}
	get validAtGraphChange(): GraphChangeClock {
		return validAtColumn[this.id >> RECORD_SHIFT]
	}
}

export interface CellNode<T> extends ReactiveNode {
	value: T | typeof UNINITIALIZED
	initializer: (() => T) | undefined
	equals: EqualsFn<T>
	lifetime: ((ctx: { get(): T; set(v: T): void }) => void | (() => void)) | undefined
	lifetimeCleanup: (() => void) | undefined
	lifetimeActive: boolean
}

export interface DerivedNode<T> extends ReactiveNode {
	value: T | typeof UNINITIALIZED
	fn: (use: UseFn, previous: T | undefined) => T
	equals: EqualsFn<T>
}

export interface WatcherNode extends ReactiveNode {
	fn: (() => void | (() => void)) | undefined
	cleanup: (() => void) | undefined
	children: WatcherNode[] | undefined
	onNotify: (() => void) | undefined
	onDraftWake: ((id: DraftId) => void) | undefined
}

export const RECORD_SHIFT = 3
const RECORD_STRIDE = 1 << RECORD_SHIFT
const NODE_STRIDE = 8
// Fixed capacity: virtual pages are committed on first touch, so the unused
// tail costs address space, not memory. Growth is deliberately omitted so
// every hot access keeps a constant base binding; it belongs only after the
// fixed-arena hot path is competitive.
const RECORD_CAPACITY = 2_097_152
export const graphMemory = new Int32Array(RECORD_STRIDE * RECORD_CAPACITY)
const graphClocks = new Float64Array(graphMemory.buffer)
// Per-node fields the 8-word record cannot fit, indexed by record number.
const validAtColumn = new Float64Array(RECORD_CAPACITY)
const observerColumn = new Int32Array(RECORD_CAPACITY)
const causeColumn = new Int32Array(RECORD_CAPACITY)
const pokeColumn = new Int32Array(RECORD_CAPACITY)
const batchColumn = new Int32Array(RECORD_CAPACITY)
// Bumped every time a record is reclaimed or detached (and never
// zeroed), so an (id, generation) pair names one lifetime of one record.
// The effect queue stores these pairs; an entry whose record moved on
// gen-mismatches and drains as a no-op.
const generationColumn = new Int32Array(RECORD_CAPACITY)
const pinnedInternals: Array<ReactiveNode | undefined> = [undefined]
const M = graphMemory
// Hot functions open with local views (const mem = M, clocks, pins): a
// bundler emits module state as mutable top-level vars, so a module-slot
// read cannot be constant-folded and must re-load after every call; a
// function-local const loads the slot once per activation.

/**
 * Lazy records: cells and deriveds are born WITHOUT an arena record — their
 * id points at one of two shared, immutable detached-state records that hold the
 * born flags word (so every flags READ anywhere stays correct) and zeros in
 * every list/clock slot (no deps, no subs, never changed, never validated).
 * A real record materializes at the node's first graph participation — its
 * first edge, first evaluation, or first traced write — which is also when
 * finalizer registration happens. A handle dropped before that point frees
 * with ordinary GC: no record, no registry cell, nothing to reclaim.
 *
 * Every WRITE of node state must go through a site that materialized the
 * record first; reads need no care. Watchers keep eager records — they are
 * roots with edges from their first run.
 */
const DETACHED_CELL: ReactiveNodeId = NODE_STRIDE
const DETACHED_DERIVED: ReactiveNodeId = NODE_STRIDE * 2
const FIRST_REAL_RECORD = NODE_STRIDE * 3

function initDetachedRecords(): void {
	M[DETACHED_CELL + NodeSlot.Flags] = Flag.KindCell
	M[DETACHED_DERIVED + NodeSlot.Flags] = Flag.KindDerived | Flag.StaleDirty
}
initDetachedRecords()

/** The computed body executing now, independent of dependency tracking.
 * untracked() clears activeConsumer but must not bypass computed policies. */
export let activeEvaluation: DerivedNode<unknown> | null = null
export type TraceFn = (
	kind: string,
	node: ReactiveNode | null,
	cause: TraceEventId,
	data?: unknown,
) => TraceEventId

export let traceHook: TraceFn | null = null
export function setTraceHook(fn: TraceFn | null): void {
	traceHook = fn
}

/** Installed by worlds.ts: true while any draft is live. Detached cells take
 * the recordless write fast path only when this reports false — a live
 * draft world may hold certificate readings of a detached cell's changedAt,
 * and the single-draft cutoff relies on the clock ticking for every real
 * base change. */
export let hasLiveDrafts: () => boolean = () => false
export function setHasLiveDrafts(fn: () => boolean): void {
	hasLiveDrafts = fn
}

export const NO_EVENT: TraceEventId = 0
/** Ambient causal parent for the operation in progress (write/effect/settle). */
export let currentCause: TraceEventId = NO_EVENT
export function setCurrentCause(id: TraceEventId): TraceEventId {
	const prev = currentCause
	currentCause = id
	return prev
}

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

const UNINITIALIZED = Symbol('uninitialized')

export type UseFn = <U>(t: PromiseLike<U>) => U

export function makeCell<T>(
	initial: T | (() => T),
	opts?: {
		equals?: EqualsFn<T>
		label?: string
		onObserved?: (ctx: { get(): T; set(v: T): void }) => void | (() => void)
	},
): CellNode<T> {
	return initializeCell(Object.create(ReactiveNode.prototype) as CellNode<T>, initial, opts)
}

export function initializeCell<T>(
	cell: CellNode<T>,
	initial: T | (() => T),
	opts?: {
		equals?: EqualsFn<T>
		label?: string
		onObserved?: (ctx: { get(): T; set(v: T): void }) => void | (() => void)
	},
): CellNode<T> {
	const lazyInit = typeof initial === 'function'
	;(cell as { id: ReactiveNodeId }).id = DETACHED_CELL
	cell.depsTail = 0
	cell.throwable = null
	cell.label = opts?.label
	cell.value = lazyInit ? UNINITIALIZED : (initial as T)
	cell.initializer = lazyInit ? (initial as () => T) : undefined
	cell.equals = opts?.equals ?? Object.is
	cell.lifetime = opts?.onObserved
	cell.lifetimeCleanup = undefined
	cell.lifetimeActive = false
	cell.worldMemos = null
	return cell
}

export function makeDerived<T>(
	fn: (use: UseFn, previous: T | undefined) => T,
	opts?: { equals?: EqualsFn<T>; label?: string },
): DerivedNode<T> {
	return initializeDerived(Object.create(ReactiveNode.prototype) as DerivedNode<T>, fn, opts)
}

export function initializeDerived<T>(
	node: DerivedNode<T>,
	fn: (use: UseFn, previous: T | undefined) => T,
	opts?: { equals?: EqualsFn<T>; label?: string },
): DerivedNode<T> {
	;(node as { id: ReactiveNodeId }).id = DETACHED_DERIVED
	node.depsTail = 0
	node.throwable = null
	node.label = opts?.label
	node.value = UNINITIALIZED
	node.fn = fn
	node.equals = opts?.equals ?? Object.is
	node.worldMemos = null
	return node
}

// ---------------------------------------------------------------------------
// Dependency linking
// ---------------------------------------------------------------------------

/** Host microtask scheduler (present in every supported runtime; typed here
 * so the engine's type surface stays lib-agnostic). */
declare const queueMicrotask: (fn: () => void) => void

/** Hard iteration ceiling: converts livelock into a thrown error. */
const enum Limit {
	/** Queued-effect runs per flush before declaring a non-settling cycle. */
	FlushRuns = 100_000,
}

export class WriteForbiddenError extends Error {}
/** Policy only. The graph's self-affecting-computed mechanism remains intact;
 * changing this to false restores writes from computeds without changing the
 * evaluation or validation machinery. */
export const FORBID_WRITE_FROM_COMPUTED: boolean = true

let readsForbidden: string | null = null
let writesForbidden: string | null = null

export function assertSignalReadAllowed(): void {
	if (readsForbidden !== null) {
		throw new Error(readsForbidden)
	}
}

export function assertSignalWriteAllowed(): void {
	if (writesForbidden !== null) {
		throw new WriteForbiddenError(writesForbidden)
	}
	if (FORBID_WRITE_FROM_COMPUTED && activeEvaluation !== null) {
		throw new WriteForbiddenError('writes inside computeds are forbidden')
	}
}

export function setWritesForbidden(reason: string | null): string | null {
	const prev = writesForbidden
	writesForbidden = reason
	return prev
}

export function runUpdater<T>(fn: (value: T) => T, value: T): T {
	const prevReads = readsForbidden
	const prevWrites = writesForbidden
	readsForbidden = 'signal reads are not allowed inside an updater or reducer'
	writesForbidden = 'signal writes are not allowed inside an updater or reducer'
	try {
		return fn(value)
	} finally {
		readsForbidden = prevReads
		writesForbidden = prevWrites
	}
}

/** Thrown by evaluation when it parks on an unresolved thenable. */
export const PARKED = Symbol('parked')

/** Set by asyncs.ts: called for use(t) inside a base-state evaluation. */
export let useImpl: (t: PromiseLike<unknown>, consumer: DerivedNode<unknown>) => unknown = () => {
	throw new Error('async use() is not installed')
}
export function setUseImpl(impl: typeof useImpl): void {
	useImpl = impl
}

/** Set by asyncs.ts: finish a recompute, folding parks into async state.
 * Positional outcome (parked, hasError, error, value) — this runs once per
 * recompute, so it must not cost an outcome-object allocation. */
export let finishComputeImpl: (
	node: DerivedNode<unknown>,
	parked: boolean,
	hasError: boolean,
	error: unknown,
	value: unknown,
) => boolean = (node, parked, hasError, error, value) => {
	if (parked || hasError) {
		throw hasError ? error : new Error('parked without async layer')
	}
	const prev = node.value
	if (prev === UNINITIALIZED || !node.equals(prev, value)) {
		node.value = value
		return true
	}
	return false
}
export function setFinishComputeImpl(impl: typeof finishComputeImpl): void {
	finishComputeImpl = impl
}

export function setActiveEvaluation(node: DerivedNode<unknown> | null): DerivedNode<unknown> | null {
	const prev = activeEvaluation
	activeEvaluation = node
	return prev
}

export function isUninitialized(v: unknown): boolean {
	return v === UNINITIALIZED
}

export { UNINITIALIZED }

// ---------------------------------------------------------------------------
// Watchers: effects, scopes, and store subscriptions
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// The engine core. One closure instantiation per process: the arena views
// bind as function-scope consts, which an optimizing compiler can treat as
// immutable across calls — module-level bindings compile to mutable
// context-slot loads once a bundler rewrites them as plain vars. The module
// re-exports the returned functions under their original names, so the
// import surface is unchanged.
// ---------------------------------------------------------------------------

function createGraphCore(
	memBase: Int32Array<ArrayBuffer>,
	clockBase: Float64Array,
	pinBase: Array<ReactiveNode | undefined>,
	validAtBase: Float64Array,
	observerBase: Int32Array<ArrayBuffer>,
	causeBase: Int32Array<ArrayBuffer>,
	pokeBase: Int32Array<ArrayBuffer>,
	batchStampBase: Int32Array<ArrayBuffer>,
	generationBase: Int32Array<ArrayBuffer>,
) {
	const M = memBase
	const graphClocks = clockBase
	const pinnedInternals = pinBase
	const validAtColumn = validAtBase
	const observerColumn = observerBase
	const causeColumn = causeBase
	const pokeColumn = pokeBase
	const batchColumn = batchStampBase
	const generationColumn = generationBase
	// Two-ended allocation: node records grow up from the bottom, link records
	// grow down from the top. Node ids stay dense and contiguous (validation
	// walks touch adjacent lines; the pin table and side columns cover only
	// the node region), and link allocation needs no pin-table growth check.
	let nextNodeRecord = FIRST_REAL_RECORD
	let nextLinkRecord = M.length
	// Free records as explicit stacks, not intrusive next-pointers threaded
	// through the records: a stack pop is an independent indexed load, while
	// an intrusive pop chains a dependent memory read through every
	// allocation — and mass create/dispose cycles allocate in exactly that
	// serial pattern.
	let freeLinkStack = new Int32Array(1024)
	let freeLinkCount = 0
	let freeNodeStack = new Int32Array(1024)
	let freeNodeCount = 0

	function pushFreeLink(id: Link): void {
		if (freeLinkCount === freeLinkStack.length) {
			const bigger = new Int32Array(freeLinkStack.length * 2)
			bigger.set(freeLinkStack)
			freeLinkStack = bigger
		}
		freeLinkStack[freeLinkCount++] = id
	}

	function pushFreeNode(id: ReactiveNodeId): void {
		if (freeNodeCount === freeNodeStack.length) {
			const bigger = new Int32Array(freeNodeStack.length * 2)
			bigger.set(freeNodeStack)
			freeNodeStack = bigger
		}
		freeNodeStack[freeNodeCount++] = id
	}

	/** Materialize the arena record of a detached cell/derived (see above), with
	 * finalizer registration: the general-purpose, always-safe variant. */
	function ensureNodeRecord(node: ReactiveNode): ReactiveNodeId {
		const id = node.id
		if (id >= FIRST_REAL_RECORD) {
			return id
		}
		const born = M[id + NodeSlot.Flags]
		const real = allocNode(node, born | Flag.Registered)
		queueNodeRegistration(node)
		return real
	}

	/** Materialize a dependency's record at link creation. Cells stay
	 * unregistered here: the link about to be created pins the record (and the
	 * handle), and when the last link drops the record detaches in
	 * freeLink — the registry never needs to know. A derived reaching this
	 * point has always evaluated already (readDerived freshens before it
	 * tracks), so the derived branch is a should-not-happen safety net. */
	function ensureDepRecord(dep: ReactiveNode): ReactiveNodeId {
		const id = dep.id
		if (id >= FIRST_REAL_RECORD) {
			return id
		}
		if (id !== DETACHED_CELL) {
			return ensureNodeRecord(dep)
		}
		return allocNode(dep, Flag.KindCell)
	}

	function allocNodeRecord(): number {
		const id = nextNodeRecord
		nextNodeRecord += NODE_STRIDE
		if (nextNodeRecord > nextLinkRecord) {
			throw new RangeError('signals-royale-fx2-dalien record arena exhausted')
		}
		// Grow the pin table in chunks (explicit undefined fill keeps it
		// hole-free on every engine) instead of one push per record.
		if (id >> RECORD_SHIFT >= pinnedInternals.length) {
			for (let i = 0; i < 1024; i++) {
				pinnedInternals.push(undefined)
			}
		}
		return id
	}

	function allocLink(): Link {
		if (freeLinkCount !== 0) {
			return freeLinkStack[--freeLinkCount]
		}
		const id = nextLinkRecord - RECORD_STRIDE
		if (id < nextNodeRecord) {
			throw new RangeError('signals-royale-fx2-dalien record arena exhausted')
		}
		nextLinkRecord = id
		return id
	}

	/** Last link onto an unregistered cell: the record's only owners were its
	 * links, so hand it back and point the live handle at the shared detached
	 * record again. Provably-zero slots stay untouched (no deps ever; refcount
	 * 0 means no subs and no observers); pass stamps are monotonic and
	 * tolerate staleness. Out of line so unpinning stays cheap in freeLink
	 * (hot-cluster inlining budget). */
	function unpinDep(dep: ReactiveNodeId): void {
		const mem = M
		const clocks = graphClocks
		const pins = pinnedInternals
		const depIndex = dep >> RECORD_SHIFT
		const flags = mem[dep + NodeSlot.Flags]
		if ((flags & (Flag.KindCell | Flag.Registered)) === Flag.KindCell) {
			const owner = pins[depIndex] as { id: ReactiveNodeId }
			owner.id = DETACHED_CELL
			mem[dep + NodeSlot.Flags] = 0
			generationColumn[dep >> RECORD_SHIFT]++
			clocks[(dep >> ClockSlot.Shift) + ClockSlot.ChangedAt] = 0
			pushFreeNode(dep)
		}
		pins[depIndex] = undefined
	}

	function freeLink(id: Link): void {
		const mem = M
		const dep = mem[id + LinkSlot.LinkDep]
		if (dep !== 0 && --mem[dep + NodeSlot.RefCount] === 0) {
			unpinDep(dep)
		}
		// No zeroing: unlinkFromSubs already cleared PrevSub/NextSub/InSubs for
		// subs-listed links (and they were never set otherwise), and the insert
		// path assigns LinkDep/LinkSub/LinkNextDep/LinkEvalPass on every reuse.
		// A freed link therefore carries stale-but-dead slot values only.
		pushFreeLink(id)
	}

	function allocNode(owner: ReactiveNode, flags: Flags): ReactiveNodeId {
		// Popped node records were zeroed at reclaim (or provably zero at
		// detach the record), so only the flags word needs a store here.
		const id = freeNodeCount !== 0 ? freeNodeStack[--freeNodeCount] : allocNodeRecord()
		M[id + NodeSlot.Flags] = flags
		;(owner as { id: ReactiveNodeId }).id = id
		return id
	}

	function flagsOf(node: ReactiveNode): Flags {
		return M[node.id + NodeSlot.Flags]
	}

	function setFlags(node: ReactiveNode, flags: Flags): void {
		M[node.id + NodeSlot.Flags] = flags
	}

	function depsOf(node: ReactiveNodeId): Link | undefined {
		return M[node + NodeSlot.Deps] || undefined
	}

	function subsOf(node: ReactiveNodeId): Link | undefined {
		return M[node + NodeSlot.Subs] || undefined
	}

	function subsTailOf(node: ReactiveNodeId): Link | undefined {
		return M[node + NodeSlot.SubsTail] || undefined
	}

	function changedAtOf(node: ReactiveNodeId): GraphChangeClock {
		return graphClocks[(node >> ClockSlot.Shift) + ClockSlot.ChangedAt]
	}

	function validAtOf(node: ReactiveNodeId): GraphChangeClock {
		return validAtColumn[node >> RECORD_SHIFT]
	}

	function linkDep(id: Link): ReactiveNodeId {
		return M[id + LinkSlot.LinkDep]
	}

	function linkSub(id: Link): ReactiveNodeId {
		return M[id + LinkSlot.LinkSub]
	}

	function nextDependency(id: Link): Link | undefined {
		return M[id + LinkSlot.LinkNextDep] || undefined
	}

	function dependencyOf(id: Link): ReactiveNode {
		return pinnedInternals[linkDep(id) >> RECORD_SHIFT]!
	}

	function nextSubscriber(id: Link): Link | undefined {
		return M[id + LinkSlot.LinkNextSub] || undefined
	}

	function subscriberOf(id: Link): ReactiveNode {
		return pinnedInternals[linkSub(id) >> RECORD_SHIFT]!
	}

	let graphChangeClock: GraphChangeClock = 1
	/** Identity of the evaluation pass in progress. */
	let evalPass: EvalPass = 1
	/** Pass counter — monotonic, never reused. Uniqueness is load-bearing for
	 * the same-pass dedup probe in trackRead: an evalPass match there asserts
	 * "this edge was touched by the pass in progress", and a recycled value could
	 * match an edge from a dead pass, whose position may be outside the kept
	 * prefix — trimming would then silently drop a dependency the evaluation
	 * read. */
	let evalPassCounter: EvalPass = 1
	function newEvalPass(): EvalPass {
		evalPass = ++evalPassCounter
		return evalPass
	}
	let activeConsumer: ReactiveNode | null = null
	let batchDepth = 0

	/** Bumped and read by the engine layer; here so cells can report writes. */
	function currentGraphChange(): GraphChangeClock {
		return graphChangeClock
	}

	// ---------------------------------------------------------------------------
	// Tracing seam. tracer.ts installs the hook; a mutable module binding (not
	// an object) so the detached fast path stays one null check per emit site,
	// and the graph itself stays runtime-dependency-free.
	// ---------------------------------------------------------------------------

	function linkIntoSubs(link: Link, sub: ReactiveNode): void {
		const mem = M
		if (mem[link + LinkSlot.LinkInSubs] !== 0) {
			return
		}
		mem[link + LinkSlot.LinkInSubs] = 1
		const dep = linkDep(link)
		mem[link + LinkSlot.LinkPrevSub] = subsTailOf(dep) ?? 0
		mem[link + LinkSlot.LinkNextSub] = 0
		const tail = subsTailOf(dep)
		if (tail !== undefined) {
			mem[tail + LinkSlot.LinkNextSub] = link
		} else {
			mem[dep + NodeSlot.Subs] = link
		}
		mem[dep + NodeSlot.SubsTail] = link
	}

	function unlinkFromSubs(link: Link): void {
		const mem = M
		if (mem[link + LinkSlot.LinkInSubs] === 0) {
			return
		}
		mem[link + LinkSlot.LinkInSubs] = 0
		const dep = linkDep(link)
		const prev = mem[link + LinkSlot.LinkPrevSub]
		const next = mem[link + LinkSlot.LinkNextSub]
		if (prev !== 0) {
			mem[prev + LinkSlot.LinkNextSub] = next
		} else {
			mem[dep + NodeSlot.Subs] = next
		}
		if (next !== 0) {
			mem[next + LinkSlot.LinkPrevSub] = prev
		} else {
			mem[dep + NodeSlot.SubsTail] = prev
		}
		mem[link + LinkSlot.LinkPrevSub] = 0
		mem[link + LinkSlot.LinkNextSub] = 0
	}

	/**
	 * Promote: first observer arrives. Links the dep closure depth-first (cycles
	 * are impossible — dep edges exist only after an evaluation, and cyclic
	 * evaluation throws) and reading-validates each dep once, because the node
	 * spent its unwatched span with no back-edges: dependencies changed without
	 * any push mark reaching it, so its Clean flags may be lies. The reading
	 * comparison alone is insufficient — a stale unwatched dep has not
	 * recomputed, so its changedAt reading cannot have moved even when its
	 * inputs did; the dep's post-promote staleness carries that information up.
	 * Where some dep fails validation, a Clean node is seeded StaleCheck,
	 * restoring the watched tier's invariant that flags are trustworthy (the
	 * stale-cover invariant: for every watched edge, dep stale ⇒ sub stale or
	 * scheduled).
	 */
	function addObserver(node: ReactiveNode): void {
		const mem = M
		const clocks = graphClocks
		const pins = pinnedInternals
		const id = node.id
		const observerCount = ++observerColumn[id >> RECORD_SHIFT]
		if (observerCount === 1) {
			const flags = mem[id + NodeSlot.Flags]
			mem[id + NodeSlot.Flags] = flags | Flag.Watched
			if ((flags & Flag.KindDerived) !== 0) {
				// A canonically Computing node was promoted from inside its running body.
				// Skip history validation: its watermark predates this evaluation, so
				// deps the eval just re-read
				// would compare as changed-since and seed a false StaleCheck. The
				// running eval is the validator — its finally stamps fresh staleness
				// and a current validAt reading.
				const validate = (flags & Flag.Computing) === 0
				const validAt = validAtColumn[id >> RECORD_SHIFT]
				let invalid = false
				for (let l = mem[id + NodeSlot.Deps]; l !== 0; l = mem[l + LinkSlot.LinkNextDep]) {
					linkIntoSubs(l, node)
					const depId = linkDep(l)
					addObserver(pins[depId >> RECORD_SHIFT]!)
					if (
						validate &&
						(changedAtOf(depId) > validAt ||
							(mem[depId + NodeSlot.Flags] & Flag.StaleMask) !== 0)
					) {
						invalid = true
					}
				}
				if (invalid && (mem[id + NodeSlot.Flags] & Flag.StaleMask) === 0) {
					mem[id + NodeSlot.Flags] |= Flag.StaleCheck
				}
			} else if ((node as CellNode<unknown>).lifetime !== undefined) {
				// Only cells reach the non-derived branch (watchers are never
				// dependencies), and only lifetime cells need the transition note.
				noteLifetimeTransition(node)
			}
		}
	}

	/**
	 * Demote: last observer leaves. Cascade-unlinks the back-edges promote
	 * installed (after this, the chain holds forward references only — dropping
	 * user handles collects it whole) and seeds the unwatched tier's
	 * validAtGraphChange reading: Clean at demote means no dependency changed since last validation
	 * (push marks were reliable while watched), so the next quiet read
	 * short-circuits O(1); stale at demote forces the up-walk. Flag distrust
	 * across the tier boundary lives entirely at the two crossings — promote
	 * validates on re-watch, and unwatched pulls never trust Clean without a
	 * current validAtGraphChange — so no staleness seeding happens here.
	 */
	function removeObserver(node: ReactiveNode): void {
		const mem = M
		const clocks = graphClocks
		const pins = pinnedInternals
		const id = node.id
		const observerCount = --observerColumn[id >> RECORD_SHIFT]
		if (observerCount === 0) {
			mem[id + NodeSlot.Flags] &= ~Flag.Watched
			if ((mem[id + NodeSlot.Flags] & Flag.KindDerived) !== 0) {
				for (let l = mem[id + NodeSlot.Deps]; l !== 0; l = mem[l + LinkSlot.LinkNextDep]) {
					unlinkFromSubs(l)
					const dep = linkDep(l)
					removeObserver(pins[dep >> RECORD_SHIFT]!)
				}
				validAtColumn[id >> RECORD_SHIFT] =
					(mem[id + NodeSlot.Flags] & Flag.StaleMask) === 0 ? graphChangeClock : 0
			} else if ((node as CellNode<unknown>).lifetime !== undefined) {
				// Mirror of the promote branch: only lifetime cells need the note.
				noteLifetimeTransition(node)
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Lifetime effects: an atom option that runs setup when the atom gains its
	// first subscriber of ANY kind (computed chain, effect, or React component)
	// and runs the returned cleanup when the last subscriber of every kind is
	// gone. Exactly one observation is active across the union of kinds.
	//
	// Transitions within one tick coalesce through a microtask, so
	// subscribe/unsubscribe flaps (StrictMode double-mounts, list reorders)
	// net out instead of bouncing the resource.
	// ---------------------------------------------------------------------------

	const pendingLifetimeCells = new Set<CellNode<unknown>>()
	let lifetimeFlushScheduled = false

	/** Called at the promote/demote boundary (observation count 0<->1). */
	function noteLifetimeTransition(node: ReactiveNode): void {
		if ((flagsOf(node) & Flag.KindCell) === 0) {
			return
		}
		const cell = node as CellNode<unknown>
		if (cell.lifetime === undefined) {
			return
		}
		pendingLifetimeCells.add(cell)
		if (!lifetimeFlushScheduled) {
			lifetimeFlushScheduled = true
			queueMicrotask(flushLifetimeTransitions)
		}
	}

	/** Settle observation state now (also called from tests). */
	function flushLifetimeTransitions(): void {
		lifetimeFlushScheduled = false
		const cells = [...pendingLifetimeCells]
		pendingLifetimeCells.clear()
		for (const cell of cells) {
			const shouldBeActive = observerColumn[cell.id >> RECORD_SHIFT] > 0
			if (shouldBeActive === cell.lifetimeActive) {
				continue
			}
			cell.lifetimeActive = shouldBeActive
			if (shouldBeActive) {
				const ctx = {
					get: () => peekCell(cell),
					set: (v: unknown) => {
						writeCell(cell, v)
					},
				}
				const cleanup = cell.lifetime!(ctx)
				cell.lifetimeCleanup = typeof cleanup === 'function' ? cleanup : undefined
			} else {
				const cleanup = cell.lifetimeCleanup
				cell.lifetimeCleanup = undefined
				if (cleanup !== undefined) {
					untracked(cleanup)
				}
			}
		}
	}

	/** Record "sub read dep". The common repeat-read path stays small enough to
	 * inline into cell/computed reads; cursor movement and insertion are cold. */
	function trackRead(dep: ReactiveNode, sub: ReactiveNode): void {
		const mem = M
		const depId = dep.id
		const subId = sub.id
		const tail: Link = sub.depsTail
		if (tail !== 0 && mem[tail + LinkSlot.LinkDep] === depId) {
			return
		}
		const next: Link = tail === 0 ? mem[subId + NodeSlot.Deps] : mem[tail + LinkSlot.LinkNextDep]
		if (next !== 0 && mem[next + LinkSlot.LinkDep] === depId) {
			mem[next + LinkSlot.LinkEvalPass] = evalPass
			sub.depsTail = next
			return
		}
		trackReadInsert(dep, sub)
	}

	function trackReadInsert(dep: ReactiveNode, sub: ReactiveNode): void {
		const mem = M
		const pins = pinnedInternals
		// First edge onto a detached dep materializes its record. The sub is never
		// detached here: it is a recomputing derived (recompute materializes) or a
		// watcher (eager records).
		const depId = ensureDepRecord(dep)
		const subId = sub.id
		const tail: Link = sub.depsTail
		const next: Link = tail === 0 ? mem[subId + NodeSlot.Deps] : mem[tail + LinkSlot.LinkNextDep]
		const watched = (mem[subId + NodeSlot.Flags] & Flag.Watched) !== 0
		if (watched) {
			// Same-pass dedup for non-adjacent re-reads: this sub's earlier link
			// sits at the dep's subs tail (cursor reuse re-marks, new watched edges
			// land at the tail), so an evalPass match means the edge already exists and
			// is inside the kept prefix — return it instead of double-registering
			// the observer. Unwatched edges never enter subs lists, so unwatched
			// re-reads keep the tolerated duplicate forward edges (reading-
			// consistent, forward-only garbage).
			const last = subsTailOf(depId)
			if (
				last !== undefined &&
				linkSub(last) === subId &&
				mem[last + LinkSlot.LinkEvalPass] === evalPass
			) {
				return
			}
		}
		const link = allocLink()
		mem[link + LinkSlot.LinkDep] = depId
		mem[link + LinkSlot.LinkSub] = subId
		if (++mem[depId + NodeSlot.RefCount] === 1) {
			pins[depId >> RECORD_SHIFT] = dep
		}
		mem[link + LinkSlot.LinkNextDep] = next
		mem[link + LinkSlot.LinkEvalPass] = evalPass
		if (tail === 0) {
			mem[subId + NodeSlot.Deps] = link
		} else {
			mem[tail + LinkSlot.LinkNextDep] = link
		}
		sub.depsTail = link
		if (watched) {
			// Fused subs insertion: a freshly-allocated link is never already a
			// member of a subscriber list, so the membership guard linkIntoSubs
			// carries for reused links is unnecessary here.
			mem[link + LinkSlot.LinkInSubs] = 1
			const subsTail = mem[depId + NodeSlot.SubsTail]
			mem[link + LinkSlot.LinkPrevSub] = subsTail
			mem[link + LinkSlot.LinkNextSub] = 0
			if (subsTail !== 0) {
				mem[subsTail + LinkSlot.LinkNextSub] = link
			} else {
				mem[depId + NodeSlot.Subs] = link
			}
			mem[depId + NodeSlot.SubsTail] = link
			addObserver(dep)
		}
	}

	/** Drop dependency edges not re-read by the eval that just finished. The
	 * steady state (every edge re-read) is the two loads and one store here;
	 * the freeing walk lives out of line so trimDeps inlines into recompute
	 * and executeWatcher (hot-cluster inlining budget). */
	function trimDeps(sub: ReactiveNode): void {
		const mem = M
		const subId = sub.id
		const tail = sub.depsTail
		const stale = tail === 0 ? mem[subId + NodeSlot.Deps] : mem[tail + LinkSlot.LinkNextDep]
		if (tail !== 0) {
			mem[tail + LinkSlot.LinkNextDep] = 0
		} else {
			mem[subId + NodeSlot.Deps] = 0
		}
		if (stale !== 0) {
			freeStaleDeps(stale)
		}
	}

	function freeStaleDeps(stale: Link): void {
		const mem = M
		const pins = pinnedInternals
		while (stale !== 0) {
			const next = mem[stale + LinkSlot.LinkNextDep]
			if (mem[stale + LinkSlot.LinkInSubs] !== 0) {
				unlinkFromSubs(stale)
				const dep = linkDep(stale)
				removeObserver(pins[dep >> RECORD_SHIFT]!)
			}
			freeLink(stale)
			stale = next
		}
	}

	// ---------------------------------------------------------------------------
	// Invalidation (push through watched edges)
	// ---------------------------------------------------------------------------

	/** Effect watchers scheduled by the current wave, as (record id, generation)
	 * pairs. Ids never pin anything, so retained capacity needs no slot nulling
	 * and enqueue costs two int stores — no handle lookup, no write barrier.
	 * Append-then-fully-drain; a drain entry is dead when its generation moved
	 * (record reclaimed) or its Watched bit dropped (disposed in place). */
	let effectIds = new Int32Array(256)
	let effectGens = new Int32Array(256)
	let effectCount = 0

	function growEffectQueue(): void {
		const ids = new Int32Array(effectIds.length * 2)
		ids.set(effectIds)
		effectIds = ids
		const gens = new Int32Array(effectGens.length * 2)
		gens.set(effectGens)
		effectGens = gens
	}

	/** Render-notify subscribers scheduled by the current wave; notified after
	 * effects settle. Double-buffered under the same retained-capacity
	 * discipline: a draining wave iterates its own buffer while re-marks from
	 * onNotify land in the spare, so a wave's iteration never sees entries added
	 * during delivery. */
	let renderNotifyQueue: Array<ReactiveNode | undefined> = []
	let renderNotifyCount = 0
	/** The off-duty render-notify buffer; null while checked out by a draining
	 * frame. Delivery can nest (onNotify may write, and that flush drains the
	 * buffer this frame's re-marks are landing in), so a doubly-nested frame
	 * finds the spare checked out and must not reuse a buffer that is
	 * mid-iteration. */
	let spareRenderNotify: Array<ReactiveNode | undefined> | null = []

	/** Route a watcher into its flush queue by capability bit. Scope anchors
	 * carry neither bit and are never scheduled (they track no dependencies). */
	function scheduleWatcher(id: ReactiveNodeId, flags: Flags): void {
		const mem = M
		const pins = pinnedInternals
		// One masked test: not already queued AND not disposed (Watched = alive).
		if ((flags & (Flag.Scheduled | Flag.Watched)) !== Flag.Watched) {
			return
		}
		if ((flags & Flag.WatchRender) !== 0) {
			renderNotifyQueue[renderNotifyCount++] = pins[id >> RECORD_SHIFT] as WatcherNode
		} else if ((flags & Flag.WatchRunEffect) !== 0) {
			// Ids, not handles: no lookup and no write barrier here, and no slot
			// nulling at drain. The generation stamp makes a stale entry (record
			// reclaimed, possibly reallocated, between schedule and drain) drain
			// as a no-op instead of touching the record's new owner.
			if (effectCount === effectIds.length) {
				growEffectQueue()
			}
			effectIds[effectCount] = id
			effectGens[effectCount++] = generationColumn[id >> RECORD_SHIFT]
		} else {
			return
		}
		mem[id + NodeSlot.Flags] = flags | Flag.Scheduled
	}

	// ---------------------------------------------------------------------------
	// The graph walks. Contract matrix:
	//
	//                  | marks       | schedules | schedules   | dedup
	//                  | staleness?  | effects?  | render      | mechanism
	//                  |             |           | subscribers?|
	// propagateWave    | StaleCheck  | yes       | yes         | the Clean→StaleCheck
	//                  | on Clean    |           |             | transition (already-
	//                  | nodes       |           |             | stale subtrees are
	//                  |             |           |             | covered, not re-walked)
	// pokeDraftWatchers| StaleCheck  | never     | WatchDraft  | per-node pokePass
	//                  | on poked    |           | only        | reading vs the running
	//                  | watchers    |           |             | walk's id (zero
	//                  | only        |           |             | allocation, no clearing)
	//
	// Neither walk decides whether a subscriber RE-RENDERS: render-notify
	// delivery invokes the subscriber's callback, and the React layer compares
	// what it rendered against what it would resolve now (see hooks.ts) — a
	// per-subscriber value predicate, which is how silent draft folds cost no
	// renders without any global suppression state.
	//
	// propagateFrom and invalidateDerived are the wave's entry points: they add
	// the root node's changedAt/clock movement, then run the wave.
	// ---------------------------------------------------------------------------

	/** Suspended traversal positions for the poke walk (heap, not the JS
	 * call stack, so walk depth is bounded by memory rather than stack frames). */
	interface PokeFrame {
		value: Link | undefined
		changed: boolean
		prev: PokeFrame | undefined
	}

	/** Suspended traversal positions for the invalidation wave: a persistent
	 * integer stack rather than per-frame heap cells. propagateWave never runs
	 * user code, so it cannot nest — one module-level stack serves every wave
	 * with zero allocation on the steady path. */
	let waveStack = new Int32Array(256)

	function growWaveStack(): Int32Array<ArrayBuffer> {
		const bigger = new Int32Array(waveStack.length * 2)
		bigger.set(waveStack)
		waveStack = bigger
		return bigger
	}

	/**
	 * The invalidation wave: push marks down the watched subs closure.
	 *
	 * Marks are always StaleCheck ("possibly stale"): consumers confirm against
	 * dependency changedAt READINGS before recomputing or re-running. Readings —
	 * not marks — are the recompute trigger, which is what makes
	 * write-then-revert inside a batch a true no-op.
	 *
	 * Per-node visit rules (the wave's contract, also applied by any site that
	 * installs a back-edge onto a stale dep — see observeNode):
	 * 1. already stale → re-schedule an unscheduled watcher; do not descend
	 *    (sound under the stale-cover invariant: dep stale ⇒ sub stale or
	 *    scheduled, so everything below is already marked);
	 * 2. Clean → set StaleCheck (never StaleDirty) and record the causal event;
	 * 3. Watching → schedule; watchers have no subscribers, so never descend;
	 * 4. KindDerived → descend (the Clean→StaleCheck transition is the wave's
	 *    visited test).
	 *
	 * Iterative in alien-signals' shape: a link cursor, the pending sibling, and
	 * an explicit stack of suspended positions — single-child descents reuse the
	 * pending sibling instead of pushing, so plain chains run with no stack
	 * growth at all.
	 */
	function propagateWave(link: Link | undefined, cause: TraceEventId): void {
		const mem = M
		if (link === undefined) {
			return
		}
		const tracing = cause !== NO_EVENT
		let stack = waveStack
		let top = 0
		let cur: Link = link
		let next: Link = mem[cur + LinkSlot.LinkNextSub]
		do {
			const sub = mem[cur + LinkSlot.LinkSub]
			const flags = mem[sub + NodeSlot.Flags]
			if ((flags & Flag.StaleMask) !== 0) {
				if ((flags & (Flag.Watching | Flag.Scheduled)) === Flag.Watching) {
					scheduleWatcher(sub, flags)
				}
			} else {
				mem[sub + NodeSlot.Flags] = flags | Flag.StaleCheck
				if (tracing) {
					causeColumn[sub >> RECORD_SHIFT] = cause
				}
				if ((flags & Flag.Watching) !== 0) {
					scheduleWatcher(sub, flags | Flag.StaleCheck)
				} else if ((flags & Flag.KindDerived) !== 0) {
					const subSubs = mem[sub + NodeSlot.Subs]
					if (subSubs !== 0) {
						cur = subSubs
						const sibling = mem[cur + LinkSlot.LinkNextSub]
						if (sibling !== 0) {
							if (top === stack.length) {
								stack = growWaveStack()
							}
							stack[top++] = next
							next = sibling
						}
						continue
					}
				}
			}
			if (next !== 0) {
				cur = next
				next = mem[cur + LinkSlot.LinkNextSub]
				continue
			}
			// Sibling chain exhausted: resume the nearest suspended position.
			// Suspended values can be 0 (the descent happened at its chain's tail);
			// those frames carry nothing to resume and pop straight through.
			let resume = 0
			while (top !== 0) {
				resume = stack[--top]
				if (resume !== 0) {
					break
				}
			}
			if (resume === 0) {
				break
			}
			cur = resume
			next = mem[cur + LinkSlot.LinkNextSub]
		} while (true)
	}

	/** Identity of the poke walk in progress. Monotonic and never reused, so a
	 * node's pokePass reading needs no clearing: a match asserts "this walk
	 * already visited the node" and nothing else (same discipline as EvalPass). */
	let pokePass: PokePass = 0

	/**
	 * The poke walk: notify draft watchers of a node without touching base
	 * state (draft activity — intents appended, retired, or discarded — makes
	 * draft readers re-resolve while base-state readers see no change). It shares
	 * the wave's cursor + frame-stack skeleton and follows the same watched
	 * derived edges down to the subscribers: probes subscribe to the node they
	 * probe (a computed, usually), not to the drafted input, so stopping at the
	 * cell would leave every downstream subscriber unaware. Base-state-only
	 * watchers (no WatchDraft — all effects) stay untouched.
	 *
	 * Marking: poked watchers get StaleCheck for parity with the wave. The
	 * choice is arbitrary — render-notify watchers are never validated (flush
	 * clears staleness unconditionally before delivery), so between here and the
	 * drain the bits are write-only; one convention keeps the matrix above
	 * single-valued.
	 *
	 * `wake` requests draft-id delivery to the same frontier in this ONE walk
	 * (intent appends need both jobs every time; retire/discard/commit call
	 * sites poke without waking). `valueChanged`, when present, supplies the
	 * single-draft value cutoff for each producer: value hooks skip equal
	 * producers while value-independent probes still hear the poke. The walk
	 * runs in the writer's ambient context, so inside a React transition scope
	 * the wake dispatches ride that transition's lanes. The notify flush still
	 * precedes wake delivery: the flush's effects may dispose subscriptions,
	 * and a subscriber disposed by them must not receive the draft id.
	 */
	function pokeDraftWatchers(
		node: ReactiveNode,
		cause: TraceEventId,
		wake?: DraftId,
		valueChanged?: (node: ReactiveNode) => boolean,
	): void {
		const pass = ++pokePass
		const nodeId = node.id
		let wakes: WatcherNode[] | null = null
		let changed = valueChanged?.(node) ?? true
		const first = subsOf(nodeId)
		if (first !== undefined) {
			let cur: Link = first
			let next: Link | undefined = M[cur + LinkSlot.LinkNextSub] || undefined
			let stack: PokeFrame | undefined
			top: do {
				const sub = linkSub(cur)
				const subIndex = sub >> RECORD_SHIFT
				if (pokeColumn[sub >> RECORD_SHIFT] !== pass) {
					pokeColumn[sub >> RECORD_SHIFT] = pass
					const flags = M[sub + NodeSlot.Flags]
					if ((flags & Flag.WatchDraft) !== 0) {
						const w = pinnedInternals[sub >> RECORD_SHIFT] as WatcherNode
						// Value hooks have a draft-lane callback and can use the optional
						// computed cutoff. Probes carry no callback: they still need the
						// poke because pendingness may change while the value stays equal.
						if (w.onDraftWake === undefined || changed) {
							let nextFlags = flags
							if ((flags & Flag.StaleMask) === 0) {
								nextFlags |= Flag.StaleCheck
							}
							scheduleWatcher(sub, nextFlags)
							M[sub + NodeSlot.Flags] = nextFlags | Flag.Scheduled
							if (cause !== NO_EVENT) {
								causeColumn[sub >> RECORD_SHIFT] = cause
							}
							if (wake !== undefined && w.onDraftWake !== undefined) {
								;(wakes ??= []).push(w)
							}
						}
					} else if ((flags & Flag.KindDerived) !== 0) {
						const subSubs = subsOf(sub)
						if (subSubs !== undefined) {
							const subChanged =
								valueChanged?.(pinnedInternals[sub >> RECORD_SHIFT]!) ?? true
							cur = subSubs
							const sibling = M[cur + LinkSlot.LinkNextSub] || undefined
							if (sibling !== undefined) {
								stack = { value: next, changed: subChanged, prev: stack }
								next = sibling
							}
							changed = subChanged
							continue
						}
					}
				}
				if (next !== undefined) {
					cur = next
					next = M[cur + LinkSlot.LinkNextSub] || undefined
					continue
				}
				while (stack !== undefined) {
					const resume = stack.value
					changed = stack.changed
					stack = stack.prev
					if (resume !== undefined) {
						cur = resume
						next = M[cur + LinkSlot.LinkNextSub] || undefined
						continue top
					}
				}
				break
			} while (true)
		}
		if (batchDepth === 0) {
			flush()
		}
		if (wakes !== null) {
			for (const w of wakes) {
				if ((flagsOf(w) & Flag.Watched) !== 0) {
					w.onDraftWake!(wake!)
				}
			}
		}
	}

	/** Push a change wave from a cell whose base value advanced. */
	function propagateFrom(cell: CellNode<unknown>, cause: TraceEventId): void {
		propagateWave(subsOf(cell.id), cause)
		if (batchDepth === 0) {
			flush()
		}
	}

	/**
	 * Invalidate a derived from outside the dependency graph (thenable
	 * settlement). Treated exactly like a write: the clock ticks and the node's
	 * changedAt reading advances so downstream validation re-pulls, subscribers
	 * get marked, effects run.
	 */
	function invalidateDerived(node: DerivedNode<unknown>, cause: TraceEventId): void {
		graphChangeClock++
		const id = node.id
		setFlags(node, (flagsOf(node) & ~Flag.StaleMask) | Flag.StaleDirty)
		causeColumn[id >> RECORD_SHIFT] = cause
		// Invariant: changes are stamped with the CURRENT clock, after the tick.
		graphClocks[(id >> ClockSlot.Shift) + ClockSlot.ChangedAt] = graphChangeClock
		propagateWave(subsOf(id), cause)
		if (batchDepth === 0) {
			flush()
		}
	}

	/** Cells written inside the current batch scope, with their pre-batch state:
	 * a net-revert restores the changedAt reading so consumers validate as
	 * unchanged. */
	const batchBase = new Map<
		CellNode<unknown>,
		{ value: unknown; changedAtGraphChange: GraphChangeClock }
	>()

	/** Identity of the current top-level batch scope; ticks when a batch opens
	 * at depth 0 (nested batches join the enclosing pass, matching batchBase's
	 * lifetime). Cells store their reading in cell.batchPass. */
	let batchPass: BatchPass = 0

	/** First write to this cell in this batch pass: save the pre-batch state.
	 * The pass stamp stands in for a batchBase.has probe on repeat writes. Out
	 * of line so writeCell stays under the hot-cluster inlining budget. */
	function saveBatchBase(cell: CellNode<unknown>, id: ReactiveNodeId): void {
		batchColumn[id >> RECORD_SHIFT] = batchPass
		batchBase.set(cell, {
			value: cell.value,
			changedAtGraphChange: changedAtOf(id),
		})
	}

	function startBatch(): void {
		if (batchDepth === 0) {
			batchPass++
		}
		batchDepth++
	}

	function endBatch(): void {
		if (batchDepth === 0) {
			throw new Error('endBatch() without a matching startBatch()')
		}
		batchDepth--
		if (batchDepth === 0) {
			if (batchBase.size > 0) {
				for (const [cell, base] of batchBase) {
					if (cell.value !== UNINITIALIZED && base.value !== UNINITIALIZED) {
						// Invariant: a net-revert restores the changedAt reading — the
						// batch produced no real change, so consumers must validate as
						// unchanged (the clock still ticked; they pay one reading compare).
						// A cell whose record record-detached mid-batch (last consumer
						// disposed) has nothing to restore — and must not write the
						// shared detached-state record.
						if (cell.id >= FIRST_REAL_RECORD && cell.equals(cell.value, base.value)) {
							graphClocks[(cell.id >> ClockSlot.Shift) + ClockSlot.ChangedAt] = base.changedAtGraphChange
						}
					}
				}
				batchBase.clear()
			}
			flush()
		}
	}

	function batch<T>(fn: () => T): T {
		startBatch()
		try {
			return fn()
		} finally {
			endBatch()
		}
	}

	let flushing = false
	/** Drain cursor into the effect queue (index, not shift: it can be large
	 * and repeated shifts would make wide flushes quadratic). */
	let queueHead = 0

	/** Run queued effects until settled, then deliver render notifications. A
	 * throwing effect aborts the flush; the effects it preempted are skipped
	 * (cleared), not left armed for unrelated writes to trigger later. */
	function flush(): void {
		const mem = M
		const pins = pinnedInternals
		if (flushing) {
			return
		}
		if (effectCount === 0 && renderNotifyCount === 0) {
			return
		}
		flushing = true
		try {
			let guard = 0
			while (queueHead < effectCount) {
				if (++guard > Limit.FlushRuns) {
					throw new Error('effect flush did not settle (cycle?)')
				}
				const i = queueHead++
				const id = effectIds[i]
				if (generationColumn[id >> RECORD_SHIFT] !== effectGens[i]) {
					continue // record reclaimed since scheduling: dead entry
				}
				// Clear Scheduled alone: runWatcher's validation reads StaleCheck.
				const flags: Flags = mem[id + NodeSlot.Flags] & ~Flag.Scheduled
				mem[id + NodeSlot.Flags] = flags
				if ((flags & Flag.Watched) === 0 || (flags & Flag.StaleMask) === 0) {
					continue
				}
				runWatcher(pins[id >> RECORD_SHIFT] as WatcherNode, flags)
			}
			effectCount = 0
			queueHead = 0
		} catch (e) {
			// Preempted effects are skipped, not left armed for unrelated writes to
			// trigger later.
			for (let i = queueHead; i < effectCount; i++) {
				const id = effectIds[i]
				if (generationColumn[id >> RECORD_SHIFT] !== effectGens[i]) {
					continue
				}
				mem[id + NodeSlot.Flags] &= ~(Flag.Scheduled | Flag.StaleMask)
			}
			effectCount = 0
			queueHead = 0
			throw e
		} finally {
			flushing = false
			if (renderNotifyCount > 0) {
				// Take this wave's buffer and swap the spare in as the push target:
				// subscribers scheduled during delivery land there for the NEXT wave,
				// so this iteration never sees them. A doubly-nested delivery finds
				// the spare checked out (null) and takes a fresh array — that rare
				// frame pays a per-wave allocation rather than clobbering a live
				// iteration.
				const delivering = renderNotifyQueue
				const n = renderNotifyCount
				renderNotifyQueue = spareRenderNotify ?? []
				spareRenderNotify = null
				renderNotifyCount = 0
				for (let i = 0; i < n; i++) {
					const w = delivering[i] as WatcherNode
					// Render-notify watchers are never validated, so Scheduled and the
					// staleness bits clear together in one masked store.
					setFlags(w, flagsOf(w) & ~(Flag.Scheduled | Flag.StaleMask))
				}
				try {
					for (let i = 0; i < n; i++) {
						const w = delivering[i] as WatcherNode
						if ((flagsOf(w) & Flag.Watched) !== 0) {
							w.onNotify!()
						}
					}
				} finally {
					// Null consumed slots — retained capacity must not pin watchers —
					// and hand the buffer back as the spare, also on a throwing notify.
					for (let i = 0; i < n; i++) {
						delivering[i] = undefined
					}
					spareRenderNotify = delivering
				}
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Reads and validation (pull)
	// ---------------------------------------------------------------------------

	function materializeCell<T>(cell: CellNode<T>): void {
		if (cell.value !== UNINITIALIZED) {
			return
		}
		const init = cell.initializer
		if (init === undefined) {
			throw new Error('cyclic lazy initializer')
		}
		cell.initializer = undefined
		const prevConsumer = activeConsumer
		const prevForbidden = setWritesForbidden('a lazy state initializer must not write to other state')
		activeConsumer = null
		try {
			cell.value = init()
		} catch (error) {
			cell.initializer = init
			throw error
		} finally {
			activeConsumer = prevConsumer
			setWritesForbidden(prevForbidden)
		}
	}

	/** Untracked base-value read; materializes a lazy cell. */
	function peekCell<T>(cell: CellNode<T>): T {
		assertSignalReadAllowed()
		materializeCell(cell)
		return cell.value as T
	}

	function readCell<T>(cell: CellNode<T>): T {
		assertSignalReadAllowed()
		materializeCell(cell)
		if (activeConsumer !== null) {
			trackRead(cell, activeConsumer)
		}
		return cell.value as T
	}

	function writeCell<T>(cell: CellNode<T>, next: T): boolean {
		const mem = M
		const clocks = graphClocks
		assertSignalWriteAllowed()
		// The equality contract compares against the base value, so a write that
		// arrives before the first read still runs the initializer.
		materializeCell(cell)
		if (cell.equals(cell.value as T, next)) {
			return false
		}
		let id = cell.id
		if (id < FIRST_REAL_RECORD) {
			// A detached cell has no subscribers, no watchers, and no consumer
			// holding a changedAt reading of it (edges materialize the record), so
			// the write is observable only through later reads: store and return.
			// Two parties CAN observe a recordless cell from outside the edge
			// graph and force the full path — live draft worlds (certificate
			// readings and the single-draft cutoff rely on changedAt stamps and
			// clock ticks) and an attached tracer (write events).
			if (traceHook === null && !hasLiveDrafts()) {
				cell.value = next
				return true
			}
			id = ensureNodeRecord(cell)
		}
		if (batchDepth > 0 && batchColumn[id >> RECORD_SHIFT] !== batchPass) {
			saveBatchBase(cell as CellNode<unknown>, id)
		}
		cell.value = next
		// Invariant: tick the clock FIRST, then stamp the change with the new
		// reading — a change stamped at a pre-tick reading could compare equal to
		// a subscriber that validated before this write.
		graphChangeClock++
		clocks[(id >> ClockSlot.Shift) + ClockSlot.ChangedAt] = graphChangeClock
		const cause = traceHook !== null ? traceHook('write', cell, currentCause) : NO_EVENT
		propagateFrom(cell as CellNode<unknown>, cause)
		return true
	}

	/** The use() argument every base recompute passes to fn: one shared
	 * function, no per-node closure — the evaluating computed IS the
	 * activeConsumer at call time. (Draft evaluations pass their own worldUse
	 * instead; see worlds.ts.) A use() that escapes its evaluation — captured
	 * and called later, or called inside untracked() — finds no evaluating
	 * computed and throws rather than park the wrong node. */
	const evalUse: UseFn = (<U>(t: PromiseLike<U>): U => {
		const consumer = activeConsumer
		if (consumer === null || (flagsOf(consumer) & Flag.KindDerived) === 0) {
			throw new Error('use() called outside a computed evaluation')
		}
		return useImpl(t, consumer as DerivedNode<unknown>) as U
	}) as UseFn

	/** Out of line so the cycle path's Error construction and template string
	 * stay out of recompute's bytecode (hot-cluster inlining budget). */
	function throwComputeCycle(node: DerivedNode<unknown>): never {
		throw new Error(`cycle detected in computed${node.label ? ` "${node.label}"` : ''}`)
	}

	function recompute(node: DerivedNode<unknown>): void {
		const mem = M
		const clocks = graphClocks
		const id = ensureNodeRecord(node)
		const flags: Flags = mem[id + NodeSlot.Flags]
		if ((flags & Flag.ComputingMask) !== 0) {
			throwComputeCycle(node)
		}
		mem[id + NodeSlot.Flags] = flags | Flag.Computing
		const prevConsumer = activeConsumer
		const prevEvaluation = activeEvaluation
		activeConsumer = node
		activeEvaluation = node
		const myPass: EvalPass = (evalPass = ++evalPassCounter)
		node.depsTail = 0
		// The validation reading is taken at the PRE-eval clock: if the evaluation
		// itself writes (self-affecting computed), the next read must revalidate.
		const preGraphChange = graphChangeClock
		let parked = false
		let hasError = false
		let error: unknown
		let value: unknown
		try {
			value = node.fn(evalUse, node.value === UNINITIALIZED ? undefined : node.value)
		} catch (e) {
			if (e === PARKED) {
				parked = true
			} else {
				hasError = true
				error = e
			}
		} finally {
			// A nested eval advanced the pass id; restore ours so trimming is exact.
			evalPass = myPass
			activeConsumer = prevConsumer
			activeEvaluation = prevEvaluation
			trimDeps(node)
			mem[id + NodeSlot.Flags] &= ~Flag.Computing
		}
		// Plain success over a plain previous state is the equality cutoff alone —
		// finishComputeImpl's tail with its async no-ops elided (AsyncMask clear
		// implies throwable is already null). Every async-touched outcome takes
		// the installed seam.
		let changed: boolean
		if (!parked && !hasError && (mem[id + NodeSlot.Flags] & Flag.AsyncMask) === 0) {
			const prev = node.value
			if (prev === UNINITIALIZED || !node.equals(prev as never, value as never)) {
				node.value = value
				changed = true
			} else {
				changed = false
			}
		} else {
			changed = finishComputeImpl(node, parked, hasError, error, value)
		}
		// Invariant: only a REAL change advances the reading (equality cutoff
		// keeps the old stamp, so downstream validAt comparisons stay equal).
		// Stamped with the CURRENT clock, not the pre-eval reading: recomputes do
		// not tick the clock, and any consumer that validated before this
		// recompute holds a strictly older validAt reading.
		if (changed) {
			clocks[(id >> ClockSlot.Shift) + ClockSlot.ChangedAt] = graphChangeClock
		}
		// A computed whose evaluation wrote state is self-affecting: its inputs
		// moved under it, so it never caches — every read re-evaluates.
		mem[id + NodeSlot.Flags] =
			(mem[id + NodeSlot.Flags] & ~Flag.StaleMask) |
			(graphChangeClock !== preGraphChange ? Flag.StaleDirty : 0)
		validAtColumn[id >> RECORD_SHIFT] = preGraphChange
	}

	/**
	 * Stackless validation of a pure dependency chain. A node with exactly one
	 * dependency needs no general recursion to validate: its staleness question
	 * is one reading compare against that single dependency, and when the
	 * dependency is itself a single-dep, single-subscriber possibly-stale
	 * derived, the same holds one level down. So: walk DOWN the sole dependency
	 * edges while that shape holds; stop at the first node with nothing below
	 * to resolve (a cell, or a Clean derived — compare-ready) or at a
	 * definitely-stale derived (recompute it); then resolve UPWARD through the
	 * unique subscriber links — per level, one changedAt/validAt reading
	 * compare decides recompute vs clear-and-stamp, exactly what ensureFresh's
	 * loop would do for that node, without its call frames. Any shape mismatch
	 * bails before mutating anything and the generic path takes over.
	 *
	 * Interior nodes need no Watched test: the start is watched, and a watched
	 * node's dependency closure is watched (promote installs it).
	 */
	function chainResolve(startDep: ReactiveNodeId): boolean {
		const mem = M
		const clocks = graphClocks
		const pins = pinnedInternals
		let node = startDep
		let link = mem[node + NodeSlot.Deps]
		if (link === 0 || mem[link + LinkSlot.LinkNextDep] !== 0) {
			return false
		}
		let dep = 0
		while (true) {
			dep = mem[link + LinkSlot.LinkDep]
			const dflags = mem[dep + NodeSlot.Flags]
			if (
				(dflags & (Flag.KindDerived | Flag.StaleMask)) ===
				(Flag.KindDerived | Flag.StaleDirty)
			) {
				recompute(pins[dep >> RECORD_SHIFT] as DerivedNode<unknown>)
				break
			}
			if (
				(dflags & (Flag.KindDerived | Flag.StaleMask)) !==
				(Flag.KindDerived | Flag.StaleCheck)
			) {
				break // a cell or a Clean derived: fresh as-is, compare-ready
			}
			const depDeps = mem[dep + NodeSlot.Deps]
			if (depDeps === 0 || mem[depDeps + LinkSlot.LinkNextDep] !== 0) {
				return false // branching deps: generic validation owns this
			}
			const depSubs = mem[dep + NodeSlot.Subs]
			if (depSubs === 0 || mem[depSubs + LinkSlot.LinkNextSub] !== 0) {
				return false // shared node: the climb needs a unique subscriber
			}
			node = dep
			link = depDeps
		}
		while (true) {
			if (
				clocks[(dep >> ClockSlot.Shift) + ClockSlot.ChangedAt] >
				validAtColumn[node >> RECORD_SHIFT]
			) {
				recompute(pins[node >> RECORD_SHIFT] as DerivedNode<unknown>)
			} else {
				mem[node + NodeSlot.Flags] &= ~Flag.StaleMask
				validAtColumn[node >> RECORD_SHIFT] = graphChangeClock
			}
			if (node === startDep) {
				return true
			}
			const up = mem[node + NodeSlot.Subs]
			if (up === 0) {
				// Restructured by re-entrant user code mid-climb; the untouched
				// upper marks resolve generically on their own pulls.
				return true
			}
			dep = node
			node = mem[up + LinkSlot.LinkSub]
		}
	}

	/** Bring a derived up to date; exact recompute counts are the contract. */
	function ensureFresh(node: DerivedNode<unknown>, knownFlags?: Flags): void {
		const mem = M
		const clocks = graphClocks
		const pins = pinnedInternals
		const id = node.id
		const flags = knownFlags ?? mem[id + NodeSlot.Flags]
		if ((flags & Flag.Watched) !== 0) {
			// Watched: push marks are trustworthy (promote validated the closure).
			if ((flags & Flag.StaleMask) === 0) {
				return
			}
			if (
				(flags & Flag.StaleDirty) === 0 &&
				node.value !== UNINITIALIZED &&
				chainResolve(id)
			) {
				return
			}
		} else if ((flags & Flag.StaleMask) === 0 && validAtOf(id) === graphChangeClock) {
			return
		}
		if ((flags & Flag.StaleDirty) !== 0 || node.value === UNINITIALIZED) {
			recompute(node)
			return
		}
		// StaleCheck state (or unwatched revalidation): confirm dependencies
		// upward, in first-read order, recomputing only if some dependency truly
		// changed after this node's last validation. Invariant: a dep is
		// FRESHENED before its reading is compared — a lazy dep may recompute
		// right here, stamping its changedAt with the current clock, and the
		// strictly-greater test then reports it correctly.
		const validAt = validAtColumn[id >> RECORD_SHIFT]
		for (let l = mem[id + NodeSlot.Deps]; l !== 0; l = mem[l + LinkSlot.LinkNextDep]) {
			const depId = linkDep(l)
			// Same watched-Clean skip as readDerived: such a dep has nothing to
			// validate, so don't pay a call to find that out.
			const dflags = mem[depId + NodeSlot.Flags]
			if (
				(dflags & Flag.KindDerived) !== 0 &&
				(dflags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched
			) {
				ensureFresh(pins[depId >> RECORD_SHIFT] as DerivedNode<unknown>, dflags)
			}
			if (clocks[(depId >> ClockSlot.Shift) + ClockSlot.ChangedAt] > validAt) {
				recompute(node)
				return
			}
		}
		setFlags(node, flagsOf(node) & ~Flag.StaleMask)
		// Invariant: the watermark is stamped only AFTER every dep was freshened
		// and compared (freshen-then-stamp order).
		validAtColumn[id >> RECORD_SHIFT] = graphChangeClock
	}

	function readDerived<T>(node: DerivedNode<T>): T {
		assertSignalReadAllowed()
		// Watched + Clean is the hot steady state (push marks are trustworthy,
		// nothing to validate) — skip the ensureFresh call entirely. Everything
		// else (stale, or unwatched needing the currency check) takes the call.
		const flags = flagsOf(node)
		if ((flags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched) {
			ensureFresh(node as DerivedNode<unknown>, flags)
		}
		if (activeConsumer !== null) {
			trackRead(node, activeConsumer)
		}
		return node.value as T
	}

	function untracked<T>(fn: () => T): T {
		const prev = activeConsumer
		activeConsumer = null
		try {
			return fn()
		} finally {
			activeConsumer = prev
		}
	}

	function getActiveConsumer(): ReactiveNode | null {
		return activeConsumer
	}

	function makeWatcher(
		fn: (() => void | (() => void)) | undefined,
		capabilities: number,
	): WatcherNode {
		const w = {
			// Watchers are born watched — for a watcher the bit means ALIVE, and it
			// drops at dispose; their edges never go through promote/demote
			// counting. Capability bits are creation-fixed: they route scheduling
			// for the watcher's whole life.
			depsTail: 0,
			throwable: null,
			label: undefined,
			fn,
			cleanup: undefined,
			children: undefined,
			onNotify: undefined,
			onDraftWake: undefined,
			worldMemos: null,
		} as WatcherNode
		const id = allocNode(w, Flag.Watching | Flag.Watched | capabilities)
		pinnedInternals[id >> RECORD_SHIFT] = w
		return w
	}

	let activeScope: WatcherNode | null = null

	function runWatcher(w: WatcherNode, flags: Flags): void {
		const mem = M
		const clocks = graphClocks
		const pins = pinnedInternals
		const id = w.id
		// Validate: a StaleCheck-marked watcher whose derived deps cut off must
		// not re-run its body. Validation can itself run user code (computed fns)
		// that disposes this very watcher — re-check after every pull.
		if ((flags & Flag.StaleCheck) !== 0) {
			let changed = false
			const validAt = validAtColumn[id >> RECORD_SHIFT]
			for (let l = mem[id + NodeSlot.Deps]; l !== 0; l = mem[l + LinkSlot.LinkNextDep]) {
				const depId = linkDep(l)
				// Same watched-Clean skip as readDerived: such a dep has nothing to
				// validate, so don't pay a call to find that out.
				const dflags = mem[depId + NodeSlot.Flags]
				if (
					(dflags & Flag.KindDerived) !== 0 &&
					(dflags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched
				) {
					ensureFresh(pins[depId >> RECORD_SHIFT] as DerivedNode<unknown>, dflags)
					if ((flagsOf(w) & Flag.Watched) === 0) {
						return
					} // disposed mid-validation
				}
				if (clocks[(depId >> ClockSlot.Shift) + ClockSlot.ChangedAt] > validAt) {
					changed = true
					break
				}
			}
			if (!changed) {
				setFlags(w, flagsOf(w) & ~Flag.StaleMask)
				// Invariant: watermark stamped only after every dep was freshened and
				// compared (freshen-then-stamp order) — same rule as ensureFresh.
				validAtColumn[id >> RECORD_SHIFT] = graphChangeClock
				return
			}
		}
		setFlags(w, flagsOf(w) & ~Flag.StaleMask)
		executeWatcher(w)
	}

	/** Effects created by the previous run belong to that run. Out of line:
	 * effects with children are the exception, and the loop stays out of
	 * executeWatcher's bytecode (hot-cluster inlining budget). */
	function disposeWatcherChildren(w: WatcherNode): void {
		const children = w.children!
		w.children = undefined
		for (const child of children) {
			disposeWatcher(child)
		}
	}

	/** A throwing cleanup poisons the effect: dispose it fully so it never
	 * half-runs again, then surface the error. Out of line for the same
	 * inlining-budget reason (and it carries a try/catch). */
	function runWatcherCleanup(w: WatcherNode): void {
		const c = w.cleanup!
		w.cleanup = undefined
		try {
			untracked(c)
		} catch (e) {
			disposeWatcher(w)
			throw e
		}
	}

	function executeWatcher(w: WatcherNode): void {
		const mem = M
		const clocks = graphClocks
		const id = w.id
		if (w.children !== undefined) {
			disposeWatcherChildren(w)
		}
		if (w.cleanup !== undefined) {
			runWatcherCleanup(w)
		}
		// Only live effect watchers run a body (WatchRunEffect is creation-fixed
		// and implies fn; Watched = alive).
		if (
			(flagsOf(w) & (Flag.WatchRunEffect | Flag.Watched)) !==
			(Flag.WatchRunEffect | Flag.Watched)
		) {
			return
		}
		const prevConsumer = activeConsumer
		const prevScope = activeScope
		activeConsumer = w
		activeScope = w
		const myPass: EvalPass = (evalPass = ++evalPassCounter)
		w.depsTail = 0
		const cause =
			traceHook !== null ? traceHook('effect-run', w, causeColumn[id >> RECORD_SHIFT]) : NO_EVENT
		// The validation reading is taken at the PRE-run clock: if the body
		// itself writes, its deps may have moved under it, and the wave its write
		// pushed re-schedules this watcher — whose next validation must then see
		// those deps as changed-since (their stamps exceed the pre-run reading).
		const preGraphChange = graphChangeClock
		const prevCause = currentCause
		currentCause = cause
		try {
			const ret = w.fn!()
			if (typeof ret === 'function') {
				w.cleanup = ret
			}
		} finally {
			currentCause = prevCause
			evalPass = myPass
			activeConsumer = prevConsumer
			activeScope = prevScope
			trimDeps(w)
			validAtColumn[id >> RECORD_SHIFT] = preGraphChange
		}
	}

	function disposeWatcher(w: WatcherNode): void {
		// Disposal state is the Watched bit: Watching set + Watched clear = dead.
		if ((flagsOf(w) & Flag.Watched) === 0) {
			return
		}
		setFlags(w, flagsOf(w) & ~Flag.Watched)
		try {
			if (w.children !== undefined) {
				for (const child of w.children) {
					disposeWatcher(child)
				}
				w.children = undefined
			}
			if (w.cleanup !== undefined) {
				const c = w.cleanup
				w.cleanup = undefined
				untracked(c)
			}
		} finally {
			unlinkAllDeps(w)
			const id = w.id
			pinnedInternals[id >> RECORD_SHIFT] = undefined
			// Watcher records dirty only three slots over their whole life: the
			// dep list head/tail (already zeroed by unlinkAllDeps above) and the
			// validation watermark. They are never anyone's dependency (no
			// RefCount, no ChangedAt, no Subs, no ObserverCount), and allocation
			// overwrites Flags — so this slim reclaim replaces the full one.
			validAtColumn[id >> RECORD_SHIFT] = 0
			generationColumn[id >> RECORD_SHIFT]++
			pushFreeNode(id)
		}
	}

	function unlinkAllDeps(w: WatcherNode): void {
		const mem = M
		const pins = pinnedInternals
		const id = w.id
		let l = mem[id + NodeSlot.Deps]
		mem[id + NodeSlot.Deps] = 0
		w.depsTail = 0
		while (l !== 0) {
			const next = mem[l + LinkSlot.LinkNextDep]
			if (mem[l + LinkSlot.LinkInSubs] !== 0) {
				unlinkFromSubs(l)
				const dep = linkDep(l)
				removeObserver(pins[dep >> RECORD_SHIFT]!)
			}
			freeLink(l)
			l = next
		}
	}

	function reclaimNodeRecord(id: number): void {
		const mem = M
		const clocks = graphClocks
		const pins = pinnedInternals
		let link = mem[id + NodeSlot.Deps]
		while (link !== 0) {
			const next = mem[link + LinkSlot.LinkNextDep]
			if (mem[link + LinkSlot.LinkInSubs] !== 0) {
				unlinkFromSubs(link)
				const dep = linkDep(link)
				removeObserver(pins[dep >> RECORD_SHIFT]!)
			}
			freeLink(link)
			link = next
		}
		pins[id >> RECORD_SHIFT] = undefined
		// Explicit stores for the same reason as freeLink: no builtin call per
		// reclaimed node. ChangedAt spans two words; the Float64 view clears both.
		mem[id + NodeSlot.Flags] = 0
		mem[id + NodeSlot.Deps] = 0
		mem[id + NodeSlot.Subs] = 0
		mem[id + NodeSlot.SubsTail] = 0
		mem[id + NodeSlot.RefCount] = 0
		clocks[(id >> ClockSlot.Shift) + ClockSlot.ChangedAt] = 0
		validAtColumn[id >> RECORD_SHIFT] = 0
		observerColumn[id >> RECORD_SHIFT] = 0
		generationColumn[id >> RECORD_SHIFT]++
		// pokePasses/batchPasses stay stale: pass ids are monotonic and never
		// reused, so a stale reading can never equal a future pass. causeEvents
		// stays stale too — it is read only under an attached tracer, and a
		// recycled record's first wave overwrites it.
		pushFreeNode(id)
	}

	let pendingRegistrations: Array<ReactiveNode | undefined> = []
	let pendingRegistrationEnd = 0
	let registrationScheduled = false

	function queueNodeRegistration(owner: ReactiveNode): void {
		pendingRegistrations[pendingRegistrationEnd++] = owner
		if (pendingRegistrationEnd >= 8_192) {
			drainPendingRegistrations()
		} else if (!registrationScheduled) {
			registrationScheduled = true
			queueMicrotask(drainPendingRegistrations)
		}
	}

	function makeNodeFinalizer(): FinalizationRegistry<number> {
		const registry = new FinalizationRegistry<number>((id) => {
			if (nodeFinalizer === registry) {
				reclaimNodeRecord(id)
			}
		})
		return registry
	}

	let nodeFinalizer = makeNodeFinalizer()

	function drainPendingRegistrations(): void {
		registrationScheduled = false
		const end = pendingRegistrationEnd
		for (let i = 0; i < end; i++) {
			const owner = pendingRegistrations[i]!
			nodeFinalizer.register(owner, owner.id)
		}
		pendingRegistrations.fill(undefined, 0, end)
		pendingRegistrationEnd = 0
	}

	/** Benchmark generation boundary: every handle from the old generation must
	 * already be unreachable. This keeps arena capacity out of multi-case runs. */
	function resetGraphForBenchmark(): void {
		M.fill(0, 0, nextNodeRecord)
		M.fill(0, nextLinkRecord)
		const usedRecords = nextNodeRecord >> RECORD_SHIFT
		validAtColumn.fill(0, 0, usedRecords)
		observerColumn.fill(0, 0, usedRecords)
		pinnedInternals.length = 1
		pinnedInternals[0] = undefined
		pendingRegistrations.length = 0
		pendingRegistrationEnd = 0
		registrationScheduled = false
		// The arena fill zeroed every generation stamp, so a leftover queue entry
		// from the old generation could false-match a fresh record: drop the
		// queues with it.
		effectCount = 0
		queueHead = 0
		renderNotifyCount = 0
		initDetachedRecords()
		nextNodeRecord = FIRST_REAL_RECORD
		nextLinkRecord = M.length
		freeLinkCount = 0
		freeNodeCount = 0
		nodeFinalizer = makeNodeFinalizer()
		droppedDisposers = new FinalizationRegistry<WatcherNode>((w) => disposeWatcher(w))
	}

	/**
	 * Reclaims effects whose disposer was dropped without being called. The
	 * watcher node is held by the graph (its dependencies' subscriber lists), so
	 * only the disposer's collectibility tells us the user is done with it.
	 */
	let droppedDisposers = new FinalizationRegistry<WatcherNode>((w) => disposeWatcher(w))

	function makeEffect(fn: () => void | (() => void)): () => void {
		const w = makeWatcher(fn, Flag.WatchRunEffect)
		const owned = activeScope !== null && (flagsOf(activeScope) & Flag.Watched) !== 0
		if (owned) {
			;(activeScope!.children ??= []).push(w)
		}
		executeWatcher(w)
		const dispose = () => {
			droppedDisposers.unregister(dispose)
			disposeWatcher(w)
		}
		// An effect created inside a scope (or another effect) lives and dies
		// with its owner; dropping the per-effect disposer is normal usage there,
		// not abandonment. Only ownerless effects arm the reclamation registry —
		// a collected disposer must never kill an effect something still owns.
		if (!owned) {
			droppedDisposers.register(dispose, w, dispose)
		}
		return dispose
	}

	function makeScope(fn: () => void): () => void {
		// A scope anchor: owns child effects, takes no deliveries of its own.
		const w = makeWatcher(undefined, 0)
		const prevScope = activeScope
		const prevConsumer = activeConsumer
		activeScope = w
		activeConsumer = null
		try {
			fn()
		} finally {
			activeScope = prevScope
			activeConsumer = prevConsumer
		}
		const dispose = () => {
			droppedDisposers.unregister(dispose)
			disposeWatcher(w)
		}
		droppedDisposers.register(dispose, w, dispose)
		return dispose
	}

	/**
	 * A store subscription: subscribes a callback to a node's invalidation wave
	 * without pulling it. This is the React (and committed-view) channel; the
	 * callback runs after the wave and its effects settle, so subscribers can
	 * re-read a consistent graph. Subscriptions are the full component shape —
	 * render-notified and draft-aware (WatchRender|WatchDraft) — regardless of
	 * whether a draft-lane callback is installed: draft pings must reach probes
	 * (isPending, committed views) that carry no wake channel.
	 */
	function observeNode(
		node: ReactiveNode,
		notify: () => void,
		draftWake?: (id: DraftId) => void,
	): () => void {
		const sub = makeWatcher(undefined, Flag.WatchRender | Flag.WatchDraft)
		sub.onNotify = notify
		sub.onDraftWake = draftWake
		newEvalPass()
		const subId = sub.id
		sub.depsTail = 0
		const prevConsumer = activeConsumer
		activeConsumer = sub
		try {
			if ((flagsOf(node) & Flag.KindCell) !== 0) {
				readCell(node as CellNode<unknown>)
			} else if ((flagsOf(node) & Flag.KindDerived) !== 0) {
				// Subscribe to invalidation only; do not force evaluation here.
				trackRead(node, sub)
				// This installed a back-edge without a pull, so the stale-cover
				// invariant is on this site: a stale node means the staleness edge
				// this subscriber cares about already fired (or, for promote-seeded
				// StaleCheck, could never fire while unwatched) — apply the wave's
				// visit rules to the new subscriber so it hears it once. A pull
				// re-arms; edge-triggered semantics are preserved. Never-computed
				// nodes are exempt: they are born StaleDirty with no dependency
				// edges, so no wave was ever swallowed and there is no missed edge —
				// exactly the edge-triggered contract's "no Clean→stale transition
				// happened yet".
				if (
					(flagsOf(node) & Flag.StaleMask) !== 0 &&
					(node as DerivedNode<unknown>).value !== UNINITIALIZED
				) {
					setFlags(sub, flagsOf(sub) | Flag.StaleCheck)
					causeColumn[subId >> RECORD_SHIFT] = causeColumn[node.id >> RECORD_SHIFT]
					scheduleWatcher(subId, flagsOf(sub))
				}
			}
		} finally {
			activeConsumer = prevConsumer
		}
		if (batchDepth === 0) {
			flush()
		}
		const dispose = () => {
			droppedDisposers.unregister(dispose)
			disposeWatcher(sub)
		}
		droppedDisposers.register(dispose, sub, dispose)
		return dispose
	}


	return {
		ensureNodeRecord,
		nextDependency,
		dependencyOf,
		nextSubscriber,
		subscriberOf,
		currentGraphChange,
		addObserver,
		removeObserver,
		flushLifetimeTransitions,
		pokeDraftWatchers,
		propagateFrom,
		invalidateDerived,
		startBatch,
		endBatch,
		batch,
		flush,
		peekCell,
		readCell,
		writeCell,
		ensureFresh,
		readDerived,
		untracked,
		getActiveConsumer,
		disposeWatcher,
		makeEffect,
		makeScope,
		observeNode,
		resetGraphForBenchmark,
	}
}

const core = createGraphCore(
	graphMemory,
	graphClocks,
	pinnedInternals,
	validAtColumn,
	observerColumn,
	causeColumn,
	pokeColumn,
	batchColumn,
	generationColumn,
)

export const ensureNodeRecord = core.ensureNodeRecord
export const nextDependency = core.nextDependency
export const dependencyOf = core.dependencyOf
export const nextSubscriber = core.nextSubscriber
export const subscriberOf = core.subscriberOf
export const currentGraphChange = core.currentGraphChange
export const addObserver = core.addObserver
export const removeObserver = core.removeObserver
export const flushLifetimeTransitions = core.flushLifetimeTransitions
export const pokeDraftWatchers = core.pokeDraftWatchers
export const propagateFrom = core.propagateFrom
export const invalidateDerived = core.invalidateDerived
export const startBatch = core.startBatch
export const endBatch = core.endBatch
export const batch = core.batch
export const flush = core.flush
export const peekCell = core.peekCell
export const readCell = core.readCell
export const writeCell = core.writeCell
export const ensureFresh = core.ensureFresh
export const readDerived = core.readDerived
export const untracked = core.untracked
export const getActiveConsumer = core.getActiveConsumer
export const disposeWatcher = core.disposeWatcher
export const makeEffect = core.makeEffect
export const makeScope = core.makeScope
export const observeNode = core.observeNode
export const resetGraphForBenchmark = core.resetGraphForBenchmark