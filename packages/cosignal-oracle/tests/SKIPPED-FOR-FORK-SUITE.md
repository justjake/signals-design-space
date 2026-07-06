# Behaviors that need a real React host

The model deliberately simulates React's lifecycle as explicit
bookkeeping (passes, commits, retirements) and carries no engine
internals (no packed storage, no memo caches, no real hooks, no real
promises). Some behaviors therefore cannot be expressed against it: they
are pinned instead in the test suites that run the real engine and a
patched React build implementing cosignal's external-runtime protocol
("the fork"). This file lists each one and why it is out of the model's
reach. The ids (S-numbers for pinned regression schedules, case numbers
for acceptance scenarios) are stable identifiers shared with the test
suites.

## Regression schedules (13 of 43; the other 30 are pinned in tests/scars.spec.ts)

- **S13** — retaining derived-value snapshots per (world, batch)
  combination explodes memory. A cost failure with no value-level
  observable; the model retains nothing and always replays.
- **S15** — records discarded mid-flight must be reclaimed from packed
  storage. A storage-reclamation mechanism; the model has no packed
  storage, so nothing can leak.
- **S20** — keying Suspense cache entries on global retirement counters
  invalidates them spuriously. Suspense machinery holds real thenables;
  engine/host scope.
- **S22** — tracking async carriers by patching promise methods does not
  work. An empirical ruling about how the platform schedules promise
  continuations; there is nothing to model.
- **S24** — per-pass evaluation stamps break cache keys that must
  survive a Suspense retry. Needs real Suspense retries under a stable
  render lineage.
- **S28** — publishing staged evaluator versions out of order around
  replays. Evaluator staging was removed from the design (a computed's
  function is immutable for the node's life; changed deps create a fresh
  node), so the schedule is unrepresentable.
- **S31** — a moved evaluation stamp forces a refetch, which
  side-effectful caches observe. Suspense cache validity (duplicate
  fetches are accepted in v1); host scope.
- **S32** — sampling live committed evaluators while replaying a pass
  world mixes closures. Staging was removed; evaluators and reducers are
  immutable, so the schedule cannot exist.
- **S34** — gating evaluator stages only at hook execution time leaves
  gaps. Same removal; unrepresentable.
- **S37** — a coarse receipt-count gate on reads. The approach died on
  its own declared cost terms; there is no correctness observable to
  pin.
- **S39** — guarding Suspense settlement with generation counters alone
  races. Needs real thenable identity across settlement races;
  engine/host scope.
- **S40** — deciding evaluator-version visibility by chronology alone.
  Evaluator versions were removed from the design; unrepresentable.
- **S41** — gating a read fast path on an exact cached basis. Engine
  cache internals; the model always replays, so the schedule has no
  model-level observable.

(**S43** is split: its counter horizon/reserve arithmetic is engine
scope, but its precondition — work-in-progress must be discarded
synchronously before the episode resets — is pinned at model level
inside the S38/S43 test in `tests/scars.spec.ts`. Sequence renumbering
itself was deleted — grind batch 4, item C: counters are exact to 2^53
and the SMI effect measured within noise — so quiescence is a pure
episode reset.)

## Acceptance-scenario aspects (host-only halves of cases otherwise pinned)

- **Case 1 V7** — two live batches where one suspends: Suspense caching
  and render lineage; host scope.
- **Case 9 / case 10 restart races** — an update inserted after a pass
  has finished rendering but before it commits forces React to restart
  the pass at a fresh pin. The model *assumes* this as a legality fact
  about the host; the race itself needs the real reconciler.
- **Case 13, counter-overflow halves** — wrap-around of internal walk
  and cache generation counters, reserve arithmetic for live counter
  horizons, recycling of node identities: engine counters the model does
  not carry. The model pins the episode-reset-at-quiescence and
  slot-recycling halves.
- **Case 14** — StrictMode's double-mount netting to one subscription,
  and `useComputed` hook-state reuse: needs real React hooks. The model
  pins the halves it can see: evaluation is idempotent, and writes
  during render throw.
- **Case 15** — Suspense across worlds (render lineage, cache prefixes,
  settlement identity): entirely host scope.
- **Realm affinity** — handles must not cross JavaScript realms, and
  structured-clone attempts are rejected: host-boundary behavior.
- **Reference identity of memoized replays** — the object produced by
  the committing render must *be* the committed object (not merely equal
  to it). The model recomputes replays and compares by value; reference
  parity is an engine obligation, tested in the engine's differential
  reducer suite.
- **Performance gates** — parity of the plain build, idle overhead of
  the concurrent build, per-write cost budgets: out of a correctness
  referee's scope by design.
