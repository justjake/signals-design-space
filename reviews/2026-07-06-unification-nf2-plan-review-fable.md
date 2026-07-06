# Adversarial review — effects unification + NF2 productionization plan (fable)

Artifact under review: `plans/2026-07-06-effects-unification-and-nf2.md` (read in
full). Grounding: engine/adapter/oracle sources at the plan's stated baseline
`5fc3c08` (HEAD's code — HEAD `b081136` adds only the plan; working-tree grind
diffs were ignored, symbols verified against the baseline), the contract
(`spec/react-compliance-contract.md`, cited as RCC-*), the NF2 spike report +
archived prototype, and review-2 findings F1/F5. Line numbers below are
baseline-`5fc3c08` numbers.

Reviewer posture: break the plan. Findings are ranked BLOCKER (the plan, followed
as written, lands a wrong mechanism or stops mid-stage on a question it should
have answered) / MAJOR (a stated argument is unsound or materially incomplete;
fix before the affected stage) / MINOR (real but contained) / NOTE.

## Verdicts

- **Program 1 (subscription promotion): SOUND-WITH-AMENDMENTS.** The promotion
  direction, the RUL-1/RUL-2 gating, and the oracle-first order are right; the
  two-axis parameterization does not actually describe watchers, the capture
  frame remains largely un-refereed by lockstep, and one RUL-1 resolution loses
  fires the plan does not walk.
- **Program 2 (NF2 productionization): UNSOUND AS SPECIFIED.** Three blockers:
  (B1) untracked-dependency value validation is deleted with no replacement,
  (B2) committed-plane lifecycle across quiescence/quiet mode is
  self-contradictory, (B3) the §4.2 fingerprint decision procedure at the
  lock-in fanout site reintroduces the exact below-max visibility bug the
  engine's own commit-generation re-keying documents. Each has a concrete
  schedule; each is fixable; none is fixable by an implementer "following the
  plan."
- **Sequencing (P1 → P2): SOUND**, with the caveat that P1's "one collection
  rule" claim — a stated reason for the ordering — is only two-thirds true (M4).

---

## BLOCKER findings

### B1 — NF2 deletes the only mechanisms that keep UNTRACKED dependencies fresh in world caches, and replaces them with a taint bit that provably under-covers

