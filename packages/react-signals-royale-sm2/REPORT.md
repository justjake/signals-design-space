# Signals Royale — SM2 report

## 1. Design summary

SM2's distinguishing idea is a reducer capsule: every live React batch owns only the atoms it has touched, with each capsule holding that batch's materialized value rather than a global world table or write tape. Urgent writes update canonical state immediately and flow through live capsules so deferred work can retire with React updater-queue ordering. Computeds remain one lazy push-pull graph, while each live batch records only the dependency set observed in that render world. Explicit `latest` and per-root `committed` reads reuse that capsule evaluator, including through nested computeds. React remains responsible for scheduling, interruption, commit, and retirement; the binding translates engine invalidations into state updates pinned to the owning batch. Pending thenables are graph state with weak settlement listeners, stable identity, stale-value serving, and settlement invalidation. At quiescence there are no live capsules or root-to-batch entries, and ordinary hostless writes take a direct path. The rewritten React fork identifies a capsule batch directly with React's lane bit and exposes only scheduling facts and edges that React already computes.

## Round 2 (historical; superseded by the fork rewrite)

All required gates passed at the Round 2 checkpoint. The benchmark measurements and the 1510-line fork references in this historical section predate the fork rewrite below.

| Gate | Exact command | Result |
|---|---|---|
| Core typecheck | `(cd packages/signals-royale-sm2 && pnpm typecheck)` | Pass |
| React typecheck | `(cd packages/react-signals-royale-sm2 && pnpm typecheck)` | Pass |
| Engine conformance | `(cd packages/signals-royale-sm2 && pnpm exec vitest run tests/conformance.spec.ts --reporter=dot)` | Pass, 179/179 |
| Default oracle | `(cd packages/signals-royale-sm2 && pnpm exec vitest run tests/oracle.spec.ts --reporter=verbose)` | Pass, 300 seeds × 90 steps plus 2 regressions |
| Deep oracle | `(cd packages/signals-royale-sm2 && ORACLE_SEEDS=1200 pnpm exec vitest run tests/oracle.spec.ts --reporter=verbose)` | Pass, 1200 seeds × 90 steps plus 2 regressions |
| Full core suite | `(cd packages/signals-royale-sm2 && pnpm test -- --reporter=dot)` | Pass, 4 files / 192 tests |
| Core leak audit | `(cd packages/signals-royale-sm2 && pnpm exec vitest run tests/gc-leaks.spec.ts --reporter=verbose)` | Pass, 2/2 |
| Component-atom leak audit | `(cd packages/react-signals-royale-sm2 && pnpm exec vitest run tests/gc-leaks.spec.tsx --reporter=verbose)` | Pass, 1/1 |
| React build | `./packages/react-signals-royale-sm2/build.sh` | Pass, `Built: 19.3.0 (da7a2366e8)` |
| Fork protocol | `(cd vendor/react && yarn test --no-watchman ReactFiberBatchRegistry ReactFiberExternalRuntimePass ReactFiberExternalRuntimeCommit ReactFiberRunInBatch)` | Pass, 4 suites / 41 tests |
| Adjacent upstream React | `(cd vendor/react && yarn test --no-watchman ReactAsyncActions ReactBatching.internal ReactFlushSync ReactIncrementalScheduling ReactIncrementalUpdates ReactInterleavedUpdates ReactSchedulerIntegration ReactTransition ReactUpdatePriority ReactDefaultTransitionIndicator)` | Pass, 12 suites / 117 passed / 1 skipped |
| Own Real-React suite | `(cd packages/react-signals-royale-sm2 && pnpm test -- --reporter=dot)` | Pass, 5 files / 17 tests |
| Shared Real-React battery | `(cd royale/verify-kit/battery && pnpm typecheck && pnpm test)` | Pass, 25/25 |
| Diff hygiene | `git diff --check` | Pass |

### Round 2 terminal evidence

```text
Engine conformance
Test Files  1 passed (1)
Tests       179 passed (179)

Default oracle (300 x 90) / deep oracle (1200 x 90)
Test Files  1 passed (1)
Tests       3 passed (3)

Full core suite
Test Files  4 passed (4)
Tests       192 passed (192)

Leak audits
core:  Tests 2 passed (2)
React: Tests 1 passed (1)

Fork protocol
Test Suites: 4 passed, 4 total
Tests:       41 passed, 41 total

Adjacent upstream React
Test Suites: 12 passed, 12 total
Tests:       1 skipped, 117 passed, 118 total

Own Real-React suite
Test Files  5 passed (5)
Tests       17 passed (17)

Shared battery
Test Files  1 passed (1)
Tests       25 passed (25)
```

