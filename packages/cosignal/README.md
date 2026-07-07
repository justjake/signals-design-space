# cosignal

A reactive state ("signals") library for JavaScript and TypeScript, built
around a compact core that stores its dependency graph in packed integer
arrays. One package, one build:

- **`cosignal`** — a plain, fast signals library: atoms, computed values,
  effects, batching — carrying a concurrent engine that makes the same
  signals safe under React's concurrent rendering, dormant until
  activated (`registerReactBridge()`, called for you by the separate
  `cosignal-react` bindings). **Sync by default:** until activation,
  every write applies immediately and the entire concurrency feature
  costs one predictable branch per public read/write — no write records,
  no batches, no alternative views of state are ever created (a
  behavioral test enforces this). Once activated, the engine records
  writes only while an update is actually in flight; see "Sync by
  default: quiet mode" below.

Two more entries are diagnostics: **`cosignal/trace`** (a zero-allocation
event recorder) and **`cosignal/graphviz`** (DOT renderers for the
dependency graph and for causal traces).

## The base library

```ts
import { Atom, Computed, effect, batch } from 'cosignal';

const count = new Atom(0);
const doubled = new Computed(() => count.state * 2);

const stop = effect(() => {
  console.log(doubled.state); // runs now, and again whenever it changes
});

count.set(1); // logs 2
batch(() => {
  count.set(2);
  count.set(3); // effects flush once, when the batch closes
});
stop();
```

### API

- **`new Atom(initial, options?)`** — a writable signal. `.state` reads
  (and registers a dependency when read inside a computed or effect);
  `.set(value)` replaces the value; `.update(fn)` applies a pure function
  to the current value. Options: `isEqual` (writes equal to the current
  value are dropped), `label` (debug name), and `effect` — an
  observed-lifecycle callback that runs when the atom gains its first
  subscriber of ANY kind — a computed chain or `effect()` in this
  library, or a React component subscribed through the `cosignal-react`
  bindings — and cleans up once the last subscriber of every kind is
  gone. One observation state over that union: an atom watched by both
  kinds at once observes exactly once. Useful for wiring an atom to a
  remote subscription; observe/unobserve flaps within one tick coalesce.
- **`new ReducerAtom(reducer, initial, options?)`** — an atom whose writes
  go through a reducer: `.dispatch(action)`. The reducer is fixed at
  creation and must be pure, because the concurrent engine replays
  dispatched actions to compute what different views of the state should
  show — an impure reducer would replay differently each time.
- **`new Computed(fn, options?)`** — a derived signal; `.state` evaluates
  on demand and caches. `fn` receives a context object:
  - `ctx.previous` — the last cached value (a hint only: it may be stale
    or `undefined`; the function must be correct without it).
  - `ctx.use(...)` — read an async value inside a computed, in two forms.
    Both follow React's `use()` contract: a fulfilled promise returns its
    value, a rejected one throws its reason, and while a promise is
    pending, reads of the computed throw a stable `SuspendedRead` carrier
    (the React bindings translate this into Suspense); settlement
    re-evaluates the computed.
    - `ctx.use(promise)` — for a promise the CALLER caches (in a data
      layer or in component state). The engine stores nothing; passing
      the same settled promise later reads its value synchronously.
    - `ctx.use(key, factory)` — the built-in cache: the computed keeps a
      per-key map of promises for its own lifetime, so the factory runs
      once per key and the same promise is reused across re-evaluations.
      The key is the identity of the thing being fetched — it must carry
      every input that varies the request. Example:
      `ctx.use(['user', userId], () => fetchUser(userId))`: a different
      `userId` is a different key (a new fetch); the same `userId` reuses
      the same promise, even across interrupted and replayed renders.
      Keys are JSON-ish scalars or arrays of them; the cache dies with
      the computed. (A bare factory with no key is rejected — an unkeyed,
      uncached promise would refetch on every re-evaluation, the footgun
      React's `use()` documentation warns about.)
  - `isEqual` option: when a re-evaluation produces an equal result, the
    previous reference is returned so downstream consumers see no change
    (an "equality cutoff").
- **`effect(fn)`** — runs `fn` immediately with dependency tracking and
  re-runs it when any tracked signal changes. `fn` may return a cleanup
  function. Returns a disposer. Effects always observe the newest values.
- **`effectScope(fn)`** — returns one disposer for every effect created
  inside `fn`.
- **`batch(fn)`** — defers effect re-runs until `fn` returns, so a group
  of writes triggers each affected effect once. Nothing else: batching
  never delays the writes themselves, and reads inside a batch see them
  immediately. (`startBatch()`/`endBatch()` are the low-level form for
  binding authors.)
- **`untracked(fn)`** — reads inside `fn` register no dependencies.
- **`configure({ forbidWritesInComputeds?, initialRecords? })`** —
  optional strictness (throw on writes during a computed evaluation) and
  a capacity floor for the core's storage (also settable via the
  `COSIGNAL_INITIAL_RECORDS` environment variable before first import).

