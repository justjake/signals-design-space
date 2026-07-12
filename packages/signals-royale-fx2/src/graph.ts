/**
 * The core reactive graph: signals (writable values, called "cells" here),
 * computeds (cached values derived from other nodes, called "deriveds"),
 * and effects (callbacks that re-run when the values they read change).
 *
 * Change moves through the graph in two phases:
 *
 * - Push: writing a cell walks its subscriber edges and marks downstream
 *   nodes "possibly stale". The walk only marks and schedules; it never
 *   recomputes anything.
 * - Pull: reading a node checks those marks. A computed re-runs only when
 *   one of its dependencies actually changed value since the computed last
 *   validated. A dependency that recomputed to an equal value does not
 *   count as changed, so its consumers skip recomputation entirely (the
 *   "equality cutoff").
 *
 * Staleness is decided by comparing clock readings, not by flags alone.
 * One module-wide counter, `graphChangeClock`, increments on every cell
 * write and every async settlement. Each node records the clock reading at
 * its last real value change (`changedAtGraphChange`), and each consumer
 * records the reading at its last successful validation
 * (`validAtGraphChange`). "Did this dependency change since I last
 * checked?" is then a single comparison:
 * `dep.changedAtGraphChange > sub.validAtGraphChange`. The comparison is
 * strict: equal readings mean that validation already saw the change.
 *
 * Nodes are either watched or unwatched. A node is watched while something
 * observes it — an effect, a React subscription, or another watched
 * computed. Only watched nodes are linked into their dependencies'
 * subscriber lists, so the push phase reaches exactly the nodes someone
 * cares about. An unwatched computed holds references toward its
 * dependencies only; dropping the last user reference makes the whole
 * chain garbage-collectible without any registry. Because no push marks
 * reach it, an unwatched computed instead validates lazily on read against
 * the clock. Effects are the one thing a user can leak by dropping the
 * disposer without calling it, so a FinalizationRegistry on the disposer
 * reclaims those.
 *
 * Besides clocks, the module uses "pass" counters (`EvalPass`, `PokePass`,
 * `BatchPass`). A pass value identifies one dynamic scope — a single
 * evaluation, a single traversal, a single batch. Passes are monotonic and
 * never reused; a stored pass value equal to the currently running pass
 * means "this record was already touched by the pass now running". Passes
 * are identities, not clocks: never compare them for order.
 */

import type { ErrorBox, Suspension } from './asyncs.ts'
import type { DraftId } from './worlds.ts'

export type EqualsFn<T> = (a: T, b: T) => boolean

/** Weak number brand. Plain numbers assign in, so creation and increment
 * stay cast-free (`let x: EvalPass = 1; x++`), but a value of one brand
 * does not assign to a slot or parameter of another brand — mixing up two
 * counters is a type error. The symbol is declared, never created: it is
 * purely type-level, and the runtime representation stays a plain number. */
declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]?: B }

/** The module-wide change clock (see the header): increments on every cell
 * write and every async settlement. */
export type GraphChangeClock = Brand<number, 'GraphChangeClock'>
export type TraceEventId = Brand<number, 'TraceEventId'>
/** Identity of one evaluation pass (see the header on passes). */
export type EvalPass = Brand<number, 'EvalPass'>
/** Identity of one poke walk. */
export type PokePass = Brand<number, 'PokePass'>
/** Identity of one top-level batch scope. */
export type BatchPass = Brand<number, 'BatchPass'>

/**
 * Per-node flag bits. `Flag` names a single bit; the stored word is the
 * separate `Flags` type, a branded number, because TypeScript types const
 * enum unions as the enum itself, which would force a cast on every
 * `|=` / `&=` composition.
 */
export const enum Flag {
	// Node kinds: exactly one is set at creation and never changes.
	/** Writable source (a signal's backing node). */
	KindCell = 0b0000_0000_0001,
	/** Cached computed. */
	KindDerived = 0b0000_0000_0010,
	/** Watcher: an effect, a store subscription, or a scope anchor. */
	Watching = 0b0000_0000_0100,

	// Watcher capabilities: fixed at creation, present on Watching nodes
	// only. Scheduling dispatches on these bits, never on whether a callback
	// happens to be installed. A component subscription is
	// Watching|WatchRender|WatchDraft; an engine effect is
	// Watching|WatchRunEffect; a scope anchor is Watching alone.
	/** Deliver through the render-notify queue, after effects settle. The
	 * subscriber's own notify callback decides whether the delivery becomes
	 * a re-render. */
	WatchRender = 0b0000_0000_1000,
	/** Deliver through the effect queue: validate, then run the body. */
	WatchRunEffect = 0b0000_0001_0000,
	/** Draft notifications (see worlds.ts) reach this watcher. Watchers
	 * without this bit only hear about base-state changes; engine effects
	 * are all base-state-only. */
	WatchDraft = 0b0000_0010_0000,

	// Staleness: at most one of the pair is set; writers clear the whole
	// field before setting, so a single-bit test reads the exact state.
	/** Possibly stale: confirm dependency changedAt readings before
	 * recomputing. */
	StaleCheck = 0b0000_0100_0000,
	/** Definitely stale: recompute on next pull. */
	StaleDirty = 0b0000_1000_0000,

	// Async state: at most one of the pair is set; both clear means the
	// node holds a plain value.
	/** Latest evaluation threw; node.throwable holds the ErrorBox to
	 * rethrow. */
	AsyncError = 0b0001_0000_0000,
	/** Latest evaluation parked on an unresolved thenable; node.throwable
	 * holds the Suspension. */
	AsyncSuspended = 0b0010_0000_0000,

	/** Two meanings by node kind. On cells and deriveds it mirrors
	 * observerCount > 0 (the count is authoritative; the bit is the cheap
	 * hot-path test). On watchers it means alive: set at creation, cleared
	 * at dispose. */
	Watched = 0b0100_0000_0000,
	/** Watcher currently sits in a flush queue. */
	Scheduled = 0b1000_0000_0000,
	/** Base-state derived evaluation in progress. */
	Computing = 0b1_0000_0000_0000,
	/** Draft-world derived evaluation in progress (worlds.ts). Kept
	 * separate from Computing because only a base-state evaluation may
	 * update the node's validation watermark. */
	DraftComputing = 0b10_0000_0000_0000,

	/** Both staleness bits; (flags & StaleMask) === 0 means clean. */
	StaleMask = StaleCheck | StaleDirty,
	/** Both async bits; (flags & AsyncMask) === 0 means plain value. */
	AsyncMask = AsyncError | AsyncSuspended,
	/** Either kind of evaluation in progress; re-entry means a cycle. */
	ComputingMask = Computing | DraftComputing,
}
/** The stored per-node word: a composition of Flag bits. */
export type Flags = Brand<number, 'Flags'>

