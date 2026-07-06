# cosignal-oracle

The executable reference model ("oracle") for
[`cosignal`](https://www.npmjs.com/package/cosignal)'s concurrent
semantics, used for model-based testing. It is a deliberately simple,
obviously-correct implementation of the same behavioral contract the
real engine implements, plus the machinery to referee an engine against
it:

- **the model** (`src/model.ts`) — plain objects, no caches, no
  cleverness: every observable is recomputed from first principles;
- **an invariant checker** (`src/invariants.ts`) — self-checks run after
  every step of every schedule;
- **a seeded random schedule generator, runner, and shrinker**
  (`src/schedule.ts`) — randomized interleavings of writes, render
  passes, pauses, commits, abandons, and mounts, reproducible from a
  seed, with automatic reduction of failures to minimal schedules;
- **an engine adapter interface and diff harness** (`src/adapter.ts`) —
  any engine implementation can run the same schedules in lockstep with
  the model and report the first observable divergence.

The model's authority comes from simplicity. Worlds are pure replays
over visibility-filtered write records; derived values are memo-free
recursive evaluation; notification reachability is recomputed from
scratch at every write; React's render lifecycle is explicit
token/pass/retirement bookkeeping. Wherever a real engine would use an
optimization (memo tables, dirty marking, fast paths), the model simply
recomputes everything — so if the engine and the model disagree, the
engine is wrong.

Run: `pnpm test` (vitest, about a second) and `pnpm typecheck`.

## The behavioral contract

This section states, in the model's own words, the contract an engine
must reproduce. Terms are defined as they appear.

### Vocabulary

- A **batch** is the group of writes belonging to one UI update (one
  event handler, one transition, one async action). Each batch is
  identified by a **token**. At most 31 batches are live at once,
  mirroring React's 31 priority lanes; each live batch that has written
  occupies a **slot** in a 31-entry recycling table, and visibility
  bookkeeping is per-slot.
- A **receipt** records one write: the operation (set / functional
  update — a reducer-style write records as an update whose closure
  captures the action), the writing batch's token and slot, and a
  position (**seq**) on one global timeline. Receipts append to the
  written atom's **tape**; older receipts eventually fold into the
  atom's **base** value (compaction).
- A **world** is one self-consistent assignment of values to every atom,
  computed by replaying the receipts that world may see, in timeline
  order, over the base — with the atom's equality function applied
  stepwise (an equal step keeps the previous reference).
- A **render pass** is one attempt by React to render a root. It may
  **yield** (pause) and resume; it ends in a **commit** (its output
  reaches the screen) or a **discard**. At start it freezes a **pin**
  (the current timeline position) and captures its **mask** (the live
  batches it is rendering) plus a snapshot of the root's
  already-committed batches.
- **Retirement** ends a batch's life, exactly once: its receipts become
  permanent history visible to every world. A **parked** async-action
  batch retires only when the action settles.
- A **watcher** is one subscribed component instance. A **delivery** is
  the notification that schedules a watcher to re-render after a write.

### Visibility (which receipts a world replays)

- **A pass world** sees a receipt if (1) the receipt's batch retired at
  or before the pass's pin — it was already permanent history when the
  pass started — or (2) the receipt belongs to an *included* batch (in
  the pass's mask, or committed into the root when the pass started)
  *and* the receipt's seq is at or before the pin. The pin cap exists
  because a pass can pause and resume: without it, a write landing
  mid-pause would change answers between two slices of the same render,
  which is exactly the tearing this design exists to prevent. The pin
  cap applies to committed members too: a still-live batch that is
  already committed into the root can keep writing, and those late
  writes must not drift a paused render.
- **The committed world of a root** sees every retired receipt, plus
  receipts of batches currently committed into that root (membership).
  Membership exists because commits are per root: once a root has
  committed UI rendered from a batch, that root must keep agreeing with
  its own screen even though the batch is still live elsewhere.
- **The newest world** sees everything. Plain (non-React) reads and core
  effects use it.
- **The mount-reconciliation world** (used once, at a mount's commit)
  sees the mounting render's own included receipts up to its pin, plus
  committed truth *as of now* — i.e., the mounted component's view
  fast-forwarded to what actually committed during its mount window.

### Batch and slot lifecycle

A batch's first write interns its slot (claiming a free one), appends a
receipt, and bumps the slot's write clock. On retirement the model runs
a fixed order: stamp every receipt of the batch with the retirement seq;
fold/compact what can be folded; notify committed-state observers; clear
the batch's per-root membership rows; release the slot — deferred while
any open pass's mask names it (deferred releases re-evaluate at every
pass end). The order is load-bearing: rows clear before release so a
recycled slot can never be mistaken for a committed member, and
notification happens after stamping so observers see the post-retirement
truth. Slot recycling is safe because receipts carry their slot
permanently and every claim is sequenced after the previous tenant's
retirement, so a fold can always tell tenants apart by seq. Write clocks
and delivery-dedup bits reset at claim. If every slot is somehow held, a
retired-but-mask-retained slot is released anyway, loudly — retained
passes stay correct because their receipts kept their slot fields.

Compaction folds a prefix of a tape into the base only when every
receipt in the prefix is retired *and* every live pass's pin already
sees them via the retired-history rule — so compaction can never change
any live world's answer. An abandoned batch (no React work ever
committed) retires through the same path: writes never silently revert,
and persistence never depends on having subscribers.

Equality dropping is allowed only for a write that lands on an *empty*
tape and evaluates equal to the base: with pending history present, a
"no-op" write can still change some world's fold, so it must append.

### Delivery (how watchers learn about writes)

Delivery is per write, value-blind, and synchronous in the writer's call
stack: the watcher's re-render is scheduled into the *writing batch's*
lane, so the re-render renders and commits with that batch. Value-blind
because "did this write change what the component shows?" depends on the
world doing the asking; any single value comparison at delivery time
would compare across worlds and either leak pending state or miss
updates. The price is bounded over-notification (a scheduled render that
folds to an equal value), which is safe.

One dedup bit per (watcher, slot) suppresses repeat deliveries — but
only when scheduled-and-not-yet-started work will fold the new write. If
a pass on the watcher's root already started (its pin predates the
write) and its mask names the slot, the running render cannot see the
write, so it is delivered anyway as an "interleaved" update (React
restarts at a fresh pin). Dedup bits re-arm when the watcher re-renders.

