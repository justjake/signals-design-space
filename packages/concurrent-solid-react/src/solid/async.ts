import {
  CONFIG_SYNC,
  EFFECT_TRACKED,
  EFFECT_USER,
  NOT_PENDING,
  REACTIVE_DIRTY,
  REACTIVE_OPTIMISTIC_DIRTY,
  REACTIVE_ZOMBIE,
  STATUS_ERROR,
  STATUS_PENDING,
  STATUS_UNINITIALIZED
} from "./constants.js";
import { context, setSignal, untrack, updatePendingSignal } from "./core.js";
import { emitDiagnostic } from "./dev.js";
import { NotReadyError, StatusError } from "./error.js";
import { trimStaleDeps } from "./graph.js";
import { insertIntoHeap } from "./heap.js";
import { hasActiveOverride, resolveLane, resolveTransition, type OptimisticLane } from "./lanes.js";
import { cleanup } from "./owner.js";
import {
  assignOrMergeLane,
  clock,
  dirtyQueue,
  enqueueTrackedRun,
  flush,
  globalQueue,
  insertSubs,
  queuePendingNode,
  schedule,
  zombieQueue
} from "./scheduler.js";
import type { Computed, FirewallSignal, Link } from "./types.js";

function addPendingSource(el: Computed<any>, source: Computed<any>): boolean {
  if (el._pendingSource === source || el._pendingSources?.has(source)) return false;
  if (!el._pendingSource) {
    el._pendingSource = source;
    return true;
  }
  if (!el._pendingSources) {
    el._pendingSources = new Set([el._pendingSource, source]);
  } else {
    el._pendingSources.add(source);
  }
  el._pendingSource = undefined;
  return true;
}

function removePendingSource(el: Computed<any>, source: Computed<any>): boolean {
  if (el._pendingSource) {
    if (el._pendingSource !== source) return false;
    el._pendingSource = undefined;
    return true;
  }
  if (!el._pendingSources?.delete(source)) return false;
  if (el._pendingSources.size === 1) {
    el._pendingSource = el._pendingSources.values().next().value;
    el._pendingSources = undefined;
  } else if (el._pendingSources.size === 0) {
    el._pendingSources = undefined;
  }
  return true;
}

function clearPendingSources(el: Computed<any>): void {
  el._pendingSource = undefined;
  el._pendingSources?.clear();
  el._pendingSources = undefined;
}

function setPendingError(el: Computed<any>, source?: Computed<any>, error?: any): void {
  if (!source) {
    el._error = null;
    return;
  }
  if (error instanceof NotReadyError && error.source === source) {
    el._error = error;
    return;
  }
  const current = el._error;
  if (!(current instanceof NotReadyError) || current.source !== source) {
    el._error = new NotReadyError(source);
  }
}

function forEachDependent(el: Computed<any>, fn: (node: Computed<any>, link: Link) => void): void {
  for (let s = el._subs; s !== null; s = s._nextSub) fn(s._sub, s);
  for (
    let child: FirewallSignal<unknown> | null = el._child;
    child !== null;
    child = child._nextChild
  ) {
    for (let s = child._subs; s !== null; s = s._nextSub) fn(s._sub, s);
  }
}

// Queue a node to re-run on the next flush (used both when a pending source
// settles and when an `isPending` observer must re-evaluate after a real error).
function enqueueForRerun(node: Computed<any>): void {
  if ((node as any)._type === EFFECT_TRACKED) {
    // [react-adapt E10] world-split tracked-effect delivery (see scheduler)
    enqueueTrackedRun(node);
  } else {
    const queue = node._flags & REACTIVE_ZOMBIE ? zombieQueue : dirtyQueue;
    if (queue._min > node._height) queue._min = node._height;
    insertIntoHeap(node, queue);
  }
}

export function settlePendingSource(el: Computed<any>): void {
  let scheduled = false;
  const visited = new Set<Computed<any>>();
  const settle = (node: Computed<any>) => {
    if (visited.has(node) || !removePendingSource(node, el)) return;
    visited.add(node);
    node._time = clock;
    const source = node._pendingSource ?? node._pendingSources?.values().next().value;
    if (source) {
      setPendingError(node, source);
      updatePendingSignal(node);
    } else {
      node._statusFlags &= ~STATUS_PENDING;
      setPendingError(node);
      updatePendingSignal(node);
      if (node._blocked) {
        enqueueForRerun(node);
        scheduled = true;
      }
      node._blocked = false;
    }
    forEachDependent(node, settle);
  };

  forEachDependent(el, settle);

  if (scheduled) schedule();
}

