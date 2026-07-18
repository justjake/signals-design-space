# Round 3 judgment (independent; fresh derivation)

Judged artifact: `rounds/round-03/synthesis.md`. That document is a delta
spec whose Part II states: "everything not named here carries forward from
the exit candidate verbatim" — so the design under judgment is
synthesis ∪ `design-exit-candidate.md` (read as incorporated normative
text, not as a competing draft). Not read: any review, any log, the
breaker draft, notes-diff, prior rounds. Seeds and INVARIANTS/SCARS read
in full. All battery cases re-walked; C1, C2, C4, C6, C7, C13 executed
step-by-step by me; every other case's written walk checked step-by-step
for hand-waving. Every by-construction claim attacked at least once.

**Result up front: 2 new confirmed blockers, both in repair-added rules
(R7's taint conjunct; R15/C9's compare-suppression rule). Both look
local-fix class, in-architecture. The rest of the round's new math —
stamp vectors, lock views, walkGen, lineage-stable stamps, value
revalidation, F9, saturation spillover, retired-carrier fallback — held
every attack I mounted. Exit not recommended (the synthesis itself agrees).**

---

## Part 1 — Battery re-walk

### C1 core (executed in full)

flag=false, a=0, b=0; c = flag ? a : b; W on c; canonical deps {flag, b}.

```
1 | k: flag.set(true)      | receipt(flag){true@s1,k}; K0 flag=true; wc[k]=s1; walk (walkGen g1) flag→c over K0: TS(flag)|=k, TS(c)|=k; W watched → setState(W) in k's stack (k's lanes); dedup(W,k) set
2 | k pass P1 (mask{k}, pin p1) reads c | TS(c)≠0 → world path; M(c,wk) EMPTY → world-eval frame: fold flag wk = true (slot k∈M, s1≤p1); reads a → fold a (empty tape) = 0 → c=0; K1 records REAL wk deps flag→c, a→c; edge-add a→c: TS(a)=0 ⇒ no bits to flow; memo stores value 0, r.seq, evaluator-stamp vector [(c, committedStamp)]
3 | k: a.set(1)             | receipt(a){1@s2,k}; K0 a=1; wc[k]=s2; walk (g2) from a over K0∪K1: K1 a→c reaches c; W: dedup(W,k) re-armed if W rendered at step 2, else step-1 update still pending — either way W is in k's render set
4 | k render, pin p2≥s2     | ladder for M(c,wk): epoch ok; stamp vector ok; wc[k]=s2 > r.seq → fp recheck: fp(a,wk) moved → re-evaluate: flag=true, a=1 → c=1; W renders 1 in k's lane BEFORE k commits
5 | committed reads         | fold: flag receipt invisible (k unretired/unlocked) → flag=false → c=b=0
outcome: matches Required. The trap (no canonical a→c edge) is closed structurally: the wk evaluation recorded a→c in K1 before the a-write, so the write walk reaches c; the wk cache is killed by wc[k], not by canonical topology.
```

T2/T3/T4/T5/T6/T7/T8-E/T9/T10 (base §18) re-verified step-by-step: each
step names its mechanism and the folds compute as claimed; T5's ordering
(k's pass pins after U's retirement) matches React's urgent-first
scheduling; T6's recycle hygiene is covered row-by-row in §15; T10's
queued retroactive delivery carries its own token per D10. T11′ (staged
evaluator), T12 (union cycle), T14 (saturation) re-executed — hold; my
attacks on them are in Part 2. **T13 (untracked taint) is where the round
breaks — see Blocker B1.**

### C2 (executed in full)

```
1 | event: a.set(1) → default token D | receipt(a){1@s1,D}; K0 a=1; wc[D]=s1; walk a→c (K0 edge): TS(a)|=D, TS(c)|=D; Wa,Wc setState in D's context
2 | flushSync(setState X)             | F2: SyncLane-only mask, D excluded (fork test 12); pin p≥s1
3 | Wa read                           | TS(a)∋D → world path: entry slot D ∉ mask, unretired, not in lock view → invisible → a=0 ✓
4 | Wc read                           | TS(c)∋D → M(c,wSync) EMPTY → world-eval reads a in-world = 0 → c=10 ✓ both old, no tear
5 | D renders later, retires          | a=1, c=11; fold; vSr(a) minted
outcome: matches Required. Trap (a): always-log held (D's urgent-classified write logged, I1). Trap (b): the downstream cone is off the fast path via the step-1 write walk (or ¬CT if c was never cached). C2-M: the sync-pass mount's rendered world excluded D ⇒ R15's skip check fails ⇒ runInBatch(D) corrective still scheduled — the new skip does not regress this.
```

