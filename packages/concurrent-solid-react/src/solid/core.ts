import { clearStatus, handleAsync, notifyStatus } from "./async.js";
import {
  $REFRESH,
  CONFIG_AUTO_DISPOSE,
  CONFIG_CHILDREN_FORBIDDEN,
  CONFIG_IN_SNAPSHOT_SCOPE,
  CONFIG_NO_SNAPSHOT,
  CONFIG_OWNED_WRITE,
  CONFIG_SYNC,
  CONFIG_TRANSPARENT,
  defaultContext,
  EFFECT_TRACKED,
  EFFECT_USER,
  NO_SNAPSHOT,
  NOT_PENDING,
  REACTIVE_CHECK,
  REACTIVE_DIRTY,
  REACTIVE_DISPOSED,
  REACTIVE_IN_HEAP,
  REACTIVE_IN_HEAP_HEIGHT,
  REACTIVE_LAZY,
  REACTIVE_MANUAL_WRITE,
  REACTIVE_NONE,
  REACTIVE_OPTIMISTIC_DIRTY,
  REACTIVE_RECOMPUTING_DEPS,
  REACTIVE_SNAPSHOT_STALE,
  REACTIVE_ZOMBIE,
  STATUS_ERROR,
  STATUS_PENDING,
  STATUS_UNINITIALIZED,
  STORE_SNAPSHOT_PROPS,
  type Refreshable
} from "./constants.js";
import { NotReadyError } from "./error.js";
import { externalSourceConfig } from "./external.js";
import { link, trimStaleDeps, unobserved } from "./graph.js";
import {
  deleteFromHeap,
  insertIntoHeap,
  insertIntoHeapHeight,
  markHeap,
  markNode
} from "./heap.js";
import {
  findLane,
  getOrCreateLane,
  hasActiveOverride,
  mergeLanes,
  resolveLane,
  resolveTransition,
  signalLanes,
  type OptimisticLane
} from "./lanes.js";
import { clearSignals, DEV, emitDiagnostic } from "./dev.js";
import { cleanup, disposeChildren, getNextChildId, markDisposal } from "./owner.js";
import {
  activeTransition,
  assignOrMergeLane,
  clock,
  dirtyQueue,
  globalQueue,
  GlobalQueue,
  insertSubs,
  currentTransition,
  isTransitionLive,
  projectionWriteActive,
  refreshCommittedCone,
  queuePendingNode,
  registerOptimisticNode,
  runInTransition,
  schedule,
  setActiveTransition,
  shouldReadStashedOptimisticValue,
  zombieQueue,
  type Transition
} from "./scheduler.js";
import type { Computed, FirewallSignal, Link, NodeOptions, Owner, Root, Signal } from "./types.js";

GlobalQueue._update = recompute;
GlobalQueue._dispose = disposeChildren;

export const PRIMITIVE_IN_FORBIDDEN_SCOPE_MESSAGE =
  "[PRIMITIVE_IN_FORBIDDEN_SCOPE] Cannot create reactive primitives inside createTrackedEffect or owner-backed onSettled";
export const REACTIVE_WRITE_IN_OWNED_SCOPE_SIGNAL_MESSAGE =
  "[REACTIVE_WRITE_IN_OWNED_SCOPE] Writing to reactive state inside an owned scope (component, computation) is not allowed. " +
  "Move the write outside or set the `ownedWrite` option if this is intentional.";
export const REACTIVE_WRITE_IN_OWNED_SCOPE_REFRESH_MESSAGE =
  "[REACTIVE_WRITE_IN_OWNED_SCOPE] Calling refresh() inside an owned scope (component, computation) is not allowed. " +
  "Move the invalidation outside pure computation.";

export let tracking = false;
export let stale = false;
export let pendingCheckActive = false;
export let foundPending = false;
export let latestReadActive = false;
export let context: Owner | null = null;
export let currentOptimisticLane: OptimisticLane | null = null;
let pendingCheckSources: Set<Signal<any> | Computed<any>> | null = null;

export let snapshotCaptureActive = false;
export let snapshotSources: Set<any> | null = null;

function ownerInSnapshotScope(owner: Owner | null): boolean {
  while (owner) {
    if (owner._snapshotScope) return true;
    owner = owner._parent;
  }
  return false;
}

export function setSnapshotCapture(active: boolean): void {
  snapshotCaptureActive = active;
  if (active && !snapshotSources) snapshotSources = new Set();
}

export function markSnapshotScope(owner: Owner): void {
  owner._snapshotScope = true;
}

export function releaseSnapshotScope(owner: Owner): void {
  owner._snapshotScope = false;
  releaseSubtree(owner);
  schedule();
}

function releaseSubtree(owner: Owner): void {
  let child = owner._firstChild;
  while (child) {
    if (child._snapshotScope) {
      child = child._nextSibling;
      continue;
    }
    if ((child as any)._fn) {
      const comp = child as Computed<any>;
      comp._config &= ~CONFIG_IN_SNAPSHOT_SCOPE;
      if (comp._flags & REACTIVE_SNAPSHOT_STALE) {
        comp._flags &= ~REACTIVE_SNAPSHOT_STALE;
        comp._flags |= REACTIVE_DIRTY;
        if (dirtyQueue._min > comp._height) dirtyQueue._min = comp._height;
        insertIntoHeap(comp, dirtyQueue);
      }
    }
    releaseSubtree(child);
    child = child._nextSibling;
  }
}

export function clearSnapshots(): void {
  if (snapshotSources) {
    for (const source of snapshotSources) {
      delete source._snapshotValue;
      delete source[STORE_SNAPSHOT_PROPS];
    }
    snapshotSources = null;
  }
  snapshotCaptureActive = false;
}

