# JUDGING.md — Panel Verdict on the Four Cosignal Architecture Specs

Chief-judge synthesis of the 4-lens panel (react-correctness, performance,
implementability, risk) over:

- **A** — `cosignal-arena-a-log-overlay.md`
- **B** — `cosignal-arena-b-versioned-core.md`
- **C** — `cosignal-arena-c-forked-worlds.md`
- **D** — `cosignal-arena-d-minimal-kernel.md`

---

## 1. Score matrix

| Lens              |    A |    B |    C |    D | Lens winner |
|-------------------|-----:|-----:|-----:|-----:|-------------|
| react-correctness |  9.0 |  5.0 |  6.5 |  7.0 | A           |
| performance       |  8.0 |  7.0 |  8.5 |  6.5 | C           |
| implementability  |  7.5 |  5.5 |  7.0 |  8.0 | D           |
| risk              |  7.0 |  5.0 |  4.0 |  6.0 | A           |
| **Total (/40)**   | **31.5** | **22.5** | **26.0** | **27.5** | **A** |
| Mean (/10)        | 7.88 | 5.63 | 6.50 | 6.88 |             |

Rank aggregation agrees with the totals: A is first or second on every lens
(two firsts, two seconds); D never wins correctness or performance; C's
performance win is offset by the worst risk score on the panel; B is last or
second-to-last on every lens.

**Ordering: A > D > C > B.**

---

## 2. Fatal-or-not, per spec

