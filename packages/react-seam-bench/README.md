# react-seam-bench

Benchmarks signal libraries **as consumed by React** — not the libraries'
own propagation speed, but what a React app actually pays at the seam
between an external store and committed UI. Every scenario mounts a real
tree with `react-dom/client` `createRoot` into jsdom, drives writes from
outside React, and waits for the committed DOM to change using real timers.

## What it measures

Three scenarios, each one CSV row per contender:

| test | shape | time column |
| --- | --- | --- |
| `fanout` | 5000 independent cells, one component each; 200 single-cell writes from outside React | median write-to-commit latency (ms) |
| `transition` | 2000 cells rewritten inside `React.startTransition` while an unrelated urgent `useState` input updates 30 times at ~16 ms intervals | p95 urgent update-to-commit latency (ms) |
| `mount` | mount + first commit of the 5000-cell tree, 5 fresh roots | median mount time (ms) |

Secondary stats (cell re-renders per write, transition completion time,
Profiler `actualDuration` totals) are printed to stderr as `# ...` comment
lines; stdout stays pure CSV.

## The fact the transition scenario exposes

React documents that stores read through `useSyncExternalStore` cannot take
part in non-blocking transitions: if the store is mutated during a
transition, React falls back to rendering that update synchronously
(<https://react.dev/reference/react/useSyncExternalStore#caveats>). So for
any signal library consumed through a `useSyncExternalStore` adapter —
which is how nearly every standalone signal library meets React — a bulk
write wrapped in `startTransition` still produces one blocking re-render of
every subscribed component, and urgent updates queue behind it.

`cosignal-react` binds through a different mechanism: writes made inside
`React.startTransition` are classified into that transition and render at
transition priority, so urgent updates keep committing while the bulk
re-render proceeds. Native `useState`/`useReducer` state also participates
in transitions, which is why both React-only baselines are included. The
p95 asymmetry between these groups is the point of the scenario, not noise.

## Contenders

| name | reads | writes |
| --- | --- | --- |
| `cosignal-react` | `useSignal(atom)` from cosignal's own bindings | `atom.set(v)`, batched with `batch()`, transitions via `startTransition` |
| `alien-uses` | upstream alien-signals through the shared `useSyncExternalStore` adapter (`src/adapters/useReactive.ts`) | `sig(v)`, batched with `startBatch`/`endBatch` |
| `dalien-uses` | dalien-signals through the identical adapter | same call style as alien-signals |
| `baseline-context` | one root `useReducer`, values distributed through a single context | dispatch captured at mount; every consumer re-renders per write (the honest context cost — `React.memo` cannot help because context bypasses it) |
| `baseline-local` | each cell owns its `useState` | setters registered in a module-level array, called directly — the "if state were local" floor |

## Methodology

- **One contender per process.** `registerCosignalReact()` runs once per
  process and patches `Atom`'s prototype onto the concurrent engine, so two
  contenders in one process would be wrong, not merely noisy. Process
  isolation also keeps one library's JIT warmup, GC pressure, and
  polymorphic call sites out of another's numbers.
- **Interleaved rounds, medians.** Contenders run round-robin
  (A B C, A B C, ...; default 3 rounds), and each test's final time is the
  median of its per-round times. Interleaving decorrelates machine drift
  (thermals, background load) from any one contender; the median discards
  lucky and unlucky rounds.
- **Real timers, no `act()`.** `act()` flattens exactly the scheduling
  differences under test — a synchronous blocking flush and a chunked
  concurrent render both look instant inside it. Scenarios instead poll the
  committed DOM with `setTimeout(0)` loops until a rendered sentinel
  matches; every contender pays the same polling granularity.

## Running

Once per checkout (from the repo root — the React fork must be built and
linked):

```sh
pnpm fork:build   # if vendor/react/build is not already populated
pnpm install
```

Then, in this package:

```sh
pnpm build                      # bundles dist/child.js and dist/isolated.js
pnpm bench                      # all contenders, 3 rounds; CSV on stdout
node dist/isolated.js --rounds 5 cosignal-react alien-uses   # subset
node dist/isolated.js > results.txt
node src/chart.mjs results.txt out.svg   # stacked-bar chart of the totals
```

The runner exits 1 if any requested contender produced zero result rows.

## Reading the numbers

jsdom has no layout, paint, or compositor: these numbers are **JS-side cost
only** — component renders, reconciliation, store bookkeeping, and effect
traffic per commit. They rank the work a real browser frame would have to
absorb; they are not frame times. Cross-scenario sums (as in the chart) mix
metrics with different meanings, so treat the chart as an overview and the
per-scenario rows as the actual result.