Two disciplines are enforced at runtime because the concurrent engine
depends on them:

- **Updaters and reducers must be pure.** The functions passed to
  `update`/`dispatch` run under a guard: reading or writing signals
  inside them throws. Read what you need first, then dispatch.
- **Cycles throw.** A computed that re-enters itself during its own
  evaluation throws `CycleError` instead of looping or silently serving
  a stale value.

### Performance design

The core keeps every signal, computed, effect, and dependency edge as
fixed-stride records in packed `Int32Array` buffers rather than as linked
JavaScript objects. Reads, writes, and invalidation walks are index
arithmetic over those arrays: no per-operation allocation on hot paths,
no pointer chasing, nothing for the garbage collector to trace. Capacity
grows by rebuilding over doubled buffers at safe operation boundaries.
The semantics are alien-signals-compatible push-pull reactivity — writes
push invalidation through the graph, reads pull recomputation lazily so
only stale values re-evaluate — validated against a 179-case conformance
suite (see "Testing" below).

## The concurrent engine

The same `cosignal` entry exports `registerReactBridge()`, the activation
point the React bindings (the separate `cosignal-react` package) call
once at startup:

```ts
import { registerReactBridge } from 'cosignal';

const bridge = registerReactBridge(); // once, at app setup
```

Until it is called, the engine is dormant and the library is exactly the
plain signals library above — the full conformance suite passes with the
engine dormant, and again with the bridge registered but idle.

### Why a concurrent engine exists

React's **concurrent rendering** splits work by urgency. A **transition**
(`startTransition`) marks an update as non-urgent: React renders it in
the background, over several interruptible slices, while urgent updates
(typing, clicks) keep landing and committing in between. That is safe for
React's own state because React keeps one value per pending update
internally — but an external store has just one current value. If a
low-priority render reads the store at two different moments, or an
urgent render reads state that only a pending transition should see, you
get **tearing**: a single rendered frame showing a mixture of old and new
state.

The engine removes the single-current-value limitation:

- **Log entries.** Every write is recorded as a compact log entry — which
  operation (set / functional update / reducer action), which batch it
  belongs to, and its position on one global timeline — appended to the
  written atom's write log. Writes still apply to the core immediately, so
  plain reads stay fast.
- **Batches.** A batch is the group of writes belonging to one UI update
  (one event handler, one transition, one async action). React schedules
  each batch at a single priority; the engine keeps each batch's writes
  visible together or not at all.
- **Worlds.** A world is one self-consistent assignment of values to
  every signal, computed by replaying exactly the log entries that world is
  allowed to see, in timeline order, over the atom's folded base value.
  Three kinds exist: the *newest* world (every write applied), the
  *committed* world of a root (exactly what that root's on-screen UI
  reflects), and a *pending* world (what one in-progress render may see:
  committed state plus its own batches, frozen at the moment the render
  started so a paused-and-resumed render never drifts).

Because every world is a pure replay of the same log entries, a pending UI
update and the committed UI can never disagree about history — they only
differ in how much of it they are allowed to see. When a batch is done
(committed everywhere or abandoned), it *retires*: its writes become
permanent history visible to every world, and once no world can tell the
difference, its log entries fold into the atom's base value and are
reclaimed.

The log entries themselves live in packed parallel number arrays per atom,
matching the core's no-allocation discipline: recording a write is a few
integer stores, not an object allocation.

### Sync by default: quiet mode

Registering the bridge does not, by itself, make writes expensive. While
nothing is pending — no live batch, no in-progress render pass — the
bridge is **quiet**: a write to a registered atom folds directly into
permanent history and the current value together, creating no log entry, no
batch, and no event. The recording pipeline arms only while an update is
actually in flight (a batch open, a render pass in progress) and disarms
again once the last one retires. A transition that starts after a run of
quiet writes begins from the already-advanced committed state — there is
no history to reconstruct, because quiet writes ARE permanent history the
moment they land. Net posture: an app that never starts a transition pays
close to the plain write price with the machinery dormant; an app that
does pays for recording exactly while a transition is pending.

### The host contract

`cosignal-react` is one **host driver** — the adapter connecting this
engine to a concrete UI library. The bridge surface it drives is
host-agnostic: any UI library whose renderer groups updates by priority
("lanes") and can speculatively render a proposed frame, then commit or
discard it and rebase remaining work (branch-commit-rebase semantics),
could implement the same contract. A host driver's responsibilities:

- **Batch lifecycle.** Open a batch (`openBatch`) for each group of
  writes that must land together — one event handler, one transition —
  and retire it (`retire(batchId)`) once it is finished everywhere.
  Retirement makes the batch's recorded writes permanent history that
  every world sees; this holds whether the host committed the batch or
  abandoned it (state changes are never silently discarded — a host
  that wants an abandoned batch's writes gone must undo them with new
  writes). A batch backing an asynchronous action can be parked — kept
  pending until the action's promise settles (`settleAction`).
- **Render passes.** Report each speculative render: `renderStart(root,
  includedBatches)` declares which batches the render may see (its view
  is frozen at start, so pausing and resuming never drifts);
  `renderYield`/`renderResume` bracket interruptions; `renderEnd(renderPass,
  'commit' | 'discard')` ends it with a disposition. At a commit the
  engine snapshots committed state, folds the render's batches into the
  root's committed view, and reconciles subscribers that mounted during
  the render against updates that were in flight but not included.
- **Per-root commits.** Each root (one independently rendered tree) has
  its own committed view and a commit generation (`root(id)`
  materializes it). The engine advances them at `renderEnd('commit')`; the
  host reconciles any commit its renderer reports beyond that
  (idempotent set-add into the root's committed-batch table).
- **Write classification.** Install `bridge.writeClassifier` to
  attribute every host-attributable write to the batch context it
  executes in — the engine's public atom methods capture each write as a
  whole operation (set / functional update / reducer action) and hand it
  over — and `setWorldProvider` to answer, per read, which world the
  current call context should resolve in (a rendering subscriber reads
  its own render's frozen world; everything else reads newest).
- **Delivery scheduling.** Receive the engine's re-render decisions
  through direct callbacks — `onDelivery` (a batch's write reached a
  subscriber), `onMountCorrective` (a freshly mounted subscriber must
  join a still-live batch it rendered without), `onCorrection` (an
  urgent pre-paint fix against committed truth) — and schedule each
  re-render INTO the causing batch's own lane, so it renders and commits
  together with its cause. Deliveries are value-blind: the engine
  decides who must re-render; the host only schedules.

The remaining engine exports (`CosignalBridge`, the node/render-pass/batch
types, `BridgeScheduleError`, `BridgeInvariantViolation`) are that seam;
applications normally touch only `registerReactBridge()`, indirectly,
via `cosignal-react`.

## Diagnostics: `cosignal/trace` and `cosignal/graphviz`

`cosignal/trace` answers "why did this re-render / effect run / value
change?" without perturbing what it measures. Events are fixed-size
integer records written into preallocated buffers — no allocation per
event — with two modes: a **ring** (flight recorder: fixed memory, oldest
events overwritten) and a **session** (lossless capture in sealed
chunks, with a loud truncation marker if a byte budget is crossed). When
no tracer is attached the entire cost is one field check per event site.
Every record names the event that provoked it, so causality is queryable:

```ts
import { attachTracer, formatTrace } from 'cosignal/trace';

const tracer = attachTracer(bridge); // bridge from registerReactBridge()
// ... exercise the app ...
console.log(formatTrace(tracer.events()));      // "#id +Δµs kind(subject) …"
console.log(tracer.whyDelivered('w12'));        // the write → delivery chain
tracer.stop();
```

`cosignal/graphviz` renders DOT source (pipe to `dot -Tsvg`):
`dependencyGraphToDot(bridge)` snapshots the live dependency graph
(atoms, computeds, subscribers, effects); `traceToDot(events, filter?)`
draws a trace as a causal graph — write → delivery → correction chains.
Both diagnostic entries load independently: importing the engine pulls in
neither, and each imports only types from the other modules.

## Testing

Two independent harnesses back the library's claims:

- **Conformance.** The core passes a 179-case conformance suite for
  alien-signals-compatible semantics — dependency tracking, lazy
  re-evaluation, equality cutoffs, effect scheduling, edge cases like
  diamond graphs and conditional dependencies. The identical suite passes
  again with the bridge registered and idle, pinning that the concurrent
  machinery costs nothing semantically when unused.
- **Model-based testing.** The concurrent engine is developed against an
  executable reference model: a deliberately simple, obviously-correct
  implementation of the same behavioral contract, plus an invariant
  checker, a seeded random schedule generator, and a shrinker that
  reduces any failure to a minimal reproduction. The engine replays the
  model's acceptance scenarios, a corpus of pinned regression schedules,
  and thousands of randomized interleavings (writes, render passes,
  pauses, commits, abandons, mounts) in lockstep with the model,
  comparing every observable value and every notification decision after
  every step. The model ships as its own package, `cosignal-oracle`, so
  the same harness can referee alternative engine implementations.

## License

MIT
