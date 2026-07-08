/**
 * signals-royale-fx1 — a concurrent signal engine designed to sit under React.
 *
 * The engine owns update scheduling. Instead of asking React which batch a
 * render belongs to, the engine creates a batch (an "episode") for every
 * transition-classified write, asks the host (the React runtime adapter) for a
 * dedicated lane, and dispatches every re-render request for that episode —
 * original or corrective — under that same lane. React then simply renders
 * what it was told to render, and reports back three facts: a render pass
 * started (root + lanes), a commit landed (root + lanes), and the exact DOM
 * mutation window. Everything else — speculative values, rebasing, per-root
 * committed views, suspense settlement ownership — is engine state.
 *
 * Value model:
 * - Each atom has one canonical "base" value. Urgent writes replace the base
 *   immediately (they are canonically visible before React even renders).
 * - A transition write never touches the base. It appends an operation to the
 *   episode's log for that atom. A world is "base + the ops of some episodes,
 *   replayed in episode creation order"; functional updates re-execute against
 *   whatever base they are replayed on, which is what makes an urgent write
 *   rebase a pending transition instead of being clobbered by it.
 * - When React commits an episode everywhere it was delivered, the episode
 *   retires: its ops replay onto the base once, and the log is dropped.
 * - Render passes read through a Frame: the base as of a pinned write-seq
 *   (an MVCC snapshot, so urgent writes racing a time-sliced render can't
 *   tear it) plus the episodes React is rendering.
 */

// ---------------------------------------------------------------------------
// Identifiers and small shared types
// ---------------------------------------------------------------------------

/** Monotonic clock of canonical (base) writes. Every base change gets a new seq. */
export type WriteSeq = number;
/** Creation-ordered identity of an episode (one engine-owned update batch). */
export type EpisodeSeq = number;
/** Version counter on a node value; bumps exactly when the value changes. */
export type NodeVersion = number;
/** Causality event id issued by the tracer; 0 means "no cause". */
export type TraceEventId = number;

export type Equality<T> = (a: T, b: T) => boolean;

/** One recorded write: either a plain replacement or a functional update. */
type Op<T> = { fn: ((prev: T) => T) | null; value: T | undefined };
/** A queued write: `ep` null = urgent; `seq` orders it against base history. */
type PendingOp<T> = Op<T> & { ep: Episode | null; seq: WriteSeq };

const is: Equality<unknown> = Object.is;

// ---------------------------------------------------------------------------
// Tracer sink — the engine emits through this narrow interface; the ring
// buffer, queries and formatting live in tracer.ts. Detached cost is one
// null check per emit site.
// ---------------------------------------------------------------------------

export interface TraceSink {
  emit(kind: string, cause: TraceEventId, detail?: string, node?: object): TraceEventId;
}

export let trace: TraceSink | null = null;
export function setTraceSink(sink: TraceSink | null): void {
  trace = sink;
}
/** The causal parent for events emitted right now (write → notify → render). */
export let traceCause: TraceEventId = 0;
export function setTraceCause(id: TraceEventId): TraceEventId {
  const prev = traceCause;
  traceCause = id;
  return prev;
}

// ---------------------------------------------------------------------------
// Host protocol — how the React runtime plugs in. The engine is React-free;
// everything React-shaped is behind this interface. Engine tests drive it
// directly with a fake host.
// ---------------------------------------------------------------------------

export interface EngineHost {
  /**
   * Ambient batch classification for a write happening right now. Returning
   * a token (any object identity, e.g. React's transition object) classifies
   * the write into that token's episode; null means urgent.
   */
  currentBatchToken(): object | null;
  /** True while host UI code is rendering — writes must fail loudly then. */
  isRendering(): boolean;
  /**
   * Deliver a re-render request to a subscriber. `episode` null means urgent.
   * The host must dispatch under the episode's own lane so the delivery
   * commits with that episode's batch and never beside it.
   */
  deliver(sub: Sub, episode: Episode | null): void;
}

let host: EngineHost | null = null;
export function setHost(h: EngineHost | null): void {
  host = h;
}

// ---------------------------------------------------------------------------
// Engine globals
// ---------------------------------------------------------------------------

let writeSeq: WriteSeq = 1; // seq of the latest base write
let episodeSeq: EpisodeSeq = 1;

/** The computation currently having its dependencies tracked. */
let activeObserver: Derived<any> | EffectNode | null = null;
/** The world reads resolve in; null = canonical. */
let activeFrame: Frame | null = null;
/** The async evaluation owning `use()` calls right now. */
let activeEval: EvalCtx | null = null;
/** Set while a lazy initializer runs; initializers are forbidden to write. */
let initializing = false;

let batchDepth = 0;
const effectQueue: EffectNode[] = [];
let flushing = false;

/** Subscribers with a pending delivery, deduped per (sub, episode) per batch. */
const pendingDeliveries = new Map<Sub, Set<Episode | null>>();

/** All open (unretired) episodes in creation order. */
const openEpisodes: Episode[] = [];
/** Token → episode for ambient write classification. */
const episodesByToken = new Map<object, Episode>();

/** Live render-pass frames by host root key. */
const passFrames = new Map<object, Frame>();
/** Cells that grew MVCC history entries; cleared when no pass is live. */
const cellsWithHistory = new Set<Cell<any>>();
/** Cells with a live update queue; swept for collapse when frames close. */
const cellsWithQueues = new Set<Cell<any>>();

/** Per-root committed snapshots (what is on that root's screen). */
const rootViews = new Map<object, Map<Cell<any> | Derived<any>, unknown>>();

/** Bumped on every episode lifecycle edge and async flip; isPending probes key off it. */
export let pendingEpoch = 0;

export function engineNow(): { writeSeq: WriteSeq; openEpisodes: number } {
  return { writeSeq, openEpisodes: openEpisodes.length };
}

export function openEpisodesSnapshot(): readonly Episode[] {
  return openEpisodes;
}

