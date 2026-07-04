# INVARIANTS — facts with provenance

Admission rule: a measurement (linked), a walked schedule (linked), or
independent confirmation by both reviewers. Curated by the monitor only.

- **I1. Always-log in React mode.** A world excluded from a render (C2
  flushSync/default) is reconstructible only if *every* write — urgent
  included — left a receipt; no "is anything concurrent live?" predicate can
  rescue skipping (the excluding render can arrive later in the same event).
  Provenance: walked schedule C2; independently derived in the A-synthesis
  §9.1 and confirmed by both 2026-07-04 reviews.
- **I2. Replay-in-write-order over the pre-batch base is the only
  React-parity fold.** Apply-and-discard urgent updaters folds 3 (or worse)
  where React commits 4. Provenance: C3 walk; candidate B's kill, verified
  against B's own worked example (extraction 2026-07-04).
- **I3. Canonical-topology-only invalidation/notification is unsound under
  world-divergent dependencies.** A pending world's read set can include
  atoms with no canonical edge to the reader; walks from those atoms reach
  nothing. Provenance: C1 walk; killed candidate C (verified architectural,
  extraction 2026-07-04); present-but-compensable in synthesized A (both
  reviews).
- **I4. First-divergence induction** (usable construction): a node's world-w
  evaluation and canonical evaluation read identical atom prefixes up to the
  first atom whose w-value differs from canonical; that atom IS a canonical
  dependency, so canonical-cone walks always catch the *first* divergence.
  Compensating mechanisms need only cover *subsequent* divergent-dep writes
  (nodes already evaluated-in-w). Requires computed purity. Provenance:
  derivation in review 2026-07-04T08-52 (F2), re-verified in re-judgment.
- **I5. Once-per-staleness notification dedup loses batch granularity.**
  Marks that stop walks / an armed-bit cleared until re-run cannot deliver a
  second batch's setState in that batch's lane (C4). Per-(watcher, batch)
  state or a per-write walk is required. Provenance: C4 walk; found
  independently in synthesized A (review F-family) and candidate D (ARMED
  gap, re-judgment).
- **I6. Passes span yields and event handlers run in the gaps.** Any
  "in-render" state scoped [pass-start, pass-end] misclassifies reads/writes
  during yields (C7). The fork must expose yield/resume edges or equivalent
  callstack truth. Provenance: React scheduler behavior + walked C7; both
  reviews of the synthesis concurred (writes-throw crash).
- **I7. Write-time equality drops are safe only with empty history.** With
  any pending entries, worlds disagree about the accumulator, so an
  equal-vs-newest (or equal-vs-any-single-world) drop loses a load-bearing
  receipt (C8). With empty history the drop is safe even for
  functional/reducer ops (the dropped op would hold the lowest seq in every
  fold — evaluate once against base). Provenance: C8 schedules (codex review
  finding 4 + claude review F5 refinement, mutually confirmed).
- **I8. Every counter reset needs a paired epoch/generation guard** on every
  structure that retained old counter values, or cross-episode collisions
  falsely validate stale state (C13). Provenance: claude review F8 (seq
  reset vs surviving memos) + D's k1Epoch pattern as the positive example.
- **I9. Kernel/layout facts** — see `SEEDS/research-facts.md` (measured;
  that file is itself invariant-grade and is not duplicated here).
- **I10. ≤31 live batches (one per React lane)** — slot/mask encodings are
  sound iff slot recycling is gated on zero *unswept* entries, not zero
  live entries. Provenance: fork registry design + A-synthesis §9.2 slot
  audit (verified held in review 08-52).
- **I11. The closed-kernel *protocol boundary* is free; the *storage
  change* is what costs 5–12%** (SP1 + SP1b, measured 2026-07-04, both
  conformance-gated: 179/179 + growth stress + exact pull counts before any
  benchmarking). SP1: a closed kernel with values/dispatch moved to a
  handle-indexed entity-object table runs deep 1.06–1.07×, broad
  1.05–1.09×, reads 1.09–1.12×, create 1.08–1.09× vs the donor (diamond
  ~1.0–1.02×, within noise). SP1b three-way isolation (donor / host /
  fused-dispatch): the call-boundary component is **0.99–1.02× on every
  shape** (a const-bound four-callback host protocol costs the same as
  same-closure calls), while the storage component carries the **full tax**
  (deep 1.08, broad 1.06, reads 1.11, create 1.08 min ratios).
  Implications: (a) closed-kernel/host-protocol designs are NOT blocked by
  the protocol itself; (b) what must stay packed is the kernel-adjacent
  value/fn side columns, index-aligned to the plane — moving them into
  policy objects costs 5–12% regardless of fusion; (c) codegen fusion of
  the dispatch buys nothing. SP1c (closed protocol + packed side columns
  kept in-plane-aligned, predicted ≈donor) is the queued validation.
  Provenance: `research/experiments/sp1-host-callback-tax.md`,
  `research/experiments/sp1b-fusion-isolation.md`; `libs/arena-host`,
  `libs/arena-host-fused`.

