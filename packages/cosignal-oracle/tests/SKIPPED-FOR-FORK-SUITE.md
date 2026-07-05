# Skipped for the fork suite

Scars and battery aspects that cannot be expressed against the naive model
(no real React / no engine internals), one line each. Everything here must
be pinned in the fork reconciler suite (spec §4.4 / §8) or the engine
conformance suite instead.

## Scars (13 of 43; the other 30 are pinned in tests/scars.spec.ts)

- **S13** (per-(world, batch) powerset frontier retention) — a cost/memory
  scar with no value-level observable; the model has no retained frontiers.
- **S15** (discarded arena records leak) — arena reclamation mechanism; the
  model has no arena, so nothing can leak.
- **S20** (global retirement clocks in capsule keys) — Suspense capsule
  machinery holds real thenables; fork/engine scope.
- **S22** (promise-patching carriers are dead) — empirical platform behavior
  (PerformPromiseThen); nothing to model, the ruling is architectural.
- **S24** (per-pass evaluator stamps in retry-crossing keys) — needs real
  Suspense retries under a stable fork lineage id.
- **S28** (unordered evaluator publication around folds) — evaluator staging
  was deleted by cut C3; the schedule is unrepresentable in the spec'd design.
- **S31** (stamp-move ⇒ refetch for side-effectful caches) — Suspense
  capsule validity (v1 accepts duplicate fetches; v1.1 refinement); fork scope.
- **S32** (live-sampled committed evaluators for pass folds) — staging
  deleted (C3); reducers/evaluators are immutable, the schedule cannot exist.
- **S34** (hook-time-only stage gating) — staging deleted (C3); same.
- **S37** (coarse receipt-count read gate) — died on its own declared cost
  terms; there is no correctness observable to pin.
- **S39** (generation-only capsule settlement guards) — needs real thenable
  identity across settlement races; fork/engine scope.
- **S40** (chronology-only evaluator-version visibility) — evaluator
  versions deleted (C3); unrepresentable.
- **S41** (exact-basis fast-path gating over K0 serves) — engine cache/basis
  internals; the model always folds, so the schedule has no model observable.

(**S43** is split: the horizon/reserve arithmetic is engine scope, but its
synchronous-discard precondition is pinned at model level inside the S38/S43
test in tests/scars.spec.ts.)

## Battery aspects (fork-only halves of cases otherwise pinned)

- **Case 1 V7** (two live batches, one suspends) — Suspense capsules/lineage.
- **Case 9 race with test 24** / **case 10 race (ii)** (updates inserted
  after a completed-but-uncommitted pass force a pre-commit restart) — a
  reconciler behavior the model assumes as a legality fact, not a mechanism.
- **Case 13 rows 6–9** (walk-generation wrap, capsule-generation wrap, live
  horizon reserve arithmetic, node-identity recycling) — engine counters the
  model does not carry; the model pins epoch renumbering and slot recycling.
- **Case 14** StrictMode double-mount subscription netting and useComputed
  hook-state reuse — needs real hooks; the model pins evaluation idempotence
  and the render-write throw.
- **Case 15** (Suspense across worlds) — entirely fork scope: lineage ids,
  capsule prefixes, settlement identity.
- **§3.2 realm affinity / structured-clone rejections** — host-boundary
  behavior.
- **§5.3 per-atom fold memo REFERENCE parity** (the committing render's
  object becomes the committed object) — the naive model recomputes folds
  and compares by value; reference-identity parity is an engine obligation
  tested in the differential useReducer battery.
- **§7 gates** (DIRECT parity, idle overhead, logged-write price, etc.) —
  performance gates, out of referee scope by design.