/** Would this episode's ops change what `node` shows? (Corrective joins.) */
export function episodeAffects(ep: Episode, node: Node): boolean {
  if (ep.state !== "open") return false;
  if (node instanceof Cell) return ep.cells.has(node);
  if (ep.refreshMarks !== null && ep.refreshMarks.has(node)) return true;
  return new Frame([ep], -1).touches(node);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function loud(message: string): Error {
  return new Error(`signals-royale-fx1: ${message}`);
}

/** Thrown when an evaluation reads itself (directly or through a chain). */
export class CycleError extends Error {
  constructor(label: string | undefined) {
    super(`signals-royale-fx1: dependency cycle at ${label ?? "computed"}`);
  }
}

// ---------------------------------------------------------------------------
// Graph core — cells, deriveds, effects.
//
// Canonical values live on the nodes themselves and are maintained with the
// usual lazy push/pull discipline: writes mark downstream, reads verify by
// polling source versions, equality cuts propagation. Speculative worlds
// never touch this state; they evaluate through Frames (below).
// ---------------------------------------------------------------------------

const CLEAN = 0;
const CHECK = 1;
const DIRTY = 2;
type DerivedState = typeof CLEAN | typeof CHECK | typeof DIRTY;

/** Result of an evaluation: a plain value, a parked pending, or an error. */
export class Pending {
  /** Stable across re-reads and React render retries while unsettled. */
  constructor(public ctx: EvalCtx) {}
  get promise(): Promise<unknown> {
    return this.ctx.representative!.promise;
  }
}
export class Failure {
  constructor(public error: unknown) {}
}
/** What `use()` returns for an unsettled thenable: an inert placeholder so the
 * evaluation keeps running and registers its remaining async reads. */
const POISON = undefined;

/* eslint-disable @typescript-eslint/no-explicit-any */
// Graph-internal typing uses `any` for node payloads: `Equality<T>` makes
// Cell<T> invariant in T, and the graph genuinely does not care what T is.
export type Node = Cell<any> | Derived<any>;
type Observer = Derived<any> | EffectNode;

/** A live external subscriber (a React hook instance, typically). */
export interface Sub {
  /** The node this subscriber rendered. */
  node: Node;
  /** Host root this subscriber lives under (opaque key), if known. */
  rootKey: object | null;
  /** Raw slot the subscriber last saw; deliveries that would show the same
   * value are skipped. `SUB_NEVER` forces the first comparison to differ. */
  snapshot: unknown;
  /** Cells this sub's last speculative render touched (null = canonical render). */
  cells: Set<Cell<any>> | null;
  /** True for isPending probes: delivered on pending flips, not value changes. */
  probe: boolean;
  /** True for committed-view watchers: also delivered when a commit changes
   * their node's committed snapshot. */
  committedWatcher?: boolean;
  lastPending?: boolean;
  /** Trace id of the delivery that caused the sub's latest render. */
  causeId: TraceEventId;
}
export const SUB_NEVER: unique symbol = Symbol("never-rendered");

/** Subs whose last render was speculative; scanned on episode writes so
 * speculative-only dependencies still get notified. */
const speculativeSubs = new Set<Sub>();
/** isPending probes, delivered on pendingEpoch flips. */
const probeSubs = new Set<Sub>();
let subCount = 0;

export class Cell<T> {
  /** Monomorphic discriminator (hot paths avoid instanceof). */
  readonly isCell = true;
  value!: T;
  /** Bumps when the canonical value changes (graph polling). */
  version: NodeVersion = 1;
  /** WriteSeq of the last base write (MVCC reads). */
  baseSeq: WriteSeq = 0;
  equals: Equality<T>;
  label: string | undefined;
  /** Pending lazy initializer; null once materialized. */
  init: (() => T) | null;
  /** Canonical downstream observers (slot-linked). */
  obs: Observer[] = [];
  obsSlots: number[] = [];
  /** React-side subscribers attached directly to this cell. */
  subs: Set<Sub> | null = null;
  /** Live watcher count across every kind (effects, live deriveds, subs). */
  live = 0;
  /** Lifetime effect: runs while observed by anything, cleans up when not. */
  onObserved: ((ctx: { get(): T; set(v: T): void }) => void | (() => void)) | null = null;
  observedCleanup: (() => void) | null = null;
  observedActive = false;
  observedTaskQueued = false;
  /**
   * Present while any op references an open episode: the update queue.
   * `base` is the canonical value when the queue formed; ops replay from it
   * in scheduling order (exactly React's updater-queue arithmetic — a skipped
   * transition op re-applies in its original position when it lands, so an
   * urgent ×2 over a pending +2 on 1 shows 2 now and (1+2)×2 = 6 after).
   */
  pend: { base: T; baseSeq: WriteSeq; ops: Array<PendingOp<T>> } | null = null;
  /** MVCC history: [replacedAtSeq, priorValue], appended on base writes while
   * render passes are live so a pinned pass never sees a newer base. */
  hist: Array<[WriteSeq, T]> | null = null;
  /** Value at the most recent commit that delivered this cell to any root. */
  committedValue: { v: unknown } | null = null;

  constructor(initial: T | (() => T), opts?: AtomOptions<T>) {
    this.equals = opts?.equals ?? (is as Equality<T>);
    this.label = opts?.label;
    this.onObserved = opts?.onObserved ?? null;
    if (typeof initial === "function") {
      this.init = initial as () => T;
    } else {
      this.init = null;
      this.value = initial;
    }
  }

  /** Run the lazy initializer if it has not run yet (first materialization). */
  materialize(): void {
    if (this.init === null) return;
    const fn = this.init;
    this.init = null;
    const prevInit = initializing;
    const prevObs = activeObserver;
    initializing = true;
    activeObserver = null; // initializers run untracked
    try {
      this.value = fn();
    } finally {
      initializing = prevInit;
      activeObserver = prevObs;
    }
    if (trace !== null) trace.emit("initialize", traceCause, this.label, this);
  }

  get(): T {
    if (activeFrame !== null) return frameCellRead(this, activeFrame);
    this.materialize();
    if (activeObserver !== null) linkSource(this, activeObserver);
    return this.value;
  }

  set(value: T): void {
    writeCell(this, null, value);
  }

  update(fn: (prev: T) => T): void {
    writeCell(this, fn, undefined);
  }

  peek(): T {
    return untracked(() => this.get());
  }
}

export interface AtomOptions<T> {
  equals?: Equality<T>;
  label?: string;
  onObserved?: (ctx: { get(): T; set(v: T): void }) => void | (() => void);
}

export type Use = <U>(t: PromiseLike<U>) => U;

export class Derived<T> {
  readonly isCell = false;
  fn: (use: Use) => T;
  equals: Equality<T>;
  label: string | undefined;
  /** Canonical slot: T, Pending, or Failure. Undefined before first eval. */
  slot: unknown = undefined;
  version: NodeVersion = 0;
  state: DerivedState = DIRTY;
  evaluating = false;
  /** Set when a settlement (not a source change) dirtied this node, so the
   * next run keeps its thenable slots instead of refetching. */
  settleRerun = false;
  sources: Node[] = [];
  sourceSlots: number[] = [];
  sourceStamps: unknown[] = [];
  obs: Observer[] = [];
  obsSlots: number[] = [];
  subs: Set<Sub> | null = null;
  live = 0;
  trackIndex = 0;
  /** writeSeq when this (cold) node last verified its sources; a repeat read
   * with no writes in between skips the poll entirely. */
  pollSeq: WriteSeq = -1;
  /** Slot at the most recent commit that delivered this derived to any root. */
  committedSlot: { v: unknown } | null = null;
  /** Canonical async context (created on first `use`). */
  ctx: EvalCtx | null = null;
  /** Per-world async contexts, keyed by episode-seq list. */
  worldCtx: Map<string, EvalCtx> | null = null;

  constructor(fn: (use: Use) => T, opts?: { equals?: Equality<T>; label?: string }) {
    this.fn = fn;
    this.equals = opts?.equals ?? (is as Equality<T>);
    this.label = opts?.label;
  }

  /** Canonical read. Parked evaluations serve their last settled value when
   * they have one; a never-settled read throws the stable representative
   * thenable (engine-level suspense). Failures rethrow their stable error. */
  get(): T {
    if (activeFrame !== null) return unwrap(frameDerivedRead(this, activeFrame)) as T;
    return unwrap(readCanonical(this)) as T;
  }

  peek(): T {
    return untracked(() => this.get());
  }
}

/** Raw slot → public value policy shared by canonical and frame reads. */
function unwrap(slot: unknown): unknown {
  if (slot === null || typeof slot !== "object") return slot;
  if (slot instanceof Failure) throw slot.error;
  if (slot instanceof Pending) {
    // Inside another evaluation: forward pending and keep that evaluation
    // running so the rest of its async reads still register.
    if (activeEvalRun !== null) {
      activeEvalRun.pending = true;
      (activeEvalRun.waits ??= []).push(slot);
      return POISON;
    }
    const ctx = slot.ctx;
    if (ctx.hasSettled) return ctx.settledValue; // stale serves, isPending flags it
    throw slot.promise;
  }
  return slot;
}

// ---------------------------------------------------------------------------
// Dependency tracking (slot-linked edges) and liveness
// ---------------------------------------------------------------------------

function linkSource(source: Node, observer: Observer): void {
  // Dedupe repeat reads of the same source within one run (common and cheap
  // to catch: the source was the last one linked, or already linked this run).
  const n = observer.trackIndex;
  const sources = observer.sources;
  if (n < sources.length && sources[n] === source) {
    // Same edge as the previous run: refresh the recorded stamp.
    observer.sourceStamps[n] = edgeStamp(source);
    observer.trackIndex = n + 1;
    return;
  }
  for (let i = 0; i < n; i++) if (sources[i] === source) return;
  // Divergence from the previous run: drop the stale tail once, then append.
  if (n < sources.length) truncateSources(observer, n);
  sources.push(source);
  observer.sourceStamps.push(edgeStamp(source));
  if (observerIsHot(observer)) {
    // Hot: register the reverse edge so writes can push-invalidate.
    observer.sourceSlots.push(source.obs.length);
    source.obs.push(observer);
    source.obsSlots.push(sources.length - 1);
    bumpLive(source);
  } else {
    // Cold: forward pointers only. Nothing references a cold derived, so
    // dropping the last user reference reclaims it (never-leak); it verifies
    // freshness by version polling at read time instead of receiving marks.
    observer.sourceSlots.push(COLD_EDGE);
  }
  observer.trackIndex = n + 1;
}

/** Sentinel slot for a forward-only (cold) edge. */
const COLD_EDGE = -1;

/**
 * What an edge records to detect change later. Cells stamp their value (so a
 * batch that writes and then reverts nets to "unchanged" — coalescing is a
 * value contract, not a write-count contract); deriveds stamp their version
 * (their equality cut already decides what counts as change).
 */
function edgeStamp(source: Node): unknown {
  return source.isCell ? (source as Cell<any>).value : (source as Derived<any>).version;
}

/** Remove observer's source edges from index `from` onward. */
function truncateSources(observer: Observer, from: number): void {
  const sources = observer.sources;
  if (from >= sources.length) return; // stable dependency set: nothing to trim
  const sourceSlots = observer.sourceSlots;
  for (let i = sources.length - 1; i >= from; i--) {
    if (sourceSlots[i] !== COLD_EDGE) {
      unlinkObserverEntry(sources[i]!, sourceSlots[i]!);
      dropLive(sources[i]!);
    }
  }
  sources.length = from;
  sourceSlots.length = from;
  observer.sourceStamps.length = from;
}

/** Swap-pop entry `slot` out of source.obs, fixing the moved entry's backlink. */
function unlinkObserverEntry(source: Node, slot: number): void {
  const obs = source.obs;
  const obsSlots = source.obsSlots;
  const last = obs.length - 1;
  const movedObserver = obs[last]!;
  const movedSlot = obsSlots[last]!;
  obs[slot] = movedObserver;
  obsSlots[slot] = movedSlot;
  obs.pop();
  obsSlots.pop();
  if (slot < obs.length) movedObserver.sourceSlots[movedSlot] = slot;
}

function observerIsHot(observer: Observer): boolean {
  return observer instanceof EffectNode || observer.live > 0;
}

/** A node gained a live watcher. Cells fire their lifetime effect on 0→1;
 * deriveds turn hot: they register reverse edges and pass liveness upstream. */
function bumpLive(node: Node): void {
  if (node.live++ !== 0) return;
  if (node instanceof Cell) {
    scheduleObservedFlip(node);
  } else {
    const { sources, sourceSlots } = node;
    for (let i = 0; i < sources.length; i++) {
      if (sourceSlots[i] === COLD_EDGE) {
        const s = sources[i]!;
        sourceSlots[i] = s.obs.length;
        s.obs.push(node);
        s.obsSlots.push(i);
        bumpLive(s);
      }
    }
    // Marks were not arriving while cold. Verify now, and announce any
    // staleness to the observers that just attached, like a write would.
    if (node.version !== 0 && node.state === CLEAN) {
      let stale: boolean;
      try {
        stale = sourcesChanged(node);
      } catch {
        stale = true;
      }
      if (stale) {
        node.state = CHECK;
        markObservers(node);
      }
    }
  }
}

function dropLive(node: Node): void {
  if (--node.live !== 0) return;
  if (node instanceof Cell) {
    scheduleObservedFlip(node);
  } else {
    const { sources, sourceSlots } = node;
    for (let i = 0; i < sources.length; i++) {
      if (sourceSlots[i] !== COLD_EDGE) {
        unlinkObserverEntry(sources[i]!, sourceSlots[i]!);
        sourceSlots[i] = COLD_EDGE;
        dropLive(sources[i]!);
      }
    }
  }
}

/** Lifetime effects run on a microtask so observe/unobserve flaps within a
 * tick (StrictMode double-mount, effect re-runs) coalesce to nothing. */
function scheduleObservedFlip(cell: Cell<any>): void {
  if (cell.onObserved === null || cell.observedTaskQueued) return;
  cell.observedTaskQueued = true;
  queueMicrotask(() => {
    cell.observedTaskQueued = false;
    const shouldBeActive = cell.live > 0;
    if (shouldBeActive === cell.observedActive) return;
    cell.observedActive = shouldBeActive;
    if (shouldBeActive) {
      cell.materialize();
      if (trace !== null) trace.emit("observe", traceCause, cell.label, cell);
      const cleanup = cell.onObserved!({
        get: () => untracked(() => cell.get()),
        set: (v) => cell.set(v),
      });
      cell.observedCleanup = typeof cleanup === "function" ? cleanup : null;
    } else {
      if (trace !== null) trace.emit("unobserve", traceCause, cell.label, cell);
      const cleanup = cell.observedCleanup;
      cell.observedCleanup = null;
      if (cleanup !== null) cleanup();
    }
  });
}

/** Attach a React-side subscriber to the node it rendered. */
export function subscribe(sub: Sub): () => void {
  const node = sub.node;
  (node.subs ??= new Set()).add(sub);
  subCount++;
  bumpLive(node);
  if (node instanceof Derived && node.version === 0) {
    // Never evaluated canonically (a speculative render forced it first):
    // evaluate once, now hot, so push-invalidation edges exist.
    untracked(() => void readCanonical(node));
  }
  if (sub.cells !== null) speculativeSubs.add(sub);
  if (sub.probe) probeSubs.add(sub);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    node.subs!.delete(sub);
    subCount--;
    speculativeSubs.delete(sub);
    probeSubs.delete(sub);
    dropLive(node);
    for (const ep of openEpisodes) ep.subGone(sub);
  };
}

