# Effects: the split primitive, schedules, and delivery

This document is the design for the effect subsystem: what an effect is,
when it runs, and why the engine validates it the way it does. It also
records what this design replaced, for readers migrating old code.

## The primitive

```ts
const stop = createEffect(
	() => derive(a.get(), b.get()),               // compute: tracked, pure
	(value, previous) => { ...; return cleanup }, // handler: untracked side effect
	{ equals, label, schedule },
)
```

An effect is two functions with different rules:

- **compute** uses the same evaluator and semantics as a computed: tracked
  dynamically, cached, cut off by `equals`, async-capable through `use()`,
  and handed its own previous value. Its state lives on the effect node
  instead of a separate computed node. The no-writes rule still applies.
- **handler** runs untracked with the compute's `(value, previous)` and
  may return a cleanup, which runs before the next handler run and at
  disposal. Reads inside the handler are deliberately untracked — a value
  the effect should react to belongs in the compute.

The first run happens synchronously at creation when the compute settles
immediately; a compute that parks on its first evaluation fires its first
handler at settlement, on the effect's schedule. A creation-time compute
error disposes the effect and rethrows. `createEffect` returns a disposer, and
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

| schedule            | drain trigger                                           | coalescing window      | error surface        |
| ------------------- | ------------------------------------------------------- | ---------------------- | -------------------- |
| `'sync'` (default)  | inside the flush when the write settles                 | one flush (`batch()`)  | throws at write site |
| `'useLayoutEffect'` | hosted: the pass's commit, layout phase; else microtask | the render pass / task | rethrown from drain  |
| `'useEffect'`       | hosted: the pass's passive phase; else `setTimeout(0)`  | since last drain       | rethrown from drain  |

- Ordering per write is fixed: sync effects, then render notifications,
  then useLayoutEffect, then useEffect.
- The engine core is dependency-free: its built-in pumps are
  `queueMicrotask` (useLayoutEffect) and `setTimeout(0)` (useEffect).
- With React mounted, each `CosignalsProvider` hosts the drains
  instead: a lane request re-renders a null last-child sentinel by reducer
  dispatch, at the same ambient priority as the subscriber wakes from the
  same write, so React batches both into one render pass. The sentinel's
  layout effect drains useLayoutEffect — after that pass's DOM mutations and
  every app layout effect, before the frame paints — and its passive
  effect drains useEffect in the same flush as the pass's `useEffect`s.
  The guarantee this buys is frame coherence: a handler's DOM writes land
  in the same frame as the component updates for the same signal write. A
  free-running microtask pump instead drains before React renders, so a
  handler there reads pre-commit DOM and its output paints a frame ahead
  of the components (the flaw this design replaced). The residual trade:
  an effect whose write wakes no component inherits the write's React
  urgency — end-of-event for discrete events, the DefaultLane pass for
  timers and network, which can land after a (consistent, pre-write)
  paint.
- Liveness never depends on a commit arriving: a sentinel unregistering
  with accepted-but-undrained requests re-arms the built-in pumps
  (`repumpDeferredLanes`), and with no provider mounted the built-ins
  serve directly.
- `flushScheduledEffects()` drains both deferred lanes (and pending
  `onObserved` transitions) synchronously — the test seam for headless
  code and for writes whose requests fell back to the built-in timers.
  Hosted drains need no seam: they are ordinary commit effects, so `act()`
  flushes them.
- There is a fourth, internal lane: render-subscriber notification. It is
  not selectable. Its watchers hold one pinned dependency, skip
  validation entirely (their change test is transition-aware and
  value-level, which graph clocks cannot express), drain in-flush after
  sync effects, and carry the draft-wake channel. Exposing it would let
  user code run
  inside the flush with subscriber semantics, which nothing needs.

