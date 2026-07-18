# Review: COMPENSATED OVERLAY (round 1) — Claude reviewer

Design: `design-loop/rounds/round-01/design-compensated-overlay.md`
Method: full C1–C17 re-walk, counter-schedule attacks on every "by
construction"/"proven" claim (MARK §6.3 got the most fire), seam
enumeration (mark×kernel-lazy-eval, cutoff×buckets, fold-walk×lock-in,
sweep×retained-refs), lifecycle audit (C13 table re-derived), fork rebase
drill re-run.

---

## Findings (most severe first)

### F1 — BLOCKER: lazy first canonical evaluation punches a hole in MARK; torn committed frame that reconcile then suppresses

**The gap.** The MARK invariant (§6.3) claims: mark clear ⇒ every world
agrees with K0. Its construction covers nodes whose K0 edges *existed when
the divergence receipt's walk ran* (write walk, fold walk) and nodes
canonically *re*-evaluated mid-episode (re-evaluation is triggered by a
canonical change whose walk marked first). It does not cover a node whose
**first canonical cache is created mid-episode by a lazy NEWEST-context
read** (event handler in a yield gap, core `effect()`, any non-render read).
That evaluation is triggered by a *read*, not by a walked write/fold, so no
mark is ever stamped — yet it creates exactly the K0 cache + edges that the
§6.1 fast path will serve to pinned world reads.

**Failing schedule.** Setup: committed `a=0`; computed `f = () => a*2`
never yet read (no canonical cache, no K0 edges — a module-level computed,
or a `useComputed` node from step 2); components M and S both read `f` in
transition k's pass; a click handler can read `f` (handle/ref) during a
yield.

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | k (deferred): `a.set(1)` | tape(a)=[1@1/k]; K0 a stays 0; M3.walk(a): bucket[a] empty, K0 subscribers of a = ∅ (f has no edges yet) → only `mk(a)` |
| 2 | k-pass starts (pin=1); M renders, reads f | f has no canonical cache → fresh-node bypass (C9-3b) → worldEvaluate(f,({k},1)): a marked → fold=1 → f=2; memo[(f,{k})]=2, cert{(a,1)}→bucket[a]; M shows 2 ✓ |
| 3 | pass yields; handler reads f | bypass (still no cache) → currentWorld()=NEWEST → `K0.readCanonical(f)`: kernel lazily evaluates f canonically → caches f_K0=0, creates edge a→f; handler correctly sees 0; **markPlane[f] never stamped** (a's only walk ran in step 1, before the edge existed; nothing marks on cache creation) |
| 4 | pass resumes; S reads f in ({k},1) | §6.1 line 1: markPlane[f] < eraFloor → **serve K0 = 0**. The memo[(f,{k})]=2 is never consulted (fast path short-circuits). S renders 0; M shows 2 and a-reading siblings show 1 — torn k-frame in one pass |
| 5 | k commits, retires | DOM: a=1 next to f=0. M9 fold applies a=1 → fold-walk NOW traverses a→f, marks f, drains bucket[f] dep entries → S's watcher cert hit → delivery runs the reconcile check: S.lastMask ∋ k ∧ S.lastPin(=1) ≥ maxSeq(k writes)(=1) → **suppressed**. Wrong f=0 persists until some future write to a |

Wrong observable: torn committed frame in k's own commit, then a
permanently stale committed value — the reconcile check (§9.3) reads "S
already observed these receipts" from (mask, pin) and cannot see that S's
render was value-wrong.

Mechanisms defeated: M4/MARK + the fresh-node bypass + M9 reconcile, in
combination. The induction's stated maintenance sites (write walk, fold
walk, floor bump) are not the complete set: **fresh canonical cache
creation is a fourth mutation of the state MARK quantifies over.**

