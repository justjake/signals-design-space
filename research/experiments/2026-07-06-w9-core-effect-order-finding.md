# W9 core-effect deletion — stopped at the corpus gate: sibling firing order

**Status: RESOLVED (2026-07-06, same day). Owner ruled option 1 — "sibling core-effect
firing order is implementation specific" — ratified as contract clause EF4
(spec/react-compliance-contract.md §3.6). The deletion was re-applied from the edit
list below plus four riders: multiset comparison of same-operation core-effect-run
blocks in the lockstep differ, per-mount ordinals in referee effect names (the
collision noted below), the EF4 clause, and the graphviz dead-arm + TwinDriver
effect-id map. Corpus 100% clean under the multiset differ; a strict-comparator probe
reproduced the census below to the seed (ordering-only, nothing else). W21 closed as
moot (newestReaches deleted).**

W9 (panel item): delete the bridge's synthetic "newest-policy" core-effect machinery
(`mountCoreEffect`, `newestReaches`, the full-scan flush, ~16 policy-conditional sites)
so the kernel's real `effect()` is the only implementation, re-pointing the reference
model at real notification timing. Owner ruling: "effects should fire at the
appropriate time, not synchronously."

## Outcome

The deletion + re-point was fully built and is mechanically sound — every suite except
the lockstep fuzz corpus passed with zero expectation re-baselines. The corpus diverges
on exactly one class, which the approved oracle co-evolution cannot legally absorb:
**the intra-step ORDER in which multiple core effects fire under one write.** Kernel
`effect()`s run in the kernel's propagation order over its subscriber-link lists (a
mutation history), while the oracle flushes its `coreEffects` map in mount-id order.
Making the corpus pass would require either modeling kernel link-list dynamics in the
oracle (semantic modeling beyond the described timing re-point) or relaxing the compared
stream (weakening a checker). Both were forbidden by the task, so: stop, capture minimal
schedules, revert.

## What diverges, precisely

Strict corpus census with the change in place: **21/300 CI seeds** (15, 16, 38, 62, 66,
72, 78, 82, 95, 98, 111, 121, 134, 221, 234, 245, 272, 276, 290, 292, 299) and **7/8
long seeds** diverge. **Every one is ordering-only**: a diagnostic differ identical to
`diffAgainstModelTolerant` except that maximal contiguous blocks of `core-effect-run`
events were sorted by (effect, value) on both sides ran the full 308-seed corpus
**100% clean** — legality, full snapshots (newest/committed/pass values at every step),
delivery bounds, all other events, and every core-effect-run's step placement and value
agree exactly. (The diagnostic spec was deleted after the run; shipped checkers were
never touched.)

Minimal schedules (shrunk by the corpus tooling):

- **Seed 15 → 5 ops:** `[{bareWrite b=5}, {write flag=5}, {coreEffect node 1 (atom a)},
  {coreEffect node 6 (cChain)}, {write a=1}]` — engine emits `[CE(cChain)=11, CE(a)=1]`,
  model `[CE(a)=1, CE(cChain)=11]`. Kernel propagation from `a` descends `a`'s
  subscriber list in link order: `cFlip`'s link (created by an earlier snapshot
  evaluation) precedes the later-mounted direct effect's link, so the DFS reaches the
  *downstream* effect on `cChain` first and queues it first; the model fires in
  mount-id order.
- **Seed 9001 → 9 ops (the clincher):** `[open, {write b inc}, passStart,
  {coreEffect cFlip}, discardAllWip, {coreEffect atom b}, {write flag=1},
  {write flag=0}, {write b double}]` — engine `[CE(b)=2, CE(cFlip)=2]`, model
  `[CE(cFlip)=2, CE(b)=2]`. The *earlier-mounted* effect fires *second*: the two flag
  flips made `cFlip` re-derive and **relink** `b` — the kernel unlinks and re-appends at
  the tail of `b`'s subscriber list — so `b`'s list order became `[CE(b)-effect, cFlip]`.
  Engine order depends on **link-creation *and relink* history**, not on mount order
  plus static topology. The oracle cannot reproduce it with any bounded tweak to its
  flush: it would need ordered per-node dependents lists with append-on-first-link and
  move-to-tail-on-relink semantics plus DFS propagation order — i.e., modeling the
  kernel's link discipline.

## What was built and verified before the stop (all reverted; re-appliable)