export function untracked<T>(fn: () => T): T {
  const prev = activeObserver;
  activeObserver = null;
  try {
    return fn();
  } finally {
    activeObserver = prev;
  }
}

// ---------------------------------------------------------------------------
// Evaluation — one engine for sync and async computeds, canonical and
// speculative worlds.
//
// Async model: `use(thenable)` on an unsettled thenable records a slot,
// returns an inert placeholder, and lets the function keep running so every
// async read it can reach registers in one pass (parallel fetches). The
// evaluation then parks as a Pending whose representative promise is stable
// until the evaluation completes — a React Suspense retry re-reads the same
// Pending instead of kicking off a new fetch. Thenable slots are keyed by
// call order and survive re-runs caused by settlements; they reset exactly
// when a real input changed or `refresh()` forced new fetches.
// ---------------------------------------------------------------------------

interface Slot {
  t: PromiseLike<unknown>;
  status: 0 | 1 | 2; // pending | fulfilled | rejected
  value: unknown;
  reason: unknown;
}

export interface EvalCtx {
  node: Derived<any>;
  /** '' = canonical; otherwise comma-joined episode seqs of the owning world. */
  key: string;
  episodes: Episode[];
  slots: Slot[];
  /** Stable pending box + representative promise while parked. */
  pendingBox: Pending | null;
  representative: { promise: Promise<unknown>; resolve: () => void } | null;
  hasSettled: boolean;
  settledValue: unknown;
  repullQueued: boolean;
  /** Direct dependencies of the last world run: [node, snapshot] (world ctxs only). */
  deps: Array<[Node, unknown]> | null;
  /** refresh() marks consumed so far (world ctxs compare against episode marks). */
  refreshSeen: number;
}

/** Book-keeping for one in-flight run of a derived's function. */
interface EvalRun {
  node: Derived<any>;
  key: string;
  frame: Frame | null;
  ctx: EvalCtx | null;
  pending: boolean;
  rejection: { reason: unknown } | null;
  slotIndex: number;
  /** Child Pending boxes seen; we chain repulls on their settlement. */
  waits: Pending[] | null;
  /** World runs record direct deps + touched cells for caching and shadow subs. */
  deps: Array<[Node, unknown]> | null;
  cells: Set<Cell<any>> | null;
}

let activeEvalRun: EvalRun | null = null;

function materializeCtx(run: EvalRun): EvalCtx {
  const ctx: EvalCtx = {
    node: run.node,
    key: run.key,
    episodes: run.frame === null ? [] : run.frame.episodes.slice(),
    slots: [],
    pendingBox: null,
    representative: null,
    hasSettled: false,
    settledValue: undefined,
    repullQueued: false,
    deps: null,
    refreshSeen: run.frame === null ? 0 : refreshMarksFor(run.node, run.frame),
  };
  if (run.key === "") {
    run.node.ctx = ctx;
  } else {
    (run.node.worldCtx ??= new Map()).set(run.key, ctx);
    worldCtxOwners.add(run.node);
  }
  return ctx;
}

/** `use()` as passed to every computed function. */
const useFn: Use = <U>(t: PromiseLike<U>): U => {
  const run = activeEvalRun;
  if (run === null) throw loud("use() may only be called during a computed evaluation");
  const ctx = (run.ctx ??= materializeCtx(run));
  const i = run.slotIndex++;
  let slot = ctx.slots[i];
  if (slot === undefined) {
    // First time this call site runs in the current fetch generation.
    const created: Slot = { t, status: 0, value: undefined, reason: undefined };
    ctx.slots[i] = created;
    slot = created;
    t.then(
      (v) => {
        if (created.status === 0) {
          created.status = 1;
          created.value = v;
          slotSettled(ctx);
        }
      },
      (e) => {
        if (created.status === 0) {
          created.status = 2;
          created.reason = e;
          slotSettled(ctx);
        }
      },
    );
  }
  if (slot.status === 1) return slot.value as U;
  if (slot.status === 2) {
    // A rejected read poisons the run like a pending one so later async reads
    // still register; the rejection wins at the end unless something is
    // still genuinely pending (a retry may resolve differently).
    run.rejection ??= { reason: slot.reason };
    return POISON as U;
  }
  run.pending = true;
  return POISON as U;
};

function ensureRepresentative(ctx: EvalCtx): void {
  if (ctx.representative !== null) return;
  let resolve!: () => void;
  const promise = new Promise<unknown>((r) => {
    resolve = () => r(undefined);
  });
  ctx.representative = { promise, resolve };
}

/** A thenable slot settled: re-evaluate the owning world soon and, if the
 * evaluation completes, announce the settlement as a write owned by that
 * world's episode. */
function slotSettled(ctx: EvalCtx): void {
  if (ctx.repullQueued) return;
  ctx.repullQueued = true;
  queueMicrotask(() => {
    ctx.repullQueued = false;
    repull(ctx);
  });
}

function repull(ctx: EvalCtx): void {
  const d = ctx.node;
  const prevSlot = ctx.key === "" ? d.slot : undefined;
  if (ctx.key === "") {
    if (d.ctx !== ctx) return; // superseded (refresh/retire rekeyed)
    d.state = DIRTY;
    d.settleRerun = true;
    let after: unknown;
    try {
      untracked(() => void readCanonical(d));
      after = d.slot;
    } catch {
      after = d.slot;
    }
    if (prevSlot instanceof Pending && !(after instanceof Pending)) {
      announceSettlement(d, null);
    }
  } else {
    if (d.worldCtx?.get(ctx.key) !== ctx) return;
    const frame = transientFrame(ctx.episodes);
    const slot = frameDerivedRead(d, frame);
    if (!(slot instanceof Pending)) {
      announceSettlement(
        d,
        ctx.episodes.length === 0 ? null : ctx.episodes[ctx.episodes.length - 1]!,
      );
    }
  }
}

/** Settlement behaves as a write: invalidate downstream, notify subscribers
 * under the owning episode so the new data commits with that batch. */
function announceSettlement(d: Derived<any>, episode: Episode | null): void {
  const cause = trace !== null ? trace.emit("settle", traceCause, d.label, d) : 0;
  const prevCause = setTraceCause(cause);
  writeSeq++; // a derived changed without a base write: cold readers re-poll
  pendingEpoch++;
  notifyDownstream(d, episode);
  flushAll();
  setTraceCause(prevCause);
}

// ---------------------------------------------------------------------------
// Canonical read path
// ---------------------------------------------------------------------------

function readCanonical(d: Derived<any>): unknown {
  if (d.evaluating) throw new CycleError(d.label);
  updateCanonical(d);
  if (activeObserver !== null) linkSource(d, activeObserver);
  return d.slot;
}

function updateCanonical(d: Derived<any>): void {
  if (d.state === DIRTY || d.version === 0) {
    evaluateCanonical(d);
    return;
  }
  // Hot nodes trust CLEAN (marks arrive on writes). Cold nodes receive no
  // marks, so reads verify by polling source versions — but only when
  // anything at all changed since the last verification (every canonical
  // change advances writeSeq; settlements advance it explicitly). The stamp
  // is captured before the check: a write issued from inside an evaluation
  // moves writeSeq past it and forces the next read to re-poll.
  if (d.live > 0 && d.state === CLEAN) return;
  if (d.pollSeq === writeSeq) return;
  const seq = writeSeq;
  if (!sourcesChanged(d)) {
    d.state = CLEAN;
    d.pollSeq = seq;
    return;
  }
  d.settleRerun = false; // inputs changed: fetch generations reset
  evaluateCanonical(d);
  d.pollSeq = seq;
}

