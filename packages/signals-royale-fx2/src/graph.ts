/**
 * This module implements the reactive graph at the engine's core: atoms
 * (writable values), computeds (cached values computed from other nodes),
 * and effects (a tracked compute paired with an untracked handler that
 * runs when the compute's settled value changes — see docs/effects.md).
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

import { type ErrorBox, type Suspension, baseUse, finishCompute } from './asyncs.ts'
import type { DraftId, World } from './worlds.ts'

/**
 * Value equality for the cutoff: when a write or recompute produces an
 * equal value, consumers are not notified and do not recompute.
 */
export type EqualsFn<T> = (a: T, b: T) => boolean

declare const brand: unique symbol
/**
 * Weak number brand. Plain numbers assign in, so creation and increment
 * stay cast-free (`let x: EvalPass = 1; x++`), but a value of one brand
 * does not assign to a slot or parameter of another brand — mixing up two
 * counters is a type error. The symbol is declared, never created: it is
 * purely type-level, and the runtime representation stays a plain number.
 */
export type Brand<T, B extends string> = T & { readonly [brand]?: B }

/**
 * The module-wide change clock (see the header): increments on every atom
 * write and every async settlement.
 */
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
	/** Scheduled sink: an effect or store subscription. */
	Watching = 0b0000_0000_0100,

	// Sink capabilities: fixed at creation, present on Watching nodes
	// only. Scheduling dispatches on these bits, never on whether a callback
	// happens to be installed. A component subscription is
	// Watching|WatchRender; an effect is Watching|WatchRunEffect.
	/**
	 * Deliver through the render-notify queue, after sync effects settle.
	 * The subscriber's own notify callback decides whether the delivery
	 * becomes a re-render.
	 */
	WatchRender = 0b0000_0000_1000,
	/**
	 * Effect: at the lane's drain site, refresh its tracked computation and
	 * run the handler when the settled value changed (see drainLane).
	 */
	WatchRunEffect = 0b0000_0001_0000,
	// Staleness: at most one of the pair is set; writers clear the whole
	// field before setting, so a single-bit test reads the exact state.
	/**
	 * Possibly stale: confirm dependency changedAt readings before
	 * recomputing.
	 */
	StaleCheck = 0b0000_0100_0000,
	/** Definitely stale: recompute on next pull. */
	StaleDirty = 0b0000_1000_0000,

	// Async state: at most one of the pair is set; both clear means the
	// node holds a plain value.
	/**
	 * Latest evaluation threw; node.throwable holds the ErrorBox to
	 * rethrow.
	 */
	AsyncError = 0b0001_0000_0000,
	/**
	 * Latest evaluation parked on an unresolved thenable; node.throwable
	 * holds the Suspension.
	 */
	AsyncSuspended = 0b0010_0000_0000,

	/**
	 * Two meanings by node kind. On atoms and computeds it mirrors
	 * observerCount > 0 (the count is authoritative; the bit is the cheap
	 * hot-path test). On watchers it means alive: set at creation, cleared
	 * at dispose.
	 */
	Watched = 0b0100_0000_0000,
	/** Watcher currently sits in a flush queue. */
	Scheduled = 0b1000_0000_0000,
	/** Base-state computed evaluation in progress. */
	Computing = 0b1_0000_0000_0000,
	/**
	 * Draft-world computed evaluation in progress (worlds.ts). Kept
	 * separate from Computing because only a base-state evaluation may
	 * update the node's validation watermark.
	 */
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

/**
 * One dependency edge: `sub` read `dep`. Each link sits in two intrusive
 * doubly/singly linked lists — the subscriber's dependency list (nextDep)
 * and, while the subscriber is watched, the dependency's subscriber list
 * (prevSub/nextSub).
 */
export interface Link {
	dep: ProducerNode
	sub: ConsumerNode
	nextDep: Link | undefined
	prevSub: Link | undefined
	nextSub: Link | undefined
	/**
	 * Whether the link is present in dep's subscriber list (true only
	 * while sub is watched).
	 */
	inSubs: boolean
	/**
	 * The evaluation pass that last read this edge. Equality with the
	 * running pass means the evaluation in progress already touched it.
	 */
	evalPass: EvalPass
}

/**
 * State every graph node carries, whether it produces values, consumes
 * dependencies, or does both.
 */