export function recompute(el: Computed<any>, create: boolean = false): void {
  const isEffect = (el as any)._type;
  // [react-adapt E9] Per-node world re-entry with restore. The subscriber's
  // `_reentryWorld` mark (set by insertSubs when a transition-staged source
  // dirtied it) or its own `_transition` stamp decides which world this
  // recompute runs in; the previous ambient world is restored afterwards so
  // urgent and deferred cones recomputed in the same flush stay separate.
  let prevWorld: Transition | null | undefined;
  if (!create) {
    const reentry = (el as any)._reentryWorld as Transition | undefined;
    (el as any)._reentryWorld = undefined;
    // [react-adapt E10] tracked effects never re-enter a draft world: their
    // contract is committed-only observation. Their delivery is world-split
    // instead (enqueueTrackedRun) — held runs fire after the world commits.
    const liveReentry =
      reentry && isTransitionLive(reentry) && isEffect !== EFFECT_TRACKED ? reentry : undefined;
    const target = liveReentry ?? el._transition;
    if (target && (!isEffect || activeTransition || liveReentry)) {
      prevWorld = activeTransition;
      globalQueue.initTransition(target);
    }
    deleteFromHeap(el, el._flags & REACTIVE_ZOMBIE ? zombieQueue : dirtyQueue);
    el._inFlight = null;
    // Tracked effects run after finalizePureQueue, so dispose immediately instead of deferring
    if (el._transition || isEffect === EFFECT_TRACKED) disposeChildren(el);
    else if (el._firstChild !== null || el._disposal !== null) {
      markDisposal(el);
      el._pendingDisposal = el._disposal;
      el._pendingFirstChild = el._firstChild;
      el._disposal = null;
      el._firstChild = null;
      el._childCount = 0;
      if (__DEV__) clearSignals(el);
    } else if (__DEV__) clearSignals(el);
  }

  let isOptimisticDirty = !!(el._flags & REACTIVE_OPTIMISTIC_DIRTY);
  const hasOverride = el._overrideValue !== undefined && el._overrideValue !== NOT_PENDING;
  // Track if node was pending (for detecting async resolution)
  const wasPending = !!(el._statusFlags & STATUS_PENDING);
  const wasUninitialized = !!(el._statusFlags & STATUS_UNINITIALIZED);

  const oldcontext = context;
  context = el;
  el._depsTail = null;
  el._flags = REACTIVE_RECOMPUTING_DEPS;
  el._time = clock;
  let value = el._pendingValue === NOT_PENDING ? el._value : el._pendingValue;
  let oldHeight = el._height;
  let prevTracking = tracking;
  let prevLane = currentOptimisticLane;
  let prevStrictRead: string | false = false;
  if (__DEV__) {
    prevStrictRead = strictRead;
    strictRead = false;
  }
  tracking = true;
  if (isOptimisticDirty) {
    const lane = resolveLane(el);
    if (lane) currentOptimisticLane = lane;
  } else if (activeTransition && !create && activeTransition._optimisticNodes.length) {
    // Lane adoption: parent-deeper-than-owned-child can run before its OPT-dirty
    // child propagates. Walk deps once and inherit the OPT lane so this node
    // recomputes under the right posture and propagates correctly.
    for (let d: Link | null = el._deps; d; d = d._nextDep) {
      const dep = d._dep as Computed<any>;
      if (dep._flags & REACTIVE_OPTIMISTIC_DIRTY) {
        const depLane = resolveLane(dep);
        if (depLane) {
          isOptimisticDirty = true;
          currentOptimisticLane = depLane;
          el._flags |= REACTIVE_OPTIMISTIC_DIRTY;
          assignOrMergeLane(el as any, depLane);
          break;
        }
      }
    }
  }
  const isStaleEffect = isEffect && isEffect !== EFFECT_USER;
  const prevStale = stale;
  if (isStaleEffect) stale = true;
  try {
    if (!__DEV__ && el._config & CONFIG_SYNC) {
      value = el._fn(value);
      el._inFlight = null;
    } else {
      // Snapshot `_inFlight` so we can detect whether `_fn` self-registered an async
      // subscription (e.g. `createProjection` calls `handleAsync` from inside its body
      // with a setter callback). In that case, the outer `handleAsync` call below would
      // clobber the fresh subscription, so we skip it and let the internally-registered
      // iteration drive updates.
      const prevInFlight = el._inFlight;
      const fnResult = el._fn(value);
      const isAsyncResult = typeof fnResult === "object" && fnResult !== null;
      const inFlightChanged = el._inFlight !== prevInFlight;
      value = inFlightChanged || !isAsyncResult ? fnResult : handleAsync(el, fnResult);
      if (!inFlightChanged && !isAsyncResult) el._inFlight = null;
    }
    clearStatus(el, create);
    if (el._optimisticLane) {
      const resolvedLane = resolveLane(el);
      if (resolvedLane) {
        resolvedLane._pendingAsync.delete(el);
        updatePendingSignal(resolvedLane._source);
      }
    }
  } catch (e) {
    // Track pending async in the lane (not the lane's source — it creates the lane
    // but doesn't belong to it). Set lane BEFORE notifyStatus for downstream propagation.
    if (e instanceof NotReadyError && currentOptimisticLane) {
      const lane = findLane(currentOptimisticLane);
      if (lane._source !== el) {
        lane._pendingAsync.add(el);
        el._optimisticLane = lane;
        updatePendingSignal(lane._source);
      }
    }
    if (e instanceof NotReadyError) el._blocked = true;
    notifyStatus(
      el,
      e instanceof NotReadyError ? STATUS_PENDING : STATUS_ERROR,
      e,
      undefined,
      e instanceof NotReadyError ? el._optimisticLane : undefined
    );
  } finally {
    tracking = prevTracking;
    if (__DEV__) strictRead = prevStrictRead;
    if (isStaleEffect) stale = prevStale;
    el._flags = REACTIVE_NONE | (create ? el._flags & REACTIVE_SNAPSHOT_STALE : 0);
    context = oldcontext;
  }

  if (!el._error) {
    trimStaleDeps(el);
    const compareValue = hasOverride
      ? el._overrideValue
      : el._pendingValue === NOT_PENDING
        ? el._value
        : el._pendingValue;
    const valueChanged =
      (!isEffect && wasUninitialized) || !el._equals || !el._equals(compareValue, value);

    // Effects use `_equals: false` (no per-effect closure). The side effects that
    // the equals closure used to perform — flagging the effect dirty and enqueueing
    // its runner — happen here instead. `!create` matches the previous `initialized`
    // gate: the explicit recompute(node, true) inside effect() does not enqueue, so
    // effect() can call its runner synchronously for the first run.
    if (isEffect && valueChanged) {
      (el as any)._modified = !el._error;
      if (!create) el._queue.enqueue(isEffect, GlobalQueue._runEffect.bind(null, el));
    }

    if (valueChanged) {
      const prevVisible = hasOverride ? el._overrideValue : undefined;

      if (create || (isEffect && activeTransition !== el._transition) || isOptimisticDirty) {
        el._value = value;
        // Lane-propagated correction: upstream data is fresh, correct override unconditionally
        if (hasOverride && isOptimisticDirty) {
          el._overrideValue = value;
          el._pendingValue = value;
        }
      } else el._pendingValue = value;

      // Correct override for async resolution (non-lane path) unless user wrote since lane creation
      if (hasOverride && !isOptimisticDirty && wasPending && !(el as any)._overrideSinceLane)
        el._overrideValue = value;

      if (!hasOverride || isOptimisticDirty || el._overrideValue !== prevVisible)
        insertSubs(el, isOptimisticDirty || hasOverride);
    } else if (hasOverride) {
      el._pendingValue = value;
    } else if (el._height != oldHeight) {
      for (let s = el._subs; s !== null; s = s._nextSub) {
        insertIntoHeapHeight(s._sub, s._sub._flags & REACTIVE_ZOMBIE ? zombieQueue : dirtyQueue);
      }
    }
  }
  currentOptimisticLane = prevLane;
  const needsPendingCommit =
    el._pendingValue !== NOT_PENDING ||
    el._pendingFirstChild !== null ||
    el._pendingDisposal !== null ||
    !!(el._statusFlags & (STATUS_PENDING | STATUS_UNINITIALIZED));
  needsPendingCommit &&
    (!create || el._statusFlags & STATUS_PENDING) &&
    !el._transition &&
    !(activeTransition && hasOverride) &&
    queuePendingNode(el);
  el._transition &&
    isEffect &&
    activeTransition !== el._transition &&
    runInTransition(el._transition, () => recompute(el));
  // [react-adapt E9] restore the ambient world this recompute entered under.
  if (prevWorld !== undefined) setActiveTransition(prevWorld);
}

function updateIfNecessary(el: Computed<unknown>): void {
  if (el._flags & REACTIVE_CHECK) {
    for (let d = el._deps; d; d = d._nextDep) {
      const dep1 = d._dep;
      const dep = (dep1 as FirewallSignal<unknown>)._firewall || dep1;
      if ((dep as Computed<unknown>)._fn) {
        updateIfNecessary(dep);
      }
      if (el._flags & REACTIVE_DIRTY) {
        break;
      }
    }
  }

  if (
    el._flags & (REACTIVE_DIRTY | REACTIVE_OPTIMISTIC_DIRTY) ||
    (el._error && el._time < clock && !el._inFlight)
  ) {
    recompute(el);
  }

  el._flags = el._flags & (REACTIVE_SNAPSHOT_STALE | REACTIVE_IN_HEAP | REACTIVE_IN_HEAP_HEIGHT);
}

