# Round 1 synthesis — TWO-KERNEL, repaired (K0 canonical + K1 real world edges)

Synthesis agent, round 1. Inputs: four designs (two-kernel, compensated-overlay,
fork-native, open) and one adversarial review each (claude; this round produced
a single review per design — the codex column did not run, so "both-reviewer"
evidence class is unavailable and every notes-diff line cites walks or
measurements instead). Output: adjudication of all 25 findings, the round's
repaired final design, and the spike list.

---

## Part I — Adjudication (every finding, no silent drops)

Verdicts: CONFIRMED = I re-derived the failing schedule (breaking step quoted).
REFUTED = none this round (each finding carried a concrete schedule and each
schedule re-walked true). NEEDS-MEASUREMENT = 1 (turns on a number; spike
registered).

### two-kernel (review-two-kernel-claude.md) — the winner's repair list

| id | sev | verdict | breaking step (re-derived) | disposition in synthesis |
|---|---|---|---|---|
| TK-F1 | BLOCKER | **CONFIRMED** | Ep.1 urgent `cnd.set(true)` marks `v,w` K0-stale; quiescence clears worldSensitive flags but not K0 staleness. Ep.2 `k: x.set(5)`: `x` has no out-edges (`u` never evaluated) → walk flags only `x`. Urgent pass reads `w`: `F(w)=0 → k0.pull(w)` **recomputes against newest**, first-evaluates `u`, reads newest `x=5` → renders `w=11` beside folded `x=0`. Torn frame; invariant F holds yet the routing claim built on it ("pulled value correct for every world") is false — a lazy pull is a fresh newest-basis evaluation, not a cache read. | **Repaired** — §5.2 routed-serve rule + invariant R: non-NEWEST reads may serve K0 only when `flag=0 ∧ serve-without-recompute` (CLEAN_TRACKED status load); everything else world-evaluates. Walk C1-T8. |
| TK-F2 | HIGH | **CONFIRMED** | `c = a&&b`; t1 writes `a`, t2 writes `b`; W′ mounts urgent, fixup checks `world(t1∪cm)` and `world(t2∪cm)` — both equal rendered `false` → no corrective in either lane; React renders `{t1,t2}` jointly, bails out on W′ → committed frame: siblings show `c=true`, W′ shows `false`. Equality-per-token cannot see joint divergence. | **Repaired** — §10.2 reach-based fixup (no equality filter): corrective `runInBatch` into every live deferred token with writes, unless invariant R proves the node world-agnostic. Adopts open-review F2's subset-explosion argument (`x1&x2&!x3` defeats any fixed comparison set). |
| TK-F3 | HIGH | **CONFIRMED** | §3.3.1 mints `retiredSeq = ++retireSeq` (private counter) while §2 visibility and §3.3.3 compaction compare it against pins captured from `globalSeq` — incommensurable lines. Literal reading: click batch retires with stamp `1 ≤ pin 100` → resumed pass sees the click write (C7 drift). | **Repaired** — one number line: retirement stamps mint from `++globalSeq` (§4.3); `retireSeq` row deleted from the counter table; C3/C7 walks restated on the shared line. |
| TK-F4 | MEDIUM | **CONFIRMED** | `slotWriteSeq` retains old-epoch globalSeq values across the optional quiescence reset; a re-interned slot with no writes fails `clock ≤ memo.seq` forever → permanent fail-closed re-validation (waste, not wrongness) and an I8 guard-inventory miss. | **Repaired** — `internSlot` zeroes the slot clock (also at recycle); C13 table row added; forced-reset test. |
| TK-N1..N4 | notes | confirmed as hygiene | id-column reset story stated twice; SP1 written as pending though I11 measured it; R10 absent; multi-root thenable duplicate fetches. | All folded in: §7.4 single lazy-tag story; §13.4 cites I11; §10.6 SSR; §8.4 duplicate-fetch documented. |

### compensated-overlay (review-compensated-overlay-claude.md)