/** Poll: did any source actually change value since we last evaluated? */
function sourcesChanged(d: Derived<any> | EffectNode): boolean {
  const sources = d.sources;
  const stamps = d.sourceStamps;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]!;
    if (s.isCell) {
      if (!s.equals((s as Cell<any>).value, stamps[i])) return true;
    } else {
      const der = s as Derived<any>;
      if (der.evaluating) throw new CycleError(der.label);
      try {
        updateCanonical(der);
      } catch {
        // A source that fails to evaluate counts as changed; our own
        // evaluation will surface the failure at its read site.
        return true;
      }
      if (der.version !== stamps[i]) return true;
    }
  }
  return false;
}

function evaluateCanonical(d: Derived<any>): void {
  const prevObserver = activeObserver;
  const prevRun = activeEvalRun;
  const prevFrame = activeFrame;
  activeObserver = d;
  activeFrame = null;
  d.trackIndex = 0;
  d.evaluating = true;
  const keepSlots = d.settleRerun;
  d.settleRerun = false;
  const ctx = d.ctx;
  if (ctx !== null && !keepSlots) ctx.slots = [];
  const run: EvalRun = {
    node: d,
    key: "",
    frame: null,
    ctx,
    pending: false,
    rejection: null,
    slotIndex: 0,
    waits: null,
    deps: null,
    cells: null,
  };
  activeEvalRun = run;
  let result: unknown;
  let threw = false;
  let error: unknown;
  try {
    result = d.fn(useFn);
  } catch (e) {
    threw = true;
    error = e;
  }
  truncateSources(d, d.trackIndex);
  d.evaluating = false;
  activeObserver = prevObserver;
  activeEvalRun = prevRun;
  activeFrame = prevFrame;
  if (!threw && !run.pending && run.rejection === null && run.ctx === null) {
    // The common case: a plain synchronous value.
    commitSlot(d, result);
  } else {
    commitSlot(d, finishRun(run, result, threw, error));
  }
  if (trace !== null) trace.emit("evaluate", traceCause, d.label, d);
}

/** Turn a finished run into a slot (value, Pending, or Failure) and keep the
 * async context's book-keeping straight. */
function finishRun(run: EvalRun, result: unknown, threw: boolean, error: unknown): unknown {
  if (run.pending) {
    const ctx = (run.ctx ??= materializeCtx(run));
    ensureRepresentative(ctx);
    const box = (ctx.pendingBox ??= new Pending(ctx));
    if (run.waits !== null) {
      // Forwarded pendings: when a child settles, re-evaluate this world so
      // our own representative eventually resolves for parked consumers.
      for (const w of run.waits) {
        w.promise.then(
          () => slotSettled(ctx),
          () => slotSettled(ctx),
        );
      }
    }
    return box;
  }
  if (threw) {
    if (error instanceof CycleError) throw error;
    return stableFailure(run.node, error);
  }
  if (run.rejection !== null) return stableFailure(run.node, run.rejection.reason);
  const ctx = run.ctx;
  if (ctx !== null) completeCtx(ctx, result);
  return result;
}

function completeCtx(ctx: EvalCtx, value: unknown): void {
  ctx.hasSettled = true;
  ctx.settledValue = value;
  ctx.pendingBox = null;
  const rep = ctx.representative;
  ctx.representative = null;
  if (rep !== null) rep.resolve();
}

/** Keep the previous Failure box when the same error recurs, so downstream
 * consumers and React error boundaries see one stable reference. */
function stableFailure(d: Derived<any>, error: unknown): Failure {
  const prev = d.slot;
  if (prev instanceof Failure && is(prev.error, error)) return prev;
  return new Failure(error);
}

function commitSlot(d: Derived<any>, slot: unknown): boolean {
  d.state = CLEAN;
  const prev = d.slot;
  let changed: boolean;
  if (prev === slot) {
    changed = d.version === 0; // identical value still counts as a first fill
  } else if (d.version === 0) {
    changed = true;
  } else if (
    (slot !== null &&
      typeof slot === "object" &&
      (slot instanceof Pending || slot instanceof Failure)) ||
    (prev !== null &&
      typeof prev === "object" &&
      (prev instanceof Pending || prev instanceof Failure))
  ) {
    changed = true; // boxes compare by identity, and identity already differed
  } else {
    changed = !d.equals(prev, slot);
  }
  if (changed) {
    d.slot = slot;
    d.version++;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Effects and scopes
// ---------------------------------------------------------------------------

/** Owner for cascading disposal: effects and scopes created during a run
 * belong to that run and are disposed when it re-runs or is disposed. */
let currentOwner: EffectNode | EffectScope | null = null;

export class EffectScope {
  children: Array<EffectNode | EffectScope> = [];
  disposed = false;

  run<T>(fn: () => T): T {
    const prevOwner = currentOwner;
    const prevObserver = activeObserver;
    currentOwner = this;
    activeObserver = null;
    try {
      return fn();
    } finally {
      currentOwner = prevOwner;
      activeObserver = prevObserver;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.children) child.dispose();
    this.children.length = 0;
  }
}

export class EffectNode {
  fn: () => void | (() => void);
  cleanup: (() => void) | null = null;
  sources: Node[] = [];
  sourceSlots: number[] = [];
  sourceStamps: unknown[] = [];
  trackIndex = 0;
  state: DerivedState = DIRTY;
  scheduled = false;
  disposed = false;
  children: Array<EffectNode | EffectScope> | null = null;
  label: string | undefined;

  constructor(fn: () => void | (() => void), label?: string) {
    this.fn = fn;
    this.label = label;
  }

  /** Re-run when a polled source actually changed (equality cutoffs hold). */
  maybeRun(): void {
    if (this.disposed) return;
    if (this.state === CHECK) {
      let changed: boolean;
      try {
        changed = sourcesChanged(this);
      } catch {
        changed = true;
      }
      if (!changed) {
        this.state = CLEAN;
        return;
      }
      if (this.disposed) return; // polling user code may have disposed us
    }
    this.state = CLEAN;
    this.run();
  }

  run(): void {
    if (this.disposed) return;
    if (this.children !== null) {
      for (const child of this.children) child.dispose();
      this.children.length = 0;
    }
    const cleanup = this.cleanup;
    this.cleanup = null;
    if (cleanup !== null) untracked(cleanup); // cleanups never register deps
    const prevObserver = activeObserver;
    const prevOwner = currentOwner;
    const prevFrame = activeFrame;
    activeObserver = this;
    currentOwner = this;
    activeFrame = null; // effects observe canonical state only
    this.trackIndex = 0;
    const prevCause = traceCause;
    if (trace !== null) traceCause = trace.emit("effect", traceCause, this.label, this);
    try {
      const ret = this.fn();
      if (typeof ret === "function") this.cleanup = ret;
    } finally {
      truncateSources(this, this.trackIndex);
      activeObserver = prevObserver;
      currentOwner = prevOwner;
      activeFrame = prevFrame;
      traceCause = prevCause;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.children !== null) {
      for (const child of this.children) child.dispose();
      this.children = null;
    }
    const cleanup = this.cleanup;
    this.cleanup = null;
    truncateSources(this, 0);
    if (cleanup !== null) {
      // Disposal is total: a throwing cleanup must not stop sibling teardown
      // or bounce the disposer, so the error is reported out of band.
      try {
        untracked(cleanup);
      } catch (e) {
        reportDisposeError(e);
      }
    }
  }
}

/** Where dispose-time cleanup errors go (teardown itself never throws). */
let disposeErrorReporter: (error: unknown) => void = (error) => {
  console.error("signals-royale-fx1: error in effect cleanup during dispose", error);
};
export function setDisposeErrorReporter(fn: (error: unknown) => void): void {
  disposeErrorReporter = fn;
}
function reportDisposeError(error: unknown): void {
  if (trace !== null) trace.emit("dispose-error", traceCause, String(error));
  disposeErrorReporter(error);
}

/** Create an effect: runs immediately (even inside a batch), re-runs when its
 * canonical dependencies change, returns a disposer. Dropped disposers are
 * reclaimed by the engine's FinalizationRegistry (see `effect` in index.ts). */
export function hasOwner(): boolean {
  return currentOwner !== null;
}

export function createEffect(fn: () => void | (() => void), label?: string): EffectNode {
  const node = new EffectNode(fn, label);
  if (currentOwner !== null) {
    if (currentOwner instanceof EffectNode) (currentOwner.children ??= []).push(node);
    else currentOwner.children.push(node);
  }
  node.state = CLEAN;
  node.run();
  return node;
}

function scheduleEffect(node: EffectNode): void {
  if (node.scheduled || node.disposed) return;
  node.scheduled = true;
  effectQueue.push(node);
}

const FLUSH_LIMIT = 100000;

function flushEffects(): void {
  if (flushing) return;
  flushing = true;
  let firstError: unknown;
  let hasError = false;
  let iterations = 0;
  let cursor = 0;
  try {
    // One catch frame per error, not per effect: a throwing effect drops us
    // out of the inner loop, we record, and the outer loop resumes draining.
    while (cursor < effectQueue.length) {
      if (iterations > FLUSH_LIMIT) throw loud("effect flush did not settle (cycle?)");
      try {
        while (cursor < effectQueue.length) {
          if (++iterations > FLUSH_LIMIT) break; // cycle guard: escape to the outer check
          const node = effectQueue[cursor++]!;
          node.scheduled = false;
          node.maybeRun();
          // Keep the queue array small once the drained prefix dominates.
          if (cursor > 1024 && cursor * 2 > effectQueue.length) {
            effectQueue.splice(0, cursor);
            cursor = 0;
          }
        }
      } catch (e) {
        if (!hasError) {
          hasError = true;
          firstError = e;
        }
      }
    }
    effectQueue.length = 0;
  } finally {
    flushing = false;
  }
  if (hasError) throw firstError;
}

// ---------------------------------------------------------------------------
// Writes, notification, batching
// ---------------------------------------------------------------------------

function applyOp<T>(op: Op<T>, prev: T): T {
  return op.fn !== null ? op.fn(prev) : (op.value as T);
}

function writeCell<T>(cell: Cell<T>, fn: ((prev: T) => T) | null, value: T | undefined): void {
  if (initializing) throw loud("atom initializers must not write");
  if (host !== null) {
    if (host.isRendering()) {
      throw loud(
        `write to ${cell.label ?? "atom"} during render — move it to an event handler or effect`,
      );
    }
    const token = host.currentBatchToken();
    if (token !== null) {
      cell.materialize();
      recordEpisodeOp(cell, { fn, value }, episodeFor(token));
      return;
    }
  }
  cell.materialize();
  if (cell.pend === null) {
    // Fast path: no update queue on this cell, no trace bookkeeping beyond
    // what setCanonical does.
    const next = fn !== null ? fn(cell.value) : (value as T);
    if (!cell.equals(cell.value, next)) {
      const prevCause = traceCause;
      setCanonical(cell, next, null);
      flushAll();
      traceCause = prevCause;
    }
    return;
  }
  // Queue in scheduling order; canonical refolds over urgent+retired ops.
  const prevCause = traceCause;
  cell.pend.ops.push({ fn, value, ep: null, seq: writeSeq + 1 });
  const next = foldQueue(cell, null, -1);
  if (!cell.equals(cell.value, next)) setCanonical(cell, next, null);
  else notifyDownstream(cell as Cell<any>, null); // queue shape changed: drafts refold
  pendingEpoch++;
  flushAll();
  traceCause = prevCause;
}

/**
 * Replay the cell's update queue for one world.
 * Included: urgent ops (up to `pinSeq` when pinned), ops of retired episodes
 * (from their retirement seq), and ops of `episodes`. Order is scheduling
 * order — a landing transition op re-applies in its original position.
 */
function foldQueue<T>(cell: Cell<T>, episodes: Episode[] | null, pinSeq: WriteSeq): T {
  const pend = cell.pend!;
  // A pass pinned before the queue formed starts from its own pinned base
  // (the queue's ops all postdate it; episode ops replay against it).
  let value = pinSeq >= 0 && pend.baseSeq > pinSeq ? baseValueAt(cell, pinSeq) : pend.base;
  for (const op of pend.ops) {
    const ep = op.ep;
    // A world that explicitly contains the op's episode sees it regardless of
    // its retirement state — a pass that rendered the episode keeps seeing it
    // through its own commit even though retirement restamps the op.
    const visible =
      ep !== null && episodes !== null && ep.state !== "aborted" && episodes.includes(ep)
        ? true
        : ep === null || ep.state === "retired"
          ? pinSeq < 0 || op.seq <= pinSeq
          : false;
    if (visible) value = applyOp(op, value);
  }
  return value;
}

/** Set the cached canonical value (a base write): history, marks, deliveries. */
function setCanonical<T>(cell: Cell<T>, next: T, episode: Episode | null): void {
  if (passFrames.size > 0) {
    (cell.hist ??= []).push([writeSeq + 1, cell.value]);
    cellsWithHistory.add(cell as Cell<any>);
  }
  writeSeq++;
  cell.baseSeq = writeSeq;
  cell.value = next;
  cell.version++;
  if (trace !== null) {
    const cause = trace.emit(
      episode === null ? "write" : "retire-fold",
      episode !== null ? episode.openTrace : traceCause,
      cell.label,
      cell,
    );
    setTraceCause(cause);
  }
  if (openEpisodes.length > 0) pendingEpoch++;
  notifyDownstream(cell as Cell<any>, null);
}

/** A transition-classified write: append to the update queue tagged with the
 * episode. Never touches canonical. Equal set()s drop against the value the
 * episode's own world currently shows. */
function recordEpisodeOp<T>(cell: Cell<T>, op: Op<T>, ep: Episode): void {
  const pend = (cell.pend ??= { base: cell.value, baseSeq: cell.baseSeq, ops: [] });
  cellsWithQueues.add(cell as Cell<any>);
  const before = foldQueue(cell, [ep], -1);
  const next = applyOp(op, before);
  if (op.fn === null && cell.equals(before, next)) return;
  pend.ops.push({ fn: op.fn, value: op.value, ep, seq: writeSeq });
  ep.cells.add(cell as Cell<any>);
  ep.version++;
  pendingEpoch++;
  if (trace !== null) {
    setTraceCause(trace.emit("write", ep.openTrace, cell.label, cell));
  }
  ep.armAutoRetire();
  notifyDownstream(cell as Cell<any>, ep);
  flushAll();
}

/**
 * Collapse the queue once nothing needs its structure: no op references an
 * open episode, and no live pass frame still includes a retired one (a pass
 * that rendered an episode keeps reading its ops through its own commit).
 */
function collapseQueue(cell: Cell<any>): void {
  const pend = cell.pend;
  if (pend === null) {
    cellsWithQueues.delete(cell);
    return;
  }
  for (const op of pend.ops) {
    if (op.ep === null) continue;
    if (op.ep.state === "open") return;
    if (op.ep.state === "retired" && frameHolds(op.ep)) return;
  }
  cell.pend = null;
  cellsWithQueues.delete(cell);
}

function frameHolds(ep: Episode): boolean {
  for (const frame of passFrames.values()) {
    if (frame.episodes.includes(ep)) return true;
  }
  return false;
}

function sweepQueues(): void {
  for (const cell of [...cellsWithQueues]) collapseQueue(cell);
}

/**
 * Fan a change out from `origin`.
 * - Canonical change (episode null): mark downstream deriveds, queue effects,
 *   and collect subscriber deliveries.
 * - Episode change: canonical state is untouched (drafts are invisible to
 *   effects and canonical readers); only subscriber deliveries are collected,
 *   dispatched under the episode's lane.
 */
function notifyDownstream(origin: Node, episode: Episode | null): void {
  if (episode === null) {
    markObservers(origin);
  }
  if (subCount > 0) collectSubDeliveries(origin, episode);
}

/**
 * Mark downstream "possibly changed" and queue reached effects. Marks are
 * always CHECK-level: whether anything actually changed is decided at poll
 * time by comparing values, so a batch that writes and reverts nets to no
 * recomputation and no effect runs.
 */
function markObservers(node: Node): void {
  const obs = node.obs;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i]!;
    if (o instanceof EffectNode) {
      if (o.state === CLEAN) {
        o.state = CHECK;
        scheduleEffect(o);
      }
    } else if (o.state === CLEAN) {
      o.state = CHECK;
      markObservers(o);
    }
  }
}