/** One dependency edge: `sub` read `dep`. Each link sits in two intrusive
 * doubly/singly linked lists — the subscriber's dependency list (nextDep)
 * and, while the subscriber is watched, the dependency's subscriber list
 * (prevSub/nextSub). */
export interface Link {
	dep: ReactiveNode
	sub: ReactiveNode
	nextDep: Link | undefined
	prevSub: Link | undefined
	nextSub: Link | undefined
	/** Whether the link is present in dep's subscriber list (true only
	 * while sub is watched). */
	inSubs: boolean
	/** The evaluation pass that last read this edge. Equality with the
	 * running pass means the evaluation in progress already touched it. */
	evalPass: EvalPass
}

export interface ReactiveNode {
	flags: Flags
	/**
	 * The clock reading at this node's last real value change. A recompute
	 * that produced an equal value does not advance it, and a batch whose
	 * writes net out restores it — that is what makes the staleness
	 * comparison (`dep.changedAtGraphChange > sub.validAtGraphChange`)
	 * mean "actually changed since that subscriber last validated".
	 *
	 * Changes are stamped with the current clock at change time. Writes
	 * tick the clock first and then stamp; recomputes stamp without
	 * ticking, because a recompute is a consequence of an earlier write,
	 * not a new change event, and any consumer that validated before the
	 * recompute already holds a strictly older reading.
	 */
	changedAtGraphChange: GraphChangeClock
	/**
	 * The object backing the async flags: the ErrorBox to rethrow
	 * (AsyncError) or the Suspension being awaited (AsyncSuspended); null
	 * when the node holds a plain value. Present on every node kind so all
	 * nodes share one object shape — cells never set the async bits but
	 * are read through the same { flags, value, throwable } protocol
	 * (DerivedState, asyncs.ts).
	 */
	throwable: ErrorBox | Suspension | null
	/** Subscriber list: watched consumers and store subscriptions. */
	subs: Link | undefined
	subsTail: Link | undefined
	/** Dependency list in first-read order (deriveds and watchers only). */
	deps: Link | undefined
	depsTail: Link | undefined
	/** Number of observers: watched consumer edges, effects, and React
	 * subscriptions. */
	observerCount: number
	/** Tracing: the event that caused the latest invalidation to reach
	 * this node. */
	causeEvent: TraceEventId
	label: string | undefined
	/** Per-world resolution memos, managed by worlds.ts; undefined while
	 * no transition drafts are live. */
	worldMemos: Map<string, unknown> | undefined
	/** The last poke walk that reached this node. Equality with the
	 * running walk's pass means the walk already visited it. */
	pokePass: PokePass
}

let graphChangeClock: GraphChangeClock = 1
/** Identity of the evaluation pass in progress. */
let evalPass: EvalPass = 1
/** Backing counter for evaluation passes — monotonic, never reused. If a
 * value were recycled, the same-pass check in trackRead could match an
 * edge left over from a dead pass and skip registering a dependency the
 * current evaluation actually read. */
let evalPassCounter: EvalPass = 1
function newEvalPass(): EvalPass {
	evalPass = ++evalPassCounter
	return evalPass
}
/** The node whose dependencies are being tracked right now: reads inside
 * an evaluation register edges against this node. */
let activeConsumer: ReactiveNode | null = null
/** The computed body executing right now, tracked separately from
 * activeConsumer: untracked() clears activeConsumer but must not disable
 * per-computed policies (like the no-writes-inside-computeds rule). */
export let activeEvaluation: DerivedNode<unknown> | null = null
let batchDepth = 0

export function currentGraphChange(): GraphChangeClock {
	return graphChangeClock
}

// ---------------------------------------------------------------------------
// Tracing seam. tracer.ts installs the hook. A mutable module binding
// rather than an object property, so the common detached case costs one
// null check per emit site and the graph has no runtime dependency on the
// tracer.
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
/** The trace event acting as causal parent for the operation in progress
 * (a write, an effect run, or a settlement). */
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

export interface CellNode<T> extends ReactiveNode {
	value: T | typeof UNINITIALIZED
	initializer: (() => T) | undefined
	equals: EqualsFn<T>
	/** The batch pass that already saved this cell's pre-batch state.
	 * Equality with the running pass means the batchBase entry exists, so
	 * repeat writes in the same batch skip the map lookup. */
	batchPass: BatchPass
	/** The onObserved option: setup that runs when the cell gains its first
	 * observer, returning an optional cleanup for when the last one leaves. */
	lifetime: ((ctx: { get(): T; set(v: T): void }) => void | (() => void)) | undefined
	lifetimeCleanup: (() => void) | undefined
	lifetimeActive: boolean
}

export interface DerivedNode<T> extends ReactiveNode {
	value: T | typeof UNINITIALIZED
	fn: (use: UseFn, previous: T | undefined) => T
	equals: EqualsFn<T>
	/** The clock reading at this node's last successful validation. When it
	 * equals the current clock, nothing in the graph changed since, so an
	 * unwatched read can return immediately without walking dependencies. */
	validAtGraphChange: GraphChangeClock
}

