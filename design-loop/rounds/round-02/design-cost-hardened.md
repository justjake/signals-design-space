# Round 2 — COST-HARDENED two-kernel (the champion re-armored against its cliffs)

Stance: I inherit the round-1 champion (`rounds/round-01/synthesis.md`: K0
canonical donor kernel + K1 real world edges + always-log tape + clock
validity + per-write full-reach walk). I am the cost adversary. Part I builds
the nastiest schedules I can against the champion's own gate table and shows
four gates break or are unprovable as stated. Part II is the re-armored
design: every broken gate gets its pre-registered fallback designed IN FULL
and integrated (three as defaults, one as a measured escape hatch), and every
round-2 docket blocker my machinery touches (all eight, it turns out — the
validity, marks, fixup, mask-lifecycle, thenable, async-attribution, and both
SPK remedies live exactly where the cost repairs live) is repaired in place.
Architecture class is unchanged (DECISIONS D8 respected); every delta is a
seam rule, a column, or a validity predicate — no load-bearing mechanism of
the champion moved.

Reading protocol: sections marked **[=]** are unchanged from the champion
(one-line restatement + pointer); sections marked **[Δ]** carry the deltas.
The battery (§14) is walked in full; steps changed by a hardening are marked
‡H*n*.

---

## 1. One-page summary (the whole concurrency story)

**Two closure builds, not two flags.** DIRECT mode (no React) is the donor
arena kernel **verbatim** — not "hooks present but disarmed": SPK-H/SPK-Q
measured dormant hook sites at +2.5–3.5% (deep) and the dormant routing
branch at +2.4–3.8% (reads), both over budget [SPKHQ]. Registering the React
bridge (monotonic, S6) rebuilds the engine closures once into the LOGGED
build, which alone contains the logging write path, the read-routing branch,
and the two re-track hooks. Public `Atom`/`Computed` accessors re-bind by
prototype swap at registration; internal recursion is closure-internal to
each build, so DIRECT executes literally zero concurrency instructions (P3).

**One value truth plus receipts.** [=] K0's value column holds newest. Every
LOGGED write — urgent included (I1) — passes the render-write guard, appends
a receipt `{op, slot, seq}` (inline-2 in cold atom columns, pooled spill),
and folds per world by the seed visibility math on ONE monotone seq line.
New: each atom carries `baseSeq`, stamped at compaction, so dep versions
survive compaction (the I16/B1 repair).

**Worlds route reads; marks are per-slot.** [Δ] The champion's scalar
`worldSensitive` flag becomes **touchedSlots(n)**: a per-node int32 mask,
"slot k's recorded influence cone includes n". Maintained by walks and by
**propagate-on-new-edge**: any edge add (world-eval record, K0 re-track)
flows missing bits down existing out-edges with queued deliveries — which is
exactly the I17 repair (equality-stranded CLEAN nodes now inherit bits).
Routing keeps the champion's invariant R verbatim with `touchedSlots(n)=0`
as the unflagged test.

**Validity is clocks plus a CLOSED change-source table.** [Δ] The I16 family
is repaired as one enumeration (§8.2): (1) in-mask writes — per-slot clocks;
(2) retirements — a **relevance ring** replaces the champion's
epoch-nukes-all-memos, so memos survive unrelated commits (this deletes the
held-open-transition cliff); (3) thenable settlement — sentinel memos check
settle status; (4) evaluator identity — `fnVersion` joins the predicate;
(5) compaction — `baseSeq` keeps atom versions monotone. Memo keys drop the
pin (`(node, maskId)`); a pin-window lemma (§8.3) proves clock+ring checks
cover pin drift, so passes of one held transition REUSE memos across urgent
interruptions. Per-(atom, maskId) fold caches ride the same predicate —
the SPK-G8 escape hatch, now the default.

**Notification: full reach, frontier-pruned, value-cut at fan-out.** [Δ] The
per-write walk over K0∪K1 in the writer's stack (D5, D10) stays. Two
armor plates: (a) **delivered-frontier pruning** — per-node
`deliveredMask/deliveredEra` vs per-slot `rearmEra` prune repeat same-slot
walks to the changed frontier (one full cone walk per slot per render cycle,
O(out-degree) after); (b) **evaluate-cutoff at fan-out** (default ON at
watcher count ≥ F₈=8, SPK-N1 tunes): at delivery, evaluate the node once in
the writer's world (memo-shared — the pass reuses it), compare per-watcher
`lastRendered`, suppress if all equal. Suppression is sound only because it
is **revocable**: any other slot's walk arriving, any relevant retirement,
or any propagation re-delivers suppressed bits via `runInBatch` — the I13
joint-mask trap is closed by revocation, not by joint enumeration.

**React edges.** [Δ] The mount fixup narrows from "every live deferred
token" to `touchedSlots(node) ∩ liveDeferred` (sound by the I4/propagation
argument, §10.2) — O11's 10k-mount × 10-transition storm drops from 10k
correctives to ≤1 per genuinely-touched mount — plus an unconditional
committed-world version compare at layout time (the I18 repair: no
live-token enumeration can go silently empty). Signal-effects are walk
targets like watchers (committed-channel), so retirement flushes touch only
affected effects. Fresh nodes stage in per-lineage manifests; abandoned
mounts free their arena records (S15).

**The fork speaks eight facts** (§11): the champion's seven plus **F8
async-action scope** (post-await write attribution — O14), with fork test 13
differential against React 19. Rebase drill answer unchanged: the library
moves zero lines.

Numbers: DIRECT = donor verbatim [ARENA]. Hardened gates in §13: logged
write ≤2× DIRECT steady (pruned) with the cold full-walk gated separately;
quiet-React read tax has a measured 2.4% floor [SPKHQ] — G-Q is flagged
AT-RISK with an idle re-run + renegotiation rule, not asserted; fan-out
suppressed-write storms are O(1 shared eval + frontier)/write instead of
10k renders/frame; mount fixup ≤ |touched ∩ live| correctives; held-open
re-validation is ring-checks, not re-evaluation. Unmeasured ⇒ spike (§13.4).

---

## 2. Part I — the attack: workloads vs the champion's gates

Every workload is a schedule I re-walked against the champion's mechanisms
as written. "BREAKS" = the gate as stated is violated or unprovable;
"HOLDS" = survives with the stated bound.

### W1 — O12 value-blind fan-out (vs G-N)

`c = a*0 + b`; 10k watchers on `c`; one deferred batch k held open across
frames; 100 `a.set(random)` per frame (all value-suppressed at `c`).

Champion walk: write 1 walks a→c, iterates 10k watchers, 10k setStates
(value-blind), 10k spurious renders in k's lane. Writes 2–100: dedup bits
set → 10k bit loads per write = **1M loads/frame** (~0.5–1 ms). Render
re-arms → next frame repeats: **10k spurious renders per frame, forever**.

- G-N as stated ("≤1 spurious render per (watcher, batch)") — **BREAKS**:
  the bound is per render *cycle*, and a held batch has unboundedly many
  cycles. 10k renders/frame ≈ 50–100 ms/frame of pure waste. The champion
  itself deferred this to SPK-N1; the adversarial grid row above needs no
  measurement to show the *stated* bound is wrong — the knob cannot stay
  optional.
- Secondary: the 1M dedup loads/frame are real even when renders are
  deduped.

**Verdict: the evaluate-cutoff fallback must ship default-on at fan-out,
and repeat-walk cost needs structural pruning.** But the naive cutoff is
UNSOUND (I13-class): with `c = a && b`, t1 writes `a` (t1-world value of c
unchanged → suppress), t2 writes `b` (t2-world unchanged → suppress), the
joint {t1,t2} pass renders c=true with no pending update — torn commit. A
retirement extends every world the same way (walked in §9.3). So the
hardened cutoff (§9.3) is per-write equality **plus revocation** on
cone-sharing walks, propagation, and relevant retirements. Designed in
full below; SPK-N1's grid now *tunes the threshold*, it no longer decides
soundness.

### W2 — O11 mount-fixup over-render (vs G-F and P1)

10 live held transitions (each wrote *something*, so every slot clock ≠ 0);
mount a 1000-row list whose row nodes sit under one atom touched by ONE
transition (t3). Champion §10.2: every flagged mount schedules correctives
into **every** live deferred token → 10 × 1000 = 10,000 lane-scheduled
updates, 10 full transition re-render passes over fresh rows at mount time.
P1's 10k-subscription-mount ≤15% budget is gone many times over; G-F's
"≤ live-deferred-count per mount" bound is *met* and still catastrophic —
**the gate's bound is the problem** (10× over-render is inside the gate).

**Verdict: BREAKS (gate mis-specified).** Repair: the fixup consults
`touchedSlots(n) ∩ liveDeferred` — rows touched only by t3 get exactly one
corrective, in t3's lane, joining t3's already-pending render. Soundness
needs the propagation invariant (a fresh mount's first evaluation adds
edges; edge-add propagation marks the node before the layout fixup runs) —
§10.2 carries the induction. The I18 hole (live-token enumeration goes
empty when a batch retires inside the mount window) is repaired in the same
function by an unconditional committed-world version compare.

### W3 — held-open transition read bursts (vs G-E/§13.3)

Transition k held open 10 s over a 1000-row deferred list; user types: each
keystroke is an urgent batch that writes an atom **disjoint** from k's
cone, renders, commits (= retires), and interrupts k, which restarts.

Champion: (a) memo keys are `(node, worldKey)` with the **pin in the key**;
every k-pass restart captures a new pin → new worldKey → 100% memo miss
across passes of the *same* transition. (b) Worse, §4.3 step 2 bumps
`worldMemoEpoch` at **every** retirement — each keystroke's commit nukes
every world memo in the system. Net: every keystroke re-evaluates k's
entire visible flagged region (1000 rows × their computed chains), ~10×/s.
The ladder cannot save it: the ladder lives on memos, and the memos are
gone. G-E's "world-eval cost ∝ flagged/non-fresh region" is technically
satisfied **per pass** — the gate failed to say "amortized across passes",
so the cliff hides inside it.