export function computed<T>(fn: (prev?: T) => T | PromiseLike<T> | AsyncIterable<T>): Computed<T>;
export function computed<T>(
  fn: (prev: T) => T | PromiseLike<T> | AsyncIterable<T>,
  options?: NodeOptions<T>
): Computed<T>;
export function computed<T>(
  fn: (prev?: T) => T | PromiseLike<T> | AsyncIterable<T>,
  options?: NodeOptions<T>
): Computed<T> {
  const transparent = options?.transparent ?? false;
  const self: Computed<T> = {
    id:
      options?.id ??
      (transparent ? context?.id : context?.id != null ? getNextChildId(context) : undefined),
    _config:
      (transparent ? CONFIG_TRANSPARENT : 0) |
      (options?.ownedWrite ? CONFIG_OWNED_WRITE : 0) |
      (!context || options?.lazy ? CONFIG_AUTO_DISPOSE : 0) |
      (options?.sync ? CONFIG_SYNC : 0) |
      (options?._noSnapshot ? CONFIG_NO_SNAPSHOT : 0) |
      (snapshotCaptureActive && ownerInSnapshotScope(context) ? CONFIG_IN_SNAPSHOT_SCOPE : 0),
    _equals: options?.equals != null ? options.equals : isEqual,
    _unobserved: options?.unobserved,
    _disposal: null,
    _queue: context?._queue ?? globalQueue,
    _context: context?._context ?? defaultContext,
    _childCount: 0,
    _fn: fn,
    _value: undefined as T,
    _height: 0,
    _child: null,
    _nextHeap: undefined,
    _prevHeap: null as any,
    _deps: null,
    _depsTail: null,
    _subs: null,
    _subsTail: null,
    _parent: context,
    _nextSibling: null,
    _prevSibling: null,
    _firstChild: null,
    _flags: options?.lazy ? REACTIVE_LAZY : REACTIVE_NONE,
    _statusFlags: STATUS_UNINITIALIZED,
    _time: clock,
    _pendingValue: NOT_PENDING,
    _pendingDisposal: null,
    _pendingFirstChild: null,
    _inFlight: null,
    _transition: null
  } as Computed<T>;
  if (__DEV__) (self as any)._name = options?.name ?? "computed";
  setupComputedNode(self, options);
  return self;
}

/**
 * Build an Effect node with all effect-specific fields baked into a single object literal,
 * so V8 sees the full hidden class shape at construction time. Effects always run in lazy
 * mode (recompute is called explicitly by `effect()`), so we hardcode the lazy bits and skip
 * the auto-dispose CONFIG bit (effect() previously cleared it post-construction).
 */
export function createEffectNode<T>(
  fn: (prev?: T) => T,
  effectFn: (val: T, prev: T | undefined) => void | (() => void),
  errorFn: ((err: unknown, cleanup: () => void) => void | (() => void)) | undefined,
  type: number,
  notifyStatus: ((status?: number, error?: any) => void) | undefined,
  options: NodeOptions<T> | undefined
): any {
  const transparent = options?.transparent ?? false;
  const self = {
    id:
      options?.id ??
      (transparent ? context?.id : context?.id != null ? getNextChildId(context) : undefined),
    _config:
      (transparent ? CONFIG_TRANSPARENT : 0) |
      (options?.ownedWrite ? CONFIG_OWNED_WRITE : 0) |
      (options?.sync ? CONFIG_SYNC : 0) |
      (snapshotCaptureActive && ownerInSnapshotScope(context) ? CONFIG_IN_SNAPSHOT_SCOPE : 0),
    _equals: false as unknown as Computed<T>["_equals"],
    _unobserved: options?.unobserved,
    _disposal: null,
    _queue: context?._queue ?? globalQueue,
    _context: context?._context ?? defaultContext,
    _childCount: 0,
    _fn: fn,
    _value: undefined as T,
    _height: 0,
    _child: null,
    _nextHeap: undefined,
    _prevHeap: null as any,
    _deps: null,
    _depsTail: null,
    _subs: null,
    _subsTail: null,
    _parent: context,
    _nextSibling: null,
    _prevSibling: null,
    _firstChild: null,
    _flags: REACTIVE_LAZY,
    _statusFlags: STATUS_UNINITIALIZED,
    _time: clock,
    _pendingValue: NOT_PENDING,
    _pendingDisposal: null,
    _pendingFirstChild: null,
    _inFlight: null,
    _transition: null,
    _modified: false,
    _prevValue: undefined as T | undefined,
    _effectFn: effectFn,
    _errorFn: errorFn,
    _cleanup: undefined as (() => void) | undefined,
    _cleanupRegistered: false,
    _type: type,
    _notifyStatus: notifyStatus
  } as any;
  if (__DEV__) self._name = options?.name ?? "effect";
  setupComputedNode(self, lazyOptions);
  return self;
}

const lazyOptions = { lazy: true } as const;

function setupComputedNode<T>(self: Computed<T>, options: NodeOptions<T> | undefined): void {
  self._prevHeap = self;
  const parent = (context as Root)?._root
    ? (context as Root)._parentComputed
    : (context as Computed<any> | null);
  if (__DEV__ && context && context._config & CONFIG_CHILDREN_FORBIDDEN) {
    emitDiagnostic({
      code: "PRIMITIVE_IN_FORBIDDEN_SCOPE",
      kind: "lifecycle",
      severity: "error",
      message: PRIMITIVE_IN_FORBIDDEN_SCOPE_MESSAGE,
      ownerId: context.id,
      ownerName: (context as any)._name
    });
    throw new Error(PRIMITIVE_IN_FORBIDDEN_SCOPE_MESSAGE);
  }
  if (context) {
    const lastChild = context._firstChild;
    if (lastChild === null) {
      context._firstChild = self;
    } else {
      self._nextSibling = lastChild;
      lastChild._prevSibling = self;
      context._firstChild = self;
    }
  }
  if (__DEV__) DEV.hooks.onOwner?.(self);
  if (parent) self._height = parent._height + 1;
  if (externalSourceConfig) {
    const bridgeSignal = signal<undefined>(undefined, { equals: false, ownedWrite: true });
    const source = externalSourceConfig.factory(self._fn as any, () => {
      setSignal(bridgeSignal, undefined);
    });
    cleanup(() => source.dispose());
    self._fn = ((prev: any) => {
      read(bridgeSignal);
      return source.track(prev);
    }) as any;
  }
  !options?.lazy && recompute(self, true);
  if (snapshotCaptureActive && !options?.lazy) {
    if (!(self._statusFlags & STATUS_PENDING) && !(self._config & CONFIG_NO_SNAPSHOT)) {
      self._snapshotValue = self._value === undefined ? NO_SNAPSHOT : self._value;
      snapshotSources!.add(self);
    }
  }
}

export function signal<T>(v: T, options?: NodeOptions<T>): Signal<T>;
export function signal<T>(
  v: T,
  options?: NodeOptions<T>,
  firewall?: Computed<any>
): FirewallSignal<T>;
export function signal<T>(
  v: T,
  options?: NodeOptions<T>,
  firewall: Computed<unknown> | null = null
): Signal<T> {
  const s = {
    _equals: options?.equals != null ? options.equals : isEqual,
    _config:
      (options?.ownedWrite ? CONFIG_OWNED_WRITE : 0) |
      (options?._noSnapshot ? CONFIG_NO_SNAPSHOT : 0),
    _unobserved: options?.unobserved,
    _value: v,
    _subs: null,
    _subsTail: null,
    _time: clock,
    _firewall: firewall,
    _nextChild: firewall?._child || null,
    _pendingValue: NOT_PENDING
  };
  if (__DEV__) {
    (s as any)._name = options?.name ?? "signal";
    (s as any)._internal = !!firewall;
  }
  firewall && (firewall._child = s as FirewallSignal<unknown>);
  if (
    snapshotCaptureActive &&
    !(s._config & CONFIG_NO_SNAPSHOT) &&
    !((firewall?._statusFlags ?? 0) & STATUS_PENDING)
  ) {
    (s as any)._snapshotValue = v === undefined ? NO_SNAPSHOT : v;
    snapshotSources!.add(s);
  }
  return s as Signal<T>;
}

