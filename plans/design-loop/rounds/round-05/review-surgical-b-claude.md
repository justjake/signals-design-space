# Review — round-5 design-surgical-b (Claude, adversarial correctness)

Design under review: `rounds/round-05/design-surgical-b.md`, which incorporates
`rounds/round-04/synthesis.md` as normative base, which in turn incorporates
`rounds/round-04/design-consolidate-a.md`. All three read as one design; no
other round-5 artifact, review, or judge text was read.

Method followed: re-walk of the docket schedules (S5-R1-A, S5-R12-A, R2/R3/
R4/R8/R9 rewalks), attack on every by-construction claim in the two
replacements, seam enumeration between the amended mechanisms (EB0 vs the K0
fast path; EBr→c vs the fixup pipeline; basis state vs §15/R8 lifecycle),
lifecycle audit of every stamp the amendment consumes, and cost check against
`research-facts.md` and the design's own gate ledger.

---

## Findings (most severe first)

### F1 — BLOCKER (local fix): the evaluator basis for K0-served values is unconstructed state; the amended fixup fast-out is unsound (or self-rejectingly expensive) exactly where S5-R1 rule 3 needs it

**The defect.** S5-R1 defines `B0(n)` as the K0 cached value's "existing
flattened evaluator basis" and `B_r(n, w_r) := B0(n) when it served K0`. But
in the inherited design the flattened evaluator vector exists **only on world
memos and suspense prefixes** (consolidate-a §8 S3, §8.2 step 2, §9.2; I31/I40
govern memo/prefix validity). The K0 cache is the donor kernel's cache; no
inherited mechanism records, stores, merges, renumbers, or reclaims a
per-K0-node evaluator vector. S5-R1-A's own step 4 writes one
("K0 becomes CT with B0(ra)={(ra,r1)}") — no mechanism in the design performs
that write. Simultaneously the design asserts "Added state: none", "no bit,
clock, walk, or cache is added", "no allocation and no new stored word", and
rule 3's retention clause says the rendered basis survives "under the
inherited pass-owned memo lifetime; this adds no watcher field" — but the
pass-owned lifetime (R7 allocation lists) covers records **allocated during
render**, and a K0 fast-path serve allocates nothing. The retention clause is
vacuous in precisely the case its own sentence names ("B0(n) when it served
K0").

**Failing schedule (the false fast-out horn — implementation reads B0 at
fixup time because nothing retained the rendered basis).** Setup: stageable
shared `useComputed` node `m`, committed evaluator r0 (value v0); its owner
hook lives on root A (cross-root sharing is sanctioned — synthesis Part II
rejected the owner-root restriction). Root B mounts fresh watcher W over `m`.
Zero signal receipts anywhere (the transition on A is React-state-only).

```text
step | actor/mechanism | state touched
1 | root-B pass P starts (pin q); renders fresh W reading m | touched(m)==0, CT(m), EB0: effectiveStamp(m,P)=r0 == B0(m)=r0 → K0 FAST-PATH serve v0; no world memo exists; W not yet subscribed; P yields
2 | root A transition stages r1 (deps change) and commits; F9 promotes r1 (promotedAt=sA>q) | P2′ dirties K0 m; P3′ value-blind walk from m — W is unmounted, unreachable; no touched bits minted (no receipts)
3 | any NEWEST read on A (effect/handler/next render) pulls m | K0 recomputes under r1 → v1; CT(m) true again; B0(m) := {(m, r1)}
4 | P resumes; commits; W's layout fixup runs | structural fast-out: touched(m)==0 ✓, CT(m) ✓, ¬fastPathDisabled ✓, EBr→c: B_r read as B0(m)-now = {(m,r1)}; effectiveStamp(m, committedForRoot(B, now)) = latest committed = r1 → MATCH → RETURN
5 | steady state | W's committed DOM shows v0; committed-for-root(B) truth for m is v1 (latest committed evaluator). Any other B-watcher of m was corrected by P3′; W was not.
outcome: torn committed frame on root B, indefinitely (quiet app): no receipt exists to drive R4 drains; the P3′ walk ran pre-subscription; the fixup — the design's own "final w_fx compare" that "a version change in the render-to-subscribe window must reach" — was skipped by its own fast-out.
```

This directly breaks the S5-R12 construction's third case ("Step for an
evaluator promotion before subscription: S5-R1 makes the rendered evaluator
basis fail EBr→c, so the structural fast-out cannot hide it") — that argument
requires `B_r` = the basis **at render time** (r0), which exists only if
something snapshots it at serve time. The design's own mount-interaction walk
(R1 section, step 1) quietly assumes the render went through a **world memo**
("world memo records evaluator basis r0"); the fast-path-served mount has no
memo, and that is the normal case for a quiet cone.

**The other horn.** If the implementation instead treats a K0-served render
as conservatively failing EBr→c (no retained basis → cannot verify), then
**every** quiet mount (touched==0 ∧ CT — today's zero-work case) falls
through to the always-fold of S5-R12 step 3. The 10k-quiet-mount case then
pays 10k committed-world folds that the inherited design and the W2/P1
ledger price at zero; the design pre-authorizes no fallback ("Gate failure
rejects this final design"). So as written the amendment is either unsound
(horn 1) or plausibly self-rejecting on its own gate (horn 2).

**Judgment: local fix, not architectural.** The architecture already has the
right shape: record the flattened basis at every LOGGED K0 evaluation
epilogue (the epilogue already exists for taint), and capture the rendered
basis stamps (or a cheap monotone guard, e.g. a render-time
committedAdvanceSeq capture in `w_r`, which unlike the deleted commit-time
baseline is captured on the correct side of the window) in the watcher's
rendered-world snapshot — exactly how R5 added `fastPathDisabled` to `w_r`.
But that is new state: the "Added state: none" framing must be withdrawn, and
the state needs §15 rows, renumber duty (see F2), and G-Q/G-W pricing (see
F4). Until the basis's own construction is written, both S5-R1 rule 3 and
S5-R12's partition argument are by-construction claims resting on an
unconstructed structure — a blocker by the loop's own rule.

### F2 — HIGH (local fix; consequence of F1's denial): basis stamp fields are absent from the §15 ledger and the R8 renumber duty list — "an omitted seq-bearing field is fatal" by the design's own standard

Evaluator stamps are minted from `++globalSeq` (consolidate-a §11.1 case 4),
so every stored `(e, stamp)` pair — K0-side B0 vectors, and any retained
rendered basis under F1's fix — is a seq-bearing field. The design's R8 duty
list ends with "all other fields declared on the inherited §15 sequence
ledger", and its own residual risk row says "an omitted seq-bearing field is
fatal; … schema CI asserts rewrite coverage." Because the design denies the
basis state exists, it is declared nowhere, so the schema sweep cannot cover
it and the rewrite will skip it.

Failing schedule: populate B0 vectors under useComputed traffic; force the
small horizon (R8); WIP passes are discarded, retained seqs rewritten
compactly, epoch bumped — K0 caches and their B0 vectors survive (they are
not worldKey-keyed). Stored raw stamps (e.g. 500) now compare against
rewritten committed stamps (e.g. 3): every EB0/EBr→c on the affected cones
mismatches → permanent world-routing of the whole stageable cone for the rest
of the process (K0 fast path dead; P1/P3 silently degrade). I attempted the
worse horn — a later fresh mint re-reaching the stale raw value (counters
restart above the rewritten max and count up) and falsely matching — and
could not convert it into a wrong value: promotion's P2′ dirty plus donor
shallow-stale re-validation forces either a recompute (basis refreshed) or a
proven-equal value at every serve I could construct, and R8's
discard-WIP-first step kills any retained rendered basis across the horizon.
So this lands as a lifecycle-discipline violation with a measurable
degraded-mode observable, not a proven tear — but it is exactly the C13/I8/
I19 class the loop treats as load-bearing, and it is automatically repaired
by admitting the state in F1's fix (one duty-list row + one §15 row).

### F3 — MEDIUM (local fix): exact-stamp routing with no value escape creates permanent fast-path-loss classes the cost section does not enumerate

Two schedules, both correctness-safe (over-routing only), both permanent
until an unrelated event:

1. **Cutoff-preserved parents.** `p` consumes stageable `c` (committed f0,
   stamp0). f1 promoted; K0 recomputes `c` equal (cutoff) → `p` revalidates
   CT with its old cache and basis pair (c, stamp0), and is never dirtied
   again. Every pass pinned ≥ the promotion now fails EB0(p) forever
   (stamp0 ≠ stamp1) and world-routes `p` and everything above it, even
   though the served values are provably identical. `p` recovers only if
   some future write happens to dirty it.
2. **Reducer atoms after receiptless promotion.** P3′ re-folds NEWEST only
   "for a ReducerAtom with pending receipts". A reducer promoted with an
   empty tape keeps B0(ra)={(ra, r0)} while effectiveStamp resolves r1 for
   all new worlds → every read world-routes until the next dispatch happens
   to re-fold and re-stamp.

The cost bullet prices only the probe ("linear in the already-flattened
evaluator prefix") and charges G-Q/SPK-G8; it does not name this steady-state
routing-loss class, and the quiet-React gate it feeds is already measured AT
RISK (2.4–3.8% vs ≤2%, G1/O19). Fix is a rule choice, e.g. refresh basis
pairs during shallow-stale revalidation when the child proved equal, and
re-stamp reducer bases at every promotion; either is local. Name it in the
ledger either way.

### F4 — MEDIUM (cost honesty): the recording half of the basis is an unpriced hot-path obligation

Given F1's fix, every LOGGED K0 NEWEST evaluation of a stageable-reachable
node must record its own pair and merge child vectors. Flattened vectors on
a depth-D useComputed chain store and merge O(D) pairs per node (O(D²)
aggregate), on the recompute path the donor kernel keeps closed, monomorphic,
and bytecode-budgeted; the inherited design pays flattening only on world
evaluations (priced in G-E/SPK-G8 prefix rows). No G-W/G-Q row covers K0-side
maintenance, and "no allocation and no new stored word" denies the cost
exists. DIRECT is genuinely untouched (P2 safe); the exposure is P3/G-Q and
G-W. Local fix: a ledger row plus a spike row (the machinery is the same
family SPK-G8 already measures).

### F5 — NOTE: "Equality records the current basis and returns" has no home

S5-R12 step 4 records "the current basis" on equality — the only candidate
holder is the watcher record ("adds no watcher field" says otherwise), and no
later consumer of that record is named (R4 drains compare values, not bases;
fixup runs once per mount). Either delete the clause or let it land naturally
as part of F1's watcher-snapshot fix.

---

## Verified held (attacked and survived)

1. **S5-R1-A read-path repair.** Re-walked steps 1–6 independently: with EB0
   gating every K0 return, the resumed pass at step 5 mismatches
   (r0 vs cached r1 basis) and world-routes; the committed frame is uniform;
   the queued P3′ publication delivery renders both siblings under r1. The
   judge's R1 leak is closed at the read path — conditional on F1's state
   actually existing.
2. **EB0's flattening completeness (rule-2 "one rule" claim).** I attempted
   branch-hidden divergence: `n = flag ? m : b` with staged `m` and no
   receipts — the world evaluation cannot reach `m` without a receipt on
   `flag`, whose bit gates the fast path; with the branch driven by a
   stageable selector, the selector's own pair is in B0(n) and mismatches.
   The first-divergence argument transfers to evaluators: the first divergent
   consumed node is on K0's recorded path and its pair (or its vector,
   flattened) is present. No counter-schedule found. This also quietly closes
   an inherited residue: the old `¬stagedFor(n, pass)` probe was per-node and
   did not refuse K0 serves of *downstream consumers* of a staged node
   (R3's restart re-serves the same stale K0 value on retry, so the restart
   alone did not fix routing); EB0's merged pairs do. The amendment is
   strictly stronger than what it replaces.
3. **S5-R12-A kill and repair.** Re-derived the old comparator's tautology
   independently (baseline captured after the in-window retirement and after
   this commit's own lock-in → equality proves nothing about the render);
   confirmed touched(c)≠0 defeats the structural fast-out and the retired
   token defeats the loop, so 6a's indefinite tear is real. The always-fold
   repair corrects it pre-paint. Deletion vindicated.
4. **A second independent kill of the deleted baseline.** Error-abandoned
   staging subtree: W renders under staged r1 (world memo), the staging hook
   is error-abandoned so F9 never promotes; cas/lockViewId never move, so the
   old baseline fast-out would return with W's DOM showing never-committed
   r1 output — stale indefinitely. The S5 fixup catches it (EBr→c fails:
   staged stamp vs committed r0; always-fold compares committed r0 value).
   The deletion is load-bearing, not just cost-neutral.
5. **Always-fold cannot false-fire on C9 own-pass mounts.** F3 lock-in
   precedes layout and watermark = committing pass pin (I25, fork test 33),
   so at the mounting pass's own commit, committedForRoot's lock clause
   admits exactly the render's mask-clause prefix; post-pin same-token writes
   are excluded from both sides (and handled by the R6 loop → interleaved
   restart). Equality holds by purity; no double render, no torn pending
   batch. I25 is load-bearing here; flag it if anyone ever weakens it.
6. **R2 pass-aware suppression.** Re-walked including the
   completed-uncommitted pass (fork test 32 supplies the pre-commit restart)
   and the lock-view-only pass (it does not consume the pending lane update,
   so the scheduled work survives and suppression stays sound). Held.
7. **R3 seeding and A/B/A.** Re-walked; contradiction write-through plus
   seed-latest restart terminates in two restarts; F9-only-at-commit makes
   the "tentative publication" horn vacuous. Held.
8. **R4 late-edge drain.** Re-walked b-codex-3's shape: retention keeps D's
   bit alive across the pin, the edge-add flows it, and the lock advance that
   first commits the combined value reconciles W pre-paint. Held.
9. **R8 discard-first horizon.** Re-walked with a live pin and a WIP F9
   stage id; discard-all-WIP closes both horns before rewrite; ordering is
   strictly monotone on the retained set. Held — except the undeclared-field
   exposure in F2.
10. **R9 fold identity vs S5-R1.** Ladder order (evaluator vector before
    clock/fold-memo serve) is preserved by rule 4; reference installation at
    watermark=pin unaffected. Held.
11. **RENDER_NEWEST without EB0.** Promotion demotes open RENDER_NEWEST
    passes (P2′) and NEWEST pulls re-validate values under the latest
    committed evaluator, so the missing EB0 check on RENDER_NEWEST serves is
    sound. Attempted stale-serve schedule failed on CT.
12. **Untracked reads of stageable computeds.** A K0 cache embedding a
    committed-at-eval-time evaluator's output through an untracked read shows
    later worlds temporal staleness only (K0 never evaluates under stages;
    promotion-embedded values were committed when embedded) — within I33's
    license, unchanged by the amendment.

## Scars/invariants check

No scar is repeated: the fixup loop stays value-blind (S10), delivery stays
value-blind (S14/S16), the routing gate is per-node exact (not S37's coarse
gate), retention and ¬fastPathDisabled conjuncts are preserved (I39/I51),
the skip bound stays per-clause (I52), and the always-fold is the
I18-mandated committed-compare made unconditional. No measured fact in
`research-facts.md` is contradicted; the design's unmeasured claims are
routed to gates — except the F3/F4 omissions above.

## Verdict

The two repairs aim at the right mechanisms and the R12 deletion is
independently over-determined (two distinct kills of the old comparator),
but S5-R1 rule 3 and the S5-R12 partition construction both rest on an
evaluator-basis structure for K0-served values that the inherited design
does not contain and this design refuses to admit adding, which yields a
concrete indefinitely-torn committed frame (F1) plus ledger and cost gaps
(F2–F4) — all repairable by admitting, constructing, and pricing that state
inside the existing snapshot/epilogue machinery. No architectural mechanism
is invalidated: the fix is a rule-and-state amendment of the same kind as
R5's `fastPathDisabled` capture, not a new walk, clock, or kernel. Verdict:
**repairable** — one blocker (F1), one high (F2), two medium (F3, F4), one
note (F5); not implementation-ready as written, and nowhere architecturally
unsound.