Severity: BLOCKER. Judgment: **local fix** — when a NEWEST-context read
canonically evaluates a node that had no canonical cache while any live
slot/receipt exists, stamp `markPlane[node]` (conservatively: whenever
`liveSlots ≠ 0`). The site already exists as the fresh-bypass predicate
branch in the read dispatcher; over-marking is sound (mark set only routes
to the overlay, and NEWEST reads still serve K0). The dev MARK sweep must
also run at cache creation, not only after walks (as specified it would
catch this one walk too late — after step 4's torn read). Caveat for the
judge: §16 declares any "fifth channel" the stance's kill condition; I
read this as the audited "fresh nodes" channel incompletely closed on its
canonical side (one guarded stamp at one existing branch, still enumerable
and sweep-checkable) rather than a new channel class — but by the letter
of §16 the design invited the architectural reading.

Note: a *second* k-write to `a` after step 3 would heal S (the walk now
traverses the a→f edge, marks f, drains bucket[f]) — the schedule requires
no further writes to `a` before commit, which is the common case.

### F2 — HIGH: the urgent `k0Changed` delivery cutoff gates bucket-hit notifications; a canonical-equal urgent write silently moves a deferred world

**The gap.** §8.3: "urgent writes deliver only if k0Changed", where
k0Changed compares the *canonical* fold. But bucket-hit memos live in
deferred worlds whose folds can move when the canonical fold does not
(set-clobbers-updater, updater-over-different-accumulator). §7.3/§8.3 route
bucket-hit invalidation *notifications* (and the C1-T5 `runInBatch`
corrective) through the same delivery rule, so they die with the cutoff.

**Failing schedule.** Setup: committed `a=3`; watcher W on computed
`c = f(a)`; deferred T: `a.update(x=>x+1)` → tape [+1@1/T], K0 a=3. T's
pass renders W with pin≥1: memo[(c,{T})] from a_T=4; W.cert{(a,1)}; T's
pass finishes, commit not yet performed (yield / scheduler gap).

1. Urgent U: `a.set(3)` (equal to canonical). Tape non-empty → receipt
   [set3@2/U] appended (I7, correct). `replayNewest` = fold(base 3, skip T,
   set3) = 3 = K0 → **k0Changed = false** → no K0 write.
2. M3.walk(a, U, false): cutoff → no watcher delivery. bucket[a] urgent →
   check ALL entries → cert (a,1): tail_T(a) is now 2 ≠ 1 → memo
   invalidated — but the §8.3 delivery **and** the `runInBatch(T,
   setState(W))` corrective are skipped under the same k0Changed gate.
3. T's world value of a is now fold(3, +1@1, set3@2) = **3** (set clobbers
   the +1); it was 4. No setState ever lands in T's lane → React commits
   T's already-rendered tree showing c(4).
4. T retires: fold = 3 = K0 → no applyToK0 → no fold-walk delivery.
   Committed DOM shows output derived from a=4 while committed a=3 —
   stale committed frame, uncorrected until the next a-write.

Blast-radius ambiguity: if M8's layout-effect L2 recheck runs on **every**
watcher commit, W is caught at its own commit and corrected pre-paint
(cost, not tearing); §10.4 specifies M8 only for the mount gap (C10). The
design must pin M8's scope; as written the natural reading is mount-only
and the frame ships.

Mechanisms defeated: §8.3 cutoff × §7.3 bucket semantics (a seam: validity
is per-world, the gate is canonical-only).

Severity: HIGH. Judgment: **local fix** — bucket-hit invalidation
deliveries and their correctives must be unconditional (or gated on the
*memo-world's own* fold movement), never on canonical k0Changed; and state
M8's scope explicitly (every-commit recheck is the cheap belt that also
bounds this class).

### F3 — HIGH: C16's "re-flush at lock-in" has no constructed mechanism, and the obvious ones provably don't fire

**The gap.** C16 step 3 asserts: "onRootCommit → locked[r] ∋ D; effect
scheduler re-flushes effects whose certs/deps moved in the newly-locked
world." No mechanism in §2/§9/§10 performs this. The candidates fail:

- **Fold-walk delivery** (M9): for an urgent-classified batch D the
  retirement fold computes exactly the already-applied K0 value →
  `applyToK0` never runs → no fold-walk → no delivery, by construction.
- **Write-time delivery**: D's write walk queued the effect once, but the
  battery's own schedule consumes it — an *unrelated* retirement flushes
  the effect first (in the pre-D committed world), emptying the queue.

