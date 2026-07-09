# Signals Royale SH1 Report

## 1. Design summary

SH1 is an operation-log software transactional memory: canonical atoms hold committed state, while each deferred React batch owns a compact write set. An urgent write updates canonical state and notifies canonical effects immediately. A deferred batch stays invisible until React renders lanes attributed to it, and a render reads the root's committed view plus exactly those transaction logs. Functional updates are replayed over the newest canonical base at retirement, which gives `(1 + 1) × 2 = 4` without copying whole worlds or rerunning user event bodies. The React patch is a 91-line protocol object with hooks at update scheduling, render entry/exit, root commit, and the host mutation phase. The binding maps lanes to transactions, pins settlement updates back to their original lane, and weakly keys all per-root episode state. Computeds retain the ordinary lazy push-pull graph for canonical work and evaluate transaction worlds directly, while pending promise reads form one stable joined thenable per world revision. At quiescence, transaction maps are empty, root maps are weak, and dropped top-level effect handles are finalized.

## 2. Gates

| Gate | Exact command | Result | Headline |
| --- | --- | --- | --- |
| Engine typecheck | `cd packages/signals-royale-sh1 && pnpm typecheck` | PASS | strict `tsc --noEmit` |
| React package typecheck | `cd packages/react-signals-royale-sh1 && pnpm typecheck` | PASS | strict `tsc --noEmit` |
| Engine conformance | `cd packages/signals-royale-sh1 && pnpm test -- --reporter=dot` | PASS | 179/179 conformance; 190/190 package tests |
| Randomized STM oracle | `ORACLE_SEEDS=300 ORACLE_LENGTH=90 pnpm vitest run tests/oracle.spec.ts` | PASS | 300 seeds × 90 steps; 3/3 tests including two pinned regressions |
| Engine feature specs | `pnpm vitest run tests/features.spec.ts` | PASS | 6/6: lazy, SSR, lifetime, parallel pending, tracing, quiescence |
| Real React | `cd packages/react-signals-royale-sh1 && pnpm test -- --reporter=dot` | PASS | 15/15; all 18 numbered scenarios covered |
| Fork protocol | `cd vendor/react && yarn test --no-watchman ReactSignalsRuntime` | PASS | 3/3 |
| Adjacent upstream React | `cd vendor/react && yarn test --no-watchman ReactIncrementalUpdates ReactTransition ReactFlushSync` | PASS | 62 passed, 1 skipped, 6 suites |
| Leak audit | `cd packages/signals-royale-sh1 && pnpm vitest run tests/gc-leaks.spec.ts` | PASS | 2/2; dropped computed and dropped effect disposer reclaimed under exposed GC |
| Pristine patch/build | `cd packages/react-signals-royale-sh1 && ./build.sh` | PASS | 3 patches applied to `e71a6393e6`; NODE_DEV and NODE_PROD bundles built |
| Diff hygiene | `git diff --check` in both repositories | PASS | no whitespace errors |

Real output excerpts:

```text
Test Files  4 passed (4)
Tests       190 passed (190)
✓ tests/conformance.spec.ts (179 tests)
✓ tests/oracle.spec.ts (3 tests)
✓ tests/gc-leaks.spec.ts (2 tests)
```

```text
✓ tests/real-react.spec.tsx (15 tests) 297ms
Test Files  1 passed (1)
Tests       15 passed (15)
```

```text
PASS packages/react-reconciler/src/__tests__/ReactSignalsRuntime-test.js
Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
```

```text
Test Suites: 6 passed, 6 total
Tests:       1 skipped, 62 passed, 63 total
```

```text
Applying: Add minimal transactional signals protocol
Applying: Test and complete signals commit protocol
Applying: Make signals protocol closure-safe
COMPLETE  react.production.js (node_prod)
COMPLETE  react-dom-client.production.js (node_prod)
Built: 19.3.0 (4af800fe95)
```

## 3. LOC self-count

React fork metric: **91** insertions + deletions.