// Object-thenable detection (Promises/A+ shape).
export function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export function handleAsync<T>(
  el: Computed<T>,
  result: T | PromiseLike<T> | AsyncIterable<T>,
  setter?: (value: T) => void
): T {
  let iterator: any = false;
  let thenable = false;
  if (typeof result === "object" && result !== null) {
    untrack(() => {
      iterator = (result as any)[Symbol.asyncIterator];
      thenable = !iterator && isThenable(result as T | PromiseLike<T>);
    });
  }

  if (!thenable && !iterator) {
    el._inFlight = null;
    return result as T;
  }

  // Dev-only contract enforcement for `sync: true` nodes. In production these
  // never reach `handleAsync` (the recompute fast path skips the call), but in
  // dev they do — we run the full async-shape probe and diagnose if a Promise
  // / AsyncIterable comes through. The fast-path semantics in production would
  // silently store the unawaited value, which is what the user opted out of by
  // passing `sync: true`; the diagnostic surfaces that mistake immediately.
  if (__DEV__ && el._config & CONFIG_SYNC) {
    const message =
      `[SYNC_NODE_RECEIVED_ASYNC] A computed/effect created with \`sync: true\` returned ` +
      `${thenable ? "a Promise" : "an AsyncIterable"}. The value would be stored as-is and ` +
      `never awaited in production; remove \`sync: true\` to use async-aware behavior, or ` +
      `unwrap the value before returning.`;
    emitDiagnostic({
      code: "SYNC_NODE_RECEIVED_ASYNC",
      kind: "lifecycle",
      severity: "error",
      message,
      ownerId: el.id,
      ownerName: (el as any)._name
    });
    throw new Error(message);
  }

  el._inFlight = result as PromiseLike<T> | AsyncIterable<T>;
  let syncValue: T;

  const handleError = (error: any) => {
    if (el._inFlight !== result) return;
    globalQueue.initTransition(resolveTransition(el as any));
    // NotReadyError from rejected promises should be treated as pending, not error
    notifyStatus(el, error instanceof NotReadyError ? STATUS_PENDING : STATUS_ERROR, error);
    el._time = clock;
  };

  const asyncWrite = (value: T, then?: () => void) => {
    if (el._inFlight !== result) return;
    // If the node was dirtied by a newer write (optimistic override or regular),
    // skip this stale async result — the upcoming flush will recompute the node
    // with the new value, creating a fresh Promise that supersedes this one.
    if (el._flags & (REACTIVE_DIRTY | REACTIVE_OPTIMISTIC_DIRTY)) return;
    globalQueue.initTransition(resolveTransition(el as any));
    const wasUninitialized = !!(el._statusFlags & STATUS_UNINITIALIZED);
    trimStaleDeps(el);
    clearStatus(el);
    const lane = resolveLane(el as any);
    if (lane) lane._pendingAsync.delete(el);
    if (setter) {
      setter(value);
      if (wasUninitialized) clearStatus(el, true);
    } else if (el._overrideValue !== undefined) {
      if (el._overrideValue !== NOT_PENDING) {
        // Active override: hold the fresh value as the revert target. The override
        // stays visible, so this must not commit.
        el._pendingValue = value;
      } else {
        // Resting optimistic node (no active override): commit through the shared
        // pending-node path, exactly like a plain async memo, so the commit clears
        // STATUS_UNINITIALIZED — no divergence from a non-optimistic source (#2806).
        if (el._pendingValue === NOT_PENDING) queuePendingNode(el);
        el._pendingValue = value;
        insertSubs(el);
      }
      el._time = clock;
    } else if (lane) {
      // Route through lane's effect queue for independent flushing
      const isEffect = (el as any)._type;
      const prevValue = el._value;
      const equals = el._equals;
      if ((!isEffect && wasUninitialized) || !equals || !equals(value, prevValue)) {
        el._value = value;
        el._time = clock;
        // Write to _latestValueComputed so latest() effects get independent lanes
        if (el._latestValueComputed) {
          setSignal(el._latestValueComputed, value);
        }
        insertSubs(el, true);
      }
    } else {
      setSignal(el, () => value);
    }
    settlePendingSource(el);
    schedule();
    flush();
    then?.();
  };

  if (thenable) {
    let resolved = false,
      rejected = false,
      syncError: any,
      isSync = true;
    (result as PromiseLike<T>).then(
      v => {
        if (isSync) {
          syncValue = v;
          resolved = true;
        } else asyncWrite(v);
      },
      e => {
        if (isSync) {
          syncError = e;
          rejected = true;
        } else handleError(e);
      }
    );
    isSync = false;
    if (rejected) {
      // Settle through the same status path an async rejection uses, then
      // unwind the in-progress synchronous read so the errored node isn't
      // momentarily read as `undefined`.
      handleError(syncError);
      throw syncError;
    } else if (!resolved) {
      globalQueue.initTransition(resolveTransition(el as any));
      throw new NotReadyError(context!);
    }
  }

  if (iterator) {
    const it = (result as AsyncIterable<T>)[Symbol.asyncIterator]();
    let hadSyncValue = false;
    let completed = false;

    cleanup(() => {
      if (completed) return;
      completed = true;
      try {
        const returned = it.return?.();
        if (isThenable(returned)) returned.then(undefined, () => {});
      } catch {}
    });

    const iterate = (): boolean => {
      let syncResult: IteratorResult<T>,
        resolved = false,
        isSync = true;
      it.next().then(
        r => {
          if (isSync) {
            syncResult = r;
            resolved = true;
            if (r.done) completed = true;
          } else if (el._inFlight !== result) {
            return;
          } else if (!r.done) asyncWrite(r.value, iterate);
          else {
            completed = true;
            schedule();
            flush();
          }
        },
        e => {
          if (!isSync && el._inFlight === result) {
            completed = true;
            handleError(e);
          }
        }
      );
      isSync = false;
      if (resolved && !syncResult!.done) {
        syncValue = syncResult!.value;
        hadSyncValue = true;
        return iterate();
      }
      return resolved && syncResult!.done;
    };

    const immediatelyDone = iterate();
    if (!hadSyncValue && !immediatelyDone) {
      globalQueue.initTransition(resolveTransition(el as any));
      throw new NotReadyError(context!);
    }
  }

  return syncValue!;
}