### Commit, mount reconciliation, and effects

When a pass commits: re-rendered watchers adopt the pass-world values;
retirements due at this commit run (only batches this pass rendered may
retire inside its commit — a foreign batch retires at its own closure);
every still-live rendered batch is committed into the root (**lock-in**,
bumping the root's commit generation and notifying committed observers);
then, in layout (before paint), newly mounted watchers subscribe and
reconcile.

Mount reconciliation closes the render-to-subscribe gap. For each live
batch that touched the mounted node but was not included in its render,
a corrective re-render is scheduled into that batch's own lane (so the
mount joins pending updates instead of missing or revealing them). Then
one comparison against the mount-reconciliation world catches whatever
retired or locked in during the window and corrects it urgently before
paint. A fast path may skip the comparison when four conditions prove
the window was quiet (same pass mounting and committing; no
committed-side advance since the pin; root commit generation unchanged;
no included batch wrote after the pin — checked over the committing
batches at commit time, not a stale slot snapshot). The fast path is
sound only together with the corrective loop; the subtle cases live in
`tests/FLAGS.md`.

Effects come in two kinds. Core effects (`effect()`) observe the newest
world and flush after a write's notification walk. React-level effects
(`useSignalEffect`) observe the committed world of their root and re-run
at every durable flip — per-root commits, retirements, settlements —
because side effects must track what the user actually sees, never
pending speculation.

### Quiescence

When nothing is live (no batches, no passes, no parked actions), every
tape has fully compacted. The model then resets per-episode dependency
bookkeeping (epoch bump, dead-record drop, slot bookkeeping zeroes).
Timeline values are never rewritten: sequence counters are plain JS
numbers, exact to 2^53, only ever compared, so they simply keep
climbing across episodes. Batch tokens are likewise monotone forever.

## How an engine plugs in

Implement `EngineAdapter` (`src/adapter.ts`) over the engine:

```ts
type EngineAdapter = {
  // Apply one ScheduleOp (open batch, write, scoped write, settle, retire,
  // pass start/yield/resume/end(+retire-at-commit), mount/render watcher,
  // effects, discard-all, quiesce). Return 'skipped' iff the op is illegal
  // in the current state — legality must match the model's.
  apply(op: ScheduleOp): 'applied' | 'skipped';
  // All observable values right now: the newest world, committed-for-root
  // for every root, and every open pass's world.
  snapshot(): ObservableSnapshot;
  // Comparable events since the last drain, in order: deliveries and
  // suppressions (value-blind, with {watcher, token, slot} attribution),
  // reconcile corrections, mount correctives, urgent mount corrections,
  // per-root commits, retirements, effect runs.
  drainEvents(): ModelEvent[];
};
```

Then `diffAgainstModel(engine, generateSchedule(seed, steps), seed)`
replays the same schedule into the engine and the model side by side and
returns the first divergence (step + message). `modelAsEngine()` is the
conforming self-test adapter the fuzz suite already runs — copy it as
the template. Engine internals (memos, dirty bits, packed storage) are
never compared; only observables are.

Two declared tolerances a diff runner may need, both documented in the
model source: the model's notification reachability uses the union of
dependency edges observed in *any* world this episode, which is
deliberately conservative — an engine whose dependency re-tracking
timing differs may notify slightly differently, so compare deliveries as
"engine ⊇ required, ⊆ the union-conservative set" if needed
(over-notification costs a render, never correctness). And the model
compares folded values with `Object.is`; reference identity of memoized
folds is an engine-side obligation tested in the engine's own suite.

## Reproducing a failing seed

Every fuzz failure prints its seed and a shrunk schedule. To replay:

```ts
import { fuzzSeed, runSchedule } from './src/schedule.js';
const { failure } = fuzzSeed(173, 80);      // same seed + steps as the log
// failure.error, failure.step, failure.shrunk (a minimal ScheduleOp[])
runSchedule(failure.shrunk, true);          // deterministic re-run, invariants on
```

or paste the printed shrunk JSON straight into `runSchedule(ops, true)`.
Schedules are pure functions of (seed, steps); the determinism suite
double-runs every seed and compares full observable fingerprints, so a
seed reproduces byte-identically.

## Test layout

```
tests/battery.spec.ts   17 acceptance scenarios for the contract above
tests/scars.spec.ts     30 pinned regression schedules — interleavings that
                        broke earlier designs, asserting the correct outcome
tests/flags.spec.ts     targeted tests for four subtle rules (tests/FLAGS.md)
tests/fuzz.spec.ts      seeded fuzzing, determinism double-runs, adapter self-test
tests/FLAGS.md                    the subtle behavioral rules, with rationale
tests/SKIPPED-FOR-FORK-SUITE.md   what needs a real React host, and why
```

## What the model deliberately does not do

No memos, no dirty marking, no fast paths for value computation (it
always replays); no Suspense capsules or thenables; no packed storage;
no performance claims. The `ctx.previous` hint is omitted because the
contract grants it no semantics a test could pin. Where the engine
implements an optimization plus its safety argument, the model
implements only the semantics the optimization must preserve — that is
what makes it an oracle.