**Plan text attacked:** §4.2 ("What dies is every PER-COMPUTED fingerprint:
computeds validate structurally (flag checks + `wCheckDirty`), never by per-dep
fingerprint scans"), §4.4 ("Weak (untracked) coverage: the drain additionally
re-checks any subscription whose node carries TAINT — the conservative arm that
replaces weak-edge expansion (untracked reads still leave no link in any
design)"), §4.6 (deletes `recordWeakEdge`, the weak plane, per-dep `scanFp`).

**What HEAD actually does (two mechanisms, the plan re-homes neither):**

1. **Value validation.** An untracked read enters the open memo frame's
   *fingerprint set* even though it records no strong edge
   (`untrackedReader`, logged.ts:1757-1784: "the dep still enters the open memo
   frame's fingerprint set (validation must observe untracked movement, or
   committed folds would serve stale values)"). `validateMemoInner`
   (logged.ts:1541-1548) fp-rechecks every recorded atom dep — tracked or
   untracked — so a cached committed/pass value goes stale the moment an
   untracked dep moves. Under NF2 the per-computed fp arrays are deleted and
   validation is `wCheckDirty` over plane **links**; an untracked dep has no
   link, so nothing ever invalidates the cached value. This is not a
   drain-candidate problem; the cache itself is wrong: even Program 1's
   full-scan effect re-check (which needs no candidate collection at all)
   calls `evaluate(node, committed)` and receives the stale plane value.
2. **Drain candidates.** `recordWeakEdge` fires unconditionally on every
   untracked read (logged.ts:1766-1768, 1994-2002) and
   `drainCommittedObservers` expands candidates over `weakOutList`
   (logged.ts:3150-3162). The plan's replacement — "re-check any subscription
   whose node carries TAINT" — covers only nodes whose **own last evaluation
   already saw pending state** (taint originates in the reader's frame,
   logged.ts:1770-1776, and propagates downstream over *strong* out-edges,
   logged.ts:2044-2062). The read-before-pending interleaving is uncovered.

**Failure schedule (read-before-pending):** computed `C` reads atom `A` via
`untracked` while `A` is committed-quiet (no taint minted anywhere; no link in
any plane); watcher `w` on `C` commits in root R; batch T writes `A`; T retires.
NF2: fanout marks `A` in R's committed plane; expansion over plane links finds
no `A→C` edge (untracked); `C` is not tainted (its last evaluation saw no
pending state); the plane's cached `C` never refolds → `w` receives neither a
delivery nor a drain correction and the committed frame is stale until some
*tracked* dep of `C` moves. HEAD is correct twice over on this schedule (fp
recheck + weak-edge expansion). Violates RCC-SP5's MUST half and RT5; the model
full-scans and corrects (model.ts:1136-1156), so lockstep's **exact**
correction-stream compare (cosignal/tests/helpers.ts:161-171) catches it at
S-B — i.e., the stage STOPS on a design hole the plan should have closed on
paper. The spike never exercised this: it had no untracked reads and no folds
(spike report §1 "Spike simplifications"). Fix shape to demand: per-plane weak
links (untracked reads DO leave a link at HEAD — the plan's "no link in any
design" is factually wrong for the weak plane), or per-shadow untracked-fp
columns, or forced-refold-on-read for nodes with untracked deps; each must be
priced, since this is where the spike's "simpler does not hold" bites hardest.

### B2 — Committed-plane lifecycle across quiescence and quiet mode is specified three mutually inconsistent ways, and every consistent resolution has a walked failure

**Plan text attacked:** §4.1 ("committed-for-root worlds — one **long-lived**
plane per root"), §4.5.7 ("planes renumber their clocks at quiescence"),
§4.8 S-B ("committed planes renumber/**pool** at quiescence"), §4.9.6 ("quiet
folds bypass planes entirely — **zero live worlds while quiet is an
invariant, asserted**"), and Program 1's §2.4 row 4 ("`quietDrain`'s committed
arm retargets the promoted records").

**The contradiction:** `quietDrain` (logged.ts:2283-2300) evaluates every live
watcher and committed effect **in a committed world** during quiet mode — after
P1 it re-checks the promoted committed subscriptions (the plan says so). Under
NF2 a committed-world evaluation is exactly what materializes/uses a committed
plane (§4.1's lazy rule). So quiet mode *itself* uses committed planes, and
"zero live worlds while quiet" cannot be an invariant unless committed planes
are torn down before quiet re-arms — which contradicts "long-lived" and
"renumber at quiescence" (you don't renumber a dead plane's clocks).
`recomputeQuiet` (logged.ts:1007-1015) consults tokens/passes/tapes/events —
never planes — so quiet arms with planes alive.

**Resolution 1 (planes survive quiescence, per §4.1/§4.5.7):** then quiet folds
MUST fan into committed planes, and the plan's §4.3 flip-site list (retirement /
lock-in / member-write) is missing a **fourth site**. Schedule: bridge host
with a live watcher/committed effect; quiesce; quiet write to atom `A`
(`__quietWrite` advances `base`/`cas` with no receipt, logged.ts:2261-2277);
`quietDrain` evaluates the watcher's computed committed → the surviving plane's
shadow is unmarked (no fanout site fired; `cas`-based `committedClocksQuiet`
that saves HEAD at logged.ts:1495-1506 is deleted with the ladder) → stale
value served → `quiet-mode.spec.ts`, which the plan's own gate list requires
untouched-and-green, fails. Violates RCC-PR2's spirit (quiet writes ARE
committed history the moment they land — every reader must see them).

**Resolution 2 (planes drop at quiescence, "pool" = free):** then the plan has
silently deleted `quiesce()`'s kernel-pull refresh (logged.ts:3361-3425: every
K1-touched node holding a committed watcher is re-evaluated so "the coverage
those observers rely on must be re-recorded, not lost with the old plane") and
replaced it with nothing. Schedule: watcher `w` on computed `C` (deps `{A}`)
committed in R; app quiesces; R's plane drops; event-handler write to `A` in
new batch T: write-time delivery walks kernel ∪ live planes — no plane holds
`A→C`, kernel lists never hold world edges by NF2's own segregation — no
delivery; T's commit drain expands marks over an empty plane → no correction;
`w` is stale until an unrelated re-render evaluates `C` committed. Violates
RCC-SP5-MUST/SP4. (HEAD survives this exact window via the refresh it is about
to lose.)

Either arm needs design, not implementation-time improvisation; and P1 §2.4
row 4 vs P2 §4.9.6 must stop asserting opposite invariants in one plan.

### B3 — The §4.2 fingerprint decision at the lock-in fanout site reintroduces the below-max visibility bug that commit-generation re-keying exists to prevent

**Plan text attacked:** §4.2 ("The atom-granularity fingerprint (`fpOf`)
SURVIVES: it is how a re-marked shadow atom decides whether its fold actually
changed (write-equality per world) **before propagating**") together with
§4.3(b) (lock-in fanout "**replaces commit-generation re-keying** — item 6 of
§3 — structurally").

**The engine's own documentation of why this is unsound** (logged.ts:1531-1538,
`validateMemoInner`): "The root commit generation RE-KEYS committed memos: a
gen mismatch means the memo belongs to a dead world — evict, **never
fingerprint-rescue**. Why: a per-root commit flips visibility of receipts BELOW
the visible maximum sequence, and fingerprints only track that maximum, so they
cannot detect the flip." `fpOf(atom, world)` is max-visible-seq
(logged.ts:1555-1565). At flip sites (a) retirement and (c) member-write the fp
moves (retirement stamps `retirementStamp`; a member write appends a new max
seq), so an fp-gated mark consumption is sound there. At flip site **(b)
per-root lock-in** it is not: lock-in adds *membership*, exposing receipts with
seqs at or below the already-visible maximum.

**Failure schedule:** atom `A`: retired receipt seq 100 (visible to R's
committed world); live batch T holds an older receipt on `A` at seq 50; R
commits a pass including T → lock-in fans `A` into R's plane; the shadow's
re-mark decision computes `fpOf(A, committed(R))` = 100 = stored fp → "fold
unchanged" → no refold, no propagate → R's committed world never shows T's
write. Violates RCC-EF2's explicit clause ("including flips where an OLDER
write becomes visible beneath a newer one") and RT5/CR1's no-less half.
Lockstep would catch it (committed snapshots + exact correction stream), but
the plan *specifies* the unsound procedure and *advertises* it as the
replacement for the gen mechanism. Required amendment: at site (b), mark
consumption must refold and value-compare (fp may only serve as a
one-directional shortcut: fp moved ⇒ refold; fp unmoved ⇒ NOT sufficient), and
the plan's claim that (b)-fanout "replaces commit-generation re-keying
structurally" must carry that carve-out plus a pinned engine test for the
seq-50-under-100 shape.

---

## MAJOR findings

### M1 — §4.4's delivery-coverage argument rests on two load-bearing mechanisms the plan never identifies, so the "already-rendered consumer's links exist in its root's committed plane" premise is unsupported

The discriminant-edge argument needs the committed plane to *contain the
consumer's current committed dep links*. Nothing in §4.3/§4.4 creates them:
fanout writes **marks**, not links; drains expand marks *over existing links*;
mount fixup runs in a plane-less `mountFix` world that "caches nothing" (§4.1).
The mechanisms that would actually populate committed planes at HEAD-shaped
code are incidental and unnamed by the plan:

- the **re-staled detection loop** at `passEnd(commit)` (logged.ts:2848-2853),
  which committed-evaluates EVERY rendered watcher's node at every commit
  (`p.rendered` includes mounted watchers — logged.ts:2622, 2661); and
- the reveal path's conservative compare (`resubscribeAtLayout`,
  shim.ts:812-813), a direct `committedValue` evaluation.

If either survives verbatim, cold windows mostly close; if an implementer
restructures `passEnd` per §4.4's four-job re-homing list (delivery, drains,
fixup, TOUCHED) — the only jobs the plan says K1 routing has — computed-node
watchers become unreachable from writes for the whole window between their
pass's death and the first committed-world evaluation of their node, and that
first evaluation is itself reachability-gated: a bootstrap circularity.
Walked schedule (with the loop absent): mount `C=f(A)` in R (pass P1, links in
π1 only), commit (π1 drops), handler write to `A` in fresh batch T2 → walk
finds no `A→C` in kernel ∪ live planes → no delivery (dedup rule is irrelevant:
the bit for T2's slot was never set, so this is a *fresh* delivery that simply
cannot route); commit/retirement drains expand `A`'s mark over a link-less
plane → no correction → stale committed frame until an unrelated render.
RCC-SP5-MUST + SP4.

Demand: §4.4 must name the committed-plane **population rule** as a first-class
mechanism (candidates: commit-time migration of the committing pass's links
into the root's plane — which also strengthens B3's site-(b) story; or keeping
the re-staled loop and declaring it load-bearing for routing, with a pin).
Additionally the plan's R2 residual ("value-correct but lane-degraded, RCC-SP4
erosion") understates the failure mode: under NF2, deliveries AND drain
candidates share ONE structural source (plane links), whereas HEAD's drain
coverage (slot-touched lists + weak edges, logged.ts:3133-3176) is an
*independent* conservative net. The plan deletes the independence and should
say so: a routing miss is now also a correction miss (stale-until-cone-motion),
not a lane demotion.

### M2 — §4.5.4's suspense story changes the validation regime for background-cached sentinels and can strand settled resources; "exactly as today" is only half true

Today: hook-initiated evaluations RETHROW `SuspendedRead` (shim.ts:735, 745-752)
— a throwing evaluation stores no memo (logged.ts:1705-1722 stores only on
successful return) — so render-path retries always re-run and make progress
(RCC-SU5). Background evaluations (drains, effect re-checks) *return* the
sentinel and cache it — but at HEAD every committed-truth motion invalidates
the cached sentinel coarsely (`cas` moves ⇒ `committedClocksQuiet` false ⇒ fp
recheck/refold), so the next drain re-runs the fn, re-reads `ctx.use`'s per-key
cache, and picks up the settled value. Under NF2 the sentinel is cached in a
plane value column and refolds only when a *marked atom reaches it over plane
links*. Resource settlement is not a write and has no fanout site. Schedule:
committed effect deps computed `C` which suspends on key K (sentinel cached in
R's plane); K settles; unrelated commits/retirements happen (their marks don't
reach `C`); the effect's re-check reads the cached sentinel forever — 16d's
"still-pending is not a flip" rule turns the missing invalidation into a
permanently silent effect. HEAD's accidental coarseness masked this; NF2's
precision exposes it. Since `ctx.use` is outside the oracle (§4.9.4(c)), the
referee of record is the React battery — which drives settlement through
component retry, not background caches, so the blind spot and the risk
coincide. Demand: a settlement re-mark site (`ctx.use` settle ⇒ mark the
holder node in every plane caching its sentinel), or an owner ruling + pinned
React-battery case accepting sentinel-until-cone-motion (against RCC-SU5's
"settlement re-evaluates the consumers that suspended").

### M3 — RUL-1: the plan's two resolutions are asymmetrically walked; resolution B does not merely "change production behavior," it LOSES fires (OL2 interaction), and resolution A needs two more pins than §2.5 lists

Resolution B (defer to next drain): schedule — write W lands in batch B already
committed into R (committed truth moves at the write, membership clause);
`useSignalEffect` on R deps the written atom; the user navigates; the effect
unmounts (cleanup runs) BEFORE B's retirement/next commit; RCC-OL2 forbids
post-teardown re-runs → the durable flip that occurred while the effect was
live is never observed. Under today's production (and resolution A) the effect
fired at the write. So B is not a timing shift; it drops side effects — the
strongest argument FOR the plan's recommended A, and it belongs in R1.
Resolution A (amend EF2): two under-specified observables need pins written
into 16b: (i) *chatter* — N member writes in one handler produce up to N
value-gated runs where B/React-commit timing would coalesce to one (EF2's
amended text must bless per-write firing or specify coalescing at the op
boundary); (ii) *effect-ahead-of-screen* — the effect observes committed truth
that the root's DOM does not yet show (the follow-up commit, fork test 18's
flush-split, lands later), so an effect that reads signals AND measures DOM
sees mixed generations. Both are today's production behavior; pinning them is
the point — but §2.5.4 currently names only "16b committed-member-write
immediacy," which under-specifies what 16b must assert. Mechanically, the
promoted refire-as-queue-kind keeps today's ordering (deliveries flush, their
listeners run, refires behind them in the same `flushNotify` sweep,
logged.ts:854-887; today's adapter revalidates after `bridge.write` returns,
shim.ts:577-589) — fine — but that equivalence deserves one ordering pin, not
an assertion in a table cell.

