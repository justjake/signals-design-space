The plan is not implementation-safe as written. Program 1’s promotion idea is salvageable, but its timing placement is wrong. Program 2 has contract-breaking holes in both routing coverage and per-world policy state.

## Ranked findings

1. **BLOCKER — Program 1 moves user effects across a real React bookkeeping boundary.**

   The plan moves per-root revalidation from `onRootCommitted` into `passEnd(commit)` and calls that observably equivalent ([plan §2.4](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:264)). It is not: the adapter currently handles pass end first and revalidates effects only in `handleRootCommitted` ([shim pass end](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:384), [root commit](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:482)); the protocol explicitly orders pass end before the root report ([react-fork.d.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/types/react-fork.d.ts:16)).

   Schedule: a parked action T exposes its `ActionScope`; its commit flips an effect dependency; the promoted effect refires during `onRenderPassEnd`; its body calls `scope.set(b, 1)`, and a watcher on `b` schedules React work back into T. React already captured `rependedLanes` before emitting pass end ([work loop](/Users/jitl/src/alien-signals-opt/vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:4015)). The new T update therefore arrives too late for the registry’s re-pend classification ([batch registry](/Users/jitl/src/alien-signals-opt/vendor/react/packages/react-reconciler/src/ReactFiberBatchRegistry.js:345)): the bridge has locked T into the root while React may omit that lock-in. Current adapter timing runs the effect inside `onRootCommitted`, after that classification. This can break RCC-CR1’s exact committed write set, not merely event ordering.

2. **BLOCKER — RUL-1’s “immediate or next drain” choice has no globally sound answer.**

   Immediate revalidation fails this schedule: T is parked and already committed into root A with `x=1`; A opens and yields a pass pinned at `x=1`; `scopeWrite(T, x=2)` occurs in the gap. The pass and on-screen frame remain at 1, but current membership makes `committedValue(A)` return 2 and `scopeWrite` immediately revalidates the effect ([shim](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:586)). The effect runs with 2 before A can commit it, conflicting with RCC-EF1 and RCC-CR4’s prohibition on same-root committed advance while a frame is open ([contract EF1](/Users/jitl/src/alien-signals-opt/spec/react-compliance-contract.md:436), [CR4](/Users/jitl/src/alien-signals-opt/spec/react-compliance-contract.md:347)).

   Deferral also changes observable behavior: two member writes `1→2→3` before the next drain currently produce cleanup/run at 2 and again at 3; deferred revalidation coalesces to one run at 3—or waits indefinitely if the parked action neither settles nor commits again. Thus merely amending EF2 as proposed ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:271)) does not reconcile production timing, on-screen committed state, and open-pass behavior.

3. **BLOCKER — TAINT cannot replace weak-edge drain coverage.**

   An untracked read always records a weak edge today, while TAINT is set only when a newest-world untracked read encounters pending state ([untracked reader](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:1723), [weak edges](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:1949)). The plan deletes weak edges and scans subscriptions whose nodes carry TAINT ([plan §4.4](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:550)).

   Schedule: mount `W → d → c`, where `c = tracked(b) + untracked(a)`. At mount there is no pending state, so `c` is not tainted. T writes only `a`; correctly, no write-time delivery occurs. T retires, making `a` committed. Today the weak edge expands the retirement drain and corrects W. Under the proposed rule, neither a structural edge nor TAINT reaches W, leaving it stale. This is already the pinned battery member ([logged battery](/Users/jitl/src/alien-signals-opt/packages/cosignal/tests/logged-battery.spec.ts:116)) and violates RCC-SP5. Making TAINT mean “ever used untracked” would require permanent global scans or per-world tracked weak state—the representation supposedly deleted.

