# @lab/cosignal-oracle

The referee for cosignal v1 (spec/cosignal-v1.md §8 "oracle first"): a
deliberately naive, obviously-correct reference model plus a randomized test
harness. The real engine must later agree with this model on every
observable. The model's authority comes from simplicity — plain objects, no
caches, no cleverness: worlds are pure folds over visibility-filtered
receipt tapes, computeds are memo-free recursive evaluation, delivery
reachability is recomputed from scratch at every write, and the fork is
explicit token/pass/retirement bookkeeping. If the engine and this model
disagree, the engine is wrong (or the spec reading is — see
`tests/FLAGS.md` for the two places fuzzing showed the spec text itself
needs annotation).

```
src/model.ts       the naive model; every rule cites its spec section
src/invariants.ts  self-checks run after every schedule step
src/schedule.ts    seeded schedule generator + runner + shrinker
src/adapter.ts     the engine adapter interface + diff harness
tests/battery.spec.ts   the 17 acceptance-battery cases (§6)
tests/scars.spec.ts     30 pinned scar schedules (SCARS.md)
tests/flags.spec.ts     appendix-B flags 3/4/5/7, targeted
tests/fuzz.spec.ts      seeded fuzz, determinism double-runs, adapter self-test
tests/FLAGS.md                    editorial-flag findings/discrepancies
tests/SKIPPED-FOR-FORK-SUITE.md   what needs real React, and why
```

Run: `pnpm -C packages/cosignal-oracle test` (vitest; ~1s) and
`pnpm -C packages/cosignal-oracle typecheck`.

## How a future engine plugs in

Implement `EngineAdapter` (src/adapter.ts) over the real engine + fork
bridge:

```ts
type EngineAdapter = {
  // Apply one ScheduleOp (open batch, write, scope write, settle, retire,
  // pass start/yield/resume/end(+retireAtCommit), mount/render watcher,
  // effects, discardAllWip, quiesce). Return 'skipped' iff the op is
  // illegal in the current state — legality must match the model's.
  apply(op: ScheduleOp): 'applied' | 'skipped';
  // All observable values right now: newest world, committed-for-root(r)
  // for every root, and every open pass's world (read(node, world)).
  snapshot(): ObservableSnapshot;
  // Comparable events since the last drain, in order: delivery / suppressed
  // decisions (value-blind, with {watcher, token, slot} attribution),
  // reconcile corrections, mount correctives, urgent fixup corrections,
  // per-root commits, retirements, core/react effect runs.
  drainEvents(): ModelEvent[];
};
```

Then `diffAgainstModel(engine, generateSchedule(seed, steps), seed)` replays
the same schedule into the engine and the model side by side and returns the
first divergence (step + message). `modelAsEngine()` is the conforming
self-test adapter the fuzz suite already runs — copy it as the template.
Engine internals (memos, touched words, K1 records, slots-as-bits) are never
compared; only observables are. Two declared tolerances an engine diff
runner may need to relax, both documented in the model source: the model's
delivery reachability uses the episode-accumulated union graph (an engine
may over-notify relative to exact per-world closures — §5.9 prices this, so
compare deliveries as "engine ⊇ required, ⊆ union-conservative" if the
engine's K0 re-track timing differs), and the model compares folded values
by `Object.is` (reference parity of fold memos is an engine-side obligation,
see the skipped manifest).

## Reproducing a failing seed

Every fuzz failure prints its seed and a shrunk schedule. To replay:

```ts
import { fuzzSeed, runSchedule } from '@lab/cosignal-oracle/src/schedule.js';
const { failure } = fuzzSeed(173, 80);      // same seed + steps as the log
// failure.error, failure.step, failure.shrunk (a minimal ScheduleOp[])
runSchedule(failure.shrunk, true);          // deterministic re-run, invariants on
```

or paste the printed shrunk JSON straight into `runSchedule(ops, true)`.
Schedules are pure functions of (seed, steps); the determinism suite
double-runs every seed and compares full observable fingerprints, so a seed
reproduces byte-identically.

## What the model deliberately does not do

No memos, no touched words, no fast paths (it always folds); no Suspense
capsules or thenables; no arena; no performance claims. `ctx.previous` is
omitted because §3.4 grants it no semantics. Where the spec describes an
optimization plus its safety argument, the model implements only the
semantics the optimization must preserve — that is what makes it an oracle.