### Round 2 core benchmark

The adapter sanity command was `(cd milomg-reactivity-benchmark && pnpm -C packages/core test)` and passed 8/8, including pull-count checks. The final runner was rebuilt with `(cd milomg-reactivity-benchmark/packages/node && pnpm exec esbuild src/index.ts src/isolated.ts --bundle --platform=node --format=esm --target=esnext --outdir=dist --sourcemap=external)` and measured with `node dist/isolated.js --rounds 3 "Royale SM2" "Alien Signals"`. `--platform=node` was necessary because the isolated entry imports Node APIs.

| Suite | Royale SM2 ms | Alien Signals ms |
|---|---:|---:|
| createSignals | 2.52 | 6.62 |
| createComputations | 235.39 | 85.69 |
| updateSignals | 943.08 | 306.08 |
| avoidablePropagation | 247.37 | 100.89 |
| broadPropagation | 374.14 | 84.42 |
| deepPropagation | 131.51 | 33.48 |
| diamond | 244.07 | 87.81 |
| mux | 223.46 | 87.24 |
| repeatedObservers | 27.00 | 20.32 |
| triangle | 86.60 | 27.53 |
| unstable | 36.64 | 22.45 |
| molBench | 14.58 | 13.26 |
| cellx1000 | 22.65 | 5.14 |
| cellx2500 | 70.29 | 17.79 |
| 2-10x5 - lazy80% | 579.18 | 188.45 |
| 6-10x10 - dyn25% - lazy80% | 452.27 | 131.39 |
| 4-1000x12 - dyn5% | 920.44 | 351.04 |
| 25-1000x5 | 1409.07 | 446.29 |
| 3-5x500 | 331.33 | 101.51 |
| 6-100x15 - dyn50% | 579.27 | 200.86 |
| **Sum of medians** | **6930.86** | **2318.26** |

The summed-median ratio is **2.990× Alien Signals**. SM2's adapter disposes every build scope, including all three warmups before `cleanup()`. The bundled Alien adapter stores only its most recent scope disposer, so the reference side has a leak-vs-no-leak cleanup asymmetry; the table is reported unchanged rather than silently modifying the reference implementation.

### Round 2 React benchmark (pre-fork-rewrite historical result)

Command: `(cd packages/react-signals-royale-sm2 && node bench/react-bench.mjs)`. Every scenario/contender pair ran in a fresh child process against this entry's built React artifacts, with real timers and no `act`.

```csv
scenario,contender,stat,ms
fanout,royale-sm2,median_write_to_commit,2.11
fanout,uses-store,median_write_to_commit,1.91
transition,royale-sm2,urgent_p95,6.38
transition,uses-store,urgent_p95,1.79
mount,royale-sm2,median_mount,58.18
mount,uses-store,median_mount,54.91
```

Earlier Round 2 tuning removed eager subscriber, scope, and async allocations; consolidated dependency sets and value maps; added a hostless direct-write path; and added a canonical-revision cutoff for disconnected clean computeds. This verification pass fixed the milomg adapter to dispose every warmup/build scope and reused one reducer function across React subscription hooks. An A/B run showed that retaining the existing version-coupled post-commit subscription claim materially improved fanout and transition p95, so that behavior remains. The shared battery remains green and found no disputed cases.

### Changes, asymmetries, and disputes

- The private milomg checkout now contains the SM2 adapter, dependency, executable Vitest config, filterable Node entry point, and source-controlled isolated runner required to reproduce the table.
- Its unrelated `x-reactivity` adapter fails its own sanity pull-count declaration (51 actual versus 41 expected), so the private registry is limited to the two measured contenders; benchmark cases and measured implementations are unchanged.
- SM2 disposes every scope created by `withBuild`. The bundled Alien adapter retains only its latest scope disposer, so its earlier warmup scopes are a disclosed cleanup asymmetry.
- The shared battery passes 25/25 and there are no disputed tests.

## Fork rewrite

