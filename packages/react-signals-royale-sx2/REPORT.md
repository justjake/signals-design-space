# Signals Royale — sx2 report

## Design summary

Every value is an async cell; settled synchronous state is the compact fast path, while pending reads, stale refreshes, errors, and transition drafts extend the same cell record. Deferred writes are replayable operations keyed directly by React's transition lane, so urgent state stays canonical and a retiring transition replays over that newer base. A render reads canonical state plus exactly the live lanes reported by React, while committed values are captured separately per root. Computeds use the same dependency links whether observed or detached, with render-world evaluation only at the React boundary. Pending thenables are collected as graph state and become a stable aggregate only when a read reaches a Suspense boundary. The fork reports facts React already owns—write lane, render world, pass disposition, root commit, finished lanes, and mutation edges—and adds only lane-pinned scheduling as a mechanism. This canonical-cell design was kept deliberately separate from root views and trace state because those lifetimes must legitimately disagree.

## Gates

| Gate | Command | Result | Headline |
|---|---|---|---|
| Engine typecheck | `cd packages/signals-royale-sx2 && pnpm typecheck` | PASS | strict `tsc --noEmit`, zero errors |
| React package typecheck | `cd packages/react-signals-royale-sx2 && pnpm typecheck` | PASS | strict `tsc --noEmit`, zero errors |
| Engine conformance | `cd packages/signals-royale-sx2 && pnpm vitest run tests/conformance.spec.ts tests/oracle.spec.ts tests/gc-leaks.spec.ts --reporter=verbose` | PASS | conformance 179/179; focused run 181/181 |
| Randomized oracle | same focused command | PASS | 300 seeds × 90 steps = 27,000 operations; seed and shortest failing prefix are printed on failure |
| Leak audit | same focused command | PASS | dropped cell collected under `--expose-gc`; retired episode left `liveBatchIds() === []` |
| Complete engine suite | `cd packages/signals-royale-sx2 && pnpm test` | PASS | 4 files, 192/192 tests |
| Real-React gate | `cd packages/react-signals-royale-sx2 && pnpm test` | PARTIAL | 2 files, 13/13 tests; all listed scenarios except a real-DOM CPU time-slice assertion are covered |
| Fork protocol and adjacent upstream suites | `cd vendor/react && yarn test --no-watchman ReactExternalSignals ReactTransition ReactFlushSync` | PASS | 5 suites; 48 passed, 1 upstream skip; own protocol suite 5/5 |
| Fork build | `./packages/react-signals-royale-sx2/build.sh` | PASS | NODE_DEV/NODE_PROD React, React DOM, and Scheduler bundles; `Built: 19.3.0 (d9034d1ca3)` |
| Formatting/diff | React `yarn prettier`; package Prettier; `git diff --check` | PASS | clean |
| Performance benchmarks | milomg and react-seam runners | NOT RUN | adapters are delivered, but no benchmark numbers are claimed |

Real output excerpts:

```text
Test Files  4 passed (4)
Tests       192 passed (192)

✓ tests/oracle.spec.ts > randomized replay oracle (300 seeds x 90 steps by default)
✓ tests/gc-leaks.spec.ts > dropped cells reclaim and retired episodes leave no live batches
Test Files  3 passed (3)
Tests       181 passed (181)
```

```text
Test Files  2 passed (2)
Tests       13 passed (13)
```

```text
PASS ReactExternalSignals-test.js
PASS ReactTransition-test.js
PASS ReactTransitionTracing-test.js
PASS ReactFlushSync-test.js
PASS ReactFlushSyncNoAggregateError-test.js
Test Suites: 5 passed, 5 total
Tests:       1 skipped, 48 passed, 49 total
```

The deterministic fork test `lets urgent work interrupt a lane-pinned correction` passes. I also attempted the required CPU time-slicing assertion with real `createRoot`; its pure-React control produced the same non-interrupting observation in this jsdom/Vitest setup, so I removed that inconclusive test instead of reporting it as a pass.

## LOC self-count

Fork production metric: **112** insertions + deletions.

```sh
git -C vendor/react diff --numstat e71a6393e6..HEAD -- packages ':!packages/*/src/__tests__*' \
  | awk '{a+=$1+$2} END {print a}'
```

Library metric: **1,261** nonblank, non-comment lines after Prettier `--print-width 100` normalization across both `src/` directories. The count streamed each normalized source file through an `awk` state machine that excludes blank lines, line comments, and block-comment-only lines.

## Feature coverage

