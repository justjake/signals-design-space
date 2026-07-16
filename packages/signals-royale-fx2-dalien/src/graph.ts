/**
 * The base reactive graph: writable signals, cached computeds, and effects
 * (a tracked compute paired with an untracked handler that runs when the
 * compute's settled value changes — see docs/effects.md).
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
 * - Effects, effect scopes, and subscriptions are explicit resources: their
 *   owners must call the returned disposer. A FinalizationRegistry reclaims
 *   the records of dropped derived handles — their records own dep links a
 *   dead handle must free — and nothing else.
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

import { type ErrorBox, type Suspension, baseUse, finishCompute } from './asyncs.ts'
import type { DraftId } from './worlds.ts'

export type EqualsFn<T> = (a: T, b: T) => boolean

/**
 * Weak number brand. Plain numbers assign in, so creation and increment
 * stay cast-free (`let x: EvalPass = 1; x++`), but a value of one brand
 * does not assign to a slot or parameter of another — counter mixups are
 * type errors. The symbol is declared, never created: purely type-level,
 * and the runtime representation stays a plain number.
 */
declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]?: B }

/**
 * Monotone logical clock: ticks on every base-state change — writes AND
 * settlements. Validation shortcut for unwatched reads.
 */
export type GraphChangeClock = Brand<number, 'GraphChangeClock'>
export type TraceEventId = Brand<number, 'TraceEventId'>
/**
 * Identity of one evaluation pass; monotonic, never reused (see
 * evalPassCounter).
 */
export type EvalPass = Brand<number, 'EvalPass'>
/**
 * Identity of one poke walk; monotonic, never reused, so no per-walk
 * clearing is needed (same discipline as EvalPass).
 */
export type PokePass = Brand<number, 'PokePass'>

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
	/**
	 * Subscriber (alien-signals' name): an effect, a store subscription, or
	 * a scope anchor.
	 */
	Watching = 0b0000_0000_0100,

	// Watch capabilities: creation-fixed, Watching nodes only; dispatch
	// routes on these bits, never on callback presence. Component
	// subscription = Watching|WatchRender; effect = Watching|WatchRunEffect;
	// scope anchor = Watching alone.
	/**
	 * Deliver through the render-notify queue, after sync effects settle.
	 * The subscriber's own notify callback decides whether the delivery
	 * becomes a re-render. Every render watcher is also draft-poked; there
	 * is no separate draft capability bit.
	 */
	WatchRender = 0b0000_0000_1000,
	/**
	 * Effect: at the lane's drain site, refresh its tracked computation and
	 * run the handler when the settled value changed (see drainLane).
	 */
	WatchRunEffect = 0b0000_0001_0000,

	// Staleness: an exclusive pair; writes clear the whole field before
	// setting, so a single-bit test reads the exact state.
	/**
	 * Possibly stale: confirm dependency changedAt readings before
	 * recomputing.
	 */
	StaleCheck = 0b0000_0100_0000,
	/** Definitely stale: recompute on next pull. */
	StaleDirty = 0b0000_1000_0000,

	// Async value plane: an exclusive pair; both clear = plain value.
	/**
	 * Latest evaluation threw; node.throwable holds the ErrorBox to
	 * rethrow.
	 */
	AsyncError = 0b0001_0000_0000,
	/** Latest evaluation parked; node.throwable holds the Suspension. */
	AsyncSuspended = 0b0010_0000_0000,

	// State.
	/**
	 * Double role by kind. Cells/deriveds: mirror of observerCount > 0 —
	 * promote (0→1) sets it, demote (1→0) clears it; the count stays
	 * authoritative, the bit is the one-load hot-path test. Watchers: ALIVE —
	 * set at creation, cleared at dispose, so disposal = Watching set,
	 * Watched clear.
	 */
	Watched = 0b0100_0000_0000,
	/** Watcher sits in a flush queue. */
	Scheduled = 0b1000_0000_0000,
	/** Canonical derived evaluation in progress. */
	Computing = 0b1_0000_0000_0000,
	/**
	 * Draft-world derived evaluation in progress. Separate because only a
	 * canonical evaluation refreshes the graph-validation watermark.
	 */
	DraftComputing = 0b100_0000_0000_0000,
	/**
	 * This record's owner is registered with the node finalizer. Deriveds
	 * always are (their records own dep links a dead handle must free). An
	 * unregistered cell's record is owned by its incoming links alone: when
	 * the last one drops the record detaches instead (see freeLink), so it never
	 * needs the registry — and must never be freed by it.
	 */
	Registered = 0b1000_0000_0000_0000,

	/** Both staleness bits; (flags & StaleMask) === 0 is the Clean state. */
	StaleMask = StaleCheck | StaleDirty,
	/**
	 * Both value-plane bits; (flags & AsyncMask) === 0 is the plain-value
	 * state — how ResolvedState views are read (see asyncs.ts).
	 */
	AsyncMask = AsyncError | AsyncSuspended,
	/** Either kind of derived evaluation; any re-entry is a cycle. */
	ComputingMask = Computing | DraftComputing,
}
/** The stored per-node word: a composition of Flag bits. */
export type Flags = Brand<number, 'Flags'>

/** Nodes and links are pre-multiplied offsets into one interleaved arena. */
export type ReactiveNodeId = Brand<number, 'ReactiveNodeId'>
export type Link = Brand<number, 'Link'>

/**
 * Node and link records are both 8 words. The changed-at clock reading is
 * a Float64 value in words 6-7, read through the graphClocks view; the
 * remaining per-node fields the record cannot fit live in side columns
 * indexed by record number (validation watermark, observer count, causal
 * event, walk passes, generation).
 */
export const enum NodeSlot {
	Flags = 0,
	Deps = 1,
	/**
	 * On effect records: the Lane the effect drains through, so the
	 * write-hot enqueue reads it without a handle lookup. (The dependency
	 * cursor lives on the handle depsTail field, not here.)
	 */
	EffectLane = 2,
	Subs = 3,
	SubsTail = 4,
	RefCount = 5,
	ChangedAt = 6,
	FreeNext = Deps,
}

/**
 * The two clock readings are Float64 values read through the graphClocks
 * view. A record id is a word offset; id >> WordsPerClock is the record's
 * first f64 slot, and the NodeSlot word offsets halve into f64 slot
 * offsets.
 */
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
	/**
	 * Dependency-list append cursor for the evaluation in progress. A handle
	 * field, not a record slot: every touch site holds the handle, and the
	 * cursor is hit twice per tracked read — one property load beats an id
	 * load plus an indexed load.
	 */
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

/**
 * Which queue an effect's signal-triggered runs drain through.
 * Setup runs (creation) are always synchronous and unaffected.
 */
export const enum Lane {
	/** Drained by flush(), when the triggering write or batch settles. */
	Sync = 0,
	/**
	 * With a React host: drained in the layout phase of the hosting root's
	 * commit — after the same write's DOM mutations and app layout effects,
	 * before that frame paints. Headless: a microtask, the only host timing
	 * guaranteed to precede the rendering steps.
	 */
	UseLayoutEffect = 1,
	/**
	 * With a React host: drained in the hosting root's passive phase, the
	 * same flush as useEffect. Headless: setTimeout.
	 */
	UseEffect = 2,
}

/**
 * A dynamically evaluated effect and its untracked delivery state. The
 * compute side (value/fn/equals/throwable) shares the derived evaluator:
 * recompute and ensureFresh work on effect records exactly as on derived
 * records.
 */
export interface EffectNode extends ReactiveNode {
	value: unknown
	fn: (use: UseFn, previous: unknown) => unknown
	equals: EqualsFn<unknown>
	/**
	 * The untracked side effect, handed the settled value and the previously
	 * handled one; may return a cleanup.
	 */
	handler: (value: unknown, previous: unknown) => void | (() => void)
	/**
	 * The compute value the handler last ran with (UNINITIALIZED before
	 * the first run). The delivery gate compares fresh settled values
	 * against this rather than trusting the compute's own cutoff, because
	 * validation and delivery are different moments: change stamps advance
	 * when a pending or error span ends even on an equal value, and a
	 * handler can be deferred a round while the graph moves on.
	 */
	lastHandled: unknown
	/** Which drain site runs the handler (also stored in NodeSlot.EffectLane). */
	lane: Lane
	cleanup: (() => void) | undefined
	/** Direct child effects, allocated only when the first child is created. */
	children: EffectNode[] | undefined
	/**
	 * Set at dispose, never cleared. Handle-owned so it stays readable after
	 * the record returns to the pool: a pending thenable's parked set can
	 * hold this handle past disposal, and settlement checks this mark before
	 * addressing the record (see asyncs.ts settle).
	 */
	disposed: boolean
}

