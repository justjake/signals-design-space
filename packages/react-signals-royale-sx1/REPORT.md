# Signals Royale sx1 report

## Design summary

The store is one ordered operation log, and canonical, latest, render, and per-root committed state are folds over that log. Urgent operations advance each atom's checkpoint immediately, while deferred reducer operations remain in the log and replay over the newer urgent checkpoint when their React lane commits. React lanes are the batch identity, so the engine and fork do not maintain parallel id spaces or translation tables. Computeds use the same world fold and force a canonical reevaluation after a contextual render so a draft cache cannot poison ordinary reads. Settled episodes compact into checkpoints, leaving the log empty at quiescence while an attached bounded trace retains causality. The fork exposes lane attribution, render and commit edges, the exact mutation window, and one owning-lane correction primitive. Weak registries plus finalizer-backed dropped disposers reclaim atoms, computeds, effects, and subscriptions.

## Gates

| Gate | Exact command | Result | Headline |
|---|---|---:|---|
| Engine typecheck | `cd packages/signals-royale-sx1 && pnpm typecheck` | PASS | strict `tsc --noEmit` |
| React bindings typecheck | `cd packages/react-signals-royale-sx1 && pnpm typecheck` | PASS | strict `tsc --noEmit` |
| Engine conformance | `cd packages/signals-royale-sx1 && pnpm exec vitest run tests/conformance.spec.ts --reporter=dot` | PASS | 179/179 |
| Randomized oracle | `cd packages/signals-royale-sx1 && ORACLE_SEEDS=300 ORACLE_STEPS=90 pnpm exec vitest run tests/oracle.spec.ts --reporter=verbose` | PASS | 300 seeds x 90 steps; failures prefix-shrink |
| Full engine suite | `cd packages/signals-royale-sx1 && pnpm test -- --reporter=dot` | PASS | 190/190 |
| Leak audit | `cd packages/signals-royale-sx1 && pnpm exec vitest run tests/gc-leaks.spec.ts --reporter=verbose` | PASS | 3/3; dropped atoms, computeds, effects, subscriptions; empty retired episode |
| Pristine fork rebuild | `./packages/react-signals-royale-sx1/build.sh` | PASS | base checkout + 3 patches + NODE_DEV/NODE_PROD bundles |
| Fork protocol and adjacent upstream | `cd vendor/react && yarn test --no-watchman ReactFiberRoyaleRuntime ReactTransition ReactFlushSync` | PASS | 5 suites; 47 passed, 1 skipped |
| Real React | `cd packages/react-signals-royale-sx1 && pnpm test -- --reporter=dot` | PARTIAL | 17/17 written tests pass; deterministic actual time-slice interruption is not pinned |
| Benchmarks | not run | NOT RUN | adapters are present; no performance claim |

Real output excerpts:

```text
Test Files  1 passed (1)
     Tests  179 passed (179)
```

```text
✓ tests/oracle.spec.ts > 300 x 90 event-log folds match the naive oracle 156ms
```

```text
Test Files  4 passed (4)
     Tests  190 passed (190)
```

```text
Test Files  2 passed (2)
     Tests  17 passed (17)
```

```text
Test Suites: 5 passed, 5 total
Tests:       1 skipped, 47 passed, 48 total
```

```text
Applying: Add external-runtime introspection channel for external state libraries
Applying: Test royale runtime protocol edges
Applying: Pin corrections to an existing transition lane
Built pristine React patch series at 76d2e35254
```

## LOC self-count

Fork metric:

```sh
git -C vendor/react diff --numstat e71a6393e6..HEAD -- packages/ ':!packages/*/src/__tests__*' | awk '{a+=$1+$2} END {print a+0}'
```

Result: **476**.

The scored source was normalized first with:

```sh
node vendor/react/node_modules/prettier/bin/prettier.cjs --write --print-width 100 packages/signals-royale-sx1/src/index.ts packages/signals-royale-sx1/src/runtime.ts packages/react-signals-royale-sx1/src/index.ts packages/react-signals-royale-sx1/src/react-protocol.d.ts
```

Library metric:

```sh
node packages/react-signals-royale-sx1/royale/count-loc.mjs
```

