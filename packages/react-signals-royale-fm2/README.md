# react-signals-royale-fm2

React bindings for [`signals-royale-fm2`](../signals-royale-fm2), plus the
48-line React patch they require. The design stance: lean maximally on stock
React, and patch only what React physically cannot tell userland.

```tsx
import { atom, set } from 'signals-royale-fm2';
import { register, useValue, startTransitionWrite } from 'react-signals-royale-fm2';

register(); // fails loudly on a React build without the host protocol

const count = atom(0);

function Counter() {
	return <button onClick={() => set(count, count.get() + 1)}>{useValue(count)}</button>;
}

// A heavy rewrite that must not block typing:
startTransitionWrite(() => set(count, 9000));
```

## How it works

Values never live in React state. Each subscribing hook holds a bump counter
(`useReducer(c => c + 1)`) and re-reads the engine in its render body. The
host protocol tells the engine which pending write batches each render pass
may see (its *world*), so the same component body resolves the right value
in an urgent pass, a transition pass, and a StrictMode replay — and React's
own update-queue replay gives rebase-after-urgent semantics for free.

- `startTransitionWrite(scope)` wraps `React.startTransition`, asks React
  which lane the transition got, and opens an engine batch pinned to that
  lane. Writes in `scope` become drafts: invisible to canonical readers and
  the committed DOM.
- Draft notifications re-dispatch on the owning batch's lane, so subscribers
  join that transition's render. A component that mounts mid-transition
  claims its subscription at commit and re-poked *on the transition's lane*
  — its corrective render lands inside the owning batch's commit, never
  beside it.
- When React commits lanes that include a batch, the host retires the batch:
  the engine folds the drafts into canonical state at the exact moment the
  screen starts showing them.
- Per-root committed views are recorded by the hooks' layout effects, which
  only run for renders that actually commit — a suspended or discarded
  render never records, so `committed(x, container)` mirrors each screen
  exactly even while one root holds a transition and another has shipped it.

Hooks: `useValue`, `useComputed(fn, deps)`, `useSignalEffect`,
`useIsPending`, `useCommitted`, `useAtom` (component-owned, reclaimed after
unmount), plus `startTransitionWrite`, `onDomMutation`, and the trace view
(`traceView().whyLastDelivery(x)` explains a re-render).

Write-during-render throws synchronously. Multiple roots are supported;
unmounted subscribers receive nothing; StrictMode double-mounts net one
engine subscription and one lifetime observation.

## The fork, line by line

The patch series in `patches/` (48 insertions+deletions over React's
`packages/`, all in `ReactFiberWorkLoop.js`) adds a host protocol that is
inert until a runtime registers — one null check per site. Per-line
justification:

| Lines | What | Why React cannot tell userland this |
|---|---|---|
| ~11 | `royaleEvent()` + `royaleHost` slot | A single callback for `render-start`/`render-stop` (with root container and lanes), `commit` (with lanes), and `mutation-start`/`mutation-stop`. No public API reports which lanes a render pass is rendering, so an external store cannot know whether this pass should see a transition's pending writes — the root cause of `useSyncExternalStore`'s de-opt. |
| 2×2 | `render-start`/`render-stop` at the top and epilogue of `renderRootSync` and `renderRootConcurrent` | Brackets every render slice, including resumed and replayed ones, so the engine's ambient world and the write-during-render guard are set for exactly the code that renders. |
| 1 | `commit` at the top of `commitRoot` | The only moment a pending batch may legally become canonical state. Userland has no commit hook that carries lanes; `useEffect` timing is too late and per-component. |
| 2 | `mutation-start`/`mutation-stop` around `commitMutationEffects` | The DOM mutation window. Nothing observable from userland separates React's own mutations from third-party ones; a MutationObserver client needs the exact bracket. |
| ~5 | `royaleProbeLane` | Returns the lane an update issued right now would receive (the current transition's lane, else 0). Needed once per `startTransitionWrite` to pin an engine batch to its transition. React never exposes lane identity. |
| ~10 | `royaleRunWithLane` + a 3-line check in `requestUpdateLane` | Pins updates dispatched inside a callback to a given lane. This is how a late subscriber's corrective update joins the *owning* transition's commit instead of landing beside it (and how pending probes stay urgent from inside a transition scope). |

Everything else — worlds, retirement, committed views, suspense behavior,
tracing — is userland, in this package and the engine.

## Building the fork

```sh
./build.sh                  # build vendor/react on the fork branch (~13s)
./build.sh --apply-patches  # or: pristine base checkout + patches/, then build
```

Artifacts land in `vendor/react/build/oss-experimental/*` and this package
consumes them via `link:`, so rebuilds need no reinstall. Protocol invariant
tests live in the fork itself:
`yarn test --no-watchman ReactDOMRoyaleHostProtocol`.

## Benchmarks

`node bench/react-bench.mjs` runs three scenarios (fanout write latency,
urgent-p95 during a large transition, mount cost) against these bindings
and a stock `useSyncExternalStore` baseline. Note when comparing: the stock
baseline de-opts transitions into synchronous renders — its urgent numbers
are the numbers of a store that blocks instead of staying concurrent.
Neither contender leaks: every scenario drops its tree and the engine holds
no per-episode state at quiescence.
