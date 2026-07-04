# Adversarial correctness review — Round 4 exact-world consolidation

## Findings

### 1. BLOCKER · architectural — Functional receipts do not produce a stable atom value within one world

The replay invariant proves arithmetic order for one fold, but atoms “fold directly” on every read and no per-world atom-result cache is defined.

**Failing schedule**

1. Setup: `a={n:0}` with default reference equality. Park transition T and call `a.update(x => ({n: x.n + 1}))`.
2. The write stores the updater as the receipt op and invokes it once for K0, producing object `o1`.
3. Pass P includes T. Its first `a.state` folds from the base and invokes the updater, producing `o2`.
4. A second `a.state` in the same evaluation and exact same world folds again, producing `o3`.
5. Although both invocations are pure, `o2 !== o3`. A component can therefore render `a.state === a.state` as false.
6. Reconcile or mount fixup can fold again to `o4`, compare it with rendered `o2`, and repeatedly schedule corrections despite no intervening write.

**Wrong outcome:** one world does not define one stable value reference, unlike `useState`/`useReducer`. Reducers returning fresh objects fail identically.

The §4.3 induction assumes applying the same op to the same accumulator preserves the same representative; that is false across separate callback invocations. Repair requires a canonical per-atom/per-world fold result or an equivalent receipt-result cache, including complete invalidation and reclamation rules.

### 2. BLOCKER · local fix — Delivery dedup can consume the only notification for a post-pin write

The claim that one queued update covers later same-token writes fails once a pass has captured its immutable pin but has not yet rendered the watcher.

**Failing schedule**

1. Setup: mounted W reads `a=0`; async transition T remains parked.
2. T writes `a=1` at `s1`. The walk queues W in T and sets W’s T delivery bit.
3. React starts pass P, capturing `pin=s1`, then yields before W renders. W’s bit remains set because re-arming occurs only when W renders.
4. T’s continuation writes `a=2` at `s2`. The walk reaches W but suppresses `setState` because the same T bit is still set.
5. P resumes. Its immutable pin excludes `s2`, so W renders `a=1` and only then clears the bit.
6. P commits and locks T only through `s1`. No React update exists for `s2`; keep T parked indefinitely so retirement cannot provide a later backstop.

**Wrong outcome:** `a=2` has a live receipt but W is never scheduled to render it. The pre-mutation reconcile sees the pass’s claimed `s1` world and therefore accepts the stale candidate.

The smallest sound repair is to remove this dedup. Preserving it requires making coverage sequence-aware so an update queued before a pass pin cannot suppress a later write outside that pin.

### 3. BLOCKER · architectural — Immediate slot release loses dependencies discovered after retirement

Pin retention preserves old values, but it does not preserve the retired token’s reach information long enough to notify a dependency discovered by that old pass.

**Failing schedule**

1. Setup a fresh episode with `flag=false, a=0, b=0`, `c=flag?a:b`, and mounted W on `c`. K0 has `flag→c` and `b→c`; K1 has no `a→c`.
2. Parked transition K writes `flag=true`. The existing `flag→c` edge schedules W. Pass P starts after that write, captures its pin, and yields before evaluating W.
3. In the yield gap, store-only default token D writes `a=1`. Neither K0 nor K1 contains `a→c`, so D does not reach W.
4. D has no React work and retires. Its receipt remains because P’s pin predates retirement, but retirement clears D’s reach bits and releases its slot.
5. P resumes. Its exact world includes K but excludes D, so it evaluates `c=0` through `a=0` and adds `a→c` to K1.
6. Edge-add carry handles only still-live tokens. D is retired and its reach bit was cleared, so this newly discovered edge schedules nothing.
7. P’s pre-mutation reconcile compares W with P’s claimed world and accepts `c=0`. Once K’s prefix is locked, committed-for-root state contains `flag=true` plus globally retired `a=1`, whose correct `c` is 1.

**Wrong outcome:** the root can commit `flag=true, c=0` while its committed signal world evaluates `c=1`. W was already mounted, so mount-only fixup cannot supply the missing pre-commit notification.

This refutes the construction that receipt retention alone permits immediate slot release. A repair needs retained retired reach state, a late-edge committed correction, or commit validation against the actual post-lock committed world.

### 4. BLOCKER · architectural — Evaluator publication is too late to notify consumers and too early to survive a restart

`passStages` protects only reads after a stage is selected. A React-state-only evaluator change can leave already-finished or bailed-out consumers on the old evaluator, making F9 publication their first notification.

**Failing schedule**

