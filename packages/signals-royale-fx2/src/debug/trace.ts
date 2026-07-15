/**
 * `signals-royale-fx2/debug/trace` — the tracer surface and the canonical
 * trace vocabulary.
 *
 * This module is the ONE source of kind strings. The engine emits these
 * verbatim and the devtools shows them verbatim: there is no runtime mapping
 * table anywhere. Renaming a concept means renaming its string here and at
 * its emit site — never adding a translation layer.
 *
 * Contract only — signatures and types. The Tracer/attachTracer implementation
 * already lives in ../tracer.ts and the emit seam in ../graph.ts; this file
 * re-exports them and adds the vocabulary the devtools builds against.
 */

// The tracer and the raw emit seam already exist; the debug entry re-exports
// them so consumers import only `signals-royale-fx2/debug`, never core.
export { Tracer, attachTracer, getActiveTracer } from '../tracer.ts'
export type { TraceEvent, TracerOptions } from '../tracer.ts'
export { setTraceHook, NO_EVENT } from '../graph.ts'
export type { TraceFn, TraceFields, TraceEventId } from '../graph.ts'

/**
 * The canonical trace vocabulary: every string fx2 actually emits today,
 * verbatim. The devtools' kind chips and filters are typed against this union
 * and show these strings as-is — there is no runtime mapping.
 *
 * A usability rename pass is pending design sign-off (candidates:
 * `write`→`set`/`update`, `effect-run`→`effect`, `deliver`→`notify`,
 * `render-value`→`render`, `provider-world-commit`→`commit`). When it lands,
 * the string changes here AND at the emit site together — never a translation
 * layer. Until then this reflects reality so nothing lies.
 */
export type TraceKind =
	// Atom write (graph.ts / worlds.ts draft path).
	| 'write'
	// Computed lifecycle. `compute` fires just before node.fn() runs, only on
	// real evaluation (never a cache hit); -error/-suspend when it throws or
	// parks on a thenable.
	| 'compute'
	| 'compute-error'
	| 'compute-suspend'
	// Effects (graph.ts).
	| 'effect-run'
	| 'effect-error'
	// Async resolution (asyncs.ts).
	| 'settle'
	| 'retry-ready'
	// World/draft — the speculative worlds behind React transitions
	// (worlds.ts / react host).
	| 'draft-open'
	| 'draft-discard'
	| 'draft-wake'
	// React binding (react/hooks.ts, react/host.ts).
	| 'deliver' // delivery to a component subscription (a re-render is scheduled)
	| 'render-value' // a render produced a committed value
	| 'render-suspend' // a render parked on a thenable
	| 'render-error' // a render threw
	| 'provider-world-commit' // a transition's world committed
	| 'scheduler-fallback' // scheduler degraded to a fallback path
	// Errors carrying a `phase` in TraceFields.
	| 'callback-error'
	| 'cleanup-error'
	| 'flush-error'
	| 'policy-error'

/**
 * Coarse class for coloring and filtering in the UI — the ONLY place the
 * panel reduces the vocabulary. Maps who-acted, not a rename. Unknown strings
 * (a future kind the panel hasn't seen) resolve to `'system'` so the log
 * still renders.
 */
export type TraceKindClass =
	| 'origin' // user input (a DOM event captured as the operation root)
	| 'write' // set / update
	| 'compute' // computed re-evaluation
	| 'notify' // watcher delivery
	| 'render' // render / commit
	| 'effect' // effect runs
	| 'batch' // batch / draft lifecycle
	| 'async' // settle / retry / suspend
	| 'error' // *-error
	| 'system' // anything else

/** Classify a kind for the UI. Pure; no mapping of the kind itself — just a
 * coarse bucket for color/filter. Unknown kinds fall through to 'system' so
 * the log still renders a future kind the panel hasn't seen. */
export function kindClass(kind: TraceKind | string): TraceKindClass {
	switch (kind) {
		case 'dom-event':
			return 'origin' // synthetic root the collector adds from window.event
		case 'write':
			return 'write'
		case 'compute':
			return 'compute'
		case 'deliver':
			return 'notify'
		case 'render-value':
		case 'render-suspend':
		case 'provider-world-commit':
			return 'render'
		case 'effect-run':
			return 'effect'
		case 'draft-open':
		case 'draft-discard':
		case 'draft-wake':
			return 'batch'
		case 'settle':
		case 'retry-ready':
		case 'compute-suspend':
			return 'async'
		case 'compute-error':
		case 'effect-error':
		case 'render-error':
		case 'callback-error':
		case 'cleanup-error':
		case 'flush-error':
		case 'policy-error':
			return 'error'
		case 'scheduler-fallback':
			return 'system'
		default:
			return 'system'
	}
}
