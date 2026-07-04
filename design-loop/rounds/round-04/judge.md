# Round 4 — judgment

Judge of record for `rounds/round-04/synthesis.md`. The synthesis declares
`design-consolidate-a.md` its normative base and amends it (R1–R14, T1–T4,
deletions); I therefore judged the composite (base + amendments) as one
design. I read the seeds, INVARIANTS.md, SCARS.md, the synthesis, and its
incorporated base only — no reviews, no prior rounds, no consolidate-b. All
walks below are my own re-derivations; the synthesis's refutations and
repairs were treated as claims before the court.

Verdict up front: the consolidation is real and most of the battery
genuinely holds under attack, but **two of this round's own repairs each
mint a new confirmed blocker** — R12's commit-baseline fast-out deletes the
I18 mount fallback in exactly its mandated window, and R1's pin-gated
evaluator versions were never wired into the §6.2 fast path, re-opening
S23 through the routing surface. Both have concrete killing schedules and
both contradict rows the synthesis's own disposition table marks
"carry / re-verified."

---

## 1. Battery re-walk

### Full-depth traces (executed by me, step by step)

**C1 core** — k: `flag.set(true)` → receipt {T@s1,k}, wc[k]++, K0 apply,
touched(flag)|=k, mark walk flag→c (K0 edge) sets touched(c)|=k and
appends c to touchedList[k]; delivery walk sets (W,k) bit, setState in k's
lane. k-world read (pass pin p): touched(c)≠0 → world path → fold flag=true,
a in-world = 0 → c=0; **K1 records the real deps flag→c, a→c**. k:
`a.set(1)`@s2 → walk from a follows the K1 edge (no canonical edge needed —
the trap is dead structurally); delivery hits W with bit set → R2 check:
started-and-uncommitted pass on root(W) including k with pin < s2 →
DELIVER → interleaved k-lane update → pre-commit restart (fork test 32);
otherwise suppress soundly (future passStart pin ≥ s2). k render at pin ≥
s2: worldKey changed + wc[k] moved → ladder refuses old memo → re-eval →
c=1 in k's lane before commit. Committed world folds to 0 via b.
No-early-read variant: no K1 edge but also no k-cache; fresh eval post-s2 →
1. **PASS.** V2/V4/V5/V6/V7 verified against the design's walks — V5's
pinned-pass exclusion (retiredSeq > p1) and V6's pin-term/epoch
disambiguation hold; V7's lineage-keyed capsules hold.

**C2** — `a.set(1)` in default D: always-log receipt (I1), K0 applied,
cone marked, watcher setStates in D's context. `flushSync` pass (mask ∅,
pin p): reads route world-path (touched≠0): D not retired/mask/locked →
a=0, c=10 — both old, no tear. D's later commit folds and drains
touchedList[D]. **PASS.**

**C4** — T1 write: (W, slot(T1)) set, setState in T1's lane. T2 write
before any re-render: fresh delivery walk, (W, slot(T2)) clear → setState
in T2's lane. Dedup is per-(watcher, slot) (I5), so the second batch has
its own bit; R2 is not even consulted across slots. **PASS.**

