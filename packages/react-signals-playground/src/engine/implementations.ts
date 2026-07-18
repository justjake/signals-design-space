/**
 * The one table of selectable engines. The selector (./index.ts) resolves
 * the page's engine from it, and the app's tab bar renders one tab per
 * row — adding an engine here updates both at once, so the loader and the
 * navigation can never disagree about what exists.
 */
import { DEFAULT_SEGMENT } from "./default-segment"

/**
 * The module surface both engine pages present: the cosignals public API
 * (core signals plus React bindings) and a display name. cosignals-arena
 * exports the identical surface by design — its public modules differ
 * from cosignals' only in doc comments.
 */
export type EngineModule = typeof import("./cosignals")

export interface Implementation {
  /** First URL path segment that selects this engine; '' is the root entry. */
  readonly segment: string
  /** Short tab text. */
  readonly label: string
  /** The engine module's exported `name` — the tab bar marks the active tab by comparing against it. */
  readonly name: string
  /** Typed loader: the import() namespace is checked against EngineModule here. */
  readonly load: () => Promise<EngineModule>
}

export const implementations: readonly Implementation[] = [
  {
    segment: "cosignals",
    label: "cosignals",
    name: "cosignals",
    load: () => import("./cosignals"),
  },
  {
    segment: "cosignals-arena",
    label: "cosignals-arena",
    name: "cosignals-arena",
    // The arena package's API is identical to cosignals'; TypeScript still
    // sees two distinct namespaces because each package brands its signal
    // handles with its own `unique symbol` (both are Symbol.for registry
    // symbols with different keys). This cast is the one place that
    // nominal difference is bridged.
    load: () => import("./cosignals-arena") as unknown as Promise<EngineModule>,
  },
]

const defaultRow = implementations.find((impl) => impl.segment === DEFAULT_SEGMENT)
if (defaultRow === undefined) {
  throw new Error(
    `react-signals-playground: DEFAULT_SEGMENT "${DEFAULT_SEGMENT}" has no implementation row`,
  )
}
/**
 * The engine `/` redirects to (named in ./default-segment.ts; kept first
 * in the table so it also leads the tab bar). Every engine lives under
 * its own named path; the bare root only forwards here — a server
 * redirect in dev/preview, the root index.html stub on static hosts.
 */
export const defaultImplementation: Implementation = defaultRow

// Vite injects import.meta.env; the battery's Playwright config imports
// this module under Node, where it is absent and the dev-server base ("/")
// is the right answer.
const base: string =
  typeof import.meta.env === "undefined" ? "/" : (import.meta.env.BASE_URL ?? "/")

/**
 * The entry URL for an engine: the deploy base (always "/" in dev and
 * preview; the repo subpath on GitHub Pages builds) plus the segment
 * directory, served with a trailing slash.
 */
export function implementationHref(impl: Implementation): string {
  return `${base}${impl.segment}/`
}