### M4 — The two-axis (action × world-policy) model does not describe watchers; the "three per-node indices collapse into one" claim is two-thirds true

Counterexample the plan's own table admits: the watcher row's policy cell is
"pass (render) / committed (drains)" — and the code adds a THIRD world:
watcher corrections during mount fixup evaluate in a `mountFix` world
(logged.ts:551, 3253+). A watcher's world is chosen **per operation**, not per
subscription; `policy` on the record is meaningful only for `run`
subscriptions. Of the 2×3 matrix, `deliver` inhabits no single policy,
`run/pass` is illegal (effects during render), and `run/newest` keeps
single-node semantics (no capture frame) while `run/committed` is multi-dep —
so the "one record" is a three-armed tagged union wearing one type. The plan
concedes "nominally, not structurally" for watchers, then §5.1 leans on "ONE
subscription index and one collection rule" as a P2 sequencing benefit — but
`run/committed` subscriptions are collected by **per-root full scan** (§2.2.4,
§4.4), not from the per-node index: post-P1 there are two collection
structures (per-node index for deliver + run/newest; per-root list for
run/committed). The honest claim is 3 indices → 1 index + 1 root-scoped list,
and P2's walk rewrite touches both. Amend the claim; the design itself is fine.

### M5 — The oracle co-evolution referees the promoted mechanism's registration/trigger surface, not its riskiest component: the capture frame

