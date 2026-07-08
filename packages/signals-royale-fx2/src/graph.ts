/**
 * The canonical reactive graph: writable signals, cached computeds, effects.
 *
 * Design notes
 *
 * - Push-pull: writes push a small "dirty" wave through WATCHED edges only;
 *   reads pull values and validate caches by comparing per-edge version
 *   numbers. A computed recomputes only when some dependency's version
 *   actually advanced, which is what gives exact evaluation counts and
 *   equality cutoff.
 * - Watched vs unwatched: a computed is linked into its dependencies'
 *   subscriber lists only while something observes it (an effect chain, a
 *   React subscription, or another watched computed). An unwatched computed
 *   holds references dependency-ward only, so dropping the last user
 *   reference makes the whole chain collectible — no registry needed for
 *   reads. Unwatched computeds validate lazily on read using a global write
 *   epoch.
 * - Effects are the only long-lived graph roots a user can leak by dropping
 *   the disposer without calling it; a FinalizationRegistry on the disposer
 *   reclaims those.
 */

export type EqualsFn<T> = (a: T, b: T) => boolean;
/** Monotonic count of canonical writes; validation shortcut for unwatched reads. */
export type WriteEpoch = number;
/** Per-node value generation; an edge is fresh while its snapshot matches. */
export type NodeVersion = number;
export type TraceEventId = number;

/** Node staleness. Kept as erasable-syntax consts (a const object, not a
 * const enum) so the TS source runs directly under node's type stripping. */
export type Flags = 0 | 1 | 2;
export const Flags = {
  Clean: 0,
  Check: 1,
  Dirty: 2,
} as const satisfies Record<string, Flags>;

export interface Link {
  dep: ReactiveNode;
  sub: ReactiveNode;
  /** dep.version captured when sub last used this edge's value. */
  version: NodeVersion;
  nextDep: Link | undefined;
  prevSub: Link | undefined;
  nextSub: Link | undefined;
  /** Present in dep's subscriber list (only while sub is watched). */
  inSubs: boolean;
  /** Eval-generation stamp: marks the edge as re-read by the current run. */
  stamp: number;
}

export interface ReactiveNode {
  kind: 'cell' | 'derived' | 'watcher';
  flags: Flags;
  version: NodeVersion;
  /** Subscriber list (watched edges + leaf observers). */
  subs: Link | undefined;
  subsTail: Link | undefined;
  /** Dependency list in first-read order (derived/watcher only). */
  deps: Link | undefined;
  depsTail: Link | undefined;
  /** Count of observers: watched sub-links, effects, React subscriptions. */
  observerCount: number;
  /** WriteEpoch at last successful validation (unwatched fast path). */
  validatedEpoch: WriteEpoch;
  /** Trace: event that caused the latest invalidation reaching this node. */
  causeEvent: TraceEventId;
  label: string | undefined;
  /** World-resolution memos, managed by worlds.ts; null while quiescent. */
  worldMemos: Map<string, unknown> | null;
  /**
   * Subscription epoch for React: advances exactly when committed-view
   * subscribers must re-render — urgent canonical changes, settlements,
   * rollbacks. Draft folds advance it ONLY when no render pass carried the
   * draft (see worlds.retireDraft): folds whose values were already
   * delivered through render-pass worlds stay silent here, which is what
   * keeps a transition commit from triggering a synchronous repair render
   * of every subscriber.
   */
  reactEpoch: number;
}

let writeEpoch: WriteEpoch = 1;
let evalStamp = 1;
let activeConsumer: ReactiveNode | null = null;
let batchDepth = 0;

/** Bumped and read by the engine layer; here so cells can report writes. */
export function currentWriteEpoch(): WriteEpoch {
  return writeEpoch;
}

// ---------------------------------------------------------------------------
// Hooks the engine layer installs (worlds, lifetime, tracing). Kept as
// mutable module bindings so the graph itself stays dependency-free.
// ---------------------------------------------------------------------------

export interface GraphHooks {
  /** Return a draft sink for this write, or null for a canonical write. */
  classifyWrite: ((cell: CellNode<unknown>) => boolean) | null;
  /** Observation count moved 0->1 (true) or 1->0 (false). */
  observation: ((node: ReactiveNode, on: boolean) => void) | null;
  /** A canonical write/invalidations wave finished propagating. */
  afterPropagate: ((marked: ReactiveNode[]) => void) | null;
  trace:
    | ((kind: string, node: ReactiveNode | null, cause: TraceEventId, data?: unknown) => TraceEventId)
    | null;
}

