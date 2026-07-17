# cosignals-devtools

> Historical naming: `signals-royale-fx2` is now named `cosignals`.

Devtools for cosignals: a dependency-graph explorer and a causal
event log. One panel, two hosts (inline in-page, or a Chrome DevTools panel).

## Layers

- `src/protocol.ts` — normalized, library-agnostic wire types + `kindClass`.
  Modeled on the causal event shape, not any one library's vocabulary.
- `src/collector.ts` — the in-page core: ring of events, reduced per-node
  state, and the `Backend` query surface. Plain JS, holds only numbers and
  strings, so it never leaks or feeds back into the graph it observes.
- `src/cosignals.ts` — the cosignals adapter. Plugs `cosignals/debug` (the trace
  hook + inert `inspect`) into a collector; node handles held via `WeakRef` +
  `FinalizationRegistry`.
- `src/panel/` — the React UI (base16 theme, Log + Graph + inspector). State
  via `useSyncExternalStore` over the `Backend`; no signals used internally.
  The panel's data logic lives in `viewmodel.ts` (framework-free, tested).
- `src/extension/` — the Chrome MV3 bridge: the page pushes bounded snapshots,
  the panel serves its sync `Backend` from the latest (`SnapshotBackend`).

## Inline use

```ts
import { attachCosignalsDevtools } from 'cosignals-devtools/cosignals'
import { mountDevtools } from 'cosignals-devtools/panel'

const { collector } = attachCosignalsDevtools()
mountDevtools(document.getElementById('devtools')!, collector)
```

## Chrome extension

```
pnpm build:extension     # bundles src/extension/* → extension/*.js
```

Then load `extension/` as an unpacked extension (chrome://extensions →
Developer mode → Load unpacked). Open DevTools on a page running cosignals; the
**Signals** panel appears. (Loading in Chrome is the one step not covered by
the test suite — the bridge's data path is verified in `tests/extension.spec.ts`.)

## Tests

`pnpm test` — the cosignals-to-collector pipeline, the panel view-model, a live inline
render (jsdom), and the extension snapshot round-trip.