### C4 (executed in full)

```
1 | T1: a.set(1) | receipt s1; walk (g1) a→c: setState(W) in T1's context; dedup(W,T1) set; TS={T1}
2 | T2: a.set(2) before any render | receipt s2; walk (g2) a→c: dedup is per-(watcher,slot) — (W,T2) unset → setState(W) in T2's context ✓
3 | T2 render | wT2={T2}∪retired: fold a = 2 (s1 invisible) ✓; T1 render later: 1 ✓
outcome: matches Required; I5 respected (no once-per-staleness state exists; marks gate routing, never delivery). walkGen is per-walk bookkeeping only — two writes = two walks = two deliveries.
```

### C6 (executed in full)

```
1 | batch() opens | defers CORE-effect flush only; no watcher-delivery deferral exists
2 | a.set(1) | currentBatchToken(): carrier null → event context → urgent token U; walk delivers a's cone setStates NOW in U's context → urgent lanes
3 | startTransition(() => b.set(2)) | inside scope: token T; walk delivers b's cone setStates NOW inside the scope → React assigns transition lanes; one T commit carries them
4 | batch() closes | core effects flush once (NEWEST contract)
outcome: "Handle it" resolution, mechanism named = per-write synchronous delivery in the writer's context (D5/D10). The trap's second half: implicit grouping must preserve context or not exist — I searched the design for any deferred watcher delivery; the only deferrals are core-effect flush (no lane context carried, no watcher setStates) and in-render edge-add deliveries, which are queued WITH their own token per entry (6.3′/T10). Answered by absence, verified.
```

### C7 (executed in full)

```
1 | T's pass P (mask{T}, pin p) yields | F2 pops the binding (per-callstack truth, I6)
2 | click reads a.state | no binding on this stack → NEWEST → K0 (includes T's applied write) ✓ newest world
3 | click a.set(5) | guard: no restricted frame → no throw; token = click's U; receipt{5@s9,U}; walk delivers in U's context ✓
4 | P resumes | binding re-pushed (mask{T}, pin p): folds exclude s9 > p → original pinned world ✓; compaction blocked below live pin p (§5.3 step 2); if the click's batch retires while P pinned: entries pin-blocked, slot unswept → bits retained (I10, T14); saturation force-clear flips P to fastPathDisabled → world-path-only (conservative, correct)
outcome: all three Required clauses met; S7's wall-clock scoping is structurally absent. C7-D: RENDER_NEWEST demotion fires on first write AND now on staging (6.1′) with original pins retained.
```

### C13 (executed in full — row audit + schedules)

