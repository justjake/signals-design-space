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

- I did not run the official milomg or React seam benchmark, so this report makes no comparative performance claim.
- The shared hidden cross-entrant battery was not present as an executable command in this clone; the exact adapters are delivered, but only the local 179-case, oracle, fork, and 15-case real-React suites were executed.
- Render-pass discard tracing is inferred when a root starts a different lane set; a pass abandoned without any later render or commit may not emit its discard event until the root becomes active again.
- A computed that literally creates a brand-new network promise inside every evaluation can start one extra request when it re-evaluates after settlement; pending retries themselves are cached and do not re-evaluate. Applications should create or key-cache the resource promise outside the computed body.

## 6. What I would do with another day

I would add keyed async resource slots so inline promise factories cannot start the post-settlement extra request, run the official core and React seam benchmarks, profile the global React delivery fanout, and fuzz multi-root prune/commit races with suspended passes. After that, I would split world-only computed evaluation from the canonical class to reduce the 1075 library lines without touching the 91-line fork.