- Writable signals, equality, labels: done.
- Lazy initialization at first materialization, including set-before-read: done; initialization is untracked and writes are rejected.
- Functional reducer replay: done; the `(1 + 1) × 2 = 4` schedule is pinned.
- Lazy cached computeds, dynamic dependency trimming, equality cutoff, exact pull behavior: done; 179-case suite passes.
- Effects, nested effect scopes, cleanup, and deterministic disposal: done.
- `batch`, `startBatch`, `endBatch`, and `untracked`: done.
- Observation-lifetime effects across computed, effect, and React subscribers: done; StrictMode netting is tested.
- Urgent/deferred write classification and draft invisibility: done through the fork protocol.
- Render-pass consistency and sibling no-tear behavior: done.
- Urgent-during-transition rebase and pruned-transition rollback: done and tested.
- Per-root committed views and one batch spanning two roots: done and tested.
- `flushSync` exclusion: done and tested.
- Quiescent episode reclamation and store-only transition retirement: done and tested.
- Canonical, latest, committed, isPending, and refresh read family: done.
- Pending/error graph state and parallel `useThenable` registration: done.
- Stable Suspense thenables, first-load suspension, stale refresh, and transition-owned settlement: done for the tested direct-use resource shape.
- React subscribing read with commit subscription and late-subscribe lane fixup: done.
- `useComputed`, `useSignalEffect`, `useCommitted`, `useIsPending`, transition helper, and component-owned atom: done.
- Loud rejection on stock React and write-during-render rejection: done.
- Multiple roots, StrictMode, and unmounted-subscriber cleanup: done.
- SSR serialization, keyed installation without lazy initialization, and matching first render: done.
- Causality tracer, bounded ring, overflow count, component/effect chains, render/commit events, and Suspense settlement: done.
- Exact DOM mutation window surfaced to userland: done; real `MutationObserver` test passes.
- CPU time-slicing responsiveness: protocol-level deterministic interruption passes; real-DOM CPU interruption remains unverified.

## Known gaps and honest risks

- The real-React suite does not claim the CPU-bound time-slicing scenario. The deterministic ReactNoop protocol test proves the lane-pinned correction is interruptible, but the jsdom control could not distinguish the same behavior using pure React state.
- No milomg or React seam benchmark was run, so the entry makes no performance ranking claim. Atom delivery is cell-local; computed render subscribers currently use conservative graph-wide invalidation.
- The async evaluator is strongest for direct `useThenable` resources. Arbitrary JavaScript that dereferences a value after a pending `useThenable` returns its placeholder, or creates new uncached promises inside a multi-read computation, remains a risk because JavaScript provides no resumable continuation at that call site.
- Store-only batches close in a binding microtask when no current subscriber claimed a root. A transition that both mounts its first-ever subscriber and writes the cell in the same event is the least-tested edge of that heuristic.
- The cross-entrant hidden battery, Daishi matrix, and benchmark runners were not available as executable registrations in this clone; their exact adapters are present but were not run here.

## What I would do with another day

First I would wire the delivered adapters into the shared battery and both benchmark runners, then promote a real-browser time-slicing test that has a trustworthy pure-React control. Next I would replace placeholder async evaluation with an explicit resource-loader API that can memoize arbitrary fetch factories and preserve transformed multi-read continuations without refetching. Finally I would make computed React subscriptions dependency-local and stress the first-subscriber/store-only schedule across multiple roots.

## Round 2

### Outcome

Round 2 closes the two largest Round 1 unknowns. The shared cross-entrant battery passes all 25 tests, including its real-DOM time-slicing scenario, and the required benchmark runners now execute against this entry. The battery initially exposed a real reducer-order bug: a transition `+1` followed by urgent `×2` retired as `3` instead of `4`. Atom histories now preserve global scheduling order across deferred and urgent operations; the corrected model is covered by the replay oracle and the shared scenarios.

Performance work fixed two structural costs without changing semantics. Dependency bookkeeping switches from array scans to a lazily allocated source set only above eight dependencies. More importantly, a computed that is first reached by an effect becomes observed before its first evaluation. This prevents a shared, deep lazy DAG from recursively revalidating the same unobserved ancestors. The 500-layer milomg case went from minutes in diagnostic runs to completing normally. React renders also read the live-lane bitmask without allocating temporary arrays. A larger single-cell batch specialization was measured, improved the write suite by only about 1.3%, and was removed because 35 production lines were not justified.

### Fresh gates

