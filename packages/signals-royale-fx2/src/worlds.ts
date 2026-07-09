/**
 * Worlds: speculative overlays that make React transitions invisible to
 * canonical readers until they commit.
 *
 * A DRAFT is the engine-side record of one transition batch: write intents
 * (set values and update functions) against base cells. A WORLD is
 * "canonical state plus an ordered set of drafts" — exactly what one React
 * render pass is allowed to see.
 *
 * Replay follows React's updater-queue rules. Every intent — urgent or
 * drafted — gets a global sequence number at dispatch. While any draft
 * touches a cell, the cell keeps a REBASE LOG: its base value plus all
 * intents in dispatch order. Views then differ only in which intents they
 * include:
 *
 * - canonical = base + urgent intents (drafts skipped, later urgents still
 *   apply — so a counter at 1 with a pending transition "+2" shows 2 after
 *   an urgent "*2");
 * - a world   = base + urgent intents + its drafts' intents, all in
 *   dispatch order (the transition lands at (1+2)*2 = 6, never a reorder).
 *
 * Retiring a draft folds the full replay into canonical state through the
 * ordinary write path (effects, equality, propagation) and marks the draft
 * retired, so render passes still holding its id resolve identical values.
 * When the last draft touching a cell dies, the log is dropped — a
 * quiescent engine holds no per-suspension state anywhere.
 */

import {
  type CellNode,
  type DerivedNode,
  type ReactiveNode,
  type TraceEventId,
  ASYNC_MASK,
  Flags,
  NO_EVENT,
  bumpReactEpoch,
  currentWriteEpoch,
  ensureFresh,
  hooks,
  peekCell,
  pokeAndWakeLeafObservers,
  pokeLeafObservers,
  setCurrentCause,
  startBatch,
  endBatch,
  untracked,
  withSuppressedReactEpoch,
  writeCell,
} from './graph.ts';
import {
  type DerivedState,
  type ErrorBox,
  type Suspension,
  makeErrorBox,
  makeSuspension,
  setOnSettlementEpoch,
  trackThenable,
} from './asyncs.ts';

export type DraftId = number;
export type DraftState = 'open' | 'sealed' | 'retired' | 'discarded';
/** Bumps whenever any draft's ops or state change; world memos key on it. */
export type WorldEpoch = number;
/** Global dispatch order across urgent and drafted intents. */
export type OpSeq = number;

export type OpKind = 'set' | 'update';

export interface Intent {
  seq: OpSeq;
  kind: OpKind;
  payload: unknown;
  /** The draft that issued this intent; null for urgent intents. */
  draft: Draft | null;
}

export interface RebaseLog {
  /** Canonical value when the first draft intent arrived. */
  base: unknown;
  intents: Intent[];
}

export interface Draft {
  id: DraftId;
  state: DraftState;
  /** Cells this draft wrote (for fold, poke, and log teardown). */
  cells: Set<CellNode<unknown>>;
  openEvent: TraceEventId;
  retireEvent: TraceEventId;
  lastWriteEvent: TraceEventId;
}

let nextDraftId: DraftId = 1;
let nextSeq: OpSeq = 1;
/** Open and sealed drafts, in creation order (Map preserves insertion). */
const liveDrafts = new Map<DraftId, Draft>();
/** Cells with at least one live draft intent. */
const rebaseLogs = new Map<CellNode<unknown>, RebaseLog>();
let worldEpoch: WorldEpoch = 1;
/** Nodes holding world memos, for sweeping at quiescence. */
const memoNodes = new Set<ReactiveNode>();
/** Per-root committed draft sets, recorded by the bindings at root commits. */
const committedWorlds = new WeakMap<object, readonly DraftId[]>();

setOnSettlementEpoch(() => {
  worldEpoch++;
});

export function currentWorldEpoch(): WorldEpoch {
  return worldEpoch;
}

export function liveDraftCount(): number {
  return liveDrafts.size;
}

export function getDraft(id: DraftId): Draft | undefined {
  return liveDrafts.get(id);
}

export function openDraft(): Draft {
  const draft: Draft = {
    id: nextDraftId++,
    state: 'open',
    cells: new Set(),
    openEvent: hooks.trace !== null ? hooks.trace('draft-open', null, NO_EVENT) : NO_EVENT,
    retireEvent: NO_EVENT,
    lastWriteEvent: NO_EVENT,
  };
  liveDrafts.set(draft.id, draft);
  worldEpoch++;
  return draft;
}

