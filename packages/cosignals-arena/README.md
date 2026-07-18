# cosignals-arena

A reactive state engine with first-class support for React concurrent
rendering, whose graph lives in typed-array records instead of linked JS
objects. It is the data-oriented build of
[cosignals](https://www.npmjs.com/package/cosignals): same public API,
same tests, different memory layout (see
[Data-oriented design](#data-oriented-design) for what that buys and
costs). It is two layers:

- a conventional signal graph — writable atoms, lazy cached computeds,
  effects, batching — with equality cutoff and batched delivery. Node and
  link records share one interleaved `Int32Array` arena; the public handle
  IS the node, and numeric record ids replace object pointers on the
  invalidation and validation paths;
- a small concurrency overlay for React transitions: writes made inside a
  transition stay invisible to committed readers until the transition
  lands, while every reader still sees an internally consistent snapshot.

The root entry (`cosignals-arena`) is React-free and dependency-free.
React bindings ship as a subpath — `cosignals-arena/react` — with
`react`/`react-dom` 18.2 or later as peer dependencies; they run on stock
React, no patches or build flags. The npm package contains ESM JavaScript
and TypeScript declarations compiled from this repository's TypeScript
source.

## Core API

```ts
import { createAtom, createComputed, createEffect, batch, untrack } from "cosignals-arena"

const count = createAtom(1)
const double = createComputed(() => count.get() * 2)
const stop = createEffect(
  () => double.get(), // compute: tracked, pure
  (value) => console.log(value), // handler: untracked side effect
) // the handler runs now, then when the settled value changes

count.set(2) // handler logs 4
count.update((x) => x + 1) // functional update
batch(() => {
  // one flush for the whole callback
  count.set(10)
  count.set(3) // net revert: the handler never runs
})
stop()
```

- **Equality:** writes that compare equal are dropped. Pass
  `{ equals }` to customize; pass `{ label }` to name an atom in traces.
- **Lazy initializers:** `createAtom(() => expensive())` runs the function once,
  untracked, at first use (read, write, or subscription — never at
  construction). A `set` before the first read still runs it, because the
  equality contract needs the base value. Initializers must not write.
- **Computeds** are lazy and cached, track dependencies dynamically (a
  branch not taken this evaluation is not a dependency), and only recompute
  when an input's value generation actually advanced.
- **Effects** are a source and a handler. The source declares what the
  effect reacts to: a compute function (the same evaluator and semantics
  as a computed — tracked, cached, cut off by `equals`, async-capable
  through `use()` — with state living on the effect itself), a signal, a
  tuple of signals, or a record of signals. The container shorthands read
  each signal into a same-shaped value and default their cutoff to
  `shallowEquals` (exported; an explicit `equals` overrides):

  ```ts
  createEffect(query, (q) => syncUrl(q))
  createEffect([user, theme], ([u, t]) => paintHeader(u, t))
  createEffect({ user, theme }, ({ user, theme }) => paintHeader(user, theme))
  ```

  The handler runs untracked with the source's settled `(value, previous)`
  pair when that value changes, and may return a cleanup that runs before
  the next handler run and at disposal. Reads the effect should react to
  belong in the source; handler reads are untracked.

  A pending compute is silent: settlement fires the handler only when the
  settled value differs. A compute error rethrows from the drain site without
  calling the handler. `effectScope(fn)` collects every effect created inside
  and returns one disposer.

- **Schedules:** `createEffect(compute, handler, { schedule })` picks when
  signal-triggered re-runs drain: `'sync'` (default — inside the flush
  when the write settles), `'useLayoutEffect'`, or `'useEffect'` — named
  for the React phases that run them. With a provider mounted, the
  handler runs in the same commit as the components the write re-rendered
  (layout or passive phase); headless, a microtask or `setTimeout(0)`
  approximates. Both are coalesced per window with a net value cutoff,
  and the first run at creation is always synchronous.
  `flushScheduledEffects()` drains the deferred lanes now (tests,
  headless hosts). See `docs/effects.md` for the full contract.

## Intents, drafts, and transitions

Writes are INTENTS: either a value (`set`) or a function to re-execute
against whatever the base turns out to be (`update`). Urgent intents apply
immediately. Intents issued inside a React transition are recorded into a
DRAFT instead — an ordered log attached to that transition.

Every reader resolves values against committed state plus the drafts it
is allowed to see: an urgent render sees none, a transition's own renders
see that transition's draft. Resolution replays, in original dispatch
order, exactly the intents the reader may see. That single rule produces
React's updater-queue behavior:

```ts
const n = createAtom(1)
// transition records: update(x => x + 2)     (draft D)
// urgent write:       update(x => x * 2)
n.get() // 2      — urgent skipped the draft: 1 * 2
// inside the transition: (1 + 2) * 2 = 6 — replay in dispatch order, never reorder
```

When a draft RETIRES (its transition committed everywhere), the full replay
folds into committed state through the ordinary write path — effects run,
equality applies — and renders still holding the draft's id resolve the same
values, so retirement is invisible to them. A discarded draft rolls back:
draft readers are re-notified and re-resolve without it. When the last
draft dies, every per-draft structure is dropped; a quiescent engine holds
nothing extra.

## The read family

```ts
count.get() // committed state plus applied urgent writes; drafts hidden
latest(count) // newest intent, drafts included; never suspends
isPending(count) // true while newer data exists behind the shown value
```

There is deliberately no `committed()` query: the committed view is
implicit, exactly as in React and Solid. Ordinary reads outside a render
pass are base state — committed writes and retired transitions, drafts
hidden — so "what is on screen" is what everything that did not opt into
a draft already sees.

Inside a computed evaluation (or a render pass, through the React bindings)
`latest` and `get` resolve that context's own snapshot — reading
transitions your context does not include would be a tear. In a base-state
computed or effect, `latest(x)` is also a tracked dependency: when `x`
changes, the reader re-runs. What distinguishes `latest` from `get` is
that it never suspends, not that it reads a different snapshot from inside
an evaluation.

## Async values

Pending and error are graph STATE, not control flow:

```ts
const user = createComputed((use) => use(fetchUser(id.get())))
```

- `use(thenable)` returns the settled value, or parks the evaluation. A
  parked computed keeps serving its last settled value ("stale") and exposes
  one stable pending promise per span, so a suspended React render retries
  exactly once per settlement and never re-issues fetches.
- Settlement behaves as a write: it invalidates and propagates, and parked
  computeds re-evaluate eagerly so chained requests progress without a
  reader.
- Errors rethrow the same reason object at every read site.
- Keep thenables stable per input set (derive them from state, as above).
  A function that creates a brand-new promise on every evaluation would
  refetch on every settlement — that is a data-layer bug this engine cannot
  paper over.

## Refetching

To refetch with unchanged inputs, own the trigger: keep a version atom,
read it inside the computed, and bump it to fetch again. There is no
dedicated refetch API because a version bump is an ordinary write, and
ordinary writes already do everything a refetch needs.

```ts
const userVersion = createAtom(0)
const user = createComputed((use) => use(fetchUser(id.get(), userVersion.get())))

userVersion.update((v) => v + 1) // refetch now; user keeps serving stale
```

- While the new fetch is pending the computed serves its last value and
  `isPending(user)` is true — exactly as if `id` had changed.
- It composes with transitions for free: the bump is classified like any
  other write, so a bump inside a transition refetches inside that
  transition — the current screen holds, and the result commits with it.
- Include the version in the request's cache key (as in `fetchUser` above)
  so each bump creates exactly one new request.

## Observed lifecycle

```ts
const price = createAtom(0, {
  onObserved: ({ get, set }) => {
    const socket = subscribePrices(set)
    return () => socket.close()
  },
})
```

The callback runs when the atom gains its FIRST subscriber of any kind
(effect, watched computed chain, or React component) and the cleanup runs
when the LAST subscriber of every kind is gone. Subscribe/unsubscribe flaps
within a tick coalesce, so a StrictMode double-mount nets one activation.

## Server rendering

```ts
import { initializeAtomState, installState, serializeAtomState } from "cosignals-arena/ssr"

serializeAtomState([a, b]) // or { name: atom } records
initializeAtomState(json, [a2, b2]) // fresh client atoms
installState(atom, value) // one atom
```

Installing is not a write: no propagation, no equality check, and lazy
initializers do not run — the installed value satisfies the first read.

## Causality tracing

```ts
import { attachTracer } from "cosignals-arena/debug"

const t = attachTracer({ capacity: 4096 })
// ... run your app ...
t.whyLastDelivery(node) // ["#42 deliver", "#41 write \"count\"", ...]
t.events() // ring contents; t.dropped counts evictions
t.stop()
```

Every event carries a causal parent: a re-render chains to the write that
caused it, a fold write chains to the draft retirement, a retirement chains
to the transition's last write. Unrelated operations never chain. Detached
cost is one null check per emit site; the ring never grows past its
capacity and overflow is counted, never silent.

## Ownership and reclamation

- Computeds hold references toward their dependencies only, and join
  subscriber lists only while observed. Dropping the last reference to an
  unobserved computed chain makes the whole chain collectible; a
  `FinalizationRegistry` returns each dropped node's arena record to the
  pool.
- Effects, effect scopes, and subscriptions retain graph edges until their
  returned disposer is called.
- Draft retirement clears rebase logs and per-transition caches (see
  above).
- One arena-specific caveat: a linked dependency's handle is pinned by the
  engine, and a pinned handle retains its compute closure's whole scope
  chain. Build long computed chains through small factory functions (each
  compute's scope containing only its own inputs) rather than one shared
  scope that also holds handles from higher in the chain — the shared-scope
  version keeps the chain reachable from the pin for as long as the engine
  lives. See EXPERIMENT.md's lifetime notes.

Leaks are bugs here, not optimizations.

## Data-oriented design

This package is the data-oriented build of
[cosignals](https://www.npmjs.com/package/cosignals): the same public
contract and test suite, re-implemented so the reactive graph lives in
flat typed arrays instead of linked JS objects.

What that means concretely:

- Every node and dependency edge is a fixed-size record inside one shared
  `Int32Array`; clock readings live in `Float64Array` views over the same
  buffer. A "reference" between records is a numeric id, not an object
  pointer.
- The hot paths — invalidation waves, cache validation, effect drains —
  walk integers through contiguous memory instead of chasing pointers
  through the heap. That is the performance bet: better cache locality,
  fewer allocations, less garbage-collector pressure.
- The public handles (`Atom`, `Computed`) stay ordinary objects, so the
  API feels identical to cosignals; only the engine underneath changes.

What it costs:

- **Harder to understand.** The engine manages its own memory: a record
  pool, free lists, a pin table, and `FinalizationRegistry`-driven
  reclamation replace "let the GC handle it". Reading `src/graph.ts`
  requires holding the record layout in your head.
- **Memory limitations.** The record arena has a fixed capacity
  (2,097,152 records; the backing buffer reserves address space up front
  and the OS commits pages on first touch). Creating signals beyond it
  throws `RangeError: cosignals-arena record arena exhausted` — there is
  deliberately no growth path, because growth would cost the hot paths
  their constant base pointer. A dropped computed's record is reclaimed
  and reused, but the ceiling is real: an app that creates unbounded
  signals will hit it.
- One reclamation caveat: a linked dependency's handle is pinned by the
  engine, and a pinned handle retains its compute closure's whole scope
  chain. Build long computed chains through small factory functions (each
  compute's scope containing only its own inputs) rather than one shared
  scope that also holds handles from higher in the chain.

If you are unsure which package to use, start with
[cosignals](https://www.npmjs.com/package/cosignals) and reach for the
arena when profiling says the graph itself is hot. EXPERIMENT.md records
the design, the optimization rounds, and the measured frontier;
`docs/two-tier-graph.md` covers the watched/unwatched graph mechanics and
`docs/effects.md` the effect subsystem.

# React bindings: `cosignals-arena/react`

Bindings for stock React — no patches, no build flags, no globals.
Requires `react` and `react-dom` 18.2 or later as peer dependencies;
the suite runs against both React 19 and a pinned React 18.2.

## The design premise: React decides what each render sees

Most signal bindings treat React as a display driver: the store changes, the
binding forces components to re-render. That model collapses under
concurrent rendering — React may be preparing several futures at once
(transitions), and a store that changes mid-flight either tears or forces
everything synchronous (`useSyncExternalStore` renders every store change
at sync priority, no matter where the write came from).

These bindings invert the relationship. The engine never decides what a
render pass may see; React does:

- `CosignalsProvider` connects a React subtree to the signals runtime;
  render one at the top of each root. Providers cannot be nested. A
  provider's only state is a list of transition draft ids managed by
  `useReducer`. Its context value is identity-stable, so publishing the
  connection never re-renders consumers.
- A transition write opens an engine draft. The draft id is dispatched from
  inside `React.startTransition` to each root connection and, for each written
  atom, to exactly the subscribers of that atom (and of computeds over
  it), each through its own `useReducer`. The dispatches ride the
  transition's own lanes, so React's update queues — not this library —
  decide which render passes include the draft: urgent passes skip it, the
  transition's passes carry it, interrupted work recomputes it. A
  transition's render passes therefore re-render only the components its
  writes actually touch, not every subscriber in the app.
- Reads resolve against exactly the drafts in the current pass's React
  state. Urgent writes land immediately and pending drafts REPLAY over
  them in dispatch order, which is how a counter at 1 with a pending "+2"
  transition shows 2 after an urgent doubling and settles at 6 — never a
  reorder, never a torn 3.
- Base-state changes travel the SAME channel: the engine notifies a
  subscriber, and the hook dispatches into its own reducer only if
  re-rendering would actually show the committed tree something different
  (a per-subscriber compare — equal resolutions, foreign transitions, and
  already-delivered folds all stay silent). Store changes are never
  escalated to sync priority: subscriptions attach in effects, the gap
  between rendering and attaching is closed by a commit-time repair, and
  a subscription-less `useSyncExternalStore` call supplies only React's
  own pre-commit consistency check.

### Writes re-render with exactly `useState`'s urgency

Because every wake is a reducer dispatch made in the write's own context,
the re-render gets the lane React would give a `setState` from the same
place: synchronous before paint from a click handler, default priority from
a timeout, a promise, or a network callback (it may land after a paint —
wrap the write in `flushSync` when you need the DOM updated immediately,
exactly as for React state), and the owning transition's lanes for drafted
writes. An atom write and a `setState` in the same async callback commit
in ONE render. This deliberately diverges from `useSyncExternalStore`-based
stores, which escalate every store change to sync priority.

A draft retires when every root that received it has committed it; the
engine then folds it into committed state, and passes still holding the id
resolve identical values. Base state is therefore the committed view —
drafts hidden, folds included. With multiple roots it converges at
retirement, so while a transition one root already committed is still held
by another, that root's screen momentarily runs ahead of base state.

Plain `latest(x)` / `isPending(x)` calls in render bodies resolve the
current pass's snapshot through a validity-gated note: the note is written
by the pass that owns it and expires at the end of its synchronous window,
so a pass that did not refresh it (an urgent pass over an untouched
subtree, another root's render, an interleaved flush) falls back to BASE
rather than consuming a stale snapshot or leaking live drafts into an
urgent frame.

Every provider-dependent hook (`useSignal`, `useComputed`, and
`useIsPending`) requires a `CosignalsProvider` above it and throws
without one. The provider is the channel that delivers transitions to its
subtree, so a subscriber outside one cannot see them. `useSignalEffect`
and `useSignalLayoutEffect` observe base state, which needs no root
channel, so they work without a provider — as do the plain function reads
(`latest`, `isPending`).

## Out of scope: DOM-mutation attribution

Bracketing exactly React's own DOM mutation phase per commit (so a
`MutationObserver` client could blind itself to React's mutations while
still catching everyone else's) needs cooperation from inside the
reconciler: stock React exposes no signal at mutation-phase entry or exit,
and anything observable from userland (snapshot lifecycles, layout effects,
the observer's own async records) fires either on the wrong fibers or too
late to disconnect. This package deliberately does not patch React, so it
does not offer a DOM mutation window.

## React API

```tsx
import { createRoot } from "react-dom/client"
import {
  CosignalsProvider,
  useSignal,
  useComputed,
  useSignalEffect,
  useSignalLayoutEffect,
  useIsPending,
  useAtom,
  startSignalTransition,
  useSignalTransition,
} from "cosignals-arena/react"
import { createAtom } from "cosignals-arena"

const count = createAtom(0)

function Counter() {
  const n = useSignal(count) // what this render pass sees
  const pending = useIsPending(count) // newer data behind the screen?
  return (
    <button onClick={() => count.set(n + 1)}>
      {n}
      {pending ? "…" : ""}
    </button>
  )
}

createRoot(container).render(
  <CosignalsProvider>
    <Counter />
  </CosignalsProvider>,
)

startSignalTransition(() => count.update((x) => x * 2)) // draft until commit
```

- `useSignal(x)` — subscribing read; resolves what the current render pass
  sees; suspends by
  handing React the engine's stable pending promise (a transition holds; an
  urgent render with settled history serves stale instead — no fallback
  flash).
- `useComputed(fn, deps)` — component-owned computed.
- `useSignalEffect(() => ({ watch, run, equals?, label? }), deps)` /
  `useSignalLayoutEffect(...)` — the engine effect owned by a component.
  `watch` is the effect's source (compute, signal, tuple, or record);
  `run` is its handler. The factory runs in the hook's React phase on
  mount and on every `deps` change — disposing the previous effect first,
  exactly `useEffect`'s re-create cycle, so captured props are always
  deps-fresh. Signal-triggered re-runs drain in the matching phase of the
  pass the write produced, after its DOM mutations. Because one closure
  carries every capture, `react-hooks/exhaustive-deps` checks the whole
  spec once configured:

  ```jsonc
  "react-hooks/exhaustive-deps": ["error", {
    "additionalHooks": "(useSignalEffect|useSignalLayoutEffect)"
  }]
  ```

  Cleanup honored; StrictMode nets one; base state only — a transition
  reaches it once, at retirement.

- `useIsPending(x)` — the pending probe, delivered urgently (an indicator
  must not be held hostage by the transition it indicates).
- `useAtom(initial, opts?)` — component-owned atom, reclaimed after
  unmount.
- `startSignalTransition(fn)` / `useSignalTransition()` — transition
  batches. Plain `React.startTransition` also works: the first engine write
  inside any transition context is classified into a draft automatically.
- Writing during render throws.
- Multiple roots are supported; one transition can span them, and each
  root's render passes stay internally consistent.

## Performance

The [justjake/js-reactivity-benchmark](https://github.com/justjake/js-reactivity-benchmark)
fork of [milomg/js-reactivity-benchmark](https://github.com/milomg/js-reactivity-benchmark)
uses median-of-N timing, one process per framework, and interleaved rounds to
reduce shared-runner noise. It measures signal creation and propagation without
React.

[![Core signal benchmark totals. Lower is better.](https://raw.githubusercontent.com/justjake/signals-design-space/main/docs/performance/signals-node.png)](https://github.com/justjake/signals-design-space/actions/runs/29652090926)

Raw data: [CSV](https://github.com/justjake/signals-design-space/blob/main/docs/performance/signals-node.csv).
Source: [CI run](https://github.com/justjake/signals-design-space/actions/runs/29652090926).

The [React seam benchmark](https://github.com/justjake/signals-design-space/tree/main/packages/react-seam-bench)
runs fan-out updates, transitions under load, and mount scenarios through each
library's React binding. It uses ReactDOM and jsdom, so the chart measures
JavaScript work without browser layout or paint.

[![React seam benchmark totals. Lower is better.](https://raw.githubusercontent.com/justjake/signals-design-space/main/docs/performance/react.png)](https://github.com/justjake/signals-design-space/actions/runs/29655219049)

Raw data: [CSV](https://github.com/justjake/signals-design-space/blob/main/docs/performance/react.csv).
Source: [CI run](https://github.com/justjake/signals-design-space/actions/runs/29655219049).

Each chart reports the median of three interleaved rounds on a GitHub Actions
x86_64 runner with Node v24.18.0. Compare contenders within one chart; hosted
runner differences below about 5% are noise. Totals combine different workloads
and are not application performance predictions.

## See also

- [cosignals](https://www.npmjs.com/package/cosignals) — the object-graph
  original: the same API and semantics on plain JS objects. Easier to read
  and debug, no arena capacity ceiling. Start there; reach for the arena
  when profiling says the graph itself is hot.
- [dalien-signals](https://www.npmjs.com/package/dalien-signals) — a fork
  of [alien-signals](https://www.npmjs.com/package/alien-signals) with a
  data-oriented memory layout. Probably the fastest signals library for
  JavaScript, but not React-concurrent compatible: it has no equivalent of
  the transition drafts these packages exist for.

## Thanks

- [Sophie Alpert](https://twitter.com/sophiebits) for teaching me about
  React concurrent rendering and why it matters
- [Johnson Chu](https://twitter.com/johnsoncodehk) for
  [alien-signals](https://github.com/stackblitz/alien-signals), the basis
  of the fast linked-list signals graph
- [Ryan Carniato](https://twitter.com/RyanCarniato) and
  [the SolidJS](https://github.com/solidjs) team for
  [SolidJS 2](https://github.com/solidjs/solid), which inspired this
  package's API shape and support for async
- [Milo M](https://twitter.com/milomg__) for
  [reactively](https://github.com/milomg/reactively) and the
  [js-reactivity-benchmark](https://github.com/milomg/js-reactivity-benchmark).
  gotta go fast.