**Engine deletions** (line refs into the restored `packages/cosignal/src/concurrent.ts`):
the `policy: 'newest'` doc arm + field and both sentinels (`root:''`, `node`) in
`Subscription` (:563–590); the stale `subsByNode` comment (:1405); `newestSubCount`
(:1571) and its 4 uses; the settlement-drain flush arm (:3255); the quiet-fold flush arm
(:3909); the direct-write flush (:4001); the post-delivery-walk `flushNewestSubs` call
(:4091); `flushNewestSubs` (:4136–4161); `runNewestSub` (:4163–4172, both callers gone →
deleted); `newestReachSeen` (:4174); `newestReaches` (:4176–4193); `directFlushCoreEffects`
(:4195–4204 — all three call sites exist only for the newest policy, so it loses its
last caller and goes entirely); `mountCoreEffect` (:4409–4421); policy checks in
`captureRun` (:4437), `removeSubscription` (:4483–4486), `replayReactEffect` (:4503),
`consumerCount` (:3281), `revalidateCommittedSubs` (:4555). One **addition**: a 2-line
referee seam `logCoreEffectRun(name, value)` through the `log()` waist, so the referee's
kernel-effect wrappers mint `core-effect-run` with the same retention/cursor/
trace-causality semantics (trace.spec's cause-chain assertions passed unchanged).

**Re-point:** `tests/helpers.ts` gained `mountEngineCoreEffect` — a real kernel
`effect()` whose body does a plain tracked kernel read of `node.handle.state` (host
routing is bypassed inside a kernel frame), baselines silently on the mount run, then
value-gates (`Object.is`) and reports via the seam. TwinDriver's `mountCoreEffect`,
oracle-adapter's `coreEffect` op, trace.spec, trace-off.spec (graphviz case switched to
a committed observer), and quiet-mode.spec were re-pointed to it.

**Oracle co-evolution (model.ts only):** the concurrent write flushes core effects only
when the write advances the atom's newest fold (stepwise-equality gate, mirroring the
eager kernel apply) and before the delivery loop; the direct-mode write flushes only
inside the value-changed branch. `schedule.ts` and `invariants.ts` needed nothing.

**Tallies with the change in place:** cosignal 2 failed | 312 passed | 1 skipped — the
two failures are exactly the two corpus tests (300×80 and 8×400); smoke seeds and
flag-finding seeds (29/97/173) passed. typecheck clean. oracle 81 passed | 1 skipped
with **zero** re-baselines.

**Tallies after restore:** cosignal 314+1; typecheck clean; oracle 81+1; conformance
179/179 for both cosignal-concurrent and arena.

## Premise corrections

- **The expected risk did not materialize.** No untracked-sampling timing shifts: the
  old synthetic per-write re-check was a pull, idempotent between newest-advances, and
  the kernel effect pulls at exactly the newest-advance moments. The canonicalized
  corpus (values + placement exact) proves the class is empty. The actual blocker —
  kernel flush order — was not in the risk list.
- **One out-of-scope consumer:** `packages/cosignal/src/graphviz.ts:47–55` renders the
  newest-policy arm (`e.policy`/`e.node`); the deletion cannot typecheck without a
  3-line dead-arm removal there.
- **Effect-id desync:** the model's `nextEffect` ticks for core effects, the engine's
  (post-deletion) only for committed observers, so twin `removeReactEffect`/
  `replayReactEffect` need a model-id → engine-id map in TwinDriver (implemented;
  trivial).
- **Referee name collisions:** two `coreEffect` mounts with no intervening event/seq
  mint identical `CE${events}.${seq}.${epoch}` names (seed 15's shrink shows `CE3.3.0`
  twice). Benign today; must be fixed if ordering is relaxed, since duplicate names make
  multiset comparison ambiguous.
- **W21 is moot if W9 lands:** the deletion removes `newestReaches` entirely;
  `closureOverKernel` (:5278) remains the sole kernel-link walker.

## The decision (owner's)

1. **Rule intra-write core-effect interleaving out of the observable contract** and
   compare `core-effect-run` per step as a multiset (checker semantics change — the
   diagnostic shows this exact comparator passes 308/308), or
2. **extend the oracle to model kernel subscriber-link order** (ordered dependents
   lists, append-on-link, move-to-tail-on-relink, DFS flush) — faithful but couples the
   oracle to kernel link discipline, or
3. **keep the synthetic machinery** until one of the above is ruled.