1. Hook-owned signal H has committed evaluator A. Same-root sibling W legally subscribes to H and displays A.
2. A transition changes the owner hook’s React deps to B without any signal receipt.
3. W bails out or finishes before the owner renders, so it remains on A while `passStages` is still empty.
4. The owner creates stage B and renders B. The prospective stage gate cannot revisit W.
5. At commit, §8.2 first publishes B as committed and then walks H, finally queuing W.
6. If the candidate commits normally, W’s update is too late and the frame contains owner B beside W A.
7. If the fork honors §7.3 by restarting finished work before mutation, B has already been published even though its hook never became current. An urgent interruption or abandonment can then leave K0/core reads using B while React remains on A; no tentative-publication rollback exists.

**Wrong outcome:** either a torn commit occurs or an evaluator from an uncommitted hook escapes into committed/core state.

The world-isolation stage induction only proves that the stage table is populated before the staged node’s later read; it does not cover earlier consumers. Repair requires a render-order-independent staging/publication protocol, not merely a later delivery walk.

### 5. BLOCKER · architectural — Live `globalSeq` renumber cannot rewrite F9 identities held by React

The lifecycle section promises a full rewrite with live passes and tokens, but `stageId` is both an immutable library identity and an opaque integer copied into React’s WIP hook.

**Failing schedule**

1. Under a forced-small `globalSeq` horizon, pass P creates evaluator stage B with `stageId=7`, attaches 7 to its WIP hook through F9, and yields.
2. Other writes or lock-view mints reach the horizon while P remains live.
3. The prescribed live full rewrite renumbers retained stage records and bumps the episode.
4. None of the 16 protocol touch points rewrites the integer already stored in React’s WIP hook.
5. P resumes and commits; React emits the old 7. The generation CAS either rejects B, leaving evaluator A behind a DOM rendered with B, or 7 collides with a newly minted stage and publishes the wrong record.

**Wrong outcome:** React’s committed tree and the library’s committed evaluator diverge.

Keeping 7 unchanged merely moves the collision to post-reset reuse because F9 carries no episode. The design must discard all affected WIP passes before renumbering, add an epoch-bearing F9 identity, or separate externally held stage IDs from the rewritten sequence line.

### 6. BLOCKER · local fix — Capsule generations can wrap while stale thenables remain live

`capsuleGen` is only incremented before reuse; no epoch or non-colliding identity protects callbacks within one long-lived lineage.

**Failing schedule**

1. Force a two-bit capsule generation. Lineage L creates pending thenable `q0` at position P with generation 0.
2. Inputs change repeatedly while `q0` remains pending. Each change generation-drops P and installs `q1`, `q2`, `q3`, then `q4`.
3. P’s reused capsule generation wraps to 0 for `q4`. L and the episode are still live, so neither lineage nor episode identity changed.
4. `q0` settles. Its stale callback sees the same capsule id and generation 0 and passes the documented stale-settlement check.
5. The callback mutates or invalidates `q4`’s capsule as though `q0` were its current thenable.

**Wrong outcome:** a retry can consume the wrong resource result or stop suspending before `q4` settles.

The callback must additionally validate a non-wrapping settlement identity or the exact thenable reference, or the slot cannot be reused while any prior callback remains possible.

## Verified held

- The standard live-token C1 schedule works: an exact-world evaluation records the divergent K1 edge, and a later write carries the live token through it.
- C2 and C8 hold: receipt append precedes K0 mutation, and an equal write cannot disappear once that atom has history.
- C3’s numeric, pure-updater queue order matches React’s 4-not-3 arithmetic; the blocker above concerns stable representatives across repeated folds.
- C4 holds for distinct live tokens because walks ignore stale marks and watcher dedup is generation/token-specific.
- C6 and C7 hold: watcher delivery occurs synchronously in each writer’s context, and yield removes the pass frame before handlers run.
- C9’s existing and fresh nodes route through exact-world evaluation whenever receipt history or a stage already exists.
- C10’s stated mount race is covered by `runInBatch` plus the retired-token urgent fallback.
- Per-root immutable lock views correctly prevent a post-await write from leaking past a root’s committed watermark in the ordinary C11 schedule.
- The single-`lastWalk` termination proof holds under the stated no-user-code and deferred edge-drain rules, including K0∪K1 cycles.
- Common-basis value revalidation avoids refetching solely because a relevant stamp moved, before generation wrap.
- The enumerated async registrar wrappers preserve live-token attribution across nested callbacks and degrade explicitly after retirement.
- C17 holds because no truncation surface exists.

## Verdict

This design is architecturally unsound as written. The coarse exact-world gate does repair several cache leaks, but the constructions still fail stable per-world value identity, post-pin delivery, retired late-edge delivery, and render-order-independent evaluator publication. Do not implement it until those mechanisms and the live-id lifecycle are specified and the schedules above pass forced tests.

