# react-signals-playground

One React app, four concurrent-signals implementations. Every component imports its whole reactive surface — signals, hooks, transitions — from the single specifier `#concurrent-signals-shim`, and the page path decides which implementation that specifier resolves to. The app never names an implementation, so the same tree exercises each engine unchanged.

| path | implementation |
| --- | --- |
| `/` | `cosignals` + `cosignals-react` |
| `/alt-a/` | `cosignals-alt-a` (`cosignals-alt-a/react` bindings) |
| `/alt-b/` | `cosignals-alt-b` (`cosignals-alt-b/react` bindings) |
| `/solid-react/` | `concurrent-solid-react` (Solid 2.0 core hosted in React) |

## How the shim resolves

- `package.json` `"imports"` maps `#concurrent-signals-shim` → `src/shims/index.ts` (Vite and TypeScript both resolve subpath imports natively).
- `src/shims/implementations.ts` is the one table of implementations: URL segment, tab label, shim name, and a typed loader per row. The selector resolves the page's implementation from it, and the app's tab bar renders one tab per row, so the loader and the navigation can never disagree.
- `src/shims/index.ts` picks the row matching the first path segment and binds it with a top-level-await dynamic import; every importer of the specifier waits on that await, so app code always sees a fully bound implementation.
- Each implementation adapts to one common typed surface (`src/shims/interface.ts`: `name`, `register`, `createAtom`, `createComputed`, `useSignal`, `useComputed`, `useSignalEffect`, `startSignalTransition`, `transitionHoldStyle`) in its own file: `src/shims/cosignals.ts`, `alt-a.ts`, `alt-b.ts`, `solid-react.ts`.

Runtime selection was chosen over per-entry "select the implementation before the shim initializes" side-effect modules for one reason: isolation. These engines are module singletons that claim exclusive React protocol registrations (one batch-id allocator per page), so the non-selected implementations must never initialize. A selector that re-exports synchronously would need static imports of all implementations — initializing every engine on every page — so preserving isolation forces a dynamic import somewhere; doing it in the selector needs no per-entry files and no reliance on import evaluation order. Vite code-splits each implementation into its own chunk, and only the selected chunk ever loads (verify in devtools: one `shims/*` chunk per page). The same isolation is why the implementation tabs are plain `<a href>` full-page navigations: each entry is its own module graph, and a client-side switch cannot swap engines.

## The app

A transitions lab shaped like a tiny browser, shared verbatim by every entry. Every inner navigation runs inside `startSignalTransition` and suspends on a keyed fake-fetch resource until the destination's data arrives, so the transition's pending window is exactly as long as the lab wants it to be:

- The mini-browser: back/forward over an inner history stack, a virtual address bar that shows the target route with a loading shimmer while the navigation is pending, bookmarks for the three pages (dashboard / table / detail), and a page area that keeps the previous view — dimmed — until the new one commits.
- The lab panel: a navigation-latency knob (instant / 250 ms / 1 s / 3 s / hold) controlling when each navigation's data resolves — "hold" parks it until the RELEASE button — and a separate row-work knob for sync render weight (hash rounds per derived table row).
- An urgent controls strip — counter, evens toggle, live table filter, add/remove rows — plus a pausable 10 s clock tile; all must keep committing while a navigation is held open. The browser battery speeds the clock up to 100 ms in test mode so it remains a practical liveness probe.
- A transition timeline: the live navigation grows a bar in real time, urgent commits that land inside the pending window drop amber ticks onto it, and the last five navigations keep their duration + interleave count.
- A HUD of stat tiles: implementation name, committed route, transition pending, last navigation duration, committed-render tally, and a consistency verdict that compares independently subscribed signal reads within one render (`TORN` means a committed frame mixed two write generations).
- A red error strip (≤5 lines) for page errors and torn commits; empty means healthy.

### How the hold works, per implementation

The preferred holding mechanism is Suspense: the destination throws its resource's promise while pending, which keeps React's transition open exactly the way a data-fetching router would. Each shim declares whether that is safe via `transitionHoldStyle`:

- `cosignals`, `cosignals-alt-a` — `'suspense'`: the transition stays pending, urgent updates keep committing throughout.
- `cosignals-alt-b` — `'suspense'`: the hold works, but a known engine issue is kept visible on purpose: while a transition is held, an urgent write that changes a derived value's output (the table filter, add/remove rows) locks the page in an update loop. Writes whose deriveds come out equal (the counter, the evens toggle) are unaffected.
- `concurrent-solid-react` — `'defer-write'`: originally a foreign thrown promise froze all commits (urgent ones included) until it resolved, then React recovered with a synchronous root render. The battery's 2026-07-08 retest (`FIND-THENABLE.gate`) shows thrown promises now hold cleanly on current engine sources, but defer-write stays for the navigation flow: this bridge's own Suspense story is its async-memo machinery, and the app-derived pending window behaves identically either way.
- `concurrent-solid-react` also currently runs with memos degraded to unmemoized tracked reads (see `src/shims/solid-react.ts` for the mechanism and repro): as of the engine sources current on 2026-07-08, one urgent signal write with any memo-subscribed component — outside a live transition — parks the bridge's shared render-probe node in the engine's dirty heap with cleared flags, and the flush loop spins forever. The package's own tests pass; the trigger needs the write to land with no transition open.

## The verification battery

`battery/` is a Playwright battery that drives this app in bundled Chromium against all four implementations and asserts the React compliance contract's browser-observable clauses, ported source-suite scenarios (including all 10 daishi-benchmark levels), and pinned findings. A fifth entry, `/control/`, is a vanilla-React page (no signals engine) the battery uses as the host baseline: when all four implementations behave identically, the same schedule runs there to attribute the behavior to React or to the engines. See `battery/README.md` to run it, `battery/MANIFEST.md` for the scenario contract, and `battery/TESTIDS.md` for the instrumentation contract (`?test=1` enables `src/testkit.tsx`).

## Adding implementation #5

- Write `src/shims/<name>.ts` exporting the `ConcurrentSignalsShim` surface.
- Add one row to `src/shims/implementations.ts` (the loader typechecks the shim; the tab bar follows the table).
- Copy `index.html` to `<name>/index.html`, add it to `build.rollupOptions.input`, and add `/<name>` to the `redirectDirEntries` list in `vite.config.ts`.

## Notes

- `react`/`react-dom` are declared `*` like every package in this workspace: the root `pnpm.overrides` pins them to `link:vendor/react/build/oss-experimental/*`, the patched build whose external-runtime protocol all four bridges require (`register()` throws on stock React). A registry version pin would never be consulted.
- The patched build is CJS behind a `link:` dependency, which Vite would serve as-is in dev; `optimizeDeps.include` forces it through the prebundler (see `vite.config.ts`).
- `concurrent-solid-react` ships TypeScript source that reads the `__DEV__` compile-time constant; `vite.config.ts` defines it (dev diagnostics on for `pnpm dev`, off for builds) and the playground `tsconfig.json` includes that package's `globals.d.ts` so `tsc` sees the declaration.
- `pnpm dev` / `pnpm build` / `pnpm preview` / `pnpm check` from this directory.