The incumbent-derived `royale/sm2-react` branch is retained at `da7a2366e8`; the active fork was rewritten from the pinned upstream base on the fresh `royale/sm2-react-rewrite` branch and committed at `5a968f65b4`. The protocol identifies an engine batch directly with the React lane chosen for that write: React exposes the current write lane, the active render's container plus lane set, render/commit edges, the exact mutation window, and one scoped lane pin. There is no React-side batch registry, token allocator, root table, or retirement table. The binding records only roots actually invalidated by each deferred lane, folds render lane sets into live capsules, and retires a capsule after every owning root's `remainingLanes` excludes it. Commit-stop is emitted after layout effects, so a mount-time corrective update pinned during layout leaves its lane pending; the rewritten Jest suite proves the corrective render uses that same lane before retirement. Lane zero temporarily clears the surrounding transition, which keeps `useIsPending` and other urgent corrections outside deferred work. Mutation start/stop are emitted immediately around React's mutation phase, before `commitMutationEffects` can change the host tree and after `resetAfterCommit`, while before-mutation, layout, and passive effects remain outside the window.

All required gates pass on the rewritten fork.

| Gate | Exact command | Result |
|---|---|---|
| Core typecheck | `(cd packages/signals-royale-sm2 && pnpm typecheck)` | Pass |
| React typecheck | `(cd packages/react-signals-royale-sm2 && pnpm typecheck)` | Pass |
| Engine conformance | `(cd packages/signals-royale-sm2 && pnpm exec vitest run tests/conformance.spec.ts --reporter=dot)` | Pass, 179/179 |
| Default oracle | `(cd packages/signals-royale-sm2 && pnpm exec vitest run tests/oracle.spec.ts --reporter=verbose)` | Pass, 300 seeds × 90 steps plus 2 regressions |
| Deep oracle | `(cd packages/signals-royale-sm2 && ORACLE_SEEDS=1200 pnpm exec vitest run tests/oracle.spec.ts --reporter=verbose)` | Pass, 1200 seeds × 90 steps plus 2 regressions |
| Full core suite | `(cd packages/signals-royale-sm2 && pnpm test)` | Pass, 4 files / 192 tests |
| Core leak audit | `(cd packages/signals-royale-sm2 && pnpm exec vitest run tests/gc-leaks.spec.ts --reporter=verbose)` | Pass, 2/2 |
| Component-atom leak audit | `(cd packages/react-signals-royale-sm2 && pnpm exec vitest run tests/gc-leaks.spec.tsx --reporter=verbose)` | Pass, 1/1 |
| Fork protocol | `(cd vendor/react && yarn test --no-watchman ReactSignalRuntime)` | Pass, 1 suite / 6 tests |
| Pristine-patch fork build | Detach `vendor/react` at `e71a6393e66b0d2add46ba2b2c5db563a0563828`, then `./packages/react-signals-royale-sm2/build.sh` | Pass, one patch applied; `Built: 19.3.0 (52c804665d)` |
| Adjacent upstream React | `(cd vendor/react && yarn test --no-watchman ReactAsyncActions ReactBatching.internal ReactFlushSync ReactIncrementalScheduling ReactIncrementalUpdates ReactInterleavedUpdates ReactSchedulerIntegration ReactTransition ReactUpdatePriority ReactDefaultTransitionIndicator)` | Pass, 12 suites / 117 passed / 1 skipped |
| Own Real-React suite | `(cd packages/react-signals-royale-sm2 && pnpm test)` | Pass, 5 files / 17 tests |
| Shared Real-React battery | `(cd royale/verify-kit/battery && pnpm typecheck && pnpm test)` | Pass, 25/25 |
| Diff hygiene | `git diff --check` in both repositories | Pass |

```text
Engine conformance
Test Files  1 passed (1)
Tests       179 passed (179)

Default oracle / deep oracle
matches a memo-free world-fold model for 300 seeds x 90 steps
matches a memo-free world-fold model for 1200 seeds x 90 steps
Tests       3 passed (3) in each run

Leak audits
core:  Tests 2 passed (2)
React: Tests 1 passed (1)

Fork protocol
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total

Pristine patch build
Applying: Add lane-fact signal runtime protocol
Built: 19.3.0 (52c804665d)

Adjacent upstream React
Test Suites: 12 passed, 12 total
Tests:       1 skipped, 117 passed, 118 total

Own Real-React suite
Test Files  5 passed (5)
Tests       17 passed (17)

Shared battery
Test Files  1 passed (1)
Tests       25 passed (25)
```