```sh
git -C vendor/react diff --numstat e71a6393e6..HEAD -- \
  packages/ ':!packages/*/src/__tests__*' |
  awk '{a+=$1+$2} END {print a}'
# 91
```

Library metric: **1075** nonblank, non-comment lines across the two `src/` trees after formatting at width 100.

```sh
vendor/react/node_modules/.bin/prettier --write --print-width=100 \
  packages/signals-royale-sh1/src packages/react-signals-royale-sh1/src
awk 'BEGIN{b=0} b{if(/\*\//)b=0;next} /^[[:space:]]*\/\*/{if(!/\*\//)b=1;next} \
  /^[[:space:]]*\/\// || /^[[:space:]]*$/{next} {n++} END{print n}' \
  packages/signals-royale-sh1/src/index.ts \
  packages/react-signals-royale-sh1/src/index.ts
# 1075
```

## 4. Feature coverage

- Writable atoms, custom equality, labels, and lazy initialization: **done**; set-before-read and write-forbidden initializer cases are pinned.
- Functional update replay: **done**; urgent/deferred `(1 + 1) × 2 = 4` and branch `2 → 6` are pinned.
- Lazy computed graph, equality cutoff, dynamic dependency trimming, and exact pull behavior: **done**; 179/179 conformance.
- Effects, cleanup, scopes, batching, and untracked reads: **done**.
- Observed-lifetime effects across computed, effect, and React subscribers: **done**; microtask cleanup coalesces StrictMode flaps.
- Urgent/deferred classification and invisible drafts: **done**.
- Render-pass consistency and sibling non-tearing: **done**; a render receives one immutable transaction list from the fork.
- Urgent-during-transition, rebase, and abandoned-root rollback: **done**; pruned lanes abort when no root landed the transaction.
- Per-root committed views and multi-root batches: **done**.
- `flushSync` exclusion of deferred work: **done**.
- Quiescent episode reclamation: **done**; transaction/lane maps empty and root state is weakly keyed.
- Canonical, latest, committed, pending, and refresh read family: **done**; latest/committed never suspend.
- Parallel pending graph state and stable error/thenable identity: **done** for tested stable resources; pending retries reuse one joined thenable without re-evaluating the computed.
- Suspense stale-vs-suspend boundary rule: **done**; initial load falls back, refresh serves stale, transition render suspends.
- Latest-wins refresh and transaction-owned settlement: **done**.
- React subscribing read, computed, signal effect, committed, pending, transition, and component atom hooks: **done**.
- Post-subscribe fixup, loud stock-React failure, write-during-render failure, and unmount cleanup: **done**.
- SSR keyed serialization and initializer-free installation: **done**.
- Causality tracer, causal-chain formatting, attach/detach, and bounded ring overflow: **done**.
- Exact DOM mutation window with a disconnecting `MutationObserver`: **done**.
- Dropped-handle reclamation: **done** for top-level effects through `FinalizationRegistry`; component and computed handles have no global owner after disposal.

## 5. Known gaps and honest risks

- Round 2 supersedes the original benchmark and shared-battery availability notes; both are measured below.
- Render-pass discard tracing is inferred when a root starts a different lane set; a pass abandoned without any later render or commit may not emit its discard event until the root becomes active again.
- A computed that literally creates a brand-new network promise inside every evaluation can start one extra request when it re-evaluates after settlement; pending retries themselves are cached and do not re-evaluate. Applications should create or key-cache the resource promise outside the computed body.

## 6. What I would do with another day

I would add keyed async resource slots so inline promise factories cannot start the post-settlement extra request, profile the remaining wide-graph and single-cell delivery cost, and fuzz multi-root prune/commit races with suspended passes. After that, I would split world-only computed evaluation from the canonical class to recover some of the Round 2 library LOC without touching the 91-line fork.

## 7. Round 2

### Final verification

All entry-owned gates pass on the final formatted code and rebuilt fork.