export const hooks: GraphHooks = {
  classifyWrite: null,
  observation: null,
  afterPropagate: null,
  trace: null,
};

export const NO_EVENT: TraceEventId = 0;
/** Ambient causal parent for the operation in progress (write/effect/settle). */
export let currentCause: TraceEventId = NO_EVENT;
export function setCurrentCause(id: TraceEventId): TraceEventId {
  const prev = currentCause;
  currentCause = id;
  return prev;
}

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

const UNINITIALIZED = Symbol('uninitialized');

export interface CellNode<T> extends ReactiveNode {
  kind: 'cell';
  value: T | typeof UNINITIALIZED;
  initializer: (() => T) | undefined;
  equals: EqualsFn<T>;
  lifetime: ((ctx: { get(): T; set(v: T): void }) => void | (() => void)) | undefined;
  lifetimeCleanup: (() => void) | undefined;
  lifetimeActive: boolean;
  lifetimePending: boolean;
}

export interface DerivedNode<T> extends ReactiveNode {
  kind: 'derived';
  value: T | typeof UNINITIALIZED;
  fn: (use: UseFn) => T;
  equals: EqualsFn<T>;
  computing: boolean;
  /** Async state managed by asyncs.ts; null while the value is plain. */
  asyncState: unknown;
  /** Hidden refresh input; created on first refresh(x). */
  refreshNonce: CellNode<number> | undefined;
}

export interface WatcherNode extends ReactiveNode {
  kind: 'watcher';
  fn: (() => void | (() => void)) | undefined;
  cleanup: (() => void) | undefined;
  scheduled: boolean;
  disposed: boolean;
  /** Owner scope; disposing the scope disposes the watcher. */
  children: WatcherNode[] | undefined;
  onNotify: (() => void) | undefined;
}

export type UseFn = <U>(t: PromiseLike<U>) => U;

export function defaultEquals<T>(a: T, b: T): boolean {
  return Object.is(a, b);
}

export function makeCell<T>(
  initial: T | (() => T),
  opts?: {
    equals?: EqualsFn<T>;
    label?: string;
    onObserved?: (ctx: { get(): T; set(v: T): void }) => void | (() => void);
    lazy?: boolean;
  },
): CellNode<T> {
  const lazyInit = typeof initial === 'function' && opts?.lazy !== false;
  return {
    kind: 'cell',
    flags: Flags.Clean,
    version: 1,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    observerCount: 0,
    validatedEpoch: 0,
    causeEvent: NO_EVENT,
    label: opts?.label,
    value: lazyInit ? UNINITIALIZED : (initial as T),
    initializer: lazyInit ? (initial as () => T) : undefined,
    equals: opts?.equals ?? defaultEquals,
    lifetime: opts?.onObserved,
    lifetimeCleanup: undefined,
    lifetimeActive: false,
    lifetimePending: false,
    worldMemos: null,
    reactEpoch: 1,
  };
}

export function makeDerived<T>(
  fn: (use: UseFn) => T,
  opts?: { equals?: EqualsFn<T>; label?: string },
): DerivedNode<T> {
  return {
    kind: 'derived',
    flags: Flags.Dirty,
    version: 0,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    observerCount: 0,
    validatedEpoch: 0,
    causeEvent: NO_EVENT,
    label: opts?.label,
    value: UNINITIALIZED,
    fn,
    equals: opts?.equals ?? defaultEquals,
    computing: false,
    asyncState: null,
    refreshNonce: undefined,
    worldMemos: null,
    reactEpoch: 1,
  };
}

// ---------------------------------------------------------------------------
// Dependency linking
// ---------------------------------------------------------------------------

function linkIntoSubs(link: Link): void {
  if (link.inSubs) return;
  link.inSubs = true;
  const dep = link.dep;
  link.prevSub = dep.subsTail;
  link.nextSub = undefined;
  if (dep.subsTail !== undefined) dep.subsTail.nextSub = link;
  else dep.subs = link;
  dep.subsTail = link;
}

