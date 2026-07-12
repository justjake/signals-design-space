/**
 * Async support for computeds. A computed body can call use(promise) to
 * read an async value. Rather than modeling this as control flow, the
 * engine records "pending" and "error" as node state, alongside the value.
 *
 * When a computed touches an unresolved thenable, its evaluation parks:
 * the body's throw is caught, the node is marked suspended, and it keeps
 * serving its last settled value (its "stale" value) to readers outside
 * any evaluation. Reading a pending computed from inside another
 * evaluation parks the reader as well, so pendingness forwards up chains.
 * When the thenable settles, settlement behaves like a write: the parked
 * computeds are invalidated and re-evaluated, and the change propagates so
 * downstream computeds and subscribers converge.
 *
 * Two identity guarantees matter to React:
 * - One suspension promise per pending span per computed. A Suspense retry
 *   that re-reads the computed must get the same thenable it suspended on,
 *   or React would loop and fetches would be re-issued.
 * - An erroring computed rethrows the same reason object on every read,
 *   held in a box the engine keeps until the value actually changes, so
 *   error boundaries and memo comparisons see a stable reference.
 */

import {
	type DerivedNode,
	type Flags,
	Flag,
	PARKED,
	ensureFresh,
	invalidateDerived,
	isUninitialized,
	NO_EVENT,
	setCurrentCause,
	setFinishComputeImpl,
	setUseImpl,
	startBatch,
	endBatch,
	traceHook,
	untracked,
} from './graph.ts'

export type ThenableStatus = 'pending' | 'fulfilled' | 'rejected'

export interface ThenableBox {
	status: ThenableStatus
	value: unknown
	reason: unknown
	/** Computeds whose latest base-state evaluation parked on this thenable. */
	parkedNodes: Set<DerivedNode<unknown>>
	/** Suspensions (base-state or per-world) waiting on this thenable. */
	parkedSuspensions: Set<Suspension>
}

/** One pending span: a stable promise that resolves when the span makes
 * progress, so a suspended React render retries exactly then and not
 * before. */
export interface Suspension {
	promise: Promise<void>
	resolve: () => void
	settled: boolean
}

export interface ErrorBox {
	error: unknown
}

/** Every ErrorBox ever made, so code that receives a box through a value
 * channel (committedSnapshot hands boxes to callers) can tell it apart
 * from a user value without adding a marker property to the box. */
const errorBoxes = new WeakSet<object>()

export function makeErrorBox(error: unknown): ErrorBox {
	const box: ErrorBox = { error }
	errorBoxes.add(box)
	return box
}

export function isErrorBox(v: unknown): v is ErrorBox {
	return typeof v === 'object' && v !== null && errorBoxes.has(v)
}

/**
 * The uniform shape a resolved value is read through. Graph nodes (cells
 * and deriveds) satisfy this interface directly, so resolving base state
 * allocates nothing; per-world memo records (worlds.ts) are separate
 * objects of the same shape.
 *
 * - flags: consumers read only the async bits (`flags & Flag.AsyncMask`);
 *   node-backed views carry kind and staleness bits in the same word.
 *   Both async bits clear means a plain value.
 * - value: the settled value, or the UNINITIALIZED sentinel when none
 *   exists yet. A suspended state whose value is not the sentinel is
 *   "stale": the previous value keeps serving while the refetch runs.
 *   Unwrap sites normalize the sentinel to undefined.
 * - throwable: the ErrorBox whose .error every read rethrows (AsyncError),
 *   or the Suspension whose .promise suspends a reader (AsyncSuspended);
 *   null for a plain value.
 */
export interface DerivedState {
	flags: Flags
	value: unknown
	throwable: ErrorBox | Suspension | null
}

const boxes = new WeakMap<PromiseLike<unknown>, ThenableBox>()

/** Installed by worlds.ts so settlement also invalidates its world memos. */
let onSettlement: (() => void) | null = null
export function setOnSettlement(fn: () => void): void {
	onSettlement = fn
}

