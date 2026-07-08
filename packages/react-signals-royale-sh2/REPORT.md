# Signals Royale SH2 report

## 1. Design summary

SH2 stores every reactive node in a numbered slab and represents dependency edges as bit masks.
Invalidation sweeps words, marks nodes as possibly dirty, and lets dependency-version checks prune
unchanged computed branches before downstream work runs. A transition is a small overlay containing
per-slot reducer actions; reads fold the render pass's batch mask over the canonical slab, so
functional actions naturally rebase over urgent writes. The React fork attaches one external batch
number to a transition lane and reports render, commit, and mutation edges through one runtime slot.
Late subscribers schedule their correction through the original live lane rather than a new
transition. Canonical state remains allocation-light, while overlays and render caches exist only
during concurrent episodes. FinalizationRegistry reclaims dropped slab handles, with deterministic
disposal for component-owned cells.

## 2. Gates

| Gate | Exact command | Result | Headline output |
| --- | --- | --- | --- |
| Engine typecheck | `cd packages/signals-royale-sh2 && pnpm typecheck` | PASS | `tsc --noEmit -p tsconfig.json` |
| React package typecheck | `cd packages/react-signals-royale-sh2 && pnpm typecheck` | PASS | `tsc --noEmit -p tsconfig.json` |
| Engine conformance | `pnpm exec vitest run tests/conformance.spec.ts --reporter=verbose` | PASS | `Tests 179 passed (179)` |
| Full engine suite | `cd packages/signals-royale-sh2 && pnpm test -- --reporter=verbose` | PASS | `5 passed`, `191 passed` |
| Randomized oracle | `pnpm exec vitest run tests/oracle.spec.ts tests/gc-leaks.spec.ts --reporter=verbose` | PASS | `300 seeds x 90 steps`; 3 tests passed |
| Real-React gate | `cd packages/react-signals-royale-sh2 && pnpm test -- --reporter=verbose` | PASS | `1 passed`, `18 passed`; includes actual yielded time slicing |
| Fork protocol and adjacent upstream suites | `cd vendor/react && yarn test --no-watchman ReactFiberSignalRuntime ReactFlushSync ReactTransition` | PASS | 5 suites; 47 passed, 1 skipped |
| Fork build | `cd packages/react-signals-royale-sh2 && ./build.sh` | PASS | NODE_DEV and NODE_PROD React, React DOM, and Scheduler bundles completed |
| Leak audit | `pnpm exec vitest run tests/gc-leaks.spec.ts --reporter=verbose` | PARTIAL | Dropped handles reclaim and committed episodes reach zero; abandoned scheduled batches are not proven |
| Core/React benchmark | Not run | NOT RUN | Both required benchmark adapters are present; no comparable milomg or seam numbers are claimed |

Real output excerpts:

```text
Test Files  1 passed (1)
Tests  179 passed (179)

tests/oracle.spec.ts > randomized world-fold oracle (300 seeds x 90 steps) 891ms

Test Files  1 passed (1)
Tests  18 passed (18)

Test Suites: 5 passed, 5 total
Tests:       1 skipped, 47 passed, 48 total
```

## 3. LOC self-count

- React fork: **205** changed production lines.
  Command: `git -C vendor/react diff --numstat e71a6393e6..HEAD -- packages ':!packages/*/src/__tests__*' | awk '{a+=$1+$2} END {print a}'`
- Library and bindings: **1169** nonblank source lines after Prettier 100-column normalization.
  Command: `awk 'NF {n++} END {print n}' packages/signals-royale-sh2/src/*.ts packages/react-signals-royale-sh2/src/*.ts`

## 4. Feature coverage

