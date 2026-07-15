/**
 * `signals-royale-fx2/debug` — the opt-in observability surface.
 *
 * Not part of the main entry: a prod app that doesn't debug never bundles it.
 * More importantly, it's the stable contract between fx2 and the devtools —
 * the devtools imports only from here, so fx2's internals stay free to change.
 *
 * `./trace`   — the tracer + the canonical TraceKind vocabulary.
 * `./inspect` — inert node peeking + Flag unpacking + graph walks.
 */
export * from './trace.ts'
export * from './inspect.ts'