export function sealDraft(draft: Draft): void {
  if (draft.state === 'open') draft.state = 'sealed';
}

function logFor(cell: CellNode<unknown>): RebaseLog {
  let log = rebaseLogs.get(cell);
  if (log === undefined) {
    // Capture the base BEFORE any speculative intent; materializes lazy
    // cells (replay needs the base for the equality/update contract).
    log = { base: untracked(() => peekCell(cell)), intents: [] };
    rebaseLogs.set(cell, log);
  }
  return log;
}

/** Record a drafted write intent. Speculative subscribers (isPending probes,
 * latest() viewers) get poked; canonical values do not move. Subscribers of
 * the cell — and of watched computeds over it — additionally receive the
 * draft id on their draft-lane channel, so exactly the affected components
 * join the transition's render passes (write-time dispatch runs inside the
 * transition scope; late appends re-dispatch to the same audience). */
export function appendDraftIntent(
  draft: Draft,
  cell: CellNode<unknown>,
  kind: OpKind,
  payload: unknown,
): void {
  if (draft.state !== 'open') {
    throw new Error('cannot write into a batch that already ended');
  }
  logFor(cell).intents.push({ seq: nextSeq++, kind, payload, draft });
  draft.cells.add(cell);
  worldEpoch++;
  if (hooks.trace !== null) {
    draft.lastWriteEvent = hooks.trace('write', cell, draft.openEvent, { draft: draft.id });
    cell.causeEvent = draft.lastWriteEvent;
  }
  pokeAndWakeLeafObservers(cell, draft.id);
}

/** Record an urgent intent on a cell that currently has a rebase log, so
 * pending worlds replay it in dispatch order. The canonical write itself is
 * performed by the caller. */
export function appendUrgentIntent(cell: CellNode<unknown>, kind: OpKind, payload: unknown): boolean {
  const log = rebaseLogs.get(cell);
  if (log === undefined) return false;
  log.intents.push({ seq: nextSeq++, kind, payload, draft: null });
  worldEpoch++;
  return true;
}

/** Replay a cell's log for a world (or for canonical state, when `world` is
 * null): urgent and retired intents always apply; drafted intents apply
 * only when the world includes their draft. */
function replayLog(cell: CellNode<unknown>, world: World | null): unknown {
  const log = rebaseLogs.get(cell);
  if (log === undefined) return untracked(() => peekCell(cell));
  let value = log.base;
  for (const intent of log.intents) {
    const d = intent.draft;
    const included =
      d === null ||
      d.state === 'retired' ||
      (world !== null && world.drafts.includes(d));
    if (!included) continue;
    value = intent.kind === 'set' ? intent.payload : (intent.payload as (p: unknown) => unknown)(value);
  }
  return value;
}

/** Fold a draft into canonical state through the normal write path, then
 * let stale world sets resolve it as a no-op.
 *
 * `silent` folds keep subscription epochs still: use it when render-pass
 * worlds already delivered the draft's values to every subscriber (a
 * committed transition), so the fold must not schedule repair renders.
 * A loud fold (the default) is for drafts nothing rendered — their values
 * become visible only through this fold, so subscribers re-render. */
export function retireDraft(id: DraftId, opts?: { silent?: boolean }): void {
  const draft = liveDrafts.get(id);
  if (draft === undefined) return;
  liveDrafts.delete(id);
  draft.state = 'retired';
  worldEpoch++;
  const evt =
    hooks.trace !== null
      ? hooks.trace(
          'draft-retire',
          null,
          draft.lastWriteEvent !== NO_EVENT ? draft.lastWriteEvent : draft.openEvent,
        )
      : NO_EVENT;
  draft.retireEvent = evt;
  const prevCause = setCurrentCause(evt);
  const fold = () => {
    startBatch();
    try {
      for (const cell of draft.cells) {
        // The draft is marked retired, so the full committed replay
        // includes its intents interleaved with urgent ones in dispatch
        // order.
        writeCell(cell, replayLog(cell, null));
        pokeLeafObservers(cell);
      }
    } finally {
      endBatch();
    }
  };
  try {
    if (opts?.silent === true) withSuppressedReactEpoch(fold);
    else fold();
  } finally {
    setCurrentCause(prevCause);
  }
  releaseLogs(draft);
  maybeQuiesce();
}