The decisive question per spec: is the worst panel flaw a **wrongness**
(violates React semantics or loses data), and if so, is the fix **local**
(a rule change inside the architecture) or **architectural** (invalidates
the design's central mechanism)?

### A — Log Overlay: NOT FATAL (spec gaps + a slowness, no wrongness)

- Worst flaw (correctness lens): the deferred-write watcher-notification
  path is underspecified — the overlay-mark walk "stops at already-stamped
  nodes" (§9.3/§8.7.2) while §10.6 requires per-write per-world watcher
  evaluation, so a second deferred write from a different batch into a
  stamped region has no specified path to watchers; and the post-subscribe
  fixup's "corrective setVersion joins the pending batch" is asserted, not
  demonstrated. **Verdict: a specification gap in an otherwise-correct
  visibility model, fixable locally** (per-batch re-mark / era bump on
  append into a stamped cone; replace the fixup assertion with an explicit
  batch-entanglement mechanism plus a test).
- Worst flaw (risk lens): long-transition over-evaluation storm — while any
  deferred batch is live, NEWEST-context reads of marked computeds fall to
  untracked `overlayEvaluate`, memoized only per `logEpoch`, which bumps on
  every append. **A slowness, not a wrongness**; the mitigation (per-node
  world-value stamping) is already named in A's own risk register — it must
  be promoted from "deferred" to required, with a gate.
- Ungated hot-path cost: §10.6 watcher-broadcast does an overlay evaluation
  per watcher-world on the write path with no numeric gate in §18.3; kairo
  ≤1.25× has no named mechanism. Fixable by gates + milestones (grafts
  below).
- Uniquely, A's core visibility rule (§10.2) maps clause-for-clause onto
  React's hook-queue semantics, its rebase walkthrough (§10.7) reproduces
  React exactly, committed=false batches fold (no data loss), and it is the
  only spec that represents the flushSync-excludes-default-batch case at
  all — a case three other lenses independently confirmed B, C, and D
  cannot express.

### B — Versioned Core: FATAL AS WRITTEN

- The rebase fold is mathematically wrong: urgent functional updates are
  applied and discarded (`writeCommitted(node, value)`, no chain entry), so
  the case-3 fold yields 3 where React — and B's own worked example —
  yields 4. The supporting claim about React internals ("React too
  re-applies skipped updaters on the newer base") is factually false.
- The fix is architectural, not local: making the fold correct requires
  retaining urgent functional entries, i.e. logging urgent writes — which
  collapses B's no-log urgent path into A's always-log rule. The same
  no-log path also makes the flushSync exclusion case unrepresentable.
- Compounding: B invades every proven hot walk (per-link WORLDS AND,
  C_SEQ store + seq bump per committed write, view-parameterized
  checkDirty) on the exact cost class §7b measured as the residual deficit,
  and is the only spec with no bytecode-budget CI — its ≤1.03× steady gate
  is asserted, not enforced. Its "bit-identical plus one scalar branch"
  collapse claim is overstated.
- Salvage value is high even though the architecture dies: best build-order
  discipline (M0–M6), the strongest single test on the panel (naive-replay
  oracle over random schedules), the sharpest analysis of world-divergent
  dependency topology (§9.3), and full packed-structs-guide compliance.

### C — Forked Worlds: FATAL AS WRITTEN (two wrongness classes)

- Data loss: committed=false retirement **drops** entries (§10.5), so
  `startTransition(() => atom.set(x))` with no subscribed component
  silently reverts, and settled async-action store-only writes evaporate.
  Whether a user's write persists depends on whether anyone happened to be
  subscribed. A/B/D all fold ("the writes are real"). The fix is a local
  rule change (fold on retire) — this one alone would not be fatal.
- Unsoundness: HEAD-world missed invalidation. Worlds never track
  dependencies; HEAD invalidates through canonical subscriber topology
  only, so a computed with in-world-divergent deps (reads atom `a` only
  when a pending-world flag is true) caches an SV_READY shadow that a later
  same-batch write to `a` never dirties. Sibling spec B §9.3 names this
  exact tear as the reason per-view link bits must exist; C's §10.4
  induction covers only first divergence in fresh worlds. Fixing it
  requires adding per-world dependency tracking — architectural, and it
  erodes the cheap-read premise the performance win rests on. Related, and
  from the same no-pins root cause: paused HEAD-aliased passes observe
  mid-pause urgent writes through in-place HEAD-shadow mutation, violating
  C's own pass-consistency guarantee.
- Distributed invariant: copy-out completeness is a global temporal
  obligation over every canonical-overwrite site, present and future,
  guarded by a manual audit and a dev-only assertion — C's own "subtlest
  correctness surface."
- Salvage value is the highest of the three losers on the performance and
  process axes: best hot-path pricing discipline, best authoring
  constraints (§8), best fuzz-first methodology (§16.2).

### D — Minimal Kernel: NOT FATAL, BUT STRUCTURALLY TAXED

- Worst flaw: K1 shadow-edge sync completeness. A missing K1 edge silently
  omits a component from the transition render, producing a mixed-world
  committed frame corrected only by a post-commit urgent re-render — a
  user-visible tear the spec optimistically labels a "backstop." The risk
  lens adds that the hook-fixup protocol covers render-to-subscribe races,
  not missed steady-state notifies on already-subscribed watchers. Not a
  committed-wrong-value bug, but a real glitch class inherent to
  maintaining two topologies; D itself names shadowing the architectural
  revisit point (risk 7).
- The existence-gated log (`forked || anyPassActive || deferred`) provably
  cannot cover the same-event flushSync/default-batch exclusion (the write
  predates any pass and is neither deferred nor forked) — the exact case
  A's §9.1 proves requires always-logging.
- Mixed-pass cost is misbudgeted as rare: one suspended transition plus one
  active one (the canonical R6 Suspense scenario) makes every
  active-transition pass mixed for the suspension's duration, with a
  whole-cone policy recompute per pass restart; the bloom/bitset escape
  hatch is designed-not-built. Per-pass thenable caching is also missing.
- And uniquely among the four, D **pre-budgets regressions on benchmarks
  the donor kernel already wins** (deep 0.90→≤0.95, broad 0.84–0.88→≤0.90,
  diamond 0.89→≤0.93) — it spends the repo's hardest-won results to buy
  pollution-proofing, plus the +26–30% fallback exposure on always-hot K0
  if the two-stamp specialization bet fails.
- Salvage value: the smallest trusted core, the best gated-claim and
  milestone discipline, protocol contract tests, the placement table, and
  the single tracing choke point.

---

## 3. Recommended base architecture

**Build on A (log-overlay).**

Reasons, in order of weight:

1. **Only A has no wrongness-class flaw.** A's worst findings are a spec
   gap (watcher-notify path for stamped regions) and a bounded slowness
   (long-transition evaluation storm) — both with local, already-sketched
   fixes. B's fold computes wrong values; C loses user writes and serves
   stale HEAD reads; D commits mixed-world frames when shadow sync slips.
2. **Correctness is the product.** A concurrent-React signals library lives
   or dies on useState/useTransition parity; A scores 9 on that lens, maps
   its visibility rule clause-by-clause onto React's hook queue, and is the
   only design that can even express the flushSync-excludes-default-batch
   case — which three independent lenses confirmed is unrepresentable in B
   and D and unhandled in C.
3. **A wins the aggregate** (31.5/40), wins two lenses outright, and is
   second on the other two. Its performance deficit vs. C (8.0 vs 8.5) is a
   gating-discipline gap, not an architectural one — DIRECT mode is the
   proven kernel with zero overlay instructions — and C's process
   discipline is importable (below) while C's soundness holes are not
   cheaply exportable.
4. **The failure modes degrade the right way.** A's residual risks are slow,
   not wrong, and self-reset at quiescence; the tape model is the most
   inspectable and debuggable state of the four.

Accepted costs of choosing A: the permanent always-log/markOverlay write
tax in React mode (§9.1 argues it is the honest price of the flushSync
case; the panel agrees), and a concurrency subsystem dense in invariants
(pins, RETIRED_SEQ, eras, coalescing legality) that A under-tests today —
directly addressed by grafts G1–G3.

---

## 4. Graft list — imports into A, by donor section

Ordered by priority. "Fix" items are obligations on A itself surfaced by
the panel; "Graft" items import a loser's machinery or process.

### Correctness fixes in A (required before any milestone exit)

- **F1 (A §9.3/§8.7.2 × §10.6).** Specify the deferred-write notify path
  for writes into already-stamped regions: per-batch (or era-bumping)
  re-mark on append so the §10.6 broadcast rule always has a mechanism that
  reaches watchers, including second writes from a different batch. Add the
  two-batch stamped-region scenario to §17.2. This is load-bearing for lane
  inheritance and currently unspecified.
- **F2 (A §10.6 fixup).** Replace the asserted "corrective setVersion
  inside startTransition joins that pending batch" with a demonstrated
  mechanism (explicit batch-entanglement token on the pending batch, used
  by the post-subscribe fixup), plus a test that the corrective write
  commits with — not after — the original batch.
- **F3 (A §19 risks 1–2).** Promote per-node world-value stamping from
  deferred mitigation to required design: memo overlay evaluations per
  (node, world, last-relevant-seq) instead of per logEpoch, so a held-open
  transition plus a hot read loop does not degenerate the marked cone to
  full re-evaluation per append. Gate it (see G4).

### G1 — from B §17.2: randomized replay oracle (implementability)

A is the only spec with no randomized oracle or model checking, while
carrying the most invariant-dense concurrency plane. Import B's
naive-replay oracle over random schedules, retargeted at A's tape: a naive
full-snapshot model replays the log per world and must agree with
overlayEvaluate/visibility-clause results on every read, across randomized
write/fork/retire/pass interleavings.

### G2 — from C §16.2 + C §8: fuzz-first discipline and bytecode-budget CI

- Build the G1 oracle **before** the sweep/coalescing/mark-repair code, per
  C's model-first sequencing, and adopt C's "re-run the entire conformance
  suite inside a synthetic episode" invisibility test (steady-mode
  equivalence under a live-but-irrelevant batch).
- Import C's per-function bytecode budgets, comment-declared and
  CI-enforced at +10% tolerance, applied to every kernel function A
  touches — above all `linkInsert` (A §8.7.3 mark repair lives inside the
  kernel's hottest helper and is the panel's named erosion of "proven
  kernel untouched"; pin it at its 168-bytecode out-of-line budget) and the
  flags-gated atom read path.
- Import C's pre-registered mode-gate-vs-closure-swap experiment for A's
  DIRECT/LOGGED branch (the measured +34–43% mutable-binding hazard).

### G3 — from B §M0–M6 and D §M1: milestone build order with per-gate exits

A ships no build order. Import B's per-milestone gate structure with D's
day-one measurement rule: **M1 measures A's two unpriced hot costs before
any concurrency code exists** — (a) the always-log + markOverlay urgent
write tax (gate: ≤2×, already in §18.3, now sequenced first), and (b) the
§10.6 per-watcher-world broadcast evaluation, which currently has **no**
gate. Each later milestone (overlay reads, forks, sweep) re-runs the
steady-state parity gate, fixing B's own "gate exists but nothing re-runs
it" gap rather than copying it.

### G4 — from C §18-style numeric gates: close A's §18.3 gate holes

Extend A's gate table with mode-specific numbers in C's style: watcher
broadcast per deferred write ≤N×base-write (N pre-registered at M1);
held-open-transition hot-read-loop benchmark for F3 (marked-cone read
≤1.5× DIRECT while a batch is live); mounted-quiet ≤2% tier-0; and either
a named kairo mechanism or an honest re-scope of the ≤1.25× target with a
measurement milestone (the panel found the target currently sits against a
measured 1.4× reality with no mechanism).

### G5 — from D §12.4 + D §10: contract tests and placement table

- Adapt D's protocol contract suite to A's five named kernel additions: a
  standalone suite asserting the kernel-with-additions is behaviorally
  identical to the frozen 179/179 artifact when the overlay plane is empty
  (quiescence residue zero, bit-level state parity) — making "proven kernel
  untouched" verifiable by construction rather than by claim.
- Import D's §10 placement table ("where every future feature lands"),
  mapping each concern to kernel / tape / world-manager / React adapter.
- Import D's single-choke-point tracing dividend: instrument A's tape
  append + overlay read as the two choke points satisfying R11.

### G6 — from B (guide compliance) + D (codegen): packed-structs tooling

A's codegen fit is partial (const-enum + CI grep only). Import B's branded
ids, `schema.ts` single-source data file, and `__DEV__` define-stripping
evidence; import D's kernel-stamping generator with regenerate-and-diff CI
so A's field tables (§9/§10 planes) are generated, not hand-maintained.

### G7 — from B §9.3: world-divergent dependency scenarios (as tests)

Do not import B's per-link WORLDS bits (that is B's kernel invasion — the
thing A exists to avoid). Import the **scenario family**: computeds whose
dependency set differs between worlds (branch on a pending-world flag),
including long-lived batches with cached divergent evaluations and
same-batch follow-up writes to the divergent dep. A's untracked
overlayEvaluate should be immune by construction (it re-walks deps per
evaluation); after F3's stamping lands, these tests guard exactly the tear
class that killed C — stamping must key on the re-observed dep set, not
the canonical one.

### Explicitly rejected grafts

- C §10.5 drop-on-abort retirement (data loss) and C's pin-free pass model
  (HEAD-shadow tear) — the two flaws that sank C.
- B's no-log urgent write path and 3-case fold (wrong values; A's §10.7
  rebase is already correct).
