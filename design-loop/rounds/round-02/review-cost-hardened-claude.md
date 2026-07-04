# Review — design-cost-hardened.md (round 2) — CLAUDE reviewer

Scope note: per the reviewer protocol I did not read the round-1 champion,
other round-2 designs, or prior reviews. Sections marked `[=]` were judged
as restated *in this document*; where a restated pointer is itself
load-bearing and contradicted by a delta, that is a finding, not a benefit
of the doubt. Line numbers reference design-cost-hardened.md.

---

## Findings (most severe first)

### CH-1 — BLOCKER — Frontier prune strands stale suppressions on same-slot repeat writes: torn committed frame from two writes in one transition

**Mechanisms defeated:** H2 delivered-frontier pruning (§9.1 pseudocode,
§9.2 soundness claim) × H3 evaluate-cutoff suppression (§9.3). The §9.2
parenthetical claims "a same-slot *later write* must re-check suppressed
nodes — that is why suppression refuses the stamp: the walk re-reaches it."
The walk does NOT re-reach it: the prune fires at the nearest **stamped
ancestor** — including the written atom itself — and the design's own C4
walk (line 942: "prune at a") confirms watcherless atoms are stamped and
prune-eligible at the walk root. Refusing the stamp at the suppressed node
is useless if descent never gets there.

**Failing schedule.** `c = (a >= 2)`, committed `a=0`, `c=false`;
`watcherCount(c) ≥ F₈` (cutoff on; the design's own soundness battery
forces F₈=1, so this is also the tested configuration). One transition k,
one sibling component reading `a.state` directly:

```
step | mechanism | state
1 | k: a.set(1) §4.1 | tape(a)+={1,k,s1}; wc[k]=s1
2 | notifyWalk(a,k) §9.1 | a: no watchers → delivered trivially → DM(a)|=k, DE(a)=E1; descend to c: cutoff §9.3: v=worldMemoRead(c,{k})=false == all lastRendered(false) → SUPPRESS: SUP(c)|=k, no stamp, no descent, NO setState
3 | k: a.set(2) (same scope, no render between) | tape+={2,k,s2}; wc[k]=s2
4 | notifyWalk(a,k) | pop a: DM(a)∋k ∧ DE(a)=E1 ≥ rearmEra[k]=E0 (no watcher ever re-armed for k) → PRUNE at a → stack empty, walk ends. c never visited; cutoff never re-evaluated; SUP(c) stale
5 | k renders | sibling reading a: TS(a)∋k → world path → 2 ✓; W (on c) has no pending update in k's lane → not rendered; c's k-world value is now true, W's DOM says false
6 | k commits | committed frame: sibling shows a=2, W shows c=false where c=(a>=2) — TORN COMMITTED FRAME
7 | k retires | retirement revocation pass over touchedList[k] (§12 suppressedMask row) finally revokes → urgent correction ONE FRAME LATE — the exact S2 kill signature ("corrected one frame late"); the reconcile backstop §10.3 firing is design-declared a bug
```

**Why the design's own proof misses it:** §9.2's case analysis covers
watchers below the *pruned* node being delivered-or-re-armed, and covers
"a pruned ancestor cannot hide a suppressed descendant" only for the
*descendants of the suppressed node* (never delivered, so never expected).
The suppressed node itself sits below a stamped ancestor; no case covers
it. Note the design's cost model *already knows the sound behavior*:
§13.2/G-C prices "suppressed nodes re-run the cutoff eval per write" — but
the §9.1 pseudocode makes that re-run unreachable (the prune kills the walk
above the suppressed node), and §9.2's W1 costing ("writes 2–100 walk 1
node each") celebrates exactly the pruning that makes suppression unsound.
The pseudocode and the gate table describe two different algorithms; the
priced one has no mechanism.

