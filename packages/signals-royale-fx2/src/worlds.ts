/**
 * Worlds: speculative overlays that make React transitions invisible to
 * canonical readers until they commit.
 *
 * A DRAFT is the engine-side record of one transition batch: an ordered log
 * of write intents (set values and update functions) against base cells. A
 * WORLD is "canonical state plus an ordered set of drafts" — exactly what
 * one React render pass is allowed to see. Resolving a value in a world
 * replays the drafts' intents over the current canonical value, so an
 * urgent write that lands mid-transition automatically REBASES the pending
 * drafts: update functions re-execute against the new base (signal at 1,
 * transition applies x*2, urgent applies x+1 and shows 2 — the transition
 * lands at 4, never 2).
 *
 * The React bindings never tell the engine "which world is rendering";
 * instead each render pass carries its own draft-id set through React state
 * (React's own update queues implement the world algebra), and the bindings
 * resolve reads against that set. When every root has committed a draft,
 * the bindings retire it here: retiring FOLDS the intents into canonical
 * state through the ordinary write path (effects and equality included) and
 * from then on the draft resolves as a no-op, so renders holding stale
 * world sets still resolve to the same values.
 */

import {
  type CellNode,
  type DerivedNode,
  type ReactiveNode,
  type TraceEventId,
  NO_EVENT,
  currentWriteEpoch,
  ensureFresh,
  hooks,
  isUninitialized,
  peekCell,
  pokeLeafObservers,
  setCurrentCause,
  startBatch,
  endBatch,
  untracked,
  writeCell,
} from './graph.ts';
import {
  type Envelope,
  type Episode,
  type ErrorBox,
  envelopeOf,
  makeEpisode,
  setOnSettlementEpoch,
  trackThenable,
} from './asyncs.ts';

export type DraftId = number;
export type DraftState = 'open' | 'sealed' | 'retired' | 'discarded';
/** Bumps whenever any draft's ops or state change; world memos key on it. */
export type WorldEpoch = number;

export interface DraftOp {
  cell: CellNode<unknown>;
  kind: 'set' | 'update';
  payload: unknown;
}

export interface Draft {
  id: DraftId;
  state: DraftState;
  ops: DraftOp[];
  openEvent: TraceEventId;
  retireEvent: TraceEventId;
}

let nextDraftId: DraftId = 1;
/** Open and sealed drafts, in creation order (Map preserves insertion). */
const liveDrafts = new Map<DraftId, Draft>();
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

export function allLiveDraftIds(): DraftId[] {
  return [...liveDrafts.keys()];
}

export function getDraft(id: DraftId): Draft | undefined {
  return liveDrafts.get(id);
}

export function openDraft(): Draft {
  const draft: Draft = {
    id: nextDraftId++,
    state: 'open',
    ops: [],
    openEvent: hooks.trace !== null ? hooks.trace('draft-open', null, NO_EVENT) : NO_EVENT,
    retireEvent: NO_EVENT,
  };
  liveDrafts.set(draft.id, draft);
  worldEpoch++;
  return draft;
}

export function sealDraft(draft: Draft): void {
  if (draft.state === 'open') draft.state = 'sealed';
}

export function appendOp(draft: Draft, op: DraftOp): void {
  if (draft.state !== 'open') {
    throw new Error('cannot write into a batch that already ended');
  }
  draft.ops.push(op);
  worldEpoch++;
  if (hooks.trace !== null) hooks.trace('write', op.cell, draft.openEvent, { draft: draft.id });
}

/** Fold a draft's intents into canonical state through the normal write
 * path, then let stale world sets resolve it as a no-op. */
export function retireDraft(id: DraftId): void {
  const draft = liveDrafts.get(id);
  if (draft === undefined) return;
  liveDrafts.delete(id);
  draft.state = 'retired';
  worldEpoch++;
  const evt =
    hooks.trace !== null ? hooks.trace('draft-retire', null, draft.openEvent) : NO_EVENT;
  draft.retireEvent = evt;
  const prevCause = setCurrentCause(evt);
  startBatch();
  try {
    for (const op of draft.ops) {
      const next =
        op.kind === 'set'
          ? op.payload
          : (op.payload as (prev: unknown) => unknown)(peekCell(op.cell));
      writeCell(op.cell, next);
    }
  } finally {
    endBatch();
    setCurrentCause(prevCause);
  }
  maybeQuiesce();
}

/** Roll back an abandoned draft; speculative readers re-resolve without it. */
export function discardDraft(id: DraftId): void {
  const draft = liveDrafts.get(id);
  if (draft === undefined) return;
  liveDrafts.delete(id);
  draft.state = 'discarded';
  worldEpoch++;
  if (hooks.trace !== null) hooks.trace('draft-discard', null, draft.openEvent);
  const seen = new Set<CellNode<unknown>>();
  for (const op of draft.ops) {
    if (!seen.has(op.cell)) {
      seen.add(op.cell);
      pokeLeafObservers(op.cell);
    }
  }
  maybeQuiesce();
}

