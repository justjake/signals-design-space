# cosignal-oracle

The executable reference model ("oracle") for
[`cosignal`](https://www.npmjs.com/package/cosignal)'s concurrent
semantics, used for model-based testing. It is a deliberately simple,
obviously-correct implementation of the same behavioral contract the
real engine implements, plus the machinery to referee an engine against
it:

- **the model** (`src/model.ts`) — plain objects, no cleverness, and
  exactly one cache, which the behavioral contract itself requires
  (explained below): everything else is recomputed from first
  principles;
- **an invariant checker** (`src/invariants.ts`) — self-checks run after
  every step of every schedule;
- **a seeded random schedule generator, runner, and shrinker**
  (`src/schedule.ts`) — randomized interleavings of writes, render
  renders, pauses, commits, abandons, and mounts, reproducible from a
  seed, with automatic reduction of failures to minimal schedules;
- **an engine adapter interface and diff harness** (`src/adapter.ts`) —
  any engine implementation can run the same schedules in lockstep with
  the model and report the first observable divergence.

The model's authority comes from simplicity. Worlds are pure replays
over visibility-filtered write records; derived values are memo-free
recursive evaluation; notification reachability is recomputed from
scratch at every write; React's render lifecycle is explicit
batch/render/retirement bookkeeping. Wherever a real engine would use an
optimization (memo tables, dirty marking, fast paths), the model simply
recomputes everything — so if the engine and the model disagree, the
engine is wrong. The one exception is semantic, not an optimization: in
the newest world, an untracked read observes a point-in-time sample
taken when its computed last re-derived, and a value sampled in the
past cannot be recomputed from present state — it has to be remembered.
Each computed node therefore keeps its last newest-world derivation
(the tracked dependencies with the values they had, plus the derived
value); render-pass and committed worlds still replay cache-free.

Run: `pnpm test` (vitest, about a second) and `pnpm typecheck`.

## The behavioral contract

This section states, in the model's own words, the contract an engine
must reproduce. Terms are defined as they appear.

### Vocabulary

- A **batch** is the group of writes belonging to one UI update (one
  event handler, one transition, one async action). Each batch is
  identified by a **BatchId**. At most 31 batches are live at once,
  mirroring React's 31 priority lanes; each live batch that has written
  occupies a **slot** in a 31-entry recycling table, and visibility
  bookkeeping is per-slot.
- A **log entry** records one write: the operation (set / functional
  update — a reducer-style write records as an update whose closure
  captures the action), the writing batch's id and slot, and a
  position (**seq**) on one global timeline. Log entries append to the
  written atom's **write log**; older log entries eventually fold into the
  atom's **base** value (compaction).
- A **world** is one self-consistent assignment of values to every atom,
  computed by replaying the log entries that world may see, in timeline
  order, over the base — with the atom's equality function applied
  stepwise (an equal step keeps the previous reference).
- A **render pass** is one attempt by React to render a root. It may
  **yield** (pause) and resume; it ends in a **commit** (its output
  reaches the screen) or a **discard**. At start it freezes a **pin**
  (the current timeline position) and captures its **mask** (the live
  batches it is rendering) plus a snapshot of the root's
  already-committed batches.
- **Retirement** ends a batch's life, exactly once: its log entries become
  permanent history visible to every world. A **parked** async-action
  batch retires only when the action settles.
- A **watcher** is one subscribed component instance. A **delivery** is
  the notification that schedules a watcher to re-render after a write.

### Visibility (which log entries a world replays)

- **A render world** sees a log entry if (1) the log entry's batch retired at
  or before the render's pin — it was already permanent history when the
  render started — or (2) the log entry belongs to an *included* batch (in
  the render's mask, or committed into the root when the render started)
  *and* the log entry's seq is at or before the pin. The pin cap exists
  because a render can pause and resume: without it, a write landing
  mid-pause would change answers between two slices of the same render,
  which is exactly the tearing this design exists to prevent. The pin
  cap applies to committed members too: a still-live batch that is
  already committed into the root can keep writing, and those late
  writes must not drift a paused render.
- **The committed world of a root** sees every retired log entry, plus
  log entries of batches currently committed into that root (membership).
  Membership exists because commits are per root: once a root has
  committed UI rendered from a batch, that root must keep agreeing with
  its own screen even though the batch is still live elsewhere.
- **The newest world** sees everything. Plain (non-React) reads and core
  effects use it. One rule refines its COMPUTED values [ruling
  2026-07-06: untracked sampling]: newest values of computeds follow
  KERNEL semantics — a computed re-derives only when a TRACKED
  dependency's newest value changed, and untracked reads are
  point-in-time samples taken at those re-derivations. Untracked means
  untracked: a write reaching a computed only through untracked reads
  changes no newest answer until a tracked dependency moves (the base
  library's documented untracked contract, value face — each computed
  node keeps a `{trackedFingerprint, value}` record consulted only by
  `newestValue` and the core-effect flush). World folds are unchanged:
  render/committed/mount-fix evaluations refold at their boundaries, so
  untracked deps stay fresh in every world-side revalidation.
- **The mount-reconciliation world** (used at most once per mount, at
  its commit, when the four-condition test below falls through) sees
  the mounting render's own included log entries up to its pin, plus
  committed truth *as of now* — i.e., the mounted component's view
  fast-forwarded to what actually committed during its mount window.

### Batch and slot lifecycle

A batch's first write interns its slot (claiming a free one), appends a
log entry, and bumps the slot's write clock. On retirement the model runs
a fixed order: stamp every log entry of the batch with the retirement seq;
fold/compact what can be folded; notify committed-state observers; clear
the batch's per-root membership rows; release the slot — deferred while
any open render's mask names it (deferred releases re-evaluate at every
render end). The order is load-bearing: rows clear before release so a
recycled slot can never be mistaken for a committed member, and
notification happens after stamping so observers see the post-retirement
truth. Slot recycling is safe because log entries carry their slot
permanently and every claim is sequenced after the previous tenant's
retirement, so a fold can always tell tenants apart by seq. Write clocks
and delivery-dedup bits reset at claim. If every slot is somehow held, a
retired-but-mask-retained slot is released anyway, loudly — retained
renders stay correct because their log entries kept their slot fields.

Compaction folds a prefix of a write log into the base only when every
log entry in the prefix is retired *and* every live render's pin already
sees them via the retired-history rule — so compaction can never change
any live world's answer. An abandoned batch (no React work ever
committed) retires through the same path: writes never silently revert,
and persistence never depends on having subscribers.