| Gate | Exact command | Result | Headline |
|---|---|---|---|
| Engine typecheck | `pnpm -C packages/signals-royale-sx2 typecheck` | PASS | strict `tsc --noEmit`, zero errors |
| React typecheck | `pnpm -C packages/react-signals-royale-sx2 typecheck` | PASS | strict `tsc --noEmit`, zero errors |
| Conformance | `pnpm -C packages/signals-royale-sx2 exec vitest run tests/conformance.spec.ts --reporter=verbose` | PASS | 179/179 |
| Oracle, default | `pnpm -C packages/signals-royale-sx2 exec vitest run tests/oracle.spec.ts --reporter=verbose` | PASS | 300 seeds × 90 steps |
| Oracle, 4× | `ORACLE_SEEDS=1200 pnpm -C packages/signals-royale-sx2 exec vitest run tests/oracle.spec.ts --reporter=verbose` | PASS | 1,200 seeds × 90 steps |
| Leak audit | `pnpm -C packages/signals-royale-sx2 exec vitest run tests/gc-leaks.spec.ts --reporter=verbose` | PASS | dropped cells reclaimed; no live retired episode |
| Complete engine suite | `pnpm -C packages/signals-royale-sx2 test` | PASS | 4 files, 193/193 |
| Fork protocol + adjacent suites | `yarn test --no-watchman ReactExternalSignals ReactTransition ReactFlushSync` in `vendor/react` | PASS | 5 suites; 48 passed, 1 upstream skip |
| Entrant real-React gate | `pnpm -C packages/react-signals-royale-sx2 test` | PASS | 2 files, 13/13 |
| Shared real-React battery | `pnpm typecheck && pnpm test` in `royale/verify-kit/battery` | PASS | typecheck clean; 25/25 scenarios |
| Fork build | `./packages/react-signals-royale-sx2/build.sh` | PASS | all NODE_DEV/NODE_PROD bundles; `d9034d1ca3` |
| Diff/patch hygiene | `git diff --check` in all three repositories; regenerated `patches/` | PASS | clean; four fork patches reproduced |

Real terminal output, in gate order:

```text
> signals-royale-sx2@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

> react-signals-royale-sx2@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json
```

```text
Test Files  1 passed (1)
Tests       179 passed (179)
Duration    548ms
```

```text
✓ randomized replay oracle (300 seeds x 90 steps by default) 390ms
Test Files  1 passed (1)
Tests       1 passed (1)

ORACLE_SEEDS=1200:
✓ randomized replay oracle (300 seeds x 90 steps by default) 1590ms
Test Files  1 passed (1)
Tests       1 passed (1)
```

```text
✓ dropped cells reclaim and retired episodes leave no live batches 56ms
Test Files  1 passed (1)
Tests       1 passed (1)
```

```text
PASS ReactTransitionTracing-test.js
PASS ReactTransition-test.js
PASS ReactFlushSync-test.js
PASS ReactExternalSignals-test.js
PASS ReactFlushSyncNoAggregateError-test.js
Test Suites: 5 passed, 5 total
Tests:       1 skipped, 48 passed, 49 total
```

```text
Test Files  2 passed (2)
Tests       13 passed (13)
```

```text
> royale-battery@0.0.0 typecheck
> tsc --noEmit -p tsconfig.json

Test Files  1 passed (1)
Tests       25 passed (25)
```

```text
Built: 19.3.0 (d9034d1ca3)
```

The shared battery is the stronger real-React matrix: all scenarios 1–18 pass, including urgent/deferred replay, pruning, multi-root state, Suspense, causality, mutation windows, SSR, and a CPU-bound transition interrupted by urgent work. There are no battery disputes.

### LOC recount

The shared counter reports **112 fork LOC** and **1,330 library LOC**:

```text
{
  "forkLoc": 112,
  "libLoc": 1330,
  "perFile": {
    "packages/react-reconciler/src/ReactFiberRootScheduler.js": 10,
    "packages/react-reconciler/src/ReactFiberWorkLoop.js": 100,
    "packages/react/src/ReactSharedInternalsClient.js": 2,
    "packages/signals-royale-sx2/src/index.ts": 1056,
    "packages/react-signals-royale-sx2/src/index.ts": 274
  }
}
```

Command:

```sh
node royale/verify-kit/count-loc.mjs \
  --fork vendor/react \
  --base e71a6393e66b0d2add46ba2b2c5db563a0563828 \
  --head royale/sx2-react \
  --lib packages/signals-royale-sx2 \
  --lib packages/react-signals-royale-sx2
```

### Milomg benchmark

Integration lives at benchmark commit `57f3a5c` on `royale/sx2-milomg`. The runner had to add `--platform=node` to the prescribed esbuild command because esbuild 0.28 otherwise rejected `node:child_process`, `node:url`, and `node:path`. The equivalent successful build was:

```sh
pnpm exec esbuild src/index.ts src/isolated.ts --bundle --platform=node \
  --format=esm --target=esnext --outdir=dist --sourcemap=external
node dist/isolated.js --rounds 3 "Royale SX2" "Alien Signals"
```

The table is the isolated runner's three-round per-suite median, in milliseconds:

| Suite | Royale SX2 | Alien Signals |
|---|---:|---:|
| createSignals | 49.26 | 2.46 |
| createComputations | 571.99 | 69.36 |
| updateSignals | 1,733.93 | 297.62 |
| avoidablePropagation | 283.21 | 114.50 |
| broadPropagation | 581.31 | 96.80 |
| deepPropagation | 172.81 | 40.36 |
| diamond | 330.76 | 94.10 |
| mux | 484.15 | 89.71 |
| repeatedObservers | 49.16 | 19.13 |
| triangle | 140.84 | 25.41 |
| unstable | 51.17 | 21.42 |
| molBench | 18.14 | 15.05 |
| cellx1000 | 45.08 | 4.17 |
| cellx2500 | 171.38 | 12.30 |
| 2-10x5 - lazy80% | 712.00 | 166.99 |
| 6-10x10 - dyn25% - lazy80% | 406.05 | 118.01 |
| 4-1000x12 - dyn5% | 981.42 | 287.42 |
| 25-1000x5 | 1,601.64 | 366.99 |
| 3-5x500 | 352.96 | 85.72 |
| 6-100x15 - dyn50% | 572.06 | 167.68 |
| **sum** | **9,309.32** | **2,095.20** |

Overall, sx2 is **4.443× Alien Signals** by summed suite time. This is an honest loss on raw core throughput: the async-cell engine carries replay histories, error/pending state, observation lifetimes, and a general correctness-oriented graph representation that Alien does not. The retained tuning removes pathological graph construction but does not pretend to erase that constant-factor cost.

`cleanup()` disposes the effect scope and clears its handle; the benchmark does not run a leaking sx2 variant. Its cleanup behavior is symmetric with the Alien adapter's scope disposal, so no leak-vs-no-leak shortcut contributes to these numbers.

Adapter sanity is green for sx2 itself:

```text
Tests  4 passed | 76 skipped (80)
```

The unfiltered upstream sanity command is **79/80**, with the sole failure in the pre-existing `x-reactivity | static graph, read 2/3 of leaves` row (`51` pulls vs its expected `41`). All four Royale SX2 rows and all Alien rows pass. I did not alter another framework's registration to paper over that unrelated failure.

The machine was shared with simultaneous contestant runs despite repeated attempts to find a quiet window. The final runner still alternated sx2 and Alien within each round and reports medians; these numbers are suitable as the requested paired measurement, not as a noise-free machine baseline.

### React seam benchmark

`bench/react-bench.mjs` uses jsdom, real timers, no `act`, the built sx2 React fork, and one child process per scenario/contender. The reference is a plain per-cell store using `useSyncExternalStore` with the same component trees. Raw stdout:

```csv
scenario,contender,stat,ms
fanout,sx2,median_write_commit,1.748
fanout,uses,median_write_commit,1.684
transition,sx2,p95_urgent_commit,40.035
transition,uses,p95_urgent_commit,47.936
mount,sx2,median_mount,53.662
mount,uses,median_mount,49.158
```

| Scenario | Statistic | SX2 | stock `useSyncExternalStore` | SX2 result |
|---|---|---:|---:|---:|
| fanout: 5,000 cells, 200 external writes | median write→commit | 1.748 ms | 1.684 ms | 3.8% slower |
| transition: 2,000 rewrites + 30 urgent inputs | p95 urgent→commit | 40.035 ms | 47.936 ms | **16.5% faster** |
| mount: 5,000-cell tree, 5 roots | median first commit | 53.662 ms | 49.158 ms | 9.2% slower |

The fork pays a modest subscription/mount tax but delivers the property it exists for: urgent React state commits faster while a large external-state transition is in flight. The fanout gap is within the noise seen across repeated shared-machine diagnostics; the exact retained run is reported rather than cherry-picked.

### Changes and adjudication notes

- Fixed urgent reducer replay by retaining deferred and urgent operations in one per-atom scheduling-order history. The oracle model now independently represents that history, and the shared battery's `(1 + 1) × 2 = 4` and branch-state cases pass.
- Made first effect observation precede a computed's initial evaluation, while refreshing only the outer tracked version afterward. This preserves stale-cache detection and computed self-write behavior (#179 and #191 both pass) and prevents shared lazy DAGs from explosive revalidation.
- Made high-fan-in dependency membership linear above eight sources without imposing a `Set` allocation on ordinary small computeds.
- Removed temporary live-lane array allocation from React render/mount paths by exposing a bitmask query.
- Added the isolated React benchmark and milomg adapter; regenerated the four fork patches. No React fork production source changed in Round 2, so fork LOC remains 112.
- Shared battery: no disputed tests. Benchmark tooling notes: the full milomg sanity failure is isolated to `x-reactivity`, and esbuild required the Node platform flag as documented above.

<oai-mem-citation>
<citation_entries>
MEMORY.md:240-248|note=[used benchmark contention guidance to reject overloaded attempts before retaining paired medians]
</citation_entries>
<rollout_ids>
019f261b-bb8a-72e1-9e2f-790108c371ee
</rollout_ids>
</oai-mem-citation>
