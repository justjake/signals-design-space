# Review — consolidate-a (round 4) — Claude reviewer

Design: `rounds/round-04/design-consolidate-a.md`. Method: full battery
re-walk (C1–C17 + T8-N + the design's own X-members), counter-schedule
attack on every written construction (§6.3, §6.4, §10.2, §11.2, §12.1,
compaction prefix rule, F2 serialization), seam enumeration over mechanism
pairs sharing state, lifecycle audit against §15, fork/cost honesty checks.
Findings ranked most-severe first. Every finding names a schedule and the
mechanisms it defeats.

---

## F1 — BLOCKER — Pass worlds have no evaluator pin: a cross-root F9
promotion mid-yield flips an open pass's effective reducer, and the P3
rescue walk is equality-gated on NEWEST (an S14-class canonical gate)

**Mechanisms defeated:** §5.2 fold rule ("reducer ops fold under the
world's effective reducer — staged-in-this-pass else committed") × §8.2
ladder step 2 (vector compared against *current* effStamps) × §11.1 P2/P3
promotion. The pass pin freezes receipts (visibility) but nothing freezes
the *committed evaluator* a pass folds under; "committed" is sampled live
at every fold and every memo check.

**Failing schedule** (all inside the design's declared scope: C11 full
multi-root spanning + R3/D16 hook-staged reducers on a shared ReducerAtom):

Setup: module-level ReducerAtom `ra`, base 0. Committed reducer r0:
`INC → s+1`, `DOUBLE → s*2`. Root B renders `useReducerAtom(ra, r1)` where
r1: `INC → s+2`, `DOUBLE → s` (adversarial but legal user code — reducers
are arbitrary functions). Root A components read `ra` (plain reads, no
reducer hook, so nothing is staged in A's passes).

1. Transition T_A on root A: `ra.dispatch(INC)` — receipt appended; pass
   P_A (mask {T_A}, pin p) starts rendering; component W renders,
   evaluates `ra` in w_A under effStamp = committed r0 → fold(0, INC) =
   **1**; memo/vector records (ra-reducer, r0-stamp). P_A yields.
2. Yield gap: urgent U dispatches `DOUBLE`; U commits and retires
   (retiredSeq > p, so P_A's world still excludes it — correct). NEWEST
   under r0 = (0+1)×2 = **2**.
3. Root B's pass (deps changed) stages r1 and **commits**. F9 promotion:
   committed reducer := r1 (stamp installed), K0 dirtied, cas bump. P3:
   `ra` has pending receipts → re-fold K0 NEWEST under r1:
   r1(r1(0,INC)=2, DOUBLE)=**2** — *equal* to the old NEWEST 2 → stepwise
   equality keeps the old reference → **"if the value moved" is false →
   no notification walk, no reconcile, no effect flush**.
4. P_A resumes (F2 permits it: the commit was on root B, and B's lock-view
   re-mint touches nothing P_A consults). Sibling component X reads `ra`
   (or a computed over it): ladder step 2 — current effStamp(ra) =
   staged-in-P_A? none → **committed = r1** ≠ recorded r0 → refuse →
   re-fold in w_A under r1: r1(0, INC) = **2**.
5. P_A completes and commits: **one committed frame where W shows 1 and X
   shows 2 for the same logical world** — a torn committed frame. Nothing
   repairs it: no receipt was created in the window, P3's walk was
   suppressed by the NEWEST equality gate, and both components committed
   inside P_A's own commit.

**Why the design's own text hand-waves exactly here:** C3-M row 4 claims
"no r0/r1 mix" but walks only *commits* (which serialize); C11-A row Y
claims "Cross-root advances shown irrelevant to a captured view" — true
for lock views (root-scoped by construction), **false for promotions,
which the design itself calls "global-committed state" (C3-M row 4)**.
The F2 serialization fact protects passes only from *same-root* commits;
promotion is the one committed-side advance that is global. Note also that
even when the P3 walk *does* fire (NEWEST moved), the rescue is indirect —
it relies on the committing-context setState producing an urgent same-root-A
commit that kills P_A before it resumes; and for **computed** evaluator
promotions there is no P3 walk at all (P2 only dirties K0), so any
cross-root-shared hook-created computed tears with no rescue path even
attempted. Gating a cross-world-relevant notification on canonical (NEWEST)
value movement is the S14 scar class ("a canonical-only gate must never
guard cross-world notification").

**Judgment: local fix** (does not invalidate K0/tape/K1/staging): evaluator
visibility needs a pin clause, symmetric with receipts — effective
evaluator for a pass = staged-in-this-pass, else the committed evaluator
*as of the pass's pin* (retain the prior {fn, stamp} version while any live
pin predates the promotion; promotedAtSeq is already mintable from the one
globalSeq line, and reclamation can ride the same pin-gated discipline as
tape compaction). Memo ladder step 2 then compares against pinned
effStamps and stays sound. Alternative local fix: promotion
unconditionally (value-blind, per D13's own philosophy) delivers into
every live pass whose world folds the atom, or flips such passes to
restart — but the pinned-evaluator rule is the smaller change and matches
the design's own "one number line" discipline.

---

## F2 — BLOCKER — Saturation force-clear erases exactly the state the
mount-fixup fast-out consumes: `touched==0 ∧ CT → return` skips the
I18-mandated w_fx compare for a fastPathDisabled pass → indefinitely stale
committed DOM

**Mechanisms defeated:** §5.4 force-clear (compensation = fastPathDisabled,
applied to *reads* only) × §11.2 fixup first line (`if r == 0 ∧ CT(n):
return`, justified by TAINT-COMPLETE). The §6.3 justification is a category
error at this call site: TAINT-COMPLETE certifies the *K0 cache's
provenance* ("committed-only content"), not that the *render's v_r is
current with committed truth*. In the unsaturated regime the two coincide
because bits are retained for every live pin (I39); saturation is precisely
the carve-out where bits are cleared while a live pin still excludes the
entries — and the fixup fast-out is a consumer of the swept word that the
§5.4 compensation list does not cover (invariant R §6.4 source 4 enumerates
only pass *reads* as the refused consumer).

**Failing schedule:**

Setup: atom `a`, computed `c = f(a)`, one core `effect()` on `c` (keeps
CT(c) true via NEWEST pulls at flush; C16 documents core effects read
NEWEST), **no mounted watcher of `c` yet**. Store-only batches (D2: no
React work → retire on close without a commit, so F2's same-root-commit
discard never triggers) supply the storm.

1. Transition T_A writes unrelated atom `x`; pass P_A (pin p) yields.
2. Store-only batches k1…k30 each write `a` (bits pile onto touched(a),
   touched(c)); each retires on close — retiredSeq > p ⇒ compaction
   refused (pin-gated §5.3.2) ⇒ slots unswept ⇒ with T_A that is 31 held
   slots. Core-effect flushes after each close re-pull `c` at NEWEST ⇒
   CT(c) true, K0 cache = post-storm value.
3. Further store-only batches write *other* atoms y1…y30: each intern
   force-clears the oldest fully-retired a-writer slot, sweeping its bit
   from touched(a)/touched(c) (entries retained, retiredSeq intact), and
   sets fastPathDisabled(P_A). After 30 force-clears, **touched(c) == 0**
   while committed `a` is the storm-final value and P_A's pin excludes
   every storm entry.
4. P_A resumes; component W mounts reading `c`. Render read: P_A is
   fastPathDisabled ⇒ world path ⇒ v_r = fold at (mask{T_A}, pin p,
   captured LV) = **pre-storm value** (retiredSeq > p; not in mask; not in
   the captured lock view). Correct for P_A's world.
5. Layout fixup: `r = touched(c) = 0 ∧ CT(c)` ⇒ **return** — the per-token
   loop, the cas fast-out (which *would* fail: cas moved at every storm
   retirement), and the w_fx compare (which *would* fire: v_fx folds the
   retired storm entries ⇒ v_fx ≠ v_r) are all skipped.
6. P_A commits: retirement fold touches only `x`; touchedList[slot(T_A)] ∌
   c ⇒ the reconcile backstop never examines W. No future write to c's
   cone arrives.
7. Outcome: W's committed DOM shows pre-storm `c` indefinitely; any later
   mount W2 (post-storm world) shows the storm-final value. **Same root,
   two committed watchers of one node in permanent disagreement** — the
   R9 per-root self-consistency violation the fixup exists to prevent
   (I18's exact window, lost because the trigger state was force-cleared).

**Judgment: local fix.** The fixup fast-out needs one more conjunct
mirroring the read path's compensation: `if r == 0 ∧ CT(n) ∧
¬w_r.fastPathDisabled: return` (capture the flag in the watcher's
rendered-world snapshot, which §11.2 already takes), or equivalently a
per-root "last force-clear seq" watermark checked against w_r.pin before
the shortcut. Either reuses existing state classes; no new mechanism.

---

## F3 — HIGH — Discarded fresh-node arena records have no named
reclamation (the S15 class, by omission)

**Mechanisms defeated:** §11.1 staging/P4 × the arena substrate. C9(b) and
C14 create K0 node records for freshly-mounted `useComputed` nodes during
render (world-path evaluation allocates the node, records K1 edges, mints
memos). P4 reclaims **stages**; lineage death reclaims **stage caches and
capsules**; §15 has *no row* for the K0 node record of a never-promoted
hook node, and "committed evaluator … cleared by node death" leaves "node
death" undefined for nodes whose creating render was discarded.

**Failing schedule:** StrictMode double-invoke (C14 row 1/5) or a
repeatedly-interrupted transition that mounts a component with
`useComputed`: each discarded pass allocates a fresh arena node + K1 edges
+ memo; publicationsComplete reclaims the stage only. Repeat mount-
evaluate-abandon → K0 grows monotonically; K1 bulk reset and lineage death
reclaim nothing arena-resident (S15's exact text: "a collected JS wrapper
cannot reclaim a bump-allocated integer record"). Observable outcome:
unbounded plane growth under ordinary dev traffic (P4/G-M violated;
eventual growth-stress pressure). SCARS S15 demands any discard story over
arena state "name the reclamation or staging protocol"; this design is
silent rather than wrong, but the battery (C14) exercises the flow, so
silence is a gap, not out-of-scope.

**Judgment: local fix.** The substrate already carries "deferred frees +
GEN generation counters; free-list discipline" (mechanism library); wire
node allocation for not-yet-promoted hook nodes to a pass/lineage-scoped
staging list freed at publicationsComplete/discard, or free-list the node
at lineage death when no promotion installed it. Needs a §15 row + a C14
forced test (mount-discard soak).

---

## F4 — MEDIUM — C9(a)'s fast-out rows contradict the design's own
F3/F9-before-layout ordering; "zero extra work" for in-pass mounts is
unreachable and the w_fx evaluation is under-priced

C9 rows 2–3 claim a mount inside k's own pass exits via `cas ≤ p ∧
lockViewId unchanged ⇒ return — zero extra work`. But the fixup runs in
the layout effect of k's own commit, and by I38c/F3 the same commit's F9
publications, retirement folds (single-root: k retires here) or per-root
lock-in (spanning: LV re-mint, new lockViewId) all run **before layout** —
each bumps cas past p or changes lockViewId. So for any batch that wrote
signals, every in-pass mount falls through to the w_fx world evaluation
(row 6's path — which the design itself walks as "fast-out fails (cas
moved)", contradicting row 3). Correctness is unaffected (v_fx = v_r via
the retired/lock clause ⇒ no fire, one render), but the failure mode is
cost: 10k mounts inside a committing transition each pay a world
evaluation; G-F's ledger line "1 w_fx eval only when cas/lockViewId moved"
must be read as "≈always for in-pass mounts", and cross-root traffic makes
cas movement the common case for *every* mount. The P1 10k-mount ≤15% gate
should carry this shape explicitly in the W2 workload. **Local fix**
(sharpen the fast-out: compare cas against "cas at this commit's fold
start" rather than the pass pin, or exempt the mounting pass's own
commit-side advances), plus correct the walk.

## F5 — MEDIUM — K1 + E-PRESERVE have no growth bound when the app never
quiesces

K1 is add-only within an episode; episodes close only at *full* quiescence
(no live tokens, pins, or parked actions — §5.5). E-PRESERVE's strong
reading mirrors **every** K0 re-track removal "while any live receipt
exists anywhere". A long-lived app with steady transition/polling traffic
never reaches full quiescence, so K1 accumulates world edges plus dead
mirrored edges without bound (tapes are safe — compaction is pin-gated,
not quiescence-gated — but K1 records and touchedLists only reset at the
episode edge). No mid-episode K1 compaction or dead-mirror sweep is named;
§15's K1 row lists "episode bulk reset" as the only clear site. Failure
mode: unbounded memory (P4 reporting), degrading walk costs (longer
touched cones), never a wrong value. **Local fix:** a mid-episode K1 sweep
gated the same way compaction is (drop mirrors/edges whose slots' entries
are all retired-visible-to-every-live-pin), or an explicit declared gap
row alongside G3. Flagged because the design's own G-list (G1–G8) does not
declare it.

## F6 — NOTE — §5.1's write-path text conflates the mark frontier with the
notification walk; if implemented as written, C4/C5 regress

§5.1 step 4 describes the write walk as the monotone frontier
`newBits & ~touched(n)` and step 5 delivers "for every watcher record
reached by the walk". A frontier walk stops at already-bitted nodes, so a
second same-slot write into an already-marked cone would reach no watcher —
exactly the I5/S17 trap. §10.2 and the C1/C4/C5 walks make clear the
*intended* semantics: every write runs a **full** value-blind walkGen walk
for delivery, with the frontier only governing bit propagation. The two
walks must be split explicitly in §5.1 or an implementer will build the
scar. (Also cosmetic: §10.2 lists "retirement notification" as a walkGen
walk while §5.3 step 4 enumerates touchedList — the list is the normative
one per I34.)

## F7 — NOTE — G-W/G-N realism: the full-cone per-write walk vs the ≤2×
DIRECT-write gate; the pre-blessed fallback is S17-adjacent and unwalked

A LOGGED write walks its full cone every time (value-blind, D13); DIRECT's
donor write stops at already-stale nodes. Repeated writes into a deep
already-stale cone are therefore O(cone) per write vs DIRECT's O(1)
amortized — the ≤2× G-W gate is at genuine risk on exactly the breaker W1
shapes, which the design honestly flags (SPK-W/SPK-N1, G4). The declared
fallback ("D13 per-slot-mark dedup") re-introduces per-node cross-write
elision state whose re-arm discipline was S17's grave; if the fallback is
ever adopted it needs its own walked schedule (per-(node, slot) marks,
re-armed per (watcher, slot, cycle) — the design nowhere sketches it).
Pre-registered spike + named fallback satisfies the letter of cost
honesty; this note is so the spike's failure branch doesn't inherit an
unwalked mechanism.

---

## Verified held (attacked, did not break)

- **TAINT-COMPLETE (§6.3) and the L1 merge**: attacked the epilogue rules
  (untracked pull of a stale computed; sampling order; clear-vs-pin race;
  0→1 propagation through later-added K0 and K1 edges; taint set with no
  receipts), the cutoff horn (C1-X3 row 5), and the DIRECT→LOGGED base
  case with the registerReactBridge throw — all held. The pin-gated
  compaction argument for trustworthy empty-tape clears is sound and is
  the load-bearing coupling (correctly cross-referenced both directions).
- **Invariant R (§6.4)** holds for its enumerated consumer (pass reads);
  F2 is a *different consumer* of the same certificate, not a break of the
  read-path construction.
- **Walk atomicity (§10.2/L7)**: attacked via flushSync-inside-writer,
  reconcile equality callbacks, effect flush timing — the instruction-class
  enumeration holds; fold frames and walks are indeed disjoint given §5.3's
  step order; the saturation corollary (C1-X5 row 5) follows.
- **w_fx (L2) in the unsaturated regime**: attacked the retired-clause/
  mask-clause double-count, post-pin writes by included tokens, in-window
  retirement of the mounting pass's own token, lock→retired handover,
  suspending v_fx, and the S10 subset trap — all held; the "fire ⟺ the
  render missed committed-side truth" construction is correct as scoped.
  The TAINT-only fast-out (r has only bit 31, cas unmoved) is sound.
- **C1 family**: core (K1 real-edge notification), V2 over-notification
  bound, V3 both E-PRESERVE halves (including the no-receipt drop-is-safe
  argument), V5 pin stability across an urgent retirement, V6 worldKey
  disambiguation by pin, V7 lineage separation, X1 four S23 surfaces, X2
  union-cycle termination, X4 retention.
- **C2/C2-M, C3/C3-E/C3-R** (fold-before-publication unrepresentable given
  I38c; compaction prefix rule correctly blocks the 3-vs-4 arithmetic),
  **C4, C5** (delivery genuinely value-blind + clock validity), **C6**
  (per-write context, no implicit grouping), **C7/C7-D** (demotion-before-
  first-receipt ordering), **C8** (I7/I38a drop legality construction),
  **C10** (both races; F4's fork tests 18/19 named), **C12/-U/-T/-F**
  (carrier induction, liveness stack-atomicity, L5's MessagePort deletion
  is honest — the shim really was a no-op under registration-time capture,
  and rung-uniformity with AsyncContext is correctly argued), **C13**
  (renumber duty list vs §15 table is closed; walkGen wrap row exists;
  dedup-bit staleness is bounded by re-arm-at-committed-render, which
  retirement ordering guarantees), **C14** (L4 kills the mint oscillation;
  lineage-stable stamps make replays idempotent), **C15** incl. 5‴ (the L3
  reducer-effStamp-in-prefix repair genuinely closes the I35 hole), **C16**
  (cas pre-filter proved conservative: every committed-for-root fp source
  bumps cas), **C17** (deletion + API snapshot test is a legitimate
  preamble-rule resolution), **T8-N** (full-cone carry + rank termination).
- **fp injectivity (I21/S2b)**: retireVisStamp/lockTerm cover the flip
  classes; pass-world visible sets are frozen at pin (checked all three
  clauses), so post-pin activity can only over-invalidate via wc, never
  change a fold.
- **Fork honesty**: F1–F9 are edge-triggered facts; the rebase drill answer
  is genuine (tokens/edges/ids only cross the seam); F2's serialization
  claim matches real React restart-not-resume behavior and is pinned by
  fork test 24; the F9-before-folds ordering is used consistently
  everywhere *except* the C9 row-3 arithmetic (F4).
- **Cost honesty**: G-Q at-risk declared with pre-registered renegotiation;
  lockTerm priced in-fold; unmeasured items all carry named spikes and
  fallbacks (F7's caveat noted).

## Verdict

Two blockers, one high, two medium, two notes. Both blockers defeat seam
compositions (evaluator promotion × pass pinning; saturation sweep × fixup
fast-out) rather than any central mechanism, and both carry rule-level
in-architecture repairs (a pin clause on evaluator visibility with
pin-gated retention of the prior version; one compensating conjunct on the
fixup fast-out) — the K0/tape/K1/clock/staging/fork-seam core survived
every attack I could construct, and the round's deletion-based repairs (L1,
L2, L4, L5) all genuinely hold. **Repairable** — not implementation-ready
until F1/F2 are folded in with their forced tests (a cross-root promotion
row in C3-M/C11-A and a saturation×mount row in C1-X5/C9), and not
architecturally unsound anywhere I probed.