| Gate | Exact command | Result | Real headline output |
| --- | --- | --- | --- |
| Engine typecheck | `cd packages/signals-royale-sh1 && pnpm typecheck` | PASS | `tsc --noEmit`, exit 0 |
| React typecheck | `pnpm --dir packages/react-signals-royale-sh1 typecheck` | PASS | `tsc --noEmit`, exit 0 |
| Conformance | `pnpm vitest run tests/conformance.spec.ts --reporter=dot` | PASS | `179 passed (179)`, 14 ms |
| Oracle, default | `ORACLE_SEEDS=300 ORACLE_LENGTH=90 pnpm vitest run tests/oracle.spec.ts --reporter=verbose` | PASS | 3/3; `300 seeds x 90 steps`, 22 ms |
| Oracle, deep | `ORACLE_SEEDS=1200 ORACLE_LENGTH=90 pnpm vitest run tests/oracle.spec.ts --reporter=verbose` | PASS | 3/3; `1200 seeds x 90 steps`, 55 ms |
| Leak audit | `pnpm vitest run tests/gc-leaks.spec.ts --reporter=verbose` | PASS | 2/2; dropped computed 28 ms, dropped effect disposer 5 ms |
| Full engine package | `pnpm test -- --reporter=dot` | PASS | 4 files; 190/190 tests |
| Fork protocol | `cd vendor/react && yarn test --no-watchman ReactSignalsRuntime` | PASS | 1 suite; 3/3 tests |
| Adjacent React | `yarn test --no-watchman ReactIncrementalUpdates ReactTransition ReactFlushSync` | PASS | 6 suites; 62 passed, 1 skipped |
| Fork build | `./fork/build-react.sh` | PASS | all NODE_DEV/NODE_PROD bundles; `Built: 19.3.0 (7944cbad7a)` |
| Own real React | `pnpm vitest run tests/real-react.spec.tsx --reporter=verbose` | PASS | 15/15; 297 ms; time-slicing case 262 ms |
| Shared battery | `cd royale/verify-kit/battery && pnpm test` | PASS | 25/25; 264 ms |
| Diff hygiene | `git diff --check` and `git -C vendor/react diff --check` | PASS | no output |

Representative final output:

```text
Test Files  1 passed (1)
Tests       179 passed (179)

matches a memo-free operation-log model for 300 seeds x 90 steps 22ms
matches a memo-free operation-log model for 1200 seeds x 90 steps 55ms

Test Files  4 passed (4)
Tests       190 passed (190)
```

```text
PASS packages/react-reconciler/src/__tests__/ReactSignalsRuntime-test.js
Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total

Test Suites: 6 passed, 6 total
Tests:       1 skipped, 62 passed, 63 total
```

```text
Test Files  1 passed (1)
Tests       15 passed (15)

Test Files  1 passed (1)
Tests       25 passed (25)
```

The shared battery initially found five genuine gaps: pending atoms were not flip-visible, urgent/deferred updater replay was ordered incorrectly for root-owned transactions, a mid-transition mount could miss retirement, branch state could expose an intermediate frame, and the resulting causality check failed. The final engine retains a transaction base, deferred write set, and urgent rebase set; root-owned worlds fold them in React's required order and retirement emits one targeted delivery. Direct engine transactions retain the oracle's replay-on-current-base behavior. The final shared result is 25/25, with no disputed tests.

### milomg js-reactivity-benchmark

The adapter is committed in the benchmark clone and its cleanup disposes the enclosing effect scope. The focused pull-count sanity gate passes all four SH1 cases:

```text
pnpm -C packages/core exec vitest run src/frameworks.test.ts -t "Royale SH1" --reporter=verbose
Test Files  1 passed (1)
Tests       4 passed | 76 skipped (80)
```

The requested unfiltered `pnpm -C packages/core test -- --run` is honestly **79/80**, because the pre-existing `x-reactivity | static graph, read 2/3 of leaves` case reports pull count 51 instead of 41. Every Royale SH1 case passes, including the exact-pull cases; I did not change or mask the unrelated framework failure.

Final isolated command:

```sh
cd milomg-reactivity-benchmark/packages/node
pnpm exec esbuild src/index.ts src/isolated.ts --bundle --platform=node \
  --format=esm --target=esnext --outdir=dist --sourcemap=external
node dist/isolated.js --rounds 3 "Royale SH1" "Alien Signals"
```

