/**
 * This module implements the reactive graph at the engine's core: atoms
 * (writable values), computeds (cached values computed from other nodes),
 * and effects (callbacks that re-run when the values they read change).
 *
 * Change moves through the graph in two phases:
 *
 * - Push: writing an atom walks its subscriber edges and marks downstream
 *   nodes "possibly stale". The walk only marks and schedules; it never
 *   recomputes anything.
 * - Pull: reading a node checks those marks. A computed re-runs only when
 *   one of its dependencies actually changed value since the computed last
 *   validated. A dependency that recomputed to an equal value does not
 *   count as changed, so its consumers skip recomputation entirely (the
 *   "equality cutoff").
 *
 * Staleness is decided by comparing clock readings, not by flags alone.
 * One module-wide counter, `graphChangeClock`, increments on every atom
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
 * chain garbage-collectible. Because no push marks reach it, an unwatched
 * computed instead validates lazily on read against the clock. Effects,
 * scopes, and subscriptions are explicit resources: their owners must call
 * the returned disposer.
 *
 * Besides clocks, the module uses "pass" counters (`EvalPass`, `PokePass`).
 * A pass value identifies one dynamic scope — a single evaluation or
 * traversal. Passes are monotonic and never reused; a stored pass value
 * equal to the currently running pass means "this record was already
 * touched by the pass now running". Passes are identities, not clocks:
 * never compare them for order.
 */

import type { ErrorBox, Suspension } from './asyncs.ts'
import type { DraftId } from './worlds.ts'

/** Value equality for the cutoff: when a write or recompute produces an
 * equal value, consumers are not notified and do not recompute. */
export type EqualsFn<T> = (a: T, b: T) => boolean

declare const brand: unique symbol
/** Weak number brand. Plain numbers assign in, so creation and increment
 * stay cast-free (`let x: EvalPass = 1; x++`), but a value of one brand
 * does not assign to a slot or parameter of another brand — mixing up two
 * counters is a type error. The symbol is declared, never created: it is
 * purely type-level, and the runtime representation stays a plain number. */
export type Brand<T, B extends string> = T & { readonly [brand]?: B }

/** The module-wide change clock (see the header): increments on every atom
 * write and every async settlement. */
export type GraphChangeClock = Brand<number, 'GraphChangeClock'>
/** Identity of one trace event; NO_EVENT (zero) means "no event". */
export type TraceEventId = Brand<number, 'TraceEventId'>
/** Identity of one evaluation pass (see the header on passes). */
export type EvalPass = Brand<number, 'EvalPass'>
/** Identity of one poke walk. */
export type PokePass = Brand<number, 'PokePass'>

/**
 * Per-node flag bits. `Flag` names a single bit; the stored word is the
 * separate `Flags` type, a branded number, because TypeScript types const
 * enum unions as the enum itself, which would force a cast on every
 * `|=` / `&=` composition.
 */
