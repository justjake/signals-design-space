/**
 * Async values: pending and error are graph STATE, not control flow.
 *
 * A computed that touches an unresolved thenable evaluates-to-pending: the
 * evaluation parks, the computed keeps serving its last settled value
 * ("stale"), and a stable suspension promise represents the pending span.
 * Settlement behaves like a write: it invalidates the parked computeds and
 * propagates, so downstream computeds and subscribers converge. Reading a
 * pending computed from inside another evaluation parks the reader too
 * (pending forwards); reading it from outside serves the stale value when
 * one exists.
 *
 * Stability contracts:
 * - One suspension promise per pending span per computed: a Suspense retry that
 *   re-reads the computed gets the SAME thenable, so React neither loops nor
 *   re-issues fetches.
 * - Errors rethrow the SAME reason object every time (reference stable),
 *   held in a box the engine keeps until the value actually changes.
 */

import {
	type DerivedNode,
	type Flags,
	type TraceEventId,
	Flag,
	NodeSlot,
	PARKED,
	ensureFresh,
	invalidateDerived,
	isUninitialized,
	NO_EVENT,
	currentCause,
	setCurrentCause,
	startBatch,
	endBatch,
	tickGraphChange,
	emitEvent,
	untracked,
	graphMemory,
} from './graph.ts'

export type ThenableStatus = 'pending' | 'fulfilled' | 'rejected'

/**
 * Per-thenable tracking record: its settlement state plus everything
 * currently parked on it.
 */
export interface ThenableBox {
	status: ThenableStatus
	/** Fulfillment value or rejection reason, selected by status. */
	result: unknown
	/**
	 * Computeds whose latest base-state evaluation parked on this thenable,
	 * or null after settlement releases the membership owner.
	 */
	parkedNodes: Set<DerivedNode<unknown>> | null
	/**
	 * Suspensions (base-state or per-world) waiting on this thenable, or
	 * null after settlement releases the membership owner.
	 */
	parkedSuspensions: Set<Suspension> | null
}

/**
 * One pending span: a stable promise that resolves when the span makes
 * progress, so a suspended React render retries exactly then and not
 * before.
 */
export interface Suspension {
	/** Stable promise thrown to Suspense during this pending span. */
	promise: Promise<void>
	/** Resolve the span after its awaited value settles; null after resolution. */
	resolve: ((cause?: TraceEventId) => void) | null
}

/**
 * A thrown error, boxed so an erroring evaluation has one stable result
 * object to compare and rethrow (see the header on stability). The class
 * identity distinguishes engine errors from error-shaped user values.
 */
export class ErrorBox {
	constructor(public error: unknown) {}
}

/**
 * The uniform read protocol for a resolved value — one shape for the graph's
 * own nodes (cells and deriveds ARE this shape; resolving the base world
 * allocates nothing) and per-world memo records:
 *
 * - flags: read via the async bits ONLY (`flags & Flag.AsyncMask`); node-backed
 *   views carry type/staleness/tier bits in the same word. Both async bits
 *   clear = plain value state.
 * - value: the settled value; the UNINITIALIZED sentinel when none exists
 *   yet. A suspended state with a settled value is "stale" — the previous
 *   value keeps serving while the refetch runs (unwrap sites normalize the
 *   sentinel to undefined).
 * - throwable: present only for async states — the ErrorBox whose .error
 *   every read rethrows (AsyncError), or the Suspension whose .promise
 *   suspends a reader (AsyncSuspended). Node-backed views keep the slot as
 *   null for a plain value because they can become async.
 */
export interface ResolvedState {
	flags: Flags
	value: unknown
	throwable?: ErrorBox | Suspension | null
}

/**
 * Read one ResolvedState under a park policy — the shared tail of every
 * unwrap site:
 * - a plain value flows through;
 * - an error rethrows its stable reason;
 * - a pending state parks through `park` when one is supplied (evaluation
 *   contexts forward pendingness; no stale value may leak into their
 *   result), and otherwise serves settled history ("stale"), suspending
 *   on the promise only when none exists yet.
 */
export function unwrapResolved(
	st: ResolvedState,
	park: ((t: PromiseLike<unknown>) => unknown) | null,
): unknown {
	const asyncBits = st.flags & Flag.AsyncMask
	if (asyncBits === 0) {
		return st.value
	}
	if (asyncBits === Flag.AsyncError) {
		throw (st.throwable as ErrorBox).error
	}
	const suspension = st.throwable as Suspension
	if (park !== null) {
		return park(suspension.promise)
	}
	if (!isUninitialized(st.value)) {
		return st.value // stale serves
	}
	throw suspension.promise // never settled: suspend
}

const boxes = new WeakMap<PromiseLike<unknown>, ThenableBox>()

export function makeSuspension(): Suspension {
	let resolveRaw!: () => void
	const promise = new Promise<void>((r) => (resolveRaw = r))
	const ep: Suspension = {
		promise,
		resolve: (cause = NO_EVENT) => {
			if (ep.resolve === null) {
				return
			}
			ep.resolve = null
			resolveRaw()
			if (emitEvent !== null) {
				// The suspension promise is now fulfilled. React may retry because
				// of that fact, but the engine does not observe when it schedules or
				// which later render is that retry.
				emitEvent('retry', null, cause, { suspension: ep })
			}
		},
	}
	return ep
}

