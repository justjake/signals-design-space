# react-signals-playground

The explainer and test site for `cosignals` and `cosignals-arena`. Both pages
render the same React app against a different signal engine.

| Path | Engine |
| --- | --- |
| `/cosignals/` | `cosignals` |
| `/cosignals-arena/` | `cosignals-arena` |
| `/control/` | React-only test control |

The root path redirects to `/cosignals/`.

## What the site contains

- A short introduction to signals and the active engine.
- A transitions lab with controllable Suspense latency and render work.
- A canvas stress test that runs the same graph on several signal libraries.
- In-page runs of the `js-reactivity-benchmark` suites.
- The cosignals devtools.

## Engine selection

Application code imports signals and React bindings from `#engine`.
`src/engine/index.ts` selects an engine from the first URL path segment and
loads it with a dynamic import. Vite puts each engine in a separate chunk, so
the other engine never initializes on that page.

`src/engine/implementations.ts` contains the URL segment, tab label, and loader
for each engine. The tab bar reads the same table. Switching tabs performs a
full-page navigation because React protocol registration is process-wide.

## Tests

The Playwright battery in `battery/` runs the same scenarios against both
engines. `/control/` runs host-level checks against React without a signal
engine. See:

- [`battery/README.md`](./battery/README.md) for commands and test groups.
- [`battery/MANIFEST.md`](./battery/MANIFEST.md) for scenario coverage.
- [`battery/TESTIDS.md`](./battery/TESTIDS.md) for the test instrumentation.

`devtools-e2e/` covers the embedded devtools.

## Commands

```sh
pnpm dev
pnpm build
pnpm preview
pnpm check
pnpm battery
pnpm devtools-e2e
```