- D's dual-kernel shadow topology and host.refresh indirection (pays a
  quiescent tax on won benchmarks; A's single-kernel overlay makes it
  unnecessary).

---

## 5. Executive verdict

1. **Winner: A (log-overlay), 31.5/40** — first on react-correctness (9) and risk (7), second on performance (8) and implementability (7.5); ordering A > D (27.5) > C (26) > B (22.5).
2. A is the only spec with no wrongness-class flaw: its worst findings are an underspecified watcher-notify path and a long-transition slowness, both with local fixes already sketched in its own text.
3. B is fatal as written: its urgent-update fold provably computes 3 where React computes 4, resting on a false claim about React internals, and the repair (log urgent writes) collapses B into A.
4. C is fatal as written: committed=false retirement silently loses user writes, and pin-free HEAD worlds serve stale values on world-divergent dependencies — the exact tear B §9.3 documents; fixing it costs C its performance premise.
5. D survives but pays permanently: it pre-budgets regressions on benchmarks the kernel already wins, and its shadow-edge "backstop" is a user-visible committed-frame tear, not a guarantee.
6. Decisive discriminator: only A can represent the flushSync-excludes-default-batch case — three lenses independently confirmed B and D structurally cannot, and C never addresses it; the always-log write tax is the honest price.
7. Required fixes in A before build: specify the stamped-region re-notify mechanism (F1), demonstrate batch-joining for the post-subscribe fixup (F2), and make per-node world-value stamping mandatory (F3).
8. Priority grafts: B §17.2 randomized replay oracle + C §16.2 fuzz-first sequencing (G1–G2), C §8 bytecode-budget CI pinned on linkInsert (G2), B/D milestone gates with day-one pricing of the §10.6 broadcast cost (G3–G4).
9. Secondary grafts: D §12.4 frozen-kernel contract suite and §10 placement table (G5), B/D codegen compliance (G6), B §9.3 world-divergent-dep scenarios as tests only (G7); rejected: C's drop-on-abort, B's no-log urgent path, D's dual kernel.
10. Confidence: high on the A-over-B/C ordering (wrongness beats slowness), moderate on A-over-D (if F1/F3 prove harder than specced, D's quarantined-kernel plan is the fallback base — at a known, measured performance price.)

---

*Synthesized 2026-07-04 from the four-lens panel (react-correctness,
performance, implementability, risk) over the four arena specs in
`research/specs/`.*