The documented esbuild line omitted `--platform=node`; without it esbuild rejects the runner's `node:` imports. The added flag only makes the documented runner buildable and does not change benchmark code or timing.

| Suite (median ms, 3 isolated rounds) | Royale SH1 | Alien Signals |
| --- | ---: | ---: |
| createSignals | 9.74 | 2.45 |
| createComputations | 309.52 | 80.81 |
| updateSignals | 1177.81 | 273.52 |
| avoidablePropagation | 212.28 | 108.71 |
| broadPropagation | 396.16 | 83.32 |
| deepPropagation | 107.05 | 32.72 |
| diamond | 239.34 | 86.22 |
| mux | 240.66 | 83.83 |
| repeatedObservers | 24.95 | 18.92 |
| triangle | 81.27 | 23.09 |
| unstable | 33.01 | 20.00 |
| molBench | 14.63 | 14.23 |
| cellx1000 | 35.85 | 3.62 |
| cellx2500 | 109.46 | 12.32 |
| 2-10x5 - lazy80% | 614.47 | 160.41 |
| 6-10x10 - dyn25% - lazy80% | 432.66 | 105.03 |
| 4-1000x12 - dyn5% | 950.51 | 272.39 |
| 25-1000x5 | 1764.33 | 336.89 |
| 3-5x500 | 335.84 | 78.95 |
| 6-100x15 - dyn50% | 591.27 | 156.12 |
| **sum / ratio** | **7680.81** | **1953.55** |

Overall SH1 is **3.932× Alien** by the sum of per-suite medians. The first integrated run was 10139.17 vs 1954.93, or 5.186×, so tuning reduced the ratio by 24.2%. Both adapters dispose their effect scopes after each graph; there is no known leak-vs-no-leak asymmetry. SH1 remains substantially slower than Alien, especially in large update and fan-in/fan-out graphs, and this report does not present the improvement as parity.

### React seam benchmark

`bench/react-bench.mjs` uses jsdom, real timers, no `act`, the built SH1 React fork, one scenario per child process, and the same component shapes for SH1 and a local plain-store `useSyncExternalStore` contender. The final command was `pnpm exec tsx bench/react-bench.mjs`.

| Scenario | Statistic | SH1 | stock `useSyncExternalStore` |
| --- | --- | ---: | ---: |
| fanout: 5000 cells, 200 single-cell writes | median write→commit | 1.73 ms | 1.47 ms |
| transition: 2000 rewritten cells, 30 urgent inputs | p95 urgent→commit | 27.70 ms | 29.70 ms |
| mount: 5000-cell tree, 5 fresh roots | median mount→first commit | 50.02 ms | 54.21 ms |

SH1 is 17.7% slower on isolated single-cell fanout, 6.7% faster on transition urgent p95, and 7.7% faster on mount in this run. These are single machine-sharing runs of internally sampled medians/p95s, not confidence intervals.

### Round 2 tuning and size

- Replaced quadratic dependency collection/diff scans with a small-list fast path that promotes to a `Set` at eight dependencies. This keeps common one-to-four-edge computations allocation-light while bounding wide-graph lookup cost.
- Replaced repeated `Set.values().next()` child disposal, which rescanned tombstones and made 100k-effect cleanup quadratic, with one mutation-safe `for...of` traversal.
- Replaced the binding's all-component broadcast with exact per-cell subscriptions for canonical writes and targeted transaction delivery; computed readers remain covered when a draft atom changes. Subscription effects no longer tear down and recreate solely because the global version advanced.
- Added explicit root-owned write/rebase sets, cheap pending-atom detection, pending-transaction enrollment for late mounts, and a targeted retirement flip. This is both the shared-battery correctness fix and the mechanism that avoids a second global fanout.
- Regenerated the three React patch files from the unchanged 91-line fork history.

Final LOC was measured with the shared counter:

```sh
node royale/verify-kit/count-loc.mjs \
  --fork vendor/react --base e71a6393e66b0d2add46ba2b2c5db563a0563828 \
  --head royale/sh1-react \
  --lib packages/signals-royale-sh1 --lib packages/react-signals-royale-sh1
```

```text
forkLoc: 91
libLoc: 1208
```

The fork remains **91 LOC**. Library LOC is **1208** (891 engine + 317 binding), up from 1075 in Round 1; the 133-line increase buys the verified rebase/pending/late-mount semantics and targeted delivery path. The benchmark driver and adapters are outside the ranked `src/` metric.

### Judgement fixes

The three flagged behaviors now live in the shipped engine/bindings and the verification adapter is pure wiring:

- `Atom.set()` and `Atom.update()` consult a render-state probe installed by the React bindings and throw `Signals cannot be written during render`. The regression invokes `value.set(1)` directly inside a component; `royale/adapter.ts` no longer checks `protocol.world()` in `set` or `update`.
- Plain `flushSync` imported from `react-dom` now brackets the registered signal runtime through a three-line fork hook. The binding converts that hook into the engine's urgent-rebase scope. The regression imports `flushSync` directly from `react-dom`; the adapter now exports the same function unchanged and contains no ordering composition.
- Engine `latest()` now preserves an active computation's world instead of reading ambient newest intent. Binding `latest()` enters the fork-provided render world when called during render. New regressions cover canonical versus transactional computed evaluation and an urgent render mounted while a newer transition world is suspended; direct-render and nested-computed reads show `0:0`, then the transition shows `1:1`.

Fresh final outputs after a pristine four-patch rebuild:

| Gate | Exact command | Result | Fresh headline |
| --- | --- | --- | --- |
| Engine typecheck | `cd packages/signals-royale-sh1 && pnpm typecheck` | PASS | `tsc --noEmit`, exit 0 |
| React typecheck | `cd packages/react-signals-royale-sh1 && pnpm typecheck` | PASS | `tsc --noEmit`, exit 0 |
| Engine suite | `cd packages/signals-royale-sh1 && pnpm test -- --reporter=dot` | PASS | 4 files; **191/191** tests, including 179/179 conformance |
| Pristine patch build | `cd packages/react-signals-royale-sh1 && ./build.sh` | PASS | 4 patches applied; all NODE_DEV/NODE_PROD bundles; `Built: 19.3.0 (f30beef0bf)` |
| Real React | `pnpm vitest run tests/real-react.spec.tsx --reporter=verbose` | PASS | **16/16**, 297 ms; contextual `latest` 2 ms; direct render-write rejection 2 ms |
| Shared battery | `cd royale/verify-kit/battery && pnpm test` | PASS | **25/25**, 263 ms |
| Affected fork suites | `yarn test --no-watchman ReactSignalsRuntime ReactFlushSync ReactFlushSyncNoAggregateError` | PASS | 3 suites; **12/12** tests |
| Diff hygiene | `git diff --check` in the superproject and React fork | PASS | no output |

```text
✓ tests/features.spec.ts (7 tests)
✓ tests/oracle.spec.ts (3 tests)
✓ tests/gc-leaks.spec.ts (2 tests)
✓ tests/conformance.spec.ts (179 tests)
Test Files  4 passed (4)
Tests       191 passed (191)
```

```text
✓ latest inside a render and nested computed resolves that render's world
✓ suspended transition stays hidden, urgent work commits, then functional updates rebase
✓ writes during render fail loudly
Test Files  1 passed (1)
Tests       16 passed (16)

Test Files  1 passed (1)
Tests       25 passed (25)
```

The regenerated patch series now contains four patches; the added fork patch is `0004-Expose-flushSync-scopes-to-signal-runtimes.patch`. The shared LOC counter reports:

```text
forkLoc: 94
libLoc: 1217
```

That is **+3 fork LOC** and **+9 library LOC** versus the verified Round 2 entry. Current per-source totals are 892 engine LOC and 325 binding LOC. These figures supersede the earlier 91/1208 Round 2 count.