export function trackThenable(t: PromiseLike<unknown>): ThenableBox {
	let box = boxes.get(t)
	if (box !== undefined) {
		return box
	}
	const fresh: ThenableBox = {
		status: 'pending',
		result: undefined,
		parkedNodes: new Set(),
		parkedSuspensions: new Set(),
	}
	boxes.set(t, fresh)
	t.then(
		(v) => settle(fresh, 'fulfilled', v),
		(r) => settle(fresh, 'rejected', r),
	)
	return fresh
}

/**
 * A thenable settled. Treat it like a write: invalidate the parked
 * computeds and eagerly re-evaluate them — eagerly, so a computed that
 * awaits several thenables in sequence parks on the next one without
 * waiting for a reader, and so passive probes observe the final state when
 * the wave's notifications run. Then release the suspensions, so suspended
 * renders retry against the already-settled graph.
 */
function settle(box: ThenableBox, status: 'fulfilled' | 'rejected', result: unknown): void {
	if (box.status !== 'pending') {
		return
	}
	box.status = status
	box.result = result
	const cause =
		emitEvent !== null
			? emitEvent('settle', null, NO_EVENT, {
					status: box.status,
					error: box.status === 'rejected' ? box.result : undefined,
				})
			: NO_EVENT
	// Settlement ticks the one change clock even when nothing base-visible
	// parked here: world memos whose suspensions this settlement resolves
	// key their fast path on the clock, and a memo serving a suspended
	// state with a resolved suspension would suspend renders on an
	// already-fulfilled promise.
	tickGraphChange()
	const nodes = box.parkedNodes!
	box.parkedNodes = null
	const suspensions = box.parkedSuspensions!
	box.parkedSuspensions = null
	const prevCause = setCurrentCause(cause)
	startBatch()
	try {
		for (const node of nodes) {
			// A disposed effect's record may already be reclaimed and reused,
			// so its id must not be addressed; the handle-owned mark is the
			// only safe liveness signal here. Skipping is also the right
			// semantics: effects are terminal, so a dead one has no
			// downstream and its compute must not re-run.
			if ((node as { disposed?: boolean }).disposed === true) {
				continue
			}
			invalidateDerived(node, cause)
			try {
				untracked(() => ensureFresh(node))
			} catch {
				// The evaluation outcome (pending or error) is recorded on the
				// node; readers encounter it at their own read sites.
			}
		}
	} finally {
		nodes.clear()
		try {
			endBatch()
		} finally {
			setCurrentCause(prevCause)
			for (const ep of suspensions) {
				ep.resolve?.(cause)
			}
		}
	}
}

/**
 * Whether ANY node ever entered the async value plane (parked or errored).
 * False in a fully-synchronous app, which lets the computed read path skip
 * its per-read async-state probe: AsyncError/AsyncSuspended can only be set
 * by the two sites that flip this. Never reset — a heuristic, not state.
 */
export let asyncPlaneUsed = false

/** Handles use(t) inside a base-state evaluation. */
export function baseUse(t: PromiseLike<unknown>, consumer: DerivedNode<unknown>): unknown {
	const box = trackThenable(t)
	if (box.status === 'fulfilled') {
		return box.result
	}
	if (box.status === 'rejected') {
		throw box.result
	}
	box.parkedNodes!.add(consumer)
	const flags = graphMemory[consumer.id + NodeSlot.Flags]
	// Reuse the pending span's suspension so Suspense retries see one
	// stable thenable — but never a settled one, or a suspended render
	// would retry in a loop.
	const suspension =
		(flags & Flag.AsyncSuspended) !== 0 && (consumer.throwable as Suspension).resolve !== null
			? (consumer.throwable as Suspension)
			: makeSuspension()
	box.parkedSuspensions!.add(suspension)
	if (emitEvent !== null) {
		emitEvent('compute-suspend', consumer, currentCause, { suspension })
	}
	consumer.throwable = suspension
	graphMemory[consumer.id + NodeSlot.Flags] = (flags & ~Flag.AsyncMask) | Flag.AsyncSuspended
	asyncPlaneUsed = true
	throw PARKED
}

/** Fold a recompute's value, park, or throw into the node's async state. */
export function finishCompute(
	node: DerivedNode<unknown>,
	parked: boolean,
	hasError: boolean,
	error: unknown,
	value: unknown,
): boolean {
	const flags = graphMemory[node.id + NodeSlot.Flags]
	if (parked) {
		// baseUse already installed the suspended state. Report a change so
		// downstream readers re-pull and park on the (possibly fresh)
		// suspension.
		return true
	}
	if (hasError) {
		if ((flags & Flag.AsyncSuspended) !== 0) {
			;(node.throwable as Suspension).resolve?.(currentCause)
		}
		const sameError =
			(flags & Flag.AsyncError) !== 0 && (node.throwable as ErrorBox).error === error
		if (!sameError) {
			node.throwable = new ErrorBox(error)
		}
		graphMemory[node.id + NodeSlot.Flags] = (flags & ~Flag.AsyncMask) | Flag.AsyncError
		asyncPlaneUsed = true
		return !sameError
	}
	if ((flags & Flag.AsyncSuspended) !== 0) {
		;(node.throwable as Suspension).resolve?.(currentCause)
	}
	graphMemory[node.id + NodeSlot.Flags] = flags & ~Flag.AsyncMask
	node.throwable = null
	const prev = node.value
	if (isUninitialized(prev) || !node.equals(prev, value)) {
		node.value = value
		return true
	}
	// The value itself is unchanged; downstream still re-pulls when this ends
	// a pending or error span (readers may have parked or thrown).
	return (flags & Flag.AsyncMask) !== 0
}
