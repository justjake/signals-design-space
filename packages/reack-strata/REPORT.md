# Strata report

## Design

Strata keeps one canonical push-pull graph and adds operation journals only while
React has live lanes. A journal stores `set` values and functional `update`
operations in issue order, so each render world folds the same operations over its
own committed base without copying the graph. React owns lane choice, render-pass
boundaries, commit boundaries, and the DOM mutation bracket; the 157-line fork
reports those facts through one unstable bridge. The binding owns all policy:
per-root cutoffs, branch retirement, subscription claim, correction scheduling,
committed effects, and causality. Render candidates subscribe before commit to
close the render/subscribe gap, then layout promotion gives the committed candidate
the lifetime observation. Unobserved computeds remain pull-only, while observed
consumers use direct subscriber edges with a single-subscriber fast path. Async
state and refreshes use the same operation journal rather than a second transition
model.

## Gates

| Gate | Command | Result |
| --- | --- | --- |
| Core typecheck | `cd packages/strata && pnpm typecheck` | pass |
| React typecheck | `cd packages/reack-strata && pnpm typecheck` | pass |
| Core suite | `cd packages/strata && pnpm test` | 6 files, 191 tests pass |
| Shared conformance | `cd harness && FRAMEWORK=strata pnpm conformance` | 179/179 pass |
| Deep oracle | `STRATA_ORACLE_SEEDS=1200 pnpm exec vitest run tests/oracle.spec.ts` | 1,200 × 90 schedules plus 3 named regressions pass |
| Leak audit | core and React `vitest run tests/gc.spec.*` | core 2/2, React 1/1 pass with exposed GC |
| React suite | `cd packages/reack-strata && pnpm test` | 7 files, 20 tests pass |
| Shared React battery | canonical battery rewired only to the adapter/build, then `pnpm typecheck && pnpm test` | typecheck pass, 25/25 pass; canonical files restored byte-for-byte afterward |
| Fork formatting | `yarn prettier` | pass |
| Fork Flow | `yarn flow dom-node` | pass, no errors |
| Fork protocol | `yarn test --no-watchman ReactStrata-test` | 3/3 pass |
| Adjacent upstream React | `yarn test --no-watchman ReactIncrementalUpdates-test ReactDOM-test ReactStartTransition-test` | 35/35 pass |
| Pristine patch build | `./build.sh /private/tmp/strata-react` | patch applies to `v19.2.7`; NODE_DEV and NODE_PROD React, React DOM, server, and scheduler bundles pass |
| Daishi browser matrix | Strata adapter, production fork, `LIBS=strata npx playwright test` | 10/10 pass, including interruption and branching |
| Milomg adapter sanity | `pnpm exec vitest run` in benchmark core | all 4 Strata cases pass; full command is 79/80 because the pre-existing x-reactivity partial-read case fails |

Representative final output:

```text
Test Files  1 passed (1)
Tests       179 passed (179)

Test Files  1 passed (1)
Tests       25 passed (25)

Running 10 tests using 1 worker
10 passed (1.4m)

Flow passed for the dom-node renderer
```

## Lines of code

Command:

```sh
node royale/verify/count-loc.mjs \
  --fork /private/tmp/strata-react --base v19.2.7 --head HEAD \
  --lib packages/strata --lib packages/reack-strata
```

Result: **157 fork lines** and **2,665 normalized library lines**. The fork is
89.6% smaller than the 1,510-line incumbent. The library is 43.2% smaller than
the 4,689-line smaller incumbent baseline. Product lines break down as 79 in the
work loop, 47 in the public bridge, 22 in shared-internals typing, 9 entry exports,
1,869 in the engine and tracer, and 796 in the React binding.

## Performance

The complete isolated one-round milomg run put Strata at **1.793× Alien Signals**
by geometric mean over all 20 rows, **1.631×** when the three creation/update rows
are excluded, and **1.360×** over the six dynamic-graph rows. Strata is therefore
not the core speed winner. Against Cosignal Alt B in separate isolated children,
Strata's geometric mean was 0.927× overall and 0.826× on the dynamic rows; this is
directional rather than a statistically interleaved claim. The official
three-round wrapper repeatedly returned partial child tables on this machine, so
those partial results are deliberately not reported as medians.

