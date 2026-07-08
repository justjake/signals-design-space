# Signals Royale SM1 Report

## Design summary

SM1 treats concurrent signals as an operation-history repair problem, keeping one per-atom episode log instead of separate canonical, render, and React graphs. Urgent operations enter the canonical fold immediately, while deferred operations remain lane overlays until React reports their owning roots committed. Functional updaters stay as functions in that history, so retirement replays them over intervening urgent state. Each render pass pins a sequence number and a lane set, making every read in that pass a fold of the same world. The React fork exposes only scheduling facts—write lane, render root and lanes, pass boundaries, root commits, event closure, and exact mutation brackets—rather than embedding signal semantics. At a root commit, the engine advances that root's view and retires a lane only after no owning root remains. A subscription claimed in layout checks the just-rendered snapshot, then schedules any missed live-lane correction in that lane so the repair lands in the owning batch. Async state, lifetime observation, tracing, and SSR all reuse that graph and history.

## Verification gates

| Gate | Exact command | Result | Headline |
| --- | --- | --- | --- |
| Engine typecheck | `pnpm typecheck` (`cwd=packages/signals-royale-sm1`) | PASS | strict `tsc --noEmit`, no diagnostics |
| React bindings typecheck | `pnpm typecheck` (`cwd=packages/react-signals-royale-sm1`) | PASS | strict `tsc --noEmit`, no diagnostics |
| Engine conformance | `pnpm vitest run tests/conformance.spec.ts --reporter=dot` (`cwd=packages/signals-royale-sm1`) | PASS | 179/179 |
| Randomized oracle | `pnpm vitest run tests/oracle.spec.ts --reporter=verbose` (`cwd=packages/signals-royale-sm1`) | PASS | 2/2; 300 seeds × 90 steps plus pinned rebase regression |
| Full engine suite | `pnpm test -- --reporter=dot` (`cwd=packages/signals-royale-sm1`) | PASS | 193/193 in 4 files |
| Real React | `pnpm vitest run tests/real-react.spec.tsx --reporter=dot` (`cwd=packages/react-signals-royale-sm1`) | PASS | 17/17, spanning the 18 listed scenarios |
| Fork protocol | `yarn test --no-watchman ReactFiberSignalRuntime` (`cwd=vendor/react`) | PASS | 4/4 in 1 suite |
| Adjacent upstream React | <code>yarn test --no-watchman 'ReactAsyncActions&#124;ReactFlushSync&#124;ReactIncrementalScheduling&#124;ReactIncrementalUpdates&#124;ReactInterleavedUpdates&#124;ReactSchedulerIntegration&#124;ReactTransition&#124;ReactUpdatePriority&#124;ReactDefaultTransitionIndicator'</code> (`cwd=vendor/react`) | PASS | 117 passed, 1 skipped, 12 suites |
| GC/leak audit | `pnpm vitest run tests/gc-leaks.spec.ts --reporter=verbose` (`cwd=packages/signals-royale-sm1`) | PASS | 2/2; dropped handles collected and episode state reclaimed |
| Fork build | `./build.sh` (`cwd=packages/react-signals-royale-sm1`) | PASS | `Built: 19.3.0 (8a2dd11d0f)` |
| Patch replay | Commands below against the pinned base | PASS | replayed tree equals fork tree |

Real output excerpts:

```text
Test Files  1 passed (1)
Tests  179 passed (179)

✓ matches the naive fold for 300 seeds x 90 steps
Test Files  1 passed (1)
Tests  2 passed (2)

Test Files  4 passed (4)
Tests  193 passed (193)

Test Files  1 passed (1)
Tests  17 passed (17)

Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total

Test Suites: 12 passed, 12 total
Tests:       1 skipped, 117 passed, 118 total

✓ collects dropped computed and effect handles
✓ reclaims all per-episode state at quiescence

Built: 19.3.0 (8a2dd11d0f)
```

Patch replay audit:

```sh
git -C vendor/react worktree add --detach /tmp/royale-sm1-patch-audit e71a6393e66b0d2add46ba2b2c5db563a0563828
git -C /tmp/royale-sm1-patch-audit am /tmp/royale-sm1/packages/react-signals-royale-sm1/patches/*.patch
git -C /tmp/royale-sm1-patch-audit rev-parse 'HEAD^{tree}'
git -C vendor/react rev-parse 'HEAD^{tree}'
```