```text
packages/signals-royale-sx1/src/index.ts: 1
packages/signals-royale-sx1/src/runtime.ts: 843
packages/react-signals-royale-sx1/src/index.ts: 227
packages/react-signals-royale-sx1/src/react-protocol.d.ts: 16
total: 1087
```

## Feature coverage

- Writable atoms, custom equality, labels, lazy initialization, set-before-read, and write rejection inside initializers: **done**.
- Reducer replay over newer urgent checkpoints: **done**, including `(1 + 1) x 2 = 4` and branch `1 x 2 x 3 = 6` React tests.
- Lazy cached computeds, equality cutoff, dynamic dependency trimming, and distinct contextual reads: **done**.
- Effects, cleanup, nested ownership, scopes, batch/startBatch/endBatch, and untracked: **done**.
- Lifetime effects across graph and React subscribers with microtask flap coalescing and StrictMode: **done**.
- Urgent/deferred classification, draft invisibility, consistent render worlds, rollback notification, and per-root commits: **done** for tested schedules.
- `flushSync` exclusion and quiescent episode reclamation: **done**.
- Canonical, latest, committed, isPending, and refresh read family: **done** for tested atom/computed and per-root cases.
- Async graph state, stale refresh, direct parallel `use` reads, stable reused thenables, stable errors, and owning-lane settlement: **done** for tested cases; fresh-promise retry identity is partial below.
- React subscribing hook, computed hook, signal effect, committed/pending hooks, transition helper, component atom, post-subscribe fixup, two roots, loud stock-React mismatch, render-write rejection, and unmount: **done**.
- SSR serialization, initialization, direct install without lazy execution, and matching first client render: **done**.
- Bounded causality ring, write/batch/render/root/component/effect/settlement/mutation events, overflow count, and `whyLastDelivery`: **partial** because pass-end disposition is not commit-vs-discard labeled.
- Exact DOM mutation start/stop surface with a real disconnect/reconnect `MutationObserver` test: **done**.
- Dropped-handle reclamation and deterministic disposal: **done** and GC-tested.
- Actual time-slice interruption under a large transition: **not directly verified**.

## Known gaps and honest risks

- A computed that creates a brand-new promise on every retry does not canonicalize that promise by call site; callers currently need a stable resource thenable. This falls short of the strongest thenable-identity requirement.
- The fork's render-pass end event closes completed and replaced passes but does not label the edge `commit` versus `discard`; the causality surface therefore cannot answer that distinction directly.
- The real-React tests prove urgent exclusion and lane priority, but do not deterministically prove that React began and then interrupted a large transition. The overall real-React gate is therefore partial.
- The official core and React seam benchmark runners were not executed, so there is no defensible performance ranking.
- Multi-renderer lane attribution remains first-provider wins, matching the small fork seam but not a general multi-renderer protocol.

## What I would do with another day

I would add call-site async slots so retries reuse fresh promises without refetching, and carry a generation through settlement for a stronger race proof. I would extend the fork's pass edge with an explicit commit/discard disposition and add a deterministic scheduler-controlled interruption test. Then I would wire the adapters into isolated official benchmark children, profile the global fold and Set/Map graph costs, and replace only measured hot allocations.

## Round 2

This section supersedes the Round 1 gate and benchmark status above. The final source passes both local suites and the shared battery. Performance work improved the direct-update paths substantially, but the Cellx and full dynamic milomg suites do not finish in a practical measurement window; those rows and a true all-suite ratio remain honestly unmeasured.

### Fresh gates