Same root cause defeats revocation witness (a) for cross-slot suppression:
§9.3 soundness leans on "another slot j's walk … arriving at n (it must —
reach induction/M)"; a j-walk pruned at a j-stamped ancestor of n does not
arrive, so a k-suppression whose equality basis was broken by a j-write is
also stranded (needs j previously delivered through the ancestor, W
re-armed for j — composes with CH-2's era bug or plain j-repeat-writes).

**Judgment:** local fix, but it must be *designed*, not patched: e.g.
enroll suppressed nodes in a per-slot suppressed set re-checked on every
same-slot write (this is literally what G-C already budgets: one shared
ladder/clock recheck per write), with the §13.2 suppressedSeq fallback as
its cheap form; or veto pruning at any node with a nonzero suppressedMask
in its subcone (needs a summary bit — new mechanism either way). Until
specified, C5's family (same-atom repeat writes, not just the walked
different-atom variant) fails above F₈.

### CH-2 — BLOCKER — deliveredEra is one shared stamp per node; a later other-slot delivery masks a re-arm and the prune eats a needed k-lane notification

**Mechanisms defeated:** H2 pruning (§4 concepts, §9.1) vs per-slot
re-arm. `deliveredMask` is per-slot (bit k) but `deliveredEra(n)` is a
single int32 per node (line 289; line 541 stamps `deliveredEra[n] =
eraCounter` on ANY slot's delivery; G-M's ≤24B/node budget confirms one
column, not 32). The prune test `deliveredEra[n] >= rearmEra[slot]`
therefore compares slot k's re-arm against *whichever slot delivered
last*. §9.2's soundness case (b) — "re-armed after the stamp — then
rearmEra[k] > deliveredEra[n]" — is false when another slot's walk
overwrote the stamp after k's re-arm.

**Failing schedule.** Watcher W on `c = f(a)`, watcherCount < F₈ (no
suppression involved — pure delivery). Two overlapping transitions k, j
both writing `a`; k is an async action (F8) so its second write lands
post-await, or simply a held transition writing across frames (W1's own
shape):

```
1 | k: a.set(1); walk k | delivers W in k's ctx (NM(W)={k}); stamps DM(a,c)|=k, DE(a)=DE(c)=E1
2 | React renders W in a k-including pass; pass yields (F2) | re-arm: NM(W) k-bit cleared; rearmEra[k]=E2
3 | j: a.set(9); walk j | DM j-bits clear → deliver W in j's ctx; DM(a,c)|={k,j}; DE(a)=DE(c)=E3 (shared stamp overwritten)
4 | k (continuation): a.set(3); walk k | pop a: DM(a)∋k ∧ DE(a)=E3 ≥ rearmEra[k]=E2 → PRUNE at the root. Walk ends. (Had j not walked, DE=E1 < E2 → delivery — the design's C1 step 6 case.)
5 | k's pass resumes/completes with W's already-rendered f(1) output; no new setState in k's lane exists to force a fresh k pass | k commits: committed tree carries c=f(1) while k's world says f(3); any sibling reading a in k shows 3 → torn commit; at best stale-by-one-frame corrected post-retirement
```

**Judgment:** local fix with a real cost decision: per-(node, slot) era
truth is 32 int32 columns (breaks G-M's 24B/node budget — must be
re-priced), or store `(era, lastSlot)` and prune only when `lastSlot ==
k` (sound — a same-slot stamp newer than the re-arm implies delivery
happened after re-arm; degrades prune efficacy under interleaved slots,
which is exactly the multi-transition case W1's numbers were sold on), or
clear DM bit k for the touched cone at re-arm via touchedList[k] (a
clearing sweep — RJ6 rejected walks, but a list sweep is O(touched)).
Pick one, re-price G-W(steady), re-walk C4-extended.

### CH-3 — BLOCKER — Quiescence + optional globalSeq reset: memos and atom fold caches on untouched (TS=0) nodes survive, and the §8.2 window inverts under reset — stale world value validates in the new episode (C13 fails on its own forced path)

**Mechanisms defeated:** §12 lifecycle table (globalSeq row, maskId row) ×
§8.2 validity predicate × §7.3(d) quiescence-via-lists. Quiescence work is
"O(touched) via lists" (line 809–810); memo death is "memos die with their
nodes' chains" / "chains dropped with nodes at quiescence" (lines 801,
1040) — the only enumeration quiescence has is the touched-list union, and
memo-bearing nodes with `touchedSlots = 0` are on no list. Such nodes are
ordinary: C9(b) fresh `useComputed` nodes world-evaluated (¬CT forces the
world path) whose deps the live transitions never wrote, and any atom
world-read but unwritten (`foldAtom` cache, §8.1). Their memos survive
quiescence. Then the C13 walk's own step — "quiesce → optional small reset
→ stale memos unreachable" — is false, and the §8.2 guards collapse:

