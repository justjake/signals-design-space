/**
 * The base reactive graph: writable signals, cached computeds, effects.
 *
 * Design notes
 *
 * - Push-pull: writes push a small "dirty" wave through WATCHED edges only;
 *   reads pull values and validate caches by comparing clock readings.
 *   A computed recomputes only when some dependency actually changed after
 *   the computed's last validation (dep.changedAtGraphChange strictly
 *   greater than sub.validAtGraphChange), which is what gives exact
 *   evaluation counts and equality cutoff.
 * - Watched vs unwatched: a computed is linked into its dependencies'
 *   subscriber lists only while something observes it (an effect chain, a
 *   React subscription, or another watched computed). An unwatched computed
 *   holds references dependency-ward only, so dropping the last user
 *   reference makes the whole chain collectible — no registry needed for
 *   reads. Unwatched computeds validate lazily on read against the global
 *   graph change clock.
 * - Effects are the only long-lived graph roots a user can leak by dropping
 *   the disposer without calling it; a FinalizationRegistry on the disposer
 *   reclaims those.
 *
 * Counter taxonomy — every numeric counter is one of two kinds, and the
 * name says which:
 *
 * - …ChangeClock: monotone logical clock; ticks when its event class
 *   happens. Records never hold private counters — they hold READINGS of a
 *   clock: validAt<Clock> ("proven current as of") and changedAt<Clock>
 *   ("last real change"). Every staleness question is one comparison:
 *   dep.changedAt<Clock> > sub.validAt<Clock> means changed-since-validated
 *   (strictly greater — equal readings mean that very validation already
 *   consumed the change).
 * - …Pass: identity of a dynamic scope (an evaluation, a walk); saved and
 *   restored on nesting, so NEVER compare for order — equality means
 *   membership in the pass now running.
 */

import type { ErrorBox, Suspension } from './asyncs.ts';
import type { DraftId } from './worlds.ts';

export type EqualsFn<T> = (a: T, b: T) => boolean;

/** Weak number brand. Plain numbers assign in, so creation and increment
 * stay cast-free (`let x: EvalPass = 1; x++`), but a value of one brand
 * does not assign to a slot or parameter of another — counter mixups are
 * type errors. The symbol is declared, never created: purely type-level,
 * and the runtime representation stays a plain number. */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]?: B };

/** Monotone logical clock: ticks on every base-state change — writes AND
 * settlements. Validation shortcut for unwatched reads. */
export type GraphChangeClock = Brand<number, 'GraphChangeClock'>;
export type TraceEventId = Brand<number, 'TraceEventId'>;
/** Identity of one evaluation pass; monotonic, never reused (see
 * evalPassCounter). */
export type EvalPass = Brand<number, 'EvalPass'>;
/** Identity of one poke walk; monotonic, never reused, so no per-walk
 * clearing is needed (same discipline as EvalPass). */
export type PokePass = Brand<number, 'PokePass'>;
export type BatchPass = Brand<number, 'BatchPass'>;

/**
 * One flag bit. `Flag` names a bit; `Flags` (the stored word) stays a
 * branded number because TS5 types const enum unions as the enum, which
 * would force a cast on every |= / &= composition. esbuild inlines members
 * within this file and compiles cross-file consumers to object lookups —
 * the same cost as a const object — while tsc-compiled consumers inline
 * everywhere.
 */
export const enum Flag {
  // Kinds: exactly one, set at creation, never changed.
  /** Writable source. */
  KindCell = 0b0000_0000_0001,
  /** Cached computed. */
  KindDerived = 0b0000_0000_0010,
  /** Subscriber (alien-signals' name): an effect, a store subscription, or
   * a scope anchor. */
  Watching = 0b0000_0000_0100,

  // Watch capabilities: creation-fixed, Watching nodes only; dispatch
  // routes on these bits, never on callback presence. Component
  // subscription = Watching|WatchRender|WatchDraft; engine effect =
  // Watching|WatchRunEffect; scope anchor = Watching alone.
  /** Schedule into the render-notify queue, delivered after effects
   * settle; the subscriber's notify predicate decides whether the delivery
   * becomes a re-render. */
  WatchRender = 0b0000_0000_1000,
  /** Schedule into the validated effect queue (runs the body). */
  WatchRunEffect = 0b0000_0001_0000,
  /** Draft pings and wakes reach this watcher; absent = base-state-only
   * (every engine effect today). */
  WatchDraft = 0b0000_0010_0000,

  // Staleness: an exclusive pair; writes clear the whole field before
  // setting, so a single-bit test reads the exact state.
  /** Possibly stale: confirm dependency changedAt readings before
   * recomputing. */
  StaleCheck = 0b0000_0100_0000,
  /** Definitely stale: recompute on next pull. */
  StaleDirty = 0b0000_1000_0000,

  // Async value plane: an exclusive pair; both clear = plain value.
  /** Latest evaluation threw; node.throwable holds the ErrorBox to
   * rethrow. */
  AsyncError = 0b0001_0000_0000,
  /** Latest evaluation parked; node.throwable holds the Suspension. */
  AsyncSuspended = 0b0010_0000_0000,

  // State.
  /** Double role by kind. Cells/deriveds: mirror of observerCount > 0 —
   * promote (0→1) sets it, demote (1→0) clears it; the count stays
   * authoritative, the bit is the one-load hot-path test. Watchers: ALIVE —
   * set at creation, cleared at dispose, so disposal = Watching set,
   * Watched clear. */
  Watched = 0b0100_0000_0000,
  /** Watcher sits in a flush queue. */
  Scheduled = 0b1000_0000_0000,
  /** Derived evaluation in progress (re-entry = a cycle). */
  Computing = 0b1_0000_0000_0000,
  /** Derived reads route through the active draft world. Raw graph-level
   * deriveds intentionally lack this capability. */
  WorldAware = 0b10_0000_0000_0000,

  /** Both staleness bits; (flags & StaleMask) === 0 is the Clean state. */
  StaleMask = StaleCheck | StaleDirty,
  /** Both value-plane bits; (flags & AsyncMask) === 0 is the plain-value
   * state — how DerivedState views are read (see asyncs.ts). */
  AsyncMask = AsyncError | AsyncSuspended,
}
/** The stored per-node word: a composition of Flag bits. */
export type Flags = Brand<number, 'Flags'>;