| Gate | Exact command | Result |
|---|---|---:|
| Engine typecheck | `cd packages/signals-royale-sx1 && pnpm typecheck` | PASS |
| React typecheck | `cd packages/react-signals-royale-sx1 && pnpm typecheck` | PASS |
| Conformance | `pnpm exec vitest run tests/conformance.spec.ts --reporter=dot` | PASS, 179/179 |
| Oracle default | `pnpm exec vitest run tests/oracle.spec.ts --reporter=verbose` | PASS, 300 seeds x 90 steps |
| Oracle deep | `ORACLE_SEEDS=1200 pnpm exec vitest run tests/oracle.spec.ts --reporter=verbose` | PASS, 1,200 seeds x 90 steps |
| Leak audit | `pnpm exec vitest run tests/gc-leaks.spec.ts --reporter=verbose` | PASS, 3/3 |
| Pristine fork build | `./packages/react-signals-royale-sx1/build.sh` | PASS |
| Fork suites | `yarn test --no-watchman ReactFiberRoyaleRuntime ReactTransition ReactFlushSync` | PASS, 47 passed / 1 skipped |
| Real React | `pnpm test -- --reporter=dot` | PASS, 17/17 |
| Shared battery typecheck | `cd royale/verify-kit/battery && pnpm typecheck` | PASS |
| Shared battery | `cd royale/verify-kit/battery && pnpm test` | PASS, 25/25 |
| milomg adapter sanity | `pnpm -C packages/core test` | PASS, 8/8 |

Real final output:

```text
> signals-royale-sx1@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

> react-signals-royale-sx1@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json
```

```text
Test Files  1 passed (1)
     Tests  179 passed (179)
  Duration  483ms (transform 245ms, setup 0ms, import 297ms, tests 20ms, environment 0ms)
```

```text
✓ tests/oracle.spec.ts > 300 x 90 event-log folds match the naive oracle 117ms
Test Files  1 passed (1)
     Tests  1 passed (1)

$ ORACLE_SEEDS=1200 pnpm exec vitest run tests/oracle.spec.ts --reporter=verbose
✓ tests/oracle.spec.ts > 300 x 90 event-log folds match the naive oracle 267ms
Test Files  1 passed (1)
     Tests  1 passed (1)
```

The oracle title is static; the second command actually supplied 1,200 seeds.

```text
✓ tests/gc-leaks.spec.ts > dropped atom and computed handles are reclaimable 11ms
✓ tests/gc-leaks.spec.ts > dropped effect and subscription disposers clean their retained graph links 12ms
✓ tests/gc-leaks.spec.ts > retirement leaves no live operation episode 1ms
Test Files  1 passed (1)
     Tests  3 passed (3)
```

```text
Applying: Add external-runtime introspection channel for external state libraries
Applying: Test royale runtime protocol edges
Applying: Pin corrections to an existing transition lane
Built pristine React patch series at 6475df0e04
```

```text
Test Suites: 5 passed, 5 total
Tests:       1 skipped, 47 passed, 48 total
Snapshots:   0 total
Time:        1.659 s
```

```text
Test Files  2 passed (2)
     Tests  17 passed (17)
  Duration  670ms (transform 130ms, setup 25ms, import 186ms, tests 105ms, environment 758ms)
```

```text
> royale-battery@0.0.0 typecheck
> tsc --noEmit -p tsconfig.json
> royale-battery@0.0.0 test
> vitest run
Test Files  1 passed (1)
     Tests  25 passed (25)
  Duration  956ms (transform 105ms, setup 0ms, import 142ms, tests 220ms, environment 448ms)
```

### Core benchmark

The adapter is registered as `Royale SX1`, uses the package directly, and disposes every accumulated build scope in `cleanup()`. There is no leak/no-leak benchmark asymmetry: the adapter does not retain benchmark graphs after cleanup, and the independent GC audit passes.

The prescribed bundle needed `--platform=node` because the isolated runner imports Node built-ins:

```text
dist/index.js          66.8kb
dist/isolated.js       38.2kb
dist/index.js.map     150.5kb
dist/isolated.js.map   90.2kb
Done in 12ms
```

The local benchmark clone's other candidate package directories are empty submodule stubs. To respect isolation and avoid importing unavailable contestant packages, its private roster contains only Alien Signals and Royale SX1. Adapter sanity still exercises all eight pull-count cases:

```text
✓ src/frameworks.test.ts (8 tests) 5ms
Test Files  1 passed (1)
     Tests  8 passed (8)
Duration  196ms (transform 68ms, setup 0ms, import 85ms, tests 5ms, environment 0ms)
```

Three isolated rounds completed for sBench and Kairo. Times are the isolated runner's medians in milliseconds:

| Suite/test | Royale SX1 | Alien Signals | sx1 / Alien |
|---|---:|---:|---:|
| sBench createSignals | 9.79 | 2.47 | 3.96x |
| sBench createComputations | 396.19 | 79.30 | 5.00x |
| sBench updateSignals | 1131.68 | 274.03 | 4.13x |
| Kairo avoidablePropagation | 268.74 | 118.07 | 2.28x |
| Kairo broadPropagation | 374.09 | 83.66 | 4.47x |
| Kairo deepPropagation | 126.07 | 32.72 | 3.85x |
| Kairo diamond | 278.00 | 88.60 | 3.14x |
| Kairo mux | 218.59 | 81.61 | 2.68x |
| Kairo repeatedObservers | 38.01 | 19.75 | 1.92x |
| Kairo triangle | 83.27 | 24.33 | 3.42x |
| Kairo unstable | 61.30 | 20.50 | 2.99x |
| Kairo molBench | 16.07 | 14.32 | 1.12x |

sBench totals are 1537.66 ms versus 355.80 ms (4.32x). Kairo totals are 1464.14 ms versus 483.56 ms (3.03x). The completed-suite subtotal is 3001.80 ms versus 839.36 ms, or **3.58x Alien**. This is not presented as the required overall ratio because Cellx and the full dynamic suite are absent.

Cellx was attempted first in the unfiltered three-round command, then as a one-suite three-round command, and finally as a single isolated round. A single Royale child remained CPU-active with flat memory for more than fifteen minutes without emitting a row, so it was terminated. The unfiltered runner likewise produced no buffered table before termination. A diagnostic, non-final first dynamic configuration measured Royale at 625.02 ms, but no three-round Alien pair was completed. Cellx, dynamic, and the true all-suite ratio are therefore **NOT MEASURED**.

### React benchmark

`bench/react-bench.mjs` runs each contender/scenario in a fresh child, uses jsdom with real timers and real `createRoot`, and emits only CSV. The baseline is a plain store read through `useSyncExternalStore` with the same component trees.

Final output from `pnpm bench:react`:

```csv
scenario,contender,stat,ms
fanout,sx1,median,0.307
fanout,useSyncExternalStore,median,0.378
transition,sx1,p95,2.600
transition,useSyncExternalStore,p95,2.049
mount,sx1,median,71.065
mount,useSyncExternalStore,median,37.954
```

Sx1 is 19% faster on fanout, 27% slower on transition urgent-p95 in this run, and 1.87x slower to mount. An earlier same-machine run produced a 0.892 ms sx1 transition p95 versus 1.174 ms for the baseline, so the short transition statistic is noisy under shared-machine contention; the table above is the final-code run and is the claimed result.

### Round 2 changes

- Removed the per-atom debug WeakRef registry, added the empty-log fold fast path, removed urgent checkpoint closures, and reused a single effect queue.
- Reused dependency maps in place, removed synchronous computed async allocations, and replaced per-batch Map/object allocation with a scalar fast path.
- Made component delivery per-source instead of scanning one global listener set. React-owned claims skip WeakRef/finalizer allocation because layout cleanup owns them; unmanaged dropped disposers remain finalizer-backed and GC-tested.
- Added render-aware reducer replay: an urgent update before a deferred pass becomes its rebase checkpoint, while an urgent update after that pass rendered is retained after the draft. This satisfies both the canonical preemption schedule and the shared live-transition schedules.
- Late subscribers now record which batches their mounting render saw, so retirement corrects only genuinely missed work. Computed pending subscribers receive settlement/refresh edges. SSR falls back to stable positional keys when labels are absent.
- Added the React benchmark runner and the milomg adapter/registration. Regenerated the three React patches from `e71a6393e6..royale/sx1-react`.

### Round 2 LOC and disputes

The shared verifier reports **476 fork LOC** and **1295 library LOC**. The entry's older local counter reports 1314 because it counts the declaration file and comment/blank normalization differently; the shared verifier number is the authoritative Round 2 figure.

There are no shared-battery disputes: typecheck and all 25 scenarios pass. The only incomplete Round 2 deliverable is the full milomg table/overall ratio, reported above without substitution or workaround.