§2.5's schedule ops (`reactEffect{root, nodes[]}`, `reactEffectSwap`) drive
dep-list *contents*; the engine adapter "mirrors by re-registering a body
reading the new list." A static node-list body never exercises: the
suppression rule (reads inside a bound-computed evaluation belong to the
computed, not the effect — shim.ts:206-211, promoted into the core frame per
§2.2.2), mid-body throw semantics (partial snapshots), duplicate reads, or
capture-order effects on the `react-effect-run` event payload (§2.5.3 "gains
the captured values" — engine order is body read order, model order is list
order; an exact comparator will flake unless the payload is order-normalized
or value-only). So after P1 the F1 complaint recurs one level down in
miniature: the refereed thing is a configuration shim over the real frame.
Either extend ops (a `reactEffect` body variant that reads a computed whose
own deps include a listed atom, pinning suppression under lockstep) or declare
the frame adapter-battery-refereed the way `ctx.use` is declared
(`tests/SKIPPED-FOR-FORK-SUITE.md` precedent) — the plan currently claims
"the lockstep adapter drives the REAL mechanism" (P1.S2) without the caveat.

### M6 — R4's mitigation ("7456c7b pins stay green untouched") cannot detect the failure R4 itself predicts

The kept arm feeds `obsCapture` from plane/kernel link recording so retains
follow "the most recent evaluation in ANY world." The existing pins were
written when every world evaluation ran the fn-reader path, whose `evaluate`
epilogue does the capture (logged.ts:1688-1741, `recordEdge` capture at
1789-1793). P2.S-C moves world evaluations onto transliterated walks
(`wLink`/`wUpdate`); if the capture hook is forgotten there, obsDeps re-points
only at NEWEST evaluations — precisely the rejected arm's "retains follow
newest-evaluation deps only," arrived at silently — and the existing pins can
stay green if they drive re-points through newest/fn runs. Schedule to pin
BEFORE S-C: observed computed C with committed-world deps {A} and newest deps
{B} (world-divergent flag); drive a committed-world re-evaluation via a drain;
assert A gains/holds the retain and B's is released — through the WORLD path.
Also note RUL-2 compounds this surface: if promoted effect deps join the union,
every effect re-capture is a committed-world evaluation moving retains (R9
prices the obsShift traffic but not the S-C capture-path dependency).