export interface Link {
  dep: ReactiveNode;
  sub: ReactiveNode;
  nextDep: Link | undefined;
  prevSub: Link | undefined;
  nextSub: Link | undefined;
  /** Present in dep's subscriber list (only while sub is watched). */
  inSubs: boolean;
  /** Reading of the eval pass that last (re)read this edge; equality with
   * the running evalPass means the evaluation in progress already touched
   * it. */
  evalPass: EvalPass;
}

export interface ReactiveNode {
  flags: Flags;
  /**
   * Reading of graphChangeClock at this node's last REAL value change.
   * Equality-cutoff recomputes do not advance it, and a batch net-revert
   * restores it — so dep.changedAtGraphChange > sub.validAtGraphChange is
   * exactly "changed since that subscriber last validated". Stamped with
   * the CURRENT clock at change time (writes tick the clock first, then
   * stamp; recomputes stamp without ticking — a recompute is not a base
   * event, and any consumer with an older validAt reading still compares
   * greater).
   */
  changedAtGraphChange: GraphChangeClock;
  /**
   * The value-plane companion to the AsyncError/AsyncSuspended flags:
   * the ErrorBox to rethrow or the Suspension being awaited; null in the
   * plain-value state. Initialized null at construction on every node kind
   * (uniform shape — no post-construction property addition): cells never
   * set the async bits but share the { flags, value, throwable } read
   * protocol (DerivedState, asyncs.ts), and watchers carry the slot only
   * for shape uniformity.
   */
  throwable: ErrorBox | Suspension | null;
  /** Subscriber list (watched edges + store subscriptions). */
  subs: Link | undefined;
  subsTail: Link | undefined;
  /** Dependency list in first-read order (derived/watcher only). */
  deps: Link | undefined;
  depsTail: Link | undefined;
  /** Count of observers: watched sub-links, effects, React subscriptions. */
  observerCount: number;
  /** Trace: event that caused the latest invalidation reaching this node. */
  causeEvent: TraceEventId;
  label: string | undefined;
  /** World-resolution memos, managed by worlds.ts; null while quiescent. */
  worldMemos: Map<string, unknown> | null;
  /** Reading of the last poke walk that reached this node; equality with
   * the running pokePass means that walk already visited it. */
  pokePass: PokePass;
}

let graphChangeClock: GraphChangeClock = 1;
/** Identity of the evaluation pass in progress. */
let evalPass: EvalPass = 1;
/** Pass counter — monotonic, never reused. Uniqueness is load-bearing for
 * the same-pass dedup probe in trackRead: an evalPass match there asserts
 * "this edge was touched by the pass in progress", and a recycled value could
 * match an edge from a dead pass, whose position may be outside the kept
 * prefix — trimming would then silently drop a dependency the evaluation
 * read. */
let evalPassCounter: EvalPass = 1;
function newEvalPass(): EvalPass {
  evalPass = ++evalPassCounter;
  return evalPass;
}
let activeConsumer: ReactiveNode | null = null;
let batchDepth = 0;

/** Bumped and read by the engine layer; here so cells can report writes. */
export function currentGraphChange(): GraphChangeClock {
  return graphChangeClock;
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
  /** Reading of the batch pass whose base state this cell already saved —
   * equality with the running batchPass means the batchBase entry exists, so
   * repeat writes in the same batch skip the map probe (same convention as
   * pokePass: the record holds the reading of the last pass that touched it). */
  batchPass: BatchPass;
  lifetime: ((ctx: { get(): T; set(v: T): void }) => void | (() => void)) | undefined;
  lifetimeCleanup: (() => void) | undefined;
  lifetimeActive: boolean;
}

export interface DerivedNode<T> extends ReactiveNode {
  value: T | typeof UNINITIALIZED;
  fn: (use: UseFn, previous: T | undefined) => T;
  equals: EqualsFn<T>;
  /** The use() argument recompute passes to fn. It closes over nothing but
   * the node, so it is created once with the node rather than per recompute. */
  useFn: UseFn;
  /** GraphChangeClock reading at last successful validation — the unwatched
   * tier's currency gate (validAtGraphChange === clock ⇒ nothing relevant
   * happened since; the read short-circuits O(1)). Deriveds only: cells and
   * watchers never validate, so they do not carry the slot. */
  validAtGraphChange: GraphChangeClock;
}

