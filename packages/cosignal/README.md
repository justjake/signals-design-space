# cosignal

A reactive state ("signals") library for JavaScript and TypeScript, built
around a compact core that stores its dependency graph in packed integer
arrays. One package, two builds:

- **`cosignal`** — a plain, fast signals library: atoms, computed values,
  effects, batching. Nothing else. Its module graph contains none of the
  React-integration machinery below; if you import only this entry, your
  bundle carries zero concurrency code (a build-isolation test enforces
  this).
- **`cosignal/logged`** — the same API plus the concurrent engine that
  makes signals safe under React's concurrent rendering. It records every
  write, so different views of the state ("worlds") can coexist without
  ever mixing.

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
  subscriber and cleans up when it loses its last one (useful for wiring
  an atom to a remote subscription; observe/unobserve flaps within one
  tick coalesce).
- **`new ReducerAtom(reducer, initial, options?)`** — an atom whose writes
  go through a reducer: `.dispatch(action)`. The reducer is fixed at
  creation and must be pure, because the concurrent build replays
  dispatched actions to compute what different views of the state should
  show — an impure reducer would replay differently each time.
- **`new Computed(fn, options?)`** — a derived signal; `.state` evaluates
  on demand and caches. `fn` receives a context object:
  - `ctx.previous` — the last cached value (a hint only: it may be stale
    or `undefined`; the function must be correct without it).
  - `ctx.use(thenableOrFactory)` — read an async value inside a computed.
    While the promise is pending, reads of the computed throw a stable
    `SuspendedRead` carrier (React bindings translate this into
    Suspense); settlement re-evaluates the computed.
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

Two disciplines are enforced at runtime because the concurrent build
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

## The concurrent build: `cosignal/logged`

`cosignal/logged` exports the same API and adds `registerReactBridge()`,
the activation point the React bindings (the separate `cosignal-react`
package) call once at startup. Until the bridge is armed, the logged
build behaves exactly like the base build — the full conformance suite
passes both ways.

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

The logged engine removes the single-current-value limitation:

- **Receipts.** Every write is recorded as a compact receipt — which
  operation (set / functional update / reducer action), which batch it
  belongs to, and its position on one global timeline — appended to the
  written atom's history. Writes still apply to the core immediately, so
  plain reads stay fast.
- **Batches.** A batch is the group of writes belonging to one UI update
  (one event handler, one transition, one async action). React schedules
  each batch at a single priority; the engine keeps each batch's writes
  visible together or not at all.
- **Worlds.** A world is one self-consistent assignment of values to
  every signal, computed by replaying exactly the receipts that world is
  allowed to see, in timeline order, over the atom's folded base value.
  Three kinds exist: the *newest* world (every write applied), the
  *committed* world of a root (exactly what that root's on-screen UI
  reflects), and a *pending* world (what one in-progress render may see:
  committed state plus its own batches, frozen at the moment the render
  started so a paused-and-resumed render never drifts).

Because every world is a pure replay of the same receipts, a pending UI
update and the committed UI can never disagree about history — they only
differ in how much of it they are allowed to see. When a batch is done
(committed everywhere or abandoned), it *retires*: its writes become
permanent history visible to every world, and once no world can tell the
difference, its receipts fold into the atom's base value and are
reclaimed.

The receipts themselves live in packed parallel number arrays per atom,
matching the core's no-allocation discipline: recording a write is a few
integer stores, not an object allocation.

The remaining logged exports (`CosignalBridge`, the node/pass/token
types, `BridgeScheduleError`, `BridgeInvariantViolation`) are the seam
the React bindings and the diagnostics entries drive; applications
normally touch only `registerReactBridge()` indirectly via
`cosignal-react`.

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
  diamond graphs and conditional dependencies. The logged build with the
  bridge unarmed passes the identical suite, pinning that the concurrent
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
