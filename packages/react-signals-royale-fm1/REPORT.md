# signals-royale-fm1 — REPORT

## 1. Design summary

Speculative state is a **replay, not a copy**. Canonical state lives in one
value-aware reactive graph; a write inside a transition is recorded as a
write intent in a per-atom rebase log, and while any batch holds intents for
an atom every write to it — urgent included — appends in call order. A world
is a replay of the entries it can see: canonical sees urgent + retired,
a render pass pins a snapshot that also sees its own open batches, and
commit replays and installs (React updater-queue arithmetic — replay, never
reorder). The React fork shrinks to a **signal seam** (~190 diff lines):
React reports lanes as opaque numbers (pass start, per-root commit, the DOM
mutation window), answers which lane a write issued now would take and what
is rendering on the current stack, and lets the runtime pin an update to a
lane; batch identity, the lane-to-batch map, write classification, and world
snapshots all live in userland. Per-root committed views are just epochs:
each root records the canonical epoch of its last commit and reads history
through the snapshot pins. Validation in the core graph is value-aware
polling (each edge remembers what the consumer saw), so writes that revert
in a batch never propagate.

## 2. Gates (Round 2 — fresh runs, real output)

| Gate | Command | Result |
|---|---|---|
| Typecheck (engine) | `npx tsc --noEmit -p tsconfig.json` in `packages/signals-royale-fm1` | PASS |
| Typecheck (react) | `npx tsc --noEmit -p tsconfig.json` in `packages/react-signals-royale-fm1` | PASS |
| Conformance 179/179 | `npx vitest run tests/conformance.spec.ts` | PASS (179/179, no skips — `untracked` implemented) |
| Oracle fuzz | `npx vitest run tests/oracle.spec.ts` (300 seeds x 90 steps) | PASS |
| Oracle deep sweep | `FUZZ_SEEDS=1200 npx vitest run tests/oracle.spec.ts` | PASS |
| Leak audit | `npx vitest run tests/gc-leaks.spec.ts` (forks pool, `--expose-gc`) | PASS (4 tests) |
| Engine suite total | `npx vitest run` | **211 passed (211)** |
| Real-React gate | `npx vitest run` in react package (fork build, jsdom, raw createRoot + act, no RTL) | **24 passed (24)** — scenarios 1-18 |
| Fork protocol suite | `cd vendor/react && yarn test --no-watchman ReactSignalSeam` | **6 passed, 6 total** |
| Upstream adjacent suites | `yarn test --no-watchman ReactAsyncActions ReactBatching ReactFlushSync ReactIncrementalScheduling ReactIncrementalUpdates ReactInterleavedUpdates ReactSchedulerIntegration ReactTransition ReactUpdatePriority ReactDefaultTransitionIndicator` | **13 suites passed; 121 passed, 1 skipped** |
| Shared battery (verify-kit) | `npx vitest run` in `royale/verify-kit/battery` | **25 passed (25)** (calibration reference alt-b: 24/25) |
| Fork hygiene | `yarn flow dom-node`; `yarn linc`; `yarn prettier` | Flow: "No errors!"; lint passed; prettier clean |

Output snippets (verbatim):

```
== engine tests (conformance 179 + worlds + oracle 300 + gc)
 Test Files  4 passed (4)
      Tests  211 passed (211)
== deep fuzz 4x (1200 seeds)
      Tests  1 passed (1)
== real-React gate (final run includes the adapter-load smoke spec)
 Test Files  4 passed (4)
      Tests  25 passed (25)
== shared battery
 Test Files  1 passed (1)
      Tests  25 passed (25)
Test Suites: 1 passed, 1 total        (ReactSignalSeam)
Tests:       6 passed, 6 total
Test Suites: 13 passed, 13 total      (upstream adjacent)
Tests:       1 skipped, 121 passed, 122 total
```

## 3. LOC self-count

`node royale/verify-kit/count-loc.mjs --fork vendor/react --base e71a6393e6...
--head royale/fm1-react --lib packages/signals-royale-fm1 --lib
packages/react-signals-royale-fm1`:

