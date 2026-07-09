# Signals Royale — entry fm2 — REPORT

## 1. Design summary

The entry bets everything on one idea: **React already contains the whole
concurrency machine; a signal library only needs to know which write batches
each render pass may see.** So the fork is a 48-line inert host protocol
(render-slice bracket with lanes, commit with lanes, mutation window, lane
probe, lane pin), and everything else is userland. Values never live in
React state: hooks hold a bump counter and re-read the engine in the render
body, where the host has set the pass's "world" — so urgent passes,
transition passes, and StrictMode replays each resolve the right value with
no snapshot bookkeeping, and React's own updater-queue replay provides
rebase-after-urgent arithmetic. The engine mirrors that queue exactly: each
atom is a committed base plus a dispatch-ordered write queue tagged by
batch; retiring a batch marks its ops committed in place and advances the
base through the committed prefix. Per-root committed views are recorded by
layout effects — which only run for renders that actually commit — so a
suspended root's screen and a shipped root's screen read differently with
zero write-path cost.

## 2. Gates

| Gate | Command | Result |
|---|---|---|
| Typecheck (engine) | `pnpm typecheck` in `packages/signals-royale-fm2` | PASS |
| Typecheck (react) | `pnpm typecheck` in `packages/react-signals-royale-fm2` | PASS |
| Engine conformance | `pnpm test` (tests/conformance.spec.ts, reactive-framework-test-suite@0.0.2) | PASS — **179/179**, no skips (`untracked` implemented) |
| Randomized oracle | tests/oracle.spec.ts, default `ORACLE_SEEDS=300` × 90 steps | PASS (part of the 204-test engine suite) |
| Oracle deep sweep | `ORACLE_SEEDS=1200 vitest run tests/oracle.spec.ts` | PASS (`Tests 1 passed`, 512ms) |
| Leak audit | tests/gc-leaks.spec.ts under `--expose-gc`, pool=forks | PASS — 5/5 (dropped nodes, disposed effects, unsubscribed hosts, batch churn, quiescence) |
| Real-React gate | `pnpm test` in react package (in-package copy of the shared battery + hooks/reclamation specs) | PASS — **31/31** (battery scenarios 1–18 all green) |
| Shared battery (verify-kit) | `pnpm test` in `royale/verify-kit/battery` (ADAPTER → this entry, links → this fork build) | PASS — **25/25** |
| Fork protocol tests | `cd vendor/react && yarn test --no-watchman ReactDOMRoyaleHostProtocol` | PASS — 6/6 |
| Upstream adjacency | `yarn test --no-watchman packages/react-reconciler` | PASS — **76/76 suites, 1140 passed, 19 skipped** |
| Fork prettier | `yarn prettier-check` in vendor/react | PASS |

Real output snippets:

```
signals-royale-fm2:      Test Files  4 passed (4)   Tests  204 passed (204)
deep sweep (1200 seeds): Tests  1 passed (1)        Duration 634ms
react-signals-royale-fm2: Test Files 2 passed (2)   Tests  31 passed (31)
verify-kit battery:      Test Files  1 passed (1)   Tests  25 passed (25)
fork protocol:           Test Suites: 1 passed      Tests: 6 passed, 6 total
react-reconciler:        Test Suites: 76 passed, 76 total
                         Tests: 19 skipped, 1140 passed, 1159 total
```

The oracle was negative-controlled: mutating the model's fold semantics
makes it fail within the first seeds and print a shrunk schedule.

## 3. LOC self-count

Commands (from the clone root):

```sh
git -C vendor/react diff --numstat e71a6393e6..HEAD -- packages/ ':!packages/*/src/__tests__*' \
  | awk '{a+=$1+$2} END {print a}'
node royale/verify-kit/count-loc.mjs --fork vendor/react \
  --base e71a6393e66b0d2add46ba2b2c5db563a0563828 --head royale/fm2-react \
  --lib packages/signals-royale-fm2 --lib packages/react-signals-royale-fm2
```