---

## MINOR findings

### m1 — S-A's stated contents cannot deliver S-A's stated property

§4.8 S-A: "planes as the value store... memo ladder deleted... K1 still owns
delivery/drains; lockstep and battery green with zero semantic change." With
`validateMemo`/clocks/fp-scans deleted, plane values are only correct if the
fanout + all flip sites (§4.3 a/b/c — and B2's quiet site) land IN S-A; the
stage description names only structure/links/values and prices only "dual-write
cost" (edge recording). The stage that §6-R3 calls the fold isolation stage is
actually planes+fanout+flip-sites+folds — the majority of NF2's new write-path
logic. Restate S-A's contents honestly, and state the divergence detector
explicitly: per-op lockstep value snapshots + exact correction/effect streams
are the ONLY cross-check between old and new bookkeeping (the structural
validator checks each graph internally, not their agreement), and a mid-stage
mismatch is a STOP — the plan states that rule only for S-B comparator noise.

### m2 — Mount fixup's plane dependency imposes an ordering constraint §4.1 contradicts

§4.4: fixup's `dependencyClosureOf` walks "kernel + the mounting pass's plane."
§4.1: pass planes are "dropped in bulk at passEnd (commit or discard)." Fixup
runs INSIDE `passEnd(commit)` step (4) (logged.ts:2837-2841), after lock-in
drains; HEAD's pass-record reclamation runs last (logged.ts:2856). NF2 must pin
plane-drop after fixup (and after the re-staled loop, per M1) — one sentence
and one dev assert, but as written §4.1's rule invites dropping the plane at
frame-close, which empties every mount closure.

### m3 — The delivery-precedes-correction fuzz invariant is false at HEAD and will cry wolf

§4.4/§6-R2: "every watcher correction at drain time whose value changed must
have been preceded by a delivery or a scheduled corrective." Legitimate
counterexamples at HEAD: a correction caused by an abandoned batch's
retirement flipping an OLDER write visible (no write op since the watcher
mounted → no delivery to it); a watcher mounted after the causing write whose
fixup took the compare arm; quiet-mode corrections (no deliveries exist at
all). Scope it (e.g., "corrections caused by member-slot writes newer than the
watcher's last render") or it becomes either red noise or, after weakening,
decoration. As currently worded it also gold-plates: no RCC line demands
delivery-before-correction; SP5 demands the union of both.

### m4 — §4.3(b)'s "the locked-in token's atomsTouched" is singular; commits lock in SETS of tokens

`passEnd(commit)` iterates `maskTokenRecords` and locks in every still-live
mask token (logged.ts:2817-2834) — under entanglement a pass includes several
batches (RCC-CR1's "no less" was pinned against exactly this). Fanout at (b)
must run per locked-in token. The code shape makes this natural; the plan's
wording makes it easy to write once-per-commit. One-line fix.

### m5 — P1's "registration illegal inside an open evaluation/render frame — enforced, not assumed" overstates what core can enforce

Core can check its own evaluation depth and open frames; "on a render call
stack" is a host predicate (RCC-RT4 distinguishes them; the render context
lives behind `React.unstable_getRenderContext`, shim.ts:539). The core throw
covers evaluation frames; the render-stack half stays adapter-enforced. Say
which layer owns which half, or the L3-exclusion argument in §2.3 rests on an
assert that cannot fire in core for the case it names.

### m6 — §2.4 row 1's "all roots covered in both" hides a gating asymmetry worth one pin

Today `handleBatchRetired` → `revalidateEffects()` unconditionally for ALL
roots (shim.ts:449-460); the promoted path re-checks per root only when that
root's drain fires, and `retireInternal` gates drains on
`bits !== 0 || restaled` (logged.ts:3001-3008) — a write-free retirement drains
nothing. Value-gating makes the outcomes equal only if every committed-value
motion implies a drain-or-RUL-1 site firing for that root; that implication is
an invariant, currently unstated. State it (it holds: motion sources are
retirement-with-receipts, lock-in, member-write, settle→retire, quiet fold) and
pin the write-free-retirement no-fire case in battery 16.

## NOTES

- **N1 (gates).** §4.9.4(b) undersells the referee: `reconcile-correction` and
  `react-effect-run` are in the EXACT stream (cosignal/tests/helpers.ts:161-179;
  only delivery/suppressed/mount-corrective get the ⊆ bound), so
  required-delivery misses that change values ARE caught per-op at the next
  drain, not merely "as downstream divergence." The genuinely blind spots are
  lane placement (⊆-tolerant) and everything outside the model's vocabulary
  (ctx.use — which is where M2 lives). Precision here matters because it
  redirects scarce pinned-schedule effort toward M2's shape instead of
  duplicating what lockstep already polices.
- **N2 (R5 pricing).** The spike's idle-world fanout numbers (+1-10%) measured
  marks that were never consumed. A drain-heavy React app cycles
  mark→drain-consume→re-mark per commit, so the O(1)-after-first dedup resets
  every cycle; §4.9.5's head-bridge anchor re-proof should include a
  write+commit+drain cycling shape, not only write storms.
- **N3 (PR1).** The +0.5ns `Computed.state` branch is within PR1's "predictable
  branches" letter and the plan pins it — compliant, no finding; noted so the
  next reviewer doesn't re-litigate it.
- **N4 (RUL-2).** RCC-OL1's letter ("anything that subscribes") already reads
  as including effect dep snapshots, so "effects deliberately don't count" is
  an OL1 amendment, not an interpretation — the plan says exactly this;
  recording agreement so the ruling doesn't soften into a reading.

---

## Per-program verdicts and overall assessment

**Program 1: sound-with-amendments** — amendments: M3's two extra 16b pins and
the B-resolution loss schedule folded into R1; M4's honest restatement of the
collapse (index + root list) and of watcher policy as per-operation; M5's
referee-scope caveat (or the op extension); m5/m6 wording+pins. Nothing found
that invalidates promotion, the trigger inventory (§2.4 rows verified against
shim.ts:449-460, 489-511, 577-600 and logged.ts:2416-2423), or the deletes
ledger.

**Program 2: unsound as specified** — B1 (untracked value validation deleted
with no replacement; the plan's premise "untracked reads leave no link in any
design" is false at HEAD), B2 (plane lifecycle vs quiescence/quiet is
self-contradictory across §4.1/§4.5.7/§4.8/§4.9.6 and against P1 §2.4 row 4;
each consistent resolution has a walked failure and a missing mechanism —
quiet-fold fanout or a quiesce repopulation story), B3 (fp-gated mark
consumption at lock-in reintroduces the below-max visibility bug documented at
logged.ts:1531-1538). M1 additionally shows the §4.4 coverage argument's
central premise is carried by mechanisms (the passEnd re-staled loop, the
reveal compare) the plan neither names nor protects. All four have concrete
fix shapes; none is discretionary.

**Overall.** This is an unusually honest plan attacking the right two targets
in the right order, and its verification story (oracle-first, exact-stream
lockstep, staged landing, STOP-on-tolerance-noise) is strong enough that every
blocker above would eventually trip a gate. That is precisely why the plan is
not ready: each blocker is a place where the implementer, following the text
faithfully, builds a mechanism the gates then reject — B1 and B2 because the
spike (which had no folds, no untracked reads, no watchers, no drains, no
quiescence) could not have surfaced them, and B3 because the plan traded a
documented evict-never-fingerprint-rescue rule for a fingerprint. Program 1
can proceed once RUL-1/RUL-2 land with the M3 pins. Program 2 needs one more
design pass over §4.2-§4.5 — the untracked story, the plane lifecycle across
quiet/quiescence, the site-(b) decision procedure, and the committed-plane
population rule — before S-A is safe to start; with those closed, the
mechanism itself (segregated planes, fanout at committed-truth motion,
pass-plane pin immutability — whose RT1/UM2 derivation survives attack once
the fixup ordering in m2 is pinned) stands.