export function optimisticSignal<T>(v: T, options?: NodeOptions<T>): Signal<T> {
  const s = signal(v, options);
  s._overrideValue = NOT_PENDING;
  return s;
}

export function optimisticComputed<T>(
  fn: (prev?: T) => T | PromiseLike<T> | AsyncIterable<T>,
  options?: NodeOptions<T>
): Computed<T> {
  const c = computed(fn, options);
  c._overrideValue = NOT_PENDING;
  return c;
}

export function isEqual<T>(a: T, b: T): boolean {
  return a === b;
}

/**
 * When set to a component name string, any reactive read that is not inside a nested tracking
 * scope will log a dev-mode warning. Managed automatically by `untrack(fn, strictReadLabel)`.
 */
export let strictRead: string | false = false;
export function setStrictRead(v: string | false): string | false {
  const prev = strictRead;
  strictRead = v;
  return prev;
}

/**
 * Runs `fn` outside of any reactive tracking — reads inside `fn` will not
 * subscribe the current scope. Returns whatever `fn` returns.
 *
 * Use `untrack` inside a memo or effect when you need to read a signal once
 * without making the surrounding computation depend on its future changes.
 *
 * Pass a `strictReadLabel` string to enable a dev-mode warning: any reactive
 * read inside `fn` that isn't inside a nested tracking scope will log a
 * warning naming the label.
 *
 * @example
 * ```ts
 * createEffect(
 *   () => trigger(),                 // tracks `trigger` only
 *   () => {
 *     const snapshot = untrack(() => state); // read once, untracked
 *     log(snapshot);
 *   }
 * );
 * ```
 */
/**
 * [react-adapt E13] Run `fn` with tracking enabled against an explicit
 * observer node. This is how a React render read establishes a Solid
 * tracking frame: the bridge's probe node collects dependency links during
 * the component's render, harvests them, and immediately unlinks — so a
 * discarded React render leaves no trace in the graph.
 */
export function runTracked<T>(observer: Computed<any>, fn: () => T): T {
  const prevContext = context;
  const prevTracking = tracking;
  context = observer;
  tracking = true;
  try {
    return fn();
  } finally {
    context = prevContext;
    tracking = prevTracking;
  }
}

export function untrack<T>(fn: () => T, strictReadLabel?: string | false): T {
  if (!externalSourceConfig && !tracking && (!__DEV__ || (!strictRead && !strictReadLabel)))
    return fn();
  const prevTracking = tracking;
  const prevStrictRead = strictRead;
  tracking = false;
  if (__DEV__) strictRead = strictReadLabel || false;
  try {
    if (externalSourceConfig) return externalSourceConfig.untrack(fn);
    return fn();
  } finally {
    tracking = prevTracking;
    if (__DEV__) strictRead = prevStrictRead;
  }
}