/** A store subscription pinned to one producer for its whole life. */
export interface RenderWatcherNode extends ReactiveNode {
	/**
	 * Render subscribers: delivery callback, run after sync effects
	 * settle, with this watcher's causeEvent — the state change (write,
	 * settle, fold) whose invalidation scheduled it. The callback decides
	 * whether the delivery becomes a re-render.
	 */
	onNotify: ((cause: TraceEventId) => void) | undefined
	/**
	 * Draft-wake callback: receives the id and cause of a transition draft
	 * whose new write touches this subscriber's sources. Separate from
	 * onNotify so draft activity never looks like a base-state change to
	 * subscribers that compare snapshots.
	 */
	onDraftWake: ((id: DraftId, cause: TraceEventId) => void) | undefined
}

/**
 * A scope anchor: owns child effects, takes no deliveries of its own.
 * Effects can own children too (nested effects created inside a handler
 * belong to that run).
 */
export interface ScopeNode extends ReactiveNode {
	children: EffectNode[] | undefined
}

export type WatcherNode = EffectNode | RenderWatcherNode | ScopeNode

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

/**
 * The computed body executing now, independent of dependency tracking.
 * untracked() clears activeConsumer but must not bypass computed policies.
 */
export let activeEvaluation: DerivedNode<unknown> | null = null

// ---------------------------------------------------------------------------
// Tracing seam. tracer.ts installs the sink. Mutable module bindings rather
// than object properties, so the common detached case costs one null check
// per emit site and the graph has no runtime dependency on the tracer.
// ---------------------------------------------------------------------------

/**
 * Emit one entry (or open a span) and return its id, so the caller can pass
 * it on as the cause/parent of downstream entries.
 */
export type EmitFn = (
	kind: string,
	node: ReactiveNode | null,
	parent: TraceEventId,
	attrs?: TraceFields,
) => TraceEventId

/**
 * Optional semantic identities and outcomes attached when an entry is emitted
 * or a span is opened. The consumer converts object identities to stable
 * numeric ids before it stores the entry.
 */
export interface TraceFields {
	root?: object
	suspension?: object
	draftId?: DraftId
	error?: unknown
	status?: string
	phase?: string
	world?: readonly DraftId[]
}

/**
 * Outcome known only when a span closes. A compute reports whether its result
 * changed; effects carry nothing. Duration is deliberately NOT here — the
 * consumer owns the clock and times a span from its start/end calls.
 */
export interface SpanEndAttrs {
	changed?: boolean
}
/** Close a trace span and optionally record its outcome. */
export type EndSpanFn = (id: TraceEventId, attrs?: SpanEndAttrs) => void

/**
 * The engine's trace sink, shaped like a real tracing API:
 *  - `emitEvent` records an instantaneous entry (a write, a notify, an error).
 *  - `startSpan`/`endSpan` bracket durationful work (a compute, an effect);
 *    every `startSpan` is matched by an `endSpan`, so there are no dangling
 *    opens for a reader to chase.
 * The engine does no timing — the consumer stamps start and end from its own
 * clock. Installed as three module bindings so each emit site stays a direct
 * null-checked call (no per-emit property load) on the hot path.
 */
export interface TraceSink {
	emitEvent: EmitFn
	startSpan: EmitFn
	endSpan?: EndSpanFn
}
export let emitEvent: EmitFn | null = null
export let startSpan: EmitFn | null = null
export let endSpan: EndSpanFn | null = null
/**
 * Install or detach the engine's low-level trace sink.
 *
 * Only one sink is active at a time. Passing `null` returns every emit site to
 * its detached, single-null-check path.
 */
export function setTracer(sink: TraceSink | null): void {
	emitEvent = sink?.emitEvent ?? null
	startSpan = sink?.startSpan ?? null
	endSpan = sink?.endSpan ?? null
}

// ---------------------------------------------------------------------------
// Hot algorithm channel. A second, independently gated hook for the
// highest-volume internal steps: the invalidation wave, the dependency
// validation walk, and the recompute. Deliberately NOT routed through the
// emitEvent seam above — these steps would flood the causal log, and each
// channel must attach and detach alone. Same discipline as the tracer seam:
// a mutable module binding, detached cost is one null check per site.
// ---------------------------------------------------------------------------

/**
 * One hot step: the invalidation wave pushing staleness marks ('propagate'),
 * the dependency-validation walk ('check'), or a re-evaluation ('pull').
 */
export type HotStep = 'propagate' | 'check' | 'pull'
/**
 * The hot channel's hook. It receives the live node plus a step tag and must
 * not retain the node — derive an id and drop the reference (the devtools
 * adapter maps nodes to numeric ids through WeakRefs).
 */
export type HotFn = (node: ReactiveNode, step: HotStep) => void
let hotHook: HotFn | null = null
/** Install or detach the hot hook. `null` restores the detached null-check path. */
export function setHotTracer(fn: HotFn | null): void {
	hotHook = fn
}

/**
 * Installed by worlds.ts: true while any draft is live. Detached cells take
 * the recordless write fast path only when this reports false — a live
 * draft world may hold certificate readings of a detached cell's changedAt,
 * and the single-draft cutoff relies on the clock ticking for every real
 * base change.
 */
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
	// No depsTail and no throwable: cells produce plain values and never
	// consume or park, so the dependency cursor and the async payload slot
	// are consumer-only state.
	cell.label = opts?.label
	cell.value = lazyInit ? UNINITIALIZED : initial
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

/**
 * Host schedulers (present in every supported runtime; typed here so the
 * engine's type surface stays lib-agnostic).
 */
declare const queueMicrotask: (fn: () => void) => void
declare const setTimeout: (fn: () => void, ms?: number) => unknown

/** Hard iteration ceiling: converts livelock into a thrown error. */
const enum Limit {
	/** Queued-effect pulls per drain before declaring a non-settling cycle. */
	DrainRuns = 100_000,
}

export class SignalReadForbidden extends Error {
	name = 'SignalReadForbidden'
}
export class SignalWriteForbidden extends Error {
	name = 'SignalWriteForbidden'
}
/**
 * Policy only. The graph's self-affecting-computed mechanism remains intact;
 * changing this to false restores writes from computeds without changing the
 * evaluation or validation machinery.
 */
export const FORBID_WRITE_FROM_COMPUTED: boolean = true

let readsForbidden: string | null = null
let writesForbidden: string | null = null

/**
 * Cold policy path shared by read and write guards. Keeping construction
 * and tracing here leaves the successful guards as their original checks.
 */
function throwSignalAccessForbidden(kind: 'read' | 'write', reason: string): never {
	const error =
		kind === 'read' ? new SignalReadForbidden(reason) : new SignalWriteForbidden(reason)
	if (emitEvent !== null) {
		emitEvent('policy-error', activeEvaluation, currentCause, { error, phase: kind })
	}
	throw error
}

export function assertSignalReadAllowed(): void {
	if (readsForbidden !== null) {
		throwSignalAccessForbidden('read', readsForbidden)
	}
}

