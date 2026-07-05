# Round 5 review — surgical-a — Claude reviewer

Design reviewed: `design-loop/rounds/round-05/design-surgical-a.md`, together
with its incorporated normative base (`rounds/round-04/synthesis.md` +
`rounds/round-04/design-consolidate-a.md`, which the diff manifest carries
verbatim — reading the base is required to evaluate a diff-shaped artifact).
Not read: the sibling round-5 design, any judge file, any prior review.

Method executed: re-walked the docket math and the delta-bearing battery rows
(C1-X6, K2a/K2b, C9′, C10, C2-M, C3-M, C13, T8-N), attacked both repair
constructions (§2.3, §3.3) with counter-schedules, probed the seams the diff
creates (promotion marking × saturation × renumber × E-PRESERVE re-track ×
R2 dedup; commit-entry baseline × F3 ordering × deferred-effect mounts), and
audited the Δ3 lifecycle rows. Findings first, ranked; then verified-held;
then verdict.

---

## Findings

### F1 — BLOCKER — Q2's fast-out returns for a watcher whose rendering pass is not the committing pass while the commit's own folds move committed truth outside `w_r.mask` (Activity/Offscreen reveal): permanent torn committed DOM

**Mechanisms defeated:** Δ4's replacement fast-out (all three conjuncts) +
the I18 committed-compare fallback it guards; R4's drain (runs pre-layout,
before the watcher exists); R2 dedup (no bits ever set).

The construction in §3.3 partitions motion into "before commit entry"
(conjuncts 1–2) and "during the commit" — but the during-commit
value-neutrality cases (a)/(b)/(c) are each argued **only "for a watcher
rendered in the committing pass"**, whose mask equals the commit's batches.
For that population, own-commit retirement folds are folds of *included*
tokens and conjunct 3 certifies them. The design's whole coverage for the
other population is one sentence: *"A watcher whose rendering pass is not
the committing one (Offscreen reveal) fails conjunct 1 — conservative
fall-through."* That is asserted, not constructed, and it is false: conjunct
1 fails only if some **pre-entry** advance postdates the watcher's pin. A
quiet-since-the-pin app gives `baseline.cas ≤ w_r.pin`, and the committing
commit's own fold of a token **not in `w_r.mask`** is invisible to every
conjunct: the cas bump is post-capture (that is the entire point of the
entry capture), the slot is outside the mask so conjunct 3 never checks
`wc[s]`, and no lock view moved.

Note this is in-scope by the design's own premises: I41/F9 exists precisely
because hidden Offscreen trees commit with hooks current but **effects
deferred to reveal** — so subscription + mount fixup for a pre-rendered
hidden watcher run at the *reveal* commit, under a `w_r` captured at the
pre-render pass.

```
K3 (new; pinned test demanded): Activity reveal + same-commit non-included retirement
setup | quiet app, ZERO receipts ever (F1 mints tokens lazily ⇒ no token, no retirement,
      | cas stays at init c0); root R: <Activity mode="hidden"> wraps W on c-over-a;
      | visible sibling V on c; committed a=0, c=f(0)
1 | app mounts (no signal writes); Activity pre-renders the hidden subtree in its own
  | deferred pass P_h (mask ∅, pin p1 > c0) and commits it hidden; W's effects are
  | DEFERRED (the I41 premise) | W: v_r = f(0); w_r = (∅, p1, LVid_1); W has NO watcher
  | record yet (subscription is a layout effect)
2 | one event: a.set(1) → batch u minted, receipt {1@s2>p1}; setShow(true) same event
  | wc[u]=s2; write walk: touched(c) ∋ slot(u); delivery reaches V (subscribed);
  | W unreachable — no record exists (the I18 race, verbatim)
3 | u renders (mask {u}, pin p2 ≥ s2): V re-renders f(1); the Activity boundary flips
  | visible; W BAILS OUT (no pending lanes, no prop change — reusing the pre-rendered
  | tree is Activity's purpose) | committed tree: V = f(1), W = f(0)
4 | u commits. Step 0 (Δ5): commitBaseline := {cas = c0, LVid_1} — nothing has ever
  | advanced. Then folds: u retires, s2 → committed; cas := s2′ > p1 (POST-capture).
  | R4 drain runs pre-layout; touchedList[u] holds no W watcher record, and W is still
  | unsubscribed even under a node-based drain reading (F3 order: folds → reconcile →
  | layout) | committed truth: a=1, c=f(1)
5 | layout: W's deferred effects finally run — subscribe, then fixup. touched(c) ≠ 0 ⇒
  | past R5's first fast-out; per-token loop over LIVE tokens: u retired ⇒ empty.
  | Q2 fast-out: baseline.cas = c0 ≤ p1 ✓ ∧ LVid_1 == LVid_1 ✓ ∧ ∀s ∈ ∅ ✓ ⇒ RETURN
  | — w_fx is never evaluated
6 | paint | V shows f(1) beside W showing f(0): TORN COMMITTED DOM. u is retired, W's
  | dedup bits are clean, u's drain already ran ⇒ no future flip enumerates W ⇒ NO
  | CORRECTION until some unrelated later write happens to reach c (unbounded)
outcome: violates I18's mandate (the compare is the designated fallback for exactly
this subscribe-after-write race); the fast-out's own-motion exclusion is sound only
for the population §3.3 analyzed.
```

