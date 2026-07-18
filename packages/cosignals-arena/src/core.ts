/**
 * cosignals-arena/core provides signals without loading the React
 * bindings.
 *
 * Create signals, derive values, react to changes, and batch writes
 * through this entry point. Import from `cosignals-arena` instead when
 * the same module also needs React hooks or the React provider.
 *
 * Related entry points:
 * - `cosignals-arena` combines this API with the React bindings.
 * - `cosignals-arena/react` provides the React bindings on their own.
 * - `cosignals-arena/ssr` serializes and restores atom state across the
 *   server and client.
 * - `cosignals-arena/debug` provides tracing and inspection for
 *   developer tools.
 * - `cosignals-arena/unstable` exposes engine integration APIs with no
 *   compatibility promise.
 * - `cosignals-arena/testing` resets engine state between tests.
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
  growCapacity,
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
