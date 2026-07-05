# React-seam benchmark proposal

Goal: a CI benchmark that measures what the milomg core-graph suite cannot —
the cost and behavior of signal libraries **as consumed by React** — comparing:

1. `cosignal` via `cosignal-react` (the bridge)
2. `alien-signals` via a shared `useSyncExternalStore` adapter
3. `dalien-signals` via the same adapter (same file, import swapped)
4. React-primitives baselines (no library)
5. (optional reference point) one popular external store, e.g. zustand,
   to anchor our numbers against published intuition

## What the field does today

- **krausest js-framework-benchmark**: the canonical DOM benchmark — 1,000-row
  table with create / partial-update (every 10th) / select / swap / append /
  clear, driven by puppeteer against real Chrome, measuring script+paint from
  traces. React + state-library entries (react-redux, react-mobx, jotai,
  zustand, preact signals, legend-state…) make it the de facto arena for
  "state lib inside React" claims. Strength: realistic, comparable to public
  numbers. Weakness: measures fully-synchronous updates only; says nothing
  about concurrent behavior, and paint dominates small JS differences.
- **dai-shi's `will-this-react-global-state-work-in-concurrent-rendering`**:
  jest + puppeteer suite; ~50 subscribed components with deliberately
  expensive renders while state mutates from outside React. Scores libraries
  on levels: (1) no tearing after render settles, (2) no tearing even
  mid-render, (3) render interruptible (time slicing) and state branchable
  (work-in-progress trees). Run under both `useTransition` and
  `useDeferredValue`. This is the standard correctness panel for the seam.
- **Ad-hoc library comparisons** (blog/vendor benchmarks) converge on: update
  latency at N subscribed components, unnecessary re-render counts, mount
  cost, bundle size.

## The one fact that shapes everything

Per the React docs, RFC 0214, and facebook/react#24810/#26382: **updates
triggered through `useSyncExternalStore` are always synchronous, even inside
`startTransition`** — React cannot maintain multiple versions of external
state, so external-store writes de-opt transitions and force the nearest
Suspense fallback instead of keeping old content on screen. React-native
state (`useState`/`useReducer`) does participate in transitions.

This is precisely the limitation `cosignal-react` was built to remove (the
bridge maintains world-consistent values across React's work-in-progress
trees — the R6 mid-transition-suspense scenario in `packages/cosignal-react`
is the existence proof). Consequence: **a benchmark with only synchronous
scenarios would erase cosignal's differentiator and hide the uSES adapters'
sharpest weakness.** The suite must include concurrent scenarios where the
outcome differs in kind (transitions stay non-blocking vs de-opt), not just
in milliseconds.

## Proposed design

### Contenders

| entry | wiring |
| --- | --- |
| `react-baseline-context` | idiomatic no-library React: state in `useReducer`, distributed via context (one context per store slice); its known fan-out weakness (no selectors) is information, not unfairness |
| `react-baseline-local` | colocated `useState`/`useMemo` where the scenario permits — the "if you didn't need shared state" floor |
| `alien-uses` | shared ~25-line adapter: `useReactive(fn)` = `useSyncExternalStore(subscribe, getSnapshot)` where subscribe mounts an `effect` over `fn` bumping a version, snapshot reads `fn()` untracked |
| `dalien-uses` | the identical adapter file with the import swapped |
| `cosignal-react` | the published bridge API |
| `zustand` (optional) | reference anchor |

All contenders run on the **same React build: the cosignal fork**
(`vendor/react` @ `cosignal-fork`, built by `fork/build-react.sh`). The fork
behaves as stock React for non-bridge code, cosignal-react requires it, and a
single-React-version rule is non-negotiable for fairness. CI caches the
build keyed on the fork SHA (~13s build after a large clone; cache makes it
a non-issue).

### Panel A — performance scenarios

Each scenario is a small react-dom app; per contender we record wall-clock
around update→commit, `<Profiler>` actualDuration sums, and re-render
counters incremented inside components. Same interleaved-rounds + median
methodology and the same CSV/chart pipeline as the core benchmark.

1. **Fan-out cells**: 5,000 components, each subscribed to its own cell;
   write one cell; expect 1 re-render. Measures subscription scalability and
   per-update dispatch cost. (The classic "N subscribers" test.)
2. **Derived diamond**: components read computeds over shared signals
   (kairo-like diamond, but through React); one source write; measures
   derived-state efficiency through the seam.
3. **Table ops (krausest-lite)**: 1,000-row table, rows subscribe to row
   state: create, update-every-10th, select-row (2 rows re-render), swap,
   clear. Comparable in spirit to public js-framework-benchmark entries.
4. **Transition under load** (the differentiator): a `startTransition`
   rewrites 2,000 subscribed cells while urgent keystrokes update a text
   input at 60Hz. Metrics: p95 urgent-input commit latency during the
   transition, total transition completion time, and a binary
   "suspense fallback flashed / old content retained". Expected: baselines
   stay responsive (native state), uSES adapters de-opt (synchronous storms;
   documented React behavior), cosignal keeps the transition non-blocking —
   this is where the bridge either earns its LOGGED tax or doesn't.
5. **Mount cost**: mount the 5,000-cell tree; time to interactive commit.

### Panel B — correctness (dai-shi levels + ours)

