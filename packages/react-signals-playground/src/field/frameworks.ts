/**
 * The library roster for the stress field and the in-page benchmarks:
 * one row per reactivity library, with a lazy loader for its
 * benchmark-shape adapter (the reactivity-benchmark submodule's own
 * adapter files — the code its CI runs).
 *
 * Loaders are dynamic imports on purpose:
 * - the page realm stays clean — an engine page never evaluates another
 *   library until the user actually selects it;
 * - each adapter (and its library) becomes its own code-split chunk, so
 *   the initial page load carries none of them.
 *
 * cosignals-arena routes to a local core-only adapter: the submodule's
 * imports the package root, whose React bindings register on import (see
 * cosignals-arena-core-adapter.ts).
 */
import type { ReactiveFramework } from "../../../../milomg-reactivity-benchmark/packages/core/src/util/reactiveFramework"

export interface LibraryEntry {
  /** Stable key: selection state, worker messages, and chart colors key on it. */
  readonly key: string
  /** Display name in the selector and chart. */
  readonly label: string
  /** Checked by default in the benchmark checklist. */
  readonly benchDefault?: boolean
  /** Shown as a badge; the library works but stalls (slow build or teardown). */
  readonly slow?: string
  /**
   * Highest stress-field resolution this library can hold, as a pixel count
   * (width × height). Undefined means no limit. cosignals-arena preallocates
   * fixed typed-array storage (about 2.1 million records), and the field
   * costs roughly 7 records per pixel, so tiers above 320p exhaust it.
   */
  readonly fieldMaxPixels?: number
  readonly load: () => Promise<ReactiveFramework<any>>
}

export const LIBRARIES: readonly LibraryEntry[] = [
  {
    key: "cosignals",
    label: "cosignals",
    benchDefault: true,
    load: () =>
      import(
        "../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/cosignals"
      ).then((m) => m.cosignalsFramework),
  },
  {
    key: "cosignals-arena",
    label: "cosignals-arena",
    benchDefault: true,
    // ~2.1M records / ~7 records per pixel: 320p (181,760 px) fits,
    // 480p (409,920 px) exhausts the arena.
    fieldMaxPixels: 300_000,
    load: () => import("./cosignals-arena-core-adapter").then((m) => m.cosignalsArenaCoreFramework),
  },
  {
    key: "alien-signals",
    label: "alien-signals",
    benchDefault: true,
    load: () =>
      import(
        "../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/alienSignals"
      ).then((m) => m.alienFramework),
  },
  {
    key: "dalien-signals",
    label: "dalien-signals",
    benchDefault: true,
    load: () =>
      import(
        "../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/dalienSignals"
      ).then((m) => m.dalienFramework),
  },
  {
    key: "dalien-malloc-free",
    label: "dalien malloc/free",
    load: () =>
      import(
        "../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/dalienMallocFree"
      ).then((m) => m.dalienMallocFreeFramework),
  },
  {
    key: "solidjs-signals",
    label: "@solidjs/signals (solid 2)",
    benchDefault: true,
    load: () =>
      import(
        "../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/xReactivity"
      ).then((m) => m.xReactivityFramework),
  },
  {
    key: "preact",
    label: "@preact/signals",
    load: () =>
      import(
        "../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/preactSignals"
      ).then((m) => m.preactSignalFramework),
  },
  {
    key: "reactively",
    label: "@reactively/core",
    load: () =>
      import(
        "../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/reactively"
      ).then((m) => m.reactivelyFramework),
  },
  {
    key: "solid",
    label: "solid-js 1.x",
    load: () =>
      import("../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/solid").then(
        (m) => m.solidFramework,
      ),
  },
  {
    key: "angular",
    label: "angular signals",
    load: () =>
      import(
        "../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/angularSignals2"
      ).then((m) => m.angularFramework),
  },
  {
    key: "svelte",
    label: "svelte 5 runes",
    slow: "slow unmount",
    load: () =>
      import("../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/svelte").then(
        (m) => m.svelteFramework,
      ),
  },
  {
    key: "tansu",
    label: "tansu",
    slow: "slow",
    load: () =>
      import("../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/tansu").then(
        (m) => m.tansuFramework,
      ),
  },
  {
    key: "tanstack-store",
    label: "tanstack store",
    load: () =>
      import(
        "../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/tanstackStore"
      ).then((m) => m.tanstackStoreFramework),
  },
  {
    key: "pota",
    label: "pota",
    load: () =>
      import("../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/pota").then(
        (m) => m.potaFramework,
      ),
  },
  {
    key: "tldraw-state",
    label: "tldraw state",
    load: () =>
      import(
        "../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/tldrawState"
      ).then((m) => m.tldrawStateFramework),
  },
]

export function libraryByKey(key: string): LibraryEntry {
  const entry = LIBRARIES.find((lib) => lib.key === key)
  if (entry === undefined) {
    throw new Error(`unknown library key "${key}"`)
  }
  return entry
}
