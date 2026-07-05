# Fork S2 report — existence-proof tests (2026-07-05)

Session S2 per `fork/PLAN.md`. All seven fork facts **PROVEN** in
current-generation React — no spec escalation needed. Branch
`cosignal-fork` tip: `65a8d89a97167844dee754646ea7e41d80b4101c`.

## Per fact (spec §4.4 numbering)

| Test | File › test name | Verdict |
|---|---|---|
| 15 per-root commit reported w/ generation, token live | `ReactFiberExternalRuntimeCommit-test.js` › "reports a spanning batch per root, with generations, while the token stays live" | **PROVEN** |
| 16 both roots in one flush; retire after last report; independent generations | same › "reports each root separately when a spanning batch commits on both in one flush" | **PROVEN** |
| 17 pruned root never reports the batch; retire once, committed=true | same › "never reports a batch on a root where its work was pruned by deletion" | **PROVEN** |
| 25 write-set closure at commit | same › "a commit exposes exactly the write set the committing pass rendered" (invariant replayed over all 7 commits) | **PROVEN** |
| 22 urgent commit discards older yielded pass before any committed-view advance | `ReactFiberExternalRuntimePass-test.js` › "an urgent commit discards an older yielded pass before any committed-view advance" | **PROVEN** |
| 24 insertion after completed-but-uncommitted ⇒ pre-commit restart | same › "an update inserted after a completed-but-uncommitted pass forces a pre-commit restart" | **PROVEN** |
| 28 no same-root committed-view advance while pass frame open (per-root scoped, cross-root control included) | same › "never advances a committed view while the same root has an open pass frame" | **PROVEN** |

Notable observed details:

- **Test 17 prune timing**: the prune resolves at the deleting commit
  itself (the transition lane leaves `pendingLanes` when the subtree
  dies; retirement fired there; resolving the gate afterwards was a
  no-op). The registry doc-comment's alternative "React eventually
  renders the orphan lane to nothing" path did **not** occur — S3+ must
  not rely on an extra orphan-lane commit existing.
- **Test 24 window**: built with `<ViewTransition>` (opts the subtree
  into `SuspenseyImagesMode`, giving a suspensey-commit window in the
  default channel where `enableSuspenseyImages` is off;
  `enableViewTransition` is default-true). Gated
  `@gate enableViewTransition`.

## Runtime changes (plan-anticipated, minimal)

- **`onRootCommitted(container, committedBatches, rootCommitGeneration)`**
  — fires on every commit (empty delta allowed; tests 22/28 need every
  advance observable); per-root WeakMap generation counter; report
  emitted **before** the retirements that commit causes (spec case-11
  step 6: report is cause, retirement consequence). Capability bit
  `1<<5` deliberately left unset — it also names the §4.2 ordering
  guarantee, pinned by test 26 in S6.
- **Noop renderer harness fix**: `resolveSuspenseyThing` threw "Expected
  commit to be a function" on a **canceled** suspended commit (interrupt
  then resolve — upstream never resolves after an interrupt). Fixed with
  an explicit `canceled` flag to match `ReactFiberConfigDOM`'s cancel
  semantics (`if (state.unsuspend)` skip); the invariant still catches
  genuine double-fires.

## Gates

| Gate | Result |
|---|---|
| Fork suite (default channel) | **17/17** (10 S1 + 7 new), stable ×3 runs; also 17/17 on `--release-channel=stable` |
| Upstream suites (S1's ten + suspensey extras) | **15 suites, 145 passed, 1 pre-existing skip** (S1's named set is a strict subset, all green); `ReactSuspenseyCommitPhase` also green on www-modern variant=true and =false |
| `yarn linc` | pass |
| `yarn flow dom-node` | pass (also `prettier-check` pass) |
| `fork/build-react.sh` | builds (~13s) — build label reads `(fcd2bf8f82)` because it was built pre-commit; content includes all S2 changes |

## Commits (fcd2bf8f82 → 65a8d89a97)

1. `2959f1b767` Per-root commit reporting: onRootCommitted(container, batches, generation)
2. `a496bbfbee` Existence proofs: per-root commit facts under multi-root schedules
3. `925210e6f8` Noop renderer: a canceled suspended commit is inert when resources resolve
4. `65a8d89a97` Existence proofs: pass/commit serialization and insertion edges

## For S3+

1. **Pre-existing www-channel gap**: all fork tests fail on
   `--release-channel=www-modern` — `React.unstable_subscribeToExternalRuntime`
   is undefined because `packages/react/index.fb.js` never got the S1
   exports. Verified pre-existing at S1 tip via stash (8/10 fail there
   too). Fix the fb entry or gate the suite.
2. **Frame semantics**: the current channel closes the pass frame at
   render completion (before commit); S3's end-disposition edges move
   the close to commit/discard — test 28's tracker and the Pass-test
   header comment mark exactly what changes.
3. **act() mechanics worth knowing**: `internal-test-utils` act sets
   `IS_REACT_ACT_ENVIRONMENT=false` and never populates `actQueue`, so
   `shouldForceFlushFallbacksInDEV()` is false and production commit
   paths (suspensey commits, throttling) run under act; the noop
   suspensey cache is timer-free, so suspended commits survive act
   boundaries — ideal for S3 yield/discard windows.
4. **Listener window**: retirement emits are deferred until after the
   same commit's `onRootCommitted`; a listener writing into a retiring
   lane during that callback lands on the outgoing token (merge rule;
   documented in the registry comment).
