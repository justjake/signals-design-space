/**
 * '#engine' — the selector this package.json "imports" entry resolves to.
 * One engine per page, chosen by the first path segment, loaded with a
 * top-level-await dynamic import, then re-exported unwrapped: app code
 * uses the real cosignals API surface, never an adapter.
 *
 * Why runtime selection instead of a per-entry "select before app code
 * runs" side-effect module: the engines are module singletons that claim
 * exclusive React protocol registrations (exactly one batch-id allocator
 * per page), so the engine that was NOT selected must never initialize. A
 * selector that re-exports synchronously would need static imports of
 * both engines — initializing both on every page. Keeping isolation
 * therefore forces a dynamic import somewhere, and doing it here keeps it
 * in exactly one place: each engine becomes its own code-split chunk,
 * only the selected chunk ever loads (dev and production alike), and no
 * import-evaluation-order contract exists to silently break.
 *
 * Every module importing this specifier waits on the top-level await, so
 * by the time any app code runs, the page's engine is bound and its React
 * bindings are registered (registration happens when the engine module
 * evaluates). react-dom/client is imported first so the renderer exists
 * before any engine registers against it.
 */
import "react-dom/client"
import { implementations, type EngineModule } from "./implementations"

// First path segment under the deploy base: '/cosignals/' → 'cosignals',
// and '/my-repo/cosignals/' → 'cosignals' when built with --base=/my-repo/.
// The bare root never reaches this module — it serves only the redirect stub.
const base = import.meta.env.BASE_URL
const pathname = window.location.pathname
const path = pathname.startsWith(base) ? pathname.slice(base.length) : pathname
const segment = path.split("/").find((part) => part !== "") ?? ""
const entry = implementations.find((impl) => impl.segment === segment)
if (entry === undefined) {
  throw new Error(`react-signals-playground: no engine mapped for path segment "/${segment}"`)
}

const impl: EngineModule = await entry.load()

export const {
  name,
  // core
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
  // react
  CosignalsProvider,
  useSignal,
  useComputed,
  useSignalEffect,
  useSignalLayoutEffect,
  useIsPending,
  useAtom,
  startSignalTransition,
  useSignalTransition,
} = impl

// The implementation table rides along for the app's tab bar: exporting it
// here keeps components on the single '#engine' specifier. Re-exporting
// the table triggers no engine loads — rows hold dynamic-import thunks,
// and only the selected one was invoked above.
export { implementationHref, implementations } from "./implementations"
export type { EngineModule, Implementation } from "./implementations"

// Type-only re-exports are erased at runtime, so naming the cosignals
// package here never initializes it. Arena handles satisfy these types
// through the selector's cast (see implementations.ts).
export type {
  Atom,
  AtomOptions,
  Computed,
  ComputedOptions,
  Signal,
  SignalValue,
  SignalEffectSpec,
  UseFn,
  WatchSource,
} from "cosignals"
