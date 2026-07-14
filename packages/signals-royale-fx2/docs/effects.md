# Effects: the split primitive, schedules, and delivery

This document is the design for the effect subsystem: what an effect is,
when it runs, and why the engine validates it the way it does. It also
records what this design replaced, for readers migrating old code.

## The primitive

```ts
const stop = effect(
	() => derive(a.get(), b.get()),               // compute: tracked, pure
	(value, previous) => { ...; return cleanup }, // handler: untracked side effect
	{ equals, label, schedule },
)
```

An effect is two functions with different rules:

- **compute** is a real computed node: tracked dynamically, cached,
  cut off by `equals`, async-capable through `use()`, handed its own
  previous value. Everything true of `createComputed` is true of it,
  including the no-writes rule.
- **handler** runs untracked with the compute's `(value, previous)` and
  may return a cleanup, which runs before the next handler run and at
  disposal. Reads inside the handler are deliberately untracked — a value
  the effect should react to belongs in the compute.

The first run happens synchronously at creation when the compute settles
immediately; a compute that parks on its first evaluation fires its first
handler at settlement, on the effect's schedule. A creation-time compute
error disposes the effect and rethrows. `effect` returns a disposer, and
`effectScope` collects effects exactly as before.

There is no single-function form. A body that both tracks and side-effects
cannot be re-validated without re-running its side effect, which is the
defect this split removes.

## Delivery: value-anchored, settled-only