| id | sev | verdict | breaking step | consequence |
|---|---|---|---|---|
| CO-F1 | BLOCKER | **CONFIRMED** | Yield-gap handler reads never-evaluated `f` at NEWEST → K0 lazily creates cache+edge `a→f` with **no mark stamped** (no walk runs at cache creation); resumed pass: `markPlane[f] < eraFloor` → serves K0 `f=0` beside memo `f_k=2`; reconcile suppresses by (mask,pin) → wrong committed value persists. MARK's maintenance-site list (write walk, fold walk, floor bump) missed a fourth mutation site: fresh canonical cache creation. | Same defect class as TK-F1 (both designs, independently): **a mark/flag fast-path gate must also require serve-without-recompute**. Feeds proposed invariant I12 and scar S9. Repairable in-stance (stamp at cache creation) but the stance loses its "three enumerable sites" pitch — a rejection input for O1. |
| CO-F2 | HIGH | **CONFIRMED** | Urgent `a.set(3)` equal to canonical → `k0Changed=false` → §8.3 cutoff suppresses the bucket-hit delivery AND the `runInBatch(T)` corrective, while T's fold moved 4→3 (set clobbers updater). T commits its rendered `c(4)`; stale committed frame. Validity is per-world; the gate was canonical-only. | Lesson: canonical-value cutoffs must never gate world-cache invalidation *notifications*. The winner's walk delivers value-blind (no such gate exists); scar S14 proposed. |
| CO-F3 | HIGH | **CONFIRMED** | C16's own schedule walked to the end: D's write-walk queue entry is consumed by the unrelated pre-commit flush; D's retirement fold is a no-op vs K0 (urgent already applied) → no fold-walk; `onRootCommit` sets a bit and notifies nobody → the effect never re-runs seeing `a=1`. The "re-flush at lock-in" mechanism was asserted, never constructed. | Same class as FN-F4 (independent). Winner makes the retire/lock-in-edge flush an explicit mechanism (§10.4): fold-based (base moved ⇒ flush check), engine-microtask when no React commit runs, dep-version compare decides re-run. Feeds I14. |
| CO-F4 | MEDIUM | **CONFIRMED** | Untracked reads recorded in certs feed buckets; buckets notify → the re-render the user opted out of, plus two staleness contracts for one node across planes. | Winner is immune **by construction**: validity is clock/mask-based, so untracked reads need no validity entry, record no K1 edge, and trigger no delivery — stated in §8.5. Also an O9 argument: certificates carry contract obligations clocks don't. |
| CO-F5 | MEDIUM | **CONFIRMED** | Thenable key `(node, mask∪locked, position)`: unrelated batch commits mid-suspension → `locked` drifts → key miss → refetch/re-suspend, the narrowed form of the passSerial trap. | Winner keys thenables by fork lineage (F5), which is defined stable across the batch-set's life — drift-proof by protocol fact. Feeds the O8 settlement. |
| CO-N1..N6 | notes | confirmed as hygiene/pins | pass-start dedup-clear cost unpriced; multi-slot sweep bookkeeping; dangling `latestCert`; first-render edge purity conflict; T5 leans on an undocumented scheduler fact; 31-token pressure policy unstated. | N5's lesson adopted: the winner's T5/parity rests on the **fork mask-parity fact** (F2's `tokens` = exactly what React applies), not on scheduler folklore — stated at §11-F2 and fork test 4. N6: entangled transitions share a lane ⇒ share a token ⇒ ≤31 structural (§11-F1, fork test 11). |

### fork-native (review-fork-native-claude.md)

| id | sev | verdict | breaking step | consequence |
|---|---|---|---|---|
| FN-F1 | BLOCKER | **CONFIRMED** | Re-track under live-default mask `{D}` installs `edges(c)={flag,a}`; yield-gap sync write to `b` walks no edge; sync commit excludes D; gate fast-out passes (every window is deferred-keyed) → torn commit. The two readings of "committed-class" (§1 vs C1-T4) form a pincer with F2 — no consistent reading closes both. | Kills "canonical edges re-trackable from any live-token world." Winner never re-tracks canonical edges from world evaluations at all (K1 holds world edges; K0 re-tracks only from NEWEST evaluations, with E-PRESERVE mirroring). Feeds scar S11. |
| FN-F2 | BLOCKER | **CONFIRMED** | `fold` dropped the seed rule's `retired ≤ pin`: token U retires mid-yield (commit on another root / no-work close); resumed pass's first read of an unread node folds `fullyRetired(U)=true` → two siblings disagree about `x` in one committed tree. React needs no watermark because hook queues are per-fiber; SharedQueues are global — the charter's disanalogy, unconfronted. | Kills pin-free global queues. The winner's visibility math carries both pins (seed-verbatim); C7 walk shows the retired-after-pin exclusion. Feeds scar S12. |
| FN-F3 | BLOCKER | **CONFIRMED** | Skew tag condition tests the lagging root's mask (which equals fully-retired — no tag); surviving tags are cleared at the first root's validating commit while the hazard lives until global retire → torn commit on root B. | Winner's C11 needs no tag lifecycle: per-root lock-in masks compose into every pass/effect world by the same visibility math; nothing is cleared early. |
| FN-F4 | HIGH | **CONFIRMED** | Store-only transition retires with no commit on any root; committed world moves; `useSignalEffect` rides passive-effect flushes that never happen → lost observation indefinitely. | Same class as CO-F3; winner's §10.4 retire-edge flush (engine microtask when no commit) closes it. Feeds I14. |
| FN-F5 | MEDIUM | **CONFIRMED** (conditionally reachable) | Dedup pruned at global retire, not per-root commit: post-partial-commit same-token write finds the bit set → no setState, no pending update → stale frame on the committed root. Reachability hinges on an unpinned fork fact (per-segment async-action commits). | Winner hardening: watcher re-arm already clears per-pass; additionally slot-bit columns clear at each root's commit for that root's watchers (§9.1 re-arm note); the async-action fact is pinned by fork test 2. |
| FN-F6 | MEDIUM | **CONFIRMED** (proof-soundness; no standalone failure constructed) | Gate comparator uses `lastRenderedValue` recorded at render completion — includes discarded renders; the no-torn-commit proof needs commit-grade records. | Winner records `lastRendered` at the commit edge only (§10.1), never during render. |
| FN-F7 | MEDIUM | **CONFIRMED** | Gate sweeps/mount fixups evaluate computeds outside render callstacks with writes enabled (R8 config) → mid-sweep world drift or unbounded correction loop. | Winner: **every** world evaluation runs under the write-rejecting frame (render, fixup, reconcile, effect-world reads) — §8.5. |
| FN-F8 | MEDIUM | **CONFIRMED** | worldId minted over live token sets churns when a spanning urgent enters the retry mask → thenable identity lost → refetch loop. | Same lesson as CO-F5 from the other side: the suspense key must be lineage-scoped, not live-set-scoped. Feeds O8 settlement. |
| FN-F9 | MEDIUM | **NEEDS-MEASUREMENT** | No watcher-delivery cutoff: `c=a*0+b` with 10k watchers schedules 10k no-op renders per suppressed write — the same shape §12 used to kill the maximalist variant, unpriced. The winner shares the value-blind delivery choice (deliberately, per the cost-model warning), so the number decides the knob, not the architecture. | **Spike SPK-N1(grid)**: suppressed-write ratio × watcher count {10,100,10k} × writes/frame; decision rule: >2× DIRECT propagate class or >1 spurious render per (watcher,batch) → adopt §15-R1 per-slot mark fallback or default-on `notifyCutoff:'evaluate'` above a fan-out threshold. |
| FN-F10 | MEDIUM | **CONFIRMED** | dispatch appends, updates hot slot, bumps clock, **then** throws for render-phase writes — the rejected write persists and folds at retire. | Winner's write path checks the render frame **first** (§4.1 line 1), before token ask or append — stated with a StrictMode queue-untouched test. |
| FN-F11/F12 | notes | confirmed | seed misquote (dropped pins) enabling F2; global seq wrap guard unnamed. | Winner: visibility math quoted verbatim with both pins; 53-bit seq + episode-epoch guard row in §12. |

### open (review-open-claude.md)

| id | sev | verdict | breaking step | consequence |
|---|---|---|---|---|
| OP-F1 | BLOCKER | **CONFIRMED** | Equality-retained frontier F (real edges `{flag→c, b→c}`) loses its last liveness ref at k's retirement canonicalization; head links stay stale `{flag,a}` (head `c` never re-read); urgent `b.set(7)` reaches no live graph → W stale after **all** batches retire. The §7.2 induction is silent across retirement — exactly where it breaks. | Kills liveness-scoped world topology. The winner's K1 is add-only to quiescence — recorded edges stay walkable for the whole episode regardless of batch lifetime; retirement never expires reach. |
| OP-F2 | HIGH | **CONFIRMED** | Late-join check tests per-token projections; `c = x1 & x2` with t1,t2 live pre-mount: singleton projections equal → no corrective; joint `{t1,t2}` pass bails out on W → torn commit, unreconciled (W on no touched list). Subset checking is exponential; equality-filtered correction is unpatchable in principle. | **Adopted into the winner** as the C10 repair's justification (reach-based correctives) — proposed invariant I13/scar S10. |
| OP-F3 | HIGH | **CONFIRMED** (analytic) | Per-(v,k) frontier retention doubles per interleaved live batch: 2^n live graphs, thousands of projected pulls per write at n=10; SP-R2's "1,2,8,31 graphs" gate mismodels the true independent variable (2^31). The multi-batch induction *requires* the family, so a cap needs a new proof (owner-mask union), i.e. an M4 redesign. | Rejection input: eager per-write projection evaluation + powerset retention is the research-facts expensive shape squared. Feeds scar S13. |
| OP-F4 | MEDIUM | **CONFIRMED** | Detach-mid-pass: head box O1 served pre-yield, sparse re-evaluation post-resume mints O2 ≠ O1 — two identities for one logical value in one commit (breaks React.memo stability). | Winner has no head-aliasing/detach state to tear: routing is by flag+R per read; world evals cache in memos keyed (node, worldKey), one identity per world per episode. |
| OP-F5 | MEDIUM | **CONFIRMED** | Render-write guard defined only for sparse evaluation; head-equivalent pass renders write straight through `claimWrite` (detaching the currently rendering pass mid-render), StrictMode double-fires. | Winner: the guard keys on the per-callstack **pass binding**, not world identity — a pass whose mask covers all live slots routes reads to K0 as `RENDER_NEWEST` but still rejects writes (§5.1). |
| OP-F6 | MEDIUM | **CONFIRMED** | Pending thenable is a retaining ref for its cell; one hung fetch blocks episode compaction for the session → unbounded tape growth. | Winner: lineage caches drop at batch-set commit/**abandon** regardless of settlement; late settlement is a generation-checked no-op (§8.4). |

**Totals: 24 CONFIRMED, 0 REFUTED, 1 NEEDS-MEASUREMENT** (FN-F9 → SPK-N1 grid).
Cross-design convergences worth notes-status: TK-F1 ≡ CO-F1 (routing gates need
freshness, two independent derivations); CO-F3 ≡ FN-F4 (retire/lock-in edges
need their own notification path); TK-F2 ≡ OP-F2 (equality-filtered correction
is unsound for joint worlds); CO-F5 ≡ FN-F8 (suspense keys must be
lineage-scoped). All four designs independently chose per-write synchronous
delivery with `batch()` deferring core effects only (C6 "handle it") — a
genuine round-settled decision.

---

## Part II — Choice and rejections

**Winner: two-kernel.** Rationale in one sentence: it is the only design whose
review found *zero* defects in the load-bearing mechanisms (clock validity,
reach induction, per-write delivery dedup, fold parity, E-PRESERVE, lifecycle
guards all "verified held") — all four findings are seam rules with local
repairs that the reviewer pre-validated as compatible with the architecture,
whereas each competitor took a confirmed hit to its central bet (compensated:
MARK's enumerable-sites pitch; fork-native: the gate taxonomy, three ways;
open: frontier liveness/retention). Secondary: it lands on the measured-safe
side of every cost invariant (values in-plane per I11; no per-write world
evaluation per the G-7 warning; no per-link kernel state per D4) and answers
O9 with the simplest sound validity mechanism (clocks, not certificates).

**Rejected, per design (negative space for the judge and future rounds):**

From **compensated-overlay**: the certificate+bucket compensation stack (4
cooperating completeness obligations; CO-F1 showed the maintenance-site list
was not closed, CO-F4 showed certificates acquire contract obligations clocks
don't have — clock validity dominates, O9); mark-plane-as-routing-gate without
a freshness predicate (CO-F1); the canonical `k0Changed` delivery cutoff
(CO-F2); mask∪locked thenable keys (CO-F5). Adopted from it: the explicit
empty-history-only equality fast path phrasing (I7), and its §6.3 fold-walk
insight survives here as "retirement folds run the full notification walk."

From **fork-native**: fork-owned SharedQueues (FN-F2 proved global queues need
the retirement pin React's per-fiber queues never needed — the charter's
disanalogy, fatal as built); the pre-commit gate as the correctness guarantee
(its window taxonomy failed on all three divergence dimensions, FN-F1/2/3;
a safety net whose trigger list is the hard part is not a net); the
no-durable-world-cache bet (held-open transitions re-evaluate per pass — the
G-8 cost with no mitigation). Adopted from it: the **maximalist O4 kill with
schedules** (proposed for NOTES verbatim); commit-edge-recorded watcher values
(FN-F6); the write-rejecting scope for all non-render evaluations (FN-F7);
its useReducer-differential-in-fork test idea (folded into the fork suite).

From **open**: eager per-write projection evaluation (before/after/baseAfter
pulls per live graph per write — the research-facts expensive shape, and
OP-F3's 2^n retention on top); liveness-scoped world topology (OP-F1);
equality-filtered late-join (OP-F2 — its *fix* is adopted); head-aliasing with
detach-before-append (OP-F4's identity tear; flag-routing needs no detach
dance); v1 single-root scope (the winner's lock-in masks buy full spanning for
one table). Adopted from it: the reach-based join correction (C10 repair), the
render-write guard keyed on the pass binding (OP-F5's lesson), and its counter
table's rigor as the C13 bar.

---

# The repaired design

Stance: per-world staleness/reach lives in a second kernel plane (K1) whose
edges are **real** — recorded by world evaluations at read time — lazily
populated while forked, bulk-reset at quiescence. The canonical kernel K0 is
the donor arena kernel, closed and monomorphic. Values are one truth plus
receipts; worlds are folds; validity is clocks; notification is a per-write
full-reach walk delivered in the writer's stack. Four repairs (R1–R4 below)
and six transplanted hardenings change seam rules only; no load-bearing
mechanism moved.

## 1. One-page summary (the whole concurrency story)

**Two modes.** DIRECT (no React): the donor arena kernel K0 is the entire
engine; zero concurrency instructions execute (P3/D1). Registering the React
bridge — monotonic, never keyed to watcher count (S6) — rebuilds the kernel
closures once into LOGGED mode: a logging write function and two null-checked
per-recompute hooks are swapped in. K0's plane, walks, and exact-pull
semantics are the donor's.

**One value truth plus receipts.** K0's value column always holds the newest
world. In LOGGED mode every write — urgent included (I1) — first passes the
render-write guard, then appends a receipt `{op, slot, seq}` to the atom's
tape; the atom's pre-fork base is preserved on first receipt. Any world's
value is a fold: base + entries visible under `(retiredSeq≠0 ∧ retiredSeq≤pin)
∨ (slot∈mask ∧ seq≤pin)`, replayed in seq order — clause-for-clause React's
queue filtering and rebase (D3, I2). **All stamps — write seqs, pins, and
retirement stamps — mint from one monotone counter** (repair R3).

**Worlds route reads; a freshness rule guards the fast path.** A world =
(include mask over ≤31 slots, pin, per-root lock-in). The fork's pass
lifecycle drives a per-callstack `currentWorld` (yields reset it — I6). Reads
at NEWEST hit K0 raw. Reads in any other world serve K0 **only when the node
is unflagged AND its K0 record can be served without recompute** (invariant R,
repair R1 — an unflagged-but-stale node's pull would be a fresh newest-basis
evaluation and must world-evaluate instead). Flagged or non-fresh nodes go to
per-(node, worldKey) memos.

**K1 makes pending topology real.** World evaluations record their true read
edges in K1, a second bump-allocated plane — add-only while forked, epoch-
reset at quiescence (C13). When K0 re-tracks a node while forked, its old
edges are first mirrored into K1 (E-PRESERVE, one site), so no served value's
evaluation basis ever loses its edges. Reach never expires with a batch
(the OP-F1 lesson is structural here).

**Validity is clocks, not certificates.** A world memo is valid iff no
included slot has written since it was made (per-slot write clocks, zeroed at
intern — repair R4) and no retirement epoch has passed. S5-immune by
construction; untracked reads need no entry, record no edge, and trigger no
delivery (untracked contract preserved by construction). A direct-dep version
recheck ladder sits on top purely to avoid recomputes.

**Notification is a per-write full-reach walk in the writer's stack.** Each
logged write traverses its K0∪K1 cone once, flags visited nodes, and calls
each reached watcher's `setState` synchronously in the writer's execution
context (D5) with per-(watcher, slot) dedup re-armed on render (I5/C4). No
grouped drain exists, so C6 lane attribution is by construction. Value-blind
delivery is the priced trade (SPK-N1 grid decides the cutoff knob). The reach
induction (§9.2) proves walk-or-already-scheduled.

**React edges are reach-based, never equality-filtered.** The mount fixup
schedules correctives into **every** live deferred batch with writes unless
invariant R proves the node world-agnostic (repair R2 — joint-mask divergence
cannot be seen by per-token equality). Retirement and per-root lock-in run
their own notification path: folds walk, and signal-effect flush checks run
per root even when React commits nothing (transplant of CO-F3/FN-F4).
`lastRendered` is recorded at commit only.

**The fork speaks seven facts** (§11): write classification (lazy tokens),
pass lifecycle with yield/resume + a current-pass query, per-root
retirement/lock-in, `runInBatch`, render lineage ids, the DOM mutation
window, a version handshake. Bindings depend only on the protocol document;
the rebase drill answer is "the fork re-implements the facts; the library
moves zero lines."

**Lifecycle.** Retirement stamps from the shared counter, folds tapes by
seq-order replay (C3), respects pass pins before compacting (C7), locks in
per root (C11 full spanning), flushes committed-world effects on its own
edge. Quiescence resets K1/flags/memos/counters behind epoch guards (C13).

Numbers: DIRECT = donor kernel [ARENA]. Gates: logged write ≤2× DIRECT;
quiet tier-0 ≤2%; hook tax ≤1%; fixup over-render ≤ live-deferred count per
flagged mount; world-eval cost ∝ flagged/non-fresh region. Unmeasured items
are spikes (§13.5), never claims.

## 2. Repairs and transplants (delta log against design-two-kernel.md)

- **R1 (TK-F1):** routed-serve rule + invariant R (§5.2, §5.3); new walk
  C1-T8; donor unwatch-semantics pin test.
- **R2 (TK-F2 / OP-F2):** reach-based mount fixup (§10.2); gate G-F.
- **R3 (TK-F3):** retirement stamps mint from `globalSeq` (§4.3, §12 table).
- **R4 (TK-F4):** slot clocks zeroed at intern/recycle (§7.2, §12 table).
- **T1 (CO-F3/FN-F4):** retire/lock-in-edge effect flush made an explicit
  mechanism (§10.4).
- **T2 (FN-F6):** watcher `lastRendered`/`lastRenderSeq` recorded at commit
  edge only (§10.1).
- **T3 (FN-F7):** all world evaluations run write-rejecting (§8.5).
- **T4 (FN-F10):** render-write guard is the write path's first line (§4.1).
- **T5 (OP-F5):** guard keys on the pass binding; `RENDER_NEWEST` world for
  all-slots-covering passes (§5.1).
- **T6 (OP-F6/CO-F5/FN-F8):** thenable caches keyed by fork lineage; dropped
  at commit/abandon regardless of settlement; late settle generation-checked
  (§8.4).
- Hygiene: single K1 id-tag story (§7.4); §13.4 cites I11 as measured; R10
  SSR section (§10.6); ≤31-token entanglement policy stated (§11-F1);
  FN-F5-class re-arm hardening note (§9.1).

## 3. Concepts (defined before use; unchanged terms abbreviated)

- **K0** — donor arena kernel (`libs/arena`): one Int32Array plane, stride-8
  interleaved node+link records, alien-v3 push-pull, exact pull counts,
  179/179 [ARENA]. Holds newest values, newest topology, native staleness.
- **K1** — shadow plane holding **world edges** only (dep edges recorded by
  non-newest evaluations + E-PRESERVE mirrors): no values, no recompute
  machinery, add-only while forked, epoch-reset at quiescence.
- **DIRECT / LOGGED** — engine modes; LOGGED entered once at bridge
  registration via closure rebuild (monotonic, S6).
- **seq** — ONE global monotone counter (53-bit) minting write seqs, pass
  pins, and retirement stamps (R3).
- **tape / base** — per-atom append-only receipts `{op, slot, seq,
  retiredSeq}`; base = accumulator with no live receipts folded.
- **batch / token / slot** — fork-minted integer token per React batch,
  never reused live; interned to ≤31 slots (I10); include-sets are 32-bit
  masks. React entangling transitions into one lane = one batch = one token,
  so ≤31 is structural.
- **world** — `(mask, pin, root?)`; entry visible iff `(retiredSeq≠0 ∧
  retiredSeq≤pin) ∨ (slot∈mask ∧ seq≤pin)` (seed math verbatim, both pins).
  **NEWEST** — everything; K0 raw. **RENDER_NEWEST** — a pass world whose
  selection equals newest: reads route like NEWEST, writes still throw (T5).
- **worldKey** — interned `(mask, pin, rootLockInVariant)`, epoch-scoped.
- **world evaluation / world memo** — §8; memo `{value|sentinel, seq, epoch,
  deps[(id,version)], fnVersion}` keyed `(node, worldKey)`.
- **worldSensitive flag** `F(n)` — per-node monotone episode bit: "a logged
  write this episode may make some world disagree with newest below here."
  Routing filter only; never the notification mechanism.
- **CLEAN_TRACKED** — K0 status predicate (one in-plane flags load): node is
  evaluated, in the push-maintained (watched/tracking) regime, and carries no
  stale/pending bits — i.e. its cached value can be served with zero
  recompute. Atoms with empty tapes trivially qualify.
- **watcher** — `{setState, lastRendered, lastRenderSeq, notifiedMask}`;
  value fields written at commit only (T2).
- **pass / pin / lineage / retirement / episode** — as in the author design:
  fork-scoped pass with yield/resume; pin = seq captured at pass start;
  lineage = fork-minted stable id per (root, batch-set) across
  restarts/replays; retirement = exactly-once fold; episode = quiescence to
  quiescence.

## 4. Value model: tape, folds, parity

### 4.1 The logged write path

```
write(atom, op):
  if currentPassBinding occupied: throw       // FIRST: guard precedes any mutation (T4/T5; R8/C14)
  token = fork.currentBatchToken()            // lazy mint
  slot  = internSlot(token)                   // zeroes slotWriteSeq on first intern (R4)
  seq   = ++globalSeq;  slotWriteSeq[slot] = seq
  if atom.tape.length == 0: atom.base = k0.value(atom)
  atom.tape.push({op, slot, seq, retiredSeq: 0})   // ALWAYS — equal values too (I1/I7/C8)
  k0.writeNewest(atom, apply(op, k0.value(atom)))  // equality may skip K0 marks only
  notifyWalk(atom, slot)                           // §9: full reach, writer-context delivery
```

No write-time equality drop exists in LOGGED mode; DIRECT keeps the donor's
native equality skip (I7's empty-history case is exactly DIRECT). K0's
internal propagate may skip marks on an equal newest value; the walk runs
unconditionally (C5/C8).

### 4.2 World value of an atom

`foldAtom(atom, world)`: base + visible entries in seq order (visibility math
§3). ReducerAtom rides the same tape with actions as ops (R3 parity by
identical machinery; useReducer differential in CI).

### 4.3 Retirement (repair R3 applied)

On `onBatchRetired(token, committed)` — fold for both committed values (D2):

1. Stamp the slot's entries `retiredSeq = ++globalSeq` — the SHARED line, so
   `retiredSeq ≤ pin` compares commensurably (R3).
2. Bump `worldMemoEpoch` (all world memos die; re-validation is lazy).
3. Per touched atom: recompute `base'` by folding the retired prefix;
   **compact** only entries with `retiredSeq ≤ min(live pass pins)` and no
   smaller-seq unretired entry behind them (pin retention — C7).
4. Run the retirement **notification path** (T1): the fold-walk (§9, fold
   semantics) for atoms whose base moved, the reconcile backstop (§10.3),
   and the per-root signal-effect flush check (§10.4) — scheduled as an
   engine microtask for roots React will not commit.
5. Release the slot at unswept=0 (I10); recycling zeroes its write clock
   (R4) and its watcher bit column.

### 4.4 Quiescence

Live batches = 0 ∧ live passes = 0 ∧ tapes compacted (lineage caches cannot
block this — T6): bump `episodeEpoch`; bump-reset K1 plane; clear flags; drop
worldKeys/memos; optional `globalSeq` reset (every retainer carries an epoch —
§12). Cost O(touched nodes), amortized; quiet apps quiesce every event.

## 5. Worlds and read routing (repair R1 — the heart of the fix)

### 5.1 Where worlds come from

As the author design (§4.1): NEWEST outside passes; pass worlds from fork F2
(mask ∪ lockedIn(root), pin, currentWorld per-callstack across yields);
committed-for-root for effect flushes and fixups; writer's world never
materialized. Delta (T5): a pass whose selection equals newest is
RENDER_NEWEST — K0-routed reads, write-rejecting. The write guard keys on the
pass binding, never on world identity.

### 5.2 Read routing (REPAIRED)

```
read(node):
  w = currentWorld
  if w is NEWEST or RENDER_NEWEST: return k0.pull(node)     // donor fast path
  if F(node) = 1:                                            // flagged → world path
    if node is atom: return foldAtomMemo(node, w)
    return worldMemoRead(node, w)                            // §8
  // unflagged:
  if node is atom: return k0.value(node)                     // no live tape (invariant F)
  if k0.status(node) is CLEAN_TRACKED: return k0.value(node) // invariant R: serve w/o recompute
  return worldMemoRead(node, w)                              // stale/pending/never-evaluated/unwatched
```

Inside a world evaluation the same routing applies per read; K0-served reads
record a K1 edge and a dep-version entry; world-path reads recurse.

### 5.3 Invariant R (routed-serve soundness) — the construction

**Claim.** If `F(n)=0` and `n` is CLEAN_TRACKED (or an atom with an empty
tape) at a non-NEWEST read, then `value_w(n) = value_K0(n)` for every
constructible world `w`.

**Proof.**
- CLEAN_TRACKED means the read serves the **cached** value of `n`'s last
  evaluation with zero recompute — no new reads can occur, so the only
  question is whether that evaluation's result is world-invariant.
- Basis-edge completeness (E-PRESERVE, §7.3): while forked, every direct
  dependency edge of the evaluation that produced any servable cached value
  is present in K0∪K1 at all times until quiescence. Non-NEWEST worlds exist
  only while forked, so the precondition holds whenever R is consulted.
- Invariant F (§6): if any atom with a live-episode receipt had a K0∪K1 path
  to `n`, then `F(n)=1`. Contrapositive with `F(n)=0`: no receipted atom
  reaches `n` — in particular none is in the basis's transitive read set
  (those are inbound paths, present by the previous point).
- By computed purity (R2/C14; render writes throw), re-running the basis in
  world `w` reads atoms whose w-values equal their evaluation-time values
  (no divergence receipt among them) — so it returns the cached value. Every
  world agrees with K0's cache. ∎

**Why the pull was the bug (TK-F1):** a stale/pending/never-evaluated node's
`k0.pull` is a *fresh evaluation against newest values* that can acquire a
receipted atom through an edge that exists in no plane yet; F cannot see a
path that the pull itself creates. The repaired rule routes exactly those
reads to world evaluation — which folds correctly and records the real K1
edges, so subsequent writes reach the node (C1-T8 walk). Unwatched computeds
fail CLEAN_TRACKED conservatively (their K0 flags are not push-maintained),
which also pins the donor's unwatch semantics out of the trust base; a donor
unwatch-behavior test is added regardless.

Cost: the status load fires only on unflagged **computed** reads inside
non-newest worlds (transition-active renders); quiet-mode reads never reach
it (G-Q unchanged). World-evaluated non-fresh nodes memoize, so the route is
paid once per (node, worldKey) per invalidation.

### 5.4 The worldSensitive flag invariant F (unchanged, restated)

`F`: if atom `x` has a tape entry this episode and a K0∪K1 path `x → … → n`
exists, then `F(n)=1`. Maintenance: walks flag every visited node (§9); world
evaluations OR dep flags into their node; `afterRetrack` ORs new-dep flags on
K0 re-track/first-track. Monotone per episode; bulk-cleared at quiescence.
(Reviewer-verified; R1 removes the false *consequence* previously drawn from
F — F itself is unchanged.)

## 6. K0: the canonical kernel (unchanged) and its two hooks

K0 is the donor arena kernel, unmodified in layout and algorithm; DIRECT mode
is K0 alone at donor numbers (deep 0.90×, broad 0.84–0.88×, diamond 0.89×,
reads 0.74–0.87×, create 0.96× vs alien [ARENA][SYNTH §18.2]). Mode
activation = one closure rebuild (P3's literal zero: DIRECT closures contain
no concurrency code). LOGGED K0 gains exactly two null-checked per-recompute
callsites — `beforeRetrack(n)` (E-PRESERVE mirror while forked) and
`afterRetrack(n)` (flag OR-in) — never per-link, never per-read. Values stay
in-plane: **I11 (measured) says the closed-protocol boundary is free and the
storage move is what costs 5–12%; this design keeps kernel-adjacent value/fn
columns packed and plane-aligned, so it is on the measured-safe side.** SPK-H
gates the residual hook-branch tax (predicted ≪1%; recomputes are an order
rarer than link traversals).

## 7. K1: the shadow plane

### 7.1 Layout and population

Per shadow node `{firstOutLink}`; link records `{target, nextOut}`;
bump-allocated; add-only while forked. A cold parallel Int32 column on K0 ids
holds `k1IdAndFlag` (bit 0 = F, upper bits = K1 id + episodeEpoch tag) — cold
columns are outside the interleaving hazard [RESEARCH]. Population: (1) world
evaluations append every dependency actually read (dedup by link-exists probe);
(2) E-PRESERVE mirrors. Edges persist to quiescence — reach never expires with
a batch (the OP-F1 counter-lesson). Precision loss from add-only union edges
is over-notification only, bounded by delivery dedup.

### 7.2 Per-slot write clocks (repair R4)

`slotWriteSeq[slot]` bumps on every write in that slot; **zeroed at intern
and at recycle** (a freshly interned slot has no writes; retained old-epoch
values would fail-closed forever — TK-F4). C13 row added (§12).

### 7.3 E-PRESERVE (unchanged; reviewer-verified)

While any batch is live, before K0 replaces node `n`'s dep set, every current
K0 edge d→n is mirrored into K1 (skip if present). One site: `beforeRetrack`.
Maintains basis-edge completeness (base/step induction as authored). Dev
validator priced by SP2; sampling fallback stated.

### 7.4 K1 id lifecycle (hygiene: ONE story)

Ids are minted lazily; the `k1IdAndFlag` column entry carries the
episodeEpoch tag; a stale tag re-mints. The plane bump-resets at quiescence;
the column is NOT bulk-cleared (the tag check makes stale entries inert; a
tag-wrap collision yields at worst a shared record = over-notification).
Tag width and the forced-collision test are pinned in §12.

## 8. Per-world values: memos, clocks, recheck, thenables

### 8.1 World evaluation

`worldMemoRead(node, w)`: memo hit + valid → return (sentinel boxes rethrow
per R2). Else evaluate under an explicit world-eval frame: reads route per
§5.2 inside `w`; each K0-served or folded read appends its K1 edge and
`(depId, depVersion)`; store memo; `F(node) |= OR(dep flags)`; pop. Cycles
throw (R7). **Every world-eval frame rejects writes** (T3/FN-F7) — render,
fixup, reconcile, and effect-world evaluations alike (R8's rule applied
uniformly).

### 8.2 Validity (sound core)

`memo.epoch == worldMemoEpoch ∧ ∀ slot s ∈ w.mask: slotWriteSeq[s] ≤
memo.seq`. Soundness: a world's fold changes only via an included-slot write
(clock) or a retirement (epoch); mask/pin are in the key. S5-immune: validity
never consults a read set. Coarseness is the accepted trade (O9); the
direct-dep version recheck ladder (alien checkDirty transplanted; atom
version = seq of newest visible entry, 0 for tape-free) restores
recompute-avoidance and gives per-world equality cutoff. Correctness never
depends on the ladder.

### 8.3 currentWorld across yields

Fork F2 flips pass state at the reconciler's own work-loop boundaries:
enter/resume set `(passId, world)`; yield/exit clear to NEWEST. Per-callstack
truth (I6/S7): yield-gap handlers see NEWEST, their writes classify under
their own batch, the resumed pass restores its pinned world.

### 8.4 Suspense thenables (T6 applied)

`ctx.use(thenable)` in a world evaluation keys the positional cache by
`(node, lineageId, position)` — lineage is fork-defined stable across
restarts/replays of one (root, batch-set) and distinct across set changes
(C15; immune to CO-F5's lock-in drift and FN-F8's live-set churn **because
the key never mentions masks or live sets**). Lifetime: dropped at batch-set
commit or **abandon regardless of settlement** — a hung fetch cannot block
quiescence (OP-F6); late settlement checks the cache generation and no-ops.
NEWEST evaluations use K0's policy-column sentinel caching and never consult
lineage caches. Multi-root: lineage is per root, so a spanning suspension may
fetch per root — duplicate async work, not wrongness (documented; R2/C15
require stable identity within each root's retry loop, which holds).

### 8.5 Untracked reads (CO-F4 contrast, made explicit)

`untracked()` reads inside world evaluations resolve values through §5.2
(world-correct) but record no K1 edge and no dep-version entry. Validity is
unaffected — clocks are mask-based, not read-set-based — so this is sound,
and no bucket/cert machinery exists to over-notify: the untracked contract
("do not re-render me on this") holds by construction in both planes.

## 9. Notification: per-write walk, writer-context delivery

### 9.1 The walk (unchanged core; hardening noted)

```
notifyWalk(atom, slot):                       // synchronous, writer's stack (D5)
  stack=[atom]; ticket=++walkTicket
  while stack: n=pop
    if visited[n]==ticket: continue
    visited[n]=ticket; F(n)=1
    push K0 out-edges(n); push K1 out-edges(n)
    for watcher W on n:
      if !(W.notifiedMask & bit(slot)):
        W.notifiedMask |= bit(slot); W.setState()   // React assigns writer's lane
    if core-effect subscribers: enqueue once (NEWEST contract §10.5)
```

Full reach per write; no cross-walk marks (rejected optimization §15-R1 with
its fallback spec). Dedup is per-(watcher, slot) — I5's granularity — re-armed
when the watcher's hook renders in a pass whose mask contains the slot;
early-clear on discarded passes is over-delivery only. Hardening (FN-F5
class): the slot-bit column also clears for a root's watchers at that root's
commit of the slot, so a post-partial-commit same-token write re-delivers;
the async-action segment-commit fact is pinned by fork test 2.

### 9.2 Reach induction (walk-or-already-scheduled; reviewer-verified)

As authored: for every watcher W, batch k, time t — if W's k-world value
diverges from its last k-rendered value, either W.notifiedMask has k's bit
(scheduled; memo validity cannot serve the stale value — the diverging write
bumped the clock) or the next k-write's walk sets it. Base: no k-writes ⇒ no
divergence. Step: bit set ⇒ persists until a k-including render re-reads
through invalidated memos. Bit clear ⇒ W's basis edges are all present
(E-PRESERVE); a write outside the basis's read set introduces no divergence
(purity); a write inside walks recorded edges to W. ∎ Corollaries: C1's `a`
reaches W through the K1 edge; C4's second batch has its own bit; C5's
second write re-delivers after re-arm. **R1 extends coverage to the
previously-unroutable case:** a node with no recorded basis (never evaluated
/ stale) is never *served* to a non-newest world — it world-evaluates, which
records the edges the induction needs.

### 9.3 What notification deliberately does not do

No value evaluation at write time (the measured-expensive shape [SYNTH
§10.6/G-7]); one spurious re-render per (watcher, batch) is the priced trade
(G-N; SPK-N1 grid — the FN-F9 number — decides the optional
`notifyCutoff:'evaluate'` knob's default).

## 10. React bindings

### 10.1 Watchers and hooks

One shape: hook-instance watcher record + `useState(version)` + reads routed
through §5.2 under `currentWorld` (a mount mid-transition reads k's world on
first render with no special case — C9a). `useComputed` mints its node once
per hook instance; deps changes bump `fnVersion`. **Fresh nodes need no
special case under R1**: a node with no K0 record fails CLEAN_TRACKED, so its
first evaluation is world-routed by the ordinary rule, recording real K1
edges; registration (watcher attach, node retention) happens in the commit
effect; discarded passes leave only unregistered nodes and add-only K1 edges
(C14). `lastRendered`/`lastRenderSeq` are written **at the commit edge only**
(T2/FN-F6): a discarded render can never poison a comparator.

### 10.2 Subscribe-gap fixup (REPAIRED — R2, reach-based)

In the layout effect of a mounting/subscribing watcher on node n:

```
if F(n)=0 ∧ (n is atom with empty tape ∨ CLEAN_TRACKED(n)): done   // invariant R
needUrgent = false
for each live deferred token t with slotWriteSeq[slot(t)] ≠ 0:
  if !fork.runInBatch(t, () => setState(W)): needUrgent = true      // retired race
if needUrgent: setState(W) once                                     // urgent pre-paint
```

No equality filter (OP-F2's subset-explosion argument: per-token equality
cannot witness joint divergence, and subset enumeration is exponential). Each
corrective puts a pending update in t's lanes, so **every** pass including
any subset of live tokens re-renders W fresh through §5.2 and reads that
pass's exact world — sound for all masks. Over-render bound: ≤ live deferred
tokens (≤31, typically 1–2) extra renders of the newly mounted component,
only when mounting into a possibly-sensitive region; equal values commit no
DOM change. Gate G-F. C10's one-commit requirement holds per token via
`runInBatch`; the urgent fallback is pre-paint by layout timing.

### 10.3 Reconcile-at-fold backstop

At retirement, watchers on fold-changed cones compare commit-recorded
`lastRendered` vs the committed value; mismatch → urgent corrective. Fires
only in races routed elsewhere; a fired backstop in tests is a bug
(telemetry hook).

### 10.4 Effects (T1 — the retire/lock-in notification path, explicit)

`useSignalEffect` reads in world(committed-for-root); dep `(id, version)`
lists; re-run decided by version compare in that world (equality cutoff at
the committed world). Flush triggers — all three, none optional:
1. **After each React commit on root r** (rides React's passive flush): the
   lockedIn(r) mask just grew; dep versions re-compared in the new world.
2. **At retirement** (§4.3 step 4): for every root, schedule a flush check;
   if React has no commit queued for r, run it on an engine microtask —
   store-only transitions (C12) and urgent-applied batches (C16) reach
   effects through this edge (CO-F3/FN-F4 closed).
3. On unmount, records drop.
Core `effect()` keeps the donor contract — observes NEWEST, flush-coalesced,
sync-flushable under `configure({flush:'sync'})` (R13) — the documented C16
divergence for the non-React API.

### 10.5 StrictMode (C14 summary)

Render-phase writes throw at the guard (first line, before any mutation —
T4). Replays re-run world evaluations idempotently (same worldKey+lineage ⇒
same memos/thenables). Double mount/unmount: microtask-debounced observed
lifecycle. Discarded passes leave add-only K1 edges and unregistered fresh
nodes — over-notify or GC fodder, never semantics; commit-recorded watcher
fields stay clean (T2).

### 10.6 SSR / hydration (R10, previously missing)

Server runs DIRECT (no worlds exist server-side); state serializes as atom
bases (+ ids/labels). Hydration constructs K0 from bases **before** bridge
registration, then registers (LOGGED begins with empty tapes; first receipts
preserve hydrated bases). Version/schema validated; RSC/Flight out of scope
v1.

## 11. fork-protocol (the seam — 7 facts, versioned; unchanged shape)

`__COSIGNAL_PROTOCOL__ = 1`; feature-detect, throw on stock React. Integers,
booleans, documented callbacks only.

- **F1 `getCurrentBatchToken()`** — lazy mint; `(serial<<1)|deferredBit`;
  never reused live; ≤31 live is structural: React entangling transitions
  under lane pressure shares a lane ⇒ one batch ⇒ one token (CO-N6 answered;
  fork test 11). Edge: `requestUpdateLane` seam.
- **F2 pass lifecycle** — `onPassStart(root, tokens[], lineageId)`,
  `onPassYield/Resume(passId)`, `onPassEnd(passId, discarded)`,
  `getCurrentPassId()`. Invariants: flips at work-loop boundaries
  (per-callstack truth — I6/C7); `tokens` = exactly the batches whose updates
  the pass applies (**mask parity** — this is what makes fold answers equal
  React's queue answers under any scheduling, closing CO-N5's class without
  scheduler folklore); restart = new passId, same lineage.
- **F3 retirement + lock-in** — `onBatchCommittedOnRoot(token, rootId)`;
  `onBatchRetired(token, committed)` exactly once, async actions park until
  settle (C12).
- **F4 `runInBatch(token, fn): boolean`** — updates join the token's lanes;
  false if retired.
- **F5 lineage** — stable per (root, batch-set) across restarts/replays;
  new id on set change; dead at commit/abandon. The suspense key (C15).
- **F6 mutation window**; **F7 version handshake**.

Rebase drill: lane renames → token registry is fork-internal, bindings
unchanged; commit-phase moves → F3 edges re-anchor, invariant tests pin;
update-queue rewrites → nothing (we never touch hook queues; rebase parity
lives in our tape); scheduler/yield changes → F2 flip sites move with the
work loop, the yield-gap test re-asserts. Library moves zero lines.

Fork test list (rebase-run): the author design's 10 (token mint/uniqueness;
retire exactly-once + async parking; lock-in ordering; **pass mask parity**
(differential vs a probe hook); yield truth; restart lineage; runInBatch
entanglement + dead-token false; StrictMode replay events; flushSync
exclusion; inertness — one null-check per site) **plus** 11: 31-token
entanglement pressure (parked async actions + new transitions ⇒ shared
tokens, no 32nd slot); 12: a dev harness asserting at each commit that no
mounted watcher's world-value disagrees with its rendered value (the
fork-native gate, demoted to test apparatus — it earns its keep as an oracle,
not as a correctness mechanism). ~10 reconciler touch sites.

## 12. Lifecycle: counters and guards (C13 inventory; R3/R4 applied)

| counter | retained by | reset | guard |
|---|---|---|---|
| `globalSeq` (53-bit; mints write seqs, pins, **retirement stamps** — R3) | tape entries, memo.seq, pins, retiredSeq stamps | optional at quiescence | epoch bumps precede reset; tapes empty at quiescence by definition; forced small-reset + near-2^53 tests |
| `slotWriteSeq[32]` | memo validity | **zeroed at intern and recycle** (R4) | recycle gated on unswept=0 (I10) after the retirement epoch bump killed citing memos; forced test: re-intern without writes |
| slot ids (5-bit) | notifiedMask bits, tape slots | recycle | unswept=0 gate; bit column cleared at recycle and per-root on commit (§9.1) |
| `worldKey` interns | memos | retirement/quiescence | epoch in key |
| `walkTicket` (int32) | visited stamps | wrap | zero stamp column on wrap (forced test) |
| K1 ids | `k1IdAndFlag` column | quiescence plane reset | episodeEpoch tag; stale tag re-mints; tag-wrap collision = over-notify only (§7.4) |
| `lineageId` | thenable/memo caches | batch-set commit/**abandon** (T6) | fork-minted serial; late settle generation-checked no-op |
| `fnVersion` (per hook) | memos | hook unmount | memos die with node |

(The separate `retireSeq` row is deleted — R3.) Quiescence detection:
incrementally maintained three-way count; reset runs at the microtask after
the last retirement, never inside a walk or eval.

## 13. Performance: gates and spikes

### 13.1 Gate table

| gate | class | budget | how |
|---|---|---|---|
| G-D | P2 DIRECT tier-0 | ≤ alien v3 every shape | donor kernel verbatim [ARENA]; 179/179, exact pulls |
| G-Q | P3 quiet tier-0 | ≤2% | one `currentWorld==NEWEST` branch on public getters; SPK-Q measures |
| G-W | logged write | ≤2× DIRECT write | token ask (cached per batch) + push + clock + walk [SYNTH G-6] |
| G-N | notify walk | ≤2× DIRECT propagate; ≤1 spurious render per (watcher,batch) | full-reach walk = donor propagate class; dedup bounds setStates; SPK-N1 grid (FN-F9) |
| G-H | K0 hook tax | ≤1% recompute-dense | two per-recompute null-checks; SPK-H |
| G-F (new) | mount fixup | ≤ live-deferred-count extra renders per flagged mount; 0 for R-clean mounts | §10.2; measured in the react-concurrent-store harness |
| G-M | P4 steady re-render | 0 engine allocations | pooled tapes/memos/frames; plane bytes + heapUsed reported |
| G-P1 | P1 vs useState | ≤10%; 10k mount ≤15% | setState + one routed read; record append |
| G-E | world-eval cost | ∝ flagged∪non-fresh region, never whole closure | §5.2 routing; SPK-G8 |

### 13.2 Cost concentration (honest)

Logged write = O(cone) walk per write (no cross-walk marks; §15-R1 fallback
specced if SPK-N1 fails). First k-read after a k-write re-validates the
flagged region (ladder turns most into version compares). Retirement = O(slot
atoms + watchers on changed cones) + coarse epoch bump. R1 adds world
evaluations for stale-unflagged nodes touched by non-newest passes — each
paid once per (node, worldKey) then memoized; bounded by the region a pass
actually reads.

### 13.3 Held-open transitions (O9/G-8)

Coarse clocks invalidate k-mask memos per k-write, but only the flagged
region re-validates and the ladder stops recomputes at unchanged versions;
NEWEST traffic untouched. Escape hatch if SPK-G8 fails: per-(atom, worldKey)
fold cache (atom folds already carry versions).

### 13.4 The SP1/I11 stance (settled by measurement)

I11 (SP1+SP1b, measured): the closed-protocol call boundary is 0.99–1.02×;
the storage move to entity objects costs 5–12%. This design keeps values/fn
columns in-plane and uses two per-recompute hooks, not a per-read host
protocol — the measured-safe configuration. No correctness property depends
on SP1c; it stays queued as a refactor-enabling question only.

### 13.5 Spike register (unmeasured ⇒ never asserted)

| spike | question | method | decision rule |
|---|---|---|---|
| SPK-H | §6 hook tax | donor vs hooked build; tier-0 + kairo; one-framework-per-process; bundled child | >1% → hooks compiled out of DIRECT via the closure rebuild (already the plan), re-measure LOGGED only |
| SPK-W | G-W | set-heavy isolated writes | >2× → inline-2 receipts in atom record / tape pooling |
| SPK-N1 | G-N + FN-F9 grid | fan-out cone 1k; writes/frame 100; suppressed-write ratio × watcher count {10,100,10k} | fail → §15-R1 per-slot mark fallback, or default-on evaluate-cutoff above a fan-out threshold |
| SPK-G8 | §13.3 | held-open transition, kairo-scale, mixed read/write | fail → per-(atom, worldKey) fold cache |
| SPK-Q | G-Q | donor + NEWEST branch (+R-predicate on world path), tier-0 | >2% → move branch behind the LOGGED closure rebuild so DIRECT compiles it out (already planned) |
| SP2 | E-PRESERVE dev validator (O3) | brute-force K1-edge cross-check on synthetic forked topologies | >10% dev overhead → sampled validation |

## 14. Correctness walks — full battery, re-walked against the REPAIRED design

Notation: `tape(x)+={op,slot,seq}`; `wc[k]` slot clock; `M(c,w)` world memo;
`F(n)` flag; `NM(W)` notifiedMask; `K1: a→c` shadow edge; `CT(n)` =
CLEAN_TRACKED status. Every walk below was re-run after the repairs; steps
changed by a repair are marked ‡.

### C1 — world-divergent dependency (family, now 8)

`k: flag.set(true) → k-read of c → k: a.set(1); c=flag?a:b; K0 deps {flag,b}.`

```
step | actor/mechanism | state
1 | k: flag.set(true) §4.1 | guard: no pass binding ✓; tape(flag)+={true,k,s1}; wc[k]=s1; base kept; K0 newest flag=true, native mark c
2 | notifyWalk(flag,k) | visits flag,c: F=1 both; W: NM bit k clear → setState in k's context; NM(W)|=k
3 | k pass P1 starts (F2) | w1=({k},pin=s1); currentWorld=w1
4 | W renders; re-arm | NM(W) clears k; reads c: F(c)=1 → world eval: flag folds true (K1: flag→c); a: F=0, atom, tape empty → k0.value=0 (K1: a→c); M(c,w1)=0
5 | k: a.set(1) | tape(a)+={1,k,s2}; wc[k]=s2; K0 newest a=1 (no K0 a-edges)
6 | notifyWalk(a,k) | reaches c via K1 a→c (step 4's REAL edge); W: bit clear (re-armed) → setState in k's lane; NM|=k
7 | k re-render P2 | w2=({k},s2): M(c,w1) other key; wc[k]=s2 kills any w1-key reuse; eval: flag=true, a folds 1 → c=1 ✓
8 | committed/sync read of c ‡ | w3=(∅,pin): F(c)=1 → world eval: flag folds base=false → b: F=0, atom, no tape → 0 → c=0 ✓ via b
9 | k commits (F3) | retire: stamps retiredSeq=++globalSeq; fold bases; epoch++; reconcile: lastRendered(commit-recorded)=1 == committed 1 → no-op; quiescence resets
outcome: k-world 1 pre-commit in k's lane; committed 0 via b. Matches.
residual: re-arm timing (notify-rearm property test); K1 dedup bug = over-notify only.
```

If step 4 never happened (no k-read before step 5): NM(W) still holds k from
step 2 (never re-armed) → W scheduled; its eventual k-render pulls fresh
(reach induction case (a)).

- **T2** (k writes committed-only dep b): walk b→c (K0) delivers in k's lane;
  k-eval re-runs (clock): flag=true→a → 1 unchanged; over-invalidation only ✓.
- **T3** (k: flag back to false): walk delivers; fold flag {true@s1,false@s3}
  = false → c reads b → 0; K1 gains b→c (add-only union) ✓.
- **T4** (urgent U writes b): walk b→c delivers in U's context; U render
  (mask {U}∪lockedIn, k excluded): c eval flag=false, b=9 → 9 ✓ committed
  changed; k's next pass unchanged value (ladder stops dependents) ✓.
- **T5** (urgent U writes a=5): walk follows K1 a→c → deliver in U's context
  (spurious for U, priced). k's next render: fold a = {k:1@s2, U:5@s9} in
  seq order → 5 → c=5 ✓ — parity note: if U is still live-unretired AND the
  k-pass mask excludes U, the fold excludes it, which is exactly what
  React's queue filter does for those renderLanes; F2's mask-parity fact
  makes our answer equal React's under either scheduling (CO-N5 closed
  without scheduler assumptions).
- **T6** (slot/world reuse): slot released at unswept=0 after epoch bump;
  NM bit column cleared at recycle; K1 tags fail cross-episode (§7.4);
  wc zeroed at re-intern ‡ (R4). Forced collision test ✓.
- **T7** (joint render, one suspends, one commits): pass P{j,k} lineage Ljk:
  c suspends → thenable (c,Ljk,0); abandon set → lineage Ljk dead, cache
  dropped ‡ (T6-transplant; a hung j-fetch cannot block quiescence);
  Pk lineage Lk: separate worldKey+lineage → k-eval no suspension; k
  commits; j retries under Lj' with retired k visible via pin ✓.
- **T8 ‡ (the TK-F1 schedule — new)**:
```
setup ep.1 | cnd=false,x=0,m=0; u=x*2 never evaluated; v=cnd?u:m deps{cnd,m}; w=v+1 deps{v}
1 | ep.1 urgent: cnd.set(true); retire; quiesce | flags cleared; K0 stale marks on v,w PERSIST; tapes empty
2 | ep.2 k: x.set(5) | tape(x)+={5,k,s1}; x has no out-edges → walk flags only x; F(v)=F(w)=0
3 | urgent pass (mask {U}, k∉mask) reads w ‡ | §5.2: F(w)=0, w is computed, status=STALE → NOT CT → worldMemoRead(w, wU)
4 | world eval w in wU ‡ | v: F=0, STALE → world eval: cnd: F=0 atom no-tape → true; branch u: F=0, never-evaluated → NOT CT → world eval u: x: F(x)=1 → fold base 0 → u=0; v=0; w=1 ✓; K1 edges x→u→v→w recorded
5 | sibling reads x | F(x)=1 → fold → 0 ✓ frame consistent (w=1 ⇔ x=0)
6 | later k: x.set(7) | walk follows K1 x→u→v→w → watchers delivered in k's lane ✓ (edges exist now)
outcome: no torn frame; the stale-unflagged serve is structurally unreachable (invariant R).
residual: CT predicate must include the unwatched regime conservatively — donor unwatch-semantics pin test; invariant-R property test (random stale graphs × random worlds).
```

### C2 — flushSync excludes a pending default batch

```
1 | event: a.set(1) → token D | tape(a)+={1,D,s1}; wc[D]=s1; base=0; K0 newest 1, mark c
2 | notifyWalk(a,D) | F(a)=F(c)=1; watchers setState in D's context
3 | flushSync → sync pass S | F2 tokens exclude D → w=({}∪lockedIn, pin=s1); not RENDER_NEWEST (D live, excluded)
4 | read a | F=1 → fold: D invisible (slot∉mask, retiredSeq=0) → 0 ✓
5 | read c | F=1 → world eval: a→0 → 10 ✓
6 | D renders/commits later | mask {D}: 1/11; retirement folds base
outcome: (0,10) both — receipt (I1) + write-time cone flagging close both traps.
residual: fast-path regression — C2 conformance + invariant-F property test.
```

### C3 — rebase parity (‡ shared counter line)

```
1 | T: a.update(+1) | tape+={+1,T,s1}; newest 2; walk delivers in T
2 | U: a.update(×2) | tape+={×2,U,s2}; newest 4; walk delivers in U
3 | U render (mask{U},pin s2) | fold: base 1; s1 invisible; ×2 → 2 ✓
4 | U commits ‡ | retiredSeq(U-entries)=++globalSeq=s3; committed view (∅, pin≥s3): retired clause → 2 ✓; compaction blocked (s1 unretired behind)
5 | T render (mask{T}, pin≥s3) | fold: +1@s1 (T∈mask) → 2; ×2@s2 (retired s3 ≤ pin) → 4 ✓ write-order replay (I2)
6 | T commits | fold in seq order → base 4; quiescence
plain-set: {+1@T, set5@U} → U render 5; final fold (1+1) then set5 → 5 ✓
outcome: 2, 2, 4, 4 — React's arithmetic; useReducer differential beside it.
residual: fold-order bug — replay oracle (D6) + C3 differential.
```

### C4 — two-batch write into an already-stale region

```
1 | T1: a.set | walk full reach: W setState in T1; NM={T1}
2 | T2: a.set | walk runs FULL REACH again (no cross-walk marks); NM bit T2 clear → setState in T2's context; NM={T1,T2}
3 | React renders each | W included in both lanes ✓
outcome: per-(watcher,slot) dedup = I5's granularity; once-per-staleness marks don't exist.
residual: §15-R1 reintroduction — C4 unit + I5 property test.
```

### C5 — cutoff-suppressed first write, effective second write

```
1 | k: a.set(1) (c value-unchanged) | tape+; wc[k]=s1; K0 equality skips K0 marks; walk runs UNCONDITIONALLY → W setState in k; NM={k}
2 | k render; re-arm; read c | M(c,wk)={b-value, seq=s1}; NM={}
3 | k: b.set(7) | tape+; wc[k]=s2; walk b→c → bit clear → setState in k ✓
4 | k re-render | M invalid (wc[k]=s2>s1) → re-eval → 7 ✓
outcome: delivery never suppressed at write time; clocks are per-slot, not per-value; pre-render variant (NM still {k} at step 3) safe — scheduled render pulls through invalidated memo.
residual: future cutoff knob must keep the clock bump unconditional — C5 unit with knob on.
```

### C6 — lane attribution under grouped notification: HANDLE IT

No grouped drain exists; delivery is synchronous per write (§9.1).

```
1 | batch() opens | defers core-effect flush ONLY
2 | a.set(1) | token Ua (event urgent); walk delivers NOW in urgent context
3 | startTransition(() => b.set(2)) | token Tb inside the scope; walk delivers NOW in transition context → transition lanes; one Tb commit
4 | batch() closes | core effects flush (NEWEST)
outcome: per-write context by construction (D5); implicit grouping: none exists (stated).
residual: delivery-coalescing "optimization" — C6 two-lane assertion via fork probe.
```

### C7 — writes and reads during a yielded render pass (‡ shared line)

```
1 | pass P (mask{T}, pin p) starts | currentWorld=wT
2 | yield (F2) | currentWorld=NEWEST; getCurrentPassId()=0
3 | handler: a.state | NEWEST → k0.pull → newest ✓
4 | handler: a.set(x) | pass binding empty → no throw ✓; token C (click); tape+={x,C,sc}; walk delivers urgent
5 | click renders+commits ‡ | C retires: retiredSeq=++globalSeq=sr > p (SHARED line — R3); compaction blocked for P (sr > p)
6 | P resumes (F2) | currentWorld=wT (same mask, pin p)
7 | P reads a ‡ | fold: C entry retired at sr; visible iff sr ≤ p — FALSE → excluded ✓ pinned world intact; memo epoch bumped at 5 → lazy re-validation reproduces identical folds under p
outcome: newest reads in the gap, click-classified write, undrifted resumed pass. R3 makes step 7's comparison commensurable — the literal-spec bug is gone.
residual: fork flip-site drift — fork test 5; retention rule — C7 unit.
```

### C8 — equality drops must not lose receipts

```
1 | T: a.set(1) | tape+={1,T,s1}; newest 1
2 | U: a.set(1) | NO write-time drop in LOGGED (§4.1): tape+={1,U,s2}; wc[U]=s2; K0 1→1 (marks skipped); walk runs (worlds excluding T changed 0→1)
3 | U render (mask{U}) | fold: base 0 + s2 → 1 ✓
4 | overlapping T1,T2 set 1 | two receipts; each world folds its subset; committed folds both ✓
outcome: I7 enforced in the strongest form; DIRECT keeps donor equality-skip (history cannot exist there).
residual: tape-coalescing violating I7 — declined (O10); C8 unit.
```

### C9 — mount mid-transition (existing and fresh nodes)

```
(a) | mount render inside k-pass reads existing c | currentWorld=wk; F(c)=1 → world path ✓ first render correct; if F(c)=0 ∧ CT(c) ‡ → invariant R: k-value = newest ⇒ K0 serve sound; if F=0 ∧ ¬CT → world eval (no leak possible)
(b) | fresh node n (useComputed) ‡ | no K0 record → ¬CT → world-routed by the ORDINARY rule (R1 subsumes the special case): evaluates in wk, records K1 edges, M(n,wk) stored
(b2) | registration at commit effect | discarded/replayed pass leaves an unregistered node + add-only K1 edges (over-notify at worst; C14)
(b3) | post-mount k-write to n's dep | walk reaches n via its K1 edges → delivered in k's lane ✓
outcome: both resolve in the pass's world on first render; the fresh-node mechanism is now a corollary of routing, not a carve-out.
residual: K0 backfill on first NEWEST read must not clobber world memos — separate stores; C9 unit + StrictMode variant.
```

### C10 — late subscription joins the pending batch (‡ REPAIRED, incl. joint masks)

```
1 | k: a.set(1) | receipts; existing watchers notified in k
2 | urgent mount render of W′ | world = committed(root): renders 0-derived value; no watcher yet
3 | layout fixup ‡ (§10.2) | F(node)=1 (k's walk flagged the cone) → NO equality check: for each live deferred t with wc[t]≠0 (= {k}): runInBatch(k, setState(W′)) ✓ correction joins k's lanes
4 | React renders k | W′ has pending k-update → renders fresh → reads wk → 1; ONE commit carries k + correction ✓
5 | race: k retired between 2 and 3 | runInBatch false → single urgent pre-paint setState ✓
JOINT variant ‡ (the TK-F2 schedule): c=a&&b; t1 wrote a, t2 wrote b pre-mount; step 3 schedules into BOTH t1 and t2 (no equality filter) → W′ has pending updates in both lanes → the joint {t1,t2} pass renders W′ fresh → reads world({t1,t2}∪lockedIn) → true ✓ no bailout tear; each single-token pass also renders W′ (equal value → no DOM change; bounded by G-F)
outcome: exactly one commit per token with the correction included; joint divergence structurally covered (I13). Fresh startTransition rejected: new lanes ⇒ separate commit ⇒ torn window (stated).
residual: G-F over-render bound in the harness; fork F4 semantics — fork test 7.
```

### C11 — multiple roots (declared scope: FULL spanning)

```
1 | k writes atoms read on roots A,B | receipts slot k; walks deliver on both roots in k's lane
2 | A's k-render commits | F3 lock-in: lockedIn(A)|=k; k NOT retired; ‡ effect flush check for A runs with the new lockedIn (§10.4 trigger 1)
3 | urgent render on A | mask {U}∪lockedIn(A)∋k → folds include k ✓ A never contradicts its DOM
4 | A's passive effects | world(committed-for-A) ∋ k ✓ though token live
5 | urgent render on B | lockedIn(B)∌k → excludes k ✓
6 | B commits | last root → onBatchRetired(k,true) → single fold, exactly once
7 | store-only on B (no B work) | fork counts involved roots by scheduled work; retire fires once either way
outcome: per-root lock-in masks replace any global "committed"; cross-root skew is React's own commit ordering (permitted). Spanning suspense may duplicate fetches per root (lineage per root) — documented, not wrongness.
residual: lock-in ordering vs paint/effects — fork test 3; the fork registry facts must be re-proven on the current React base (gap G4 kept, flagged).
```

### C12 — store-only transitions persist

```
1 | startTransition(() => a.set(5)), no subscribers | LOGGED since registration (monotonic, S6): tape+; walk finds no watchers
2 | batch closes, no React work | onBatchRetired(k, committed=false) → FOLD anyway (D2): base=5 ✓; ‡ §10.4 trigger 2: effect flush check per root on an engine microtask — a useSignalEffect on a elsewhere re-runs seeing 5 (FN-F4 closed)
3 | async action: set(1); await; set(2) | one token across the await (fork parks); retirement PARKED until settle
4 | settle | fold in seq order → 2 ✓ not before
outcome: persistence independent of subscription (D2/S4); committed-world observers hear about retire-only changes.
residual: fork parking — fork test 2 (incl. per-segment-commit fact pin).
```

### C13 — counter/world-id lifecycle soundness

Walked as the §12 inventory: every counter, retainer, reset, guard, forced
test. R3 removed the incommensurable line; R4 added the missing clock guard.
Episode collision drive: quiesce → reset small → stale memos unreachable
(epoch in worldKey), stale K1 column entries fail the tag, NM bits cleared at
recycle, tapes empty by definition, wc zeroed at intern.
`outcome:` no cross-episode validation without passing a bumped guard (I8).
`residual:` new structures must add a row — the C13 checklist is a review
gate (D6); schema sweep asserts every seq-typed field pairs with an epoch.

### C14 — StrictMode and replayed renders

```
1 | render-phase write | guard throws FIRST, before token/append/clock (T4) — queue untouched (test asserts); yield-gap handler write does NOT throw (per-callstack)
2 | replayed pass | same worldKey+lineage → identical memos/thenables (purity) → no re-suspend loop
3 | discarded pass | leaves add-only K1 edges (over-notify), unregistered fresh nodes, early-cleared NM bits (over-delivery); lastRendered untouched (commit-recorded, T2) — no observable graph mutation ✓
4 | double mount/unmount | microtask-debounced observed lifecycle nets to one ✓
outcome: purity holds; render-side mutations are keyed-idempotent or monotone-and-harmless.
residual: memo store keyed without lineage for fresh nodes — C14 forced-discard test.
```

### C15 — suspense across worlds

```
1 | k suspends c | k-pass lineage Lk: ctx.use → cache[(c,Lk,0)]=th; M(c,wk)=suspension sentinel; React suspends via use protocol
2 | mount mid-transition reading c | same lineage → SAME thenable identity → consistent suspension ✓ (react-concurrent-store known bug = passing test)
3 | canonical reads meanwhile | NEWEST path; lineage caches never consulted ✓
4 | settle; retry | new pass, SAME lineage (F5) → cache hit → settled value ✓
5 | k commits | lineage dropped → cache freed; ‡ abandon also drops it regardless of settlement (T6)
outcome: world key = fork lineage — stable across restarts/replays of one batch-set, distinct across set changes, dead at commit/abandon. passSerial-refetch, single-token under-keying, mask-drift (CO-F5) and live-set churn (FN-F8) all excluded by construction.
residual: lineage lifetime drift — fork test 6; positional stability per world — R2 contract test.
```

### C16 — effects observe committed state only (‡ trigger inventory explicit)

```
1 | default D: a.set(1) applied, uncommitted | tape entry slot D; newest=1; base=0
2 | unrelated j retires → flush check (trigger 2) | effect world (committed-for-R): D unretired ∧ ∉ lockedIn(R) → fold excludes → 0 ✓
3 | D commits | trigger 1 (React passive flush after commit; lockedIn grew): dep version for a moved in the committed world → re-run sees 1 ✓
3′| D retires with no commit on R (variant) | trigger 2 fires on the engine microtask → re-run sees 1 ✓ (CO-F3's missing mechanism, present here)
4 | core effect() | documented NEWEST contract: saw 1 at step 1's flush — stated and conformance-tested divergence
outcome: committed world is a first-class world (same fold math), and every edge that changes it notifies.
residual: flush world must use the effect's OWN root's lockedIn — C11/C16 cross test.
```

### C17 — optimistic rollback

Not exposed: no truncation surface exists (batches fold on retirement, D2;
React batches never truncate). Optimistic UI composes from ReducerAtom
actions whose fold interprets reconciliation (R3). Surface deleted per the
case's clause; nothing depends on truncation.

## 15. Rejected variants and known gaps

Rejected (kept with reasons):
- **R1: cross-walk notification marks** — with add-only K1 edges the
  mark-stop invariant breaks at every edge-add; the repaired fallback
  (propagate-on-edge-add + render-coherent per-slot clearing) is specced
  here and activates only if SPK-N1 fails.
- **R2: per-read certificates** — clocks+ladder dominate (S5-immune, no
  completeness obligation, untracked contract free); CO-F1/CO-F4 are the
  round's evidence that certificate stacks grow obligations (O9 settled).
- **R3: full host-protocol K0** — unnecessary (I11: storage is the tax, and
  values stay in-plane here); revisit only as refactoring if ever free.
- **R4: write-time watcher value cutoffs** — the measured-expensive shape;
  SPK-N1 decides the opt-in knob's default instead.
- **R5: React-owned atom queues (O4)** — killed with schedules by the
  fork-native round: fiber-grain flattening loses computed cutoffs (10k
  no-op renders), core/benchmark consumers have no fiber, hidden fibers
  destroy creation; and the viable retreat's global queues needed the very
  retirement pin (FN-F2) whose absence was its selling point. The tape +
  visibility math remains the ~60-line reimplementation, oracle-tested.
- **R6: equality-filtered mount fixup** — unsound for joint masks (OP-F2's
  exponential-subset argument); replaced by reach-based correctives.
- **R7: gate/commit-veto as primary correctness** — FN-F1/2/3 showed the
  trigger taxonomy is the hard part; adopted only as a dev/test oracle
  (fork test 12).

Known gaps (declared):
- **G1** repeated high-fan-out writes re-walk their cone per write (SPK-N1;
  R1-fallback specced).
- **G2** held-open-transition re-validation bursts (SPK-G8; escape hatch
  specced).
- **G3** union K1 edges over-notify across batches (≤1 spurious render per
  (watcher, batch); G-N asserts).
- **G4** fork registry facts (per-root lock-in, async parking, mask parity)
  proven in the previous-generation fork; THIS protocol's ordering must be
  re-proven by fork tests 2/3/4 on the current React base before C11/C12
  walks count as implemented.
- **G5** E-PRESERVE dev-validator cost unknown until SP2 (sampling fallback).
- **G6 ‡** mount-fixup over-render for R-unclean mounts under many live
  transitions (bounded ≤ live-deferred count; G-F measures in the harness).
- **G7 ‡** R1 routes stale-unflagged reads to world evaluation — a
  first-touch cost in transition renders after quiescence-with-stale-cones;
  memoized thereafter (G-E covers; SPK-G8 shape includes it).

## 16. Mechanism inventory (10)

1. **K0** — donor arena kernel (closed, monomorphic) + LOGGED closure
   rebuild with two null-checked per-recompute hooks (§6).
2. **Tape + base + one global seq line** — always-log receipts; visibility
   math; seq-order folds; retirement stamps on the same line (§4, R3).
3. **Slots/masks/pins + per-root lock-in** — batch bookkeeping over fork
   tokens (§3, §5.1, C11).
4. **Per-slot write clocks + epochs** — world-value validity, zeroed at
   intern/recycle (§8.2, R4).
5. **World memos + dep-version ladder + lineage thenable caches** (§8).
6. **K1 shadow plane + E-PRESERVE + worldSensitive column + invariant-R
   routed-serve rule** — real pending topology; freshness-guarded fast path
   (§5, §7, R1).
7. **Notification walk** — per-write full reach over K0∪K1, writer-context
   setState, per-(watcher, slot) dedup with render re-arm (§9).
8. **Watcher records (commit-recorded) + reach-based mount fixup +
   reconcile backstop + retire/lock-in effect flush** (§10, R2/T1/T2).
9. **Fork protocol** — 7 facts F1–F7 (§11).
10. **Episode lifecycle** — retirement folds/compaction with pin retention,
    quiescence reset, counter guards (§4.3–4.4, §12).

## 17. Test plan (beyond the inherited apparatus, D6)

Inherited wholesale: randomized replay oracle FIRST (fold math vs brute-force
multi-world interpreter + useReducer differential), frozen-kernel contract
suite, bytecode budgets CI, invisibility tests (179-suite inside a synthetic
episode), react-concurrent-store 14 scenarios + two-root scenario,
pre-registered spikes (§13.5). Added:

- Invariant-F property test (random graphs/writes/evals; reachable-from-taped
  ⇒ flagged).
- **Invariant-R property test ‡**: random graphs with forced K0 staleness
  (cross-episode + pre-bridge), random worlds; assert every non-NEWEST read
  either world-evaluates or serves a CT node whose value equals a
  brute-force world fold. Includes the C1-T8 schedule and the donor
  unwatch-semantics pin.
- Basis-edge completeness fuzz (E-PRESERVE; SP2's subject).
- Notify-rearm property (per-(watcher, batch) exactly-once-per-render-cycle).
- Walk-reach differential (reached set ⊇ brute-force could-change set).
- **Joint-mask mount battery ‡**: TK-F2/OP-F2 schedules (`a&&b`,
  `x1&x2&!x3`) with subsets rendered in every order; assert no committed
  frame disagrees (uses fork test 12's commit oracle).
- Episode collision battery (C13; T6; forced small counters).
- StrictMode render-write test asserting tape/clock untouched after throw
  (T4).
- Fork suite: tests 1–12 of §11, every rebase.

*End of repaired design. 10 mechanisms; 7 protocol facts (~10 reconciler
sites); all C1–C17 walked (C1 now a family of 8); 6 spikes registered;
adjudication: 24 confirmed / 0 refuted / 1 needs-measurement.*