The `onObserved` atom lifetime flush keeps its own microtask instead of
riding the useLayoutEffect pump: an activation feeds data (sockets,
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
the drain site (the write for `'sync'`; for the deferred lanes, the hosting
commit effect or the fallback pump task). A throwing cleanup additionally
poisons its own effect, as before.

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
concurrent React without any coupling to what renders see.

## React hooks

```ts
useSignalEffect(() => ({ watch, run, equals?, label? }), deps)       // useEffect lane
useSignalLayoutEffect(() => ({ watch, run, equals?, label? }), deps) // useLayoutEffect lane
```

The factory-built spec names createEffect()'s two slots: `watch` is the source
(a compute function, a signal, a tuple, or a record) and `run` is the
handler. The factory runs inside the matching React phase effect, keyed
on `deps`: mount and deps changes dispose the previous effect and set up
and first-run the new one **exactly** in React's phase and tree order —
`useEffect`'s own re-create cycle. Only signal-triggered re-runs use the
lane, which is the relaxation that removes the old re-render-to-run
machinery.

- Captures are deps-fresh, never ref-fresh: the factory shape exists so
  one closure carries every capture — the compute's and the handler's —
  and stock `react-hooks/exhaustive-deps` checks them all against `deps`
  (callback at argument 0, deps at argument 1) once the hooks are listed:

  ```jsonc
  "react-hooks/exhaustive-deps": ["error", {
    "additionalHooks": "(useSignalEffect|useSignalLayoutEffect)"
  }]
  ```

  A deps change resets `previous` to undefined (fresh effect, first run
  in-phase), exactly like a `useEffect` re-run. The earlier design's
  latest-ref handler — commit-anchored freshness without re-creation —
  was deleted with the move to deps-driven re-creation: its safety
  argument had to be re-proven under every concurrent feature, while
  deps-only freshness has nothing to prove.
- No provider is required: the hooks observe base state, which needs no
  root channel. StrictMode's double mount nets one live effect.

## What this replaced

- `effect(fn)`, the tracked-and-side-effecting single body, and with it
  the entire second validation path: watcher dependency lists, the
  watcher's validation watermark and its pre-run stamping discipline, and
  the flush's per-watcher dependency confirmation loop. One `EffectNode`
  now stores the effect's dynamic dependencies and shares the computed
  evaluator. Pinned watchers are only used by render subscriptions; each
  holds its observed node and never re-tracks.
- `useSignalEffect`'s re-render channel: the force reducer, the
  version/rerun bookkeeping, and the scheduled-effect handshake
  (`WatchSchedule`) that asked React to re-render a component purely to
  reach its phase effect.
- Committed-view effects and committed views (`committed(x, container)`,
  then `committed(x)` and `useCommitted` entirely, the twin
  committed-view watcher and its certificate-edge refresh). The per-root
  machinery existed to observe the window where a transition has
  committed on one React root but not yet on another; on a single root
  that window is unobservable — the commit marker retires the draft
  before any descendant layout effect runs, so the committed view is
  always base state. What remained after that cut was a shell over base
  reads with no ecosystem precedent (React and Solid keep the committed
  view implicit), so the query was removed outright. Render soundness
  across multiple roots is unaffected (per-root render snapshots and
  retirement-waits-for-all-roots remain); during multi-root commit skew,
  effects and ambient reads observe values at retirement rather than per
  root.

## Migration sketch (for posterity)

Two units, engine-first because the old hook machinery reads per-root
committed state:

1. Engine + React effect rewrite: split primitive, lanes, two-phase
   drain, hook rewrite, pump installation, adapter shims
   (benchmark-harness `effect(fn)` becomes compute-with-side-effects plus
   a no-op handler and `equals: () => false` — sound because harness
   bodies read but never write signals).
2. Committed-view removal: first the per-root bookkeeping and the
   provider `container` plumbing, then `committed()`/`useCommitted`
   outright.

Tests pin the new contract rather than porting old pins: value cutoff
instead of conservative re-runs, lane timing, drain-sourced errors, and
provider-free operation.
