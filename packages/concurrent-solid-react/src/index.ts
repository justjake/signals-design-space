/**
 * concurrent-solid-react — concurrent React signals as a minimum evolution of
 * Solid 2.0's reactive core.
 *
 * The engine is the vendored solid-signals core (src/solid/), edited only at
 * the seams React hosting requires; every edit is tagged `[react-adapt E#]`
 * in the source. The React layer (bridge + hooks) maps the fork protocol's
 * batch tokens onto Solid transitions and Solid's NotReadyError onto stable
 * node-held Suspense thenables. See README.md for the design.
 */

// Engine API (Solid 2.0 surface, minus stores/boundaries/action)
export {
  createSignal,
  createMemo,
  createEffect,
  createRenderEffect,
  createTrackedEffect,
  createReaction,
  createOptimistic,
  resolve,
  onSettled,
  onCleanup
} from "./solid/signals.js";
export type {
  Accessor,
  SourceAccessor,
  Setter,
  Signal,
  ComputeFunction,
  EffectFunction,
  EffectBundle,
  EffectOptions,
  SignalOptions,
  MemoOptions
} from "./solid/signals.js";
export {
  NotReadyError,
  createRoot,
  runWithOwner,
  getOwner,
  getObserver,
  untrack,
  isPending,
  latest,
  refresh,
  flush,
  createContext,
  getContext,
  setContext
} from "./solid/index.js";
export type { Owner, Refreshable } from "./solid/index.js";

// React bridge + hooks
export {
  registerConcurrentSolidReact,
  useSelector,
  useSignal,
  useIsPending,
  useLatest,
  useComputed,
  useSignalState,
  useSignalEffect,
  useSignalTransition
} from "./hooks.js";
export { assertForkPresent, type BridgeHandle, type ForkReact } from "./bridge.js";
