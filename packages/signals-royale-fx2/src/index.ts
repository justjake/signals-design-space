/**
 * signals-royale-fx2 — a concurrent signal engine designed to ride React's
 * own scheduling machinery instead of forking it.
 *
 * Canonical state lives in a conventional signal graph (lazy cached
 * computeds, effects, batching). Concurrency is a thin overlay: writes
 * issued inside a React transition become DRAFTS (ordered logs of write
 * intents), and readers resolve values in a WORLD — canonical state plus
 * the drafts a specific render pass is allowed to see. Draft intents
 * replay over the live canonical value, so urgent writes rebase pending
 * transitions by construction. See worlds.ts for the full model.
 */

import {
  type CellNode,
  type DerivedNode,
  type EqualsFn,
  type Flags,
  type ReactiveNode,
  type UseFn,
  Flag,
  flushLifetimeTransitions,
  getActiveConsumer,
  isUninitialized,
  makeCell,
  makeDerived,
  makeEffect,
  makeScope,
  peekCell,
  readCell,
  readDerived,
  startBatch as graphStartBatch,
  endBatch as graphEndBatch,
  batch as graphBatch,
  untracked as graphUntracked,
  useImpl,
  writeCell,
} from './graph.ts';
import { type DerivedState, type ErrorBox, type Suspension, isErrorBox } from './asyncs.ts';
import {
  type Draft,
  type DraftId,
  type World,
  CANONICAL_WORLD,
  appendDraftIntent,
  appendUrgentIntent,
  cellHasDraftIntents,
  classifyWrite,
  committedWorldOf,
  discardAllDrafts,
  getCurrentPark,
  getCurrentWorld,
  latestWorld,
  peekWorldMemo,
  pokeRebasedCell,
  resolveState,
  setAmbientClassifier,
  unwrapForEval,
  worldOf,
} from './worlds.ts';
import { attachTracer, getActiveTracer, Tracer, type TraceEvent } from './tracer.ts';

// ---------------------------------------------------------------------------
// Public handle types
// ---------------------------------------------------------------------------

export interface SignalOptions<T> {
  equals?: EqualsFn<T>;
  label?: string;
  /** Runs when the atom gains its first subscriber of any kind; the cleanup
   * runs when the last subscriber of every kind is gone. */
  onObserved?: (ctx: { get(): T; set(v: T): void }) => void | (() => void);
}

export interface ComputedOptions<T> {
  equals?: EqualsFn<T>;
  label?: string;
}

export class Signal<T> {
  /** @internal */
  readonly node: CellNode<T>;
  constructor(initial: T | (() => T), opts?: SignalOptions<T>) {
    this.node = makeCell(initial, opts);
  }
  /** Canonical read (tracked inside computations); in a draft evaluation,
   * resolves that evaluation's own world. */
  get(): T {
    return readValue(this) as T;
  }
  set(value: T): void {
    writeSignal(this, value);
  }
  /** Functional update. Inside a transition the function is recorded and
   * REPLAYS against each world's base value (React updater-queue rules). */
  update(fn: (prev: T) => T): void {
    updateSignal(this, fn);
  }
  /** Untracked canonical read. */
  peek(): T {
    return graphUntracked(() => peekCell(this.node));
  }
}

export class Computed<T> {
  /** @internal */
  readonly node: DerivedNode<T>;
  constructor(fn: (use: UseFn) => T, opts?: ComputedOptions<T>) {
    this.node = makeDerived(fn, opts);
  }
  get(): T {
    return readValue(this) as T;
  }
  peek(): T {
    return graphUntracked(() => this.get());
  }
}

export type Readable<T> = Signal<T> | Computed<T>;
/** @internal Accepts any handle regardless of value-type variance. */
type AnyReadable = Signal<any> | Computed<any>;

export function signal<T>(initial: T | (() => T), opts?: SignalOptions<T>): Signal<T> {
  return new Signal(initial, opts);
}

export function computed<T>(fn: (use: UseFn) => T, opts?: ComputedOptions<T>): Computed<T> {
  return new Computed(fn, opts);
}