Equality dropping is allowed only for a write that lands on an *empty*
write log and evaluates equal to the base: with pending history present, a
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
a render on the watcher's root already started (its pin predates the
write) and its mask names the slot, the running render cannot see the
write, so it is delivered anyway as an "interleaved" update (React
restarts at a fresh pin). Dedup bits re-arm when the watcher re-renders.

### Commit, mount reconciliation, and effects

When a render commits: re-rendered watchers adopt the render-world values;
retirements due at this commit run (only batches this render rendered may
retire inside its commit — a foreign batch retires at its own closure);
every still-live rendered batch is committed into the root (**lock-in**,
bumping the root's commit generation and notifying committed observers);
then, in layout (before paint), newly mounted watchers subscribe and
reconcile.

Mount reconciliation closes the render-to-subscribe gap, in two steps
decided in order. First, for each live batch that touched the mounted
node but was not included in its render, a corrective re-render is
scheduled into that batch's own lane (so the mount joins pending
updates instead of missing or revealing them) — this step reads write
metadata only, no values. Second, a four-condition test decides whether
anything retired or locked in during the window: same render mounting and
committing; no committed-side advance since the pin; root commit
generation unchanged; no included batch wrote after the pin (checked
over the committing batches at commit time, not a stale slot snapshot).
When every condition passes, reconciliation is done — no re-evaluation,
no comparison; any drift the window could still hide is a live batch's
write that the first step just scheduled a re-render for. When a
condition fails, the node is re-evaluated in the mount-reconciliation
world (its own included writes at its pin, plus committed truth as of
now) and a real difference is corrected urgently before paint. The
conditions are sound only together with the corrective step; the subtle
cases live in `tests/FLAGS.md`.