/** Quiescence: with no live drafts, every per-episode structure empties. */
function maybeQuiesce(): void {
  if (liveDrafts.size > 0) return;
  for (const node of memoNodes) node.worldMemos = null;
  memoNodes.clear();
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
  env: Envelope;
}

function memoFor(node: ReactiveNode, sig: string): WorldMemo | undefined {
  return node.worldMemos?.get(sig) as WorldMemo | undefined;
}

function storeMemo(node: ReactiveNode, sig: string, memo: WorldMemo): void {
  if (node.worldMemos === null) {
    node.worldMemos = new Map();
    memoNodes.add(node);
  }
  node.worldMemos.set(sig, memo);
}

/** Envelope identity stability: keep the previous envelope object when the
 * fresh resolution is indistinguishable, so subscribers comparing snapshots
 * by identity do not re-render for no reason. */
function reconcileEnvelopes(node: ReactiveNode, prev: Envelope | undefined, next: Envelope): Envelope {
  if (prev === undefined) return next;
  if (prev.kind === 'value' && next.kind === 'value') {
    const equals = (node as DerivedNode<unknown>).equals ?? Object.is;
    return equals(prev.value, next.value) ? prev : next;
  }
  if (prev.kind === 'pending' && next.kind === 'pending' && prev.episode === next.episode) {
    return prev.value === next.value ? prev : next;
  }
  if (prev.kind === 'error' && next.kind === 'error' && prev.box.error === next.box.error) {
    return prev;
  }
  return next;
}

/** Resolve a node's value as seen by a world. Canonical worlds hit the
 * ordinary graph; drafted worlds replay intents (cells) or speculatively
 * evaluate (deriveds) with memoization per (node, world signature). */
export function resolveEnvelope(node: ReactiveNode, world: World): Envelope {
  if (world.drafts.length === 0) {
    return untracked(() => {
      if (node.kind === 'cell') {
        return { kind: 'value', value: peekCell(node as CellNode<unknown>) } as Envelope;
      }
      ensureFresh(node as DerivedNode<unknown>);
      return envelopeOf(node as DerivedNode<unknown>);
    });
  }
  const memo = memoFor(node, world.sig);
  if (
    memo !== undefined &&
    memo.writeEpoch === currentWriteEpoch() &&
    memo.worldEpoch === worldEpoch
  ) {
    return memo.env;
  }
  const fresh =
    node.kind === 'cell'
      ? replayCell(node as CellNode<unknown>, world)
      : draftEvaluate(node as DerivedNode<unknown>, world, memo?.env);
  const env = reconcileEnvelopes(node, memo?.env, fresh);
  storeMemo(node, world.sig, { writeEpoch: currentWriteEpoch(), worldEpoch, env });
  return env;
}

function replayCell(cell: CellNode<unknown>, world: World): Envelope {
  let value = untracked(() => peekCell(cell));
  for (const draft of world.drafts) {
    for (const op of draft.ops) {
      if (op.cell !== cell) continue;
      value = op.kind === 'set' ? op.payload : (op.payload as (p: unknown) => unknown)(value);
    }
  }
  return { kind: 'value', value };
}

/** Guards against a computed reading itself within one world. */
const draftEvalStack = new Map<ReactiveNode, Set<string>>();

function draftEvaluate(node: DerivedNode<unknown>, world: World, prev: Envelope | undefined): Envelope {
  let sigs = draftEvalStack.get(node);
  if (sigs?.has(world.sig)) {
    throw new Error(`cycle detected in computed${node.label ? ` "${node.label}"` : ''}`);
  }
  if (sigs === undefined) draftEvalStack.set(node, (sigs = new Set()));
  sigs.add(world.sig);
  // Suspense retries must observe one stable thenable per pending span.
  const episode =
    prev !== undefined && prev.kind === 'pending' && !prev.episode.settled
      ? prev.episode
      : makeEpisode();
  const worldUse = (t: PromiseLike<unknown>): unknown => {
    const box = trackThenable(t);
    if (box.status === 'fulfilled') return box.value;
    if (box.status === 'rejected') throw box.reason;
    box.parkedEpisodes.add(episode);
    throw WORLD_PARKED;
  };
  const prevPark = currentPark;
  currentPark = worldUse;
  try {
    const value = untracked(() => withWorld(world, () => node.fn(worldUse as never)));
    return { kind: 'value', value };
  } catch (e) {
    if (e === WORLD_PARKED) {
      return {
        kind: 'pending',
        episode,
        stale: !isUninitialized(node.value),
        value: isUninitialized(node.value) ? undefined : node.value,
      };
    }
    if (prev !== undefined && prev.kind === 'error' && prev.box.error === e) return prev;
    return { kind: 'error', box: { error: e } };
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

/** Unwrap an envelope from inside another evaluation: values flow, errors
 * rethrow their stable reason, pending forwards by parking the reader. */
export function unwrapForEval(env: Envelope, park: (t: PromiseLike<unknown>) => unknown): unknown {
  if (env.kind === 'value') return env.value;
  if (env.kind === 'error') throw env.box.error;
  return park(env.episode.promise);
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
