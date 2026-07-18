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
  type EvaluatedNode,
  type Flags,
  type TraceEventId,
  Flag,
  PARKED,
  ensureFresh,
  invalidateComputed,
  isUninitialized,
  NO_EVENT,
  currentCause,
  setCurrentCause,
  startBatch,
  endBatch,
  tickGraphChange,
  activeTracer,
} from "./graph.ts"

/** Settlement state recorded for a tracked thenable. */
export type ThenableStatus = "pending" | "fulfilled" | "rejected"

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
  parkedNodes: Set<EvaluatedNode<unknown>> | null
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
 * Every resolved value is read through this one shape. Graph nodes (atoms
 * and computeds) satisfy the interface directly, so resolving base state
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
 * - throwable: present only for async states. It is the ErrorBox whose
 *   .error every read rethrows (AsyncError), or the Suspension whose
 *   .promise suspends a reader (AsyncSuspended). Computed nodes keep the
 *   slot as null for a plain base value because they can become async.
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
      if (activeTracer !== null) {
        // The suspension promise is now fulfilled. React may retry because
        // of that fact, but the engine does not observe when it schedules or
        // which later render is that retry.
        activeTracer.emitEvent("retry", null, cause, { suspension: ep })
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
    status: "pending",
    result: undefined,
    parkedNodes: new Set(),
    parkedSuspensions: new Set(),
  }
  boxes.set(t, fresh)
  t.then(
    (v) => settle(fresh, "fulfilled", v),
    (r) => settle(fresh, "rejected", r),
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
function settle(box: ThenableBox, status: "fulfilled" | "rejected", result: unknown): void {
  if (box.status !== "pending") {
    return
  }
  box.status = status
  box.result = result
  const cause =
    activeTracer !== null
      ? activeTracer.emitEvent("settle", null, NO_EVENT, {
          status: box.status,
          error: box.status === "rejected" ? box.result : undefined,
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
      invalidateComputed(node, cause)
      try {
        ensureFresh(node)
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

/** Handles use(t) inside a base-state evaluation. */
export function baseUse(t: PromiseLike<unknown>, consumer: EvaluatedNode<unknown>): unknown {
  const box = trackThenable(t)
  if (box.status === "fulfilled") {
    return box.result
  }
  if (box.status === "rejected") {
    throw box.result
  }
  box.parkedNodes!.add(consumer)
  const flags = consumer.flags
  // Reuse the pending span's suspension so Suspense retries see one
  // stable thenable — but never a settled one, or a suspended render
  // would retry in a loop.
  const suspension =
    (flags & Flag.AsyncSuspended) !== 0 && (consumer.throwable as Suspension).resolve !== null
      ? (consumer.throwable as Suspension)
      : makeSuspension()
  box.parkedSuspensions!.add(suspension)
  if (activeTracer !== null) {
    activeTracer.emitEvent("compute-suspend", consumer, currentCause, { suspension })
  }
  consumer.throwable = suspension
  consumer.flags = (flags & ~Flag.AsyncMask) | Flag.AsyncSuspended
  throw PARKED
}

/** Fold a recompute's value, park, or throw into the node's async state. */
export function finishCompute(
  node: EvaluatedNode<unknown>,
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
      ;(node.throwable as Suspension).resolve?.(currentCause)
    }
    const sameError =
      (flags & Flag.AsyncError) !== 0 && (node.throwable as ErrorBox).error === error
    if (!sameError) {
      node.throwable = new ErrorBox(error)
    }
    node.flags = (flags & ~Flag.AsyncMask) | Flag.AsyncError
    return !sameError
  }
  if ((flags & Flag.AsyncSuspended) !== 0) {
    ;(node.throwable as Suspension).resolve?.(currentCause)
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