**Verdict: BREAKS (two compounding design choices, one mis-scoped gate).**
Repair (§8): pinless memo keys + pin-window lemma; retirement relevance
ring instead of the epoch nuke; per-(atom, maskId) fold caches. After
repair the keystroke costs 1000 ring/clock checks (~µs), zero re-folds for
disjoint writes. SPK-G8 flips from "does the champion survive" to
"validate the repair's constants".

### W4 — LOGGED-mode write and read taxes (vs G-W, G-Q, G-H; SPK-H follow-up)

Measured input [SPKHQ]: dormant hook sites +2.5–3.5% deep (three sessions),
dormant routing branch +2.4/2.4/3.8% reads — both decision rules triggered.

- **G-D** (DIRECT ≤ alien on every tier-0 shape): with hooks/branch present
  in DIRECT, the donor's 0.90×/0.74–0.87× margins shrink by 2.5–3.8%;
  reads at 0.87× × 1.038 ≈ 0.90× still passes, but deep at 0.90× × 1.035 ≈
  0.93× erodes the margin for nothing. **AT RISK as designed; repaired
  structurally** by the dual closure build (§6): DIRECT is donor bytes.
- **G-Q** (React-mounted-but-quiet ≤2%): the branch **alone** measured
  2.4% min-ratio — over the gate before the logged write path pays a
  cycle. **UNPROVABLE as stated.** Hardening (§13): flag the measured
  floor; queue SPK-L (idle-machine LOGGED tier-0); pre-register the
  renegotiation (≤3% with monitor sign-off) and the episode-swap escape
  hatch with the reason it is NOT the default (a per-event closure swap
  thrashes ICs; urgent-only events still need routing for C2's flushSync
  world, so the swap trigger would be per-event, not per-episode).
- **G-W** (logged write ≤2× DIRECT): the champion's write = guard + token +
  clock + push + K0 write + **full-cone walk**. On W1's shape the walk is
  the whole cost; ≤2× is unprovable for cold deep cones. **Repaired by
  split gating** (§13): steady-state (frontier-pruned) writes ≤2× DIRECT;
  cold first-walk-per-cycle gated against the donor's own propagate class
  on the same cone (≤2× donor propagate). SPK-W measures both rows.
- **G-H** (hook tax ≤1%): satisfied by construction in DIRECT (no sites);
  re-scoped to LOGGED-quiet (armed hooks, no live fork: `beforeRetrack`
  short-circuits on one boolean). SPK-L row.

### W5 — retirement/compaction storm (new, mine)

Transition writes 10k atoms (bulk import) then retires; 5k signal-effects
registered app-wide. Champion §4.3+§10.4: fold 10k tapes (necessary) +
fold-walk (necessary) + **per-root effect flush check** with no targeting
stated — as written it version-compares every registered effect on every
retirement: 5k compares per keystroke-commit in W3's mixed schedule.
**HOLDS on values, BREAKS on effect-flush scaling.** Repair (§10.4):
effects are walk/fold-walk targets (committed-channel watchers); flush
checks drain a touched-effect queue, O(affected), not O(registered).

### Scorecard

| champion gate | verdict under attack | disposition |
|---|---|---|
| G-N (≤1 spurious render/(watcher,batch)) | BREAKS (per-cycle, unbounded per batch; 1M dedup loads/frame) | evaluate-cutoff default-on ≥F₈ + frontier pruning (§9); gate restated per render cycle |
| G-F (≤ live-deferred/mount) | BREAKS at scale (bound too loose 10×) | touched-narrowed fixup (§10.2); gate = |touched∩live| |
| G-E (∝ flagged region) | BREAKS across passes (pin keys + epoch nuke) | pinless keys + ring + fold caches (§8); gate re-scoped amortized |
| G-D / G-Q / G-H / G-W | G-D at-risk, G-Q unprovable (2.4% floor), G-W unprovable cold | dual closure build (§6); split G-W; G-Q flagged with rule (§13) |
| retirement effect flush (ungated) | BREAKS at 10k effects | walk-targeted effects (§10.4); new gate G-R |

---

## 3. Delta log against the champion (hardenings H1–H8, docket repairs)

- **H1 (SPK-H/SPK-Q remedies; docket 7, 8):** dual closure build; DIRECT =
  donor verbatim; hooks + routing branch + logged write exist only in the
  LOGGED build; prototype-swap activation table (§6).
- **H2 (O12/G-N):** per-node `deliveredMask/deliveredEra` + per-slot
  `rearmEra` frontier pruning of repeat same-slot walks (§9.2).
- **H3 (O12/G-N):** fan-out evaluate-cutoff, default-on at ≥F₈ watchers,
  memo-shared writer's-world evaluation, per-node suppression, revocation
  on cone-share/propagation/retirement (§9.3). SPK-N1 tunes F₈.
- **H4 (O11/G-F; docket 3 = I18):** mount fixup narrowed to
  `touchedSlots ∩ liveDeferred` + unconditional committed-world version
  compare fallback (§10.2).
- **H5 (W3/G-E; docket 1 = I16 family, docket 5 = I20):** validity redesign:
  closed change-source table; pinless memo keys + pin-window lemma;
  retirement relevance ring (replaces epoch nuke); `baseSeq` monotone atom
  versions (B1); sentinel settle-check (TKC-2); `fnVersion` conjunct
  (TKC-8); thenable `foldStamp` (I20) (§8).
- **H6 (docket 2 = I17):** scalar F flag generalized to `touchedSlots` with
  propagate-on-new-edge (covers `afterRetrack` re-track acquisitions
  through existing out-edges, with queued deliveries) (§7).
- **H7 (W5 + docket 4 = I19):** per-slot touched-node lists = walk-first-
  touch log; they drive retirement fold targeting, ring relevance, slot-bit
  clearing at recycle (the I19 sweep), quiescence column zeroing (kills the
  champion's K1 tag-wrap story — O13), and effect-flush targeting (§7.3,
  §10.4, §12).
- **H8 (docket 6 = O14):** fork fact F8 async-action scope + fork test 13;
  S15 staging manifests for fresh nodes; O15/O16/O17 pins (§10.5–§10.7,
  §11).

Everything else — tape/fold math, invariant R, E-PRESERVE, K1, per-write
delivery in the writer's stack, reach-based-not-equality-filtered React
corrections, lineage suspense keys, the fork's F1–F7, retirement/lock-in
notification triggers, quiescence discipline — is the champion's, restated
only where a walk needs it.

## 4. Concepts (delta over the champion's §3; new terms defined here)

- **K0 / K1 / DIRECT / LOGGED / seq / tape / base / batch / token / slot /
  world / worldKey→maskId (changed, §8.3) / NEWEST / RENDER_NEWEST /
  watcher / pass / pin / lineage / retirement / episode** — as the
  champion, except: `worldKey` is replaced by **maskId** = interned
  `(deferredMask, lockedInVariant)` with **no pin component**; memos carry
  their fold-pin as data. `lockedInVariant` enumerates live locked tokens
  only — the empty variant is the single-root/steady-state case, so maskId
  is stable across unrelated commits.
- **touchedSlots(n)** — int32 cold column: bit k set ⇔ some k-write's
  influence cone, as recorded in K0∪K1 *at any time this episode*, includes
  n. Monotone per (episode × slot-generation); cleared per-slot at slot
  recycle via the touched list, bulk at quiescence. Replaces the scalar
  worldSensitive flag: routing tests `touchedSlots(n) == 0`; the fixup and
  the retirement ring test individual bits.
- **touchedList[slot]** — per-slot append-only list of node ids first
  touched by that slot (walk or propagation appends on 0→1 of the bit).
  Bounded by touched-region size; the slot's retirement fold, suppression
  revocation, bit-clear at recycle, and quiescence zeroing all iterate it.
- **deliveredMask(n) / deliveredEra(n)** — int32 cold columns: bit k +
  stamp meaning "a k-walk has delivered through n and no k re-arm happened
  since era deliveredEra(n)". **rearmEra[32]** — per-slot int32 from a
  dedicated era counter, bumped when any watcher re-arms for that slot.
  Prune rule §9.2.
- **suppressedMask(n)** — int32 cold column: bit k set ⇔ a k-delivery at n
  (watchers and descent) was equality-suppressed by the cutoff and is
  revocable (§9.3). Cleared on revocation, per-slot via touchedList at
  retire/recycle.
- **baseSeq(a)** — per-atom seq of the newest entry ever folded into its
  base (stamped at compaction; 0 for never-folded). Atom's version in
  world w = `max(baseSeq, seq of newest w-visible entry)` — monotone
  across compaction (I16/B1 repair).
- **retire ring** — global ring of the last R=64 retirements
  `{slot, retireSeq, slotGen}`; memos validate retirement-relevance
  against it (§8.2 source 2). Overflow ⇒ fail-closed (memo invalid).
- **fnVersion / settle status / foldStamp** — evaluator identity per hook
  node; thenable settled-ness (React `use` protocol field); the
  clock+ring snapshot a positional thenable entry was minted under (§8.4).
- **staging manifest** — per-lineage list of fresh node ids minted during
  its passes; commit registers them, abandon frees unregistered ones to
  the donor free-list under GEN discipline (S15) (§10.5).
- **F₈** — fan-out cutoff threshold (watchers per node) above which
  evaluate-cutoff is on; default 8, SPK-N1 tunes.

## 5. Value model **[= with two deltas]**

§4.1–§4.4 of the champion stand: guard-first logged write path, always-log
(I1/I7/C8), seed visibility math verbatim with both pins, seq-order folds
(I2/C3), retirement folding for committed=false too (D2), pin-retention
compaction (C7), quiescence reset behind epoch guards (C13).

Deltas:

- **Δ5a (P4/SPK-W):** tape storage is inline-2: two receipt triples packed
  in cold parallel columns on the atom id (`op`-tag+slot packed int32, seq
  float64 pair), spilling to pooled segment chains at length 3+. Steady
  React traffic (1–2 receipts per atom per event) allocates nothing.