Master table (§15.1 + §15′ rows) audited row-by-row: every counter/stamp
names mint, observers, clear site paired with the identity it outlives,
and a forced test. Schedules executed: episode straggler memo → dead via
epoch-in-key; forced-small globalSeq → renumber rewrites baseSeq/vSr/
lockStamps-in-views/fnStamps/lineage-cache stamps/lastRetireSeq + lastWalk
sweep (§15.2 amended list is complete against the state table — I
cross-checked every stamp-bearing row); never-quiescent → hard diagnostic
throw; token wrap under 31 parked actions → live-skip + entanglement;
K1 tag wrap → full sweep; slot recycle with lock views → records cleared
after retirement stamps exist, pooled views gen-bumped, stale lockViewId
⇒ worldKey mismatch; saturation force-clear → retired entries stay
visible slot-free (retired clause needs no slot), new tenant's wc guarded
by pins (my aliasing attack failed — a pre-clear pass's pin excludes the
new tenant's seqs, and post-clear passes pin above retireSeq(k*)).
Outcome: C13 walks; I8/I19 discipline held everywhere I probed.

### Other cases (design's walks verified step-by-step)

- **C3 + C3-E + C3-R**: fold arithmetic re-computed by hand — 2/2/4/4 and
  5-not-6 exact; compaction prefix-block makes 3-not-4 unrepresentable;
  C3-R's F9-before-folds ordering makes fold-under-old-reducer
  unrepresentable (fork test 23); React parity of the promoted-reducer
  re-fold checks out (React folds queued actions with the current
  committed closure). ✓
- **C5**: value-blind delivery + wc-gated memo → 7 delivered in k's lane;
  first evaluation's 0 cannot be served. ✓
- **C8**: R13's world-invariant-op restriction leaves the plain-set drop
  legal only on empty history; U's equal write appends; truncation
  unrepresentable. ✓
- **C9**: (a)(b) reads correct (eager world-routing of fresh nodes via
  ¬CT). **The fixup's new suppression rule is Blocker B2.**
- **C10 + C10-R**: main path and race (ii) hold; race (i) depends on the
  committed compare — captured under B2.
- **C11 + C11-W + C11-A**: lock views re-keyed per advance
  (lockViewId in worldKey), every advance mints a lockStamp, effect
  enumeration durable via touchedList; watermark construction held
  (same-root pass/advance serialization, fork test 24); cross-root
  starvation attack failed (lockTerm is per-root by construction);
  retire-handover ordering pinned (clear after stamps exist). ✓
- **C12 + C12-U + C12-T + C12-F**: parking/identity separation intact;
  scheduler shims give registration-time capture (AsyncContext parity for
  the enumerated registrars); retired-carrier → ambient + warn is total
  and rung-uniform; the mixed-boundary refutation of the codex blockers
  is legitimate — I30 (monitor-curated, measured) states the boundary,
  the self-test, and the support-matrix line verbatim; the synthesis
  additionally shrank the class (shims, ActionScope) and fixed the matrix
  wording. Within the declared matrix C12 walks verbatim. ✓
- **C14**: lineage stage cache makes re-staging idempotent across replays
  AND retries; render-phase writes throw pre-mutation; flap damping;
  positional thenables per lineage. ✓
- **C15**: retry stability now provable (lineage-stable stamps — the
  refetch-forever schedule I ran against staging comes back stamp-equal);
  5′/5″ value revalidation distinguishes genuine content change from
  content-neutral flips at the cost of one fold. ✓
- **C16 + B1 + C16-D**: targeted flush excludes the pending default
  write; vSr/lockStamp move snapshots on flips; effects ride React's
  native deps re-fire (no F9) — the dead-edge schedule cannot arise. ✓
- **C17**: closed by deletion (no truncation surface); legitimate. ✓
- **T8-N**: refresh + cone carry + two-strike termination — see H3 for a
  spec ambiguity in the carry traversal; the asserted property is the
  right one.

---

## Blocker B1 — WORLD_TAINT does not propagate through tracked reads of tainted caches (invariant R clause 2's construction is false)

R7's repair is node-local: `WORLD_TAINT(n)` is "recomputed at every K0
(NEWEST) evaluation of n: set iff, during that evaluation, an untracked
signal read hit an atom with a non-empty tape" (§3′), and routing checks
`¬WORLD_TAINT(n)` on the read target only (§6.2′). Invariant R clause 2
claims: "any K0 cache that could embed a pending value was produced by an
evaluation whose untracked read hit a non-empty tape, which set
WORLD_TAINT(n)." That premise is false one level downstream — a K0 cache
can embed a pending value through a **tracked** read of a tainted
computed's cache, and the consumer's own evaluation performs no untracked
read.

Failing schedule (legal user code; all mechanisms named):

```
setup | atoms a=0, d=0, b=0; m = d.state + untracked(() => a.state); c = m.state + b.state
      | committed K0 caches m=0, c=0; K0 edges d→m, m→c, b→c; NO edge from a (untracked)
1 | deferred T: a.set(1)      | receipt{1@s1,T}; K0 a=1; walk from a: a has no out-edges → marks nothing; TS(m)=TS(c)=0
2 | urgent U: d.set(2)        | receipt{2@s2,U}; walk d→m→c marks U's bit; U renders in-world (m: fold d=2, untracked a folds IN-WORLD = 0 → m=2; c=2) ✓ correct; U commits, retires; fold compacts d; U's slot swept → U bits cleared
3 | NEWEST pull of c (core-effect flush at U's retirement, or any newest read) | K0: d moved → m re-evaluates at NEWEST: reads d=2; untracked read of a hits NON-empty tape → WT(m):=1; m caches 3 (embeds T's pending a=1); c re-evaluates: reads m TRACKED → serves m's K0 cache 3; reads b=0 → c caches 3; c's evaluation did NO untracked read → WT(c):=0 (recomputed at this evaluation); CT(m)=CT(c)=true; TS(m)=TS(c)=0
4 | any T-excluding render (flushSync per C2, or any urgent pass while T pends) reads c | fastPath(c): TS(c)=0 ✓, CT ✓, ¬WT(c) ✓, no stage ✓, no saturation ✓ → SERVES K0's c=3
5 | same pass reads m (sibling component) | WT(m)=1 → world path → fold d=2 (retired), untracked a in-world = 0 (T excluded) → m=2
outcome: one pass, one world: m=2 and c=3 where c ≡ m + b = 2 — c's rendered value embeds T's pending write in a world that excludes T. Urgent commit → torn committed frame. The fixup fast-out (11.2′ line 1) has the same hole for mounts.
```

This is the I17 lesson (node-local fixup is insufficient for a
path-transitive property) recurring in the taint dimension, and it defeats
the design's own adjudication note on #12 ("the repair is a node-grain
routing taint"): node-grain taint without propagation is not closed.
Repair class: **local, in-architecture** — during a K0 evaluation, OR the
WT bit of every dep whose cached value is consumed into the consumer's WT
(one flag OR per dep load, LOGGED only; G-Q ledger row), or refuse WT
propagation-free serves the way marks flow through edge-adds. But as
specified, invariant R's clause-2 construction is broken and T13 does not
cover the transitive case. **New confirmed blocker.**

## Blocker B2 — R15/C9's committed-compare suppression rule contradicts its own retire-race walk and misses mixed-token divergence

Synthesis C9 step 2′ introduces mid-walk: "RULE (normative): the
committed compare is suppressed when every slot in touchedSlots(n) ∩ live
passed the R15 inclusion check…; it fires otherwise (retire-race,
excluded-token divergence)." Step 3′ then asserts: "k retired in the
window → k not live → inclusion check vacuous → compare FIRES."

(a) **The rule and the walk contradict.** With k retired,
touchedSlots(n) ∩ live = ∅, and ∀ over the empty set is TRUE — the rule
as written SUPPRESSES exactly where the walk says FIRES. Under the
literal rule, C10-R(i) re-breaks: k retires inside W's render→layout
window; the live-token loop finds nothing; the reconcile backstop at k's
retirement ran before W's watcher existed (subscribe happens at layout);
the compare was the only corrector and the rule suppressed it → W commits
stale committed-world output → torn committed frame with no pre-paint
correction. This is the design's own I18 fallback being disabled by its
own new guard.

(b) **Even the charitable "fires when vacuous" patch fails the mixed
case the walk itself names as a residual test row.** n depends on x
(written by k) and y (written by j): TS(n) = {k, j}. W mounts inside k's
own pass (k passes the inclusion check: k ∈ rendered mask, wc[k] ≤ pin);
j is live-unretired at W's render (j ∉ mask → excluded from v_rendered),
and j retires during W's render→layout window. At layout: the live loop
skips k (correct) and cannot schedule j (not live); the rule sees
TS ∩ live = {k}, all passed → SUPPRESSED. But v_now (committed-for-root,
which by R11 already includes k's lock-in and j's fold) differs from
v_rendered by exactly j's newly-visible write; j's backstop pre-dated W's
subscription; nothing corrects W. Torn committed frame.

The guard needs a retired-slot term the design already has state for
(touched slot retiredSeq vs renderedPassPin, or per-atom retireVisStamp
vs the pass pin): suppress only when every touched **live** slot passed
inclusion AND no touched slot retired since the rendered pin. Repair
class: **local, in-architecture** — but as written the normative rule is
self-contradictory and reopens a walked race. **New confirmed blocker.**

---

## Part 2 — Construction audit (every by-construction claim, attacked)

| construction | attack attempted | verdict |
|---|---|---|
| Invariant R, 4-source enumeration (§6.2′) | two-level untracked embed (B1) | **BROKEN** at clause 2; clauses 1/3/4 held my attacks (fresh-pull S9 attack blocked by CT; staging attack blocked by probe + demotion; slot-erasure attack blocked by I10 gating + spillover) |
| Invariant M induction (§6.3/6.3′) | cutoff-cleaned intermediate (T9 shape), displacement (T8-E), late-edge joint pass (T10), delivery-context enumeration | held — event kinds enumerated, edge-add flows bits through existing out-edges AND delivers retroactively; 6.3′'s context list now exhaustive |
| Staged-evaluator confinement + F9 selection (§11.1/11.1′) | hidden-Offscreen publish, error-abandoned subtree, stale alternate CAS, RENDER_NEWEST leak, pre-promotion NEWEST serve, parent-memo staleness | held — staging demotes (6.1′), F9 dirties K0, stamp vectors checked at ladder step 2 before any serve |
| Lineage-stable stamps (R9) | suspense retry re-mint (the livelock schedule) | held — retry hits the lineage cache, stamps compare equal; unstable user deps degrade to React's own useMemo-churn behavior, documented |
| Watermark / lock views (§5.2′, C11-W/C11-A) | cross-root starvation, advance-vs-open-pass race, retire-handover stamp gap | held — per-(root, slot) stamps, F2 same-root serialization (test 24), clear-after-stamps ordering |
| walkGen termination (6.2″) | union cycle (T12), nested write from sync core-effect flush, wrap | held — per-walk generation; nested writes get their own walk; renumber sweep row exists |
| Saturation spillover (R8/T14) | slot aliasing after force-clear; pass-pin boundary cases | held — retired-clause visibility is slot-free; pins exclude the new tenant's seqs; flagged passes world-route wholesale |
| Value revalidation (R11/9.2′) | custom-equality flip, included equal-value write, evaluator flip | held — equality decided per world against the fold; evaluator mismatches never value-revalidate |
| Carrier induction (12.1′) | timer-invoked async callback (the R5 hole), fire-and-forget child post-settle (R6), unshimmed registrar | held **within the declared boundary** — shims give registration-time capture; retired-carrier policy is total; residual class enumerated, dev-warned, I30-sanctioned |
| E-PRESERVE strong reading + no-receipt safety (§7′) | drop a→c at true zero-receipt quiescence, then deferred write to a | held — resurrecting the displaced branch requires a receipt on the branching dep, whose retained canonical edge marks the cone; BUT the claim cites "walk C1-T8E′" **which does not exist in either document** (see H2) |
| Two-strike refresh termination (§5.4′) | rank arithmetic; unbounded-new-work | held — R strictly decreases; new work delegated to the loop budget throw |
| R15 inclusion-skip + compare suppression (11.2′ + C9 2′) | vacuous and mixed retire-window schedules | **BROKEN** (B2) |

Secondary findings (not blockers):

- **H1 (NOTE)**: §6.2′ clause 2 cites "I33"; INVARIANTS.md ends at I30 —
  a dangling citation for the licensed-staleness premise the clause leans
  on. The inline argument stands on untracked's definition, but the
  invariant it names does not exist yet.
- **H2 (NOTE)**: §7′ and Part I #19 cite "walk C1-T8E′" twice; no such
  walk exists (C1 lists Core, T2–T10, T11′–T14). The claim it should
  carry survived my attack, but a by-construction claim citing a
  nonexistent walk is exactly the discipline the loop exists to enforce.
- **H3 (MEDIUM)**: §5.4′'s cone carry says "traverse K1 in-edges to fixed
  point" while asserting "mixed K0/K1 paths stay connected because K0
  persists." For x→(K1)u→(K0)v→(K1)w, a K1-only reverse traversal from w
  stops at v and never copies x→u; the asserted property holds only under
  a reverse-traversal of K0∪K1 that copies the K1 edges encountered. The
  intended reading is stated adjacent, but the algorithm line
  under-specifies it and no mixed-path test row is named.

---

## Part 3 — Scores

**correctness = 6.** The battery is walked at unusual depth (C1 family of
14; 8 new named schedules), the fold arithmetic is exact everywhere I
re-computed it, and the round-2-class repairs all held adversarial
re-derivation. But I confirmed two new blockers, both torn-committed-frame
class, both introduced by this round's own repairs (R7's node-local taint;
R15/C9's suppression rule — the latter contradicting its own walk within
the same document). Both have clear in-architecture repairs, which is why
this is a 6 and not lower; they are real, schedulable wrongness, which is
why it is not higher.

