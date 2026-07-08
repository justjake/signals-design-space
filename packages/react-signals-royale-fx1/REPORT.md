# signals-royale-fx1 — REPORT

## 1. Design summary

The store owns update scheduling; React only honors it. Every
transition-classified write opens an engine **episode**; the runtime claims a
React transition lane once and pins it on the transition object
(`transition._signalLane`), so every delivery for that episode — original
re-renders, corrective joins for components that mount mid-transition, and
async settlements the episode owns — dispatches under the same lane and lands
in the same commit. Values are one canonical base per atom plus a tagged
update queue replayed in scheduling order (React updater-queue arithmetic:
urgent ×2 over a pending +2 on 1 shows 2 now, 6 after landing). Render passes
read through an MVCC-pinned frame (base-at-seq + the episodes React said it
is rendering), so time-sliced renders never tear even against racing urgent
writes. Episodes retire when every root that received deliveries commits
them; retirement folds the queue and reclaims everything. The React fork
shrinks to one bridge module plus four call sites — honor the pin, report
pass starts, per-root commits, and the exact DOM mutation window — 80 diff
lines against upstream, versus the incumbent's 1510. Cold computeds keep
forward pointers only (dropping the last reference reclaims them); hot nodes
flip to push-invalidation, and marks are value-judged at poll time so
write-then-revert batches net to nothing.

## 2. Gates