- Writable atoms, custom equality, labels, lazy initialization, set-before-read: **done**.
- Replayable functional transition updates: **done**, including `(1 + 1) * 2 = 4` and branch `2 -> 6` gates.
- Lazy cached computeds, equality cutoff, dynamic dependency trimming: **done for canonical graphs**; speculative dependency sets are recomputed per render cache rather than retained independently.
- Effects, cleanup, effect scopes, batch/start/end, and untracked: **done**.
- Lifetime observation across computed, effect, and React subscribers: **done**, including StrictMode coalescing.
- Urgent/deferred classification, isolated render worlds, rebase, and tear-free sibling reads: **done**.
- Late mount and suspending late mount pinned to the owning transition lane: **done**.
- Per-root committed atom views and two-root transition commits: **done**; committed computed snapshots are partial.
- flushSync exclusion and actual time-sliced urgent interruption: **done**.
- Canonical/latest/committed/isPending/refresh read family: **done for atoms and direct async resources**; computed committed views and general transformed refreshes are partial.
- Async graph state, parallel registration, stable thenables, stale urgent refetch, and transition settlement: **done for direct `use(thenable)` resources**; see risks below.
- React hooks, loud fork registration, post-subscribe fixup, write-during-render failure, unmount cleanup, and component-owned atoms: **done**.
- SSR serialization, reviver/replacer, keys, and initializer-free installation: **done**.
- Causality trace, causal chains, attach/detach, and bounded overflow accounting: **done**.
- Exact DOM mutation window exposed to MutationObserver clients: **done**.
- Dropped-handle reclamation and deterministic cell disposal: **done**; scheduled-abandon pruning is partial.

## 5. Known gaps and honest risks

- A scheduled external batch whose React work is permanently abandoned before any root commits has
  no explicit prune edge in the 205-line fork. Ordinary render restarts preserve the batch correctly,
  unobserved batches retire in a microtask, and committed batches reclaim, but the permanent-abandon
  case can retain an overlay. This means the full rollback and quiescence contract is not proven.
- `committed(cell, root)` snapshots atoms per root. A computed passed to `committed` currently falls
  back to canonical evaluation instead of a retained per-root computed snapshot.
- The fetch-once path handles direct `use(fetchPromise)` resources and refreshes them once per call.
  A general expression that creates fresh promises inline and transforms unresolved values may need
  an application cache; JavaScript cannot resume the middle of that synchronous expression, and this
  implementation may re-evaluate it after settlement.
- Parallel async registration works when the computation reaches each `use` call before consuming
  unresolved values. A property access on the first unresolved placeholder can prevent later reads.
- Canonical effects advance when the first root commits a shared batch, not after an explicit
  all-roots retirement edge.
- No milomg or React seam benchmark was run, so the entry makes no performance ranking claim.

Because the abandoned-batch and fully general async cases remain partial, this report does **not**
claim the tournament's complete correctness gate even though every command listed as PASS is green.

## 6. What I would do with another day

I would add a tiny root/pending-lane registry to the fork so it can emit an exactly-once committed or
pruned retirement edge, then move canonical promotion and effects to that edge. Next I would retain
the completed render cache per root for exact committed computed reads. Finally I would formalize
async computations as resumable keyed resource nodes rather than accepting arbitrary synchronous
promise expressions, then run the milomg and React seam matrices and optimize the slab sweeps from
those measurements.

## Round 2 — verify, integrate, tune

This section supersedes the Round 1 benchmark status and correctness caveat. The shared battery is
green at 25/25. The remaining abandoned-work risk is still stated below; it did not fail any
required or shared gate.

### Fresh gates, in required order

| Gate | Exact command | Result |
| --- | --- | --- |
| Engine typecheck | `cd packages/signals-royale-sh2 && pnpm typecheck` | PASS |
| React typecheck | `cd packages/react-signals-royale-sh2 && pnpm typecheck` | PASS |
| Conformance | `pnpm exec vitest run tests/conformance.spec.ts --reporter=verbose` | PASS, 179/179 |
| Oracle, default | `pnpm exec vitest run tests/oracle.spec.ts --reporter=verbose` | PASS, 300 seeds × 90 steps |
| Oracle, deep | `ORACLE_SEEDS=1200 pnpm exec vitest run tests/oracle.spec.ts --reporter=verbose` | PASS, 1200 seeds × 90 steps |
| Leak audit | `pnpm exec vitest run tests/gc-leaks.spec.ts --reporter=verbose` | PASS, 2/2 |
| Fork protocol + adjacent suites | `yarn test --no-watchman ReactFiberSignalRuntime ReactFlushSync ReactTransition` | PASS, 5 suites; 47 passed, 1 skipped |
| Real-React gate | `pnpm test -- --reporter=verbose` in the React package | PASS, 18/18 |
| Full engine suite | `pnpm test -- --reporter=verbose` in the engine package | PASS, 191/191 |
| Fork build | `./fork/build-react.sh` | PASS, all requested dev/prod bundles completed |
| Shared battery typecheck | `pnpm typecheck` in `royale/verify-kit/battery` | PASS |
| Shared battery | `pnpm test` in `royale/verify-kit/battery` | PASS, 25/25 |

