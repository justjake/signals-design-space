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

<oai-mem-citation>
<citation_entries>
MEMORY.md:79-99|note=[used prior signal design cautions about explicit verification boundaries]
</citation_entries>
<rollout_ids>
019f2f97-9d59-7f02-bf46-d11f4835ee2b
</rollout_ids>
</oai-mem-citation>
