# react-signals-playground

One React app, three concurrent-signals implementations. Every component imports its whole reactive surface — signals, hooks, transitions — from the single specifier `#concurrent-signals-shim`, and the page path decides which implementation that specifier resolves to. The app never names an implementation, so the same tree exercises each engine unchanged.

| path | implementation |
| --- | --- |
| `/` | `cosignals` + `cosignals-react` |
| `/alt-a/` | `cosignals-alt-a` (`cosignals-alt-a/react` bindings) |
| `/alt-b/` | `cosignals-alt-b` (`cosignals-alt-b/react` bindings) |

## How the shim resolves

- `package.json` `"imports"` maps `#concurrent-signals-shim` → `src/shims/index.ts` (Vite and TypeScript both resolve subpath imports natively).
- `src/shims/index.ts` picks a loader by the first path segment and binds it with a top-level-await dynamic import; every importer of the specifier waits on that await, so app code always sees a fully bound implementation.
- Each implementation adapts to one common typed surface (`src/shims/interface.ts`: `name`, `register`, `createAtom`, `createComputed`, `useSignal`, `useComputed`, `useSignalEffect`, `startSignalTransition`) in its own file: `src/shims/cosignals.ts`, `alt-a.ts`, `alt-b.ts`.

Runtime selection was chosen over per-entry "select the implementation before the shim initializes" side-effect modules for one reason: isolation. These engines are module singletons that claim exclusive React protocol registrations (one batch-id allocator per page), so the non-selected implementations must never initialize. A selector that re-exports synchronously would need static imports of all implementations — initializing every engine on every page — so preserving isolation forces a dynamic import somewhere; doing it in the selector needs no per-entry files and no reliance on import evaluation order. Vite code-splits each implementation into its own chunk, and only the selected chunk ever loads (verify in devtools: one `shims/*` chunk per page).

## Adding implementation #4

- Write `src/shims/<name>.ts` exporting the `ConcurrentSignalsShim` surface (the loader map typechecks it).
- Add one loader line to `implByPathSegment` in `src/shims/index.ts`.
- Copy `index.html` to `<name>/index.html` and add it to `build.rollupOptions.input` in `vite.config.ts`.

## Notes

- `react`/`react-dom` are declared `*` like every package in this workspace: the root `pnpm.overrides` pins them to `link:vendor/react/build/oss-experimental/*`, the patched build whose external-runtime protocol all three bridges require (`register()` throws on stock React). A registry version pin would never be consulted.
- The patched build is CJS behind a `link:` dependency, which Vite would serve as-is in dev; `optimizeDeps.include` forces it through the prebundler (see `vite.config.ts`).
- `pnpm dev` / `pnpm build` / `pnpm preview` / `pnpm check` from this directory.