- **Δ5b (I16/B1):** retirement compaction stamps
  `baseSeq(a) = max(baseSeq(a), seq of newest folded entry)` per folded
  atom. Dep-version entries and effect dep lists record the world version
  defined in §4 — never "0 because the tape is empty".
- **Δ5c:** retirement no longer bumps a global memo epoch; it appends to
  the retire ring and runs the notification path (§4.3 step 2 of the
  champion is replaced by §8.2 source 2; steps 1, 3, 4, 5 stand, with the
  fold-walk seeded by touchedList[slot] instead of a scan).

## 6. K0 and the dual closure build **[Δ — H1, the SPK-H/SPK-Q remedy]**

K0 is the donor arena kernel, unchanged in layout and algorithm. What
changes is packaging:

- **Two builds of the engine closure set** from one source with a
  build-time flag (same-file `const enum`/define discipline, [GUIDE]):
  - `buildDirect()` — the donor, byte-for-byte: no hook callsites, no
    routing branch, donor write path with native equality skip. This is
    what tier-0/P2 runs. G-D = donor numbers **by identity, not by
    argument** [ARENA].
  - `buildLogged()` — read paths open with the one-scalar routing compare
    (`currentWorld !== 0 → worldRead`), recompute paths carry
    `beforeRetrack/afterRetrack` as **closure-const-bound direct calls**
    (I11: a const-bound callback boundary measured 0.99–1.02×; it is the
    *dormant mutable site* that cost 2.5–3.5% [SPKHQ]), and the write path
    is §4.1's logged path.
- **Activation = bridge registration (monotonic, S6):** build LOGGED
  closures over the same plane buffers, then swap the public dispatch
  table: `Atom.prototype` state get/set/update, `Computed.prototype` get,
  `effect/batch/untracked/configure` module bindings. The swap-site table
  is part of the spec (schema-generated; one row per public entry point;
  CI asserts DIRECT build contains zero references to overlay symbols).
  One-time cost: closure build + IC re-learn on first LOGGED call per
  site; measured as SPK-L row "activation".
- Growth (arena realloc) rebuilds whichever build is live — the donor's
  closure-rebuild growth discipline unchanged.
- **Hot-loop hazard fenced:** kernel-internal recursion (computed re-entry,
  link walks) never crosses the dispatch table; only user-facing entry
  points swap. So LOGGED's tax is paid once per public call, not per link.

LOGGED-quiet obligations moved here: the routing branch (measured 2.4%
floor on reads [SPKHQ]) and armed-but-idle hooks (`beforeRetrack` gates on
one `forked` boolean when no batch is live). Gate G-Q and spike SPK-L in
§13. The episode-swap variant (LOGGED-unrouted closures while zero tokens
live) is REJECTED as default: token minting happens at the first write of
an ordinary event, so the swap frequency is per-event, and C2 requires
routing while any receipt is unswept even with zero *deferred* tokens;
per-event prototype swaps thrash ICs. It remains the named escape hatch if
SPK-L(idle) still fails G-Q and the monitor declines renegotiation.

## 7. Marks: touchedSlots, propagation, touched lists **[Δ — H6, H7; repairs I17, feeds O11/O12/I19]**

### 7.1 Invariant M (replaces invariant F; same role in invariant R)

**M:** if atom `x` has a live-episode receipt in slot k and a path
`x → … → n` exists in K0∪K1 **at any time while the bit is live**, then
`touchedSlots(n) ∋ k`.

Maintenance (all sites):

1. **Walks** (§9.1): every visited node ORs the walk's slot bit; 0→1
   transitions append to touchedList[slot].
2. **World evaluations**: the evaluating node ORs the union of its read
   deps' bits (champion rule, per-slot now).
3. **Propagate-on-new-edge** (the I17 repair): whenever an edge d→n is
   recorded — K1 edge from a world eval, K0 re-track acquisition seen by
   `afterRetrack`, E-PRESERVE mirror — compute
   `newBits = touchedSlots(d) & ~touchedSlots(n)`; if nonzero, OR them in,
   append to touched lists, **recurse through n's existing K0∪K1
   out-edges**, and for each watched node reached, queue delivery of
   `newBits` (drained per §9.4 — `runInBatch` per bit, immediate when in
   the writer's stack, at the work-loop edge when inside a render).
   Node-local OR-in is exactly what I17 killed; the recursion through
   existing out-edges is the repair, and its cost is amortized: each node
   gains each bit at most once per slot-generation, so total propagation
   work per episode ≤ live-slots × touched-region.

Base case: quiescence — no receipts, all bits 0, M holds vacuously. Step:
receipts appear only via §4.1 writes (walk fires, sites 1); paths appear
only via edge recording (site 3 fires); node evaluation composes bits
(site 2). Every event that can create an `x-receipt ∧ path` pair passes a
maintenance site. ∎

### 7.2 Invariant R **[=]**

The champion's §5.2 routing and §5.3 proof stand verbatim with
`touchedSlots(n) = 0` substituted for `F(n) = 0` (M ⇒ the contrapositive
step of the proof reads identically: no receipted atom reaches n in any
slot). CLEAN_TRACKED, the E-PRESERVE precondition, and the C1-T8
freshness rule are unchanged (I12 honored).

### 7.3 Touched lists (H7 — one log, five consumers)

Append-only int32 id lists per slot, written on 0→1 bit transitions.
Consumers: (a) retirement fold-walk seed set (replaces any scan); (b) ring
relevance is just a bit test but the list bounds the *clearing* work; (c)
slot recycle clears bit k and suppressedMask bit k over the list — the
**I19 sweep**, making "who retains slot bits" an enumerated, swept set;
(d) quiescence zeroes touchedSlots/deliveredMask/suppressedMask/k1Id over
the union of lists (touched-region cost, not plane cost) — this deletes
the champion's k1IdAndFlag epoch-tag scheme and with it the tag-wrap
missed-notification hole (O13): k1Id ≠ 0 now simply *means* minted this
episode, because quiescence zeroing is exact; (e) effect-flush targeting
(§10.4). Lists are pooled segments; a list overflow watermark forces
fail-closed full-column sweeps (dev assert, C13 forced test).

### 7.4 K1 **[= except id lifecycle]**

Layout, population (world-eval recording + E-PRESERVE), add-only-to-
quiescence reach (OP-F1 lesson) as the champion. Id lifecycle simplified
per §7.3(d): one `k1Id` int32 column, zeroed exactly at quiescence over
touched lists; no epoch tag, no wrap case (O13 closed by deletion).
E-PRESERVE keeps its SP2 dev-validator spike.

## 8. Per-world values: validity redesigned **[Δ — H5; repairs I16 family, I20; deletes the W3 cliff]**

### 8.1 Memos and fold caches

`worldMemoRead(node, w)` evaluates under the write-rejecting world frame
(champion §8.1, T3) and stores `M(node, maskId) = {outcome, foldPin,
retireEra, deps[(id, versionInWorld)], fnVersion, flags}`. **Atoms get the
same treatment**: `foldAtom` memoizes per (atom, maskId) with `{value,
foldPin, retireEra}` — the per-(atom, worldKey) fold cache the champion
kept as an escape hatch is the default (it shares the predicate below, so
it costs one struct, not a mechanism). Outcome ∈ {value, error box,
suspension sentinel} (R2 sentinel discipline).

### 8.2 The closed change-source table (the I16 repair)

A cached world outcome for (n, maskId) is servable to a pass at pin `p`
iff ALL rows pass. This table is the enumeration I16 demands; adding any
new way a world outcome can change REQUIRES a row (schema-checked: every
memo field pairs with a row, every row with a test).

| # | change source | predicate on the memo | why closed |
|---|---|---|---|
| 1 | in-mask write to anything (cone-blind, coarse) | ∀ s ∈ mask: `slotWriteSeq[s] ≤ min(foldPin, p)` | any entry visible to memo-or-pass but not both has an in-mask seq in the pin window (lemma §8.3); clocks are the max of those seqs; D9 kept |
| 2 | retirement (base moves; retired entries join all worlds) | for every ring entry with `retireSeq ∈ window(foldPin, p)` (window = `(min, max]`): `touchedSlots(n) ∌ entry.slot`, entry.slotGen current; era gap beyond ring ⇒ invalid | retirement changes a fold only via entries of the retired slot; if that slot's cone never included n (M), n's fold is bitwise unchanged; gen-stale ring entries fail closed |
| 3 | thenable settlement (TKC-2) | outcome is a suspension sentinel ⇒ its thenable's status is still pending | a sentinel's *correct* outcome changes exactly at settle; one status load, only on sentinel memos |
| 4 | evaluator identity (TKC-8) | `memo.fnVersion == node.fnVersion` | useComputed deps-change is the only fn mutation surface; it bumps the version (hook contract) |
| 5 | compaction (judge B1) | no predicate — prevented at the source: versions are `max(baseSeq, newest visible seq)` (Δ5b) | compaction can only *raise* baseSeq to the folded entry's seq: the version an observer would have read is preserved, monotone |
| 6 | mask composition (lock-in growth) | none — maskId is the key | lockedInVariant is in the key; growth mints a new maskId (multi-root spanning only; single-root variant is constant-∅) |
| 7 | `ctx.previous` (O17 pin) | none — previous is the memo's own prior outcome, rewritten atomically with it | previous is not an external input; per-world lineage of previous is self-contained (§10.7) |

Ladder **[=]**: the direct-dep version recheck (alien checkDirty
transplanted) sits on top for recompute avoidance with per-world equality
cutoff; correctness never depends on it (D9). Its dep versions are source-5
safe by Δ5b.

### 8.3 Pinless keys: the pin-window lemma

**Lemma.** For one maskId m and pins p₁ ≤ p₂:
`fold(n, m, p₁) ≠ fold(n, m, p₂)` ⇒ some tape entry has
`seq ∈ (p₁, p₂]` with slot ∈ m, or `retireSeq ∈ (p₁, p₂]` for a slot
whose cone includes some atom in n's fold basis.

*Proof.* The visibility predicate `(retiredSeq≠0 ∧ retiredSeq≤pin) ∨
(slot∈mask ∧ seq≤pin)` is monotone in pin clause-by-clause; two pins
disagree about entry e iff e's deciding stamp (seq for the mask clause,
retiredSeq for the retired clause) lies in `(p₁, p₂]`. A mask-clause
disagreement is row 1's subject (its write bumped `slotWriteSeq[slot]`
above p₁, and slot ∈ m). A retired-clause disagreement is row 2's subject
(the ring holds its retireSeq; relevance: an entry changes n's fold only
if its atom is in n's basis, and M marks n for that slot — walks mark at
write time, propagation marks on later edge acquisition, both before any
serve that could depend on it, because serving routes through §5.2 which
consults the same columns). ∎