**Lineage check (why this is new to Q2):** the base's original fast-out read
*live* cas (`committedAdvanceSeq ≤ w_r.pin`) — at step 5 live cas = s2′ > p1
⇒ it would fall through and fire (at the known cost a-claude F4 complained
about); R12's `cas == baseline` was tautologically true (the design's own
§3.1 kill) and also tears here. Q2 fixed the committing-pass population and
re-opened the deferred-effect-mount population.

**Reachability premises, stated:** (i) hidden pre-render is a separate
deferred pass (that is the Activity feature; if it rendered in the mount
pass, an incidental earlier cas bump may rescue by luck — luck is not
coverage); (ii) reveal reuses the pre-rendered child when it has no pending
lanes (standard bailout; if React re-rendered W in u's pass, w_r would be
({u}, p2) and all is well — the fix below preserves that case's zero-eval).

**Severity: BLOCKER.** Wrong committed frame, value-bearing, no correction
path, on shipping React surface the design itself names.

**Judgment: LOCAL FIX.** The architecture already ships the needed fact:
`lastRenderPassId` is stamped at every watcher render (R3). Gate the
fast-out on "w_r's pass IS the committing pass" (one int compare); a
deferred-effect mount falls through to the per-token loop + w_fx compare
(bounded evals, only on reveal-shaped mounts — priceable in G-F). C9′(a)'s
zero-eval row is untouched (in-pass mounts pass the gate). Alternatively,
extend conjunct 3 to "no token retired at this commit with entries > w_r.pin
outside w_r.mask" — more state, worse than the passId gate. Pin K3 and an
Activity-reveal-under-cross-root-traffic variant.

### F2 — MEDIUM — Δ1's `oldestLivePin` scan, as written, always includes the committing pass's own frame: step 4 is unreachable and the "quiet promotions are zero-cost" claim (and two §7 pricing rows) are false as written

Δ1 step 2 computes `oldestLivePin` over "every open pass frame … all roots";
Δ6 pins frame lifetime to `[passStart, passEnd(commit|discard))`. F9 runs
*inside* the commit, before passEnd, so the committing pass's frame is open
— and its pin is < q **always** (q = ++globalSeq minted at F9, after pass
start). The committing pass is not RENDER_NEWEST (it staged; staging demoted
it, base §11.1), so nothing excludes it from the enumeration.

```
schedule | any promotion, zero cross-root passes open
1 | pass P_A (pin p) stages f1, renders, commits; F9: q = ++globalSeq > p
2 | P2′ scan: P_A's own frame open, pin p < q ⇒ oldestLivePin < q ⇒ step 3 MARKS
  | the cone, bumps wc[s], creates the synthetic unswept entry — on EVERY promotion
outcome (not a tear): step 4's branch is dead code; Δ1 step 4's "promotions in quiet
apps stay zero-cost" and §7's SPK-R/SPK-W qualifiers "non-zero only when a promotion
races a live pin" are contradicted by the design's own frame-lifetime rule (Δ6).
Over-marking is safe (bits route conservatively; the synthetic entry sweeps as soon
as the committing frame closes) — cost and internal consistency only.
```

**Severity: MEDIUM** (normative dead branch + two mispriced gate rows; a
spike would catch the cost, but the text contradiction steers the
implementation). **Judgment: LOCAL FIX** — one sentence: exclude the
committing root's committing frame from the oldestLivePin scan. Soundness of
the exclusion (should be stated in the fix): the committing pass cannot
evaluate after F9 (render is over; layout effects read committed/NEWEST),
and its world memos are unreachable by any future worldKey because pins are
minted monotone and never reused (renumber epoch-bumps).

### F3 — MEDIUM — Δ7's "forced discard needs no new fork surface" note (test-32 insertion) is asynchronous, contradicting R8's synchronous discard-then-rewrite precondition; the slack construction covers one atomic extent, not multi-task deferral

R8 step 1 requires **all** WIP passes discarded (zero live pins) before the
order-preserving rewrite; its soundness proof ("live pins are impossible at
step 2") depends on it. Δ7(iii) claims implementability by "inserting a
trivial interleaved update per root" — but insertion makes React abandon the
WIP **when its scheduler next processes that root**, not at the library's
operation boundary. Δ7(ii)'s slack is sized "≥ one atomic extent's mints"
(mid-commit deferral only).

```
schedule | forced-small horizon H (the C13 discipline), the async reading
1 | globalSeq reaches H − slack; root B transition pass P_B yielded (pin p)
2 | a mint at an operation boundary triggers renumber → trivial updates inserted;
  | P_B's abandonment now waits on B's next scheduler slice
3 | the current and subsequent tasks keep minting (a dense retirement-fold extent,
  | more writes) past H before B's slice runs → wrap forced with live pin p
4 | post-wrap retirement stamps retiredSeq = small ≤ p → false retired-visibility
  | in P_B's resumed fold → torn resumed frame (S38(a) re-entered through the gap
  | between the two readings of "discard")
```

**Severity: MEDIUM** (needs forced-small-H or extreme uptime, plus an
implementer following Δ7's note instead of R8's letter — but the note exists
to be followed). **Judgment: LOCAL FIX**, pick one honestly: (a) name the
synchronous discard as a fork capability (F2 discard invokable by the
library) and put it on the O7/O23 existence-proof line — which is what R8's
own text ("Fork discards every WIP pass") already implies; or (b) keep the
insertion trick and gate every mint site while renumber is pending, with a
re-derived slack bound (needs a number ⇒ a spike row). The Δ7 forced-small-H
test should pin whichever is chosen with a mid-yield WIP present.

### N1 — NOTE — whether cas bumps on receipt-less retirements is unspecified

The base says cas bumps at "retirement folds"; a token with zero receipts
has an empty fold. The choice moves conjunct-1 hit rates (and rescues some —
not all — F1 variants by accident; F1's pinned K3 uses lazy minting so no
token exists to retire and the choice is moot there). Specify it; suggest
"bump only when a fold/lock/promotion actually mutates committed-side
state", and rely on the F1 fix — never on incidental bumps — for
deferred-effect mounts.

---

## Verified held (attacked; the attack failed — stated per the discipline)

1. **Q1's routing repair vs the C1-X6 family.** Tried to re-open the
   wash-out: yield-gap NEWEST recompute after marking (bit persists — bits
   clear only at sweep/force-clear, and the synthetic entry pin-gates the
   sweep); marking-before-any-read ordering (synchronous commit; pins
   monotone ⇒ no later pass pins < q). Held; row 5′/6′ walk verified.
2. **Q1 vs the evaluator-deps re-track seam** (my best candidate for a new
   blocker; it failed). Promotion changes n's deps; the first NEWEST
   recompute under f1 re-tracks K0 and drops f0's in-edges; with zero
   receipts anywhere E-PRESERVE mirrors nothing. No hole: a pre-q pin's
   world evaluation of n under f0 records its real deps in K1 at evaluation
   time, so later writes to f0-only deps route through the eval-recorded
   edge (edge-add inherits s while unswept); before any such evaluation,
   Δ1's bit already refuses the fast path; a write reaching n only through
   a dropped edge cannot precede that evaluation's own recording (I4 applied
   to the evaluator as divergence source, exactly as §2.3 argues). Held.
3. **Q1 slot-choice indifference** ("any included token serves", multi-token
   commits, test 35). Audited every consumer of bit s / wc[s] / the
   synthetic entry (routing, ladder step 3, R6's bound, Q2 conjunct 3, R4
   drains incl. live-vs-retired t, force-clear maxRetiredSeq, sweep gate):
   only pin-gated retention is load-bearing; which included slot carries it
   is immaterial. Held.
4. **Q1 × saturation.** Force-clear of s with a live pre-q pin: the
   synthetic retiredSeq = q forces fastPathDisabled onto every pre-q pin;
   world path resolves the version at the pin; the fixup consumer is covered
   by I51's w_r flag capture (R5). Held.
5. **Q1 × renumber/quiescence.** Discard-first ⇒ no live pins ⇒ synthetic
   entries reclaim pre-rewrite; promotedAtSeq (= the synthetic retiredSeq)
   is on the §15 duty list; quiescence sweeps superseded versions. Held.
6. **Q2 for committing-pass watchers** (K2a, K2b, C10 race (i), C2-M,
   C9′(a) zero-eval cost row). The partition is exhaustive *for that
   population*: own-commit retirements are of mask tokens only (a batch
   retires at a commit only if its lanes rendered there; store-only closes
   are task-boundary foreign events), so conjunct 3 certifies them; foreign
   motion ⇒ conjuncts 1–2; own lock-in/F9 are value-neutral per (a)/(c)
   (watermark = pin, test 33; stamps installed unchanged). Counter-attacks
   (self-promoting commit mounts where Δ1 bumps wc[mask slot] to q > pin;
   parked-live post-pin writes; own lock-in with foreign LV drift) all land
   in priced-safe branches (wasted eval / loop-corrected / conjunct-2
   fall-through). Held — F1 is exactly the population outside this proof.
7. **Δ6 (R2 "all open frames").** Attacked with the completed-uncommitted
   suppression schedule and a discard-timing variant (urgent restart
   discarding the completed tree before the continuation write): while the
   frame is open the check delivers; once discarded, suppression is sound
   because the forced restart re-pins ≥ seq. Held.
8. **R2 × Q1 seam.** A set (W, s) bit suppressing the promotion-seq
   delivery is sound when no started pass on root(W) includes s with pin <
   q: the scheduled s-lane work pins ≥ q at start and folds f1. Held.
9. **cas on the one number line (I15).** Q2's conjunct 1 requires cas
   values to be globalSeq mints; consistent with the base's own
   `cas ≤ w_r.pin` fast-out; §3.3 states it. Held — flag as load-bearing.
10. **VH-R3 (A/B/A) and VH-R9 (i)/(iii)** spot re-walks: pure-deps A/B/A
    terminates via seed-match; prefix-equality-gated reference installation
    correctly declines on post-pin foreign retirement. Held.
11. **Fork honesty.** Tests 34/35 are named, reconciler-level, and placed on
    the G5/O7/O23 existence-proof risk line; the rebase drill answer
    survives the two additions (commit-entry capture and F9-context token
    sampling are protocol facts, not internals). Held.

---

## Verdict

The Q1 repair is genuinely solid — it survived every counter-schedule I
could build, including the evaluator re-track/E-PRESERVE seam and the
saturation/renumber lifecycles — and Q2 kills the two schedules it pinned.
But Q2's comparator is *proven* only for watchers rendered in the committing
pass, and its one-sentence dispatch of the deferred-effect-mount population
(Offscreen/Activity reveal) is false: the commit's own folds of non-included
tokens evade all three conjuncts, yielding a permanent torn committed DOM
(F1 — blocker, one-conjunct local fix using the already-shipped
lastRenderPassId), alongside two MEDIUM text-level contradictions (Δ1's
dead zero-cost branch; Δ7's async discard note vs R8's synchronous
precondition). **REPAIRABLE** — no central mechanism is invalidated, every
fix is a rule change inside the architecture, but the blocker (with K3
pinned) must land before this is implementation-ready.
