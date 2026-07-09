/**
 * react-signals-royale-fx1 — React bindings for the signals-royale-fx1
 * engine, on a React build that carries the fx1 signal-scheduler protocol.
 *
 * Call `register()` once after react-dom loads, then use the hooks. The
 * engine classifies writes by the transition scope that issues them: writes
 * inside `startTransitionWrite` (or any React transition) stay invisible to
 * the committed DOM until React commits that batch, while urgent writes
 * commit immediately and pending transitions rebase on top.
 */
export {
  register,
  resetForTest,
  startTransitionWrite,
  onDomMutation,
  currentEpisode,
  deliver,
  currentRenderFrame,
  type RuntimeHandle,
  type HostSub,
  type TransitionToken,
  type LaneBits,
} from "./runtime";
export {
  useValue,
  useComputed,
  useAtom,
  useSignalEffect,
  useIsPending,
  useCommitted,
  useTransitionWrite,
} from "./hooks";