**mechanisms = 5.** I counted from the spec, not the inventory: the 10
clusters are honest groupings, but the master state table now carries ~24
cooperating stateful items, and this round alone added walkGen, lock
views + lockStamps, WORLD_TAINT, the staged probe, the lineage stage
cache, the saturation trio, F9 publication CAS, scheduler shims,
ActionScope, and realm nonces. The obligations are mostly structural in
exactly the way the seeds reward — closed change-source table, event-kind
inductions, per-row lifecycle clears with forced tests — but two carry
semantic completeness burdens: WORLD_TAINT's ("any cache that could embed
a pending value…"), which has already failed (B1), and E-PRESERVE's,
which is honestly delegated to a CI fuzz gate. The direction of travel is
a widening compensation stack, each piece schedule-justified but
cumulatively heavy.

**seam = 8.** F1–F9 cover every fact the charter requires (classification,
pass lifecycle **with yield/resume**, retirement + per-root lock-in +
async parking, lane-scoped scheduling, lineage, mutation window) plus
handshake, action scope, and the new F9 — each edge-triggered from a site
the reconciler already mutates, each with reconciler-level tests (27
fork/build tests enumerated), integers-and-callbacks only, loud
version-skew failure. The rebase drill is answered per-fact and the
answers are the right shape ("the library moves zero lines; the fork
re-implements the fact; the test is the tripwire"), including for F9's
commit-phase re-anchor. Docked two points: ~16 touch sites and two new
load-bearing reconciler assertions (same-root advance serialization;
F9-before-folds ordering) rest on tests not yet demonstrated against a
current React generation — the design itself flags G4 as its biggest
external risk.

**performance = 8.** Every hot mechanism sits in a gate row with either a
measured number with provenance ([ARENA] donor deltas, [SPKHQ→O19]
LOGGED-quiet floor honestly marked AT RISK with a pre-registered
renegotiation, I30 carrier numbers) or an UNMEASURED flag bound to a
named spike with a decision rule (SPK-L/N1/G8/W/R, SP2). The G-R
comparator fix (split core/react, no zero denominator) is the kind of
honesty the axis rewards. New hot-path costs added by the repairs (taint
branch, staged probe, walkGen stamp, lockTerm) are enumerated into
existing CI-checked ledgers rather than asserted free — acceptable,
though "no new spike is required by the repairs" leans on those ledgers
catching regressions. Nothing I found contradicts research-facts.md: K0
stays closed, world state lives beside it, always-log is priced, and the
expensive eager-per-write-world-evaluation shape is structurally absent.

**explainability = 7.** The one-page story genuinely covers every
mechanism I counted — including this round's additions — in mostly plain
English, and every concept is defined before use across §3/§3′. Docked
for: the final design existing only as base-plus-delta across two
documents (the exit candidate's X4 self-containment promise no longer
holds for the synthesis); a normative rule being minted mid-walk complete
with visible self-argument ("?? NO — walk:") in C9; and two dangling
citations (I33, C1-T8E′) in load-bearing constructions.

---

## Verdict

Blockers found: **B1** (transitive WORLD_TAINT hole → fast path serves a
pending-value-embedding cache to an excluding world; torn frame) and
**B2** (R15/C9 compare-suppression rule self-contradicts and misses
retired-slot divergence; torn frame in the retire-race and mixed-token
windows). Both are repairs-of-repairs: local-fix class, in-architecture,
with the needed state already present (dep-WT propagation; retired-since-
pin term). Architecture-changing open spikes: the SPK-N1/SPK-G8/SPK-L
performance cluster is the one contingency that could swap the K1
architecture for the compensated-single-kernel fallback (per the design's
own O1 disposition); each spike alone has a named in-architecture
fallback, so I count the cluster once.

```
VERDICT
new_confirmed_blockers: 2
scores: correctness=6 mechanisms=5 seam=8 performance=8 explainability=7
open_spikes_that_could_change_architecture: 1
exit_recommended: no   # blockers > 0
one_line: The two-kernel champion's 25 repairs mostly survive fresh attack, but the round minted two new torn-frame blockers of its own — untracked taint that does not propagate through tracked serves, and a mount-fixup suppression rule that contradicts its own retire-race walk — repairable in-architecture, not exit-ready.
```