/** Walk live edges downstream and enqueue deliveries for every subscriber
 * that can see `origin`, plus speculative subscribers whose last render
 * touched it through a world-only dependency. */
function collectSubDeliveries(origin: Node, episode: Episode | null): void {
  const visited = new Set<Node>();
  const visit = (node: Node): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.subs !== null) {
      for (const sub of node.subs) enqueueDelivery(sub, episode);
    }
    const obs = node.obs;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i]!;
      if (!(o instanceof EffectNode)) visit(o);
    }
  };
  visit(origin);
  if (origin instanceof Cell && speculativeSubs.size > 0) {
    for (const sub of speculativeSubs) {
      if (sub.cells !== null && sub.cells.has(origin as Cell<any>)) {
        enqueueDelivery(sub, episode);
      }
    }
  }
}

function enqueueDelivery(sub: Sub, episode: Episode | null): void {
  let set = pendingDeliveries.get(sub);
  if (set === undefined) {
    set = new Set();
    pendingDeliveries.set(sub, set);
  }
  set.add(episode);
}

/** Flush effects, subscriber deliveries and isPending probes. No-op while a
 * batch is open; endBatch flushes once. */
function flushAll(): void {
  if (batchDepth > 0) return;
  if (effectQueue.length > 0) flushEffects();
  if (pendingDeliveries.size > 0) flushDeliveries();
  if (probeSubs.size > 0) flushProbes();
}

function flushDeliveries(): void {
  if (host === null) {
    pendingDeliveries.clear();
    return;
  }
  while (pendingDeliveries.size > 0) {
    const batch = [...pendingDeliveries];
    pendingDeliveries.clear();
    for (const [sub, episodes] of batch) {
      for (const episode of episodes) {
        if (episode !== null && episode.state !== "open") continue;
        if (!sub.probe && sameAsSnapshot(sub, episode)) continue;
        // Probes and unrooted subscribers take the delivery but never gate
        // the episode's retirement — no commit of theirs will ever name it.
        if (episode !== null && !sub.probe && sub.rootKey !== null) episode.noteDelivery(sub);
        host.deliver(sub, episode);
      }
    }
  }
}

/** Skip deliveries that would render an identical value. Conservative: only
 * skips on reference-identical slots; anything else re-renders. */
function sameAsSnapshot(sub: Sub, episode: Episode | null): boolean {
  if (episode !== null) return false; // draft deliveries always go out
  if (sub.snapshot === SUB_NEVER) return false;
  try {
    return Object.is(peekSlot(sub.node, null), sub.snapshot);
  } catch {
    return false;
  }
}

let probeFlushScheduled = false;
function flushProbes(): void {
  if (probeSubs.size === 0 || probeFlushScheduled) return;
  probeFlushScheduled = true;
  queueMicrotask(() => {
    probeFlushScheduled = false;
    if (host === null) return;
    for (const sub of probeSubs) {
      const now = isPending(sub.node);
      if (now !== sub.lastPending) {
        sub.lastPending = now;
        host.deliver(sub, null); // pending flips stay urgently visible
      }
    }
  });
}

export function startBatch(): void {
  batchDepth++;
}

export function endBatch(): void {
  if (batchDepth === 0) throw loud("endBatch without startBatch");
  batchDepth--;
  if (batchDepth === 0) flushAll();
}

export function batch<T>(fn: () => T): T {
  startBatch();
  try {
    return fn();
  } finally {
    endBatch();
  }
}