export function read<T>(el: Signal<T> | Computed<T>): T {
  // Handle latest() mode: read from _latestValueComputed
  // Checked before isPending so that isPending(() => latest(x)) checks
  // the _pendingSignal of _latestValueComputed (async in flight) rather
  // than the original node (which stays "pending" while held in a transition).
  if (latestReadActive) {
    const pendingComputed = getLatestValueComputed(el);
    const prevPending = latestReadActive;
    latestReadActive = false;
    const visibleValue = (
      el._overrideValue !== undefined && el._overrideValue !== NOT_PENDING
        ? el._overrideValue
        : el._value
    ) as T;
    let value: T;
    try {
      value = read(pendingComputed);
    } catch (e) {
      if (!context && e instanceof NotReadyError) return visibleValue;
      throw e;
    } finally {
      latestReadActive = prevPending;
    }
    if (pendingComputed._statusFlags & STATUS_PENDING) return visibleValue;
    // Cross-lane stale read: a child lane should keep seeing the parent's
    // committed value until the parent lane resolves.
    if (stale && currentOptimisticLane && pendingComputed._optimisticLane) {
      const pcLane = findLane(pendingComputed._optimisticLane);
      const curLane = findLane(currentOptimisticLane);
      if (pcLane !== curLane && pcLane._pendingAsync.size > 0) {
        return visibleValue;
      }
    }
    return value as T;
  }

  // Handle isPending() mode: collect pending state while preserving normal read semantics.
  if (pendingCheckActive) {
    const firewall = (el as FirewallSignal<any>)._firewall;
    const prevCheck = pendingCheckActive;
    pendingCheckActive = false;
    let c = context;
    if ((c as Root)?._root) c = (c as Root)._parentComputed;
    const owner = firewall || (el as Computed<any>);
    const pendingComputed = el as Partial<Computed<unknown>>;
    if (typeof pendingComputed._fn === "function") {
      const comp = el as Computed<unknown>;
      if (comp._flags & REACTIVE_LAZY) {
        comp._flags &= ~REACTIVE_LAZY;
        recompute(comp as Computed<any>, true);
      } else if (comp._flags & REACTIVE_DISPOSED) {
        recompute(comp as Computed<any>, true);
      } else {
        updateIfNecessary(comp);
      }
    }
    if (c && owner._statusFlags & STATUS_PENDING && owner._statusFlags & STATUS_UNINITIALIZED) {
      if (tracking && el !== c) link(el, c as Computed<any>);
      pendingCheckActive = prevCheck;
      throw owner._error;
    }
    if (firewall && el._overrideValue !== undefined) {
      if (
        el._overrideValue !== NOT_PENDING &&
        (firewall._inFlight || !!(firewall._statusFlags & STATUS_PENDING))
      ) {
        foundPending = true;
      }
      collectPendingSources(el);
      collectPendingSources(firewall);
      if (c && tracking) link(el, c as Computed<any>);
    } else {
      collectPendingSources(el);
      if (firewall) collectPendingSources(firewall);
    }
    pendingCheckActive = prevCheck;
  }

  let c = context;
  if ((c as Root)?._root) c = (c as Root)._parentComputed;
  const computed = el as Partial<Computed<unknown>>;
  if (typeof computed._fn === "function") {
    const comp = el as Computed<unknown>;
    if (comp._flags & REACTIVE_LAZY) {
      comp._flags &= ~REACTIVE_LAZY;
      recompute(comp as Computed<any>, true);
    } else if (comp._flags & REACTIVE_DISPOSED) {
      recompute(comp as Computed<any>, true);
    }
  }
  const owner = (el as FirewallSignal<any>)._firewall || el;

  if (
    !computed._fn &&
    owner === el &&
    el._overrideValue === undefined &&
    el._snapshotValue === undefined &&
    activeTransition === null &&
    // [react-adapt E9] a transition-held signal must take the slow path so
    // readers outside that world get the committed value, not the staged one
    el._transition == null &&
    currentOptimisticLane === null &&
    !snapshotCaptureActive &&
    (!__DEV__ || !strictRead)
  ) {
    if (c && tracking) link(el, c as Computed<any>);
    const fastValue = (!c || el._pendingValue === NOT_PENDING ? el._value : el._pendingValue) as T;
    // [react-adapt E13] render-pass value pinning (render-probe reads only)
    if (c !== null && renderValueInterceptor !== null && (c as any)._isRenderProbe === true) {
      return renderValueInterceptor(el, fastValue) as T;
    }
    return fastValue;
  }

  if (__DEV__ && strictRead && owner._statusFlags & STATUS_PENDING) {
    const message =
      `[PENDING_ASYNC_UNTRACKED_READ] Reading a pending async value directly in ${strictRead}. ` +
      `Async values must be read within a tracking scope (JSX, a memo, or an effect's compute function).`;
    emitDiagnostic({
      code: "PENDING_ASYNC_UNTRACKED_READ",
      kind: "async",
      severity: "error",
      message,
      ownerId: c?.id,
      ownerName: (c as any)?._name,
      nodeName: (owner as any)?._name,
      data: { strictRead }
    });
    throw new Error(message);
  }

  if (c && tracking) {
    link(el, c as Computed<any>, pendingCheckActive);

    if ((owner as Computed<unknown>)._fn) {
      const isZombie = (el as Computed<unknown>)._flags & REACTIVE_ZOMBIE;
      if (owner._height >= (isZombie ? zombieQueue._min : dirtyQueue._min)) {
        markNode(c as Computed<any>);
        markHeap(isZombie ? zombieQueue : dirtyQueue);
        updateIfNecessary(owner);
      }
      const height = owner._height;
      // parent check is shallow, might need to be recursive
      if (height >= (c as Computed<any>)._height && (el as Computed<any>)._parent !== c) {
        (c as Computed<any>)._height = height + 1;
      }
    }
  }

  if (owner._statusFlags & STATUS_PENDING) {
    // [react-adapt E5] Two-level suspense rule, generalized from the stock
    // stale-reader escape (which only existed for transition-held nodes,
    // because stock Solid wraps every refetch in an ambient transition). A
    // pending read throws — suspending the reader — only when:
    //   - the read is strict (internal recompute: execute-and-abort), or
    //   - the value has never settled (first load must suspend), or
    //   - the current world IS the transition that caused the refetch (a
    //     React transition render suspends on its own pending work).
    // Otherwise (a stale-posture read of an initialized, refetching value —
    // i.e. a React render in a world that didn't cause the refetch) the read
    // falls through and serves the last committed value: stale content
    // instead of a fallback flash.
    const throwPending =
      !stale ||
      !!(owner._statusFlags & STATUS_UNINITIALIZED) ||
      (!!owner._transition &&
        !!activeTransition &&
        currentTransition(owner._transition) === currentTransition(activeTransition));
    if (c && throwPending) {
      if (__DEV__ && c && c._config & CONFIG_CHILDREN_FORBIDDEN) {
        const message =
          "[PENDING_ASYNC_FORBIDDEN_SCOPE] Reading a pending async value inside createTrackedEffect or onSettled will throw. " +
          "Use createEffect instead which supports async-aware reactivity.";
        emitDiagnostic({
          code: "PENDING_ASYNC_FORBIDDEN_SCOPE",
          kind: "async",
          severity: "warn",
          message,
          ownerId: c.id,
          ownerName: (c as any)._name,
          nodeName: (owner as any)?._name
        });
        console.warn(message);
      }
      if (currentOptimisticLane) {
        // Per-lane suspension: only throw if in same lane as pending async
        // AND the node doesn't have an active override (overrides are the visible value,
        // downstream in the lane should read the override, not throw)
        const pendingLane = (owner as any)._optimisticLane;
        const lane = findLane(currentOptimisticLane);
        if (pendingLane && findLane(pendingLane) === lane && !hasActiveOverride(owner)) {
          if (!tracking && el !== c) link(el, c as Computed<any>);
          throw owner._error;
        }
      } else {
        if (!tracking && el !== c) link(el, c as Computed<any>);
        throw owner._error;
      }
    } else if (c && owner !== el && owner._statusFlags & STATUS_UNINITIALIZED) {
      if (!tracking && el !== c) link(el, c as Computed<any>);
      throw owner._error;
    } else if (!c && owner._statusFlags & STATUS_UNINITIALIZED) {
      throw owner._error;
    }
  }
  if ((el as Computed<any>)._fn && (el as Computed<any>)._statusFlags & STATUS_ERROR) {
    // Only a genuine reactive re-read may retry an errored async source:
    // - tracking: owned/tracked scope only (never events / `untrack` / effect side-effect phase)
    // - !pendingCheckActive: an `isPending` probe observes the error, never refetches
    // - el._time < clock: only on a later cycle than the one the error was found
    if (tracking && !pendingCheckActive && el._time < clock) {
      recompute(el as Computed<unknown>);
      return read(el);
    } else throw (el as Computed<any>)._error;
  }

  if (snapshotCaptureActive && c && (c as Computed<any>)._config & CONFIG_IN_SNAPSHOT_SCOPE) {
    const sv = el._snapshotValue;
    if (sv !== undefined) {
      const snapshot = sv === NO_SNAPSHOT ? undefined : sv;
      const current = el._pendingValue !== NOT_PENDING ? el._pendingValue : el._value;
      if (current !== snapshot) (c as Computed<any>)._flags |= REACTIVE_SNAPSHOT_STALE;
      return snapshot as T;
    }
  }

  if (__DEV__ && strictRead) {
    const message =
      `[STRICT_READ_UNTRACKED] Reactive value read directly in ${strictRead} will not update. ` +
      `Move it into a tracking scope (JSX, a memo, or an effect's compute function).`;
    emitDiagnostic({
      code: "STRICT_READ_UNTRACKED",
      kind: "strict-read",
      severity: "warn",
      message,
      ownerId: c?.id,
      ownerName: (c as any)?._name,
      nodeName: (owner as any)?._name,
      data: { strictRead }
    });
    console.warn(message);
  }

  if (el._overrideValue !== undefined && el._overrideValue !== NOT_PENDING) {
    if (c && stale && shouldReadStashedOptimisticValue(el as Signal<any>)) return el._value as T;
    return el._overrideValue as T;
  }

  // Entanglement gate: a reader recomputing under an optimistic lane that reads
  // a pending mid-transition write sees the committed value. Projection-store
  // manual writes use the firewall's manual-write flag to opt into this path.
  // Async drivers are not under an optimistic lane and so bypass this, reading
  // _pendingValue for correct fetching. The sub is recorded for replay at commit
  // so it re-runs with the new committed view.
  if (
    activeTransition !== null &&
    currentOptimisticLane !== null &&
    !latestReadActive &&
    el._pendingValue !== NOT_PENDING &&
    (owner === el || !!((owner as Computed<unknown>)._flags & REACTIVE_MANUAL_WRITE)) &&
    !(el as Partial<Computed<unknown>>)._fn &&
    c
  ) {
    activeTransition._gatedSubs.add(c as Computed<any>);
    return el._value as T;
  }

  // In optimistic lane context, return _value for optimistic/lane-assigned signals
  // and for regular signals in stale mode (render effects). Non-stale readers (user
  // effects) see _pendingValue so that latest() and direct reads stay consistent.
  // Exception: resolved projection store properties (firewall, owner !== el) whose
  // STATUS_PENDING has been cleared always return _pendingValue.
  // [react-adapt E5] Outside any tracking scope, reads resolve the committed
  // world — with one exception: code running inside the very scope that
  // staged a value (the startTransition callback or async-action continuation
  // that wrote it) reads its own draft back. The bridge resolves the ambient
  // scope's world through React's write-batch probe; every other
  // outside-render read stays committed-only (README: "Which world does a
  // read see?").
  if (
    c === null &&
    ambientWorldResolver !== null &&
    el._pendingValue !== NOT_PENDING &&
    el._transition &&
    isTransitionLive(el._transition)
  ) {
    const scope = ambientWorldResolver();
    if (scope !== null && currentTransition(el._transition) === scope) {
      return el._pendingValue as T;
    }
  }

  // [react-adapt E9] world selection resolves merged transitions: a stale
  // (React render) reader sees a staged value only when the current render
  // world is the transition holding it.
  const value =
    !c ||
    (currentOptimisticLane !== null &&
      (el._overrideValue !== undefined ||
        (el as any)._optimisticLane ||
        (owner === el && stale) ||
        !!(owner._statusFlags & STATUS_PENDING))) ||
    el._pendingValue === NOT_PENDING ||
    (stale &&
      el._transition &&
      isTransitionLive(el._transition) &&
      (!activeTransition || currentTransition(el._transition) !== currentTransition(activeTransition)))
      ? el._value
      : (el._pendingValue as T);
  if (
    !c &&
    owner === el &&
    typeof computed._fn === "function" &&
    el._config & CONFIG_AUTO_DISPOSE &&
    !(owner._statusFlags & STATUS_PENDING) &&
    !el._subs
  ) {
    unobserved(el as Computed<unknown>);
  }
  // [react-adapt E13] render-pass value pinning (render-probe reads only)
  if (c !== null && renderValueInterceptor !== null && (c as any)._isRenderProbe === true) {
    return renderValueInterceptor(el, value) as T;
  }
  return value;
}

