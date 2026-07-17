# cosignals internals

This document is for integrators and tooling authors: people binding
another framework to the engine, building devtools, or reading the
source. Application authors need none of it — the [README](./README.md)
covers the public API.

It covers the architecture, the `cosignals/unstable` entry (engine
integration seams), and the `cosignals/debug` entry (tracing and
inspection for devtools).

## Architecture

The engine is a conventional signal graph with a small transition
overlay on top. The layers, by module:

- `src/graph.ts` — the base signal graph: atoms, computeds, effects,
  batching. Change moves in two phases: a write pushes "possibly stale"
  marks down the subscriber edges without recomputing anything, and a
  read pulls, recomputing a node only when a dependency actually changed
  value since the node last validated. Staleness is decided by comparing
  readings of a module-wide change clock, not by flags alone. Nodes are
  watched (linked into subscriber lists, reached by push) or unwatched
  (validated lazily on read against the clock); an unwatched computed
  holds references toward its dependencies only, so dropping the last
  user reference makes the chain garbage-collectible.
- `src/worlds.ts` — transition drafts and worlds. A draft is one
  transition batch: a write made inside a transition appends an intent (a
  set-value or an updater function) to the atom's rebase log instead of
  touching the atom. A world is a set of drafts — the answer to "which
  pending batches does this reader include?". An atom's value in a world
  is computed by replaying, in dispatch order, every intent whose draft
  the world includes; urgent intents always replay. When a transition
  commits, its draft retires: the full replay folds into the atom through
  the normal write path (equality check, propagation, effects). When it
  is abandoned, the draft is discarded and its readers re-resolve without
  it. When the last draft dies, all per-draft state is swept — a
  quiescent engine holds no transition state.
- `src/signals.ts` — the handle API (`Atom`, `Computed`, `createEffect`,
  `latest`, `isPending`, ...). This layer only decides which path each
  read and write takes: reads inside a selected world resolve through the
  worlds overlay, everything else goes to the base graph.
- `src/asyncs.ts` — async computed state. `use(thenable)` parks an
  evaluation on a suspension; settlement behaves like a write. Pending
  and error are graph state carried on the node, not control flow.
- `src/react/` — the React bindings. `host.ts` glues drafts and worlds to
  a running React tree; the hooks and `SignalsFrameworkProvider` dispatch
  draft ids into ordinary React state (`useReducer`), so React's own
  update queues decide which render passes see which drafts. The bindings
  never guess at lanes and never patch React.

### How the React bindings attach

The engine knows nothing about React. The bindings install four seams at
registration (importing `cosignals/react` does this automatically;
`registerReactSignals()` is the underlying idempotent call, and the
handle it returns has a `dispose()` that removes the installation):

- a write classifier, which decides whether a write belongs to a
  transition draft (by detecting React's ambient transition context);
- a render write guard, which throws on writes during a render;
- a render-world provider, which answers "what world is the current
  render pass in?";
- a lane pump, which lets mounted providers host the deferred effect
  schedules (`'useLayoutEffect'` / `'useEffect'`) in React's own commit
  phases instead of the built-in microtask and timer fallbacks.

The render write guard and the render-world provider are exported
through `cosignals/unstable`, so a non-React host can install its own
versions; the classifier and lane pump seams are internal.

## `cosignals/unstable`

Integration seams below the public API. No compatibility promise:
anything here may change or disappear in any release, without a major
version bump. Pin an exact version if you depend on this entry.

### Handles and nodes

- `nodeOf(signal)` resolves a public handle (atom or computed) to its
  engine node, a `ProducerNode`. It throws a `TypeError` for anything
  that is not a handle from this library. Nodes are what the inspection
  and integration APIs operate on.
- `SIGNAL_BRAND` is the symbol every handle carries; `isSignal` in the
  main entry tests for it. It is a registry symbol (`Symbol.for`), so two
  copies of the library loaded into one page agree on what counts as a
  signal.

### Reading state views

- `ResolvedState` is the shape of a resolved read: `flags`, `value`, and
  `throwable`. Base-state reads return the node itself as the view (no
  allocation); world resolutions return memo records of the same shape.
- `Flag` names the bits in `flags`. Consumers reading views directly
  should test only the async bits: `Flag.AsyncMask` selects them,
  `Flag.AsyncError` means the last evaluation threw (`throwable` is a
  box whose `.error` is the reason), and `Flag.AsyncSuspended` means it
  parked on a promise (`throwable` is the pending `Suspension`). `Flags`
  is the type of the stored word.
- `isUninitialized(value)` tests for the sentinel a node holds before its
  first evaluation, which is distinct from holding `undefined`.
- `isPendingPassive(node, world)` is the node-level probe behind
  `isPending` and `useIsPending`: true while newer data exists behind the
  node's settled value. The `world` argument scopes the check to one
  world's view; pass `null` for the ambient view. Passive by contract —
  it never evaluates, refetches, or suspends.

### Worlds

- `BASE_WORLD` is the empty world: base state, no drafts. `World`,
  `Draft`, and `DraftId` are the overlay's types. Draft ids are numbers
  that are never reused, so long-lived host state can hold an id without
  retaining the draft record behind it.

### Host seams

- `setRenderWriteGuard(fn)` installs a check that runs before every
  write and may throw to reject it. The React bindings use it to forbid
  writes during a render. Pass `null` to remove it.
- `setRenderWorldProvider(fn)` installs a function answering "what world
  is rendering right now". It returns draft ids (the current render pass
  declared its world), `'base'` (a render is executing but no valid
  declaration exists — plain `latest` and `isPending` calls fall back to
  base state, because wrong-toward-base is safe while reading a stale
  world is not), or `null` (no render is executing, so ambient reads see
  the newest view). Pass `null` to remove it.