**C5** (R2's own case) — first write value-blind delivered (bit set);
second same-slot write: bit set → R2 split: no started pass → suppress
(scheduled render's future pin folds it); started-uncommitted pass with
pin < s2 → deliver → test-32 restart. wc[k] refuses the first
evaluation's memo either way. **PASS** — the repair's construction (case
split over unstarted/started/discarded) is exhaustive; I could not
construct an under-delivery.

**C6** — resolution "handled, no implicit grouping" (D10): engine
`batch()` defers only core-effect flush; `a.set(1)` delivers NOW in the
urgent context; `b.set(2)` inside the transition scope delivers NOW under
F1's transition token → per-write context preserved by per-write
synchronous delivery; nothing user-visible was forbidden. **PASS.**

**C7** — passYield → callstack truth: handler read is NEWEST (K0
newest-applied), write classifies into the click batch U (no throw),
resumed pass folds at (mask{T}, pin p): U's seq > p excluded, and if U
retires mid-yield retiredSeq > p still excludes; retention (pin-gated
compaction + unswept slots, C1-X4) keeps the fold reconstructible.
**PASS.** C7-D demotion-before-append, and R1's promotion demotion, are
consistent.

**C13** — walked the §15 master table plus R11 addenda row by row: every
counter names its guard; R8's live renumber discards WIP passes first (so
no live pin can straddle the rewrite — a-codex 5's inversion is
structurally impossible), rewrites the full duty list (now including
promotedAtSeq and watcher snapshot pins/cas), epoch-bumps worldKeys;
b-codex 5's externally-held stage ids die with the discarded passes;
walkGen wrap has its sweep row; capsule settlement is identity-checked
(R10) so gen wrap is immaterial; lastRenderPassId is generation-checked;
version chains reclaim pin-gated and sweep at quiescence. Forced-wrap
tests named per row. **PASS.**

### Verified-by-audit (design's walks checked for hand-waves)

- **C3/C3-E/C3-R/C3-M**: replay-in-write-order arithmetic exact (2 → 4);
  prefix-clause compaction blocks the ×2 from folding under a pending +1;
  R9's committed-reference installation is justified by I25 (watermark =
  committing pin ⇒ prefix equality). F9-before-folds ordering pinned by
  fork test 23. Holds.
- **C8**: empty-tape drop restricted to world-invariant ops; stageable
  ReducerAtoms always append (I38a). Holds.
- **C1-X2/X3/X4/X5**: walkGen termination; TAINT including the cutoff
  horn and the pin-gated-compaction clear race (row 6 is the load-bearing
  step and it is written, not waved); retention; saturation + R5's
  fastPathDisabled conjunct in the fixup fast-out. Hold.
- **C11/C11-W/C11-A** under T2: per-root immutable lock views; effect
  snapshot headers carry lockViewId and R4's forced drain enumerates
  touchedList, so the deleted lockTerm's I21/I34 load is genuinely carried
  by id re-mint + value revalidation. I attacked each enumerated consumer
  (committed-for-root memo keys, snapshot headers, suspense prefix
  headers, fixup baseline) and found no orphan. Holds.
- **C12 family**: parking + measured carrier (I30) + registration-time
  shims (I36) + retired-token ambient fallback (I37); runSync deletion
  breaks no walk. Holds; residual class documented and dev-warned (D17).
- **C14**: seeding makes replays idempotent; L4 committed-first kills the
  oscillation mint; R7 gives S15's soak a named reclamation protocol.
  Holds.
- **C15**: lineage identity + receipt-line content validity; reducer
  stamps ride the prefix (5‴); R10 identity-checked settlement (5⁗);
  I40 + install-unchanged keeps retries stable across promotion. Holds.
- **C16/C16-D/B1**: two effect contracts stated and mechanically
  distinct; R4 strengthens B1. Holds.
- **C17**: discharged by deletion + API snapshot test. Legitimate.
- **T8-N**: full-cone carry (I42) with the two-strike termination rank.
  Holds.
- **C9/C10/C1-X1**: **FAIL in specific rows** — see blockers below. The
  disposition table's "C9 rows 6–7 carry," "C10 races (i)/(ii)
  re-verified," and "C1-X1 new row 8" claims do not survive re-walking.

---

## 2. Construction audit

