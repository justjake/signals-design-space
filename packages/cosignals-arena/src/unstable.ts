/**
 * cosignals-arena/unstable — the integration surface below the public
 * API.
 *
 * These exports let host bindings (like `cosignals-arena/react`) and
 * tooling reach the engine: resolve handles to nodes, probe pendingness
 * without evaluating, install write guards, and read resolved-state
 * views directly. None of it is needed to build an application.
 *
 * No compatibility promise: anything here may change or disappear in any
 * release. Pin an exact version if you depend on this entry.
 */
export {
  BASE_WORLD,
  Flag,
  isPendingPassive,
  isUninitialized,
  nodeOf,
  setRenderWorldProvider,
  setRenderWriteGuard,
  SIGNAL_BRAND,
  type Draft,
  type DraftId,
  type Flags,
  type ReactiveNode,
  type ResolvedState,
  type Suspension,
  type World,
} from "./signals.ts"
