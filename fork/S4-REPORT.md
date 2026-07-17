# Fork S4 report — runInBatch, lineage ids, ordering pin, classification: v1 surface COMPLETE (2026-07-05)

Branch `cosignal-fork` tip: `56178d8c13ac4b6fdcfc82dbc1a81dec6e576c17`.
**Feature-completeness verdict: the fork surface is complete for the v1
bindings per spec §4.** All seven §4.1 facts implemented and pinned; all
28 §4.4 test rows have reconciler-level pinning tests; capability bits
0–8 all set (`capabilities === 511`) on both handshake sides.

## Per item

**1. `React.unstable_runInBatch(token, fn)` — spec fact 4, bit `1<<6`.**

- **Live deferred token**: fn runs inside a transition pinned to the
  batch's own lane via a dedicated `requestTransitionLane` override in
  `ReactFiberRootScheduler` (`currentEventTransitionLane` and all its
  consumers untouched). Every update in fn joins the lane; same-lane
  updates entangle through React's ordinary hook-queue path. Writes
  inside classify into the same batch: `getCurrentWriteBatch() === token`,
  `isCurrentWriteDeferred() === true`.
- **Live urgent token**: fn runs at the lane's own event priority.
- **Retired/unknown/0**: documented fallback — DiscreteEventPriority,
  outside any transition; pinned to preempt even a yielded transition
  pass (default priority does not — the "urgent pre-paint" distinction).
- **Retiring-commit window**: a token stays addressable through its own
  retiring commit's `onRootCommitted` report; a delivery inside that
  listener lands on the outgoing token's lane (merge rule); token still
  retires exactly once. Pinned.
- **Legality**: event handlers, timers, layout effects, commit-phase
  listeners, yield gaps, and inside the `onRenderPassYield` listener
  itself (both yield emits fire after the RenderContext restore). During
  render it throws **error 605**.
- Nested calls compose (innermost pin wins, restore on return); fn is
  synchronous, result returned; the pin covers only fn's synchronous
  extent. Multi-renderer: first provider answers; zero providers ⇒ plain
  run.