Real terminal output:

```text
> signals-royale-sh2@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

> react-signals-royale-sh2@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

Test Files  1 passed (1)
Tests  179 passed (179)
Duration  233ms

✓ randomized world-fold oracle (300 seeds x 90 steps) 918ms
Test Files  1 passed (1)
Tests  1 passed (1)

✓ randomized world-fold oracle (1200 seeds x 90 steps) 3770ms
Test Files  1 passed (1)
Tests  1 passed (1)

✓ dropped atom handles release their slab slots 107ms
✓ a committed transition leaves no per-episode state 0ms
Test Files  1 passed (1)
Tests  2 passed (2)

Test Suites: 5 passed, 5 total
Tests:       1 skipped, 47 passed, 48 total
Time:        2.026 s

Test Files  1 passed (1)
Tests  18 passed (18)
Duration  613ms

Test Files  5 passed (5)
Tests  191 passed (191)
Duration  1.10s

> royale-battery@0.0.0 typecheck
> tsc --noEmit -p tsconfig.json
Test Files  1 passed (1)
Tests  25 passed (25)
Duration  557ms
```

### milomg js-reactivity-benchmark

The adapter uses SH2's numeric cell IDs so the runner measures the slab rather than one wrapper
object per cell. `cleanup()` disposes the effect scope and resets the full slab, edge arena, batch
overlays, and render state; there is no intentional leak-vs-no-leak asymmetry.

Adapter sanity passed all four SH2 cases:

```text
pnpm -C packages/core exec vitest run -t "Royale SH2"
Test Files  1 passed (1)
Tests  4 passed | 76 skipped (80)
```

The requested unfiltered `pnpm -C packages/core test` is not fully green: SH2 passes 4/4, but the
benchmark checkout's unrelated `x-reactivity | static graph, read 2/3 of leaves` case expects 41
pulls and receives 51. The actual total is `79 passed, 1 failed`; I did not alter or suppress it.

Final isolated command:

```text
cd milomg-reactivity-benchmark/packages/node
pnpm exec esbuild src/index.ts src/isolated.ts --bundle --platform=node --format=esm --target=esnext --outdir=dist --sourcemap=external
node dist/isolated.js --rounds 3 "Royale SH2" "Alien Signals"
```

The documented esbuild line needed `--platform=node` because the runner imports Node built-ins.
Values are the runner's three-round medians, in milliseconds:

| Suite | Royale SH2 | Alien Signals | SH2 / Alien |
| --- | ---: | ---: | ---: |
| createSignals | 1.09 | 3.08 | 0.35× |
| createComputations | 234.56 | 73.96 | 3.17× |
| updateSignals | 906.56 | 286.28 | 3.17× |
| avoidablePropagation | 244.70 | 107.32 | 2.28× |
| broadPropagation | 231.22 | 83.74 | 2.76× |
| deepPropagation | 77.86 | 33.21 | 2.34× |
| diamond | 191.18 | 88.19 | 2.17× |
| mux | 134.10 | 86.02 | 1.56× |
| repeatedObservers | 33.17 | 19.25 | 1.72× |
| triangle | 54.37 | 23.14 | 2.35× |
| unstable | 38.13 | 20.40 | 1.87× |
| molBench | 14.79 | 13.72 | 1.08× |
| cellx1000 | 7.33 | 3.67 | 2.00× |
| cellx2500 | 17.20 | 11.03 | 1.56× |
| 2-10x5 - lazy80% | 428.15 | 159.58 | 2.68× |
| 6-10x10 - dyn25% - lazy80% | 237.54 | 106.88 | 2.22× |
| 4-1000x12 - dyn5% | 509.00 | 276.96 | 1.84× |
| 25-1000x5 | 582.05 | 342.80 | 1.70× |
| 3-5x500 | 141.76 | 83.70 | 1.69× |
| 6-100x15 - dyn50% | 254.84 | 159.33 | 1.60× |
| **sum** | **4339.60** | **1982.26** | **2.189×** |

