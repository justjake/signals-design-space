# cosignals internals

This document is for framework integrations, devtools, and engine
development. See the [README](./README.md) for the application API.

It covers the engine architecture and two internal entries:

- `cosignals/unstable` exposes APIs for framework integrations.
- `cosignals/debug` exposes tracing and graph inspection.

## Architecture

The engine is a signal graph with transition state layered on top. The
implementation is split across these modules:

- `src/graph.ts` implements atoms, computeds, effects, and batching. A
  write marks direct subscribers as stale and their descendants as
  possibly stale. It does not recompute them. A later read recomputes
  only if a dependency changed value since the node last validated.

  Nodes use a module-wide change clock as well as flags to detect this.
  Watched nodes belong to subscriber lists. Unwatched computeds validate
  lazily and retain only their dependencies, so unused chains can be
  garbage-collected.
- `src/worlds.ts` implements transition drafts. A transition write adds
  a set or update intent to the atom's rebase log instead of changing the
  atom. A world selects which drafts a reader sees. Resolving an atom
  replays selected draft intents and all urgent intents in dispatch
  order. On commit, the full replay updates the atom through its normal
  write path, including equality checks, propagation, and effects.

  Abandoning a draft discards it and resolves its readers again. The
  engine removes all draft state after the last draft ends.
- `src/signals.ts` implements public handles such as `Atom`, `Computed`,
  `createEffect`, `latest`, and `isPending`. Reads in a selected world
  use `src/worlds.ts`. Other reads and writes use the base graph.
- `src/asyncs.ts` stores async computed state. `use(thenable)` suspends
  an evaluation, and settlement acts like a write. Pending and error
  states live on the graph node.
- `src/react/` implements the React bindings. `host.ts` connects drafts
  and worlds to the React tree. Hooks and `CosignalsProvider` put draft
  ids in `useReducer` state, so React's update queues decide which render
  sees each draft. The bindings do not inspect lanes or patch React.

### How the React bindings attach

The engine does not import React. Importing `cosignals/react` calls the
idempotent `registerReactSignals()` function. The returned handle has a
`dispose()` method that removes the registration.

Registration installs four hooks into the engine:

- The write classifier detects React's current transition and assigns
  writes to its draft.
- The render write guard rejects writes during render.
- The render-world provider identifies the world for the current render.
- The lane pump runs deferred layout and passive effects during React's
  matching commit phases. Without it, the engine uses microtask and timer
  fallbacks.

`cosignals/unstable` exports the render write guard and render-world
provider so another host can replace them. The write classifier and lane
pump are internal.

## `cosignals/unstable`

This entry has no compatibility guarantee. Its exports may change or
disappear without a major version bump. Pin an exact package version if
you depend on it.

### Handles and nodes

- `nodeOf(signal)` returns the `ProducerNode` behind an atom or computed.
  It throws a `TypeError` for values that are not cosignals handles.
  Inspection and integration APIs accept nodes rather than handles.
- `SIGNAL_BRAND` is the `Symbol.for` registry symbol stored on every
  handle. The main entry's `isSignal` function checks this symbol.
  Separate copies of cosignals therefore recognize each other's handles.

### Reading state views

- `ResolvedState` contains the `flags`, `value`, and `throwable` fields
  for a read. Base-state reads return the node itself without allocating.
  World reads return memo records with the same shape.
- `Flag` names the bits stored in a `Flags` word. Consumers should inspect
  only the async bits.
  - `Flag.AsyncMask` selects all async bits.
  - `Flag.AsyncError` means the last evaluation threw. `throwable.error`
    contains the reason.
  - `Flag.AsyncSuspended` means the evaluation awaits a promise.
    `throwable` contains the pending `Suspension`.
- `isUninitialized(value)` tests for the sentinel a node holds before its
  first evaluation, which is distinct from holding `undefined`.