export interface WatcherNode extends ReactiveNode {
	/** The clock reading at this watcher's last validation or run; same
	 * meaning as DerivedNode.validAtGraphChange. */
	validAtGraphChange: GraphChangeClock
	fn: (() => void | (() => void)) | undefined
	cleanup: (() => void) | undefined
	/** Child effects created during this watcher's run (when it acts as a
	 * scope); disposing the watcher disposes them. */
	children: WatcherNode[] | undefined
	/** Render-notify callback (WatchRender watchers). */
	onNotify: (() => void) | undefined
	/** Draft-wake callback: receives the id of a transition draft whose new
	 * write touches this subscriber's sources. Separate from onNotify so
	 * draft activity never looks like a base-state change to subscribers
	 * that compare snapshots. */
	onDraftWake: ((id: DraftId) => void) | undefined
}

export type UseFn = <U>(t: PromiseLike<U>) => U

// ---------------------------------------------------------------------------
// Dependency linking
// ---------------------------------------------------------------------------

function linkIntoSubs(link: Link): void {
	if (link.inSubs) {
		return
	}
	link.inSubs = true
	const dep = link.dep
	link.prevSub = dep.subsTail
	link.nextSub = undefined
	if (dep.subsTail !== undefined) {
		dep.subsTail.nextSub = link
	} else {
		dep.subs = link
	}
	dep.subsTail = link
}

function unlinkFromSubs(link: Link): void {
	if (!link.inSubs) {
		return
	}
	link.inSubs = false
	const dep = link.dep
	if (link.prevSub !== undefined) {
		link.prevSub.nextSub = link.nextSub
	} else {
		dep.subs = link.nextSub
	}
	if (link.nextSub !== undefined) {
		link.nextSub.prevSub = link.prevSub
	} else {
		dep.subsTail = link.prevSub
	}
	link.prevSub = undefined
	link.nextSub = undefined
}

/**
 * A node's first observer arrived: link it into its dependencies'
 * subscriber lists, recursively (depth-first; cycles are impossible
 * because dependency edges only exist after an evaluation, and a cyclic
 * evaluation throws).
 *
 * While the node was unwatched, no push marks could reach it, so its clean
 * staleness flags cannot be trusted: dependencies may have changed without
 * it hearing. Each dependency is therefore checked once during promotion,
 * two ways. The clock comparison catches dependencies that recomputed to a
 * new value. It cannot catch a stale unwatched dependency that has not
 * recomputed yet — its changedAt reading has not moved even though its
 * inputs did — so the dependency's own staleness flag (just restored by
 * its recursive promotion) is checked as well. If either check fails, a
 * clean node is marked StaleCheck. This restores the invariant that push
 * marks rely on: for every watched edge, a stale dependency implies a
 * stale or scheduled subscriber.
 */
export function addObserver(node: ReactiveNode): void {
	node.observerCount++
	if (node.observerCount === 1) {
		node.flags |= Flag.Watched
		if ((node.flags & Flag.KindDerived) !== 0) {
			// If this node's own evaluation is what triggered the promotion
			// (its body is running now), skip the history check: the node's
			// watermark predates the running evaluation, so dependencies it
			// just re-read would look changed-since and seed a false
			// StaleCheck. The running evaluation stamps fresh staleness and a
			// current watermark when it finishes.
			const validate = (node.flags & Flag.Computing) === 0
			const validAt = (node as DerivedNode<unknown>).validAtGraphChange
			let invalid = false
			for (let l = node.deps; l !== undefined; l = l.nextDep) {
				linkIntoSubs(l)
				const dep = l.dep
				addObserver(dep)
				if (
					validate &&
					(dep.changedAtGraphChange > validAt || (dep.flags & Flag.StaleMask) !== 0)
				) {
					invalid = true
				}
			}
			if (invalid && (node.flags & Flag.StaleMask) === 0) {
				node.flags |= Flag.StaleCheck
			}
		}
		noteLifetimeTransition(node)
	}
}

/**
 * A node's last observer left: unlink it from its dependencies' subscriber
 * lists, recursively. Afterwards the chain holds forward references only,
 * so dropping the user's handles makes it garbage-collectible whole.
 *
 * The node also gets a starting watermark for its unwatched life. If it is
 * clean right now, push marks were reliable up to this moment, so nothing
 * changed since its last validation and the watermark can be the current
 * clock — the next read short-circuits if the clock has not moved. If it
 * is stale, the watermark is zeroed so the next read walks its
 * dependencies. No staleness needs to be seeded here; the promote path
 * re-validates whenever the node becomes watched again.
 */
export function removeObserver(node: ReactiveNode): void {
	node.observerCount--
	if (node.observerCount === 0) {
		node.flags &= ~Flag.Watched
		if ((node.flags & Flag.KindDerived) !== 0) {
			for (let l = node.deps; l !== undefined; l = l.nextDep) {
				unlinkFromSubs(l)
				removeObserver(l.dep)
			}
			;(node as DerivedNode<unknown>).validAtGraphChange =
				(node.flags & Flag.StaleMask) === 0 ? graphChangeClock : 0
		}
		noteLifetimeTransition(node)
	}
}

// ---------------------------------------------------------------------------
// Lifetime effects: the onObserved signal option. Setup runs when the cell
// gains its first observer of any kind (a computed chain, an effect, or a
// React component), and the returned cleanup runs when the last observer
// of every kind is gone.
//
// Transitions are settled in a microtask rather than synchronously, so
// subscribe/unsubscribe flaps within one tick (React StrictMode
// double-mounts, list reorders) net out instead of tearing the resource
// down and back up.
// ---------------------------------------------------------------------------

/** Host microtask scheduler; declared here so the engine typechecks
 * without a DOM or Node lib. */
declare const queueMicrotask: (fn: () => void) => void

const pendingLifetimeCells = new Set<CellNode<unknown>>()
let lifetimeFlushScheduled = false

/** Called whenever a cell's observer count crosses zero in either
 * direction. */
