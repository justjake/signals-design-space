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

export const enum NodeSlot {
	Flags = 0,
	Deps = 1,
	DepsTail = 2,
	Subs = 3,
	SubsTail = 4,
	RefCount = 5,
	ChangedAt = 6,
	FreeNext = Deps,
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
		return graphClocks[(this.id >> 1) + 3]
	}
	set changedAtGraphChange(value: GraphChangeClock) {
		graphClocks[(this.id >> 1) + 3] = value
	}
	get subs(): Link | undefined {
		return M[this.id + NodeSlot.Subs] || undefined
	}
	get deps(): Link | undefined {
		return M[this.id + NodeSlot.Deps] || undefined
	}
	get observerCount(): number {
		return observerCounts[this.id >> RECORD_SHIFT]
	}
	get causeEvent(): TraceEventId {
		return causeEvents[this.id >> RECORD_SHIFT]
	}
	set causeEvent(value: TraceEventId) {
		causeEvents[this.id >> RECORD_SHIFT] = value
	}
	get validAtGraphChange(): GraphChangeClock {
		return validAtClocks[this.id >> RECORD_SHIFT]
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
// Fixed like dalien's arena generation: virtual pages are committed on touch.
// This experiment deliberately omits growth so every hot access keeps a const
// base binding. Growth comes after the fixed-arena hot path is competitive.
const RECORD_CAPACITY = 2_097_152
export const graphMemory = new Int32Array(RECORD_STRIDE * RECORD_CAPACITY)
const graphClocks = new Float64Array(graphMemory.buffer)
const validAtClocks = new Float64Array(RECORD_CAPACITY)
const observerCounts = new Int32Array(RECORD_CAPACITY)
const causeEvents = new Int32Array(RECORD_CAPACITY)
const pokePasses = new Int32Array(RECORD_CAPACITY)
const batchPasses = new Int32Array(RECORD_CAPACITY)
const pinnedInternals: Array<ReactiveNode | undefined> = [undefined]
const M = graphMemory
let nextRecord = RECORD_STRIDE
let freeLinks: Link = 0
let freeNodes: ReactiveNodeId = 0

function allocRecord(): number {
	const id = nextRecord
	nextRecord += RECORD_STRIDE
	if (nextRecord > M.length) {
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
	if (freeLinks !== 0) {
		const id = freeLinks
		freeLinks = M[id + LinkSlot.FreeNext]
		return id
	}
	return allocRecord()
}

function freeLink(id: Link): void {
	const dep = M[id + LinkSlot.LinkDep]
	if (dep !== 0 && --M[dep + NodeSlot.RefCount] === 0) {
		pinnedInternals[dep >> RECORD_SHIFT] = undefined
	}
	// Slot-by-slot zeroing: unlinkFromSubs already cleared PrevSub/NextSub/
	// InSubs for subs-listed links, and they were never set otherwise, so
	// only the four slots this module writes on every link need clearing.
	// Explicit stores keep this on the inlined fast path (TypedArray fill is
	// a builtin call per freed link).
	M[id + LinkSlot.LinkEvalPass] = 0
	M[id + LinkSlot.LinkDep] = 0
	M[id + LinkSlot.LinkSub] = 0
	M[id + LinkSlot.LinkNextDep] = 0
	M[id + LinkSlot.FreeNext] = freeLinks
	freeLinks = id
}

function allocNode(owner: ReactiveNode, flags: Flags): ReactiveNodeId {
	const id = freeNodes !== 0 ? freeNodes : allocRecord()
	if (freeNodes !== 0) {
		freeNodes = M[id + NodeSlot.FreeNext]
		M[id + NodeSlot.FreeNext] = 0
	}
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

function depsTailOf(node: ReactiveNodeId): Link | undefined {
	return M[node + NodeSlot.DepsTail] || undefined
}

function subsOf(node: ReactiveNodeId): Link | undefined {
	return M[node + NodeSlot.Subs] || undefined
}

function subsTailOf(node: ReactiveNodeId): Link | undefined {
	return M[node + NodeSlot.SubsTail] || undefined
}

function changedAtOf(node: ReactiveNodeId): GraphChangeClock {
	return graphClocks[(node >> 1) + 3]
}

function validAtOf(node: ReactiveNodeId): GraphChangeClock {
	return validAtClocks[node >> RECORD_SHIFT]
}

function linkDep(id: Link): ReactiveNodeId {
	return M[id + LinkSlot.LinkDep]
}

function linkSub(id: Link): ReactiveNodeId {
	return M[id + LinkSlot.LinkSub]
}

export function nextDependency(id: Link): Link | undefined {
	return M[id + LinkSlot.LinkNextDep] || undefined
}

export function dependencyOf(id: Link): ReactiveNode {
	return pinnedInternals[linkDep(id) >> RECORD_SHIFT]!
}

export function nextSubscriber(id: Link): Link | undefined {
	return M[id + LinkSlot.LinkNextSub] || undefined
}

export function subscriberOf(id: Link): ReactiveNode {
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
/** The computed body executing now, independent of dependency tracking.
 * untracked() clears activeConsumer but must not bypass computed policies. */
export let activeEvaluation: DerivedNode<unknown> | null = null
let batchDepth = 0

/** Bumped and read by the engine layer; here so cells can report writes. */
export function currentGraphChange(): GraphChangeClock {
	return graphChangeClock
}

// ---------------------------------------------------------------------------
// Tracing seam. tracer.ts installs the hook; a mutable module binding (not
// an object) so the detached fast path stays one null check per emit site,
// and the graph itself stays runtime-dependency-free.
// ---------------------------------------------------------------------------

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
	allocNode(cell, Flag.KindCell)
	queueNodeRegistration(cell)
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
	allocNode(node, Flag.KindDerived | Flag.StaleDirty)
	queueNodeRegistration(node)
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

function linkIntoSubs(link: Link, sub: ReactiveNode): void {
	if (M[link + LinkSlot.LinkInSubs] !== 0) {
		return
	}
	M[link + LinkSlot.LinkInSubs] = 1
	const dep = linkDep(link)
	M[link + LinkSlot.LinkPrevSub] = subsTailOf(dep) ?? 0
	M[link + LinkSlot.LinkNextSub] = 0
	const tail = subsTailOf(dep)
	if (tail !== undefined) {
		M[tail + LinkSlot.LinkNextSub] = link
	} else {
		M[dep + NodeSlot.Subs] = link
	}
	M[dep + NodeSlot.SubsTail] = link
}

function unlinkFromSubs(link: Link): void {
	if (M[link + LinkSlot.LinkInSubs] === 0) {
		return
	}
	M[link + LinkSlot.LinkInSubs] = 0
	const dep = linkDep(link)
	const prev = M[link + LinkSlot.LinkPrevSub]
	const next = M[link + LinkSlot.LinkNextSub]
	if (prev !== 0) {
		M[prev + LinkSlot.LinkNextSub] = next
	} else {
		M[dep + NodeSlot.Subs] = next
	}
	if (next !== 0) {
		M[next + LinkSlot.LinkPrevSub] = prev
	} else {
		M[dep + NodeSlot.SubsTail] = prev
	}
	M[link + LinkSlot.LinkPrevSub] = 0
	M[link + LinkSlot.LinkNextSub] = 0
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
export function addObserver(node: ReactiveNode): void {
	const id = node.id
	const index = id >> RECORD_SHIFT
	const observerCount = ++observerCounts[index]
	if (observerCount === 1) {
		M[id + NodeSlot.Flags] |= Flag.Watched
		if ((M[id + NodeSlot.Flags] & Flag.KindDerived) !== 0) {
			// A canonically Computing node was promoted from inside its running body.
			// Skip history validation: its watermark predates this evaluation, so
			// deps the eval just re-read
			// would compare as changed-since and seed a false StaleCheck. The
			// running eval is the validator — its finally stamps fresh staleness
			// and a current validAt reading.
			const validate = (M[id + NodeSlot.Flags] & Flag.Computing) === 0
			const validAt = validAtClocks[index]
			let invalid = false
			for (let l = depsOf(id); l !== undefined; l = M[l + LinkSlot.LinkNextDep] || undefined) {
				linkIntoSubs(l, node)
				const depId = linkDep(l)
				addObserver(pinnedInternals[depId >> RECORD_SHIFT]!)
				if (
					validate &&
					(changedAtOf(depId) > validAt ||
						(M[depId + NodeSlot.Flags] & Flag.StaleMask) !== 0)
				) {
					invalid = true
				}
			}
			if (invalid && (M[id + NodeSlot.Flags] & Flag.StaleMask) === 0) {
				M[id + NodeSlot.Flags] |= Flag.StaleCheck
			}
		}
		noteLifetimeTransition(node)
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
export function removeObserver(node: ReactiveNode): void {
	const id = node.id
	const index = id >> RECORD_SHIFT
	const observerCount = --observerCounts[index]
	if (observerCount === 0) {
		M[id + NodeSlot.Flags] &= ~Flag.Watched
		if ((M[id + NodeSlot.Flags] & Flag.KindDerived) !== 0) {
			for (let l = depsOf(id); l !== undefined; l = M[l + LinkSlot.LinkNextDep] || undefined) {
				unlinkFromSubs(l)
				const dep = linkDep(l)
				removeObserver(pinnedInternals[dep >> RECORD_SHIFT]!)
			}
			validAtClocks[index] =
				(M[id + NodeSlot.Flags] & Flag.StaleMask) === 0 ? graphChangeClock : 0
		}
		noteLifetimeTransition(node)
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

/** Host microtask scheduler (present in every supported runtime; typed here
 * so the engine's type surface stays lib-agnostic). */
declare const queueMicrotask: (fn: () => void) => void

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
export function flushLifetimeTransitions(): void {
	lifetimeFlushScheduled = false
	const cells = [...pendingLifetimeCells]
	pendingLifetimeCells.clear()
	for (const cell of cells) {
		const shouldBeActive = observerCounts[cell.id >> RECORD_SHIFT] > 0
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
	const depId = dep.id
	const subId = sub.id
	const tail: Link = M[subId + NodeSlot.DepsTail]
	if (tail !== 0 && M[tail + LinkSlot.LinkDep] === depId) {
		return
	}
	const next: Link = tail === 0 ? M[subId + NodeSlot.Deps] : M[tail + LinkSlot.LinkNextDep]
	if (next !== 0 && M[next + LinkSlot.LinkDep] === depId) {
		M[next + LinkSlot.LinkEvalPass] = evalPass
		M[subId + NodeSlot.DepsTail] = next
		return
	}
	trackReadInsert(dep, sub)
}

function trackReadInsert(dep: ReactiveNode, sub: ReactiveNode): void {
	const depId = dep.id
	const subId = sub.id
	const tail: Link = M[subId + NodeSlot.DepsTail]
	const next: Link = tail === 0 ? M[subId + NodeSlot.Deps] : M[tail + LinkSlot.LinkNextDep]
	const watched = (M[subId + NodeSlot.Flags] & Flag.Watched) !== 0
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
			M[last + LinkSlot.LinkEvalPass] === evalPass
		) {
			return
		}
	}
	const link = allocLink()
	M[link + LinkSlot.LinkDep] = depId
	M[link + LinkSlot.LinkSub] = subId
	if (++M[depId + NodeSlot.RefCount] === 1) {
		pinnedInternals[depId >> RECORD_SHIFT] = dep
	}
	M[link + LinkSlot.LinkNextDep] = next
	M[link + LinkSlot.LinkEvalPass] = evalPass
	if (tail === 0) {
		M[subId + NodeSlot.Deps] = link
	} else {
		M[tail + LinkSlot.LinkNextDep] = link
	}
	M[subId + NodeSlot.DepsTail] = link
	if (watched) {
		linkIntoSubs(link, sub)
		addObserver(dep)
	}
}

/** Drop dependency edges not re-read by the eval that just finished. */
function trimDeps(sub: ReactiveNode): void {
	const subId = sub.id
	const tail = depsTailOf(subId)
	let stale = tail === undefined ? depsOf(subId) : M[tail + LinkSlot.LinkNextDep] || undefined
	if (tail !== undefined) {
		M[tail + LinkSlot.LinkNextDep] = 0
	} else {
		M[subId + NodeSlot.Deps] = 0
	}
	while (stale !== undefined) {
		const next = M[stale + LinkSlot.LinkNextDep] || undefined
		if (M[stale + LinkSlot.LinkInSubs] !== 0) {
			unlinkFromSubs(stale)
			const dep = linkDep(stale)
			removeObserver(pinnedInternals[dep >> RECORD_SHIFT]!)
		}
		freeLink(stale)
		stale = next
	}
}

// ---------------------------------------------------------------------------
// Invalidation (push through watched edges)
// ---------------------------------------------------------------------------

/** Effect watchers scheduled by the current wave. Cleared by logical length
 * (effectCount), never `.length = 0`: V8 right-trims the backing store on a
 * length reset, so a truncated queue re-grows its capacity from zero on
 * every wave (O(log n) reallocations plus copies, garbage proportional to
 * peak wave width). The price of retained capacity is that consumed slots
 * are nulled at drain — a soft-cleared slot must not pin a disposed watcher.
 * Append-then-fully-drain with the drain-time disposed check (Watched clear)
 * as the tombstone; there is no mid-queue removal, so no compaction
 * machinery. */
const effectQueue: Array<WatcherNode | undefined> = []
let effectCount = 0

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
	// One masked test: not already queued AND not disposed (Watched = alive).
	if ((flags & (Flag.Scheduled | Flag.Watched)) !== Flag.Watched) {
		return
	}
	const w = pinnedInternals[id >> RECORD_SHIFT] as WatcherNode
	if ((flags & Flag.WatchRender) !== 0) {
		renderNotifyQueue[renderNotifyCount++] = w
	} else if ((flags & Flag.WatchRunEffect) !== 0) {
		effectQueue[effectCount++] = w
	} else {
		return
	}
	M[id + NodeSlot.Flags] = flags | Flag.Scheduled
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
	if (link === undefined) {
		return
	}
	const tracing = cause !== NO_EVENT
	let stack = waveStack
	let top = 0
	let cur: Link = link
	let next: Link = M[cur + LinkSlot.LinkNextSub]
	do {
		const sub = M[cur + LinkSlot.LinkSub]
		const flags = M[sub + NodeSlot.Flags]
		if ((flags & Flag.StaleMask) !== 0) {
			if ((flags & (Flag.Watching | Flag.Scheduled)) === Flag.Watching) {
				scheduleWatcher(sub, flags)
			}
		} else {
			M[sub + NodeSlot.Flags] = flags | Flag.StaleCheck
			if (tracing) {
				causeEvents[sub >> RECORD_SHIFT] = cause
			}
			if ((flags & Flag.Watching) !== 0) {
				scheduleWatcher(sub, flags | Flag.StaleCheck)
			} else if ((flags & Flag.KindDerived) !== 0) {
				const subSubs = M[sub + NodeSlot.Subs]
				if (subSubs !== 0) {
					cur = subSubs
					const sibling = M[cur + LinkSlot.LinkNextSub]
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
			next = M[cur + LinkSlot.LinkNextSub]
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
		next = M[cur + LinkSlot.LinkNextSub]
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
export function pokeDraftWatchers(
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
			if (pokePasses[subIndex] !== pass) {
				pokePasses[subIndex] = pass
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
							causeEvents[subIndex] = cause
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
export function propagateFrom(cell: CellNode<unknown>, cause: TraceEventId): void {
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
export function invalidateDerived(node: DerivedNode<unknown>, cause: TraceEventId): void {
	graphChangeClock++
	const id = node.id
	setFlags(node, (flagsOf(node) & ~Flag.StaleMask) | Flag.StaleDirty)
	causeEvents[id >> RECORD_SHIFT] = cause
	// Invariant: changes are stamped with the CURRENT clock, after the tick.
	graphClocks[(id >> 1) + 3] = graphChangeClock
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

export function startBatch(): void {
	if (batchDepth === 0) {
		batchPass++
	}
	batchDepth++
}

export function endBatch(): void {
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
					if (cell.equals(cell.value, base.value)) {
						graphClocks[(cell.id >> 1) + 3] = base.changedAtGraphChange
					}
				}
			}
			batchBase.clear()
		}
		flush()
	}
}

export function batch<T>(fn: () => T): T {
	startBatch()
	try {
		return fn()
	} finally {
		endBatch()
	}
}

let flushing = false
/** Drain cursor into effectQueue (index, not shift: the queue can be large
 * and repeated shifts would make wide flushes quadratic). */
let queueHead = 0

/** Hard iteration ceiling: converts livelock into a thrown error. */
const enum Limit {
	/** Queued-effect runs per flush before declaring a non-settling cycle. */
	FlushRuns = 100_000,
}

/** Run queued effects until settled, then deliver render notifications. A
 * throwing effect aborts the flush; the effects it preempted are skipped
 * (cleared), not left armed for unrelated writes to trigger later. */
export function flush(): void {
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
			const w = effectQueue[i]!
			effectQueue[i] = undefined // consumed slot must not pin the watcher
			// Clear Scheduled alone: runWatcher's validation reads StaleCheck.
			const flags = flagsOf(w) & ~Flag.Scheduled
			setFlags(w, flags)
			if ((flags & Flag.Watched) === 0 || (flags & Flag.StaleMask) === 0) {
				continue
			}
			runWatcher(w)
		}
		effectCount = 0
		queueHead = 0
	} catch (e) {
		// Preempted effects are skipped, not left armed for unrelated writes to
		// trigger later; their unconsumed slots get the same nulling discipline.
		for (let i = queueHead; i < effectCount; i++) {
			const w = effectQueue[i]!
			effectQueue[i] = undefined
			setFlags(w, flagsOf(w) & ~(Flag.Scheduled | Flag.StaleMask))
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
export function peekCell<T>(cell: CellNode<T>): T {
	assertSignalReadAllowed()
	materializeCell(cell)
	return cell.value as T
}

export function readCell<T>(cell: CellNode<T>): T {
	assertSignalReadAllowed()
	materializeCell(cell)
	if (activeConsumer !== null) {
		trackRead(cell, activeConsumer)
	}
	return cell.value as T
}

export function writeCell<T>(cell: CellNode<T>, next: T): boolean {
	assertSignalWriteAllowed()
	// The equality contract compares against the base value, so a write that
	// arrives before the first read still runs the initializer.
	materializeCell(cell)
	if (cell.equals(cell.value as T, next)) {
		return false
	}
	const id = cell.id
	const index = id >> RECORD_SHIFT
	if (batchDepth > 0 && batchPasses[index] !== batchPass) {
		// First write to this cell in this batch pass: save the pre-batch state.
		// The pass stamp stands in for a batchBase.has probe on repeat writes.
		batchPasses[index] = batchPass
		batchBase.set(cell as CellNode<unknown>, {
			value: cell.value,
			changedAtGraphChange: changedAtOf(id),
		})
	}
	cell.value = next
	// Invariant: tick the clock FIRST, then stamp the change with the new
	// reading — a change stamped at a pre-tick reading could compare equal to
	// a subscriber that validated before this write.
	graphChangeClock++
	graphClocks[(id >> 1) + 3] = graphChangeClock
	const cause = traceHook !== null ? traceHook('write', cell, currentCause) : NO_EVENT
	propagateFrom(cell as CellNode<unknown>, cause)
	return true
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

function recompute(node: DerivedNode<unknown>): void {
	const id = node.id
	let flags = flagsOf(node)
	if ((flags & Flag.ComputingMask) !== 0) {
		throw new Error(`cycle detected in computed${node.label ? ` "${node.label}"` : ''}`)
	}
	setFlags(node, flags | Flag.Computing)
	const prevConsumer = activeConsumer
	const prevEvaluation = activeEvaluation
	activeConsumer = node
	activeEvaluation = node
	const myPass = newEvalPass()
	M[id + NodeSlot.DepsTail] = 0
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
		setFlags(node, flagsOf(node) & ~Flag.Computing)
	}
	const changed = finishComputeImpl(node, parked, hasError, error, value)
	// Invariant: only a REAL change advances the reading (equality cutoff
	// keeps the old stamp, so downstream validAt comparisons stay equal).
	// Stamped with the CURRENT clock, not the pre-eval reading: recomputes do
	// not tick the clock, and any consumer that validated before this
	// recompute holds a strictly older validAt reading.
	if (changed) {
		graphClocks[(id >> 1) + 3] = graphChangeClock
	}
	// A computed whose evaluation wrote state is self-affecting: its inputs
	// moved under it, so it never caches — every read re-evaluates.
	flags = flagsOf(node)
	setFlags(
		node,
		(flags & ~Flag.StaleMask) | (graphChangeClock !== preGraphChange ? Flag.StaleDirty : 0),
	)
	validAtClocks[id >> RECORD_SHIFT] = preGraphChange
}

/** Bring a derived up to date; exact recompute counts are the contract. */
export function ensureFresh(node: DerivedNode<unknown>, knownFlags?: Flags): void {
	const id = node.id
	const flags = knownFlags ?? M[id + NodeSlot.Flags]
	if ((flags & Flag.Watched) !== 0) {
		// Watched: push marks are trustworthy (promote validated the closure).
		if ((flags & Flag.StaleMask) === 0) {
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
	const validAt = validAtClocks[id >> RECORD_SHIFT]
	for (let l = depsOf(id); l !== undefined; l = M[l + LinkSlot.LinkNextDep] || undefined) {
		const depId = linkDep(l)
		// Same watched-Clean skip as readDerived: such a dep has nothing to
		// validate, so don't pay a call to find that out.
		const dflags = M[depId + NodeSlot.Flags]
		if (
			(dflags & Flag.KindDerived) !== 0 &&
			(dflags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched
		) {
			ensureFresh(pinnedInternals[depId >> RECORD_SHIFT] as DerivedNode<unknown>, dflags)
		}
		if (graphClocks[(depId >> 1) + 3] > validAt) {
			recompute(node)
			return
		}
	}
	setFlags(node, flagsOf(node) & ~Flag.StaleMask)
	// Invariant: the watermark is stamped only AFTER every dep was freshened
	// and compared (freshen-then-stamp order).
	validAtClocks[id >> RECORD_SHIFT] = graphChangeClock
}

export function readDerived<T>(node: DerivedNode<T>): T {
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

export function untracked<T>(fn: () => T): T {
	const prev = activeConsumer
	activeConsumer = null
	try {
		return fn()
	} finally {
		activeConsumer = prev
	}
}

export function getActiveConsumer(): ReactiveNode | null {
	return activeConsumer
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

function makeWatcher(
	fn: (() => void | (() => void)) | undefined,
	capabilities: number,
): WatcherNode {
	const w = {
		// Watchers are born watched — for a watcher the bit means ALIVE, and it
		// drops at dispose; their edges never go through promote/demote
		// counting. Capability bits are creation-fixed: they route scheduling
		// for the watcher's whole life.
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

function runWatcher(w: WatcherNode): void {
	const id = w.id
	// Validate: a StaleCheck-marked watcher whose derived deps cut off must
	// not re-run its body. Validation can itself run user code (computed fns)
	// that disposes this very watcher — re-check after every pull.
	if ((flagsOf(w) & Flag.StaleCheck) !== 0) {
		let changed = false
		const validAt = validAtClocks[id >> RECORD_SHIFT]
		for (let l = depsOf(id); l !== undefined; l = M[l + LinkSlot.LinkNextDep] || undefined) {
			const depId = linkDep(l)
			// Same watched-Clean skip as readDerived: such a dep has nothing to
			// validate, so don't pay a call to find that out.
			const dflags = M[depId + NodeSlot.Flags]
			if (
				(dflags & Flag.KindDerived) !== 0 &&
				(dflags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched
			) {
				ensureFresh(pinnedInternals[depId >> RECORD_SHIFT] as DerivedNode<unknown>, dflags)
				if ((flagsOf(w) & Flag.Watched) === 0) {
					return
				} // disposed mid-validation
			}
			if (graphClocks[(depId >> 1) + 3] > validAt) {
				changed = true
				break
			}
		}
		if (!changed) {
			setFlags(w, flagsOf(w) & ~Flag.StaleMask)
			// Invariant: watermark stamped only after every dep was freshened and
			// compared (freshen-then-stamp order) — same rule as ensureFresh.
			validAtClocks[id >> RECORD_SHIFT] = graphChangeClock
			return
		}
	}
	setFlags(w, flagsOf(w) & ~Flag.StaleMask)
	executeWatcher(w)
}

function executeWatcher(w: WatcherNode): void {
	const id = w.id
	// Effects created by the previous run belong to that run.
	if (w.children !== undefined) {
		const children = w.children
		w.children = undefined
		for (const child of children) {
			disposeWatcher(child)
		}
	}
	if (w.cleanup !== undefined) {
		const c = w.cleanup
		w.cleanup = undefined
		try {
			untracked(c)
		} catch (e) {
			// A throwing cleanup poisons the effect: dispose it fully so it never
			// half-runs again, then surface the error.
			disposeWatcher(w)
			throw e
		}
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
	const myPass = newEvalPass()
	M[id + NodeSlot.DepsTail] = 0
	const cause =
		traceHook !== null ? traceHook('effect-run', w, causeEvents[id >> RECORD_SHIFT]) : NO_EVENT
	// The validation reading is taken at the PRE-run clock: if the body
	// itself writes, its deps may have moved under it, and the wave its write
	// pushed re-schedules this watcher — whose next validation must then see
	// those deps as changed-since (their stamps exceed the pre-run reading).
	const preGraphChange = graphChangeClock
	const prevCause = setCurrentCause(cause)
	try {
		const ret = w.fn!()
		if (typeof ret === 'function') {
			w.cleanup = ret
		}
	} finally {
		setCurrentCause(prevCause)
		evalPass = myPass
		activeConsumer = prevConsumer
		activeScope = prevScope
		trimDeps(w)
		validAtClocks[id >> RECORD_SHIFT] = preGraphChange
	}
}

export function disposeWatcher(w: WatcherNode): void {
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
		pinnedInternals[w.id >> RECORD_SHIFT] = undefined
		reclaimNodeRecord(w.id)
	}
}

function unlinkAllDeps(w: WatcherNode): void {
	const id = w.id
	let l = depsOf(id)
	M[id + NodeSlot.Deps] = 0
	M[id + NodeSlot.DepsTail] = 0
	while (l !== undefined) {
		const next = M[l + LinkSlot.LinkNextDep] || undefined
		if (M[l + LinkSlot.LinkInSubs] !== 0) {
			unlinkFromSubs(l)
			const dep = linkDep(l)
			removeObserver(pinnedInternals[dep >> RECORD_SHIFT]!)
		}
		freeLink(l)
		l = next
	}
}

function reclaimNodeRecord(id: number): void {
	let link = M[id + NodeSlot.Deps] || undefined
	while (link !== undefined) {
		const next = M[link + LinkSlot.LinkNextDep] || undefined
		if (M[link + LinkSlot.LinkInSubs] !== 0) {
			unlinkFromSubs(link)
			const dep = linkDep(link)
			removeObserver(pinnedInternals[dep >> RECORD_SHIFT]!)
		}
		freeLink(link)
		link = next
	}
	pinnedInternals[id >> RECORD_SHIFT] = undefined
	// Explicit stores for the same reason as freeLink: no builtin call per
	// reclaimed node. ChangedAt spans two words; the Float64 view clears both.
	M[id + NodeSlot.Flags] = 0
	M[id + NodeSlot.Deps] = 0
	M[id + NodeSlot.DepsTail] = 0
	M[id + NodeSlot.Subs] = 0
	M[id + NodeSlot.SubsTail] = 0
	M[id + NodeSlot.RefCount] = 0
	graphClocks[(id >> 1) + 3] = 0
	const index = id >> RECORD_SHIFT
	validAtClocks[index] = 0
	observerCounts[index] = 0
	causeEvents[index] = 0
	pokePasses[index] = 0
	batchPasses[index] = 0
	M[id + NodeSlot.FreeNext] = freeNodes
	freeNodes = id
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
export function resetGraphForBenchmark(): void {
	M.fill(0, 0, nextRecord)
	const end = nextRecord >> RECORD_SHIFT
	validAtClocks.fill(0, 0, end)
	observerCounts.fill(0, 0, end)
	causeEvents.fill(0, 0, end)
	pokePasses.fill(0, 0, end)
	batchPasses.fill(0, 0, end)
	pinnedInternals.length = 1
	pinnedInternals[0] = undefined
	pendingRegistrations.length = 0
	pendingRegistrationEnd = 0
	registrationScheduled = false
	nextRecord = RECORD_STRIDE
	freeLinks = 0
	freeNodes = 0
	nodeFinalizer = makeNodeFinalizer()
	droppedDisposers = new FinalizationRegistry<WatcherNode>((w) => disposeWatcher(w))
}

/**
 * Reclaims effects whose disposer was dropped without being called. The
 * watcher node is held by the graph (its dependencies' subscriber lists), so
 * only the disposer's collectibility tells us the user is done with it.
 */
let droppedDisposers = new FinalizationRegistry<WatcherNode>((w) => disposeWatcher(w))

export function makeEffect(fn: () => void | (() => void)): () => void {
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

export function makeScope(fn: () => void): () => void {
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
export function observeNode(
	node: ReactiveNode,
	notify: () => void,
	draftWake?: (id: DraftId) => void,
): () => void {
	const sub = makeWatcher(undefined, Flag.WatchRender | Flag.WatchDraft)
	sub.onNotify = notify
	sub.onDraftWake = draftWake
	newEvalPass()
	const subId = sub.id
	M[subId + NodeSlot.DepsTail] = 0
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
				causeEvents[subId >> RECORD_SHIFT] = causeEvents[node.id >> RECORD_SHIFT]
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