4. **BLOCKER — The dead-plane coverage argument loses batch attribution.**

   The “scheduled work will fold it” arm does not establish that work exists in the writing batch’s lane ([plan §4.4](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:519)).

   Schedule:

   1. W’s committed graph is `c = flag ? a : b`, currently `flag=false`.
   2. Parked batch T writes `flag=true`, delivering W into T.
   3. T’s pass evaluates the `a` branch, then is discarded; its plane—and sole `a→c` edge—dies while T remains pending for retry.
   4. Before that retry, independent parked batch U writes `a=1`.
   5. The committed plane still has `flag→b`; the lazy kernel graph is not re-evaluated; no live graph contains `a→c`. U receives no delivery.
   6. T retries without U and commits. When U later settles, only an urgent drain correction repairs W.

   HEAD’s episode-union K1 retains the dead pass’s `a→c` edge and schedules W in U’s lane. NF2 degrades that to an urgent correction, violating RCC-SP4 and exactly failing the plan’s proposed “delivery precedes correction” invariant. The discriminant write scheduled T, not U; that distinction defeats the argument.

5. **BLOCKER — “Pass planes receive no fanout, ever” omits resource settlement.**

   The pin proof is sound for receipt writes, but not for L4 resource state. The spike explicitly did not implement suspense boxes or `ctx.use` ([spike](/Users/jitl/src/alien-signals-opt/research/experiments/world-tagged-links-spike.md:51)). In production, settlement invalidates the computed that cached the pending thenable ([index.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:1783)). The plan says planes change nothing here and provides no equivalent per-plane invalidation ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:585)).

   Schedule: a living pass plane evaluates C, caches a `SuspendedRead`, and yields; the promise settles; only the kernel record is invalidated; C’s clean shadow remains cached. A retry reads the same pending sentinel indefinitely. Supporting this requires per-plane outcome bits, stale guards, and settlement invalidation/fanout; attaching one listener per plane also introduces unpriced allocation and retention. As specified, this violates RCC-SU5.

6. **MAJOR — Per-world computed equality cannot reuse the current kernel wrapper.**

   A custom-equality `Computed` wraps its function around the kernel value slot and returns the kernel’s old reference on equality ([index.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:2038)). The spike calls that same wrapped function from a world shadow and then compares only shadow identities ([spike code](/Users/jitl/src/alien-signals-opt/research/experiments/world-tagged-links-spike-code/cosignal/src/index.ts:2597)).

   Counterexample: newest caches `[0]`; root A’s plane caches `[1]`; a committed-world recomputation produces another `[1]`. The comparator should preserve A’s plane-local old `[1]`, but the kernel wrapper compares against newest’s `[0]`, returns the new array, and the plane reports a false change. This breaks reference preservation and causes extra downstream work. The plan’s one sentence that `wUpdate` performs a per-plane cutoff ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:581)) requires separating raw getter, comparator, plane-local previous value, and exceptional outcome bits—substantially more policy machinery than budgeted.

7. **MAJOR — P2.S-A is not an executable green stage, and dual bookkeeping masks the exact routing failures.**

   Current `ComputedNode` has no kernel handle ([logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:348)); its newest value depends on `newestMemos` ([logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:1416)). Yet S-A deletes the memo ladder while S-C does not eliminate `ComputedNode` until later ([S-A](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:668), [S-C](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:684)). S-A/B therefore cannot serve newest reads, bridge core effects, or observation discovery without retaining a temporary newest memo/plane that the plan says is gone.

   Moreover, while K1 owns routing in S-A, it masks dead-plane and weak-edge failures. S-B simultaneously activates plane routing and deletes the only mechanism covering those cases. “Dual bookkeeping” therefore provides value-store comparison, not migration atomicity for the load-bearing routing change.