// ---------------------------------------------------------------------------
// Episodes — engine-owned update batches
// ---------------------------------------------------------------------------

export type EpisodeState = "open" | "retired" | "aborted";

export class Episode {
  seq: EpisodeSeq;
  token: object;
  /** Bumps on every op and settlement owned by this episode (world cache keys). */
  version = 0;
  state: EpisodeState = "open";
  /** Cells this episode has ops for (the ops live on the cells). */
  cells = new Set<Cell<any>>();
  /** Roots that received deliveries and have not committed this episode yet. */
  roots = new Map<object, Set<Sub>>();
  everDelivered = false;
  /** refresh() marks recorded while this episode was ambient. */
  refreshMarks: Map<Derived<any>, number> | null = null;
  /** Trace id of the batch-open event (writes chain to their batch). */
  openTrace: TraceEventId = 0;
  private autoRetireArmed = false;

  constructor(token: object) {
    this.seq = episodeSeq++;
    this.token = token;
  }

  noteDelivery(sub: Sub): void {
    if (sub.rootKey === null) return;
    this.everDelivered = true;
    let set = this.roots.get(sub.rootKey);
    if (set === undefined) {
      set = new Set();
      this.roots.set(sub.rootKey, set);
    }
    set.add(sub);
  }

  subGone(sub: Sub): void {
    if (this.state !== "open") return;
    if (sub.rootKey === null) return;
    const set = this.roots.get(sub.rootKey);
    if (set === undefined || !set.delete(sub)) return;
    if (set.size === 0) this.roots.delete(sub.rootKey);
    if (this.roots.size === 0) {
      // Defer: a StrictMode-style unsubscribe/resubscribe flap within one
      // commit must not retire the batch out from under the resubscriber.
      queueMicrotask(() => {
        if (this.state === "open" && this.roots.size === 0) retireEpisode(this);
      });
    }
  }

  /**
   * A transition that never reaches a subscriber has no React work to wait
   * for: nothing will render it and no commit will ever name it. The engine
   * owns scheduling, so it retires such an episode itself one microtask after
   * its writes flush (a subscriber appearing in between keeps it open).
   */
  armAutoRetire(): void {
    if (this.autoRetireArmed) return;
    this.autoRetireArmed = true;
    queueMicrotask(() => {
      this.autoRetireArmed = false;
      if (this.state === "open" && !this.everDelivered && this.roots.size === 0) {
        retireEpisode(this);
      }
    });
  }
}

/** Find or create the episode for an ambient batch token. */
export function episodeFor(token: object): Episode {
  let ep = episodesByToken.get(token);
  if (ep === undefined) {
    ep = new Episode(token);
    episodesByToken.set(token, ep);
    openEpisodes.push(ep);
    if (trace !== null) ep.openTrace = trace.emit("batch-open", traceCause, `episode ${ep.seq}`);
  }
  return ep;
}

/** Fold the episode's ops onto the base (its functional updates re-execute
 * against today's base — the rebase), then drop every trace of it. */
export function retireEpisode(ep: Episode): void {
  if (ep.state !== "open") return;
  const cause = trace !== null ? trace.emit("batch-retire", ep.openTrace, `episode ${ep.seq}`) : 0;
  const prevCause = setTraceCause(cause);
  ep.state = "retired";
  unregisterEpisode(ep);
  for (const cell of ep.cells) {
    const pend = cell.pend;
    if (pend === null) continue;
    // The landing ops become canonically visible now: restamp them at the
    // retirement seq so passes pinned earlier keep excluding them.
    for (const op of pend.ops) if (op.ep === ep) op.seq = writeSeq + 1;
    const next = foldQueue(cell, null, -1);
    collapseQueue(cell);
    if (!cell.equals(cell.value, next)) setCanonical(cell, next, ep);
  }
  adoptWorldContexts(ep);
  pendingEpoch++;
  flushAll();
  setTraceCause(prevCause);
}

/** Drop an abandoned episode: ops vanish, anyone who saw them re-renders. */
export function abortEpisode(ep: Episode): void {
  if (ep.state !== "open") return;
  ep.state = "aborted";
  writeSeq++; // dropped drafts flip pending probes and world folds
  if (trace !== null) trace.emit("batch-abort", ep.openTrace, `episode ${ep.seq}`);
  unregisterEpisode(ep);
  for (const cell of ep.cells) {
    const pend = cell.pend;
    if (pend !== null) {
      pend.ops = pend.ops.filter((op) => op.ep !== ep);
      collapseQueue(cell);
    }
    notifyDownstream(cell, null);
  }
  dropWorldContexts(ep);
  pendingEpoch++;
  flushAll();
}

function unregisterEpisode(ep: Episode): void {
  const i = openEpisodes.indexOf(ep);
  if (i >= 0) openEpisodes.splice(i, 1);
  episodesByToken.delete(ep.token);
  for (const [, committed] of committedByRoot) {
    const j = committed.indexOf(ep);
    if (j >= 0) committed.splice(j, 1);
  }
  ep.roots.clear();
}

/** Deriveds with world-keyed async contexts (kept small; swept on retire). */
const worldCtxOwners = new Set<Derived<any>>();

/** When an episode retires, evaluation state its worlds accumulated becomes
 * canonical truth: settled fetches move over instead of refetching. */
function adoptWorldContexts(ep: Episode): void {
  const seqToken = String(ep.seq);
  for (const d of worldCtxOwners) {
    const map = d.worldCtx;
    if (map === null) continue;
    for (const [key, ctx] of [...map]) {
      const seqs = key.split(",");
      const i = seqs.indexOf(seqToken);
      if (i < 0) continue;
      map.delete(key);
      seqs.splice(i, 1);
      const newKey = seqs.join(",");
      ctx.episodes = ctx.episodes.filter((e) => e !== ep);
      if (newKey === "") {
        ctx.key = "";
        d.ctx = ctx;
        d.state = DIRTY;
        d.settleRerun = true; // keep the world's slots: no refetch after commit
        writeSeq++; // adopted evaluation state: cold readers re-poll
      } else {
        ctx.key = newKey;
        map.set(newKey, ctx);
      }
    }
    if (map.size === 0) {
      d.worldCtx = null;
      worldCtxOwners.delete(d);
    }
  }
}

function dropWorldContexts(ep: Episode): void {
  const seqToken = String(ep.seq);
  for (const d of worldCtxOwners) {
    const map = d.worldCtx;
    if (map === null) continue;
    for (const key of [...map.keys()]) {
      if (key.split(",").includes(seqToken)) map.delete(key);
    }
    if (map.size === 0) {
      d.worldCtx = null;
      worldCtxOwners.delete(d);
    }
  }
}

// ---------------------------------------------------------------------------
// Frames — one read view: a pinned base plus an ordered episode fold
// ---------------------------------------------------------------------------

export class Frame {
  /** Base writes after this seq are invisible (-1 = live base). */
  pinSeq: WriteSeq;
  /** Episodes folded on top, in creation order. */
  episodes: Episode[];
  /** Async-context key for this world (episode seqs; versions excluded). */
  ctxKey: string;
  /** Memoized world evaluations: derived → { slot, cells }. */
  cache = new Map<Derived<any>, { slot: unknown; cells: Set<Cell<any>> | null }>();
  /** Memoized world-relevance checks. */
  private touch: Map<Derived<any>, boolean> | null = null;
  /** Trace id of this pass's start event. */
  passTrace: TraceEventId = 0;

  constructor(episodes: Episode[], pinSeq: WriteSeq) {
    this.episodes = [...episodes].sort((a, b) => a.seq - b.seq);
    this.pinSeq = pinSeq;
    this.ctxKey = this.episodes.map((e) => e.seq).join(",");
  }

  /** Does this world change anything this derived (transitively) reads? */
  touches(d: Derived<any>): boolean {
    if (this.episodes.length === 0) return false;
    let memo = (this.touch ??= new Map());
    const hit = memo.get(d);
    if (hit !== undefined) return hit;
    memo.set(d, false); // cycle guard; real cycles throw at evaluation
    let result = false;
    for (const s of d.sources) {
      if (s instanceof Cell) {
        for (const ep of this.episodes) {
          if (ep.cells.has(s)) {
            result = true;
            break;
          }
        }
      } else if (this.touches(s)) {
        result = true;
      }
      if (result) break;
    }
    memo.set(d, result);
    return result;
  }

  /** Newest base seq among the derived's transitive cell sources. */
  newestSourceSeq(d: Derived<any>): WriteSeq {
    let newest = 0;
    for (const s of d.sources) {
      const seq = s instanceof Cell ? s.baseSeq : this.newestSourceSeq(s);
      if (seq > newest) newest = seq;
    }
    return newest;
  }
}

function baseValueAt<T>(cell: Cell<T>, pinSeq: WriteSeq): T {
  if (pinSeq < 0 || cell.baseSeq <= pinSeq) return cell.value;
  const hist = cell.hist;
  if (hist !== null) {
    for (const [replacedAt, prior] of hist) {
      if (replacedAt > pinSeq) return prior;
    }
  }
  return cell.value;
}

function frameCellRead<T>(cell: Cell<T>, frame: Frame): T {
  cell.materialize();
  const value =
    cell.pend !== null
      ? foldQueue(cell, frame.episodes, frame.pinSeq)
      : baseValueAt(cell, frame.pinSeq);
  const run = activeEvalRun;
  if (run !== null && run.frame === frame) {
    run.cells?.add(cell as Cell<any>);
    run.deps?.push([cell as Cell<any>, value]);
  }
  if (subRenderCells !== null) subRenderCells.add(cell as Cell<any>);
  return value;
}

/** Cells touched by the subscriber render in progress (speculative renders
 * only; used to notify world-only dependencies). */
let subRenderCells: Set<Cell<any>> | null = null;

