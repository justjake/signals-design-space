/**
 * The benchmark submodule's solid adapter imports solid's CJS build by
 * file path; solid-js is not a dependency of this package, so its real
 * types are out of reach here. Declare just the members the adapter uses,
 * with the signatures solid-js documents for them.
 */
declare module "solid-js/dist/solid.cjs" {
  export function createSignal<T>(value: T): [() => T, (v: T) => void]
  export function createMemo<T>(fn: () => T): () => T
  export function createEffect(fn: () => void): void
  export function createRoot<T>(fn: (dispose: () => void) => T): T
  export function batch<T>(fn: () => T): T
}
