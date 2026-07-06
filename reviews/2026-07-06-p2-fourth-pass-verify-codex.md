HEAD reviewed: `7e4c246`. No files changed.

1. **Settlement drain fixed point — PARTIALLY.**

   - The simple at-rest schedule closes: settlement scans the suspended list, drains the cone, revalidates the background-only effect, then delivers ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1251)).
   - Settlement during a watcher drain or `revalidateCommittedSubs` inside a public operation also gets another queue iteration.
   - It is not a complete fixed point: the loop ends before `flushNotify`, but HEAD invokes refire callbacks synchronously during `flushNotify` ([logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:886)). Such a callback can synchronously settle another custom thenable after the loop; its sentinel is queued and the operation returns without another iteration.
   - The immediate at-rest settlement drain is described as one scan/drain/revalidate/flush sequence, not as an owner of the queue-to-empty loop. Reentrant settlement during that drain has the same gap.
   - Termination is not proved. A queued bit bounds one sentinel, not the number of distinct thenables that evaluations/refires can synchronously create or settle. A settlement chain can extend the loop without a system-level bound; this needs the same explicit user-feedback/nontermination qualification as existing reactive flushes.

2. **List invariant, sentinel minting, retention — PARTIALLY.**

   - Sentinel minting is closed: HEAD calls `t.then(...)` before minting `t.sr` ([index.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:1641)); mint-on-tap gives the callback and later throw one identity.
   - List uniqueness is still not executable. Gating append on the bit’s 0→1 transition prevents duplicates only while the bit remains set. The plan says the array entry “drops” when the bit clears but supplies no removal/index/compaction mechanism, so clear→re-suspend can leave two physical entries and the claimed O(current suspensions) scan does not follow ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1155)).
   - The corrected strong-retention fact is accurate—`SuspendedRead` holds its thenable ([index.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:187))—but the bounded-retention claim is not. A synchronous custom thenable during standalone `committedValue`/`passValue` queues its minted sentinel while evaluation is open; the read-site probe can heal the value, but those HEAD read surfaces have no epilogue ([logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:3706)). Nothing written removes that queued entry.

3. **FP ledger and gates — PARTIALLY.**

   - The main ledger correction matches HEAD: `foldAtom` still computes and stores `lastFoldFp` ([logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:1404)).
   - Its staging rationale does not: the newest arm computes `fpOf` directly from the tape tail and never reads `lastFoldFp` ([logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:1604)). Once S-A deletes pass/committed memo paths and arena code declines to read fingerprints, the store is dead weight already—not load-bearing until S-C. The schedule also still says “none stored” ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:698)).
   - The wide-mask gate now has a number and STOP disposition, and §8 now acknowledges staged gates.
   - The resulting summary overclaims consistency: it says every staged gate has a threshold and STOP disposition, while the S-B untracked-fan gate still has neither a numeric acceptance threshold nor an explicit STOP rule ([gate](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1725), [§8](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1961)).

4. **Lifetime relabels under RUL-5 — PARTIALLY.**

   The foot-block infrastructure rows fit the recorded exemption. The arena/outcome relabels do not follow from §2 as written: the contract says anything whose content a consumer can observe remains governed, while the plan silently adds a “not rebuildable from classified state” exception absent from the ruling ([contract](/Users/jitl/src/alien-signals-opt/spec/react-compliance-contract.md:101), [plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1459)). Cached values, errors, sentinels, and `ctx.previous` are consumer-observable outcomes. The table also classifies pass-arena value columns and marks as L3 in the pass-arena row, then classifies the same state as exempt mechanism in the next two rows ([table](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1475)).

**New fourth-pass defects:** the fixed point excludes reentrancy during its final notification flush; synchronous standalone reads can strand a strongly retaining queue entry; distinct thenables invalidate the unconditional termination argument; and the plan applies a broader RUL-5 exemption than the contract records.

**Disposition: another item — P2.S-A is not ready; the settlement boundary is still not outermost, and the lifetime relabels remain outside §2’s recorded exemption.**