Port the shape of dai-shi's suite rather than the repo itself: external
mutations during expensive renders, checked for (1) tearing after settle,
(2) tearing mid-render, (3) interruptibility/branching — under both
`useTransition` and `useDeferredValue` — plus our own **mid-transition
Suspense scenario** (cosignal R6, generalized to all contenders). Output is
a pass/fail matrix published next to the perf chart; perf numbers without
this table invite "fast because it tears" suspicion — and the two baselines
plus uSES entries give the matrix known-answer rows that validate the
harness itself.

### Environment: two tiers

- **Tier 1 (ships first, runs in CI)**: node + jsdom + `react-dom/client`,
  real scheduler (no `act()` around timed regions — `act` batches
  unnaturally; drive with real events and await paint-equivalent flushes).
  Measures JS-side cost only (reconciliation + subscription dispatch), which
  is exactly where state libraries differ, and is stable on shared runners.
  Node-only initially; a bun job is a cheap later add if jsdom behaves.
- **Tier 2 (later, optional)**: playwright + headless Chrome tracing for
  script+paint realism, krausest-style. Heavier, flakier on hosted runners;
  only worth it if we want numbers comparable to published js-framework-
  benchmark entries.

### CI wiring

New workflow in the parent repo (private — same reasoning as the family
benchmark): `react-benchmark.yml`, triggered on `packages/cosignal-react/**`,
`packages/cosignal/**`, the dalien submodule pointer, and the adapter/harness
paths; `workflow_dispatch` inputs for scenarios and rounds. Jobs: Tier-1
node (later + bun). Steps mirror the family workflow, plus: restore-or-build
the React fork (actions/cache keyed on `vendor/react` SHA). Artifacts:
`react-results-<runtime>.csv`, `react-benchmark-<runtime>.png` (same
chart.mjs, suite column = scenario), plus `correctness-matrix.md` in the job
summary. Missing-contender guard identical to the family workflow.

### Phasing

- **P1** (a day-ish): harness skeleton, shared uSES adapter, contenders
  wired, scenarios 1 + 4, CSV/chart/CI. Scenario 4 first because it is the
  question this benchmark exists to answer.
- **P2**: scenarios 2/3/5 + the correctness matrix.
- **P3** (optional): Chrome tier, zustand anchor, bun job.

## Honest expectations to publish with it

- On synchronous scenarios (1–3, 5) the three signal libraries should land
  within noise of each other and beat `react-baseline-context` on fan-out —
  the interesting deltas are adapter overhead per subscription, and
  cosignal's LOGGED bridge tax with React idle (~measured 2–8% core-side).
- On scenario 4 the result is qualitative first (de-opt vs not), quantitative
  second. If cosignal does NOT hold its advantage there, the whole bridge
  design needs re-examination — which is exactly why this belongs in CI.
- jsdom numbers are JS-cost numbers; the chart subtitle must say so.

## Implementation status

P1 shipped:

- **`packages/react-seam-bench`** — the Tier-1 (node + jsdom) Panel A
  harness: shared uSES adapter, contenders `cosignal-react` / `alien-uses` /
  `dalien-uses` / `baseline-context` / `baseline-local`, scenarios **1
  (fan-out)**, **4 (transition under load)**, and **5 (mount cost)**.
  `pnpm build` then `node dist/isolated.js --rounds N <contenders>` emits the
  same CSV shape as the core benchmark; the package carries its own
  `src/chart.mjs`.
- **Panel B via the daishi fork** — the `daishi-concurrent-benchmark`
  submodule carries `cosignal-react` / `alien-uses` / `dalien-uses` entries
  next to the stock ones, plus a `LIBS` env filter in the spec so CI runs
  only our entries and the two known-answer anchors (`react-state`,
  `zustand`).
- **`.github/workflows/react-benchmark.yml`** — two jobs, both restoring or
  building the React fork from an `actions/cache` keyed on the
  `vendor/react` submodule SHA:
  - `perf` (Panel A): scenario CSV + chart artifacts, missing-contender
    guard, totals table in the job summary.
  - `correctness` (Panel B): builds only our pages + the two anchors, runs
    jest headless, publishes the lib × test pass/fail matrix to the job
    summary and uploads the jest JSON. The verdict gates only on
    (a) cosignal-react passing everything it ran and (b) the anchors
    matching their hardcoded known-good rows (react-state 10/10, zustand
    8/10); uSES entries failing Level 3 is the documented expected outcome,
    never a CI failure.

Remaining:

- Panel A scenarios **2 (derived diamond)** and **3 (table ops)**.
- The mid-transition-suspense scenario generalized into the daishi fork's
  spec (today it exists only as cosignal-react's own R6 test).
- Tier 2: playwright + headless-Chrome tracing for script+paint numbers.
- The zustand anchor in Panel A, and a bun job for Panel A.

## Sources

- https://github.com/krausest/js-framework-benchmark
- https://github.com/dai-shi/will-this-react-global-state-work-in-concurrent-rendering
- https://react.dev/reference/react/useSyncExternalStore (caveats: store
  updates cannot be marked as transitions)
- https://github.com/reactjs/rfcs/blob/main/text/0214-use-sync-external-store.md
- https://github.com/facebook/react/issues/24810,
  https://github.com/facebook/react/issues/26382 (startTransition +
  useSyncExternalStore de-opt)
- https://github.com/reduxjs/react-redux/issues/2086 (perf impact of the
  de-opt in a mainstream library)