Selected complete-run milliseconds:

| Case | Strata | Alien | Alt B |
| --- | ---: | ---: | ---: |
| create signals | 6.23 | 2.48 | 22.21 |
| create computeds | 265.10 | 54.89 | 144.38 |
| broad propagation | 170.70 | 85.79 | 163.88 |
| deep propagation | 53.69 | 32.46 | 70.45 |
| diamond | 148.84 | 85.25 | 175.06 |
| mol | 14.67 | 14.50 | 16.72 |
| dynamic 4×1000×12 | 337.77 | 266.27 | 525.55 |
| dynamic 25×1000×5 | 338.70 | 327.79 | 536.82 |
| dynamic 3×5×500 | 125.86 | 85.00 | 112.53 |

The React seam benchmark is stronger. Three interleaved rounds produced:

| Scenario | Strata | Alien/useSyncExternalStore | local React state |
| --- | ---: | ---: | ---: |
| fanout median write → commit | 1.79 ms | 1.92 ms | 1.87 ms |
| transition urgent p95 | 1.58 ms | 1.55 ms | 1.48 ms |
| mount 5,000 cells | 71.94 ms | 60.39 ms | 59.48 ms |

Strata's median urgent maximum across those transition rounds was 3.42 ms versus
14.26 ms for the external-store adapter. Mount is 19% slower than that adapter and
is the clear React hot spot.

Final retained heap, shared adapter, kilobytes:

| Shape | Strata | Alien | Alt B |
| --- | ---: | ---: | ---: |
| 10k atoms | 3,868 | 3,059 | 3,846 |
| 10k computeds | 5,988 | 3,527 | 6,224 |
| 10k effects | 10,497 | 3,869 | 4,688 |
| 100×100 grid | 16,875 | 7,093 | 11,481 |

## Feature coverage

- Writable atoms, lazy initialization, equality, labels, reducers: done.
- Lazy cached computeds, equality cutoff, dynamic dependency trimming: done.
- Functional transition updates replay over urgent canonical updates: done.
- Effects, nested scopes, cleanup, batching, and untracked reads: done.
- Union lifetime observation across graph, effects, and React with tick coalescing: done.
- Frozen render worlds, urgent/deferred branches, rollback, and per-root views: done.
- `latest`, canonical, per-root `committed`, `isPending`, and `refresh`: done.
- Parallel async reads, stable joined thenables, stale refresh, and latest-wins settlement: done.
- React reads, owned atoms, computed hooks, committed effects, pending reads, and transitions: done.
- Signal-only `useSignalEffect` delivery without a forced component render: done.
- Request-isolated `Runtime`, serialization, initialization, and install-without-materialization: done.
- Bounded causal log with overflow count, causal parents, chains, and explanations: done.
- Exact React DOM mutation start/stop events: done.
- Reproducible React 19.2.7 patch and NODE_DEV/NODE_PROD build: done.

## Known gaps and risks

- Alien remains materially faster and smaller in the core hot paths. Strata spends
  more on class instances, version arrays, effect ownership, and general async/world
  capability.
- React mount and retained effect/grid memory are worse than both comparison floors.
  Candidate arrays and pre-commit journal subscriptions are the likely next target.
- A JavaScript `throw undefined` is not distinguishable from “no error” in the
  current internal error sentinel. Normal `Error` objects and rejected promises are
  covered. This was left explicit rather than adding state for an unconfirmed edge.
- The DOM renderer is tested; simultaneous use by multiple different React
  renderers in one JavaScript realm is not.
- Runtime isolation is complete at the engine level. Hooks that construct their own
  values (`useAtom`, `useComputed`, and `useSignalEffect`) use the default runtime;
  request-scoped code should construct values from its `Runtime` and pass them to
  `useSignal`.

## With another day

I would profile React mount allocations first, then replace effect dependency
version arrays with a compact edge record only if the profile justifies the extra
code. I would also add an explicit error-present bit if `throw undefined` matters,
exercise a second renderer, and make the official multi-round benchmark runner
report child termination instead of silently producing partial tables.
