# cosignals

`cosignals` is a signals library built for React concurrent rendering. A signal
write inside `React.startTransition` remains transition work: the current screen
keeps its committed values while the background render sees one coherent draft.
Urgent writes can commit in the meantime without tearing or losing functional
updates.

The React integration runs on stock React and supports React 18.2 and later. It
does depend on React internals, so React upgrades are compatibility events rather
than routine dependency bumps.

This repository contains the publishable packages, browser and benchmark
verification, and the research record that produced the current design.

## Packages

| Package                                        | Purpose                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cosignals`](packages/cosignals/)             | The main implementation. It includes the React-free graph, React bindings, async values, SSR state transfer, tracing, and testing APIs.         |
| [`cosignals-arena`](packages/cosignals-arena/) | The same public API and concurrent behavior with nodes and links stored in typed-array records. It is retained as the data-oriented comparison. |
| [`cosignals-devtools`](packages/devtools/)     | A dependency-graph explorer and causal event log for both engines, available inline or as a Chrome DevTools panel.                              |

The core entry points are React-free and dependency-free. React support lives at
`cosignals/react` and `cosignals-arena/react`, with `react` and `react-dom` as
peer dependencies.

## Example

```tsx
import { createAtom, createComputed } from "cosignals"
import { CosignalsProvider, useSignal } from "cosignals/react"

const count = createAtom(0)
const doubled = createComputed(() => count.get() * 2)

function Counter() {
  const value = useSignal(count)
  const double = useSignal(doubled)

  return (
    <button onClick={() => count.update((n) => n + 1)}>
      {value} × 2 = {double}
    </button>
  )
}

function App() {
  return (
    <CosignalsProvider>
      <Counter />
    </CosignalsProvider>
  )
}
```

Install the main package with your package manager:

```sh
pnpm add cosignals
```

See [`packages/cosignals/README.md`](packages/cosignals/README.md) for the full
API, including effects, transitions, async computeds, pending state, SSR, and
multiple roots.

## How concurrent writes work

An urgent write updates committed state immediately. A write inside a React
transition records an ordered intent in that transition's draft instead.

- The current screen and urgent renders do not see the draft.
- The transition's renders replay their draft over the committed base.
- Functional updates retain dispatch order when urgent work lands first.
- When the transition commits everywhere, its draft folds into committed state.
- If React abandons the transition, its speculative view is discarded.

React hooks subscribe through `CosignalsProvider`, which lets signal
invalidations schedule component work at the priority of the write that caused
them. Async computeds keep settled data visible while a replacement is pending,
and suspend only when no settled value exists.

The behavioral contract is documented in
[`spec/react-compliance-contract.md`](spec/react-compliance-contract.md).

## Repository map

| Path                                                                      | Purpose                                                                                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [`harness`](harness/)                                                     | Shared signal conformance, core benchmarks, memory probes, and inlining checks.                                            |
| [`packages/react-signals-playground`](packages/react-signals-playground/) | Browser playground plus Playwright batteries for concurrent behavior and devtools.                                         |
| [`packages/react-seam-bench`](packages/react-seam-bench/)                 | Measures write-to-commit fan-out, urgent latency during transitions, and mount cost.                                       |
| [`packages/dalien-signals`](packages/dalien-signals/)                     | Submodule containing the packed-layout baseline used by benchmarks.                                                        |
| [`libs`](libs/)                                                           | Focused graph-layout and propagation experiments used by the core harness.                                                 |
| [`research`](research/), [`plans`](plans/), [`reviews`](reviews/)         | Design studies, measured experiments, implementation plans, and adversarial reviews.                                       |
| [`royale`](royale/)                                                       | Archived results and notes from the independent implementation tournament. Its old harness and adapters have been removed. |

Vendored and submodule sources are comparison material, not additional packages
maintained by this workspace.

## Development

The CI environment uses Node 24 and pnpm 10.33.0. Initialize the source
submodules needed by the workspace before installing:

```sh
corepack enable
git submodule update --init packages/dalien-signals upstream-alien-signals
pnpm install --frozen-lockfile
```

Run the package checks directly:

```sh
pnpm --dir packages/cosignals typecheck
pnpm --dir packages/cosignals test
pnpm --dir packages/cosignals test:react18

pnpm --dir packages/cosignals-arena typecheck
pnpm --dir packages/cosignals-arena test

pnpm --dir packages/devtools typecheck
pnpm --dir packages/devtools test
```

Run the shared verification surfaces from the repository root:

```sh
FRAMEWORK=cosignals pnpm conformance
pnpm inlining
pnpm play
```

The browser battery uses the Chromium version bundled with Playwright:

```sh
cd packages/react-signals-playground
pnpm exec playwright install chromium
pnpm check
pnpm battery
pnpm devtools-e2e
```

## CI and releases

[`verify.yml`](.github/workflows/verify.yml) runs the main package suites, a
React 19 compatibility matrix, inlining verification, and the Chromium battery.

[`release.yml`](.github/workflows/release.yml) builds npm tarballs for
`cosignals`, `cosignals-arena`, and `cosignals-devtools`, installs those
artifacts into isolated consumers, runs production-build browser tests, and
runs the React 18 package suites before publishing. GitHub Actions are pinned to
release commit SHAs.
