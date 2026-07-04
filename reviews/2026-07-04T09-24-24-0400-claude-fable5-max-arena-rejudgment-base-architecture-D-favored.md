# Re-judgment: which base architecture, given the review findings?

- **Author:** Claude (Fable 5, effort: max), 2026-07-04
- **Question (from the user):** was the original A-wins judgment wrong? Would repairing/upgrading one of the other candidates (B/C/D) be better than piling fixes onto A? And: the fork is no longer a constraint — "we can do whatever we need to in our react fork."
- **Inputs:** first-hand reads of `JUDGING.md` and `cosignal-arena-d-minimal-kernel.md`; mechanical extractions of B and C (divergent-dep trace, notification, equality, abort/commit, fork assumptions, mechanism inventory); my review of the synthesized A (`2026-07-04T08-52-19…-overlay-soundness-and-fork-protocol-gaps.md`); the codex review.

## Verdict in three sentences

The original panel was right about C (fatal, and its divergence hole is architectural — verified first-hand against its own §10.4 text) and right that B-as-written is fatal, but **A's winning correctness score rested on a claim my review disproves** ("immune by construction" to world-divergent dependency tears — JUDGING G7), and the panel's own tiebreaker — "if F1/F3 prove harder than specced, D's quarantined-kernel plan is the fallback base" — **has triggered**: the synthesis's implementations of panel-F1 and panel-F3 are exactly where my review's blockers live. On re-examination, **D-repaired is the favored base** (it solves the entire divergence failure family by construction, where A needs four cooperating compensations), with A-repaired as the fallback if D's measured kernel tax breaks the G-1/G-2 gates — a question D's own M1 plan settles in about a day. I recommend a scoped round-2 judgment between those two repaired designs (plus one fork-liberated wildcard), with the failure schedules as mandatory worked examples and mechanism count as a scored criterion — not a from-scratch redo.

---

## 1. The axis the original judgment never named

Every blocker in my review of the synthesized A, and both wrongness classes that killed C, are projections of one question: **where does per-world dependency knowledge live?** A pending world can read different atoms than the canonical world does — that is what makes it a different world — so anything derived only from canonical topology (invalidation, notification, memo validity) is unsound somewhere.

| candidate | where per-world dep knowledge lives | the T1 divergence case (`c = flag ? a : b`; k sets `flag`, then writes `a`) |
| --- | --- | --- |
| **B** versioned-core | first-class, **in the canonical kernel**: per-link `WORLDS` view bits + per-slot write clocks | **solved by construction** — B §9.3 is literally this scenario; pending-view evaluations record slot-tagged links, propagation follows the union, and `slotWriteSeq[k]` makes cached-entry staleness false-negatives "impossible by construction" |
| **D** minimal-kernel | first-class, **in a second kernel**: head-world evaluations do real dependency tracking in K1, so K1's edges *are* the head topology | **solved by construction** for staleness and invalidation — the k-evaluation of `c` links `a → c` in K1 at the moment it reads it; the later write to `a` propagates through K1's real edges |
| **A** log-overlay (synthesized winner) | **nowhere structural** — compensated post-hoc: read certificates + per-slot registries + drain re-validation + per-write walks (my review's fix set) | fails as written (review F2/F3); repairable, at the cost of four cooperating mechanisms, each with its own completeness obligation |
| **C** forked-worlds | **nowhere, by explicit design** ("No world dep-tracking needed for invalidation", §10.4) | fails, and the extraction confirms the fix contradicts the design's founding premise — repairing it "reintroduces the edge-merge problem that read-only topology eliminates" (C's own §18.2) |

