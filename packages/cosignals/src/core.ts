/**
 * cosignals/core provides signals without loading the React bindings.
 *
 * Create signals, derive values, react to changes, and batch writes
 * through this entry point. Import from `cosignals` instead when the
 * same module also needs React hooks or the React provider.
 *
 * Related entry points:
 * - `cosignals` combines this API with the React bindings.
 * - `cosignals/react` provides the React bindings on their own.
 * - `cosignals/ssr` serializes and restores atom state across the
 *   server and client.
 * - `cosignals/debug` provides tracing and inspection for developer
 *   tools.
 * - `cosignals/unstable` exposes engine integration APIs with no
 *   compatibility promise.
 * - `cosignals/testing` resets engine state between tests.
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
