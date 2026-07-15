# signals-devtools

Devtools for signals-royale-fx2: a dependency-graph explorer and a causal
event log. One panel, two hosts (inline in-page, or a Chrome DevTools panel).

## Layers

- `src/protocol.ts` — normalized, library-agnostic wire types + `kindClass`.
  Modeled on the causal event shape, not any one library's vocabulary.
- `src/collector.ts` — the in-page core: ring of events, reduced per-node
  state, and the `Backend` query surface. Plain JS, holds only numbers and
  strings, so it never leaks or feeds back into the graph it observes.
- `src/fx2.ts` — the fx2 adapter. Plugs `signals-royale-fx2/debug` (the trace
  hook + inert `inspect`) into a collector; node handles held via `WeakRef` +
  `FinalizationRegistry`.
- `src/panel/` — the React UI (base16 theme, Log + Graph + inspector). State
  via `useSyncExternalStore` over the `Backend`; no signals used internally.
  The panel's data logic lives in `viewmodel.ts` (framework-free, tested).
- `src/extension/` — the Chrome MV3 bridge: the page pushes bounded snapshots,
  the panel serves its sync `Backend` from the latest (`SnapshotBackend`).

## Inline use

```ts
import { attachFx2Devtools } from 'signals-devtools/fx2'
import { mountDevtools } from 'signals-devtools/panel'

const { collector } = attachFx2Devtools() // hooks the active fx2 engine
mountDevtools(document.getElementById('devtools')!, collector)
```

## Chrome extension

```
pnpm build:extension     # bundles src/extension/* → extension/*.js
```

Then load `extension/` as an unpacked extension (chrome://extensions →
Developer mode → Load unpacked). Open DevTools on a page running fx2; the
**Signals** panel appears. (Loading in Chrome is the one step not covered by
the test suite — the bridge's data path is verified in `tests/extension.spec.ts`.)

## Tests

`pnpm test` — the fx2→collector pipeline, the panel view-model, a live inline
render (jsdom), and the extension snapshot round-trip.