```text
Applying: Add minimal signal lane and commit protocol
Applying: Pin external-only signal event closure
replayed=075720b474b8dca07daf9f9a72c70172c5a4b40b
fork=075720b474b8dca07daf9f9a72c70172c5a4b40b
```

## Benchmarks

One final `pnpm bench:core` Kairo run, in milliseconds:

| Test | SM1 |
| --- | ---: |
| avoidablePropagation | 350.97 |
| broadPropagation | 906.07 |
| deepPropagation | 854.69 |
| diamond | 511.00 |
| mux | 1886.53 |
| repeatedObservers | 59.67 |
| triangle | 231.24 |
| unstable | 82.48 |
| molBench | 18.30 |

The runner ended with `# leak no {"batches":0,"passes":0,"touchedAtoms":0,"liveLanes":0}`.

Three final `pnpm bench:seam` runs, in milliseconds:

| Scenario | Runs | Median |
| --- | --- | ---: |
| fanout write-to-commit | 1.74, 1.85, 1.90 | 1.85 |
| urgent p95 during transition | 1.56, 1.59, 1.53 | 1.56 |
| five-root mount | 67.90, 64.84, 64.28 | 64.84 |

Fanout rendered exactly one cell per write and recorded 201 profiler commits; transition runs recorded 30 urgent updates and 32 profiler commits. Every run ended with the same explicit `# leak no` zero-state verdict.

## LOC self-count

The React fork metric is **320** inserted/deleted lines:

```sh
git -C vendor/react diff --numstat e71a6393e66b0d2add46ba2b2c5db563a0563828..HEAD -- packages/ ':!packages/*/src/__tests__*' | awk '{n += $1 + $2} END {print n}'
```

```text
320
```

After Prettier normalization at print width 100, the library metric is **2,088** nonblank, non-comment lines: 1,861 engine plus 227 React bindings.

```sh
find packages/signals-royale-sm1/src packages/react-signals-royale-sm1/src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 awk 'NF && $0 !~ /^[[:space:]]*(\/\/|\/\*|\*|\*\/)/ {n++} END {print n}'
```

```text
2088
```

## Feature coverage

- Done — writable atoms support labels, custom equality, lazy one-shot untracked initialization, write prohibition during initialization, set-before-read materialization, and non-writing state install.
- Done — functional updates remain replayable operations and rebase over urgent writes; the `(1 + 1) × 2 = 4` case passes in the engine and React suites.
- Done — computeds are lazy and cached, cut off equal output, trim dynamic dependencies, preserve exact pull counts, and cache independently by world.
- Done — effects and effect scopes clean up deterministically and observe canonical state only.
- Done — `batch`, `startBatch`, `endBatch`, and `untracked` coalesce synchronous work without tracking accidental reads.
- Done — atom lifetime effects count computed, effect, and React observation together, debounce flaps, net StrictMode to one start, and stop after final unmount.
- Done — writes are classified by React lane; urgent writes are canonical immediately and deferred writes stay out of canonical and committed DOM views.
- Done — render passes pin sequence plus visible lanes, so siblings and retries read one consistent world.
- Done — urgent-during-transition commits alone, deferred updater functions later rebase, interrupted passes discard their caches, and correction delivery is lane-pinned.
- Done — per-root committed lane views support one batch spanning multiple roots.
- Done — `flushSync` folds urgent state without pending deferred lanes.
- Done — completed episodes compact atom histories and clear batches, pass state, touched atoms, and live lanes; the GC audit also collects dropped computed/effect handles.
- Done — canonical reads expose committed plus urgent state while hiding drafts.
- Done — `latest` never suspends, sees newest intent outside a world, and respects an enclosing computed/render world's lane set.
- Done — `committed` reads root-specific screen state when given a root and does not subscribe at engine level.
- Done — `isPending` is a non-suspending, non-refetching flip probe with a dedicated subscription path.
- Done — `refresh` preserves stale content, keeps `latest`, is latest-wins across races, and carries transition lane ownership through settlement.
- Done — pending and error are stable graph evaluations; a parked computation records all parallel async reads and downstream nodes forward pending.
- Done — Suspense retries reuse thenable identity; the real-React first-load test fetches once.
- Done — never-settled data suspends, transition renders hand React the thenable, and urgent renders with settled history serve stale content instead of flashing fallback.
- Done — settlement invalidates and propagates as a write in its owning urgent or deferred world, including canonical effects after deferred retirement.
- Done — `useValue` resolves the active pass, claims dependencies in layout, performs post-subscribe repair, and repairs mount-mid-transition in the owning lane.
- Done — `useComputed`, `useSignalEffect`, `useCommitted`, `useIsPending`, `useAtom`, and `startTransitionWrite` are implemented and covered against the fork build.
- Done — registration rejects stock React; multiple roots, write-during-render failure, unmount silence, and component-owned atom reclamation are covered.
- Done — keyed SSR serialize/initialize supports replacer/reviver, and install avoids lazy initialization and corrective first renders.
- Done — the attachable bounded causality ring records all required event families, counts overflow, and explains component/effect delivery chains back to writes.
- Done — fork events bracket React's mutation phase exactly; the real MutationObserver test ignores React mutations and still observes a third-party mutation.