The handler fires when the compute's **settled** value differs from the
value the handler **last received** (`equals`, same function as the
compute's own cutoff, different anchor):

- Parking is silent: a refetch keeps serving the previous value and runs
  nothing; `isPending` is the indicator.
- Settlement fires the handler only when the settled value differs from
  the last-handled one — a refetch that returns identical data runs
  nothing.
- A compute error never calls the handler; the error rethrows from the
  drain (see below). The effect stays live and fires on the next settled
  change.

Why anchor to the last-handled value instead of trusting the compute's own
cutoff: validation and delivery are different moments. The graph must
advance a node's change stamp when an evaluation parks and again when a
settlement ends the pending span even if the value is unchanged — parked
readers have to re-pull. Ends of error spans behave the same way. And a
handler can be deferred by a round (see the drain), after which the
compute's own previous-value comparison answers the wrong question. The
last-handled anchor gets every case right with one field and one `equals`
call per drain, and it is the same pattern React subscribers already use
(compare against what was rendered, not against graph stamps).

## Schedules

`schedule` picks when signal-triggered re-runs drain. It changes nothing
else — not the first run, not disposal, not the change test.

| schedule                 | drain trigger                              | coalescing window     | error surface        |
| ------------------------ | ------------------------------------------ | --------------------- | -------------------- |
| `'sync'` (default)       | inside the flush when the write settles    | one flush (`batch()`) | throws at write site |
| `'before-paint'`         | microtask (end of the current task)        | the task              | rethrown from pump   |
| `'after-paint'`          | scheduler NormalPriority; timeout fallback | since last drain      | rethrown from pump   |

- Ordering per write is fixed: sync effects, then render notifications,
  then before-paint, then after-paint.
- The engine core is dependency-free: its built-in pumps are
  `queueMicrotask` (before-paint) and `setTimeout(0)` (after-paint).
  `registerReactSignals()` upgrades after-paint to
  `Scheduler.unstable_scheduleCallback(NormalPriority)` — the same band
  React uses for its own passive flush, so both flushes interleave at one
  priority. Before-paint stays on the microtask even under React: a
  microtask is the only host timing guaranteed to precede the rendering
  steps — a scheduler callback is a macrotask that can land after a paint
  (which is why React runs its own layout effects synchronously in
  commit), and requestAnimationFrame never fires in hidden tabs. The
  trade: coalescing is per task rather than per frame, and a write from an
  async callback can drain before React commits that callback's own state
  updates, so a handler there may read pre-commit DOM.
- `flushScheduledEffects()` drains both paint lanes (and pending
  `onObserved` transitions) synchronously — the test seam; `act()` alone
  does not flush scheduler tasks.
- There is a fourth, internal lane: render-subscriber notification. It is
  not selectable. Its watchers hold one pinned dependency, skip
  validation entirely (their change test is world-aware and value-level,
  which graph clocks cannot express), drain in-flush after sync effects,
  and carry the draft-wake channel. Exposing it would let user code run
  inside the flush with subscriber semantics, which nothing needs.

The `onObserved` atom lifetime flush keeps its own microtask instead of
riding the before-paint pump: an activation feeds data (sockets,
`ctx.set`), and delaying it to a frame boundary would show subscribers the
pre-activation value for a visible beat.

## The drain

The write path only marks and enqueues; **an effect validates and runs at
its lane's drain site**. Each drain processes rounds of two phases until
the queue is empty (with the same run ceiling as the flush, so a
non-settling cycle throws instead of livelocking):

1. **Pull.** For each queued effect: bring the compute fresh, then keep
   the effect only if its settled value differs from the last-handled one.
   Parked computes and equal values drop out here; nothing has side
   effects yet, so a heavy recompute burst never interleaves with DOM
   work.
2. **Run.** All survivors' cleanups run first, then all handlers
   (React's own destroy-all-then-create-all ordering). A survivor whose
   compute was re-marked by an earlier handler's write in this round is
   skipped before its cleanup: its value is already superseded, and the
   re-mark re-enqueued it, so the next round delivers the latest value —
   or nothing, if the write reverted it. Once a cleanup has run, its
   handler runs even if re-marked mid-phase; cleanups never run unpaired.

Errors follow the flush's documented policy: a throwing pull, cleanup, or
handler aborts the drain, the preempted entries' marks are cleared so an
unrelated later write cannot fire them stale, and the error surfaces from
the drain site (the write for `'sync'`, the pump task for the paint
lanes). A throwing cleanup additionally poisons its own effect, as
before.

Net effect of drain-time validation: the cutoff is measured against the
window, not the write. A value that changes and reverts between drains
runs nothing; the old "a batch may conservatively re-run an effect once"
caveat is gone for effects (atoms still stamp conservatively for cache
purposes).

## Effects and transitions

Effects observe base state, full stop. A drafted write moves no base
state and runs no wave, so effects cannot observe speculative values; a
transition reaches every effect exactly once, at retirement, through the
normal write path with equality applied; a discarded transition is
invisible. This is what makes the effect side of the engine sound under
concurrent React without any coupling to render worlds.

## React hooks

```ts
useSignalEffect(compute, handler, deps, opts?)       // after-paint lane
useSignalLayoutEffect(compute, handler, deps, opts?) // before-paint lane
```

- The effect is created inside the matching React phase effect, keyed on
  `deps` (required, mirroring `useComputed`): mount and deps changes set
  up and first-run **exactly** in React's phase and tree order. Only
  signal-triggered re-runs use the lane, which is the relaxation that
  removes the old re-render-to-run machinery.
- The handler reads through a latest ref, so it sees the most recent
  committed render's props without re-creating the effect — the same
  freshness the old design provided.
- No provider is required: the hooks observe base state, which needs no
  root channel. StrictMode's double mount nets one live effect.

## What this replaced

- `effect(fn)`, the tracked-and-side-effecting single body, and with it
  the entire second validation path: watcher dependency lists, the
  watcher's validation watermark and its pre-run stamping discipline, and
  the flush's per-watcher dependency confirmation loop. Watchers now hold
  exactly one pinned dependency (an effect's compute; a subscriber's
  observed node) and never re-track; dynamic dependency tracking lives
  only in computeds.
- `useSignalEffect`'s re-render channel: the force reducer, the
  version/rerun bookkeeping, and the scheduled-effect handshake
  (`WatchSchedule`) that asked React to re-render a component purely to
  reach its phase effect.
- Committed-world effects and per-root committed views (`committed(x,
  container)`, `useCommitted`, the twin world-source watcher and its
  certificate-edge refresh). Those existed to observe the window where a
  transition has committed on one React root but not yet on another; on a
  single root that window is unobservable — the commit marker retires the
  draft before any descendant layout effect runs, so the committed world
  is always base state. Render soundness across multiple roots is
  unaffected (per-root render worlds and retirement-waits-for-all-roots
  remain); during multi-root commit skew, effects and committed reads now
  observe values at retirement rather than per root.

## Migration sketch (for posterity)

Two units, engine-first because the old hook machinery reads per-root
committed state:

1. Engine + React effect rewrite: split primitive, lanes, two-phase
   drain, hook rewrite, pump installation, adapter shims
   (benchmark-harness `effect(fn)` becomes compute-with-side-effects plus
   a no-op handler and `equals: () => false` — sound because harness
   bodies read but never write signals).
2. Committed-view removal: `committed()`/`useCommitted`, the per-root
   committed bookkeeping, and the provider `container` plumbing.

Tests pin the new contract rather than porting old pins: value cutoff
instead of conservative re-runs, lane timing, drain-sourced errors, and
provider-free operation.