function frameDerivedRead(d: Derived<any>, frame: Frame): unknown {
  const hit = frame.cache.get(d);
  if (hit !== undefined) {
    if (hit.cells !== null && subRenderCells !== null) {
      for (const c of hit.cells) subRenderCells.add(c);
    }
    return hit.slot;
  }
  // A derived this world doesn't touch is just its canonical self — share the
  // canonical slot (and its fetch state) instead of re-evaluating, as long as
  // the pinned base hasn't advanced past our pin for its inputs.
  if (d.version !== 0 && !frame.touches(d) && frame.newestSourceSeq(d) <= frame.pinSeq) {
    const slot = untracked(() => {
      updateCanonical(d);
      return d.slot;
    });
    // Re-check: evaluation may have picked up new sources with newer bases.
    if (!frame.touches(d) && frame.newestSourceSeq(d) <= frame.pinSeq) return slot;
  }
  return evaluateInFrame(d, frame);
}

function evaluateInFrame(d: Derived<any>, frame: Frame): unknown {
  if (d.evaluating) throw new CycleError(d.label);
  const key = frame.ctxKey;
  let ctx = key === "" ? d.ctx : (d.worldCtx?.get(key) ?? null);
  const run: EvalRun = {
    node: d,
    key,
    frame,
    ctx,
    pending: false,
    rejection: null,
    slotIndex: 0,
    waits: null,
    deps: [],
    cells: new Set(),
  };
  if (ctx !== null) {
    // Reset fetch slots when a real input changed or refresh() forced it.
    const marks = refreshMarksFor(d, frame);
    if (marks !== ctx.refreshSeen) {
      ctx.slots = [];
      ctx.refreshSeen = marks;
    } else if (ctx.deps !== null && worldDepsChanged(ctx.deps, frame)) {
      ctx.slots = [];
    }
  }
  const prevObserver = activeObserver;
  const prevRun = activeEvalRun;
  const prevFrame = activeFrame;
  activeObserver = null; // world evaluations never edit the canonical graph
  activeFrame = frame;
  activeEvalRun = run;
  d.evaluating = true;
  let result: unknown;
  let threw = false;
  let error: unknown;
  try {
    result = d.fn(useFn);
  } catch (e) {
    threw = true;
    error = e;
  }
  d.evaluating = false;
  activeObserver = prevObserver;
  activeEvalRun = prevRun;
  activeFrame = prevFrame;
  let slot: unknown;
  try {
    slot = finishRun(run, result, threw, error);
  } finally {
    if (run.ctx !== null) run.ctx.deps = run.deps;
  }
  frame.cache.set(d, { slot, cells: run.cells });
  if (subRenderCells !== null && run.cells !== null) {
    for (const c of run.cells) subRenderCells.add(c);
  }
  return slot;
}

function worldDepsChanged(deps: Array<[Node, unknown]>, frame: Frame): boolean {
  for (const [node, snapshot] of deps) {
    if (node instanceof Cell) {
      if (!node.equals(frameCellRead(node, frame), snapshot)) return true;
    } else {
      const cur = frameDerivedRead(node, frame);
      const same =
        cur === snapshot ||
        (!(cur instanceof Pending || cur instanceof Failure) &&
          !(snapshot instanceof Pending || snapshot instanceof Failure) &&
          node.equals(cur, snapshot));
      if (!same) return true;
    }
  }
  return false;
}

function refreshMarksFor(d: Derived<any>, frame: Frame): number {
  let marks = 0;
  for (const ep of frame.episodes) {
    if (ep.refreshMarks !== null) marks += ep.refreshMarks.get(d) ?? 0;
  }
  return marks;
}

/** The "newest intent" world: every open episode over the live base. Memoized
 * per (writeSeq, episode versions) so repeated probes stay cheap. */
let latestFrameMemo: { key: string; frame: Frame } | null = null;
export function latestFrame(): Frame {
  let key = String(writeSeq);
  for (const ep of openEpisodes) key += `|${ep.seq}:${ep.version}`;
  if (latestFrameMemo !== null && latestFrameMemo.key === key) return latestFrameMemo.frame;
  const frame = new Frame(openEpisodes, -1);
  latestFrameMemo = { key, frame };
  return frame;
}

/** Transient frame over the live base for a specific episode set. */
function transientFrame(episodes: Episode[]): Frame {
  return new Frame(
    episodes.filter((e) => e.state === "open"),
    -1,
  );
}

// ---------------------------------------------------------------------------
// Render passes and commits — driven by the host runtime
// ---------------------------------------------------------------------------

/** Episodes committed at a root but not yet retired everywhere: still part of
 * that root's world (they are on its screen). */
const committedByRoot = new Map<object, Episode[]>();
/** Subscribers grouped by root (committed-view snapshots at commit). */
const subsByRoot = new Map<object, Set<Sub>>();

export function registerSubRoot(sub: Sub): void {
  if (sub.rootKey === null) return;
  let set = subsByRoot.get(sub.rootKey);
  if (set === undefined) {
    set = new Set();
    subsByRoot.set(sub.rootKey, set);
  }
  set.add(sub);
}

let rootViewPruneQueued = false;

export function unregisterSubRoot(sub: Sub): void {
  if (sub.rootKey === null) return;
  const set = subsByRoot.get(sub.rootKey);
  if (set !== undefined) {
    set.delete(sub);
    if (set.size === 0) subsByRoot.delete(sub.rootKey);
  }
  // Commit reporting precedes unmount cleanup, so the commit that removed
  // this subscriber could not prune its snapshots; sweep once we settle.
  if (!rootViewPruneQueued) {
    rootViewPruneQueued = true;
    queueMicrotask(() => {
      rootViewPruneQueued = false;
      pruneRootViews();
    });
  }
}

/**
 * The host started a render pass on `rootKey` covering `episodes`. The frame
 * pins today's base: urgent writes landing while the pass is time-sliced stay
 * invisible to it, so every component in the pass reads one world. A frame
 * already live for this root was an interrupted pass — discarded.
 */
export function beginPass(rootKey: object, episodes: Episode[]): Frame {
  const prior = passFrames.get(rootKey);
  if (prior !== undefined && trace !== null) {
    trace.emit("pass-discard", traceCause, undefined);
  }
  if (prior !== undefined) passFrames.delete(rootKey);
  const committed = committedByRoot.get(rootKey);
  const all =
    committed !== undefined && committed.length > 0 ? [...committed, ...episodes] : episodes;
  const frame = new Frame(
    all.filter((e) => e.state === "open"),
    writeSeq,
  );
  passFrames.set(rootKey, frame);
  if (trace !== null) {
    const detail = frame.episodes.map((e) => `episode ${e.seq}`).join("+");
    frame.passTrace = trace.emit("pass-start", traceCause, detail || "urgent");
  }
  return frame;
}

/** The pass frame the host is currently rendering for a root. */
export function frameForRoot(rootKey: object): Frame | null {
  return passFrames.get(rootKey) ?? null;
}

/**
 * The host committed a pass at `rootKey` that covered `episodes`. Committed
 * values snapshot per root; episodes seen by all their roots retire.
 */
export function commitPass(rootKey: object, episodes: Episode[]): void {
  const frame = passFrames.get(rootKey) ?? transientFrame(episodes);
  passFrames.delete(rootKey);
  const commitCause =
    trace !== null ? trace.emit("commit", frame.passTrace ?? traceCause, undefined) : 0;
  const prevCause = setTraceCause(commitCause);

  // Snapshot what this root's screen now shows. Only worlds can make a
  // screen disagree with canonical: with no episodes anywhere, committed()
  // already answers from canonical, so the walk is skipped entirely — an
  // urgent commit costs O(changed), not O(subscribed).
  const subs = subsByRoot.get(rootKey);
  const worldsInPlay = frame.episodes.length > 0 || openEpisodes.length > 0 || rootViews.size > 0;
  if (worldsInPlay && subs !== undefined && subs.size > 0) {
    let view = rootViews.get(rootKey);
    if (view === undefined) {
      view = new Map();
      rootViews.set(rootKey, view);
    }
    for (const sub of subs) {
      if (sub.probe) continue;
      try {
        const slot = peekSlot(sub.node, frame);
        const prev = view.get(sub.node);
        view.set(sub.node, slot);
        recordGlobalCommit(sub.node, slot);
        if (sub.committedWatcher === true && !Object.is(prev, slot) && host !== null) {
          host.deliver(sub, null);
        }
      } catch {
        // A throwing read cannot be on screen; skip the snapshot.
      }
    }
  }

  // Book-keeping for the committed episodes.
  const committed = committedByRoot.get(rootKey) ?? [];
  for (const ep of episodes) {
    if (ep.state !== "open") continue;
    if (!committed.includes(ep)) committed.push(ep);
    ep.roots.delete(rootKey);
    if (ep.roots.size === 0) retireEpisode(ep);
  }
  committed.sort((a, b) => a.seq - b.seq);
  const stillOpen = committed.filter((e) => e.state === "open");
  if (stillOpen.length > 0) committedByRoot.set(rootKey, stillOpen);
  else committedByRoot.delete(rootKey);

  sweepQueues();
  if (passFrames.size === 0) pruneHistory();
  pruneRootViews();
  flushProbes();
  setTraceCause(prevCause);
}

/** The host discarded a root's work without committing (root unmounted). */
export function discardPass(rootKey: object): void {
  passFrames.delete(rootKey);
  sweepQueues();
  if (passFrames.size === 0) pruneHistory();
}

function pruneHistory(): void {
  for (const cell of cellsWithHistory) cell.hist = null;
  cellsWithHistory.clear();
}

/** Committed snapshots that match canonical truth carry no information —
 * drop them so a quiescent engine holds nothing per-root. */
