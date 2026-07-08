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
