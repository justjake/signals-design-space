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
	Flag,
	NodeSlot,
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
	graphMemory,
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
 * progress, so a suspended React render retries exactly then. */
export interface Suspension {
	promise: Promise<void>
	resolve: () => void
	settled: boolean
}

export interface ErrorBox {
	error: unknown
}

/** Box identity is the rethrow-same-reference contract: every read of an
 * erroring computed rethrows the same reason, and identity-comparing
 * consumers (snapshot equality, memo reconciliation) rely on the box staying
 * the same object for the whole error span. Boxes are registered so value
 * channels that hand a box to a caller (committedSnapshot) can be told apart
 * from user values without a marker allocation. */
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
 * The uniform read protocol for a resolved value — one shape for the graph's
 * own nodes (cells and deriveds ARE this shape; resolving the base world
 * allocates nothing) and per-world memo records:
 *
 * - flags: read via the async bits ONLY (`flags & Flag.AsyncMask`); node-backed
 *   views carry type/staleness/tier bits in the same word. Both async bits
 *   clear = plain value state.
 * - value: the settled value; the UNINITIALIZED sentinel when none exists
 *   yet. A suspended state with a settled value is "stale" — the previous
 *   value keeps serving while the refetch runs (stale ⇔ value is not the
 *   sentinel; unwrap sites normalize the sentinel to undefined).
 * - throwable: the value-plane companion — the ErrorBox whose .error every
 *   read rethrows (AsyncError), the Suspension whose .promise suspends a
 *   reader (AsyncSuspended), null in the value state.
 */
export interface DerivedState {
	flags: Flags
	value: unknown
	throwable: ErrorBox | Suspension | null
}

const boxes = new WeakMap<PromiseLike<unknown>, ThenableBox>()

/** Installed by worlds.ts: settlement also invalidates world memos. */
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

/** Settlement is a write: invalidate parked computeds and eagerly bring
 * them up to date (progressive evaluations park on their NEXT thenable
 * without waiting for a reader, and passive probes observe final state when
 * the wave's notifications run), then release the suspensions so suspended
 * renders retry against the settled graph. */
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
				// Evaluation state (pending/error) is recorded on the node; readers
				// see it at their own read sites.
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

/** Whether ANY node ever entered the async value plane (parked or errored).
 * False in a fully-synchronous app, which lets the computed read path skip
 * its per-read async-state probe: AsyncError/AsyncSuspended can only be set
 * by the two sites that flip this. Never reset — a heuristic, not state. */
export let asyncPlaneUsed = false

/** use(t) inside a base-state evaluation. */
function baseUse(t: PromiseLike<unknown>, consumer: DerivedNode<unknown>): unknown {
	const box = trackThenable(t)
	if (box.status === 'fulfilled') {
		return box.value
	}
	if (box.status === 'rejected') {
		throw box.reason
	}
	box.parkedNodes.add(consumer)
	const flags = graphMemory[consumer.id + NodeSlot.Flags]
	// Reuse the span's suspension so Suspense retries see one stable thenable —
	// but never a settled one, or a suspended render would retry in a loop.
	const suspension =
		(flags & Flag.AsyncSuspended) !== 0 && !(consumer.throwable as Suspension).settled
			? (consumer.throwable as Suspension)
			: makeSuspension()
	box.parkedSuspensions.add(suspension)
	consumer.throwable = suspension
	graphMemory[consumer.id + NodeSlot.Flags] = (flags & ~Flag.AsyncMask) | Flag.AsyncSuspended
	asyncPlaneUsed = true
	throw PARKED
}

function finishCompute(
	node: DerivedNode<unknown>,
	parked: boolean,
	hasError: boolean,
	error: unknown,
	value: unknown,
): boolean {
	const flags = graphMemory[node.id + NodeSlot.Flags]
	if (parked) {
		// baseUse installed the suspended state. Advance the version so
		// downstream readers re-pull and park on the (possibly fresh) suspension.
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
		graphMemory[node.id + NodeSlot.Flags] = (flags & ~Flag.AsyncMask) | Flag.AsyncError
		asyncPlaneUsed = true
		return !sameError
	}
	if ((flags & Flag.AsyncSuspended) !== 0) {
		;(node.throwable as Suspension).resolve()
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

setUseImpl(baseUse)
setFinishComputeImpl(finishCompute)