## Known gaps and honest risks

- Core performance is the main weakness. Against the stored same-suite alien-v3 snapshot, this final run is about 1.34× slower on `molBench` and up to 26.48× slower on `mux`; the operation log favors concurrency semantics over hot-path indexing.
- `startTransitionWrite` intentionally scopes a synchronous adapter callback. An async React action that performs external signal writes after an `await` is not kept in one engine batch and needs a dedicated protocol if that behavior becomes required.
- React pass discard, replacement, lane pruning, and retirement are covered, but there is no public arbitrary host-side batch-cancellation API outside React's reported lane lifecycle.
- The supplied Daishi adapter typechecks, but I did not run a separate official Daishi compatibility matrix or a cross-entrant tournament battery; the report claims only the gates and benchmarks listed above.
- The GC proof combines deterministic disposal, `FinalizationRegistry`, forced-GC tests, and quiescent counters; as with any finalizer-backed design, reclamation timing outside forced tests remains host-controlled.

## What I would do with another day

I would replace repeated linear operation/dependency membership scans with episode-local indexes while preserving the single-history model, then profile the Kairo `mux`, deep, and broad cases until the core gap closes. I would also define and test lane continuity across async React actions, run the external Daishi and tournament-wide batteries, and try to remove source surface from async evaluation and tracing without moving signal policy into the fork.

## Round 2 — verify, integrate, tune

### Outcome

All RULES.md gates pass after tuning. The shared battery passes 22/25; its remaining three failures are one updater-order dispute repeated by scenarios 3, 13, and 15, documented below rather than coded around. The React fork is unchanged at `8a2dd11d0f`; its patches were regenerated and its build, protocol suite, and adjacent upstream suites pass. Official Round 2 LOC is 320 fork lines and 2,158 library lines.

### Fresh gate reruns

| Gate | Exact command | Result |
| --- | --- | --- |
| Engine typecheck | `pnpm typecheck` in `packages/signals-royale-sm1` | PASS — no diagnostics |
| React typecheck | `pnpm typecheck` in `packages/react-signals-royale-sm1` | PASS — no diagnostics |
| Conformance | `pnpm vitest run tests/conformance.spec.ts --reporter=verbose` | PASS — 179/179 |
| Oracle default | `pnpm vitest run tests/oracle.spec.ts --reporter=verbose` | PASS — 2/2, 300×90 |
| Oracle deep sweep | `ORACLE_SEEDS=1200 pnpm vitest run tests/oracle.spec.ts --reporter=verbose` | PASS — 2/2, 1200×90 |
| Leak audit | `pnpm vitest run tests/gc-leaks.spec.ts --reporter=verbose` | PASS — 2/2 |
| Fork protocol | `yarn test --no-watchman ReactFiberSignalRuntime` in `vendor/react` | PASS — 4/4 |
| Adjacent React | <code>yarn test --no-watchman 'ReactAsyncActions&#124;ReactFlushSync&#124;ReactIncrementalScheduling&#124;ReactIncrementalUpdates&#124;ReactInterleavedUpdates&#124;ReactSchedulerIntegration&#124;ReactTransition&#124;ReactUpdatePriority&#124;ReactDefaultTransitionIndicator'</code> | PASS — 117 passed, 1 skipped |
| Real React | `pnpm vitest run tests/real-react.spec.tsx --reporter=verbose` | PASS — 17/17 |
| Fork build | `./build.sh` in `packages/react-signals-royale-sm1` | PASS — React 19.3.0 at `8a2dd11d0f` |

