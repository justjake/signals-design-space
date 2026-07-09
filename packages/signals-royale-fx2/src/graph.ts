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

import type { ErrorBox, Suspension } from './asyncs.ts';
import type { DraftId } from './worlds.ts';

export type EqualsFn<T> = (a: T, b: T) => boolean;

/** Weak number brand. Plain numbers assign in, so creation and increment
 * stay cast-free (`let x: EvalStamp = 1; x++`), but a value of one brand
 * does not assign to a slot or parameter of another — counter mixups are
 * type errors. The symbol is declared, never created: purely type-level,
 * and the runtime representation stays a bare number. */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]?: B };

/** Monotonic count of canonical writes; validation shortcut for unwatched reads. */
export type WriteEpoch = Brand<number, 'WriteEpoch'>;
/** Per-node value generation; an edge is fresh while its snapshot matches. */
export type NodeVersion = Brand<number, 'NodeVersion'>;
export type TraceEventId = Brand<number, 'TraceEventId'>;
/** Tracking stamp of one evaluation pass; monotonic, never reused (see
 * stampCounter). */
export type EvalStamp = Brand<number, 'EvalStamp'>;
/** Subscription epoch for scoped React subscribers; silent draft folds do
 * not advance it (see ReactiveNode.reactEpoch). */
export type ReactEpoch = Brand<number, 'ReactEpoch'>;
/** Subscription epoch counting every canonical change, silent folds
 * included (see ReactiveNode.canonicalEpoch). */
export type CanonicalEpoch = Brand<number, 'CanonicalEpoch'>;

/**
 * Per-node flags word — the full bit layout:
 *
 *   0b0000_0001  Cell             node type: writable source
 *   0b0000_0010  Derived          node type: cached computed
 *   0b0000_0100  Watcher          node type: effect or leaf observer
 *   0b0000_1000  Check            staleness: possibly stale; confirm
 *                                 dependency versions before recomputing
 *   0b0001_0000  Dirty            staleness: must recompute on next pull
 *   0b0010_0000  Watched          tier: back-edges installed, push marks
 *                                 trustworthy
 *   0b0100_0000  DerivedError     async: latest evaluation threw; the
 *                                 ErrorBox to rethrow is in node.throwable
 *   0b1000_0000  DerivedSuspended async: latest evaluation parked; the
 *                                 Suspension is in node.throwable
 *   0b1_0000_0000+                reserved
 *
 * Exactly one type bit is set at creation and never changes. Check and
 * Dirty form an exclusive staleness field: at most one is set, and both
 * clear is the Clean state. DerivedError and DerivedSuspended form a second
 * exclusive field (the value plane): at most one is set, both clear is the
 * plain-value state. Writes to either field clear the whole field before
 * setting, so a single-bit test reads the exact state.
 *
 * Watched semantics per node type:
 * - cells and deriveds: mirror of observerCount > 0, set by promote (0→1)
 *   and cleared by demote (1→0). observerCount stays authoritative
 *   (lifetime effects and demote need the count); the flag is the one-load
 *   test on the hot paths;
 * - watchers: set at creation, cleared at dispose.
 *
 * Naming: Flag is one bit, Flags is the stored word. The word stays a
 * branded number rather than a Flag-typed field because TS5 types const
 * enum unions as the enum, which would force a cast on every |= / &=
 * composition. The toolchain compiles TS everywhere (vitest/esbuild, tsc):
 * esbuild inlines Flag members within this file and compiles cross-file
 * consumers to object lookups — the same cost as a const object — while
 * tsc-compiled consumers inline everywhere.
 */
export const enum Flag {
  Cell = 0b0000_0001,
  Derived = 0b0000_0010,
  Watcher = 0b0000_0100,
  Check = 0b0000_1000,
  Dirty = 0b0001_0000,
  Watched = 0b0010_0000,
  DerivedError = 0b0100_0000,
  DerivedSuspended = 0b1000_0000,
  /** Both staleness bits; (flags & StaleMask) === 0 is the Clean state. */
  StaleMask = Check | Dirty,
  /** Both value-plane bits; (flags & AsyncMask) === 0 is the plain-value
   * state — how DerivedState views are read (see asyncs.ts). */
  AsyncMask = DerivedError | DerivedSuspended,
}
/** The stored per-node word: a composition of Flag bits. */
export type Flags = Brand<number, 'Flags'>;

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
  stamp: EvalStamp;
}