export interface ReactiveNode {
	flags: Flags
	/**
	 * Tracing: the event that caused the latest invalidation to reach
	 * this node.
	 */
	causeEvent: TraceEventId
	label?: string | undefined
}

/** State carried only by value producers: atoms and computeds. */
export interface ProducerNode extends ReactiveNode {
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
	/** Subscriber list: watched consumers and store subscriptions. */
	subs: Link | undefined
	subsTail: Link | undefined
	/**
	 * Number of observers: watched consumer edges, effects, and React
	 * subscriptions.
	 */
	observerCount: number
	/**
	 * Per-world resolution memos, managed by worlds.ts; undefined while
	 * no transition drafts are live.
	 */
	worldMemos: Map<string, unknown> | undefined
}

/**
 * State carried only by nodes that read dependencies: computeds, effects,
 * and render watchers. Atoms produce values but never consume them.
 */
export interface ConsumerNode extends ReactiveNode {
	/**
	 * Dependency list in first-read order. Computeds and effects rebuild a
	 * dynamic list on each evaluation. A render watcher's list is one pinned
	 * link installed at creation and never re-tracked.
	 */
	deps: Link | undefined
	/**
	 * The last poke walk that reached this node. Equality with the
	 * running walk's pass means the walk already visited it.
	 */
	pokePass: PokePass
}

let graphChangeClock: GraphChangeClock = 1
/**
 * The clock reading at the last BASE change — an atom write or a
 * settlement invalidation. Draft activity ticks the clock (world memos
 * and caches key their fast paths on it) without moving this watermark,
 * so "did base state change since X" stays answerable: compare X against
 * this reading, not against the clock.
 */
let baseChangedAtGraphChange: GraphChangeClock = 1
/** Identity of the evaluation pass in progress. */
let evalPass: EvalPass = 1
/**
 * Backing counter for evaluation passes — monotonic, never reused. If a
 * value were recycled, the same-pass check in trackRead could match an
 * edge left over from a dead pass and skip registering a dependency the
 * current evaluation actually read.
 */
let evalPassCounter: EvalPass = 1
function newEvalPass(): EvalPass {
	evalPass = ++evalPassCounter
	return evalPass
}
/**
 * The node whose dependencies are being tracked right now: reads inside
 * an evaluation register edges against this node.
 */
export let activeConsumer: EvaluatedNode<unknown> | null = null
/**
 * The world an evaluation is running in; null means base state. A world
 * boundary also detaches graph collectors owned by its caller.
 */
export let currentWorld: World | null = null
/**
 * The computed body executing right now, tracked separately from
 * activeConsumer: untracked() clears activeConsumer but must not disable
 * per-computed policies (like the no-writes-inside-computeds rule).
 */
export let activeEvaluation: EvaluatedNode<unknown> | null = null
let batchDepth = 0

export function currentGraphChange(): GraphChangeClock {
	return graphChangeClock
}

/**
 * Advance the one change clock. Draft activity (opens, intent appends,
 * retires, discards) and thenable settlement tick through here so every
 * clock-keyed fast path — world memos, the world cache, unwatched
 * validation short-circuits — revalidates; base writes tick inline and
 * additionally move the base watermark.
 */
export function tickGraphChange(): GraphChangeClock {
	return ++graphChangeClock
}

/** The clock reading at the last base change (write or settlement). */
export function currentBaseChange(): GraphChangeClock {
	return baseChangedAtGraphChange
}

// ---------------------------------------------------------------------------
// Tracing seam. tracer.ts installs the hook. A mutable module binding
// rather than an object property, so the common detached case costs one
// null check per emit site and the graph has no runtime dependency on the
// tracer.
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

/** The id recorded when an operation has no known cause. */
export const NO_EVENT: TraceEventId = 0
/**
 * The trace event acting as causal parent for the operation in progress
 * (a write, an effect run, or a settlement).
 */
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
export interface AtomNode<T> extends ProducerNode {
	value: T | typeof UNINITIALIZED
	initializer: (() => T) | undefined
	equals: EqualsFn<T>
	/**
	 * The onObserved option: setup that runs when the atom gains its first
	 * observer, returning an optional cleanup for when the last one leaves.
	 */
	lifetime: ((ctx: { get(): T; set(v: T): void }) => void | (() => void)) | undefined
	lifetimeCleanup: (() => void) | undefined
	lifetimeActive: boolean
}

