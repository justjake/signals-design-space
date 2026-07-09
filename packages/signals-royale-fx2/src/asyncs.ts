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
  type CellNode,
  type DerivedNode,
  PARKED,
  adoptDepLink,
  ensureFresh,
  hooks,
  invalidateDerived,
  isUninitialized,
  makeCell,
  NO_EVENT,
  setCurrentCause,
  setFinishComputeImpl,
  setUseImpl,
  startBatch,
  endBatch,
  untracked,
} from './graph.ts';

export type ThenableStatus = 'pending' | 'fulfilled' | 'rejected';

export interface ThenableBox {
  status: ThenableStatus;
  value: unknown;
  reason: unknown;
  /** Canonical computeds whose latest evaluation parked on this thenable. */
  parkedNodes: Set<DerivedNode<unknown>>;
  /** Suspensions (canonical or per-world) waiting on this thenable. */
  parkedSuspensions: Set<Suspension>;
}

/** One pending span: a stable promise that resolves when the span makes
 * progress, so a suspended React render retries exactly then. */
export interface Suspension {
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
}

export interface ErrorBox {
  error: unknown;
}

export type AsyncState =
  | { kind: 'pending'; suspension: Suspension }
  | { kind: 'error'; box: ErrorBox };

const boxes = new WeakMap<PromiseLike<unknown>, ThenableBox>();

/** Installed by worlds.ts: settlement also invalidates world memos. */
let onSettlementEpoch: (() => void) | null = null;
export function setOnSettlementEpoch(fn: () => void): void {
  onSettlementEpoch = fn;
}

export function makeSuspension(): Suspension {
  let resolveRaw!: () => void;
  const promise = new Promise<void>((r) => (resolveRaw = r));
  const ep: Suspension = {
    promise,
    settled: false,
    resolve: () => {
      if (ep.settled) return;
      ep.settled = true;
      resolveRaw();
    },
  };
  return ep;
}

export function trackThenable(t: PromiseLike<unknown>): ThenableBox {
  let box = boxes.get(t);
  if (box !== undefined) return box;
  const fresh: ThenableBox = {
    status: 'pending',
    value: undefined,
    reason: undefined,
    parkedNodes: new Set(),
    parkedSuspensions: new Set(),
  };
  boxes.set(t, fresh);
  t.then(
    (v) => {
      fresh.status = 'fulfilled';
      fresh.value = v;
      settle(fresh);
    },
    (r) => {
      fresh.status = 'rejected';
      fresh.reason = r;
      settle(fresh);
    },
  );
  return fresh;
}

/** Settlement is a write: invalidate parked computeds and eagerly bring
 * them up to date (progressive evaluations park on their NEXT thenable
 * without waiting for a reader, and passive probes observe final state when
 * the wave's notifications run), then release the suspensions so suspended
 * renders retry against the settled graph. */
function settle(box: ThenableBox): void {
  const cause = hooks.trace !== null ? hooks.trace('settle', null, NO_EVENT) : NO_EVENT;
  onSettlementEpoch?.();
  const nodes = [...box.parkedNodes];
  box.parkedNodes.clear();
  const suspensions = [...box.parkedSuspensions];
  box.parkedSuspensions.clear();
  const prevCause = setCurrentCause(cause);
  startBatch();
  try {
    for (const node of nodes) {
      invalidateDerived(node, cause);
      try {
        untracked(() => ensureFresh(node));
      } catch {
        // Evaluation state (pending/error) is recorded on the node; readers
        // see it at their own read sites.
      }
    }
  } finally {
    endBatch();
    setCurrentCause(prevCause);
    for (const ep of suspensions) ep.resolve();
  }
}

export function asyncStateOf(node: DerivedNode<unknown>): AsyncState | null {
  return node.asyncState as AsyncState | null;
}

/** use(t) inside a canonical evaluation. */
function canonicalUse(t: PromiseLike<unknown>, consumer: DerivedNode<unknown>): unknown {
  const box = trackThenable(t);
  if (box.status === 'fulfilled') return box.value;
  if (box.status === 'rejected') throw box.reason;
  box.parkedNodes.add(consumer);
  const prior = consumer.asyncState as AsyncState | null;
  // Reuse the span's suspension so Suspense retries see one stable thenable —
  // but never a settled one, or a suspended render would retry in a loop.
  const suspension =
    prior !== null && prior.kind === 'pending' && !prior.suspension.settled
      ? prior.suspension
      : makeSuspension();
  box.parkedSuspensions.add(suspension);
  consumer.asyncState = { kind: 'pending', suspension } satisfies AsyncState;
  throw PARKED;
}

function finishCompute(
  node: DerivedNode<unknown>,
  outcome: { parked: boolean; error: unknown; hasError: boolean; value: unknown },
): boolean {
  const prior = node.asyncState as AsyncState | null;
  if (outcome.parked) {
    // canonicalUse installed the pending state. Advance the version so
    // downstream readers re-pull and park on the (possibly fresh) suspension.
    return true;
  }
  if (outcome.hasError) {
    if (prior !== null && prior.kind === 'pending') prior.suspension.resolve();
    const sameError = prior !== null && prior.kind === 'error' && prior.box.error === outcome.error;
    node.asyncState = sameError
      ? prior
      : ({ kind: 'error', box: { error: outcome.error } } satisfies AsyncState);
    return !sameError;
  }
  if (prior !== null && prior.kind === 'pending') prior.suspension.resolve();
  node.asyncState = null;
  const prev = node.value;
  if (isUninitialized(prev) || !node.equals(prev, outcome.value)) {
    node.value = outcome.value;
    return true;
  }
  // The value itself is unchanged; downstream still re-pulls when this ends
  // a pending or error span (readers may have parked or thrown).
  return prior !== null;
}

setUseImpl(canonicalUse as never);
setFinishComputeImpl(finishCompute as never);

/** A derived's canonical result envelope, after ensureFresh. */
export type Envelope =
  | { kind: 'value'; value: unknown }
  | { kind: 'pending'; suspension: Suspension; stale: boolean; value: unknown }
  | { kind: 'error'; box: ErrorBox };

export function envelopeOf(node: DerivedNode<unknown>): Envelope {
  const st = node.asyncState as AsyncState | null;
  if (st === null) return { kind: 'value', value: node.value };
  if (st.kind === 'error') return { kind: 'error', box: st.box };
  return {
    kind: 'pending',
    suspension: st.suspension,
    stale: !isUninitialized(node.value),
    value: isUninitialized(node.value) ? undefined : node.value,
  };
}

/**
 * Force a refetch with unchanged inputs. The hidden nonce cell is a real
 * tracked dependency, so the bump routes through write classification: an
 * urgent refresh invalidates canonically, a refresh inside a transition
 * writes a draft op and the refetch belongs to that world until it commits.
 */
export function ensureRefreshNonce(node: DerivedNode<unknown>): CellNode<number> {
  if (node.refreshNonce === undefined) {
    node.refreshNonce = makeCell(0, {
      label: node.label !== undefined ? `${node.label}.refresh` : 'refresh',
      lazy: false,
    });
    adoptDepLink(node.refreshNonce, node);
  }
  return node.refreshNonce;
}