/** Roll back an abandoned draft: anyone who saw it re-resolves without it. */
export function discardDraft(id: DraftId): void {
  const draft = liveDrafts.get(id);
  if (draft === undefined) return;
  liveDrafts.delete(id);
  draft.state = 'discarded';
  worldEpoch++;
  if (hooks.trace !== null) hooks.trace('draft-discard', null, draft.openEvent);
  for (const cell of draft.cells) {
    bumpReactEpoch(cell);
    pokeLeafObservers(cell);
  }
  releaseLogs(draft);
  maybeQuiesce();
}

/** Drop rebase logs on cells no longer touched by any live draft. */
function releaseLogs(dead: Draft): void {
  for (const cell of dead.cells) {
    let stillDrafted = false;
    const log = rebaseLogs.get(cell);
    if (log === undefined) continue;
    for (const intent of log.intents) {
      if (intent.draft !== null && intent.draft.state !== 'retired' && intent.draft.state !== 'discarded') {
        stillDrafted = true;
        break;
      }
    }
    if (!stillDrafted) rebaseLogs.delete(cell);
  }
}

/** Quiescence: with no live drafts, every per-suspension structure empties. */
function maybeQuiesce(): void {
  if (liveDrafts.size > 0) return;
  rebaseLogs.clear();
  for (const node of memoNodes) node.worldMemos = null;
  memoNodes.clear();
}

/** True while the draft is open or sealed (retired/discarded ids are dead:
 * their effects are already canonical or rolled back). */
export function isLiveDraft(id: DraftId): boolean {
  return liveDrafts.has(id);
}

const NO_IDS: readonly DraftId[] = [];

/** Live drafts holding intents against this node's canonical sources (the
 * node itself for a cell; its transitive dependency cells for a derived).
 * Serves late-subscription repair: a subscriber that mounted after the
 * write-time wakes asks which transitions it missed. */