- **Fork: 188** (incumbent: 1510). ReactSignalSeam.js 113 + WorkLoop 69 +
  react-dom/client 6.
- **Library: 1725** (incumbents: alt-a ~4689, alt-b ~4909). Engine 1238
  (core 603, worlds 381, index 101, tracer 78, async 75) + bindings 487
  (runtime 298, hooks 124, index 40, trace 25).

Cross-check: `git -C vendor/react diff --numstat e71a6393e6..HEAD --
packages/ ':!packages/*/src/__tests__*'` sums to 188.

## 4. Feature coverage

- Writable signals w/ custom equality + label — **done**.
- Lazy initializers (first-touch, set-before-read runs it, SSR install does
  not) — **done** (engine + gate tests).
- Functional updates that replay — **done** (rebase logs; see section 6).
- Computeds (lazy, cached, cutoff, dynamic deps w/ trimming, exact pull
  counts) — **done** (conformance 179/179; milomg pull-count tests green).
- Effects/scopes with cleanup; canonical-only observation — **done**.
- batch/startBatch/endBatch/untracked — **done**.
- Lifetime effects (union of subscriber kinds, tick coalescing, StrictMode
  nets one) — **done**.
- Concurrent model (classification, render-pass consistency, urgent-during-
  transition, per-root committed views, flushSync exclusion, quiescence
  reclamation) — **done**.
- Read family: canonical/latest/committed/isPending/refresh — **done**
  (latest of a never-settled pending reads as undefined, documented).
- Async/Suspense: pending-as-graph-state, stable thenable identity across
  retries, two-level suspend-vs-stale, settlement-as-write — **done**;
  settlement-in-transition commits with the transition via the snapshot
  world (battery scenario 11 green).
- React bindings incl. loud registration failure on stock React, multiple
  roots, write-during-render throws, unmount silence — **done**.
- SSR serialize/initialize/installState — **done**.
- Causality debug log (attach/detach, causal parents, ring + overflow
  count, whyLastDelivery) — **done**.
- DOM mutation window (exact bracket; MutationObserver use case) — **done**.

## 5. Benchmarks

### milomg js-reactivity-benchmark

Adapter registered as `Royale FM1` (`testPullCounts: true`; sanity tests
green including exact pull counts; `cleanup()` disposes the build scope —
no leak asymmetry, flagged: disposal is deterministic, nothing waits on GC).

Isolated runner, `--rounds 3`, vs Alien Signals (same process conditions;
three other entrants were benchmarking on the machine concurrently — treat
absolute numbers as noisy, ratios as indicative):

| suite | Royale FM1 | Alien | ratio |
|---|---|---|---|
| createSignals | 6.35 | 1.75 | 3.6x |
| createComputations | 176.6 | 59.1 | 3.0x |
| updateSignals | 436.3 | 272.1 | 1.6x |
| avoidablePropagation | 173.2 | 102.3 | 1.7x |
| broadPropagation | 178.8 | 81.5 | 2.2x |
| deepPropagation | 70.3 | 31.0 | 2.3x |
| diamond | 133.7 | 79.0 | 1.7x |
| mux | 137.9 | 79.1 | 1.7x |
| repeatedObservers | 16.0 | 18.9 | **0.84x** |
| triangle | 40.0 | 22.8 | 1.8x |
| unstable | 24.1 | 18.7 | 1.3x |
| molBench | 14.8 | 15.7 | **0.94x** |
| cellx1000 | 9.3 | 3.7 | 2.5x |
| cellx2500 | 41.9 | 11.5 | 3.6x |
| kairo 2-10x5 lazy80% | 255.7 | 146.1 | 1.8x |
| kairo 6-10x10 dyn25% lazy80% | 142.6 | 97.7 | 1.5x |
| kairo 4-1000x12 dyn5% | 318.6 | 264.8 | 1.2x |
| kairo 25-1000x5 | 306.5 | 347.6 | **0.88x** |
| kairo 3-5x500 | 132.0 | 72.6 | 1.8x |
| kairo 6-100x15 dyn50% | 201.8 | 151.9 | 1.3x |