export function makeSuspension(): Suspension {
	let resolveRaw!: () => void
	const promise = new Promise<void>((r) => (resolveRaw = r))
	const ep: Suspension = {
		promise,
		settled: false,
		resolve: () => {
			if (ep.settled) {
				return
			}
			ep.settled = true
			resolveRaw()
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
		value: undefined,
		reason: undefined,
		parkedNodes: new Set(),
		parkedSuspensions: new Set(),
	}
	boxes.set(t, fresh)
	t.then(
		(v) => {
			fresh.status = 'fulfilled'
			fresh.value = v
			settle(fresh)
		},
		(r) => {
			fresh.status = 'rejected'
			fresh.reason = r
			settle(fresh)
		},
	)
	return fresh
}

/** A thenable settled. Treat it like a write: invalidate the parked
 * computeds and eagerly re-evaluate them — eagerly, so a computed that
 * awaits several thenables in sequence parks on the next one without
 * waiting for a reader, and so passive probes observe the final state when
 * the wave's notifications run. Then release the suspensions, so suspended
 * renders retry against the already-settled graph. */
function settle(box: ThenableBox): void {
	const cause = traceHook !== null ? traceHook('settle', null, NO_EVENT) : NO_EVENT
	onSettlement?.()
	const nodes = [...box.parkedNodes]
	box.parkedNodes.clear()
	const suspensions = [...box.parkedSuspensions]
	box.parkedSuspensions.clear()
	const prevCause = setCurrentCause(cause)
	startBatch()
	try {
		for (const node of nodes) {
			invalidateDerived(node, cause)
			try {
				untracked(() => ensureFresh(node))
			} catch {
				// The evaluation outcome (pending or error) is recorded on the
				// node; readers encounter it at their own read sites.
			}
		}
	} finally {
		endBatch()
		setCurrentCause(prevCause)
		for (const ep of suspensions) {
			ep.resolve()
		}
	}
}

/** Handles use(t) inside a base-state evaluation. */
function baseUse(t: PromiseLike<unknown>, consumer: DerivedNode<unknown>): unknown {
	const box = trackThenable(t)
	if (box.status === 'fulfilled') {
		return box.value
	}
	if (box.status === 'rejected') {
		throw box.reason
	}
	box.parkedNodes.add(consumer)
	const flags = consumer.flags
	// Reuse the pending span's suspension so Suspense retries see one
	// stable thenable — but never a settled one, or a suspended render
	// would retry in a loop.
	const suspension =
		(flags & Flag.AsyncSuspended) !== 0 && !(consumer.throwable as Suspension).settled
			? (consumer.throwable as Suspension)
			: makeSuspension()
	box.parkedSuspensions.add(suspension)
	consumer.throwable = suspension
	consumer.flags = (flags & ~Flag.AsyncMask) | Flag.AsyncSuspended
	throw PARKED
}

function finishCompute(
	node: DerivedNode<unknown>,
	parked: boolean,
	hasError: boolean,
	error: unknown,
	value: unknown,
): boolean {
	const flags = node.flags
	if (parked) {
		// baseUse already installed the suspended state. Report a change so
		// downstream readers re-pull and park on the (possibly fresh)
		// suspension.
		return true
	}
	if (hasError) {
		if ((flags & Flag.AsyncSuspended) !== 0) {
			;(node.throwable as Suspension).resolve()
		}
		const sameError =
			(flags & Flag.AsyncError) !== 0 && (node.throwable as ErrorBox).error === error
		if (!sameError) {
			node.throwable = makeErrorBox(error)
		}
		node.flags = (flags & ~Flag.AsyncMask) | Flag.AsyncError
		return !sameError
	}
	if ((flags & Flag.AsyncSuspended) !== 0) {
		;(node.throwable as Suspension).resolve()
	}
	node.flags = flags & ~Flag.AsyncMask
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

setUseImpl(baseUse)
setFinishComputeImpl(finishCompute)