| construction | verdict after attack |
|---|---|
| TAINT-COMPLETE (§6.3) | **Holds.** Base case + every event class enumerated; the cutoff horn and the compaction-gated clear are both written out. My attacks (downstream clear ordering, fresh-node untracked read, DIRECT→LOGGED base case) all bounced. |
| Invariant R (§6.4), source 3 as amended by R1 | **FAILS.** "Promotion dirties the K0 node, so CT is false until NEWEST recomputes" refuses staleness for exactly one recompute; after that recompute the cache embeds the NEW version while open passes pinned before `promotedAtSeq` must fold the OLD one, and no fast-path conjunct compares cache-stamp against the pin-resolved effStamp. Blocker B. |
| R2 suppression rule ("exactly sufficient") | **Holds.** The unstarted/started/discarded case split is exhaustive; "a fiber with pending lanes never bails" + fork test 32 close the started branch; over-delivery is safe by D13. |
| R3 coverage (both link orders) + termination | **Holds.** Edge n→m exists in K0 or K1 by evaluation time; walk runs at stage time; pass-filter delivers only P-rendered watchers; oscillation bottoms out in React's update-depth limits. Fresh mints deliver to nobody (nothing rendered them) — correct. |
| R4 drain coverage (closed enumeration of flips) | **Holds for subscribed watchers.** Every flip is a drain of the flipping token; retention guarantees the bits; fully-retired-swept slots have no future flips; saturation only clears fully-retired victims. The gap it cannot cover — a watcher that subscribes at layout, after the drain — is exactly what the fixup exists for, which is why Blocker A is a blocker. |
| Walk atomicity (§10.2) | **Holds**, conditional on the stated fork guarantee (no synchronous render inside setState); dev assert converts violations to loud failures. |
| Fixup w_fx / I43 reconciliation (§11.2) | **Holds as base-written** (fold-in of included tokens; joint fast-forwarded world defeats S10's subset trap) — but R12 guts its trigger; see Blocker A. |
| R12 "the fast-out only skips an evaluation whose compare provably matches" | **FAILS** its counter-attack. The base's held construction covered own-token lock-in only ("same values through a different clause"); foreign retirements/advances/promotions in (render pin, this commit's lock-in] are inside the baseline yet outside v_r. The claim is over-generalized; base C9 row 7 is its own counterexample. |
| R8 "no seq-bearing identity exists outside the library after discard" | **Holds.** F9 attachments die with passes; capsule identity is the thenable reference (R10), not a seq. |
| R9 committed-reference installation | **Holds** via I25 prefix equality; `a.state === a.state` within a render follows. |
| T2 lockViewId-only lock versioning | **Holds.** All five consumers audited and each carries the id or is drain-enumerated; I34 root-scoping preserved by per-root ids; I35 value revalidation keeps over-invalidation content-guarded. |
| Carrier induction (§12.1) | **Holds**; measured (I30); boundaries enumerated and rung-uniform (L5). |

---

## 3. New confirmed blockers (2)

### Blocker A — R12's baseline fast-out deletes the I18 mount fallback