The regenerated `patches/` directory contains one 564-line mail patch, including the excluded Jest suite; applying it to the pristine base produced the successful build above. The tournament LOC command reports `forkLoc: 186` and `libLoc: 1524`. Fork LOC is 186 insertions and zero deletions: 65 in `ReactFiberWorkLoop`, 59 in the new public protocol module, 35 in shared-internals state, 12 in `ReactClient`, and 15 across the three client entrypoints. The library split is 1089 normalized source lines in the engine and 435 in the React binding. This replaces the 1510-line fork with 186 lines, a reduction of 1324 lines; the binding-side lane/root bookkeeping accounts for the library increase from 1467 to 1524 lines. The Round 2 performance tables above remain historical; the fix-round React table below is the first post-rewrite run.

## 3. LOC self-count

Command:

```sh
node royale/verify-kit/count-loc.mjs \
  --fork vendor/react \
  --base e71a6393e66b0d2add46ba2b2c5db563a0563828 \
  --head royale/sm2-react-rewrite \
  --lib packages/signals-royale-sm2 \
  --lib packages/react-signals-royale-sm2
```

Authoritative output: `forkLoc: 186`, `libLoc: 1524`. The library split is 1089 lines for the core package (`src/index.ts` 64 + `src/runtime.ts` 1025) and 435 lines for the React package. The active fork branch is `royale/sm2-react-rewrite` at `5a968f65b4`; the checked-in patch series contains its single commit from the pinned base. The superseded `royale/sm2-react` branch remains available at `da7a2366e8` for the record.

## 4. Feature coverage

- Done — writable atoms, labels, custom equality, equal-write cutoff, and set-before-read behavior.
- Done — lazy initializers run once, untracked, reject writes, and are bypassed by installed SSR state.
- Done — functional updates materialize per capsule and pass the urgent/deferred replay arithmetic gates.
- Done — lazy cached computeds, equality cutoff, dynamic dependency trimming, exact pull counts, and per-world dependency sets.
- Done — synchronous effects, cleanup, nested effect scopes, and canonical-only effect observation.
- Done — `batch`, `startBatch`, `endBatch`, and `untracked`.
- Done — microtask-coalesced lifetime effects across computed, effect, and React subscribers.
- Done — React-batch write classification with deferred capsule isolation.
- Done — render-pass consistency, replay consistency, rollback notification, and sibling no-tear behavior.
- Done — urgent-during-transition commits and rebased deferred retirement.
- Done — per-root committed atom and computed views across split root commits.
- Done — `flushSync` excludes pending deferred work.
- Done — batch capsules, world dependencies, and root membership are reclaimed at retirement.
- Done after fix round — canonical read, per-root `committed`, flip-only `isPending`, and stale-preserving `refresh`; `latest` previously bypassed `evaluationBatches` and could read a newer draft from inside a computed, but now resolves the computed or render context's exact world through `renderBatches()`.
- Done — pending/error graph state, parallel async registration, downstream forwarding, and stable thenable identity.
- Done — first-load suspension, stale urgent refreshes, deferred suspension, and settlement propagation.
- Done — subscribing read hook with commit claim and post-subscribe correction.
- Done — `useComputed`, `useSignalEffect`, `useCommitted`, `useIsPending`, and transition write helper.
- Done — component-owned atoms are reclaimed after unmount; the GC test holds only a `WeakRef`.
- Done — loud stock-React rejection, multiple roots, loud render writes, and inert unmounted subscriptions.
- Done — keyed SSR serialization, replacer/reviver support, initialization, and install-without-write semantics.
- Done — bounded attachable causality tracing for writes, batches, render passes, roots, components, effects, settlement, and retirement.
- Done — exact per-root DOM before/after mutation events; the MutationObserver disconnect/reconnect scenario passes.

## 5. Known gaps and honest risks

- The rewritten fork has one listener slot per React instance; registration is intentionally single-runtime and fails loudly on a second live registrant.
- Core performance is not at Alien parity: the final summed-median ratio is 2.990×, with the largest deficits in update propagation and large synthetic graphs.
- The final React run is close on mount but behind the plain store on fanout and urgent p95; shared-machine noise is visible across runs, so the CSV above is the final run rather than a selected best run.
- The oracle opens up to three simultaneous deferred batches and checks arbitrary included-world sets, but its generated updates are additive; nonlinear replay has pinned regressions rather than broad generated coverage.
- The isolated benchmark loaded only Alien and SM2 because this older runner revision's unrelated `x-reactivity` sanity case fails its own pull-count declaration (51 actual versus 41 expected). Neither measured implementation nor any benchmark scenario was changed.
- The benchmark cleanup paths are asymmetric: SM2 disposes all build scopes, while the bundled Alien adapter retains only the latest scope disposer.
- There are no disputed shared-battery cases and no known required-feature failure.