SH2 is faster only at raw signal creation and is 2.189× slower in the unweighted suite sum. The
largest remaining cost is computed evaluation and propagation, not allocation of atom handles.

### React seam benchmark

`bench/react-bench.mjs` uses jsdom, Node real timers, no `act`, one child process for each
scenario/contender pair, and prints only `scenario,contender,stat,ms` on stdout. Both contenders use
the same component shapes and this fork build; the reference is a plain store read through
`useSyncExternalStore`.

```text
scenario,contender,stat,ms
fanout,sh2,median,1.72
fanout,useSyncExternalStore,median,2.24
transition,sh2,p95,8.98
transition,useSyncExternalStore,p95,2.23
mount,sh2,median,64.54
mount,useSyncExternalStore,median,47.68
```

SH2 wins the measured single-cell fanout latency by 23%. Its mount is 35% slower. The transition
result is also worse: SH2's deferred 2000-cell render spans scheduler slices that affect multiple
urgent samples, while the baseline's blocking work is concentrated in its first/max sample and
therefore mostly disappears from p95 over 30 updates. This is the specified p95, so I report it as
measured rather than substitute max or total transition time.

### Changes made in Round 2

- Replaced capacity-sized observer/dependency arrays with an intrusive typed edge slab. Stable edges
  are reused between evaluations; dynamic branches unlink only dependencies that disappeared.
- Added allocation-free epoch arrays for batch rollback bookkeeping, reusable invalidation/effect
  work arrays, lazy child arrays, and a no-listener notification fast path.
- Added a numeric-ID adapter tier and deterministic reset mode used only by milomg. Public object
  handles and automatic reclamation remain the default API.
- Made transition actions globally sequence-ordered, so urgent functional and absolute writes replay
  after older speculative actions. The randomized oracle now models that binding ordering directly.
- Changed the fork from one global lane table to a global pinning table plus a small typed lane table
  per Fiber root. A batch spanning roots retains attribution until each root's own commit.
- Made refresh pending visible before the refreshed computed reevaluates, and added positional SSR
  fallback keys while preserving explicit app keys.
- Added the shared-battery adapter return annotations required for JSX consumption and fixed every
  substantive battery failure rather than special-casing its tests.

### LOC and remaining risks

```text
node royale/verify-kit/count-loc.mjs \
  --fork vendor/react \
  --base e71a6393e66b0d2add46ba2b2c5db563a0563828 \
  --head royale/sh2-react \
  --lib packages/signals-royale-sh2 \
  --lib packages/react-signals-royale-sh2
```

Result: **235 fork LOC** and **1424 library LOC**. The library metric counts production `src` files;
the benchmark driver, tests, adapters, and report are excluded by the shared counter.

No shared-battery test is disputed. The known residual risk is permanent React abandonment: a batch
scheduled on a root that never commits or retries has no explicit prune callback, so its overlay can
remain live. Ordinary restarts, multi-root commits, unobserved batches, and all tested suspense paths
retire cleanly. The React formatter command also could not be used as its script expects a local
`main` ref absent from the supplied clone; direct Prettier hit an existing Hermes parser crash even
on the preceding committed file. The fork builds and its five requested suites pass.

<oai-mem-citation>
<citation_entries>
MEMORY.md:1-44|note=[used prior benchmark adapter and hot path guidance]
</citation_entries>
<rollout_ids>
019f37b3-e5f8-7c61-978e-5182e41b632b
</rollout_ids>
</oai-mem-citation>
