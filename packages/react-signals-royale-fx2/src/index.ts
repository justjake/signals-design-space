/**
 * react-signals-royale-fx2 — React bindings for the signals-royale-fx2
 * engine, built on the premise that React's own update queues are the
 * source of truth for which speculative state a render pass may see.
 *
 * Requires a React build with the fx2 external-state protocol (an 11-line
 * patch: the DOM mutation window hook plus a handshake marker). Everything
 * else — transition worlds, rebase, per-root committed views, suspense
 * behavior — runs on stock React semantics.
 */
export {
  registerReactSignals,
  resetReactSignalsForTest,
  onDomMutation,
  type ReactSignalsHandle,
} from './host.ts';
export { SignalScope, wrapCreateRoot, WorldContext, ContainerContext } from './scope.tsx';
export {
  useValue,
  useComputed,
  useSignalEffect,
  useIsPending,
  useCommitted,
  useAtom,
} from './hooks.ts';
export { startTransitionWrite, useSignalTransition } from './transitions.ts';