export const enum Flag {
	// Node kinds: exactly one is set at creation and never changes.
	/** Writable source. */
	KindAtom = 0b0000_0000_0001,
	/** Cached computed. */
	KindComputed = 0b0000_0000_0010,
	/** Watcher: an effect or store subscription. */
	Watching = 0b0000_0000_0100,

	// Watcher capabilities: fixed at creation, present on Watching nodes
	// only. Scheduling dispatches on these bits, never on whether a callback
	// happens to be installed. A component subscription is
	// Watching|WatchRender|WatchDraft; an engine effect is
	// Watching|WatchRunEffect.
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
	/** Validation asks the host to schedule the user body instead of running
	 * it inside the graph flush. Used by React-phase signal effects. */
	WatchSchedule = 0b100_0000_0000_0000,

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

	/** Two meanings by node kind. On atoms and computeds it mirrors
	 * observerCount > 0 (the count is authoritative; the bit is the cheap
	 * hot-path test). On watchers it means alive: set at creation, cleared
	 * at dispose. */
	Watched = 0b0100_0000_0000,
	/** Watcher currently sits in a flush queue. */
	Scheduled = 0b1000_0000_0000,
	/** Base-state computed evaluation in progress. */
	Computing = 0b1_0000_0000_0000,
	/** Draft-world computed evaluation in progress (worlds.ts). Kept
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
/** A node's Flag bits composed into one stored number. */
export type Flags = Brand<number, 'Flags'>

/** One dependency edge: `sub` read `dep`. Each link sits in two intrusive
 * doubly/singly linked lists — the subscriber's dependency list (nextDep)
 * and, while the subscriber is watched, the dependency's subscriber list
 * (prevSub/nextSub). */
export interface Link {
	dep: ReactiveNode
	sub: ConsumerNode
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

/** State every graph node carries, whatever its kind (atom, computed, or
 * watcher). */
export interface ReactiveNode {
	flags: Flags
	/**
	 * The clock reading at this node's last value-changing atom write or real
	 * computed-value change. A recompute that produced an equal value does
	 * not advance it.
	 * Atom writes remain conservatively visible even when later writes return
	 * to an earlier value.
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
	 * nodes share one object shape — atoms never set the async bits but
	 * are read through the same { flags, value, throwable } protocol
	 * (ResolvedState, asyncs.ts).
	 */
	throwable: ErrorBox | Suspension | null
	/** Subscriber list: watched consumers and store subscriptions. */
	subs: Link | undefined
	subsTail: Link | undefined
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
}

/** State carried only by nodes that read dependencies: computeds and
 * watchers. Atoms produce dependency values but never consume them. */
export interface ConsumerNode extends ReactiveNode {
	/** Dependency list in first-read order. */
	deps: Link | undefined
	depsTail: Link | undefined
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
let activeConsumer: ConsumerNode | null = null
/** Auxiliary watcher collecting draft-world certificate sources for the
 * scheduled effect currently running. Those edges wake comparison only;
 * the primary watcher's deps remain the values the user body read. */
export let activeWorldSourceConsumer: WatcherNode | null = null
/** The computed body executing right now, tracked separately from
 * activeConsumer: untracked() clears activeConsumer but must not disable
 * per-computed policies (like the no-writes-inside-computeds rule). */
export let activeEvaluation: ComputedNode<unknown> | null = null
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

/** Record one trace event and return its id, so the caller can pass it
 * on as the cause of downstream events. */
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

/** The id recorded when an operation has no known cause. */
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

/** A writable value node — the engine side of an atom. */
export interface AtomNode<T> extends ReactiveNode {
	value: T | typeof UNINITIALIZED
	initializer: (() => T) | undefined
	equals: EqualsFn<T>
	/** The onObserved option: setup that runs when the atom gains its first
	 * observer, returning an optional cleanup for when the last one leaves. */
	lifetime: ((ctx: { get(): T; set(v: T): void }) => void | (() => void)) | undefined
	lifetimeCleanup: (() => void) | undefined
	lifetimeActive: boolean
}

/** A cached computed-value node — the engine side of a computed. */
export interface ComputedNode<T> extends ConsumerNode {
	value: T | typeof UNINITIALIZED
	fn: (use: UseFn, previous: T | undefined) => T
	equals: EqualsFn<T>
	/** The clock reading at this node's last successful validation. When it
	 * equals the current clock, nothing in the graph changed since, so an
	 * unwatched read can return immediately without walking dependencies. */
	validAtGraphChange: GraphChangeClock
}

/** State needed while a scope or effect body owns nested effects. A real
 * watcher's Watched bit prevents a self-disposed effect from gaining children
 * later in the same body. */
interface EffectOwner {
	flags: Flags
	/** Direct child effects, allocated only when the first child is created. */
	children: WatcherNode[] | undefined
}

/** A node that reacts when its dependencies change: effects and
 * render-notify subscribers. */
export interface WatcherNode extends ConsumerNode, EffectOwner {
	/** The clock reading at this watcher's last validation or run; same
	 * meaning as ComputedNode.validAtGraphChange. */
	validAtGraphChange: GraphChangeClock
	fn: (() => void | (() => void)) | undefined
	cleanup: (() => void) | undefined
	/** Delivery callback: render notification for WatchRender watchers, or
	 * the React-phase scheduler for a deferred effect. */
	onNotify: (() => void) | undefined
	/** Draft-wake callback: receives the id of a transition draft whose new
	 * write touches this subscriber's sources. Separate from onNotify so
	 * draft activity never looks like a base-state change to subscribers
	 * that compare snapshots. */
	onDraftWake: ((id: DraftId) => void) | undefined
}

/** The `use` function handed to computed bodies: read a promise-like,
 * returning its value once settled or parking the evaluation until it
 * settles (see asyncs.ts). */
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
		if ((node.flags & Flag.KindComputed) !== 0) {
			// If this node's own evaluation is what triggered the promotion
			// (its body is running now), skip the history check: the node's
			// watermark predates the running evaluation, so dependencies it
			// just re-read would look changed-since and seed a false
			// StaleCheck. The running evaluation stamps fresh staleness and a
			// current watermark when it finishes.
			const computed = node as ComputedNode<unknown>
			const validate = (node.flags & Flag.Computing) === 0
			const validAt = computed.validAtGraphChange
			let invalid = false
			for (let l = computed.deps; l !== undefined; l = l.nextDep) {
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
		if ((node.flags & Flag.KindComputed) !== 0) {
			const computed = node as ComputedNode<unknown>
			for (let l = computed.deps; l !== undefined; l = l.nextDep) {
				unlinkFromSubs(l)
				removeObserver(l.dep)
			}
			computed.validAtGraphChange =
				(node.flags & Flag.StaleMask) === 0 ? graphChangeClock : 0
		}
		noteLifetimeTransition(node)
	}
}

// ---------------------------------------------------------------------------
// Lifetime effects: the onObserved atom option. Setup runs when the atom
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

const pendingLifetimeAtoms = new Set<AtomNode<unknown>>()
let lifetimeFlushScheduled = false

/** Called whenever an atom's observer count crosses zero in either
 * direction. */
function noteLifetimeTransition(node: ReactiveNode): void {
	if ((node.flags & Flag.KindAtom) === 0) {
		return
	}
	const atom = node as AtomNode<unknown>
	if (atom.lifetime === undefined) {
		return
	}
	pendingLifetimeAtoms.add(atom)
	if (!lifetimeFlushScheduled) {
		lifetimeFlushScheduled = true
		queueMicrotask(flushLifetimeTransitions)
	}
}

/** Settle observation state now (also called from tests). */
export function flushLifetimeTransitions(): void {
	lifetimeFlushScheduled = false
	const atoms = [...pendingLifetimeAtoms]
	pendingLifetimeAtoms.clear()
	for (const atom of atoms) {
		const shouldBeActive = atom.observerCount > 0
		if (shouldBeActive === atom.lifetimeActive) {
			continue
		}
		atom.lifetimeActive = shouldBeActive
		if (shouldBeActive) {
			const ctx = {
				get: () => peekAtom(atom),
				set: (v: unknown) => {
					writeAtom(atom, v)
				},
			}
			const cleanup = atom.lifetime!(ctx)
			atom.lifetimeCleanup = typeof cleanup === 'function' ? cleanup : undefined
		} else {
			const cleanup = atom.lifetimeCleanup
			atom.lifetimeCleanup = undefined
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
function trackRead(dep: ReactiveNode, sub: ConsumerNode): Link {
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

/** Link a world-resolved read to the watcher currently collecting
 * dependencies. World evaluation itself runs untracked, so only an
 * explicit watcher run reaches this path. */
export function trackWorldRead(node: ReactiveNode): void {
	const consumer = activeConsumer
	if (
		consumer !== null &&
		(consumer.flags & (Flag.Watching | Flag.Watched)) === (Flag.Watching | Flag.Watched)
	) {
		trackRead(node, consumer)
	}
}

/** Link one flattened draft-world certificate source to the auxiliary
 * wake-only watcher of the scheduled effect currently running. */
export function trackWorldSource(node: ReactiveNode): void {
	const consumer = activeWorldSourceConsumer
	if (consumer !== null && (consumer.flags & Flag.Watched) !== 0) {
		trackRead(node, consumer)
	}
}

/** Drop dependency edges the just-finished evaluation did not re-read. */
function trimDeps(sub: ConsumerNode): void {
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
/** Spare render-notify buffer; null while a draining flush has it
 * checked out. Delivery can nest (an onNotify callback may write, and that
 * write's flush drains the buffer the outer flush is filling), and a
 * doubly-nested flush must not reuse a buffer that is mid-iteration — it
 * allocates a fresh one instead. */
let spareRenderNotify: Array<ReactiveNode | undefined> | null = []

/** Route a watcher into its flush queue by capability bit. */
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
// Two graph traversals follow. Both walk subscriber edges downstream from
// a node, but they differ in what they do at each visit:
//
// - propagateWave is the base-state invalidation wave. It marks clean
//   nodes StaleCheck and schedules every kind of watcher. Its visited-set
//   is the mark itself: an already-stale subtree is guaranteed to be fully
//   marked (see the visit rules on propagateWave), so the wave does not
//   descend into it again.
// - pokeDraftWatchers notifies draft-aware watchers only, without touching
//   base state; ordinary engine effects never hear it. Its visited-set is
//   the per-node pokePass stamp, which needs no clearing because pass values
//   are never reused.
//
// Neither traversal decides whether a subscriber re-renders. Delivery just
// invokes the subscriber's callback; the React layer then compares what it
// rendered against what it would resolve now (see hooks.ts) and only
// re-renders on a real difference.
//
// propagateFrom and invalidateComputed are the wave's entry points: they
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
 * Push staleness marks down the watched subscriber closure of a changed
 * node — the invalidation wave.
 *
 * Marks are always StaleCheck ("possibly stale"), never StaleDirty:
 * consumers confirm against dependency changedAt readings before
 * recomputing or re-running.
 *
 * Visit rules, per node (also applied by any code that installs a
 * subscriber edge onto an already-stale dependency — see observeNode):
 * 1. already stale: re-schedule the watcher if it is not scheduled, and do
 *    not descend — a stale dependency implies its subscribers are already
 *    stale or scheduled, so everything below is already marked;
 * 2. clean: set StaleCheck and record the causal event for tracing;
 * 3. watcher: schedule it; watchers have no subscribers, so never descend;
 * 4. computed: descend into its subscribers.
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
			} else if ((flags & Flag.KindComputed) !== 0) {
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
 * Notify draft-aware watchers downstream of a node without touching base
 * state — the poke walk. Draft activity — a write recorded into a draft, a
 * draft committing or being discarded — changes what draft readers should
 * resolve while base-state readers see nothing, so those readers need
 * their own notification channel.
 *
 * The walk shares the wave's cursor-and-frame-stack skeleton and follows
 * the same watched computed edges down to the subscribers. It must descend
 * that far because subscribers subscribe to the node they read (usually a
 * computed), not to the drafted atom underneath it; stopping at the atom
 * would leave every downstream subscriber unaware. Watchers without the
 * WatchDraft bit (including ordinary engine effects) are untouched.
 *
 * Render-notify watchers get StaleCheck for consistency with the wave;
 * their bits are write-only until delivery. A host-scheduled effect gets
 * StaleDirty on a no-wake commit/discard poke so base validation cannot hide
 * a root-relative world change; a write's draft wake already schedules it.
 *
 * `wake`, when present, additionally delivers that draft id to the same
 * watchers in this one walk. Writes into a draft need both notification
 * and delivery; commit and discard call sites poke without waking.
 * `valueChanged`, when present, is a per-producer cutoff: subscribers of a
 * producer whose draft value did not change are skipped, except for
 * value-independent probes and host-scheduled effects that must refresh
 * world source edges. The walk runs in the writer's ambient context, so inside a React
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
					// Probes without a draft-wake callback must hear every poke,
					// because pendingness can change while values stay equal.
					// Host-scheduled effects also bypass the value cutoff: an
					// equal computed may have switched world-only source branches,
					// so its host phase must refresh those wake edges.
					if (w.onDraftWake === undefined || changed || (flags & Flag.WatchSchedule) !== 0) {
						scheduleWatcher(w)
						if ((flags & Flag.WatchSchedule) !== 0 && wake === undefined) {
							// A draft poke changes a root-relative world without
							// necessarily changing base graph readings. Force the host
							// callback so it can refresh that world's source edges.
							w.flags = (w.flags & ~Flag.StaleMask) | Flag.StaleDirty
						} else if ((w.flags & Flag.StaleMask) === 0) {
							w.flags |= Flag.StaleCheck
						}
						w.causeEvent = cause
						if (wake !== undefined && w.onDraftWake !== undefined) {
							;(wakes ??= []).push(w)
						}
					}
				} else if ((flags & Flag.KindComputed) !== 0) {
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

/** Push an invalidation wave from an atom whose base value just changed. */
export function propagateFrom(atom: AtomNode<unknown>, cause: TraceEventId): void {
	propagateWave(atom.subs, cause)
	if (batchDepth === 0) {
		flush()
	}
}

/**
 * Invalidate a computed from outside the dependency graph — used when a
 * thenable it parked on settles. Treated exactly like a write: the clock
 * ticks and the node's changedAt reading advances so downstream validation
 * re-pulls, subscribers get marked, effects run.
 */
export function invalidateComputed(node: ComputedNode<unknown>, cause: TraceEventId): void {
	graphChangeClock++
	node.flags = (node.flags & ~Flag.StaleMask) | Flag.StaleDirty
	node.causeEvent = cause
	// Tick first, then stamp with the new reading (see writeAtom).
	node.changedAtGraphChange = graphChangeClock
	propagateWave(node.subs, cause)
	if (batchDepth === 0) {
		flush()
	}
}

export function startBatch(): void {
	batchDepth++
}

export function endBatch(): void {
	if (batchDepth === 0) {
		throw new Error('endBatch() without a matching startBatch()')
	}
	batchDepth--
	if (batchDepth === 0) {
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

export class SignalReadForbidden extends Error {
	name = 'SignalReadForbidden'
}
export class SignalWriteForbidden extends Error {
	name = 'SignalWriteForbidden'
}
/** Policy switch only. The machinery for computeds that write state (see
 * recompute's self-affecting handling) works either way; flipping this to
 * false allows such writes without any other change. */
export const FORBID_WRITE_FROM_COMPUTED: boolean = true

let readsForbidden: string | null = null
let writesForbidden: string | null = null

export function assertSignalReadAllowed(): void {
	if (readsForbidden !== null) {
		throw new SignalReadForbidden(readsForbidden)
	}
}

export function assertSignalWriteAllowed(): void {
	if (writesForbidden !== null) {
		throw new SignalWriteForbidden(writesForbidden)
	}
	if (FORBID_WRITE_FROM_COMPUTED && activeEvaluation !== null) {
		throw new SignalWriteForbidden('writes inside computeds are forbidden')
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

function materializeAtom<T>(atom: AtomNode<T>): void {
	if (atom.value !== UNINITIALIZED) {
		return
	}
	const init = atom.initializer
	if (init === undefined) {
		throw new Error('cyclic lazy initializer')
	}
	atom.initializer = undefined
	const prevConsumer = activeConsumer
	const prevForbidden = setWritesForbidden('a lazy state initializer must not write to other state')
	activeConsumer = null
	try {
		atom.value = init()
	} catch (error) {
		atom.initializer = init
		throw error
	} finally {
		activeConsumer = prevConsumer
		setWritesForbidden(prevForbidden)
	}
}

/** Untracked base-value read; runs a lazy atom's initializer if needed. */
export function peekAtom<T>(atom: AtomNode<T>): T {
	assertSignalReadAllowed()
	materializeAtom(atom)
	return atom.value as T
}

export function readAtom<T>(atom: AtomNode<T>): T {
	assertSignalReadAllowed()
	materializeAtom(atom)
	if (activeConsumer !== null) {
		trackRead(atom, activeConsumer)
	}
	return atom.value as T
}

export function writeAtom<T>(atom: AtomNode<T>, next: T): boolean {
	assertSignalWriteAllowed()
	// The equality check compares against the current base value, so a
	// write that arrives before the first read still runs the initializer.
	materializeAtom(atom)
	if (atom.equals(atom.value as T, next)) {
		return false
	}
	atom.value = next
	// Tick the clock first, then stamp the change with the new reading. A
	// change stamped with a pre-tick reading could compare equal to a
	// subscriber that validated before this write, hiding the change.
	graphChangeClock++
	atom.changedAtGraphChange = graphChangeClock
	const cause = traceHook !== null ? traceHook('write', atom, currentCause) : NO_EVENT
	propagateFrom(atom as AtomNode<unknown>, cause)
	return true
}

/** Thrown by an evaluation when it parks on an unresolved thenable. */
export const PARKED = Symbol('parked')

/** Installed by asyncs.ts: handles use(t) inside a base-state evaluation. */
export let useImpl: (t: PromiseLike<unknown>, consumer: ComputedNode<unknown>) => unknown = () => {
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
const evalUse: UseFn = <U>(t: PromiseLike<U>): U => {
	const consumer = activeConsumer
	if (consumer === null || (consumer.flags & Flag.KindComputed) === 0) {
		throw new Error('use() called outside a computed evaluation')
	}
	return useImpl(t, consumer as ComputedNode<unknown>) as U
}

/** Installed by asyncs.ts: finish a recompute, folding a park or a throw
 * into the node's async state. Takes the outcome as positional arguments
 * rather than an object because it runs once per recompute and must not
 * allocate. */
export let finishComputeImpl: (
	node: ComputedNode<unknown>,
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

function recompute(node: ComputedNode<unknown>): void {
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

const chainNodes: Array<ComputedNode<unknown> | undefined> = []
let chainDepth = 0

function chainResolve(start: ComputedNode<unknown>, first: Link): void {
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
				(flags & (Flag.KindComputed | Flag.StaleMask)) ===
				(Flag.KindComputed | Flag.StaleDirty)
			) {
				chainDepth = depth
				recompute(dep as ComputedNode<unknown>)
				break
			}
			if (
				(flags & (Flag.KindComputed | Flag.StaleMask)) !==
				(Flag.KindComputed | Flag.StaleCheck)
			) {
				break
			}
			const computed = dep as ComputedNode<unknown>
			const next = computed.deps
			if (next === undefined || next.nextDep !== undefined) {
				chainDepth = depth
				ensureFreshAt(computed, 0)
				break
			}
			node = computed
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

/** Bring a computed up to date. Which conservative invalidations require
 * a recomputation is an implementation detail; resolved values and effect
 * observations are the semantic contract. */
export function ensureFresh(node: ComputedNode<unknown>): void {
	ensureFreshAt(node, 0)
}

function ensureFreshAt(node: ComputedNode<unknown>, depth: number): void {
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
		// Skip the call for a watched clean computed — it has nothing to
		// validate (same shortcut as readComputed).
		const dflags = dep.flags
		if (
			(dflags & Flag.KindComputed) !== 0 &&
			(dflags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched
		) {
			ensureFreshAt(dep as ComputedNode<unknown>, depth === 16 ? 0 : depth + 1)
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

export function readComputed<T>(node: ComputedNode<T>): T {
	assertSignalReadAllowed()
	// Watched and clean is the hot steady state: push marks are
	// trustworthy and there is nothing to validate, so skip the ensureFresh
	// call entirely.
	if ((node.flags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched) {
		ensureFreshAt(node as ComputedNode<unknown>, 0)
	}
	if (activeConsumer !== null) {
		trackRead(node, activeConsumer)
	}
	return node.value as T
}

export function untracked<T>(fn: () => T): T {
	const prev = activeConsumer
	const prevWorldSource = activeWorldSourceConsumer
	activeConsumer = null
	activeWorldSourceConsumer = null
	try {
		return fn()
	} finally {
		activeConsumer = prev
		activeWorldSourceConsumer = prevWorldSource
	}
}

export function getActiveConsumer(): ConsumerNode | null {
	return activeConsumer
}

export function setActiveEvaluation(
	node: ComputedNode<unknown> | null,
): ComputedNode<unknown> | null {
	const prev = activeEvaluation
	activeEvaluation = node
	return prev
}

export function isUninitialized(v: unknown): boolean {
	return v === UNINITIALIZED
}

export { UNINITIALIZED }

// ---------------------------------------------------------------------------
// Watchers: effects and store subscriptions
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

let activeEffectOwner: EffectOwner | null = null

/** Dispose every child even when one cleanup throws, then surface the first
 * error after the whole owned set is released. */
function disposeChildren(owner: EffectOwner): void {
	const children = owner.children
	if (children === undefined) {
		return
	}
	owner.children = undefined
	let failed = false
	let failure: unknown
	for (const child of children) {
		try {
			disposeWatcher(child)
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

function runWatcher(w: WatcherNode): void {
	// Validate first: a possibly-stale watcher whose computed dependencies
	// all recomputed to equal values must not re-run its body. Validation
	// itself runs user code (computed bodies) that may dispose this very
	// watcher, so aliveness is re-checked after every pull.
	if ((w.flags & Flag.StaleCheck) !== 0) {
		let changed = false
		for (let l = w.deps; l !== undefined; l = l.nextDep) {
			const dep = l.dep
			// Skip the call for a watched clean computed — it has nothing to
			// validate (same shortcut as readComputed).
			const dflags = dep.flags
			if (
				(dflags & Flag.KindComputed) !== 0 &&
				(dflags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched
			) {
				ensureFreshAt(dep as ComputedNode<unknown>, 0)
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
	const flags = (w.flags &= ~Flag.StaleMask)
	if ((flags & Flag.WatchSchedule) !== 0) {
		// A scheduled effect has validated a real base-state change. React owns
		// when its user body runs; acknowledge this reading and ask React to run
		// the next phase without replacing the body's dependency list.
		w.validAtGraphChange = graphChangeClock
		w.onNotify!()
	} else {
		executeWatcher(w)
	}
}

function executeWatcher(w: WatcherNode): void {
	// Effects created by the previous run belong to that run.
	if (w.children !== undefined) {
		try {
			disposeChildren(w)
		} catch (error) {
			// A child cleanup poisons its owner, but every sibling and the owner
			// itself must still release their edges before the first error escapes.
			try {
				disposeWatcher(w)
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
	const prevOwner = activeEffectOwner
	activeConsumer = w
	activeEffectOwner = w
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
		activeEffectOwner = prevOwner
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
				if (!failed) {
					failed = true
					failure = error
				}
			}
		}
	} finally {
		unlinkAllDeps(w)
	}
	if (failed) {
		throw failure
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

/** @internal A dependency-tracking effect whose user body runs in a
 * host-selected phase rather than inside the graph flush. */
export interface ScheduledEffect {
	run(fn: () => void | (() => void)): Link | undefined
	/** Re-evaluate committed-world source links without running the user
	 * effect body. Used when its visible dependencies compare equal but a
	 * computed may have switched branches in that world. */
	refresh<T>(fn: () => T): T
	dispose(): void
}

/** @internal Create a React-phase effect tracker. Base invalidations are
 * value-validated before schedule is called; draft ids use draftWake's
 * separate delivery channel. Its host owns deterministic setup-error and
 * unmount disposal, so this internal handle needs no abandonment finalizer. */
export function makeScheduledEffect(
	schedule: () => void,
	draftWake: (id: DraftId) => void,
): ScheduledEffect {
	const capabilities = Flag.WatchRunEffect | Flag.WatchDraft | Flag.WatchSchedule
	const w = makeWatcher(undefined, capabilities)
	const worldSources = makeWatcher(undefined, capabilities)
	w.onNotify = schedule
	w.onDraftWake = draftWake
	worldSources.onNotify = schedule
	worldSources.onDraftWake = draftWake
	function runPrimary(): void {
		executeWatcher(w)
	}
	const handle: ScheduledEffect = {
		run(fn) {
			if ((w.flags & Flag.Watched) === 0 || (worldSources.flags & Flag.Watched) === 0) {
				return undefined
			}
			w.fn = fn
			handle.refresh(runPrimary)
			return w.deps
		},
		refresh(fn) {
			const previous = activeWorldSourceConsumer
			activeWorldSourceConsumer = worldSources
			const myPass = newEvalPass()
			worldSources.depsTail = undefined
			const preGraphChange = graphChangeClock
			try {
				return fn()
			} finally {
				evalPass = myPass
				activeWorldSourceConsumer = previous
				trimDeps(worldSources)
				worldSources.validAtGraphChange = preGraphChange
			}
		},
		dispose() {
			// The wake-only watcher must die before the user cleanup: that
			// cleanup may write one of its sources, and an unmounted host must
			// not be scheduled again.
			disposeWatcher(worldSources)
			disposeWatcher(w)
		},
	}
	return handle
}

export function makeEffect(fn: () => void | (() => void)): () => void {
	const w = makeWatcher(fn, Flag.WatchRunEffect)
	const owner = activeEffectOwner
	if (owner !== null && (owner.flags & Flag.Watched) !== 0) {
		;(owner.children ??= []).push(w)
	}
	try {
		executeWatcher(w)
	} catch (error) {
		try {
			disposeWatcher(w)
		} catch {
			// Preserve the setup error.
		}
		throw error
	}
	return () => disposeWatcher(w)
}

export function makeScope(fn: () => void): () => void {
	const owner: EffectOwner = { flags: Flag.Watched, children: undefined }
	const prevOwner = activeEffectOwner
	const prevConsumer = activeConsumer
	activeEffectOwner = owner
	activeConsumer = null
	try {
		try {
			fn()
		} finally {
			activeEffectOwner = prevOwner
			activeConsumer = prevConsumer
		}
	} catch (error) {
		try {
			disposeChildren(owner)
		} catch {
			// Preserve the setup error.
		}
		throw error
	}
	return () => disposeChildren(owner)
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
	try {
		newEvalPass()
		sub.depsTail = undefined
		const prevConsumer = activeConsumer
		activeConsumer = sub
		try {
			if ((node.flags & Flag.KindAtom) !== 0) {
				readAtom(node as AtomNode<unknown>)
			} else if ((node.flags & Flag.KindComputed) !== 0) {
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
					(node as ComputedNode<unknown>).value !== UNINITIALIZED
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
	} catch (error) {
		try {
			disposeWatcher(sub)
		} catch {
			// Preserve the subscription error.
		}
		throw error
	}
	return () => disposeWatcher(sub)
}