Rough geometric mean ~1.7x alien (incumbents hover at parity). The Round 2
perf pass took the worst suites from 5-12x down to this: a live push-pull
shortcut (the stale wave is authoritative for live nodes, so clean live
computeds validate O(1)), an in-place dependency prefix fast path (steady
re-evaluations allocate nothing and never relink), frame-stamp dedupe
replacing per-run Sets, and a flush cursor replacing queue shifts. The
remaining gap is the value-aware seen column (my revert semantics cost one
comparison per edge per poll) and per-evaluation frame objects.

### React seam (bench/react-bench.mjs, jsdom, real timers, per-scenario child)

| scenario | stat | fm1 | stock uSES baseline |
|---|---|---|---|
| fanout (5000 cells, 200 writes) | median write->commit | 1.848 ms | 1.815 ms |
| transition (2000 cells + 30 urgent) | urgent p95 | 2.113 ms | 0.322 ms |
| mount (5000 cells, 5 roots) | median | 49.8 ms | 45.6 ms |

Reading the transition row honestly: the baseline's `startTransition` over a
uSES store **degrades to a blocking synchronous render** (React warns), so
its 30 urgent probes run against an idle tree. fm1 actually holds a
concurrent transition; its p95 pays real interruption cost. The apples-to-
apples rows are fanout (+12%) and mount (+10%).

## 6. Adjudications and disputes

- **Updater-queue order.** RULES.md's prose example ("transition x2, urgent
  +1, retirement shows 4") and the calibrated battery (scenarios 3 and 13:
  transition +1/+2 then urgent x2, retirement shows (1+1)*2 / (1+2)*2)
  cannot both hold under one deterministic replay order. I adopted the
  battery's semantics — full call-order replay of the per-atom write log,
  which is literally React's updater-queue arithmetic — and note that under
  it the RULES prose example evaluates to 3 (its "4" presumes the urgent
  write was issued first). My engine tests pin both call-order shapes.
- **Set-vs-set conflicts** follow the same rule: an urgent `set` issued
  after a transition's `set` to the same atom wins the final canonical
  value at retirement (React useState parity).

## 7. Known gaps and honest risks

- **Draft-world fetch identity**: a computed evaluated inside a draft
  snapshot re-runs per pass; if its function creates a fresh promise per
  call (no per-input cache), a held transition can refetch across restarts.
  Canonical/urgent evaluations always reuse the stable park promise; the
  battery's resource pattern (keyed cache) is unaffected.
- **committed(x, container)** is epoch-based: exact while any render pass
  pins history (the only time a root can lag canonical) and equal to
  canonical at quiescence; a root that never re-renders while *no* pass is
  pinned reads canonical rather than a forever-stale view. `committed` for
  computeds serves the canonical settled value (no per-root memo).
- **Batch discard** happens on explicit engine discard or test reset; React
  has no silent transition-drop path I hook (async-action abort rollback is
  untested).
- **Direct `atom.set()`** (engine API) during a live rebase episode
  bypasses the call-order log (classified writes via `set`/`update`/`write`
  are logged). The React bindings only issue classified writes.
- Benchmarks ran while three other entrants' suites ran on the same
  machine; treat absolute times as noisy.

## 8. With another day

- Trim `runtime.ts` subscriber bookkeeping (atomSubs/nodeSubs collapse to
  one map keyed by node) and fold `trace.ts` into hooks — ~60 lines.
- Fanout/mount overhead: skip Snapshot allocation for draft-free passes
  entirely (read canonical direct), pool the per-pass memo maps.
- An async-action abort test (does React ever drop a transition lane
  without committing?) and a real-browser mutation-window demo.
- A `latest()` overload that returns the park promise instead of undefined
  for never-settled values.