Real terminal output:

```text
> signals-royale-sm1@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

> react-signals-royale-sm1@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

Test Files  1 passed (1)
Tests  179 passed (179)

✓ matches the naive fold for 300 seeds x 90 steps
Test Files  1 passed (1)
Tests  2 passed (2)

✓ matches the naive fold for 1200 seeds x 90 steps
Test Files  1 passed (1)
Tests  2 passed (2)

✓ collects dropped computed and effect handles
✓ reclaims all per-episode state at quiescence
Test Files  1 passed (1)
Tests  2 passed (2)

Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total

Test Suites: 12 passed, 12 total
Tests:       1 skipped, 117 passed, 118 total

Test Files  1 passed (1)
Tests  17 passed (17)

Built: 19.3.0 (8a2dd11d0f)
```

### Milomg integration and final measurement

The benchmark is committed in its submodule at `cde40f9`. The all-framework sanity command reached 79/80; SM1 passed all four adapter checks including pull counts, while the unrelated checked-in `x-reactivity` adapter produced 51 pulls where the harness expects 41. The entrant-only sanity rerun passed 4/4:

```text
Test Files  1 passed (1)
Tests  4 passed | 76 skipped (80)
```

The Round 2 esbuild command failed as written because `isolated.ts` imports `node:child_process`, `node:url`, and `node:path`; adding `--platform=node` built both entries successfully. Final command:

```sh
pnpm exec esbuild src/index.ts src/isolated.ts --bundle --platform=node --format=esm --target=esnext --outdir=dist --sourcemap=external
node dist/isolated.js --rounds 3 "Royale SM1" "Alien Signals"
```

Final three-round medians, milliseconds:

| Test | SM1 | Alien | SM1/Alien |
| --- | ---: | ---: | ---: |
| createSignals | 19.17 | 2.52 | 7.61× |
| createComputations | 986.51 | 58.65 | 16.82× |
| updateSignals | 2517.85 | 274.72 | 9.17× |
| avoidablePropagation | 374.37 | 108.11 | 3.46× |
| broadPropagation | 997.93 | 83.42 | 11.96× |
| deepPropagation | 320.54 | 32.50 | 9.86× |
| diamond | 520.93 | 85.67 | 6.08× |
| mux | 342.06 | 81.40 | 4.20× |
| repeatedObservers | 67.18 | 18.61 | 3.61× |
| triangle | 157.37 | 23.91 | 6.58× |
| unstable | 107.44 | 20.24 | 5.31× |
| molBench | 18.59 | 13.74 | 1.35× |
| cellx1000 | 47.65 | 3.64 | 13.09× |
| cellx2500 | 112.82 | 12.21 | 9.24× |
| 2-10x5 - lazy80% | 1264.78 | 157.47 | 8.03× |
| 6-10x10 - dyn25% - lazy80% | 599.91 | 104.71 | 5.73× |
| 4-1000x12 - dyn5% | 1541.16 | 280.74 | 5.49× |
| 25-1000x5 | 1763.82 | 343.41 | 5.14× |
| 3-5x500 | 470.68 | 78.91 | 5.96× |
| 6-100x15 - dyn50% | 595.22 | 172.98 | 3.44× |

Summed median time is 12,825.98 ms for SM1 versus 1,957.56 ms for Alien: **6.55× overall**. The geometric mean of the 20 per-test ratios is 6.19×. Leak flag: no known asymmetry—both adapters deterministically dispose their effect scopes; SM1's forced-GC handle audit and zero-state quiescence audit pass, while the external milomg runner itself does not inspect retained heap.

### React benchmark