## Round 1 (2026-07-04): rounds/round-01/ — walked-schedule provenance per line

- **I12. A mark/flag fast-path routing gate is sound only with a freshness
  conjunct**: serve the canonical kernel to a non-newest world only if the
  node is unflagged AND its cached value can be served without recompute. A
  lazy pull / first evaluation is a fresh newest-basis evaluation that can
  acquire a receipted atom through an edge no plane has recorded;
  reachability-derived flags cannot see a path the pull itself creates.
  Provenance: [WALK review-two-kernel-claude F1] + [WALK
  review-compensated-overlay-claude F1]; codex independently re-derived the
  class (TKC-3A) — both-model. Repaired construction: synthesis §5.3
  invariant R (judge re-walked, held).
- **I13. Equality-filtered per-token correction cannot witness joint
  multi-batch divergence**; late-join/mount corrections must be reach-based
  (schedule into every live batch that could reach the node; over-render is
  the price). Adversarial f diverges only on rendered subsets; subset
  enumeration is exponential. Provenance: [WALK review-open-claude F2] +
  [WALK review-two-kernel-claude F2]; both-model (codex TKC-5 duplicate).
- **I14. Retirement and per-root lock-in edges need their own notification
  path to committed-world observers** (write-time queue entries get consumed
  by earlier flushes; urgent-applied retirement folds are value-no-ops;
  store-only batches never commit on any root). Provenance: [WALK
  review-compensated-overlay-claude F3] + [WALK review-fork-native-claude
  F4]. Positive construction: synthesis §10.4 three-trigger inventory.
- **I15. Every retirement stamp/pin comparison must live on one monotone
  number line with write seqs** — a private retire counter vs a global-seq
  pin admits retiredSeq(1) ≤ pin(100) for a post-pin retirement (C7 drift);
  dropping the `retired ≤ pin` clause fails from the other side. The seed
  visibility rule's two pins are load-bearing, verbatim. Provenance: [WALK
  review-two-kernel-claude F3] + [WALK review-fork-native-claude F2].
- **I16. World-cache validity must enumerate a CLOSED set of change sources
  for world-visible outcomes.** Writes and retirement epochs are not
  enough: retirement *compaction* collapses version fingerprints (judge
  B1), thenable *settlement* changes a sentinel memo's correct outcome
  (TKC-2), and *evaluation-function identity* changes the value with no
  signal write (TKC-8). Three independent holes in one predicate family —
  repair as a single change-source enumeration, and audit it as a table.
  Provenance: three walked schedules; two models + judge independently.
- **I17. Node-local fixup at an edge-creation site is insufficient for a
  path-transitive invariant**: a reach/sensitivity flag raised at re-track
  must propagate through existing out-edges, because equality cutoff can
  leave downstream nodes CLEAN and unflagged while genuinely
  world-divergent. Provenance: [WALK addendum A2 / codex TKC-3B,
  re-derived against the repaired design].
- **I18. Mount/subscribe fixups must not rely solely on enumerating LIVE
  tokens**: a batch can retire inside the render→layout-effect window,
  making every per-token corrective unreachable; the fallback trigger must
  be a value/version compare against the current committed-for-root world.
  Provenance: [WALK addendum A3 / codex TKC-4].
- **I19 (extends I8). Every mask/bit column needs a stated clear site
  paired with the identity-recycle it outlives** (lock-in masks at slot
  recycle; notification columns; observed/ref counts) — retainer tables
  must include mask, seq, and allocator retainers and be checked by schema
  sweep, not prose. Provenance: [WALK addendum A4 / codex TKC-6] + judge
  C13 inventory gap.
- **I20. Positional suspense caches need world-CONTENT validity, not just
  batch-set (lineage) identity**: an intra-batch write invalidates the
  value memo, but a lineage-keyed positional cache survives and replays a
  thenable fetched from the stale world. Stable-identity-across-pure-
  retries AND invalidate-on-included-write must both hold. Provenance:
  [WALK codex CO-4, confirmed against the winner's §8.4].