function pruneRootViews(): void {
  if (openEpisodes.length > 0 || rootViews.size === 0) return;
  for (const [rootKey, view] of rootViews) {
    const subs = subsByRoot.get(rootKey);
    let liveNodes: Set<Node> | null = null;
    if (subs !== undefined) {
      liveNodes = new Set();
      for (const sub of subs) liveNodes.add(sub.node);
    }
    for (const [node, slot] of view) {
      if (liveNodes !== null && liveNodes.has(node)) continue; // still on screen here
      const canonical = node instanceof Cell ? node.value : node.slot;
      if (Object.is(canonical, slot)) view.delete(node);
    }
    if (view.size === 0) rootViews.delete(rootKey);
  }
}

function recordGlobalCommit(node: Node, slot: unknown): void {
  if (node instanceof Cell) {
    node.committedValue = Object.is(slot, node.value) ? null : { v: slot };
  } else {
    node.committedSlot = Object.is(slot, node.slot) ? null : { v: slot };
  }
}

// ---------------------------------------------------------------------------
// The read family
// ---------------------------------------------------------------------------

/** Raw slot of a node in a frame (null frame = canonical), untracked. */
export function peekSlot(node: Node, frame: Frame | null): unknown {
  return untracked(() => {
    if (node instanceof Cell) {
      if (frame !== null) return frameCellRead(node, frame);
      node.materialize();
      return node.value;
    }
    if (frame !== null) return frameDerivedRead(node, frame);
    updateCanonical(node);
    return node.slot;
  });
}

/**
 * `latest(x)`: newest intent — every open episode folded over the live base.
 * Inside a render pass or computed evaluation it resolves that context's own
 * world instead (reading ahead of your own world would be a tear). Never
 * suspends: a pending evaluation serves its last settled value.
 */
export function latest<T>(node: Cell<T> | Derived<T>): T {
  if (activeFrame !== null || activeEvalRun !== null) {
    return node.get(); // context-bound read: same world, same policy
  }
  const slot = peekSlot(node, latestFrame());
  if (slot instanceof Failure) throw slot.error;
  if (slot instanceof Pending) {
    const ctx = slot.ctx;
    return (ctx.hasSettled ? ctx.settledValue : undefined) as T;
  }
  return slot as T;
}

/**
 * `committed(x, rootKey?)`: what is on screen — per root when given, else the
 * most recent commit anywhere that involved x. Never subscribes. Falls back
 * to canonical when x has never been part of a commit (nothing renders it, so
 * nothing on screen can disagree).
 */
export function committed<T>(node: Cell<T> | Derived<T>, rootKey?: object): T {
  let slot: unknown;
  let found = false;
  if (rootKey !== undefined) {
    // Per-root: this root's snapshots or canonical — never another root's.
    const view = rootViews.get(rootKey);
    if (view !== undefined && view.has(node as Node)) {
      slot = view.get(node as Node);
      found = true;
    }
  } else {
    const global = node instanceof Cell ? node.committedValue : node.committedSlot;
    if (global !== null) {
      slot = global.v;
      found = true;
    }
  }
  if (!found) slot = peekSlot(node as Node, null);
  if (slot instanceof Failure) throw slot.error;
  if (slot instanceof Pending) {
    const ctx = slot.ctx;
    return (ctx.hasSettled ? ctx.settledValue : undefined) as T;
  }
  return slot as T;
}

/**
 * `isPending(x)`: cheap flip-only probe — true while newer data is loading
 * (or waiting to commit) behind what canonical readers see. Never evaluates
 * anything, so it can never refetch or suspend.
 */
export function isPending(node: Node): boolean {
  if (node instanceof Cell) {
    if (node.pend === null) return false;
    return !node.equals(node.value, foldQueue(node, openEpisodes, -1));
  }
  // Async in flight on any track?
  if (node.ctx !== null && node.ctx.pendingBox !== null) return true;
  if (node.worldCtx !== null) {
    for (const ctx of node.worldCtx.values()) if (ctx.pendingBox !== null) return true;
  }
  if (node.slot instanceof Pending) return true;
  // A draft anywhere upstream means newer data is waiting to commit.
  return openEpisodes.length > 0 && latestFrame().touches(node);
}

/**
 * `refresh(x)`: refetch with unchanged inputs. The stale value keeps serving
 * while the new evaluation runs; latest-wins on races. A refresh issued
 * inside a transition belongs to that transition — its settlement commits
 * with that episode.
 */
export function refresh(node: Node): void {
  if (node instanceof Cell) return; // nothing to fetch
  const token = host !== null ? host.currentBatchToken() : null;
  if (token !== null) {
    const ep = episodeFor(token);
    ep.refreshMarks ??= new Map();
    ep.refreshMarks.set(node, (ep.refreshMarks.get(node) ?? 0) + 1);
    ep.armAutoRetire();
    // Make sure the episode's world notices even if it has no cell ops yet.
    ep.version++;
    pendingEpoch++;
    if (trace !== null) trace.emit("refresh", ep.openTrace, node.label, node);
    notifyDownstream(node, ep);
    flushAll();
    return;
  }
  // Canonical refetch: reset fetch slots, keep the settled value serving.
  if (node.ctx !== null) {
    node.ctx.slots = [];
  }
  node.state = DIRTY;
  node.settleRerun = true; // inputs unchanged; slot reset above forces fetches
  writeSeq++; // fetch state changed without a base write
  pendingEpoch++;
  if (trace !== null) trace.emit("refresh", traceCause, node.label, node);
  // Start the refetch now — refresh means "fetch", not "fetch when read".
  // The evaluation parks and the settled value keeps serving meanwhile.
  untracked(() => {
    try {
      readCanonical(node);
    } catch {
      // pending or failure: surfaced at consumer read sites
    }
  });
  notifyDownstream(node, null);
  flushAll();
}

// ---------------------------------------------------------------------------
// Render-context reads (for host hooks)
// ---------------------------------------------------------------------------

/**
 * Read a node for a subscriber render. Resolves the pass frame's world and
 * returns the raw slot (the hook applies suspend-vs-stale policy). When the
 * frame carries episodes, the cells the render actually touched are collected
 * so world-only dependencies still notify this subscriber.
 */
export function renderRead(
  node: Node,
  frame: Frame | null,
): { slot: unknown; cells: Set<Cell<any>> | null } {
  if (frame === null || (frame.episodes.length === 0 && frame.pinSeq >= writeSeq)) {
    return { slot: peekSlot(node, null), cells: null };
  }
  const prevCollect = subRenderCells;
  const cells = frame.episodes.length > 0 ? new Set<Cell<any>>() : null;
  subRenderCells = cells;
  try {
    return { slot: peekSlot(node, frame), cells };
  } finally {
    subRenderCells = prevCollect;
  }
}

/** True when an evaluation or render-frame read is in progress (used by the
 * host to keep `latest` context-bound). */
export function inReadContext(): boolean {
  return activeFrame !== null || activeEvalRun !== null;
}

// ---------------------------------------------------------------------------
// SSR — serialize canonical values, install them without acting like a write
// ---------------------------------------------------------------------------

/**
 * Serialize the canonical values of `atoms` keyed by the app-supplied labels
 * (falling back to positional keys). Unmaterialized lazy atoms run their
 * initializer here — serializing an atom is reading it.
 */
export function serializeAtomState(
  atoms: Array<Cell<any>>,
  replacer?: (key: string, value: unknown) => unknown,
): string {
  const out: Record<string, unknown> = {};
  atoms.forEach((cell, i) => {
    cell.materialize();
    out[cell.label ?? String(i)] = cell.value;
  });
  return JSON.stringify(out, replacer);
}

/**
 * Install serialized state onto `atoms`. Installation is not a write: no
 * equality check, no notification, no batch classification — and it does not
 * run lazy initializers (the value arriving from the server replaces them).
 */
export function initializeAtomState(
  json: string,
  atoms: Array<Cell<any>>,
  reviver?: (key: string, value: unknown) => unknown,
): void {
  const data = JSON.parse(json, reviver) as Record<string, unknown>;
  atoms.forEach((cell, i) => {
    const key = cell.label ?? String(i);
    if (Object.prototype.hasOwnProperty.call(data, key)) installState(cell, data[key]);
  });
}

/** Install one value: sets the base directly. Install ≠ write. */
export function installState<T>(cell: Cell<T>, value: T): void {
  cell.init = null; // the installed value replaces any pending initializer
  cell.value = value;
  cell.version++;
  cell.baseSeq = writeSeq;
}

// ---------------------------------------------------------------------------
// Test / lifecycle plumbing
// ---------------------------------------------------------------------------

/** Reset every piece of cross-atom engine state (per-test isolation). */
export function resetEngine(): void {
  for (const ep of [...openEpisodes]) abortEpisode(ep);
  openEpisodes.length = 0;
  episodesByToken.clear();
  passFrames.clear();
  cellsWithHistory.forEach((c) => (c.hist = null));
  cellsWithHistory.clear();
  cellsWithQueues.forEach((c) => (c.pend = null));
  cellsWithQueues.clear();
  rootViews.clear();
  committedByRoot.clear();
  subsByRoot.clear();
  pendingDeliveries.clear();
  speculativeSubs.clear();
  probeSubs.clear();
  subCount = 0;
  effectQueue.length = 0;
  worldCtxOwners.clear();
  latestFrameMemo = null;
  batchDepth = 0;
  flushing = false;
  traceCause = 0;
}

/** Everything a quiescent engine still holds, for leak audits. */
export function debugFootprint(): Record<string, number> {
  let views = 0;
  for (const view of rootViews.values()) views += view.size;
  return {
    openEpisodes: openEpisodes.length,
    passFrames: passFrames.size,
    cellsWithHistory: cellsWithHistory.size,
    rootViewEntries: views,
    pendingDeliveries: pendingDeliveries.size,
    worldCtxOwners: worldCtxOwners.size,
    subs: subCount,
  };
}