## `cosignals/debug`

The observability surface devtools build on. It is not part of the main
entry, so an app that never debugs never bundles it. The devtools in
this repository import only from here, which is the boundary that lets
the engine's internals change freely.

Two halves: `trace` (the event stream — what happened and why) and
`inspect` (current graph state, read without perturbing it).

### Tracing

`attachTracer(options?)` activates a bounded in-memory causality trace
and returns the `Tracer`. Detached cost is one null check per emit site.
Attached, events go into a ring of `capacity` events (default 4096);
overflow evicts the oldest and increments `dropped`, never silently.

```ts
import { attachTracer, nodeOf } from 'cosignals/debug'

const t = attachTracer({ capacity: 4096 })
// ... run the app ...
t.whyLastDelivery(nodeOf(count))  // ['#42 notify', '#41 set "count"', ...]
t.events()                        // retained events, oldest first
t.dropped                         // events evicted by ring overflow
t.stop()                          // detach
```

Every event carries a causal parent id: a re-render chains to the write
that caused it, a retirement fold's writes chain to the retirement, a
retirement chains to the transition's last write. Unrelated operations
never chain. `whyLastDelivery(node)` walks that chain back from the most
recent delivery involving a node and formats it as human-readable lines.

`TraceKind` is the canonical vocabulary: the union of every kind string
the engine emits (writes, compute lifecycle, effect runs, async
settlement, React notifications, transition lifecycle, error kinds). The
engine emits these strings verbatim and devtools should show them
verbatim; renaming a concept means renaming its string at the emit site,
never adding a translation table.

For tooling that needs its own sink instead of the built-in ring:
`setTracer(sink)` installs a custom `TraceSink`, and `setHotTracer`
gates a separate, off-by-default, very-high-volume feed of internal
algorithm steps (`propagate`, `check`, `pull`).

### Inspection

Everything in the inspect half is inert: plain field reads and
pointer-list walks. Nothing calls the reactive read API. That
distinction is load-bearing — `x.get()`, even wrapped in `untrack`,
evaluates a stale computed, advancing clocks and emitting a `compute`
event into the very trace the devtools is observing. Reading the cached
field does not. A devtools therefore shows the last-known value plus a
staleness marker, never a value it forced into existence.

- `nodeOf(signal)` — the same handle-to-node resolver `cosignals/unstable`
  exports, re-exported here so devtools import one entry.
- `inspect(node)` returns an `Inspected` snapshot: debug `id`, `kind`
  (`'atom' | 'computed' | 'watcher' | 'effect'`), `label`, last-known
  `value`, `uninitialized` (never evaluated), `status`
  (`'ok' | 'suspended' | 'error'`), the pending suspension or error box,
  and `stale` (a dependency changed since the node last evaluated, so
  `value` is the previous result).
- `deps(node)` and `subs(node)` walk the dependency edges: what the node
  reads, and what reacts when it changes.
- `nodeId(node)` assigns stable debug ids (nodes carry no id of their
  own); `nodeKind` and `nodeStatus` unpack the flag bits.