export function setSignal<T>(el: Signal<T> | Computed<T>, v: T | ((prev: T) => T)): T {
  if (
    __DEV__ &&
    !(el._config & CONFIG_OWNED_WRITE) &&
    !(context && context._config & CONFIG_CHILDREN_FORBIDDEN) &&
    context &&
    (el as FirewallSignal<any>)._firewall !== context
  ) {
    emitDiagnostic({
      code: "REACTIVE_WRITE_IN_OWNED_SCOPE",
      kind: "write",
      severity: "error",
      message: REACTIVE_WRITE_IN_OWNED_SCOPE_SIGNAL_MESSAGE,
      ownerId: context.id,
      ownerName: (context as any)._name,
      nodeName: (el as any)._name,
      data: { operation: "setSignal" }
    });
    throw new Error(REACTIVE_WRITE_IN_OWNED_SCOPE_SIGNAL_MESSAGE);
  }

  // [react-adapt E3] The bridge-installed router classifies this write by
  // asking React which batch it belongs to: a deferred (transition) write
  // activates that batch's Solid transition around the write so staging
  // routes into it; an urgent write leaves the ambient world untouched. The
  // returned closure restores the previous ambient world.
  const restoreWorld = writeRouter !== null ? writeRouter(el) : undefined;
  try {
    if (el._transition && isTransitionLive(el._transition)) {
      if (activeTransition) {
        // A deferred write to a node held by another live transition
        // entangles the two worlds (they now share staged state).
        if (currentTransition(el._transition) !== activeTransition)
          globalQueue.initTransition(el._transition);
      } else if (el._overrideValue === undefined) {
        // [react-adapt E3] Urgent write to a transition-held node: React
        // lane semantics. The urgent update must be visible in the committed
        // world NOW, and the pending transition must rebase on top of it —
        // the same arrival-order updater fold React's own update queue
        // performs. Both value channels are written; subscribers re-enter
        // the transition (E9 world stamp from `el._transition`) so the
        // staged cone rebases. Known gap: memo *committed* copies over this
        // node stay stale until the transition commits.
        const committedPrev = el._value;
        const stagedPrev = el._pendingValue === NOT_PENDING ? el._value : (el._pendingValue as T);
        const next =
          typeof v === "function"
            ? {
                committed: (v as (prev: T) => T)(committedPrev),
                staged: (v as (prev: T) => T)(stagedPrev)
              }
            : { committed: v, staged: v };
        el._value = next.committed;
        el._pendingValue = next.staged;
        if (el._pendingSignal) updatePendingSignal(el);
        if (el._latestValueComputed) setSignal(el._latestValueComputed, next.staged);
        el._time = clock;
        insertSubs(el);
        // The cone's normal recompute refreshes only the staged world (E9);
        // the committed-world shadow refresh runs NOW — React's discrete
        // render fires at the end of this event, before any flush, and must
        // not paint this signal's fresh committed value beside stale memos.
        refreshCommittedCone([el]);
        schedule();
        return next.committed;
      }
    }

    return setSignalStock(el, v);
  } finally {
    restoreWorld?.();
  }
}

// [react-adapt E3] Classification hook installed by the React bridge. Called
// at the top of every setSignal; may activate a transition for the write and
// must return a closure restoring the previous ambient world (or nothing).
export type WriteRouter = (el: Signal<any> | Computed<any>) => (() => void) | undefined | void;
let writeRouter: WriteRouter | null = null;
export function setWriteRouter(router: WriteRouter | null): void {
  writeRouter = router;
}

// [react-adapt E5] Resolves the transition world of the ambient (non-render)
// scope, if any — how an untracked read inside a startTransition callback
// sees the scope's own staged writes. Installed by the React bridge.
export type AmbientWorldResolver = () => Transition | null;
let ambientWorldResolver: AmbientWorldResolver | null = null;
export function setAmbientWorldResolver(resolver: AmbientWorldResolver | null): void {
  ambientWorldResolver = resolver;
}

// [react-adapt E13] Per-render-pass value pinning. React time-slices a
// concurrent render pass; the engine's flushes keep committing urgent writes
// between slices, so two components reading the same node in different
// slices could paint different values in ONE committed frame (tearing). The
// bridge pins each node's first-read value for the lifetime of the pass;
// the commit-time fixup then corrects any staleness pre-paint. Consulted
// only for render-probe reads (see reader.ts).
export type RenderValueInterceptor = (
  el: Signal<any> | Computed<any>,
  value: unknown
) => unknown;
let renderValueInterceptor: RenderValueInterceptor | null = null;
export function setRenderValueInterceptor(interceptor: RenderValueInterceptor | null): void {
  renderValueInterceptor = interceptor;
}

function setSignalStock<T>(el: Signal<T> | Computed<T>, v: T | ((prev: T) => T)): T {
  const isOptimistic = el._overrideValue !== undefined && !projectionWriteActive;
  const hasOverride = el._overrideValue !== undefined && el._overrideValue !== NOT_PENDING;
  const currentValue = isOptimistic
    ? hasOverride
      ? (el._overrideValue as T)
      : el._value
    : el._pendingValue === NOT_PENDING
      ? el._value
      : (el._pendingValue as T);

  if (typeof v === "function") v = (v as (prev: T) => T)(currentValue);

  const valueChanged =
    !el._equals ||
    !el._equals(currentValue, v) ||
    !!((el as Computed<T>)._statusFlags & STATUS_UNINITIALIZED);
  if (!valueChanged) {
    // Re-propagate for optimistic computeds with active override — downstream
    // nodes may have stale _inFlight based on old upstream data.
    if (isOptimistic && hasOverride) {
      const transition = resolveTransition(el as any);
      if (transition && activeTransition !== transition) globalQueue.initTransition(transition);
      if ((el as Computed<T>)._fn) {
        insertSubs(el, true);
        schedule();
      }
    }
    return v;
  }

  if (isOptimistic) {
    const firstOverride = el._overrideValue === NOT_PENDING;
    if (!firstOverride) globalQueue.initTransition(resolveTransition(el as any));
    if (firstOverride) {
      el._pendingValue = el._value;
      // [react-adapt E8] register with the world that created the override
      registerOptimisticNode(el);
    }

    (el as any)._overrideSinceLane = true;

    const lane = getOrCreateLane(el);
    el._optimisticLane = lane;

    el._overrideValue = v;
  } else {
    if (el._pendingValue === NOT_PENDING) queuePendingNode(el);
    el._pendingValue = v;
  }

  // Update pending signal if it exists (for isPending reactivity)
  if (el._pendingSignal) updatePendingSignal(el);

  // Also write to latest value computed if it exists (for latest())
  if (el._latestValueComputed) {
    setSignal(el._latestValueComputed, v);
  }

  el._time = clock;
  insertSubs(el, isOptimistic);
  schedule();
  return v;
}