- `isPendingPassive(node, world)` is the node-level probe behind
  `isPending` and `useIsPending`. It returns true when newer data exists
  behind the node's settled value. The `world` argument limits the check
  to one world. Pass `null` for the ambient view. This function never
  evaluates, refetches, or suspends.

### Worlds

- `BASE_WORLD` contains base state and no drafts. `World`, `Draft`, and
  `DraftId` are the transition types. The engine never reuses numeric
  draft ids. Host state can keep an id without retaining its draft.

### Host integration

- `setRenderWriteGuard(fn)` installs a check before every write. The
  function may throw to reject the write. React uses it to forbid writes
  during render. Pass `null` to remove the guard.
- `setRenderWorldProvider(fn)` identifies the world for a render. Pass
  `null` to remove the provider. The function returns one of these values:
  - Draft ids declare the current render's world.
  - `'base'` means a render is active without a valid declaration.
    `latest` and `isPending` then read base state. Falling back to base is
    safer than reading a stale world.
  - `null` means no render is active. Ambient reads use the newest view.

## `cosignals/debug`

This entry contains the APIs used by devtools. Apps that do not import it
do not bundle it. The devtools in this repository import engine state
only through this entry.

The entry has two parts:

- `trace` records what happened and why.
- `inspect` reads current graph state without changing it.

### Tracing

`attachTracer(options?)` starts an in-memory causality trace and returns
the `Tracer`. When detached, each emit site performs one null check. When
attached, the tracer stores up to `capacity` events in a ring buffer. The
default capacity is 4096. On overflow, it removes the oldest event and
increments `dropped`.

```ts
import { attachTracer, nodeOf } from "cosignals/debug"

const t = attachTracer({ capacity: 4096 })
// ... run the app ...
t.whyLastDelivery(nodeOf(count)) // ['#42 notify', '#41 set "count"', ...]
t.events() // retained events, oldest first
t.dropped // events evicted by ring overflow
t.stop() // detach
```

Every event has a causal parent id. A re-render points to its write.
Writes made while retiring a draft point to that retirement. The
retirement points to the transition's last write. Unrelated operations
do not share a chain.

`whyLastDelivery(node)` starts at the node's most recent delivery, walks
the chain backward, and formats each event as text.

`TraceKind` is the union of all event kind strings emitted by the engine.
It includes writes, computation and effect events, async settlement,
React notifications, transition events, and errors. Devtools show these
strings directly. Rename a kind at its emit site rather than translating
it in devtools.

`setTracer(tracer)` installs a custom `TraceSink` instead of the built-in
ring buffer. `setHotTracer` enables a separate high-volume feed for
internal `propagate`, `check`, and `pull` steps. The hot tracer is off by
default.

### Inspection

Inspection uses field reads and linked-list walks. It never calls the
reactive read API. Calling `x.get()` evaluates a stale computed even
inside `untrack`. That advances clocks and emits a `compute` event into
the trace being inspected. Reading the cached field does neither.

Devtools therefore show the last known value and mark it stale. They do
not evaluate a value while inspecting it.

- `nodeOf(signal)` is the same handle-to-node resolver exported by
  `cosignals/unstable`. It is re-exported here so devtools need only one
  entry.
- `inspect(node)` returns an `Inspected` snapshot with the debug `id`,
  `kind`, `label`, last known `value`, initialization state, async
  `status`, pending suspension or error, and staleness state.
  - `kind` is `'atom'`, `'computed'`, `'watcher'`, or `'effect'`.
  - `status` is `'ok'`, `'suspended'`, or `'error'`.
  - `uninitialized` means the node has never evaluated.
  - `stale` means a dependency changed after the node last evaluated, so
    `value` contains the previous result.
- `deps(node)` returns the nodes read by this node. `subs(node)` returns
  the nodes that react when it changes.
- `nodeId(node)` assigns a stable debug id because nodes do not store
  their own ids. `nodeKind` and `nodeStatus` decode the flag bits.
