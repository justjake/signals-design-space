/**
 * `cosignals-arena/debug/trace` — the tracer surface and the canonical
 * trace vocabulary.
 *
 * This module is the single source of kind strings. The engine emits these
 * verbatim and the devtools shows them verbatim: there is no runtime mapping
 * table anywhere. Renaming a concept means renaming its string here and at
 * its emit site — never adding a translation layer.
 *
 * Contract only — signatures and types. The Tracer/attachTracer implementation
 * already lives in ../tracer.ts and the emit seam in ../graph.ts; this file
 * re-exports them and adds the vocabulary the devtools builds against.
 */

// The tracer and the raw emit seam already exist; the debug entry re-exports
// them so consumers import only `cosignals-arena/debug`, never core.
export { Tracer, attachTracer, getActiveTracer } from "../tracer.ts"
export type { TraceEvent, TracerOptions } from "../tracer.ts"
export { setTracer, setHotTracer, NO_EVENT } from "../graph.ts"
export type {
  TraceSink,
  EmitFn,
  EndSpanFn,
  TraceFields,
  SpanEndAttrs,
  TraceEventId,
  HotFn,
  HotStep,
} from "../graph.ts"

/**
 * The canonical trace vocabulary: every string the engine actually emits today,
 * verbatim. The devtools' kind chips and filters are typed against this union
 * and show these strings as-is — there is no runtime mapping.
 */
export type TraceKind =
  // Atom write, by the API verb the caller used (graph.ts / worlds.ts draft
  // path); the intent is threaded from set()/update().
  | "set"
  | "update"
  // Computed lifecycle. Fires just before node.fn() runs, only on real
  // evaluation (never a cache hit): `compute` on the first (the node coming
  // into existence), `recompute` on every later run; -error/-suspend when it
  // throws or parks on a thenable.
  | "compute"
  | "recompute"
  | "compute-error"
  | "compute-suspend"
  // Effects (graph.ts).
  | "effect"
  | "effect-error"
  // Async resolution (asyncs.ts).
  | "settle"
  | "retry"
  // React binding: per-component delivery and render failures (react/hooks.ts).
  | "notify" // a component was told its inputs changed (re-render scheduled)
  | "render-suspend" // a render parked on a thenable
  | "render-error" // a render threw
  // Transitions — the speculative worlds behind React transitions
  // (worlds.ts / react host). notify/commit are the transition-world
  // counterparts of the base-world notify/render.
  | "transition-open" // a transition began
  | "transition-notify" // a component woken to render in the transition
  | "transition-commit" // a root committed the transition's world
  | "transition-retire" // a committed transition folded into base state
  | "transition-discard" // the transition was abandoned
  | "scheduler-fallback" // scheduler degraded to a fallback path
  // Errors carrying a `phase` in TraceFields.
  | "callback-error"
  | "cleanup-error"
  | "flush-error"
  | "policy-error"
  // Hot algorithm channel (graph.ts setHotTracer) — a separately gated,
  // off-by-default, very-high-volume feed of the internal steps.
  | "propagate" // the invalidation wave marked subscribers possibly stale
  | "check" // a dependency-validation walk confirmed or cleared staleness
  | "pull" // a computed/effect computation re-evaluated