/** @internal Resolve a handle to its engine node. */
export function nodeOf(x: AnyReadable): ReactiveNode {
  const node = (x as Signal<unknown>).node;
  if (node === undefined) throw new TypeError('expected a signal or computed handle');
  return node;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function readValue(x: AnyReadable): unknown {
  const node = nodeOf(x);
  const world = getCurrentWorld();
  if (world !== null) {
    // Inside a draft evaluation every read resolves that world.
    return unwrapForEval(resolveState(node, world), getCurrentPark()!);
  }
  if ((node.flags & Flag.KindCell) !== 0) return readCell(node as CellNode<unknown>);
  const value = readDerived(node as DerivedNode<unknown>);
  const flags = node.flags;
  if ((flags & Flag.AsyncMask) !== 0) {
    if ((flags & Flag.AsyncError) !== 0) throw (node.throwable as ErrorBox).error;
    const suspension = node.throwable as Suspension;
    const consumer = getActiveConsumer();
    if (consumer !== null && (consumer.flags & Flag.KindDerived) !== 0) {
      // Pending forwards: park the evaluating computed on this suspension.
      useImpl(suspension.promise, consumer as DerivedNode<unknown>);
    }
    if (!isUninitialized((node as DerivedNode<unknown>).value)) return value; // stale serves
    throw suspension.promise; // never settled: suspend
  }
  return value;
}

/** The value slot of a state view, sentinel normalized: a suspended state
 * with no settled value reads as undefined on the never-suspending channels
 * (latest, committed). */
function stateValue(st: DerivedState): unknown {
  return isUninitialized(st.value) ? undefined : st.value;
}

/** Newest intent: canonical plus every live draft; never suspends. That is
 * the AMBIENT meaning — inside an evaluation context, latest() resolves that
 * context's own world instead, because reading ahead of your world is a
 * tear: a draft evaluation sees its draft world, a canonical computed or
 * effect evaluation sees canonical, a render pass sees the pass's world. */
export function latest<T>(x: Readable<T>): T {
  const node = nodeOf(x);
  let world = getCurrentWorld();
  if (world === null) {
    if (getActiveConsumer() !== null) {
      // A canonical evaluation (computed or effect) is running. Its context
      // world is canonical, and this read is a real dependency: track it so
      // a later change to x re-runs the consumer rather than leaving it
      // permanently stale.
      world = CANONICAL_WORLD;
      if ((node.flags & Flag.KindCell) !== 0) readCell(node as CellNode<unknown>);
      else readDerived(node as DerivedNode<unknown>);
    } else {
      world = renderWorld() ?? latestWorld();
    }
  }
  const st = resolveState(node, world);
  if ((st.flags & Flag.AsyncError) !== 0) throw (st.throwable as ErrorBox).error;
  return stateValue(st) as T;
}

/** What is on screen: per-root when a container is given. Never subscribes. */
export function committed<T>(x: Readable<T>, container?: object): T {
  const node = nodeOf(x);
  const st = resolveState(node, committedWorldOf(container));
  if ((st.flags & Flag.AsyncError) !== 0) throw (st.throwable as ErrorBox).error;
  return stateValue(st) as T;
}

/** Committed-view snapshot with stable identity: the value, or the ErrorBox
 * itself (identity-stable for the whole error span — see isErrorBox) whose
 * error the caller rethrows. The React bindings' useCommitted snapshot. */
export function committedSnapshot(node: ReactiveNode, container: object | undefined): unknown {
  const st = resolveState(node, committedWorldOf(container));
  if ((st.flags & Flag.AsyncError) !== 0) return st.throwable;
  return stateValue(st);
}

/** Cheap flip-only probe: true while newer data exists behind what is on
 * screen — a pending transition draft on this atom, or an async refetch
 * loading behind a stale value. Passive by contract: never evaluates,
 * never refetches, never suspends. */
export function isPending(x: AnyReadable): boolean {
  return isPendingPassive(nodeOf(x), getCurrentWorld() ?? renderWorld());
}

/** Node-level pendingness probe; `world` scopes the suspended-memo check
 * (null = ambient). The React bindings' useIsPending snapshot. */
export function isPendingPassive(node: ReactiveNode, world: World | null): boolean {
  if ((node.flags & Flag.KindCell) !== 0) return cellHasDraftIntents(node as CellNode<unknown>);
  if ((node.flags & Flag.KindDerived) === 0) return false;
  if ((node.flags & Flag.AsyncSuspended) !== 0) return true;
  if (world !== null && world.drafts.length > 0) {
    const memo = peekWorldMemo(node, world.sig);
    if (memo !== undefined && (memo.flags & Flag.AsyncSuspended) !== 0) return true;
  }
  // A drafted input means this computed has newer data pending too.
  for (let l = node.deps; l !== undefined; l = l.nextDep) {
    if ((l.dep.flags & Flag.KindCell) !== 0 && cellHasDraftIntents(l.dep as CellNode<unknown>)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Installed by the React bindings: throws when called during a render. */
let renderWriteGuard: (() => void) | null = null;
export function setRenderWriteGuard(fn: (() => void) | null): void {
  renderWriteGuard = fn;
}
function guardRenderWrite(): void {
  renderWriteGuard?.();
}

function writeSignal<T>(x: Signal<T>, value: T): void {
  guardRenderWrite();
  const cell = x.node as CellNode<unknown>;
  const draft = classifyWrite();
  if (draft !== null) {
    appendDraftIntent(draft, cell, 'set', value);
    return;
  }
  // Urgent: canonical moves now; pending worlds replay it in dispatch order.
  const rebased = appendUrgentIntent(cell, 'set', value);
  const changed = writeCell(x.node, value);
  // Equality cutoff with pending drafts: canonical did not move (no wave
  // ran) but the drafted replays did — their audiences must still hear it.
  if (rebased && !changed) pokeRebasedCell(cell);
}

function updateSignal<T>(x: Signal<T>, fn: (prev: T) => T): void {
  guardRenderWrite();
  const cell = x.node as CellNode<unknown>;
  const draft = classifyWrite();
  if (draft !== null) {
    appendDraftIntent(draft, cell, 'update', fn);
    return;
  }
  const rebased = appendUrgentIntent(cell, 'update', fn);
  const changed = writeCell(x.node, fn(graphUntracked(() => peekCell(x.node))));
  if (rebased && !changed) pokeRebasedCell(cell);
}

export function set<T>(x: Signal<T>, value: T): void {
  writeSignal(x, value);
}

export function update<T>(x: Signal<T>, fn: (prev: T) => T): void {
  updateSignal(x, fn);
}

export function read<T>(x: Readable<T>): T {
  return readValue(x) as T;
}

// ---------------------------------------------------------------------------
// Effects, batching, untracked
// ---------------------------------------------------------------------------

export const effect: (fn: () => void | (() => void)) => () => void = makeEffect;
export const effectScope: (fn: () => void) => () => void = makeScope;
export const batch: <T>(fn: () => T) => T = graphBatch;
export const startBatch: () => void = graphStartBatch;
export const endBatch: () => void = graphEndBatch;
export const untracked: <T>(fn: () => T) => T = graphUntracked;

// ---------------------------------------------------------------------------
// SSR
// ---------------------------------------------------------------------------

/** Atoms under app-supplied keys: positional (array) or named (record). */
type AtomMap = Record<string, Signal<any>> | Signal<any>[];

function atomEntries(atoms: AtomMap): Array<[string, Signal<unknown>]> {
  return Array.isArray(atoms)
    ? atoms.map((a, i) => [String(i), a] as [string, Signal<unknown>])
    : Object.entries(atoms);
}

/** Serialize canonical atom state under app-supplied keys. */
export function serializeAtomState(
  atoms: AtomMap,
  replacer?: (key: string, value: unknown) => unknown,
): string {
  const out: Record<string, unknown> = {};
  for (const [key, atom] of atomEntries(atoms)) {
    out[key] = graphUntracked(() => peekCell(atom.node));
  }
  return JSON.stringify(out, replacer as never);
}

/** Install a value without running lazy initializers and without counting
 * as a write: no propagation, no equality check, no effects. */
export function installState<T>(atom: Signal<T>, value: T): void {
  atom.node.initializer = undefined;
  atom.node.value = value;
}

export function initializeAtomState(
  json: string,
  atoms: AtomMap,
  reviver?: (key: string, value: unknown) => unknown,
): void {
  const data = JSON.parse(json, reviver as never) as Record<string, unknown>;
  for (const [key, atom] of atomEntries(atoms)) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      installState(atom, data[key]);
    }
  }
}

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

export { attachTracer, getActiveTracer, Tracer };
export type { TraceEvent };

// ---------------------------------------------------------------------------
// Render-world provider (installed by the ./react bindings, which import
// engine modules directly — the react directory is part of the library).
// ---------------------------------------------------------------------------

/** Installed by the bindings: answers "what world is rendering right now".
 * - draft ids: the pass's world was noted by this pass and is still valid;
 * - 'canonical': a component render is executing but no valid note exists
 *   (the note expired or belongs to another pass) — plain latest()/
 *   isPending() must fall back to CANONICAL rather than read a stale world
 *   or read ahead into live drafts;
 * - null: no render is executing — ambient reads see newest intent.
 * A provider (not a sticky setter) because only the host knows when React
 * is rendering and which notes a pass refreshed. */
let renderWorldProvider: (() => readonly DraftId[] | 'canonical' | null) | null = null;

export function setRenderWorldProvider(
  fn: (() => readonly DraftId[] | 'canonical' | null) | null,
): void {
  renderWorldProvider = fn;
}

function renderWorld(): World | null {
  if (renderWorldProvider === null) return null;
  const ids = renderWorldProvider();
  if (ids === null) return null;
  if (ids === 'canonical') return CANONICAL_WORLD;
  return worldOf(ids);
}

/** Reset seam for tests: discard live drafts, settle lifetime flaps, drop
 * ambient classification, detach any tracer. Existing atoms stay valid. */
export function resetEngineForTest(): void {
  discardAllDrafts();
  flushLifetimeTransitions();
  setAmbientClassifier(null);
  setRenderWriteGuard(null);
  renderWorldProvider = null;
  getActiveTracer()?.stop();
}

export type { DerivedState, ErrorBox, Suspension, World, DraftId, Draft, UseFn, EqualsFn, Flags };
/** The DerivedState read protocol: the Flag bit constants (test async bits
 * via Flag.AsyncMask/AsyncError/AsyncSuspended), the error-box identity
 * check, and the never-settled sentinel test. */
export { Flag, isErrorBox, isUninitialized };
export { CANONICAL_WORLD };
