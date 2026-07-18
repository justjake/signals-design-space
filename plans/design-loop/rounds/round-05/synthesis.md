# Round 5 synthesis — the surgical champion, with version visibility completed

Status: the round's single repaired final design. **Normative composition**
(three documents, innermost first): `rounds/round-04/design-consolidate-a.md`
(self-contained base) ← `rounds/round-04/synthesis.md` (R1–R14, T1–T4) ←
**this file** (RS1–RS7 + the adopted surgical-a deltas listed in §0). Where
this file replaces a rule it gives **full replacement text**, so
`design-surgical-a.md` is provenance, not a normative link. Architecture
class unchanged (D8/D12): donor kernel K0 + receipt tape + world-edge plane
K1 + clocks/stamps + value-blind delivery + co-designed fork. Zero new
mechanisms; the round's biggest repair (RS1) makes evaluator versions ride
machinery receipts already own.

---

## Part I — Adjudication of every review finding

Fifteen findings across four reviews. ≡ marks the same defect found twice.
Verdicts: **13 CONFIRMED, 2 REFUTED, 0 NEEDS-MEASUREMENT.** No finding
silently dropped.

| # | finding (design, reviewer) | verdict | resolution |
|---|---|---|---|
| 1 | b-codex 1 — pin-only evaluator visibility tears a lagging root: a T-excluding urgent pass with pin > promotedAtSeq selects the promoted version by chronology; one committed root frame holds two evaluator versions | **CONFIRMED — and cross-design**: the rule is the round-4 champion's R1 (`greatest promotedAtSeq ≤ pin`), carried verbatim by BOTH round-5 designs. Re-derived against surgical-a: Δ1's marks don't fire (no raced pin at promotion; the mounting pass pins after q), and even the world path resolves e1 at pin p2 > q. Walked as C11-E kill below. The champion's own phrase "exactly analogous to tape entries" was implemented for the retired clause only — promotion was treated as instantly-globally-retired | Repair **RS1**: version entries carry their promoting token and ride the full three-clause receipt visibility rule; retention = tape compaction verbatim |
| 2 | a-claude F1 ≡ a-codex 1 — Q2's commit-entry fast-out returns for a watcher whose rendering pass is not the committing pass (Offscreen/Activity reveal) while the commit's own folds move truth outside w_r.mask → permanent torn committed DOM (K3) | **CONFIRMED** (two independent schedules, same population hole; §3.3's "fails conjunct 1" dispatch is asserted, not constructed, and false in a quiet app) | Repair **RS3**: conjunct 0 — the watcher's rendering pass IS the committing pass (generation-checked pass id already shipped); reveal-shaped mounts fall through to loop + w_fx |
| 3 | a-claude F2 — Δ1's oldestLivePin scan always includes the committing pass's own frame: the zero-cost branch is dead code; two §7 pricing rows false | **CONFIRMED** (frame lifetime [passStart, passEnd) per Δ6; q minted after pass start ⇒ own pin < q always) | Repair **RS2**: exclude the committing frame (soundness: it cannot evaluate after F9; its memos are unreachable by future worldKeys) — merged into the RS1-extended marking condition |
| 4 | a-codex 2 — R8's horizon slack ("≥ one atomic extent's mints") has no finite construction: a synchronous commit can publish arbitrarily many hooks; wrap mid-extent with a live pin re-enters S38(a) | **CONFIRMED** (spec gap of the C13/I8 class; the champion's "at a mint that would cross H, at the current operation boundary" is ambiguous between check-at-mint-defer-to-next-boundary — unsound — and check-at-entry — sound but unstated) | Repair **RS5**: horizon check at atomic-extent ENTRY with a documented runtime-computable reserve; loud invariant throw as the dead-code backstop; forced-tiny-H test |
| 5 | a-codex 3 — the artifact omits its normative base; unchanged cases (C3 compaction etc.) are unreviewable | **REFUTED as a blocker**: LOOP.md's isolation rule explicitly passes the champion artifact across rounds, and NOTES D12 defines the champion as `round-04/synthesis.md` + its incorporated base; the round-5 docket ("repair the judge's 2 blockers with MINIMAL diffs") is impossible without reading it; both claude reviewers and the round-4 judge worked the composite, and the composite does contain the C3 compaction rule (consolidate-a prefix-clause compaction; judge re-walked C3 at full depth, PASS). Residue accepted: exit deliverable includes a mechanically merged single document (OPEN note) | Documentation task, not a design defect |
| 6 | a-codex 4 — synthetic version entries lack slot-incarnation lifecycle identity: force-clear + slot recycle makes reclamation decrement the wrong incarnation (→ bit under-count → C2-class tear) or never decrement (→ slot leak) | **CONFIRMED** (I19 class: "counts as" needs concrete state) | Repair inside **RS1**: the version entry is a real slot(t) tape-class entry carrying its never-reused token; force-clear marks it swept (idempotent, no later decrement); payload reclamation is by the compaction rule, never by slot counts. The abstract relation becomes the existing entry lifecycle |
| 7 | a-claude F3 — Δ7's "insert a trivial update" forced-discard is asynchronous, contradicting R8's synchronous discard-then-rewrite precondition | **CONFIRMED** (insertion abandons WIP at the root's next scheduler slice, not at the operation boundary; the gap re-enters S38(a)) | Repair **RS6**: name synchronous `discardAllWip` a fork capability inside F2 (surgical-b's F2 text already carried it); fork test 36; the insertion trick deleted |
| 8 | a-claude N1 — whether cas bumps on receipt-less retirements is unspecified | **CONFIRMED** (underspecification; conjunct-1 hit rates depend on it) | Repair **RS7**: cas advances exactly when committed-side state mutates (fold touching ≥1 entry, lock-in/advance, promotion); pure-empty retirements bump nothing; correctness never leans on incidental bumps (RS3 carries the reveal population) |
| 9 | b-claude F1 — S5-R1's evaluator basis for K0-served values is unconstructed state: no mechanism records/maintains per-K0-node vectors; fixup fast-out either false-matches a refreshed basis (walked torn frame) or conservatively always-folds (self-rejecting on the design's own gate) | **CONFIRMED** (schedule re-derived; consolidate-a §8 keeps vectors on world memos and suspense prefixes only). Consequence: S5-R1 is **rejected**, not repaired — see Part II | Rejection rationale (SCAR proposal S41) |
| 10 | b-claude F2 — basis stamps absent from §15 ledger and R8 duty list ("an omitted seq-bearing field is fatal" by the design's own standard) | **CONFIRMED** against surgical-b as written; moot on rejection of S5-R1. The lesson is honored in RS1: its one new field is a token (separate, never-renumbered counter domain); promotedAtSeq/retiredSeq were already on the duty list | Rejection rationale |
| 11 | b-claude F3 — exact-stamp routing creates permanent fast-path-loss classes (cutoff-preserved parents; reducers promoted with empty tapes) | **CONFIRMED** against surgical-b; moot on rejection. RS1/Δ1 routing has no analog: bits clear at slot sweep, which the compaction rule reaches | Rejection rationale |
| 12 | b-claude F4 — the recording half of the basis is an unpriced hot-path obligation (O(D) merge per LOGGED K0 recompute — the cost class that killed per-link world bits) | **CONFIRMED** against surgical-b; moot on rejection; decisive for Part II's choice | Rejection rationale |
| 13 | b-claude F5 — "equality records the current basis" has no home | **CONFIRMED** (dangling clause); moot on rejection | — |
| 14 | b-codex 2 — normative design outside the review boundary (C2 walk unreviewable) | **REFUTED as a blocker**, same grounds as #5; C2's gate exists in the composite (consolidate-a routing; round-4 judge walked C2 PASS) | Same documentation task |
| 15 | claude-a verified-held 4 (b-claude VH-4's class, filed by neither as a finding; surfaced by this synthesis's battery re-walk) — a pass-visible stage whose owner hook error-abandons publishes nothing; outside-boundary consumers commit never-promoted output with no receipt, no touched bit, no drain path, no fixup (for already-subscribed watchers) | **CONFIRMED by synthesis re-walk** (Step-2 duty; walked as C1-X7 below). Not attributable to either round-5 diff — it is a champion-level hole in R3/P4 that the deletion-vs-fast-out debate exposed | Repair **RS4**: P4′ unpublished-stage reconcile + one fixup conjunct |

Reviewer disagreements resolved by walk, not vote: (a) b-codex "architecturally
unsound" vs b-claude "repairable" — both are right about different strata:
the unsound verdict attaches to the **pin-only visibility rule**, which is the
champion's (finding 1, repaired in-architecture by RS1 with receipt machinery);
surgical-b's *distinctive* machinery (basis routing) independently fails
findings 9–13 and is rejected. (b) a-claude 1-blocker vs a-codex 3-blocker:
codex's extra two are the horizon gap (confirmed, RS5) and the process finding
(refuted, #5).

---

## Part II — Architecture choice and the rejected list

**Winner: surgical-a** (its Δ1/Δ4 repair line over the round-4 champion),
because its routing repair confines all new cost to **promotion events** and
survived every counter-schedule from both reviewers (wash-out, E-PRESERVE
re-track seam, slot-choice, saturation, renumber — attacked and held), while
surgical-b's routing repair rests on per-K0-node basis state that nothing
constructs (finding 9), prices vector merges onto the donor kernel's recompute
epilogue (finding 12 — the measured "invades every hot walk" cost class), and
mints permanent fast-path-loss classes (finding 11). Reads under surgical-a
stay one-word checks.

**REJECTED from surgical-b** (one line each):

- **S5-R1 exact-basis routing (EB0/EBr→c)**: findings 9–13 — unconstructed
  K0-side state; hot-path recording; ledger omission; permanent routing loss.
  Its one genuine insight — the old staged-only probe missed downstream
  consumers of a staged node — is already covered in the champion by R3
  seeding + the staging walk, and by Δ1 bits for promotions.
- **S5-R12 deletion of the fast-out**: re-opens round-4's CONFIRMED row 16
  (per-mount w_fx evals in exactly P1's measured window) with "no fallback
  authorized"; its safety argument for the evaluator window leaned on EBr→c
  (finding 9). Q2 with RS3's population gate achieves the same coverage with
  a proven partition. Two of its by-product kills are kept as pinned tests
  (S5-R12-A ≡ K2a-class; the error-abandoned-stage mount variant → C1-X7(b)).
- Retained from surgical-b anyway: the F2 `discardAllWip` naming (RS6), the
  R2 clarification that "includes s" means the **render mask**, never the
  lock view (its rewalk + b-claude VH-6 both verify: a lock-view-only pass
  does not consume the pending lane update, so the scheduled work survives),
  and its full fork-test restatement style (tests table).

**REJECTED from surgical-a** (superseded by this file):

- Δ1's marking trigger "any live pin < q" — wrong twice: dead branch
  (finding 3) and under-marks for spanning/parked promotions once RS1 lands
  (a pass pinned AFTER q can still exclude the version). Replaced by P2″.
- Δ1's synthetic-entry bookkeeping (`retiredSeq = q` field reuse) — replaced
  by RS1's real tape-class entry (finding 6).
- Q2's three-conjunct fast-out without a population gate — finding 2;
  replaced by Q2′ (five conjuncts).
- Δ7(iii)'s trivial-update forced-discard note — finding 7; replaced by RS6.
- The pin-resolution rule inherited from champion R1 — finding 1; replaced by
  RS1 (this is a champion repair both designs needed).

Adopted from surgical-a verbatim (audited, kept): Δ2's invariant-R source-3
rewrite shape (re-based on RS1 below), Δ3's lifecycle-row discipline, Δ6
(R2 "all open frames", lifetime [passStart, passEnd(commit|discard))), Δ7's
two wording pins minus the discard note, Δ8's gate rows (amended §7), fork
tests 34–35, and its verified-held register VH-R2/R3/R4/R8/R9 (spot re-walked;
see Part IV).

---

## Part III — The repairs (normative replacement text + constructions)

### RS1 — Evaluator versions are token'd entries under the full visibility rule

*(Repairs findings 1 and 6; replaces champion R1's effStamp resolution rule
and retention rule, and surgical-a Δ1's synthetic-entry bookkeeping.
P1′/P3′/P4, demotion, ladder-compare-against-effStamp, I40 stamp installation
all carry.)*

**Version entry.** A promotion at F9 appends to the hook's version chain the
entry `{fn, deps, stamp, token t, promotedAtSeq q}` where
`t = F1.currentBatchToken()` sampled in the F9 emission context (fork test 35;
minted lazily if the batch never wrote). `retiredSeq(t)` attaches when t
retires, exactly as for receipts. Tokens are never reused (F1), so the entry's
identity is unambiguous across slot recycling — finding 6's incarnation
problem does not exist for it.

**Resolution rule (replaces "greatest promotedAtSeq ≤ world.pin").**
`effStamp(e, w)` = the stage in this pass's `passStages` if present; else the
newest chain entry **visible in w** under the seed visibility rule verbatim:

```
visible(entry, w) :=  (t retired ∧ retiredSeq(t) ≤ w.pin)
                    ∨ (t ∈ w.mask ∧ q ≤ w.pin)
                    ∨ (t ∈ w.lockView ∧ q ≤ w.lockView[t].watermark)
```

NEWEST resolves newest-applied (K0's basis — same as receipts, which K0
applies eagerly). Committed-for-root(R) resolves via R's lock view + the
retired clause — **root-scoped**, which is the repair. Selection is
newest-visible; per-world monotone because a fixed world header's clause
answers are fixed and committed-for-root worlds only gain visibility.
Versions REPLACE (they are not folded); a world may lawfully skip an
invisible intermediate version — documented semantics, consistent with I22's
"version, not delta" treatment of evaluators.

**Retention/compaction (tape discipline verbatim).** A chain entry's
predecessor payload is reclaimable when the entry is universally visible:
`t fully retired ∧ min(live pins) ≥ retiredSeq(t)`. The entry then becomes
the chain base. Until then the entry counts in slot(t)'s unswept-entry gate
(I10/I39) like any receipt. Force-clear (targets fully-retired slots only)
marks the entry **swept** — an idempotent bit; reclamation is by the
compaction rule above and never decrements a recycled slot incarnation's
count (finding 6's both horns closed); excluded pins get `fastPathDisabled`
via maxRetiredSeq exactly as for receipts (I39/I51). Renumber duty: q and
retiredSeq are already duty-list members; t is a token serial (separate,
never-renumbered domain).

**Construction (invariant R, source 3 — replaces Δ2's text).** A *staged*
evaluator is excluded by the pass-frame probe and demotes RENDER_NEWEST
(unchanged). For a *promoted* entry E = {…, t, q}, worlds divide by
`visible(E, ·)`:

- Visible worlds (NEWEST; committed-for-root of roots holding t in their
  lock view or after t's retirement; passes including t, or pinned ≥
  retiredSeq(t)): the P2″ K0-dirty forces the next serve through a recompute
  under E; fast-path serves are then version-correct for exactly these
  worlds.
- Invisible worlds exist while (a) a pass pinned < q lives, or (b) t is
  unretired and some root/pass excludes it, or (c) t retired at rs and a
  pass pinned < rs lives. P2″ marks the promoted cone with slot(t) in every
  such situation (its condition below is the disjunction of (a)–(c)'s
  possibility), the bits outlive every invisible world by the sweep gate
  (compaction requires universal visibility), and edge-add propagation +
  the I4 first-divergence argument (re-branching into the node needs its own
  walked change) extend reach to later-recorded edges. Marked ⇒ world path ⇒
  effStamp resolves per visibility. The bit, not the dirt, carries routing —
  unchanged from surgical-a's repaired discipline, now with the correct
  invisible-world enumeration. ∎

**The kill this repairs, walked (C11-E; pinned).** Champion rule, either
round-5 design as written:

```
setup | stageable computed c, owner hook on root A, committed e0 (c=1); W_old subscribed on root B (DOM 1); zero receipts
1 | startTransition T: A's pass renders; hook stages e1 | stage lineage-scoped to A; B unaffected
2 | A commits T: F9 promotes {e1, q}; P3′ walks value-blind | W_old setState in T's context → scheduled on B in T's lanes → T now has B work → T does NOT retire; lock view(A) ∋ T
3 | urgent U on B mounts W_new (pin p2 > q, mask {U}, LV(B) ∌ T); W_old bails (its pending lanes are T's, excluded) | OLD RULE: effStamp(c, w_U) = greatest q ≤ p2 = e1 → W_new renders 10 (or the K0 fast path serves a recomputed e1 cache — same value)
4 | U commits B | committed root-B frame: W_old = 1, W_new = 10 — TORN (two evaluator versions in one root); fixup agrees with the wrong value (committed-for-root(B) also resolved "at now"); correction waits for B's T render — deferred-lane latency, unbounded if c suspends under e1 on B
```

Repaired walk (delta rows):

```
2′ | A commits T; P2″: no raced pin, but t does not retire at this commit → MARK at commit end (still synchronous): touched(c) ∋ slot(T), cone+list; wc[T] := max(wc[T], q) | bits land before any later task
3′ | W_new reads c | touched ≠ 0 → world path → visible({e1,T,q}, w_U)? mask ✗, retired ✗, LV(B) ✗ → INVISIBLE → e0 → renders 1 ✓
4′ | U commits B | uniform frame (1, 1) ✓; fixup: conjuncts pass (promotion cas-bump q < p2; nothing else moved) → return, zero evals — correct
5′ | B's T render (P3′'s corrective): mask ∋ T, q ≤ pin → e1 → W_old renders 10; commits → lock view(B) ∋ T → committed-for-root(B) flips → R4 ADVANCE DRAIN enumerates touchedList[T] ∋ c → reconcile c's watcher set AT DRAIN TIME: W_new lastRendered 1 ≠ 10 → urgent pre-paint setState → W_new renders 10 pre-paint ✓
6′ | T retires (both roots done); pins release → compaction → entry becomes base → slot sweeps → bits clear ✓
outcome: per-root self-consistency at every commit; the pre-repair rule tears at step 4.
residual: one urgent pre-paint over-render for late subscribers at the lock-in flip (bounded, value-true — the I13 price); pinned tests: this schedule; its suspending variant (c suspends under e1 on B — B's committed view stays e0 throughout ✓); its urgent-promotion variant (t retires at its own commit → retired clause ≡ old pin behavior)
```

One normative clarification the walk uses (making the base's intent explicit):
**durable drains enumerate touchedList's nodes and resolve each node's watcher
set at drain time** — late subscribers to an already-listed node are covered
without list surgery.

### RS2 — Promotion marking condition (replaces Δ1 steps 2–4: P2″)

At F9 emission, after P1′ installs entry E = {fn, deps, stamp, t, q}:

1. Dirty the K0 node (NEWEST freshness; unchanged). Demote open RENDER_NEWEST
   passes (unchanged).
2. During the same open-pass enumeration, compute `racedPin :=` any open pass
   frame **other than the committing root's committing frame** with pin < q.
   (Exclusion sound: the committing pass cannot evaluate after F9 — render is
   over, layout reads committed/NEWEST — and its world memos are unreachable
   by any future worldKey since pins mint monotone and never recycle. This
   closes finding 3's dead branch.)
3. **If racedPin**: run the marking frontier from the promoted node now
   (inside the synchronous commit): ordinary step-4a frontier over K0∪K1
   out-edges with bit slot(t) (`newBits & ~touched`, self-terminating,
   appends to touchedList[slot(t)]); set `wc[slot(t)] = max(wc[slot(t)], q)`.
4. **Else defer the decision to this commit's own retirement edge** (the
   library already observes F4 inside the F3 sequence): if t fully retires at
   this commit, no marks are needed — every future world sees E by the
   retired clause and every committed-for-root by lock/retired; if the commit
   ends **without** t retiring (spanning roots, parked action), run the same
   frontier at commit end — still inside the synchronous commit, before any
   foreign task can read. No new fork fact: this is ordering within edges F3
   already reports.
5. Quiet single-root promotions (t retires here, no raced pin — the common
   case) mark nothing and bump nothing: zero-cost claim restored **honestly**
   (finding 3's two mispriced §7 rows re-anchored to this condition).

Consumer audit unchanged from surgical-a §2.4 (routing, fixup, ladder step 3,
R4 drains, R2 dedup, saturation, renumber, quiescence) — re-checked against
the extended condition; the only delta is that spanning/parked promotions now
mark unconditionally, which STRENGTHENS every row (more conservative routing,
same lifecycle).

### RS3 — Fixup committed-side fast-out: population gate + abandoned-stage flag (Q2′)

*(Repairs finding 2; amends surgical-a Δ4/Q2. Capture point and the rest of
the fixup pipeline carry.)*

**Capture** (unchanged): at each commit's committed-side entry — before its
own F9 publications, folds, lock-in — capture
`commitBaseline = {cas, lockViewId(root)}` (fork test 34).

**Fast-out** (full replacement; after the per-token loop):

```
if w_r.passId == committingPass.id            // 0: rendered BY this commit's pass (generation-checked)
 ∧ commitBaseline.cas ≤ w_r.pin               // 1: no foreign committed-side motion since my pin
 ∧ commitBaseline.lockViewId == w_r.lockViewId // 2: no root lock-view drift since my render
 ∧ ∀s ∈ w_r.mask: wc[s] ≤ w_r.pin             // 3: no post-pin write/promotion in any included slot
 ∧ ¬committingPass.stagesAbandoned            // 4: every pass-visible stage published (RS4)
  return
v_fx = evaluate(n, w_fx); if !isEqual(v_fx, v_r): setStateW()   // unchanged
```

**Construction (the partition, with its population premise now a conjunct).**
Conjunct 0 restricts the "during the commit" case to watchers whose
`w_r.mask` equals the commit's batch set — the exact population for which
§3.3's value-neutrality cases (a)/(b)/(c) were proven: own folds are of
included tokens (conjunct 3 certifies no post-pin entries), own lock-in
exposes mask content to watermark = pin (fork test 33/I25), own F9
publications equal the stages the pass rendered under **when they published**
(conjunct 4 excludes the abandoned case — RS4). Every other watcher
(Offscreen/Activity reveal, any deferred-effect mount) falls through to the
per-token loop + w_fx compare — the I18 fallback, restored for exactly the
population that needs it. Pre-entry motion: conjuncts 1–2 (cas on the one
seq line, I15). Over-firing remains impossible to make unsound. ∎

**K3 repaired (delta rows; pinned, with codex's Offscreen variant):**

```
5′ | layout: W subscribes; fixup. touched(c) ≠ 0 → past first fast-out; loop over live tokens: u retired → empty | conjunct 0: w_r.passId = P_h ≠ committing pass (u's) → FALL THROUGH
6′ | w_fx = committed-for-root(R) now: a=1, c=f(1) ≠ v_r=f(0) → urgent pre-paint setState | W paints f(1) beside V ✓ (I18 restored)
cost | reveal-shaped mounts pay one w_fx eval each (G-F row); in-pass mounts keep C9′(a)'s zero evals (conjunct 0 passes)
```

### RS4 — P4′: pass-visible stages that fail to publish reconcile at commit

*(Repairs finding 15 — the synthesis-found C1-X7 hole; extends champion P4;
one new trigger site on existing machinery.)*

**Rule.** At `publicationsComplete` (inside the commit, before layout), for
every stage that was pass-visible in the committing pass (seeded or minted)
whose hook did **not** publish (error-abandoned subtree, discarded alternate —
fork tests 21/29 report nothing for these), the library: (a) sets the commit
record's `stagesAbandoned` flag (consumed by Q2′ conjunct 4 for mounting
watchers); (b) runs the R3 walk from the stage's node, filtered to watchers
with `lastRenderPassId == this pass`, delivering **urgent pre-paint**
setStates (the R4 channel — the stage is dead, so these watchers must
re-render under the committed chain before paint); (c) clears the lineage
cache entry (write-through), so retries/replays seed committed. Termination:
the corrective renders carry no stages → no further walks. StrictMode: stages
are lineage-keyed and idempotent (I40); Offscreen hidden commits DO publish
(fork test 20) → P4′ silent there.

**The kill, walked (C1-X7; pinned, both variants).**

```
setup | stageable n owned by hook O inside error boundary B_O; consumer W OUTSIDE B_O, subscribed; committed evaluator r0; zero receipts
1 | transition pass P: W renders early (tree order), seeded/staged E1{r1} pass-visible → W folds r1-output | R3 working as designed
2 | O renders later, THROWS (new deps make O's render throw after its hook) | React unwinds to B_O → fallback; O's fiber never becomes current
3 | P completes and commits | F9: NOTHING for E1 (test 21); committed chain stays r0; W's committed DOM = r1-output — never-promoted output in a committed frame
4 | pre-repair | no receipt, no touched bit (stage walks are delivery, never marking — R14), touchedList empty → R4 drains enumerate nothing; W is subscribed so no fixup runs → TORN vs any r0 sibling, indefinitely
4′ | repaired: P4′ at publicationsComplete | E1 pass-visible, unpublished → flag set; walk from n filtered to P-rendered watchers → W gets urgent pre-paint setState → W re-renders under committed r0 pre-paint ✓; lineage cache cleared
variant (b): fresh W mounts in P under E1; O abandons | P4′ runs before layout (W unsubscribed → walk misses it) → conjunct 4 fails at W's fixup → w_fx folds committed r0 ≠ v_r → urgent pre-paint correction ✓ (this is b-claude VH-4's schedule, kept as a pinned test)
outcome: no commit retains never-promoted evaluator output past paint.
residual: P4′ fires only on error/discard-abandoned stagers (rare); cost = one filtered walk per abandoned stage (G-F row)
```

### RS5 — Horizon reserve protocol (completes R8)

*(Repairs finding 4; amends R8/Δ7's slack sentence.)*

**Rule.** The horizon check runs at **atomic-extent entry** (the operation
boundary before entering any commit, walk, fold, or drain extent — the frame
guards already exist): if `globalSeq + reserve(extent) > H`, run the R8
renumber protocol **first** (discard-WIP via RS6, rewrite, epoch-bump), then
enter the extent. `reserve(extent)` is a documented, runtime-computable upper
bound on one extent's mints: for a commit, `k1·(staged hooks attached to the
committing tree) + k2·(atoms touched by tokens retiring at this commit) +
k3·(roots) + k4` (registry/plane counts the library already holds; k's are
schema constants asserted by CI against the mint-site table); walks/folds
have constant reserves. Production H sits ≥ 2^32 below the float53 ceiling,
making mid-extent crossing structurally unreachable; crossing anyway is a
**loud invariant throw** (all builds — dead code by the sizing rule).
Forced-tiny-H tests: (a) an oversized commit at low remaining reserve →
observes the PRE-entry renumber, and the throw stays dead; (b) surgical-a's
mid-commit-mint row carries; (c) live-pin-at-horizon (discard-first) carries.
"Every WIP pass" includes completed-but-uncommitted trees (Δ7 wording pin,
kept).

### RS6 — Synchronous discard is a fork capability

*(Repairs finding 7.)* F2 gains `discardAllWip()`: invokable by the library
at operation boundaries; synchronously abandons every WIP pass on every root
(React re-schedules them; always legal); returns only when no WIP pass
exists. This is surgical-b's F2 sentence adopted as normative. Joins the
O7/O23 fork-existence-proof risk line. **Fork test 36**: after
`discardAllWip()` returns, no pass frame is open and no WIP hook retains an
F9 attachment; a later retry is a fresh pass with a fresh pin. Δ7(iii)'s
trivial-update insertion note is deleted.

### RS7 — cas mint sites specified

*(Repairs finding 8.)* `committedAdvanceSeq` advances exactly when
committed-side state mutates: a retirement fold that touches ≥ 1 entry
(receipt or version), every per-root lock-in/advance, every promotion. A
receipt-less, version-less retirement mutates nothing, bumps nothing, and
needs no drain (nothing to reconcile). Q2′ never relies on incidental bumps:
the reveal population is carried by conjunct 0, not by cas motion.

---

## Part IV — Battery disposition (full battery; deltas walked, carries cited)

Baseline: surgical-a §8's table over the champion's Part IV walks. Every case
listed; nothing silent.

| case | disposition |
|---|---|
| C1 core, V2–V7 | verbatim (no promotions/mounts in these walks) |
| C1-X1 | verbatim + row 8 now enforced by P2″ marks with the RS1 visibility answer (cross-ref C11-E) |
| C1-X2, C1-X3, C1-X4 | verbatim (walkGen, taint, retention untouched) |
| C1-X5 | verbatim + Δ1-note under RS1: force-cleared promotion slots compensate via swept entries + fastPathDisabled (finding 6's schedule = the pinned test) |
| C1-X6 | surgical-a's kill + repaired walk carry; re-checked under RS1: t gains B work at P3′ → non-instant-retire → P2″ marks at commit end (same marks, sound reason); effStamp resolves f0 for w_B by INVISIBILITY (mask ✗ retired ✗ lock ✗) — same outcome, correct rule; rows 5′–8′ verbatim |
| **C1-X7 (new)** | RS4's kill + repaired walk, both variants — pinned |
| C2, C2-M | verbatim (conjunct 3 vacuous over empty mask; conjunct 0 passes for the flushSync pass's own mounts) |
| C3, C3-E, C3-R | verbatim + R9 annotations; C3-R's P3′ walk unconditional; I38c ordering (publication before folds) unchanged |
| C3-M | verbatim + row 4 note: "version-at-pin" reads become "version-visible-in-world" — for C3-M's pinned passes (pins predate q, tokens excluded) the resolution is identical |
| C4, C5 | verbatim (R2 cited; "includes" = render mask, per the adopted clarification) |
| C6, C7, C7-D | verbatim (demotion-on-promotion carries) |
| C8 | verbatim |
| C9 | amended: C9′(a) quiet zero-eval row now passes five conjuncts (cost pinned); K2a/K2b carry under Q2′ (conjunct 0 passes for committing-pass watchers, then 1/3 catch as before); **K3 + Offscreen variant repaired via conjunct 0** (RS3 walk); rows (b)/8 carry |
| C10, C10-R | race (i): k's mid-yield retirement is foreign pre-entry motion → cas bump → conjunct 1 fails → fire ✓; race (ii) verbatim |
| C11, C11-W, C11-A | verbatim + **C11-E (new, pinned)**: the RS1 lagging-root walk; effects note — committed-for-root version resolution is now root-scoped, so a B-effect no longer observes A's spanning promotion early (strictly more consistent than the champion) |
| C12, -U, -T, -F | verbatim (carrier untouched); parked-action promotions: version visible on the committed root via lock clause, elsewhere at settlement-retirement — consistent with I25 |
| C13 | amended rows (§ ledger below): version entries (token'd), commitBaseline (entry capture), wc promotion mints, stagesAbandoned flag, reserve constants; forced tests: C11-E lifecycle row 6′, finding-6's force-clear schedule, RS5(a)/(b), fork test 36 |
| C14 | verbatim + C1-X7's StrictMode note (stages lineage-keyed/idempotent; P4′ replay-safe) |
| C15 | verbatim; prefix evaluator stamps compare against visibility-resolved effStamp (same I40 identity discipline; retries share the world header → stable resolution) |
| C16, C16-D, B1 | verbatim + the C11-E effects note (root-scoped resolution); promotion flips reach effects via the durable drains (Δ1 note carries) |
| C17 | verbatim (discharged by deletion) |
| T8-N | verbatim (quiescence sweeps superseded versions — now by the compaction rule; no live pins ⇒ all reclaimable) |

Docket re-derivations: VH-R2 (with Δ6), VH-R3 (incl. A/B/A), VH-R4 (with the
drain-time watcher-set clarification), VH-R8 (now RS5/RS6-completed), VH-R9
carry from surgical-a's register — each was attacked by both its reviewers
and held; my spot re-walks (R2's completed-uncommitted frame; R3's A/B/A
seed-match termination; R4's late-edge advance drain; R9's prefix-gated
installation) reproduced the register's outcomes. R12 remains KILLED
(K2a/K2b) and replaced by Q2′.

New pinned regression schedules this round: **C11-E** (+ suspending and
urgent-promotion variants), **C1-X7(a)/(b)**, **K3** (+ Offscreen variant),
RS5's oversized-commit row, fork test 36's discard row — joining surgical-a's
C1-X6, K2a, K2b, C9′(a) cost row, VH-R2's completed-uncommitted schedule.

---

## Part V — Mechanism inventory (9 — unchanged) and state ledger

Counting rule unchanged. 1 K0 donor kernel + twin builds; 2 receipt tape +
folds (wc gains the promotion mint site); 3 token/slot/mask/pin + immutable
lock views (version entries join the unswept gate as ordinary entries);
4 K1 + touched word + the two walks (P2″ call sites); 5 world memos +
suspense capsules (validity compares visibility-resolved effStamp); 6
evaluator staging + F9 + **token'd version chain** (RS1) + P4′; 7
watcher/binding records (Q2′ five-conjunct fast-out); 8 fork/build protocol
F1–F9 + carrier (F2 discardAllWip; F3 step 0; tests 34–36); 9 episode
lifecycle (RS5 reserve protocol).

State-item ledger delta vs surgical-a: **added** — version-entry token field
(one int; a token serial, not a seq), per-commit `stagesAbandoned` bit,
reserve constants (schema-owned). **Deleted** — Δ1's synthetic
`retiredSeq = q` field reuse (subsumed by real entry lifecycle), Δ7's
insertion-discard note. **Amended** — wc mint sites, touched-bit mint/clear
sites, commitBaseline capture point (carried from surgical-a); compaction
rule now keyed on retiredSeq(t) instead of q.

Lifecycle rows (I19 discipline — mint / observed / cleared / forced test):

| item | minted | observed by | cleared | test |
|---|---|---|---|---|
| version entry {…, t, q} | F9 (P1′) | effStamp resolution; ladder/prefix compares; unswept gate; force-clear maxRetiredSeq | compaction (t retired ∧ min pins ≥ retiredSeq(t)); quiescence; renumber rewrites q/retiredSeq | C11-E 6′; finding-6 schedule |
| swept bit on version entry | force-clear | reclamation (skip decrement) | entry compaction | finding-6 schedule |
| stagesAbandoned | P4′ | Q2′ conjunct 4 | end of commit (per-commit scratch) | C1-X7(b) |
| commitBaseline | commit committed-side entry | Q2′ conjuncts 1–2 | end of commit | fork test 34; K2a |
| wc[s] | writes; P2″ promotions | ladder 3; R6 bound; Q2′ conjunct 3 | slot re-intern | C13; K2b |

## Part VI — Seam (deltas only; nine fork facts, count unchanged)

F1–F9 carry with surgical-a's amendments. Deltas: F2 names `discardAllWip()`
(RS6). F3's ordering clause: step 0 commitBaseline capture → F9 publications
→ retirement folds/lock-in → durable drains (watcher reconcile + effect
revalidation) → layout; P4′ rides publicationsComplete inside this sequence.
F9's emission context answers `F1.currentBatchToken()` (test 35) — now
load-bearing for RS1's version attribution, not just slot sourcing. Fork
tests: 1–33 carried (surgical-a's re-justification of 29–33 adopted), **34**
capture-before-F9, **35** F9-context token sampling, **36** synchronous
discardAllWip. Rebase drill answer unchanged: all protocol facts, zero
library lines move on lane renames / commit-phase moves / queue rewrites.
Version skew loud (unchanged).

## Part VII — Gates and spikes (amendments over surgical-a §7)

- **G-F**: fast-out ≤ 5 compares + popcount(mask); zero-eval pinned for
  in-pass mounts (C9′(a)); one w_fx eval per **reveal-shaped** mount (K3
  population — new row) and per mount under an abandoned-stage commit
  (C1-X7(b), rare); the loop-corrected and promotion-raced rows carry.
- **SPK-R**: promotion rows re-keyed to P2″'s condition (marks fire on
  raced-pin OR non-instant-retire promotions); adds the version-visibility
  resolution compare (chain length 1 common case) and the C11-E lock-in
  reconcile row.
- **SPK-W**: ladder-step-3 over-invalidation row carries (mask∋s memos
  re-derived once per raced promotion).
- **G-Q**: zero delta for quiet paths (marking, P4′, and the fast-out run at
  promotions/commit/mount only); O19's floor question untouched.
- RS5's reserve is analytic (schema CI), not a spike. All other gates,
  spikes, fallbacks carry: SPK-L, SPK-N1 (O24 embargo intact), SPK-G8, SP2,
  SPK-K1.

## One page: the story that ships (amended paragraph only)

**Evaluators are world-scoped state on the receipt discipline — all the way
now.** A hook's fn/deps stages per pass (lineage-seeded from pass start;
mid-pass stagings restart already-rendered consumers pre-commit; a stage
whose owner dies unpublished is reconciled to committed before paint). The
fork's F9 publishes at hook-becomes-current, before that commit's folds, and
the published version is a **token'd entry**: visible to a world exactly when
a receipt of the same batch would be — retired-below-my-pin, or in my mask,
or locked into my root below the watermark. A promotion that isn't instantly
universal marks its cone like a write and holds its slot unswept until no
world can demand the old version, so reads route to the version their world
admits; lagging roots keep rendering — and committing — the old evaluator
until their own lock-in, then correct their late subscribers pre-paint at
that flip. Mount fixup returns early only for a watcher rendered by the
committing pass itself, with no foreign motion since its pin, no post-pin
included writes, and no abandoned stages; everyone else — including a
revealed Activity subtree — gets the committed compare before paint.

---

*Synthesis complete. Verdicts: 13 confirmed / 2 refuted / 0
needs-measurement. Winner: surgical-a's repair line (promotion-time
marks/clocks routing; commit-entry baseline), completed by RS1's token'd
version visibility — the round's one champion-level defect — plus the
population gate, P4′, and the lifecycle/horizon repairs. 9 mechanisms; 9
fork facts; fork tests 1–36. New pinned schedules: C11-E, C1-X7(a)/(b), K3,
RS5(a), plus surgical-a's set. NOT a dry round: findings 1, 2, and 15 are
confirmed blockers minted before this synthesis; the budget cap is reached —
the exit case presents this artifact as best-so-far with the open items in
the notes diff.*
