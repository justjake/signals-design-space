# Round 5 — surgical-a: the round-4 champion, with two surgical repairs

Stance: FINAL budgeted round, SURGICAL scope. This artifact **is** the
round-4 champion — `rounds/round-04/synthesis.md`, which incorporates
`rounds/round-04/design-consolidate-a.md` as normative base — plus the
smallest diffs that (1) repair the judge's two blockers (R12's baseline
fast-out; R1's unrouted evaluator versions) and (2) survive adversarial
re-derivation of the round-5 docket's listed math (R1, R2, R3 incl. A/B/A,
R4, R8, R9, R12) and the merged fork-test list. Every sentence of the
champion not named in the diff manifest below carries **verbatim**,
including its walks. Architecture class unchanged (D8/D12): donor kernel
K0 + receipt tape + world-edge plane K1 + clocks/stamps + value-blind
delivery + co-designed fork. Zero new mechanisms.

---

## 0. Diff manifest (the entire diff; audit this table, then its sections)

| # | champion text touched | change (one line) | why |
|---|---|---|---|
| Δ1 | synthesis **R1 P2′** (promotion step) | when any live pin predates the promotion, route the promotion **like a write**: mark the promoted node's cone with the committing slot (existing step-4a frontier + touchedList), set `wc[s] = max(wc[s], promotedAtSeq)`, and count the superseded version record as that slot's unswept entry (retiredSeq = promotedAtSeq) | blocker 1 (§2) |
| Δ2 | base **§6.4 invariant R, source 3** | replacement text + completed induction: the K0-dirty carries NEWEST freshness only; the touched bit carries world routing, pin-gated | blocker 1 construction (§2.3) |
| Δ3 | base **§5.4 / §15** lifecycle rows | superseded version records participate in force-clear's maxRetiredSeq and in the I10/I39 unswept gate; wc row gains the promotion mint site; commitBaseline row re-anchored | I19 (repairs ship with clear sites) (§2.4, §5) |
| Δ4 | synthesis **R12** (fixup committed-side fast-out) | capture `commitBaseline` at the commit's committed-side **entry** (before its own F9/folds/lock-in), and compare the **baseline against the watcher's snapshot** (`baseline.cas ≤ w_r.pin ∧ baseline.lockViewId == w_r.lockViewId`) plus one included-slot clock conjunct (`∀s ∈ w_r.mask: wc[s] ≤ w_r.pin`) | blocker 2 (§3) |
| Δ5 | base **§14 F3** ordering clause + fork tests | ordering gains "commit-entry baseline capture" as step 0; tests 34–35 added (capture-before-F9; F1 sampling at F9) | blocker 2 seam (§6) |
| Δ6 | synthesis **R2** implementation note | "the root's active pass frame" → **all open pass frames** of the root, lifetime [passStart, passEnd(commit\|discard)) — the rule text was already plural; the note now matches it | held-with-wording-pin (§4 VH-R2) |
| Δ7 | synthesis **R8** wording | "every WIP pass" explicitly includes completed-but-uncommitted trees; horizon H carries slack ≥ one atomic extent's mints | held-with-wording-pin (§4 VH-R8) |
| Δ8 | **G-F / SPK-R / SPK-W** gate rows | fixup fast-out is now ≤ 2 + popcount(mask) compares; promotion-marking and drain rows priced | pricing (§7) |