export function clearStatus(el: Computed<any>, clearUninitialized: boolean = false): void {
  if (el._pendingSource || el._pendingSources) clearPendingSources(el);
  if (el._blocked) el._blocked = false;
  el._statusFlags = clearUninitialized ? 0 : el._statusFlags & STATUS_UNINITIALIZED;
  if (el._error) setPendingError(el);
  // Update pending signal for isPending() reactivity
  if (el._pendingSignal) updatePendingSignal(el);
  if (el._notifyStatus) el._notifyStatus();
  // [react-adapt E11] wake React Suspense retries waiting on this node
  el._onStatusSettled?.();
}

export function notifyStatus(
  el: Computed<any>,
  status: number,
  error: any,
  blockStatus?: boolean,
  lane?: OptimisticLane
): void {
  // Wrap regular errors to track source node
  if (
    status === STATUS_ERROR &&
    !(error instanceof StatusError) &&
    !(error instanceof NotReadyError)
  )
    error = new StatusError(el, error);

  const pendingSource =
    status === STATUS_PENDING && error instanceof NotReadyError ? error.source : undefined;
  const isSource = pendingSource === el;
  const isOptimisticBoundary =
    status === STATUS_PENDING && el._overrideValue !== undefined && !isSource;
  const startsBlocking = isOptimisticBoundary && hasActiveOverride(el);

  if (!blockStatus) {
    if (status === STATUS_PENDING && pendingSource) {
      addPendingSource(el, pendingSource);
      el._statusFlags = STATUS_PENDING | (el._statusFlags & STATUS_UNINITIALIZED);
      // Preserve the current source on this propagation so render-effect notification
      // can register every distinct pending source with the transition.
      setPendingError(el, pendingSource, error);
    } else {
      clearPendingSources(el);
      el._statusFlags =
        status | (status !== STATUS_ERROR ? el._statusFlags & STATUS_UNINITIALIZED : 0);
      el._error = error;
      // [react-adapt E11] a real error settles the suspension: React retries
      // the render, the read rethrows the error, an error boundary catches.
      if (status === STATUS_ERROR) el._onStatusSettled?.();
    }
    updatePendingSignal(el);
  }

  if (lane && !blockStatus) {
    assignOrMergeLane(el, lane);
  }

  const downstreamBlockStatus = blockStatus || startsBlocking;
  const downstreamLane = blockStatus || isOptimisticBoundary ? undefined : lane;

  if (el._notifyStatus) {
    if (blockStatus && status === STATUS_PENDING) {
      return;
    }
    if (downstreamBlockStatus) {
      el._notifyStatus(status, error);
    } else {
      el._notifyStatus();
    }
    return;
  }
  forEachDependent(el, (sub, link) => {
    sub._time = clock;
    if (
      (status === STATUS_PENDING &&
        pendingSource &&
        sub._pendingSource !== pendingSource &&
        !sub._pendingSources?.has(pendingSource)) ||
      (status !== STATUS_PENDING &&
        (sub._error !== error || sub._pendingSource || sub._pendingSources))
    ) {
      // A pending-observer link is the subscription an `isPending` read created.
      // It exists so the observer re-runs when the source settles, but it must
      // not carry a real (non-NotReadyError) error — the synchronous `isPending`
      // read swallows those, and the async path must match. Re-run the observer
      // so `isPending` re-evaluates (to not-pending) instead of forwarding.
      if (link._pendingObserver && status !== STATUS_PENDING && !(error instanceof NotReadyError)) {
        enqueueForRerun(sub);
        schedule();
        return;
      }
      if (!downstreamBlockStatus && !sub._transition) queuePendingNode(sub);
      notifyStatus(sub, status, error, downstreamBlockStatus, downstreamLane);
    }
  });
}