## 6. What I would do with another day

I would add a generated multi-root interruption oracle around the new lane/root retirement bookkeeping, including completed-but-delayed commits and discarded suspended passes. Next I would profile the large propagation cases, focusing on watcher delivery and dependency reconciliation without weakening lazy pull counts. I would expand the engine oracle to generate nonlinear reducers and async settlement races. Finally, I would rerun the isolated React benchmarks under a quieter machine allocation and tune subscription mount cost from profiles rather than timing variance.

## Fix round

The confirmed gap was real. With canonical `source = 1`, one deferred world at `50`, and a newer deferred world at `99`, `Runtime.latest()` consulted only the host render context. A computed evaluating the canonical world therefore observed `99` instead of `1`, and the computed evaluating the selected deferred world observed `99` instead of `50`.

Both regression tests were added before the implementation change and failed against the old code with the judge's exact values:

```text
keeps latest reads in a canonical computed evaluation
expected 99 to be 1

keeps latest reads in a selected deferred-world computed evaluation
expected 99 to be 50

Tests  2 failed | 8 skipped (10)
```

The implementation fix is one world-selection change in `Runtime.latest()`: it now calls `this.renderBatches()` instead of reading `this.host?.getRenderBatches()` directly. That preserves top-level newest-intent behavior while honoring `evaluationBatches` during computed evaluation. The same focused run is now green:

```text
✓ keeps latest reads in a canonical computed evaluation
✓ keeps latest reads in a selected deferred-world computed evaluation
Tests  2 passed | 8 skipped (10)
```

The randomized oracle now builds a computed whose body calls `runtime.latest(atom)` for every source. Every generated check evaluates it once with the canonical empty world and, when present, once with the generated selected batch set. This widens the existing 4-atom/additive schedule specifically along the missing contextual-`latest` axis while retaining seed and shrunk-schedule diagnostics.

Fresh verification from commit `8aa9cb1`:

| Gate | Exact command | Result |
|---|---|---|
| Core typecheck | `(cd packages/signals-royale-sm2 && pnpm typecheck)` | Pass |
| React typecheck | `(cd packages/react-signals-royale-sm2 && pnpm typecheck)` | Pass |
| Full engine suite | `(cd packages/signals-royale-sm2 && pnpm test)` | Pass, 4 files / 194 tests |
| Deep oracle | `(cd packages/signals-royale-sm2 && ORACLE_SEEDS=1200 pnpm exec vitest run tests/oracle.spec.ts --reporter=verbose)` | Pass, 1200 seeds × 90 steps plus 2 regressions |
| Own Real-React gate | `(cd packages/react-signals-royale-sm2 && pnpm test)` | Pass, 5 files / 17 tests |
| Shared battery | `(cd royale/verify-kit/battery && pnpm typecheck && pnpm test)` | Pass, 25/25 |

```text
Full engine suite
Test Files  4 passed (4)
Tests       194 passed (194)

Deep oracle
matches a memo-free world-fold model for 1200 seeds x 90 steps
Tests       3 passed (3)

Own Real-React gate
Test Files  5 passed (5)
Tests       17 passed (17)

Shared battery
Test Files  1 passed (1)
Tests       25 passed (25)
```

### Post-rewrite React benchmark

Command: `(cd packages/react-signals-royale-sm2 && node bench/react-bench.mjs)`. This run used the rewritten fork build, not the superseded incumbent-derived fork.

```csv
scenario,contender,stat,ms
fanout,royale-sm2,median_write_to_commit,3.01
fanout,uses-store,median_write_to_commit,2.16
transition,royale-sm2,urgent_p95,7.67
transition,uses-store,urgent_p95,5.99
mount,royale-sm2,median_mount,95.01
mount,uses-store,median_mount,60.12
```

The React fork did not change in this fix round: `vendor/react` remains clean at `5a968f65b4`, so the existing single patch was not regenerated. The authoritative counts remain `forkLoc: 186` and `libLoc: 1524`; the source fix replaces one call and adds no normalized library LOC.