| Gate | Command | Result |
|---|---|---|
| Typecheck (engine) | `pnpm typecheck` in `packages/signals-royale-fx1` | PASS (0 errors) |
| Typecheck (react) | `pnpm typecheck` in `packages/react-signals-royale-fx1` | PASS (0 errors) |
| Engine conformance | `npx vitest run tests/conformance.spec.ts` | PASS — **179/179** (`Tests  179 passed (179)`) |
| Randomized oracle | `npx vitest run tests/oracle.spec.ts` (default `ORACLE_SEEDS=300` × 90 steps; env-tunable; failures print seed + shrunk schedule) | PASS; deep sweep `ORACLE_SEEDS=1200` also PASS; 2 real bugs found and pinned in `tests/engine-regressions.spec.ts` |
| Engine suite total | `npx vitest run` in engine package | PASS — **195/195** (conformance + oracle + regressions + async + gc-leaks) |
| Real-React gate (own suite) | `npx vitest run` in react package | PASS — **26/26** across scenarios.spec.tsx (1-10), scenarios2.spec.tsx (11,12,15-18), hooks.spec.tsx, gc-leaks.spec.tsx |
| Shared battery (verify-kit) | `pnpm test` in `royale/verify-kit/battery` | PASS — **25/25** (all 18 scenarios) |
| Fork protocol tests | `cd vendor/react && yarn test --no-watchman ReactDOMSignalScheduler` | PASS — **8/8** |
| Upstream adjacent suites | `yarn test --no-watchman ReactAsyncActions ReactBatching ReactFlushSync ReactIncrementalScheduling ReactIncrementalUpdates ReactInterleavedUpdates ReactSchedulerIntegration ReactTransition ReactUpdatePriority ReactDefaultTransitionIndicator` | PASS — `Tests: 1 skipped, 121 passed, 122 total` (the skip is upstream's own gate) |
| Fork hygiene | `yarn prettier` (clean), `yarn linc` ("Lint passed"), `yarn flow dom-node` ("No errors!") | PASS |
| Leak audit (engine) | `npx vitest run tests/gc-leaks.spec.ts` (`--expose-gc`, forks pool) | PASS — 4/4: dropped computed collected; dropped effect disposer reclaimed via FinalizationRegistry; quiescence footprint all zeros; per-root views drop with subscribers |
| Leak audit (react) | `npx vitest run tests/gc-leaks.spec.tsx` | PASS — 2/2: subscriptions return to baseline after unmount; component-owned atom collected after unmount |

Representative outputs:

```
Tests  179 passed (179)      # conformance
Tests  195 passed (195)      # engine package total
Tests  26 passed (26)        # react package total
Tests  25 passed (25)        # shared battery
Tests: 8 passed, 8 total     # ReactDOMSignalScheduler (fork)
Tests: 1 skipped, 121 passed, 122 total  # upstream adjacent
No errors!  Flow passed for the dom-node renderer
```

## 3. LOC self-count

Measured with the orchestrator's counter:

```
node royale/verify-kit/count-loc.mjs \
  --fork vendor/react --base e71a6393e66b0d2add46ba2b2c5db563a0563828 \
  --head royale/fx1-react \
  --lib packages/signals-royale-fx1 --lib packages/react-signals-royale-fx1
```

- **Fork: 80** (`ReactFiberSignalScheduler.js` 44 new, `ReactFiberWorkLoop.js` +23, `ReactFiberRootScheduler.js` +13). Incumbent: 1510.
- **Library: 2307** (engine ~1698 + engine index 117 + tracer 86; react runtime 200 + hooks 184 + index 22; final count after the Round 2 tuning). Incumbents: alt-a 4689, alt-b 4909.

Raw `git diff --numstat e71a6393e6..HEAD -- packages/ ':!packages/*/src/__tests__*'` agrees: 80.

## 4. Performance

### React seam scenarios (`bench/react-bench.mjs`, NODE_ENV=production, fork build)

| scenario | stat | royale-fx1 | useSyncExternalStore baseline |
|---|---|---|---|
| fanout (5000 cells, 200 writes) | median write→commit | **0.431 ms** | 0.389 ms |
| transition (2000 burning cells in transition + 30 urgent inputs @16ms) | p95 urgent→commit | **5.29 ms** | 77.26 ms |
| mount (5000 cells × 5 roots) | median mount | **27.9 ms** | 27.4 ms |

The transition row is the fork's reason to exist: the baseline's "transition"
degrades to one synchronous render that freezes queued input for ~90 ms
(samples decay 93.2, 77.3, 61.3, … = one long block); the engine's pinned
lanes keep every urgent sample ≤ 5.5 ms while the same bulk render proceeds
concurrently and still lands. Leak note: both contenders unmount and hold no
registries afterward (no leak asymmetry).

### milomg js-reactivity-benchmark

See the Round 2 section for the isolated-runner table and ratio vs Alien
Signals.

## 5. Feature coverage

| Feature | Status |
|---|---|
| Writable atoms: custom equality, labels, lazy initializers (set-before-read runs initializer; SSR install does not) | done |
| Functional updates replaying in scheduling order per world | done |
| Computeds: lazy, cached, equality cutoff, dynamic deps with trimming, exact pull counts | done (179/179) |
| Effects + scopes with cleanup and disposers | done |
| batch/startBatch/endBatch (net-value coalescing), untracked | done |
| Lifetime effects (union of kinds, microtask coalescing, StrictMode nets one) | done |
| Write classification urgent vs transition; drafts invisible until commit | done |
| Render-pass consistency (MVCC-pinned frames; sibling and replay consistency) | done |
| Urgent-during-transition: commits alone; rebased retirement | done |
| Per-root committed views | done |
| flushSync excludes deferred work | done |
| Quiescence reclamation (`debugFootprint` all zeros; leak suites) | done |
| Read family: read/latest/committed/isPending/refresh | done (isPending on deriveds is topology-based: may over-report briefly, never evaluates/refetches — by design) |
| Async: evaluate-to-pending, parallel registration, stable thenable identity, forwarded pending, stable error boxes, settlement-as-write owned by its world | done |
| Two-level suspend-vs-stale at React boundaries | done |
| React hooks: useValue, useComputed, useAtom, useSignalEffect, useIsPending, useCommitted, useTransitionWrite/startTransitionWrite | done |
| Loud registration failure on stock React; write-during-render throws; multi-root; unmounted subscribers silent | done |
| SSR: serializeAtomState/initializeAtomState/installState | done |
| Causality log: ring tracer, causal parents, whyLastDelivery, bounded + counted overflow | done |
| DOM mutation window events (exact bracket, MutationObserver-verified) | done |

## 6. Known gaps and honest risks

- **isPending(computed) over-reporting**: for deriveds it answers from
  topology (do open episodes touch your sources?), not values, so a
  transition writing an upstream atom to an equal-after-fold value briefly
  reports pending. Atoms are exact. Chosen so the probe can never evaluate
  (and therefore never refetch or suspend).
- **Two overlapping independent transitions**: React may batch multiple
  pending transition lanes into one render pass; the engine folds all
  included episodes, and they may commit together (never early, never torn).
  Retirement order is commit order; ops still replay in scheduling order.
- **Speculative-only dependencies** (a computed that reads different atoms
  inside a draft world than canonically) notify through per-subscriber
  touched-cell sets. Sound for subscribers that rendered the draft;
  over-notification is possible, under-notification is not.
- **Refetch-on-equal-refresh downstream**: a refresh that settles to an equal
  value still bumps the computed's version through the pending interlude, so
  downstream async computeds re-fetch. Documented; fetch-count gates pass.
- **Fork lane cycling**: pinned lanes come from React's 15-lane transition
  pool; a very long-lived episode can share a lane with a later transition
  (they entangle — commit together). Same failure mode as stock React's lane
  reuse; never a tear.
- The milomg numbers were measured on a machine shared with 11 concurrent
  entrants; treat absolute times as noisy.

## 7. With another day

- Close the remaining kairo gap to alien (profile shows the poll-then-eval
  double walk and effect-queue bookkeeping as the next ~30%).
- Property-based fuzz for the async family (thenable schedules × worlds), the
  way the sync oracle fuzzes writes.
- A `useSelector(computed, selector)` hook with render-equality cutoff at the
  selector level.
- Wire the daishi tearing matrix and react-seam-bench contender into their
  runners in-repo (adapters are written and typechecked; the harnesses
  themselves were not runnable in this clone).

## Round 2 — verification transcript

All gates re-run fresh, in order, after the final tuning changes.

### Typecheck

```
$ pnpm -C packages/signals-royale-fx1 typecheck        # tsc --noEmit
(exit 0, no output)
$ pnpm -C packages/react-signals-royale-fx1 typecheck  # tsc --noEmit
(exit 0, no output)
```

### Conformance (179) + engine suite

```
$ npx vitest run   # packages/signals-royale-fx1
 ✓ tests/conformance.spec.ts (179 tests)
 ✓ tests/oracle.spec.ts (1 test)         # 300 seeds x 90 steps
 ✓ tests/engine-regressions.spec.ts (2)
 ✓ tests/async.spec.ts (9)
 ✓ tests/gc-leaks.spec.ts (4)
 Tests  195 passed (195)
```

### Oracle deep sweep (4× seeds)

```
$ ORACLE_SEEDS=1200 npx vitest run tests/oracle.spec.ts
 ✓ oracle fuzz: 1200 seeds x 90 steps
 Tests  1 passed (1)   Duration  1.86s
```

### Leak audits

```
$ npx vitest run tests/gc-leaks.spec.ts    # engine: 4 passed
$ npx vitest run tests/gc-leaks.spec.tsx   # react: 2 passed
```

### Fork protocol suites + upstream adjacency (vendor/react)

```
$ yarn test --no-watchman ReactDOMSignalScheduler
Tests:       8 passed, 8 total
$ yarn test --no-watchman ReactAsyncActions ReactBatching ReactFlushSync \
    ReactIncrementalScheduling ReactIncrementalUpdates ReactInterleavedUpdates \
    ReactSchedulerIntegration ReactTransition ReactUpdatePriority \
    ReactDefaultTransitionIndicator
Tests:       1 skipped, 121 passed, 122 total
$ yarn flow dom-node
No errors! Flow passed for the dom-node renderer
```

Patch-series reproducibility: applied `patches/*.patch` onto a pristine
worktree at the base commit with `git am`; build metric on the pristine tree
is the same 80 lines.

### Real-React gate

```
$ npx vitest run   # packages/react-signals-royale-fx1
 ✓ tests/scenarios.spec.tsx (9)   # scenarios 1-10
 ✓ tests/scenarios2.spec.tsx (10) # scenarios 11,12,15,16,17,18
 ✓ tests/hooks.spec.tsx (5)
 ✓ tests/gc-leaks.spec.tsx (2)
 Tests  26 passed (26)
```

### Shared battery (royale/verify-kit)

```
$ npx vitest run   # royale/verify-kit/battery, ADAPTER -> royale/adapter.ts
 Tests  25 passed (25)
```

### Tuning changes made in Round 2, and why

- `truncateSources` early-returns on a stable dependency set (the three array
  length writes were the hottest line in kairo profiles; a stable set has
  nothing to trim).
- Marks/verify hot path: `typeof`-guarded box checks, `isCell` discriminator
  instead of `instanceof` in `edgeStamp`/`sourcesChanged`, inline completion
  for plain synchronous evaluations.
- Zero-allocation urgent writes (`set`/`update` pass the operation as two
  arguments; queue objects only exist while an update queue exists).
- Effects owned by a scope skip their own FinalizationRegistry entry (the
  owner's registration already guarantees reclamation of dropped handles).
- Commit reporting is O(changed) when no worlds are in play: per-root screen
  snapshots and their pruning only run while episodes exist (this was an
  O(subscribers) walk per urgent commit — the 5000-cell fanout paid 17 ms per
  single-cell write before, 0.43 ms after).
- Effect flush drains with a cursor and one catch frame per error instead of
  `Array.shift` and one per effect.

Net effect on kairo broadPropagation (local micro-harness, 500 iterations):
536 ms → 110 ms; alien-signals on the same harness: 64 ms.

### milomg js-reactivity-benchmark (isolated runner)

Machine note: measured while up to six other entrants ran benchmarks on the
same host; absolute numbers are noisy, the ratio column is the signal.
| suite | Royale FX1 (ms) | Alien Signals (ms) | ratio |
|---|---|---|---|
| createSignals | 0.96 | 1.01 | 0.95x |
| createComputations | 236.22 | 33.87 | 6.97x |
| updateSignals | 353.54 | 279.47 | 1.27x |
| avoidablePropagation | 153.90 | 96.45 | 1.60x |
| broadPropagation | 145.29 | 81.47 | 1.78x |
| deepPropagation | 49.40 | 31.60 | 1.56x |
| diamond | 112.52 | 80.55 | 1.40x |
| mux | 136.31 | 79.20 | 1.72x |
| repeatedObservers | 15.93 | 18.21 | 0.87x |
| triangle | 33.79 | 23.58 | 1.43x |
| unstable | 25.60 | 18.72 | 1.37x |
| molBench | 14.74 | 14.98 | 0.98x |
| cellx1000 | 17.14 | 3.98 | 4.31x |
| cellx2500 | 64.24 | 10.49 | 6.12x |
| 2-10x5 - lazy80% | 218.56 | 144.75 | 1.51x |
| 6-10x10 - dyn25% - lazy80% | 118.84 | 101.52 | 1.17x |
| 4-1000x12 - dyn5% | 281.59 | 267.04 | 1.05x |
| 25-1000x5 | 288.25 | 357.84 | 0.81x |
| 3-5x500 | 121.18 | 77.93 | 1.55x |
| 6-100x15 - dyn50% | 175.34 | 166.03 | 1.06x |

Geometric-mean ratio vs Alien Signals: 1.58x

Run shape: `node --expose-gc dist/index.js "<name>"` per framework,
sequential (one framework per process, matching the isolated runner's
one-per-process rule), current bundle, zero `console.assert` failures for
both frameworks. Reading the table: creation-dominated suites
(createComputations, cellx) are the engine's honest gap — effect/computed
construction costs ~7x alien's; propagation suites sit at 1.3–1.8x; several
suites (createSignals, repeatedObservers, molBench, 25-1000x5) are at parity
or ahead. The geometric mean over all suites is 1.58x alien — same class,
not parity, bought alongside the world/episode machinery alien does not
carry.
