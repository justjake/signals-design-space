/**
 * `signals-royale-fx2-dalien/debug` — the opt-in observability surface.
 *
 * Not part of the main entry: a prod app that doesn't debug never bundles it.
 * More importantly, it's the stable contract between the engine and the
 * devtools — the devtools imports only from here, so the engine's internals
 * stay free to change.
 *
 * `./trace`   — the tracer + the canonical TraceKind vocabulary.
 * `./inspect` — inert node peeking + Flag unpacking + graph walks.
 */
export * from './trace.ts'
export * from './inspect.ts'