8. **MAJOR — Program 1’s oracle co-evolution does not model the production mechanism it claims to referee.**

   A synthetic `nodes[]` plus `reactEffectSwap` cannot model an actual body such as `flag.state ? a.state : b.state`, where the same refire causally chooses and captures its next dependency set. An external swap op—and especially “re-registering” the body—changes lifecycle rather than reproducing same-subscription recapture ([plan §2.5](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:311)).

   The schedule vocabulary also has no effect removal, cleanup, StrictMode replay, queued-refire-after-disposal, or callback-issued write ([schedule.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/schedule.ts:39)). Those are precisely the adapter-owned shells in the real hook ([hooks.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/hooks.ts:306)). One pass locking in two tokens also exposes an undefined queue rule: both per-token drains can enqueue the same effect before the operation boundary. No dedup gives two cleanup/runs at the final value; dedup gives one. Current adapter performs one recheck for the one root report. `lastGen` is listed but never given semantics.

   The simplification claim is also internally inconsistent: a multi-dependency committed subscription has no single index key and is explicitly full-scanned, so it cannot live solely in the claimed “one per-node subscription index” ([record](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:163), [full scan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:220)).

9. **MAJOR — P1→P2 has two unpriced ordering couplings.**

   First, committed-plane fanout must happen before P1’s member-write effect scan. Otherwise an effect rechecks a clean cached plane, sees the old fold, and misses the immediate refire; the later fanout mark has no trigger. Calling both operations a “deliberate joint” does not define their atomic order.

   Second, commit `7456c7b` captures observation deps before K1’s edge dedup ([logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:1754)). The spike’s `wLink` returns early for an in-place reused dependency ([spike code](/Users/jitl/src/alien-signals-opt/research/experiments/world-tagged-links-spike-code/cosignal/src/index.ts:2332)). If P2 feeds `obsCapture` from link insertion rather than every dependency read before reuse checks, a second evaluation with unchanged deps captures an empty set and releases the atom while its watcher remains live. That violates RCC-OL1 and the zero-flap semantics of `7456c7b`. The plan’s “feed from plane/kernel link recording” is not precise enough to preserve this load-bearing placement.

10. **MAJOR / NOTE — Contract accounting is incomplete and partly inverted.**

   - **Undershoot:** RUL-2 treats effect participation in observation liveness as optional, but RCC-OL1 already says “ALL consumer kinds,” explicitly including effects ([contract](/Users/jitl/src/alien-signals-opt/spec/react-compliance-contract.md:510)). Choosing “no” is non-compliant, not an equally valid implementation ruling.
   - **Undershoot:** P2 never classifies planes, marks, pooled buffers, boxes, or committed-plane state into L1–L4. P1 calls its record “consumer-scoped” while explicitly excluding L1–L4 ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:241)). The contract says resistance to exactly-one classification is a stop-and-rule condition ([contract](/Users/jitl/src/alien-signals-opt/spec/react-compliance-contract.md:648)).
   - **Gold-plating:** one module-scope computed API is not required by Section 3. NF2 is explicitly future, non-contract work, recommended only when profiles justify it ([contract NF2](/Users/jitl/src/alien-signals-opt/spec/react-compliance-contract.md:589)). RUL-3/RUL-4 contemplate landing for API aesthetics without that evidence ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:915)); that exceeds documented requirements.

## Per-program verdicts

| Program | Verdict | Reason |
|---|---|---|
| Program 1 | **Sound-with-amendments** | Promoting dep-snapshot mechanics is viable, but React phase ownership, member-write semantics, refire dedup/order, OL1 handling, and oracle lifecycle coverage must be resolved first. |
| Program 2 | **Unsound** | Weak/untracked drains, cross-batch gap delivery, settlement invalidation, equality policy, and the staged migration all fail as specified. |
| P1 → P2 sequencing | **Unsound as written** | The advertised stable boundary omits fanout-before-recheck ordering, pre-dedup observation capture, and the temporary newest representation required before S-C. |

Overall, Program 1 has a credible convergence target but currently moves observable timing into the wrong layer. Program 2 productionizes only the spike’s structural success while treating the unbuilt policy and routing halves as implementation details; those halves contain direct RCC-SP4/SP5/SU5 failures and make the proposed green staging impossible. Verification gates would catch several failures, but a gate that predictably stops is not a sound implementation plan. Review was read-only; no files were changed or tests run.