The uncomfortable symmetry: **the panel killed C for this exact tear, then awarded A a 9.0 partly on the belief that A was immune to it.** A is not immune; A just hides the same hole one layer deeper (in the writer's-world memos and the canonical-only notify walk). The two candidates that actually solved the problem — B and D — finished third and second.

## 2. What the re-examination changes, and what it doesn't

**C stays dead.** Its drop-on-abort data loss is a one-branch fix (fold instead of drop — the replay machinery already exists), but its divergence hole is structural: worlds are read-only over topology *as the central bet*, its §10.4 "first divergence" induction covers only mark-then-read-once and silently assumes no further writes into an evaluated world, and its own rejected-alternatives section concedes the repair is per-world dependency tracking — the thing its performance premise requires not having. Salvage: its per-world value storage (speculation plane, shadow chains), fold-as-replay, copy-out, and episode lifecycle are genuinely separable and quarry-grade.

**B stays dead as a base, but its ideas are vindicated.** Its no-log urgent fold provably computes 3 where React computes 4, and the repair (log urgent operations) erases its founding "no side log" identity — "collapses B into A's always-log rule wearing B's versioned caches" (JUDGING). Its 19-mechanism concurrency inventory and hot-walk invasion (per-link AND, view-parameterized checkDirty) remain disqualifying for a project whose crown jewel is the untouched proven kernel. But two B mechanisms are the simplest known sound answers to problems my A-fixes solve elaborately, and belong in the quarry:
- **Per-slot write clocks** (`slotWriteSeq[k]`): a cached per-world value is valid iff its seq ≥ its world's slots' clocks. Coarse (any k-write invalidates all k-view caches) but sound with no per-atom certificates at all. If the winning design keeps any world-value memos (mixed-pass memos), validate them with slot clocks, not read certificates.
- **B §9.3's scenario family** as tests — already grafted (G7), keep.

**A's standing drops from "no wrongness-class flaw" to "same flaw class as C, compensated."** My review's fix set works — I stand by it as *a* repair — but it is compensatory by nature: the design forbids world evaluations from touching topology, then needs full read-certificates (F3), a per-slot node registry (F2), drain-time re-validation with an urgent-write extension (F2), a mark walk on tape creation plus a post-eval stamp re-check (F4), and lane-grouped drains (F6) to recover what first-class world edges give directly. Each compensation carries a completeness obligation ("did every certificate capture every read? did every drain re-validate the right worlds?") that is semantic rather than structural — testable by the oracle, but the kind of obligation that regresses silently under maintenance. The synthesis process itself is evidence: the panel's F1 fix (the 9.8 always-walk) and F3 fix (world memos) each introduced the next, subtler hole. What A keeps unambiguously: the fastest steady-state story (zero kernel additions on hot walks beyond the dormant gates) and the best-proven value semantics (the 10.2 visibility rule and 10.7 rebase math).

**D's standing rises — its dings shrink on inspection, and its strengths are exactly where A bleeds.**
- *Divergence family:* solved by construction (K1 tracks the head world's real topology; my review's F2/F3/F8 and most of F4 have no analogue in D — there are no writer's-world memos to validate and no certificates to get wrong).
- *Equality-drop (F5):* absent — D's cutoff is fold-time/refresh-time, entries always append when the gate is on.
- *Lane attribution (F6):* absent — D notifies synchronously per write in the writer's context, deduped by the ARMED bit instead of a drain.
- *Activation timing (F7):* already correct — D gates on bridge registration (`hasReactBindings`), not watcher count.
- *Held-open-transition hot reads (the G-8 scenario):* served by K1's ordinary kernel caches and staleness — no memo machinery at all. This is A's single most delicate performance mechanism, and D gets it for free.
- *The judges' worst-flaw (shadow-edge sync):* real, but narrower than judged. K1's edges are maintained by head evaluations' own tracking; the sync obligation covers only canonical re-tracks of shadowed-but-not-head-reevaluated computeds. The obligation is *structural and enumerable* (edges exist or don't; D specifies a dev-mode brute-force cross-check validator), unlike A's semantic certificate obligations. Its failure mode — a component missing from one transition render, corrected post-commit — is the same transient-tear class as A's compensation failures, not a worse one.
- *The judges' perf ding ("pre-budgets regressions on won benchmarks"):* D's targets concede ≤5% of margin on recompute-dense shapes (deep 0.90→≤0.95 etc., still beating alien-signals), from the `host.refresh` indirection — and D itself specifies the fallback the judgment didn't credit: codegen-fuse the policy dispatcher into the kernel stamp at a `/*REFRESH*/` splice point, keeping the source separation while flattening the call.

## 3. D's repair list (what "D-repaired" means concretely)

D is not clean as written. Its required repairs, all local:

1. **Always-log graft** (from A §9.1). D's existence-gated log (`forked || anyPassActive || deferred`) provably cannot represent the same-event flushSync/default-batch exclusion — the judges were right. Gate on `hasReactBindings` instead; adopt A's base-record tape shape and the honest ≤2× logged-write gate. D's §7.4 read rule is already clause-identical to A's proven 10.2, so the semantics transfer without invention.
2. **Two-batch notify walk.** D's ARMED dedup gives at-most-one notify per stale period, which loses batch granularity: a second batch's write to an already-stale region produces no setState in the second batch's lane (the same failure A's 9.8 exists to prevent; the risk lens saw it — "missed steady-state notifies on already-subscribed watchers"). Fix: on each deferred write, walk K1 subscribers collecting watchers whose last-bumped token differs, and bump them in the writer's context (or via `unstable_runInBatch`). Crucially this walk is **sound in D** because K1's topology is the real head topology — the exact reason the same walk is *unsound* in A.
3. **Hook re-arm protocol** — specify where watcher ARMED re-arms (post-commit layout effect) and the reconcile check's interaction with it; underspecified today.
4. **Per-pass thenable cache** (judges' ding; D has per-world caches but no pass-eval story) and **per-root committed views** (shared with A — review F9).
5. **Fork yield/resume edges** (review F1) — needed by every candidate; see §5.
6. **Head-read shadowing clarification:** world-1 reads of not-yet-shadowed atoms must `ensureShadow` at read time (one epoch compare when already shadowed) — architecturally implied, one line of spec.

What D-repaired inherits from the synthesis unchanged: the tape/visibility/rebase semantics (shared already), and the entire process apparatus — oracle-first sequencing, frozen-kernel contract suite, bytecode budgets, gate table, milestone discipline, schema/codegen. Those sections survived my review and are architecture-agnostic.

## 4. The decisive trade, and the one-day experiment that prices it

| | A-repaired | D-repaired |
| --- | --- | --- |
| divergence family (T1, memo validity, two-batch notify) | 4 compensating mechanisms, semantic completeness obligations | by construction (K1) + 1 walk, structural obligations |
| steady-state kernel tax | none beyond dormant gates (donor numbers stand) | `host.refresh` indirection: predicted ≤3–5% on recompute-dense shapes; codegen-fusion fallback if worse |
| held-open-transition reads (G-8) | world memos + certificate validation (the cost cliff my review's plane-`W` exists to manage) | K1 kernel caches, native |
| shadow/second-topology cost | n/a | K1 memory (128 KiB default, bulk-reset) + shadow-sync obligation (dev validator specified) |
| concurrency mechanism count (rough) | ~12 (tape core ~5 + 7 compensations) | ~8–9 (tape core ~5 + K1/shadowing + notify walk + re-arm) |
| worst residual failure mode | stale value served / missed notify (torn commit, corrected next frame) | missed K1 edge (torn commit, corrected next frame) |
| what the mission loses | nothing on benchmarks; complexity concentrated in the overlay | ≤5% of already-won benchmark margin on some shapes |

Both residual failure modes are the same severity; the difference is which kind of obligation you would rather live with (semantic certificates vs enumerable edges) and whether ~5% of won margin buys the simpler correctness story. **D's own M1 plan is the cheap decider**: extract the host-protocol kernel from `libs/arena` and measure the `host.refresh` tax on deep/broad/diamond — about a day, before any concurrency code, and it converts this table's one open number into a fact. Run it before or during round-2 judging.

## 5. Fork liberation (the constraint that shaped all four candidates is gone)

All four specs treated the fork as observation-plus-one-override, per the old "minimal additive patch" constraint. With that lifted:

- **Upgrades every candidate needs:** `onRenderPassYield`/`onRenderPassResume` edges (my F1 — as specified, an urgent write during a yielded time-sliced render *throws* in A and mis-resolves in C/D); `unstable_runInBatch` (already in the synthesis fork — D's fixup and two-batch corrections should use it too); a stable render-lineage id per (root, lane-set) for suspense caches (F10).
- **The wildcard nobody was allowed to write: React-owned update queues for atoms.** Every candidate hand-reimplements React's update-queue semantics (A's 10.2 "maps clause-for-clause onto React's hook queues"; D's §7.4 likewise; that duplication is precisely where B's fatal fold bug lived). A fork deep enough to host *fiber-detached update queues* — atoms as first-class reconciler-managed state, processed by React's own lane filtering and rebasing — would delete the library's entire log/visibility/rebase plane, the most invariant-dense code in any candidate. Sober assessment: highest elegance ceiling; the risks are that reconciler surgery of this depth makes fork-rebase the dominant lifetime cost, that hook queues are per-fiber for reasons that may not transfer to many-subscriber atoms (an atom is shaped more like a context than a hook), and that non-React/benchmark paths need a parallel fold anyway. It has never been specced; it deserves one round-2 candidate slot with an explicit maintainability lens, and an explicit license to fail fast.

## 6. Recommendation

1. **Run a scoped round-2 arena, not a from-scratch redo.** Frozen inputs: the kernel + layout, the tape/visibility/rebase semantics, the process sections (17–19-equivalents), both reviews as adversarial material. Candidates: **A-repaired** (the synthesis + my review's fix set), **D-repaired** (§3 above), and optionally the **fork-maximal wildcard** (§5). C contributes storage/lifecycle quarry only; B contributes slot clocks and the scenario family.
2. **Judge against the failure schedules, not against claims**: T1 and its same-batch/urgent variants, the flushSync exclusion, writes-during-yield, two-batch re-notify, batched-drain lane attribution, equal-write drops, cross-era cache reuse, multi-root committed views, mount-mid-transition on a fresh node. Every candidate must *walk* each schedule mechanism-by-mechanism; "immune by construction" claims require the construction (the induction argument written out), because that phrase is where the last judgment went wrong.
3. **Score simplicity with teeth:** count cooperating mechanisms for the concurrent story; require each to be independently checkable against the naive oracle; require new structures to be plain policy objects unless a named gate forces packing.
4. **Run D's M1 host-tax measurement** (one day) before finalizing, so the perf axis is a number, not a prediction.
5. **My prior, stated for the record:** D-repaired wins unless the host-tax measurement or the shadow-sync validator surprises badly; A-repaired is the fallback with known costs. This matches the original panel's own fallback clause — I am recommending we exercise it, not that the panel was incompetent. The panel's error was accepting a by-construction claim without the construction; the round-2 rules above exist so that error class can't recur.

*No repository files other than this document were changed.*