/**
 * Suppresses automatic recomputation of `el` until the scheduler drains. Used
 * when a manual write should win over dependency changes queued in the same
 * tick. The MANUAL_WRITE flag is cleared by the pending-node drain; projection
 * computeds don't commit values, but they still need the same end-of-tick
 * cleanup point.
 */
export function suppressComputedRecompute(el: Computed<unknown>): void {
  deleteFromHeap(el, el._flags & REACTIVE_ZOMBIE ? zombieQueue : dirtyQueue);
  if (!(el._flags & REACTIVE_MANUAL_WRITE) && el._pendingValue === NOT_PENDING) {
    queuePendingNode(el);
    schedule();
  }
  el._flags = (el._flags & ~(REACTIVE_DIRTY | REACTIVE_CHECK)) | REACTIVE_MANUAL_WRITE;
}

/**
 * User-facing setter for the memo form of `createSignal(fn)`. Behaves like
 * `setSignal`, but also cancels any pending recompute of the memo so the
 * manual value wins over a value that would otherwise be produced by an
 * upstream change in the same tick.
 */
export function setMemo<T>(el: Computed<T>, v: T | ((prev: T) => T)): T {
  const result = setSignal(el, v);
  suppressComputedRecompute(el as Computed<unknown>);
  return result;
}

/**
 * Executes `fn` with the given `owner` set as the current owner. Any reactive
 * primitives (`createSignal`, `createMemo`, `createEffect`, `onCleanup`,
 * `cleanup`, etc.) created inside `fn` are attached to that owner, so they
 * are disposed when the owner is disposed.
 *
 * The classic pattern: capture the current owner with `getOwner()` inside a
 * component, then re-enter it from a callback (event handler, async resolve,
 * setTimeout) so disposables created in the callback get cleaned up with the
 * component.
 *
 * @example
 * ```ts
 * function delayed<T>(ms: number, fn: () => T) {
 *   const owner = getOwner();
 *   setTimeout(() => runWithOwner(owner, fn), ms);
 * }
 * ```
 */
export function runWithOwner<T>(owner: Owner | null, fn: () => T): T {
  if (__DEV__ && owner && (owner as any)._flags & REACTIVE_DISPOSED) {
    const message =
      "[RUN_WITH_DISPOSED_OWNER] runWithOwner called with a disposed owner. Children created inside will never be disposed.";
    emitDiagnostic({
      code: "RUN_WITH_DISPOSED_OWNER",
      kind: "owner",
      severity: "warn",
      message,
      ownerId: owner.id,
      ownerName: (owner as any)._name
    });
    console.warn(message);
  }
  const oldContext = context;
  const prevTracking = tracking;
  context = owner;
  tracking = false;
  try {
    return fn();
  } finally {
    context = oldContext;
    tracking = prevTracking;
  }
}

/**
 * Get or create the pending signal for a node (lazy).
 * Used by isPending() to track pending state reactively.
 */
function getPendingSignal(el: Signal<any> | Computed<any>): Signal<boolean> {
  if (!el._pendingSignal) {
    // [react-adapt E1] Stock Solid backs isPending with an *optimistic*
    // signal whose override rides the ambient refetch transition and reverts
    // with it. With ambient transitions disabled, an optimistic override here
    // would revert at the very flush that set it. A plain signal stages and
    // commits like any urgent write and stays true while the source is
    // pending; `resolveOptimisticNodes` re-derives it when overrides revert.
    el._pendingSignal = signal(computePendingState(el), { ownedWrite: true });
    // Propagate parent-child lane relationship for isPending(() => latest(x))
    if (el._parentSource) {
      el._pendingSignal._parentSource = el;
    }
  }
  return el._pendingSignal;
}

function collectPendingSources(el: Signal<any> | Computed<any>): void {
  pendingCheckSources?.add(el);
  const owner = (el as FirewallSignal<any>)._firewall || el;
  if (owner !== el) pendingCheckSources?.add(owner);
}

/**
 * Compute whether a node is in "pending" state.
 * Pending means: has stale data while new data is loading.
 * Returns false for initial async loads (no stale data to show).
 */
function computePendingState(el: Signal<any> | Computed<any>): boolean {
  const comp = el as Computed<any>;
  const firewall = (el as FirewallSignal<any>)._firewall;
  if (el._parentSource) {
    const parent = el._parentSource as Computed<any>;
    if (parent._statusFlags & STATUS_PENDING && !(parent._statusFlags & STATUS_UNINITIALIZED))
      return true;
    return el._pendingValue !== NOT_PENDING && !(comp._statusFlags & STATUS_UNINITIALIZED);
  }
  if (firewall && el._pendingValue !== NOT_PENDING) {
    return (
      !!(firewall._flags & REACTIVE_MANUAL_WRITE) ||
      (!firewall._inFlight && !(firewall._statusFlags & STATUS_PENDING))
    );
  }
  // Optimistic nodes with active override:
  if (el._overrideValue !== undefined && el._overrideValue !== NOT_PENDING) {
    if (comp._statusFlags & STATUS_PENDING && !(comp._statusFlags & STATUS_UNINITIALIZED))
      return true;
    // Internal pending/latest helpers carry `_parentSource`; user-created
    // optimistic nodes just stay pending while the override is active.
    if (el._parentSource) {
      const lane = el._optimisticLane ? findLane(el._optimisticLane) : null;
      return !!(lane && lane._pendingAsync.size > 0);
    }
    return true;
  }
  // Upstream: value held in transition (not during initial load). Excluded for a
  // *resting* optimistic node (`_overrideValue === NOT_PENDING`, no active override):
  // its held `_pendingValue` belongs to a reverting optimistic write, not a refetch, so
  // it must not read as pending. Muting pending is the job of an active override; a
  // resting optimistic node otherwise behaves like a plain async memo and reports
  // pending only via the downstream async-in-flight check below (#2799).
  if (
    el._overrideValue !== NOT_PENDING &&
    el._pendingValue !== NOT_PENDING &&
    !(comp._statusFlags & STATUS_UNINITIALIZED)
  )
    return true;
  // Downstream: async in flight with previous value (not initial load)
  // STATUS_UNINITIALIZED is cleared on first successful completion
  return !!(comp._statusFlags & STATUS_PENDING && !(comp._statusFlags & STATUS_UNINITIALIZED));
}

/**
 * Update _pendingSignal when pending state changes. When the override clears
 * (pending -> not pending), merge the sub-lane into the source's lane so
 * isPending effects are blocked until the full scope resolves.
 */
