/**
 * cosignals-arena — signals with first-class React transition support,
 * backed by typed-array graph storage.
 *
 * This entry is the application-facing API: create signals, derive
 * values, react to changes, and batch writes. Everything here is safe to
 * use without knowing how the engine works.
 *
 * Related entry points:
 * - `cosignals-arena/react` — hooks and the provider for React
 *   components;
 * - `cosignals-arena/ssr` — serialize and restore atom state across
 *   server/client;
 * - `cosignals-arena/debug` — the tracing and inspection surface
 *   devtools build on;
 * - `cosignals-arena/unstable` — engine integration seams with no
 *   compatibility promise;
 * - `cosignals-arena/testing` — helpers for resetting engine state
 *   between tests.
 */
export {
  createAtom,
  createComputed,
  createEffect,
  createReducerAtom,
  effectScope,
  isPending,
  isSignal,
  latest,
  shallowEquals,
  batch,
  startBatch,
  endBatch,
  untrack,
  flushScheduledEffects,
  type Atom,
  type AtomOptions,
  type Computed,
  type ComputedOptions,
  type EffectOptions,
  type EffectSchedule,
  type EqualsFn,
  type ReducerAtom,
  type Signal,
  type SignalValue,
  type SignalValues,
  type UseFn,
} from "./signals.ts"