function unlinkFromSubs(link: Link): void {
  if (!link.inSubs) return;
  link.inSubs = false;
  const dep = link.dep;
  if (link.prevSub !== undefined) link.prevSub.nextSub = link.nextSub;
  else dep.subs = link.nextSub;
  if (link.nextSub !== undefined) link.nextSub.prevSub = link.prevSub;
  else dep.subsTail = link.prevSub;
  link.prevSub = undefined;
  link.nextSub = undefined;
}

/** Add one observer to a node, propagating watch state into a derived's deps. */
export function addObserver(node: ReactiveNode): void {
  node.observerCount++;
  if (node.observerCount === 1) {
    if (node.kind === 'derived') {
      for (let l = node.deps; l !== undefined; l = l.nextDep) {
        linkIntoSubs(l);
        addObserver(l.dep);
      }
    }
    hooks.observation?.(node, true);
  }
}

export function removeObserver(node: ReactiveNode): void {
  node.observerCount--;
  if (node.observerCount === 0) {
    if (node.kind === 'derived') {
      for (let l = node.deps; l !== undefined; l = l.nextDep) {
        unlinkFromSubs(l);
        removeObserver(l.dep);
      }
      // An unwatched cache can no longer trust push marks; force lazy
      // revalidation on the next read.
      if (node.flags === Flags.Clean) node.flags = Flags.Check;
      node.validatedEpoch = 0;
    }
    hooks.observation?.(node, false);
  }
}

/** Record "sub read dep" for the eval in progress, reusing edges in place. */
function trackRead(dep: ReactiveNode, sub: ReactiveNode): Link {
  const tail = sub.depsTail;
  if (tail !== undefined && tail.dep === dep && tail.stamp === evalStamp) return tail;
  const next = tail === undefined ? sub.deps : tail.nextDep;
  if (next !== undefined && next.dep === dep) {
    next.stamp = evalStamp;
    sub.depsTail = next;
    return next;
  }
  const link: Link = {
    dep,
    sub,
    version: 0,
    nextDep: next,
    prevSub: undefined,
    nextSub: undefined,
    inSubs: false,
    stamp: evalStamp,
  };
  if (tail === undefined) sub.deps = link;
  else tail.nextDep = link;
  sub.depsTail = link;
  const watched = sub.kind === 'watcher' ? !(sub as WatcherNode).disposed : sub.observerCount > 0;
  if (watched) {
    linkIntoSubs(link);
    addObserver(dep);
  }
  return link;
}

/** Drop dependency edges not re-read by the eval that just finished. */
function trimDeps(sub: ReactiveNode): void {
  const tail = sub.depsTail;
  let stale = tail === undefined ? sub.deps : tail.nextDep;
  if (tail !== undefined) tail.nextDep = undefined;
  else sub.deps = undefined;
  while (stale !== undefined) {
    const next = stale.nextDep;
    if (stale.inSubs) {
      unlinkFromSubs(stale);
      removeObserver(stale.dep);
    }
    stale.nextDep = undefined;
    stale = next;
  }
}

// ---------------------------------------------------------------------------
// Invalidation (push through watched edges)
// ---------------------------------------------------------------------------

const watcherQueue: WatcherNode[] = [];
/** Leaf observers marked by the current wave; reported to afterPropagate. */
const markedLeaves: ReactiveNode[] = [];

/** While true, canonical changes do not advance reactEpoch (a silent draft
 * fold: render-pass worlds already delivered these values). */
let reactEpochSuppressed = false;

export function withSuppressedReactEpoch<T>(fn: () => T): T {
  const prev = reactEpochSuppressed;
  reactEpochSuppressed = true;
  try {
    return fn();
  } finally {
    reactEpochSuppressed = prev;
  }
}

export function bumpReactEpoch(node: ReactiveNode): void {
  node.reactEpoch++;
}

/**
 * Invalidation marks are always Check ("possibly stale"): consumers confirm
 * against dependency VERSIONS before recomputing or re-running. Versions —
 * not marks — are the recompute trigger, which is what makes write-then-
 * revert inside a batch a true no-op.
 */
function mark(node: ReactiveNode, cause: TraceEventId): void {
  if (node.flags !== Flags.Clean) {
    if (node.kind === 'watcher' && !(node as WatcherNode).scheduled) {
      scheduleWatcher(node as WatcherNode);
    }
    return;
  }
  node.flags = Flags.Check;
  node.causeEvent = cause;
  if (node.kind === 'watcher') {
    scheduleWatcher(node as WatcherNode);
    return;
  }
  if (node.kind === 'derived') {
    if (!reactEpochSuppressed) node.reactEpoch++;
    for (let l = node.subs; l !== undefined; l = l.nextSub) {
      mark(l.sub, cause);
    }
  }
}

