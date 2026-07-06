# cosignal-arena, Variant A: the Log-Overlay design

**Status: complete design spec, ready for implementation review.**

This document specifies `cosignal-arena` — a from-scratch signals library for
TypeScript whose entire hot state lives in flat integer arrays ("arenas"), and
which integrates with concurrent React with no compromises: no
`useSyncExternalStore`, full `startTransition` participation, Suspense parity,
and a small React fork that exposes the render/commit lifecycle to userspace.

It is self-contained. Every concept is defined in plain English before it is
used. The reader is not assumed to know React internals, alien-signals, or any
prior cosignal research. The one external artifact this spec depends on — our
patched build of React — is fully specified in section 6.

Conventions used throughout: TypeScript with stripping-only transforms (so no
`const enum`, no `namespace`), `type` aliases preferred over `interface`,
`undefined` preferred over `null`, pnpm workspaces. All sizes assume V8 on a
64-bit machine.

---

## Table of contents

1. [What cosignal-arena is](#1-what-cosignal-arena-is)
2. [Background: signals, concurrent React, and why stores tear](#2-background)
3. [Vocabulary](#3-vocabulary)
4. [Public API surface](#4-public-api-surface)
5. [Architecture at a glance](#5-architecture-at-a-glance)
6. [The React fork: external-runtime protocol, integer edition](#6-the-react-fork)
7. [Data layout: arenas, records, field tables, byte math](#7-data-layout)
8. [The kernel: mechanisms](#8-the-kernel)
9. [The write log overlay](#9-the-write-log-overlay)
10. [View resolution: read contexts and worlds](#10-view-resolution)
11. [The kernel/policy cut](#11-the-kernelpolicy-cut)
12. [Signal kinds and promise handling](#12-signal-kinds-and-promise-handling)
13. [React bindings](#13-react-bindings)
14. [Growth, reclamation, and memory management](#14-growth-reclamation-and-memory-management)
15. [Constant inlining without const enum](#15-constant-inlining-without-const-enum)
16. [Tracing and debugging](#16-tracing-and-debugging)
17. [Testing plan](#17-testing-plan)
18. [Benchmarks and performance targets](#18-benchmarks-and-performance-targets)
19. [Open risks](#19-open-risks)
20. [Alternatives considered](#20-alternatives-considered)

---

## 1. What cosignal-arena is

A **signal** is a container for a value that remembers who reads it. When the
value changes, everything that depends on it — derived values, effects, React
components — finds out automatically. No manual subscription lists, no
"remember to update X when Y changes."

cosignal-arena is a signals library with two unusual commitments:

1. **Arena data layout.** The dependency graph — which signal feeds which
   computed value, which component watches what — is not built from JavaScript
   objects pointing at each other. It lives in a handful of large
   `Int32Array`s, where each node and each edge is a fixed-size group of
   32-bit integers (a "record") identified by an integer id. This makes graph
   traversal cache-friendly, makes allocation a pointer bump instead of a heap
   allocation, makes most of the library's state invisible to the garbage
   collector, and lets us free thousands of records by resetting one integer.
   The record kernel is a proven quantity: an equivalent core in this repo
   passes all 179 cases of the reactive-framework conformance suite and beats
   alien-signals (the fastest conformant object-based library) on every tier-0
   benchmark shape.

2. **Log-overlay concurrency.** Concurrent React needs to show *two or more
   versions of your state at once* (section 2 explains why). Most designs pay
   for this by versioning every value or maintaining parallel copies of the
   graph. In this design, the canonical engine knows nothing about versions:
   it is a plain, fast, single-world signal engine. Concurrency is an
   **overlay**: each atom that has in-flight concurrent writes gets a small
   **write log** — a receipt tape of recent writes, packed into its own arena
   plane — and reads that care about a specific version resolve their answer
   *through the log*. When React commits, the log is absorbed into the
   canonical world in bulk. When nothing concurrent is happening — which is
   almost always — the canonical fast path pays exactly one "is the log
   empty?" branch, and pure non-React users never pay even that.

The headline bet: **versioning is an exceptional condition, so its cost should
be proportional to how much of it is happening, not to the size of your
state.** Abandoning a speculative batch is truncating a log. Committing one is
replaying a short tape. A quiet app is a zero-length tape.

---

## 2. Background

### 2.1 Signals in one page

Three primitives:

- An **atom** holds a plain value you can read and write (`count.state`,
  `count.set(5)`).
- A **computed** holds a function over other signals (`new Computed({fn: () =>
  a.state + b.state})`). Reading it returns the function's result. The library
  records which signals the function actually read — its **dependencies** —
  and caches the result until one of them changes. Dependencies are discovered
  *by running the function*, so they can change from run to run (read a
  different branch, get different dependencies).
- An **effect** is a function the library re-runs for you whenever any signal
  it read last time changes. In this library, React components are a special
  kind of effect ("watcher"), and `useSignalEffect` is the user-facing effect
  for React apps.

Two disciplines make this fast:

- **Push then pull.** A write does not eagerly recompute everything
  downstream. It cheaply marks downstream nodes "possibly stale" (push). Only
  when someone actually reads a possibly-stale computed does the library walk
  its dependencies to check whether anything truly changed (pull), recomputing
  the minimum necessary. Unread computeds cost nothing.
- **Equality cutoff.** If a computed re-runs and produces an equal value, the
  things that depend on *it* are not re-run. Change stops propagating at the
  first place it stops mattering.

This algorithm family (alien-signals' push-pull with exact re-verification) is
what our kernel implements; the conformance suite in section 17 pins its exact
semantics, including the subtle parts (re-entrant writes, dynamic dependency
trimming, exact pull counts).

### 2.2 What concurrent React does

Modern React does not always render your update immediately and synchronously.
Two features matter here:

- **Transitions** (`startTransition`, `useTransition`): updates marked as
  transitions render *in the background*. React builds a new tree for the
  future state while the screen keeps showing the current state. Urgent
  updates (typing, clicking) can happen *during* that background render; React
  will render the urgent update first — **without** the transition's changes —
  and finish the transition later. So at one moment there are two live
  "versions of the world": the committed one on screen (possibly updated
  urgently), and the pending transition one being prepared.
- **Yielding and replay.** A background render is time-sliced: React pauses it
  to keep the page responsive and resumes later. It can also throw a partially
  built tree away and restart. Therefore any code that runs during rendering
  must be pure (no side effects), and any data it reads must return *the same
  answer for the whole pass*, even if the outside world moved on while the
  render was paused. A render that reads value A at the start and value B
  after resuming produces a torn, internally inconsistent frame — this is
  called **tearing**.

React's own state (`useState`, `useReducer`) handles all of this because a
setState call does not overwrite anything: it appends an **update** to a
per-hook queue, tagged with a **lane** (React's internal priority/batch
label). A render for a given set of lanes applies exactly the queued updates
in those lanes and skips the rest ("rebasing"). Commit folds applied updates
into the hook's memoized state. React's queues are, precisely, small
multi-version write logs. Our design copies this shape — that is what the
write log in section 9 is.

### 2.3 Why external stores tear, and what the fork fixes

State living outside React (any signals library) has a single current value.
React's escape hatch, `useSyncExternalStore`, forces consistency by brute
force: every store change schedules *synchronous* re-rendering, and any store
write that lands during a concurrent render makes React throw away the work
and re-render synchronously. External state can never ride in a transition.
That is the de-opt this project exists to eliminate.

The userspace strategy (validated by the React team's own
`react-concurrent-store` experiment and by our previous-generation design) is:

- Signal writes notify subscribed components by calling their `setState`
  **synchronously, in the writer's call stack**, so React assigns those
  re-renders the same lane as everything else in that event or transition.
  Batching, priorities, async-action entanglement, and infinite-loop
  protection are all inherited from React for free.
- The store keeps enough recent history (the write log) that a render can be
  answered *for the specific version of the world it is rendering*.

Three facts are impossible to observe from userspace, and are exactly what our
React fork exposes (section 6):

1. **Which batch does a write issued right now belong to** — so a store write
   can be tagged with the same "version of the world" as the setState calls it
   travels with.
2. **Which batches does the currently-running render include** — so a read
   during render resolves against the right version (this is what fixes the
   "component mounts in the middle of a transition" bug that
   react-concurrent-store could not fix from userspace).
3. **When does a batch retire** (commit or get pruned) — so pending log
   entries can be folded into canonical state at the right moment, exactly
   once.

Plus one unrelated nicety (also from the fork): a bracket around the window
where React mutates the DOM, so a `MutationObserver` can ignore React's own
mutations. Section 6.5.

---

## 3. Vocabulary

Terms defined once, used everywhere. Plain-English first.

| Term | Meaning |
| --- | --- |
| **arena** | A large, pre-allocated `Int32Array` treated as an array of fixed-size records. Allocating a record = advancing a bump pointer or popping a free list. |
| **plane** | One arena serving one record family. This design has two: the **main plane** `M` (graph nodes and links, stride 8) and the **log plane** `G` (write-log entries, stride 4). |
| **record** | A fixed-size run of 32-bit slots inside a plane. Referenced by an **id**. |
| **id** | An integer naming a record. Ids are *pre-multiplied byte-offsets-in-elements*: id = recordIndex × stride, so field access is `M[id + FIELD]` with no multiply. Id 0 is burned as "none" (the null id). |
| **node** | A graph participant: atom, computed, effect, scope, or watcher. One main-plane record each. |
| **link** | One dependency edge ("this consumer read that producer"), member of two intrusive doubly-linked lists at once (the consumer's dependency list and the producer's subscriber list). One main-plane record each. |
| **atom** | A writable signal (`Atom`, `ReducerAtom`, and the hook-owned variants). |
| **computed** | A derived, cached, lazily-evaluated signal. |
| **watcher** | A node representing one mounted React hook subscription. Like an effect, but its notification runs synchronously in the writer's stack (to inherit React's lane) instead of queuing for the effect flush. |
| **kernel** | The mechanism layer: pure integer/graph algorithms over the planes plus one packed value column. It never interprets user values beyond identity comparison and never chooses policy (section 11). |
| **policy layer** | Everything above the kernel: Atom/ReducerAtom/Computed semantics, custom equality, reducers, promise handling, React bindings, tracing. |
| **batch** | A set of updates React renders and retires as a unit — everything scheduled in one event, or one transition. Named across the fork boundary by a **batch token**. |
| **batch token** | A nonzero 31-bit integer minted by the fork's batch registry, stable for the batch's life, never reused while live. Bit 0 encodes "deferred". Section 6.2. |
| **deferred batch** | A transition-like batch: its render does not block paint and it commits later. Writes in deferred batches are the ones that *must* be logged. |
| **batch slot** | The engine's own small index (0–31) interned for a live batch token, so log records can store a 5-bit slot instead of a full token, and a render pass's included batches become one 32-bit mask. |
| **write log / log** | Per-atom singly-linked chain of log records in the log plane: the atom's recent writes, each tagged with operation, batch slot, and sequence tickets. Empty for almost every atom almost all the time. |
| **base record** | The first record of every log: a synthetic entry holding the atom's value from the moment the log was created. Replays start from it. |
| **seq / ticket** | A number from one global take-a-number counter, stamped on every log record at append time. Gives every logged write a position on one shared timeline. |
| **retirement** | The moment a batch leaves React's books — its commit, or the close of a batch that never produced React work. Delivered exactly once per token by the fork. |
| **absorption** | Folding a retired batch's log entries into canonical kernel state: replay visible entries in seq order, write the result through the kernel (which propagates staleness and queues effects). |
| **truncation** | Discarding log entries without absorbing them (speculation abort, optimistic rollback, devtools). |
| **canonical world (W0)** | The world the kernel's values describe: all committed state, plus urgent writes that were applied directly (section 9.4). The only world the kernel knows. |
| **pass world (Wp)** | The world one render pass must see: determined by its **pin** and **include mask**. |
| **newest world (Wn)** | Every write visible, pending or not. What reads outside render see. |
| **pin** | The seq-counter value captured when a render pass starts. The pass may not see anything that happened after its pin, even if it yields and resumes. |
| **include mask** | The 32-bit batch-slot mask of the batches a render pass includes (from the fork's `includedBatches`). |
| **overlay mark** | A per-node stamp meaning "some atom below me currently has a log". Nodes without the mark can answer any world from the kernel cache. Cleared for the whole graph in O(1) by bumping an era counter. |
| **overlay era** | The generation counter for overlay marks. Bumped when the last log empties. |
| **quiescence** | The state of having no live logs, no live batches, and no open render pass. The overlay resets itself to zero cost at quiescence. |
| **handle** | The user-facing object (`Atom`, `Computed`, …) wrapping a node id. Handles are ordinary objects; the arena records behind them are reclaimed when handles are garbage-collected or deterministically disposed. |

---

## 4. Public API surface

Package name `cosignal`; subpath exports `cosignal/react`, `cosignal/tracing`,
`cosignal/graphviz`. The core (`cosignal`) has zero React imports.

### 4.1 Atoms

```ts
type AtomCtx<T> = {
  /** Read current value without registering a dependency. */
  peek(): T
  set(next: T): void
  update(fn: (current: T) => T): void
}

type AtomOptions<T> = {
  state: T
  /**
   * If set, runs when the atom becomes observed (first watcher, effect, or
   * transitively-watched computed), and the returned cleanup runs when it is
   * no longer observed. Intended for remote subscriptions. Delivery is
   * debounced to a microtask so an observe/unobserve flap in one tick does
   * not thrash the remote end.
   */
  effect?: (ctx: AtomCtx<T>) => (() => void) | void
  /** Custom equality; Object.is otherwise. Equal writes are dropped. */
  isEqual?: (a: T, b: T) => boolean
  /** Debug-tools name. */
  label?: string
}

class Atom<T> {
  constructor(options: AtomOptions<T>)
  /** Read. Auto-tracks inside computeds/effects; resolves per read context. */
  get state(): T
  set(next: T): void                       // like setState(value)
  update(fn: (current: T) => T): void      // like setState(fn) — fn is stored
                                           // and replayed per world, so it
                                           // must be pure
}
```

### 4.2 Reducer atoms

```ts
type ReducerAtomOptions<S, A> = {
  state: S
  reducer: (state: S, action: A) => S      // pure; replayed per world
  isEqual?: (a: S, b: S) => boolean
  label?: string
}

class ReducerAtom<S, A> {
  constructor(options: ReducerAtomOptions<S, A>)
  get state(): S
  dispatch(action: A): void
}
```

`dispatch` stores the *action* in the write log, not a computed value, and
replays it through the reducer once per world that includes it — exactly what
React does with `useReducer` updates. A conformance test dispatches identical
action streams through a `ReducerAtom` and a real `useReducer` across a
held-open transition with urgent interleaving and asserts the committed values
match at every step.

### 4.3 Computeds

```ts
type ComputedCtx<T> = {
  /**
   * Suspense integration: give it a promise/thenable; if pending, this
   * computed enters the "suspended" state (readers suspend or observe
   * pending); once settled, the computed re-evaluates and `use` returns the
   * value or throws the rejection. Thenable identity is cached positionally
   * per world, so re-evaluations see stable promises (the same protocol
   * React's `use` expects).
   */
  use<U>(thenable: PromiseLike<U>): U
  /** Previous cached value, if any (for incremental computeds). */
  previous: T | undefined
}

type ComputedOptions<T> = {
  fn: (ctx: ComputedCtx<T>) => T
  isEqual?: (a: T, b: T) => boolean
  label?: string
}

class Computed<T> {
  constructor(options: ComputedOptions<T>)
  get state(): T    // may throw (cached error) or suspend (React read sites)
}
```

Evaluation never throws *through the graph*: a throwing `fn` or a pending
`ctx.use` becomes a cached error/suspended state on the node; read sites
rethrow or suspend. This fixes the class of bugs where an exception mid-walk
corrupts staleness flags.

### 4.4 Core auxiliaries (non-React)

```ts
/** Synchronous reactive effect for non-React consumers (and the benchmark
 * adapter). Returns a disposer. `fn` may return a cleanup. */
function effect(fn: () => void | (() => void)): () => void
/** Groups child effects for bulk disposal. */
function effectScope(fn: () => void): () => void
/** Coalesce writes: effects flush once at the end. Nestable. */
function batch<T>(fn: () => T): T
/** Read without registering a dependency. */
function untracked<T>(fn: () => T): T
/** Library-wide switches, set once at startup. */
function configure(options: {
  /** Writes to atoms inside computed evaluation throw immediately.
   * Default false: such writes are allowed unless they create a cycle
   * (cycles always throw). */
  forbidWritesInComputeds?: boolean
  /** Initial main-plane record count (default 8192) and log-plane record
   * count (default 1024); both grow by doubling. */
  initialRecords?: number
  initialLogRecords?: number
}): void
```

### 4.5 React bindings (`cosignal/react`)

```ts
/** Subscribe this component to a signal; returns its value for the current
 * render's world. Concurrent-safe: no useSyncExternalStore. Suspends if the
 * signal is a suspended computed. */
function useSignal<T>(signal: Atom<T> | ReducerAtom<T, any> | Computed<T>): T

/** Component-owned atom; like useState but the value is a signal usable by
 * computeds anywhere. Created on mount, disposed on unmount. */
function useAtom<T>(options: AtomOptions<T>): Atom<T>

/** Component-owned reducer atom; like useReducer. */
function useReducerAtom<S, A>(options: ReducerAtomOptions<S, A>): ReducerAtom<S, A>

/** Like useMemo, but re-renders the component when a signal read inside `fn`
 * changes. `fn` may close over props/state freely — that is what `deps` is
 * for; signal reads are auto-tracked and are NOT listed in deps. */
function useComputed<T>(
  fn: () => T,
  deps: unknown[],
  options?: { isEqual?: (a: T, b: T) => boolean; label?: string },
): T

/** Like useEffect, but also re-runs when a tracked signal's committed value
 * changes. Cleanup supported. Observes committed state only. */
function useSignalEffect(fn: () => void | (() => void), deps?: unknown[]): void

/** Optional helpers: identical semantics to React's startTransition /
 * useTransition, plus the engine batches signal broadcasts in the scope so a
 * multi-write transition triggers one setState per watcher instead of many. */
function startSignalTransition(scope: () => void): void
function useSignalTransition(): [isPending: boolean, start: (scope: () => void) => void]
```

There is **no required provider component**. The bindings register with the
fork's global registry once, at module load; multiple React roots work because
every callback carries the root's container.

Writes need no special API inside transitions: `startTransition(() => {
atom.set(x); setReactState(y) })` moves both in lockstep, because the write
asks the fork "what batch am I in?" at write time.

### 4.6 Tracing (`cosignal/tracing`, lazy) and Graphviz (`cosignal/graphviz`)

Specified in section 16. Loading `cosignal/tracing` installs a tracer into the
core's single null-checked slot; not loading it costs one `tracer !== null`
check per traced site. `cosignal/graphviz` renders DOT source for the live
dependency graph and for causal trace timelines, and imports only *types* from
tracing.

### 4.7 Explicitly supported situations

- Multiple React roots, including batches spanning roots.
- Writes from inside computeds (cycle-guarded; can be globally forbidden).
- Server-side rendering + hydration from serialized atom state (section 13.8).
- React StrictMode double-rendering and render replays (render reads are pure;
  pass-local memoization tolerates replays).
- Infinite-update-loop rejection: every component re-render flows through
  `setState`, so React's own nested-update and render-loop limits apply to
  signal storms; pure signal→signal cycles are caught by the engine's own
  cycle checks.

---

## 5. Architecture at a glance

Three layers, two gates.

```
┌────────────────────────────────────────────────────────────────────┐
│ POLICY: cosignal/react bindings                                    │
│   hooks, watcher broadcast, batch-token interning, pins,           │
│   retirement → absorption orchestration, SSR                       │
├────────────────────────────────────────────────────────────────────┤
│ POLICY: signal kinds                                               │
│   Atom / ReducerAtom / Computed classes, isEqual, reducers,        │
│   ctx.use (suspense), error containment, observed-lifecycle        │
├────────────────────────────────────────────────────────────────────┤
│ OVERLAY (mechanism): the write log                                 │
│   log plane G, seq tickets, batch slots, overlay marks,            │
│   visibility resolution, absorption/truncation primitives          │
├────────────────────────────────────────────────────────────────────┤
│ KERNEL (mechanism): canonical arena engine                         │
│   main plane M, link/unlink, propagate/checkDirty, effect queue,   │
│   identity-compare update, growth, reclamation                     │
└────────────────────────────────────────────────────────────────────┘
```

The two gates that keep the fast path fast:

- **Write gate** — one module-scalar comparison. `writeMode` is `DIRECT`
  until the React bindings mount their first watcher, then `LOGGED`. In
  DIRECT mode a write is exactly the proven kernel write: compare, set
  pending value, propagate staleness, flush effects. Pure-core users and the
  benchmark never execute a single overlay instruction.
- **Read gate** — one branch per read. For atoms it is folded into the flags
  word the read loads anyway (`FLAG_LOGGED`); for computeds it is
  `overlayLive !== 0 && M[c + OVERLAY_STAMP] === overlayEra` — when the
  overlay is quiescent, the first scalar comparison short-circuits. This is
  the "log empty?" branch of the design brief, and it is the *only* overlay
  cost the canonical engine ever pays while quiescent.

Life of a write, end to end, in LOGGED mode:

1. `atom.set(x)` — policy checks `isEqual(newest-visible value, x)`; equal
   writes stop here.
2. Ask the fork: `isCurrentWriteDeferred()`, `getCurrentWriteBatch()` (an
   integer token). Intern the token to a batch slot (0–31).
3. Append a log record to the atom's log (creating the log, with its base
   record, if empty): operation, batch slot, payload, seq ticket. If the
   write is urgent (not deferred), *also* apply it through the kernel
   immediately and mark the record APPLIED (section 9.4).
4. Walk the atom's subscribers once, stamping **overlay marks** ("a log
   exists below me") down the graph, stopping at already-stamped nodes.
5. Kernel propagation (for applied writes) queues core effects and collects
   **watchers** — React subscriptions — onto a broadcast list; the write call
   drains it synchronously before returning, calling each watcher's
   `setState` in the writer's stack so React lanes are inherited.
6. React renders whatever it decides to render. Each render pass tells us its
   root, pin, and included batches; reads during the pass resolve through the
   logs (section 10).
7. React retires the batch (commit or close). We stamp the batch's log
   entries retired, **absorb**: replay each touched atom's visible entries in
   seq order and write the fold through the kernel inside one kernel batch —
   canonical values, staleness, and core effects all update at once.
8. When the last open render pass unpins, logs are swept: retired entries
   fold into base records, empty logs are freed, and at full quiescence the
   log plane's bump pointer resets to zero, the seq counter restarts, and the
   overlay era bumps (clearing every mark in O(1)).

Speculation never touches canonical state, so aborting speculation is
deleting log entries — truncation — plus discarding a pass-local memo table.
Nothing to un-propagate, no shadow graph to reconcile.

---

## 6. The React fork

We maintain a fork of React (a submodule + build script; see 6.6) whose only
substantive addition is a small, renderer-agnostic introspection channel
called the **external runtime**. This spec revises the channel's protocol to
be **integer-oriented**: batch identities cross the boundary as plain
integers rather than objects, which lets the engine stamp them straight into
`Int32Array` log records with no interning `Map` on the write path.

Design constraints, in order:

1. **React-concurrency-safe.** The protocol must describe batches and passes
   truthfully across lane recycling, yielding, restarts, multi-root commits,
   and async actions. Everything here is *edge-triggered from the places the
   reconciler already mutates its own bookkeeping* — never sampled — so it
   cannot drift from reality.
2. **Minimal and encapsulating.** No Fiber objects, no lane bitmasks, no
   reconciler types cross the boundary. Tokens are serially-numbered
   integers, uncorrelated with lane bit positions. Roots are identified by
   their *container* (for react-dom, the DOM element you rendered into) — an
   identity that is meaningful to userspace anyway.
3. **Inert when unused.** Every hook site is one null/flag check when nothing
   has subscribed. The additions carry no feature flag; they simply do
   nothing without a listener.

### 6.1 The isomorphic API (exports from `react`)

```ts
type Container = unknown  // e.g. the DOM element passed to createRoot

type ExternalRuntimeListener = {
  /** A render pass began on `container`. `includedBatches` are the tokens of
   * every live batch this pass renders. A pass spans yields; it ends by
   * completing or being discarded/restarted. */
  onRenderPassStart?: (container: Container, includedBatches: readonly number[]) => void
  /** The pass on `container` completed or was discarded. Exactly one end per
   * start, even across restarts. */
  onRenderPassEnd?: (container: Container) => void
  /** A batch retired — exactly once per token, ever. `committed` is false
   * only for batches that never produced React work (external-only writes);
   * batches whose React updates died with unmounted trees still retire
   * through an ordinary (possibly empty) commit with committed = true. */
  onBatchRetired?: (token: number, committed: boolean) => void
  /** DOM mutation window; see 6.5. */
  onBeforeMutation?: (container: Container) => void
  onAfterMutation?: (container: Container) => void
}

function unstable_subscribeToExternalRuntime(l: ExternalRuntimeListener): () => void

/** Would a write issued right now belong to a deferred (transition-like)
 * batch? Pure classification: no minting, no allocation. */
function unstable_isCurrentWriteDeferred(): boolean

/** The token of the batch a write issued right now belongs to, minting it on
 * first use. 0 when no renderer is loaded. */
function unstable_getCurrentWriteBatch(): number

/** undefined outside render; the rendering root's container during render.
 * (The signals engine uses "am I inside render?" and "which root?" — nothing
 * else leaks.) */
function unstable_getRenderContext(): { container: Container } | undefined
```

Renderers (react-dom, test renderers) register a provider on the shared
internals object at module init, following React's existing
`ReactSharedInternals` slot pattern; the isomorphic functions above delegate
to it. With multiple renderers loaded simultaneously, write attribution
answers from the first registered provider (documented limitation — only one
renderer processes an event at a time in practice).

### 6.2 Batch tokens: integer protocol

A **batch token** names "a set of updates React renders and retires as a
unit". Why not expose React's lane bits directly? Lane bits are *recycled*
(the transition lane cursor wraps after a handful of claims), so a bit cannot
name a batch across time; and lane bits are exactly the reconciler internal
we refuse to leak. Tokens are identities.

Encoding:

- `token = (serial << 1) | (deferred ? 1 : 0)`, where `serial` starts at 1
  and increments per minted token. Tokens are nonzero 31-bit integers — they
  are Smis in V8, they fit in an `Int32Array` slot, and bit 0 answers "is
  this transition-like?" without a lookup.
- `0` means "no token" everywhere.
- Serials are never reused while any token is live. At the 2^30 wrap
  (unreachable in practice: one serial per *event or transition that touches
  external state*, and section 9.7's quiescence renumbering is irrelevant
  here because tokens don't persist), the registry skips serials still held
  by its ≤31 live slots.

**Liveness invariant: at most 31 tokens are live at once** — one per lane
slot. If React reuses a lane bit while the registry still holds a pending
token for it, React itself cannot tell the two batches apart (they render and
retire together), so the registry reuses the existing token: an explicit
merge that mirrors reality. This invariant is what lets the engine intern
tokens into a fixed table of 32 batch slots (section 9.2).

Registry edges (each wired into a place the reconciler already touches):

- **claim** — a transition claims a lane for the current event
  (`requestTransitionLane`); slot noted, no allocation.
- **mint** — first `unstable_getCurrentWriteBatch()` call for the slot
  creates the token. Writes that never ask cost nothing.
- **pending** — `markRootUpdated`: the batch has scheduled work on a root;
  the slot records the root. A repair pass (**backfill**) runs in the root
  scheduler's microtask to catch updates scheduled *before* the batch's first
  store write (ordinary `startTransition(() => { setState(x); atom.set(y) })`
  line order).
- **finish** — after `markRootFinished` in commit: a batch is done on a root
  when its lane is no longer pending there. The token retires when its *last*
  pending root finishes. If a root commits the batch while other roots are
  still pending, that root is recorded in the slot's committed set: later
  renders on it must keep including the batch (its committed tree already
  shows those values — hiding them would tear the root against its own DOM).
  `batchTokensForRender` folds these locked-in tokens into
  `includedBatches`.
- **close** — end of the event's scheduling microtask: a batch that produced
  no React work anywhere retires now with `committed = false` — with one
  exception: a store-only transition whose scope returned a promise (an
  **async action**) parks on that promise and re-runs the close decision when
  it settles, because the action's post-await updates commit later and
  retiring early would leak its writes into canonical state mid-action.

These edges and their exact reconciler call sites were built and
reconciler-test-suite-validated in the previous-generation fork; this design
inherits them wholesale and changes only the token representation
(object → integer). The per-edge cost with no live tokens is an integer/null
check.

### 6.3 Render passes

`onRenderPassStart(container, includedBatches)` fires when React prepares a
fresh work-in-progress stack for a root with real work;
`onRenderPassEnd(container)` fires when that pass completes or is discarded.
Yields do **not** end a pass: a pass paused for time-slicing and resumed
later is one pass, which is exactly why the engine pins the seq counter at
pass start (reads must not move for the pass's whole life). A restart
(fresh stack) ends the old pass and starts a new one, re-delivering
`includedBatches` — the new pass may legitimately see newer state.

`includedBatches` contains the live tokens for the pass's render lanes plus
the committed-elsewhere lock-ins from 6.2. Tokens whose batches carry no
external writes are simply unknown to the engine and ignored.

React renders one pass at a time on a thread; passes on different roots never
interleave *execution* (switching roots restarts). The engine may therefore
keep a single "current pass" scalar set.

### 6.4 Write classification

`unstable_isCurrentWriteDeferred()` answers "if setState were called right
now, would it be a transition-like update?" — it is the same decision
`requestUpdateLane` makes, exposed as a boolean. The engine calls it on every
logged write *before* deciding whether to also apply the write directly
(section 9.4); it must therefore be pure and allocation-free, and it is: a
couple of comparisons against the reconciler's current-transition state.

### 6.5 The DOM mutation window

Unrelated to signals, delivered on the same channel because it is the same
kind of lifecycle fact: `onBeforeMutation(container)` /
`onAfterMutation(container)` bracket exactly the window in which React
mutates the host tree during a commit, so an application `MutationObserver`
can disconnect around React's own writes and observe everything else. The
signals library itself never references MutationObserver.

Precision notes (inherited from the validated fork): the brackets live in the
mutation-effects flush, not in `commitRoot`, because with View Transitions
the mutation phase runs later, inside the browser's `startViewTransition`
update callback; the bracket fires only when mutations will actually occur,
and covers every commit path including `flushSync`. Scope is React's
*reconciliation* mutations. Documented exclusions callers must filter
themselves: the layout-phase `<img src>` re-assignment, suspensey-CSS
`<link>` insertion, imperative Float APIs (`preload`/`preinit`), View
Transition name attributes, and DOM writes from user effect code.

### 6.6 Patch surface and maintenance

Files touched (small, additive, no behavioral change to React):

- `packages/react/src/ReactExternalRuntime.js` — new isomorphic module:
  listener set, provider slot on `ReactSharedInternals`, emit helpers
  (listener errors are reported like uncaught errors, never thrown into the
  commit), the four query/subscribe exports.
- `packages/react-reconciler/src/ReactFiberExternalRuntime.js` — new: the
  notify entry points the work loop calls; pairs pass start/end exactly via
  a per-root active-pass set.
- `packages/react-reconciler/src/ReactFiberBatchRegistry.js` — new: the
  31-slot token registry and its five edges (6.2).
- `ReactFiberWorkLoop.js` — calls into the two modules at: prepare fresh
  stack, render-pass completion, commit (finish edge, mutation window),
  scheduling-microtask close.
- `packages/react/index.js` + `ReactClient.js` — re-exports.

Everything is unconditional (no feature flag) but inert until a listener
subscribes: cost is one property-read-and-branch per hook site. Built via
`scripts/build-react.sh` into `build/oss-experimental/*` and linked into the
workspace with pnpm overrides; rebuilding does not require reinstalling.

Version-skew rule: the bindings feature-detect
`unstable_subscribeToExternalRuntime`. On stock React the bindings refuse to
enable concurrent mode and throw with a clear message at first hook use
(building a silent degraded mode is explicitly out of scope — parity is the
product).

---

## 7. Data layout

### 7.1 Layout principles (each one measured, not aesthetic)

- **Record interleaving, not parallel columns.** A record's fields live
  contiguously (one cache line, one bounds-check domain). Naive
  one-array-per-field SoA measured 1.8× *worse* than objects on deep chains;
  interleaved records beat objects everywhere.
- **Nodes and links share one plane.** A single base register and bump
  pointer for both record families measured −2% deep / −8% diamond versus
  split planes, because traversals alternate node/link loads.
- **Log records get their own plane** — not for style: they have a different
  stride (4 vs 8), a bulk-reset lifecycle (the whole plane empties at
  quiescence, so a resetting bump pointer beats free-list hygiene), and
  keeping speculative traffic out of the main plane preserves the main
  plane's locality.
- **One packed `unknown[]` value column.** Type-segregated columns
  (Float64Array + tag) measured worse than a single packed array of tagged
  values. Never make the value column holey; grow it by `push(undefined)`.
- **Buffers are closure constants.** TurboFan embeds the base address of a
  buffer bound by `const` in an enclosing closure. Growth = rebuild the
  engine closure over doubled buffers at an operation boundary (section 14).
  Segment tables, resizable ArrayBuffers, mutable bindings, per-function
  aliases: all measured and rejected (+26% to +83% per access).
- **Ids are pre-multiplied.** An id is `recordIndex * stride`, so field
  access is one add and one indexed load, no shift/multiply. Id 0 is burned
  (record 0 permanently unused) so "no id" is `0` and every existence check
  is `!== 0` on an integer.

### 7.2 The main plane `M` (Int32Array, stride 8, 32 bytes/record)

Two record families interleave freely: **nodes** and **links**.

**Node record.** Fields +0..+5 are universal; +6/+7 are kind-specific.

| offset | name | meaning |
| --- | --- | --- |
| +0 | `FLAGS` | state machine + kind bits (table below) |
| +1 | `DEPS` | first link of my dependency list; free-list next when freed |
| +2 | `DEPS_TAIL` | last *confirmed* dependency link (re-run cursor) |
| +3 | `SUBS` | first link of my subscriber list |
| +4 | `SUBS_TAIL` | last subscriber link |
| +5 | `GEN` | generation counter, bumped on free; stale disposers no-op |
| +6 | atoms: `LOG_HEAD` — first log record id in plane G, 0 = no log. computeds / effects / watchers: `OVERLAY_STAMP` — overlay-marked iff equal to the global `overlayEra` |
| +7 | atoms: `LOG_TAIL` — last log record id. computeds: `MEMO_STAMP` — the world-stamp for the side memo slot (section 10.5). effects/watchers: reserved (0) |

**Link record** (one dependency edge, member of two doubly-linked lists):

| offset | name | meaning |
| --- | --- | --- |
| +0 | `VERSION` | evaluation-cycle stamp: intra-run duplicate-read dedup |
| +1 | `DEP` | producer node id |
| +2 | `SUB` | consumer node id |
| +3 | `PREV_SUB` / +4 `NEXT_SUB` | position in the producer's subscriber list |
| +5 | `PREV_DEP` / +6 `NEXT_DEP` | position in the consumer's dependency list; `NEXT_DEP` doubles as free-list next when freed |
| +7 | reserved (0) | |

**Flags word** (all in `M[id + FLAGS]`, so kind dispatch and state checks are
one 4-byte load):

| bit | name | meaning |
| --- | --- | --- |
| 1 | `MUTABLE` | can produce new values (atoms, computeds) |
| 2 | `WATCHING` | wants notification when possibly stale (effects, watchers) |
| 4 | `RECURSED_CHECK` | currently evaluating (re-entrancy guard) |
| 8 | `RECURSED` | re-entrant write reached me during my own run |
| 16 | `DIRTY` | definitely stale |
| 32 | `PENDING` | possibly stale — verify by pulling before recomputing |
| 64 | `HAS_CHILD_EFFECT` | my dep list contains child effects/scopes (slow-path cleanup) |
| 128 | `LOGGED` | atoms only: `LOG_HEAD !== 0`. The read gate. |
| 256 | `IMMEDIATE` | watchers only: notify synchronously via the broadcast list instead of the effect queue |
| 512 | `LIVE` | transitively watched by some effect/watcher (liveness split; drives the atom observed-lifecycle and lets policy skip dead regions) |
| 1024 | `K_ATOM`, 2048 `K_COMPUTED`, 4096 `K_EFFECT`, 8192 `K_SCOPE`, 16384 `K_WATCHER` | kind bits; `KIND_MASK` = their union. A freed record has FLAGS 0. |

### 7.3 The log plane `G` (Int32Array, stride 4, 16 bytes/record)

One record per logged write, plus one **base record** per live log.

| offset | name | meaning |
| --- | --- | --- |
| +0 | `NEXT` | next entry in this atom's log (append order = seq order); 0 = tail; free-list next when freed |
| +1 | `META` | packed: bits 0–1 `OP` (0 = BASE, 1 = SET, 2 = UPDATE, 3 = DISPATCH); bit 2 `APPLIED` (already written through the kernel — urgent writes, section 9.4); bit 3 `RETIRED`; bits 4–8 `BATCH_SLOT` (5 bits, 32 slots); bits 9–30 reserved |
| +2 | `SEQ` | take-a-number ticket at append time |
| +3 | `RETIRED_SEQ` | 0 while the batch is pending; a fresh ticket stamped at retirement |

### 7.4 Side columns (plain JS arrays, indexed off ids)

GC-visible state that cannot live in an Int32Array. All are packed arrays
grown by pushing `undefined`; none is ever made holey.

| column | index | slots/record | holds |
| --- | --- | --- | --- |
| `values` | `id >> 2` (+ 1) | 2 | slot 0: atom canonical value / computed cached value. slot 1: atom kernel pending value / effect cleanup fn |
| `fns` | `id >> 3` | 1 | computed wrapper function / effect function / watcher broadcast function |
| `passVals` | `id >> 3` | 1 | computeds: overlay memo value (valid iff `MEMO_STAMP` matches; section 10.5) |
| `meta` | `id >> 3` | 1 | policy metadata object, only for nodes that need one: `{ label?, isEqual?, reducer?, observeEffect?, liveCount, lastBroadcast, thenableCache?, finalizerToken? }`. `undefined` for plain nodes. |
| `logVals` | `gid >> 2` | 1 | log-entry payload: SET value / UPDATE fn / DISPATCH action / BASE snapshot value |

The index arithmetic works because ids are pre-multiplied: main-plane
`id = record*8`, so `id >> 2 = record*2` (two value slots) and
`id >> 3 = record` (one slot); log-plane `gid = record*4`, so
`gid >> 2 = record`.

### 7.5 Small fixed tables and module scalars

- `batchToken: Int32Array(32)` — slot → live token (0 = free slot).
- `batchEntryCount: Int32Array(32)` — live (unswept) log entries per slot;
  a slot recycles when its token retired *and* its count reaches 0.
- Scalars: `liveSlotMask`, `liveDeferredMask` (uint32 bitmasks of live /
  live-deferred slots), `unappliedEntries` (count of not-yet-applied entries
  program-wide), `loggedAtomCount`, `seqCounter`, `overlayEra`, `logEpoch`
  (bumped on any log append/absorb/truncate), `writeMode` (DIRECT/LOGGED),
  and the pass set: `passOpen`, `passSerial`, `passPin`, `passIncludeMask`,
  `passContainer`.
- `loggedAtoms: number[]` — ids of atoms with live logs (absorption and
  sweep iterate this; append on first log entry, compact on sweep).
- Persistent traversal scratch: `propStack`, `checkStack` (Int32Array,
  doubling, with base save/restore so re-entrant walks unwind to their own
  base — these replace the per-propagation cons-cell allocations that cost
  the object-based competitor ~1.5 ms of GC per deep-chain benchmark run).

### 7.6 Byte math

Per-entity steady-state costs (V8 64-bit; object sizes measured on Node 24):

| entity | cosignal-arena | alien-signals objects |
| --- | --- | --- |
| dependency edge | **32 B** arena, GC-invisible, zero write barriers | 80 B heap (24 B header + 7 tagged fields), 4–6 write barriers per splice |
| atom | 32 B record + 2 value slots (~16 B) + handle object ~48 B ≈ **96 B** | ~120 B (node + bound function) |
| computed | 32 B + 2 slots + wrapper closure + handle ≈ **~160 B** | ~246 B |
| effect | 32 B + slots + closure ≈ **~120 B** + its links | ~331 B + links |
| log entry | **16 B** record + 1 payload slot (~8 B); freed in bulk | n/a (no equivalent) |
| watcher | 32 B + broadcast closure ≈ **~100 B** | n/a |

Plane sizing: default main plane 8192 records = **256 KiB** (an app with
2,000 signals, 1,000 computeds, and 20,000 edges uses ~23,000 records =
736 KiB after two doublings); default log plane 1024 records = **16 KiB**.
Growth doubles a plane; the number of growth events over a program's life is
logarithmic. The main-plane watermark keeps ≥1280 records of slack at every
operation boundary so no single flush cascade can exhaust the plane mid-walk.

Address-space ceiling: ids are positive 31-bit ints and pre-multiplied by 8,
so the main plane tops out at 2^31/8 = 268M records (8.6 GB) — not a real
constraint.

---

## 8. The kernel

The kernel is the canonical single-world engine: alien-signals v3.2.1
semantics, transliterated onto the record layout, plus five overlay-support
mechanisms. Its contract: **all functions take integers, touch only the
planes, the scratch stacks, and the side columns; user code is invoked only
through the `fns` column at defined points; user values are only ever
compared by identity (`!==`).** That keeps every kernel function
monomorphic — one hidden class per argument, no polymorphic dispatch, no
type-feedback pollution from user data.

The kernel is a proven artifact: this section describes the engine at
`libs/arena/src/index.ts` in this repo (179/179 conformance, exact pull
counts, all tier-0 shapes at or below alien-signals' times), with the
overlay-support additions called out explicitly in 8.7.

### 8.1 State machine

`DIRTY` means definitely stale, `PENDING` means possibly stale. A write marks
direct subscribers and their transitive consumers `PENDING` (cheap push,
stops at already-marked nodes); the first subscriber level gets `DIRTY` via
`shallowPropagate` when a value *confirmed* changed. A read of a `PENDING`
computed runs `checkDirty`: an iterative walk down its dependency list **in
recorded order** (the discipline that makes verification sound under dynamic
dependencies), recomputing a dependency only when it is `MUTABLE|DIRTY`, and
upgrading sibling `PENDING` subscribers to `DIRTY` when a recompute really
changed the value. Nothing changed → clear `PENDING` and skip the recompute
(early cutoff, "exact pull counts").

`RECURSED_CHECK`/`RECURSED` implement re-entrancy: a write that reaches the
currently-evaluating node, or a read of a node mid-evaluation, is either
tolerated (re-run scheduled) or detected as a cycle and thrown — this is the
machinery that lets us *allow* writes-inside-computeds per the requirements
while still rejecting true cycles. Deleting it is a known false optimization
(an upstream experiment removed it, passed alien's own tests, and was caught
by Vue's suite).

### 8.2 Topology maintenance

- `link(dep, sub, version)`: called on every tracked read. Fast path: the
  consumer's re-run cursor (`DEPS_TAIL`) already points at (or just before) a
  link for this dep — stamp its version and advance, zero allocation. Stable
  graphs hit this 100%. The insertion tail (`linkInsert`) is **kept
  out-of-line deliberately**: the monolithic function measured 475 bytecodes
  — over V8's 460 default inline budget (`kExceedsBytecodeLimit`) — so the
  hottest helper in the library was never inlined into read paths. Split, the
  fast path is 168 bytecodes and inlines; measured −8% deep / −10% broad /
  −13% diamond. This split is a load-bearing constraint on future edits, not
  a style choice.
- `unlink(link)`: O(1) removal from both intrusive lists; when a producer's
  subscriber list empties, the kernel calls `unwatched(dep)` (8.5).
- After an evaluation, `purgeDeps(sub)` trims links after the cursor —
  dependencies not re-read this run.

### 8.3 Traversals

`propagate` (push) and `checkDirty` (pull verification) are iterative, using
the persistent scratch stacks with saved bases (user getters can re-enter the
kernel; the inner walk must unwind to its own base). `propagate` runs no user
code (notification only queues), so it needs no try/finally; `checkDirty`
restores its stack base in `finally` because `update` runs user getters.

### 8.4 Scheduling

Effects queue into a flat array; `notify(effect)` walks the parent-effect
chain and reverses the inserted segment so outer effects run before inner.
`flush()` drains the queue with per-effect re-checking, error containment,
and re-arm-on-abort. Writes outside an explicit `batch()` flush before
returning. Growth and reclamation work runs only *before* the flush loop, at
a true operation boundary ("boundary-lite" — audited: cascade re-runs
allocate ~tens of records, far under the 1280-record watermark).

### 8.5 Kind dispatch and the unwatched path

The flags word carries kind bits, so "is this a computed?" is a bit test on
the load the caller already did. `update(node)` dispatches: computeds re-run
their `fns` entry and compare old/new by identity (the policy layer makes
identity-compare correct for custom equality — section 11.2); atoms move
pending→current. `unwatched(node)`: computeds go dormant (marked
DIRTY+deps-dropped, lazily re-evaluated if ever read again); effects/scopes
dispose.

### 8.6 Liveness (`LIVE` bit)

Effects and watchers are born `LIVE`. When `linkInsert` attaches a LIVE
consumer to a non-LIVE producer, the producer becomes LIVE and the bit flows
down its own dependency list (iterative walk); when `unlink` removes the last
LIVE subscriber, the bit is cleared the same way. Liveness transitions on
atoms that carry an `observeEffect` in their meta fire the policy
observed-lifecycle hook (section 12.4). The walk runs only when the liveness
boundary actually moves — steady-state reads and writes never touch it.

### 8.7 Overlay-support mechanisms (the five kernel additions)

1. **Broadcast list.** `propagate`'s notify step checks the `IMMEDIATE` bit:
   immediate watchers go to a separate `broadcastQueue` instead of the effect
   queue. The public write wrapper drains it synchronously before returning —
   still inside the writer's event/transition context, so React lane
   assignment is inherited — calling each watcher's `fns` entry. Keeping user
   code out of the propagation walk itself preserves the no-try/finally
   invariant.
2. **Overlay mark walk.** `markOverlay(subsLink)`: stamp `OVERLAY_STAMP =
   overlayEra` on every node reachable through subscriber edges, stopping at
   already-stamped nodes. Pure integer walk reusing `propStack`. Called by
   the overlay on the first log append per atom per era.
3. **Mark repair on new edges.** In `linkInsert` (the out-of-line slow path —
   zero cost on the cursor-hit fast path): if the overlay is live and the new
   producer is marked (or is a LOGGED atom), stamp the consumer and its
   subscribers. This maintains the mark invariant — *every node reachable
   via subscriber edges from a logged atom is stamped* — when a canonical
   re-evaluation picks up a brand-new dependency mid-era.
4. **`invalidate(id)`.** Set `DIRTY`, propagate to subscribers, queue
   notifications. Used by absorption (when a fold changes a value the kernel
   never saw as a pending write) and by promise settlement.
5. **Log-plane allocation.** Bump pointer + free list over plane G, and the
   O(1) chain-splice free (a swept log chain is already linked; freeing it is
   `tail.NEXT = freeHead; freeHead = head`). The kernel owns log record
   *memory*; it never interprets log *contents* beyond the integer fields.

### 8.8 Kernel invariants (checked by debug assertions)

- Record 0 of each plane is never allocated.
- A record is on exactly one of: live graph, free list, `pendingFree`.
- `DEPS_TAIL` always points into the node's own dep list; cursor never
  crosses `purgeDeps` boundaries.
- The effect queue never holds a freed id (deferred reclamation sweeps only
  when the queue is empty; `GEN` defuses stale disposers).
- Scratch stack pointers return to their saved bases on every exit path.
- No kernel function allocates a JS object. (The only allocations are
  Int32Array doubling and side-column pushes, both at boundaries.)
- While quiescent (`loggedAtomCount === 0`): no node's `OVERLAY_STAMP`
  equals `overlayEra`, plane G's bump pointer is 0, and `seqCounter` is 1.

---

## 9. The write log overlay

The overlay gives every atom that needs one a **receipt tape**: an
append-only (until swept) chain of log records describing recent writes, from
which the value *as of any world* can be reconstructed. This section covers
the tape's lifecycle; section 10 covers how reads use it.

### 9.1 When logging happens at all

`writeMode` is `DIRECT` until the React bindings mount their first watcher
(watcher count 0→1), and returns to `DIRECT` when the last watcher unmounts
and the overlay is quiescent. In DIRECT mode, writes are pure kernel — this
is the benchmark path and the non-React path, and it executes zero overlay
instructions.

In `LOGGED` mode, **every write is logged**. This mirrors React exactly: a
`setState` always enqueues an update object; our log record is that update,
externalized into an arena (and cheaper to allocate). Trying to be cleverer —
skipping the log for urgent writes when "nothing could tell the difference" —
is unsound: a later `flushSync` render in the same event legitimately renders
*without* the default-priority batch, and only a log entry lets that render
reconstruct the older value. We take the always-log rule and make the log
entry cheap instead: ~6 Int32 stores plus one side-array store.

### 9.2 Batch slot interning

Log records need to name their batch in 5 bits. On each logged write:

1. `token = unstable_getCurrentWriteBatch()` (mints lazily inside React).
2. Look up the slot: a one-entry cache (`lastToken/lastSlot`) catches the
   common run of writes in one batch; otherwise scan `batchToken[0..31]`
   (at most 31 live tokens exist — fork invariant 6.2 — so a linear scan of
   an Int32Array(32) is a handful of nanoseconds).
3. Miss → claim a free slot (`batchToken[slot] = token`, set bit in
   `liveSlotMask`, and in `liveDeferredMask` if `token & 1`).

A slot is released (token zeroed, masks cleared) when its batch has retired
*and* its `batchEntryCount` reaches zero (all entries swept). Because retired
entries stop consulting their slot (their visibility runs on `RETIRED_SEQ`),
slot recycling can never mis-attribute an old record.

If all 32 slots are somehow occupied (cannot happen from React's ≤31 live
tokens; defensive), the engine falls back to treating the write as belonging
to an always-included pseudo-batch and emits a trace warning — correctness
degrades toward "urgent" for that write rather than crashing.

### 9.3 Appending a log record

`appendLog(atom, op, payload, applied)`:

```
if LOG_HEAD == 0:                          // first entry: create the tape
    base = allocLog()
    G[base+META] = OP_BASE | RETIRED
    G[base+SEQ] = ticket()                 // seq of log creation
    G[base+RETIRED_SEQ] = G[base+SEQ]      // visible to any pass pinned later
    logVals[base>>2] = values[atom>>2]     // snapshot canonical value
    LOG_HEAD = LOG_TAIL = base
    FLAGS |= LOGGED; loggedAtoms.push(atom); loggedAtomCount++
    markOverlay(M[atom+SUBS])              // stamp the downstream region
rec = allocLog()
G[rec+META] = op | (slot << 4) | (applied ? APPLIED : 0)
G[rec+SEQ] = ticket()                      // one global counter, ++ per append
G[rec+RETIRED_SEQ] = 0
logVals[rec>>2] = payload
G[LOG_TAIL+NEXT] = rec; LOG_TAIL = rec
batchEntryCount[slot]++; if (!applied) unappliedEntries++
logEpoch++
```

The base record is what makes the tape self-contained: every replay starts
from `logVals[base]`, so the atom's canonical value can keep moving (via
absorption) without corrupting the history older passes still need.

**Same-batch coalescing** (bounds tape growth for hot atoms during long
transitions): if the tail entry belongs to the same batch, is unretired, and
*no render pass is currently open* (an open pass may be pinned between the
two writes), then a new SET replaces the tail record's payload and seq
in place, and a new UPDATE/DISPATCH may compose onto a tail UPDATE/DISPATCH
of the same batch (function composition is input-independent, so composing is
always sound; composition allocates one closure and is applied only after the
tape for that batch exceeds a small threshold, default 8 entries). With
coalescing, per-atom tape length is O(live batches) between passes.

### 9.4 Applied versus unapplied entries

- A **deferred** write (transition-like, `token & 1`) is *log-only*: the
  kernel's canonical value, staleness flags, and effects are untouched. Its
  existence is visible only through overlay marks and to readers whose world
  includes its batch.
- An **urgent** write is logged *and applied*: the same call performs the
  normal kernel write (pending value, propagate, queue effects, collect
  broadcasts) and sets `APPLIED` on the record. This keeps the canonical
  world "committed plus urgent-pending" (the definition of W0), which is what
  non-render readers and core effects should see with zero replay work, and
  it means absorption of an urgent batch is usually a no-op fold.

Consequence: the kernel's value for a logged atom always equals the fold of
its base record plus all APPLIED and all RETIRED-committed entries, in seq
order. This is the **W0 invariant**; absorption maintains it.

### 9.5 Retirement and absorption

When the fork reports `onBatchRetired(token, committed)`:

1. Resolve the slot; stamp `RETIRED` + `RETIRED_SEQ = ticket()` on every
   entry of that batch, by iterating `loggedAtoms` and walking each tape
   (tapes are short; this is O(total live log entries), at commit frequency).
   The same walk performs absorption:
2. **Absorb**, per touched atom, inside one kernel `batch()`:
   - Recompute the W0 fold: replay from the base record, applying every
     entry that is RETIRED (any batch) or APPLIED-pending, in seq order.
     SET replaces the accumulator; UPDATE applies the stored function;
     DISPATCH applies the atom's reducer to the stored action. Updaters run
     once per world that includes them and must be pure — same contract as
     React updater functions.
   - If the fold differs from the kernel's current value (policy equality,
     section 11.2), write it through the kernel (`invalidate` + value set),
     which propagates staleness and queues core effects and
     `useSignalEffect` watchers.
   - Entries retired with `committed = false` (store-only batches that never
     made React work, including settled async actions) fold identically —
     the writes are real; the flag is recorded for tracing only.
3. End the kernel batch → one effect flush for the whole absorption.
4. Decrement `unappliedEntries` for each formerly-unapplied entry; release
   batch slots per 9.2; then attempt a sweep (9.6).

Replay ordering across batches is what produces React-parity rebasing: an
older transition's SET can never clobber a newer urgent SET, because the
urgent entry has a later seq and replays after it — worked example in 10.7.

### 9.6 Sweeping and truncation

An entry is **dead** once no possible reader can distinguish its presence:
it is RETIRED, and its `RETIRED_SEQ` is at or below every open pass's pin
(no pass is pinned before it), and it is not needed as replay input for a
still-pending entry earlier in the tape. The sweep (run at pass end,
retirement, and operation boundaries):

- folds each atom's leading run of dead entries into the base record
  (`logVals[base] = fold; G[base+SEQ] = lastFolded.RETIRED_SEQ`), splicing
  the freed run onto the log free list in O(1);
- if the tape is just the base record and no live batch could still write
  (its batches all retired): free the tape entirely, clear
  `LOG_HEAD/LOG_TAIL` and the `LOGGED` flag, decrement `loggedAtomCount`,
  and remove the atom from `loggedAtoms`.

**Truncation** is the abort primitive: `truncateBatch(slot)` unlinks every
entry of a batch from every tape *without folding*, fixing up chains and
counts. Nothing else is needed to abandon speculation, because speculative
writes never touched canonical state. Exposed to policy for optimistic-update
rollback APIs and used by devtools; React batches themselves never truncate
(React always retires them).

### 9.7 Quiescence: the bulk reset

When `loggedAtomCount` reaches 0 with no open pass and no live slots:

- plane G's bump pointer resets to 0 and its free list empties — the entire
  log arena is reclaimed with two integer stores;
- `overlayEra++` — every overlay mark in the graph becomes stale in O(1),
  with no walk;
- `seqCounter` resets to 1 — pins and retire stamps from the previous era are
  all dead, so tickets can restart, making 31-bit overflow unreachable in
  practice (an era would need 2^31 logged writes with no quiescent moment).

This is the payoff of keeping speculation in its own plane: the common
lifecycle — interaction, transition, commit, quiet — ends with the overlay at
literally zero residue.

---

## 10. View resolution

### 10.1 Read contexts

Every read resolves in one of four contexts. The context is a module scalar,
not a parameter — reads stay zero-argument bound calls.

| context | active when | world |
| --- | --- | --- |
| `RENDER` | between `onRenderPassStart` and `onRenderPassEnd` | Wp: pin + include mask |
| `NEWEST` | default: event handlers, core effects, benchmarks, computed evaluation outside render | Wn: everything visible |
| `COMMITTED` | inside `useSignalEffect` callbacks (and SSR) | retired entries only |
| kernel-internal | inside `checkDirty`/`update` walks | W0 by construction (the kernel only ever sees applied state) |

### 10.2 The visibility rule

For a pass with pin `P` and include mask `I`, a log entry `e` is **visible**
iff either:

1. **It retired before the pass started:** `e.RETIRED` is set and
   `e.RETIRED_SEQ <= P`; or
2. **The pass includes its batch and the write predates the pass:**
   `I` has bit `e.BATCH_SLOT` and `e.SEQ <= P`.

Each clause mirrors a rule React applies to its own hook queues: clause 2 is
the lane filter (a transition render applies transition updates and skips
urgent ones, and vice versa); the `<= P` conditions mirror React's rule that
updates arriving during a render are hidden from it and picked up by the
next one. Clause 1 keying on *retire time* rather than write time is what
keeps a paused-and-resumed pass stable: if another root commits (and folds)
while this pass is yielded, the fold's stamp exceeds this pass's pin, so this
pass keeps reading what it started with.

`NEWEST` visibility: every entry. `COMMITTED` visibility: `RETIRED` entries
only (regardless of stamps; APPLIED-but-pending entries are *excluded*, which
is what makes `useSignalEffect` observe only committed worlds).

### 10.3 Resolving an atom read

```
readAtom(a):
  flags = M[a+FLAGS]
  if (flags & LOGGED) == 0: return kernelRead(a)      // the fast path
  head = M[a+LOG_HEAD]
  // shortcut: if every entry is visible and every visible entry is APPLIED
  // or absorbed, the kernel value IS the answer (common for urgent-only
  // activity): one pass over META words, no payload touched.
  if allVisibleAndApplied(head, ctx): return kernelRead(a)
  acc = logVals[head>>2]                               // base snapshot
  for rec in chain(head):
    if visible(rec, ctx):
      acc = apply(rec, acc)     // SET: payload; UPDATE: fn(acc);
                                // DISPATCH: reducer(acc, action)
  return acc
```

If no entry beyond the base is visible (a pass pinned before the tape
existed, after an absorption moved the canonical value), the answer is the
base snapshot — *not* the kernel value. That is the tear-prevention case.

Tracking: in `NEWEST`/`COMMITTED` contexts, tracked reads link normally
(`link(a, activeSub, cycle)`). In `RENDER` context, component-level reads run
untracked (subscription is a commit-time concern, section 13.2), and
overlay-world computed evaluations are untracked too (10.5) — so **render
never mutates graph topology**, which is what makes discarded/replayed
renders free of side effects.

### 10.4 Overlay marks: the computed fast path

A computed whose transitive inputs have no live logs cannot differ between
worlds, so any context may take the kernel path (normal `checkDirty` +
cached value). The overlay mark (stamped by 9.3, repaired by 8.7.3, cleared
by era bump) is a conservative "may differ" bit:

```
readComputed(c, ctx):
  if loggedAtomCount == 0 or M[c+OVERLAY_STAMP] != overlayEra:
      return kernelComputedRead(c)                     // the fast path
  if ctx == NEWEST and unappliedEntries == 0:
      return kernelComputedRead(c)   // Wn == W0 when nothing is unapplied
  return overlayEvaluate(c, ctx)
```

Marks over-approximate (a marked computed might still be world-identical);
the cost of a false positive is one overlay evaluation, not wrong answers.

### 10.5 Overlay evaluation and the pass memo

`overlayEvaluate(c, ctx)` re-runs the computed's function with reads
resolving in `ctx`, **untracked** (canonical dependency lists must reflect
canonical evaluation only — a speculative world may take different branches,
and letting it re-track would corrupt the canonical graph's topology for
everyone). Results are memoized per world:

- The memo value lives in `passVals[c >> 3]`; validity is
  `M[c + MEMO_STAMP] === worldStamp`.
- `worldStamp` encodes the world: during a pass, `(passSerial << 1) | 1`
  (each pass start bumps `passSerial`, and a pass's world cannot change
  mid-pass by the pin rule, so one stamp per pass suffices); outside a pass,
  `(logEpoch << 1)` (the newest world changes whenever any tape changes, so
  the memo key is the tape epoch).

So within one render pass, each marked computed evaluates at most once no
matter how many components read it; across passes, evaluation re-runs
(matching React, which re-renders those components anyway). Because renders
are read-only, discarding a pass discards nothing but these memo stamps —
that, plus log truncation, is the entirety of "abort" in this design.

Suspense inside overlay evaluation uses the per-world thenable cache
(section 12.3) so promise identity is stable across replays of the same
world.

Nested overlay evaluation (a marked computed reading another marked
computed) recurses with the same context and hits the inner memo — depth
equals graph depth exactly as in the kernel.

### 10.6 Broadcast worlds (why watchers don't over-notify)

When a logged write propagates (applied) or appends (deferred), watchers
subscribed to affected nodes must decide whether to `setState`. The rule: a
watcher broadcasts iff its watched node's value **in the writer's world**
(base + retired + entries of the writing batch) differs — by the node's
equality policy — from the last value it broadcast (or rendered) for that
world, memoized in the watcher's meta. Cost: one overlay evaluation on the
writer's world at write time — work the imminent render would do anyway,
and it prevents render storms for equal-value writes (graph-level cutoff,
matching the kernel's own cutoff semantics).

For unmarked nodes (no overlay), the kernel's ordinary cutoff already
guarantees notify fires only on real change; the watcher broadcasts
unconditionally.

### 10.7 Worked example: the rebase walkthrough

State: `a = 1` (atom). A transition writes `a.update(x => x + 1)`; while it
is pending, an urgent click writes `a.update(x => x * 2)`.

Tape after both writes (base seq 10):

| record | op | batch | seq | applied | retired |
| --- | --- | --- | --- | --- | --- |
| base | BASE `1` | — | 10 | — | yes (at 10) |
| e1 | UPDATE `x+1` | T (deferred) | 11 | no | no |
| e2 | UPDATE `x*2` | U (urgent) | 12 | yes | no |

Kernel value (W0) = base + applied = `1*2 = 2`.

- **Urgent render** (includes U, not T; pin 13): visible = base, e2 →
  `1*2 = 2`. The click's doubling shows; the transition stays invisible.
  React commits; U retires; e2 stamps RETIRED_SEQ 14. Absorption fold =
  base + retired(e2) + applied() = `2` — unchanged, no-op.
- **Transition render** (includes T; pin 15): visible = base,
  e1 (clause 2), e2 (clause 1, retired at 14 ≤ 15) → replay in seq order:
  `(1 + 1) * 2 = 4`. The transition lands *on top of* the urgent change.
- T retires: fold = `(1+1)*2 = 4`; kernel value moves 2 → 4 via
  `invalidate`; effects observe committed 4. Sweep folds everything into the
  base; tape frees; quiescence resets the overlay.

`4` is exactly what two queued `useState` updaters produce in React — the
side-by-side `ReducerAtom`-vs-`useReducer` conformance test (17.3) pins this
equivalence across held-open transitions.

### 10.8 Purity of render worlds

Writes during `RENDER` context throw, unconditionally (React may replay or
discard the pass; a write from a replayed render would double-fire). This is
independent of `configure({ forbidWritesInComputeds })`, which governs
canonical evaluation contexts only.

---

## 11. The kernel/policy cut

The precise line between mechanism (kernel + overlay memory) and policy
(everything users can configure). The test for every future feature: *if it
inspects a user value, a user option, or React, it is policy; if it is
integer math over the planes, it is mechanism.*

### 11.1 The cut, operation by operation

| operation | mechanism (kernel/overlay) | policy (kinds/React layer) |
| --- | --- | --- |
| create | record allocation, flags init | handle construction, meta allocation, wrapper synthesis |
| tracked read | `link` cursor/splice, flags checks | read-context selection, log replay payload application |
| write | pending-value slot, `propagate`, broadcast/effect queues | equality short-circuit, log append decision, deferred/urgent classification |
| recompute | `checkDirty` walk, `update` call, `!==` compare, `shallowPropagate` | what "evaluate" means: ctx, isEqual, error/suspense capture (all inside the stored wrapper fn) |
| notify | queue discipline, outer-before-inner order, IMMEDIATE routing | watcher broadcast rule (world evaluation + cutoff + setState) |
| log lifecycle | record packing, chains, slots, seq tickets, visibility *mask* math, sweep/truncate splicing | replaying payloads (SET/UPDATE/DISPATCH semantics), absorption equality, when to absorb (retirement orchestration) |
| liveness | LIVE bit maintenance | observed-lifecycle effect delivery, debouncing |
| memory | bump/free/growth/reclaim, generation counters | FinalizationRegistry wiring for handles, configure() sizing |

Two non-obvious choices make this cut clean and fast:

### 11.2 Custom equality without a kernel branch: return the old reference

The kernel compares recompute results by identity (`old !== new`). Custom
equality never touches the kernel: the computed's stored function is a
**wrapper** (synthesized by the policy layer at construction) that receives
the previous value and — when `isEqual(prev, next)` holds — **returns the
previous reference**. The kernel's identity compare then correctly reports
"unchanged". The same trick serves error and suspense states (11.3): the
wrapper returns the *same* box object while the state is unchanged.

Atoms: `isEqual` runs in `Atom.set`/`update`/`dispatch` before anything is
logged or written (compare against the newest-world value), and again at
absorption when deciding whether the fold moved the committed value. The
kernel's own `!==` on the pending-value slot stays as a second, free line of
defense.

Result: zero policy bits in kernel flags, zero extra kernel branches, and the
kernel's hot loops stay monomorphic. Plain computeds (no options) get a
minimal wrapper; the wrapper layer costs one extra call frame per actual
recomputation — recomputations run user code anyway, so the relative cost is
noise (validated in the shapes harness before committing to this cut;
see 18.2).

### 11.3 Sentinel boxes

Computed evaluation outcomes are values, never control flow through the
graph:

```ts
type ErrorBox = { kind: 'error'; error: unknown }
type SuspendedBox = { kind: 'suspended'; thenable: PromiseLike<unknown> }
```

The wrapper catches throws and pending `ctx.use` thenables and returns a box;
the box is cached like any value (and reference-stable while the state is
unchanged, per 11.2). Policy read sites unbox: `Computed.state` rethrows
errors; React read sites suspend on `SuspendedBox` via React's `use`
(section 13.2); core effects treat a box read as an error to surface. Flags
can never be corrupted by a throwing getter because the kernel never sees the
throw. Boxes are policy vocabulary — the kernel treats them as opaque values.

---

## 12. Signal kinds and promise handling

How the three public kinds sit above the kernel. Each kind is: a handle
class, a meta record (only if it has options), and rules for the three policy
sites (write, replay, recompute).

### 12.1 Atom

- `set(v)` → equality gate → DIRECT: kernel write. LOGGED: append SET
  (+ apply if urgent).
- `update(fn)` → the *function* is the payload (never pre-evaluated in LOGGED
  mode): worlds replay it against their own accumulator, which is how
  functional updates rebase (10.7). In DIRECT mode it evaluates immediately
  (no worlds exist to disagree).
- Reads resolve per context (10.3).

### 12.2 ReducerAtom

Identical machinery to Atom with `dispatch(action)` appending DISPATCH
records; replay applies `meta.reducer(acc, action)`. The reducer is fixed at
construction, so replays are deterministic given the tape — the property the
useReducer-parity test (17.3) verifies. `dispatch` in DIRECT mode applies the
reducer immediately and kernel-writes the result.

### 12.3 Computed and `ctx.use` (suspense parity)

The wrapper synthesized for a computed:

```
wrapper(prev):
  ctx = enter(computedId)            // reused ctx object in meta
  try:    next = userFn(ctx)
  catch e: return sameOrNewErrorBox(prev, e)
  finally: exit()
  if suspendedDuring(ctx): return sameOrNewSuspendedBox(prev, ctx.thenable)
  if prev !== undefined && isEqual(prev, next): return prev
  return next
```

`ctx.use(thenable)` follows React's thenable protocol: it stamps
`status/value/reason` onto the thenable via `then` handlers (first
encounter), then:

- fulfilled → return the value; rejected → throw the reason (becomes an
  ErrorBox); pending → record it on the ctx and abort evaluation of the rest
  of the function body by throwing an internal marker the wrapper catches
  (same shape as React's suspend-on-use).
- **Positional identity cache, per world:** the meta holds
  `thenableCache: Map<worldKey, PromiseLike<unknown>[]>` where `worldKey` is
  0 for canonical evaluation or the batch token for pass-world evaluation.
  The N-th `ctx.use` call in a given world always returns the same thenable
  across re-evaluations of that world — this is what makes suspend/replay
  converge instead of re-fetching forever. World entries are dropped when
  their batch retires; the canonical entry is dropped when the computed
  settles to a non-suspended value.
- **Settlement wake-up:** when a thenable that suspended the *canonical*
  evaluation settles, the policy layer calls kernel `invalidate(c)` in a
  microtask (if the computed still caches that SuspendedBox): watchers
  re-render, effects re-run, the wrapper re-evaluates and now sees the
  settled status. Pass-world suspensions need no engine action: React's own
  `use` machinery re-renders the pass when the promise settles, and the
  re-render re-evaluates through the same per-world cache.

### 12.4 Atom observed-lifecycle (`options.effect`)

Driven by the kernel LIVE bit (8.6): when an atom with an `observeEffect`
transitions not-LIVE → LIVE, schedule `effect(ctx)` on a microtask; LIVE →
not-LIVE schedules the returned cleanup. The microtask debounce means an
observe/unobserve flap within one tick (e.g. React strict-mode double-mount,
list reordering) nets to no remote-subscription churn. `ctx` gives
`peek/set/update`; writes from inside the effect are ordinary writes.

### 12.5 Writes inside computeds

Allowed in canonical contexts by default. The kernel's
`RECURSED_CHECK`/`RECURSED` machinery detects propagation reaching the
currently-evaluating node (or a read of a mid-evaluation node) and throws a
cycle error; acyclic in-computed writes re-run affected consumers after the
current evaluation finishes (effect flush is deferred while evaluation is on
the stack). `configure({ forbidWritesInComputeds: true })` makes any
in-computed write throw at the write site. Render-world evaluation always
rejects writes (10.8).

---

## 13. React bindings

All bindings share one module-level singleton: the **bridge**. At first
import it subscribes to the external runtime (6.1) and wires four callbacks:

- `onRenderPassStart(container, tokens)` → `passOpen = 1; passSerial++;
  passPin = seqCounter; passIncludeMask = internAll(tokens);
  passContainer = container` — and switch the read context to `RENDER`.
- `onRenderPassEnd(container)` → close the pass, restore `NEWEST`, run a
  sweep (9.6).
- `onBatchRetired(token, committed)` → retirement + absorption (9.5), then
  flush `useSignalEffect` watchers in a microtask.
- `onBeforeMutation`/`onAfterMutation` → re-emitted verbatim on
  `cosignal/react`'s own tiny event surface for app code (MutationObserver
  users); the signals engine ignores them.

### 13.1 The watcher protocol

A mounted `useSignal`/`useComputed` owns one **watcher node** (kind
`K_WATCHER`, flags `WATCHING|IMMEDIATE|LIVE`). Its `fns` entry is the
broadcast closure; its meta holds `lastBroadcast` per-world memos (10.6).
Watchers subscribe like effects — a link from the watched node — but notify
through the broadcast list, synchronously in the writer's stack:

```
broadcast():  // called by the write wrapper's drain loop
  if worldValueChanged(watchedId, writerWorld):   // 10.6 cutoff
      setVersion(v => (v + 1) | 0)                // the hook's useState
```

Because `setVersion` runs in the writer's context, React's
`requestUpdateLane` gives the re-render the writer's priority: transition
writes schedule transition re-renders, urgent writes schedule urgent
re-renders, updates inside async actions entangle — all inherited, never
reimplemented. Every signal-driven render passes through React's
infinite-loop guards (`NESTED_UPDATE_LIMIT`, render-phase re-render limit)
like any setState.

### 13.2 `useSignal(signal)`

Render phase (pure): read the signal in `RENDER` context (which resolves the
pass's world Wp) and return it. A mount *during* a transition render
therefore reads the pending world directly — no double render, no guessing;
this is the scenario stock-React userland provably cannot handle (the
known-bug test we inherit and turn green, 17.4). If the value is a
`SuspendedBox`, call React's `use(thenable)` — a conditional `use` is legal —
so Suspense fallbacks and replays behave exactly as for a suspending
`useState` initializer.

Commit phase (layout effect): create/rebind the watcher node and link it to
the signal, then run the **post-subscribe fixup** for writes that raced into
the gap between render and subscription:

- committed value moved past what we rendered → `setVersion` immediately
  (pre-paint correction);
- a *deferred* batch wrote in the gap → issue the corrective `setVersion`
  inside `startTransition` so the correction joins that pending batch rather
  than jumping the queue.

Both checks compare against the watcher's remembered render world; they fire
only in genuine race windows. Unmount: unlink the watcher; liveness sweeps
run post-commit.

### 13.3 `useComputed(fn, deps, options?)`

A component-local `Computed` held in a `useState` holder, recreated when
`deps` change (compared like `useMemo`). `fn` closes over props/state freely
— that is exactly what `deps` re-creation handles; signal reads inside `fn`
are auto-tracked by the graph (in canonical contexts) and resolved per-world
during passes. Subscription and reads then work exactly like `useSignal` on
the local node. Disposal on unmount (and holder replacement) frees the
record deterministically.

### 13.4 `useSignalEffect(fn, deps?)`

A passive-effect-scheduled graph watcher over **committed** state: the
callback runs after commit, reads in `COMMITTED` context, and re-runs when
(a) `deps` change (React pathway) or (b) absorption changes the committed
value of anything it tracked (engine pathway, flushed in a microtask after
retirement — "after commit", matching `useEffect`'s contract). Cleanup
supported.

### 13.5 `useAtom` / `useReducerAtom`

Component-owned atoms: created in a `useState` initializer, disposed in the
unmount cleanup of an effect, recreated on strict-mode remount (the holder
pattern from the react-concurrent-store harness). They are ordinary atoms —
other components' computeds may read them through context or props.

### 13.6 Transitions helpers

`startSignalTransition(scope)` = `startTransition` + engine `batch()`: the
batch coalesces broadcasts so N writes notify each watcher once.
`useSignalTransition()` wraps `useTransition` the same way; `isPending` is
React's own. Neither is required for correctness — plain `startTransition`
works — they are throughput helpers.

### 13.7 Multiple roots

The engine keeps no per-root state beyond the current pass (one pass executes
at a time, 6.3). Batches spanning roots are correct by construction:
per-root commit lock-in lives in the fork's registry (6.2), which keeps
including a committed-elsewhere batch in that root's `includedBatches` until
the token retires everywhere; the engine just applies the mask it is given.

### 13.8 SSR and hydration

Server rendering uses `COMMITTED` context reads with no subscriptions and no
observed-lifecycle mounting (watcher creation is a layout-effect concern, and
layout effects don't run on the server). Recipe (documented + helper):
serialize atom state into the HTML, initialize atoms from it *before*
`hydrateRoot`, hydrate against identical committed values. No
`getServerSnapshot` analogue exists because reads are plain values. Flight/
RSC is out of scope for v1.

---

## 14. Growth, reclamation, and memory management

### 14.1 Growth: closure rebuild over const buffers

The whole engine is one closure over `const M`, `const G`, and const aliases
of the side columns. TurboFan embeds those bases like module constants — the
only binding strategy measured at exact const parity (rejected with numbers:
segment tables +35–40%/access, resizable ArrayBuffers +66–83% traversal,
mutable `let` bindings +34–43%, per-function aliases +26–30%; growth *events*
are near-free — only growth *support on the read path* costs).

Mechanics (inherited verbatim from the proven kernel):

- Allocators set `growPending` when the bump pointer crosses the watermark
  (keep ≥1280 main-plane records **and** half the plane free; log plane: ≥256
  records and half free).
- Only at an **operation boundary** (`enterDepth === 0`: no engine frame that
  captured the old buffers is live) does boundary work run: copy into doubled
  buffers with `.set`, rebuild the engine closure, swap the single mutable
  module-level engine reference. Mid-walk growth is impossible by
  construction; an operation that out-allocates the entire remaining slack
  throws rather than corrupt in-flight walks.
- Scalar counters and heads live at module level so a rebuilt engine resumes
  exactly where the old one stopped.
- Plane G participates in the same rebuild; its watermark also counts open
  passes (never reallocate G while a pass could hold log ids — in practice G
  boundary work runs at pass end and retirement, which are its natural
  allocation boundaries).

### 14.2 Reclamation

- **Links**: freed to the free list on unlink (kernel, deterministic).
- **Effects, scopes, watchers**: disposal zeroes the record and defers the
  actual free to the next operation boundary (`pendingFree`), so a mid-flush
  dispose can never recycle a record the queue or an in-flight walk still
  references; the `GEN` counter makes stale disposers no-ops.
- **Atoms and computeds** are owned by their handles. Deterministic disposal
  exists internally (hooks dispose their component-owned nodes on unmount).
  For module-level handles, a `FinalizationRegistry` on handle objects pushes
  record ids onto the free list when handles are collected — closing the
  known leak in the lab kernel. Registration happens once per handle at
  construction; finalization latency is bounded by the watermark slack (a
  record lingering costs 32 B + side slots, never correctness). Unwatched
  computeds already drop their dependency links (kernel `unwatched`), so an
  unreferenced computed holds no graph edges while awaiting finalization.
- **Log entries**: swept by chain splice (9.6); the whole plane resets at
  quiescence (9.7).

### 14.3 Memory-visible guarantees (tested)

- Quiescent overlay = zero log-plane residue, zero live batch slots, era
  marks all stale.
- Steady-state re-render traffic allocates nothing in the engine (log
  records in LOGGED mode come from the plane; broadcast closures and version
  bumps allocate nothing).
- Arena memory is off-JS-heap for GC purposes: retained-heap comparisons must
  report both `heapUsed` and plane byte totals (the harness's GC-attribution
  mode does this; see 18.2).

---

## 15. Constant inlining without runtime cost

Field offsets, flag bits, opcodes, and strides (section 7) must compile to
numeric literals in the hottest code in the library. Two hazards, both
measured in this repo: module-scope `const` declarations get demoted to
mutable `var` by esbuild-style bundlers (lazy-init/scope-merge hoisting),
costing TurboFan their constant-folding — +15–21% on kairo workloads through
a bundled child; and per-function re-aliasing costs +26–30%.

**Primary strategy: a single same-file `const enum`.** All layout constants
live in one `const enum C { … }` in the kernel source file. Same-file
`const enum` members are inlined as numeric literals by esbuild (both
transform and bundle modes), tsx, vitest, and tsc alike, so the emitted code
carries literals no matter how the *library* is built. This is the exact
configuration validated in the lab kernel.

Toolchain requirement this imposes: the library itself cannot be consumed as
raw TypeScript by stripping-only loaders (Node's `--experimental-strip-types`
and similar refuse `const enum`). The package therefore **ships compiled
JavaScript** (built with tsdown/esbuild), with declaration files that expose
no `const enum` across the public boundary (the enum is internal to the
kernel module; nothing exports it). Consumers' toolchains see only plain JS
plus `.d.ts` — no configuration burden, no `isolatedModules` conflicts.

Fallback for stripping-only *contributors* (running the repo's own tests via
a type-stripping runner): a codegen'd `constants.ts` mirror of the enum as
plain `export const` values, used only by tests/tools, never imported by the
kernel. CI verification: the dist build is grepped to assert zero enum-member
identifiers survive (all literals), and the bundled-child kairo benchmark
gate (18.2) catches any packaging regression that would re-introduce the
const-demotion cliff.

---

## 16. Tracing and debugging

### 16.1 The tracer slot

The core exposes one module-level slot: `tracer: Tracer | undefined`,
`undefined` unless `cosignal/tracing` is loaded. Every interesting transition
does `tracer !== undefined && tracer.emit(...)`. Untraced cost: one null
check per site (measured noise). Because the engine's nouns are integers
(node ids, log ids, batch tokens, seqs, slots), trace events are cheap to
record and precise to correlate.

### 16.2 Event schema

Every event: `id` (monotonic int), `time`, `cause` (the id of the event that
triggered it — the causality edge), plus a type payload:

| type | payload |
| --- | --- |
| `atom-write` | atom id, op, batch token, seq, applied?, equality-dropped? |
| `log-append` / `log-coalesce` / `truncate` | atom id, log id, batch token |
| `batch-retired` | token, committed?, entries stamped |
| `absorb` | atom id, changed?, old/new (lazy-stringified via label hook) |
| `computed-eval` | node id, world (0 / token / pass serial), duration, deps-read count |
| `notify` / `broadcast` | node id, watcher id, cutoff-suppressed? |
| `effect-run` | node id, duration |
| `render-pass-start/end` | container label, pin, include mask, tokens |
| `render-read` | node id, world, resolved-via (kernel / replay / memo) |
| `suspend` / `settle` | node id, thenable identity hash, world |
| `mark` / `era-bump` / `sweep` / `quiescence` | counts |

Storage: a ring buffer (capacity must be a finite non-negative integer;
capacity 0 keeps the live subscription stream active without retaining
history) plus a subscription API — the feed for the planned Chrome devtools
timeline. Helpers answer the product questions directly by walking cause
chains: `whyDidRerun(computedOrLabel)`, `whyDidRender(componentLabel)`,
`effectRunCount(label)`.

### 16.3 Graphviz renderers (`cosignal/graphviz`)

Emits DOT source (render with `dot -Tsvg`; DOT survives graph sizes that
crash Mermaid):

- `dependencyGraphToDot(handles)` — snapshot of the live graph reachable
  from the given signals: kinds, labels, staleness flags, LIVE/marked state,
  live log tapes (as small record tables), watcher attachment.
- `traceToDot(events, filter?)` — the causal graph of trace events
  (write → mark → broadcast → render → absorb chains).

Layering is strict: `tracing` records without importing any visualizer;
`graphviz` imports only *types* from tracing. Either loads without the other.

### 16.4 Debug builds

`COSIGNAL_DEBUG` builds enable the kernel invariant assertions (8.8), tape
invariant checks (W0 fold equals kernel value after every absorption), and
label propagation into error messages. Production builds compile all of it
out (the constant-inlining pipeline drops dead branches).

---

## 17. Testing plan

Four suites, run in CI in this order (cheapest signal first).

### 17.1 Core conformance

- The reactive-framework conformance suite (179 cases as configured in this
  repo's harness — the bar alien-signals itself sets), run against the core
  API adapter, **including** the growth-stress configuration
  (`initialRecords: 2`, forcing every doubling path) and exact
  dynamic-pull-count assertions.
- Kernel unit tests: laziness, cutoff, dynamic dependency trimming, repeated
  reads, re-entrant writes and cycle rejection under both
  `forbidWritesInComputeds` settings, effect ordering (outer-before-inner),
  scope disposal, generation-counter staleness, boundary growth/reclaim
  under adversarial dispose-during-flush sequences.
- Benchmark-contract tests: synchronous effect flush, fresh mid-batch reads,
  exact pull counts (the `testPullCounts: true` club).

### 17.2 Overlay semantics (no React; simulated fork)

A fake external runtime driving the bridge lets every concurrency scenario
run as a fast unit test: pin/include visibility truth table (each clause of
10.2 in isolation and combination), rebase walkthrough (10.7) and its
functional-update variants, absorption folds with interleaved
urgent/deferred/equal writes, sweep correctness under multiple pinned
passes, truncation, slot exhaustion fallback, coalescing legality (never
coalesce across an open pass), quiescence resets (era, seq, plane G),
overlay-mark invariant under new-edge repair (8.7.3), memo stamping across
pass restarts.

### 17.3 React integration

Adopt the react-concurrent-store harness wholesale (vitest + jsdom + RTL,
transitions held open by controlled promises, TestLogger render-order asserts
with afterEach-empty, inline DOM snapshots for tear checks, listener-leak
asserts, controlled thenables for Suspense) and its 14-scenario suite as the
conformance bar — including turning their documented known-bug case (sync
mount mid-transition with suspending pending state) into a passing test.
Plus, from the previous-generation plan and this design's specifics:
signal+React-state lockstep inside one transition; interruption and rebase;
`flushSync` render excluding a pending default-priority batch (the case that
forced the always-log rule, 9.1); multiple roots with a spanning batch
(per-root lock-in); `useComputed` over props+state+signals; `useSignalEffect`
re-run sources (deps vs absorption); the **ReducerAtom vs useReducer
side-by-side**: identical action streams through both across a held-open
transition with urgent interleaving, committed values equal at every step;
infinite-loop rejection (a signal-write storm hits React's nested-update
error, not a hang); MutationObserver window (observer sees app mutations,
never React's); strict-mode double-mount (observed-lifecycle nets to one
subscription); hydration.

### 17.4 Reconciler-level fork tests

The fork's own test suite (inherited): batch-token registry edges
(claim/mint/pending/backfill/finish/close), async-action parking, per-root
commit lock-in, pass start/end pairing across yields and restarts,
exactly-once retirement, mutation-window bracketing incl. View Transitions
and `flushSync`, integer-token encoding (deferred bit, no reuse while live).

---

## 18. Benchmarks and performance targets

### 18.1 Methodology (hard-won rules; violating them produced wrong conclusions before)

- Rank only **one-framework-per-process** runs; same-process suite order
  biases results up to 3× via megamorphic pollution.
- The primary suite is the milomg reactivity-benchmark fork (current
  alien-signals; the tb fork pins a two-majors-stale alien and is
  quarantined to history).
- Report fastest-of-N **and** mean/p99 **and** GC time (fastest-of-N hides
  GC; arena designs differ most in GC). The shapes harness's GC-attribution
  mode (Node 24 `PerformanceObserver` with buffered gc entries +
  timestamp-window attribution) is the tool.
- Tier-0 shape benches (`deep`, `broad`, `diamond`, `reads`, `isolate`,
  `create`, ~0.4 s/framework, checksum-verified) gate every optimization
  before kairo-scale runs.
- Perf-affecting claims must be measured **through the bundled child** —
  call-free micro-loops cannot detect binding/packaging regressions.

### 18.2 Benchmark matrix

| mode | measures |
| --- | --- |
| core, DIRECT | kernel parity vs alien-signals v3 (the existing lab numbers are the floor) |
| core, LOGGED, no batches live | the read-gate and write-gate overhead in the worst "engaged but idle" state |
| synthetic transition (fake fork): N deferred writes → retire → absorb | log append throughput, absorption cost per entry, sweep cost |
| React app benches | click-to-paint vs `useState` equivalents; 10k-subscription mount; transition with M signal writes vs M setStates; suspense resolve-to-paint |
| memory | retained heap + plane bytes on the effects-10k and grid shapes; log-plane residue after quiescence (must be zero) |
| growth stress | full suite at `initialRecords: 2` (correctness) and growth-event timing (must stay boundary-only) |

### 18.3 Targets (numbers, not adjectives)

- **Core DIRECT**: hold the lab kernel's results — every tier-0 shape ≤1.0×
  alien-signals time (current: deep 0.90, broad 0.84–0.88, diamond 0.89,
  reads 0.74–0.87, create 0.96); kairo suite ≤1.25× alien on every test with
  GC-inclusive accounting, parity as stretch; creation-heavy and
  effects-memory wins retained (≥30% retained-heap reduction on
  effects-10k).
- **Gates**: LOGGED-mode read of an unmarked node ≤1.1× DIRECT read; logged
  urgent write ≤2× DIRECT write; quiescent-overlay read identical to DIRECT
  read within noise.
- **React**: signal-driven re-render (click → paint) within 10% of the
  `useState` equivalent; 10k `useSignal` mounts within 15% of 10k
  `useState`; a 1000-write transition absorbs in <1 ms.
- **Conformance is a precondition for any number**: 179/179 core, all
  overlay unit suites, 14/14 + extensions React suite. A benchmark result
  from a non-conformant build is not a result.

---

## 19. Open risks

Ordered by expected annoyance.

1. **The watcher broadcast cutoff (10.6) does world evaluation on the write
   path.** Wide fan-outs (one atom, thousands of watchers) pay an overlay
   evaluation per watcher-world at write time. Mitigations: per-world memo
   sharing across watchers of the same node (the memo is on the node, not
   the watcher); a configurable "always broadcast, let React bail out"
   escape hatch. Needs measurement before the default is final.
2. **Marks over-approximate and eras clear only at full quiescence.** A
   long-lived deferred batch keeps the whole downstream region marked;
   overlay evaluation replaces kernel caching there for the duration.
   Mitigation already specced: the `allVisibleAndApplied` shortcut and the
   Wn==W0 shortcut; further mitigation (per-node world-value stamping) is
   deliberately deferred until a real workload shows the need.
3. **Absorption spikes.** A transition holding 10⁵ logged writes absorbs at
   one commit. Coalescing (9.3) bounds tape length per atom; the residual
   risk is many *distinct* atoms. If it bites, absorption can incrementalize
   (absorb per-atom across microtasks) at the cost of a more complex W0
   invariant — flagged, not designed.
4. **`flushSync`-excluding-default is load-bearing for the always-log rule.**
   If React's behavior around entangled default lanes shifts, the rule could
   relax; conversely any future "skip logging" optimization must re-prove
   this case. The 17.3 test pins it.
5. **FinalizationRegistry reclamation latency** leaves records allocated
   until GC runs. Bounded cost, but a pathological create-and-drop loop of
   module-level atoms grows the plane. Documented; deterministic `dispose()`
   on handles is the pressure valve if needed.
6. **Fork drift.** The registry hooks touch the work loop's most-edited file.
   Mitigation: the reconciler-level test suite (17.4) runs against every
   React rebase; the patch is additive and small (6.6).
7. **Two engine instances from bundle duplication** (two copies of the
   module) would each intern tokens independently — correct but wasteful,
   and watchers would split across engines. A `globalThis` symbol guard
   warns loudly in dev.
8. **Multiple simultaneous renderers** (react-dom + react-three-fiber):
   write attribution answers from the first registered provider (6.1).
   Documented limitation, matches upstream precedent.
9. **Token/seq wraparound** is handled (6.2, 9.7) but the wrap paths are
   by nature nearly untestable in production-like conditions; they get
   direct unit tests with forced counter values.
10. **Log-plane locality** degrades if many atoms interleave writes (each
    tape's records scatter across the plane in global append order). Seq
    order equals append order, so replay walks are forward-only; if profiles
    show misses, per-batch segment allocation is the known fix.

---

## 20. Alternatives considered

- **Object-graph engine with per-atom object logs** (the previous-generation
  cosignal design): the semantics source of this spec, and its React model is
  carried over nearly verbatim. Rejected as the *implementation* because the
  lab kernel beat the equivalent object core on every tier-0 shape and
  the log records are exactly the kind of short-lived small objects arenas
  eliminate best.
- **Multi-plane worlds** (fork the whole value/flag plane per pending batch;
  a sibling variant explores this): strictly more mechanical sympathy for
  render-heavy pending worlds (kernel-speed pending reads), but pays plane
  bookkeeping on every write and a much wider kernel surface; log-overlay
  keeps the proven kernel untouched and concentrates all concurrency cost in
  the overlay.
- **Per-subscriber snapshots** (`useSyncExternalStore`-style value copies):
  rejected outright — per-subscriber memory, forced synchronization, no
  transition parity; eliminating this model is the project's premise.
- **Skip-log fast path for urgent writes** (only log when a pass or deferred
  batch is live): rejected as unsound (9.1's `flushSync` case).
- **Object batch tokens** (previous fork protocol): rejected for this
  design because every logged write would need a token→int interning `Map`
  hop on the write path, and trace records would need object retention;
  the integer protocol carries the same information (identity + deferred
  bit) with none of that.
- **Lane bits across the boundary**: rejected — recycled bits cannot name
  batches over time, and they leak the reconciler's internals; this is the
  precise problem batch tokens exist to solve.
- **`const` module constants / define-injection instead of `const enum`**
  (section 15): define-injection remains viable and is kept as the
  documented fallback; `const enum` wins on simplicity now that a compile
  step is acceptable.
- **WASM kernel**: rejected on evidence — ~100 ns/call boundary tax on
  per-read calls and values can't cross without bookkeeping; the layout wins
  are available inside JS.

---

*End of spec.*
