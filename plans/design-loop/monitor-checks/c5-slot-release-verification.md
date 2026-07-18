# C5 adversarial verification — immediate slot release (D25)

Verifier: monitor-side adversarial check, 2026-07-05. Sources: DECISIONS
D25; EXIT-CASE C5 + C2; champion = round-05/synthesis.md (RS1 version
entries + visibility, RS3, RS7) over round-04/synthesis.md (R2 dedup, R4
drains, R5/R6 fixup, §15 dedup-clear rows) over
round-04/design-consolidate-a.md (§5.1 write path, §5.2 visibility, §5.3
retirement order, §5.4 force-clear, §6.2–6.4 routing invariants, §7
touched-word audit, §8.2 ladder, §10 delivery, §11.2 fixup, §15 lifecycle
table); INVARIANTS I10/I13/I18/I19/I23/I39/I44; mechanism-library
writer's-world (retired ∪ applied ∪ own-batch).

Claim under test (D25): a retired batch's 5-bit slot releases immediately,
gated only on "slot ∉ every open pass's include mask"; clause 2 of receipt
visibility gains a slot-claim-epoch guard `receipt.seq ≥ slotClaimSeq[slot]`.
Consequence claimed: slot demand ≤ React's live-batch bound, saturation
unreachable, all spillover/degrade machinery deletes.

---

## 1. The Monotone Tenancy Lemma (what actually makes recycling sound)

All seq-bearing facts are minted from ONE monotone counter (globalSeq;
S12/I15: retirement stamps and pins share one line). Preconditions, each an
ordering the implementation must enforce (amendment A3):

- **P1 (stamp-before-release).** At tenant X's retirement, every X receipt
  gets `retiredSeq` (§5.3 step 2) BEFORE slot s re-enters the pool. So at
  any moment, the un-retired entries bearing slot s belong to exactly the
  current tenant.