**Failing schedule** (= C16's own schedule, walked to the end): `a=0`;
`useSignalEffect` E reads a. D: `a.set(1)` → K0 a=1, receipt [1@1/D],
uncommitted; E queued by the write walk. Unrelated retirement flushes E →
E reads world (locked[r], clock): a marked → fold excludes D → observes 0
✓ (step 2 correct); queue entry consumed. D renders, commits: onRootCommit
sets locked[r] ∋ D — a bit is set, nothing walks; onRetire(D): fold(a)=1=K0
→ no walk. **E never re-runs; the committed a=1 is never observed.** C16's
required outcome ("after D commits, the effect re-runs seeing it") fails —
a missed notification.

Mechanisms defeated: M10 (sets state, notifies nobody) + M9 (no-op fold on
urgent-applied batches) + the write-walk queue (consumed pre-commit).

Severity: HIGH. Judgment: **local fix**, and the parts exist: retirement
already enumerates the slot's written atoms (the fold needs them), effect
flush evaluations produce certs — so at `onRootCommit(root, tokens)`,
sweep each token's written-atom list through the buckets and re-queue
every effect whose cert fails against the newly-locked world (requires
effect certs to register in buckets, which §7 implies but never states).
Alternatively make effect-queue entries sticky: tag with the delivering
write's seq, retire the entry only when a flush world's visible tail ≥
that seq. Either construction must be written into §9/§10.6 and priced.

### F4 — MEDIUM: untracked reads recorded in certificates over-notify, violating the untracked contract and skewing world vs. canonical staleness semantics

§7.1 records "every read"; §16 confirms "untracked reads — recorded in
certs like tracked ones." Certificates feed buckets; buckets *notify*
(§7.3). Schedule: computed c reads `u` via `untracked()` (user's explicit
"do not re-render me on u"); c is world-evaluated in k (marked via a
tracked dep); cert gains (u, tail); any later write to u → bucket[u] hit →
memo invalidated **and W notified/re-rendered** — the exact re-render the
user opted out of. Meanwhile K0's canonical cache of c keeps alien-signals
semantics (stale until a *tracked* dep changes), so world-c is
untracked-fresh while canonical-c is untracked-stale: two staleness
contracts for the same node depending on which plane served it. No torn
frame (MARK is unaffected — u has no canonical edge, c's K0 cache is
stale-by-contract for every reader), but a semantics break against R13's
`untracked()`.

Severity: MEDIUM. Judgment: **local fix** — keep untracked entries in the
certificate for *validity* (dropping them is scar S5) but flag them
no-notify: bucket hits on flagged entries invalidate the memo without
delivering setState (next world read re-evaluates; staleness-until-then is
what `untracked` means). Document the residual world/canonical staleness
skew or mirror K0 by excluding untracked entries from L2 while keeping
them for the dev sweep.

### F5 — MEDIUM: thenable key `(node, mask ∪ locked, position)` drifts when an unrelated batch commits mid-suspension → spurious refetch/re-suspend

Schedule: transition k suspends computed c: thenable cached at
(c, {k}∪locked₀, 0). While suspended, an unrelated batch D commits on the
same root and is *not yet fully retired* (multi-root D, or any window where
locked[r] ∋ D) → k's retry pass composes mask {k}∪locked₀∪{D} → different
key → cache miss → **re-fetch and re-suspend**, despite C15's "retry
re-evaluates through a per-world cache with stable identity." Terminates
(locked drift requires commits; eventually stable → settles), and identity
*within* one pass stays consistent, so no wrongness — but the
re-fetch-on-retry trap the design calls out for passSerial reappears in a
narrower form. Severity: MEDIUM (UX/cost, bounded). Judgment: **local
fix** — on miss under a drifted mask, admit reuse of an existing entry
whose certificate validates in the new world (the machinery exists), or
key by (node, lineageId-scoped canonical mask at first suspension) with an
explicit invalidation when the drift actually changes the node's inputs.

---

## Notes (no schedule reaches wrongness, or cost/spec hygiene)

- **N1 (cost, unpriced):** "dedup bits cleared at every onPassStart whose
  mask contains k" is O(watchers holding the bit) per pass start as
  written; 10k watchers × frequent passes is real money. A per-slot
  clear-generation counter compared at delivery makes it O(1). No gate
  covers pass-start work; add one.
- **N2 (sweep bookkeeping):** a memo/cert/thenable whose mask spans
  {k1,k2} chains into *both* slots' registries and increments both unswept
  counts; the sweep at k1 must unlink/decrement at k2 too (or tombstone),
  else I10's recycle gate over- or under-counts. T6's "the sweep IS the
  proof" needs this stated.
- **N3 (dangling ref):** `watcher.latestCert` points into a plane the slot
  sweep frees. Current uses are safe by ordering (promotion §9.4 precedes
  sweep §9.5; M8 always follows a fresh render), but any future consumer
  of latestCert without an epoch/validity tag is a C13-style stale-ref
  bug. Null it at sweep or tag it.
- **N4 (spec conflict):** §10.2 "a watcher's first render ever tracks K0
  edges" vs §10.4 "subscription becomes writable state only at commit" and
  C14's render purity. A discarded first pass must leave no K0 edges; say
  explicitly that first-render edges are applied *at commit* from the
  certificate's direct-read list.
- **N5 (scheduling dependency, unstated):** C1-T5's required "pending
  worlds include applied urgent state" is delivered by §5.2 only via the
  retired clause (or co-inclusion in the pass mask) — a live, unretired,
  unincluded urgent receipt is *invisible* to a deferred-world fold. The
  design implicitly relies on React never starting a deferred pass while
  an urgent batch is applied-but-unretired. That is probably true of the
  scheduler, but it is load-bearing: make it fork invariant #7 with a test,
  or T5's ✓ rests on undocumented scheduling.
- **N6 (protocol edge):** ≤31 live tokens is seed-invariant I10, but the
  design's "fails loudly past 31 — cannot happen" doesn't state the fork's
  policy when React itself entangles transitions under lane pressure
  (31 parked async actions + new transition, the design's own fork test 2).
  State merge-tokens-on-entanglement or documented-throw; silence here is
  where a crash ships.

---

## Verified held (attacked and survived)

- **C2**: the walk is synchronous inside `set`, so marks precede any
  same-event sync render; always-log is unconditional (I1). Attempted
  reorder attack fails. Held.
- **C3** incl. plain-set variant: single fold implementation, replay over
  pre-batch base at every site (write path §5.3, retire §9.2); I
  re-derived 2 / no-op / 4 / 4 and 5-not-6 independently. Held (I2).
- **C4**: the only dedup state is per-(watcher, slot) bits cleared per
  pass-start; no ARMED/once-per-staleness state exists to eat T2. Held (I5).
- **C5** incl. the design's own pre-pass variant (bit still set → skip is
  sound; the unstarted pass pins ≥2). Held — modulo F2, which is the
  *urgent* twin of this case's gate.
- **C6**: the "no implicit grouping" construction is real — delivery
  happens inside the write call; `batch()` defers only core-effect flush.
  Held.
- **C7**: attacked with an urgent write in the yield gap then resume: MARK
  routes every U-touched node to pinned folds (type-b/c divergence), and
  unmarked nodes are provably U-untouched; base records stay pre-batch
  mid-episode so pinned folds can reconstruct. Held (S7 structurally
  absent).
- **C8**: I7's empty-history-only drop; overlapping equal transitions
  traced to 1/1/1. Value side held; the notification side is F2.
- **C9a/9b**: fresh-node world path + complete certs + M7 + bucket
  registration close the world-side race. Held. (The canonical side of
  "fresh" is F1.)
- **C10**: M8 checks against all live slots' worlds; runInBatch-refused
  fallback is pre-paint by layout-phase construction. Held (pin M8 scope —
  see F2).
- **C11** (full spanning): `locked[root]` composition; K0 never contains
  unretired deferred writes so it lower-bounds every root; post-commit
  urgent renders on A compose k via locked[A]. Attacked with A-committed/
  B-pending urgent writes to k-read deps — buckets + runInBatch corrective
  cover the un-promoted-edges window until retirement promotes. Held.
- **C12**: D2 fold-on-retire unconditional; async parking = absence of
  onRetire. Held (S4 not repeated).
- **C13**: every counter row has a named guard; attacked lastPin/cursor
  numeric collision across episodeReset → worldEpoch check catches;
  markPlane never cleared except ticket-wrap bulk clear, floor bump is
  quiescence-gated. Held (I8).
- **C14**: idempotent memo publication (purity), render-phase writes
  throw, per-mask thenable identity. Held.
- **C15/T7**: mask-keyed thenables, sweep-on-any-included-slot-retire,
  commit-time promotion; the split-commit contamination attack fails
  (distinct masks by construction). Held except F5's drift wart.
- **C17**: surface deleted; battery's escape clause satisfied. Held.
- **MARK induction for nodes whose canonical caches predate the
  divergence receipts**: I attempted dynamic-dependency counter-schedules
  (`c = y ? x : 0` with deferred x-write, then urgent y-write / retiring
  y-fold) — all closed by fold-walk marking + urgent-walk marking + the
  "stale edges describe the served value" argument. The only breach found
  is cache-creation-after-receipt (F1).
- **Scars S1–S8**: none repeated; the design is visibly built against each
  (always-log, complete certs with tail-0, monotonic activation,
  per-callstack render context, empty-history-only equality drops).
- **Fork honesty**: 8 surfaces, integers/callbacks only, edge-triggered
  anchors named, rebase drill answered credibly, inert-when-unused stated,
  per-root lock-in honestly flagged as the unproven surface (gap 4).
- **Cost honesty**: gates tabled with donor provenance; SP-A/SP-B/SP-C
  pre-registered with decision rules; the two declared unknowns (read tax,
  cert scaling) match my reading of the hot paths. N1's pass-start clear
  is the one unpriced loop I found.

---

## Verdict

**Repairable.** The architecture's load-bearing bet — enumerable
completeness via MARK + complete certificates + source buckets — survived
every attack except one missed maintenance site (F1: fresh canonical cache
creation, a one-branch local fix that the design's own dev sweep can then
enforce, though §16's letter lets a judge call it the fatal fifth channel)
plus two delivery-gate/mechanism-specification holes (F2, F3) that are
rule changes inside the existing machinery, not new mechanisms. No finding
invalidates receipts/worlds/folds, the mark-and-certificate read path, or
the fork protocol; with F1–F3 fixed, M8's scope pinned, and the N-notes
written down, this is the strongest walk of the battery I can construct a
failure against only at the seams named above.