Nothing else changes. In particular: K0, the tape and visibility math, K1
and both traversals (R14's split), the taint rules, lock views (T2), R2's
rule text, R3 entire, R4 entire, R5, R6 (rule text unchanged; its clock
input now also reflects promotions via Δ1), R7, R8's protocol steps, R9,
R10, R11, R13, the carrier, and all nine fork facts carry verbatim.

## 1. One page: the story that ships (whole story, compressed; deltas bold)

The donor arena kernel K0 stays byte-for-byte for the common case; DIRECT
builds execute zero concurrency instructions (D1/P3). In React (LOGGED)
mode every write appends a receipt {op, slot, seq}; a world is a fold —
base + visible receipts replayed in write order — with React's visibility
math verbatim: retired ≤ my pin, or in my mask up to my pin, or locked
into my root up to that slot's watermark (D3/I2/I15). Immutable per-root
lock views re-mint at every lock-in/advance; retirement stamps touched
atoms; one counter (committedAdvanceSeq, "cas") moves at every
committed-side advance.

Reads route by one word: a non-newest world may serve K0's cache only when
`touched(n) == 0` (no slot bits, no taint) ∧ CT(n) ∧ no staged evaluator ∧
not saturation-flipped. Everything else folds into per-(node, worldKey)
memos whose real deps land in K1; memo validity is the closed
change-source table (I16) with the flattened evaluator vector. Evaluators
are world-scoped (I22): hooks stage per pass with lineage-stable stamps,
stages are pass-visible from pass start (R3 seeding; mid-pass stagings
walk already-rendered consumers into a pre-commit restart), and the fork's
F9 promotes at hook-becomes-current, before that commit's folds. Committed
evaluators form a **pin-gated version chain** (R1): a pass folds under the
version its pin admits, exactly as it folds receipts. **A promotion that
races a live pin is now routed exactly like a write** (Δ1): the promoted
node's cone gets the committing slot's touched bit through the ordinary
marking frontier, the slot's clock advances to the promotion seq, and the
superseded version record holds the slot unswept until every older pin
dies — so the fast path refuses the cone and the world path resolves the
pin's version. The K0-dirty at promotion carries only NEWEST freshness;
the bit, not the dirt, carries world routing (the round's blocker 1, dead
by the same retention discipline receipts already use).

Notification is per-write, synchronous, value-blind (D5/D10/D13), over
K0∪K1 with per-walk visited generations; dedup is per-(watcher, slot) and
pass-aware (R2: a set bit suppresses only writes that scheduled-but-
unstarted work will fold). Committed truth flips only at retirements,
lock-ins/advances, and promotions; every flip drains its slot's durable
touchedList through watcher reconcile + effect revalidation (R4 —
promotions now join the drains through Δ1's marks). Mount fixup stays: a
value-blind per-token corrective loop (inclusion+clock skip, per-clause
bounds — R6), then one committed-side compare against the rendered world
fast-forwarded (w_fx). Its fast-out is now sound and cheap (Δ4): the
commit captures `{cas, lockViewId}` at its committed-side **entry**, and
the fixup returns only when the baseline shows **no motion since the
watcher's pin**, no root lock-view drift, and no post-pin write in any
included slot — the commit's *own* folds/lock-in/F9 are excluded by the
capture point (provably value-neutral for a watcher rendered in the
committing pass: watermark = pin, retired-vs-mask equality, stage = what
it rendered with), while any *foreign* motion in the render→commit window
falls through to the w_fx compare (I18 restored; the round's blocker 2,
dead). Suspense keys by fork lineage with receipt-line content validity
and value revalidation; async actions ride the measured twin-build carrier
with parking + retired-token fallback. Saturation force-clears only fully
retired slots and flips excluded pinned passes to world-path-only;
episodes renumber under R8's discard-WIP-first live protocol. DIRECT =
donor speed [ARENA]; every unmeasured hot number is a named spike (§7).

## 2. Repair Q1 — promotions are routed like writes (judge blocker 1)

### 2.1 Adversarial re-derivation (the schedule that kills the champion as written)

R1 gives committed evaluators a pin-gated version chain and amends the
memo ladder — but no **routing** surface ever learns that a version chain
exists. P2′ dirties the K0 node; the dirt is CT-freshness, which the next
NEWEST recompute restores. Promotions create no receipt and set no
touched bit. The champion's own invariant-R source 3 says "CT(n) is false
until they do" — conceding the wash-out and covering nothing after it.

```
C1-X6 (new, pinned): cross-root promotion vs a pinned pass — the fast-path seam
setup | stageable n (committed f0); root B: watchers W1, W2 on n; ZERO receipts anywhere
      | root A: transition t whose only change is a React-state deps change for n's hook
1 | root B transition j: pass P_B (mask{j}, pin p) renders W1; yields | touched(n)=0 ∧ CT(n) → FAST PATH → f0 value; W1.lastRenderPassId := P_B
2 | root A pass renders; hook stages f1 (deps ≠ committed) | stage lives in A's pass frame + A's lineage cache; P_B's probe unaffected (per-pass)
3 | A commits: F9 → P1′ installs {f1, promotedAtSeq q}; P2′ dirties K0(n), demotes RENDER_NEWEST passes | chain {f0(≤q), f1}; committed-for-root(B) resolves "now" = f1; P3′ walks value-blind: W1/W2 setStates
4 | yield gap: any NEWEST read of n (core effect, handler) | K0 recomputes under f1 → CT(n) TRUE again; touched(n) still == 0 (no receipts, no marks)
5 | P_B resumes; sibling W2 reads n | fastPath: touched==0 ∧ CT ∧ ¬staged ∧ ¬disabled → SERVES K0 = f1-value; but effStamp(n, w_B) = version-at-p = f0, and W1 rendered f0
6 | P_B commits | ONE COMMITTED FRAME: W1 = f0-output, W2 = f1-output — matching no version. TORN (blocker 1, re-derived)
```

The same hole reaches one level down (P2′'s dirt shallow-stales the K0
cone, but the first NEWEST traffic recomputes dependents under f1 and
restores their CT), and reaches the fixup's first fast-out (`touched==0 ∧
CT ∧ ¬fPD → return` serves the same unrouted state to a mounting
watcher's I18 check). Note the hazard is **cross-root only for open
passes**: a same-root commit discards the same-root WIP pass (F2
serialization), so same-root pins die at the promoting commit. Cross-root
pinned passes are ordinary (C11 full-spanning scope) — the blocker is
live, not theoretical.

### 2.2 Normative replacement text (amends synthesis R1 P2′; everything else in R1 carries)

**P2′ (replacement).** At F9 emission, after P1′ installs the new version
{fn, deps, stamp, promotedAtSeq q}:

1. Dirty the K0 node (donor invalidate — NEWEST freshness; unchanged).
2. Demote every open RENDER_NEWEST pass to its captured (mask, pin)
   (unchanged). **During this same open-pass enumeration** (the registry
   scan P2′ already performs, all roots), compute `oldestLivePin`.
3. **If `oldestLivePin < q`** — some live pass must keep resolving an
   older version — **route the promotion like a write**:
   - sample `t = F1.currentBatchToken()` (the committing batch; minted
     lazily by F1's existing contract if the batch never wrote); intern
     its slot s. If the fork reports several retiring tokens for one
     commit, any included one serves — only the slot's pin-gated
     retention matters, not which slot (one sentence, no new fact);
   - run the **ordinary step-4a marking frontier** from the promoted node
     n over K0∪K1 out-edges with bit s (`newBits & ~touched(m)`,
     self-terminating, appends newly-bitted nodes/effects/watchers to
     touchedList[s]) — the exact walk a write performs from a written
     atom;
   - set `wc[s] = max(wc[s], q)` — the slot clock now witnesses the
     promotion (consumers unchanged: ladder step 3, R6's skip bound,
     Δ4's conjunct 3);
   - the **superseded version record** (the chain entry q supersedes)
     counts as an **unswept entry of slot s** for the I10/I39 retention
     gate, with `retiredSeq = q` for force-clear's maxRetiredSeq; it
     sweeps exactly when R1's existing retention rule reclaims it
     (`min(live pins) ≥ q`).
4. If no live pin predates q: mark nothing, bump nothing — the chain is
   immediately length-1 by the retention rule, and every future pin ≥ q
   resolves the promoted version. (Promotions in quiet apps stay
   zero-cost; marks exist exactly when R1 retains a superseded version.)

P1′, P3′ (value-blind walk), P4, the effStamp pin-resolution rule, the
ladder's pin-resolved step 2, and the retention rule all carry verbatim.
Edge-add propagation extends bit s through later-recorded edges exactly
as for write bits (no text change — it already propagates whatever bits
the source holds).

### 2.3 Construction (replaces base §6.4 invariant R, source 3 — Δ2)

**Source 3 — evaluator identity (I22/I31/I45).** A *staged* evaluator is
excluded by the pass-frame probe, and staging demotes RENDER_NEWEST
(§5.1, unchanged). A *promoted* version divides by world class:

- Worlds that resolve at "now" (NEWEST, committed-for-root) and passes
  pinned ≥ q see exactly the promoted version — the K0 dirty makes CT
  false until a NEWEST recompute under it, after which fast-path serves
  are version-correct for these worlds (base case of the old text,
  unchanged).
- Worlds pinned **before** q exist only as passes already open at
  promotion time: pins are minted from the monotone globalSeq, so no
  later pass can pin < q, and memos keyed by dead pins are unreachable
  (worldKey). The P2′ enumeration therefore sees **every** consumer that
  can ever demand an older version. If any exists, every node whose
  cached evaluation can embed the promoted version — n and its K0∪K1
  cone; a node with no recorded path to n cannot change under the
  promotion, because by computed purity its evaluation never consults n,
  and any *future* re-branching into n requires a receipt or stage on the
  branch condition, which carries its own walk (the I4 first-divergence
  argument, applied to the evaluator as the divergence source) — carries
  bit s before the commit's folds complete, via the same monotone
  frontier that carries write bits; edges recorded later inherit s by
  edge-add propagation (I17/I23, unchanged machinery).
- `touched(n) ≠ 0` refuses the fast path and the fixup's first fast-out;
  the world path resolves `effStamp(e, world)` at the pin (R1) — r0 for
  pre-q pins, r1 otherwise. CT's wash-out at the next NEWEST recompute
  never re-opens the fast path for a pre-q pin: **the bit, not the dirt,
  carries the routing duty**, and the bit outlives every pre-q pin by the
  sweep gate (the superseded record is the slot's unswept entry).
- Bit-erasure sites (source 4's list) stay closed: slot recycle is
  swept-gated and the synthetic entry blocks the sweep while any pre-q
  pin lives; saturation force-clear of s sets fastPathDisabled on every
  pass whose pin < maxRetiredSeq(s) — the synthetic entry's retiredSeq =
  q puts every pre-q pin under the flag (world-path-only, version
  resolved at pin — correct, slower; I51's w_r capture covers the fixup
  consumer per R5). ∎

### 2.4 Consumer audit (every reader of the new marks/clock, one line each)

| consumer | behavior under Δ1 |
|---|---|
| read routing §6.2 | bits ≠ 0 → world path → pin-resolved version ✓ (the repair) |
| fixup first fast-out §11.2 | falls through to the loop + committed compare — the I18 check runs ✓ |
| fixup per-token loop (R6) | t retired (single-root promote): not enumerated; committed compare catches (cas bumped at q). t live (spanning): `wc[s]=q >` rendered bound → `runInBatch(t, setStateW)` — bounded value-converging over-render (delivery stays value-blind, D13/I13; an equality skip here would be S10) |
| memo ladder step 3 | mask∋s memos recorded pre-q refuse on `wc[s] > memo.seq` → re-evaluate → pin-resolved stamp re-derives the equal value — over-invalidation, safe, rare (only promotion-raced worlds), priced §7 |
| R4 drains | marked nodes/watchers join touchedList[s]; t's own retirement drain (same commit) reconciles committed observers value-compared — promotions now have a **durable** drain path, closing R4's enumeration for the promotion flip source (§4 VH-R4) |
| R2 delivery dedup | P3′ deliveries dedup in slot s as usual; pass-aware rule applies unchanged |
| saturation §5.4 | force-clear may target s once t is fully retired; compensation walked in §2.3 ✓ |
| renumber (R8) | promotedAtSeq already on the duty list; passes discarded first ⇒ min(live pins)=∞ ⇒ synthetic entries reclaimable pre-rewrite ✓ |
| quiescence (T8-N) | synthesis already sweeps superseded versions at quiescence (no live pins ⇒ all reclaimable) → bits die at slot sweep ✓ |

Ordering/atomicity: the marking frontier runs inside P2′, inside the
synchronous commit, not inside any walk (walk atomicity §10.2 — walks
dispatch no user code, and promotions run from commit code); P3′'s
delivery walk runs after it, sequentially. No yield-gap NEWEST recompute
can precede the marks (the commit phase is synchronous), and no pass can
start with pin < q after them (pins are monotone).

### 2.5 Repaired walk of C1-X6 (delta rows only; pinned as the regression test)

```
3′ | A commits: P1′ install {f1, q}; P2′: dirty K0(n); demote; scan open passes → P_B.pin p < q → MARK | t interned (slot s); frontier from n: touched(n) ∋ s, cone + W1/W2 → touchedList[s]; wc[s] := q; f0-record = unswept entry of s (retiredSeq q)
4′ | same commit: P3′ walk delivers; t's retirement drain (R4) reconciles committed observers | lastRendered(W1) vs committed-for-root(B) under f1: differ ⇒ urgent setState on B ⇒ B's WIP pass discarded at that urgent commit (F2) ⇒ restart pins ≥ q ⇒ uniform f1. Equal ⇒ no fire, P_B survives:
5′ | gap NEWEST read recomputes n under f1 | CT true; touched(n) ∋ s PERSISTS (pin-gated)
6′ | P_B resumes; W2 reads n | touched ≠ 0 → world path → effStamp(n, w_B) = f0 → M(n, w_B) serves f0 (ladder step 2 pin-resolved compare passes; step 3 vacuous: s ∉ P_B's mask) ✓ frame uniform f0
7′ | P_B commits; P3′-scheduled follow-up render (pin ≥ q) folds f1 | uniform f1 ✓ per-root self-consistency at every commit (C11 scope)
8′ | pins release: min(live pins) ≥ q | f0 record reclaimed → slot entry count → 0 → sweep → bits clear ✓ no permanent tax
outcome: no commit mixes versions; the pre-repair design tears at step 5/6.
residual risk: marking frequency = promotions racing live pins (SPK-R row, §7); pinned tests: this schedule; its fixup variant (mount on B at step 6 — first fast-out falls through, loop + Q2 compare correct); its saturation variant (force-clear s in the window — fastPathDisabled compensation).
```

## 3. Repair Q2 — the fixup fast-out compares the right two points (judge blocker 2)

### 3.1 Adversarial re-derivation (two schedules that kill R12 as written)

R12 captures `commitBaseline = {cas, lockViewId}` **at F3 lock-in** —
after the commit's own folds and lock-in — and returns when `cas ==
baseline.cas ∧ root.lockViewId == baseline.lockViewId`. Every
committed-side mutation site (retirement fold, lock re-mint, promotion)
executes inside a commit's F3/F9 sequence or a store-only close at a task
boundary; none can interleave a synchronous commit phase. So between the
capture and layout **nothing can move**: the comparator is tautologically
true, the fast-out always returns, and the w_fx compare — the I18
mount-race fallback — is dead code. The synthesis's own C9 amendment says
"rows 6–7 carry", but row 7's trigger is "fast-out fails (cas moved)",
which can now never fire: internal contradiction, and a torn frame:

```
K2a (pinned): foreign retirement in the render→commit window (C9 row 7 shape)
1 | pass P_k (mask{k}, pin p) renders mounting W on c-over-a; yields | w_r = ({k}, p, LV); v_r excludes default D (nothing visible)
2 | gap: store-only default D writes a@sD, closes, RETIRES | fold: committed a moves; cas := sD > p; R4 drain reconciles SUBSCRIBED watchers — W is not subscribed yet (mount pending): unreachable (the I18 race, verbatim)
3 | P_k commits; R12 captures baseline AFTER its own folds/lock-in | baseline = {cas_now, LVid_now}
4 | layout fixup: loop over LIVE tokens — D retired ⇒ not enumerated | fast-out: cas == baseline.cas ∧ LVid == baseline.LVid — TRUE BY CONSTRUCTION ⇒ return
5 | paint | W shows the D-less value; committed-for-root and every D-drained sibling show a=sD's value ⇒ TORN COMMITTED DOM; D is fully retired, W's dedup bits are clean, no future flip targets W ⇒ NO CORRECTION EVER (blocker 2, re-derived)

K2b (pinned): own-commit retirement folding a post-pin included write
1 | transition t writes a@s1; pass P (pin p > s1) mounts W on c | v_r folds s1 ✓
2 | yield: a t-attributed write a@s2 > p lands (no subscribed cone: only W, unsubscribed) | wc[t] = s2; no delivery target exists; t has no pending React work
3 | t retires AT P's commit (folds before layout: retired clause admits ALL entries incl. s2) | committed c ∋ s2; W rendered without s2
4 | fixup: loop over LIVE tokens — t retired ⇒ skipped; R12 fast-out ⇒ return | torn vs every R4-drained subscribed sibling, permanent (same terminal state as K2a)
```

(K2b's write vehicle today is a parked continuation racing settlement or
any future t-context write; with R2, a delivered post-pin write keeps t
live and the loop corrects — the conjunct below closes the class
structurally either way, at one compare per included slot.)

### 3.2 Normative replacement text (replaces synthesis R12's rule; base §11.2 otherwise unchanged)

**Capture.** At each commit's committed-side **entry** — immediately
before that commit's F9 publications, retirement folds, and lock-in (F3's
ordering clause gains this as step 0 — Δ5) — the root registry captures
`commitBaseline = {cas, lockViewId(root)}`. Two int copies per commit.

**Fixup committed-side fast-out** (after the per-token loop, replacing
both the base's original and R12's):

```
if commitBaseline.cas ≤ w_r.pin                      // no foreign committed-side motion since my pin
 ∧ commitBaseline.lockViewId == w_r.lockViewId       // no root lock-view drift since my render
 ∧ ∀s ∈ w_r.mask: wc[s] ≤ w_r.pin:                   // no post-pin write in any slot my render included
  return
v_fx = evaluate(n, w_fx); if !isEqual(v_fx, v_r): setStateW()   // unchanged
```

R5's conjunct on the *first* fast-out, the per-token loop with R6's
per-clause bound, and the w_fx definition carry verbatim. The champion's
"TAINT-only fast-out" remark is subsumed: taint-only touched words make
the loop vacuous and reach this same predicate.

### 3.3 Construction (why this comparator is exactly I43/I18)

v_fx − v_r can differ only through committed-side motion between w_r's
pin and layout (w_fx's mask clause is capped at w_r.pin, identical to the
render's own fold; live non-included tokens are invisible to both sides —
the base's held w_fx construction, unchanged). Partition that motion by
time against the capture point:

- **Before the commit's committed-side entry**: every retirement fold,
  lock re-mint, and promotion bumps cas, and every lock-in/advance on
  this root re-mints lockViewId — conjuncts 1–2 admit none after the pin
  (cas values are globalSeq mints, so `≤ w_r.pin` says "the latest
  advance predates my pin"; I15's one number line). Any such motion falls
  through to the compare, where w_fx's retired-at-NOW / current-lock-view
  clauses expose exactly what the render missed — fire ⟺ real
  divergence (K2a fires at step 4).
- **During the commit (entry → layout)**: only the commit's *own* F9
  publications, folds, and lock-in can run (single-threaded synchronous
  commit; store-only closes and parked settlements are task-boundary
  events — they cannot interleave). For a watcher rendered in the
  committing pass this motion is value-neutral: (a) own lock-in exposes
  mask writes to watermark = pin (fork test 33/I25) — content the render
  already folded through the mask clause at the same pin; (b) own
  retirement folds of included tokens re-present the same entries through
  the retired clause — value-identical **provided no included entry
  postdates the pin**, which conjunct 3 certifies (`wc[s] ≤ w_r.pin`;
  K2b fails it and falls through, where the retired-at-NOW clause folds
  s2 and fires); (c) own F9 publications equal the stages the pass
  rendered under (probe/R3 seeding; base §11.2's evaluator clause). A
  watcher whose rendering pass is not the committing one (Offscreen
  reveal) fails conjunct 1 — conservative fall-through.
- Base case: no motion at all — all conjuncts hold and v_fx = v_r
  trivially. Over-firing is impossible to make unsound (the compare
  fires a value-true urgent correction); under-firing is excluded by the
  case split. ∎

Cost: quiet in-pass mounts return in ≤ 2 + popcount(w_r.mask) int
compares, zero evaluations — R12's C9 arithmetic goal is preserved
honestly (row 16's repair survives; only its comparator moves). A post-pin
write by a still-live included token costs one wasted w_fx evaluation
(equal ⇒ no fire — correct: the loop's runInBatch is the corrector there,
and an urgent fire would tear the pending batch; base construction
unchanged).

### 3.4 Repaired walks (C9′/C10 delta rows; pinned)

```
C9′(a) quiet in-pass mount | loop: skip (R6) / empty | fast-out: baseline.cas ≤ p ∧ LVid match ∧ wc[k] ≤ p ⇒ RETURN — zero evals ✓ (pinned cost test)
C9′(c) = K2a repaired | step 3′: baseline captured at entry = {sD, …}; sD > p ⇒ conjunct 1 FAILS ⇒ v_fx (retired@NOW ∋ D) ≠ v_r ⇒ urgent pre-paint setState ✓ (I18 fallback restored)
C9′(d) = K2b repaired | wc[t] = s2 > p ⇒ conjunct 3 FAILS ⇒ v_fx retired@NOW folds s2 ≠ v_r ⇒ fire ✓; parked-live variant: loop fires runInBatch(t) and the eval compares equal — one bounded eval, no false urgent
C10 race (i) | k retires mid-window at ITS commit/close ⇒ cas bump precedes this commit's entry ⇒ conjunct 1 fails ⇒ fire ✓ (champion row 5's outcome, now reachable again)
C10 race (ii), C2-M | unchanged verbatim (loop paths; conjunct 3 vacuous over empty mask)
outcome: fire ⟺ the render missed committed-side truth; own-commit motion excluded by capture point, not comparator blindness.
residual risk: none new; pinned tests K2a, K2b, C9′(a) cost row.
```

## 4. Docket re-derivations — verified-held register (every walk shown or delta'd)

**VH-R1 (pin-resolved version chain, retention, ladder step 2, P3′
value-blind, demotion) — HELD except routing (repaired, §2).** Attacks
walked: (i) the champion's S32 re-walk re-checked line-by-line — rows
1–5 stand, and Δ1 changes only the branch where the R4 drain now also
reconciles B's watchers at t's retirement (outcome uniform either way:
value-different promotions urgently restart B's WIP per F2; value-equal
ones commit the old-version frame whose values equal the new fold — no
visible divergence, follow-up converges). (ii) Suspense-retry pin
interaction: a retry's new pass re-pins; effStamp resolves per its pin;
recorded prefixes compare pin-resolved (synthesis interaction audit) —
no livelock re-opened (I40 stamps installed unchanged at P1′). (iii)
Committed-for-root memos recorded under r0: worldKey resolves at "now",
ladder step 2 refuses on the vector — held pre-repair and unchanged.

**VH-R2 (pass-aware suppression) — HELD, with Δ6's wording pin.** The
rule text quantifies over "no started-and-uncommitted pass"; the
implementation note said "the root registry already holds each root's
active pass frame" (singular). Attack: T's pass completes-uncommitted
(suspensey commit wait) at pin p; urgent U starts and commits (its frame
closes); then a carried continuation writes a@s2 under T with (W, T)'s
bit set. If the registry dropped T's frame when U started, the check
finds no open pass ⇒ suppress ⇒ T's finished tree commits a=1 and a
later watermark advance exposes s2 with no scheduled work — S33
verbatim. F2's own edges forbid the drop: T's frame lives
[passStart, passEnd(commit|discard)), and completion is not an edge —
Δ6 makes the note match (all open frames scanned, ≤2 in practice).
Remaining attacks held: cross-root passes correctly ignored (scheduled
work on root(W) captures a fresh pin ≥ seq); bit-set-with-no-scheduled-
work impossible (a fiber with pending lanes never bails); seq/pin
strictness (pins mint before later writes on one line); renumber
interaction (no passes exist during rewrite — R8 step 1). Pinned test:
the completed-uncommitted frame schedule above (fork test 32's semantics
supply the follow-up render).

**VH-R3 (seeding / staging walk / termination, incl. A/B/A) — HELD.**
Attacks walked: (i) *A/B/A*: with pure deps, attempt 2 recomputes the
same deps (same props/state) ⇒ matches seed ⇒ no walk ⇒ terminate; the
champion's row-6 A/B/A is the impure-deps case, and its two restarts
land in React's own update-depth limits — construction honest as
written. (ii) *Cached consumer coverage*: a watcher of m that consumed n
through a memo recorded in an earlier pass — the K1 edges recorded at
that evaluation persist (add-only) and the walk runs at stage time,
after any such recording; a consumer whose current-topology evaluation
never reads n cannot change under n's stage (purity + I4-style first
divergence: re-branching into n requires its own walked change) ⇒ the
walk's K0∪K1 reach is exactly sufficient. (iii) *Multiple stagings in
one pass*: each change walks; one restart seeds all; selections are
pure-stable ⇒ second attempt walks nothing. (iv) *Discarded pass*:
queued own-lane updates die with the pass; restart seeds from the
lineage cache ⇒ uniform. (v) *Cross-root isolation*: stages are
lineage-scoped; another root's pass correctly reads committed until
promotion, then Δ1 routes its pins. Pinned: the S-before-O schedule and
the impure A/B/A row (both already in the champion's test list; kept).

**VH-R4 (closed drain coverage) — HELD for receipt flips; enumeration
now closed for promotion flips via Δ1.** Attacks walked: (i) the
b-codex-3 schedule re-run — row 6's advance drain reconciles W against
FULL committed-for-root, so divergence exposed by K's advance but caused
by D's retired fold is caught from touchedList[K] membership (K's own
write walk put W there); generalized: any watcher whose committed fold
changes at t's flip reads an atom holding a flipping t-entry through a
path that carried t's bit while t was live-or-unswept (retention I39;
force-clear targets only fully-retired slots and compensates) — the
champion's induction, re-derived intact. (ii) *Pending-render false
fire*: lastRendered updates only at committed renders (§11.3), so
reconcile never compares a finished-uncommitted tree's values — no
urgent tear of pending batches. (iii) *Store-only retirement*: the drain
runs at the close, urgent-pre-paint semantics preserved (§5.3 step 6).
(iv) *Promotion flips*: previously corrected only by P3′'s live walk
(sound for subscribed watchers — promotions are never io-gated — but
outside the drain enumeration and silent for edges recorded later); Δ1's
marks put the promoted cone in touchedList[s], so t's same-commit
retirement drain reconciles durably, and the late-edge variant
reduces to first-divergence (§2.3): a committed reader of n has an edge
at its last evaluation, so the walk/drain reaches it; a non-reader is
not divergent. Coverage statement amended to name promotions as a flip
source (one line in R4's construction).

**VH-R8 (live renumber) — HELD, with Δ7's two wording pins.** Attacks
walked: (i) *finished-uncommitted trees*: they hold pins and F9
publication ids; if "WIP" excluded them, a post-renumber commit carries
stale-numbered identities ⇒ "every WIP pass" must (and now explicitly
does) include completed-but-uncommitted trees — after which the
"no seq-bearing identity outside the library" fact is checked member by
member: WIP hooks (discarded), lineage caches (library-side, rewritten),
committed fibers (hold values only), carrier cells (token serials, a
separate counter), capsules (die by epoch key; in-flight thenables inert
by R10's reference check — a nice cross-repair closure). (ii) *Mint
inside an atomic extent*: retirement folds mint stamps mid-commit;
renumber defers to the operation boundary, so H needs slack ≥ one
extent's mints — Δ7 states it; forced-small-H test pins it. (iii)
*Forced discard is implementable with no new fork surface*: inserting a
trivial interleaved update per root (fork test 32's machinery) makes
React abandon and restart WIP — noted in the seam section; rides
O7/O23's existing fork-existence-proof risk line, no new fact.

**VH-R9 (fold identity / committed-reference installation) — HELD.**
Attacks walked: (i) *post-pin foreign retirement before commit*: the
committing world's memoized prefix then differs from committed-now ⇒ the
conditional installation correctly does not fire ⇒ fresh fold (the rule
is prefix-equality-gated, not unconditional). (ii) *Two candidate memos*:
installation names the committing world's — deterministic. (iii)
*Stepwise-equality re-folds* keep old references (I29) ⇒ reconcile and
effect compares stable ⇒ no ping-pong (b-codex-1's schedule
unrepresentable). (iv) *Cross-world fresh references* are React's own
rebase behavior (C3) — stated, still legal. (v) Lifecycle: fold memos
ride M(n, worldKey)'s §15 row (key drift + epoch). Pinned: `a.state ===
a.state` within one render; committed reference === committing render's
reference at C3's steps (fork test 33 load-bearing).

**R12 — KILLED as written (K2a/K2b, §3.1); replaced by Q2 (Δ4/Δ5).**

**Merged fork-test list — re-derived, each load-bearing claim named.**
29 (discard cannot later commit — R3/R8 depend: discarded stages must
never publish); 30 (same-root urgent commit discards an older yielded
pass before F9/lock publication — F2 serialization; VH-R2/C11-A lean on
it); 31 (stable root ids; portals report parent — root registry keys for
lock views and commitBaseline); 32 (updates inserted after completed
work force a pre-commit restart — load-bearing for R2's follow-up
render, R3's staging restart, and R8's forced-discard implementability);
33 (watermark = committing pass pin — load-bearing for R9's reference
installation, I25, and Q2's own-lock-in neutrality). **Added: 34** —
commitBaseline capture precedes the same commit's F9/folds/lock-in
(reconciler-level ordering assert; Q2's capture point); **35** — F9
emission can sample F1.currentBatchToken() and receives the committing
batch (lazily minted if needed; Q1's slot source). Tests 1–28 carry
verbatim.

## 5. Lifecycle deltas (Δ3 — the I19 rows for both repairs)

| state item | minted/set by | observed by | cleared/reset by | forced test |
|---|---|---|---|---|
| touched bits 0–30 (row amended) | write walk; edge-add; E-PRESERVE; **P2′ promotion marking when a live pin < q** | routing; fixup; drain enumeration | slot recycle (swept-gated — **superseded version records count as entries**); force-clear sweep (+fastPathDisabled; **synthetic retiredSeq = q**) | C1-X5; **C1-X6** |
| wc[s] (row amended) | writes in s; **promotion: max(wc[s], q)** | ladder step 3; R6 skip bound; **Q2 conjunct 3** | zeroed at slot re-intern | C13; **K2b** |
| superseded evaluator version (row sharpened) | P1′ promotion | effStamp pin resolution; **slot unswept gate; force-clear maxRetiredSeq** | reclaim at min(live pins) ≥ q; quiescence sweep; renumber rewrites promotedAtSeq | **C1-X6 row 8′** |
| commitBaseline (row re-anchored) | **commit committed-side entry (before F9/folds/lock-in)** | fixup fast-out (Q2) | end of commit (per-commit scratch) | **fork test 34; K2a** |

All other §15 rows carry verbatim. Every new mint site has a stated
clear site paired with the identity it outlives (I8/I19); the schema
sweep's retainer table gains the two amended rows.

## 6. Seam (delta only; fork facts unchanged in count and shape — nine)

F1–F9 carry verbatim with the synthesis's amendments. Δ5 adds one
ordering clause to F3: within a commit, **step 0: commitBaseline capture
→ F9 publications → retirement folds/lock-in → reconcile + effect flush
→ layout effects** — an anchor re-position of state R12 already
introduced, at a place the reconciler already owns (commit entry), one
line in the same hook site. F9 gains a clarifying sentence, not a
capability: its emission context is inside the committing batch, where
F1's existing `currentBatchToken()` answers (test 35). No new facts, no
new callbacks; reconciler sites stay ~16. Rebase drill answer unchanged:
tokens, pass edges, retirement/lock edges + the commit-entry capture,
runInBatch, lineage ids, publication ids — all re-implementable protocol
facts; lane renames, commit-phase moves, and update-queue changes move
zero library lines. Fork test list: 1–33 carried + 34–35 (§4).

## 7. Gates and numbers (Δ8 amendments only; nothing unmeasured asserted)

- **G-F**: fast-out now ≤ 2 + popcount(w_r.mask) int compares (was 2);
  zero-eval claim for quiet in-pass mounts preserved and **pinned as a
  cost test** (C9′(a)); bounded extra: one w_fx eval per mount whose
  included slot carries a post-pin write (loop-corrected case); one
  over-render per mount inside a live spanning batch that promoted
  (§2.4 loop row). W2 workload rows carry.
- **SPK-R**: adds the promotion-marking row (frontier size × promotion
  frequency, non-zero only when a promotion races a live pin) beside the
  existing promotion-walk and advance-drain rows.
- **SPK-W**: adds the ladder-step-3 over-invalidation row (mask∋s memos
  re-derived once per raced promotion).
- **G-Q**: zero delta — Δ1/Δ4 add no instruction to quiet-path reads,
  writes, or renders (marking and the fast-out run at promotions and
  mount layout only). O19's LOGGED-quiet floor question is untouched.
- All other gates, spikes, and fallbacks carry verbatim (SPK-L, SPK-N1,
  SPK-G8, SP2, SPK-K1; D13-fallback obligation per O24 intact).

## 8. Battery disposition (full battery; delta-focused per the round brief)

Unchanged cases cite the champion's walks **verbatim** (synthesis Part IV
over the base §17); listed here case-by-case so nothing is silent:

| case | disposition |
|---|---|
| C1 core, V2–V7 | verbatim (Δ1/Δ4 touch no row: no promotions, no mounts in these walks) |
| C1-X1 | verbatim + row 8 sharpened: a cross-root promotion during this pass's yield now also **marks** (Δ1) — the pin rule row 8 already asserted is now enforced by routing, not only by the ladder; new cross-ref to C1-X6 |
| C1-X2, C1-X3, C1-X4 | verbatim (walkGen, taint, retention untouched) |
| C1-X5 | verbatim + row 9 (R5) + the Δ1 note: force-cleared promotion slots compensate identically (walked §2.3) |
| **C1-X6 (new)** | the Q1 killing schedule + repaired walk (§2.1/§2.5) — pinned |
| C2, C2-M | verbatim (single write pre-pass; conjunct 3 vacuous over empty mask — §3.4) |
| C3, C3-E, C3-R | verbatim + R9 reference annotations carry; C3-R's P3′ walk unconditional (synthesis) |
| C3-M | verbatim + row 2 note: if any live pin < q existed, P2′ also marks (Δ1); row 6's saturation×promotion now names the synthetic retiredSeq (§2.3 erasure bullet) |
| C4, C5 | verbatim (R2's case split cited; different slots / burst-before-pass) |
| C6, C7, C7-D | verbatim (demotion-on-promotion carries) |
| C8 | verbatim |
| C9 | **amended**: C9′ rows in §3.4 (quiet zero-eval; K2a foreign-retirement; K2b post-pin fold); rows (b) fresh-node and row 8 saturated-mount carry verbatim |
| C10, C10-R | race (i) re-walked under Q2 (§3.4); race (ii) verbatim |
| C11, C11-W, C11-A | verbatim (lock views untouched; C11-A row Y's F2 serialization is what confines Q1's hazard to cross-root — noted) |
| C12, -U, -T, -F | verbatim (carrier untouched) |
| C13 | verbatim + §5's four amended rows + forced tests: C1-X6 row 8′ (version-record sweep), K2b (wc from promotions), fork test 34 |
| C14 | verbatim (R3 seed row cited; Δ1 adds no render-phase behavior) |
| C15 | verbatim (effStamp pin-resolution unchanged; R10 identity check unchanged) |
| C16, C16-D, B1 | verbatim + one line: promotion flips now also reach effects via the durable drain (Δ1), strictly more coverage, value-compared |
| C17 | verbatim (discharged by deletion) |
| T8-N | verbatim (quiescence already sweeps superseded versions) |

New pinned regression schedules this round: **C1-X6** (+ fixup and
saturation variants), **K2a**, **K2b**, **C9′(a)** cost row, VH-R2's
completed-uncommitted-frame schedule, VH-R8's forced-small-H-mid-commit
row. No case is unwalked; C11 remains full-spanning scope; C17 remains
discharged by deletion.

## 9. Mechanism inventory (9 — unchanged; audit that the diff adds none)

Counted as structures with state and lifecycle (the champion's counting
rule), each carrying its synthesis-Part-V bracket plus this round's delta:

1. **K0 donor kernel + twin builds** [unchanged]
2. **Receipt tape + fold semantics** (incl. wc slot clocks, R9 fold
   memos) [wc gains the promotion mint site — Δ1]
3. **Token/slot/mask/pin + immutable lock views** [unswept gate's entry
   count includes superseded version records — Δ1]
4. **K1 + touched word + the walks** [marking frontier gains the
   promotion call site; touchedList gains promotion members — Δ1]
5. **World memos + suspense capsules, closed validity** [unchanged;
   ladder step 3 over-invalidation priced]
6. **Evaluator staging + F9 + promotion** [P2′ routes like a write when
   a live pin predates it — Δ1]
7. **Watcher/binding records** [fixup fast-out comparator corrected;
   commitBaseline re-anchored to commit entry — Δ4]
8. **Fork/build protocol F1–F9 + carrier** [F3 ordering step 0; tests
   34–35 — Δ5]
9. **Episode lifecycle** [unchanged; renumber duty list already carried
   promotedAtSeq]

Δ1 composes four of them without minting state kinds: the
marking frontier (mech 4), touchedList (4), wc (2's clock family), the
version chain's own retention record (6) doubling as the slot's unswept
entry (3's existing gate) — the one genuinely new *datum* is one seq
field reuse (`retiredSeq = q`) on a record that already existed. Δ4 moves
R12's existing two-int capture (7) earlier and changes two comparisons.
State-item ledger delta: added — none (commitBaseline existed; the
superseded-version record existed); amended — wc mint sites, touched-bit
mint/clear sites, commitBaseline capture point. Deleted — R12's
current-vs-baseline comparator (replaced, not augmented).

## 10. Known gaps (all carried; none added, none repaired-away silently)

G1–G8 carry verbatim (O19 quiet floor; D17/O22 carrier boundary; G3
permanent-writer cones; G4 unmeasured hot numbers with pre-named
fallbacks; G5 fork existence proofs — now also covering tests 34–35 on
the same critical path (O7/O23); G6 taint conservatism; G7 spillover
frequency; G8 combinatorial forced-test matrix with the oracle backstop).
New residuals declared in place: Δ1's marking/over-invalidation costs
(§7, SPK-R/SPK-W rows — cost, never correctness); Δ4's one-eval and
one-over-render bounded cases (§3.3/§2.4). OPEN items touched: O23
(F9/F1 sampling joins the existence-proof line), O24 untouched, O7
extended by test 34.

---

*surgical-a complete. Diff = 8 rows (§0); 2 repairs, each with its
killing schedule pinned (C1-X6; K2a/K2b); docket math re-derived with 6
verified-held entries (R1-core, R2, R3, R4, R8, R9) and 1 kill (R12 →
Q2); fork tests 29–33 re-justified + 34–35 added; 9 mechanisms
(unchanged); 9 fork facts (unchanged); no new mechanisms; every
unchanged walk cited verbatim from the champion.*
