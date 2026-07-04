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
- **I11. The closed-kernel host-callback tax is real and exceeds the 5%
  gate on recompute-dense shapes** (SP1, measured 2026-07-04,
  conformance-validated 179/179 + growth stress + exact pull counts before
  benchmarking): vs the donor kernel, min-of-N ratios deep **1.06×**, broad
  **1.06×** (mean 1.09×), diamond 1.02×; reads 1.09×; scale-1 write
  +12–16%. The tax is NOT confined to recompute upcalls — quiet read/write
  paths pay accessor indirection too — and the measurement bundles (a)
  call-boundary cost and (b) the packed-side-columns → handle-indexed
  entity-object storage change; SP1b (fusion variant) isolates them. Any
  design putting a call boundary or object-table hop on kernel hot paths
  must price against these numbers, not predictions. Provenance:
  `research/experiments/sp1-host-callback-tax.md`, `libs/arena-host`.