- **P2 (claim-after-release).** Y claims s only after X's release, which is
  at/after X's retirement. Hence `max(retiredSeq of X's entries) <` every
  seq minted after Y's claim.
- **P3 (pin/seq-after-claim).** Any receipt of Y has seq > claim time; any
  pass whose mask bit s *means* Y pinned after Y was live, i.e. after the
  claim. (Masks are captured from live tokens at pass start; a mid-pass
  first write's receipts have seq > pin and are clause-2-excluded anyway.)

**Lemma.** For consecutive tenants X → Y of slot s:
`retiredSeq(every X entry) < claim(Y) < min(seq of every Y entry, pin of
every pass whose mask names s-as-Y)`.

**Corollary (alias harmlessness).** For any pass world w = (mask, pin) with
s ∈ mask:

- An OLDER tenant's entry e (slot s): `e.retiredSeq < claim ≤ pin` ⇒ e is
  visible via clause 1. A spurious clause-2 match is `visible ∨ visible` —
  no change to the visible set, hence none to fold, fp, replay order, or
  count (fold is one tape scan against a predicate; replay is by global
  seq; X's seqs < Y's seqs, so order is correct and nothing double-applies).
- A NEWER tenant's entry vs an old-tenant-mask pass cannot coexist: the
  open-mask condition blocks release while that pass lives. Even if it did
  not (see §6, exhaustion backstop), the newer entries have seq > that
  pass's pin and fail clause 2's seq conjunct. Belt and suspenders, both
  independently sufficient for receipts.

This is the verified form of the requester's re-derivation (a): correct,
with P1–P3 as the load-bearing preconditions that must be stated as
invariant rows, not left implicit.

## 2. Verdict on the slot-claim-epoch guard: NOT NECESSARY

- For every clause-2 consumer over RECEIPTS (pass worlds §5.2; fixup w_fx
  §11.2 clause 2, whose clause 1 `retiredSeq ≠ ∅` is even wider; RS3's
  conjunct 3 population), the corollary makes every cross-tenant match
  harmless. The guard rejects entries clause 1 already admits — it never
  changes any world's answer.
- The guard can never wrongly exclude either (given P1: current-tenant
  entries all have seq ≥ claim) — so it is safe but inert.
- Writer's-world (retired ∪ applied ∪ own-batch): own-batch keyed by slot
  matches un-retired s-entries = current tenant's only (P1). Old-tenant
  entries land in the retired term regardless. The requester's point (b)
  verified.
- **Cost of keeping it is not zero**: `slotClaimSeq[32]` is a seq-bearing
  table, so it joins the §15 renumber duty list — D25 as recorded does NOT
  add that row, so D25-with-guard is unsound-by-omission at renumber (C13
  class: a live/episode renumber rewrites receipt seqs but not the claim
  epochs; clause 2 then mis-rejects or mis-admits post-renumber). Dropping
  the guard dissolves the row. Recommendation: drop it; state the lemma as
  the invariant. At most keep the compare as a dev-assert (dev-build table,
  no shipped state).

## 3. What the open-mask condition is actually FOR (it is necessary, but
not for receipt visibility)

Receipt clause-2 math would survive even mid-pass release of an INCLUDED
slot (seq-monotonicity, corollary above). The condition is load-bearing for
three other things:

1. **RS1 version entries.** They carry `token t` and NO slot field;
   `t ∈ w.mask` resolves via the interning table (token→slot). A pass P
   with mask ∋ slot(T) whose T retires mid-pass (entangled lane with no
   work on P's root, or multi-root) must still resolve T's promoted
   evaluator via clause 2 — clause 1 fails (rs > P.pin). Release would
   unmap t and P would fold under the stale evaluator (C11-E-class tear).
   The condition keeps slot(t) resolvable exactly as long as any pass can
   need clause 2 for t. (Alternative that dissolves this: denormalize the
   slot onto the version entry at mint, like receipts — then version
   entries are lemma-covered too. Optional hardening, not required.)
2. **wc[s] stability / memo ladder.** wc[s] zeroes at re-intern (§15) and
   then carries the new tenant's seqs. Ladder step 3 and RS3 conjunct 3
   (`∀s ∈ mask: wc[s] ≤ …`) stay meaningful for an open pass only if s
   cannot be re-tenanted under it. Without the condition the pass never
   serves a wrong value (new-tenant wc is HIGH, so memos refuse and
   re-fold conservatively) but loses every memo serve for its remaining
   life — a silent perf cliff on exactly the pass being protected.
3. **R2 suppression + fixup per-token loop coherence.** Both consult live
   tokens/active-pass masks; the condition guarantees any open mask bit s
   denotes one unambiguous tenant (older tenants' release completed before
   the current claim, so no open pass can hold an older meaning of s —
   verified: a pass holding s-as-X blocks X's release, so Y cannot claim
   while it lives).

## 4. Attack schedules

Notation: receipt = {atom=value @seq, slot s, rs=retiredSeq or ∅}. One
globalSeq line. K0 = newest-applied.

### 4.1 Paused-pass exclusion

Setup: atom a base a0. P = transition pass, pin 100, mask {2=T}. Urgent U
claims slot 5, writes a=1 @110 (bit 5 marked on a's cone, touchedList[5]
appended, wc[5]=110, delivered value-blind). U commits, retires: stamp
rs=112. Release check: 5 ∉ {2}, no other open mask → slot 5 released. V
claims 5 (after 112), writes a=2 @120.

| reader | entry {a=1@110, s5, rs112} | entry {a=2@120, s5, rs∅} |
|---|---|---|
| P (pin 100, mask {2}) | cl.1: 112≤100 ✗; cl.2: 5∉{2} ✗ → INVISIBLE ✓ | ✗/✗ → INVISIBLE ✓ (also 120>100) |
| Q (pin 130, mask {5=V}) | cl.1: 112≤130 ✓ visible (committed history); spurious cl.2 match harmless | cl.2: 5∈mask ∧ 120≤130 ✓ visible ✓ |

Visibility: PASS. **Routing horn (the amendment):** P's world is served
soundly only if P's reads of U-dirty nodes stay OFF the K0 fast path.
U's entries can't compact (rs 112 > pin 100 — §5.3's pin-gated prefix ✓),
but if release SWEEPS bit 5 with no compensation, touched(n)=0 ∧ CT(n)
fast-paths K0 values embedding a=1 into P — invariant R conjunct 4 / I39's
first horn verbatim, and RS1's source-3 construction ("the bits outlive
every invisible world by the sweep gate") breaks identically for promoted
evaluators. D25 as recorded is silent here → REQUIRED amendment A2.

### 4.2 Mid-pass retirement of an INCLUDED batch

P pin 100, mask {3=T} (T's lane entangled; T's React work lives on another
root — this is the only way an included batch retires under an open pass;
a batch whose work IS this pass cannot leave React's books before the pass
commits, and a discarded pass leaves its lanes pending, blocking
retirement). T wrote b=7 @95. T's other-root work commits; T retires,
stamps rs=105 > 100. Release check: 3 ∈ P.mask → **blocked**. P resumes:
b: cl.2 3∈mask ∧ 95≤100 → sees 7 ✓ (cl.1 fails, 105>100 — clause 2 is
load-bearing). A post-pin T write @103: cl.2 seq 103>100 → excluded ✓ (C7
parity; its K0 presence is routed by retained bit 3). T's promoted
evaluator (if any): version entry {t=T, q≤100}: `t ∈ mask` resolves —
interning row alive because release is blocked ✓. R4 retirement drain
enumerated touchedList[3] before any release ✓. P ends → release
re-evaluated at passEnd → slot 3 frees, then normal §4.1 story. PASS —
and the walk shows the condition must be re-checked at EVERY passEnd
(commit AND discard), amendment A3.

### 4.3 New pass after recycling

Q pins 130, mask {5=V} (V live at Q's start ⇒ claim < 130, P3). Old tenant
U's receipts {@110, s5, rs112}: visible to Q via clause 1 (112≤130) — they
are committed history and MUST show. Fold: one scan, predicate-visible
entries replay by seq: 110 before 120 ✓; nothing double-counts (a receipt
is one tape entry; clause-1∨clause-2 is one boolean). fp(a, w_Q) sees the
same visible set with or without the guard ✓. Mount inside Q → w_fx:
clause 1 `rs ≠ ∅` admits U's receipts, clause 2 admits V's ≤130 ✓ same
values as Q's render → no spurious correction ✓. Memo aliasing between a
dead T-era world and Q impossible: any old s-mask world has pin < claim <
130, so worldKeys differ ✓. PASS.

### 4.4 Writer's-world of the recycled tenant

V (slot 5) writes a=3 @125 while a's tape still holds U's {@110, s5,
rs112}. Tape non-empty → the §5.1 drop check is bypassed (always append,
S8) → no wrong drop ✓. K0 apply compares against newest-applied (embeds
U's fold) — slot-free ✓. Writer's-world = retired ∪ applied ∪ own-batch:
own-batch-by-slot collects un-retired s5 entries = V's only (P1: U's all
stamped before release); U's enter via the retired term — same union
either way, no wrong inclusion/exclusion ✓. Delivery: walk reaches W;
dedup bit (W,5) — must have been cleared at re-intern (amendment A1,
below); R2 then delivers in V's lane ✓. PASS with A1.

### 4.5 Sweep/compaction interplay

P ends (pin 100 gone). U's entry {@110, s5, rs112}: prefix rule — every
entry with seq ≤ 110 retired ✓, rs 112 ≤ min(live pins) ✓ → folds into
base; V's {@120} stays (un-retired). Compaction keys on seq order +
retired bit + pins ONLY (§5.3 step 2) — the identity of slot 5's current
tenant never enters ✓. Per-slot unswept-entry COUNTS (I10's gate) are
deleted with retention (amendment A4) — nothing decrements, so round-5
finding 6's wrong-incarnation-decrement hazard is dissolved rather than
inherited ✓. RS1 version entries reclaim by their own token-keyed rule
(`t retired ∧ min pins ≥ retiredSeq(t)`) — slot-free ✓. PASS.

### 4.6 Composition with the C2 multi-root cut

Per-root committed view = retired ∪ locked-into-r (simple per-root table).
Retired term keys on retiredSeq — slot-free ✓. Locked rows key on (root,
token) and clear during retirement bookkeeping, BEFORE release (§5.3 step
5's injectivity ordering carries; A3 pins it) — no row can name a freed
slot ✓. A live-elsewhere T (committed on A, pending on B) is NOT retired →
not releasable → no aliasing window mid-lock ✓. Per-root passes use the
two-clause rule; the lemma is root-agnostic (one counter) ✓. R4
lock-in/advance drains enumerate touchedList[slot] for LIVE tokens only
(advances happen only while t is live; post-retirement flips don't exist —
R4's closed construction carries) ✓. Nothing in the per-root story
consults a retired batch's slot identity. PASS.

### 4.7 Storm test

One yielded transition P (pin 100, mask {2=T}); 40 urgent keystroke
batches U1…U40 during the yield, each: mint token → intern slot at first
write → write/render/commit → retire (rs_i > 100) → release check (retired
✓; slot ∉ {2} ✓; ∉ other open masks ✓) → slot returns to pool.

| instant | slot table contents |
|---|---|
| any | T(2) live+mask-retained; U_cur (1 slot); ≤1–2 overlapping urgents (sync/default in flight) |
| worst observed | ~4–5 entries; the pool recycles the same 2–3 ids 40 times |

Never approaches 31; no force-clear; no victim selection. Receipts of all
40 are RETAINED on tapes (pin 100 blocks compaction) — tape growth is the
pre-existing held-transition cost, unchanged; only slot-ID demand
collapsed. Under amendment A2(b) P's fast path survives except on
actually-dirty cones — identical routing behavior to the champion's
retention, which is the point: **the slot ID and the slot's bookkeeping
have different lifetimes; D25 conflated them**. PASS with A2.

## 5. Audit: every consumer of a retired receipt's slot field / per-slot state

| consumer | verdict under immediate release |
|---|---|
| visibility clause 2 (receipts; w_fx clause 2; RS3 population) | lemma-covered; guard redundant (§1–2) |
| RS1 version-entry clause 2 (`t ∈ mask` via token→slot lookup) | needs the open-mask condition (or denormalized slot field) — §3.1 |
| retirement stamping walk ("t's now-retired receipts") | identifies un-retired s-entries = current tenant, sound by P1; requires stamp-before-release ordering (A3) |
| retirement/R4 drains: touchedList[slot(t)] enumeration | runs inside F3 before release (A3); post-recycle enumerations see a superset (old-tenant records) — reconcile is value-compared, conservative ✓ |
| touched bits 0–30 + touchedList[s] + mark frontier | the frontier invariant (bit on n ⇒ n's whole reachable cone bitted, via write walk + edge-add inheritance I23 + E-PRESERVE) is per-BIT transitive closure, tenant-agnostic — so bits may lawfully OUTLIVE the tenancy as conservative dirt; what is UNSAFE is erasing them early (A2) |
| per-(watcher, slot) delivery dedup bits (R2/I44) | REAL HOLE — A1 required. A stale set bit + no active s-pass ⇒ R2 suppresses the new tenant's first delivery. Reachable: React retires a lane whose updates on hidden (Offscreen/Activity) fibers were rebased at markRootFinished — the watcher never rendered, the bit never re-armed, the batch still retired. R4's commit-time reconcile bounds the damage (pre-paint correction at V's commit) but the pending-pass delivery is lost and the backstop becomes primary delivery. The champion already prescribed dedup-clear at its recycle sites (round-04 synthesis rows 14/§15); the site must MOVE to release/re-intern |
| wc[s] (ladder step 3, R6 bound, RS3 conjunct 3) | zero-at-re-intern carries; in-pass stability guaranteed by the open-mask condition (§3.2) ✓ |
| fixup per-token loop; R2 suppression check | live-token/live-mask keyed; unambiguous under the condition (§3.3) ✓ |
| compaction, fp, base folds | slot-free (§4.5) ✓ |
| per-root lock/committed rows | cleared pre-release (§4.6) ✓ |
| per-slot unswept-entry counts | deleted with retention (A4); no consumer remains |

## 6. Saturation "unreachable": an over-claim, with a cheap honest fix

Slot demand = |live tokens with slots| + |retired slots retained by open
masks|. The first is ≤31 (I10, fork guarantee). The second is usually 0–2
(schedule 4.7) but is NOT structurally zero: a pass whose mask names k
written batches that all retire mid-pass (entangled lanes with no work on
that root / multi-root) retains k slots; adversarially live + retained can
exceed 31 (e.g., 31 retained by one yielded pass + a 32nd fresh live
token). So "saturation unreachable" as recorded is false in the adversarial
limit. The fix is 4 lines, not spillover machinery: on intern with an
empty pool, release the oldest mask-retained retired slot anyway and flag
its retaining passes world-path-only — safe for receipts by the lemma
(new-tenant seqs > those passes' pins; old entries retain their slot
fields and stay clause-2 visible), costs those passes their version-entry
clause-2 resolution unless version entries denormalize their slot (§3.1's
optional hardening makes even this corner fully safe). Loud dev-log
retained. EXIT-CASE C5's deletion list ("spillover machinery, loud-degrade
fallback, the saturation scenario") survives; the row's bound should read
"≤ live-batch bound + open-mask retention (small; loud 4-line backstop for
the adversarial corner)".

## 7. Required amendments

- **A1 (dedup clear at recycle — I19/I44 row).** Clear every per-(watcher,
  s) dedup bit when slot s is re-interned (ride the touchedList[s] walk),
  or replace bit-dedup with the seq rule `deliver iff lastDeliverySeq[W,s]
  ≤ lastStartedPassPin[root(W)]` (monitor-design §5), which is
  recycle-proof with no clear site. Without A1 the new tenant's first
  delivery can be suppressed (Offscreen/hidden-updates horn, §5 table).
- **A2 (bit/list disposal — the I39 horn D25 doesn't mention).** Choose
  one, both sound: **(a)** sweep bit s + reset touchedList[s] at release,
  compensating with the per-pass world-path-only flag on every open pass
  with pin < maxRetiredSeq[s] (force-clear §5.4's own discipline,
  generalized — note this RETAINS the flag mechanism, amending D25's
  "all degrade machinery deleted", and degrades yielded passes in the
  common storm case); or **(b) [recommended]** release the ID only —
  bits/touchedList persist as tenant-agnostic conservative dirt with their
  existing pin-gated lifetime (sweep at a re-intern where min(live pins) ≥
  maxRetiredSeq[s], else inherit and carry maxRetiredSeq forward; bulk
  zero at episode reset). (b) is routing-behavior-identical to the
  champion's retention, deletes fastPathDisabled entirely, and keeps RS1's
  "bits outlive every invisible world" construction verbatim. Either way
  I39's first sentence is honored; only its saturation half dissolves.
- **A3 (ordering + trigger sites — I19 rows).** Within F3: stamp
  retiredSeq on every receipt of t → folds → durable drains
  (touchedList[slot(t)]) → clear per-root lock/committed rows for t →
  unmap token→slot and release (if unblocked). Re-evaluate deferred
  releases at every passEnd, commit AND discard. Parked (async) tokens are
  live, never releasable. wc[s] zeroes at re-intern (existing §15 row).
- **A4 (deletions made explicit).** Per-slot unswept-entry counts and the
  swept-entries recycle gate delete; I10's text amends from "recycling
  gated on zero unswept entries" to "recycling gated on retirement-stamped
  ∧ open-mask exclusion (+ A2's disposal rule)"; RS1's "joins slot(t)'s
  unswept gate" clause becomes vacuous; I39's saturation clause dissolves
  into §6's backstop.
- **A5 (guard).** Drop the slot-claim-epoch guard (§2); record the
  Monotone Tenancy Lemma (P1–P3) as the replacing invariant. If retained
  against this advice, slotClaimSeq[32] MUST join the §15 renumber duty
  list (omitted in D25 as recorded — latent renumber bug).
- **A6 (optional hardening).** Store the slot on RS1 version entries at
  mint; version entries become lemma-covered like receipts, shrinking the
  open-mask condition to a pure perf choice and making §6's backstop
  unconditionally safe.

## 8. Verdict

The core restructuring is right: slot-ID demand collapses to live batches
plus open-mask pins, the storm case holds a handful of table entries, and
receipt visibility needs NO new guard — the epoch guard is redundant
(and, as recorded without a renumber row, a latent bug). But D25 as
recorded is incomplete: it says nothing about the disposal of the slot's
bookkeeping (touched bits/lists — I39's first horn re-opens under a naive
sweep, schedule 4.1) or per-(watcher, slot) dedup (a suppressed
first-delivery for the new tenant, schedule 4.4/§5), and "saturation
unreachable"/"all degrade machinery deleted" both over-claim by one
adversarial corner and one retained flag (unless A2(b)+A6 are taken, which
delete both cleanly).

**VERDICT: SOUND-WITH-AMENDMENTS** (A1–A4 required; A5 recommended
deletion of the guard; A6 optional hardening).
