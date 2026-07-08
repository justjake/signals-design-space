# Signals Royale — sx2 report

## Design summary

Every value is an async cell; settled synchronous state is the compact fast path, while pending reads, stale refreshes, errors, and transition drafts extend the same cell record. Deferred writes are replayable operations keyed directly by React's transition lane, so urgent state stays canonical and a retiring transition replays over that newer base. A render reads canonical state plus exactly the live lanes reported by React, while committed values are captured separately per root. Computeds use the same dependency links whether observed or detached, with render-world evaluation only at the React boundary. Pending thenables are collected as graph state and become a stable aggregate only when a read reaches a Suspense boundary. The fork reports facts React already owns—write lane, render world, pass disposition, root commit, finished lanes, and mutation edges—and adds only lane-pinned scheduling as a mechanism. This canonical-cell design was kept deliberately separate from root views and trace state because those lifetimes must legitimately disagree.

## Gates

| Gate | Command | Result | Headline |
|---|---|---|---|
| Engine typecheck | `cd packages/signals-royale-sx2 && pnpm typecheck` | PASS | strict `tsc --noEmit`, zero errors |
| React package typecheck | `cd packages/react-signals-royale-sx2 && pnpm typecheck` | PASS | strict `tsc --noEmit`, zero errors |
| Engine conformance | `cd packages/signals-royale-sx2 && pnpm vitest run tests/conformance.spec.ts tests/oracle.spec.ts tests/gc-leaks.spec.ts --reporter=verbose` | PASS | conformance 179/179; focused run 181/181 |
| Randomized oracle | same focused command | PASS | 300 seeds × 90 steps = 27,000 operations; seed and shortest failing prefix are printed on failure |
| Leak audit | same focused command | PASS | dropped cell collected under `--expose-gc`; retired episode left `liveBatchIds() === []` |
| Complete engine suite | `cd packages/signals-royale-sx2 && pnpm test` | PASS | 4 files, 192/192 tests |
| Real-React gate | `cd packages/react-signals-royale-sx2 && pnpm test` | PARTIAL | 2 files, 13/13 tests; all listed scenarios except a real-DOM CPU time-slice assertion are covered |
| Fork protocol and adjacent upstream suites | `cd vendor/react && yarn test --no-watchman ReactExternalSignals ReactTransition ReactFlushSync` | PASS | 5 suites; 48 passed, 1 upstream skip; own protocol suite 5/5 |
| Fork build | `./packages/react-signals-royale-sx2/build.sh` | PASS | NODE_DEV/NODE_PROD React, React DOM, and Scheduler bundles; `Built: 19.3.0 (d9034d1ca3)` |
| Formatting/diff | React `yarn prettier`; package Prettier; `git diff --check` | PASS | clean |
| Performance benchmarks | milomg and react-seam runners | NOT RUN | adapters are delivered, but no benchmark numbers are claimed |

Real output excerpts:

```text
Test Files  4 passed (4)
Tests       192 passed (192)

✓ tests/oracle.spec.ts > randomized replay oracle (300 seeds x 90 steps by default)
✓ tests/gc-leaks.spec.ts > dropped cells reclaim and retired episodes leave no live batches
Test Files  3 passed (3)
Tests       181 passed (181)
```

```text
Test Files  2 passed (2)
Tests       13 passed (13)
```

```text
PASS ReactExternalSignals-test.js
PASS ReactTransition-test.js
PASS ReactTransitionTracing-test.js
PASS ReactFlushSync-test.js
PASS ReactFlushSyncNoAggregateError-test.js
Test Suites: 5 passed, 5 total
Tests:       1 skipped, 48 passed, 49 total
```

The deterministic fork test `lets urgent work interrupt a lane-pinned correction` passes. I also attempted the required CPU time-slicing assertion with real `createRoot`; its pure-React control produced the same non-interrupting observation in this jsdom/Vitest setup, so I removed that inconclusive test instead of reporting it as a pass.

## LOC self-count

Fork production metric: **112** insertions + deletions.

```sh
git -C vendor/react diff --numstat e71a6393e6..HEAD -- packages ':!packages/*/src/__tests__*' \
  | awk '{a+=$1+$2} END {print a}'
```