export function draftsAffecting(node: ReactiveNode): readonly DraftId[] {
  if (liveDrafts.size === 0) return NO_IDS;
  const sources = new Set<CellNode<unknown>>();
  const visited = new Set<ReactiveNode>();
  const collect = (n: ReactiveNode): void => {
    if (visited.has(n)) return;
    visited.add(n);
    if ((n.flags & Flags.Cell) !== 0) {
      sources.add(n as CellNode<unknown>);
      return;
    }
    for (let l = n.deps; l !== undefined; l = l.nextDep) collect(l.dep);
  };
  collect(node);
  const out: DraftId[] = [];
  for (const [id, draft] of liveDrafts) {
    for (const cell of draft.cells) {
      if (sources.has(cell)) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

/** True while some live draft holds intents against this cell. */
export function cellHasDraftIntents(cell: CellNode<unknown>): boolean {
  const log = rebaseLogs.get(cell);
  if (log === undefined) return false;
  for (const intent of log.intents) {
    const d = intent.draft;
    if (d !== null && d.state !== 'retired' && d.state !== 'discarded') return true;
  }
  return false;
}

/** Test/reset seam: discard every live draft and clear per-suspension state. */
export function discardAllDrafts(): void {
  for (const id of [...liveDrafts.keys()]) discardDraft(id);
}

// ---------------------------------------------------------------------------
// Write classification
// ---------------------------------------------------------------------------

/** Explicit draft scope (startTransitionWrite / adapter runInBatch). */
let currentDraft: Draft | null = null;
/** Ambient classifier installed by the React bindings: detects writes issued
 * inside React.startTransition without our helper. */
let ambientClassifier: (() => Draft | null) | null = null;

export function setAmbientClassifier(fn: (() => Draft | null) | null): void {
  ambientClassifier = fn;
}

export function runInDraft<T>(draft: Draft, fn: () => T): T {
  const prev = currentDraft;
  currentDraft = draft;
  try {
    return fn();
  } finally {
    currentDraft = prev;
  }
}

export function classifyWrite(): Draft | null {
  if (currentDraft !== null) return currentDraft;
  if (ambientClassifier !== null) return ambientClassifier();
  return null;
}

// ---------------------------------------------------------------------------
// World resolution
// ---------------------------------------------------------------------------

export interface World {
  /** Live drafts, in creation order. */
  drafts: readonly Draft[];
  sig: string;
}

export const CANONICAL_WORLD: World = { drafts: [], sig: '' };

/** Normalize a render pass's draft-id set: retired and discarded drafts drop
 * out (their effects are already canonical / rolled back), order is
 * creation order regardless of arrival order. */
export function makeWorld(ids: readonly DraftId[]): World {
  if (ids.length === 0) return CANONICAL_WORLD;
  const drafts: Draft[] = [];
  for (const [id, draft] of liveDrafts) {
    if (ids.includes(id)) drafts.push(draft);
  }
  if (drafts.length === 0) return CANONICAL_WORLD;
  return { drafts, sig: drafts.map((d) => d.id).join(',') };
}

/** The world an evaluation is running in; null means canonical. */
let currentWorld: World | null = null;

export function getCurrentWorld(): World | null {
  return currentWorld;
}

export function withWorld<T>(world: World | null, fn: () => T): T {
  const prev = currentWorld;
  currentWorld = world;
  try {
    return fn();
  } finally {
    currentWorld = prev;
  }
}

/** World objects per id-array identity (React state arrays are stable
 * across renders, so this makes repeated resolves allocation-free). */
const worldCache = new WeakMap<readonly DraftId[], { epoch: WorldEpoch; world: World }>();

export function worldOf(ids: readonly DraftId[]): World {
  if (ids.length === 0) return CANONICAL_WORLD;
  const hit = worldCache.get(ids);
  if (hit !== undefined && hit.epoch === worldEpoch) return hit.world;
  const world = makeWorld(ids);
  worldCache.set(ids, { epoch: worldEpoch, world });
  return world;
}

interface WorldMemo {
  writeEpoch: number;
  worldEpoch: WorldEpoch;
  state: DerivedState;
}

function memoFor(node: ReactiveNode, sig: string): WorldMemo | undefined {
  return node.worldMemos?.get(sig) as WorldMemo | undefined;
}

/** Passive view of a world memo's state (no evaluation, no validation). */
export function peekWorldMemo(node: ReactiveNode, sig: string): DerivedState | undefined {
  return memoFor(node, sig)?.state;
}

function storeMemo(node: ReactiveNode, sig: string, memo: WorldMemo): void {
  if (node.worldMemos === null) {
    node.worldMemos = new Map();
    memoNodes.add(node);
  }
  node.worldMemos.set(sig, memo);
}

/** State identity stability: keep the previous state record when the fresh
 * resolution is indistinguishable, so subscribers comparing snapshots by
 * identity do not re-render for no reason. Value states compare with the
 * node's equals(); suspended states are the same span iff the suspension and
 * the stale value match; error states are the same span iff the box carries
 * the same reason reference. */
function reconcileStates(
  node: ReactiveNode,
  prev: DerivedState | undefined,
  next: DerivedState,
): DerivedState {
  if (prev === undefined) return next;
  const asyncBits = next.flags & ASYNC_MASK;
  if ((prev.flags & ASYNC_MASK) !== asyncBits) return next;
  if (asyncBits === 0) {
    const equals = (node as DerivedNode<unknown>).equals ?? Object.is;
    return equals(prev.value, next.value) ? prev : next;
  }
  if (asyncBits === Flags.DerivedSuspended) {
    return prev.throwable === next.throwable && prev.value === next.value ? prev : next;
  }
  return (prev.throwable as ErrorBox).error === (next.throwable as ErrorBox).error ? prev : next;
}

/** Resolve a node's value as seen by a world. A canonical world hits the
 * ordinary graph and returns the NODE ITSELF as the state view (cells and
 * deriveds carry the DerivedState shape; the trivial read allocates
 * nothing); drafted worlds replay intents (cells) or speculatively evaluate
 * (deriveds) into memo records per (node, world signature). */
export function resolveState(node: ReactiveNode, world: World): DerivedState {
  if (world.drafts.length === 0) {
    untracked(() => {
      if ((node.flags & Flags.Cell) !== 0) peekCell(node as CellNode<unknown>);
      else ensureFresh(node as DerivedNode<unknown>);
    });
    return node as CellNode<unknown> | DerivedNode<unknown>;
  }
  const memo = memoFor(node, world.sig);
  if (
    memo !== undefined &&
    memo.writeEpoch === currentWriteEpoch() &&
    memo.worldEpoch === worldEpoch
  ) {
    return memo.state;
  }
  const fresh: DerivedState =
    (node.flags & Flags.Cell) !== 0
      ? { flags: 0, value: replayLog(node as CellNode<unknown>, world), throwable: null }
      : draftEvaluate(node as DerivedNode<unknown>, world, memo?.state);
  const state = reconcileStates(node, memo?.state, fresh);
  storeMemo(node, world.sig, { writeEpoch: currentWriteEpoch(), worldEpoch, state });
  return state;
}

/** Guards against a computed reading itself within one world. */
const draftEvalStack = new Map<ReactiveNode, Set<string>>();

function draftEvaluate(
  node: DerivedNode<unknown>,
  world: World,
  prev: DerivedState | undefined,
): DerivedState {
  let sigs = draftEvalStack.get(node);
  if (sigs?.has(world.sig)) {
    throw new Error(`cycle detected in computed${node.label ? ` "${node.label}"` : ''}`);
  }
  if (sigs === undefined) draftEvalStack.set(node, (sigs = new Set()));
  sigs.add(world.sig);
  // Suspense retries must observe one stable thenable per pending span.
  const suspension =
    prev !== undefined &&
    (prev.flags & Flags.DerivedSuspended) !== 0 &&
    !(prev.throwable as Suspension).settled
      ? (prev.throwable as Suspension)
      : makeSuspension();
  const worldUse = (t: PromiseLike<unknown>): unknown => {
    const box = trackThenable(t);
    if (box.status === 'fulfilled') return box.value;
    if (box.status === 'rejected') throw box.reason;
    box.parkedSuspensions.add(suspension);
    throw WORLD_PARKED;
  };
  const prevPark = currentPark;
  currentPark = worldUse;
  try {
    const value = untracked(() => withWorld(world, () => node.fn(worldUse as never)));
    return { flags: 0, value, throwable: null };
  } catch (e) {
    if (e === WORLD_PARKED) {
      // The canonical value doubles as the stale serve (sentinel = none yet).
      return { flags: Flags.DerivedSuspended, value: node.value, throwable: suspension };
    }
    if (
      prev !== undefined &&
      (prev.flags & Flags.DerivedError) !== 0 &&
      (prev.throwable as ErrorBox).error === e
    ) {
      return prev;
    }
    return { flags: Flags.DerivedError, value: node.value, throwable: makeErrorBox(e) };
  } finally {
    currentPark = prevPark;
    sigs.delete(world.sig);
    if (sigs.size === 0) draftEvalStack.delete(node);
  }
}

const WORLD_PARKED = Symbol('world-parked');

/** The park function of the draft evaluation in progress (if any); reads of
 * pending values inside that evaluation forward through it. */
let currentPark: ((t: PromiseLike<unknown>) => unknown) | null = null;

export function getCurrentPark(): ((t: PromiseLike<unknown>) => unknown) | null {
  return currentPark;
}

/** Unwrap a resolved state from inside another evaluation: values flow,
 * errors rethrow their stable reason, suspended forwards by parking the
 * reader (no stale serve here — a world evaluation must not fold a stale
 * canonical value into a speculative result). */
export function unwrapForEval(st: DerivedState, park: (t: PromiseLike<unknown>) => unknown): unknown {
  const asyncBits = st.flags & ASYNC_MASK;
  if (asyncBits === 0) return st.value;
  if (asyncBits === Flags.DerivedError) throw (st.throwable as ErrorBox).error;
  return park((st.throwable as Suspension).promise);
}

// ---------------------------------------------------------------------------
// Ambient views
// ---------------------------------------------------------------------------

/** Newest intent: canonical plus every live draft, in creation order. */
export function latestWorld(): World {
  if (liveDrafts.size === 0) return CANONICAL_WORLD;
  const drafts = [...liveDrafts.values()];
  return { drafts, sig: drafts.map((d) => d.id).join(',') };
}

export function setCommittedWorld(container: object, ids: readonly DraftId[]): void {
  committedWorlds.set(container, ids);
}

export function committedWorldOf(container: object | undefined): World {
  if (container === undefined) return CANONICAL_WORLD;
  const ids = committedWorlds.get(container);
  return ids === undefined ? CANONICAL_WORLD : worldOf(ids);
}