Effects come in two kinds. Core effects (`effect()`) observe the newest
world and flush after a write's notification walk. React-level effects
(`useSignalEffect`) are committed-for-root **dep-snapshot observers**
(the engine's promoted production mechanism, modeled 1:1): each run
executes the effect's BODY under committed-for-root read capture — the
body re-chooses its dependencies causally, so a flag-flip body reads
different atoms on different runs — and the `(node, value)` snapshot it
captured is the value-gated re-check surface. Re-check timing is
RCC-EF2's amended BOUNDARY semantics (2026-07-06): once per boundary
OPERATION — a per-root commit, a retirement (write-free ones included:
retirement and settlement are guaranteed flush points), a settlement —
at the boundary value (member writes coalesce; one render locking in two
batches re-checks once), and never while the effect's own root has an
open render-pass frame (the deferred flip flushes when that frame
closes, commit or discard). Cleanup runs before every re-fire and at
removal; nothing runs after removal. StrictMode-style replay is an
explicit op (cleanup + unconditional re-run + recapture).

### Quiescence

When nothing is live (no batches, no renders, no parked actions), every
write log has fully compacted. The model then resets per-episode dependency
bookkeeping (epoch bump, dead-record drop, slot bookkeeping zeroes).
Timeline values are never rewritten: sequence counters are plain JS
numbers, exact to 2^53, only ever compared, so they simply keep
climbing across episodes. Batch ids are likewise monotone forever.

## How an engine plugs in

Implement `EngineAdapter` (`src/adapter.ts`) over the engine:

```ts
type EngineAdapter = {
  // Apply one ScheduleOp (open batch, write, scoped write, settle, retire,
  // render start/yield/resume/end(+retire-at-commit), mount/render watcher,
  // effects, discard-all, quiesce). Return 'skipped' iff the op is illegal
  // in the current state — legality must match the model's.
  apply(op: ScheduleOp): 'applied' | 'skipped';
  // All observable values right now: the newest world, committed-for-root
  // for every root, and every open render's world.
  snapshot(): ObservableSnapshot;
  // Comparable events since the last drain, in order: deliveries and
  // suppressions (value-blind, with {watcher, batch, slot} attribution),
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

No memos, no dirty marking, no fast paths for value computation —
render-pass and committed worlds always replay, and the single
exception is the newest world's per-computed sample record (see "The
newest world" above), kept because the untracked-read contract requires
remembering point-in-time samples. No Suspense capsules or thenables;
no packed storage; no performance claims. The `ctx.previous` hint is
omitted because the contract grants it no semantics a test could pin. Where the engine
implements an optimization plus its safety argument, the model
implements only the semantics the optimization must preserve — that is
what makes it an oracle.

Declared gaps of the committed-observer (useSignalEffect) model — each
refereed elsewhere, named here so the coverage boundary is explicit
(effects unification, 2026-07-06):

- **Suspense in dep snapshots.** The model has no thenables, so battery
  16d's rule — a dep whose committed re-read is a still-pending
  suspension is NOT a flip — is pinned engine-direct
  (`cosignal/tests/suspense.spec.ts`) and at the React battery, not in
  lockstep.
- **Host refire phase.** The model runs a re-fire at the boundary
  operation's end. The React adapter additionally defers refires queued
  by a COMMIT's boundary to the root-commit report (React captures its
  re-pend classification before render-end) — a host-phase shell with no
  protocol counterpart here; the React suite referees it.
- **Observation liveness.** Effect dep snapshots retain the RCC-OL1
  observation union engine-side (like watchers, whose lifecycle the
  model also deliberately omits); pinned by
  `cosignal/tests/observe-union.spec.ts` and the React suite.
- **StrictMode.** React's double-invoke is modeled only as the explicit
  `replayReactEffect` op (cleanup + unconditional re-run), not as host
  double-registration; the React hooks suite referees the real shape.
