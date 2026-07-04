# Round 4 synthesis — the consolidated two-kernel design, repaired

Status: the round's single repaired final design. Base text: this document
**incorporates `rounds/round-04/design-consolidate-a.md` as normative base**
(it is self-contained, restating the whole champion) and amends it with the
repairs below. Every amended rule is given here as full replacement text;
everything not named carries from consolidate-a verbatim. Architecture class
unchanged (D8/D12): donor kernel K0 + receipt tape + world-edge plane K1 +
clocks/stamps + value-blind delivery + co-designed fork. Winner rationale and
transplants from consolidate-b are in Part II.

---

## Part I — Adjudication of every review finding

Twenty findings across four reviews. Equivalences collapse where two
reviewers found the same defect (marked ≡). Verdicts: 19 CONFIRMED,
0 REFUTED, 1 NEEDS-MEASUREMENT. No finding silently dropped.

| # | finding (design, reviewer) | verdict | resolution |
|---|---|---|---|
| 1 | a-claude F1 ≡ a-codex 1 — cross-root F9 promotion flips an open pass's effective evaluator; P3 rescue equality-gated on NEWEST (S14 class) | **CONFIRMED** (both reviewers; schedule re-derived — quote in R1) | Repair **R1**: evaluator versions on the pin line + value-blind publication walk + promotion demotes RENDER_NEWEST |
| 2 | a-codex 2 ≡ b-codex 2 — per-(watcher, slot) dedup suppresses the only setState for a post-pin same-slot write; watermark advance later exposes it → torn committed DOM, io-gated duration | **CONFIRMED** (cross-design; also present in the round-3 champion's identical rule — the base's C1 row 3 "that render reads fresh" is false when the pass pinned first) | Repair **R2**: pass-aware suppression rule |
| 3 | b-claude F1 ≡ b-codex 4 — stage gate is temporally incomplete: a tree-order-earlier consumer reads the stageable node before the owner hook stages → two evaluator worlds in one commit (S23 residue) | **CONFIRMED** (both reviewers of b; **also applies to consolidate-a** — its C1-X1 row 3 walks only siblings rendering *after* the staging hook; a sibling rendering before it takes the fast path or folds under the committed evaluator, then the owner stages: same tear. a's reviewers missed this; adjudicated confirmed for both) | Repair **R3**: lineage-seeded passStages + staging walk + interleaved restart |
| 4 | b-codex 3 — immediate slot release loses committed-observer delivery for a dependency edge discovered after the writer retired | **CONFIRMED**, and the class is cross-design: in consolidate-a the bits survive (retention) but §11.4's lock-in/advance drains reconcile **effects only**, so the same schedule tears from P's commit until the parked token's global retirement (walk in R4) | Repair **R4**: watcher reconcile joins every durable drain (retirement AND every lock-in/advance), with a closed drain-coverage construction |
| 5 | a-claude F2 — saturation force-clear erases the touched word the mount-fixup fast-out consumes → fixup skips the I18 compare for a fastPathDisabled pass → indefinitely stale committed DOM | **CONFIRMED** (schedule re-derived; §5.4's compensation list covers pass reads only, and §11.2's fast-out is a second consumer of the swept word) | Repair **R5**: fast-out gains the ¬fastPathDisabled conjunct (flag captured in w_r) |
| 6 | a-codex 4 — fixup skip predicate applies the render pin to lock-clause visibility; the true lock bound is the watermark → wrongly skipped entanglement | **CONFIRMED** (consolidate-b §7.2 has the same conflated bound) | Repair **R6**: per-clause visibility bound |
| 7 | a-claude F3 ≡ a-codex 3 — discarded fresh-node K0 arena records have no reclamation (SCAR S15 by omission) | **CONFIRMED** (both) | Repair **R7**: transplant consolidate-b's pass-owned allocation lists (with its generation invariant) |
| 8 | a-codex 5 — globalSeq has no live-episode rollover protocol (renumber is quiescence-only; forced-wrap with a live pin inverts ordering → torn frame) | **CONFIRMED** (spec gap; C13 demands the row) | Repair **R8**: live renumber = discard-WIP-first, then rewrite |
| 9 | b-codex 5 — b's live rewrite cannot rewrite stage ids already held inside React's WIP hooks | **CONFIRMED** against b's protocol as written. R8's discard-WIP-first step dissolves the class: after discard, no seq-bearing identity is held outside the library (F9 attachments die with their passes; lineage caches are library-side and rewritten) | Absorbed into **R8** |
| 10 | b-codex 1 — functional receipts yield no stable per-world value reference ("atoms fold directly"); `a.state !== a.state` within one render; reconcile ping-pong | **CONFIRMED** against b as written; consolidate-a is ambiguous (M(n, worldKey) never explicitly covers atom folds). The merged design states the rule | Repair **R9**: per-(atom, world) fold memos + committing-world reference installation |
| 11 | b-codex 6 — capsuleGen wrap while a stale thenable is still pending lets its settlement validate against the wrong capsule occupant | **CONFIRMED** (lifecycle class, I8/I19) | Repair **R10**: settlement validates the exact thenable reference (identity, not generation) |
| 12 | b-claude F2 — b's reconcile backstop is placed after retirement folds where "restart before commit" is impossible; self-contradictory | **CONFIRMED** against b. The merged design carries a's ordering (F9 → folds/lock-in → reconcile + effect flush → layout) and claims **no** post-fold restart anywhere: corrections are urgent pre-paint setStates; the only restart-shaped path is R3's queued own-lane update draining at yield/end, which rides React's native interleaved-update restart *before* commit (fork test 14) | Resolved by architecture choice + R3/R4 |
| 13 | b-claude F3 — b's cross-root publication consistency rests entirely on the F2-ambiguous backstop; owner-root check is subscription-grain and misses indirect reads | **CONFIRMED** against b. Dissolved in the merge: R1's pinned evaluator versions protect open cross-root passes structurally, and the value-blind publication walk delivers cross-root; b's owner-root restriction (§1.3) is **rejected** — a's unrestricted sharing model stands, so no read-grain check is needed | Resolved by R1 |
| 14 | b-claude F4 — `renderCycle` is a lifecycle-bearing counter missing from b's §11 table | **CONFIRMED** against b. Moot in the merge: renderCycle is not adopted; dedup state is a's per-(watcher, slot) bits, whose clear sites (render re-arm; slot-recycle/force-clear sweep via touchedList) get explicit §15 rows | Resolved by non-adoption + §15 rows (R11 lifecycle addenda) |
| 15 | b-claude F5 — "a root commit containing a reached token" effect trigger is ambiguous across roots; own-root reading leaves committed effects stale for io-gated durations | **CONFIRMED** against b. Merged design scopes publication delivery globally: the promotion walk is root-agnostic (R1), and R4's drains enumerate touchedLists regardless of the observing root | Resolved by R1 + R4 |
| 16 | a-claude F4 — C9's "zero extra work" fast-out rows contradict the design's own F3/F9-before-layout ordering (cas always moves by layout of the mounting pass's own commit); w_fx cost under-priced | **CONFIRMED** (arithmetic follows from §5.3's own step order; correctness unaffected, cost/spec defect) | Repair **R12**: commit-baseline comparator; C9 walk corrected; W2 workload row |
| 17 | a-claude F5 — K1 + E-PRESERVE have no growth bound when the app never quiesces | **CONFIRMED** as a declared-gap omission (unbounded memory / degrading walks, never a wrong value) | Repair **R13**: declared gap G9 + bounded mid-episode sweep (safe subset only) + new spike SPK-K1 |
| 18 | a-claude F6 — §5.1 conflates the monotone mark frontier with the value-blind notification walk; implemented as written, C4/C5 regress | **CONFIRMED** (text defect; the design's own §10.2/C4 walks show the intent) | Repair **R14**: normative split of the two traversals |
| 19 | a-claude F7 — G-W/G-N realism (full-cone per-write walk vs ≤2× gate); the pre-blessed D13 fallback is S17-adjacent and unwalked | **NEEDS-MEASUREMENT** — this is exactly SPK-W/SPK-N1 (queued, decision rules stand). New obligation recorded in OPEN: the per-slot-mark dedup fallback may not be adopted without its own walked schedule (S17 re-entry risk) | Spike queue + OPEN note |
| 20 | b-claude F1's livelock branch / b-codex 4 step 7 — "publication too early to survive restart" (B published though its hook never became current) | **CONFIRMED-as-written against b's §7.3-restart reading; vacuous under the merged protocol**: publication happens only at F9 emission inside a real commit; R3's restart fires pre-commit, before any publication exists. No tentative-publication state exists to roll back | Resolved by R3 (walked there) |

Where reviewers of one design disagreed (a-claude "repairable" vs a-codex
"architecturally unsound"; same split on b), the resolution is by walk, not
vote: every one of a-codex's five blockers re-derived as real (rows 1, 2, 7,
6, 8) **and** every one carries an in-architecture repair that reuses or
deletes machinery — the "unsound" verdicts rested on the absence of those
repairs, not on any defect in K0/tape/K1/visibility/seam, which all four
reviews' verified-held lists independently confirm.

---

## Part II — Architecture choice, transplants, and the rejected list

**Winner: consolidate-a's architecture.** Reasons, one line each:

- Its fine-grain routing keeps K0 serves available *during* traffic
  (touched(n)==0 elsewhere); b's coarse `receiptCount` gate routes **every**
  render read through world memos whenever any receipt exists — which is
  precisely when P1 (≤1.10× useState re-render) is measured — with no
  fallback by its own declaration (§13: "a failed numeric gate rejects the
  design"), and it deliberately re-accepts O18's restart-revalidation cost
  that S18 already scarred.
- b's central new math took the round's worst damage: the stage gate's
  temporal hole (row 3), no per-world value identity (row 10), late-edge
  committed-delivery loss enabled by immediate slot release (row 4), a
  self-contradictory backstop (row 12) — each in machinery b built to
  replace what it deleted.
- a's verified-held lists are broader on both reviews, and both a-reviews
  independently confirm the core (tape arithmetic, TAINT merge, saturation
  value-preservation, walk atomicity, lock views, carrier) survived attack.

**Transplants from consolidate-b** (mechanisms move only with their
invariants):

- **T1 — pass-owned allocation lists** (b §11): fresh arena nodes allocated
  during render belong to the pass; commit transfers to ordinary ownership;
  discard returns records after generation increment. Invariant carried:
  gen-increment-before-free-list-reuse; StrictMode mount/abandon cannot grow
  the plane unboundedly. (= repair R7.)
- **T2 — lockViewId as the sole lock-visibility version** (b §4.4/§2.2):
  per-(root, slot) lockStamp and per-atom lockTerm are **deleted**. I34's
  letter is still satisfied: every lock-in and every advance re-mints the
  immutable view and its id; the id sits in committed-for-root worldKeys
  (re-keying memos) and in every basis/snapshot header (forcing
  revalidation); value revalidation (I35) then keeps over-invalidation
  content-guarded. Consumers audited: committed-for-root memos (key),
  effect snapshots (header id + forced drain enumeration), suspense
  prefixes (header id; on mismatch → per-position value revalidation),
  fixup fast-out (id compare — already id-based). Atom fp drops the
  lockTerm term and keeps {newest visible seq, baseSeq, retireVisStamp,
  } — one O(1) record, no ≤31-entry scan. Root-scoping (I34) is preserved
  by construction (per-root ids).
- **T3 — `ActionScope.runSync` deleted** (b §2.1): set/dispatch are D17's
  sanctioned escape; runSync re-enters ambient carrier state for opaque
  callbacks and adds misuse surface with no walked need.
- **T4 — fork test additions**: b's tests 6 (discard cannot later commit),
  7 (same-root urgent commit discards an older yielded pass before F9/lock
  publication), 8 (stable root ids; portals report parent), 14 (updates
  inserted after completed work force restart before commit), 21 (watermark
  = committing pass pin) merge into the base's fork list (renumbered §14
  list: 29–33). Root identity is specified inside F2/F3 (pass and commit
  carry a generation-checked rootId), not as a new fact.

**REJECTED from consolidate-b** (one line each, with the killing evidence):

- The coarse `receiptCount` read gate: unpriced always-world-path cliff
  during any traffic (its own §13 declares no fallback), plus rows 3/10 hit
  its replacement math; the deletion of fine-grain routing is what forced
  it. (Performance-shape rejection + confirmed blockers.)
- Immediate slot release + effects-only advance drains: row 4's schedule.
  Retention (I10/I39) + saturation stays.
- Hook-time-only stage gating (`passStages` populated at hook run): row 3.
  Replaced by R3, which b's own claude reviewer sketched.
- The §7.3 restart-after-folds reconcile backstop: row 12 (self-contradictory).
- Owner-root restriction on stageable nodes: subscription-grain hole (row
  13) and needless API restriction once R1 lands.
- `renderCycle` dedup keying: row 14; a's bits + explicit clear rows suffice.
- Live renumber without discarding WIP first: row 9.
- "Atoms fold directly" (no per-world fold identity): row 10.
- lockViewId-in-fp-only *without* value revalidation would be rejected, but
  b paired it with I35 correctly — transplanted as T2.

**REJECTED from consolidate-a** (superseded by repairs):

- Live-sampled committed evaluator as a pass's fold authority ("else
  committed", unpinned) — row 1; replaced by pinned versions (R1).
- P3's equality-gated promotion notification ("if the value moved") — row
  1's second horn, an S14-class canonical gate on cross-world notification;
  replaced by an unconditional value-blind publication walk (R1).
- The unconditional fixup fast-out `touched==0 ∧ CT → return` — row 5; one
  conjunct added (R5).
- The single-bound fixup skip `s ∈ mask∪LV ∧ wc[s] ≤ pin` — row 6 (R6).
- The claim "delivery: dedup already set AND W's render still pending →
  that render reads fresh" (C1 row 3, C5) — row 2; true only when no pass
  has pinned yet; replaced by R2's rule.
- lockStamp/lockTerm — superseded by T2 (state deletion, same guarantees).
- Quiescence-only renumbering as the *only* counter protocol — row 8 (R8).

---

## Part III — The repairs (normative replacement text + constructions)

### R1 — Evaluator visibility is pin-scoped; promotion delivery is value-blind

*(Repairs row 1; amends base §2 "evaluator/effStamp", §5.2 fold rule, §8.2
ladder step 2, §11.1 P2/P3, §5.1 demotion.)*

**Rule (replaces "staged-in-this-pass else committed").** The committed
evaluator of a stageable node is a **pin-gated version chain**
`{fn, deps, stamp, promotedAtSeq}`, exactly analogous to tape entries:

- `effStamp(e, world)` = the stage in this pass's `passStages` if present;
  else the committed version with the greatest `promotedAtSeq ≤ world.pin`
  (pass worlds); NEWEST and committed-for-root worlds resolve at "now"
  (greatest promotedAtSeq). One extra compare in the common case: chains
  have length 1 whenever no promotion raced a live pin.
- **Retention**: a superseded version (next version promoted at seq q) is
  reclaimable when `min(live pins) ≥ q` — the tape-compaction discipline
  verbatim. Renumber rewrites promotedAtSeq (§15 row).
- Memo ladder step 2 and suspense prefix checks compare against
  `effStamp(e, world)` — i.e. against the *pin-resolved* version, so a memo
  recorded under r0 stays servable to a pass pinned before r1's promotion.

**Promotion (replaces P2/P3):** at F9 emission (unchanged edge, I41),
ordered before the same commit's folds and layout (I38c):

- P1′: append the staged {fn, deps, stamp — installed unchanged, I40} as a
  new committed version with `promotedAtSeq = ++globalSeq`; bump
  committedAdvanceSeq.
- P2′: dirty the K0 node (donor invalidate — shallow-stales the K0
  downstream cone, so CT refuses fast-path serves of stale dependents);
  **demote every open RENDER_NEWEST pass** to its captured (mask, pin) —
  the same global demotion the first receipt-creating write performs
  (§5.1); promotion moves NEWEST itself, so RENDER_NEWEST's premise dies
  with it.
- P3′: **unconditionally** (value-blind, D13 — no NEWEST equality gate) run
  the ordinary notification walk from the promoted node in the committing
  context: watcher setStates (React assigns the committing batch's lanes;
  cross-root watchers get scheduled on their own roots), effect enqueues,
  per-(watcher, slot) dedup as usual. For a ReducerAtom with pending
  receipts, re-fold K0 NEWEST under the new committed reducer first
  (ordinary fold, stepwise equality) so post-walk NEWEST reads are current.
- P4: unchanged (publicationsComplete reclaims unpublished stages).

**Re-walk of the killing schedule** (a-codex 1's; a-claude F1's is the same
shape): shared ReducerAtom `ra`, receipts X:inc, Y:dec; r0 = ±1, r1 = ±10;
NEWEST 0 under both.

```
1 | root B pass P_B (mask {X}, pin q) reads ra | effStamp = version-at-q = r0 → B1 renders 1; P_B yields
2 | root A commits, staging r1 | P1′ appends version {r1, promotedAt=sA > q}; P2′ dirties K0 + demotes RENDER_NEWEST passes; P3′ re-folds NEWEST under r1 (0 — equal, reference kept) and walks VALUE-BLIND anyway: B1's watcher gets setState in the committing context → follow-up render scheduled for root B
3 | P_B resumes; sibling B2 reads ra | effStamp(ra, w_B) = version-at-q = r0 (pin rule) → fold {X} under r0 → 1. Memo recorded under r0-stamp still validates (ladder compares pin-resolved stamps). ONE pass, ONE reducer.
4 | P_B commits | frame uniformly r0 (B1=1, B2=1) — internally consistent; committed-for-root(B) evaluations use latest r1 but the P3′ delivery already scheduled B's corrective render
5 | B's follow-up render (pin > sA) | folds under r1 → B1=B2=10 → commits; per-root self-consistency held at every commit; cross-root skew transient and scheduled (C11's declared scope)
outcome: no torn frame at any commit; no canonical equality gate anywhere on the notification path (S14 respected); computed-evaluator promotions take the same P3′ walk (the base's "P2-only" hole closed).
residual: version-chain retention priced (≈ tape discipline); forced test: promotion during a yielded cross-root pass (new fork/battery row); reclamation row in §15.
```

Interaction audit: C1-X1 rows unchanged except row 6 (now P1′–P3′; discard
variant unchanged); C3-R/C3-M unchanged arithmetic, "if the value moved"
deleted (walk always runs — the walk is value-blind; reconcile checks
remain value-compared, legal per I35); w_fx evaluator clause unchanged
(committed-latest at fixup time — the fixup compares committed-side truth);
suspense retries pin per-pass → a promotion between retries re-keys
effStamps only if the retry's pin admits it, and the retry's staged reuse
(I40) still compares equal.

### R2 — Pass-aware delivery suppression (dedup repair)

*(Repairs row 2; amends base §5.1 step 5, §10.1, C1 row 3, C5.)*

**Rule.** Delivery reaching watcher W in slot s with the (W, s) dedup bit
already set is **suppressed iff no started-and-uncommitted pass on
root(W) includes s with pin < the write's seq**. Otherwise deliver anyway
(the bit stays set; React receives the setState as an interleaved update
and schedules a follow-up render for s's lanes with a fresh pin). The root
registry already holds each root's active pass frame (F2 passStart →
passEnd(commit|discard)); the check is one load + two compares, only on
the suppressed path.

**Construction (why this is exactly sufficient).** The bit means "a
setState for (W, s) is scheduled and unconsumed". Suppression is sound iff
the scheduled work will fold the new write. Scheduled-but-unstarted work
captures its pin at future passStart ≥ seq → covered → suppress.
Started work has pin frozen < seq → not covered → deliver; React's
interleaved-update handling (fork test 14 semantics) guarantees a
follow-up render at a pin ≥ seq before or after the current pass commits,
and that render re-renders W (a fiber with pending lanes never bails).
Discarded passes restart with a fresh pin ≥ seq → the original suppression
of pre-start writes stays sound. Over-delivery is impossible to make
unsound (delivery is value-blind, D13); under-delivery is now excluded by
the case split. ∎

**Re-walk of the killing schedule** (a-codex 2 ≡ b-codex 2):

```
1 | T writes a=1 @s1 | deliver setState(W) in T; bit (W,T) set
2 | T pass P starts (pin p ≥ s1), yields before W renders | root registry: activePass(root(W)) = {mask ∋ T, pin p}
3 | carried continuation writes a=2 @s2 > p | walk reaches W; bit set → CHECK: active pass includes T with pin p < s2 → DELIVER. React queues an interleaved T-lane update for W
4 | P resumes; W renders a=1 (pin p); commits; watermark → p | internally consistent commit; W's bit re-arms at render; the s2 update is still queued (React kept it — it postdates P's pin)
5 | React schedules the follow-up T render (pin p2 ≥ s2) | W re-renders a=2; that commit advances the watermark to p2 WITH W's update — no bail-out, no tear
outcome: the watermark can never advance past a write W was not scheduled for; useReducer parity (React produces the same two commits).
residual: one registry check per suppressed delivery (G-Q ledger row); forced test: yield-gap same-slot write with a pinned pass (this schedule).
```

C4 unchanged (different slots, different bits). C5 re-walked: both writes
in one event burst precede any pass → no active pass → suppression as
before (the design's original efficiency claim, now correctly conditioned).
C1 row 3's justification is replaced by this rule (in that walk the k-pass
is open with pin < s2 → deliver; the k render at row 4 runs at p2 ≥ s2 —
the walk's stated outcome was already correct, its reason was not).

### R3 — Stage visibility is pass-scoped from pass start (S23 temporal hole)

*(Repairs rows 3 and 20; amends base §11.1 staging, §6.2 probe; applies to
both designs' hole.)*

**Rules:**

1. **Seeding.** At F2 passStart(lineage L), `passStages` is seeded from L's
   lineage stage cache (every current noncommitted record). A retry/replay
   therefore world-routes stageable nodes from its first read, before any
   hook runs. Seeding a nonempty set prevents RENDER_NEWEST classification
   (equivalently: demotes at start).
2. **Hook authority.** Hook selection (base cases 1–4, committed-first per
   L4) is authoritative. If the selection contradicts the seeded entry
   (deps returned to committed while the seed staged E1), the lineage cache
   is written through (current := committed) and the contradiction is a
   *stage-set change* (rule 3).
3. **Staging walk.** Any mid-pass stage-set change for node n (first mint,
   lineage adoption absent from the seed, or a rule-2 contradiction) runs
   the ordinary value-blind notification walk from n with delivery
   *filtered to watchers whose lastRenderPassId equals this pass* and
   *queued to the pass's yield/end drain in the pass's own token context*
   (the same drain edge-add deliveries already use). Watchers that already
   rendered n-derived output in this pass thereby get an own-lane update →
   React's interleaved-update restart (fork test 14) re-runs the pass
   before commit → the restart is seeded (rule 1) → all consumers fold
   under the same stage. Consumers that have not rendered yet need nothing
   (their reads see the stage via the probe). `lastRenderPassId` is one int
   stamped at the existing dedup re-arm site.

**Coverage construction.** A consumer that observed n's pre-stage value in
pass P is either (i) a watcher of n — reached by the walk from n directly;
or (ii) a watcher of some m whose evaluation (this pass or cached) consumed
n — then an edge n→m exists in K0 (newest-basis read) or K1 (world-eval
read, recorded at evaluation), so the walk reaches m's watchers; the
pass-filter delivers exactly those that rendered in P. Both link orders are
covered because the walk runs at stage time, after any such evaluation
recorded its edges. Termination: each restart moves the seed to the hook's
latest selection; a pass whose hook selections match its seed triggers no
walk; per-attempt oscillation requires impure render deps and lands in
React's own update-depth limits. ∎

**Re-walk of the killing schedule** (b-claude F1; the same schedule aimed
at consolidate-a):

```
setup | S before O in tree order; O owns n (committed f_A); S subscribes to n; zero receipts
1 | transition: setDep(1); pass P renders S | seed: lineage cache empty → no stage → S serves K0 f_A value (v_A); S.lastRenderPassId := P
2 | P renders O | deps [1]≠[0] → mint E1{f_B}, stage, update lineage cache → STAGE-SET CHANGE → walk from n, filter lastRenderPassId==P → S qualifies → queue setState(S) in t to the yield/end drain
3 | drain at P's next yield/end (pre-commit) | React records an interleaved t-update for S → P restarts before commit (test 14)
4 | restart P′ | seed from lineage cache: {n: E1} → S's read routes world path under f_B (v_B); O reuses E1 (case 3, same stamp — I40); no walk (no change)
5 | P′ commits | one frame, one evaluator (f_B); F9 publishes E1 (first and only publication — no tentative state existed pre-commit, so row 20's "too early" horn is vacuous)
6 | oscillation A→B→A across attempts | attempt 2's hook computes deps=A == committed → rule 2: write-through, contradiction → walk (S rendered f_B) → restart → attempt 3 seeds empty → uniform f_A. Two restarts, adversarial-only, terminating.
7 | StrictMode double invoke | second invoke hits case 2 (pass frame) — no change, no walk; discard+replay hits the seed — idempotent (C14 preserved)
outcome: no commit ever mixes evaluator worlds; restarts are pre-commit (b-claude F2's contradiction cannot arise — nothing restarts after folds).
residual: restart frequency = first-staging-after-earlier-consumer-render, priced in G-F/W2; lastRenderPassId store (1 int/watcher render, G-Q row).
```

### R4 — Committed-observer reconcile at every durable drain

*(Repairs rows 4 and 15; amends base §5.3 step 4, §11.4.)*

**Rule.** The durable committed-observer flush — enumerate
touchedList[slot], reconcile-check watchers (compare lastRendered against
committed-for-root(root(W)) *now*; urgent pre-paint setState on real
difference), re-validate effect snapshots — runs at **every retirement AND
every per-root lock-in/watermark advance** (the base ran watcher reconcile
at retirement only; advances flushed effects only). It runs inside the
committing commit's reconcile phase (after folds/lock-in, before layout —
§5.3 step order), so corrections flush in the sync lane before paint:
C10's sanctioned fallback shape, never a visible tear.

**Closed drain-coverage construction.** Committed-for-root visibility flips
only at retirements and lock-ins/advances (I14/I34), i.e. always at a drain
of the flipping token t. Claim: any watcher-node n whose
committed-for-root fold changes at t's flip is in touchedList[t] by drain
time. The change requires n's committed evaluation to read some atom x
holding a flipping t-entry. If the path x→…→n existed at t's write, the
write walk appended n (and its watchers). If it was created later by an
evaluation, edge-add propagation flowed t's bit through the new edge and
appended to touchedList[t] — possible whenever touched(x) still carries
t's bit, which retention guarantees while t is live or retired-unswept
(I10/I39). A fully-retired-and-swept t has no future flips (entries
compacted ⇒ universally visible; lock records cleared ⇒ no advances), and
saturation force-clear only targets fully-retired slots — so no flip can
postdate the loss of t's bits. Mid-render edge-adds flow bits at the
yield/end drain, which precedes the pass's own commit drain. ∎

**Re-walk of the killing schedule** (b-codex 3, run against the merged
design with retention):

```
setup | c = flag ? a : b; W mounted on c; K0: flag→c, b→c
1 | parked K writes flag=true @s1 | walk flag→c→W: deliver W in K; touchedList[K] ∋ {flag, c, W}
2 | K pass P (pin p) starts, yields | —
3 | gap: store-only default D writes a=1 @s2 | no edge from a → marks only a; touchedList[D] = {a}
4 | D retires | drain touchedList[D]: no watcher on a; committed c unchanged (flag still false → b-path) → correctly quiet. Entries pin-blocked (retiredSeq > p) → slot unswept, bits retained
5 | P resumes; evaluates c in w_P | fold flag=true, a in-world = 0 (D excluded) → c=0 CORRECT for w_P; K1 records a→c; edge-add flows D's retained retired-unswept bit → touched(c) ∋ D, c appended to touchedList[D] (no delivery — D not live; I23 unchanged)
6 | P commits; K locks in at watermark p | committed-for-root now folds flag=true (locked) + a=1 (retired) → c=1. THE ADVANCE DRAIN (new): enumerate touchedList[K] ∋ W → reconcile: lastRendered 0 ≠ committed 1 → urgent setState pre-paint → W re-renders 1 before paint
outcome: the root never paints a frame contradicting its own committed world; the correction is the I18-mandated fallback at the exact flip that created the divergence — not io-gated (the base's gap: nothing until K's global retirement).
residual: advance-drain cost = touchedList[advanced slot] reconciles per advancing commit, value-compared (memo-served folds) — G-R ledger row + SPK-R workload.
```

### R5 — Fixup fast-out learns about saturation

*(Repairs row 5; amends base §11.2 line 1.)* The watcher's rendered-world
snapshot w_r additionally captures `fastPathDisabled` (one bit at render).
Fast-out rule: `if touched(n) == 0 ∧ CT(n) ∧ ¬w_r.fastPathDisabled:
return`. When the flag is set, fall through to the per-token loop and the
committed-side check (whose cas/lockViewId fast-out and w_fx compare are
exactly the machinery that catches the swept-bits case). Re-walk of
a-claude F2's schedule: step 5 now falls through → per-token loop (storm
slots retired → none; T_A included → skip) → cas moved → w_fx folds the
retired storm entries → v_fx ≠ v_r → urgent pre-paint correction. ✓
C1-X5 gains row 9 (mount during spillover). TAINT-only fast-out
(r == bit-31-only, cas unmoved) remains sound (unchanged from base).

### R6 — Fixup skip bound is per-clause

*(Repairs row 6; amends base §11.2 loop.)* Skip live token t (slot s) iff
`wc[s] ≤ max(s ∈ w_r.mask ? w_r.pin : −1, s ∈ w_r.LV ?
w_r.LV[s].watermark : −1)` — the maximum visibility the rendered world's
clauses actually granted. Re-walk of a-codex 4's schedule: T locked at
watermark p1, wc[T] = s2 > p1, T ∉ mask → bound = p1 < s2 → no skip →
`runInBatch(T, setStateW)` → T's next render includes W → one commit; the
later watermark advance carries W's update (and R4 backstops the race). ✓
C9(a) unchanged (own-pass mount: s ∈ mask, wc ≤ pin → skip).

### R7 — Pass-owned allocation lists (transplant T1)

*(Repairs row 7.)* Fresh K0 nodes, K1 records, memos, and capsules
allocated during a render belong to the allocating pass's allocation list.
Commit transfers them to ordinary ownership; discard/lineage-death returns
them to free lists after generation increment (stale ids reject
everywhere ids are consumed — the base's existing generation discipline).
§15 gains the row; C14 gains a mount-evaluate-abandon soak test (S15's
schedule, now with a named reclamation protocol). Walk delta for C9(b)/C14:
allocation rows note pass ownership; no behavioral change on the commit
path.

### R8 — Live renumber protocol (counter horizon with live episode)

*(Repairs rows 8 and 9; amends base §5.5, §15.)* globalSeq carries an
explicit horizon H (forced small in tests). At a mint that would cross H,
at the current operation boundary (never inside a walk/eval/fold — the
frame guards already exist):

1. Fork discards every WIP pass (F2 discard; React restarts them later —
   always legal). Publication attachments die with their passes
   (publicationsComplete sweep); after this step **no seq-bearing identity
   exists outside the library** — the fact that dissolves b-codex 5:
   externally-held stage ids live only on WIP hooks.
2. Order-preserving rewrite of every retained seq per the §15 renumber duty
   list (tape seqs/retiredSeqs, baseSeq, wc, stamps, promotedAtSeq, memo
   seqs, prefix fps, lastWalk sweep, lineage-cache stamps, watcher
   snapshots' pins/cas captures); parked tokens' receipts rewrite like any
   others (token serials are a separate counter, unchanged).
3. Epoch bump in every worldKey (pre-rewrite memos/capsules die by key —
   over-invalidation, safe); counters restart above the rewritten range.

Live pins are impossible at step 2 (all passes discarded), so a-codex 5's
inversion cannot arise; the pause is bounded (one sweep of retained
records) and its frequency is once per H mints. C13 gains the
forced-small-horizon-with-live-pass row; the never-quiescent diagnostic
throw is deleted (superseded by this protocol).

### R9 — Per-(atom, world) fold identity

*(Repairs row 10; amends base §5.2/§6.2 and states what the base left
implicit.)* Atom folds in non-NEWEST worlds are memoized per (atom,
worldKey) in the same memo plane as computeds (value + fp + visible-prefix
seq); every read in one world serves one reference. Revalidation is the
ladder's cheap checks (wc, fp); a re-fold applies stepwise equality against
the memo's accumulator (I29). Committed installation: a retirement or
lock-in whose visible prefix equals a committing world's memoized prefix
installs **that memo's reference** as the committed value (prefix equality
holds by I25: watermark = committing pass pin); store-only retirements
fold once, fresh. Consequences walked: within one render `a.state ===
a.state` always; useReducer parity for committed references (React commits
the rendering pass's object, not a re-fold — C3 rows keep their exact
values and gain reference annotations); reconcile/effect compares see
stable references, so codex-b 1's correction ping-pong is unrepresentable;
updater re-invocation across *different* worlds producing fresh references
is React's own rebase behavior (C3 replays), unchanged. w_fx folds reuse
committed-for-root memos for the retired/locked clauses, so mount-fixup
compares are reference-stable except for atoms with live included updater
receipts — where the per-token loop, not the compare, is the corrector
(bounded over-correction noted in G-F).

### R10 — Capsule settlement validates thenable identity

*(Repairs row 11.)* A settlement callback mutates its capsule iff the
settling thenable **is** (reference identity) the capsule's current
thenable. capsuleGen remains for suffix-drop bookkeeping but is no longer
a settlement guard; references cannot wrap. One-line rule + forced test
(2-bit gen, five in-flight refetches, out-of-order settlement).

### R11 — Lifecycle addenda (rows 14 and general C13 hygiene)

New/updated §15 rows: evaluator version chains (mint at promotion; observed
by folds/ladder/prefixes; reclaimed pin-gated; renumber rewrites);
lastRenderPassId (stamped at render; observed by staging walk; cleared at
unmount; pass ids generation-checked); pass allocation lists (R7); watcher
dedup words (cleared at render re-arm AND swept at slot recycle/force-clear
via touchedList — made explicit); commit-baseline capture (R12); capsule
current-thenable ref (R10). renderCycle: not adopted (row 14 moot).

### R12 — Commit-baseline fast-out + corrected C9 arithmetic

*(Repairs row 16.)* At F3 lock-in (pre-layout), the root registry captures
`commitBaseline = {cas, lockViewId}`. The fixup's committed-side fast-out
compares against the baseline: `if cas == baseline.cas ∧ root.lockViewId ==
baseline.lockViewId: return` — own-commit advances no longer defeat the
fast-out, so in-pass mounts are again O(loop) with zero w_fx evaluations
(the base's C9 rows 3/6 corrected: row 3's comparator is the baseline, row
6's "fast-out fails" applies only to motion *after* this commit's own
lock-in — e.g. cross-root traffic in the window). Correctness unchanged
(the fast-out only skips an evaluation whose compare provably matches:
v_fx over the baseline visibility = v_r by the base's own held
construction). W2 workload gains "10k mounts inside a committing
transition" and "mount storm under cross-root commit traffic" rows.

### R13 — K1 growth honesty

*(Repairs row 17.)* New declared gap **G9**: K1 and E-PRESERVE mirrors are
add-only until quiescence; never-quiescent apps grow K1 without bound
(memory + walk-cost degradation; never a wrong value). Bounded mid-episode
sweep (normative, safe subset only): a K1 record is collectible when (a)
its recording epoch's world memos are all dead (worldKey-unreachable) AND
(b) neither endpoint holds a committed watcher or effect-dep snapshot
(the quiescence refresh-set predicate, reused mid-episode) AND (c) the
record carries no retained touched bits for live-or-unswept slots. Sweep
runs at operation boundaries under a budget. Residual growth is SPK-K1
(below); the R4 coverage construction is unaffected (collectible records
by (c) carry no future-flip obligations).

### R14 — The two traversals, split normatively

*(Repairs row 18; amends base §5.1 steps 4–5.)* Step 4a (marking): monotone
frontier `newBits & ~touched(n)` propagates slot/taint bits and appends to
touchedList — self-terminating, no walkGen, stops at already-bitted nodes.
Step 4b (delivery): the **full** value-blind walk over K0∪K1 with walkGen,
visiting every record once regardless of bits, delivering per R2's rule
with per-(watcher, slot) dedup. Both run per write, in the writer's stack;
neither ever substitutes for the other (I5: marks gate routing, never
delivery). §10.2's "retirement notification" phrasing corrected: retirement
and advance drains enumerate touchedList (I34), never re-walk.

---

## Part IV — Battery disposition (full re-walk against the repaired design)

Every case re-checked; walks below either carry from the base **verbatim
(re-verified against all repairs)** or are amended as noted. No case is
unwalked; C11 remains full-spanning scope; C17 remains discharged by
deletion.

| case | disposition |
|---|---|
| C1 core, V2–V7 | Carry, with row-3 justification replaced by R2 (outcome unchanged); V6 gains renumber-live cross-check (R8) |
| C1-X1 (staged evaluator) | Amended: row 6 = P1′–P3′; new row 8: cross-root promotion during this pass's yield → pin rule serves the old version; new row 9: tree-order-earlier consumer → R3 walk/restart (the row a's reviewers missed) |
| C1-X2 (union cycle) | Carry (walkGen untouched; R14 makes the full-walk reading normative) |
| C1-X3 (taint) | Carry verbatim (no repair touches taint; re-verified rows 5–8 against R2/R4 — no interaction) |
| C1-X4 (pinned retention) | Carry |
| C1-X5 (saturation) | Amended: new row 9 — mount during spillover: w_r captures fastPathDisabled → fixup falls through (R5) → w_fx corrects |
| C2, C2-M | Carry (single write per slot before any pass → R2 degenerate; C2-M unchanged under R6 — D ∉ mask∪LV) |
| C3, C3-E | Carry + R9 reference annotations (committed value = committing render's reference) |
| C3-R | Amended: P3′ walk unconditional (no equality gate); fold-before-publication still unrepresentable (fork test 23) |
| C3-M | Amended: row 4 — B's pinned passes fold under version-at-pin (no r0/r1 mix *within* any pass, now by construction, closing a-claude F1's exact quote); row 5 unchanged (vector catches cross-root staleness at "now"-scoped worlds); row 6 carries |
| C4 | Carry (R2: different slots — bit check never consults the pass rule across slots) |
| C5 | Amended: outcome unchanged; justification now R2's case split (burst-before-pass → suppress; post-pin → deliver) |
| C6, C7, C7-D | Carry (C7-D demotion now also fires on promotion — consistent, R1) |
| C8 | Carry |
| C9 | Amended: rows 2–3 use R6's per-clause bound and R12's baseline comparator ("zero extra work" restored honestly); rows 6–7 carry; new row 8: saturated-pass mount (R5) |
| C10, C10-R | Carry (races (i)/(ii) re-verified; R4's advance drain adds a second net under race (i)) |
| C11, C11-W | Carry (T2: lockTerm deleted — visibility unchanged; fp keeps retireVisStamp; committed-for-root re-keying via lockViewId carries the I21/I34 load) |
| C11-A | Amended: row 1/5 — effect snapshot revalidation triggered by header lockViewId mismatch + forced drain (no lockTerm); row Y carries (F2 serialization); new row: the advance drain reconciles watchers (R4) — walked in R4 |
| C12, -U, -T, -F | Carry (carrier untouched; runSync deleted — no walk used it; ActionScope.set/dispatch remain) |
| C13 | Amended: rows for version chains, lastRenderPassId, allocation lists, commit baseline, thenable identity (R11); renumber section replaced by R8's live protocol + forced live-horizon test |
| C14 | Amended: row 5 gains the R3 seed (replays converge without re-walks); new row 7: discarded-mount arena reclamation (R7 soak); rows 1–4, 6 carry |
| C15 | Carry + row 5⁗: out-of-order settlement of a superseded thenable is inert (R10 identity check); effStamp resolution via pin-resolved versions re-verified stable across retries (I40 + R1 install-unchanged) |
| C16, C16-D, B1 | Carry; R4 strengthens B1 (advances now reconcile watchers too); cas pre-filter still never suppresses a moved-fp re-run |
| C17 | Carry (deletion + API snapshot test) |
| T8-N | Carry; quiescence additionally sweeps superseded evaluator versions (no live pins ⇒ all reclaimable) — added to the renumber duty list |

New named schedules pinned as regression tests: R1's cross-root promotion
walk, R2's yield-gap same-slot write, R3's earlier-consumer staging (+
A/B/A oscillation), R4's late-edge lock-in walk (b-codex 3's), R5's
storm-saturated mount (a-claude F2's), R6's watermark-bound mount (a-codex
4's), R8's forced live horizon, R10's out-of-order settlement.

---

## Part V — Mechanism inventory (9) and the state ledger

Counting rule unchanged (structures with state and lifecycle). The
inventory stays at **9** — every repair reuses an existing structure's
discipline or deletes state:

1. **K0 donor kernel + twin builds** [+ pass-owned allocation lists (R7) —
   allocator substrate]
2. **Receipt tape + fold semantics** [+ per-(atom, world) fold identity
   (R9) rides the memo plane; committed-reference installation]
3. **Token/slot/mask/pin + immutable lock views** [lockStamp/lockTerm
   DELETED (T2); lockViewId is the sole lock version]
4. **K1 + touched word + walks** [delivery gains R2's pass check; R14
   splits marking/delivery normatively; mid-episode sweep (R13)]
5. **World memos + suspense capsules, closed validity** [atom folds
   first-class (R9); settlement identity check (R10)]
6. **Evaluator staging + F9 + promotion** [pin-gated version chain, seeded
   passStages, staging walk, value-blind publication walk (R1/R3)]
7. **Watcher/binding records** [fixup: per-clause bound (R6), saturation
   conjunct (R5), baseline fast-out (R12); reconcile at every drain (R4);
   lastRenderPassId]
8. **Fork/build protocol F1–F9 + carrier** [runSync deleted (T3); test
   list merged (T4)]
9. **Episode lifecycle** [live renumber protocol (R8); G9 + sweep (R13)]

State-item ledger this round: deleted — standalone WORLD_TAINT column
(base L1), fixup suppression predicate (base L2), duplicate reducerStamp
(L3), MessagePort shim (L5), lastRetireSeq (L6→cas), lockStamp + lockTerm
(T2), ActionScope.runSync (T3), renderCycle (never adopted), the
never-quiescent diagnostic throw (R8). Added — evaluator version chain
(pin-gated, usually length 1), lastRenderPassId (one int/watcher),
commitBaseline (two ints/root), pass allocation lists (R7), capsule
thenable ref (R10). Net: the compensation stack shrank where the judge
flagged accretion and grew only where four confirmed torn-frame schedules
demanded state that mostly already existed in adjacent form.

## Part VI — Seam

Fork facts F1–F9 unchanged in count and shape; amendments: F2/F3 carry a
generation-checked rootId on pass/commit records (was implicit in the root
registry); F3's ordering clause now names the advance drain (R4) between
folds and layout; F4 unchanged (RETIRED return already specified); F9
unchanged (R1 is library-side). Fork test list: base 1–28 plus merged
29 (discard cannot later commit), 30 (same-root urgent commit discards an
older yielded pass before F9/lock publication), 31 (stable root ids;
portals report parent), 32 (updates inserted after completed work force a
pre-commit restart — load-bearing for R2/R3), 33 (watermark equals the
committing pass pin — load-bearing for R9's reference installation).
Rebase drill answer unchanged: tokens, pass edges, retirement/lock edges,
runInBatch, lineage ids, publication ids — all re-implementable facts; the
library moves zero lines.

## Part VII — Gates and spikes (amendments only)

- G-Q ledger adds: R2 registry check (suppressed path only), R3
  lastRenderPassId store (per watcher render), R1 version resolution (one
  compare; chain >1 only while a promotion outlives a pin).
- G-F: R12 restores the in-pass-mount zero-eval claim (baseline
  comparator); adds W2 rows (10k in-commit mounts; cross-root commit
  traffic); notes R9's bounded over-correction for live-updater atoms.
- G-R/SPK-R adds the R4 advance-drain reconcile cost (touchedList ∩
  watchers per advancing commit) and R1's promotion walk.
- SPK-W adds the staging-walk frequency row (R3 restarts).
- **New spike SPK-K1** (from row 17): K1/E-PRESERVE growth under
  never-quiescent traffic with the R13 sweep enabled. Decision rule:
  steady-state K1 growth unbounded after sweep (>1 MB/hour on the soak
  workload) or walk-cost degradation >5% over 24h-equivalent → promote the
  sweep's predicate (b) to include sampled reachability collection, else
  G9 stands as documented.
- Row 19 (a-claude F7) stays NEEDS-MEASUREMENT under SPK-W/SPK-N1 with the
  recorded obligation: the D13 per-slot-mark fallback requires its own
  walked schedule before adoption.

## One page: the story that ships (amended paragraphs only)

**Evaluators are world-scoped state (I22) — now on the pin line.** A
hook's fn/deps/reducer stages per pass with lineage-stable stamps (I40);
the fork's F9 publishes at hook-becomes-current (I41), before that
commit's folds. Committed evaluators form a pin-gated version chain:
a pass folds under the version its pin admits, exactly as it folds
receipts — so a promotion on any root never changes an open pass's world
(the round's first blocker, dead by construction). Promotion delivers
value-blind through the ordinary walk; stages are visible from pass start
via lineage seeding, and a stage minted after an earlier consumer already
rendered triggers that consumer's own-lane update, riding React's native
pre-commit restart (the round's S23 residue, dead).

**Notification is per-write, in the writer's stack, value-blind
(D5/D10/D13)** — and dedup is pass-aware: a set bit suppresses only writes
the scheduled render will actually fold (pin comparison against the
watcher root's active pass); anything later delivers again and rides
React's interleaved-update machinery (the round's second cross-design
blocker, dead). Committed truth moves only at retirements and per-root
lock-ins/advances, and **every** such flip drains its slot's durable
touched list through the watcher reconcile and effect revalidation — so a
dependency discovered after its writer retired still corrects before
paint (the round's third cross-design blocker, dead).

Everything else — always-log receipts with React's visibility math, the
taint bit riding the touched word, K1's real world edges, per-slot clocks,
immutable lock views (now versioned by id alone), saturation spillover,
the twin-build carrier, the co-designed nine-fact fork — carries from
consolidate-a unchanged, with its walks.

---

*Synthesis complete. Verdicts: 19 confirmed / 0 refuted / 1
needs-measurement. Winner: consolidate-a's architecture with four
consolidate-b transplants (allocation lists, lockViewId-only lock
versioning, runSync deletion, fork-test merge) and repairs R1–R14. 9
mechanisms. Spikes: SPK-L, SPK-N1, SPK-G8, SPK-W, SPK-R, SP2, SPK-K1
(new).*