function scheduleWatcher(w: WatcherNode): void {
  if (w.scheduled || w.disposed) return;
  w.scheduled = true;
  if (w.onNotify !== undefined) {
    markedLeaves.push(w);
  } else {
    watcherQueue.push(w);
  }
}

/** Push a change wave from a cell whose canonical value advanced. */
export function propagateFrom(cell: CellNode<unknown>, cause: TraceEventId): void {
  for (let l = cell.subs; l !== undefined; l = l.nextSub) {
    mark(l.sub, cause);
  }
  if (batchDepth === 0) flush();
}

/**
 * Invalidate a derived from outside the dependency graph (thenable
 * settlement, refresh). Treated exactly like a write: the version advances
 * so downstream validation re-pulls, subscribers get marked, effects run.
 */
export function invalidateDerived(node: DerivedNode<unknown>, cause: TraceEventId): void {
  writeEpoch++;
  node.flags = Flags.Dirty;
  node.causeEvent = cause;
  node.version++;
  node.reactEpoch++;
  for (let l = node.subs; l !== undefined; l = l.nextSub) {
    mark(l.sub, cause);
  }
  if (batchDepth === 0) flush();
}

/** Notify leaf observers of a node without touching canonical state (draft
 * activity: ops appended or a draft discarded — speculative readers must
 * re-resolve, canonical readers see no change). */
export function pokeLeafObservers(node: ReactiveNode): void {
  for (let l = node.subs; l !== undefined; l = l.nextSub) {
    const sub = l.sub;
    if (sub.kind === 'watcher' && (sub as WatcherNode).onNotify !== undefined) {
      scheduleWatcher(sub as WatcherNode);
      sub.flags = Flags.Dirty;
    }
  }
  if (batchDepth === 0) flush();
}

/** Append a dependency edge outside evaluation (the hidden refresh nonce).
 * The edge participates in watch bookkeeping like any tracked read. */
export function adoptDepLink(dep: ReactiveNode, sub: ReactiveNode): void {
  for (let l = sub.deps; l !== undefined; l = l.nextDep) {
    if (l.dep === dep) return;
  }
  const link: Link = {
    dep,
    sub,
    version: dep.version,
    nextDep: sub.deps,
    prevSub: undefined,
    nextSub: undefined,
    inSubs: false,
    stamp: 0,
  };
  sub.deps = link;
  if (sub.depsTail === undefined) sub.depsTail = link;
  if (sub.observerCount > 0 || (sub.kind === 'watcher' && !(sub as WatcherNode).disposed)) {
    linkIntoSubs(link);
    addObserver(dep);
  }
}

/** Cells written inside the current batch scope, with their pre-batch state:
 * a net-revert restores the version so consumers validate as unchanged. */
const batchBase = new Map<CellNode<unknown>, { value: unknown; version: NodeVersion }>();

export function startBatch(): void {
  batchDepth++;
}

export function endBatch(): void {
  if (batchDepth === 0) throw new Error('endBatch() without a matching startBatch()');
  batchDepth--;
  if (batchDepth === 0) {
    if (batchBase.size > 0) {
      for (const [cell, base] of batchBase) {
        if (cell.value !== UNINITIALIZED && base.value !== UNINITIALIZED) {
          if (cell.equals(cell.value, base.value)) cell.version = base.version;
        }
      }
      batchBase.clear();
    }
    flush();
  }
}

export function batch<T>(fn: () => T): T {
  startBatch();
  try {
    return fn();
  } finally {
    endBatch();
  }
}

let flushing = false;
/** Drain cursor into watcherQueue (index, not shift: the queue can be large
 * and repeated shifts would make wide flushes quadratic). */
let queueHead = 0;

/** Run queued effects until settled, then deliver leaf notifications. A
 * throwing effect aborts the flush; the effects it preempted are skipped
 * (cleared), not left armed for unrelated writes to trigger later. */