export interface ReactiveNode {
  flags: Flags;
  version: NodeVersion;
  /**
   * The value-plane companion to the DerivedError/DerivedSuspended flags:
   * the ErrorBox to rethrow or the Suspension being awaited; null in the
   * plain-value state. Initialized null at construction on every node kind
   * (uniform shape — no post-construction property addition): cells never
   * set the async bits but share the { flags, value, throwable } read
   * protocol (DerivedState, asyncs.ts), and watchers carry the slot only
   * for shape uniformity.
   */
  throwable: ErrorBox | Suspension | null;
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
  reactEpoch: ReactEpoch;
  /**
   * Companion epoch that never goes silent: advances on every canonical
   * change, silent draft folds included. Subscribers rendering outside any
   * SignalScope snapshot this one — no render-pass world ever delivers to
   * them, so the fold is their only channel and a suppressed epoch would
   * strand them on stale state.
   */
  canonicalEpoch: CanonicalEpoch;
}

let writeEpoch: WriteEpoch = 1;
/** The tracking stamp of the evaluation pass in progress. */
let evalStamp: EvalStamp = 1;
/** Stamp counter — monotonic, never reused. Uniqueness is load-bearing for
 * the same-pass dedup probe in trackRead: a stamp match there asserts "this
 * edge was stamped by the pass in progress", and a recycled value could match
 * an edge from a dead pass, whose position may be outside the kept prefix —
 * trimming would then silently drop a dependency the evaluation read. */
let stampCounter: EvalStamp = 1;
function newEvalStamp(): EvalStamp {
  evalStamp = ++stampCounter;
  return evalStamp;
}
let activeConsumer: ReactiveNode | null = null;
let batchDepth = 0;

/** Bumped and read by the engine layer; here so cells can report writes. */
export function currentWriteEpoch(): WriteEpoch {
  return writeEpoch;
}

// ---------------------------------------------------------------------------
// Tracing seam. tracer.ts installs the hook; a mutable module binding (not
// an object) so the detached fast path stays one null check per emit site,
// and the graph itself stays runtime-dependency-free.
// ---------------------------------------------------------------------------

export type TraceFn = (
  kind: string,
  node: ReactiveNode | null,
  cause: TraceEventId,
  data?: unknown,
) => TraceEventId;

export let traceHook: TraceFn | null = null;
export function setTraceHook(fn: TraceFn | null): void {
  traceHook = fn;
}

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
  value: T | typeof UNINITIALIZED;
  initializer: (() => T) | undefined;
  equals: EqualsFn<T>;
  lifetime: ((ctx: { get(): T; set(v: T): void }) => void | (() => void)) | undefined;
  lifetimeCleanup: (() => void) | undefined;
  lifetimeActive: boolean;
  lifetimePending: boolean;
}

export interface DerivedNode<T> extends ReactiveNode {
  value: T | typeof UNINITIALIZED;
  fn: (use: UseFn) => T;
  equals: EqualsFn<T>;
  computing: boolean;
}

export interface WatcherNode extends ReactiveNode {
  fn: (() => void | (() => void)) | undefined;
  cleanup: (() => void) | undefined;
  scheduled: boolean;
  disposed: boolean;
  /** Owner scope; disposing the scope disposes the watcher. */
  children: WatcherNode[] | undefined;
  onNotify: (() => void) | undefined;
  /** Draft-lane channel: receives the id of a draft whose new intent touches
   * this leaf's sources. Distinct from onNotify so speculative activity never
   * looks like a store change to snapshot-comparing subscribers. */
  onDraftWake: ((id: DraftId) => void) | undefined;
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
  },
): CellNode<T> {
  const lazyInit = typeof initial === 'function';
  return {
    flags: Flag.Cell,
    version: 1,
    throwable: null,
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
    canonicalEpoch: 1,
  };
}

