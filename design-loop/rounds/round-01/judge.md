# Judge — round 1 (design under judgment: `synthesis.md`, the repaired two-kernel design)

Independent re-derivation. I read only the seeds, INVARIANTS.md, SCARS.md, and
the synthesis; no reviews, no drafts, no prior rounds. Every claim below is
re-walked from the design's own stated mechanisms (§ references are into
`synthesis.md`). Full-depth traces executed for C1, C2, C4, C6, C7, C13 per
the judge method; all other cases verified step-by-step against the design's
walks, with counter-attacks where I could construct them.

---

## Part 1 — Battery re-walk

### C1 — world-divergent dependency (family of 8) — PASS (full depth)

Main schedule, my own trace against §4.1/§5.2/§8/§9:

| step | mechanism | state |
|---|---|---|
| 1 | `flag.set(true)` in k (§4.1) | guard: no pass binding ✓; slot(k) interned, `wc[k]=s1`; `base(flag)=false` preserved; `tape(flag)+={true,k,s1}`; K0 newest `flag=true`, K0 marks `c` (canonical edge flag→c) |
| 2 | `notifyWalk(flag,k)` (§9.1) | visits flag, c via K0 edge; `F(flag)=F(c)=1`; W: NM bit k clear → `setState` in the transition context → k's lane; `NM(W)={k}` |
| 3 | k pass P1, `w1=({k},s1)` | W renders, re-arms NM; reads c: `F=1` → world eval: flag folds true (**K1 edge flag→c recorded**); branch reads a: `F=0`, atom, empty tape → `k0.value=0` (**K1 edge a→c recorded**); `M(c,w1)=0` |
| 4 | `a.set(1)` in k | `tape(a)+={1,k,s2}`; `wc[k]=s2`; K0 newest a=1; **K0 has no a-edges** (c's K0 deps are {flag,b}) |
| 5 | `notifyWalk(a,k)` | K1 out-edge a→c (step 3's real edge) reaches c; W bit re-armed → `setState` in k's lane ✓ |
| 6 | k re-render, `w2=({k},s2)` | new worldKey (pin moved) and `wc[k]=s2` kills any memo reuse → re-eval: flag true, a folds 1 → **c=1 pre-commit in k's lane** ✓ |
| 7 | committed/sync read | `F(c)=1` → world eval under (∅∪lockedIn, pin): k entries invisible (slot∉mask, retiredSeq=0) → flag=false → reads b → **c=0 via b** ✓ |

The trap (no canonical a→c edge) is closed structurally: the k-world
evaluation *itself* created the K1 edge the later write needs. If step 3 never
ran before step 4, `NM(W)` still holds k from step 2 (never re-armed) — the
reach induction's "already scheduled" arm. Verified.

Variants: **T2** over-invalidation only (K0 edge b→c delivers; k-eval
unchanged) ✓. **T3** fold `{true@s1,false@s3}`=false → c reads b; K1 gains
b→c (add-only union) ✓. **T4** urgent b-write delivers in U's context; U-world
c=9; k-world unchanged ✓. **T5** urgent a-write follows the K1 edge (spurious
delivery for U — priced under G-N); k's fold `{1@s2, 5@s9}` in seq order → 5,
with the F2 mask-parity fact making the answer agree with React's queue answer
under either scheduling ✓. **T6** slot/id hygiene routed to §12; forced tests
named ✓. **T7** joint-then-solo passes: lineage-keyed thenables per batch-set;
abandoned set's cache drops regardless of settlement; one extra fetch on set
change, documented, not wrongness ✓. **T8** (the TK-F1 schedule): re-walked
myself — episode-2 urgent read of stale-unflagged `w` fails CLEAN_TRACKED
(stale bits persist across quiescence in K0) → world-evaluates → folds `x`'s
base 0 → renders `w=1` beside `x=0`, and records K1 x→u→v→w so the later
k-write reaches watchers ✓. The R1 routed-serve rule genuinely closes the
class: a lazy pull is a fresh newest-basis evaluation, and the repaired rule
never serves one to a non-newest world.

### C2 — flushSync excludes a pending default batch — PASS (full depth)

My trace: `a.set(1)` → token D, receipt `{1,D,s1}` (always-log, no urgent
skip — I1), base 0 preserved, K0 newest 1, walk flags a and c and delivers in
D's context. `flushSync` pass: F2 tokens exclude D → world `({sync}∪lockedIn,
s)`; not RENDER_NEWEST (D live, excluded). Read a: `F=1` → fold: D's entry
fails both visibility clauses (slot∉mask; retiredSeq=0) → **0** ✓. Read c:
`F=1` → world eval → a folds 0 → **10** ✓. Both traps closed: (a) the receipt
exists for the urgent-classified write; (b) the write-time walk flagged the
downstream cone off the canonical edge, and — my added attack — if c had
*never been evaluated* (no canonical edge, no flag), the routing rule still
catches it: never-evaluated fails CLEAN_TRACKED → world eval → 10. The design
survives a variant its own walk didn't need. ✓

### C3 — rebase parity — PASS (verified walk)

Fold arithmetic re-executed: U render (mask {U}) folds base 1, s1 invisible,
×2 → 2; U commit stamps `retiredSeq=s3` **on the shared globalSeq line**
(R3); committed view: retired clause → 2; T render (mask {T}, pin≥s3) folds
+1@s1 then ×2@s2-retired in *seq order* → 4; T commits 4. Plain-set variant →
5 not 6. This is I2's replay-in-write-order, clause-for-clause. Compaction
correctly blocked at step 4 (smaller-seq unretired entry behind). ✓

### C4 — two-batch write into an already-stale region — PASS (full depth)

T1 write: full-reach walk, W gets setState in T1's context, `NM={T1}`. T2
write **before any re-render**: the walk runs full reach again — `visited` is
per-walk-ticket, F flags never gate the walk, and no cross-walk mark exists
(§15-R1 explicitly rejected) — W's T2 bit is clear → setState in T2's context,
`NM={T1,T2}` ✓. Dedup is per-(watcher, slot) — exactly I5's granularity; the
trap (once-per-staleness marks / ARMED bits) is structurally absent. I looked
for any hidden walk-stopper (K0's internal equal-value mark skip): irrelevant,
the notify walk is independent of K0 marks. ✓

### C5 — cutoff-suppressed first write, effective second — PASS (verified)

No write-time equality drop in LOGGED; K0 may skip its internal marks on the
equal value but the walk runs unconditionally, and `wc[k]=s2 > memo.seq=s1`
kills the first evaluation's memo. Pre-render variant (second write before W
renders): NM still holds k → already scheduled; the render pulls through the
invalidated memo. ✓

### C6 — lane attribution under grouped notification — PASS (full depth), "handle it"

The design's resolution: **no grouped drain exists**. `batch()` defers core
effect flush only; watcher delivery is synchronous per write in the writer's
stack (D5). My trace: `a.set(1)` inside `batch()` asks the fork → urgent
token, delivers now in urgent context; `startTransition(() => b.set(2))` asks
the fork inside the transition scope → deferred token, delivers now →
transition lanes, one commit; `batch()` close flushes core effects at NEWEST.
Per-write context preservation is by construction (classification and
delivery both happen at the write site), and the mandatory statement about
implicit grouping is present: none exists. Attack attempted (writes straddling
scopes, nested transition inside batch): symmetric, same mechanism. ✓

### C7 — writes and reads during a yielded render pass — PASS (full depth)

Pass P (mask {T}, pin p) starts → `currentWorld=wT`, pass binding set. Yield
(F2 flips at work-loop boundaries) → `currentWorld=NEWEST`, binding cleared.
Handler read: NEWEST → `k0.pull` ✓ newest. Handler write: guard sees empty
pass binding → no throw; classified under the click's token; walk delivers
urgent ✓. Click commits: `retiredSeq=++globalSeq=sr` — **commensurable with p
because R3 put stamps and pins on one line**; my check: p < sc < sr by
monotonicity, so the resumed pass's fold excludes the click entry (`sr ≤ p`
false; slot∉mask) ✓ pinned world intact; compaction blocked by pin retention
(sr > p) so the fold is reconstructible ✓. Added attacks: (1) a tracked NEWEST
pull in the gap re-tracks K0 → `beforeRetrack` mirrors old edges to K1
(E-PRESERVE's one site) so the resumed pass's notification reach survives the
re-track; (2) the recompute's `afterRetrack` ORs flags so a freshly-CLEAN K0
cache is never wrongly served to wT — either F=1 routes to world path, or F=0
with invariant R holding means newest genuinely equals every world. Both
survive. ✓

### C8 — equality drops must not lose receipts — PASS (verified)

`ALWAYS — equal values too` is on the write path itself (§4.1); U's fold over
base 0 shows 1 ✓; overlapping same-value transitions each hold receipts ✓;
DIRECT keeps the donor skip, which is exactly I7's empty-history case (history
cannot exist in DIRECT) ✓.

### C9 — mount mid-transition — PASS (verified)

(a) existing node: per-callstack `currentWorld=wk` → F=1 world path, or F=0
with CT ⇒ invariant R makes the K0 serve provably world-agnostic, or ¬CT ⇒
world eval. First render correct in all three legs. (b) fresh node: no K0
record ⇒ ¬CT ⇒ world-routed *by the ordinary rule* — the fresh-node trap is a
corollary, not a carve-out; K1 edges recorded at first eval give later
k-writes reach; registration at commit keeps discarded passes harmless (C14).
The residual the design names (K0 backfill vs world memos, separate stores) is
real and pinned by a test. ✓

### C10 — late subscription joins the pending batch — PASS (verified, incl. joint masks)

Reach-based fixup: `F(n)=1` → corrective `runInBatch(t, setState)` into
**every** live deferred token with writes; no equality filter. Joint variant
(c=a&&b, t1 wrote a, t2 wrote b): correctives in both lanes → the joint pass
includes W′, renders it fresh, reads world({t1,t2}) → no bailout tear; single-
token passes over-render boundedly (G-F ≤ live deferred count). Retired-race
fallback: `runInBatch` returns false → one urgent pre-paint setState (layout
timing). Fresh-transition inequivalence stated (separate lanes ⇒ separate
commit ⇒ torn window). My attack — a live deferred token with no writes is
skipped via `wc[t]=0`: sound, a writeless batch cannot diverge any signal
world. ✓

### C11 — multiple roots, declared scope: FULL spanning — PASS (verified)

Per-root lock-in masks compose into every world by the same visibility math;
A-commits-k while k lives: A's urgent renders and passive effects include k
via `lockedIn(A)`; B excludes it; retirement fires exactly once at the last
root; store-only-on-B still retires once. No global "committed" world exists
to be wrong. Spanning-suspense duplicate fetch per root documented. The
honest G4 flag (fork registry facts re-proven on the current base by fork
tests 2/3/4 before C11/C12 count as implemented) is the right epistemic move.
✓ at declared scope.

### C12 — store-only transitions persist — **FAIL in one leg** (see blocker B1)

Value persistence itself holds: fold-on-retire regardless of `committed` and
regardless of subscribers (D2; S4 avoided); async actions park retirement
until settle; folds in seq order → 2, not before ✓. **But the required
observation path fails as-written**: the walk's step 2 claims "a
`useSignalEffect` on `a` elsewhere re-runs seeing 5" via §10.4 trigger 2's
version compare — and the mechanism as defined cannot deliver that. Full
derivation under B1 below.

### C13 — counter/world-id lifecycle — PASS with a documented inventory gap (full depth)

I re-derived every counter in §12 against its retainers: `globalSeq` (memos
die at quiescence-or-epoch; pins die with passes; tapes empty at quiescence;
near-2^53 test names the float64 horizon); `slotWriteSeq` zeroed at
intern/recycle (R4 — the fail-closed-forever bug is genuinely gone);
slot-id/NM-bit columns cleared at recycle and per-root at commit; worldKeys
epoch-scoped; walkTicket wrap zeroes the stamp column; K1 ids epoch-tagged
with the tag-wrap collision correctly classified as over-notify-only; lineage
generation-checked. Forced-collision tests named per structure. **Gap:** the
retainer column for `globalSeq` omits two seq-holding structures that survive
quiescence on mounted components — `useSignalEffect` dep `(id, version)`
lists (§10.4) and `watcher.lastRenderSeq` (§3, recorded at commit, no stated
consumer or guard). The C13 walk's claim "every retainer carries an epoch" is
false as written. Under the design's *current* mechanics I could not convert
this into a cross-episode false-validation schedule (the retirement flush
ordering happens to refresh effect versions to 0 before any reset can occur,
and `lastRenderSeq` has no comparer), so this is a walk-completeness defect,
not an independent blocker — but the fix for B1 (a persistent atom version) is
exactly the kind of new seq-retainer this table must gain a guarded row for,
so the omission is load-bearing for the repair. Case passes; inventory must be
completed next round.

### C14 — StrictMode — PASS (verified)

Guard-first write rejection (queue untouched, test asserts); per-callstack
binding keeps yield-gap writes legal; replays hit the same (worldKey, lineage)
memos/thenables; discarded passes leave only monotone-and-harmless residue
(add-only K1 edges, unregistered nodes, early-cleared NM bits = over-delivery);
watcher fields commit-recorded (T2). My attack — F flags set during render are
render-phase mutations: they are monotone, routing-only, and can cause at most
an extra world evaluation whose result agrees (invariant R's contrapositive),
so no observable impurity. ✓

### C15 — suspense across worlds — PASS (verified)

Key = `(node, lineageId, position)`; lineage is a protocol fact: stable across
restarts/replays of one (root, batch-set), distinct across set changes, dead
at commit/abandon; late settle generation-checked. This simultaneously
excludes passSerial-refetch, single-token under-keying, lock-in drift, and
live-set churn — the key never mentions masks or live sets. Mount
mid-suspension shares the thenable identity (the react-concurrent-store known
bug becomes a passing test); canonical never consults lineage caches. Set
change mid-suspension costs one refetch then converges (lineage for the new
set is stable). Key and lifetime both stated, as the case demands. ✓

### C16 — effects observe committed state only — **FAIL** (shares blocker B1)

The world math is right (committed-for-root excludes D's applied-uncommitted
write; core `effect()`'s NEWEST divergence is stated and tested). But steps 3
and 3′ assert "dep version for `a` moved in the committed world → re-run" —
and under the design's own definitions the version does *not* move once the
entry compacts. Derivation in B1.

### C17 — optimistic rollback — PASS (surface deleted per the case's clause)

No truncation exists; batches fold on retirement; optimistic UI composes from
ReducerAtom folds. Nothing depends on truncation. ✓

---

## Part 2 — The new confirmed blocker

### B1 — the effect-flush version fingerprint collapses at retirement compaction (C12 leg 2, C16 steps 3/3′)

The design's own definitions, quoted:

- §8.2: "atom version = **seq of newest visible entry, 0 for tape-free**".
- §10.4: `useSignalEffect` "re-run decided by **version compare** in that
  world" — for all three triggers.
- §4.3 ordering: step 3 "recompute base′ …; **compact**" precedes step 4
  "the per-root signal-effect flush check … scheduled as an engine microtask
  for roots React will not commit".

Failing schedule (C12's own, walked to the end):

| step | state |
|---|---|
| 1 | `useSignalEffect` E reads atom `a` at last flush; `tape(a)` empty → E stores `version(a)=0` |
| 2 | `startTransition(() => a.set(5))`, no subscribers, no live passes; receipt `{5,k,s1}` |
| 3 | k closes with no React work → `onBatchRetired(k, false)`: stamp `retiredSeq=s2`; epoch bump; fold `base(a)=5`; **compact** (no live pins) → `tape(a)` empty |
| 4 | step-4 flush check runs on the engine microtask: `version(a, committed) = 0` (tape-free) `==` stored `0` → **no re-run**. E never observes `a=5` |

C12 requires the effect to re-run seeing 5; C16's step 3 has the same shape
through trigger 1 (React retires at commit, compaction runs at retirement,
the passive flush runs *after* — by flush time the fingerprint has collapsed
back to 0-tape-free, equal to the stored 0). The fingerprint `seq-of-newest-
visible-entry-else-0` is **not monotone across fold/compaction**: a
base-moved-then-compacted atom is indistinguishable from an unchanged one.
Note the irony: the synthesis adjudicated exactly this defect class in
*other* designs (CO-F3/FN-F4, "the re-flush at lock-in was asserted, never
constructed") and built an explicit trigger inventory — the triggers fire,
but the predicate they consult is blind after compaction.

Not architecture: the fold-walk in §4.3 step 4 already knows which atoms'
bases moved; repairs are local (persistent per-atom version bumped at write
and at base fold — which then needs a §12 epoch-guard row per C13 — or
walk-marked effect records, or compaction deferred one flush cycle). But
as-written, two battery cases' walks assert an outcome the stated mechanism
does not produce. **New confirmed blocker: 1.**

---

## Part 3 — Construction audit ("by construction" claims, attacked)

1. **Invariant R (§5.3), the load-bearing construction.** Present and written
   out (CT ⇒ zero-recompute serve; E-PRESERVE ⇒ basis edges present; F=0 ⇒ no
   receipted atom reaches n; purity ⇒ re-run in any world reproduces the
   cache). My attacks: (i) F's maintenance-site list — is it closed? The three
   sites (walk-flagging, world-eval OR-in, `afterRetrack` OR-in) cover the
   only edge-creation paths (K1 edges come only from world evals and
   E-PRESERVE mirrors of pre-existing edges; K0 edges only from
   (re)tracks) and the only receipt-creation path (writes walk). Closed —
   this is an enumeration over structural sites, unlike the S3/S5 semantic
   prayers. (ii) Unwatched nodes whose K0 edges the donor may prune: excluded
   from the trust base — they fail CT conservatively, and the design still
   adds a donor unwatch-semantics pin test. Honest. (iii) Writes-in-computeds
   (R8): NEWEST-only tolerance; every world-eval frame rejects writes — R8's
   own rule, applied uniformly (T3). **Survives.**
2. **C6 by construction** — the construction is the *absence* of a drain plus
   write-site delivery; implicit grouping explicitly nonexistent. Survives.
3. **S5-immunity by construction (§8.2)** — validity never consults a read
   set; a first-receipt write bumps the slot clock and kills every mask-
   including memo regardless of what any evaluation recorded. Survives.
4. **Untracked contract by construction (§8.5)** — no K1 edge, no dep entry,
   no delivery path through the untracked atom; clock-driven memo
   re-evaluation on unrelated re-reads is allowed behavior. Survives.
5. **C10 joint divergence structurally covered** — corrective updates sit in
   every live deferred lane, so every mask subset's pass re-renders the
   mounted component fresh; no equality filter exists to be defeated by
   `x1&x2&!x3`. Survives.
6. **≤31 structural (§11-F1)** — rests on the fork entangling transitions
   under lane pressure (one lane = one token); it is a protocol fact we
   implement, pinned by fork test 11. Acceptable as a co-design fact, flagged
   correctly.
7. **Reach induction (§9.2)** — the walk-or-scheduled dichotomy holds under
   my retirement attack (divergence introduced by another batch's retirement
   is carried by React re-rendering k over the new base — F2 mask parity —
   not by our walk), and R1 closes the previously unroutable never-evaluated
   arm. Survives.
8. **Weak spots:** the dep-version recheck ladder is sound-by-analogy only
   ("alien checkDirty transplanted") and its atom-version definition is
   exactly what B1 broke in the effect path — the ladder's memo-validation
   use is safe only because clock validity gates it first, but the spec's
   "correctness never depends on the ladder" is an assertion, not a
   construction; and worldKey includes the pin, so cross-pass memo reuse
   depends on "captured, not minted" pins plus the ladder — a perf
   under-specification (G-E/SPK-G8 cover the cost, but the churn deserves a
   named line).

## Part 4 — Mechanism count (mine, from the spec, not the inventory)

Counting cooperating concurrency mechanisms: (1) LOGGED write path with tape/
base/single seq line; (2) visibility-math folds; (3) slot/mask/pin/lock-in
batch bookkeeping; (4) clock+epoch validity; (5) world memos + ladder +
lineage thenable caches (three sub-pieces, one world-value store); (6) K1 +
E-PRESERVE + F column + invariant-R routing (the structural heart); (7) the
per-write full-reach walk with per-(watcher,slot) dedup/re-arm; (8) React
correction layer (reach fixup + reconcile backstop + retire/lock-in effect
flush + commit-recorded fields — four small policies); (9) fork protocol (7
facts); (10) episode lifecycle (folds/compaction/pin retention/quiescence/
guards). That is honestly 10 at the spec's grain — 12–13 if the sub-pieces of
(5) and (8) are counted separately. Crucially, the obligations are almost all
structural/enumerable: one E-PRESERVE site, three F sites (audited closed),
zero read-set-completeness obligations, no certificate stack. B1 lives inside
(8)'s predicate — a definition slip, not a completeness prayer.

## Part 5 — Scores

- **correctness = 7.** Fifteen of seventeen cases pass full re-walks,
  including every mandated full-depth trace and my counter-attacks (C2's
  never-evaluated variant, C7's mid-gap re-track, C14's F-flag purity attack,
  T8's cross-episode staleness). One confirmed blocker (B1) breaks the
  observation leg of C12 and C16's main line — real, walkable, but local:
  the fix touches one predicate plus a §12 row, and three repair shapes are
  already latent in the design's own text. C13 additionally carries a
  documented inventory omission that the B1 fix will force into the open.
- **mechanisms = 8.** Ten cooperating mechanisms at an honest grain, and —
  the thing this axis actually measures — their obligations are structural:
  clocks over certificates (O9 settled the right way), one-site E-PRESERVE, a
  closed three-site flag enumeration, delivery dedup with per-(watcher,slot)
  granularity. The count is not minimal (a compensated single kernel claims
  fewer planes but pays in semantic completeness obligations — the round's
  adjudication trail shows why that trade is worse), and B1 shows the
  correction layer still has one under-constructed predicate.
- **seam = 8.** All six charter-required protocol facts present plus a
  version handshake, integers/callbacks only, feature-detect with loud
  failure, fork-owned test suite (12 tests, including the mask-parity
  differential and the commit-oracle demotion of the gate idea — a genuinely
  good move). The rebase drill is answered concretely per scenario with
  "library moves zero lines," and mask parity (F2) is the single fact that
  makes fold-vs-React parity testable rather than folkloric. Deductions: the
  ~10 reconciler touch sites are asserted, not itemized with in-place
  invariants (charter goal 2), and G4 honestly leaves the registry facts
  re-proof pending.
- **performance = 8.** Every hot mechanism carries a numeric gate consistent
  with research-facts: donor numbers cited correctly, ≤2× logged write (G-6),
  ≤2% quiet (P3), the G-7 eager-evaluation shape explicitly avoided, I11
  applied exactly right (values stay in-plane; two per-recompute hooks, not a
  per-read host protocol; SP1c demoted to refactor question). Unmeasured
  items are spikes with decision rules and pre-specced fallbacks, and gaps
  G1–G7 are declared rather than wished away. Deductions: worldKey-pin churn
  across passes is only implicitly priced (the "memoized thereafter" claim in
  §13.2 is optimistic when pins advance), and the ladder that carries the
  recompute-avoidance load is the least-specified hot mechanism.
- **explainability = 9.** The one-page summary covers all ten mechanisms I
  counted — modes, receipts/folds, the routing rule with its freshness
  predicate, K1, clocks, the walk, the correction layer, the seven fork
  facts, lifecycle — in plain English, with every term defined before use
  (§3) and the walks in the required trace format. The repairs are stated as
  a delta log with finding provenance. Nearly exemplary; only the ladder and
  the pin-capture semantics made me read twice.

## Part 6 — Open spikes that could change architecture

Zero, by my count. SPK-N1's failure mode swaps in a pre-specced fallback
(§15-R1) inside the same walk architecture; SPK-G8's escape hatch is an
additive fold cache; SPK-H/W/Q have compile-out plans; SP2 is dev-only; G4 is
implementation re-proof of protocol facts the fork itself defines. The one to
watch is SPK-N1 — its fallback changes the delivery mechanism's internals,
not the two-kernel/tape/clock shape.

---

```
VERDICT
new_confirmed_blockers: 1
scores: correctness=7 mechanisms=8 seam=8 performance=8 explainability=9
open_spikes_that_could_change_architecture: 0
exit_recommended: no
one_line: The repaired two-kernel design survives full-depth re-walks of the battery — invariant R and the reach induction held under attack — except that the effect-flush version fingerprint collapses at retirement compaction (C12/C16), one local, confirmed blocker in an otherwise structurally sound architecture.
```