export interface WatcherNode extends ReactiveNode {
  /** Reading at this watcher's last validation or run — the same currency
   * gate deriveds use (see DerivedNode.validAtGraphChange). */
  validAtGraphChange: GraphChangeClock;
  fn: (() => void | (() => void)) | undefined;
  cleanup: (() => void) | undefined;
  /** Owner scope; disposing the scope disposes the watcher. */
  children: WatcherNode[] | undefined;
  /** Render-notify delivery (WatchRender watchers). */
  onNotify: (() => void) | undefined;
  /** Draft-lane channel: receives the id of a draft whose new intent touches
   * this subscriber's sources. Distinct from onNotify so draft activity never
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
    flags: Flag.KindCell,
    changedAtGraphChange: 0,
    throwable: null,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    observerCount: 0,
    causeEvent: NO_EVENT,
    label: opts?.label,
    value: lazyInit ? UNINITIALIZED : (initial as T),
    initializer: lazyInit ? (initial as () => T) : undefined,
    equals: opts?.equals ?? defaultEquals,
    batchPass: 0,
    lifetime: opts?.onObserved,
    lifetimeCleanup: undefined,
    lifetimeActive: false,
    worldMemos: null,
    pokePass: 0,
  };
}

export function makeDerived<T>(
  fn: (use: UseFn, previous: T | undefined) => T,
  opts?: { equals?: EqualsFn<T>; label?: string },
  worldAware = false,
): DerivedNode<T> {
  const node: DerivedNode<T> = {
    flags: Flag.KindDerived | Flag.StaleDirty | (worldAware ? Flag.WorldAware : 0),
    changedAtGraphChange: 0,
    throwable: null,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    observerCount: 0,
    causeEvent: NO_EVENT,
    label: opts?.label,
    value: UNINITIALIZED,
    fn,
    equals: opts?.equals ?? defaultEquals,
    useFn: undefined as never, // assigned below; needs the node reference
    validAtGraphChange: 0,
    worldMemos: null,
    pokePass: 0,
  };
  node.useFn = ((t: PromiseLike<unknown>) =>
    useImpl(t, node as DerivedNode<unknown>)) as UseFn;
  return node;
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
 * evaluation throws) and reading-validates each dep once, because the node
 * spent its unwatched span with no back-edges: dependencies changed without
 * any push mark reaching it, so its Clean flags may be lies. The reading
 * comparison alone is insufficient — a stale unwatched dep has not
 * recomputed, so its changedAt reading cannot have moved even when its
 * inputs did; the dep's post-promote staleness carries that information up.
 * Where some dep fails validation, a Clean node is seeded StaleCheck,
 * restoring the watched tier's invariant that flags are trustworthy (the
 * stale-cover invariant: for every watched edge, dep stale ⇒ sub stale or
 * scheduled).
 */
export function addObserver(node: ReactiveNode): void {
  node.observerCount++;
  if (node.observerCount === 1) {
    node.flags |= Flag.Watched;
    if ((node.flags & Flag.KindDerived) !== 0) {
      // A Computing node is promoted mid-evaluation (a consumer subscribed
      // from inside the running body). Skip history validation: the
      // watermark predates this evaluation, so deps the eval just re-read
      // would compare as changed-since and seed a false StaleCheck. The
      // running eval is the validator — its finally stamps fresh staleness
      // and a current validAt reading.
      const validate = (node.flags & Flag.Computing) === 0;
      const validAt = (node as DerivedNode<unknown>).validAtGraphChange;
      let invalid = false;
      for (let l = node.deps; l !== undefined; l = l.nextDep) {
        linkIntoSubs(l);
        const dep = l.dep;
        addObserver(dep);
        if (
          validate &&
          (dep.changedAtGraphChange > validAt || (dep.flags & Flag.StaleMask) !== 0)
        ) {
          invalid = true;
        }
      }
      if (invalid && (node.flags & Flag.StaleMask) === 0) node.flags |= Flag.StaleCheck;
    }
    noteLifetimeTransition(node);
  }
}

/**
 * Demote: last observer leaves. Cascade-unlinks the back-edges promote
 * installed (after this, the chain holds forward references only — dropping
 * user handles collects it whole) and seeds the unwatched tier's
 * validAtGraphChange reading: Clean at demote means no dependency changed since last validation
 * (push marks were reliable while watched), so the next quiet read
 * short-circuits O(1); stale at demote forces the up-walk. Flag distrust
 * across the tier boundary lives entirely at the two crossings — promote
 * validates on re-watch, and unwatched pulls never trust Clean without a
 * current validAtGraphChange — so no staleness seeding happens here.
 */
export function removeObserver(node: ReactiveNode): void {
  node.observerCount--;
  if (node.observerCount === 0) {
    node.flags &= ~Flag.Watched;
    if ((node.flags & Flag.KindDerived) !== 0) {
      for (let l = node.deps; l !== undefined; l = l.nextDep) {
        unlinkFromSubs(l);
        removeObserver(l.dep);
      }
      (node as DerivedNode<unknown>).validAtGraphChange =
        (node.flags & Flag.StaleMask) === 0 ? graphChangeClock : 0;
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
  if ((node.flags & Flag.KindCell) === 0) return;
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
  if (tail !== undefined && tail.dep === dep && tail.evalPass === evalPass) return tail;
  const next = tail === undefined ? sub.deps : tail.nextDep;
  if (next !== undefined && next.dep === dep) {
    next.evalPass = evalPass;
    sub.depsTail = next;
    return next;
  }
  const watched = (sub.flags & Flag.Watched) !== 0;
  if (watched) {
    // Same-pass dedup for non-adjacent re-reads: this sub's earlier link
    // sits at the dep's subs tail (cursor reuse re-marks, new watched edges
    // land at the tail), so an evalPass match means the edge already exists and
    // is inside the kept prefix — return it instead of double-registering
    // the observer. Unwatched edges never enter subs lists, so unwatched
    // re-reads keep the tolerated duplicate forward edges (reading-
    // consistent, forward-only garbage).
    const last = dep.subsTail;
    if (last !== undefined && last.sub === sub && last.evalPass === evalPass) return last;
  }
  const link: Link = {
    dep,
    sub,
    nextDep: next,
    prevSub: undefined,
    nextSub: undefined,
    inSubs: false,
    evalPass,
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

// ---------------------------------------------------------------------------
// Invalidation (push through watched edges)
// ---------------------------------------------------------------------------

/** Effect watchers scheduled by the current wave. Cleared by logical length
 * (effectCount), never `.length = 0`: V8 right-trims the backing store on a
 * length reset, so a truncated queue re-grows its capacity from zero on
 * every wave (O(log n) reallocations plus copies, garbage proportional to
 * peak wave width). The price of retained capacity is that consumed slots
 * are nulled at drain — a soft-cleared slot must not pin a disposed watcher.
 * Append-then-fully-drain with the drain-time disposed check (Watched clear)
 * as the tombstone; there is no mid-queue removal, so no compaction
 * machinery. */
const effectQueue: Array<WatcherNode | undefined> = [];
let effectCount = 0;

/** Render-notify subscribers scheduled by the current wave; notified after
 * effects settle. Double-buffered under the same retained-capacity
 * discipline: a draining wave iterates its own buffer while re-marks from
 * onNotify land in the spare, so a wave's iteration never sees entries added
 * during delivery. */
let renderNotifyQueue: Array<ReactiveNode | undefined> = [];
let renderNotifyCount = 0;
/** The off-duty render-notify buffer; null while checked out by a draining
 * frame. Delivery can nest (onNotify may write, and that flush drains the
 * buffer this frame's re-marks are landing in), so a doubly-nested frame
 * finds the spare checked out and must not reuse a buffer that is
 * mid-iteration. */
let spareRenderNotify: Array<ReactiveNode | undefined> | null = [];

/** Route a watcher into its flush queue by capability bit. Scope anchors
 * carry neither bit and are never scheduled (they track no dependencies). */
function scheduleWatcher(w: WatcherNode): void {
  const flags = w.flags;
  // One masked test: not already queued AND not disposed (Watched = alive).
  if ((flags & (Flag.Scheduled | Flag.Watched)) !== Flag.Watched) return;
  if ((flags & Flag.WatchRender) !== 0) {
    renderNotifyQueue[renderNotifyCount++] = w;
  } else if ((flags & Flag.WatchRunEffect) !== 0) {
    effectQueue[effectCount++] = w;
  } else {
    return;
  }
  w.flags = flags | Flag.Scheduled;
}

// ---------------------------------------------------------------------------
// The graph walks. Contract matrix:
//
//                  | marks       | schedules | schedules   | dedup
//                  | staleness?  | effects?  | render      | mechanism
//                  |             |           | subscribers?|
// propagateWave    | StaleCheck  | yes       | yes         | the Clean→StaleCheck
//                  | on Clean    |           |             | transition (already-
//                  | nodes       |           |             | stale subtrees are
//                  |             |           |             | covered, not re-walked)
// pokeDraftWatchers| StaleCheck  | never     | WatchDraft  | per-node pokePass
//                  | on poked    |           | only        | reading vs the running
//                  | watchers    |           |             | walk's id (zero
//                  | only        |           |             | allocation, no clearing)
//
// Neither walk decides whether a subscriber RE-RENDERS: render-notify
// delivery invokes the subscriber's callback, and the React layer compares
// what it rendered against what it would resolve now (see hooks.ts) — a
// per-subscriber value predicate, which is how silent draft folds cost no
// renders without any global suppression state.
//
// propagateFrom and invalidateDerived are the wave's entry points: they add
// the root node's changedAt/clock movement, then run the wave.
// ---------------------------------------------------------------------------

/** Suspended traversal positions for the iterative walks (heap, not the JS
 * call stack, so walk depth is bounded by memory rather than stack frames). */
interface WaveFrame {
  value: Link | undefined;
  prev: WaveFrame | undefined;
}

interface PokeFrame extends WaveFrame {
  changed: boolean;
  prev: PokeFrame | undefined;
}

/**
 * The invalidation wave: push marks down the watched subs closure.
 *
 * Marks are always StaleCheck ("possibly stale"): consumers confirm against
 * dependency changedAt READINGS before recomputing or re-running. Readings —
 * not marks — are the recompute trigger, which is what makes
 * write-then-revert inside a batch a true no-op.
 *
 * Per-node visit rules (the wave's contract, also applied by any site that
 * installs a back-edge onto a stale dep — see observeNode):
 * 1. already stale → re-schedule an unscheduled watcher; do not descend
 *    (sound under the stale-cover invariant: dep stale ⇒ sub stale or
 *    scheduled, so everything below is already marked);
 * 2. Clean → set StaleCheck (never StaleDirty) and record the causal event;
 * 3. Watching → schedule; watchers have no subscribers, so never descend;
 * 4. KindDerived → descend (the Clean→StaleCheck transition is the wave's
 *    visited test).
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
      if ((flags & (Flag.Watching | Flag.Scheduled)) === Flag.Watching) {
        scheduleWatcher(sub as WatcherNode);
      }
    } else {
      sub.flags = flags | Flag.StaleCheck;
      sub.causeEvent = cause;
      if ((flags & Flag.Watching) !== 0) {
        scheduleWatcher(sub as WatcherNode);
      } else if ((flags & Flag.KindDerived) !== 0) {
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

/** Identity of the poke walk in progress. Monotonic and never reused, so a
 * node's pokePass reading needs no clearing: a match asserts "this walk
 * already visited the node" and nothing else (same discipline as EvalPass). */
let pokePass: PokePass = 0;

/**
 * The poke walk: notify draft watchers of a node without touching base
 * state (draft activity — intents appended, retired, or discarded — makes
 * draft readers re-resolve while base-state readers see no change). It shares
 * the wave's cursor + frame-stack skeleton and follows the same watched
 * derived edges down to the subscribers: probes subscribe to the node they
 * probe (a computed, usually), not to the drafted input, so stopping at the
 * cell would leave every downstream subscriber unaware. Base-state-only
 * watchers (no WatchDraft — all effects) stay untouched.
 *
 * Marking: poked watchers get StaleCheck for parity with the wave. The
 * choice is arbitrary — render-notify watchers are never validated (flush
 * clears staleness unconditionally before delivery), so between here and the
 * drain the bits are write-only; one convention keeps the matrix above
 * single-valued.
 *
 * `wake` requests draft-id delivery to the same frontier in this ONE walk
 * (intent appends need both jobs every time; retire/discard/commit call
 * sites poke without waking). `valueChanged`, when present, supplies the
 * single-draft value cutoff for each producer: value hooks skip equal
 * producers while value-independent probes still hear the poke. The walk
 * runs in the writer's ambient context, so inside a React transition scope
 * the wake dispatches ride that transition's lanes. The notify flush still
 * precedes wake delivery: the flush's effects may dispose subscriptions,
 * and a subscriber disposed by them must not receive the draft id.
 */
export function pokeDraftWatchers(
  node: ReactiveNode,
  cause: TraceEventId,
  wake?: DraftId,
  valueChanged?: (node: ReactiveNode) => boolean,
): void {
  const pass = ++pokePass;
  let wakes: WatcherNode[] | null = null;
  let changed = valueChanged?.(node) ?? true;
  const first = node.subs;
  if (first !== undefined) {
    let cur: Link = first;
    let next: Link | undefined = cur.nextSub;
    let stack: PokeFrame | undefined;
    top: do {
      const sub = cur.sub;
      if (sub.pokePass !== pass) {
        sub.pokePass = pass;
        const flags = sub.flags;
        if ((flags & Flag.WatchDraft) !== 0) {
          const w = sub as WatcherNode;
          // Value hooks have a draft-lane callback and can use the optional
          // computed cutoff. Probes carry no callback: they still need the
          // poke because pendingness may change while the value stays equal.
          if (w.onDraftWake === undefined || changed) {
            scheduleWatcher(w);
            if ((w.flags & Flag.StaleMask) === 0) w.flags |= Flag.StaleCheck;
            w.causeEvent = cause;
            if (wake !== undefined && w.onDraftWake !== undefined) (wakes ??= []).push(w);
          }
        } else if ((flags & Flag.KindDerived) !== 0) {
          const subSubs = sub.subs;
          if (subSubs !== undefined) {
            const subChanged = valueChanged?.(sub) ?? true;
            cur = subSubs;
            if (cur.nextSub !== undefined) {
              stack = { value: next, changed: subChanged, prev: stack };
              next = cur.nextSub;
            }
            changed = subChanged;
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
        changed = stack.changed;
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
  if (batchDepth === 0) flush();
  if (wakes !== null) {
    for (const w of wakes) {
      if ((w.flags & Flag.Watched) !== 0) w.onDraftWake!(wake!);
    }
  }
}

/** Push a change wave from a cell whose base value advanced. */
export function propagateFrom(cell: CellNode<unknown>, cause: TraceEventId): void {
  propagateWave(cell.subs, cause);
  if (batchDepth === 0) flush();
}

/**
 * Invalidate a derived from outside the dependency graph (thenable
 * settlement). Treated exactly like a write: the clock ticks and the node's
 * changedAt reading advances so downstream validation re-pulls, subscribers
 * get marked, effects run.
 */
export function invalidateDerived(node: DerivedNode<unknown>, cause: TraceEventId): void {
  graphChangeClock++;
  node.flags = (node.flags & ~Flag.StaleMask) | Flag.StaleDirty;
  node.causeEvent = cause;
  // Invariant: changes are stamped with the CURRENT clock, after the tick.
  node.changedAtGraphChange = graphChangeClock;
  propagateWave(node.subs, cause);
  if (batchDepth === 0) flush();
}

/** Cells written inside the current batch scope, with their pre-batch state:
 * a net-revert restores the changedAt reading so consumers validate as
 * unchanged. */
const batchBase = new Map<
  CellNode<unknown>,
  { value: unknown; changedAtGraphChange: GraphChangeClock }
>();

/** Identity of the current top-level batch scope; ticks when a batch opens
 * at depth 0 (nested batches join the enclosing pass, matching batchBase's
 * lifetime). Cells store their reading in cell.batchPass. */
let batchPass: BatchPass = 0;

export function startBatch(): void {
  if (batchDepth === 0) batchPass++;
  batchDepth++;
}

export function endBatch(): void {
  if (batchDepth === 0) throw new Error('endBatch() without a matching startBatch()');
  batchDepth--;
  if (batchDepth === 0) {
    if (batchBase.size > 0) {
      for (const [cell, base] of batchBase) {
        if (cell.value !== UNINITIALIZED && base.value !== UNINITIALIZED) {
          // Invariant: a net-revert restores the changedAt reading — the
          // batch produced no real change, so consumers must validate as
          // unchanged (the clock still ticked; they pay one reading compare).
          if (cell.equals(cell.value, base.value)) {
            cell.changedAtGraphChange = base.changedAtGraphChange;
          }
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
/** Drain cursor into effectQueue (index, not shift: the queue can be large
 * and repeated shifts would make wide flushes quadratic). */
let queueHead = 0;

/** Hard iteration ceiling: converts livelock into a thrown error. */
const enum Limit {
  /** Queued-effect runs per flush before declaring a non-settling cycle. */
  FlushRuns = 100_000,
}

/** Run queued effects until settled, then deliver render notifications. A
 * throwing effect aborts the flush; the effects it preempted are skipped
 * (cleared), not left armed for unrelated writes to trigger later. */
export function flush(): void {
  if (flushing) return;
  if (effectCount === 0 && renderNotifyCount === 0) return;
  flushing = true;
  try {
    let guard = 0;
    while (queueHead < effectCount) {
      if (++guard > Limit.FlushRuns) throw new Error('effect flush did not settle (cycle?)');
      const i = queueHead++;
      const w = effectQueue[i]!;
      effectQueue[i] = undefined; // consumed slot must not pin the watcher
      // Clear Scheduled alone: runWatcher's validation reads StaleCheck.
      const flags = (w.flags &= ~Flag.Scheduled);
      if ((flags & Flag.Watched) === 0 || (flags & Flag.StaleMask) === 0) continue;
      runWatcher(w);
    }
    effectCount = 0;
    queueHead = 0;
  } catch (e) {
    // Preempted effects are skipped, not left armed for unrelated writes to
    // trigger later; their unconsumed slots get the same nulling discipline.
    for (let i = queueHead; i < effectCount; i++) {
      const w = effectQueue[i]!;
      effectQueue[i] = undefined;
      w.flags &= ~(Flag.Scheduled | Flag.StaleMask);
    }
    effectCount = 0;
    queueHead = 0;
    throw e;
  } finally {
    flushing = false;
    if (renderNotifyCount > 0) {
      // Take this wave's buffer and swap the spare in as the push target:
      // subscribers scheduled during delivery land there for the NEXT wave,
      // so this iteration never sees them. A doubly-nested delivery finds
      // the spare checked out (null) and takes a fresh array — that rare
      // frame pays a per-wave allocation rather than clobbering a live
      // iteration.
      const delivering = renderNotifyQueue;
      const n = renderNotifyCount;
      renderNotifyQueue = spareRenderNotify ?? [];
      spareRenderNotify = null;
      renderNotifyCount = 0;
      for (let i = 0; i < n; i++) {
        const w = delivering[i] as WatcherNode;
        // Render-notify watchers are never validated, so Scheduled and the
        // staleness bits clear together in one masked store.
        w.flags &= ~(Flag.Scheduled | Flag.StaleMask);
      }
      try {
        for (let i = 0; i < n; i++) {
          const w = delivering[i] as WatcherNode;
          if ((w.flags & Flag.Watched) !== 0) w.onNotify!();
        }
      } finally {
        // Null consumed slots — retained capacity must not pin watchers —
        // and hand the buffer back as the spare, also on a throwing notify.
        for (let i = 0; i < n; i++) delivering[i] = undefined;
        spareRenderNotify = delivering;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reads and validation (pull)
// ---------------------------------------------------------------------------

export class WriteForbiddenError extends Error {}
/** Policy only. The graph's self-affecting-computed mechanism remains intact;
 * changing this to false restores writes from computeds without changing the
 * evaluation or validation machinery. */
export const FORBID_WRITE_FROM_COMPUTED: boolean = true;

let readsForbidden: string | null = null;
let writesForbidden: string | null = null;

export function assertSignalReadAllowed(): void {
  if (readsForbidden !== null) throw new Error(readsForbidden);
}

export function assertSignalWriteAllowed(): void {
  if (writesForbidden !== null) throw new WriteForbiddenError(writesForbidden);
  if (
    FORBID_WRITE_FROM_COMPUTED &&
    activeConsumer !== null &&
    (activeConsumer.flags & Flag.KindDerived) !== 0
  ) {
    throw new WriteForbiddenError('writes inside computeds are forbidden');
  }
}

export function setWritesForbidden(reason: string | null): string | null {
  const prev = writesForbidden;
  writesForbidden = reason;
  return prev;
}

export function runUpdater<T>(fn: (value: T) => T, value: T): T {
  const prevReads = readsForbidden;
  const prevWrites = writesForbidden;
  readsForbidden = 'signal reads are not allowed inside an updater or reducer';
  writesForbidden = 'signal writes are not allowed inside an updater or reducer';
  try {
    return fn(value);
  } finally {
    readsForbidden = prevReads;
    writesForbidden = prevWrites;
  }
}

function materializeCell<T>(cell: CellNode<T>): void {
  if (cell.value !== UNINITIALIZED) return;
  const init = cell.initializer;
  if (init === undefined) throw new Error('cyclic lazy initializer');
  cell.initializer = undefined;
  const prevConsumer = activeConsumer;
  const prevForbidden = setWritesForbidden('a lazy state initializer must not write to other state');
  activeConsumer = null;
  try {
    cell.value = init();
  } catch (error) {
    cell.initializer = init;
    throw error;
  } finally {
    activeConsumer = prevConsumer;
    setWritesForbidden(prevForbidden);
  }
}

/** Untracked base-value read; materializes a lazy cell. */
export function peekCell<T>(cell: CellNode<T>): T {
  assertSignalReadAllowed();
  materializeCell(cell);
  return cell.value as T;
}

export function readCell<T>(cell: CellNode<T>): T {
  assertSignalReadAllowed();
  materializeCell(cell);
  if (activeConsumer !== null) trackRead(cell, activeConsumer);
  return cell.value as T;
}

export function writeCell<T>(cell: CellNode<T>, next: T): boolean {
  assertSignalWriteAllowed();
  // The equality contract compares against the base value, so a write that
  // arrives before the first read still runs the initializer.
  materializeCell(cell);
  if (cell.equals(cell.value as T, next)) return false;
  if (batchDepth > 0 && cell.batchPass !== batchPass) {
    // First write to this cell in this batch pass: save the pre-batch state.
    // The pass stamp stands in for a batchBase.has probe on repeat writes.
    cell.batchPass = batchPass;
    batchBase.set(cell as CellNode<unknown>, {
      value: cell.value,
      changedAtGraphChange: cell.changedAtGraphChange,
    });
  }
  cell.value = next;
  // Invariant: tick the clock FIRST, then stamp the change with the new
  // reading — a change stamped at a pre-tick reading could compare equal to
  // a subscriber that validated before this write.
  graphChangeClock++;
  cell.changedAtGraphChange = graphChangeClock;
  const cause = traceHook !== null ? traceHook('write', cell, currentCause) : NO_EVENT;
  propagateFrom(cell as CellNode<unknown>, cause);
  return true;
}

/** Thrown by evaluation when it parks on an unresolved thenable. */
export const PARKED = Symbol('parked');

/** Set by asyncs.ts: called for use(t) inside a base-state evaluation. */
export let useImpl: (t: PromiseLike<unknown>, consumer: DerivedNode<unknown>) => unknown = () => {
  throw new Error('async use() is not installed');
};
export function setUseImpl(impl: typeof useImpl): void {
  useImpl = impl;
}

/** Set by asyncs.ts: finish a recompute, folding parks into async state.
 * Positional outcome (parked, hasError, error, value) — this runs once per
 * recompute, so it must not cost an outcome-object allocation. */
export let finishComputeImpl: (
  node: DerivedNode<unknown>,
  parked: boolean,
  hasError: boolean,
  error: unknown,
  value: unknown,
) => boolean = (node, parked, hasError, error, value) => {
  if (parked || hasError) throw hasError ? error : new Error('parked without async layer');
  const prev = node.value;
  if (prev === UNINITIALIZED || !node.equals(prev, value)) {
    node.value = value;
    return true;
  }
  return false;
};
export function setFinishComputeImpl(impl: typeof finishComputeImpl): void {
  finishComputeImpl = impl;
}

function recompute(node: DerivedNode<unknown>): void {
  if ((node.flags & Flag.Computing) !== 0) {
    throw new Error(`cycle detected in computed${node.label ? ` "${node.label}"` : ''}`);
  }
  node.flags |= Flag.Computing;
  const prevConsumer = activeConsumer;
  activeConsumer = node;
  const myPass = newEvalPass();
  node.depsTail = undefined;
  // The validation reading is taken at the PRE-eval clock: if the evaluation
  // itself writes (self-affecting computed), the next read must revalidate.
  const preGraphChange = graphChangeClock;
  let parked = false;
  let hasError = false;
  let error: unknown;
  let value: unknown;
  try {
    value = node.fn(node.useFn, node.value === UNINITIALIZED ? undefined : node.value);
  } catch (e) {
    if (e === PARKED) parked = true;
    else {
      hasError = true;
      error = e;
    }
  } finally {
    // A nested eval advanced the pass id; restore ours so trimming is exact.
    evalPass = myPass;
    activeConsumer = prevConsumer;
    trimDeps(node);
    node.flags &= ~Flag.Computing;
  }
  const changed = finishComputeImpl(node, parked, hasError, error, value);
  // Invariant: only a REAL change advances the reading (equality cutoff
  // keeps the old stamp, so downstream validAt comparisons stay equal).
  // Stamped with the CURRENT clock, not the pre-eval reading: recomputes do
  // not tick the clock, and any consumer that validated before this
  // recompute holds a strictly older validAt reading.
  if (changed) node.changedAtGraphChange = graphChangeClock;
  // A computed whose evaluation wrote state is self-affecting: its inputs
  // moved under it, so it never caches — every read re-evaluates.
  node.flags =
    (node.flags & ~Flag.StaleMask) | (graphChangeClock !== preGraphChange ? Flag.StaleDirty : 0);
  node.validAtGraphChange = preGraphChange;
}

/** Bring a derived up to date; exact recompute counts are the contract. */
export function ensureFresh(node: DerivedNode<unknown>): void {
  const flags = node.flags;
  if ((flags & Flag.Watched) !== 0) {
    // Watched: push marks are trustworthy (promote validated the closure).
    if ((flags & Flag.StaleMask) === 0) return;
  } else if ((flags & Flag.StaleMask) === 0 && node.validAtGraphChange === graphChangeClock) {
    return;
  }
  if ((node.flags & Flag.StaleDirty) !== 0 || node.value === UNINITIALIZED) {
    recompute(node);
    return;
  }
  // StaleCheck state (or unwatched revalidation): confirm dependencies
  // upward, in first-read order, recomputing only if some dependency truly
  // changed after this node's last validation. Invariant: a dep is
  // FRESHENED before its reading is compared — a lazy dep may recompute
  // right here, stamping its changedAt with the current clock, and the
  // strictly-greater test then reports it correctly.
  for (let l = node.deps; l !== undefined; l = l.nextDep) {
    const dep = l.dep;
    // Same watched-Clean skip as readDerived: such a dep has nothing to
    // validate, so don't pay a call to find that out.
    const dflags = dep.flags;
    if (
      (dflags & Flag.KindDerived) !== 0 &&
      (dflags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched
    ) {
      ensureFresh(dep as DerivedNode<unknown>);
    }
    if (dep.changedAtGraphChange > node.validAtGraphChange) {
      recompute(node);
      return;
    }
  }
  node.flags &= ~Flag.StaleMask;
  // Invariant: the watermark is stamped only AFTER every dep was freshened
  // and compared (freshen-then-stamp order).
  node.validAtGraphChange = graphChangeClock;
}

export function readDerived<T>(node: DerivedNode<T>): T {
  assertSignalReadAllowed();
  // Watched + Clean is the hot steady state (push marks are trustworthy,
  // nothing to validate) — skip the ensureFresh call entirely. Everything
  // else (stale, or unwatched needing the currency check) takes the call.
  if ((node.flags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched) {
    ensureFresh(node as DerivedNode<unknown>);
  }
  if (activeConsumer !== null) trackRead(node, activeConsumer);
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
// Watchers: effects, scopes, and store subscriptions
// ---------------------------------------------------------------------------

function makeWatcher(
  fn: (() => void | (() => void)) | undefined,
  capabilities: number,
): WatcherNode {
  return {
    // Watchers are born watched — for a watcher the bit means ALIVE, and it
    // drops at dispose; their edges never go through promote/demote
    // counting. Capability bits are creation-fixed: they route scheduling
    // for the watcher's whole life.
    flags: Flag.Watching | Flag.Watched | capabilities,
    changedAtGraphChange: 0,
    validAtGraphChange: 0,
    throwable: null,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    observerCount: 0,
    causeEvent: NO_EVENT,
    label: undefined,
    fn,
    cleanup: undefined,
    children: undefined,
    onNotify: undefined,
    onDraftWake: undefined,
    worldMemos: null,
    pokePass: 0,
  };
}

let activeScope: WatcherNode | null = null;

function runWatcher(w: WatcherNode): void {
  // Validate: a StaleCheck-marked watcher whose derived deps cut off must
  // not re-run its body. Validation can itself run user code (computed fns)
  // that disposes this very watcher — re-check after every pull.
  if ((w.flags & Flag.StaleCheck) !== 0) {
    let changed = false;
    for (let l = w.deps; l !== undefined; l = l.nextDep) {
      const dep = l.dep;
      // Same watched-Clean skip as readDerived: such a dep has nothing to
      // validate, so don't pay a call to find that out.
      const dflags = dep.flags;
      if (
        (dflags & Flag.KindDerived) !== 0 &&
        (dflags & (Flag.Watched | Flag.StaleMask)) !== Flag.Watched
      ) {
        ensureFresh(dep as DerivedNode<unknown>);
        if ((w.flags & Flag.Watched) === 0) return; // disposed mid-validation
      }
      if (dep.changedAtGraphChange > w.validAtGraphChange) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      w.flags &= ~Flag.StaleMask;
      // Invariant: watermark stamped only after every dep was freshened and
      // compared (freshen-then-stamp order) — same rule as ensureFresh.
      w.validAtGraphChange = graphChangeClock;
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
  // Only live effect watchers run a body (WatchRunEffect is creation-fixed
  // and implies fn; Watched = alive).
  if ((w.flags & (Flag.WatchRunEffect | Flag.Watched)) !== (Flag.WatchRunEffect | Flag.Watched)) {
    return;
  }
  const prevConsumer = activeConsumer;
  const prevScope = activeScope;
  activeConsumer = w;
  activeScope = w;
  const myPass = newEvalPass();
  w.depsTail = undefined;
  const cause = traceHook !== null ? traceHook('effect-run', w, w.causeEvent) : NO_EVENT;
  // The validation reading is taken at the PRE-run clock: if the body
  // itself writes, its deps may have moved under it, and the wave its write
  // pushed re-schedules this watcher — whose next validation must then see
  // those deps as changed-since (their stamps exceed the pre-run reading).
  const preGraphChange = graphChangeClock;
  const prevCause = setCurrentCause(cause);
  try {
    const ret = w.fn!();
    if (typeof ret === 'function') w.cleanup = ret;
  } finally {
    setCurrentCause(prevCause);
    evalPass = myPass;
    activeConsumer = prevConsumer;
    activeScope = prevScope;
    trimDeps(w);
    w.validAtGraphChange = preGraphChange;
  }
}

export function disposeWatcher(w: WatcherNode): void {
  // Disposal state is the Watched bit: Watching set + Watched clear = dead.
  if ((w.flags & Flag.Watched) === 0) return;
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
  const w = makeWatcher(fn, Flag.WatchRunEffect);
  const owned = activeScope !== null && (activeScope.flags & Flag.Watched) !== 0;
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
  // A scope anchor: owns child effects, takes no deliveries of its own.
  const w = makeWatcher(undefined, 0);
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
 * A store subscription: subscribes a callback to a node's invalidation wave
 * without pulling it. This is the React (and committed-view) channel; the
 * callback runs after the wave and its effects settle, so subscribers can
 * re-read a consistent graph. Subscriptions are the full component shape —
 * render-notified and draft-aware (WatchRender|WatchDraft) — regardless of
 * whether a draft-lane callback is installed: draft pings must reach probes
 * (isPending, committed views) that carry no wake channel.
 */
export function observeNode(
  node: ReactiveNode,
  notify: () => void,
  draftWake?: (id: DraftId) => void,
): () => void {
  const sub = makeWatcher(undefined, Flag.WatchRender | Flag.WatchDraft);
  sub.onNotify = notify;
  sub.onDraftWake = draftWake;
  newEvalPass();
  sub.depsTail = undefined;
  const prevConsumer = activeConsumer;
  activeConsumer = sub;
  try {
    if ((node.flags & Flag.KindCell) !== 0) readCell(node as CellNode<unknown>);
    else if ((node.flags & Flag.KindDerived) !== 0) {
      // Subscribe to invalidation only; do not force evaluation here.
      trackRead(node, sub);
      // This installed a back-edge without a pull, so the stale-cover
      // invariant is on this site: a stale node means the staleness edge
      // this subscriber cares about already fired (or, for promote-seeded
      // StaleCheck, could never fire while unwatched) — apply the wave's
      // visit rules to the new subscriber so it hears it once. A pull
      // re-arms; edge-triggered semantics are preserved. Never-computed
      // nodes are exempt: they are born StaleDirty with no dependency
      // edges, so no wave was ever swallowed and there is no missed edge —
      // exactly the edge-triggered contract's "no Clean→stale transition
      // happened yet".
      if (
        (node.flags & Flag.StaleMask) !== 0 &&
        (node as DerivedNode<unknown>).value !== UNINITIALIZED
      ) {
        sub.flags |= Flag.StaleCheck;
        sub.causeEvent = node.causeEvent;
        scheduleWatcher(sub);
      }
    }
  } finally {
    activeConsumer = prevConsumer;
  }
  if (batchDepth === 0) flush();
  const dispose = () => {
    droppedDisposers.unregister(dispose);
    disposeWatcher(sub);
  };
  droppedDisposers.register(dispose, sub, dispose);
  return dispose;
}