| Metric | This entry | Incumbents |
|---|---|---|
| React fork (numstat over packages/, tests excluded) | **48** | 1510 |
| Library (both packages' src/, prettier-normalized, non-blank non-comment) | **1734** | alt-a 4689, alt-b 4909 |

Per-file: core.ts 1162, engine index 122, tracer 94; host.ts 213, hooks 100,
react index 21, trace 22. The entire fork diff is one file
(`ReactFiberWorkLoop.js`); the patch series is `patches/0001` (protocol) +
`patches/0002` (tests, excluded from the metric by the tests filter).

## 4. Benchmarks

### milomg js-reactivity-benchmark (isolated runner, `--rounds 3`)

| Suite | Royale FM2 | Alien Signals | ratio |
|---|---|---|---|
| createSignals | 6.88 | 1.43 | 4.8 |
| createComputations | 344.10 | 69.16 | 5.0 |
| updateSignals | 382.79 | 265.67 | 1.4 |
| avoidablePropagation | 168.15 | 96.68 | 1.7 |
| broadPropagation | 183.88 | 79.36 | 2.3 |
| deepPropagation | 66.77 | 30.29 | 2.2 |
| diamond | 144.93 | 81.45 | 1.8 |
| mux | 137.70 | 74.99 | 1.8 |
| repeatedObservers | 19.97 | 19.07 | 1.0 |
| triangle | 45.14 | 23.19 | 1.9 |
| unstable | 88.83 | 18.67 | 4.8 |
| molBench | 15.79 | 15.26 | 1.0 |
| cellx1000 | 9.64 | 3.65 | 2.6 |
| cellx2500 | 47.68 | 10.32 | 4.6 |
| 2-10x5 lazy80% | 282.79 | 151.33 | 1.9 |
| 6-10x10 dyn25% lazy80% | 170.55 | 101.21 | 1.7 |
| 4-1000x12 dyn5% | 367.43 | 278.08 | 1.3 |
| 25-1000x5 | 392.78 | 341.95 | 1.1 |
| 3-5x500 | 140.18 | 76.05 | 1.8 |
| 6-100x15 dyn50% | 243.70 | 157.94 | 1.5 |

Overall geometric mean ≈ **2.0× alien-signals** (propagation suites mostly
1.1–2.3×; creation-heavy and dep-churn suites are the outliers at ~5×).
Adapter sanity (`pnpm -C packages/core test`): all four Royale FM2 tests
pass including exact pull counts. `cleanup()` disposes the built scope — no
leak-based numbers. (One pre-existing entry in the shared benchmark clone,
"x-reactivity", fails its own pull-count test; unrelated to this entry.)

### React seam benchmark (`node bench/react-bench.mjs`, jsdom, real timers)

| scenario | stat | royale-fm2 | stock-uses |
|---|---|---|---|
| fanout (5000 cells, 200 writes) | median write→commit ms | 2.04 | 1.92 |
| transition (2000-cell rewrite + 30 urgent inputs) | p95 urgent ms | 12.90 | 3.74 |
| transition | sync block inside the transition call ms | 1.49 | 0.36 |
| mount (5000 cells × 5 roots) | median ms | 59.5 | 45.8 |

Read the transition row carefully: the stock `useSyncExternalStore`
baseline *de-opts the transition to synchronous rendering* — its store
rewrite never renders concurrently at all, so its urgent updates run
against an idle scheduler. This entry's 12.9ms p95 is the latency of urgent
input landing *while a real concurrent transition renders 2000 components*
(under one 16ms frame). Both contenders drop their trees; neither leaks.

## 5. Feature coverage

- Writable signals + custom equality + labels — **done**
- Lazy initializers (first-touch, set-before-read, install ≠ write) — **done** (battery 17, 18)
- Functional updates that replay (updater-queue arithmetic) — **done** (battery 3, 13)
- Computeds: lazy, cached, equality cutoff, dynamic deps w/ trimming, exact pull counts — **done** (conformance + milomg pull counts)
- Per-world dependency sets / values — **done** (engine worlds.spec)
- Effects + scopes + cleanup, canonical-only — **done**
- batch/startBatch/endBatch, untracked — **done**
- Lifetime effects (union of kinds, tick coalescing, StrictMode nets one) — **done** (battery 8, 14)
- Concurrent model: draft invisibility, render-pass consistency, urgent-during-transition, per-root committed views, flushSync exclusion, quiescence — **done** (battery 2–7, 12, 13)
- Read family: read/latest/committed/isPending/refresh — **done**
- Async/suspense: pending-as-graph-state, parallel registration, stable thenable identity, two-level suspend-vs-stale, settlement-as-write owned by its batch — **done** (battery 11; engine async specs)
- React bindings: useValue/useComputed/useSignalEffect/useIsPending/useCommitted/useAtom, transition helper, loud registration failure, loud write-during-render, multi-root, unmount silence — **done**
- SSR: serialize/initialize/installState — **done** (battery 18)
- Causality log: attachable, ring-bounded w/ counted overflow, causal parents, whyLastDelivery — **done** (battery 15)
- DOM mutation window: exact bracket, MutationObserver use case — **done** (battery 16; fork test pins bracket position inside the commit)
- Rollback of an abandoned batch re-notifies — **done at engine level** (`abortBatch`, oracle-fuzzed); the React host never abandons batches itself (see gaps).

## 6. Known gaps and honest risks

- **Abandoned transitions**: React rarely abandons a committed-to lane, but
  a root unmounted with a parked transition leaves its engine batch open
  until `resetForTest`/`abortBatch`. Bounded (16 transition lanes → batches
  reuse per lane) but a stale draft could linger on a dead lane in a
  long-lived app. Fix sketch: abort batches whose lane React reports as no
  longer pending on any root.
- **committed(x, container) before any subscriber commit**: falls back to
  canonical state until a hook records a value for that root. "What is on
  screen" for an atom nothing renders is inherently ambiguous; documented.
- **Retirement pokes**: after a transition commits, its subscribers get one
  value-equal re-render (the poke that keeps roots that did *not* commit it
  honest). Costs one wasted render per subscriber per transition commit.
- **Lane collisions**: two overlapping `startTransitionWrite` calls that
  land on the same React transition lane share one engine batch (this
  mirrors React entangling those lanes, but it is coarser than per-call
  batches).
- **useSignalEffect/useComputed re-track through a ref**: swapping to a
  closure over different signals re-tracks on the next run, not eagerly.
- Perf: creation-heavy suites sit ~5× alien-signals (per-node field/Set
  allocation); propagation is 1.1–2.3×.
- The transition seam-bench comparison needs the de-opt caveat above to be
  read fairly; numbers reported as measured.

## 7. With another day

Array-based subscriber lists (drop the per-notify Set iteration) and lazy
per-node allocations to close the creation gap toward alien parity; abort
batches for dead lanes via a root-release protocol event (would cost ~4 fork
lines); a `useSelector`-style derived-slice hook; SSR streaming (per-chunk
`installState`); richer trace formatting (batch labels through delivery
chains, per-root commit frames).

## Round 2 (verification pass)

All gates re-run fresh in the Round-2 order on the final tree; the outputs
in section 2, the LOC pair in section 3, and both benchmark tables in
section 4 are from those runs (typecheck ×2 → 179/179 conformance → oracle
default + 1200-seed sweep → leak audit → fork protocol 6/6 + upstream
react-reconciler 76/76 → in-package real-React gate 31/31 → shared
verify-kit battery 25/25 → milomg isolated runner → react-bench). Changes
made during Round 2 and why: engine hot-path work (in-place dependency
re-tracking, live-node validation skip, closure-free computed evaluation,
trace-guarded emit sites) purely for the milomg objective — semantics
pinned by the 204-test engine suite and the battery before and after.
Nothing disputed in the shared battery; scenario 7's held-root case drove a
real design change (committed views recorded at layout-effect commit time
instead of write-capture), adopted rather than contested.