export function makeDerived<T>(
  fn: (use: UseFn) => T,
  opts?: { equals?: EqualsFn<T>; label?: string },
): DerivedNode<T> {
  return {
    flags: Flag.Derived | Flag.Dirty,
    version: 0,
    throwable: null,
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
    worldMemos: null,
    reactEpoch: 1,
    canonicalEpoch: 1,
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

/**
 * Promote: first observer arrives. Links the dep closure depth-first (cycles
 * are impossible — dep edges exist only after an evaluation, and cyclic
 * evaluation throws) and stamp-validates each edge once, because the node
 * spent its unwatched span with no back-edges: writes moved dependency
 * versions without any push mark reaching it, so its Clean flags may be
 * lies. The version match alone is insufficient — a stale unwatched dep has
 * not recomputed, so its own version cannot have moved even when its inputs
 * did; the dep's post-promote staleness carries that information up. Where
 * some edge fails validation, a Clean node is seeded Check, restoring the
 * watched tier's invariant that flags are trustworthy (the stale-cover
 * invariant: for every watched edge, dep stale ⇒ sub stale or scheduled).
 */
export function addObserver(node: ReactiveNode): void {
  node.observerCount++;
  if (node.observerCount === 1) {
    node.flags |= Flag.Watched;
    if ((node.flags & Flag.Derived) !== 0) {
      let invalid = false;
      for (let l = node.deps; l !== undefined; l = l.nextDep) {
        linkIntoSubs(l);
        const dep = l.dep;
        addObserver(dep);
        if (l.version !== dep.version || (dep.flags & Flag.StaleMask) !== 0) invalid = true;
      }
      if (invalid && (node.flags & Flag.StaleMask) === 0) node.flags |= Flag.Check;
    }
    noteLifetimeTransition(node);
  }
}

/**
 * Demote: last observer leaves. Cascade-unlinks the back-edges promote
 * installed (after this, the chain holds forward references only — dropping
 * user handles collects it whole) and seeds the unwatched tier's validation
 * stamp: Clean at demote means no dependency changed since last validation
 * (push marks were reliable while watched), so the next quiet read
 * short-circuits O(1); stale at demote forces the up-walk. Flag distrust
 * across the tier boundary lives entirely at the two crossings — promote
 * validates on re-watch, and unwatched pulls never trust Clean without a
 * current validatedEpoch — so no staleness seeding happens here.
 */
export function removeObserver(node: ReactiveNode): void {
  node.observerCount--;
  if (node.observerCount === 0) {
    node.flags &= ~Flag.Watched;
    if ((node.flags & Flag.Derived) !== 0) {
      for (let l = node.deps; l !== undefined; l = l.nextDep) {
        unlinkFromSubs(l);
        removeObserver(l.dep);
      }
      node.validatedEpoch = (node.flags & Flag.StaleMask) === 0 ? writeEpoch : 0;
    }
    noteLifetimeTransition(node);
  }
}

// ---------------------------------------------------------------------------
// Lifetime effects: an atom option that runs setup when the atom gains its
// first subscriber of ANY kind (computed chain, effect, or React component)
// and runs the returned cleanup when the last subscriber of every kind is
// gone. Exactly one observation is active across the union of kinds.
//
// Transitions within one tick coalesce through a microtask, so
// subscribe/unsubscribe flaps (StrictMode double-mounts, list reorders)
// net out instead of bouncing the resource.
// ---------------------------------------------------------------------------

/** Host microtask scheduler (present in every supported runtime; typed here
 * so the engine's type surface stays lib-agnostic). */
declare const queueMicrotask: (fn: () => void) => void;

const pendingLifetimeCells = new Set<CellNode<unknown>>();
let lifetimeFlushScheduled = false;

/** Called at the promote/demote boundary (observation count 0<->1). */
function noteLifetimeTransition(node: ReactiveNode): void {
  if ((node.flags & Flag.Cell) === 0) return;
  const cell = node as CellNode<unknown>;
  if (cell.lifetime === undefined) return;
  pendingLifetimeCells.add(cell);
  if (!lifetimeFlushScheduled) {
    lifetimeFlushScheduled = true;
    queueMicrotask(flushLifetimeTransitions);
  }
}

/** Settle observation state now (also called from tests). */
export function flushLifetimeTransitions(): void {
  lifetimeFlushScheduled = false;
  const cells = [...pendingLifetimeCells];
  pendingLifetimeCells.clear();
  for (const cell of cells) {
    const shouldBeActive = cell.observerCount > 0;
    if (shouldBeActive === cell.lifetimeActive) continue;
    cell.lifetimeActive = shouldBeActive;
    if (shouldBeActive) {
      const ctx = {
        get: () => untracked(() => peekCell(cell)),
        set: (v: unknown) => {
          writeCell(cell, v);
        },
      };
      const cleanup = cell.lifetime!(ctx);
      cell.lifetimeCleanup = typeof cleanup === 'function' ? cleanup : undefined;
    } else {
      const cleanup = cell.lifetimeCleanup;
      cell.lifetimeCleanup = undefined;
      if (cleanup !== undefined) untracked(cleanup);
    }
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
  const watched = (sub.flags & Flag.Watched) !== 0;
  if (watched) {
    // Same-pass dedup for non-adjacent re-reads: this sub's earlier link
    // sits at the dep's subs tail (cursor reuse re-stamps, new watched edges
    // land at the tail), so a stamp match means the edge already exists and
    // is inside the kept prefix — return it instead of double-registering
    // the observer. Unwatched edges never enter subs lists, so unwatched
    // re-reads keep the tolerated duplicate forward edges (version-
    // consistent, forward-only garbage).
    const last = dep.subsTail;
    if (last !== undefined && last.sub === sub && last.stamp === evalStamp) return last;
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

/** Dev-only invariant net: a node's deps list is exactly what its last
 * evaluation read, in read order. Evaluation is the only site that creates
 * or keeps dep edges, and every touch (re)stamps with the pass in progress,
 * so after trimming every retained edge must carry a stamp from this eval
 * or a nested one — stamps are monotonic and never reused, so `>= myStamp`
 * is exact. Gated on a module const so bundler NODE_ENV replacement strips
 * the walk from production builds; unbundled production pays one
 * always-false branch per evaluation, never the walk. */
const DEV_EVAL_CHECKS: boolean =
  typeof process !== 'undefined' && process.env.NODE_ENV !== 'production';
function assertDepsFromEval(sub: ReactiveNode, myStamp: EvalStamp): void {
  for (let l = sub.deps; l !== undefined; l = l.nextDep) {
    if (l.stamp < myStamp) {
      throw new Error(
        `invariant violation: a dependency edge survived trimming that the finished evaluation never read${
          sub.label !== undefined ? ` (sub "${sub.label}")` : ''
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Invalidation (push through watched edges)
// ---------------------------------------------------------------------------

/** Effect watchers scheduled by the current wave. Cleared by logical length
 * (watcherCount), never `.length = 0`: V8 right-trims the backing store on a
 * length reset, so a truncated queue re-grows its capacity from zero on
 * every wave (O(log n) reallocations plus copies, garbage proportional to
 * peak wave width). The price of retained capacity is that consumed slots
 * are nulled at drain — a soft-cleared slot must not pin a disposed watcher.
 * Append-then-fully-drain with the w.disposed drain-time check as the
 * tombstone; there is no mid-queue removal, so no compaction machinery. */
const watcherQueue: Array<WatcherNode | undefined> = [];
let watcherCount = 0;

/** Leaf observers marked by the current wave; notified after effects settle.
 * Double-buffered under the same retained-capacity discipline: a draining
 * wave iterates its own buffer while re-marks from onNotify land in the
 * spare, so a wave's iteration never sees entries added during delivery. */
let markedLeaves: Array<ReactiveNode | undefined> = [];
let markedCount = 0;
/** The off-duty leaf buffer; null while checked out by a draining frame.
 * Delivery can nest (onNotify may write, and that flush drains the buffer
 * this frame's re-marks are landing in), so a doubly-nested frame finds the
 * spare checked out and must not reuse a buffer that is mid-iteration. */
let spareLeaves: Array<ReactiveNode | undefined> | null = [];

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
  node.canonicalEpoch++;
}

/** Suspended traversal positions for the iterative wave (heap, not the JS
 * call stack, so wave depth is bounded by memory rather than stack frames). */
interface WaveFrame {
  value: Link | undefined;
  prev: WaveFrame | undefined;
}

/**
 * The invalidation wave: push marks down the watched subs closure.
 *
 * Marks are always Check ("possibly stale"): consumers confirm against
 * dependency VERSIONS before recomputing or re-running. Versions — not
 * marks — are the recompute trigger, which is what makes write-then-revert
 * inside a batch a true no-op.
 *
 * Per-node visit rules (the wave's contract, also applied by any site that
 * installs a back-edge onto a stale dep — see observeNode):
 * 1. already stale → re-schedule an unscheduled Watcher; do not descend
 *    (sound under the stale-cover invariant: dep stale ⇒ sub stale or
 *    scheduled, so everything below is already marked);
 * 2. Clean → set Check (never Dirty) and record the causal event;
 * 3. Watcher → schedule; watchers have no subscribers, so never descend;
 * 4. Derived → bump the subscription epochs exactly once per wave (the
 *    Clean→Check transition is the wave's visited test) and descend.
 *
 * Iterative in alien-signals' shape: a link cursor, the pending sibling, and
 * an explicit stack of suspended positions — single-child descents reuse the
 * pending sibling instead of pushing, so plain chains run with no stack
 * growth at all.
 */
function propagateWave(link: Link | undefined, cause: TraceEventId): void {
  if (link === undefined) return;
  let cur: Link = link;
  let next: Link | undefined = cur.nextSub;
  let stack: WaveFrame | undefined;
  top: do {
    const sub = cur.sub;
    const flags = sub.flags;
    if ((flags & Flag.StaleMask) !== 0) {
      if ((flags & Flag.Watcher) !== 0 && !(sub as WatcherNode).scheduled) {
        scheduleWatcher(sub as WatcherNode);
      }
    } else {
      sub.flags = flags | Flag.Check;
      sub.causeEvent = cause;
      if ((flags & Flag.Watcher) !== 0) {
        scheduleWatcher(sub as WatcherNode);
      } else if ((flags & Flag.Derived) !== 0) {
        sub.canonicalEpoch++;
        if (!reactEpochSuppressed) sub.reactEpoch++;
        const subSubs = sub.subs;
        if (subSubs !== undefined) {
          cur = subSubs;
          if (cur.nextSub !== undefined) {
            stack = { value: next, prev: stack };
            next = cur.nextSub;
          }
          continue;
        }
      }
    }
    if (next !== undefined) {
      cur = next;
      next = cur.nextSub;
      continue;
    }
    while (stack !== undefined) {
      const resume = stack.value;
      stack = stack.prev;
      if (resume !== undefined) {
        cur = resume;
        next = cur.nextSub;
        continue top;
      }
    }
    break;
  } while (true);
}

function scheduleWatcher(w: WatcherNode): void {
  if (w.scheduled || w.disposed) return;
  w.scheduled = true;
  if (w.onNotify !== undefined) {
    markedLeaves[markedCount++] = w;
  } else {
    watcherQueue[watcherCount++] = w;
  }
}

/** Push a change wave from a cell whose canonical value advanced. */
export function propagateFrom(cell: CellNode<unknown>, cause: TraceEventId): void {
  propagateWave(cell.subs, cause);
  if (batchDepth === 0) flush();
}

/**
 * Invalidate a derived from outside the dependency graph (thenable
 * settlement). Treated exactly like a write: the version advances so
 * downstream validation re-pulls, subscribers get marked, effects run.
 */
export function invalidateDerived(node: DerivedNode<unknown>, cause: TraceEventId): void {
  writeEpoch++;
  node.flags = (node.flags & ~Flag.StaleMask) | Flag.Dirty;
  node.causeEvent = cause;
  node.version++;
  node.reactEpoch++;
  node.canonicalEpoch++;
  propagateWave(node.subs, cause);
  if (batchDepth === 0) flush();
}

/** Notify leaf observers of a node without touching canonical state (draft
 * activity: ops appended, retired, or discarded — speculative readers must
 * re-resolve, canonical readers see no change). The wave follows watched
 * derived edges down to the leaves: probes subscribe to the node they probe
 * (a computed, usually), not to the drafted input, so stopping at the cell
 * would leave every downstream subscriber unaware. Watchers without a
 * notify callback (effects) are canonical-only and stay untouched. */
export function pokeLeafObservers(node: ReactiveNode): void {
  let seen: Set<ReactiveNode> | null = null;
  const walk = (n: ReactiveNode): void => {
    for (let l = n.subs; l !== undefined; l = l.nextSub) {
      const sub = l.sub;
      if ((sub.flags & Flag.Watcher) !== 0) {
        if ((sub as WatcherNode).onNotify !== undefined) {
          scheduleWatcher(sub as WatcherNode);
          sub.flags = (sub.flags & ~Flag.StaleMask) | Flag.Dirty;
        }
      } else if ((sub.flags & Flag.Derived) !== 0) {
        seen ??= new Set();
        if (!seen.has(sub)) {
          seen.add(sub);
          walk(sub);
        }
      }
    }
  };
  walk(node);
  if (batchDepth === 0) flush();
}

/**
 * Intent-append traversal: pokeLeafObservers plus draft-id delivery to the
 * same leaf frontier in ONE walk (the two jobs visit identical watched
 * derived edges, and intent appends need both every time). Runs in the
 * writer's ambient context, so inside a React transition scope the wake
 * dispatches ride that transition's lanes. Notify flush still precedes wake
 * delivery: the wave's own effects may dispose subscriptions, and a leaf
 * disposed by them must not receive the draft id.
 */
export function pokeAndWakeLeafObservers(node: ReactiveNode, id: DraftId): void {
  let seen: Set<ReactiveNode> | null = null;
  const wakes: WatcherNode[] = [];
  const walk = (n: ReactiveNode): void => {
    for (let l = n.subs; l !== undefined; l = l.nextSub) {
      const sub = l.sub;
      if ((sub.flags & Flag.Watcher) !== 0) {
        const leaf = sub as WatcherNode;
        if (leaf.onNotify !== undefined) {
          scheduleWatcher(leaf);
          leaf.flags = (leaf.flags & ~Flag.StaleMask) | Flag.Dirty;
        }
        if (!leaf.disposed && leaf.onDraftWake !== undefined) wakes.push(leaf);
      } else if ((sub.flags & Flag.Derived) !== 0) {
        seen ??= new Set();
        if (!seen.has(sub)) {
          seen.add(sub);
          walk(sub);
        }
      }
    }
  };
  walk(node);
  if (batchDepth === 0) flush();
  for (const leaf of wakes) {
    if (!leaf.disposed && leaf.onDraftWake !== undefined) leaf.onDraftWake(id);
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

/** Hard iteration ceiling: converts livelock into a thrown error. */
const enum Limit {
  /** Queued-effect runs per flush before declaring a non-settling cycle. */
  FlushRuns = 100_000,
}

/** Run queued effects until settled, then deliver leaf notifications. A
 * throwing effect aborts the flush; the effects it preempted are skipped
 * (cleared), not left armed for unrelated writes to trigger later. */
export function flush(): void {
  if (flushing) return;
  if (watcherCount === 0 && markedCount === 0) return;
  flushing = true;
  try {
    let guard = 0;
    while (queueHead < watcherCount) {
      if (++guard > Limit.FlushRuns) throw new Error('effect flush did not settle (cycle?)');
      const i = queueHead++;
      const w = watcherQueue[i]!;
      watcherQueue[i] = undefined; // consumed slot must not pin the watcher
      w.scheduled = false;
      if (w.disposed || (w.flags & Flag.StaleMask) === 0) continue;
      runWatcher(w);
    }
    watcherCount = 0;
    queueHead = 0;
  } catch (e) {
    // Preempted effects are skipped, not left armed for unrelated writes to
    // trigger later; their unconsumed slots get the same nulling discipline.
    for (let i = queueHead; i < watcherCount; i++) {
      const w = watcherQueue[i]!;
      watcherQueue[i] = undefined;
      w.scheduled = false;
      w.flags &= ~Flag.StaleMask;
    }
    watcherCount = 0;
    queueHead = 0;
    throw e;
  } finally {
    flushing = false;
    if (markedCount > 0) {
      // Take this wave's buffer and swap the spare in as the push target:
      // leaves marked during delivery land there for the NEXT wave, so this
      // iteration never sees them. A doubly-nested delivery finds the spare
      // checked out (null) and takes a fresh array — that rare frame pays
      // the old per-wave allocation rather than clobbering a live iteration.
      const leaves = markedLeaves;
      const n = markedCount;
      markedLeaves = spareLeaves ?? [];
      spareLeaves = null;
      markedCount = 0;
      for (let i = 0; i < n; i++) {
        const w = leaves[i] as WatcherNode;
        w.scheduled = false;
        w.flags &= ~Flag.StaleMask;
      }
      try {
        for (let i = 0; i < n; i++) {
          const w = leaves[i] as WatcherNode;
          if (!w.disposed) w.onNotify?.();
        }
      } finally {
        // Null consumed slots — retained capacity must not pin watchers —
        // and hand the buffer back as the spare, also on a throwing notify.
        for (let i = 0; i < n; i++) leaves[i] = undefined;
        spareLeaves = leaves;
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
  cell.canonicalEpoch++;
  if (!reactEpochSuppressed) cell.reactEpoch++;
  const cause = traceHook !== null ? traceHook('write', cell, currentCause) : NO_EVENT;
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
  const myStamp = newEvalStamp();
  node.depsTail = undefined;
  // Validation stamps at the PRE-eval epoch: if the evaluation itself writes
  // (self-affecting computed), the next read must revalidate.
  const preEpoch = writeEpoch;
  let parked = false;
  let hasError = false;
  let error: unknown;
  let value: unknown;
  try {
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
    if (DEV_EVAL_CHECKS) assertDepsFromEval(node, myStamp);
    node.computing = false;
  }
  const changed = finishComputeImpl(node, { parked, error, hasError, value });
  if (changed) node.version++;
  // A computed whose evaluation wrote state is self-affecting: its inputs
  // moved under it, so it never caches — every read re-evaluates.
  node.flags = (node.flags & ~Flag.StaleMask) | (writeEpoch !== preEpoch ? Flag.Dirty : 0);
  node.validatedEpoch = preEpoch;
}

/** Bring a derived up to date; exact recompute counts are the contract. */
export function ensureFresh(node: DerivedNode<unknown>): void {
  const flags = node.flags;
  if ((flags & Flag.Watched) !== 0) {
    // Watched: push marks are trustworthy (promote validated the closure).
    if ((flags & Flag.StaleMask) === 0) return;
  } else if ((flags & Flag.StaleMask) === 0 && node.validatedEpoch === writeEpoch) {
    return;
  }
  if ((node.flags & Flag.Dirty) !== 0 || node.value === UNINITIALIZED) {
    recompute(node);
    return;
  }
  // Check state (or unwatched revalidation): confirm dependencies upward,
  // in first-read order, recomputing only if some version truly advanced.
  for (let l = node.deps; l !== undefined; l = l.nextDep) {
    const dep = l.dep;
    if ((dep.flags & Flag.Derived) !== 0) ensureFresh(dep as DerivedNode<unknown>);
    if (l.version !== dep.version) {
      recompute(node);
      return;
    }
  }
  node.flags &= ~Flag.StaleMask;
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
    // Watchers are born watched (they exist to observe) and drop the bit at
    // dispose; their edges never go through promote/demote counting.
    flags: Flag.Watcher | Flag.Watched,
    version: 0,
    throwable: null,
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
    onDraftWake: undefined,
    worldMemos: null,
    reactEpoch: 1,
    canonicalEpoch: 1,
  };
}

let activeScope: WatcherNode | null = null;

function runWatcher(w: WatcherNode): void {
  // Validate: a Check-marked watcher whose derived deps cut off must not
  // re-run its body. Validation can itself run user code (computed fns) that
  // disposes this very watcher — re-check after every pull.
  if ((w.flags & Flag.Check) !== 0) {
    let changed = false;
    for (let l = w.deps; l !== undefined; l = l.nextDep) {
      const dep = l.dep;
      if ((dep.flags & Flag.Derived) !== 0) ensureFresh(dep as DerivedNode<unknown>);
      if (w.disposed) return;
      if (l.version !== dep.version) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      w.flags &= ~Flag.StaleMask;
      return;
    }
  }
  w.flags &= ~Flag.StaleMask;
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
  const myStamp = newEvalStamp();
  w.depsTail = undefined;
  const cause = traceHook !== null ? traceHook('effect-run', w, w.causeEvent) : NO_EVENT;
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
    if (DEV_EVAL_CHECKS) assertDepsFromEval(w, myStamp);
  }
}

export function disposeWatcher(w: WatcherNode): void {
  if (w.disposed) return;
  w.disposed = true;
  w.flags &= ~Flag.Watched;
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
  const owned = activeScope !== null && !activeScope.disposed;
  if (owned) {
    (activeScope!.children ??= []).push(w);
  }
  executeWatcher(w);
  const dispose = () => {
    droppedDisposers.unregister(dispose);
    disposeWatcher(w);
  };
  // An effect created inside a scope (or another effect) lives and dies
  // with its owner; dropping the per-effect disposer is normal usage there,
  // not abandonment. Only ownerless effects arm the reclamation registry —
  // a collected disposer must never kill an effect something still owns.
  if (!owned) droppedDisposers.register(dispose, w, dispose);
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
export function observeNode(
  node: ReactiveNode,
  notify: () => void,
  draftWake?: (id: DraftId) => void,
): () => void {
  const leaf = makeWatcher(undefined);
  leaf.onNotify = notify;
  leaf.onDraftWake = draftWake;
  newEvalStamp();
  leaf.depsTail = undefined;
  const prevConsumer = activeConsumer;
  activeConsumer = leaf;
  try {
    if ((node.flags & Flag.Cell) !== 0) readCell(node as CellNode<unknown>);
    else if ((node.flags & Flag.Derived) !== 0) {
      // Subscribe to invalidation only; do not force evaluation here.
      const link = trackRead(node, leaf);
      link.version = node.version;
      // This installed a back-edge without a pull, so the stale-cover
      // invariant is on this site: a stale node means the staleness edge
      // this subscriber cares about already fired (or, for promote-seeded
      // Check, could never fire while unwatched) — apply the wave's visit
      // rules to the new subscriber so it hears it once. A pull re-arms;
      // edge-triggered semantics are preserved. Never-computed nodes
      // (version 0) are exempt: they are born Dirty with no dependency
      // edges, so no wave was ever swallowed and there is no missed edge —
      // exactly the edge-triggered contract's "no Clean→stale transition
      // happened yet".
      if ((node.flags & Flag.StaleMask) !== 0 && node.version !== 0) {
        leaf.flags |= Flag.Check;
        leaf.causeEvent = node.causeEvent;
        scheduleWatcher(leaf);
      }
    }
  } finally {
    activeConsumer = prevConsumer;
  }
  if (batchDepth === 0) flush();
  const dispose = () => {
    droppedDisposers.unregister(dispose);
    disposeWatcher(leaf);
  };
  droppedDisposers.register(dispose, leaf, dispose);
  return dispose;
}