**Seam finding fixed under this item:** a mid-render delivery on the
rendering lane lets React commit the completed tree _without_ the
delivered update (interleaved-update semantics — no pre-commit restart;
empirically confirmed), and the S3-era finish edge reported that commit
with an **empty delta** while the DOM visibly gained the batch's writes —
a per-root committed-table desync (tear window for the binding). Fixed:
the finish edge recognizes "pass rendered this batch's updates ∧ lane
re-pended by mid-render updates" (`updatedLanes |
concurrentlyUpdatedLanes` from commitRoot, gated by a per-root
render-time entangled-lanes stash so mid-flight entanglements whose
updates are not in the tree stay excluded) and reports the batch + adds
`committedRoots` lock-in while it stays pending. Flush-split shape
pinned in test 18: both commits report `[t]`, generations n/n+1, retire
once at the end. Reachable upstream without runInBatch (live-lane reuse
merge) — a general seam-correctness fix.

**2. Render lineage ids — spec fact 5, bit `1<<7`.**
`onRenderPassStart(container, includedBatches, lineageId)` — additive
third argument, positive integer. Stable per (root × batch-set): same id
across urgent-interrupt restarts, Suspense retries, and discardAllWip
re-schedules; new id for a restart that rebases in an extra batch, for a
fresh batch after commit, and per root for a spanning set. Dead at the
first commit that takes any of the set's lanes out of
`root.pendingLanes` (commit or prune); unrelated commits and the
mid-render re-pend split don't kill it. Key = canonicalized
included-token set **plus render-time entangled lanes** — deliberate
deviation from PLAN's tokens-only key, documented in the registry:
tokens alone alias unrelated token-free transitions; lanes alone miss
committedRoots lock-in set changes; lane recycling can't alias
(live-lane reuse IS the merge rule). Six pinning tests including
token-free distinctness and per-root distinctness for a spanning set.

**3. Test 26 / capture-at-entry — bit `1<<5`.**
§4.2 pinned as one ordered sequence within a single commit that closes a
frame, updates the table, retires two tokens, mutates the host tree, and
runs layout: `end(commit)` → `onRootCommitted(delta, gen)` →
`onBatchRetired`×2 → `onBeforeMutation` → `onAfterMutation` → layout
effect. Plus the functional baseline pin: a listener snapshotting its
mirror at `end(commit)` captures the **pre-commit** {generation, retired
count} — the commit's own folds/table update can't mask foreign motion
(the §5.10 fast-out's premise).

**4. S6 remainder — classification tests 1/3/4/5/6 + flag-3 pin.**
Discrete-handler writes urgent + distinct from the same event's ambient
default batch; timer/network ambient default; flushSync urgent +
synchronous commit + retire; nested scopes per callstack both
directions; per-write context stable across interleaved scopes in one
event, with same-event transitions sharing one token. Flag 3: a
re-wrapped async-action continuation gets the **same parked token**
(entangled action lane ⇒ same slot ⇒ explicit merge); a bare
continuation classifies ambient default (urgent); the parked token
retires exactly once, uncommitted, at action settle.

**Error codes**: 605 (runInBatch during render); 602/603/604 unchanged.
**Capabilities**: bits 0–8 = **511**, both baked-in copies; grow-only
rule documented.

## Gate table

| Gate                                                       | Result                                                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Fork suite default (experimental)                          | **47/47** (16 BatchRegistry + 14 Pass + 7 Commit + 10 RunInBatch), stable ×3; supervisor re-verified                                         |
| Fork suite www-modern / www-classic / stable               | **47/47 each**                                                                                                                               |
| Upstream suites (15-suite set)                             | **145 passed, 1 pre-existing skip**                                                                                                          |
| `yarn linc` / `yarn prettier-check` / `yarn flow dom-node` | pass                                                                                                                                         |
| `yarn extract-errors`                                      | code **605** assigned                                                                                                                        |
| `fork/build-react.sh`                                      | **`Built: 19.3.0 (56178d8c13)`** — artifact smoke: `capabilities === 511` both sides; `unstable_runInBatch` exercised through the built pair |

## Commits (b6da053b10 → 56178d8c13)

1. `2eba349f4d` runInBatch: schedule updates into a live batch's own lane (+ re-pend finish-edge fix, error 605, bit 6)
2. `cc7c33389a` Render lineage ids: stable per (root × batch-set), dead at commit/abandon (+ test 23, bit 7)
3. `56178d8c13` Intra-commit ordering pinned (test 26) + classification tests + flag-3 pin: all v1 capability bits set (bit 5)

Out of scope (PLAN S7 slack, not surface gaps): a `fork/PROTOCOL.md` doc
pass, multi-root flake hardening across repeated CI runs, act()-semantics
polish.

## Handoff notes for the bindings stage

1. **Exact API surface** (all on `react`):
   `unstable_runInBatch<R>(token: number, fn: () => R): R`;
   `unstable_discardAllWip(): void`;
   `unstable_subscribeToExternalRuntime(listener): () => void` with
   `onRenderPassStart(container, includedBatches: number[], lineageId: number)`,
   `onRenderPassYield/Resume(container)`,
   `onRenderPassEnd(container, committed: boolean)`,
   `onRootCommitted(container, committedBatches: number[], rootCommitGeneration: number)`,
   `onBatchRetired(token, committed)`, `onBefore/AfterMutation(container)`;
   `unstable_getCurrentWriteBatch(): number` (0 = none, bit 0 = deferred);
   `unstable_isCurrentWriteDeferred()`; `unstable_getRenderContext()`;
   `unstable_externalRuntimeProtocol` (`{version: 1, capabilities: 511,
providerProtocols}` — assert 511 or the specific bits needed).
2. **Deliver at the yield edge directly**: the `onRenderPassYield`
   listener runs outside RenderContext — the binding may call
   `runInBatch` synchronously inside it (pinned). `onRootCommitted`/
   `onBatchRetired` listeners may too. Only render throws (605);
   `discardAllWip` additionally throws in commit (604).
3. **The flush-split rule** (§5.10-relevant): a delivery landing
   mid-render on the batch's own lane produces TWO reported commits of
   that batch on the root (rendered-writes advance with lock-in, then
   the delivered update), retire once at the end. The binding's per-root
   table must treat re-reports idempotently (spec §5.3 set semantics)
   and its durable drain runs at each report — exactly the case-8 (d′)
   shape the oracle corrected.
4. **Baseline capture site**: capture {generation mirror, retired
   mirror} in `onRenderPassEnd(container, true)` — pinned to precede the
   same commit's table update and folds (test 26). Layout effects run
   after the mutation window; corrective urgent updates from listeners
   flush pre-paint (discrete — pinned to preempt even a yielded
   transition).
5. **Retired-fallback classification**: inside the fallback,
   `getCurrentWriteBatch()` mints/joins the ambient **SyncLane** batch —
   don't assume the corrective write is batchless.
6. **Lineage keys are per root**: a spanning batch has a different id
   per root — capsule maps must be root-scoped. Ids survive
   `discardAllWip` and unrelated commits; treat any new id at passStart
   as "different world" (extra-batch rebases included).
7. **Token-free passes have real lineage ids** (empty `includedBatches`,
   distinct ids) — safe to key canonical-world capsules on them too.
8. **Test recipes**: `checkFrameInvariants` lives in both Pass and
   RunInBatch test files (rootCommitted-consumes-end(commit) included);
   the suspensey-commit window (`<ViewTransition>` + `suspensey-thing`,
   `@gate enableViewTransition`) is the only reliable
   completed-but-uncommitted harness; use `ReactNoop.discreteUpdates`/
   `flushSync` for genuine same-root preemption (default won't).