export function assertSignalWriteAllowed(): void {
	if (writesForbidden !== null) {
		throwSignalAccessForbidden('write', writesForbidden)
	}
	if (FORBID_WRITE_FROM_COMPUTED && activeEvaluation !== null) {
		throwSignalAccessForbidden('write', 'writes inside computeds are forbidden')
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

export function setActiveEvaluation(
	node: DerivedNode<unknown> | null,
): DerivedNode<unknown> | null {
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
	generationBase: Int32Array<ArrayBuffer>,
) {
	const M = memBase
	const graphClocks = clockBase
	const pinnedInternals = pinBase
	const validAtColumn = validAtBase
	const observerColumn = observerBase
	const causeColumn = causeBase
	const pokeColumn = pokeBase
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

	/**
	 * Materialize the arena record of a detached cell/derived (see above), with
	 * finalizer registration: the general-purpose, always-safe variant.
	 */
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

	/**
	 * Materialize a dependency's record at link creation. Cells stay
	 * unregistered here: the link about to be created pins the record (and the
	 * handle), and when the last link drops the record detaches in
	 * freeLink — the registry never needs to know. A derived reaching this
	 * point has always evaluated already (readDerived freshens before it
	 * tracks), so the derived branch is a should-not-happen safety net.
	 */
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

	/**
	 * Last link onto an unregistered cell: the record's only owners were its
	 * links, so hand it back and point the live handle at the shared detached
	 * record again. Provably-zero slots stay untouched (no deps ever; refcount
	 * 0 means no subs and no observers); pass stamps are monotonic and
	 * tolerate staleness. Out of line so unpinning stays cheap in freeLink
	 * (hot-cluster inlining budget).
	 */
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
	/**
	 * The clock reading at the last BASE change — a cell write or a
	 * settlement invalidation. Draft activity ticks the clock (world memos
	 * and caches key their fast paths on it) without moving this watermark,
	 * so "did base state change since X" stays answerable: compare X against
	 * this reading, not against the clock.
	 */
	let baseChangedAtGraphChange: GraphChangeClock = 1
	/** Identity of the evaluation pass in progress. */
	let evalPass: EvalPass = 1
	/**
	 * Pass counter — monotonic, never reused. Uniqueness is load-bearing for
	 * the same-pass dedup probe in trackRead: an evalPass match there asserts
	 * "this edge was touched by the pass in progress", and a recycled value could
	 * match an edge from a dead pass, whose position may be outside the kept
	 * prefix — trimming would then silently drop a dependency the evaluation
	 * read.
	 */
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

	/**
	 * Advance the one change clock. Draft activity (opens, intent appends,
	 * retires, discards) and thenable settlement tick through here so every
	 * clock-keyed fast path — world memos, the world cache, unwatched
	 * validation short-circuits — revalidates; base writes tick inline and
	 * additionally move the base watermark.
	 */
	function tickGraphChange(): GraphChangeClock {
		return ++graphChangeClock
	}

	/** The clock reading at the last base change (write or settlement). */
	function currentBaseChange(): GraphChangeClock {
		return baseChangedAtGraphChange
	}

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
						(changedAtOf(depId) > validAt || (mem[depId + NodeSlot.Flags] & Flag.StaleMask) !== 0)
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
				let cleanup: void | (() => void)
				try {
					cleanup = cell.lifetime!(ctx)
				} catch (error) {
					if (emitEvent !== null) {
						emitEvent('callback-error', cell, causeColumn[cell.id >> RECORD_SHIFT], {
							error,
							phase: 'on-observed',
						})
					}
					throw error
				}
				cell.lifetimeCleanup = typeof cleanup === 'function' ? cleanup : undefined
			} else {
				const cleanup = cell.lifetimeCleanup
				cell.lifetimeCleanup = undefined
				if (cleanup !== undefined) {
					try {
						untracked(cleanup)
					} catch (error) {
						if (emitEvent !== null) {
							emitEvent('cleanup-error', cell, causeColumn[cell.id >> RECORD_SHIFT], {
								error,
								phase: 'on-observed',
							})
						}
						throw error
					}
				}
			}
		}
	}

	/**
	 * Record "sub read dep". The common repeat-read path stays small enough to
	 * inline into cell/computed reads; cursor movement and insertion are cold.
	 */
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

	/**
	 * Drop dependency edges not re-read by the eval that just finished. The
	 * steady state (every edge re-read) is the two loads and one store here;
	 * the freeing walk lives out of line so trimDeps inlines into recompute
	 * and executeWatcher (hot-cluster inlining budget).
	 */
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
		// An effect disposed by its own evaluation (Watching set, Watched
		// clear) must not keep the edges that evaluation tracked after the
		// dispose released everything tracked before it.
		if ((mem[subId + NodeSlot.Flags] & (Flag.Watching | Flag.Watched)) === Flag.Watching) {
			unlinkAllDeps(sub as WatcherNode)
			;(sub as WatcherNode).depsTail = 0
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

	/**
	 * One effect lane: watchers queued toward one drain site, as (record id,
	 * generation) pairs. Ids never pin anything, so enqueue costs two int
	 * stores — no handle lookup, no write barrier — and a record reclaimed
	 * between schedule and drain gen-mismatches into a no-op. The drain's
	 * pull phase resolves survivors into the retained `handles` array so the
	 * run phases can re-check and invoke them; consumed handle slots are
	 * nulled so retained capacity never pins disposed effects.
	 */
	interface LaneState {
		ids: Int32Array
		gens: Int32Array
		handles: Array<EffectNode | undefined>
		/**
		 * Round cursor; entries below it are consumed. An index rather than
		 * shifting so wide drains stay linear.
		 */
		head: number
		count: number
		/** The lane's pump is requested and has not run yet. */
		pumpRequested: boolean
	}

	function makeLane(): LaneState {
		return {
			ids: new Int32Array(256),
			gens: new Int32Array(256),
			handles: [],
			head: 0,
			count: 0,
			pumpRequested: false,
		}
	}

	const lanes: readonly [LaneState, LaneState, LaneState] = [makeLane(), makeLane(), makeLane()]

	function growLane(state: LaneState): void {
		const ids = new Int32Array(state.ids.length * 2)
		ids.set(state.ids)
		state.ids = ids
		const gens = new Int32Array(state.gens.length * 2)
		gens.set(state.gens)
		state.gens = gens
	}

	/**
	 * A host-installed pump for the deferred lanes. Returning true means the
	 * host owns this request and will eventually reach the drain entry points
	 * (the React bindings re-render a per-root sentinel whose commit-phase
	 * effects drain); false falls back to the built-in pumps.
	 */
	let lanePump: ((lane: Lane.UseLayoutEffect | Lane.UseEffect) => boolean) | null = null

	function setLanePump(pump: typeof lanePump): void {
		lanePump = pump
	}

	/**
	 * Drain the useLayoutEffect lane now. Hosted drains call this from the
	 * commit's layout phase, after the pass's DOM mutations.
	 */
	function drainUseLayoutEffectLane(): void {
		lanes[Lane.UseLayoutEffect].pumpRequested = false
		drainLane(lanes[Lane.UseLayoutEffect])
	}

	/**
	 * Drain both deferred lanes now. Lane order is total regardless of pump
	 * timing: the useLayoutEffect lane settles first, so its entries can
	 * never run after same-wave useEffect entries even when this site's pump
	 * (a task) fires before a pending useLayoutEffect drain. Hosted drains
	 * call this from the commit's passive phase.
	 */
	function drainDeferredEffects(): void {
		lanes[Lane.UseEffect].pumpRequested = false
		drainLane(lanes[Lane.UseLayoutEffect])
		drainLane(lanes[Lane.UseEffect])
	}

	function requestLaneDrain(lane: Lane.UseLayoutEffect | Lane.UseEffect): void {
		const state = lanes[lane]
		if (state.pumpRequested) {
			return
		}
		state.pumpRequested = true
		if (lanePump !== null && lanePump(lane)) {
			return
		}
		if (lane === Lane.UseLayoutEffect) {
			queueMicrotask(drainUseLayoutEffectLane)
		} else {
			setTimeout(drainDeferredEffects, 0)
		}
	}

	/**
	 * Re-arm the built-in pumps for any deferred entries still queued.
	 * Called when a host pump accepted requests whose drains will now never
	 * arrive (the last hosting root unmounted, or the host uninstalled).
	 */
	function repumpDeferredLanes(): void {
		for (const lane of [Lane.UseLayoutEffect, Lane.UseEffect] as const) {
			const state = lanes[lane]
			if (state.count > state.head) {
				state.pumpRequested = false
				requestLaneDrain(lane)
			}
		}
	}

	/**
	 * Run every scheduled effect right now instead of waiting for its
	 * 'useLayoutEffect'/'useEffect' timing, and settle any pending
	 * onObserved subscriptions. For tests and non-React environments, where
	 * nothing else forces scheduled work to a deterministic moment.
	 */
	function flushScheduledEffects(): void {
		flushLifetimeTransitions()
		const layoutLane = lanes[Lane.UseLayoutEffect]
		if (layoutLane.head !== 0) {
			return
		}
		drainLane(layoutLane)
		drainLane(lanes[Lane.UseEffect])
	}

	/**
	 * Drop queued lane entries without running them (test reset). An active
	 * drain keeps its cursor, and later writes append after it as a new
	 * round. Already-requested pumps fire on empty queues, which is harmless.
	 */
	function resetEffectLanes(): void {
		for (const state of lanes) {
			for (let i = 0; i < state.count; i++) {
				state.handles[i] = undefined
			}
			state.count = state.head
			state.pumpRequested = false
		}
	}

	/**
	 * Render-notify subscribers scheduled by the current wave; notified after
	 * effects settle. Double-buffered under the same retained-capacity
	 * discipline: a draining wave iterates its own buffer while re-marks from
	 * onNotify land in the spare, so a wave's iteration never sees entries added
	 * during delivery.
	 */
	let renderNotifyQueue: Array<ReactiveNode | undefined> = []
	let renderNotifyCount = 0
	/**
	 * The off-duty render-notify buffer; null while checked out by a draining
	 * frame. Delivery can nest (onNotify may write, and that flush drains the
	 * buffer this frame's re-marks are landing in), so a doubly-nested frame
	 * finds the spare checked out and must not reuse a buffer that is
	 * mid-iteration.
	 */
	let spareRenderNotify: Array<ReactiveNode | undefined> | null = []

	/**
	 * Route a watcher into its queue by capability bit and lane. Scope
	 * anchors carry neither bit and are never scheduled (they track no
	 * dependencies).
	 */
	function scheduleWatcher(id: ReactiveNodeId, flags: Flags): void {
		const mem = M
		const pins = pinnedInternals
		// One masked test: not already queued AND not disposed (Watched = alive).
		if ((flags & (Flag.Scheduled | Flag.Watched)) !== Flag.Watched) {
			return
		}
		if ((flags & Flag.WatchRender) !== 0) {
			renderNotifyQueue[renderNotifyCount++] = pins[id >> RECORD_SHIFT]
		} else if ((flags & Flag.WatchRunEffect) !== 0) {
			// Ids, not handles: no lookup and no write barrier here. The
			// generation stamp makes a stale entry (record reclaimed, possibly
			// reallocated, between schedule and drain) drain as a no-op instead
			// of touching the record's new owner. The lane lives in the record
			// so this write-hot path never resolves the handle.
			const lane = mem[id + NodeSlot.EffectLane] as Lane
			const state = lanes[lane]
			if (state.count === state.ids.length) {
				growLane(state)
			}
			state.ids[state.count] = id
			state.gens[state.count++] = generationColumn[id >> RECORD_SHIFT]
			if (lane !== Lane.Sync) {
				requestLaneDrain(lane)
			}
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
	// pokeDraftWatchers| StaleCheck  | never     | WatchRender | per-node pokePass
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

	/**
	 * Suspended traversal positions for the poke walk (heap, not the JS
	 * call stack, so walk depth is bounded by memory rather than stack frames).
	 */
	interface PokeFrame {
		value: Link | undefined
		changed: boolean
		prev: PokeFrame | undefined
	}

	/**
	 * Suspended traversal positions for the invalidation wave: a persistent
	 * integer stack rather than per-frame heap cells. propagateWave never runs
	 * user code, so it cannot nest — one module-level stack serves every wave
	 * with zero allocation on the steady path.
	 */
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
		if (hotHook !== null) {
			// Every link in a subscriber list shares its dep: the changed producer.
			hotHook(pinnedInternals[linkDep(link) >> RECORD_SHIFT]!, 'propagate')
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

	/**
	 * Identity of the poke walk in progress. Monotonic and never reused, so a
	 * node's pokePass reading needs no clearing: a match asserts "this walk
	 * already visited the node" and nothing else (same discipline as EvalPass).
	 */
	let pokePass: PokePass = 0

	/**
	 * The poke walk: notify draft watchers of a node without touching base
	 * state (draft activity — intents appended, retired, or discarded — makes
	 * draft readers re-resolve while base-state readers see no change). It shares
	 * the wave's cursor + frame-stack skeleton and follows the same watched
	 * derived edges down to the subscribers: probes subscribe to the node they
	 * probe (a computed, usually), not to the drafted input, so stopping at the
	 * cell would leave every downstream subscriber unaware. Watchers without
	 * the WatchRender bit (ordinary engine effects) are untouched.
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
		let wakes: RenderWatcherNode[] | null = null
		let changed = valueChanged?.(node) ?? true
		const first = subsOf(nodeId)
		if (first !== undefined) {
			let cur: Link = first
			let next: Link | undefined = M[cur + LinkSlot.LinkNextSub] || undefined
			let stack: PokeFrame | undefined
			top: do {
				const sub = linkSub(cur)
				if (pokeColumn[sub >> RECORD_SHIFT] !== pass) {
					pokeColumn[sub >> RECORD_SHIFT] = pass
					const flags = M[sub + NodeSlot.Flags]
					if ((flags & Flag.WatchRender) !== 0) {
						const w = pinnedInternals[sub >> RECORD_SHIFT] as RenderWatcherNode
						// Value hooks have a draft-wake callback and can use the optional
						// computed cutoff. Probes carry no callback: they still need the
						// poke because pendingness may change while the value stays equal.
						if (w.onDraftWake === undefined || changed) {
							let nextFlags = flags
							if ((flags & Flag.StaleMask) === 0) {
								nextFlags |= Flag.StaleCheck
							}
							scheduleWatcher(sub, nextFlags)
							M[sub + NodeSlot.Flags] = nextFlags | Flag.Scheduled
							// A cause-less poke (a root commit with no tracer, a rebase
							// after an equality no-op) keeps the previous attribution
							// instead of wiping a pending delivery's cause.
							if (cause !== NO_EVENT) {
								causeColumn[sub >> RECORD_SHIFT] = cause
							}
							if (wake !== undefined && w.onDraftWake !== undefined) {
								;(wakes ??= []).push(w)
							}
						}
					} else if ((flags & Flag.KindDerived) !== 0) {
						// Stamp traversed computeds for tracing: a draft-world
						// evaluation (the write-time cutoff below, or a transition
						// render) opens its compute span with causeEvent, so a
						// background recompute chains through the draft activity
						// that disturbed it.
						if (cause !== NO_EVENT) {
							causeColumn[sub >> RECORD_SHIFT] = cause
						}
						const subSubs = subsOf(sub)
						if (subSubs !== undefined) {
							const subChanged = valueChanged?.(pinnedInternals[sub >> RECORD_SHIFT]!) ?? true
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
				// Pin identity is the liveness test: a disposed watcher's record may
				// already be reclaimed and reused, so its flags word cannot be read.
				if (pinnedInternals[w.id >> RECORD_SHIFT] === w) {
					w.onDraftWake!(wake!, cause)
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
	 * Invalidate a derived — or an effect's compute — from outside the
	 * dependency graph (thenable settlement). Treated exactly like a write:
	 * the clock ticks and the node's changedAt reading advances so downstream
	 * validation re-pulls, subscribers get marked, effects run.
	 */
	function invalidateDerived(node: DerivedNode<unknown>, cause: TraceEventId): void {
		graphChangeClock++
		baseChangedAtGraphChange = graphChangeClock
		const id = node.id
		const flags: Flags = (M[id + NodeSlot.Flags] & ~Flag.StaleMask) | Flag.StaleDirty
		M[id + NodeSlot.Flags] = flags
		causeColumn[id >> RECORD_SHIFT] = cause
		// Invariant: changes are stamped with the CURRENT clock, after the tick.
		graphClocks[(id >> ClockSlot.Shift) + ClockSlot.ChangedAt] = graphChangeClock
		if ((flags & Flag.Watching) !== 0) {
			// An effect's own compute settled: route the effect to its lane.
			scheduleWatcher(id, flags)
		} else {
			propagateWave(subsOf(id), cause)
		}
		if (batchDepth === 0) {
			flush()
		}
	}

	/**
	 * Begin a manual batch. Pair every call with endBatch; prefer batch when
	 * the work fits in one callback.
	 */
	function startBatch(): void {
		batchDepth++
	}

	/** End a manual batch and flush when the outermost batch closes. */
	function endBatch(): void {
		if (batchDepth === 0) {
			throw new Error('endBatch() without a matching startBatch()')
		}
		batchDepth--
		if (batchDepth === 0) {
			flush()
		}
	}

	/**
	 * Run `fn` as one propagation batch and return its result.
	 *
	 * Writes still update their atoms in order, but dependent computeds,
	 * effects, and subscribers settle only after the outermost batch closes.
	 */
	function batch<T>(fn: () => T): T {
		startBatch()
		try {
			return fn()
		} finally {
			endBatch()
		}
	}

	/**
	 * Drain one effect lane: the write path only marked and enqueued, so this
	 * is where an effect validates and runs. Each round is two phases over the
	 * entries queued when it starts (a handler's writes append past the round
	 * and are picked up by the next one):
	 *
	 * 1. Pull. Bring every compute fresh and keep only effects whose settled
	 *    value differs from the last-handled one. Parked computes and equal
	 *    values drop out; nothing here has side effects, so a recompute burst
	 *    never interleaves with handler work.
	 * 2. Run. All survivors' cleanups, then all handlers (React's own
	 *    destroy-all-then-create-all ordering). A survivor re-marked since its
	 *    pull is skipped before its cleanup — the re-mark re-enqueued it, and
	 *    the next round delivers the latest value or nothing. Once a cleanup
	 *    has run, its handler always runs: cleanups never run unpaired.
	 *
	 * A throwing pull, cleanup, or handler aborts the drain; the entries it
	 * preempted are cleared rather than left scheduled, so an unrelated later
	 * write cannot trigger them with stale marks. An erroring compute counts
	 * as a throwing pull: the error surfaces from the drain site and the
	 * handler never sees it.
	 *
	 * A nonzero head means this lane already has a drain frame. Nested drains
	 * return; entries appended by that frame's callbacks remain after its
	 * cursor and become its next round.
	 *
	 * Pulls run consumer-detached: a drain can be reached from inside a
	 * tracked evaluation (an observeNode flush), and an effect's refresh must
	 * not register into that consumer's dependency list.
	 */
	/** Out of line so the throw's construction stays out of drain bytecode. */
	function throwDrainCycle(): never {
		const error = new Error('effect drain did not settle (cycle?)')
		if (emitEvent !== null) {
			emitEvent('flush-error', null, currentCause, { error, phase: 'cycle' })
		}
		throw error
	}

	function drainLane(state: LaneState): void {
		const mem = M
		const pins = pinnedInternals
		if (state.head !== 0) {
			return
		}
		let guard = 0
		const prevConsumer = activeConsumer
		activeConsumer = null
		try {
			while (state.head < state.count) {
				const start = state.head
				const end = state.count
				state.head = end
				const ids = state.ids
				const gens = state.gens
				// A one-entry round — every plain write that wakes one effect —
				// needs none of the phase bookkeeping: the phases collapse to
				// pull, cleanup, handler over one local survivor, with the same
				// checks in the same order as the loops below.
				if (end - start === 1) {
					if (++guard > Limit.DrainRuns) {
						throwDrainCycle()
					}
					const id = ids[start]
					if (generationColumn[id >> RECORD_SHIFT] !== gens[start]) {
						continue
					}
					const w = pins[id >> RECORD_SHIFT] as EffectNode
					const flags: Flags = mem[id + NodeSlot.Flags]
					mem[id + NodeSlot.Flags] = flags & ~Flag.Scheduled
					if ((flags & Flag.Watched) === 0) {
						continue
					}
					ensureFresh(w)
					if (generationColumn[id >> RECORD_SHIFT] !== gens[start]) {
						continue
					}
					const cflags: Flags = mem[id + NodeSlot.Flags]
					if ((cflags & Flag.AsyncError) !== 0) {
						throw (w.throwable as ErrorBox).error
					}
					if ((cflags & Flag.AsyncSuspended) !== 0) {
						continue
					}
					if (w.lastHandled !== UNINITIALIZED && w.equals(w.value, w.lastHandled)) {
						continue
					}
					if ((cflags & Flag.Scheduled) !== 0) {
						continue // re-marked by its own pull; the next round delivers
					}
					runEffectCleanup(w)
					if (
						generationColumn[id >> RECORD_SHIFT] === gens[start] &&
						(mem[id + NodeSlot.Flags] & Flag.Watched) !== 0
					) {
						runHandler(w)
					}
					continue
				}
				const handles = state.handles
				// Phase 1: pull.
				for (let i = start; i < end; i++) {
					if (++guard > Limit.DrainRuns) {
						throwDrainCycle()
					}
					const id = ids[i]
					if (generationColumn[id >> RECORD_SHIFT] !== gens[i]) {
						handles[i] = undefined // record reclaimed since scheduling: dead entry
						continue
					}
					const w = pins[id >> RECORD_SHIFT] as EffectNode
					const flags: Flags = mem[id + NodeSlot.Flags]
					// Consume the queue membership so later writes can re-enqueue. The
					// evaluated effect retains its staleness mark for ensureFresh.
					mem[id + NodeSlot.Flags] = flags & ~Flag.Scheduled
					if ((flags & Flag.Watched) === 0) {
						handles[i] = undefined
						continue
					}
					ensureFresh(w)
					// The pull runs user code (compute bodies) that can dispose this
					// very effect; a reclaimed record's flags cannot be read.
					if (generationColumn[id >> RECORD_SHIFT] !== gens[i]) {
						handles[i] = undefined
						continue
					}
					const cflags: Flags = mem[id + NodeSlot.Flags]
					if ((cflags & Flag.AsyncError) !== 0) {
						handles[i] = undefined
						throw (w.throwable as ErrorBox).error
					}
					if ((cflags & Flag.AsyncSuspended) !== 0) {
						// Parked: silent. Settlement invalidates and re-enqueues the effect.
						handles[i] = undefined
						continue
					}
					if (w.lastHandled !== UNINITIALIZED && w.equals(w.value, w.lastHandled)) {
						handles[i] = undefined
						continue
					}
					handles[i] = w
				}
				// Phase 2a: cleanups.
				for (let i = start; i < end; i++) {
					const w = handles[i]
					if (w === undefined) {
						continue
					}
					if (
						generationColumn[ids[i] >> RECORD_SHIFT] !== gens[i] ||
						(mem[w.id + NodeSlot.Flags] & (Flag.Scheduled | Flag.Watched)) !== Flag.Watched
					) {
						// Re-marked since its pull (Scheduled) or disposed by a sibling
						// cleanup: skip before the cleanup runs.
						handles[i] = undefined
						continue
					}
					runEffectCleanup(w)
				}
				// Phase 2b: handlers, reading the settled value at run time.
				for (let i = start; i < end; i++) {
					const w = handles[i]
					handles[i] = undefined
					if (
						w === undefined ||
						generationColumn[ids[i] >> RECORD_SHIFT] !== gens[i] ||
						(mem[w.id + NodeSlot.Flags] & Flag.Watched) === 0
					) {
						continue
					}
					runHandler(w)
				}
			}
			state.head = 0
			state.count = 0
		} catch (e) {
			// Clear the entries the throw preempted (see the function comment);
			// unconsumed slots are cleared like consumed ones.
			for (let i = 0; i < state.count; i++) {
				state.handles[i] = undefined
				const id = state.ids[i]
				if (generationColumn[id >> RECORD_SHIFT] === state.gens[i]) {
					mem[id + NodeSlot.Flags] &= ~(Flag.Scheduled | Flag.StaleMask)
				}
			}
			state.head = 0
			state.count = 0
			throw e
		} finally {
			activeConsumer = prevConsumer
		}
	}

	/**
	 * Drain sync effects until they settle, then deliver render
	 * notifications.
	 */
	function flush(): void {
		const sync = lanes[Lane.Sync]
		if (sync.head !== 0) {
			return
		}
		if (sync.count === sync.head && renderNotifyCount === 0) {
			return
		}
		try {
			drainLane(sync)
		} finally {
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
					const w = delivering[i] as RenderWatcherNode
					// Render-notify watchers are never validated, so Scheduled and the
					// staleness bits clear together in one masked store.
					setFlags(w, flagsOf(w) & ~(Flag.Scheduled | Flag.StaleMask))
				}
				try {
					for (let i = 0; i < n; i++) {
						const w = delivering[i] as RenderWatcherNode
						// Pin identity is the liveness test: an earlier callback may
						// have disposed this subscriber, and a disposed watcher's
						// record may already be reclaimed and reused, so its flags
						// word cannot be read.
						if (pinnedInternals[w.id >> RECORD_SHIFT] === w) {
							w.onNotify!(causeColumn[w.id >> RECORD_SHIFT] as TraceEventId)
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
		const prevForbidden = setWritesForbidden(
			'a lazy state initializer must not write to other state',
		)
		activeConsumer = null
		try {
			cell.value = init()
		} catch (error) {
			cell.initializer = init
			if (emitEvent !== null) {
				emitEvent('callback-error', cell, currentCause, { error, phase: 'initializer' })
			}
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

	function writeCell<T>(cell: CellNode<T>, next: T, intent: 'set' | 'update' = 'set'): boolean {
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
			if (emitEvent === null && !hasLiveDrafts()) {
				cell.value = next
				return true
			}
			id = ensureNodeRecord(cell)
		}
		cell.value = next
		// Invariant: tick the clock FIRST, then stamp the change with the new
		// reading — a change stamped at a pre-tick reading could compare equal to
		// a subscriber that validated before this write.
		graphChangeClock++
		baseChangedAtGraphChange = graphChangeClock
		clocks[(id >> ClockSlot.Shift) + ClockSlot.ChangedAt] = graphChangeClock
		const cause = emitEvent !== null ? emitEvent(intent, cell, currentCause) : NO_EVENT
		propagateFrom(cell as CellNode<unknown>, cause)
		return true
	}

	/**
	 * The use() argument every base recompute passes to fn: one shared
	 * function, no per-node closure — the evaluating computed IS the
	 * activeConsumer at call time. (Draft evaluations pass their own worldUse
	 * instead; see worlds.ts.) A use() that escapes its evaluation — captured
	 * and called later, or called inside untracked() — finds no evaluating
	 * computed and throws rather than park the wrong node.
	 */
	const evalUse: UseFn = <U>(t: PromiseLike<U>): U => {
		const consumer = activeConsumer
		if (
			consumer === null ||
			(flagsOf(consumer) & (Flag.KindDerived | Flag.WatchRunEffect)) === 0
		) {
			throw new Error('use() called outside a computed evaluation')
		}
		return baseUse(t, consumer as DerivedNode<unknown>) as U
	}

	/**
	 * Out of line so the cycle path's Error construction and template string
	 * stay out of recompute's bytecode (hot-cluster inlining budget).
	 */
	function throwComputeCycle(node: DerivedNode<unknown>): never {
		throw new Error(`cycle detected in computed${node.label ? ` "${node.label}"` : ''}`)
	}

	function recompute(node: DerivedNode<unknown>): void {
		if (hotHook !== null) {
			hotHook(node, 'pull')
		}
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
		// A computed's first run is a lazy eval on read, so nothing has propagated a
		// cause to it yet (causeEvent is NO_EVENT) and the compute would orphan. Fall
		// back to the active operation's cause (currentCause) — the write or fold in
		// flight — so a first "new result" chains back to what triggered it. Outside
		// an operation currentCause is NO_EVENT, so this never mis-attributes.
		const nodeCause = causeColumn[id >> RECORD_SHIFT] as TraceEventId
		const computeCause = nodeCause !== NO_EVENT ? nodeCause : currentCause
		const compute = startSpan !== null ? startSpan('compute', node, computeCause) : NO_EVENT
		const prevCause = compute !== NO_EVENT ? setCurrentCause(compute) : NO_EVENT
		try {
			value = node.fn(evalUse, node.value === UNINITIALIZED ? undefined : node.value)
		} catch (e) {
			if (e === PARKED) {
				parked = true
			} else {
				hasError = true
				error = e
				if (emitEvent !== null) {
					emitEvent('compute-error', node, compute, { error: e })
				}
			}
		} finally {
			if (compute !== NO_EVENT) {
				setCurrentCause(prevCause)
			}
			// A nested eval advanced the pass id; restore ours so trimming is exact.
			evalPass = myPass
			activeConsumer = prevConsumer
			activeEvaluation = prevEvaluation
			trimDeps(node)
			mem[id + NodeSlot.Flags] &= ~Flag.Computing
		}
		// Plain success over a plain previous state is the equality cutoff alone —
		// finishCompute's tail with its async no-ops elided (AsyncMask clear
		// implies throwable is already null). Every async-touched outcome takes
		// the full fold.
		let changed: boolean
		if (!parked && !hasError && (mem[id + NodeSlot.Flags] & Flag.AsyncMask) === 0) {
			const prev = node.value
			if (prev === UNINITIALIZED || !node.equals(prev, value)) {
				node.value = value
				changed = true
			} else {
				changed = false
			}
		} else {
			changed = finishCompute(node, parked, hasError, error, value)
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
		const finalFlags: Flags =
			(mem[id + NodeSlot.Flags] & ~Flag.StaleMask) |
			(graphChangeClock !== preGraphChange ? Flag.StaleDirty : 0)
		mem[id + NodeSlot.Flags] = finalFlags
		validAtColumn[id >> RECORD_SHIFT] = preGraphChange
		if (compute !== NO_EVENT && endSpan !== null) {
			endSpan(compute, { changed })
		}
		// An effect this very evaluation disposed (Watching set, Watched
		// clear) kept its record for the stamps above; every write is done,
		// so the record goes back to the pool here, at the unwind.
		if ((finalFlags & (Flag.Watching | Flag.Watched)) === Flag.Watching) {
			reclaimEffectRecord(id)
		}
	}

	/**
	 * Iterative validation of a pure dependency chain. A node with exactly
	 * one dependency needs no general recursion to validate: its staleness
	 * question is one reading compare against that single dependency, and
	 * when the dependency is itself a single-dep possibly-stale derived, the
	 * same holds one level down. So: walk DOWN the sole dependency edges
	 * while that shape holds, recording the path of record ids in a
	 * persistent integer scratch; stop at the first node with nothing below
	 * to resolve (a cell, or a Clean derived — compare-ready) or at a
	 * definitely-stale derived (recompute it), or freshen generically where
	 * the deps branch; then resolve UPWARD through the recorded path — per
	 * level, one changedAt/validAt reading compare decides recompute vs
	 * clear-and-stamp, exactly what ensureFresh's loop would do for that
	 * node, without its call frames. Ids, not handles: the climb's compares
	 * are integer loads, a pinned handle resolves only on the levels that
	 * actually recompute, and the consumed scratch retains nothing.
	 *
	 * Recompute can run user code that re-enters this function, so the
	 * scratch is segmented by a depth base, exactly like nested call frames
	 * — and every nested call may replace the (growable) scratch array, so
	 * the local view refreshes after each one.
	 *
	 * Interior nodes need no Watched test and no liveness test: the start
	 * is watched, a watched node's dependency closure is watched (promote
	 * installs it), interiors are deriveds — which cannot be disposed — and
	 * their subscriber edges keep them pinned. Only the START can die
	 * mid-resolve (a lower recompute may run user code that disposes it, an
	 * effect); its final pop re-checks pin identity before touching the
	 * record.
	 */
	let chainStack = new Int32Array(256)
	let chainDepth = 0

	function growChainStack(): Int32Array<ArrayBuffer> {
		const bigger = new Int32Array(chainStack.length * 2)
		bigger.set(chainStack)
		chainStack = bigger
		return bigger
	}

	function chainResolve(start: DerivedNode<unknown>): boolean {
		const mem = M
		const clocks = graphClocks
		const pins = pinnedInternals
		let node = start.id
		let link = mem[node + NodeSlot.Deps]
		if (link === 0 || mem[link + LinkSlot.LinkNextDep] !== 0) {
			return false
		}
		const base = chainDepth
		let stack = chainStack
		let depth = base
		let dep = 0
		try {
			while (true) {
				if (depth === stack.length) {
					stack = growChainStack()
				}
				stack[depth++] = node
				dep = mem[link + LinkSlot.LinkDep]
				const dflags = mem[dep + NodeSlot.Flags]
				if (
					(dflags & (Flag.KindDerived | Flag.StaleMask)) ===
					(Flag.KindDerived | Flag.StaleDirty)
				) {
					chainDepth = depth
					recompute(pins[dep >> RECORD_SHIFT] as DerivedNode<unknown>)
					stack = chainStack
					break
				}
				if (
					(dflags & (Flag.KindDerived | Flag.StaleMask)) !==
					(Flag.KindDerived | Flag.StaleCheck)
				) {
					break // a cell or a Clean derived: fresh as-is, compare-ready
				}
				const next = mem[dep + NodeSlot.Deps]
				if (next === 0 || mem[next + LinkSlot.LinkNextDep] !== 0) {
					// Branching deps below: freshen that node generically, then
					// climb the recorded path above it.
					chainDepth = depth
					ensureFresh(pins[dep >> RECORD_SHIFT] as DerivedNode<unknown>)
					stack = chainStack
					break
				}
				node = dep
				link = next
			}
			do {
				const id = stack[--depth]
				if (depth === base && pins[id >> RECORD_SHIFT] !== start) {
					// The start was disposed by a recompute below it; its record
					// is already reclaimed (possibly reused) and must not be
					// touched. The caller's generic path owns whatever remains.
					return false
				}
				if (
					clocks[(dep >> ClockSlot.Shift) + ClockSlot.ChangedAt] >
					validAtColumn[id >> RECORD_SHIFT]
				) {
					if (depth === base) {
						chainDepth = depth
						recompute(start)
					} else {
						const handle = pins[id >> RECORD_SHIFT] as DerivedNode<unknown> | undefined
						if (handle === undefined) {
							// Restructured by re-entrant user code below (a start
							// dispose or a branch switch freed this level's last
							// inbound link). Everything resolved so far stays
							// resolved; the caller's generic path — whose frames
							// hold handles — finishes the rest.
							return false
						}
						chainDepth = depth
						recompute(handle)
						stack = chainStack
					}
				} else {
					mem[id + NodeSlot.Flags] &= ~Flag.StaleMask
					validAtColumn[id >> RECORD_SHIFT] = graphChangeClock
				}
				dep = id
			} while (depth !== base)
			return true
		} finally {
			chainDepth = base
		}
	}

	/** Bring a derived up to date; exact recompute counts are the contract. */
	function ensureFresh(node: DerivedNode<unknown>, knownFlags?: Flags, depth = 0): void {
		if (hotHook !== null) {
			hotHook(node, 'check')
		}
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
			// Shallow validation stays on this function's own frames (one
			// reading compare per level, handles held by the recursion);
			// chainResolve absorbs only the deep tail, iteratively, so a
			// 150k-node chain costs 16 frames plus one descent-and-climb.
			if (
				depth === 16 &&
				(flags & Flag.StaleDirty) === 0 &&
				node.value !== UNINITIALIZED &&
				chainResolve(node)
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
				ensureFresh(
					pins[depId >> RECORD_SHIFT] as DerivedNode<unknown>,
					dflags,
					depth === 16 ? 0 : depth + 1,
				)
			}
			if (clocks[(depId >> ClockSlot.Shift) + ClockSlot.ChangedAt] > validAt) {
				// An effect can have been disposed by the dep freshening above
				// (a computed body may call its disposer); its record is
				// already reclaimed — possibly reused — and a dead compute
				// must not run. The entry flags predate any user code, so
				// Watching reliably gates the pin check to watchers, whose
				// liveness pin identity owns.
				if ((flags & Flag.Watching) !== 0 && pins[id >> RECORD_SHIFT] !== node) {
					return
				}
				recompute(node)
				return
			}
		}
		// The same dispose window guards the validation stamp: a reclaimed
		// (possibly reused) record must not have its marks cleared.
		if ((flags & Flag.Watching) !== 0 && pins[id >> RECORD_SHIFT] !== node) {
			return
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

	/** Run `fn` without adding its signal reads to the active dependency list. */
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

	/**
	 * The scope or effect whose body/handler is running: effects created
	 * inside it become its children. An owner's Watched bit prevents a
	 * self-disposed owner from gaining children later in the same body.
	 */
	let activeEffectOwner: EffectNode | ScopeNode | null = null

	/**
	 * Dispose every child even when one cleanup throws, then surface the
	 * first error after the whole owned set is released.
	 */
	function disposeChildren(owner: EffectNode | ScopeNode): void {
		const children = owner.children
		if (children === undefined) {
			return
		}
		owner.children = undefined
		let failed = false
		let failure: unknown
		for (const child of children) {
			try {
				disposeEffect(child)
			} catch (error) {
				if (!failed) {
					failed = true
					failure = error
				}
			}
		}
		if (failed) {
			throw failure
		}
	}

	/**
	 * Release the previous run: child effects it created, then its cleanup.
	 * A throwing cleanup poisons the effect — it is disposed fully so it
	 * never half-runs again — and the error surfaces to the drain.
	 */
	function runEffectCleanup(w: EffectNode): void {
		// Effects created by the previous run belong to that run.
		if (w.children !== undefined) {
			try {
				disposeChildren(w)
			} catch (error) {
				// A child cleanup poisons its owner, but every sibling and the owner
				// itself must still release their edges before the first error escapes.
				try {
					disposeEffect(w)
				} catch {
					// Preserve the first cleanup error.
				}
				throw error
			}
		}
		if (w.cleanup !== undefined) {
			const c = w.cleanup
			w.cleanup = undefined
			try {
				untracked(c)
			} catch (e) {
				if (emitEvent !== null) {
					emitEvent('cleanup-error', w, causeColumn[w.id >> RECORD_SHIFT], { error: e })
				}
				disposeEffect(w)
				throw e
			}
		}
	}

	/**
	 * Run an effect's handler with its settled value. The computation
	 * is settled here by construction: a pull that parked was skipped, and a
	 * post-pull invalidation set Scheduled, which skipped the pair.
	 */
	function runHandler(w: EffectNode): void {
		const value = w.value
		const previous = w.lastHandled === UNINITIALIZED ? undefined : w.lastHandled
		w.lastHandled = value
		const prevConsumer = activeConsumer
		const prevOwner = activeEffectOwner
		// Handler reads are untracked by contract; nested effects belong to
		// this run.
		activeConsumer = null
		activeEffectOwner = w
		const open = startSpan
		const cause = open !== null ? open('effect', w, causeColumn[w.id >> RECORD_SHIFT]) : NO_EVENT
		const prevCause = setCurrentCause(cause)
		try {
			let ret: void | (() => void)
			try {
				ret = w.handler(value, previous)
			} catch (error) {
				if (emitEvent !== null) {
					emitEvent('effect-error', w, cause, { error })
				}
				throw error
			}
			if (typeof ret === 'function') {
				w.cleanup = ret
			}
		} finally {
			setCurrentCause(prevCause)
			activeConsumer = prevConsumer
			activeEffectOwner = prevOwner
			if (cause !== NO_EVENT && endSpan !== null) {
				endSpan(cause)
			}
		}
	}

	/**
	 * Pin identity is a watcher's liveness test: every watcher pins its
	 * handle at creation and disposal clears the pin, so a matching pin
	 * asserts both "not disposed" and "this handle still owns its record".
	 * A disposed handle's flags word can NEVER be read — its record may
	 * already be reclaimed and reused by an unrelated node.
	 */
	function watcherAlive(w: WatcherNode): boolean {
		return pinnedInternals[w.id >> RECORD_SHIFT] === w
	}

	/**
	 * Return a disposed effect's record to the pool. Effect records dirty the
	 * lane slot, the changedAt stamp (the shared evaluator writes it), the
	 * validation watermark, and the dep list head — the last already zeroed
	 * by unlinkAllDeps before this runs. Called from disposeEffect, or from
	 * the unwinding recompute for an effect that disposed itself
	 * mid-evaluation.
	 */
	function reclaimEffectRecord(id: ReactiveNodeId): void {
		M[id + NodeSlot.EffectLane] = 0
		graphClocks[(id >> ClockSlot.Shift) + ClockSlot.ChangedAt] = 0
		validAtColumn[id >> RECORD_SHIFT] = 0
		pushFreeNode(id)
	}

	function disposeEffect(w: EffectNode): void {
		if (!watcherAlive(w)) {
			return
		}
		// The handle-owned mark for parties that hold the handle past this
		// call (a pending thenable's parked set); the record-side state is
		// Watching set + Watched clear.
		w.disposed = true
		setFlags(w, flagsOf(w) & ~Flag.Watched)
		let failed = false
		let failure: unknown
		try {
			if (w.children !== undefined) {
				try {
					disposeChildren(w)
				} catch (error) {
					failed = true
					failure = error
				}
			}
			if (w.cleanup !== undefined) {
				const c = w.cleanup
				w.cleanup = undefined
				try {
					untracked(c)
				} catch (error) {
					if (emitEvent !== null) {
						emitEvent('cleanup-error', w, causeColumn[w.id >> RECORD_SHIFT], { error })
					}
					if (!failed) {
						failed = true
						failure = error
					}
				}
			}
		} finally {
			unlinkAllDeps(w)
			w.depsTail = 0
			const id = w.id
			pinnedInternals[id >> RECORD_SHIFT] = undefined
			generationColumn[id >> RECORD_SHIFT]++
			if ((M[id + NodeSlot.Flags] & Flag.ComputingMask) === 0) {
				reclaimEffectRecord(id)
			}
			// else: this dispose ran inside the effect's own evaluation, whose
			// unwind still stamps the record; recompute's tail reclaims it.
		}
		if (failed) {
			throw failure
		}
	}

	/**
	 * Dispose a store subscription. Watcher records dirty only three slots
	 * over their whole life: the dep list head (zeroed by unlinkAllDeps),
	 * the handle cursor, and the validation watermark. They are never
	 * anyone's dependency (no RefCount, no ChangedAt, no Subs, no
	 * ObserverCount), and allocation overwrites Flags — so this slim
	 * reclaim replaces the full one.
	 */
	function disposeWatcher(w: RenderWatcherNode): void {
		if (!watcherAlive(w)) {
			return
		}
		setFlags(w, flagsOf(w) & ~Flag.Watched)
		unlinkAllDeps(w)
		const id = w.id
		pinnedInternals[id >> RECORD_SHIFT] = undefined
		validAtColumn[id >> RECORD_SHIFT] = 0
		generationColumn[id >> RECORD_SHIFT]++
		pushFreeNode(id)
	}

	/** Dispose a scope anchor: its owned effects, then its record. */
	function disposeScope(w: ScopeNode): void {
		if (!watcherAlive(w)) {
			return
		}
		setFlags(w, flagsOf(w) & ~Flag.Watched)
		const id = w.id
		pinnedInternals[id >> RECORD_SHIFT] = undefined
		try {
			disposeChildren(w)
		} finally {
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
		mem[id + NodeSlot.EffectLane] = 0
		mem[id + NodeSlot.Subs] = 0
		mem[id + NodeSlot.SubsTail] = 0
		mem[id + NodeSlot.RefCount] = 0
		clocks[(id >> ClockSlot.Shift) + ClockSlot.ChangedAt] = 0
		validAtColumn[id >> RECORD_SHIFT] = 0
		observerColumn[id >> RECORD_SHIFT] = 0
		generationColumn[id >> RECORD_SHIFT]++
		// poke passes stay stale: pass ids are monotonic and never
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

	/**
	 * Benchmark generation boundary: every handle from the old generation must
	 * already be unreachable. This keeps arena capacity out of multi-case runs.
	 */
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
		for (const state of lanes) {
			for (let i = 0; i < state.count; i++) {
				state.handles[i] = undefined
			}
			state.head = 0
			state.count = 0
			state.pumpRequested = false
		}
		renderNotifyCount = 0
		initDetachedRecords()
		nextNodeRecord = FIRST_REAL_RECORD
		nextLinkRecord = M.length
		freeLinkCount = 0
		freeNodeCount = 0
		nodeFinalizer = makeNodeFinalizer()
	}

	/**
	 * Watcher handles are class expressions extending ReactiveNode: the
	 * constructor assigns every handle-owned field (a single stable shape,
	 * which V8 allocates like a literal after warmup — measured faster here
	 * than Object.create plus incremental stores), and the prototype
	 * supplies the record-backed getters (flags, deps, observerCount, …).
	 */
	const EffectHandle = class extends ReactiveNode implements EffectNode {
		declare value: unknown
		declare fn: (use: UseFn, previous: unknown) => unknown
		declare equals: EqualsFn<unknown>
		declare handler: (value: unknown, previous: unknown) => void | (() => void)
		declare lastHandled: unknown
		declare lane: Lane
		declare cleanup: (() => void) | undefined
		declare children: EffectNode[] | undefined
		declare disposed: boolean
		constructor(
			fn: (use: UseFn, previous: unknown) => unknown,
			handler: (value: unknown, previous: unknown) => void | (() => void),
			lane: Lane,
			equals: EqualsFn<unknown>,
			label: string | undefined,
		) {
			super()
			this.depsTail = 0
			this.throwable = null
			this.label = label
			this.value = UNINITIALIZED
			this.fn = fn
			this.equals = equals
			this.handler = handler
			this.lastHandled = UNINITIALIZED
			this.lane = lane
			this.cleanup = undefined
			this.children = undefined
			this.disposed = false
		}
	}

	const RenderWatcherHandle = class extends ReactiveNode implements RenderWatcherNode {
		declare onNotify: ((cause: TraceEventId) => void) | undefined
		declare onDraftWake: ((id: DraftId, cause: TraceEventId) => void) | undefined
		constructor(
			notify: (cause: TraceEventId) => void,
			draftWake: ((id: DraftId, cause: TraceEventId) => void) | undefined,
		) {
			super()
			this.onNotify = notify
			this.onDraftWake = draftWake
		}
	}

	const ScopeHandle = class extends ReactiveNode implements ScopeNode {
		declare children: EffectNode[] | undefined
		constructor() {
			super()
			this.children = undefined
		}
	}

	/**
	 * Create an effect whose one node owns dynamic evaluation and delivery.
	 * The first run is synchronous when the computation settles; a parked
	 * first evaluation stays silent, and its settlement delivers through the
	 * lane. A creation-time compute error disposes the effect and rethrows.
	 */
	function makeEffect(
		fn: (use: UseFn, previous: unknown) => unknown,
		handler: (value: unknown, previous: unknown) => void | (() => void),
		lane: Lane,
		equals: EqualsFn<unknown> = Object.is,
		label?: string,
	): () => void {
		// Effects are born watched (the bit means ALIVE on watchers) and with
		// eager records — they are roots with edges from their first run.
		// Capability bits are creation-fixed.
		const w: EffectNode = new EffectHandle(fn, handler, lane, equals, label)
		const id = allocNode(w, Flag.Watching | Flag.WatchRunEffect | Flag.Watched | Flag.StaleDirty)
		pinnedInternals[id >> RECORD_SHIFT] = w
		M[id + NodeSlot.EffectLane] = lane
		// Liveness by pin identity, never by the owner's flags: a
		// self-disposed owner's record may already be reclaimed — and even
		// recycled as THIS effect's record.
		const owner = activeEffectOwner
		if (owner !== null && watcherAlive(owner)) {
			;(owner.children ??= []).push(w)
		}
		try {
			ensureFresh(w)
			const flags = flagsOf(w)
			if ((flags & Flag.AsyncError) !== 0) {
				// The narrow from the null assignment above no longer holds:
				// ensureFresh ran the compute, which may have installed a box.
				throw (w.throwable as unknown as ErrorBox).error
			}
			if ((flags & Flag.AsyncSuspended) === 0) {
				runHandler(w)
			}
		} catch (error) {
			try {
				disposeEffect(w)
			} catch {
				// Preserve the setup error.
			}
			throw error
		}
		return () => disposeEffect(w)
	}

	/**
	 * Run `fn` as an effect owner and return one disposer for every effect it
	 * creates, including effects created by their handlers.
	 */
	function makeScope(fn: () => void): () => void {
		// A scope anchor: owns child effects, takes no deliveries of its own.
		// Pinned like every watcher, because pin identity is the liveness test.
		const w: ScopeNode = new ScopeHandle()
		const id = allocNode(w, Flag.Watching | Flag.Watched)
		pinnedInternals[id >> RECORD_SHIFT] = w
		const prevOwner = activeEffectOwner
		const prevConsumer = activeConsumer
		activeEffectOwner = w
		activeConsumer = null
		try {
			try {
				fn()
			} finally {
				activeEffectOwner = prevOwner
				activeConsumer = prevConsumer
			}
		} catch (error) {
			if (emitEvent !== null) {
				emitEvent('callback-error', null, currentCause, { error, phase: 'scope' })
			}
			try {
				disposeScope(w)
			} catch {
				// Preserve the setup error.
			}
			throw error
		}
		return () => disposeScope(w)
	}

	/**
	 * A store subscription: attach a callback to a node's invalidation wave
	 * without evaluating the node. This is how the React bindings observe
	 * the graph. The callback runs after the wave and its effects settle, so
	 * subscribers re-read a consistent graph. Every subscription is both
	 * render-notified and draft-aware even when no draft-wake callback is
	 * given, because draft pokes must reach probes (such as isPending) that
	 * install none. The watcher holds ONE pinned link, installed here and
	 * never re-tracked; render watchers are never validated, so the pin is
	 * pure wiring.
	 */
	function observeNode(
		node: ReactiveNode,
		notify: (cause: TraceEventId) => void,
		draftWake?: (id: DraftId, cause: TraceEventId) => void,
		label?: string,
	): (() => void) & { watcher: RenderWatcherNode } {
		const mem = M
		const pins = pinnedInternals
		// A render watcher owns only its callbacks; the pinned link and every
		// record field live behind the prototype's record-backed getters.
		const sub: RenderWatcherNode = new RenderWatcherHandle(notify, draftWake)
		// Attach a label only when supplied, so an unlabeled watcher keeps its
		// exact object shape (hidden class) — no cost for the non-devtools path.
		if (label !== undefined) {
			sub.label = label
		}
		const subId = allocNode(sub, Flag.Watching | Flag.WatchRender | Flag.Watched)
		pins[subId >> RECORD_SHIFT] = sub
		try {
			if ((flagsOf(node) & Flag.KindCell) !== 0) {
				peekCell(node as CellNode<unknown>)
			}
			// The one pinned link, fused insert (a fresh link is never already a
			// member of a subscriber list).
			const depId = ensureDepRecord(node)
			const link = allocLink()
			mem[link + LinkSlot.LinkDep] = depId
			mem[link + LinkSlot.LinkSub] = subId
			if (++mem[depId + NodeSlot.RefCount] === 1) {
				pins[depId >> RECORD_SHIFT] = node
			}
			mem[link + LinkSlot.LinkNextDep] = 0
			mem[link + LinkSlot.LinkEvalPass] = 0
			mem[subId + NodeSlot.Deps] = link
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
			addObserver(node)
			const depFlags = mem[depId + NodeSlot.Flags]
			if (
				(depFlags & Flag.KindDerived) !== 0 &&
				(depFlags & Flag.StaleMask) !== 0 &&
				(node as DerivedNode<unknown>).value !== UNINITIALIZED
			) {
				// The pinned edge does not pull the node. If it was already stale,
				// deliver the invalidation that happened before this edge existed.
				// (Never-computed nodes are exempt: they are born StaleDirty with
				// no dependency edges, so no wave was ever swallowed.)
				setFlags(sub, flagsOf(sub) | Flag.StaleCheck)
				causeColumn[subId >> RECORD_SHIFT] = causeColumn[depId >> RECORD_SHIFT]
				scheduleWatcher(subId, flagsOf(sub))
			}
			if (batchDepth === 0) {
				flush()
			}
		} catch (error) {
			try {
				disposeWatcher(sub)
			} catch {
				// Preserve the subscription error.
			}
			throw error
		}
		// The disposer stays the whole return value (most callers just call it);
		// the watcher node rides along as a property for the render hook, which
		// records notify/render/transition-notify against it — so those events
		// belong to the component's subscription, not to the producer it watches.
		return Object.assign(() => disposeWatcher(sub), { watcher: sub })
	}

	return {
		ensureNodeRecord,
		nextDependency,
		dependencyOf,
		nextSubscriber,
		subscriberOf,
		currentGraphChange,
		tickGraphChange,
		currentBaseChange,
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
		setLanePump,
		drainUseLayoutEffectLane,
		drainDeferredEffects,
		repumpDeferredLanes,
		flushScheduledEffects,
		resetEffectLanes,
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
	generationColumn,
)

export const ensureNodeRecord = core.ensureNodeRecord
export const nextDependency = core.nextDependency
export const dependencyOf = core.dependencyOf
export const nextSubscriber = core.nextSubscriber
export const subscriberOf = core.subscriberOf
export const currentGraphChange = core.currentGraphChange
export const tickGraphChange = core.tickGraphChange
export const currentBaseChange = core.currentBaseChange
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
export const setLanePump = core.setLanePump
export const drainUseLayoutEffectLane = core.drainUseLayoutEffectLane
export const drainDeferredEffects = core.drainDeferredEffects
export const repumpDeferredLanes = core.repumpDeferredLanes
export const flushScheduledEffects = core.flushScheduledEffects
export const resetEffectLanes = core.resetEffectLanes
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

/**
 * The host lane pump's shape: install with setLanePump (see the closure's
 * requestLaneDrain).
 */
export type LanePump = (lane: Lane.UseLayoutEffect | Lane.UseEffect) => boolean