Library metric: **1,261** nonblank, non-comment lines after Prettier `--print-width 100` normalization across both `src/` directories. The count streamed each normalized source file through an `awk` state machine that excludes blank lines, line comments, and block-comment-only lines.

## Feature coverage

- Writable signals, equality, labels: done.
- Lazy initialization at first materialization, including set-before-read: done; initialization is untracked and writes are rejected.
- Functional reducer replay: done; the `(1 + 1) × 2 = 4` schedule is pinned.
- Lazy cached computeds, dynamic dependency trimming, equality cutoff, exact pull behavior: done; 179-case suite passes.
- Effects, nested effect scopes, cleanup, and deterministic disposal: done.
- `batch`, `startBatch`, `endBatch`, and `untracked`: done.
- Observation-lifetime effects across computed, effect, and React subscribers: done; StrictMode netting is tested.
- Urgent/deferred write classification and draft invisibility: done through the fork protocol.
- Render-pass consistency and sibling no-tear behavior: done.
- Urgent-during-transition rebase and pruned-transition rollback: done and tested.
- Per-root committed views and one batch spanning two roots: done and tested.
- `flushSync` exclusion: done and tested.
- Quiescent episode reclamation and store-only transition retirement: done and tested.
- Canonical, latest, committed, isPending, and refresh read family: done.
- Pending/error graph state and parallel `useThenable` registration: done.
- Stable Suspense thenables, first-load suspension, stale refresh, and transition-owned settlement: done for the tested direct-use resource shape.
- React subscribing read with commit subscription and late-subscribe lane fixup: done.
- `useComputed`, `useSignalEffect`, `useCommitted`, `useIsPending`, transition helper, and component-owned atom: done.
- Loud rejection on stock React and write-during-render rejection: done.
- Multiple roots, StrictMode, and unmounted-subscriber cleanup: done.
- SSR serialization, keyed installation without lazy initialization, and matching first render: done.
- Causality tracer, bounded ring, overflow count, component/effect chains, render/commit events, and Suspense settlement: done.
- Exact DOM mutation window surfaced to userland: done; real `MutationObserver` test passes.
- CPU time-slicing responsiveness: protocol-level deterministic interruption passes; real-DOM CPU interruption remains unverified.

## Known gaps and honest risks

- The real-React suite does not claim the CPU-bound time-slicing scenario. The deterministic ReactNoop protocol test proves the lane-pinned correction is interruptible, but the jsdom control could not distinguish the same behavior using pure React state.
- No milomg or React seam benchmark was run, so the entry makes no performance ranking claim. Atom delivery is cell-local; computed render subscribers currently use conservative graph-wide invalidation.
- The async evaluator is strongest for direct `useThenable` resources. Arbitrary JavaScript that dereferences a value after a pending `useThenable` returns its placeholder, or creates new uncached promises inside a multi-read computation, remains a risk because JavaScript provides no resumable continuation at that call site.
- Store-only batches close in a binding microtask when no current subscriber claimed a root. A transition that both mounts its first-ever subscriber and writes the cell in the same event is the least-tested edge of that heuristic.
- The cross-entrant hidden battery, Daishi matrix, and benchmark runners were not available as executable registrations in this clone; their exact adapters are present but were not run here.

## What I would do with another day

First I would wire the delivered adapters into the shared battery and both benchmark runners, then promote a real-browser time-slicing test that has a trustworthy pure-React control. Next I would replace placeholder async evaluation with an explicit resource-loader API that can memoize arbitrary fetch factories and preserve transformed multi-read continuations without refetching. Finally I would make computed React subscriptions dependency-local and stress the first-subscriber/store-only schedule across multiple roots.

<oai-mem-citation>
<citation_entries>
MEMORY.md:114-117|note=[kept canonical render and committed lifetimes distinct and claims explicit]
MEMORY.md:499-504|note=[used active-view and Suspense mount risks to shape verification]
</citation_entries>
<rollout_ids>
019f2f97-9d59-7f02-bf46-d11f4835ee2b
019f11f4-ef9b-7222-864f-682bc53808bb
</rollout_ids>
</oai-mem-citation>
