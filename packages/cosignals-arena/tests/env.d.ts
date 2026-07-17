/** Minimal host globals for tests (the engine's own types stay lib-agnostic). */
declare function setTimeout(fn: () => void, ms?: number): unknown
declare function queueMicrotask(fn: () => void): void
declare const gc: (() => void) | undefined
declare const process: { env: Record<string, string | undefined> }