Consequence: memos need no pin in the key; rows 1–2 quoted over the window
`(min(foldPin, p), max(foldPin, p)]` decide servability in both
directions — a memo folded *after* the pass's pin is correctly rejected
when an in-window in-mask write or relevant retirement exists (C7's
exclusion re-walked in §14). W3's keystroke storm: row 1 passes (no
k-writes), row 2 passes (urgent slot's cone disjoint ⇒ bit absent) ⇒
memo HIT across the restart. The champion's every-retirement epoch nuke is
deleted; ring overflow and gen-stale entries fail closed to the champion's
behavior.

### 8.4 Thenables **[= + I20 repair]**

Positional cache keyed `(node, lineageId, position)` with lineage's
lifetime rules (champion §8.4/T6: dead at commit/abandon regardless of
settlement; late settle generation-checked). **Repair (I20):** each entry
stores `foldStamp` = the §8.2 row-1/row-2 snapshot at mint (foldPin +
retireEra). A re-evaluation reuses the entry — same identity across pure
retries/replays — iff the stamp still validates for the evaluating world;
an intra-batch included write fails row 1 ⇒ the eval **replaces** the
entry (new fetch against the moved world — the correct outcome), bumping
the entry generation so the stale thenable's settlement no-ops. Both I20
conjuncts hold: stability without invalidation, replacement with it.
NEWEST evaluations keep K0's sentinel policy (never consult lineage
caches). O17 pin: sentinel settlement semantics at NEWEST and the
RENDER_NEWEST↔world suspension boundary allow at most one duplicate fetch
and one identity flip, conformance-tested (§10.7).

### 8.5 Untracked reads **[=]**

Champion §8.5 verbatim: world-correct values, no K1 edge, no dep entry,
no delivery; clock/mask validity never consults read sets, so the
untracked contract holds by construction in both planes.

## 9. Notification: pruned walk + fan-out cutoff **[Δ — H2, H3; the O12 answer]**

### 9.1 The walk (champion core, two armor plates)

```
notifyWalk(atom, slot):                    // writer's stack (D5/D10)
  stack=[atom]; ticket=++walkTicket
  while stack: n=pop
    if visited[n]==ticket: continue
    visited[n]=ticket
    if !(touchedSlots[n] & bit): touchedSlots[n]|=bit; touchedList[slot].push(n)  // §7
    if deliveredMask[n]&bit && deliveredEra[n] >= rearmEra[slot]: continue   // H2 prune
    delivered = deliverAt(n, slot)                                            // §9.3
    if delivered: deliveredMask[n]|=bit; deliveredEra[n]=eraCounter
    else: suppressedMask[n]|=bit; continue                                    // H3: suppressed ⇒ no stamp, no descent
    push K0 out-edges(n); push K1 out-edges(n)
    if core-effect / signal-effect subscribers on n: enqueue per channel (§10.4)
```

`deliverAt` (watchers): per-(watcher, slot) dedup as the champion (I5):
bit clear → `setState` in the writer's context, set bit. Re-arm on render
in a slot-including pass clears the watcher's bit AND bumps
`rearmEra[slot] = ++eraCounter` (O(1) — no clearing walk).

### 9.2 Frontier pruning (H2) — soundness

Prune fires at n for slot k iff a k-walk previously **delivered** through
n (mask bit) and **no k re-arm happened since** (era compare). Claim:
pruning never loses the reach induction (champion §9.2). If pruned, every
watcher at-or-below n on recorded edges either (a) has its k-bit set —
delivered by the stamping walk (stamping requires delivery, and descent
happened, stamping n's subcone the same way or suppressing — suppressed
nodes are NOT stamped, so a pruned ancestor cannot hide a suppressed
descendant: descent stopped at the suppression, and the suppressed node
carries `suppressedMask∋k`, whose revocation (§9.4) is triggered by
events, not walks-from-above... except a same-slot *later write* must
re-check suppressed nodes — that is why suppression refuses the stamp:
the walk re-reaches it), or (b) re-armed after the stamp — then
`rearmEra[k] > deliveredEra[n]` and the prune does not fire. Edges added
after the stamp are covered by §7.1(3): propagation re-delivers below the
new edge and, if it delivers, re-stamps; if it suppresses, leaves the
re-walk open. So: prune ⇒ all-scheduled-or-fresh-era. ∎

Cost: per slot per render cycle, ONE full-cone walk (re-stamp) plus
O(out-degree-of-written-atom) per further write. W1's writes 2–100 walk 1
node each. The 1M dedup loads/frame drop to ~200 visits + one 10k delivery
sweep per render cycle.

### 9.3 Evaluate-cutoff at fan-out (H3) — the sound construction

Applied at `deliverAt(n, slot=k)` when `watcherCount(n) ≥ F₈` and the
node's watchers' roots share one lockedInVariant (else value-blind —
multi-root spanning skew makes one compare basis wrong):

1. `v = worldMemoRead(n, writerWorld(k))` where `writerWorld(k)` =
   maskId({k} ∪ lockedInVariant), current pin — **memo-shared**: this is
   the same (n, maskId) memo k's own render will read; the evaluation is
   paid once per (node, k-write-burst), never per watcher, and the ladder
   turns repeats into version compares. This is the research-facts
   "memo-shared evaluation" mitigation, priced at G-C.
2. Per watcher W on n: `v === W.lastRendered`? (commit-recorded, T2).
3. **Any** watcher differs → deliver to ALL (value-blind for this node,
   this write); return delivered.
4. All equal → suppress: no setStates, `suppressedMask[n]|=k`, no stamp,
   no descent (descent-skip soundness: n's k-world value equals every
   watcher's committed-rendered value, and — single-slot condition below —
   equals what descendants' cached bases read; their k-evals reproduce
   their canonical evals by purity). Return suppressed.

**Why naive equality is unsound and what makes this sound.** The I13/S10
trap re-derived for delivery (Part I, W1): two suppressions in different
slots can hide a joint-mask divergence; a later retirement extends every
k-world the same way. Sound rule: suppression is valid only while (a) no
OTHER slot's influence reaches n, and (b) no relevant retirement has
moved n's base — and both are *events the system already observes at n*:

- another slot j's walk or propagation arriving at n (it must — reach
  induction/M) sees `suppressedMask[n] ≠ 0` → **revoke**;
- a retirement whose slot bit is in `touchedSlots[n]` iterates
  touchedList[slot] → sees suppression → **revoke**.

So the joint hazard is closed by revocation-at-the-witness, not by
enumerating masks (which I13 proves exponential).

### 9.4 Revocation and the delivery queue

`revoke(n)`: for each bit k in `suppressedMask[n]` (then clear): deliver
value-blind to n's watchers in k's context via `fork.runInBatch(token_k,
setState…)`; false (retired) ⇒ the retirement fold path already covers
committed observers (reconcile §10.3 + effect flush §10.4) and the
about-to-run revocation caller continues; then resume the k-walk descent
below n (value-blind, stamping normally). Deliveries triggered inside a
render callstack (edge-add propagation during a world eval; revocation
during a render-time first-touch) are queued and drained at the pass's
yield/end edge (F2) with their per-bit `runInBatch` context — D10's
per-write-context rule is preserved: nothing is ever grouped, only
deferred to the first legal delivery point with its own context. Queue
bound: ≤ touched × live-slots entries per pass; drained once.

### 9.5 What delivery deliberately does not do **[=]**

No per-watcher evaluation, no write-time evaluation below F₈, no grouped
drain (C6 by construction), one spurious render per (watcher, slot,
render cycle) above the cutoff only via revocation races. The gate is
restated honestly in §13 (per render cycle, not per batch).

## 10. React bindings **[Δ where marked]**

### 10.1 Watchers and hooks **[=]**

Champion §10.1: hook-instance watcher records, `useState(version)`, reads
through routing under `currentWorld`, fresh nodes world-routed by the
ordinary R rule, commit-recorded `lastRendered/lastRenderSeq` (T2).

### 10.2 Mount/subscribe fixup **[Δ — H4; repairs I18; answers O11]**

Layout effect of a mounting/subscribing watcher on node n:

```
r = touchedSlots[n]                             // after mount-render eval: propagation has run (§7.1(3))
if r == 0 ∧ (atom-empty-tape ∨ CLEAN_TRACKED(n)): done          // invariant R
scheduled = r & liveDeferredMask
for each t in scheduled:  if !fork.runInBatch(t, setState): missed=true
// I18 fallback — unconditional, never keyed to live-token enumeration:
if versionInWorld(n, committedForRoot) ≠ version rendered by the mount pass: setState()  // urgent, pre-paint
```