**Defect.** §11.2's committed-side fast-out becomes
`cas == baseline.cas ∧ root.lockViewId == baseline.lockViewId → return`,
with the baseline captured at the committing pass's **own F3 lock-in**
(after that commit's folds). Commits are single-threaded: nothing can bump
cas or re-mint the lock view between lock-in and layout (the cited
exception, "cross-root traffic in the window," requires a layout effect
flushSync-committing another root). So the fast-out returns for
essentially **every** mount, and the w_fx value compare — the I18-mandated
"value/version compare against the current committed-for-root world" —
never executes. Foreign committed-side motion in (render pin, lock-in] is
absorbed into the baseline and becomes invisible.

**Killing schedule 1 (C10 race (i), verbatim from the seed).** Transition
k writes `a`; a default/transition pass P on the same root starts (pin p
excluding k) and yields; k commits and **retires during the yield** —
R4's retirement drain runs *now*, enumerating touchedList[k], but the
new component W has not subscribed yet. P resumes and renders W reading
c-over-a: world path at pin p → committed-minus-k value. P commits;
fixup: per-token loop iterates **live** tokens — k is retired, skip;
committed fast-out: baseline (captured at this commit's lock-in, which
postdates k's cas bump) equals current → **return**. No w_fx compare, no
urgent pre-paint correction. Siblings subscribed before k show k's value
(corrected at k's retirement drain); W shows the pre-k value. **Torn
committed DOM, persisting until unrelated traffic to `a` re-delivers** —
k is fully retired, so no future flip re-enumerates W (R4's own
construction: fully-retired-and-swept tokens have no future flips).
The seed sanctions an urgent pre-paint correction here; the design fires
nothing at all.

**Killing schedule 2 (base C9 row 7).** Unrelated default D commits and
retires during the mounting pass's yield; identical mechanics; the base
walked this row as FIRE ("fast-out fails (cas moved) ⇒ v_fx ≠ v_r ⇒
FIRE"), and the synthesis's disposition says "rows 6–7 carry" — under
R12, row 7 **cannot** fire. The synthesis contradicts itself.

**Killing schedule 3 (promotion variant).** Cross-root F9 promotion of
r0→r1 lands during root B's yielded pass (pin q < promotedAtSeq); a
component mounts in the resumed pass rendering the pin-resolved r0 fold;
P3′'s walk predates its subscription; the R4 drain at B's commit runs in
the reconcile phase, before layout subscription; the fixup's per-token
loop skips the included token (correct) and the baseline fast-out returns
(cas absorbed the promotion). W paints r0's value beside siblings
corrected to r1. Same class.

**Why not local-as-written.** Restoring correctness means the fast-out
must also prove nothing moved since the **render pin** (the base's
comparator) — which re-opens exactly the cost defect (row 16) R12 was
built to fix: any commit whose folds bumped cas forces a w_fx eval per
in-window mount. The repair and the cost claim are in direct tension;
one of them must give. (An in-architecture repair exists — e.g., skip
only when `baseline == w_r's pin-time capture` too, or have the R4 drain
re-run over subscriptions registered during layout — but it must be
designed and priced, not assumed.)

### Blocker B — R1's evaluator versions never reached the routing surface

**Defect.** R1 makes committed evaluators a pin-gated version chain and
amends the **fold rule** and the **memo ladder** (step 2 compares against
pin-resolved effStamp) — but §6.2's fast path
(`touched==0 ∧ CT ∧ ¬stagedFor ∧ ¬fastPathDisabled`) gains no conjunct.
Evaluator divergence is receipt-free (I31: no receipt, no touched bit; a
promotion has no slot, and P3′ runs the *delivery* walk, which per R14
never marks). After promotion dirties K0 and any single NEWEST read
recomputes (core effect flush, untracked handler read, RENDER_NEWEST pass
on a third root — all ordinary), the node is CT with touched==0 and its
cache embeds the **new** version. A pass pinned before `promotedAtSeq`
then serves that cache through the fast path, violating R1's own pin
rule.

**Killing schedule.** `useComputed` node n, committed f_A, no receipts
anywhere near n. Root B pass P_B (pin q) renders sibling B1 → fast path →
v_A (correct). P_B yields. Root A commits, staging and promoting f_B:
P1′ appends {f_B, promotedAtSeq = sA > q}; P2′ dirties n and demotes
RENDER_NEWEST passes (demotion does not disable the fast path); P3′
delivers setStates to n's watchers (B1 gets a follow-up in the committing
context's lanes — **not** P_B's lanes, so no test-32 restart of P_B).
Core effects flush at A's commit → NEWEST pull of n → K0 cache := v_B,
CT true, touched still 0. P_B resumes; sibling B2 reads n: touched==0 ∧
CT ∧ no stage in P_B (its seed is its own lineage's — empty) ∧ not
disabled → **fast path serves v_B**. P_B commits **B1 = v_A beside
B2 = v_B**: one pass, two evaluator worlds, torn committed frame — S23's
exact crime, re-entered through the one surface the repair didn't touch
(I31's warning is verbatim: "every routing/validity surface needs an
evaluator conjunct... one omission re-opens it"). The synthesis's C1-X1
"new row 8: cross-root promotion during this pass's yield → pin rule
serves the old version" asserts the outcome without walking the routing
step — the pin rule lives in the fold/ladder, which the fast path
bypasses. (The R1 re-walk itself is not a counterexample: its ReducerAtom
carries receipts, so touched bits force the world path there.)

**Repair shape (exists in-architecture, must be specified):** a fifth
fast-path conjunct comparing the cache's recorded evaluator stamp against
`effStamp(n, world)` (pin-resolved), or refusing fast-path serves of any
node whose version-chain head postdates the world's pin. O(1); G-Q row
required.

Both blockers are repair-minted (R12, R1) — the same failure mode this
round's Part I diagnosed in round 3's own repairs. Both contradict rows
the synthesis marks as verified, which is itself a process finding: the
amendment-onto-base document structure (repairs asserting "rows carry"
without re-walking them) is where both slipped through.

---

## 4. Scores

**correctness = 5.** I executed C1, C2, C4, C5, C6, C7, C13 at full
depth and audited every other walk; the historically lethal territory
(C1 family including taint/cutoff/saturation, C2 always-log, C3
arithmetic, C7 yield gaps, C12 persistence, C13 lifecycle, C15 suspense)
genuinely holds under attack, with real constructions rather than
assurances. But two new confirmed blockers stand — both torn-committed-
frame class, one indefinitely persistent — in C9/C10/C1-X1 rows the
disposition table wrongly marks "carry / re-verified," and one of them
(R12) rests on a by-construction claim that fails its counter-attack,
the exact sin the battery preamble exists to catch.

**mechanisms = 6.** I counted the structures myself: 9 (K0+allocation
lists; tape+fold; token/slot/lock-views; K1+touched+walks; memos+capsules;
evaluator chains+staging; watcher records+fixup+drains; fork+carrier;
episode lifecycle) — the inventory is honest under a defensible counting
rule, and the round's deletions (lockTerm/lockStamp, suppression
predicate, WORLD_TAINT column, runSync, MessagePort shim, renderCycle)
are real. Most obligations are structural and enumerable (visibility
math, the touched-word audit table, the closed change-source table, R2's
case split, R4's flip enumeration). The residue of semantic completeness
obligations (E-PRESERVE's "every dropped edge," TAINT epilogue coverage,
and I31's every-surface conjunct discipline) is where Blocker B actually
happened — a live demonstration that nine cooperating mechanisms still
leak at their seams.

**seam = 8.** Nine integer/callback protocol facts, each edge-triggered
with its invariant documented in place; 33 reconciler-level tests
enumerated, several load-bearing for specific battery rows (23, 24, 32,
33); the rebase drill is answered concretely and correctly (lane renames
→ F1 minting; commit-phase moves → F3/F9 re-anchoring; update-queue
changes → nothing crosses); hard rules honored (no Fiber/lanes/queues
across the boundary, loud feature-detect). G5 honestly flags the missing
current-generation existence proof for per-root facts and F9 — the one
real seam risk, correctly on the critical path.

**performance = 7.** Every hot mechanism has a numeric gate and a ledger
row consistent with research-facts ([ARENA] tier-0 numbers cited, I11
storage/boundary split respected, I30 carrier measured); unmeasured paths
are named spikes with decision rules and pre-named fallbacks, one
fallback correctly embargoed pending its own walked schedule (S17 risk).
Honest flags rewarded: the LOGGED-quiet floor (2.4–3.8% vs the ≤2% P3
gate) is declared AT RISK with a pre-registered renegotiation rather than
wished away. Deductions: that floor already exceeds the gate; R12's
restored "zero extra work" claim is achieved only via the correctness
hole, so its honest repair re-opens a bounded per-mount eval cost; the
R4 advance-drain and P3′ promotion-walk costs are ledgered but
unmeasured.

**explainability = 7.** The one-page story (base §1 plus the synthesis's
amended paragraphs) covers all nine counted mechanisms in plain English,
in order, with the round's three headline blockers narrated to their
deaths; concepts are defined before use; the walk format is followed
throughout. Deductions: the design now lives in two documents (a
1550-line base plus a repair overlay), and the overlay's "carry"
assertions are exactly where both new blockers hid — the spec's structure
worked against its own auditability.

---

## 5. Verdict

```
VERDICT
new_confirmed_blockers: 2
scores: correctness=5 mechanisms=6 seam=8 performance=7 explainability=7
open_spikes_that_could_change_architecture: 1
exit_recommended: no
one_line: A genuine consolidation whose core battery survives attack, but two of its own repairs (R12's baseline fast-out and R1's unrouted evaluator versions) each mint a confirmed torn-frame blocker at the mount-fixup and fast-path seams.
```

(The one architecture-relevant open spike is the G-W/G-N delivery-walk
realism family — row 19 stands NEEDS-MEASUREMENT and its pre-blessed D13
per-slot-mark fallback is embargoed as S17-adjacent, so a gate failure
there has no walked landing zone yet. SPK-L is a requirements
renegotiation, SPK-G8/SPK-K1 have in-class fallbacks.)