`bench/react-bench.mjs` bundles the real SM1 bindings, uses the fork build with jsdom and real timers, never calls `act`, and launches one child per scenario/contender. Its stdout is only `scenario,contender,stat,ms` CSV. Three independent runs produced:

| Scenario/stat | SM1 runs | SM1 median | useSyncExternalStore runs | Baseline median | Ratio |
| --- | --- | ---: | --- | ---: | ---: |
| fanout / median write→commit | 2.23, 1.73, 2.72 | 2.23 | 1.94, 1.82, 2.13 | 1.94 | 1.15× |
| transition / p95 urgent commit | 10.49, 3.13, 17.95 | 10.49 | 2.99, 3.01, 4.84 | 3.01 | 3.49× |
| mount / median first commit | 73.55, 78.19, 165.67 | 78.19 | 61.47, 59.18, 187.33 | 61.47 | 1.27× |

The shared machine produced visible third-run outliers, so the table retains every sample. In this shape the plain store usually finishes its blocking bulk render before most urgent samples begin, so its urgent p95 beats SM1's interruptible render; I am not claiming a transition win that the measured statistic does not show.

### Performance changes

- Replaced linear `frame.atoms.includes` deduplication with an evaluation-frame mark on atoms.
- Avoided registering scoped effects with `FinalizationRegistry`; their scope already owns deterministic cleanup, eliminating a closure and registry entry per benchmark effect.
- Stopped recursively pulling clean sources in live graphs; dirty propagation already proves their versions, removing quadratic deep-chain work.
- Captured flattened transitive atom sets only for React/world reads and skipped sync evaluation merging when no async or collector state exists.
- Added a canonical revision stamp so shared lazy DAG nodes proven clean in the current revision are not revalidated repeatedly.
- Added atom pending subscriptions so `useIsPending(atom)` flips urgently while a deferred draft is held.

The first untuned full SM1 benchmark child exceeded eight minutes and 3.3 GB RSS before emitting a row. After tuning, all three full SM1 rounds completed; representative Kairo `mux` fell from 1,886.53 ms in Round 1 to a 342.06 ms final median. No React-fork code was added.

### Shared battery and adjudication

The shim in `royale/verify-kit/battery/ADAPTER.ts` points directly to SM1's adapter. Battery typecheck passes. Final battery output:

```text
Test Files  1 failed (1)
Tests  3 failed | 22 passed (25)
```

Scenario 2's atom-pending failure was valid and is fixed. Scenarios 3, 13, and 15 are one disputed arithmetic expectation:

- RULES.md's binding example starts at 1, schedules deferred `D(x)=2x`, then urgent `U(x)=x+1`, and requires final 4. That result is `D(U(1))`; scheduling order `U(D(1))` is 3.
- Battery scenario 3 starts at 1, schedules deferred `D(x)=x+1`, then urgent `U(x)=2x`, and requires final 4. That result is `U(D(1))`; the RULES ordering `D(U(1))` is 3.
- Battery scenario 13 repeats the conflict with deferred `+2` and urgent `×2`, expecting 6 where the RULES ordering produces 4. Scenario 15 fails on the same arithmetic assertion before judging the trace.

No fixed updater ordering can satisfy both examples; doing so would require choosing order from the updater functions' results. Per ROUND2.md's instruction not to code around a disputed test, SM1 keeps the explicit RULES example and its overlay semantics. There are no other battery failures or disputes.

### Round 2 LOC and deliverables

```text
forkLoc: 320
libLoc: 2158
```

`count-loc.mjs` reports 1,762 lines for `runtime.ts`, 129 for `trace.ts`, 40 for the engine barrel, and 227 for React bindings. The patch replay series was regenerated from `e71a6393e66b0d2add46ba2b2c5db563a0563828..8a2dd11d0f` and `./build.sh` rebuilt React successfully.

<oai-mem-citation>
<citation_entries>
MEMORY.md:33-39|note=[benchmark boundary and hot path guidance]
MEMORY.md:494-505|note=[react view separation and fork mechanism guidance]
</citation_entries>
<rollout_ids>
019f37b3-e5f8-7c61-978e-5182e41b632b
019f11f4-ef9b-7222-864f-682bc53808bb
019f11f8-d0ee-7583-8e01-f467e7bb6a85
</rollout_ids>
</oai-mem-citation>