Soundness of the narrowing (the O11 answer): must every live deferred
token t with a possibly-divergent n-value be in `touchedSlots[n]`? A
t-world evaluation of n diverges from n's mount-rendered evaluation only
past a first divergent read, and by I4 that first read is a dependency
*recorded by the mount evaluation itself* (its prefix is shared). That
dep's t-receipt either predates the mount eval — then the eval's edge-add
fired propagation §7.1(3), marking n before this layout effect — or
postdates it — then t's write walks the recorded edge to n and delivers
normally (the fixup isn't needed for it). Fresh nodes have no pre-mount
edges, but their first (mount) evaluation records them, which is the
propagation trigger. So `touchedSlots[n] ⊇` every token needing a
corrective at fixup time. ∎ Joint masks: reach-filtered (not
equality-filtered) correctives land in every touched token's lanes, so
any renderable M containing a divergent subset has a pending update
(I13-safe, same argument as the champion's R2 but over the touched set).
Over-render bound: `|touchedSlots[n] ∩ liveDeferred|` per mount — 0 for
untouched mounts, ≤1 typical, vs the champion's unconditional
live-deferred-count. W2 drops 10k correctives → ≤1000 in one lane, riding
t3's already-pending render. I18: the committed-world version compare runs
unconditionally when flagged, so a token retiring inside the mount window
is caught by value, not by enumeration; if retirement lands after layout,
the reconcile backstop (§10.3, watcher now registered) fires.

### 10.3 Reconcile-at-fold backstop **[=]**

Champion verbatim (commit-recorded compare at retirement; a fired
backstop in tests is a bug).

### 10.4 Effects **[Δ — H7 targeting; repairs W5]**

Contracts unchanged (committed-world `useSignalEffect`, NEWEST core
`effect()`, the three flush triggers T1). Delta is *addressing*:
signal-effect records are walk targets on their dep nodes
(committed-channel: the walk enqueues the effect id instead of calling
setState) and fold-walks enqueue the same way. A flush check — after
commit (trigger 1) or on the retirement microtask (trigger 2) — drains
the queue and version-compares **only enqueued** effects in the flushing
root's committed world (versions per Δ5b). Cost O(affected), replacing
the un-targeted per-retirement scan (W5). Dedup per (effect, flush edge);
unmount drops records (trigger 3).

### 10.5 Fresh-node staging (S15 repair) **[Δ — H8]**

`useComputed`'s first render mints its K0 record and appends the id to
the current lineage's **staging manifest**. Commit of that lineage moves
the ids to registered (watcher attach, retention as champion). Abandon
(F5 lineage death without commit) frees unregistered manifest ids to the
donor free-list under the GEN discipline (deferred frees; K1 edges to a
freed-then-reused id are inert-by-overreach: walks may over-mark or
over-deliver through a recycled id — never under-deliver, because GEN
checks guard the only effectful sinks, watcher records and effect
records). Memos chain off the node's cold column and die with the free.
StrictMode double-render mints once per hook instance (the hook slot
carries the id across the replay — React guarantees hook-state
continuity for replays of the same fiber); the discarded sibling of a
double-*mount* is a separate fiber whose lineage abandon reclaims it.
Forced test: mount-evaluate-abandon ×10⁶ under `ARENA_INITIAL_RECORDS=2`
growth stress; plane high-water mark must plateau.

### 10.6 StrictMode, SSR **[=]**

Champion §10.5/§10.6 stand (guard-first render-write throw with
queue-untouched assert; idempotent replays via same maskId+lineage;
debounced observed lifecycle; DIRECT SSR, hydrate-then-register).
Suppression adds one StrictMode note, walked in C14: suppressedMask is
write-path state, never touched by renders, so replays cannot flip it.

### 10.7 API pins (O15/O16/O17) **[Δ — H8]**

- **O15 fold-callback purity:** `update(fn)`/reducer replay runs under a
  no-track, write-rejecting frame; signal reads inside resolve untracked
  **at the fold's world**; `__DEV__` warns once per call site (parity
  rationale: React reducers may close over ambient state; throwing would
  ban patterns React allows; untracked-at-fold-world is the only
  deterministic reading). Conformance test pins it.
- **O16 reducer identity:** ReducerAtom's reducer is constructor-fixed;
  folds always replay with it. Divergence from useReducer's
  latest-render-reducer replay is documented and differential-tested with
  fixed reducers (dynamic reducers are out of scope v1; the API has no
  swap surface, so the divergence is unobservable through our chrome).
- **O17 previous + sentinel boundary:** `ctx.previous` IS exposed (donor
  parity); per world it is the (node, maskId) memo's prior outcome
  (§8.2 row 7); at NEWEST it is K0's native previous. Sentinel
  settlement: settled thenables re-evaluate on next read (row 3); across
  the RENDER_NEWEST↔world boundary at most one duplicate fetch and one
  identity flip, pinned by a conformance note + test.

## 11. fork-protocol **[= + F8]** — 8 facts, ~12 reconciler sites

`__COSIGNAL_PROTOCOL__ = 2`; feature-detect, throw on stock React;
integers/booleans/documented callbacks only. F1–F7 are the champion's,
verbatim: F1 `getCurrentBatchToken()` (lazy mint, `(serial<<1)|deferred`,
≤31 structural via entanglement); F2 pass lifecycle
(start/yield/resume/end + `getCurrentPassId`, mask parity fact); F3
retirement + per-root lock-in (exactly-once, async parking); F4
`runInBatch(token, fn): boolean`; F5 lineage ids (per root × batch-set,
the suspense key, dead at commit/abandon); F6 DOM mutation window; F7
version handshake.

- **F8 `onActionScope(token, phase)` (H8 — the O14 repair):** the fork
  brackets every synchronously-executing segment of an async action —
  the initial body and each post-await continuation — with
  enter/exit callbacks carrying the action's batch token, emitted from
  the same place React's own async-action entanglement resumes the
  scope (React 19's startTransition async support already owns this
  boundary; the fork re-emits it, it does not invent it). Write
  classification (§4.1) consults the action scope before the ambient
  token: a post-await `a.set` classifies under the parked token. Two
  concurrent parked actions interleaving settlements each carry their
  own token (fork test 13: differential vs React 19 `useTransition`
  async side-by-side — same commit contents, same ordering). If a host
  ever cannot provide continuation truth, the pre-registered degraded
  rule is *loud*: post-await writes without scope throw in dev with the
  fix (move writes before await or use the action helper) — never
  silent urgent misclassification.

Rebase drill **[=]**: lanes renamed → token registry internal; commit
phases move → F3 edges re-anchor with invariant tests; update-queue
rewrite → nothing (tape owns rebase parity); scheduler/yield changes →
F2 flip sites move with the work loop; async-action internals move → F8
re-anchors at React's own action scope, test 13 pins. Library moves zero
lines.

Fork test list: champion tests 1–12 (token mint/uniqueness; retire
exactly-once + parking; lock-in ordering; mask parity; yield truth;
restart lineage; runInBatch + dead-token false; StrictMode replay;
flushSync exclusion; inertness = one null-check per site with no
listener; 31-token entanglement; commit-oracle harness) **plus 13**
(F8 differential) and **14**: yield-edge delivery drain ordering (queued
revocations drain before the pass's next work unit and carry their own
lanes — pins §9.4).

## 12. Lifecycle: counters, columns, guards **[Δ — the C13/I19 inventory, extended]**

Every row: retainers enumerated, clear site paired with the identity it
outlives (I8/I19), forced test named. Schema sweep asserts every
seq/mask/era-typed field has a row.

| counter/column | retained by | reset/clear site | guard + forced test |
|---|---|---|---|
| `globalSeq` (53-bit) | tape entries, memo.foldPin, pins, retire stamps, baseSeq | optional at quiescence | quiescence zeroes baseSeq over touched lists and kills memos (era in ring goes stale); **mid-episode saturation guard (O13):** at `2^53 − 2^32` a dev/prod assert forces episode close at next quiescence-eligible point and refuses further optional resets; forced-small build drives wrap in tests |
| `slotWriteSeq[32]` | memo row-1 checks | zeroed at intern and recycle (R4) | recycle gated unswept=0 (I10); re-intern-no-write test |
| slot ids (5-bit) + `slotGen[32]` | tape slots, touchedSlots bits, deliveredMask bits, suppressedMask bits, notifiedMask bits, ring entries, lockedIn masks | recycle: sweep touchedList[slot] clearing touched/suppressed/delivered bits; clear watcher notified-bit column; **clear bit in every root's lockedIn (the I19/TKC-6 repair)**; bump slotGen (ring entries with stale gen fail closed) | recycle-then-reuse battery: new batch on recycled slot must see zero bits anywhere (asserts over columns); C11 variant: root renders after recycle must not include the new batch uncommitted |
| `eraCounter` / `rearmEra[32]` / `deliveredEra` column (int32) | prune decisions | on int32 wrap: zero deliveredEra column, reset rearmEra | wrap = over-walk only (prune disabled until re-stamp); forced-wrap test |
| `touchedSlots` column | routing, fixup, ring relevance | per-slot at recycle (list sweep); bulk at quiescence (list union) | list overflow watermark ⇒ fail-closed full sweep + dev assert |
| `suppressedMask` column | pending revocations | revocation; per-slot at recycle; retirement revocation pass over touchedList[slot] | retire-with-suppressions test (C8/C5 variants) |
| `maskId` interns | memos, fold caches | quiescence (memos die with their nodes' chains; intern table reset) | epoch-free by construction: interns are episode-scoped, memos die at quiescence via chain drop; cross-episode test |
| retire ring (64) | memo row-2 checks | overwrite (ring); entries gen-checked | overflow ⇒ fail-closed invalid; forced tiny-ring build |
| `walkTicket` (int32) | visited stamps | wrap: zero stamp column | forced test [=] |
| `k1Id` column | K1 traversal | quiescence: zeroed over touched-list union (§7.3d) | no tag, no wrap case (O13 closed); dev sweep asserts all-zero post-quiescence |
| `lineageId` | thenable caches, staging manifests | commit/abandon (T6) + manifest free (S15) | late settle gen-checked no-op; abandon-reclaim plateau test |
| `fnVersion` | memos (row 4) | hook unmount (memos die with node) | deps-change invalidation test |
| watcher records (GEN) | walks' delivery sinks | unmount free (GEN bump) | recycled-id delivery is GEN-rejected |

Quiescence **[=]**: three-way live count; runs on the microtask after the
last retirement; O(touched) via lists.

## 13. Performance: hardened gate table + spikes

### 13.1 Gates (numbers or spike, never adjectives)

| gate | class | budget | status/evidence |
|---|---|---|---|
| G-D | P2 DIRECT tier-0 | ≤ alien v3 every shape; 179/179 + growth + exact pulls | **measured** — DIRECT build is donor bytes [ARENA]; SPK-H/Q removal verified by CI symbol check |
| G-Q | P3 LOGGED-quiet tier-0 | ≤2% target; **measured floor 2.4–3.8% for the branch alone on reads [SPKHQ], loaded machine** | AT RISK, honestly flagged: SPK-L(idle) re-runs; if confirmed >2%: pre-registered renegotiation to ≤3% (monitor) else episode-swap hatch (§6, with its stated IC-thrash risk) — never silently asserted |
| G-W(steady) | logged write, frontier-pruned | ≤2× DIRECT write | SPK-W row A (write burst after first walk) |
| G-W(cold) | first walk per (slot × rearm era) | ≤2× DIRECT propagate on same cone | SPK-W row B; amortized 1/render-cycle |
| G-N | delivery | ≤1 spurious render per (watcher, slot, **render cycle**) below F₈; **0 value-suppressed renders above F₈** (revocation races excepted, counted) | SPK-N1 grid (below) tunes F₈ and verifies the suppressed-storm row: cost = 1 shared ladder eval + O(frontier)/write |
| G-C (new) | cutoff eval | per (node,k)-burst: ≤1 world eval + per-write ladder recheck, shared across watchers; never per-watcher | SPK-N1 rows; memo-share asserted by pull-count instrumentation |
| G-F | mount fixup | ≤ \|touchedSlots∩liveDeferred\| correctives/mount; 0 for untouched; I18 compare = one version load | react-concurrent-store harness + W2 scenario (10 transitions × 1000 rows: assert ≤1 corrective/row, one extra pass total) |
| G-E | held-open re-validation | per interrupting commit: O(rows) ring/clock checks, **0 re-folds for disjoint writes**; re-evals only under genuine included-slot writes | SPK-G8 validates constants (now a repair-validation, not a survival test) |
| G-R (new) | retirement | O(slot's touched atoms + touched cone + enqueued effects); effect flush O(affected) | SPK-R: 10k-atom retire + 5k registered effects, ≤2× the batch's own render cost |
| G-H | LOGGED hooks armed, quiet | ≤1% recompute-dense (one `forked` boolean short-circuit) | SPK-L row |
| G-M | P4 steady traffic | 0 engine allocations; new columns ≤ 24B/node cold + 16B/atom tape-head; plane + heapUsed reported side by side | allocation asserts in harness; memory report |
| G-P1 | P1 | ≤10% vs useState; 10k mount ≤15% **with 10 live transitions** (W2 added to the scenario set) | harness |

### 13.2 Cost concentration (honest)

Logged write steady-state: guard + cached token + seq + inline push + K0
write + pruned walk (≈ out-degree visits). Cold per (slot × render
cycle): one full-cone walk — the donor propagate class. Fan-out delivery:
one shared world eval per burst + per-watcher scalar compares. First
k-read after k-writes: flagged-region re-validation, ladder-bounded
**and now memo-stable across passes** (§8.3). Retirement: touched-list
bounded. Propagation: each node gains each slot bit once per generation.
The suppressed-storm residual: suppressed nodes re-run the cutoff eval
per write (no stamp) — that IS the ladder recheck, gate G-C; if SPK-N1
shows even that too hot at 10k-node cones × 100 writes/frame, the
pre-registered fallback is a per-(node, slot) `suppressedSeq` stamp
(suppress-once-per-clock: skip re-eval while `slotWriteSeq[k]` unchanged
— sound because the memo's row-1 check embeds the same clock).

### 13.3 What this buys on the attack workloads (predicted, spiked)

- W1: 10k renders/frame → 0 suppressed renders + 1 shared eval/write +
  ~200 visits/frame (SPK-N1 verifies).
- W2: 10k correctives → ≤1000 in one lane (G-F asserts in harness).
- W3: full re-eval per keystroke → ~1000 ring/clock checks (SPK-G8).
- W4: DIRECT donor-identical (CI); LOGGED floor measured, gated, decided
  by rule.
- W5: O(registered) → O(affected) (SPK-R).

### 13.4 Spike register (all pre-registered; unmeasured ⇒ never asserted)

| spike | question | method | decision rule |
|---|---|---|---|
| SPK-L (new; SPK-H/Q follow-up) | LOGGED build: quiet reads/writes/recomputes + activation swap cost, idle machine | donor vs LOGGED build, tier-0 + kairo, one-per-process, idle; swap microbench | reads >2% → monitor renegotiation (≤3%) else episode-swap hatch; hooks-armed >1% recompute-dense → hoist `forked` gate; activation >1 ms at 10k nodes → lazy per-prototype swap |
| SPK-N1 (grid, extended) | O12: suppressed-ratio × watchers {10,100,10k} × writes/frame {1,10,100} × cone {10,1k,100k} | adversarial harness | tunes F₈; suppressed-row cost >2× DIRECT propagate → §13.2 suppressedSeq fallback; below-F₈ spurious renders >1/(watcher,slot,cycle) → lower F₈ |
| SPK-W | G-W rows A/B | set-heavy isolated writes; cold vs steady | row A >2× → inline-receipt widening/pooling; row B >2× propagate → mark-descend variant of pruning |
| SPK-G8 | G-E constants | held transition + urgent keystream, kairo-scale, disjoint AND overlapping writes | overlap-row re-eval ∝ touched only; else ladder/fold-cache audit |
| SPK-R (new) | G-R | 10k-atom retire, 5k effects | >2× batch render cost → segment retirement folds across microtasks (spec ready) |
| SP2 [=] | E-PRESERVE dev validator | as champion | >10% dev → sampled |
| SP-F8 (new) | F8 emission overhead | action-heavy schedule vs stock fork | >0.5% event overhead → emit only while bridge registered (sites null-checked) |

## 14. Correctness walks — full battery against the hardened design

Format per the seed. `tape+`, `wc[k]`, `M(n,mask)` memo, `TS(n)`
touchedSlots, `DM/DE` deliveredMask/Era, `SUP(n)` suppressedMask, `NM(W)`
notifiedMask, `ring+`, `CT` CLEAN_TRACKED. ‡Hn marks hardening-changed
steps. Unchanged champion steps are compressed, never skipped.

### C1 — world-divergent dependency (family of 9 ‡H6)

Core schedule (k: flag→read→a):

```
step | mechanism | state
1 | k: flag.set(true) §4.1 | guard✓; tape(flag)+={true,k,s1}; wc[k]=s1; K0 newest
2 | notifyWalk(flag,k) ‡H2 | visits flag,c: TS|=k (lists+); c watched (1 watcher < F₈ → value-blind): deliver W in k's ctx; DM(flag,c)|=k, DE=E1
3 | k pass P1 (F2) | world=maskId({k}), pin=s1
4 | W renders; re-arm ‡H2 | NM clears k; rearmEra[k]=E2; reads c → world eval: flag folds true; a: TS=0 atom no-tape → K0 value 0; K1 edges flag→c, a→c recorded; propagation: TS(a)=0 → no bits to flow; M(c,{k})={0, foldPin=s1}
5 | k: a.set(1) | tape(a)+={1,k,s2}; wc[k]=s2
6 | notifyWalk(a,k) ‡H2 | DE(a)=E1 < rearmEra[k]=E2 → no prune; visits a, follows K1 a→c (step 4's real edge); c: DE=E1<E2 → deliver W in k's lane; stamp E3
7 | k re-render | M(c,{k}): row-1: wc[k]=s2 > min(foldPin s1, pin) → invalid → re-eval → 1 ✓
8 | committed/sync read | maskId(∅): TS(c)∋k → world path: fold flag=false → b → 0 ✓
9 | k commits | retire: stamps on shared line; ring+={k,sr,gen}; fold bases; baseSeq(flag,a) stamped ‡H5; touchedList[k] drives fold-walk; reconcile no-op; quiescence zeroes columns over lists ‡H7
outcome: k-world 1 in k's lane pre-commit; committed 0. Matches.
residual: prune-vs-re-arm ordering — notify-rearm property test; era wrap test.
```

- **T2 (k writes committed-only dep b)** [=]: K0 edge walk delivers in k;
  k-eval unchanged value (ladder); over-invalidation only ✓.
- **T3 (flag back to false)** [=]: fold {true@s1,false@s3}=false; K1 gains
  b→c; add-only union ✓.
- **T4 (urgent U writes b)** [=]: delivers in U's ctx; U render excludes k
  → 9 ✓; k unchanged via ladder ✓.
- **T5 (urgent U writes a)** ‡H2: walk follows K1 a→c; c's watcher count
  < F₈ → value-blind deliver in U's ctx (priced spurious); k's next fold
  {1@s2, 5@s9} → 5 ✓ mask-parity as champion ✓.
- **T6 (slot/world reuse)** ‡H7: recycle sweeps touchedList[k]: TS/SUP
  bits cleared, NM column cleared, lockedIn bits cleared (I19), slotGen
  bumped (ring stale-gen fail-closed), wc zeroed; forced battery §12 ✓.
- **T7 (joint render, one suspends)** [=]: lineage-keyed thenables;
  abandon drops cache regardless of settlement ✓.
- **T8 (TK-F1 freshness schedule)** [=]: invariant R unchanged (TS=0 ∧
  ¬CT → world-evaluate); walk identical to champion's, with TS in place
  of F ✓.
- **T9 ‡H6 (the I17/TKC-3B schedule — NEW):**
```
setup | x atom; y=f(x) watched-clean; z=g(y) watched; K0 deps y→z exist; k live
1 | k: x.set(5); but y currently deps {m} (x not yet a dep) | walk marks x only (no edges out of x); TS(y)=TS(z)=0
2 | NEWEST recompute of y (urgent traffic) re-tracks, acquires x | beforeRetrack mirrors old edges (E-PRESERVE); afterRetrack ‡H6: newBits = TS(x)&~TS(y) = {k} → TS(y)|=k, recurse existing out-edge y→z: TS(z)|=k; z watched → queue delivery bit k (in-render? no: urgent effect context → immediate runInBatch(k, setState))
3 | y's NEWEST value EQUAL (cutoff) | K0 stops its own propagation — but step 2 already flowed bits+delivery; champion's node-local OR would have stranded z CLEAN/unflagged
4 | k's pass renders z | TS(z)∋k → world eval: y's k-value via M(y,{k}) → diverges → z re-renders in k ✓ no invariant-R misserve
outcome: I17 closed by propagate-on-new-edge with delivery.
residual: propagation-delivery queue drain ordering — fork test 14.
```

### C2 — flushSync excludes default batch **[=]**

Champion walk verbatim (receipts I1 + write-time cone marking): flushSync
world maskId(∅-locked), pin s1 → a folds 0, c world-evals 10 ✓. Hardening
note: c's memo made here (mask ∅) stays valid across D's later commit
only if ring row-2 says D touched c — it did (bit set) → invalid →
re-fold → 1/11 after D retires ✓ (no epoch nuke needed).

### C3 — rebase parity **[=]**

Champion walk verbatim on the shared seq line; 2, 2, 4, 4; plain-set 5.
‡H5 note: U's retirement compaction stamps baseSeq(a)=s2-fold; T's later
version reads max(baseSeq, visible) — monotone (no B1 collapse).

### C4 — two-batch write into a stale region ‡H2

```
1 | T1: a.set | walk delivers W in T1; DM(a,c)|=T1, DE=E1; NM(W)={T1}
2 | T2: a.set | walk slot T2: DM bit T2 clear → no prune; deliver W in T2's ctx; NM={T1,T2} ✓
3 | T1: a.set (again, pre-render) ‡H2 | DM∋T1 ∧ DE(E1) ≥ rearmEra[T1](E0) → prune at a: O(1), correct (W already scheduled in T1)
4 | React renders each lane | ✓ both
outcome: per-(watcher,slot) dedup preserved; pruning never crosses slots (per-bit check) and re-arm reopens (C5).
residual: prune-bit/slot-recycle interaction — §12 battery.
```

### C5 — suppressed first write, effective second ‡H3 (cutoff ON — the knob's own test)

Take watcherCount(c) ≥ F₈ (the hard case; below F₈ the champion's walk
already passes it value-blind):

```
1 | k: a.set(1); c=a*0+b | walk at c: cutoff evaluates M(c,{k}) → equal to all lastRendered → SUPPRESS: SUP(c)|=k, no stamp, no descent; wc[k]=s1 bumped REGARDLESS (clock unconditional — champion C5 residual honored)
2 | k: b.set(7) | walk from b reaches c (K0 edge): c unstamped (suppression refused the stamp ‡H3) → deliverAt: cutoff evaluates: M invalid (wc[k]=s2>foldPin) → re-eval → 7 ≠ lastRendered → deliver ALL watchers in k's lane; SUP(c) cleared by delivery; stamp
3 | k render | reads M(c,{k})=7 — the same memo the cutoff minted (shared) ✓ exact pulls: one eval
outcome: second write reaches watchers though the first was suppressed; cache validity never serves the first eval (clock).
residual: suppression-stamp interaction — C5 unit with knob forced on/off.
```

### C6 — lane attribution **[=]**

No grouped drain exists (D10); champion walk verbatim; queued
propagation deliveries (§9.4) each carry their own token via runInBatch —
context never merged; fork test 14 pins drain order.

### C7 — yielded pass, gap handler ‡H5 (pin-window re-walk)

```
1 | pass P (mask {T}, pin p) starts | world=maskId({T}), pin p
2 | yield (F2) | currentWorld=NEWEST
3 | handler reads a | NEWEST → K0 ✓
4 | handler a.set(x) | no pass binding → allowed; token C; tape+={x,C,sc}; walk delivers urgent
5 | C renders+commits | retire stamp sr=++globalSeq > p; ring+={C, sr, gen}
6 | P resumes (F2) | world restored (mask {T}, pin p)
7 | P reads n over a ‡H5 | memo M(n,{T}) foldPin=f. Case f<p: window (f,p]∌sr (sr>p) ∧ wc[T]≤f → SERVE (identical folds) ✓. Case memo folded post-commit by another consumer, f≥sr: window (p,f] contains sr; ring row-2: TS(n)∋C? yes (C's walk marked its cone) → INVALID for P → re-fold at pin p: C's entries retired@sr>p excluded ✓ pinned world intact (I15's two-pin discipline held through the pinless-key change — this walk is the proof obligation)
outcome: newest reads in gap; click-classified write (F8 not needed — sync handler); resumed pass undrifted BOTH when serving older memos and when rejecting newer ones.
residual: ring overflow during long yields → fail-closed re-fold (over-work, never drift); forced tiny-ring test.
```

### C8 — equality drops must not lose receipts ‡H3

```
1 | T: a.set(1) | tape+={1,T,s1}; walk delivers in T
2 | U: a.set(1) equal-to-newest | LOGGED: NO write-time drop (I1/I7): tape+={1,U,s2}; wc[U]=s2; walk: at watched c (≥F₈): cutoff evaluates M(c,{U}): U-world folds base0+{1@s2}=1 vs lastRendered 0 → DIVERGES → deliver in U's ctx ✓ (cutoff compares WORLD value, not newest — S8/S14 both dodged)
3 | U render (mask {U}) | 1 ✓
4 | two overlapping transitions set 1 | first delivers (diverges from rendered 0); second: its own world also 1 vs rendered 0 → delivers; after renders, further equal writes suppress — revocable ✓
outcome: receipts always; equality lives at delivery vs each watcher's rendered value, per world.
residual: suppression + truncation — no truncation surface (C17).
```

### C9 — mount mid-transition **[= + staging]**

(a) existing node: routing serves world path (TS∋k) or R-proved K0 ✓
[=]. (b) fresh node: no K0 record → ¬CT → world-routed ordinary rule;
its eval records K1 edges → propagation marks it (TS gains k if deps
touched) ‡H6; id appended to lineage staging manifest ‡H8. (b2)
discarded/replayed pass: unregistered node freed at lineage abandon —
plane plateau (S15) ‡H8; add-only K1 edges to freed ids inert (GEN at
sinks). (b3) post-mount k-write reaches n via its K1 edges ✓.

### C10 — late subscription ‡H4 (narrowed + I18)

```
1 | k: a.set(1) | receipts; cone marked TS∋k; existing watchers delivered
2 | urgent mount render of W′ on c | committed world render; eval records edges; propagation: TS(a)∋k flows to c if newly-edged (already marked here)
3 | layout fixup ‡H4 | r = TS(c)&liveDeferred = {k} (NOT all live tokens — O11): runInBatch(k, setState) ✓ one corrective, k's lane
4 | I18 fallback ‡H4 | versionInWorld(c, committed) == rendered version → no urgent correction needed here
5 | k renders | W′ pending in k → fresh read → 1; ONE commit ✓
race | k retires between 2 and 3 | runInBatch → false; I18 compare: committed version MOVED (k folded) ≠ rendered → urgent pre-paint setState ✓ (no live-token enumeration involved — the TKC-4 hole closed)
joint | c=x1&&x2, t1,t2 pre-mount | TS(c)={t1,t2} (walks or propagation §7.1) → correctives into BOTH → joint pass covered (I13-safe), singles render equal values (no DOM change), bound |touched∩live|=2
outcome: exactly one commit per touched token with correction; untouched tokens cost zero (W2's 10× repaired).
residual: G-F harness assertion; propagation-before-layout ordering — property test: fixup never reads TS older than the mount eval's edge adds (same stack).
```

### C11 — multiple roots (full spanning) **[= + I19]**

Champion walk verbatim (per-root lock-in composes into worlds; retire
once at last root). ‡H7 addition at slot recycle: lockedIn bit k cleared
in every root's mask (I19/TKC-6) — the recycle battery asserts a root
render after recycle cannot include the recycled slot's new batch via a
stale lockedIn bit. maskId note: lockedInVariant changes only at spanning
partial commits; single-root stays ∅-variant (no memo churn) ‡H5.

### C12 — store-only transitions persist **[= + F8]**

```
1 | startTransition(() => a.set(5)), no subscribers | LOGGED (monotonic): tape+; walk marks cone, no watchers
2 | batch closes, no React work | onBatchRetired(k, false) → FOLD (D2); baseSeq stamped; effect flush: fold-walk enqueued affected signal-effects only ‡H7 → they re-run seeing 5 on the engine microtask ✓
3 | async action: set(1); await io(); set(2) ‡H8 | segment 1 under onActionScope(k,enter); post-await continuation re-enters scope → set(2) classifies under k (F8), parked retirement
4 | settle | fold in seq order → 2, not before ✓; two concurrent parked actions: each continuation carries its own token (fork test 13)
outcome: persistence subscription-independent; post-await attribution is a protocol fact with a differential test, not an assertion (O14 closed).
residual: F8 emission drift across React upgrades — fork test 13 on every rebase.
```

### C13 — lifecycle soundness

Walked as the §12 inventory (every row: retainer, clear site, guard,
forced test). Episode collision drive: quiesce → optional small reset →
stale memos unreachable (chains dropped with nodes at quiescence; interns
reset), ring entries gen-stale, touched/delivered/suppressed columns
zeroed over lists, k1Id zeroed exactly (no tag to wrap — O13), NM cleared
at recycle, wc zeroed at intern, baseSeq zeroed with tapes empty.
`outcome:` no cross-episode validation passes a guard; the seq-saturation
guard (§12 row 1) gives forced-small builds a named mid-episode behavior.
`residual:` new columns require a row — schema sweep enforces (D6).

### C14 — StrictMode ‡H3/H8 notes

Champion walk stands (guard-first throw with queue-untouched assert;
idempotent replays; debounced lifecycle; commit-recorded comparators).
Additions: replayed renders never touch SUP/DM (write-path columns) —
purity preserved; double-mount staging: each fiber's lineage manifest
reclaims its own abandoned nodes (S15) with the microtask-debounced
observed lifecycle netting subscriptions to one ✓.

### C15 — suspense across worlds ‡H5 (I20 repair)

```
1 | k suspends c | lineage Lk: cache[(c,Lk,0)] = {th, foldStamp={foldPin s3, era e1}, gen g1}; M(c,{k})=sentinel
2 | mount mid-transition reads c | same lineage+position → stamp valid → SAME thenable ✓ (known-bug parity)
3 | intra-batch write ‡H5: k writes a dep of c before settle | wc[k]=s4 → M invalid; retry's re-eval: entry stamp row-1 fails (s4 > s3) → REPLACE entry {th′, gen g2}; stale th settles later → gen-check no-op ✓ retry renders moved-world data (CO-codex-4 closed)
4 | no invalidation path: settle → retry | M sentinel: row-3 settle-check → invalid → re-eval → cache hit (stamp valid) → settled value, same identity ✓ (TKC-2 closed)
5 | k commits / abandons | lineage dies → cache + manifest handled (T6/S15)
outcome: identity stable exactly while the world-content is; both I20 conjuncts walked.
residual: stamp granularity (per-entry vs per-frame) — R2 positional contract test.
```

### C16 — effects observe committed state only **[= + Δ5b]**

Champion three-trigger walk verbatim; ‡H5 at the variant that killed the
predecessor class: D retires with no commit on R → trigger 2 microtask →
version compare uses `max(baseSeq, visible)` — D's compaction RAISED
baseSeq(a), so the effect's recorded pre-write version differs → re-run
sees 1 ✓ (judge-B1's C16 instance closed). Targeting ‡H7: only enqueued
(touched) effects compare — W5 bound.

### C17 — optimistic rollback **[=]**

No truncation surface (D2; React batches never truncate); ReducerAtom
composes optimistic UI; surface deleted per the case's clause.

## 15. Rejected variants, OPEN dispositions, known gaps

Rejected (with reasons, kept for the judge):

- **RJ1 full mark-stop descent pruning on touchedSlots** — wants
  clear-on-render; touchedSlots must live to quiescence (routing). Split
  into monotone touchedSlots + era-checked deliveredMask instead; the
  leftover deep-cone×storm residual is priced (G-W cold row) with the
  suppressedSeq fallback (§13.2) pre-registered.
- **RJ2 per-write singleton-world equality cutoff without revocation** —
  reproduces I13/S10 for existing watchers (Part I W1 derivation, §9.3);
  the joint-mask and retirement counter-schedules are written out — this
  is the trap the stance brief's "default-on evaluate-cutoff" would have
  shipped naively.
- **RJ3 cutoff compare vs newest value** — S8/S14 rediscovered: worlds
  disagree about the accumulator; compare must be per-world vs
  per-watcher rendered values (C8 walk).
- **RJ4 episode-swap read closures as default** — swap frequency is
  per-event (tokens mint at first write; C2 needs routing while receipts
  are unswept), IC thrash unpriced; kept only as G-Q's escape hatch.
- **RJ5 per-(watcher,batch) suppression state** — per-node suffices
  (all-equal-or-deliver-all, §9.3), one column vs a per-watcher map;
  mixed-outcome mounts deliver value-blind (transient).
- **RJ6 global rearm clearing walks** — replaced by O(1) era bump;
  clearing walks re-introduce the cost the prune saves.
- Champion's rejected list (R1–R7) stands; note R1's fallback is now
  partially *adopted* in its sound form (per-slot marks = touchedSlots +
  propagation; the delivery half stays per-write).

OPEN dispositions touched by this stance: **O11** answered (touched-cone
narrowing; bloom variant unnecessary — the exact bit test is O(1) and the
column already exists; a bloom would only compress 32→smaller, pointless
at int32). **O12** answered structurally (sound cutoff + pruning); SPK-N1
demoted to threshold tuning. **O13** answered (k1 tag deleted via exact
zeroing; globalSeq saturation guard named). **O14** answered (F8 + test
13 + loud degraded rule). **O15/O16/O17** pinned (§10.7). **O1** — the
compensated-single-kernel fallback remains named; every hardening here
(clocks+ring validity, pruning, cutoff, touched lists) survives that swap
because none reads K1 semantics beyond "edges exist" — the fallback
swaps edge *storage*, not the walk/delivery/validity strata. **O3** — SP2
unchanged. **O7** — fork tests 2/3/4 stay on the critical path (gap G4).

Known gaps (declared):

- **G1′** cold full-cone walk once per (slot × render cycle) — gated
  (G-W cold), not eliminated; SPK-W row B.
- **G2′** suppressed nodes re-run the cutoff eval per write until
  delivered or retired — gate G-C; suppressedSeq fallback pre-registered
  (§13.2).
- **G3** union K1 edges over-notify [=]; revocation adds bounded
  re-deliveries (counted in G-N).
- **G4** fork registry facts need current-generation proof (tests 2/3/4)
  [=]; F8 adds test 13 to that list.
- **G5** E-PRESERVE validator cost (SP2) [=].
- **G6′** G-Q's 2.4% measured floor vs the 2% gate — flagged, ruled, not
  asserted away (§13.1); the honest possibility that P3's ≤2% is
  renegotiated to ≤3% is on the table for the monitor.
- **G7′** ring capacity under pathological many-retirement yields —
  fail-closed to re-folds (over-work); tiny-ring forced test.
- **G8′** propagation deliveries queued during renders drain at the
  work-loop edge — a late-by-one-yield delivery window, bounded by the
  pass's own edge-adds; fork test 14 pins the ordering. Not a torn-frame
  risk (the delivering pass has not committed), but a latency residual.

## 16. Mechanism inventory (12)

1. **K0 donor kernel + dual closure build** (DIRECT = donor bytes; LOGGED
   carries routing branch, two const-bound re-track hooks, logged write;
   prototype-swap activation table) — §6, H1.
2. **Tape (inline-2 + pooled spill) + base + baseSeq + one seq line** —
   §5, Δ5a/Δ5b.
3. **Slots/masks/pins + per-root lock-in + per-slot touched lists** — §7.3,
   H7 (lists are the retirement/recycle/quiescence work-bound).
4. **Validity = clocks + retire ring + closed change-source table**
   (fnVersion, settle-check, baseSeq versions; pin-window lemma) — §8.2–8.3,
   H5.
5. **World memos + atom fold caches (pinless keys) + dep-version ladder +
   lineage thenable caches with foldStamp** — §8.1/8.4, H5.
6. **K1 shadow plane + E-PRESERVE + exact-zeroed k1Id column** — §7.4.
7. **touchedSlots marks + propagate-on-new-edge with queued deliveries**
   (invariant M; the I17 repair; routing filter + reach index) — §7.1, H6.
8. **Notification walk + delivered-frontier pruning**
   (deliveredMask/Era vs rearmEra) — §9.1–9.2, H2.
9. **Fan-out evaluate-cutoff + per-node suppression + revocation**
   (walk-arrival / propagation / retirement witnesses) — §9.3–9.4, H3.
10. **Watcher records (commit-recorded) + touched-narrowed mount fixup +
    committed-version fallback (I18) + reconcile backstop + targeted
    retire/lock-in effect flush** — §10, H4/H7.
11. **Fork protocol F1–F8** (~12 reconciler sites; 14 fork tests) — §11,
    H8.
12. **Episode lifecycle** (retirement folds/compaction with pin
    retention, quiescence via touched lists, counter/column guard table,
    staging manifests — S15) — §12, §10.5.

(Champion had 10; +delivered-frontier pruning and +evaluate-cutoff are
the two genuinely new mechanisms; marks/lists/ring/staging replaced or
extended existing slots rather than adding independent moving parts.)

## 17. Test plan (delta over the champion's §17, which is inherited whole)

- **Attack-workload harness rows**: W1 (suppressed storm ×
  {10,100,10k} watchers), W2 (10-transition 1000-row mount), W3
  (held-open typeahead), W5 (10k-atom retire + 5k effects) — each with
  its gate assertion from §13; these are CI perf tests, not one-off
  spikes.
- **Cutoff soundness battery**: the §9.3 joint-mask schedule
  (`c=a&&b`, suppress-suppress-joint), the retirement-extension schedule
  (suppress → unrelated commit → lagging pass), revocation-race fuzz
  (random suppress/write/retire interleavings vs brute-force world
  oracle) — all with the knob forced on at F₈=1.
- **Pruning battery**: C4/C5 with forced eras, era-wrap, recycle-reuse.
- **Validity table audit**: schema sweep asserting memo fields ↔ §8.2
  rows ↔ tests bijectively; ring tiny-capacity forced runs; pin-window
  property test (random folds at random pins vs brute-force visibility).
- **Propagation/I17 battery**: T9 schedule + randomized re-track
  acquisition fuzz (equality-stranded topologies), asserting
  reachable-from-taped ⇒ marked ∧ (watched ⇒ delivered-or-queued).
- **I18/I19/I20 regressions**: mount-window retirement race; recycle
  lockedIn assertion; intra-batch thenable replacement (C15 step 3).
- **S15 plateau test**; **F8 differential** (fork test 13); **drain
  ordering** (fork test 14); **O15/O16/O17 conformance pins**.
- Gate CI: G-D symbol check (DIRECT build contains no overlay
  references), allocation asserts (G-M), pull-count instrumentation for
  G-C memo-sharing.

---

*End of cost-hardened design. 12 mechanisms; 8 protocol facts (~12
reconciler sites, 14 fork tests); all C1–C17 walked (C1 a family of 9);
attack analysis: 4 champion gates broken/unprovable as stated, each
repaired with its fallback designed in full (3 defaults, 1 ruled escape
hatch); docket blockers 1–8 all repaired in place (I16 table §8.2, I17
§7.1, I18 §10.2, I19 §12, I20 §8.4, O14 §11-F8, SPK-H/Q §6); 7 spikes
registered, none asserted.*