export function flush(): void {
  if (flushing) return;
  if (watcherQueue.length === 0 && markedLeaves.length === 0) return;
  flushing = true;
  try {
    let guard = 0;
    while (queueHead < watcherQueue.length) {
      if (++guard > 100000) throw new Error('effect flush did not settle (cycle?)');
      const w = watcherQueue[queueHead++];
      w.scheduled = false;
      if (w.disposed || w.flags === Flags.Clean) continue;
      runWatcher(w);
    }
    watcherQueue.length = 0;
    queueHead = 0;
  } catch (e) {
    for (let i = queueHead; i < watcherQueue.length; i++) {
      const w = watcherQueue[i];
      w.scheduled = false;
      w.flags = Flags.Clean;
    }
    watcherQueue.length = 0;
    queueHead = 0;
    throw e;
  } finally {
    flushing = false;
    if (markedLeaves.length > 0) {
      const leaves = markedLeaves.splice(0, markedLeaves.length);
      for (const leaf of leaves) {
        const w = leaf as WatcherNode;
        w.scheduled = false;
        w.flags = Flags.Clean;
      }
      hooks.afterPropagate?.(leaves);
      for (const leaf of leaves) {
        const w = leaf as WatcherNode;
        if (!w.disposed) w.onNotify?.();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reads and validation (pull)
// ---------------------------------------------------------------------------

export class WriteForbiddenError extends Error {}
let writesForbidden: string | null = null;

function materializeCell<T>(cell: CellNode<T>): void {
  if (cell.value !== UNINITIALIZED) return;
  const init = cell.initializer!;
  cell.initializer = undefined;
  const prevConsumer = activeConsumer;
  const prevForbidden = writesForbidden;
  activeConsumer = null;
  writesForbidden = 'a lazy state initializer must not write to other state';
  try {
    cell.value = init();
  } finally {
    activeConsumer = prevConsumer;
    writesForbidden = prevForbidden;
  }
}

/** Untracked base-value read; materializes a lazy cell. */
export function peekCell<T>(cell: CellNode<T>): T {
  materializeCell(cell);
  return cell.value as T;
}

export function readCell<T>(cell: CellNode<T>): T {
  materializeCell(cell);
  if (activeConsumer !== null) {
    const link = trackRead(cell, activeConsumer);
    link.version = cell.version;
  }
  return cell.value as T;
}

export function writeCell<T>(cell: CellNode<T>, next: T): boolean {
  if (writesForbidden !== null) throw new WriteForbiddenError(writesForbidden);
  // The equality contract compares against the base value, so a write that
  // arrives before the first read still runs the initializer.
  materializeCell(cell);
  if (cell.equals(cell.value as T, next)) return false;
  if (batchDepth > 0 && !batchBase.has(cell as CellNode<unknown>)) {
    batchBase.set(cell as CellNode<unknown>, { value: cell.value, version: cell.version });
  }
  cell.value = next;
  cell.version++;
  writeEpoch++;
  if (!reactEpochSuppressed) cell.reactEpoch++;
  const cause = hooks.trace !== null ? hooks.trace('write', cell, currentCause) : NO_EVENT;
  propagateFrom(cell as CellNode<unknown>, cause);
  return true;
}

/** Thrown by evaluation when it parks on an unresolved thenable. */
export const PARKED = Symbol('parked');

/** Set by asyncs.ts: called for use(t) inside a canonical evaluation. */
export let useImpl: (t: PromiseLike<unknown>, consumer: DerivedNode<unknown>) => unknown = () => {
  throw new Error('async use() is not installed');
};
export function setUseImpl(impl: typeof useImpl): void {
  useImpl = impl;
}

/** Set by asyncs.ts: finish a recompute, folding parks into async state. */
export let finishComputeImpl: (
  node: DerivedNode<unknown>,
  outcome: { parked: boolean; error: unknown; hasError: boolean; value: unknown },
) => boolean = (node, o) => {
  if (o.parked || o.hasError) throw o.hasError ? o.error : new Error('parked without async layer');
  const prev = node.value;
  if (prev === UNINITIALIZED || !node.equals(prev, o.value)) {
    node.value = o.value;
    return true;
  }
  return false;
};
export function setFinishComputeImpl(impl: typeof finishComputeImpl): void {
  finishComputeImpl = impl;
}

function recompute(node: DerivedNode<unknown>): void {
  if (node.computing) throw new Error(`cycle detected in computed${node.label ? ` "${node.label}"` : ''}`);
  node.computing = true;
  const prevConsumer = activeConsumer;
  activeConsumer = node;
  evalStamp++;
  node.depsTail = undefined;
  const myStamp = evalStamp;
  // Validation stamps at the PRE-eval epoch: if the evaluation itself writes
  // (self-affecting computed), the next read must revalidate.
  const preEpoch = writeEpoch;
  let parked = false;
  let hasError = false;
  let error: unknown;
  let value: unknown;
  try {
    if (node.refreshNonce !== undefined) readCell(node.refreshNonce);
    value = node.fn((t) => useImpl(t, node) as never);
  } catch (e) {
    if (e === PARKED) parked = true;
    else {
      hasError = true;
      error = e;
    }
  } finally {
    // A nested eval advanced the stamp; restore ours so trimming is exact.
    evalStamp = myStamp;
    activeConsumer = prevConsumer;
    trimDeps(node);
    node.computing = false;
  }
  const changed = finishComputeImpl(node, { parked, error, hasError, value });
  if (changed) node.version++;
  // A computed whose evaluation wrote state is self-affecting: its inputs
  // moved under it, so it never caches — every read re-evaluates.
  node.flags = writeEpoch !== preEpoch ? Flags.Dirty : Flags.Clean;
  node.validatedEpoch = preEpoch;
}

/** Bring a derived up to date; exact recompute counts are the contract. */
export function ensureFresh(node: DerivedNode<unknown>): void {
  if (node.observerCount > 0) {
    // Watched: push marks are trustworthy.
    if (node.flags === Flags.Clean) return;
  } else if (node.flags === Flags.Clean && node.validatedEpoch === writeEpoch) {
    return;
  }
  if (node.flags === Flags.Dirty || node.value === UNINITIALIZED) {
    recompute(node);
    return;
  }
  // Check state (or unwatched revalidation): confirm dependencies upward,
  // in first-read order, recomputing only if some version truly advanced.
  for (let l = node.deps; l !== undefined; l = l.nextDep) {
    const dep = l.dep;
    if (dep.kind === 'derived') ensureFresh(dep as DerivedNode<unknown>);
    if (l.version !== dep.version) {
      recompute(node);
      return;
    }
  }
  node.flags = Flags.Clean;
  node.validatedEpoch = writeEpoch;
}

export function readDerived<T>(node: DerivedNode<T>): T {
  ensureFresh(node as DerivedNode<unknown>);
  if (activeConsumer !== null) {
    const link = trackRead(node, activeConsumer);
    link.version = node.version;
  }
  return node.value as T;
}

export function untracked<T>(fn: () => T): T {
  const prev = activeConsumer;
  activeConsumer = null;
  try {
    return fn();
  } finally {
    activeConsumer = prev;
  }
}

export function getActiveConsumer(): ReactiveNode | null {
  return activeConsumer;
}

export function isUninitialized(v: unknown): boolean {
  return v === UNINITIALIZED;
}

export { UNINITIALIZED };

// ---------------------------------------------------------------------------
// Watchers (effects), scopes, and leaf observers
// ---------------------------------------------------------------------------

function makeWatcher(fn: (() => void | (() => void)) | undefined): WatcherNode {
  return {
    kind: 'watcher',
    flags: Flags.Clean,
    version: 0,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    observerCount: 0,
    validatedEpoch: 0,
    causeEvent: NO_EVENT,
    label: undefined,
    fn,
    cleanup: undefined,
    scheduled: false,
    disposed: false,
    children: undefined,
    onNotify: undefined,
    worldMemos: null,
    reactEpoch: 1,
  };
}

let activeScope: WatcherNode | null = null;

function runWatcher(w: WatcherNode): void {
  // Validate: a Check-marked watcher whose derived deps cut off must not
  // re-run its body. Validation can itself run user code (computed fns) that
  // disposes this very watcher — re-check after every pull.
  if (w.flags === Flags.Check) {
    let changed = false;
    for (let l = w.deps; l !== undefined; l = l.nextDep) {
      const dep = l.dep;
      if (dep.kind === 'derived') ensureFresh(dep as DerivedNode<unknown>);
      if (w.disposed) return;
      if (l.version !== dep.version) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      w.flags = Flags.Clean;
      return;
    }
  }
  w.flags = Flags.Clean;
  executeWatcher(w);
}

function executeWatcher(w: WatcherNode): void {
  // Effects created by the previous run belong to that run.
  if (w.children !== undefined) {
    const children = w.children;
    w.children = undefined;
    for (const child of children) disposeWatcher(child);
  }
  if (w.cleanup !== undefined) {
    const c = w.cleanup;
    w.cleanup = undefined;
    try {
      untracked(c);
    } catch (e) {
      // A throwing cleanup poisons the effect: dispose it fully so it never
      // half-runs again, then surface the error.
      disposeWatcher(w);
      throw e;
    }
  }
  if (w.fn === undefined || w.disposed) return;
  const prevConsumer = activeConsumer;
  const prevScope = activeScope;
  activeConsumer = w;
  activeScope = w;
  evalStamp++;
  const myStamp = evalStamp;
  w.depsTail = undefined;
  const cause = hooks.trace !== null ? hooks.trace('effect-run', w, w.causeEvent) : NO_EVENT;
  const prevCause = setCurrentCause(cause);
  try {
    const ret = w.fn();
    if (typeof ret === 'function') w.cleanup = ret;
  } finally {
    setCurrentCause(prevCause);
    evalStamp = myStamp;
    activeConsumer = prevConsumer;
    activeScope = prevScope;
    trimDeps(w);
  }
}

export function disposeWatcher(w: WatcherNode): void {
  if (w.disposed) return;
  w.disposed = true;
  try {
    if (w.children !== undefined) {
      for (const child of w.children) disposeWatcher(child);
      w.children = undefined;
    }
    if (w.cleanup !== undefined) {
      const c = w.cleanup;
      w.cleanup = undefined;
      untracked(c);
    }
  } finally {
    unlinkAllDeps(w);
  }
}

function unlinkAllDeps(w: WatcherNode): void {
  let l = w.deps;
  w.deps = undefined;
  w.depsTail = undefined;
  while (l !== undefined) {
    const next = l.nextDep;
    if (l.inSubs) {
      unlinkFromSubs(l);
      removeObserver(l.dep);
    }
    l.nextDep = undefined;
    l = next;
  }
}

/**
 * Reclaims effects whose disposer was dropped without being called. The
 * watcher node is held by the graph (its dependencies' subscriber lists), so
 * only the disposer's collectibility tells us the user is done with it.
 */
const droppedDisposers = new FinalizationRegistry<WatcherNode>((w) => disposeWatcher(w));

export function makeEffect(fn: () => void | (() => void)): () => void {
  const w = makeWatcher(fn);
  if (activeScope !== null && !activeScope.disposed) {
    (activeScope.children ??= []).push(w);
  }
  executeWatcher(w);
  const dispose = () => {
    droppedDisposers.unregister(dispose);
    disposeWatcher(w);
  };
  droppedDisposers.register(dispose, w, dispose);
  return dispose;
}

export function makeScope(fn: () => void): () => void {
  const w = makeWatcher(undefined);
  const prevScope = activeScope;
  const prevConsumer = activeConsumer;
  activeScope = w;
  activeConsumer = null;
  try {
    fn();
  } finally {
    activeScope = prevScope;
    activeConsumer = prevConsumer;
  }
  const dispose = () => {
    droppedDisposers.unregister(dispose);
    disposeWatcher(w);
  };
  droppedDisposers.register(dispose, w, dispose);
  return dispose;
}

/**
 * A leaf observer: subscribes a callback to a node's invalidation wave
 * without pulling it. This is the React (and committed-view) channel; the
 * callback runs after the wave and its effects settle, so subscribers can
 * re-read a consistent graph.
 */
export function observeNode(node: ReactiveNode, notify: () => void): () => void {
  const leaf = makeWatcher(undefined);
  leaf.onNotify = notify;
  evalStamp++;
  leaf.depsTail = undefined;
  const prevConsumer = activeConsumer;
  activeConsumer = leaf;
  try {
    if (node.kind === 'cell') readCell(node as CellNode<unknown>);
    else if (node.kind === 'derived') {
      // Subscribe to invalidation only; do not force evaluation here.
      const link = trackRead(node, leaf);
      link.version = node.version;
    }
  } finally {
    activeConsumer = prevConsumer;
  }
  const dispose = () => {
    droppedDisposers.unregister(dispose);
    disposeWatcher(leaf);
  };
  droppedDisposers.register(dispose, leaf, dispose);
  return dispose;
}