- **Row 1 passes falsely:** new-episode seqs are small. Memo foldPin=900
  (old line), new pass pin p=7, new in-mask write at wc[s]=5:
  `5 ≤ min(900, 7) = 7` ✓ — a genuinely included write is invisible to the
  clock check. (This is I8's exact schedule: "seq reset vs surviving
  memos".)
- **Row 2 goes vacuous:** window = `(min(900,7), max(900,7)] = (7, 900]`;
  every new-episode retirement has retireSeq < 7 → outside the window →
  never consulted. Old-episode ring entries inside the window that predate
  the memo's foldPin don't exist by construction; a same-slot recycle only
  helps if its retirement seq landed inside `(7,900]` — the k1 retirement
  at sr=950 > foldPin=900 is outside and catches nothing.
- **Key collision:** the maskId intern table resets (line 801), so a new
  episode's `(deferredMask, ∅)` interns to the same small integer as a dead
  episode's — the memo key matches a semantically different world; and
  `maskId(∅,∅)` is the same id in every episode with no reset needed.

**Failing schedule.** Ep1: transition k1 (slot 3) writes x; a component
mounts `useComputed n` over atom d (untouched); mount pass world-evaluates
n → M(n, maskId{slot3}) = {v_old, foldPin 900}, TS(n)=0, n on no list. k1
retires (sr=950); quiescence; optional reset (the same path the O13
saturation guard *forces* at wrap, and the path C13's forced-small builds
drive). Ep2: transition k2 re-interned on slot 3 (same maskId int),
`k2: d.set(9)` at seq 5 (wc[3]=5), k2's pass at pin 7 reads n → row 1
passes (5 ≤ 7), row 2 vacuous, fnVersion matches → **stale v_old served as
k2's world value of n; k2 renders and commits f(d)-without-d's-write** —
wrong committed value. The atom variant needs no mask at all: surviving
foldAtom(d, maskId∅) + an ep2 urgent write-and-retire at seq 3 < pin 7 →
window (7,900] blind → urgent in-pass read of d serves the last episode's
value — torn urgent frame.

**Judgment:** local fix, but it must be enumerated per C13's own rule
("name it per structure"): a per-episode registry of memo-bearing node ids
(append at first memo/fold-cache mint; sweep = drop all memo chains at
quiescence — O(memo'd nodes), preserving the O(touched)-class bound), or
an episode-epoch conjunct in every §8.2 check, or never-reused maskId
integers plus a foldPin-vs-episode-floor comparison. As written, the §12
guard column for globalSeq names "kills memos (era in ring goes stale)"
with no mechanism that reaches these memos, and the "epoch-free by
construction" cell for maskId interns is an unaccompanied by-construction
claim for exactly the structures the reset orphans.

### CH-4 — HIGH — The C3 ‡H5 note describes out-of-order compaction (fold s2 into base under a live older s1): replay arithmetic becomes 3-not-4 and 6-not-5; the order-gating rule the walk needs is stated nowhere in this document

**Mechanisms defeated:** Δ5b baseSeq stamping × §5's fold/compaction
restatement × C3. Line 934–935: "U's retirement compaction stamps
baseSeq(a)=s2-fold" — i.e. at U's retirement, U's entry s2 (`×2`) is
folded into base while T's older unretired s1 (`+1`) is still pending
(T renders *after* U commits in C3's required order, so no T pin exists to
retain anything — "pin-retention compaction (C7)" (line 318) does not
fire). Once s2's op is absorbed into base=2, T's fold can only apply s1
over it: `2+1=3`, not the required `(1+1)×2=4`; the seed's plain-set
variant commits 6, not 5. Functional ops do not commute; a fold basis that
has absorbed a *later* op is unreconstructible. The design's own C3 walk
claims "2, 2, 4, 4; plain-set 5" — those numbers are unreachable from the
mechanisms as restated here. (I verified C16's Δ5b usage separately: the
*version* rule `max(baseSeq, newest-visible)` is timing-robust because the
visible clause covers unfolded retired entries — the defect is confined to
the *value* fold, which makes the note's "no B1 collapse" demonstration
moot: at U's retirement nothing on `a` may legally compact.)

**Failing schedule:** C3 verbatim, implemented per Δ5b + the ‡H5 note:
committed value 3 (or 6 in the plain-set case) — lost-write class, on the
battery's parity case.

**Judgment:** local fix (one rule + one corrected note): retirement
compaction folds only the maximal seq-prefix of retired entries per atom
— blocked at the first unretired entry — and baseSeq stamps only what
actually folded; re-walk C3 and re-time the B1 example (baseSeq(a) stamps
at T's retirement, not U's). Flagged HIGH rather than BLOCKER only because
the inherited `[=]` "seq-order folds (I2/C3)" plausibly contains the
correct rule and the new note mis-restates it — but as this document
stands, an implementer produces wrong committed values.

### CH-5 — HIGH — Retirement-fold vs layout-effect ordering is load-bearing for I18/C9/C10 and never specified; each of the two possible orderings breaks one of the design's own walks

**Mechanisms defeated:** §10.2 mount fixup (I18 unconditional compare) ×
F3 retirement emission × §5 fold timing. The C10 race row (line 1010)
requires fold-effects *visible at layout* ("I18 compare: committed version
MOVED (k folded)"); a mount committing inside k's own final pass (C9 with
k completing) requires the same, or the unconditional compare misfires.
Nothing in §11/F3 or §5 pins where retirement+fold land relative to the
committing pass's layout phase.

**Failing schedules.** (a) Fold after layout: C10's race — k retires in a
yield gap between W′'s render and the pass completion; at layout,
`runInBatch(k) → false` AND the I18 compare reads pre-fold committed ==
rendered → no-op → correction missed entirely until the §10.3 backstop
(design-declared bug) — stale committed frame for at least one paint.
(b) Fold after layout, mount inside k's committing pass: liveDeferred
still ∋ k at layout → corrective scheduled into a token that is dying
this commit, plus the I18 compare sees committed-sans-k ≠ rendered-k-world
→ spurious *urgent* setState → W′ re-renders **backward** (pre-k values)
next to k's freshly committed tree, then forward again after the fold —
visible torn flicker at every mount-in-committing-transition. (c) Fold
before layout makes both walks hold — but that choice constrains F3's
emission point inside commitRoot and belongs in the protocol with a fork
test; the design's fork test list has no entry for it.

**Judgment:** local fix: state "retirement fold + ring append complete
before the committing root's layout effects run; committedForRoot at
layout includes just-retired batches," add fork test 15 pinning it, and
re-walk C9(final-pass)/C10(race).

### CH-6 — MEDIUM — Retire ring (R=64) with no foldPin re-stamp on serve: the design's own W3 workload (100 keystrokes over a 10s hold) overflows every surviving memo's window at interruption ~65 and fail-closes into exactly the mass re-fold cliff H5 claims deleted

**Mechanisms:** §8.2 row 2 window vs ring capacity × G-E. Windows are
`(min(foldPin,p), max(foldPin,p)]`; a memo folded early in k's hold keeps
its original foldPin, so each successive keystroke-commit widens the
window until it spans >64 retirements → "era gap beyond ring ⇒ invalid" →
every flagged-region memo re-folds — W3's cliff returns, merely delayed.
G-E as stated ("per interrupting commit … 0 re-folds for disjoint writes")
is false for the second half of the design's own showcase schedule; G7'
acknowledges the fail-closed path but does not connect it to W3.
**Fix (local, one sentence):** on every successful validation, re-stamp
`memo.foldPin = p` (and retireEra) — sound because the rows were just
checked over the entire old window, making serves slide the window; add a
>64-interruptions row to SPK-G8.

### CH-7 — MEDIUM — "Retirement runs the notification path" (Δ5c) is ambiguous between list iteration and a pruned/suppressible walk; the walk reading breaks C12 outright

**Mechanisms:** Δ5c (line 332–334) + §10.4 enqueue vs H2/H3 stamps. If the
retirement fold-walk is notifyWalk-shaped and honors the §9.1 prune:
store-only C12 — `k: a.set(5)` stamped DM(a-cone)|=k at write time,
no watcher ever re-arms (there are none) so rearmEra[k]=E0 → at
retirement the "walk" prunes at its root → affected signal-effects never
enqueued → the effect never observes 5 (no later trigger exists) —
I14's class, on a battery case whose walk (line 1029) asserts the
opposite. If instead "fold-walk seeded by touchedList[slot]" means pure
list iteration (touchedList[k] already IS the marked cone; no descent
needed), it is sound — and the prune/suppression columns must be declared
irrelevant to it. **Fix:** one sentence choosing the list reading and
exempting retirement/lock-in delivery, plus the C12 assertion in the
recycle battery.

### CH-8 — MEDIUM — §7.3(d)'s "quiescence zeroing is exact" is false for K1 records minted by world evaluations of untouched nodes; the O13-closure-by-deletion argument inherits a residual

**Mechanisms:** §7.3(d)/§7.4 k1Id lifecycle. A world eval of a fresh node
over deps carrying no slot bits records K1 edges while neither endpoint
ever enters a touched list (no 0→1 transition); quiescence zeroes k1Id
"over the union of lists" → these records survive with k1Id ≠ 0, so
"k1Id ≠ 0 now simply *means* minted this episode" is not established, and
K1's add-only-to-quiescence reclamation misses them (slow cross-episode
growth of never-reclaimed records; duplicate-edge handling on re-record is
unstated). Consequences I could construct are over-notification and
retention — the surviving stale edge actually *protects* correctness in
the CH-3 family by over-marking — so this is a false invariant claim plus
a leak, not a torn frame. **Fix:** the CH-3 memo registry doubles as the
enumeration (register world-eval'd node ids per episode; zero their k1Id
at quiescence), restoring the exactness claim O13's closure leans on.

### Notes (no schedule / monitor's desk)

- **N-1:** CH-2's obvious fix (per-slot eras) blows G-M's ≤24B/node cold
  budget (32×4B); the (era,lastSlot) variant preserves the budget but
  weakens the prune under interleaved transitions — SPK-N1's grid needs a
  two-slot-interleave row either way.
- **N-2:** G-Q's 2.4–3.8% measured floor vs P3's ≤2% is honestly flagged
  with a pre-registered renegotiation — correctly not asserted away; this
  is a requirements decision queued for the monitor, not a design defect.
- **N-3:** The W1 costing ("writes 2–100 walk 1 node each", §9.2) and the
  G-C gate ("suppressed nodes re-run the cutoff eval per write", §13.2)
  describe incompatible algorithms; whichever mechanism repairs CH-1 must
  also reconcile these two numbers before SPK-N1 is meaningful.

---

## Verified held (attacks attempted and failed)

1. **Pin-window lemma + pinless memo keys (§8.3):** attacked with slot
   reuse mid-episode (monotone seqs force row-1 failure), in-mask retired
   entries (retiredSeq > seq > pin cannot arise — I15's single line
   holds), post-pin memos (C7's f ≥ sr case correctly rejects via ring
   relevance), and C2's memo across D's later commit (ring row-2 bit set →
   re-fold). Held everywhere except under CH-3's reset path.
2. **Row-2 ring relevance via invariant M:** the "write predates the
   edge" bypass is closed by propagate-on-new-edge (§7.1 site 3) — the
   memo-minting eval's own edge-add flows the writer's bit before any
   serve can depend on it. Held.
3. **Mount-fixup narrowing (§10.2):** attacked via world-divergent-branch
   deps (I4 generalizes across world pairs by purity), receipts predating
   vs postdating the mount eval, and fresh nodes; the induction holds and
   the propagation-before-layout same-stack claim is coherent. Held
   modulo CH-5's ordering.
4. **Suppression × retirement:** same-slot retirement of a suppressing
   slot is an equality no-op (suppression implies k-value == committed);
   cross-slot relevant retirement revokes via touchedList[slot] iteration,
   which does not depend on walk arrival. Held (given CH-7 resolves to
   the list reading).
5. **Cutoff compare basis (RJ3):** per-world value vs per-watcher
   commit-recorded lastRendered dodges S8/S14 — C8's equal-write schedule
   delivers because the U-world fold diverges from rendered 0. Held.
6. **C7 yield/resume with pinless keys:** both directions (serve older
   memo across an interrupting commit; reject newer memo folded post-
   commit) walk correctly; the I15 two-pin discipline survives the key
   change. Held.
7. **Scar scan S1–S15:** no scar repeated as designed — always-log (S1/I1)
   kept urgent-inclusive; freshness conjunct (S9/I12) retained verbatim in
   invariant R; corrections reach-based not equality-filtered (S10/I13),
   with revocation-at-the-witness replacing mask enumeration; activation
   monotonic on bridge registration (S6); staging manifests + GEN
   discipline answer S15; D2 fold-on-abort kept (S4). CH-1/CH-2 damage
   the *witness delivery*, not the policy choices.
8. **F8 async attribution:** edge-triggered at React's own action-scope
   resume, differential-tested, loud degraded mode; raw-setTimeout escape
   matches React's own behavior. Rebase drill answer holds (library moves
   zero lines). Held.
9. **Propagation (§7.1):** termination and cost bound (each node gains
   each bit once per slot-generation) hold; queued in-render deliveries
   carry per-bit context (D10 preserved, fork test 14). Held.
10. **G-D by identity:** DIRECT = donor bytes with CI symbol check is the
    strongest possible P2/P3-DIRECT construction; nothing to attack.

---

## Verdict

The champion's inherited strata — tape/fold visibility math, invariant
M/R routing, the closed validity table with the pin-window lemma, the
fork protocol — survived every attack I could construct, and three of the
four cost repairs (dual build, touched-narrowed fixup, pinless validity)
are sound as designed. But both genuinely new mechanisms ship with seam
holes against the walk-as-witness discipline the rest of the design
relies on — the frontier prune silently eats same-slot re-deliveries
(shared era) and strands suppressions (stamped ancestors), producing torn
committed frames on two-write transitions, and the quiescence/reset story
cannot reach the memos it claims to kill — plus one delta note
mis-restates compaction into wrong C3 arithmetic. All five top findings
are rule-level repairs (per-slot era truth, a suppressed-set re-check the
gate table already prices, a memo mint-registry, one compaction sentence,
one commit-ordering sentence) that move no load-bearing champion
mechanism, so: **repairable** — not implementation-ready until CH-1
through CH-5 are re-specified and C3/C4-ext/C5-ext/C12/C13 re-walked.
