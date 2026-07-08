/**
 * signals-royale-fx1 — public surface.
 *
 * Core: `atom`, `computed`, `effect`, `effectScope`, `batch`, `untracked`.
 * Read family: `read` (canonical), `latest`, `committed`, `isPending`,
 * `refresh`. SSR: `serializeAtomState` / `initializeAtomState` /
 * `installState`. Debugging: `startTrace`.
 *
 * The host-integration exports (setHost, beginPass, commitPass, subscribe,
 * renderRead, …) are how a UI runtime plugs the engine into its scheduler;
 * application code never needs them.
 */
import {
  Cell,
  Derived,
  EffectNode,
  EffectScope,
  createEffect,
  untracked,
  type AtomOptions,
  type Equality,
  type Use,
} from './engine';

export {
  batch,
  startBatch,
  endBatch,
  untracked,
  latest,
  committed,
  isPending,
  refresh,
  serializeAtomState,
  initializeAtomState,
  installState,
  // Host integration surface (UI runtimes only).
  setHost,
  setTraceSink,
  setTraceCause,
  episodeFor,
  retireEpisode,
  abortEpisode,
  beginPass,
  commitPass,
  discardPass,
  frameForRoot,
  latestFrame,
  renderRead,
  inReadContext,
  subscribe,
  registerSubRoot,
  unregisterSubRoot,
  peekSlot,
  openEpisodesSnapshot,
  episodeAffects,
  resetEngine,
  debugFootprint,
  engineNow,
  trace,
  traceCause,
  Cell,
  Derived,
  EffectScope,
  Episode,
  Frame,
  Pending,
  Failure,
  CycleError,
  SUB_NEVER,
} from './engine';
export type {
  AtomOptions,
  Equality,
  Use,
  EngineHost,
  Sub,
  TraceSink,
  TraceEventId,
  WriteSeq,
  EpisodeSeq,
  NodeVersion,
  EpisodeState,
  EvalCtx,
} from './engine';
export { Tracer, startTrace, type TraceEvent, type TracerOptions } from './tracer';

/** A writable reactive value. */
export type Atom<T> = Cell<T>;
/** A cached derived value. */
export type Computed<T> = Derived<T>;

/**
 * Create a writable atom. A function initial value is a lazy initializer: it
 * runs once, untracked, at first materialization (first read, write, or
 * subscription — never at construction), and it must not write. A `set`
 * before the first read still runs it first, because deciding whether the
 * write changed anything requires the base value.
 */
export function atom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
  return new Cell(initial, opts);
}

/**
 * Create a computed. Lazy, cached, equality cutoff, dynamic dependency
 * tracking with trimming. The function receives `use` for async reads: an
 * unsettled thenable parks the evaluation as pending (all async reads it can
 * reach register first, so independent fetches run in parallel) and the
 * computed settles like a write when the data arrives.
 */
export function computed<T>(
  fn: (use: Use) => T,
  opts?: { equals?: Equality<T>; label?: string },
): Computed<T> {
  return new Derived(fn, opts);
}

/** Canonical read: committed state plus applied urgent writes; drafts hidden. */
export function read<T>(x: Atom<T> | Computed<T>): T {
  return x.get();
}

/** Update an atom through a function that replays against each world's base. */
export function update<T>(x: Atom<T>, fn: (prev: T) => T): void {
  x.update(fn);
}

/** Dropped handles must never leak: disposers are FinalizationRegistry-backed,
 * so an effect whose disposer is garbage-collected without being called is
 * disposed by the engine. */
const reclaimer = new FinalizationRegistry<{ dispose(): void }>((node) => node.dispose());

/**
 * Run `fn` now and re-run it when its canonical dependencies change. Effects
 * observe canonical state only — never speculative transition drafts. The
 * returned disposer stops it; a dropped disposer is reclaimed automatically.
 */
export function effect(fn: () => void | (() => void), label?: string): () => void {
  const node = createEffect(fn, label);
  const dispose = () => {
    reclaimer.unregister(dispose);
    node.dispose();
  };
  reclaimer.register(dispose, node, dispose);
  return dispose;
}

/**
 * Collect every effect created while `fn` runs (and transitively, effects
 * they create) into one scope; the returned disposer tears them all down.
 */
export function effectScope(fn: () => void, label?: string): () => void {
  void label;
  const scope = new EffectScope();
  scope.run(fn);
  const dispose = () => {
    reclaimer.unregister(dispose);
    scope.dispose();
  };
  reclaimer.register(dispose, scope, dispose);
  return dispose;
}

/** Read without registering a dependency. */
export function peek<T>(x: Atom<T> | Computed<T>): T {
  return untracked(() => x.get());
}

export { EffectNode };