export function updatePendingSignal(el: Signal<any> | Computed<any>): void {
  if (el._pendingSignal) {
    const pending = computePendingState(el);
    const sig = el._pendingSignal;
    // [react-adapt E1] Pending indicators are urgent state. Stock Solid
    // flushed them through independent child lanes precisely so isPending
    // updates never wait for the transition holding the source; here the
    // write leaves the ambient world so it stages urgently and commits at
    // the next flush even while the source's transition stays parked.
    const prevWorld = activeTransition;
    if (prevWorld) setActiveTransition(null);
    try {
      setSignal(sig, pending);
    } finally {
      if (prevWorld) setActiveTransition(currentTransition(prevWorld));
    }
    // When override clears: merge sub-lane into source's lane
    if (!pending && sig._optimisticLane) {
      const sourceLane = resolveLane(el as any);
      if (sourceLane && sourceLane._pendingAsync.size > 0) {
        const sigLane = findLane(sig._optimisticLane);
        if (sigLane !== sourceLane) {
          mergeLanes(sourceLane, sigLane);
        }
      }
      // Clear so next write creates a fresh independent sub-lane
      signalLanes.delete(sig);
      sig._optimisticLane = undefined;
    }
  }
}

/**
 * Get or create the latest value computed for a node (lazy).
 * Used by latest() to read the in-flight value during a transition.
 */
function getLatestValueComputed<T>(el: Signal<T> | Computed<T>): Computed<T> {
  if (!el._latestValueComputed) {
    // Save and restore context flags to prevent leaking isPending/latest
    // context into the computed's initial recompute.
    const prevPending = latestReadActive;
    latestReadActive = false;
    const prevCheck = pendingCheckActive;
    pendingCheckActive = false;
    const prevContext = context;
    context = null; // Detach from owner so it isn't disposed with effects
    el._latestValueComputed = optimisticComputed(() => read(el));
    el._latestValueComputed._parentSource = el; // Parent-child lane relationship
    context = prevContext;
    pendingCheckActive = prevCheck;
    latestReadActive = prevPending;
  }
  return el._latestValueComputed;
}

export function staleValues<T>(fn: () => T, set = true): T {
  const prevStale = stale;
  stale = set;
  try {
    return fn();
  } finally {
    stale = prevStale;
  }
}

/**
 * Reads reactive expressions while bypassing any pending async overlay — i.e.
 * always returns the most-recently-committed value, even when newer reads
 * inside `fn` are still in flight.
 *
 * Useful inside a `<Loading>` boundary's children when you want to keep
 * showing the previous resolved data instead of the fallback while the next
 * value loads.
 *
 * @example
 * ```tsx
 * <Loading fallback={<Skeleton />}>
 *   {/* During a transition, render the previous user instead of skeleton: *\/}
 *   <UserCard user={latest(() => user())} />
 * </Loading>
 * ```
 */
export function latest<T>(fn: () => T): T {
  const prevLatest = latestReadActive;
  latestReadActive = true;
  try {
    return fn();
  } finally {
    latestReadActive = prevLatest;
  }
}

/**
 * Returns `true` if any reactive read inside `fn` is showing a stale value
 * while newer async work is pending. Does not subscribe — pair with a tracked
 * memo if you want to react to pending status changes.
 *
 * Useful for showing inline transition indicators alongside the previous
 * value (rather than swapping to a `<Loading>` fallback).
 * Because `fn` is read normally, `isPending` participates in Loading/SSR
 * readiness the same way the read itself would.
 *
 * @example
 * ```tsx
 * const pending = createMemo(() => isPending(() => user()));
 *
 * <button disabled={pending()}>{pending() ? "Saving…" : "Save"}</button>
 *
 * <button disabled={isPending(() => user())}>Save</button>
 * ```
 */
export function isPending(fn: () => any): boolean {
  const prevPendingCheck = pendingCheckActive;
  const prevFoundPending = foundPending;
  const prevPendingCheckSources = pendingCheckSources;
  pendingCheckActive = true;
  foundPending = false;
  pendingCheckSources = new Set();
  const collectPending = () => {
    pendingCheckActive = false;
    const prevStrictRead = __DEV__ ? strictRead : false;
    if (__DEV__) strictRead = false;
    try {
      pendingCheckSources!.forEach(source => {
        if (read(getPendingSignal(source))) foundPending = true;
      });
    } finally {
      if (__DEV__) strictRead = prevStrictRead;
      pendingCheckActive = true;
    }
  };
  try {
    fn();
    collectPending();
    return foundPending;
  } catch (e) {
    collectPending();
    if (e instanceof NotReadyError) {
      if (foundPending && !(e.source?._statusFlags & STATUS_UNINITIALIZED)) return true;
      if (context) throw e;
    }
    // When a thunk throws during pending check (e.g., accessing undefined values
    // from uninitialized async memos), return foundPending. The error indicates
    // we're reading from something not yet ready.
    return foundPending;
  } finally {
    pendingCheckActive = prevPendingCheck;
    foundPending = prevFoundPending;
    pendingCheckSources = prevPendingCheckSources;
  }
}

/**
 * Invalidates one reactive source, forcing it to re-execute even if its inputs
 * haven't changed.
 *
 * Pass either a Solid-created accessor or a projected store created from
 * `createStore(fn, ...)` / `createProjection(...)`. `refresh()` is a
 * write-like invalidation operation: it does not read the target's value, and
 * refreshing a plain signal accessor is a no-op.
 *
 * Use it to invalidate cached async values (e.g. force a re-fetch) without
 * tearing the consumer down.
 *
 * @example
 * ```ts
 * const user = createMemo(async () => fetch(`/users/${id()}`).then(r => r.json()));
 *
 * // Re-fetch on demand
 * <button onClick={() => refresh(user)}>Reload</button>
 * ```
 */
export function refresh<T>(target: Refreshable<T>): void {
  const node = (target as any)?.[$REFRESH] as Computed<any> | undefined;
  if (!node) {
    if (__DEV__) {
      const message =
        "[INVALID_REFRESH_TARGET] refresh() expects a Solid source accessor or refreshable store. " +
        "Pass the original source target, not a wrapper function or derived property read.";
      emitDiagnostic({
        code: "INVALID_REFRESH_TARGET",
        kind: "write",
        severity: "error",
        message
      });
      throw new Error(message);
    }
    return;
  }
  if (
    __DEV__ &&
    context &&
    !((node._config ?? 0) & CONFIG_OWNED_WRITE) &&
    !(context._config & CONFIG_CHILDREN_FORBIDDEN)
  ) {
    emitDiagnostic({
      code: "REACTIVE_WRITE_IN_OWNED_SCOPE",
      kind: "write",
      severity: "error",
      message: REACTIVE_WRITE_IN_OWNED_SCOPE_REFRESH_MESSAGE,
      ownerId: context.id,
      ownerName: (context as any)._name,
      nodeName: (node as any)._name,
      data: { operation: "refresh" }
    });
    throw new Error(REACTIVE_WRITE_IN_OWNED_SCOPE_REFRESH_MESSAGE);
  }
  if (
    typeof node._fn === "function" &&
    !(node._flags & (REACTIVE_DISPOSED | REACTIVE_MANUAL_WRITE))
  ) {
    // [react-adapt E3] refresh() is write-like, so it classifies like a
    // write: a refresh inside startTransition must refetch in that batch's
    // world so the transition is held until the new data lands. The actual
    // recompute happens at flush time, after the ambient scope is gone, so
    // the world rides the node's re-entry mark (E9) rather than the scope.
    const restoreWorld = writeRouter !== null ? writeRouter(node) : undefined;
    try {
      if (activeTransition) node._reentryWorld = activeTransition;
      node._flags = (node._flags & ~REACTIVE_CHECK) | REACTIVE_DIRTY;
      insertIntoHeap(node, node._flags & REACTIVE_ZOMBIE ? zombieQueue : dirtyQueue);
      schedule();
    } finally {
      restoreWorld?.();
    }
  }
}