/** State shared by a public computed and an effect's private computation. */
export interface EvaluatedNode<T> extends ConsumerNode {
	/**
	 * The clock reading at this evaluation's last value change. Effects are
	 * terminal, but retain the slot so both kinds share one evaluator.
	 */
	changedAtGraphChange: GraphChangeClock
	/** Cursor through the dependency list during dynamic evaluation. */
	depsTail: Link | undefined
	/**
	 * The ErrorBox or Suspension selected by the async flags; null for a
	 * plain value. The stable slot avoids changing shape when a computed
	 * moves between value, error, and suspended states.
	 */
	throwable: ErrorBox | Suspension | null
	value: T | typeof UNINITIALIZED
	fn: (use: UseFn, previous: T | undefined) => T
	equals: EqualsFn<T>
	/** The clock reading at this evaluation's last successful validation. */
	validAtGraphChange: GraphChangeClock
}

/** A cached computed-value node — the engine side of a computed. */
export interface ComputedNode<T> extends ProducerNode, EvaluatedNode<T> {}

/**
 * State needed while a scope or effect body owns nested effects. An effect's
 * Watched bit prevents a self-disposed effect from gaining children
 * later in the same body.
 */
interface EffectOwner {
	flags: Flags
	/** Direct child effects, allocated only when the first child is created. */
	children: EffectNode[] | undefined
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

/** A dynamically evaluated effect and its untracked delivery state. */
export interface EffectNode extends EvaluatedNode<unknown>, EffectOwner {
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
	/** Which drain site runs the handler. */
	lane: Lane
	cleanup: (() => void) | undefined
}

/** A store subscription pinned to one producer for its whole life. */
export interface RenderWatcherNode extends ConsumerNode {
	/**
	 * Render subscribers: delivery callback, run after sync effects
	 * settle. The callback decides whether the delivery becomes a
	 * re-render.
	 */
	onNotify: (() => void) | undefined
	/**
	 * Draft-wake callback: receives the id and cause of a transition draft
	 * whose new write touches this subscriber's sources. Separate from
	 * onNotify so draft activity never looks like a base-state change to
	 * subscribers that compare snapshots.
	 */
	onDraftWake: ((id: DraftId, cause: TraceEventId) => void) | undefined
}

export type WatcherNode = EffectNode | RenderWatcherNode

/**
 * The `use` function handed to computed bodies: read a promise-like,
 * returning its value once settled or parking the evaluation until it
 * settles (see asyncs.ts).
 */
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
export function addObserver(node: ProducerNode): void {
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
export function removeObserver(node: ProducerNode): void {
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
// subscribe/unsubscribe flaps within one task (React StrictMode
// double-mounts, list reorders) net out instead of tearing the resource
// down and back up.
// ---------------------------------------------------------------------------

/**
 * Host schedulers; declared here so the engine typechecks without a DOM
 * or Node lib.
 */
declare const queueMicrotask: (fn: () => void) => void
declare const setTimeout: (fn: () => void, ms?: number) => unknown

const pendingLifetimeAtoms = new Set<AtomNode<unknown>>()
let lifetimeFlushScheduled = false

/**
 * Called whenever an atom's observer count crosses zero in either
 * direction. Settlement keeps its own microtask rather than riding the
 * useLayoutEffect pump: an onObserved activation feeds data (sockets,
 * ctx.set), and delaying it to a frame boundary would show subscribers the
 * pre-activation value for a visible beat.
 */
function noteLifetimeTransition(node: ProducerNode): void {
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
			let cleanup: void | (() => void)
			try {
				cleanup = atom.lifetime!(ctx)
			} catch (error) {
				if (emitEvent !== null) {
					emitEvent('callback-error', atom, atom.causeEvent, {
						error,
						phase: 'on-observed',
					})
				}
				throw error
			}
			atom.lifetimeCleanup = typeof cleanup === 'function' ? cleanup : undefined
		} else {
			const cleanup = atom.lifetimeCleanup
			atom.lifetimeCleanup = undefined
			if (cleanup !== undefined) {
				try {
					untracked(cleanup)
				} catch (error) {
					if (emitEvent !== null) {
						emitEvent('cleanup-error', atom, atom.causeEvent, {
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
 * Record "sub read dep" for the evaluation in progress. The subscriber's
 * dependency list is reused in place: depsTail is a cursor that advances
 * as the evaluation re-reads dependencies in the same order as last time,
 * so a stable evaluation allocates nothing.
 */
function trackRead(dep: ProducerNode, sub: EvaluatedNode<unknown>): Link {
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
function trimDeps(sub: EvaluatedNode<unknown>): void {
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
	if ((sub.flags & (Flag.Watching | Flag.Watched)) === Flag.Watching) {
		unlinkEffectDeps(sub as EffectNode)
	}
}

// ---------------------------------------------------------------------------
// Invalidation (push through watched edges)
// ---------------------------------------------------------------------------

/**
 * One effect lane: watchers queued toward one drain site. Array capacity
 * is retained across drains: it is cleared by resetting count, never by
 * `.length = 0`, because V8 trims the backing store on a length reset and
 * the queue would then re-grow from zero capacity on every wave. The cost
 * of retaining capacity is that consumed slots must be nulled so they do
 * not pin disposed watchers.
 */
interface LaneState {
	queue: Array<EffectNode | undefined>
	/**
	 * Round cursor; entries below it are consumed. An index rather than
	 * Array#shift so wide drains stay linear.
	 */
	head: number
	count: number
	/** The lane's pump is requested and has not run yet. */
	pumpRequested: boolean
}

const lanes: readonly [LaneState, LaneState, LaneState] = [
	{ queue: [], head: 0, count: 0, pumpRequested: false },
	{ queue: [], head: 0, count: 0, pumpRequested: false },
	{ queue: [], head: 0, count: 0, pumpRequested: false },
]

/**
 * @internal A host-installed pump for the deferred lanes. Returning true
 * means the host owns this request and will eventually reach the drain
 * entry points (the React bindings re-render a per-root sentinel whose
 * commit-phase effects drain); false falls back to the built-in pumps.
 */
export type LanePump = (lane: Lane.UseLayoutEffect | Lane.UseEffect) => boolean
let lanePump: LanePump | null = null

/** @internal Install or clear the host lane pump. */
export function setLanePump(pump: LanePump | null): void {
	lanePump = pump
}

/**
 * @internal Drain the useLayoutEffect lane now. Hosted drains call this from
 * the commit's layout phase, after the pass's DOM mutations.
 */
export function drainUseLayoutEffectLane(): void {
	lanes[Lane.UseLayoutEffect].pumpRequested = false
	drainLane(lanes[Lane.UseLayoutEffect])
}

/**
 * @internal Drain both deferred lanes now. Lane order is total regardless
 * of pump timing: the useLayoutEffect lane settles first, so its entries can
 * never run after same-wave useEffect entries even when this site's pump
 * (a task) fires before a pending useLayoutEffect drain. Hosted drains call
 * this from the commit's passive phase.
 */
export function drainDeferredEffects(): void {
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
 * @internal Re-arm the built-in pumps for any deferred entries still
 * queued. Called when a host pump accepted requests whose drains will now
 * never arrive (the last hosting root unmounted, or the host uninstalled).
 */
export function repumpDeferredLanes(): void {
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
export function flushScheduledEffects(): void {
	flushLifetimeTransitions()
	const layoutLane = lanes[Lane.UseLayoutEffect]
	if (layoutLane.head !== 0) {
		return
	}
	drainLane(layoutLane)
	drainLane(lanes[Lane.UseEffect])
}

/**
 * @internal Drop queued lane entries without running them (test reset).
 * An active drain keeps its cursor, and later writes append after it as a
 * new round. Already-requested pumps fire on empty queues, which is harmless.
 */
export function resetEffectLanes(): void {
	for (const state of lanes) {
		for (let i = 0; i < state.count; i++) {
			state.queue[i] = undefined
		}
		state.count = state.head
		state.pumpRequested = false
	}
}

/**
 * Render-notify subscribers scheduled by the current wave; they are
 * notified after sync effects settle. Double-buffered: a draining wave
 * iterates its own buffer while entries scheduled during delivery land in
 * the spare, so an iteration never sees entries added mid-delivery. Same
 * retained-capacity treatment as the effect lanes.
 */
let renderNotifyQueue: Array<RenderWatcherNode | undefined> = []
let renderNotifyCount = 0
/**
 * Spare render-notify buffer; null while a draining flush has it
 * checked out. Delivery can nest (an onNotify callback may write, and that
 * write's flush drains the buffer the outer flush is filling), and a
 * doubly-nested flush must not reuse a buffer that is mid-iteration — it
 * allocates a fresh one instead.
 */
let spareRenderNotify: Array<RenderWatcherNode | undefined> | null = []

/** Route a watcher into its queue by capability bit and lane. */
function scheduleWatcher(w: WatcherNode): void {
	const flags = w.flags
	// One masked test covering both "already queued" and "disposed"
	// (Watched means alive on watchers).
	if ((flags & (Flag.Scheduled | Flag.Watched)) !== Flag.Watched) {
		return
	}
	if ((flags & Flag.WatchRender) !== 0) {
		renderNotifyQueue[renderNotifyCount++] = w as RenderWatcherNode
	} else if ((flags & Flag.WatchRunEffect) !== 0) {
		const effect = w as EffectNode
		const state = lanes[effect.lane]
		state.queue[state.count++] = effect
		if (effect.lane !== Lane.Sync) {
			requestLaneDrain(effect.lane)
		}
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
// Atom writes and invalidateComputed are the wave's entry points: they
// record the root node's change, then run the wave.
// ---------------------------------------------------------------------------

/**
 * A suspended traversal position. The walks are iterative with an
 * explicit stack on the heap, so their depth is bounded by memory rather
 * than by JS call-stack frames.
 */
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
				const subSubs = (sub as ComputedNode<unknown>).subs
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

/**
 * Identity of the poke walk in progress. Monotonic and never reused, so
 * per-node pokePass stamps need no clearing between walks.
 */
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
 * WatchRender bit (ordinary engine effects) are untouched.
 *
 * Render-notify watchers get StaleCheck for consistency with the wave;
 * their bits are write-only until delivery.
 *
 * `wake`, when present, additionally delivers that draft id to the same
 * watchers in this one walk. Writes into a draft need both notification
 * and delivery; commit and discard call sites poke without waking.
 * `valueChanged`, when present, is a per-producer cutoff: subscribers of a
 * producer whose draft value did not change are skipped, except for
 * value-independent probes. The walk runs in the writer's ambient context, so inside a React
 * transition the wake dispatches join that transition's updates. Wake
 * delivery happens after the notify flush because the flush's effects may
 * dispose subscriptions, and a disposed subscriber must not receive the
 * draft id.
 */
export function pokeDraftWatchers(
	node: ProducerNode,
	cause: TraceEventId,
	wake?: DraftId,
	valueChanged?: (node: ProducerNode) => boolean,
): void {
	const pass = ++pokePass
	let wakes: RenderWatcherNode[] | null = null
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
				if ((flags & Flag.WatchRender) !== 0) {
					const w = sub as RenderWatcherNode
					// Probes without a draft-wake callback must hear every poke,
					// because pendingness can change while values stay equal.
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
				} else if ((flags & Flag.KindComputed) !== 0) {
					const subSubs = (sub as ComputedNode<unknown>).subs
					if (subSubs !== undefined) {
						const subChanged = valueChanged?.(sub as ComputedNode<unknown>) ?? true
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
				w.onDraftWake!(wake!, cause)
			}
		}
	}
}

/**
 * Invalidate a computed from outside the dependency graph — used when a
 * thenable it parked on settles. Treated exactly like a write: the clock
 * ticks and the node's changedAt reading advances so downstream validation
 * re-pulls, subscribers get marked, effects run.
 */
export function invalidateComputed(node: EvaluatedNode<unknown>, cause: TraceEventId): void {
	graphChangeClock++
	baseChangedAtGraphChange = graphChangeClock
	node.flags = (node.flags & ~Flag.StaleMask) | Flag.StaleDirty
	node.causeEvent = cause
	// Tick first, then stamp with the new reading (see writeAtom).
	node.changedAtGraphChange = graphChangeClock
	if ((node.flags & Flag.Watching) !== 0) {
		scheduleWatcher(node as EffectNode)
	} else {
		propagateWave((node as ComputedNode<unknown>).subs, cause)
	}
	if (batchDepth === 0) {
		flush()
	}
}

/**
 * Begin a manual batch. Pair every call with {@link endBatch}; prefer
 * {@link batch} when the work fits in one callback.
 */
export function startBatch(): void {
	batchDepth++
}

/** End a manual batch and flush when the outermost batch closes. */
export function endBatch(): void {
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
 * Writes still update their atoms in order, but dependent computeds, effects,
 * and subscribers settle only after the outermost batch closes.
 */
export function batch<T>(fn: () => T): T {
	startBatch()
	try {
		return fn()
	} finally {
		endBatch()
	}
}

/** Hard iteration ceiling: converts a livelock into a thrown error. */
const enum Limit {
	/** Queued-effect pulls per drain before declaring a non-settling cycle. */
	DrainRuns = 100_000,
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
 * return; entries appended by that frame's callbacks remain after its cursor
 * and become its next round.
 */
function drainLane(state: LaneState): void {
	if (state.head !== 0) {
		return
	}
	let guard = 0
	try {
		while (state.head < state.count) {
			const start = state.head
			const end = state.count
			state.head = end
			// Phase 1: pull.
			for (let i = start; i < end; i++) {
				if (++guard > Limit.DrainRuns) {
					const error = new Error('effect drain did not settle (cycle?)')
					if (emitEvent !== null) {
						emitEvent('flush-error', null, currentCause, { error, phase: 'cycle' })
					}
					throw error
				}
				const w = state.queue[i]!
				const flags = w.flags
				// Consume the queue membership so later writes can re-enqueue. The
				// evaluated effect retains its staleness mark for ensureFresh.
				w.flags = flags & ~Flag.Scheduled
				if ((flags & Flag.Watched) === 0) {
					state.queue[i] = undefined
					continue
				}
				ensureFresh(w)
				const cflags = w.flags
				if ((cflags & Flag.AsyncError) !== 0) {
					state.queue[i] = undefined
					throw (w.throwable as ErrorBox).error
				}
				if ((cflags & Flag.AsyncSuspended) !== 0) {
					// Parked: silent. Settlement invalidates and re-enqueues the effect.
					state.queue[i] = undefined
					continue
				}
				if (w.lastHandled !== UNINITIALIZED && w.equals(w.value, w.lastHandled)) {
					state.queue[i] = undefined
					continue
				}
			}
			// Phase 2a: cleanups.
			for (let i = start; i < end; i++) {
				const w = state.queue[i]
				if (w === undefined) {
					continue
				}
				if ((w.flags & (Flag.Scheduled | Flag.Watched)) !== Flag.Watched) {
					// Re-marked since its pull (Scheduled) or disposed by a sibling
					// cleanup: skip before the cleanup runs.
					state.queue[i] = undefined
					continue
				}
				runEffectCleanup(w)
			}
			// Phase 2b: handlers, reading the settled value at run time.
			for (let i = start; i < end; i++) {
				const w = state.queue[i]
				state.queue[i] = undefined
				if (w === undefined || (w.flags & Flag.Watched) === 0) {
					continue
				}
				runHandler(w)
			}
		}
		state.head = 0
		state.count = 0
	} catch (e) {
		// Clear the entries the throw preempted (see the function comment);
		// unconsumed slots are nulled like consumed ones.
		for (let i = 0; i < state.count; i++) {
			const w = state.queue[i]
			state.queue[i] = undefined
			if (w !== undefined) {
				w.flags &= ~(Flag.Scheduled | Flag.StaleMask)
			}
		}
		state.head = 0
		state.count = 0
		throw e
	}
}

/**
 * Drain sync effects until they settle, then deliver render
 * notifications.
 */
export function flush(): void {
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
				const w = delivering[i]!
				// Render-notify watchers are never validated, so Scheduled and
				// the staleness bits can clear together in one store.
				w.flags &= ~(Flag.Scheduled | Flag.StaleMask)
			}
			try {
				for (let i = 0; i < n; i++) {
					const w = delivering[i]!
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
/**
 * Policy switch only. The machinery for computeds that write state (see
 * recompute's self-affecting handling) works either way; flipping this to
 * false allows such writes without any other change.
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
		if (emitEvent !== null) {
			emitEvent('callback-error', atom, currentCause, { error, phase: 'initializer' })
		}
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

export function writeAtom<T>(atom: AtomNode<T>, next: T, intent: 'set' | 'update' = 'set'): boolean {
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
	baseChangedAtGraphChange = graphChangeClock
	atom.changedAtGraphChange = graphChangeClock
	const cause = emitEvent !== null ? emitEvent(intent, atom, currentCause) : NO_EVENT
	propagateWave(atom.subs, cause)
	if (batchDepth === 0) {
		flush()
	}
	return true
}

/** Thrown by an evaluation when it parks on an unresolved thenable. */
export const PARKED = Symbol('parked')

/**
 * The use() argument passed to every base-state recompute. One shared
 * function with no per-node closure: at call time the evaluating computed
 * is activeConsumer, so the function can find its owner. (Draft
 * evaluations pass their own use function instead; see worlds.ts.) A
 * use() that escapes its evaluation — captured and called later, or called
 * inside untracked() — finds no evaluating computed and throws rather than
 * park the wrong node.
 */
const evalUse: UseFn = <U>(t: PromiseLike<U>): U => {
	const consumer = activeConsumer
	if (consumer === null) {
		throw new Error('use() called outside a computed evaluation')
	}
	return baseUse(t, consumer) as U
}

function recompute(node: EvaluatedNode<unknown>): void {
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
	// A computed's first run is a lazy eval on read, so nothing has propagated a
	// cause to it yet (causeEvent is NO_EVENT) and the compute would orphan. Fall
	// back to the active operation's cause (currentCause) — the write or fold in
	// flight — so a first "new result" chains back to what triggered it. Outside
	// an operation currentCause is NO_EVENT, so this never mis-attributes.
	const computeCause = node.causeEvent !== NO_EVENT ? node.causeEvent : currentCause
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
		// A nested evaluation advanced the pass id; restore ours so dep
		// trimming sees the right pass.
		evalPass = myPass
		activeConsumer = prevConsumer
		activeEvaluation = prevEvaluation
		trimDeps(node)
		node.flags &= ~Flag.Computing
	}
	// The plain-value tail of finishCompute, inlined: a settled evaluation
	// of a node with no async history is the overwhelming steady state, and
	// it needs none of the park/error/span folding.
	let changed: boolean
	if (!parked && !hasError && (node.flags & Flag.AsyncMask) === 0) {
		const prev = node.value
		changed = prev === UNINITIALIZED || !node.equals(prev, value)
		if (changed) {
			node.value = value
		}
	} else {
		changed = finishCompute(node, parked, hasError, error, value)
	}
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
	if (compute !== NO_EVENT && endSpan !== null) {
		endSpan(compute, { changed })
	}
}

const chainNodes: Array<ComputedNode<unknown> | undefined> = []
let chainDepth = 0

function chainResolve(start: ComputedNode<unknown>, first: Link): void {
	const base = chainDepth
	let depth = base
	let node = start
	let link = first
	let dep: ProducerNode
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

/**
 * Bring a computed up to date. Which conservative invalidations require
 * a recomputation is an implementation detail; resolved values and effect
 * observations are the semantic contract. Refreshing is detached from both
 * ambient collectors: dependencies belong to the computed being refreshed,
 * and draft-world sources belong only to an explicit outer read.
 */
export function ensureFresh(node: EvaluatedNode<unknown>): void {
	const prevConsumer = activeConsumer
	activeConsumer = null
	try {
		ensureFreshAt(node, 0)
	} finally {
		activeConsumer = prevConsumer
	}
}

function ensureFreshAt(node: EvaluatedNode<unknown>, depth: number): void {
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
				chainResolve(node as ComputedNode<unknown>, first)
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

/** Run `fn` without adding its signal reads to the active dependency list. */
export function untracked<T>(fn: () => T): T {
	const prev = activeConsumer
	activeConsumer = null
	try {
		return fn()
	} finally {
		activeConsumer = prev
	}
}

export function withWorld<T>(world: World | null, fn: () => T): T {
	const prevWorld = currentWorld
	const prevConsumer = activeConsumer
	currentWorld = world
	activeConsumer = null
	try {
		return fn()
	} finally {
		currentWorld = prevWorld
		activeConsumer = prevConsumer
	}
}

export function setActiveEvaluation(
	node: EvaluatedNode<unknown> | null,
): EvaluatedNode<unknown> | null {
	const prev = activeEvaluation
	activeEvaluation = node
	return prev
}

export function isUninitialized(v: unknown): boolean {
	return v === UNINITIALIZED
}

export { UNINITIALIZED }

// ---------------------------------------------------------------------------
// Effects and store subscriptions
// ---------------------------------------------------------------------------

let activeEffectOwner: EffectOwner | null = null

/**
 * Dispose every child even when one cleanup throws, then surface the first
 * error after the whole owned set is released.
 */
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
 * A throwing cleanup poisons the effect — it is disposed fully so it never
 * half-runs again — and the error surfaces to the drain.
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
				emitEvent('cleanup-error', w, w.causeEvent, { error: e })
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
	const cause = open !== null ? open('effect', w, w.causeEvent) : NO_EVENT
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

function disposeEffect(w: EffectNode): void {
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
				if (emitEvent !== null) {
					emitEvent('cleanup-error', w, w.causeEvent, { error })
				}
				if (!failed) {
					failed = true
					failure = error
				}
			}
		}
	} finally {
		unlinkEffectDeps(w)
	}
	if (failed) {
		throw failure
	}
}

/** Release both dynamic dependency cursors after an effect's lifetime ends. */
function unlinkEffectDeps(w: EffectNode): void {
	unlinkAllDeps(w)
	w.depsTail = undefined
}

export function disposeWatcher(w: RenderWatcherNode): void {
	if ((w.flags & Flag.Watched) === 0) {
		return
	}
	w.flags &= ~Flag.Watched
	unlinkAllDeps(w)
}

function unlinkAllDeps(w: ConsumerNode): void {
	let l = w.deps
	w.deps = undefined
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
 * Create an effect whose one node owns dynamic evaluation and delivery.
 * The first run is synchronous when the computation settles; a parked first
 * evaluation stays silent, and its settlement delivers through the lane. A
 * creation-time compute error disposes the effect and rethrows.
 */
export function makeEffect(
	fn: (use: UseFn, previous: unknown) => unknown,
	handler: (value: unknown, previous: unknown) => void | (() => void),
	lane: Lane,
	equals: EqualsFn<unknown> = Object.is,
	label?: string,
): () => void {
	const w: EffectNode = {
		flags: Flag.Watching | Flag.WatchRunEffect | Flag.Watched | Flag.StaleDirty,
		changedAtGraphChange: 0,
		throwable: null,
		deps: undefined,
		depsTail: undefined,
		causeEvent: NO_EVENT,
		label,
		value: UNINITIALIZED,
		fn,
		equals,
		validAtGraphChange: 0,
		pokePass: 0,
		children: undefined,
		handler,
		lastHandled: UNINITIALIZED,
		lane,
		cleanup: undefined,
	}
	const owner = activeEffectOwner
	if (owner !== null && (owner.flags & Flag.Watched) !== 0) {
		;(owner.children ??= []).push(w)
	}
	try {
		ensureFresh(w)
		if ((w.flags & Flag.AsyncError) !== 0) {
			throw (w.throwable as ErrorBox).error
		}
		if ((w.flags & Flag.AsyncSuspended) === 0) {
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
		if (emitEvent !== null) {
			emitEvent('callback-error', null, currentCause, { error, phase: 'scope' })
		}
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
 * render-notified and draft-aware even when no draft-wake callback is
 * given, because draft pokes must reach probes (such as isPending) that
 * install none.
 */
export function observeNode(
	node: ProducerNode,
	notify: () => void,
	draftWake?: (id: DraftId, cause: TraceEventId) => void,
	label?: string,
): () => void {
	const sub: RenderWatcherNode = {
		flags: Flag.Watching | Flag.WatchRender | Flag.Watched,
		deps: undefined,
		causeEvent: NO_EVENT,
		onNotify: notify,
		onDraftWake: draftWake,
		pokePass: 0,
	}
	// Attach a label only when supplied, so an unlabeled watcher keeps its exact
	// object shape (hidden class) — no cost for the non-devtools path.
	if (label !== undefined) sub.label = label
	try {
		if ((node.flags & Flag.KindAtom) !== 0) {
			peekAtom(node as AtomNode<unknown>)
		}
		const link: Link = {
			dep: node,
			sub,
			nextDep: undefined,
			prevSub: undefined,
			nextSub: undefined,
			inSubs: false,
			evalPass: 0,
		}
		sub.deps = link
		linkIntoSubs(link)
		addObserver(node)
		if (
			(node.flags & Flag.KindComputed) !== 0 &&
			(node.flags & Flag.StaleMask) !== 0 &&
			(node as ComputedNode<unknown>).value !== UNINITIALIZED
		) {
			// The pinned edge does not pull the node. If it was already stale,
			// deliver the invalidation that happened before this edge existed.
			sub.flags |= Flag.StaleCheck
			sub.causeEvent = node.causeEvent
			scheduleWatcher(sub)
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