function noteLifetimeTransition(node: ReactiveNode): void {
	if ((node.flags & Flag.KindCell) === 0) {
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
		const shouldBeActive = cell.observerCount > 0
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

/** Record "sub read dep" for the evaluation in progress. The subscriber's
 * dependency list is reused in place: depsTail is a cursor that advances
 * as the evaluation re-reads dependencies in the same order as last time,
 * so a stable evaluation allocates nothing. */
function trackRead(dep: ReactiveNode, sub: ReactiveNode): Link {
	const tail = sub.depsTail
	if (tail !== undefined && tail.dep === dep && tail.evalPass === evalPass) {
		return tail
	}
	const next = tail === undefined ? sub.deps : tail.nextDep
	if (next !== undefined && next.dep === dep) {
		next.evalPass = evalPass
		sub.depsTail = next
		return next
	}
	const watched = (sub.flags & Flag.Watched) !== 0
	if (watched) {
		// Deduplicate a non-adjacent re-read within the same evaluation:
		// when this subscriber already read this dep earlier in the pass,
		// its link sits at the dep's subscriber-list tail, so an evalPass
		// match means the edge exists and is inside the kept prefix — reuse
		// it instead of registering the observer twice. Unwatched edges
		// never enter subscriber lists, so unwatched re-reads may leave
		// duplicate forward edges; those are harmless and forward-only.
		const last = dep.subsTail
		if (last !== undefined && last.sub === sub && last.evalPass === evalPass) {
			return last
		}
	}
	const link: Link = {
		dep,
		sub,
		nextDep: next,
		prevSub: undefined,
		nextSub: undefined,
		inSubs: false,
		evalPass,
	}
	if (tail === undefined) {
		sub.deps = link
	} else {
		tail.nextDep = link
	}
	sub.depsTail = link
	if (watched) {
		linkIntoSubs(link)
		addObserver(dep)
	}
	return link
}

/** Drop dependency edges the just-finished evaluation did not re-read. */
function trimDeps(sub: ReactiveNode): void {
	const tail = sub.depsTail
	let stale = tail === undefined ? sub.deps : tail.nextDep
	if (tail !== undefined) {
		tail.nextDep = undefined
	} else {
		sub.deps = undefined
	}
	while (stale !== undefined) {
		const next = stale.nextDep
		if (stale.inSubs) {
			unlinkFromSubs(stale)
			removeObserver(stale.dep)
		}
		stale.nextDep = undefined
		stale = next
	}
}

// ---------------------------------------------------------------------------
// Invalidation (push through watched edges)
// ---------------------------------------------------------------------------

/** Effect watchers scheduled by the current invalidation wave. The array's
 * capacity is retained across waves: it is cleared by resetting
 * effectCount, never by `.length = 0`, because V8 trims the backing store
 * on a length reset and the queue would then re-grow from zero capacity on
 * every wave. The cost of retaining capacity is that consumed slots must
 * be nulled at drain time so they do not pin disposed watchers. */
const effectQueue: Array<WatcherNode | undefined> = []
let effectCount = 0

/** Render-notify subscribers scheduled by the current wave; they are
 * notified after effects settle. Double-buffered: a draining wave iterates
 * its own buffer while entries scheduled during delivery land in the
 * spare, so an iteration never sees entries added mid-delivery. Same
 * retained-capacity treatment as effectQueue. */
let renderNotifyQueue: Array<ReactiveNode | undefined> = []
let renderNotifyCount = 0
/** The off-duty render-notify buffer; null while a draining flush has it
 * checked out. Delivery can nest (an onNotify callback may write, and that
 * write's flush drains the buffer the outer flush is filling), and a
 * doubly-nested flush must not reuse a buffer that is mid-iteration — it
 * allocates a fresh one instead. */
let spareRenderNotify: Array<ReactiveNode | undefined> | null = []

/** Route a watcher into its flush queue by capability bit. Scope anchors
 * carry neither capability and are never scheduled (they track no
 * dependencies). */
function scheduleWatcher(w: WatcherNode): void {
	const flags = w.flags
	// One masked test covering both "already queued" and "disposed"
	// (Watched means alive on watchers).
	if ((flags & (Flag.Scheduled | Flag.Watched)) !== Flag.Watched) {
		return
	}
	if ((flags & Flag.WatchRender) !== 0) {
		renderNotifyQueue[renderNotifyCount++] = w
	} else if ((flags & Flag.WatchRunEffect) !== 0) {
		effectQueue[effectCount++] = w
	} else {
		return
	}
	w.flags = flags | Flag.Scheduled
}

// ---------------------------------------------------------------------------
// The two graph traversals. Both walk subscriber edges downstream from a
// node, but they differ in what they do at each visit:
//
// - propagateWave is the base-state invalidation wave. It marks clean
//   nodes StaleCheck and schedules every kind of watcher. Its visited-set
//   is the mark itself: an already-stale subtree is guaranteed to be fully
//   marked (see the visit rules on propagateWave), so the wave does not
//   descend into it again.
// - pokeDraftWatchers notifies draft-aware watchers only, without touching
//   base state; effects never hear it. Its visited-set is the per-node
//   pokePass stamp, which needs no clearing because pass values are never
//   reused.
//
// Neither traversal decides whether a subscriber re-renders. Delivery just
// invokes the subscriber's callback; the React layer then compares what it
// rendered against what it would resolve now (see hooks.ts) and only
// re-renders on a real difference.
//
// propagateFrom and invalidateDerived are the wave's entry points: they
// record the root node's change, then run the wave.
// ---------------------------------------------------------------------------

/** A suspended traversal position. The walks are iterative with an
 * explicit stack on the heap, so their depth is bounded by memory rather
 * than by JS call-stack frames. */
interface WaveFrame {
	value: Link | undefined
	prev: WaveFrame | undefined
}

interface PokeFrame extends WaveFrame {
	changed: boolean
	prev: PokeFrame | undefined
}

/**
 * The invalidation wave: push staleness marks down the watched subscriber
 * closure of a changed node.
 *
 * Marks are always StaleCheck ("possibly stale"), never StaleDirty:
 * consumers confirm against dependency changedAt readings before
 * recomputing or re-running. Because the readings — not the marks — are
 * what triggers recomputation, a write that is reverted inside the same
 * batch ends up a true no-op.
 *
 * Visit rules, per node (also applied by any code that installs a
 * subscriber edge onto an already-stale dependency — see observeNode):
 * 1. already stale: re-schedule the watcher if it is not scheduled, and do
 *    not descend — a stale dependency implies its subscribers are already
 *    stale or scheduled, so everything below is already marked;
 * 2. clean: set StaleCheck and record the causal event for tracing;
 * 3. watcher: schedule it; watchers have no subscribers, so never descend;
 * 4. derived: descend into its subscribers.
 *
 * The traversal is iterative: a link cursor, the pending sibling, and an
 * explicit stack of suspended positions. A single-child descent reuses the
 * pending-sibling slot instead of pushing a frame, so plain chains run
 * with no stack growth at all.
 */
function propagateWave(link: Link | undefined, cause: TraceEventId): void {
	if (link === undefined) {
		return
	}
	let cur: Link = link
	let next: Link | undefined = cur.nextSub
	let stack: WaveFrame | undefined
	top: do {
		const sub = cur.sub
		const flags = sub.flags
		if ((flags & Flag.StaleMask) !== 0) {
			if ((flags & (Flag.Watching | Flag.Scheduled)) === Flag.Watching) {
				scheduleWatcher(sub as WatcherNode)
			}
		} else {
			sub.flags = flags | Flag.StaleCheck
			sub.causeEvent = cause
			if ((flags & Flag.Watching) !== 0) {
				scheduleWatcher(sub as WatcherNode)
			} else if ((flags & Flag.KindDerived) !== 0) {
				const subSubs = sub.subs
				if (subSubs !== undefined) {
					cur = subSubs
					if (cur.nextSub !== undefined) {
						stack = { value: next, prev: stack }
						next = cur.nextSub
					}
					continue
				}
			}
		}
		if (next !== undefined) {
			cur = next
			next = cur.nextSub
			continue
		}
		while (stack !== undefined) {
			const resume = stack.value
			stack = stack.prev
			if (resume !== undefined) {
				cur = resume
				next = cur.nextSub
				continue top
			}
		}
		break
	} while (true)
}

/** Identity of the poke walk in progress. Monotonic and never reused, so
 * per-node pokePass stamps need no clearing between walks. */
let pokePass: PokePass = 0

/**
 * The poke walk: notify draft-aware watchers downstream of a node without
 * touching base state. Draft activity — a write recorded into a draft, a
 * draft committing or being discarded — changes what draft readers should
 * resolve while base-state readers see nothing, so those readers need
 * their own notification channel.
 *
 * The walk shares the wave's cursor-and-frame-stack skeleton and follows
 * the same watched derived edges down to the subscribers. It must descend
 * that far because subscribers subscribe to the node they read (usually a
 * computed), not to the drafted cell underneath it; stopping at the cell
 * would leave every downstream subscriber unaware. Watchers without the
 * WatchDraft bit (all effects) are untouched.
 *
 * Poked watchers get a StaleCheck mark for consistency with the wave; for
 * render-notify watchers the bits are write-only between here and the
 * flush, so the exact mark does not matter.
 *
 * `wake`, when present, additionally delivers that draft id to the same
 * watchers in this one walk. Writes into a draft need both notification
 * and delivery; commit and discard call sites poke without waking.
 * `valueChanged`, when present, is a per-producer cutoff: subscribers of a
 * producer whose draft value did not change are skipped, unless they carry
 * no draft-wake callback (value-independent probes, which must hear every
 * poke). The walk runs in the writer's ambient context, so inside a React
 * transition the wake dispatches join that transition's updates. Wake
 * delivery happens after the notify flush because the flush's effects may
 * dispose subscriptions, and a disposed subscriber must not receive the
 * draft id.
 */
export function pokeDraftWatchers(
	node: ReactiveNode,
	cause: TraceEventId,
	wake?: DraftId,
	valueChanged?: (node: ReactiveNode) => boolean,
): void {
	const pass = ++pokePass
	let wakes: WatcherNode[] | null = null
	let changed = valueChanged?.(node) ?? true
	const first = node.subs
	if (first !== undefined) {
		let cur: Link = first
		let next: Link | undefined = cur.nextSub
		let stack: PokeFrame | undefined
		top: do {
			const sub = cur.sub
			if (sub.pokePass !== pass) {
				sub.pokePass = pass
				const flags = sub.flags
				if ((flags & Flag.WatchDraft) !== 0) {
					const w = sub as WatcherNode
					// Watchers with a draft-wake callback are value subscribers,
					// so the value cutoff applies to them. Watchers without one
					// are probes (isPending and the like): they must hear every
					// poke, because pendingness can change while values stay
					// equal.
					if (w.onDraftWake === undefined || changed) {
						scheduleWatcher(w)
						if ((w.flags & Flag.StaleMask) === 0) {
							w.flags |= Flag.StaleCheck
						}
						w.causeEvent = cause
						if (wake !== undefined && w.onDraftWake !== undefined) {
							;(wakes ??= []).push(w)
						}
					}
				} else if ((flags & Flag.KindDerived) !== 0) {
					const subSubs = sub.subs
					if (subSubs !== undefined) {
						const subChanged = valueChanged?.(sub) ?? true
						cur = subSubs
						if (cur.nextSub !== undefined) {
							stack = { value: next, changed: subChanged, prev: stack }
							next = cur.nextSub
						}
						changed = subChanged
						continue
					}
				}
			}
			if (next !== undefined) {
				cur = next
				next = cur.nextSub
				continue
			}
			while (stack !== undefined) {
				const resume = stack.value
				changed = stack.changed
				stack = stack.prev
				if (resume !== undefined) {
					cur = resume
					next = cur.nextSub
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
			if ((w.flags & Flag.Watched) !== 0) {
				w.onDraftWake!(wake!)
			}
		}
	}
}

/** Push an invalidation wave from a cell whose base value just changed. */
export function propagateFrom(cell: CellNode<unknown>, cause: TraceEventId): void {
	propagateWave(cell.subs, cause)
	if (batchDepth === 0) {
		flush()
	}
}

/**
 * Invalidate a derived from outside the dependency graph — used when a
 * thenable it parked on settles. Treated exactly like a write: the clock
 * ticks and the node's changedAt reading advances so downstream validation
 * re-pulls, subscribers get marked, effects run.
 */
export function invalidateDerived(node: DerivedNode<unknown>, cause: TraceEventId): void {
	graphChangeClock++
	node.flags = (node.flags & ~Flag.StaleMask) | Flag.StaleDirty
	node.causeEvent = cause
	// Tick first, then stamp with the new reading (see writeCell).
	node.changedAtGraphChange = graphChangeClock
	propagateWave(node.subs, cause)
	if (batchDepth === 0) {
		flush()
	}
}

/** Cells written inside the current batch, with the state they had before
 * it. When a batch's writes net out to the original value, endBatch
 * restores the cell's changedAt reading so consumers validate the batch as
 * a no-op. */
const batchBase = new Map<
	CellNode<unknown>,
	{ value: unknown; changedAtGraphChange: GraphChangeClock }
>()

/** Identity of the current top-level batch. Increments only when a batch
 * opens at depth zero; nested batches belong to the enclosing one,
 * matching batchBase's lifetime. */
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
					// The batch's writes netted out to the original value: restore
					// the pre-batch changedAt reading so consumers validate this
					// cell as unchanged. The clock still ticked; consumers just
					// pay one reading comparison and skip recomputing.
					if (cell.equals(cell.value, base.value)) {
						cell.changedAtGraphChange = base.changedAtGraphChange
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
/** Drain cursor into effectQueue. An index rather than Array#shift: the
 * queue can be large, and repeated shifts would make wide flushes
 * quadratic. */
let queueHead = 0

/** Hard iteration ceiling: converts a livelock into a thrown error. */
const enum Limit {
	/** Queued-effect runs per flush before declaring a non-settling cycle. */
	FlushRuns = 100_000,
}

/** Run queued effects until they settle, then deliver render
 * notifications. A throwing effect aborts the flush; the effects it
 * preempted are cleared rather than left scheduled, so an unrelated later
 * write cannot trigger them with stale marks. */
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
			// Clear only Scheduled; runWatcher's validation still needs the
			// staleness bits.
			const flags = (w.flags &= ~Flag.Scheduled)
			if ((flags & Flag.Watched) === 0 || (flags & Flag.StaleMask) === 0) {
				continue
			}
			runWatcher(w)
		}
		effectCount = 0
		queueHead = 0
	} catch (e) {
		// Clear the effects the throw preempted (see the function comment);
		// their unconsumed slots are nulled like consumed ones.
		for (let i = queueHead; i < effectCount; i++) {
			const w = effectQueue[i]!
			effectQueue[i] = undefined
			w.flags &= ~(Flag.Scheduled | Flag.StaleMask)
		}
		effectCount = 0
		queueHead = 0
		throw e
	} finally {
		flushing = false
		if (renderNotifyCount > 0) {
			// Take this wave's buffer and swap the spare in as the push
			// target: subscribers scheduled during delivery land there for
			// the next wave, so this iteration never sees them. A
			// doubly-nested delivery finds the spare checked out (null) and
			// allocates a fresh array — that rare frame pays an allocation
			// rather than clobbering a buffer that is mid-iteration.
			const delivering = renderNotifyQueue
			const n = renderNotifyCount
			renderNotifyQueue = spareRenderNotify ?? []
			spareRenderNotify = null
			renderNotifyCount = 0
			for (let i = 0; i < n; i++) {
				const w = delivering[i] as WatcherNode
				// Render-notify watchers are never validated, so Scheduled and
				// the staleness bits can clear together in one store.
				w.flags &= ~(Flag.Scheduled | Flag.StaleMask)
			}
			try {
				for (let i = 0; i < n; i++) {
					const w = delivering[i] as WatcherNode
					if ((w.flags & Flag.Watched) !== 0) {
						w.onNotify!()
					}
				}
			} finally {
				// Null the consumed slots (retained capacity must not pin
				// watchers) and hand the buffer back as the spare, even when a
				// notify callback threw.
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
/** Policy switch only. The machinery for computeds that write state (see
 * recompute's self-affecting handling) works either way; flipping this to
 * false allows such writes without any other change. */
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

/** Untracked base-value read; runs a lazy cell's initializer if needed. */
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
	// The equality check compares against the current base value, so a
	// write that arrives before the first read still runs the initializer.
	materializeCell(cell)
	if (cell.equals(cell.value as T, next)) {
		return false
	}
	if (batchDepth > 0 && cell.batchPass !== batchPass) {
		// First write to this cell in this batch: save the pre-batch state.
		cell.batchPass = batchPass
		batchBase.set(cell as CellNode<unknown>, {
			value: cell.value,
			changedAtGraphChange: cell.changedAtGraphChange,
		})
	}
	cell.value = next
	// Tick the clock first, then stamp the change with the new reading. A
	// change stamped with a pre-tick reading could compare equal to a
	// subscriber that validated before this write, hiding the change.
	graphChangeClock++
	cell.changedAtGraphChange = graphChangeClock
	const cause = traceHook !== null ? traceHook('write', cell, currentCause) : NO_EVENT
	propagateFrom(cell as CellNode<unknown>, cause)
	return true
}

/** Thrown by an evaluation when it parks on an unresolved thenable. */
export const PARKED = Symbol('parked')

/** Installed by asyncs.ts: handles use(t) inside a base-state evaluation. */
export let useImpl: (t: PromiseLike<unknown>, consumer: DerivedNode<unknown>) => unknown = () => {
	throw new Error('async use() is not installed')
}
export function setUseImpl(impl: typeof useImpl): void {
	useImpl = impl
}

/** The use() argument passed to every base-state recompute. One shared
 * function with no per-node closure: at call time the evaluating computed
 * is activeConsumer, so the function can find its owner. (Draft
 * evaluations pass their own use function instead; see worlds.ts.) A
 * use() that escapes its evaluation — captured and called later, or called
 * inside untracked() — finds no evaluating computed and throws rather than
 * park the wrong node. */
const evalUse: UseFn = (<U>(t: PromiseLike<U>): U => {
	const consumer = activeConsumer
	if (consumer === null || (consumer.flags & Flag.KindDerived) === 0) {
		throw new Error('use() called outside a computed evaluation')
	}
	return useImpl(t, consumer as DerivedNode<unknown>) as U
}) as UseFn

/** Installed by asyncs.ts: finish a recompute, folding a park or a throw
 * into the node's async state. Takes the outcome as positional arguments
 * rather than an object because it runs once per recompute and must not
 * allocate. */
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
	if ((node.flags & Flag.ComputingMask) !== 0) {
		throw new Error(`cycle detected in computed${node.label ? ` "${node.label}"` : ''}`)
	}
	node.flags |= Flag.Computing
	const prevConsumer = activeConsumer
	const prevEvaluation = activeEvaluation
	activeConsumer = node
	activeEvaluation = node
	const myPass = newEvalPass()
	node.depsTail = undefined
	// The validation watermark is taken before the evaluation runs: if the
	// body itself writes state, the next read must revalidate.
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
		// A nested evaluation advanced the pass id; restore ours so dep
		// trimming sees the right pass.
		evalPass = myPass
		activeConsumer = prevConsumer
		activeEvaluation = prevEvaluation
		trimDeps(node)
		node.flags &= ~Flag.Computing
	}
	const changed = finishComputeImpl(node, parked, hasError, error, value)
	// Only a real value change advances the changedAt reading; an
	// equal-value recompute keeps the old stamp so downstream consumers
	// validate as unchanged. Stamped with the current clock (see the
	// changedAtGraphChange doc for why recomputes stamp without ticking).
	if (changed) {
		node.changedAtGraphChange = graphChangeClock
	}
	// A computed whose evaluation wrote state saw its own inputs move under
	// it, so it can never trust its cache: it is left StaleDirty and every
	// read re-evaluates it.
	node.flags =
		(node.flags & ~Flag.StaleMask) | (graphChangeClock !== preGraphChange ? Flag.StaleDirty : 0)
	node.validAtGraphChange = preGraphChange
}

const chainNodes: Array<DerivedNode<unknown> | undefined> = []
let chainDepth = 0

function chainResolve(start: DerivedNode<unknown>, first: Link): void {
	const base = chainDepth
	let depth = base
	let node = start
	let link = first
	let dep: ReactiveNode
	try {
		while (true) {
			chainNodes[depth++] = node
			dep = link.dep
			const flags = dep.flags
			if (
				(flags & (Flag.KindDerived | Flag.StaleMask)) ===
				(Flag.KindDerived | Flag.StaleDirty)
			) {
				chainDepth = depth
				recompute(dep as DerivedNode<unknown>)
				break
			}
			if (
				(flags & (Flag.KindDerived | Flag.StaleMask)) !==
				(Flag.KindDerived | Flag.StaleCheck)
			) {
				break
			}
			const next = dep.deps
			if (next === undefined || next.nextDep !== undefined) {
				chainDepth = depth
				ensureFreshAt(dep as DerivedNode<unknown>, 0)
				break
			}
			node = dep as DerivedNode<unknown>
			link = next
		}
		do {
			node = chainNodes[--depth]!
			chainNodes[depth] = undefined
			if (dep.changedAtGraphChange > node.validAtGraphChange) {
				chainDepth = depth
				recompute(node)
			} else {
				node.flags &= ~Flag.StaleMask
				node.validAtGraphChange = graphChangeClock
			}
			dep = node
		} while (depth !== base)
		chainDepth = base
	} finally {
		while (depth !== base) {
			chainNodes[--depth] = undefined
		}
		chainDepth = base
	}
}

/** Bring a derived up to date, recomputing only when a dependency truly
 * changed — exact recompute counts are part of the engine's contract. */
export function ensureFresh(node: DerivedNode<unknown>): void {
	ensureFreshAt(node, 0)
}

function ensureFreshAt(node: DerivedNode<unknown>, depth: number): void {
	const flags = node.flags
	if ((flags & Flag.Watched) !== 0) {
		// Watched: push marks are trustworthy (promotion validated the
		// dependency closure), so clean means fresh.
		if ((flags & Flag.StaleMask) === 0) {
			return
		}
		if (
			depth === 16 &&
			(flags & Flag.StaleMask) === Flag.StaleCheck &&
			node.value !== UNINITIALIZED
		) {
			const first = node.deps
			if (first !== undefined && first.nextDep === undefined) {
				chainResolve(node, first)
				return
			}
		}
	} else if ((flags & Flag.StaleMask) === 0 && node.validAtGraphChange === graphChangeClock) {
		return
	}
	if ((node.flags & Flag.StaleDirty) !== 0 || node.value === UNINITIALIZED) {
		recompute(node)
		return
	}
	// Possibly stale (StaleCheck, or an unwatched node needing
	// revalidation): confirm dependencies in first-read order, recomputing
	// only if one truly changed after this node's last validation. Each
	// dependency is freshened before its reading is compared — a lazy
	// dependency may recompute right here, stamping its changedAt with the
	// current clock, and the strictly-greater test then sees it.
	for (let l = node.deps; l !== undefined; l = l.nextDep) {
		const dep = l.dep
		// Skip the call for a watched clean derived — it has nothing to
		// validate (same shortcut as readDerived).
		const dflags = dep.flags
		if (
			(dflags & Flag.KindDerived) !== 0 &&
			(dflags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched
		) {
			ensureFreshAt(dep as DerivedNode<unknown>, depth === 16 ? 0 : depth + 1)
		}
		if (dep.changedAtGraphChange > node.validAtGraphChange) {
			recompute(node)
			return
		}
	}
	node.flags &= ~Flag.StaleMask
	// The watermark is stamped only after every dependency was freshened
	// and compared; stamping earlier could hide a change a lazy dependency
	// is about to surface.
	node.validAtGraphChange = graphChangeClock
}

export function readDerived<T>(node: DerivedNode<T>): T {
	assertSignalReadAllowed()
	// Watched and clean is the hot steady state: push marks are
	// trustworthy and there is nothing to validate, so skip the ensureFresh
	// call entirely.
	if ((node.flags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched) {
		ensureFreshAt(node as DerivedNode<unknown>, 0)
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
	return {
		// Watchers are born watched: on a watcher the bit means alive, and
		// it drops at dispose. Capability bits are fixed at creation and
		// route scheduling for the watcher's whole life.
		flags: Flag.Watching | Flag.Watched | capabilities,
		changedAtGraphChange: 0,
		validAtGraphChange: 0,
		throwable: null,
		subs: undefined,
		subsTail: undefined,
		deps: undefined,
		depsTail: undefined,
		observerCount: 0,
		causeEvent: NO_EVENT,
		label: undefined,
		fn,
		cleanup: undefined,
		children: undefined,
		onNotify: undefined,
		onDraftWake: undefined,
		worldMemos: undefined,
		pokePass: 0,
	}
}

let activeScope: WatcherNode | null = null

function runWatcher(w: WatcherNode): void {
	// Validate first: a possibly-stale watcher whose derived dependencies
	// all recomputed to equal values must not re-run its body. Validation
	// itself runs user code (computed bodies) that may dispose this very
	// watcher, so aliveness is re-checked after every pull.
	if ((w.flags & Flag.StaleCheck) !== 0) {
		let changed = false
		for (let l = w.deps; l !== undefined; l = l.nextDep) {
			const dep = l.dep
			// Skip the call for a watched clean derived — it has nothing to
			// validate (same shortcut as readDerived).
			const dflags = dep.flags
			if (
				(dflags & Flag.KindDerived) !== 0 &&
				(dflags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched
			) {
				ensureFreshAt(dep as DerivedNode<unknown>, 0)
				if ((w.flags & Flag.Watched) === 0) {
					return
				} // disposed mid-validation
			}
			if (dep.changedAtGraphChange > w.validAtGraphChange) {
				changed = true
				break
			}
		}
		if (!changed) {
			w.flags &= ~Flag.StaleMask
			// Stamped only after every dependency was freshened and compared,
			// same rule as ensureFresh.
			w.validAtGraphChange = graphChangeClock
			return
		}
	}
	w.flags &= ~Flag.StaleMask
	executeWatcher(w)
}

function executeWatcher(w: WatcherNode): void {
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
	// Only live effect watchers run a body. The cleanup above may have
	// disposed this watcher, so aliveness is checked here, after it.
	if ((w.flags & (Flag.WatchRunEffect | Flag.Watched)) !== (Flag.WatchRunEffect | Flag.Watched)) {
		return
	}
	const prevConsumer = activeConsumer
	const prevScope = activeScope
	activeConsumer = w
	activeScope = w
	const myPass = newEvalPass()
	w.depsTail = undefined
	const cause = traceHook !== null ? traceHook('effect-run', w, w.causeEvent) : NO_EVENT
	// The validation watermark is taken before the body runs: if the body
	// itself writes, its dependencies may change during the run, the write's
	// wave re-schedules this watcher, and the next validation must see those
	// dependencies as changed since this run (their stamps exceed the
	// pre-run reading).
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
		w.validAtGraphChange = preGraphChange
	}
}

export function disposeWatcher(w: WatcherNode): void {
	// On watchers the Watched bit means alive; clear means already disposed.
	if ((w.flags & Flag.Watched) === 0) {
		return
	}
	w.flags &= ~Flag.Watched
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
	}
}

function unlinkAllDeps(w: WatcherNode): void {
	let l = w.deps
	w.deps = undefined
	w.depsTail = undefined
	while (l !== undefined) {
		const next = l.nextDep
		if (l.inSubs) {
			unlinkFromSubs(l)
			removeObserver(l.dep)
		}
		l.nextDep = undefined
		l = next
	}
}

/**
 * Reclaims effects whose disposer was dropped without being called. The
 * watcher node itself is held alive by the graph (it sits in its
 * dependencies' subscriber lists), so the disposer's collectibility is the
 * only signal that the user is done with the effect.
 */
const droppedDisposers = new FinalizationRegistry<WatcherNode>((w) => disposeWatcher(w))

export function makeEffect(fn: () => void | (() => void)): () => void {
	const w = makeWatcher(fn, Flag.WatchRunEffect)
	const owned = activeScope !== null && (activeScope.flags & Flag.Watched) !== 0
	if (owned) {
		;(activeScope!.children ??= []).push(w)
	}
	executeWatcher(w)
	const dispose = () => {
		droppedDisposers.unregister(dispose)
		disposeWatcher(w)
	}
	// An effect created inside a scope (or inside another effect) lives and
	// dies with its owner, and dropping its individual disposer is normal
	// usage, not abandonment. Only ownerless effects arm the reclamation
	// registry — a collected disposer must never kill an effect something
	// still owns.
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
 * A store subscription: attach a callback to a node's invalidation wave
 * without evaluating the node. This is how the React bindings observe the
 * graph. The callback runs after the wave and its effects settle, so
 * subscribers re-read a consistent graph. Every subscription is both
 * render-notified and draft-aware (WatchRender|WatchDraft) even when no
 * draft-wake callback is given, because draft pokes must reach probes
 * (isPending, committed views) that install none.
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
	sub.depsTail = undefined
	const prevConsumer = activeConsumer
	activeConsumer = sub
	try {
		if ((node.flags & Flag.KindCell) !== 0) {
			readCell(node as CellNode<unknown>)
		} else if ((node.flags & Flag.KindDerived) !== 0) {
			// Subscribe to invalidation only; do not force an evaluation here.
			trackRead(node, sub)
			// This installed a subscriber edge without pulling the node. If
			// the node is already stale, the invalidation this subscriber
			// cares about already happened (or, while the node was unwatched,
			// could never be delivered), and no future wave will re-enter the
			// stale subtree — so apply the wave's visit rules to the new
			// subscriber now, once. Never-computed nodes are exempt: they are
			// born StaleDirty with no dependency edges, so there is no missed
			// invalidation to deliver.
			if (
				(node.flags & Flag.StaleMask) !== 0 &&
				(node as DerivedNode<unknown>).value !== UNINITIALIZED
			) {
				sub.flags |= Flag.StaleCheck
				sub.causeEvent = node.causeEvent
				scheduleWatcher(sub)
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
