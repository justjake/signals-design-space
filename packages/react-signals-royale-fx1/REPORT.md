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
- **Library: 2297** (engine 1688 + engine index 117 + tracer 86; react runtime 200 + hooks 184 + index 22). Incumbents: alt-a 4689, alt-b 4909.

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
