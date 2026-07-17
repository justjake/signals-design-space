# cosignal-arena: a concurrent-React signals library on integer arenas

**Status: final design specification, approved for implementation.**

**Variant B of two:** this document specifies the **quiescence-gate**
write-mode design — DIRECT while React is fully idle, with a documented
loose contract for idle-time writes plus a `strictLanes` opt-in for exact
parity. Variant A (`react-concurrent-signals-arena-alt-a.md`) shares every
other design decision but adopts monotonic gate activation at first React
root registration, giving exact React lane parity unconditionally.

This document specifies `cosignal-arena` — a from-scratch signals library for
TypeScript whose entire hot state lives in flat integer arrays ("arenas"), and
which integrates with concurrent React with no compromises: no
`useSyncExternalStore`, full `startTransition` participation, Suspense parity,
and a small React fork that exposes the render/commit lifecycle to userspace.

It is self-contained. Every concept is defined in plain English before it is
used. The reader is not assumed to know React internals, alien-signals, or any
prior research. The one external artifact this spec depends on — our patched
build of React — is fully specified in section 6. The one internal artifact it
builds on — the proven arena kernel at `libs/arena/src/index.ts` in this
repository — is described completely in sections 7 and 8; treat those sections
as the port specification for it.

Conventions used throughout: TypeScript, pnpm workspaces, `type` aliases
preferred over `interface`, `undefined` preferred over `null`. The library
ships compiled JavaScript (section 15 explains why and what that buys).
All sizes assume V8 on a 64-bit machine.

---

## Table of contents

1. [What cosignal-arena is](#1-what-cosignal-arena-is)
2. [Background: signals, concurrent React, and why stores tear](#2-background)
3. [Vocabulary](#3-vocabulary)
4. [Public API surface](#4-public-api-surface)
5. [Architecture at a glance](#5-architecture-at-a-glance)
6. [The React fork: external-runtime protocol](#6-the-react-fork)
7. [Data layout: arenas, records, field tables, byte math](#7-data-layout)
8. [The kernel: mechanisms](#8-the-kernel)
9. [The write log overlay](#9-the-write-log-overlay)
10. [View resolution: read contexts and worlds](#10-view-resolution)
11. [The kernel/policy cut and the placement table](#11-the-kernelpolicy-cut)
12. [Signal kinds and promise handling](#12-signal-kinds-and-promise-handling)
13. [React bindings](#13-react-bindings)
14. [Growth, reclamation, and memory management](#14-growth-reclamation-and-memory-management)
15. [Schema, codegen, and constant inlining](#15-schema-codegen-and-constant-inlining)
16. [Tracing and debugging](#16-tracing-and-debugging)
17. [Testing plan](#17-testing-plan)
18. [Performance engineering: budgets, benchmarks, gates](#18-performance-engineering)
19. [Milestones and build order](#19-milestones-and-build-order)
20. [Open risks](#20-open-risks)

Appendix A: [Decision record](#appendix-a-decision-record)

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

2. **Log-overlay concurrency.** Concurrent React needs to show _two or more
   versions of your state at once_ (section 2 explains why). Most designs pay
   for this by versioning every value or maintaining parallel copies of the
   graph. In this design, the canonical engine knows nothing about versions:
   it is a plain, fast, single-world signal engine. Concurrency is an
   **overlay**: each atom that has in-flight concurrent writes gets a small
   **write log** — a receipt tape of recent writes, packed into its own arena
   plane — and reads that care about a specific version resolve their answer
   _through the log_. When React commits, the log is absorbed into the
   canonical world in bulk. When nothing concurrent is happening — which is
   almost always — the canonical fast path pays exactly one "is the log
   empty?" branch, and pure non-React users never pay even that.

The headline bet: **versioning is an exceptional condition, so its cost should
be proportional to how much of it is happening, not to the size of your
state.** Abandoning a speculative batch is truncating a log. Committing one is
replaying a short tape. A quiet app is a zero-length tape.

Two disciplines run through the whole document and are as much a part of the
design as any data structure:

- **Every hot-path cost is priced and gated.** No mechanism in this spec is
  allowed to exist on a hot path without a numeric budget (bytecode counts,
  ratio gates against named baselines) and a CI check that enforces it.
  Section 18 is the ledger.
- **The concurrency plane is verified against a naive oracle, not by
  hand-picked examples.** The subtle machinery — visibility clauses, rebasing,
  sweeping, coalescing — must agree with a deliberately dumb reference
  implementation across randomized schedules before it is trusted. Section 17
  sequences that oracle _before_ the machinery it checks.

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
  _by running the function_, so they can change from run to run (read a
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
  things that depend on _it_ are not re-run. Change stops propagating at the
  first place it stops mattering.

This algorithm family (alien-signals' push-pull with exact re-verification) is
what our kernel implements; the conformance suite in section 17 pins its exact
semantics, including the subtle parts (re-entrant writes, dynamic dependency
trimming, exact pull counts).

### 2.2 What concurrent React does

Modern React does not always render your update immediately and synchronously.
Two features matter here:

- **Transitions** (`startTransition`, `useTransition`): updates marked as
  transitions render _in the background_. React builds a new tree for the
  future state while the screen keeps showing the current state. Urgent
  updates (typing, clicking) can happen _during_ that background render; React
  will render the urgent update first — **without** the transition's changes —
  and finish the transition later. So at one moment there are two live
  "versions of the world": the committed one on screen (possibly updated
  urgently), and the pending transition one being prepared.
- **Yielding and replay.** A background render is time-sliced: React pauses it
  to keep the page responsive and resumes later. It can also throw a partially
  built tree away and restart. Therefore any code that runs during rendering
  must be pure (no side effects), and any data it reads must return _the same
  answer for the whole pass_, even if the outside world moved on while the
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
force: every store change schedules _synchronous_ re-rendering, and any store
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
  answered _for the specific version of the world it is rendering_.

Six facts are impossible to observe from userspace, and are exactly what our
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
4. **How to schedule an update _into_ a specific existing batch** — so a
   component that subscribed a moment too late can issue a corrective
   re-render that commits _with_ the pending batch it missed, not after it
   (the batch-entanglement API, section 6.5; used by sections 9.8 and 13.2).
5. **Whether React is executing render code _right now_** — a time-sliced
   render stays open across yields to the event loop, and the handlers and
   timers that run in those gaps must read current state and write legally;
   only the work loop knows where its yield edges are (sections 6.3, 10.1).
6. **A stable name for one piece of render work, and where it committed** —
   Suspense retries and restarts arrive as new passes of the _same_ work
   (the render lineage, for per-world caches), and a batch spanning roots
   commits on each root separately (per-root committed views). Sections
   6.3, 12.3, 13.4.

Plus one unrelated nicety (also from the fork): a bracket around the window
where React mutates the DOM, so a `MutationObserver` can ignore React's own
mutations. Section 6.6.

---

## 3. Vocabulary

Terms defined once, used everywhere. Plain-English first.

| Term                          | Meaning                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **arena**                     | A large, pre-allocated `Int32Array` treated as an array of fixed-size records. Allocating a record = advancing a bump pointer or popping a free list.                                                                                                                                                                                                                |
| **plane**                     | One arena serving one record family. The engine has three: the **main plane** `M` (graph nodes and links, stride 8), the **log plane** `G` (write-log entries, stride 4), and the **world-memo plane** `W` (overlay memo records and their certificates, stride 8); the tracing module owns a fourth (the trace plane `T`, section 16.2).                            |
| **record**                    | A fixed-size run of 32-bit slots inside a plane. Referenced by an **id**.                                                                                                                                                                                                                                                                                            |
| **id**                        | An integer naming a record. Ids are _pre-multiplied byte-offsets-in-elements_: id = recordIndex × stride, so field access is `M[id + FIELD]` with no multiply. Id 0 is burned as "none" (the null id).                                                                                                                                                               |
| **node**                      | A graph participant: atom, computed, effect, scope, or watcher. One main-plane record each.                                                                                                                                                                                                                                                                          |
| **link**                      | One dependency edge ("this consumer read that producer"), member of two intrusive doubly-linked lists at once (the consumer's dependency list and the producer's subscriber list). One main-plane record each.                                                                                                                                                       |
| **atom**                      | A writable signal (`Atom`, `ReducerAtom`, and the hook-owned variants).                                                                                                                                                                                                                                                                                              |
| **computed**                  | A derived, cached, lazily-evaluated signal.                                                                                                                                                                                                                                                                                                                          |
| **watcher**                   | A node representing one mounted React hook subscription. Like an effect, but its notification runs synchronously in the writer's stack (to inherit React's lane) instead of queuing for the effect flush.                                                                                                                                                            |
| **kernel**                    | The mechanism layer: pure integer/graph algorithms over the planes plus one packed value column. It never interprets user values beyond identity comparison and never chooses policy (section 11).                                                                                                                                                                   |
| **policy layer**              | Everything above the kernel: Atom/ReducerAtom/Computed semantics, custom equality, reducers, promise handling, React bindings, tracing.                                                                                                                                                                                                                              |
| **batch**                     | A set of updates React renders and retires as a unit — everything scheduled in one event, or one transition. Named across the fork boundary by a **batch token**.                                                                                                                                                                                                    |
| **batch token**               | A nonzero 31-bit integer minted by the fork's batch registry, stable for the batch's life, never reused while live. Bit 0 encodes "deferred". Section 6.2.                                                                                                                                                                                                           |
| **deferred batch**            | A transition-like batch: its render does not block paint and it commits later. Writes in deferred batches are the ones that _must_ be logged.                                                                                                                                                                                                                        |
| **batch slot**                | The engine's own small index (0–31) interned for a live batch token, so log records can store a 5-bit slot instead of a full token, and a render pass's included batches become one 32-bit mask.                                                                                                                                                                     |
| **write log / log / tape**    | Per-atom singly-linked chain of log records in the log plane: the atom's recent writes, each tagged with operation, batch slot, and sequence tickets. Empty for almost every atom almost all the time.                                                                                                                                                               |
| **base record**               | The first record of every log: a synthetic entry holding the atom's value from the moment the log was created. Replays start from it.                                                                                                                                                                                                                                |
| **seq / ticket**              | A number from one global take-a-number counter, stamped on every log record at append time. Gives every logged write a position on one shared timeline.                                                                                                                                                                                                              |
| **retirement**                | The moment a batch leaves React's books — its commit, or the close of a batch that never produced React work. Delivered exactly once per token by the fork.                                                                                                                                                                                                          |
| **absorption**                | Folding a retired batch's log entries into canonical kernel state: replay visible entries in seq order, write the result through the kernel (which propagates staleness and queues effects).                                                                                                                                                                         |
| **truncation**                | Discarding log entries without absorbing them (speculation abort, optimistic rollback, devtools).                                                                                                                                                                                                                                                                    |
| **canonical world (W0)**      | The world the kernel's values describe: all committed state, plus urgent writes that were applied directly (section 9.4). The only world the kernel knows.                                                                                                                                                                                                           |
| **pass world (Wp)**           | The world one render pass must see: determined by its **pin** and **include mask**.                                                                                                                                                                                                                                                                                  |
| **newest world (Wn)**         | Every write visible, pending or not. What reads outside render see.                                                                                                                                                                                                                                                                                                  |
| **writer's world**            | For a given write: the world containing all committed state, all retired entries, and the writing batch's own entries. The world used to decide whether a watcher must be told about the write (section 10.6).                                                                                                                                                       |
| **pin**                       | The seq-counter value captured when a render pass starts. The pass may not see anything that happened after its pin, even if it yields and resumes.                                                                                                                                                                                                                  |
| **include mask**              | The 32-bit batch-slot mask of the batches a render pass includes (from the fork's `includedBatches`).                                                                                                                                                                                                                                                                |
| **overlay mark**              | A per-node stamp meaning "some atom below me currently has a log". Nodes without the mark can answer any world from the kernel cache. Written by the notify walk.                                                                                                                                                                                                    |
| **notify walk**               | The overlay's downstream walk from a written atom: stamps overlay marks and collects watchers for broadcast. Runs on every deferred write (once per drain for batched writes), not just the first — this is what guarantees watchers hear about _every_ deferred write, including a second write from a different batch into an already-marked region (section 9.8). |
| **walk ticket**               | The id of a notify walk, from a monotonic counter. A node's overlay mark stores the last walk ticket that visited it; "marked" means the stored ticket is newer than the **era floor**.                                                                                                                                                                              |
| **era floor**                 | A scalar holding the walk-ticket value at the last quiescence. Bumping it to the current ticket counter un-marks every node in O(1), with no walk.                                                                                                                                                                                                                   |
| **world memo**                | A per-computed, per-world cache of an overlay evaluation, stored as a packed record in plane `W` and validated by its **certificate** (section 10.5). The mechanism that keeps long-lived transitions from degenerating marked regions into recompute-per-read.                                                                                                      |
| **certificate**               | The packed list of `(atom, seq-or-zero)` pairs a world memo carries: _every_ atom its evaluation read, with the atom's tape-tail seq at read time (0 if the atom had no tape then). A memo is valid only while every pair still holds (section 10.5).                                                                                                                |
| **slot memo chain**           | Per batch slot, the chain of that slot's writer's-world memo records, threaded through the memo records themselves. The drain walks it to find nodes whose pending-world values a new write may have changed — including nodes reached only through world-divergent dependencies (section 9.8).                                                                      |
| **render lineage**            | A stable integer the fork assigns to one logical piece of render work on a root (one lane set's work-in-progress), redelivered across that work's restarts and Suspense retries. The key for per-world suspense caches (sections 6.3, 12.3).                                                                                                                         |
| **committed view (per root)** | What "committed" means for one root: entries retired at or below that root's last-commit ticket, plus entries of batches the root has committed while they remain pending elsewhere (sections 10.2, 13.4).                                                                                                                                                           |
| **quiescence**                | The state of having no live logs, no live batches, and no open render pass — and, from the fork's perspective, no open or pending React work at all. The overlay resets itself to zero cost at quiescence, and the write gate returns to DIRECT there (section 9.1).                                                                                                 |
| **handle**                    | The user-facing object (`Atom`, `Computed`, …) wrapping a node id. Handles are ordinary objects; the arena records behind them are reclaimed when handles are garbage-collected or deterministically disposed.                                                                                                                                                       |
| **oracle**                    | The deliberately naive reference implementation of the overlay (plain per-atom arrays, replay-everything reads, memo-free computeds) that the real engine must agree with on every read across randomized schedules (section 17.2).                                                                                                                                  |
| **frozen kernel artifact**    | The donor arena engine, built without any overlay support, kept as a reference build. The contract suite (section 17.5) proves the shipping kernel is behaviorally identical to it whenever the overlay is empty.                                                                                                                                                    |

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
  /** Custom equality; Object.is otherwise. Equal writes never re-render
   * anything; whether they also skip the write log depends on pending
   * history (section 9.3). */
  isEqual?: (a: T, b: T) => boolean
  /** Debug-tools name. */
  label?: string
}

class Atom<T> {
  constructor(options: AtomOptions<T>)
  /** Read. Auto-tracks inside computeds/effects; resolves per read context. */
  get state(): T
  set(next: T): void // like setState(value)
  update(fn: (current: T) => T): void // like setState(fn) — fn is stored
  // and replayed per world, so it
  // must be pure
}
```

### 4.2 Reducer atoms

```ts
type ReducerAtomOptions<S, A> = {
  state: S
  reducer: (state: S, action: A) => S // pure; replayed per world
  isEqual?: (a: S, b: S) => boolean
  label?: string
}

class ReducerAtom<S, A> {
  constructor(options: ReducerAtomOptions<S, A>)
  get state(): S
  dispatch(action: A): void
}
```

`dispatch` stores the _action_ in the write log, not a computed value, and
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
  get state(): T // may throw (cached error) or suspend (React read sites)
}
```

Evaluation never throws _through the graph_: a throwing `fn` or a pending
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
  /** Exact React lane parity for writes made while React is fully idle.
   * Default false: such writes commit immediately and are visible to every
   * subsequent render (the documented loose contract, section 9.1). True:
   * every write is logged once React bindings are active, buying exact
   * flushSync/lane parity for idle-time writes at a per-write logging cost. */
  strictLanes?: boolean
  /** Initial main-plane record count (default 8192), log-plane record
   * count (default 1024), and world-memo-plane record count (default 1024);
   * all grow by doubling. */
  initialRecords?: number
  initialLogRecords?: number
  initialMemoRecords?: number
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
core's single checked slot; not loading it costs one `tracer !== undefined`
check per traced site. The tracer records packed integer records with no
per-event allocation (traces of a zero-allocation engine must not manufacture
the GC pressure they claim to observe), in two recording modes: a
flight-recorder ring (devtools default) and a lossless chunked session mode
for whole-boot captures; human-readable events are a lazy decoder view.
`cosignal/graphviz` renders DOT source for the live dependency graph and for
causal trace timelines, and imports only _types_ from tracing.

### 4.7 Explicitly supported situations

- Multiple React roots, including batches spanning roots.
- Writes from inside computeds (cycle-guarded; can be globally forbidden).
- Server-side rendering + hydration from serialized atom state (section 13.8).
- React StrictMode double-rendering and render replays (render reads are pure;
  per-world memoization tolerates replays).
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
│   retirement → absorption orchestration, batch entanglement, SSR   │
├────────────────────────────────────────────────────────────────────┤
│ POLICY: signal kinds                                               │
│   Atom / ReducerAtom / Computed classes, isEqual, reducers,        │
│   ctx.use (suspense), error containment, observed-lifecycle        │
├────────────────────────────────────────────────────────────────────┤
│ OVERLAY (mechanism): the write log                                 │
│   log plane G, memo plane W, seq tickets, batch slots, notify      │
│   walks, marks, visibility resolution, world memos + certificates, │
│   absorption/truncation                                            │
├────────────────────────────────────────────────────────────────────┤
│ KERNEL (mechanism): canonical arena engine                         │
│   main plane M, link/unlink, propagate/checkDirty, effect queue,   │
│   identity-compare update, growth, reclamation                     │
└────────────────────────────────────────────────────────────────────┘
```

The two gates that keep the fast path fast:

- **Write gate** — one module-scalar comparison. `writeMode` is `LOGGED`
  whenever React has open or pending work (any live batch token, any
  unretired batch, any render pass — the fork signals every one of these
  boundaries) and `DIRECT` only at full React quiescence; section 9.1 states
  the exact rule and the deliberate contract it implies. In DIRECT mode a
  write is exactly the proven kernel write: compare, set pending value,
  propagate staleness, flush effects. Pure-core users, servers, and the
  benchmark never execute a single overlay instruction. (Whether this gate is
  a scalar branch or a closure swap is a pre-registered experiment with the
  branch as the safe default — section 18.4.)
- **Read gate** — one branch per read. For atoms it is folded into the flags
  word the read loads anyway (`FLAG_LOGGED`); for computeds it is
  `loggedAtomCount !== 0 && M[c + OVERLAY_STAMP] > eraFloor` — when the
  overlay is quiescent, the first scalar comparison short-circuits. This is
  the "log empty?" branch of the design brief, and it is the _only_ overlay
  cost the canonical engine ever pays while quiescent.

Life of a write, end to end, in LOGGED mode:

1. `atom.set(x)` — if the atom has no tape yet, policy checks
   `isEqual(current value, x)` and equal writes stop here (provably safe
   only in that state — section 9.3); with a live tape, every write appends
   a receipt and equality applies later, inside folds and broadcasts.
2. Ask the fork: `isCurrentWriteDeferred()`, `getCurrentWriteBatch()` (an
   integer token). Intern the token to a batch slot (0–31).
3. Append a log record to the atom's log (creating the log, with its base
   record, if empty — and, on creation, mark the atom's downstream cone,
   whatever the write's classification, section 9.3): operation, batch slot,
   payload, seq ticket. If the write is urgent (not deferred), _also_ apply
   it through the kernel immediately and mark the record APPLIED (section
   9.4).
4. Notify downstream. For an **urgent** write, the kernel's own propagation
   walk queues core effects and collects **watchers** (React subscriptions)
   onto a broadcast list. For a **deferred** write — which by design does not
   touch kernel propagation — the overlay runs a **notify walk** from the
   atom: a pure integer walk over subscriber edges that stamps overlay marks
   ("a log exists below me") and collects watchers onto the same broadcast
   list. The notify walk runs for _every_ deferred write (shared once across
   a batched group of writes), not just the first write into a region — this
   is what guarantees a second deferred write, even from a different batch
   into an already-marked region, still reaches watchers (section 9.8).
5. The write call drains the broadcast list synchronously before returning.
   Queue entries carry the writing batch's token, so the drain groups them
   by token; each deferred group runs inside the fork's batch-entanglement
   scope so its `setState` calls are assigned that batch's own lanes even
   when the drain runs after the writer's `startTransition` scope has
   closed (section 9.8). For each collected watcher, evaluate the watched
   node **in the writer's world** (memoized per node per world, sections
   10.5–10.6) and call the watcher's `setState` only if the value changed.
   The drain also re-validates the writer's world's registered memos (the
   slot memo chain), which is how nodes that depend on the written atom
   _only in that pending world_ — through a branch the canonical graph never
   took — still reach their watchers (section 9.8).
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
   era floor rises to the current walk ticket (clearing every mark in O(1)).

Speculation never touches canonical state, so aborting speculation is
deleting log entries — truncation — plus discarding world memos. Nothing to
un-propagate, no shadow graph to reconcile.

---

## 6. The React fork

We maintain a fork of React (a submodule + build script; see 6.7) whose only
substantive addition is a small, renderer-agnostic introspection channel
called the **external runtime**. The channel's protocol is
**integer-oriented**: batch identities cross the boundary as plain integers
rather than objects, which lets the engine stamp them straight into
`Int32Array` log records with no interning `Map` on the write path.

Design constraints, in order:

1. **React-concurrency-safe.** The protocol must describe batches and passes
   truthfully across lane recycling, yielding, restarts, multi-root commits,
   and async actions. Everything here is _edge-triggered from the places the
   reconciler already mutates its own bookkeeping_ — never sampled — so it
   cannot drift from reality.
2. **Minimal and encapsulating.** No Fiber objects, no lane bitmasks, no
   reconciler types cross the boundary. Tokens are serially-numbered
   integers, uncorrelated with lane bit positions. Roots are identified by
   their _container_ (for react-dom, the DOM element you rendered into) — an
   identity that is meaningful to userspace anyway.
3. **Inert when unused.** Every hook site is one null/flag check when nothing
   has subscribed. The additions carry no feature flag; they simply do
   nothing without a listener.

### 6.1 The isomorphic API (exports from `react`)

```ts
type Container = unknown // e.g. the DOM element passed to createRoot

type ExternalRuntimeListener = {
  /** A render pass began on `container`. `includedBatches` are the tokens of
   * every live batch this pass renders. `lineage` is a stable integer naming
   * this piece of render work across its restarts and Suspense retries (6.3).
   * A pass spans yields; it ends by completing or being discarded/restarted. */
  onRenderPassStart?: (
    container: Container,
    includedBatches: readonly number[],
    lineage: number,
  ) => void
  /** The pass on `container` completed or was discarded. Exactly one end per
   * start, even across restarts. */
  onRenderPassEnd?: (container: Container) => void
  /** The pass on `container` is yielding to the event loop (time-slicing)
   * without ending; onRenderPassResume fires when it picks work back up.
   * Yield and resume alternate strictly between one start and its end.
   * Event handlers, timers, and microtasks run inside yield gaps — reads and
   * writes there are NOT render-phase reads and writes (10.1). */
  onRenderPassYield?: (container: Container) => void
  onRenderPassResume?: (container: Container) => void
  /** A batch's work committed on one root — exactly once per (token, root),
   * at the moment that root's commit finishes. Fires before onBatchRetired
   * when this is the token's last pending root. Feeds the per-root committed
   * views (13.4). */
  onBatchCommitted?: (container: Container, token: number) => void
  /** A batch retired — exactly once per token, ever. `committed` is false
   * only for batches that never produced React work (external-only writes);
   * batches whose React updates died with unmounted trees still retire
   * through an ordinary (possibly empty) commit with committed = true. */
  onBatchRetired?: (token: number, committed: boolean) => void
  /** DOM mutation window; see 6.6. */
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

/** Batch entanglement: run `fn` so that any React updates it schedules are
 * assigned to the SAME batch as `token` — they render and retire with it.
 * Returns false (without running `fn`) if the token has already retired;
 * the caller must then fall back to a plain urgent update. Section 6.5. */
function unstable_runInBatch(token: number, fn: () => void): boolean
```

Renderers (react-dom, test renderers) register a provider on the shared
internals object at module init, following React's existing
`ReactSharedInternals` slot pattern; the isomorphic functions above delegate
to it. With multiple renderers loaded simultaneously, write attribution
answers from the first registered provider (documented limitation — only one
renderer processes an event at a time in practice).

### 6.2 Batch tokens: integer protocol

A **batch token** names "a set of updates React renders and retires as a
unit". Why not expose React's lane bits directly? Lane bits are _recycled_
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
  (unreachable in practice: one serial per _event or transition that touches
  external state_), the registry skips serials still held by its ≤31 live
  slots.

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
  scheduler's microtask to catch updates scheduled _before_ the batch's first
  store write (ordinary `startTransition(() => { setState(x); atom.set(y) })`
  line order).
- **finish** — after `markRootFinished` in commit: a batch is done on a root
  when its lane is no longer pending there. The token retires when its _last_
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
(object → integer) plus the entanglement entry point (6.5). The per-edge cost
with no live tokens is an integer/null check.

### 6.3 Render passes, yields, and lineage

`onRenderPassStart(container, includedBatches, lineage)` fires when React
prepares a fresh work-in-progress stack for a root with real work;
`onRenderPassEnd(container)` fires when that pass completes or is discarded.
Yields do **not** end a pass: a pass paused for time-slicing and resumed
later is one pass, which is exactly why the engine pins the seq counter at
pass start (reads must not move for the pass's whole life). A restart
(fresh stack) ends the old pass and starts a new one, re-delivering
`includedBatches` — the new pass may legitimately see newer state.

**Yield edges are protocol, not detail.** A time-sliced pass returns to the
event loop _while remaining open_; user code — click handlers, timers,
resolved promises — runs in those gaps. That is the whole point of
concurrent rendering, and it means "a pass is open" and "we are executing
render code right now" are different facts. The engine keeps a read-context
scalar that must track the second fact (10.1), and it deliberately never
consults the fork per read; so the fork delivers the transitions as edges:
`onRenderPassYield` when the work loop's should-yield check makes it leave,
`onRenderPassResume` when it re-enters. Both are wired where the work loop
already knows it is leaving/re-entering; both are one null check when
nothing subscribed. Without these two edges, a write from a click handler
inside a yield gap would look like a render-phase write (which must throw,
10.8) — the design's flagship scenario, an urgent update during a background
render, would crash on first exercise.

**Lineage names the work, not the pass.** React can restart a pass, and
Suspense re-renders arrive as _new_ passes when a promise settles. Anything
cached "for this render" under a per-pass key would be discarded and
re-created on every retry — for suspense caches that means re-fetching
forever, never converging. And a single batch token under-identifies the
work: a pass legitimately renders several entangled batches at once. So the
fork assigns a **render lineage**: a serially-numbered integer minted when a
root first schedules work for a given lane set, redelivered on every pass
start for that same work — across yields, restarts, and Suspense retries —
and retired when that work commits or is abandoned. Per-world suspense
caches key on it (12.3).

`includedBatches` contains the live tokens for the pass's render lanes plus
the committed-elsewhere lock-ins from 6.2. Tokens whose batches carry no
external writes are simply unknown to the engine and ignored.

React renders one pass at a time on a thread; passes on different roots never
interleave _execution_ (switching roots restarts). The engine may therefore
keep a single "current pass" scalar set.

### 6.4 Write classification

`unstable_isCurrentWriteDeferred()` answers "if setState were called right
now, would it be a transition-like update?" — it is the same decision
`requestUpdateLane` makes, exposed as a boolean. The engine calls it on every
logged write _before_ deciding whether to also apply the write directly
(section 9.4); it must therefore be pure and allocation-free, and it is: a
couple of comparisons against the reconciler's current-transition state.

### 6.5 Batch entanglement (`unstable_runInBatch`)

The problem this solves: a component can subscribe to a signal _after_ a
pending deferred batch already wrote to it (the component mounted, or first
read the signal, in the gap between that batch's write and this component's
commit). The component must now be re-rendered _as part of that batch_ — its
corrective update has to render with the batch's other updates and commit in
the same frame. Wrapping the corrective `setState` in a fresh
`startTransition` is **not** enough: `startTransition` starts a _new_
transition, which may be assigned a different lane, render separately, and
commit at a different time. A frame could commit where the batch's other
components show the new world and this component shows the old one — a tear
we introduced ourselves. Only the reconciler knows which lanes a batch
occupies, so only the fork can offer this operation.

Semantics of `unstable_runInBatch(token, fn)`:

- **Token live** (registry slot still holds it): the registry looks up the
  lane(s) the batch currently occupies on each of its pending roots. It runs
  `fn` with the reconciler's update-lane selection overridden so that every
  update scheduled inside `fn` is assigned to exactly those lanes — the same
  override scope React itself uses when replaying updates. For a deferred
  batch this also sets the current-transition context, so
  `isCurrentWriteDeferred()` answers true inside `fn` and any signal writes
  inside `fn` log under the same batch token (the engine's slot lookup in
  9.2 sees the same token). Returns true.
- **Token retired**: returns false without running `fn`. The caller falls
  back to a plain urgent update — correct, because a retired batch's values
  have already been absorbed into canonical state, so an urgent re-render
  reads them anyway.
- **Reentrancy**: `runInBatch` may be called from inside a commit-phase
  effect (that is its primary call site, section 13.2). It must not flush
  synchronously; it only tags the scheduled updates. Nesting `runInBatch`
  inside `runInBatch` or inside `startTransition` is defined to use the
  innermost override.

Because the update lands in the batch's own lanes, React's existing machinery
does the rest: the batch's next render pass includes the corrective update,
`includedBatches` is unchanged (same token), and the batch retires once, with
the correction inside it. The reconciler test suite gains a test asserting
exactly this: schedule work in a transition, subscribe late, entangle a
corrective update, and observe **one** commit containing both (section 17.6).

One registry detail makes this sound: the **finish** edge (6.2) retires a
token only when its last pending root finishes. An entangled update scheduled
during the commit phase of that final root arrives before `markRootFinished`
completes the retirement decision for the lane — the registry treats the
newly scheduled work as re-pending the token (the same rule that handles
multi-root spans). So the "token live" check inside `runInBatch` is not a
race window: either the token is still pending somewhere and the update joins
it, or retirement already happened and the caller takes the urgent fallback.

### 6.6 The DOM mutation window

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
_reconciliation_ mutations. Documented exclusions callers must filter
themselves: the layout-phase `<img src>` re-assignment, suspensey-CSS
`<link>` insertion, imperative Float APIs (`preload`/`preinit`), View
Transition name attributes, and DOM writes from user effect code.

### 6.7 Patch surface and maintenance

Files touched (small, additive, no behavioral change to React):

- `packages/react/src/ReactExternalRuntime.js` — new isomorphic module:
  listener set, provider slot on `ReactSharedInternals`, emit helpers
  (listener errors are reported like uncaught errors, never thrown into the
  commit), the query/subscribe/entangle exports.
- `packages/react-reconciler/src/ReactFiberExternalRuntime.js` — new: the
  notify entry points the work loop calls; pairs pass start/end exactly via
  a per-root active-pass set, pairs yield/resume within a pass, and mints
  render-lineage ids (6.3).
- `packages/react-reconciler/src/ReactFiberBatchRegistry.js` — new: the
  31-slot token registry, its five edges (6.2), the per-root commit
  notification (finish edge → `onBatchCommitted`), and the lane-override
  scope backing `unstable_runInBatch` (6.5).
- `ReactFiberWorkLoop.js` — calls into the two modules at: prepare fresh
  stack, the should-yield exit and work resumption (yield/resume edges),
  render-pass completion, commit (finish edge, mutation window),
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

The field tables in this section are the human-readable rendering of the
layout schema; the schema file itself (`tools/schema.ts`, section 15) is the
single source of truth, and the tables in `docs/layout.md` are generated from
it so they cannot rot. The tables are reproduced here so this document stands
alone.

### 7.1 Layout principles (each one measured, not aesthetic)

- **Record interleaving, not parallel columns.** A record's fields live
  contiguously (one cache line, one bounds-check domain). Naive
  one-array-per-field layouts measured 1.8× _worse_ than objects on deep
  chains; interleaved records beat objects everywhere.
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
- **Ids are branded in type signatures.** `NodeId`, `LinkId`, and `LogId` are
  branded `number` subtypes (section 15.3): they erase to nothing at runtime
  and catch id-kind confusion, un-premultiplied indices, and
  raw-plane-load-used-as-id mistakes at compile time.

### 7.2 The main plane `M` (Int32Array, stride 8, 32 bytes/record)

Two record families interleave freely: **nodes** and **links**.

**Node record.** Fields +0..+5 are universal; +6/+7 are kind-specific.

| offset | name                                                                                                                                                                                                                             | meaning                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| +0     | `FLAGS`                                                                                                                                                                                                                          | state machine + kind bits (table below)                     |
| +1     | `DEPS`                                                                                                                                                                                                                           | first link of my dependency list; free-list next when freed |
| +2     | `DEPS_TAIL`                                                                                                                                                                                                                      | last _confirmed_ dependency link (re-run cursor)            |
| +3     | `SUBS`                                                                                                                                                                                                                           | first link of my subscriber list                            |
| +4     | `SUBS_TAIL`                                                                                                                                                                                                                      | last subscriber link                                        |
| +5     | `GEN`                                                                                                                                                                                                                            | generation counter, bumped on free; stale disposers no-op   |
| +6     | atoms: `LOG_HEAD` — first log record id in plane G, 0 = no log. computeds / effects / watchers: `OVERLAY_STAMP` — the walk ticket of the last notify walk that visited me; overlay-marked iff greater than the global `eraFloor` |
| +7     | atoms: `LOG_TAIL` — last log record id. computeds: `MEMO_KEY` — the world key of the first record on my memo chain in plane W (fast hit check; section 10.5). effects/watchers: reserved (0)                                     |

**Link record** (one dependency edge, member of two doubly-linked lists):

| offset | name                       | meaning                                                                                     |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------- |
| +0     | `VERSION`                  | evaluation-cycle stamp: intra-run duplicate-read dedup                                      |
| +1     | `DEP`                      | producer node id                                                                            |
| +2     | `SUB`                      | consumer node id                                                                            |
| +3     | `PREV_SUB` / +4 `NEXT_SUB` | position in the producer's subscriber list                                                  |
| +5     | `PREV_DEP` / +6 `NEXT_DEP` | position in the consumer's dependency list; `NEXT_DEP` doubles as free-list next when freed |
| +7     | reserved (0)               |                                                                                             |

**Flags word** (all in `M[id + FLAGS]`, so kind dispatch and state checks are
one 4-byte load):

| bit  | name                                                                            | meaning                                                                                                                            |
| ---- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `MUTABLE`                                                                       | can produce new values (atoms, computeds)                                                                                          |
| 2    | `WATCHING`                                                                      | wants notification when possibly stale (effects, watchers)                                                                         |
| 4    | `RECURSED_CHECK`                                                                | currently evaluating (re-entrancy guard)                                                                                           |
| 8    | `RECURSED`                                                                      | re-entrant write reached me during my own run                                                                                      |
| 16   | `DIRTY`                                                                         | definitely stale                                                                                                                   |
| 32   | `PENDING`                                                                       | possibly stale — verify by pulling before recomputing                                                                              |
| 64   | `HAS_CHILD_EFFECT`                                                              | my dep list contains child effects/scopes (slow-path cleanup)                                                                      |
| 128  | `LOGGED`                                                                        | atoms only: `LOG_HEAD !== 0`. The read gate.                                                                                       |
| 256  | `IMMEDIATE`                                                                     | watchers only: notify synchronously via the broadcast list instead of the effect queue                                             |
| 512  | `LIVE`                                                                          | transitively watched by some effect/watcher (liveness split; drives the atom observed-lifecycle and lets policy skip dead regions) |
| 1024 | `K_ATOM`, 2048 `K_COMPUTED`, 4096 `K_EFFECT`, 8192 `K_SCOPE`, 16384 `K_WATCHER` | kind bits; `KIND_MASK` = their union. A freed record has FLAGS 0.                                                                  |

### 7.3 The log plane `G` (Int32Array, stride 4, 16 bytes/record)

One record per logged write, plus one **base record** per live log.

| offset | name          | meaning                                                                                                                                                                                                                               |
| ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| +0     | `NEXT`        | next entry in this atom's log (append order = seq order); 0 = tail; free-list next when freed                                                                                                                                         |
| +1     | `META`        | packed: bits 0–1 `OP` (0 = BASE, 1 = SET, 2 = UPDATE, 3 = DISPATCH); bit 2 `APPLIED` (already written through the kernel — urgent writes, section 9.4); bit 3 `RETIRED`; bits 4–8 `BATCH_SLOT` (5 bits, 32 slots); bits 9–30 reserved |
| +2     | `SEQ`         | take-a-number ticket at append time                                                                                                                                                                                                   |
| +3     | `RETIRED_SEQ` | 0 while the batch is pending; a fresh ticket stamped at retirement                                                                                                                                                                    |

### 7.4 The world-memo plane `W` (Int32Array, stride 8, 32 bytes/record)

One record per live world memo (section 10.5), plus a companion
**certificate region**: a bump-allocated run of `(atomId, seqOrZero)` integer
pairs in the tail half of the same plane, one run per memo. World memos are
packed records rather than heap objects for the same reason everything else
here is: certificate **validation is the inner loop of every marked-cone
read** — the exact workload the held-open-transition gate prices (18.2) —
and memos have the log plane's lifecycle (bump-allocated, bulk-invalidated,
zero residue at quiescence). Packing turns validation into one contiguous
forward Int32 scan instead of dependent heap loads into scattered arrays,
and makes overlay evaluation allocate no engine-side objects at all.

| offset | name        | meaning                                                                                                                                           |
| ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| +0     | `KEY`       | world key (encoding in 10.5)                                                                                                                      |
| +1     | `EPOCH`     | `overlayEpoch` at evaluation time; **0 is reserved as the tombstone value** (never a live epoch — `overlayEpoch` starts at 1)                     |
| +2     | `NODE`      | the owning computed's node id (needed by the drain re-validation, 9.8, and by the stale-head guard below)                                         |
| +3     | `VAL`       | index into the `memoVals` side array holding the memoized value or box (GC-visible, so it stays on the heap)                                      |
| +4     | `NEXT_MEMO` | next memo record for the same node (the node's memo chain; head stored as an integer in the `memos` side slot, mirrored by `MEMO_KEY` at `M[+7]`) |
| +5     | `SLOT_NEXT` | writer's-world records only: next record in the same batch slot's memo chain (heads in `slotMemoHead: Int32Array(32)`); 0 on other keys           |
| +6     | `NDEPS`     | number of certificate pairs                                                                                                                       |
| +7     | `CERT`      | offset of this memo's certificate run in the certificate region                                                                                   |

Certificate pairs record **every atom the evaluation read** — logged or not
— with the atom's tape-tail seq at read time, or 0 if the atom had no tape
then (why "every", not "every logged": section 10.5). Lifecycle:
re-memoizing a (node, key) appends a fresh record and tombstones the old one
(`EPOCH = 0`, `memoVals[VAL] = undefined`); sweep trims chains; the whole
plane, its certificate region, and `memoVals` reset at quiescence. One
hazard the bulk reset creates, owned explicitly: node memo heads (the
integer in the `memos` slot) are not walked at quiescence, so a head can
dangle into recycled offsets of the reset plane. Every chain lookup
therefore guards with `W[rec + NODE] === nodeId` — a mismatch means "this
node has no memos" and the head is lazily zeroed — the same stale-reference
defense the `GEN` counter provides for disposers, and a `verifyArena` check
(16.6).

### 7.5 Side columns (plain JS arrays, indexed off ids)

GC-visible state that cannot live in an Int32Array. All are packed arrays
grown by pushing `undefined`; none is ever made holey.

| column     | index                 | slots/record | holds                                                                                                                                                                                            |
| ---------- | --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `values`   | `id >> 2` (+ 1)       | 2            | slot 0: atom canonical value / computed cached value. slot 1: atom kernel pending value / effect cleanup fn                                                                                      |
| `fns`      | `id >> 3`             | 1            | computed wrapper function / effect function / watcher broadcast function                                                                                                                         |
| `memos`    | `id >> 3`             | 1            | computeds: integer id of the node's first memo record in plane W (0 = none); guarded against plane resets by the `NODE` check (7.4)                                                              |
| `meta`     | `id >> 3`             | 1            | policy metadata object, only for nodes that need one: `{ label?, isEqual?, reducer?, observeEffect?, liveCount, lastBroadcast?, thenableCache?, finalizerToken? }`. `undefined` for plain nodes. |
| `logVals`  | `gid >> 2`            | 1            | log-entry payload: SET value / UPDATE fn / DISPATCH action / BASE snapshot value                                                                                                                 |
| `memoVals` | `wid`-allocated index | 1            | world-memo value or error/suspense box (referenced by the memo record's `VAL` field); `undefined` for tombstoned records                                                                         |

The index arithmetic works because ids are pre-multiplied: main-plane
`id = record*8`, so `id >> 2 = record*2` (two value slots) and
`id >> 3 = record` (one slot); log-plane `gid = record*4`, so
`gid >> 2 = record`.

### 7.6 Small fixed tables and module scalars

- `batchToken: Int32Array(32)` — slot → live token (0 = free slot).
- `batchEntryCount: Int32Array(32)` — live (unswept) log entries per slot;
  a slot recycles when its token retired _and_ its count reaches 0.
- `slotMemoHead: Int32Array(32)` — slot → head of that slot's writer's-world
  memo chain in plane W (the drain re-validation list, 9.8); 0 = empty.
  Cleared when the slot releases and at quiescence.
- Scalars: `liveSlotMask`, `liveDeferredMask` (uint32 bitmasks of live /
  live-deferred slots), `unappliedEntries` (count of not-yet-applied entries
  program-wide), `loggedAtomCount`, `seqCounter`, `walkCounter` (notify-walk
  ticket counter), `eraFloor` (walk-ticket value at last quiescence; marks
  at or below it are stale), `overlayEpoch` (starts at 1; bumped on
  retirement, truncation, overlay-relevant promise settlement, and the
  quiescence reset — the events that change world values _without_ moving
  any tape tail; world memos carry it, section 10.5), `writeMode`
  (DIRECT/LOGGED per the quiescence gate, 9.1), and the pass set:
  `passOpen`, `passExecuting` (flipped by yield/resume, 10.1), `passSerial`,
  `passPin`, `passIncludeMask`, `passContainer`, `passLineage`.
- `loggedAtoms: number[]` — ids of atoms with live logs (absorption and
  sweep iterate this; append on first log entry, compact on sweep).
- `broadcastQueue` — flat Int32Array queue of stride-2 `(watcherId, token)`
  pairs: kernel `propagate` pushes token 0 (urgent), the notify walk pushes
  its write's token; the drain groups by token (9.8).
- Persistent traversal scratch: `propStack`, `checkStack` (Int32Array,
  doubling, with base save/restore so re-entrant walks unwind to their own
  base — these replace the per-propagation cons-cell allocations that cost
  the object-based competitor ~1.5 ms of GC per deep-chain benchmark run).
  The notify walk reuses `propStack`, and the certificate collector
  (`certStack`, 10.5) follows the same saved-frame-base discipline.

### 7.7 Byte math

Per-entity steady-state costs (V8 64-bit; object sizes measured on Node 24):

| entity          | cosignal-arena                                                                                                                                            | alien-signals objects                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| dependency edge | **32 B** arena, GC-invisible, zero write barriers                                                                                                         | 80 B heap (24 B header + 7 tagged fields), 4–6 write barriers per splice |
| atom            | 32 B record + 2 value slots (~16 B) + handle object ~48 B ≈ **96 B**                                                                                      | ~120 B (node + bound function)                                           |
| computed        | 32 B + 2 slots + wrapper closure + handle ≈ **~160 B**                                                                                                    | ~246 B                                                                   |
| effect          | 32 B + slots + closure ≈ **~120 B** + its links                                                                                                           | ~331 B + links                                                           |
| log entry       | **16 B** record + 1 payload slot (~8 B); freed in bulk                                                                                                    | n/a (no equivalent)                                                      |
| watcher         | 32 B + broadcast closure ≈ **~100 B**                                                                                                                     | n/a                                                                      |
| world memo      | **32 B** record + 8 B per certificate pair + 1 `memoVals` slot (~8 B), written once per overlay _evaluation_ (never per read); plane resets at quiescence | n/a                                                                      |

Plane sizing: default main plane 8192 records = **256 KiB** (an app with
2,000 signals, 1,000 computeds, and 20,000 edges uses ~23,000 records =
736 KiB after two doublings); default log plane 1024 records = **16 KiB**;
default memo plane 1024 records + certificate region ≈ **48 KiB**.
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
`libs/arena/src/index.ts` in this repository (179/179 conformance, exact pull
counts, all tier-0 shapes at or below alien-signals' times), with the
overlay-support additions called out explicitly in 8.7. Two independent
safeguards keep "proven kernel, untouched" a checkable fact rather than a
claim: the frozen-kernel contract suite (section 17.5) asserts behavioral
identity with the pre-overlay build whenever the overlay is empty, and every
kernel function carries a bytecode budget enforced in CI (section 18.3).

### 8.1 State machine

`DIRTY` means definitely stale, `PENDING` means possibly stale. A write marks
direct subscribers and their transitive consumers `PENDING` (cheap push,
stops at already-marked nodes); the first subscriber level gets `DIRTY` via
`shallowPropagate` when a value _confirmed_ changed. A read of a `PENDING`
computed runs `checkDirty`: an iterative walk down its dependency list **in
recorded order** (the discipline that makes verification sound under dynamic
dependencies), recomputing a dependency only when it is `MUTABLE|DIRTY`, and
upgrading sibling `PENDING` subscribers to `DIRTY` when a recompute really
changed the value. Nothing changed → clear `PENDING` and skip the recompute
(early cutoff, "exact pull counts").

`RECURSED_CHECK`/`RECURSED` implement re-entrancy: a write that reaches the
currently-evaluating node, or a read of a node mid-evaluation, is either
tolerated (re-run scheduled) or detected as a cycle and thrown — this is the
machinery that lets us _allow_ writes-inside-computeds per the requirements
while still rejecting true cycles. Deleting it is a known false optimization
(an upstream experiment removed it, passed alien-signals' own tests, and was
caught by Vue's suite).

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
  a style choice: `link` carries a declared budget of 200 bytecodes and
  `linkInsert` a declared out-of-line budget, both CI-enforced (18.3), and
  the overlay's mark-repair addition (8.7.3) is required to live in
  `linkInsert` only — never in `link`.
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
returning. Growth and reclamation work runs only _before_ the flush loop, at
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
   queue — as stride-2 `(watcherId, token)` pairs, `propagate` pushing token
   0 (urgent). The token column exists because the drain can legally run
   _after_ the writer's transition scope has closed (a grouped drain at
   `batch()` close); the token is what lets the drain re-enter the right
   batch's lane context via the entanglement API (9.8) instead of silently
   inheriting whatever context happens to be live at drain time. The public
   write wrapper drains the queue synchronously before returning, calling
   each watcher's `fns` entry. Keeping user code out of the propagation walk
   itself preserves the no-try/finally invariant.
2. **Notify walk.** `notifyWalk(atom, walkTicket, collect)`: walk every node
   reachable from the atom through subscriber edges, using `propStack`. At
   each node: if `M[node + OVERLAY_STAMP] === walkTicket`, stop (already
   visited by _this_ walk — the diamond dedup); otherwise store the ticket
   into `OVERLAY_STAMP` and continue into the node's subscribers. When
   `collect` is set, nodes carrying the `IMMEDIATE` flag (watchers) are
   additionally pushed onto `broadcastQueue` with the write's token. The
   stored ticket doubles as the overlay mark: a node is "marked" iff its
   stamp exceeds `eraFloor`, so re-walking a region with a fresh ticket both
   refreshes marks and re-collects watchers. The walk is a pure integer
   traversal; it runs no user code and allocates nothing. The overlay calls
   it with `collect` on every deferred write (shared across a batched
   drain — section 9.8), and **mark-only** (collect off) once per tape
   creation regardless of the write's classification (9.3); the repetition
   is deliberate and is the mechanism by which _every_ deferred write
   reaches watchers.
3. **Mark repair on new edges.** In `linkInsert` (the out-of-line slow path —
   zero cost on the cursor-hit fast path): if the overlay is live and the new
   producer is marked (or is a LOGGED atom), stamp the consumer and its
   transitive subscribers with the current `walkCounter` value. This
   maintains the mark invariant — _every node reachable via subscriber edges
   from a logged atom is marked_ — when a canonical re-evaluation picks up a
   brand-new dependency mid-era.
4. **`invalidate(id)`.** Set `DIRTY`, propagate to subscribers, queue
   notifications. Used by absorption (when a fold changes a value the kernel
   never saw as a pending write) and by promise settlement.
5. **Log-plane allocation.** Bump pointer + free list over plane G, and the
   O(1) chain-splice free (a swept log chain is already linked; freeing it is
   `tail.NEXT = freeHead; freeHead = head`). The kernel owns log record
   _memory_; it never interprets log _contents_ beyond the integer fields.

### 8.8 Kernel invariants (checked by debug assertions)

- Record 0 of each plane is never allocated.
- A record is on exactly one of: live graph, free list, `pendingFree`.
- `DEPS_TAIL` always points into the node's own dep list; cursor never
  crosses `purgeDeps` boundaries.
- The effect queue never holds a freed id (deferred reclamation sweeps only
  when the queue is empty; `GEN` defuses stale disposers).
- Scratch stack pointers return to their saved bases on every exit path
  (including the notify walk's).
- No kernel function allocates a JS object. (The only allocations are
  Int32Array doubling and side-column pushes, both at boundaries.)
- `eraFloor <= walkCounter` always; no node's `OVERLAY_STAMP` exceeds
  `walkCounter`.
- Memo chains in plane W are acyclic and terminate at 0; `SLOT_NEXT` is
  nonzero only on writer's-world-key records; a tombstoned record
  (`EPOCH = 0`) has `memoVals[VAL] === undefined`.
- While quiescent (`loggedAtomCount === 0`): no node's `OVERLAY_STAMP`
  exceeds `eraFloor`, plane G's and plane W's bump pointers are 0 (W's
  certificate region too), every `slotMemoHead` is 0, `seqCounter` is 1,
  and `overlayEpoch` has been bumped past every value any surviving memo
  record could carry (the quiescence reset, 9.7).

---

## 9. The write log overlay

The overlay gives every atom that needs one a **receipt tape**: an
append-only (until swept) chain of log records describing recent writes, from
which the value _as of any world_ can be reconstructed. This section covers
the tape's lifecycle; section 10 covers how reads use it.

### 9.1 When logging happens at all: the quiescence gate

`writeMode` is `LOGGED` whenever React is **nonquiescent** — any live batch
token, any pending (unretired) batch, or any render pass in flight — and
`DIRECT` only at full React quiescence. Both flips ride fork-signaled
boundaries, so the gate can never race a write: DIRECT→LOGGED happens when a
batch opens or a pass starts (edges that precede any write those could
affect), and LOGGED→DIRECT happens only at the quiescence boundary where the
overlay's O(1) bulk reset already runs (9.7). In DIRECT mode, writes are
pure kernel — the benchmark path, the server path, boot before React
schedules anything, and every idle-time write from timers, sockets, and
stores while React has nothing in flight. Zero overlay instructions.

In `LOGGED` mode, **every write is logged** — urgent or deferred, watcher or
no watcher. This mirrors React exactly: a `setState` always enqueues an
update object; our log record is that update, externalized into an arena
(and cheaper to allocate). Trying to be cleverer — skipping the log for
urgent writes when "nothing could tell the difference" — is unsound. The
proof case: an event handler does an urgent `atom.set(x)` while a
default-priority batch from earlier in the same event is still pending, and
then calls `flushSync`. React renders the flushSync work _without_ the
default-priority batch — a legitimate render of a world in which the urgent
write has happened but the earlier batch has not. If the urgent write had
skipped the log and gone straight to the canonical value, nothing could
reconstruct that older world; only a log entry lets the flushSync render
answer correctly. Note that this write is inside an open batch, so the
quiescence gate logs it. Two structurally cheaper gates were considered and
rejected as unsound; their counterexamples are permanent tests (below).

**The loose contract (the default, documented plainly).** A write made while
React is _fully quiescent_ commits immediately: it is applied to canonical
state with no receipt, and it is visible to every subsequent render pass —
including a later `flushSync` — because by the time any pass exists, the
write is simply part of committed history. What such a write does **not** do
is inherit the lane of the notification it triggers. Concretely, the case
this gives up: a `setTimeout` fires while React is idle and writes an atom;
the write commits (DIRECT); the watcher broadcast it triggers schedules
default-priority React work; then, in the same task, something calls
`flushSync` — and React renders the flushSync work _without_ that
default-priority batch. React's own `useState` in this schedule would hide
the timer's value from the flushSync render (its update sits in the excluded
lane's queue); our signal shows it (it is committed state, and there is no
receipt from which to reconstruct the pre-write world). This is a deliberate
deviation from exact React parity, and its shape is bounded: **no write is
ever lost, and every component converges to the same final state** — the
worst case is a one-frame window in which a signal-driven component can show
the newer value while a React-state-driven component shows the older one,
and that frame can paint. We accept it because the alternative taxes every
imperative write in every React app forever, for a case that requires an
idle-time write, a same-task flushSync, and a lane-excluded default batch to
line up. The exact schedule above is a **contract-documentation test**
(17.6): it asserts this loose behavior on purpose, so any change to it is a
deliberate decision, not an accident.

**Exact parity when it matters: `configure({ strictLanes: true })`.** Some
applications (or test suites) want React-identical lane semantics for
idle-time writes too. The `strictLanes` option pins the gate to LOGGED
permanently once the React bindings register — a one-line change to the gate
predicate, no new machinery, because LOGGED mode's always-log rule already
provides exact semantics; the quiescence gate exists purely to avoid its
cost while idle. Under `strictLanes`, the setTimeout/flushSync schedule
above behaves exactly like `useState`. The same test family runs in both
configurations, asserting the loose default's documented behavior in one and
exact parity in the other.

**The two rejected gates, kept as gatekeepers.** (a) _Watcher-count gating_
("log only once a watcher is mounted") is unsound: the app's first
`startTransition(() => { atom.set(1); setShow(true) })` writes before any
watcher exists, goes DIRECT, and leaves no receipt — so the component that
mounts _during_ that transition's render (13.2's marquee case) has no older
world to read, and urgent renders leak the transition's value. (b)
_Quiescence-only gating presented as exact parity_ fails on the
setTimeout/flushSync schedule above — the write and the update it schedules
are one causal event split across lanes, and "causally prior to all future
work" does not hold for it. Both counterexamples are permanent tests: any
future write-mode-gate optimization must be pre-registered and pass both —
one asserting the loose default's documented observable behavior, one
asserting strict-mode parity (17.6).

Either way, the cost story is unchanged: the log entry is cheap (~6 Int32
stores plus one side-array store), gated at ≤2× a DIRECT write for steady
logged writes and priced separately for tape-creating writes (18.2).

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
_and_ its `batchEntryCount` reaches zero (all entries swept). Because retired
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
    notifyWalk(atom, ++walkCounter, /*collect*/ false)  // mark the cone (below)
rec = allocLog()
G[rec+META] = op | (slot << 4) | (applied ? APPLIED : 0)
G[rec+SEQ] = ticket()                      // one global counter, ++ per append
G[rec+RETIRED_SEQ] = 0
logVals[rec>>2] = payload
G[LOG_TAIL+NEXT] = rec; LOG_TAIL = rec
batchEntryCount[slot]++; if (!applied) unappliedEntries++
```

The base record is what makes the tape self-contained: every replay starts
from `logVals[base]`, so the atom's canonical value can keep moving (via
absorption) without corrupting the history older passes still need.

**Tape creation marks the cone, for every write classification.** The
moment an atom grows a tape, downstream computeds may differ between worlds
— even when the tape-creating write is _urgent_. An urgent, applied,
unretired entry is exactly what a same-event `flushSync` render (9.1) and
every `COMMITTED` read must be able to _exclude_; if the atom's downstream
cone were unmarked, `readComputed` would take the kernel path and hand those
readers the canonical value, applied entry included — a torn frame one node
downstream of a perfectly good tape. So tape creation runs a **mark-only**
notify walk (8.7.2, watcher collection off) unconditionally. Amortization:
once per atom per era — marks are monotonic until quiescence, so steady
urgent traffic to an already-logged atom never re-walks. This makes the
tape-creating write measurably heavier than a steady logged write, which is
why the write-tax gate splits the two (18.2).

Beyond that mark walk, `appendLog` notifies nobody. Broadcast — telling
watchers about the write — is a separate step that runs on _every_ write,
not just the tape-creating one; section 9.8 specifies it.

**Equality and receipts.** Where does `isEqual` fit when history exists?
The write-time equality drop is provably safe **only while the atom has no
tape** (`LOG_HEAD === 0`): a dropped entry would have carried the lowest
seq of any future tape on this atom, so every possible world's fold would
have evaluated it against the same base snapshot — evaluate the SET value
(or run the UPDATE fn / DISPATCH reducer once) against the current,
base-to-be value, and if the result is equal, _no world could ever observe
a difference_; dropping is sound, and the fast path stays O(1) for the
overwhelming majority of writes (unlogged atoms). With a non-empty tape,
**never drop**: equality is world-relative, and the value a write is equal
_to_ in the newest world may not be the value it lands on in another
world's fold. The canonical counterexample: base 0, pending transition
writes `SET 1`, then an urgent write `SET 1` arrives — equal to the newest
world's 1, but the urgent-only world (which excludes the transition) still
reads 0, and dropping the urgent receipt loses the write _from its own
world_. So logged atoms append unconditionally, and equality does its work
where worlds are known: in each world's replay fold
(`next = apply(rec, acc); acc = isEqual(acc, next) ? acc : next`,
preserving reference stability), in the broadcast cutoff (10.6, suppressing
setState — not history), and at absorption (11.2).

**Same-batch coalescing** (bounds tape growth for hot atoms during long
transitions): if the tail entry belongs to the same batch, is unretired, and
_no render pass is currently open_ (an open pass may be pinned between the
two writes), then a new SET replaces the tail record's payload and seq
in place, and a new UPDATE/DISPATCH may compose onto a tail UPDATE/DISPATCH
of the same batch (function composition is input-independent, so composing is
always sound; composition allocates one closure and is applied only after the
tape for that batch exceeds a small threshold, default 8 entries). With
coalescing, per-atom tape length is O(live batches) between passes. A
coalesced write is still a write: it goes through the same notification step
as an ordinary append (9.8).

### 9.4 Applied versus unapplied entries

- A **deferred** write (transition-like, `token & 1`) is _log-only_: the
  kernel's canonical value, staleness flags, and effects are untouched. Its
  existence is visible only through overlay marks and to readers whose world
  includes its batch.
- An **urgent** write is logged _and applied_: the same call performs the
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

1. Resolve the slot; bump `overlayEpoch` (world memos keyed on tape
   structure must re-validate — 10.5); stamp `RETIRED` + `RETIRED_SEQ =
ticket()` on every entry of that batch, by iterating `loggedAtoms` and
   walking each tape (tapes are short; this is O(total live log entries), at
   commit frequency). The same walk performs absorption:
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
     the writes are real; the flag is recorded for tracing only. Dropping
     them would mean a `startTransition(() => atom.set(x))` with no
     subscribed component silently reverts — whether a user's write persists
     must never depend on who happened to be subscribed.
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
  and remove the atom from `loggedAtoms`;
- drops world-memo records (10.5) whose world key names a retired batch, and
  trims memo chains opportunistically (memo validity is self-checking, so
  this is garbage hygiene, not correctness).

**Truncation** is the abort primitive: `truncateBatch(slot)` unlinks every
entry of a batch from every tape _without folding_, fixing up chains and
counts, and bumps `overlayEpoch` (a mid-tape unlink changes world values
without moving any tail seq — memos must re-validate; 10.5). Nothing else is
needed to abandon speculation, because speculative writes never touched
canonical state. Exposed to policy for optimistic-update
rollback APIs and used by devtools; React batches themselves never truncate
(React always retires them).

### 9.7 Quiescence: the bulk reset

When `loggedAtomCount` reaches 0 with no open pass and no live slots:

- plane G's bump pointer resets to 0 and its free list empties — the entire
  log arena is reclaimed with two integer stores;
- plane W resets the same way (record region, certificate region, and the
  `memoVals` side array), and every `slotMemoHead` is zeroed — all world
  memos die with the era; the stale node-head hazard this creates is guarded
  at lookup (7.4);
- `eraFloor = walkCounter` — every overlay mark in the graph becomes stale in
  O(1), with no walk (a mark is live only if its stored walk ticket exceeds
  `eraFloor`, and no stored ticket exceeds the counter);
- `overlayEpoch++` — one integer store that makes every surviving memo
  record structurally invalid. This bump is not optional hygiene: seq
  tickets restart at quiescence (next bullet), so seq values _repeat across
  eras_, and a memo whose certificate was recorded late in era 1 could
  otherwise match, pair for pair, a coincidentally identical tape state in
  era 2 and serve an era-old value while passing every check. The epoch is
  the one counter that never repeats within a process, so it is the
  cross-era invalidator; the quiescence postconditions (8.8, 14.3) and a
  forced-counter test (17.2) pin it;
- `seqCounter` resets to 1 — pins and retire stamps from the previous era are
  all dead, so tickets can restart, making 31-bit seq overflow unreachable in
  practice (an era would need 2^31 logged writes with no quiescent moment);
- and, when the fork also reports full React quiescence (no live or pending
  batches anywhere), `writeMode` returns to `DIRECT` — the LOGGED→DIRECT
  flip lives here and only here (9.1).

`walkCounter` does **not** reset — stale stamps larger than a reset counter
would read as freshly marked. It only grows, which gives it a real (if
remote) 31-bit horizon: one ticket per broadcast drain. The safety valve runs
at quiescence, when nothing is pinned and no mark is live: if
`walkCounter > 2^30`, iterate the main plane once, zero every
`OVERLAY_STAMP`, and reset `walkCounter` and `eraFloor` to 0. This is a
single linear pass over an Int32Array at an idle moment, needed at most once
per billion deferred-write drains; a forced-counter unit test covers it
(17.2).

This is the payoff of keeping speculation in its own plane: the common
lifecycle — interaction, transition, commit, quiet — ends with the overlay at
literally zero residue.

### 9.8 Deferred-write notification (marks and broadcast, every write)

A deferred write skips kernel propagation by design — canonical staleness
must not move for a speculative write. But two downstream obligations remain,
and they have different lifetimes, which is why this design keeps them in one
walk but lets neither gate the other:

1. **Readers must know the region may differ per world** (the overlay mark).
   This is a monotonic, era-scoped fact: once a node is marked, later writes
   below it change nothing about markedness until quiescence.
2. **Watchers must be told about _this specific write_** so they can decide —
   per the writer's world — whether to schedule a re-render (10.6). This is
   a per-write fact. A design that only walks on the _first_ write into a
   region has no path from a second write to the watchers below it: the
   region is already marked, the walk would stop immediately, and a deferred
   write triggers no kernel propagation. Concretely: transition T1 writes
   atom `a`, marking the cone and notifying watcher W in T1's lane; then
   transition T2 (a different batch) writes `a` again. Without a per-write
   walk, W never issues a setState in T2's lane, T2's render never includes
   W's component, and T2 commits a frame where W shows stale state — a
   missed-update tear. The same failure hits a _second write from the same
   batch_ whose first write was suppressed by the broadcast cutoff (the
   first write didn't change the watched value, the second one does).

The rule, therefore: **every deferred write runs the notify walk (8.7.2)
before its wrapper returns.** The walk stamps marks and collects watchers in
one pass; the wrapper then drains the broadcast list, evaluating each
watcher's watched node in the writer's world and calling `setState` only on
real change (10.6).

**When drains group, exactly.** Grouping is load-bearing (the amortization
below rests on it), so its trigger is explicit rather than assumed: a plain
write outside any engine `batch()` walks and drains in its own call stack,
before the write returns. Only an explicit engine `batch()` — including
`startSignalTransition`, which is `startTransition` plus `batch()` — defers
walks and broadcasts to the batch's close. Nothing else groups; in
particular the bindings never defer a drain to a microtask or an event
boundary, because a drain detached from every writer's scope would detach
every `setState` from every writer's lane.

**Drains run in the writing batch's lane context, by construction.** The
lane-inheritance story — "call `setState` in the writer's stack" — is
automatic for the in-stack drain, but a grouped drain runs at `batch()`
close, possibly _after_ an inner `startTransition` scope has ended:
`batch(() => { a.set(1); startTransition(() => b.set(2)) })` drains both
cones after the transition scope closed. A bare `setState` there would be
assigned the _urgent_ lane — the transition's render would then have no
update for its own watchers, skip those components, and commit a torn
frame. This is why broadcast-queue entries carry their write's token
(8.7.1): the drain sorts its entries into per-token groups and runs each
**deferred** group inside `unstable_runInBatch(token, …)` — the fork's
lane-override primitive (6.5) — so every `setState` lands in its batch's own
lanes no matter when the drain runs. A retired token (possible if a batch
closed between write and drain) returns false and the group falls back to
plain urgent `setState`, which is correct for the same reason as 13.2's
fallback: a retired batch's values are already absorbed. Token-0 (urgent)
groups run bare. One `runInBatch` call per distinct token per drain —
negligible next to the evaluations the drain already does.

**The drain's second job: re-validating the pending world's memos.** The
notify walk covers canonical topology. But a computed can depend on the
written atom _only in the pending world_ — `c = flag ? a : b` where only
world k's `flag` is true reads `a` in no canonical evaluation, so `a` has no
canonical subscribers and no walk from `a` reaches `c` or its watchers.
Those relationships are recorded in exactly one place: the writer's-world
memos that world-k evaluations created, whose certificates (10.5) name `a`.
So, after the walk, the drain re-validates registered memos:

- **Deferred drain for batch k:** walk `slotMemoHead[k]`'s chain (the memo
  records k's evaluations linked as a side effect of memo creation) and
  re-check each record's certificate — a contiguous integer scan per record.
  A k-write can only change k's own writer's world: pass worlds are pinned,
  and the newest world self-checks at read time, so slot k's chain is the
  whole obligation.
- **Urgent drain:** re-validate _every_ live deferred slot's chain — an
  APPLIED entry is visible in every writer's world ("RETIRED or APPLIED or
  batch = B", 10.2), so an urgent write changes pending worlds too.
- For each memo the check invalidates: re-evaluate the node in that world
  (memoized on the node as usual), and if the value changed, walk that
  node's subscriber list for IMMEDIATE watchers and apply the 10.6 cutoff
  per watcher — scheduling any resulting `setState` through
  `unstable_runInBatch` for that world's batch, exactly as above (detecting
  that world k changed is not enough; the bump must be _scheduled into k_,
  or k's render never restarts with it).

**Why this is complete — the first-divergence argument.** A node that has
_never_ been evaluated in world k has no memo to re-validate; can it be
stale at k's commit? No. Its k-evaluation and its canonical evaluation run
the same deterministic function, so they read identical inputs up to the
first atom whose k-value differs from its canonical value — and that
first-divergence atom _is_ read canonically, i.e., it is a canonical
dependency, so the write that made it diverge reaches the node through the
ordinary canonical walk, notifies its watchers, and the k-evaluation that
follows creates the memo whose certificate registers the node in slot k's
chain. From then on, the drain re-validation covers every subsequent
divergent-dep write. Canonical walks catch the first divergence; the slot
chains catch the rest. (The argument leans on computed purity — already a
contract — and on certificates recording every read, 10.5.)

Cost containment, since this walk is the overlay's most-repeated act:

- **One walk ticket per drain, shared across a write group.** The walk for
  all writes in the group runs at drain time with a single fresh ticket:
  `walkCounter++` once, then `notifyWalk(atom, walkCounter, true)` per
  written atom. Overlapping cones dedup against the shared ticket, so a
  50-write transition over one region walks the region once, not 50 times.
  Watchers are collected once and evaluated once per drain against the
  writer's world — which now includes all 50 writes.
- **The walk is pure integer traversal** — no user code, no allocation,
  same cost class as the kernel's own `propagate` over the same cone. The
  expensive part is never the walk; it is the per-watcher world evaluation,
  which is memoized per (node, world) and shared across watchers of the same
  node (10.5–10.6).
- **The re-validation is bounded by touched nodes, not watchers.** A slot's
  chain holds one record per _distinct node actually evaluated in that
  world_ — memo sharing already collapsed fan-out — and transitions touch
  few nodes. Same cost class as the walk itself; the fan-out benchmark
  gains a registered-node dimension so this is priced, not presumed (18.2).
- **Priced, not presumed.** The full deferred-write cost — walk, broadcast
  evaluations, and chain re-validation — is measured on day one of the
  overlay milestone and carries a pre-registered gate (≤N× a DIRECT write
  for the standard fan-out shapes, N recorded at that milestone with a
  provisional ceiling of 3×; section 18.2). If the measured cost breaks the
  ceiling, the fallback is also pre-registered: an "always broadcast, let
  React bail out" mode that skips the world evaluation and lets the
  watcher's render-time world read discover no-change (React's own bailout
  then prunes the render) — a slowness trade, never a correctness one. If
  the _chain scan_ is what breaks the ceiling, the pre-registered escalation
  is an ephemeral (source-atom, world) → consumer edge plane with the same
  quiescence-reset lifecycle — displacing the chain design on measurement,
  never on taste.

Urgent writes skip the walk but not the drain duties: they apply through the
kernel, so `propagate` reaches watchers via the broadcast list (8.7.1) and
marks are already maintained (tape creation marked the cone, 9.3; new edges
repair via 8.7.3) — but their drain still runs the every-live-slot memo
re-validation above, because applied entries change pending worlds. The
two-batch scenario, its same-batch cutoff variant, the divergent-dep
scenarios, and the urgent/deferred interleavings are pinned as unit
scenarios in 17.3–17.4 and generated at random by the oracle fuzz in 17.2.

---

## 10. View resolution

### 10.1 Read contexts

Every read resolves in one of four contexts. The context is a module scalar,
not a parameter — reads stay zero-argument bound calls.

| context         | active when                                                                                                                                       | world                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `RENDER`        | while React is _executing_ render code: from `onRenderPassStart` to `onRenderPassEnd`, minus yield gaps (below)                                   | Wp: pin + include mask                                           |
| `NEWEST`        | default: event handlers, timers, core effects, benchmarks, computed evaluation outside render — including all code running in a pass's yield gaps | Wn: everything visible                                           |
| `COMMITTED`     | inside `useSignalEffect` callbacks (and SSR)                                                                                                      | the root's committed view (13.4); globally, retired entries only |
| kernel-internal | inside `checkDirty`/`update` walks                                                                                                                | W0 by construction (the kernel only ever sees applied state)     |

**The scalar is kept correct by edges, including yields.** A time-sliced
pass stays _open_ across yields to the event loop, but the code that runs in
those gaps — click handlers, timers, settled promises — is not render code:
its reads must resolve `NEWEST` (a handler deciding on a stale pinned world
would misbehave) and its writes must be legal (10.8 makes render-context
writes throw; an urgent write from a handler during a background render is
the design's flagship scenario, not an error). Since reads deliberately
never consult the fork, the bridge flips the context scalar on the fork's
yield/resume edges (6.3): `RENDER → NEWEST` at `onRenderPassYield`,
`NEWEST → RENDER` at `onRenderPassResume`. The pass set — pin, include mask,
serial, lineage — persists untouched across yields, so resumed render reads
still resolve the pass's world exactly. Debug builds assert
`getRenderContext() !== undefined` whenever a read actually runs in
`RENDER` context.

### 10.2 The visibility rule

For a pass with pin `P` and include mask `I`, a log entry `e` is **visible**
if and only if either:

1. **It retired before the pass started:** `e.RETIRED` is set and
   `e.RETIRED_SEQ <= P`; or
2. **The pass includes its batch and the write predates the pass:**
   `I` has bit `e.BATCH_SLOT` and `e.SEQ <= P`.

Each clause mirrors a rule React applies to its own hook queues: clause 2 is
the lane filter (a transition render applies transition updates and skips
urgent ones, and vice versa); the `<= P` conditions mirror React's rule that
updates arriving during a render are hidden from it and picked up by the
next one. Clause 1 keying on _retire time_ rather than write time is what
keeps a paused-and-resumed pass stable: if another root commits (and folds)
while this pass is yielded, the fold's stamp exceeds this pass's pin, so this
pass keeps reading what it started with.

`NEWEST` visibility: every entry. `COMMITTED` visibility, in its global
form: `RETIRED` entries only (regardless of stamps; APPLIED-but-pending
entries are _excluded_, which is what makes `useSignalEffect` observe only
committed worlds). Commits, however, are per root — a batch spanning two
roots commits on one while still pending on the other — so the bindings
refine `COMMITTED` into a **per-root committed view**: entries retired with
`RETIRED_SEQ` at or below the root's last-commit ticket, plus entries of
batches that root has committed while they stay pending elsewhere (the
fork's lock-in set, 6.2). Section 13.4 owns the mechanics; SSR and any
rootless committed read use the global form.

**Writer's world** (used by broadcast, 10.6, and the post-subscribe fixup,
13.2): for a write in batch `B`, visibility is "RETIRED (any batch), or
APPLIED, or batch = B" — committed state plus urgent-pending plus the writing
batch's own entries. This is the world the batch's own render will show, so
it is the right world for deciding whether that render needs a component.

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
      next = apply(rec, acc)    // SET: payload; UPDATE: fn(acc);
                                // DISPATCH: reducer(acc, action)
      acc = isEqual(acc, next) ? acc : next   // equality inside the fold,
                                              // preserving reference
                                              // stability (9.3)
  return acc
```

If no entry beyond the base is visible (a pass pinned before the tape
existed, after an absorption moved the canonical value), the answer is the
base snapshot — _not_ the kernel value. That is the tear-prevention case.

Tracking: in `NEWEST`/`COMMITTED` contexts, tracked reads link normally
(`link(a, activeSub, cycle)`). In `RENDER` context, component-level reads run
untracked (subscription is a commit-time concern, section 13.2), and
overlay-world computed evaluations are untracked too (10.5) — so **render
never mutates graph topology**, which is what makes discarded/replayed
renders free of side effects.

### 10.4 Overlay marks: the computed fast path

A computed whose transitive inputs have no live logs cannot differ between
worlds, so any context may take the kernel path (normal `checkDirty` +
cached value). The overlay mark (stamped by the notify walk 8.7.2, repaired
by 8.7.3, cleared in bulk by raising `eraFloor`) is a conservative "may
differ" bit:

```
readComputed(c, ctx):
  if loggedAtomCount == 0 or M[c+OVERLAY_STAMP] <= eraFloor:
      v = kernelComputedRead(c)                        // the fast path
      // post-eval re-check: did this evaluation's own dependency linking
      // just mark c (8.7.3)? Only possible if the kernel path recomputed.
      if worldSensitive(ctx) and M[c+OVERLAY_STAMP] > eraFloor:
          return overlayEvaluate(c, ctx)
      return v
  if ctx == NEWEST and unappliedEntries == 0:
      return kernelComputedRead(c)   // Wn == W0 when nothing is unapplied
  return overlayEvaluate(c, ctx)
```

Marks over-approximate (a marked computed might still be world-identical);
the cost of a false positive is one overlay evaluation — and usually less,
because of the world memos below — never a wrong answer.

**The post-eval re-check closes a one-read window.** The mark-repair hook
(8.7.3) fires when a canonical evaluation _links_ a logged or marked
producer — which is necessarily after `readComputed` already chose the
kernel path on the strength of an unmarked stamp. Two reachable shapes hit
that window: a freshly created computed (a `useComputed` mounting during a
transition render — stamp 0, no walk ever visited it) whose first evaluation
reads a deferred-written atom, and an old computed whose canonical
re-evaluation takes a _new branch_ into a logged atom mid-era. In both, the
kernel evaluation is correct **canonical** maintenance (its cache and
topology stand), but its answer is W0 — wrong for a world-sensitive reader.
So, in world-sensitive contexts (`RENDER`, `COMMITTED`, writer's-world
evaluation, and `NEWEST` while `unappliedEntries > 0`), when the kernel path
actually ran an update, the stamp is re-checked after the read: if repair
marked the node during the evaluation, the returned value is discarded for
this reader and `overlayEvaluate` answers in the caller's context. Cost: one
Int32 load and compare on a path that just ran a user recomputation (noise);
zero on the memo and cached fast paths.

### 10.5 Overlay evaluation and world memos

`overlayEvaluate(c, ctx)` re-runs the computed's function with reads
resolving in `ctx`, **untracked** (canonical dependency lists must reflect
canonical evaluation only — a speculative world may take different branches,
and letting it re-track would corrupt the canonical graph's topology for
everyone). Nested overlay evaluation (a marked computed reading another
marked computed) recurses with the same context — depth equals graph depth
exactly as in the kernel.

Uncached, this is the overlay's cost cliff: a transition held open for
seconds (data loading, a long animation) keeps the marked cone marked the
whole time, and if every read in that cone re-ran the function, a hot
read loop would degrade to recompute-per-read for the transition's entire
life. So overlay evaluations are **memoized per node per world**, with a
validity rule precise enough to survive ongoing appends. This memo is
mandatory core design, not an optimization to bolt on later; the gate in
18.2 (marked-cone reads ≤1.5× DIRECT while a batch is live) is unmeetable
without it.

**The memo record.** Each overlay evaluation of computed `c` in world `w`
writes one packed record into plane `W` (field table in 7.4): the world key,
the `overlayEpoch` at evaluation time, the owning node, the value (via a
`memoVals` slot), the node-chain and slot-chain links, and a **certificate**
— `NDEPS` pairs of `(atomId, seqOrZero)` in the plane's certificate region,
one pair for **every atom the evaluation read** in that world, where
`seqOrZero` is the atom's tape-tail seq at read time (`G[M[a+LOG_TAIL]+SEQ]`)
if the atom was logged then, else 0.

Two properties of the certificate are load-bearing:

- **It is the re-observed dependency set.** The atoms this world's
  evaluation actually touched can differ from the canonical dependency list
  (a world where a feature flag is on reads different inputs than the
  canonical world where it is off). Keying validity on the re-observed set
  is what makes a same-batch follow-up write to a world-only dependency
  invalidate the memo — the tear class that sinks designs which derive
  invalidation from one world's topology while serving another world's cache
  (tested exhaustively in 17.4).
- **It records unlogged reads too, as zeros.** Worlds diverge down branches
  whose atoms may have _no tape yet_ — in the flag/a/b shape, world k reads
  `a` while `a` is still unlogged, and `a`'s tape is created only by the
  _later_ write that must invalidate this very memo. A certificate that
  recorded only logged atoms would omit exactly the reads that make worlds
  diverge, and the "must have been invalidated" reasoning would be false at
  its most important test. With the zero convention, validity is uniform:
  `(LOGGED(aᵢ) ? tailSeq(aᵢ) : 0) === seqOrZeroᵢ` — an atom that gained a
  tape since the evaluation mismatches (`0 ≠ tail`) and invalidates.

**Collecting the certificate.** During `overlayEvaluate`, the read wrapper
appends each read's `(atomId, seqOrZero)` to a persistent scratch
`Int32Array` (`certStack`) with saved per-frame bases — the same discipline
as the traversal stacks. Nested evaluation frames make flattening a
base-index rule rather than a bookkeeping problem: an inner overlay
evaluation's span simply remains appended beneath **every open frame's**
base, so a parent's certificate automatically contains its child's reads;
and when a nested read _hits_ a child memo instead of evaluating, the child
record's certificate run is copied into the collector. This flattening is
required, not optional: certificates validate one record at a time, so a
parent whose certificate omitted grandchild sources would stay "valid" after
a grandchild-source append invalidated the child — and a parent-level read
would serve the stale composition. The record and its certificate run are
written once, at frame exit.

**World keys** (disjoint integer encodings):

| world                              | key                |
| ---------------------------------- | ------------------ | --- |
| newest (Wn)                        | `0`                |
| a render pass's world (Wp)         | `(passSerial << 2) | 1`  |
| a writer's world for batch token t | `(t << 2)          | 2`  |

Writer's-world records additionally link themselves onto their batch slot's
memo chain (`SLOT_NEXT`, heads in `slotMemoHead`) as a side effect of memo
creation — this is the registry the drain re-validation walks (9.8), and it
needs no separate bookkeeping or dedup state: re-memoizing a (node, key)
tombstones the old record and links the new one.

**Validity.** A memo record answers a read when its `KEY` matches the
reader's world, its `EPOCH` equals the current `overlayEpoch`, and:

- **Pass worlds: key and epoch match suffice.** A pass's world cannot change
  mid-pass: new appends carry seqs above the pin (invisible by 10.2), and
  retirements stamp `RETIRED_SEQ` above the pin (clause 1 fails; clause 2's
  answer for included batches is unchanged). Each pass start bumps
  `passSerial`, so a restarted pass — which may legitimately see newer
  state — misses the old memos by key. Two integer comparisons, no
  certificate scan.
- **Newest world and writer's worlds: key and epoch match plus the
  certificate scan.** One contiguous forward pass over the pairs:
  `(M[aid+FLAGS] & LOGGED ? G[M[aid+LOG_TAIL]+SEQ] : 0) === seqOrZero` for
  each. Any mismatch — a new append, a coalesce (which rewrites the tail
  seq), an absorption that swept the tape, an atom becoming logged —
  invalidates the record, and the read re-evaluates and re-memoizes. The
  scan is monomorphic integer loads with no pointer chasing; transitions
  touch few atoms, so certificates are short, and this scan _is_ the inner
  loop the held-open-transition gate prices (18.2).

Why the epoch exists: appends move a tape's tail seq and tape creation flips
a flag, but three events change world values _without_ doing either —
**retirement** (stamping RETIRED on batch entries makes them visible in
_other_ batches' writer's worlds and in the newest-world's committed
component), **truncation** (unlinking a mid-tape entry leaves the tail
untouched), and **promise settlement** (a thenable settling moves no atom's
tape, yet a writer's-world memo holding a suspended box for it is now
stale — pass worlds are rescued by React's own retry re-render, but
writer's-world cutoff memos have no such rescue). All three bump
`overlayEpoch` (9.5, 9.6, 12.3), wholesale-invalidating memos at
commit/abort/settle frequency — cheap, conservative, and it keeps the
high-frequency event (appends during a held-open transition) on the precise
certificate scan. The quiescence reset bumps it too, for the cross-era
reason given in 9.7.

The combined check is deliberately one-sided: it may re-evaluate
unnecessarily (an append to a source atom in an unrelated batch invalidates
a newest-world memo that would have folded to the same value) but can never
serve a stale value: any event that could change the answer in world `w`
must either move a certificate pair (append, coalesce, sweep, tape
creation on a zero-pair atom) or bump the epoch (retirement, truncation,
settlement, quiescence).

**Storage and hygiene.** The node's memo-chain head lives as an integer in
the `memos` side slot, guarded against plane resets by the `NODE` check
(7.4); the node field `MEMO_KEY` mirrors the first record's key so the
common "same world reads the same node repeatedly" case hits with one Int32
load before touching plane W. Chains are short (one live record per world
that actually read the node — in practice: the newest world, one or two pass
worlds, a writer's world or two). Re-memoization tombstones the superseded
record (`EPOCH = 0`, `memoVals` slot cleared); sweep trims records whose key
names a retired batch or a closed pass; the plane resets wholesale at
quiescence (9.7), when the read gate stops consulting marks entirely.
Mid-evaluation allocation follows the same watermark-slack rule as the other
planes: allocate from slack, grow only at operation boundaries (14.1).

Within one render pass, each marked computed therefore evaluates at most
once no matter how many components read it; across passes, evaluation
re-runs (matching React, which re-renders those components anyway). Because
renders are read-only, discarding a pass discards nothing but memo entries —
that, plus log truncation, is the entirety of "abort" in this design.

Suspense inside overlay evaluation uses the per-world thenable cache
(section 12.3) so promise identity is stable across replays of the same
world.

### 10.6 Broadcast worlds (why watchers don't over- or under-notify)

When a logged write propagates (urgent, via kernel) or is drained (deferred,
via the notify walk of 9.8), watchers subscribed to affected nodes must
decide whether to `setState`. The rule: a watcher broadcasts if and only if
its watched node's value **in the writer's world** (10.2) differs — by the
node's equality policy — from the last value it broadcast (or rendered) for
that world, memoized per world in the watcher's meta (`lastBroadcast`).

Cost: one overlay evaluation of the watched node on the writer's world at
write time — work the imminent render would do anyway, and it prevents
render storms for equal-value writes (graph-level cutoff, matching the
kernel's own cutoff semantics). The evaluation is memoized **on the node**,
not the watcher (10.5, writer's-world key), so a thousand watchers of one
computed share one evaluation per drain; the per-watcher residue is an
equality compare against `lastBroadcast`. This memo-sharing is the designed
answer to wide fan-out on the write path, and the whole path is gated at
≤N× a DIRECT write (18.2).

For unmarked nodes (no overlay anywhere below), the same rule runs without
overlay evaluation: the "evaluation" is the plain kernel read (which
pull-verifies through `checkDirty`), compared against `lastBroadcast` as
usual. The comparison is not skippable even here, because the broadcast
queue is filled at _possibly-stale_ time — `propagate` enqueues watchers
before anyone knows whether the change survives the equality cutoff — and
`setVersion` always changes hook state, so an unconditional broadcast would
re-render on equal-value writes, the exact storm this section exists to
prevent.

A third broadcast source joins these two: the drain's slot-chain
re-validation (9.8) broadcasts to watchers of nodes whose _pending-world_
value changed — nodes the canonical walk cannot reach when the dependency
exists only in that world. Those broadcasts run the same per-watcher cutoff,
against the same node-level memo, scheduled into the pending batch's lanes
via the entanglement API.

### 10.7 Worked example: the rebase walkthrough

State: `a = 1` (atom). A transition writes `a.update(x => x + 1)`; while it
is pending, an urgent click writes `a.update(x => x * 2)`.

Tape after both writes (base seq 10):

| record | op           | batch        | seq | applied | retired     |
| ------ | ------------ | ------------ | --- | ------- | ----------- |
| base   | BASE `1`     | —            | 10  | —       | yes (at 10) |
| e1     | UPDATE `x+1` | T (deferred) | 11  | no      | no          |
| e2     | UPDATE `x*2` | U (urgent)   | 12  | yes     | no          |

Kernel value (W0) = base + applied = `1*2 = 2`.

- **Urgent render** (includes U, not T; pin 13): visible = base, e2 →
  `1*2 = 2`. The click's doubling shows; the transition stays invisible.
  React commits; U retires; e2 stamps RETIRED_SEQ 14. Absorption fold =
  base + retired(e2) + applied() = `2` — unchanged, no-op.
- **Transition render** (includes T; pin 15): visible = base,
  e1 (clause 2), e2 (clause 1, retired at 14 ≤ 15) → replay in seq order:
  `(1 + 1) * 2 = 4`. The transition lands _on top of_ the urgent change.
- T retires: fold = `(1+1)*2 = 4`; kernel value moves 2 → 4 via
  `invalidate`; effects observe committed 4. Sweep folds everything into the
  base; tape frees; quiescence resets the overlay.

`4` is exactly what two queued `useState` updaters produce in React — the
side-by-side `ReducerAtom`-vs-`useReducer` conformance test (17.6) pins this
equivalence across held-open transitions. Note the property that makes the
fold trustworthy: functional entries are never dropped or pre-evaluated —
they replay, in seq order, over whatever base the world provides. A design
that applied-and-discarded the urgent updater would fold T's retirement to
`1+1 = 2`... then re-apply nothing, committing 2 or 3 where React commits 4.

### 10.8 Purity of render worlds

Writes during `RENDER` context throw, unconditionally (React may replay or
discard the pass; a write from a replayed render would double-fire). This is
independent of `configure({ forbidWritesInComputeds })`, which governs
canonical evaluation contexts only.

---

## 11. The kernel/policy cut

The precise line between mechanism (kernel + overlay memory) and policy
(everything users can configure). The test for every future feature: _if it
inspects a user value, a user option, or React, it is policy; if it is
integer math over the planes, it is mechanism._

### 11.1 The cut, operation by operation

| operation     | mechanism (kernel/overlay)                                                                  | policy (kinds/React layer)                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| create        | record allocation, flags init                                                               | handle construction, meta allocation, wrapper synthesis                                                            |
| tracked read  | `link` cursor/splice, flags checks                                                          | read-context selection, log replay payload application                                                             |
| write         | pending-value slot, `propagate`, broadcast/effect queues, notify walk                       | equality short-circuit, log append decision, deferred/urgent classification                                        |
| recompute     | `checkDirty` walk, `update` call, `!==` compare, `shallowPropagate`                         | what "evaluate" means: ctx, isEqual, error/suspense capture (all inside the stored wrapper fn)                     |
| notify        | queue discipline, outer-before-inner order, IMMEDIATE routing                               | watcher broadcast rule (world evaluation + cutoff + setState)                                                      |
| log lifecycle | record packing, chains, slots, seq tickets, visibility _mask_ math, sweep/truncate splicing | replaying payloads (SET/UPDATE/DISPATCH semantics), absorption equality, when to absorb (retirement orchestration) |
| world memos   | plane-W records, certificate packing/scan, chain and slot-chain threading                   | what gets memoized (evaluation results, boxes); when the drain re-validates (9.8)                                  |
| liveness      | LIVE bit maintenance                                                                        | observed-lifecycle effect delivery, debouncing                                                                     |
| memory        | bump/free/growth/reclaim, generation counters                                               | FinalizationRegistry wiring for handles, configure() sizing                                                        |

Two non-obvious choices make this cut clean and fast:

### 11.2 Custom equality without a kernel branch: return the old reference

The kernel compares recompute results by identity (`old !== new`). Custom
equality never touches the kernel: the computed's stored function is a
**wrapper** (synthesized by the policy layer at construction) that receives
the previous value and — when `isEqual(prev, next)` holds — **returns the
previous reference**. The kernel's identity compare then correctly reports
"unchanged". The same trick serves error and suspense states (11.3): the
wrapper returns the _same_ box object while the state is unchanged.

Atoms: `isEqual` runs in `Atom.set`/`update`/`dispatch` before anything is
logged or written (compare against the newest-world value), and again at
absorption when deciding whether the fold moved the committed value. The
kernel's own `!==` on the pending-value slot stays as a second, free line of
defense.

Result: zero policy bits in kernel flags, zero extra kernel branches, and the
kernel's hot loops stay monomorphic. Plain computeds (no options) get a
minimal wrapper; the wrapper layer costs one extra call frame per actual
recomputation — recomputations run user code anyway, so the relative cost is
noise (validated in the shapes harness before committing to this cut; see
18.5).

### 11.3 Sentinel boxes

Computed evaluation outcomes are values, never control flow through the
graph:

```ts
type ErrorBox = { kind: "error"; error: unknown }
type SuspendedBox = { kind: "suspended"; thenable: PromiseLike<unknown> }
```

The wrapper catches throws and pending `ctx.use` thenables and returns a box;
the box is cached like any value (and reference-stable while the state is
unchanged, per 11.2). Policy read sites unbox: `Computed.state` rethrows
errors; React read sites suspend on `SuspendedBox` via React's `use`
(section 13.2); core effects treat a box read as an error to surface. Flags
can never be corrupted by a throwing getter because the kernel never sees the
throw. Boxes are policy vocabulary — the kernel treats them as opaque values.

### 11.4 The placement table: where every future feature lands

The cut's thesis in one table. The kernel column is tiny and closed;
everything a product engineer will ever ask for lands in the overlay, the
policy kinds, the React bindings, or the fork. When a new requirement
arrives, find its row (or its nearest neighbor) before writing code — a
feature with no natural row is a design smell to resolve in review, not in
the kernel.

| concern                                                      |      kernel      |     overlay      |   policy kinds   |         React bindings          |        fork        | why there                                                                                                                 |
| ------------------------------------------------------------ | :--------------: | :--------------: | :--------------: | :-----------------------------: | :----------------: | ------------------------------------------------------------------------------------------------------------------------- |
| Dependency tracking, staleness, exact recompute order        |        ●         |                  |                  |                                 |                    | The hot walks; must stay packed and monomorphic. The only pure-kernel row.                                                |
| Write logging, visibility, absorption, sweep                 |                  |        ●         |                  |                                 |                    | Multi-versioning is tape math over plane G; the kernel gets memory mechanics only (8.7.5).                                |
| Notify walk, marks, era floor                                |     ● (walk)     |     ● (when)     |                  |                                 |                    | The walk is integer traversal (kernel mechanism); _when_ to walk is overlay policy (9.8).                                 |
| World memos                                                  |                  |        ●         |                  |                                 |                    | Validity is integer seq math; contents are opaque values.                                                                 |
| Atom/ReducerAtom/Computed classes, `set`/`update`/`dispatch` |                  |                  |        ●         |                                 |                    | Value semantics are policy; kernel sees invalidate/update facts only.                                                     |
| Equality (`isEqual`, cutoffs)                                |                  |                  |        ●         |                                 |                    | User closures never enter kernel call sites (11.2).                                                                       |
| Promises / suspense (`ctx.use`)                              |                  |                  |        ●         |                ●                |                    | Thenable protocol is value policy (12.3); suspending a component is a binding concern (13.2).                             |
| Atom observed-lifecycle `effect`                             |                  |                  |        ●         |                                 |                    | Driven by kernel LIVE-bit facts (8.6, 12.4).                                                                              |
| Effect queue and flush timing                                |        ●         |                  |        ●         |                ●                |                    | Queue mechanics are kernel; "when reactions run" is policy; passive-effect timing rides React (13.4).                     |
| Batch identity and lifecycle                                 |                  |    ● (slots)     |                  |        ● (orchestration)        |     ● (tokens)     | Fork mints integer tokens (6.2); overlay interns slots (9.2); bindings orchestrate retirement (13).                       |
| Batch entanglement                                           |                  |                  |                  |            ● (uses)             |    ● (provides)    | Only the reconciler knows lanes (6.5); only the bindings know when a fixup needs it (13.2).                               |
| Hooks (`useSignal` …)                                        |                  |                  |                  |                ●                |                    | Hook protocol, watcher lifecycle, fixups (13).                                                                            |
| Transitions / `startTransition` parity                       |                  |     ● (logs)     |                  | ● (broadcast in writer's stack) | ● (classification) | Fork classifies writes (6.4); overlay logs/rebases; bindings inherit lanes (13.1).                                        |
| Infinite-loop rejection                                      |                  |                  |        ●         |                ●                |                    | React's own guards via real setState; engine cycle checks for signal-only loops (4.7).                                    |
| Writes-in-computeds toleration + forbid switch               |  ● (detection)   |                  |    ● (choice)    |                                 |                    | Cycle detection is graph mechanism (RECURSED flags); forbidding is configuration (12.5).                                  |
| Multiple roots, SSR/hydration                                |                  |                  |                  |                ●                |         ●          | Containers from fork; recipes in bindings (13.7–13.8).                                                                    |
| Tracing and causality                                        | ● (traced build) | ● (choke points) |        ●         |                ●                |                    | Tape append + overlay read are the two semantic choke points (16.2); kernel detail via the generated traced build (16.5). |
| Graphviz renderers                                           |                  |                  |        ●         |                                 |                    | Read-only iteration over planes + labels (16.4).                                                                          |
| DOM mutation window                                          |                  |                  |                  |                                 |         ●          | Pure React-commit concern (6.6).                                                                                          |
| Growth and reclamation                                       |        ●         |        ●         | ● (Finalization) |                                 |                    | Kernel: free lists, rebuild, generations. Policy: handle lifetime (14).                                                   |
| Labels, devtools formatting                                  |                  |                  |        ●         |                                 |                    | Debug metadata; never on a hot path (16.3).                                                                               |

The kernel column changes only if the graph algorithm itself changes — and
that is exactly the code this project wants frozen, proven, and monomorphic.

---

## 12. Signal kinds and promise handling

How the three public kinds sit above the kernel. Each kind is: a handle
class, a meta record (only if it has options), and rules for the three policy
sites (write, replay, recompute).

### 12.1 Atom

- `set(v)` → DIRECT: equality gate, then kernel write. LOGGED: equality
  gate only if the atom has no tape (the `LOG_HEAD === 0` rule of 9.3);
  otherwise append SET unconditionally (+ apply if urgent), then notify per
  9.8.
- `update(fn)` → the _function_ is the payload (never pre-evaluated in LOGGED
  mode): worlds replay it against their own accumulator, which is how
  functional updates rebase (10.7). In DIRECT mode it evaluates immediately
  (no worlds exist to disagree).
- Reads resolve per context (10.3).

### 12.2 ReducerAtom

Identical machinery to Atom with `dispatch(action)` appending DISPATCH
records; replay applies `meta.reducer(acc, action)`. The reducer is fixed at
construction, so replays are deterministic given the tape — the property the
useReducer-parity test (17.6) verifies. `dispatch` in DIRECT mode applies the
reducer immediately and kernel-writes the result.

**The purity contract for updaters and reducers.** An `update(fn)` function
and a reducer are replayed once per world that includes them and once more
at absorption — at times and in read contexts the author cannot predict. The
contract is therefore strict and simple: **a pure function of its arguments
and immutable captures.** Reading other signals from inside an updater or
reducer is unsupported — the read would observe whatever world happens to be
live at replay time, which is exactly the nondeterminism the tape exists to
prevent. (Reading signals _before_ the write and capturing the values is
fine; that pins them.) Impure updaters are user error, the same contract
React documents for its own updater functions; the library adds no defensive
machinery, but debug builds assert the contract by tripping on any tracked
read that occurs during a replay.

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
- **Positional identity cache, keyed by render lineage:** the meta holds
  `thenableCache: Map<cacheKey, PromiseLike<unknown>[]>` where `cacheKey` is
  0 for canonical evaluation and the pass's **render lineage** (6.3) for
  render-world evaluation. The N-th `ctx.use` call under a given key always
  returns the same thenable across re-evaluations — this is what makes
  suspend/replay converge instead of re-fetching forever. The key must
  satisfy two constraints that rule out the obvious candidates: it must be
  **stable across passes** (React's suspend-and-retry re-renders arrive as
  _new_ passes, so a per-pass key would re-fetch forever) and it must
  **identify the whole world** (a pass legitimately renders several
  entangled batches — a single batch token under-identifies it, and two
  different mask-worlds keyed alike would alias each other's promises).
  The lineage is exactly the fork-provided identity with both properties:
  one integer per logical piece of render work, redelivered across restarts
  and retries, retired with the work. Lineage entries are dropped when the
  fork stops delivering that lineage (its work committed or was abandoned);
  the canonical entry is dropped when the computed settles to a
  non-suspended value. Writer's-world broadcast evaluations (10.6) never
  call `ctx.use` speculatively — a suspended box in a writer's-world memo
  simply compares unequal-or-equal like any value.
- **Settlement wake-up:** when a thenable that suspended the _canonical_
  evaluation settles, the policy layer calls kernel `invalidate(c)` in a
  microtask (if the computed still caches that SuspendedBox): watchers
  re-render, effects re-run, the wrapper re-evaluates and now sees the
  settled status. Pass-world suspensions need no engine action: React's own
  `use` machinery re-renders the lineage when the promise settles, and the
  re-render re-evaluates through the same lineage-keyed cache. Settlement of
  any thenable that a live overlay memo captured also bumps `overlayEpoch`
  (10.5): nothing else would invalidate a writer's-world memo holding the
  suspended box, since settling moves no atom's tape.

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
import it subscribes to the external runtime (6.1) and wires the callbacks:

- `onRenderPassStart(container, tokens, lineage)` → `passOpen = 1;
passSerial++; passPin = seqCounter; passIncludeMask = internAll(tokens);
passContainer = container; passLineage = lineage` — and switch the read
  context to `RENDER`. Batch-open edges also flip `writeMode` to `LOGGED`
  if it was not already (9.1).
- `onRenderPassYield(container)` / `onRenderPassResume(container)` → flip
  the read context `RENDER ↔ NEWEST`; the pass set persists (10.1).
- `onRenderPassEnd(container)` → close the pass, restore `NEWEST`, run a
  sweep (9.6).
- `onBatchCommitted(container, token)` → update the container's committed
  view (13.4) and flush that root's `useSignalEffect` watchers in a
  microtask, filtered by that view.
- `onBatchRetired(token, committed)` → retirement + absorption (9.5); the
  quiescence check may then revert `writeMode` to `DIRECT` (9.7).
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
pass's world Wp) and return it. A mount _during_ a transition render
therefore reads the pending world directly — no double render, no guessing;
this is the scenario stock-React userland provably cannot handle (the
known-bug test we inherit and turn green, 17.6). If the value is a
`SuspendedBox`, call React's `use(thenable)` — a conditional `use` is legal —
so Suspense fallbacks and replays behave exactly as for a suspending
`useState` initializer.

Commit phase (layout effect): create/rebind the watcher node and link it to
the signal, then run the **post-subscribe fixup** for writes that raced into
the gap between render and subscription. The watcher remembers the world
(pin + include mask) and value it rendered with; both checks are
**world-aware** — they re-resolve the node and compare values, never
compare world identities, because "the committed value moved past what we
rendered" is _expected_, not a race, whenever the rendered world included a
still-pending batch (this component just rendered inside transition k's
pass; committed state excludes k by definition — a literal
committed-vs-rendered comparison would fire a spurious correction on every
such mount):

- **Did this component's own world move?** Re-resolve the watched node in
  the watcher's remembered rendered world, _now_, and compare with the
  remembered value (by the node's equality). A difference means something
  raced into the gap that the rendered world would have shown — an urgent
  write, an absorption. Correct it with `setVersion` immediately, in the
  layout effect's own (urgent) context — a pre-paint correction, the same
  shape React uses for its own layout-effect updates. If the rendered
  world's batches have all retired (the world is no longer resolvable), the
  committed-value comparison is the correct degenerate form and is used as
  the fallback.
- **Did a pending world this component missed move?** For each live
  deferred batch slot whose tape entries affect the watched node, evaluate
  the node in that batch's writer's world (10.2, memoized per 10.5) and
  compare with the rendered value. For each batch where the value differs,
  issue the corrective `setVersion` through the fork's batch-entanglement
  API: `unstable_runInBatch(token, () => setVersion(bump))`. The correction
  is thereby assigned to the pending batch's own lanes — it renders with
  that batch and commits in that batch's frame (6.5). If `runInBatch`
  returns false, the batch retired between our check and the call; its
  values are already absorbed into committed state, so the first check
  covers it — the fixup re-runs the first comparison and falls back to that
  path.

Why `startTransition` around the corrective setState would be wrong, and why
entanglement is required: a fresh `startTransition` mints a _new_ batch with
its own lanes and its own commit. React would be free to commit the original
batch first — without this component's correction — and paint a frame where
sibling components show the transition's world and this component shows the
world it rendered a beat too early. The entangled update cannot exhibit that
frame: it is in the original batch's lanes, so that batch's render includes
it and that batch's single commit carries it. The test in 17.6 holds a
transition open, mounts a late subscriber, and asserts exactly one commit,
containing both the transition's updates and the correction.

Both fixup checks compare against the watcher's remembered render world;
they fire only in genuine race windows. Unmount: unlink the watcher;
liveness sweeps run post-commit.

### 13.3 `useComputed(fn, deps, options?)`

A component-local `Computed` held in a `useState` holder, recreated when
`deps` change (compared like `useMemo`). `fn` closes over props/state freely
— that is exactly what `deps` re-creation handles; signal reads inside `fn`
are auto-tracked by the graph (in canonical contexts) and resolved per-world
during passes. Subscription and reads then work exactly like `useSignal` on
the local node. Disposal on unmount (and holder replacement) frees the
record deterministically.

### 13.4 `useSignalEffect(fn, deps?)` and per-root committed views

A passive-effect-scheduled graph watcher over **committed** state: the
callback runs after commit, reads in `COMMITTED` context, and re-runs when
(a) `deps` change (React pathway) or (b) the committed value of anything it
tracked changes (engine pathway, flushed in a microtask after the owning
root's commit — "after commit", matching `useEffect`'s contract). Cleanup
supported.

"Committed" here is **per root**. Commits are per-root events: a batch
spanning two roots commits on root A while still pending on root B, and at
that moment root A's effects must see the batch's values (root A's DOM
already shows them — reading older state would put the effect behind its own
root's screen) while root B's effects must not (nothing committed there
yet). The global retired-only view can express neither side of that moment.
So the bridge keeps a small per-container table, updated on
`onBatchCommitted(container, token)` (6.1):

- `committedPin[container]` — a fresh seq ticket taken at that root's
  commit; entries retired at or below it are in the root's committed view;
- `committedMask[container]` — the batch slots this root has committed while
  their tokens remain pending elsewhere (the bindings-side mirror of the
  fork's lock-in set, 6.2); entries of those batches are in the view too.
  When such a token finally retires everywhere, its slot bit clears and the
  pin advances past its retirement ticket — the view's contents are
  unchanged by that bookkeeping step.

A `useSignalEffect` callback resolves reads against its own root's view, and
the engine-pathway flush runs per root commit, filtered by that root's view
— an effect re-runs when _its root's_ committed world changed, not when any
token anywhere retired. SSR and rootless committed reads (a devtools dump,
say) use the global retired-only form (10.2). The table is a handful of
integers per live root, owned by the bindings; node records know nothing of
roots.

### 13.5 `useAtom` / `useReducerAtom`

Component-owned atoms: created in a `useState` initializer, disposed in the
unmount cleanup of an effect, recreated on strict-mode remount (the holder
pattern from the react-concurrent-store harness). They are ordinary atoms —
other components' computeds may read them through context or props.

### 13.6 Transitions helpers

`startSignalTransition(scope)` = `startTransition` + engine `batch()`: the
batch coalesces broadcasts so N writes notify each watcher once (one notify
walk ticket, one drain — 9.8). `useSignalTransition()` wraps `useTransition`
the same way; `isPending` is React's own. Neither is required for
correctness — plain `startTransition` works — they are throughput helpers.

### 13.7 Multiple roots

The engine keeps no per-root state beyond the current pass (one pass executes
at a time, 6.3). Batches spanning roots are correct by construction:
per-root commit lock-in lives in the fork's registry (6.2), which keeps
including a committed-elsewhere batch in that root's `includedBatches` until
the token retires everywhere; the engine just applies the mask it is given.

### 13.8 SSR and hydration

Server rendering uses `COMMITTED` context reads with no subscriptions and no
observed-lifecycle mounting (watcher creation is a layout-effect concern, and
layout effects don't run on the server). On the server the write gate never
leaves DIRECT (no fork activity), so SSR pays zero overlay cost. No
`getServerSnapshot` analogue exists because reads are plain values. Flight/
RSC is out of scope for v1.

**Per-request engine isolation.** A Node server interleaves requests, and
with streaming SSR two renders are genuinely concurrent on one process — a
module-singleton engine would leak one request's atom values into another's
HTML. Server builds therefore construct **one engine instance per request**:
`cosignal/server` exports `createServerEngine()`, returning an isolated
engine (its own planes, side columns, and handle factories — the same API
surface, no shared globals). Request handlers create atoms through their
request's engine; the per-request cost is the initial plane allocation,
which the `configure` sizing options keep small for server use. The browser
keeps the module singleton — one interactive document, one engine.

**Stable identity keys.** Serialization needs a name for each atom that
means the same thing on server and client, including atoms created
dynamically (per todo-item, per row). Debug `label`s are not identity;
creation order is not stable. Keys are therefore **app-supplied strings**,
and the helpers take an explicit key→atom record — for dynamic atoms, the
app derives keys deterministically from domain ids (`todo:${id}`):

```ts
/** Server: capture committed leaf values. Returns JSON-safe payload.
 * `replacer` handles non-JSON values (dates, maps) if the app has any. */
function serializeAtomState(
  atoms: Record<string, Atom<any> | ReducerAtom<any, any>>,
  replacer?: (key: string, value: unknown) => unknown,
): string

/** Client: install serialized values into matching atoms. MUST run before
 * hydrateRoot so the first client render reads identical committed values.
 * Unknown keys warn in dev; missing keys leave the atom's constructor
 * default. */
function initializeAtomState(
  json: string,
  atoms: Record<string, Atom<any> | ReducerAtom<any, any>>,
  reviver?: (key: string, value: unknown) => unknown,
): void
```

**Hydration reconstructs; it never ships plane bytes.** Only leaf atom
values cross the wire; every computed, link, and cache re-derives lazily on
the client from those leaves. Shipping the arena's binary contents is
rejected on three independent grounds: closures (computed functions,
reducers, equality functions) do not serialize, so the planes' `fns`/`meta`
columns cannot round-trip; raw bytes would pin the exact layout version and
stride across the server/client boundary, breaking every rolling deploy
where the two run different builds; and accepting client-supplied binary
plane state would turn every kernel invariant (8.8) into an attack surface
that `verifyArena` was never designed to defend at trust boundaries.
Reconstruction costs one lazy evaluation per computed actually read during
hydration — work the first render does anyway.

---

## 14. Growth, reclamation, and memory management

### 14.1 Growth: closure rebuild over const buffers

The whole engine is one closure over `const M`, `const G`, and const aliases
of the side columns. TurboFan embeds those bases like module constants — the
only binding strategy measured at exact const parity (rejected with numbers:
segment tables +35–40%/access, resizable ArrayBuffers +66–83% traversal,
mutable `let` bindings +34–43%, per-function aliases +26–30%; growth _events_
are near-free — only growth _support on the read path_ costs).

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
- Planes G and W participate in the same rebuild. An open render pass does
  **not** block their growth: growth copies into doubled buffers with
  `.set`, and ids are indices, unchanged by doubling — everything a pass
  holds (pin, include mask, memo record ids, certificate offsets) is either
  a value or an index that survives the copy, so any true operation boundary
  (`enterDepth === 0`) is a legal growth point, _including the yield gaps of
  a time-sliced pass_. This matters because long transitions allocate log
  and memo records precisely while a pass is held open; forbidding growth
  there would manufacture a spurious mid-transition exhaustion throw out of
  the watermark's own conservatism.

### 14.2 Reclamation

- **Links**: freed to the free list on unlink (kernel, deterministic).
- **Effects, scopes, watchers**: disposal zeroes the record and defers the
  actual free to the next operation boundary (`pendingFree`), so a mid-flush
  dispose can never recycle a record the queue or an in-flight walk still
  references; the `GEN` counter makes stale disposers no-ops.
- **Atoms and computeds** are owned by their handles. Deterministic disposal
  exists internally (hooks dispose their component-owned nodes on unmount).
  For module-level handles, a `FinalizationRegistry` on handle objects pushes
  record ids onto the free list when handles are collected. Registration
  happens once per handle at construction; finalization latency is bounded by
  the watermark slack (a record lingering costs 32 B + side slots, never
  correctness). Unwatched computeds already drop their dependency links
  (kernel `unwatched`), so an unreferenced computed holds no graph edges
  while awaiting finalization.
- **Log entries**: swept by chain splice (9.6); the whole plane resets at
  quiescence (9.7).
- **World memos**: tombstoned on re-memoization, trimmed at sweep, and the
  whole plane (records, certificate region, `memoVals`) resets at quiescence
  (9.7). A previously-marked computed may retain a stale integer chain head
  in its `memos` slot until its next overlay use — guarded at lookup (7.4),
  bounded, harmless.

### 14.3 Memory-visible guarantees (tested)

- Quiescent overlay = zero log-plane residue, zero memo-plane residue
  (records, certificates, `memoVals`), zero live batch slots, all
  `slotMemoHead`s zero, all marks stale (stamps at or below `eraFloor`),
  and `overlayEpoch` bumped past the dead era (9.7).
- Steady-state re-render traffic allocates nothing in the engine (log
  records in LOGGED mode come from plane G; world memos and their
  certificates come from plane W, written only on overlay _evaluations_;
  broadcast closures and version bumps allocate nothing).
- Arena memory is off-JS-heap for GC purposes: retained-heap comparisons must
  report both `heapUsed` and plane byte totals (the harness's GC-attribution
  mode does this; see 18.5). The corollary: per-object heap accounting is
  gone by construction, so the engine ships a `stats()` dump (records
  allocated, free-list lengths, bump watermark, side-column fill, bytes per
  plane) as the replacement, and leak-hunting leans on the invariant sweeper
  (16.6) plus generation counters.

---

## 15. Schema, codegen, and constant inlining

Field offsets, flag bits, opcodes, and strides (section 7) must compile to
numeric literals in the hottest code in the library. Two hazards, both
measured: module-scope `const` declarations get demoted to mutable `var` by
esbuild-style bundlers (lazy-init/scope-merge hoisting), costing TurboFan
their constant folding — +15–21% on kairo workloads through a bundled child;
and per-function re-aliasing costs +26–30%. Everything in this section
exists to defeat those two hazards while keeping one source of truth for the
layout.

### 15.1 Primary strategy: a single same-file `const enum`

All layout constants live in one `const enum C { … }` in the kernel source
file. Same-file `const enum` members are inlined as numeric literals by
esbuild (both transform and bundle modes), tsx, vitest, and tsc alike, so
the emitted code carries literals no matter how the _library_ is built.
Cross-file `const enum` is packaging-dependent (esbuild transform mode and
`tsc --isolatedModules` leave runtime property accesses) and is forbidden.
The enum is never exported; nothing crosses the public `.d.ts` boundary.

This choice deliberately overrides the project's general "assume
stripping-only TypeScript transforms" guideline, and here is the honest
accounting. The guideline exists so _consumers_ never need a real TS
compiler — and they never do: the package **ships compiled JavaScript**
(built with tsdown/esbuild) plus declaration files, so consumers' toolchains
see plain JS with the enum already folded to literals. The constraint bites
only inside this repo: the library's own sources cannot be executed by
type-stripping loaders (Node's `--experimental-strip-types` refuses
`const enum`). The dev loop therefore runs through the same esbuild-family
tools that build the package — which is a feature, not a cost, because the
packaging pipeline is exactly where the constant-demotion hazard lives, and
running everything through it keeps the tests honest. For any tool that
truly must consume the sources raw, the generator's literal-expansion mode
(15.2) produces a `const enum`-free kernel: every `C.X` replaced by its
numeric literal with a `/* C.X */` trailing comment. Byte-identical output,
zero toolchain assumptions, noisier source.

### 15.2 The schema file and the generator

The layout has exactly one author-editable source of truth:
`tools/schema.ts` — a plain TypeScript module exporting **data** (object
literals through a `defineSchema()` that only validates and types; evaluated
by the generator, never imported by shipping code). It declares:

- all four planes (`M` stride 8, `G` stride 4, `W` stride 8 with its
  certificate region, and the tracing module's trace plane `T` stride 8,
  ring or chunk list per mode — section 16.2; ids pre-multiplied; record 0
  burned in M, G, and W);
- every record family and field: slot number, a `kind` string (`flags`,
  `NodeId`, `LinkId`, `LogId`, `MemoId`, `u31`, `spare`), a doc comment, and
  an owner note (which operation writes the field, which clears it) — the
  world-memo record and the stride-2 broadcast-queue entry are schema
  families like any other, so the debug twin hydrates memos and
  certificates and `verifyArena` knows their typing rules;
- the flag-bit registry (the generator fails on overlapping bits) and
  derived masks (`KIND_MASK`);
- side-column addressing (`values` at `id >> 2`, `fns`/`memos`/`meta` at
  `id >> 3`, `logVals` at `gid >> 2`);
- named constants (`REC_SLACK = 1280`, watermarks, `LAYOUT_VERSION`);
- the bytecode-budget table for hot functions (consumed by CI, 18.3).

Spare slots are _named_ (`SPARE7`), so claiming one is a schema edit plus
regenerate, and the invariant sweeper always knew spares must read 0 on live
records — a cheap corruption tripwire until claimed. Any change to stride,
field slots, flag bits, or side-column addressing bumps `LAYOUT_VERSION`;
debug snapshot formats are stamped with it and loaders refuse mismatches.

`tools/gen-layout.ts` (a few hundred lines, no dependencies, run via
`pnpm gen`) emits four artifacts, all checked in:

1. **The layout region in the kernel file** — the `const enum C`, every
   member carrying its schema doc comment, bracketed by
   `// #region GENERATED — layout vN (from tools/schema.ts; run pnpm gen) — DO NOT EDIT`
   markers. This is the only generated text inside a handwritten file; the
   generator only ever rewrites text between its own markers and fails hard
   on missing or duplicated markers. The generator never owns function
   structure — hot-function shape (the `link`/`linkInsert` split, loop
   structure, try/finally placement) is handwritten and performance-reviewed.
2. **The debug twin** (`src/debug/layout.debug.ts`, whole file generated,
   imports nothing from the kernel): branded-type checked accessors
   (`nodeFlags(M, id: NodeId): number` with range/kind asserts), record
   hydrators (id → plain object with decoded flags, dep/sub id lists, tape
   contents), the `verifyArena()` invariant sweeper skeleton (16.6), and the
   field tables as runtime data (`FIELDS_BY_RECORD`) for the DevTools
   formatter and dump tools. None of it ships in the hot build.
3. **The docs table** (`docs/layout.md`): one table per record family, the
   flag-bit chart, side-column addressing — generated so it cannot rot.
4. **Kernel build variants by stamping.** The generator also stamps the
   kernel template into its build variants: the production kernel, the
   **traced kernel** (identical code with integer trace emits spliced at
   `/*TRACE*/` marks — section 16.5), and the literal-expansion variant
   (15.1). Textually separate stamps get their own function literals, hence
   their own V8 feedback vectors and their own embedded buffer bases —
   enabling tracing can never pollute the production kernel's type feedback,
   and attaching the traced kernel at runtime reuses the growth machinery
   (rebuild the engine closure over the same buffers at an operation
   boundary).

### 15.3 Branded ids

```ts
type NodeId = number & { readonly __brand: "NodeId" }
type LinkId = number & { readonly __brand: "LinkId" }
type LogId = number & { readonly __brand: "LogId" }
```

Used throughout kernel and overlay signatures. They erase to nothing and
catch, at compile time, the three mistakes raw integers invite: passing a
link id where a node id belongs, using an un-premultiplied record index as
an id, and assigning a raw plane load (a field value) to an id variable
without going through a typed accessor pattern. The cost is `as NodeId`
casts at the small number of sites that mint ids.

### 15.4 Debug checks: `__DEV__` by define, never by runtime const

Dev-time invariant checks compile to `if (__DEV__) …` and are stripped by
`define: { __DEV__: 'false' }` in production builds. The measured reason
this is a rule and not a preference: a branch guarded by a build-time
literal `false` folds away at bytecode generation (output identical to the
unguarded function), while the same guard via a module-scope
`const DEV = false` leaves the dead check's bytecode in place — roughly 10×
a small function's inline budget — silently pushing hot functions past V8's
inlining ceiling without ever executing. Debug builds
(`__COSIGNAL_DEBUG__`) enable the kernel invariants (8.8), the tape
invariants (W0 fold equals kernel value after every absorption), memo
validity audits, and label propagation into error messages.

### 15.5 CI enforcement (drift is a build failure, not a review burden)

- **Regenerate-and-diff**: a unit test imports the schema, runs the
  generator in memory, and string-compares against every checked-in
  generated region and file. Failure message: `run pnpm gen`. Deterministic
  emit (sorted iteration, no timestamps, formatter-normalized) makes this a
  string equality.
- **Bundle audit**: build the library with the shipping bundler; assert the
  output contains no `var C` declaration and no `C.` member access in kernel
  functions (the enum must have vanished into literals), and spot-check that
  known hot functions contain the expected literal offsets.
- **Schema self-checks at generate time**: field slots unique and under
  stride; flag bits disjoint; kind mask equals the union of kind bits;
  spares named; every field documented with an owner note.
- **Bytecode budgets**: section 18.3; the budget table lives in the schema
  file next to the field definitions.
- **Bundled-child benchmark gate**: the kairo benchmark runs through the
  bundled artifact (18.5), catching any packaging regression that would
  reintroduce the const-demotion cliff — the enforcement of "measure through
  the shipping pipeline".

---

## 16. Tracing and debugging

The packed representation trades away every default affordance of JavaScript
objects — `console.log`, heap-snapshot attribution, debugger hover — so
visibility must be _built_, and cheaply. One economy runs through this whole
section: all the tools share a single substrate, the generated debug twin's
"decode record id → plain object" hydrators (15.2). The formatter, the
verifier, the DOT dumper, the trace-event decoder, and the oracle comparator
are thin layers over it.

### 16.1 The tracer slot

The core exposes one module-level slot: `tracer: Tracer | undefined`,
`undefined` unless `cosignal/tracing` is loaded. Every emit site does
`tracer !== undefined && tracer.emit(...)`. Untraced cost: one check per
site (measured noise). Because the engine's nouns are integers (node ids,
log ids, batch tokens, seqs, slots), trace events are cheap to record and
precise to correlate.

### 16.2 Choke points and event schema

The overlay's shape yields a dividend here: every semantically meaningful
concurrency event already flows through two narrow waists — **tape append**
(every write in LOGGED mode, with its op, batch, seq, and applied bit) and
**overlay read resolution** (every world-sensitive read, with its context,
world key, and how it was answered). Instrumenting those two, plus the
policy-level lifecycle sites (retirement/absorption, pass start/end,
broadcast decisions, effect runs, suspensions), gives complete causality
without touching kernel hot loops.

**Storage: packed arena records, not an object stream.** Trace events are
fixed-size integer records in their own `Int32Array` storage (the trace
plane `T`, stride 8). The reasoning is the same asymmetry that shaped every
other plane in this design: the **write side is hot** — per-read and
per-write events fire at engine frequency — while the **read side is rare
and human** (someone opened devtools). So writes are packed integer stores
and reads hydrate lazily. Three consequences make this a requirement rather
than a preference:

- **Fidelity.** An object-allocating tracer perturbs exactly the thing being
  observed: this is a zero-allocation library, and its GC behavior is a
  measured, gated property (18.2). A tracer that allocates one object per
  event manufactures GC pressure that isn't there untraced, making every
  traced profile a lie. A zero-allocation recorder is the only way traces of
  a zero-allocation engine are trustworthy.
- **Flight-recorder mode.** Because recording is allocation-free and
  fixed-cost, the recorder can run _always-on_ in development ("last 65k
  events before the bug"), overwriting oldest records — feasible only
  packed; an object stream with this policy would be a permanent allocation
  storm.
- **The decoder is not extra cost.** Reading the records requires an
  id-to-object decoder — which the design already builds: the generated
  debug twin (15.2) that powers the DevTools formatter and `verifyArena`.
  The trace record layout lives in `tools/schema.ts` like every other plane,
  so its decoder, docs table, and field constants are generated by the same
  pipeline. The human-facing outputs (timeline, cause-chain queries, DOT
  renderings) are required deliverables regardless of representation; only
  the recorder's cost model was at stake, and packing wins it.

**Trace modes.** The tracer runs in one of three modes. All three share the
same record format and the same emit path — there is never a second
recorder, and the mode distinction lives _only_ in the end-of-chunk branch,
taken once per `chunkSize` (or `capacity`) events, so it adds no per-event
cost:

- **`OFF`** — the slot is `undefined`; one check per emit site (G-18).
- **`RING(capacity)`** — the flight recorder: one `Int32Array` of
  `capacity` records (a power of two, default 2^16 records = 2 MiB), oldest
  overwritten. The devtools-open default and the always-on development
  mode; history is bounded, loss (overwrite) is expected and detectable.
- **`SESSION(chunkSize, maxBytes)`** — the **lossless** capture mode, for
  user-invoked bounded recordings: "trace my whole app boot", "record this
  interaction end to end". Same emit path; the difference is what happens
  when the current chunk fills: instead of wrapping, the recorder **appends
  a new fixed-size `Int32Array` chunk** (`chunkSize` records, a power of
  two) to a chunk list and keeps writing. **Nothing is ever copied.**
  Growth-by-doubling-with-copy is explicitly rejected for this mode: boot
  traces are the big ones, and a doubling copy stalls the app hardest at
  exactly the moments worth tracing; chunk append is one bounded allocation
  per `chunkSize` events, constant no matter how much history has
  accumulated. A filled chunk is **sealed** — immutable from that moment —
  so the decoder and the devtools extension can stream, serialize, or
  transfer sealed chunks incrementally _while recording continues_, with no
  coordination against the writer.

  The guarantee, stated plainly for users: **a SESSION trace is lossless up
  to `maxBytes`.** If appending the next chunk would cross `maxBytes`, the
  recorder emits a loud `truncation-marker` event (recording the boundary's
  event id) and degrades to RING behavior over the final chunk — recent
  events keep flowing, but the capture is now marked partial. Loss is never
  silent: the marker event, a `stats()` flag, and a decoder warning all
  surface it.

**Record layout** (trace plane `T`, stride 8; generated from the schema):

| offset | name         | meaning                                                                                                                                                                                                                                                 |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| +0     | `KIND`       | event-kind tag (6 bits) + kind-specific flag bits (applied?, cutoff-suppressed?, memo-hit?, committed?, fallback-taken?, equality-dropped?)                                                                                                             |
| +1     | `CAUSE`      | event id of the provoking event (the causality edge); 0 = root cause. A module-level `currentCause` scalar is set around each emitting operation, so a broadcast carries its write's event id and a render-read carries the broadcast that scheduled it |
| +2     | `NODE`       | primary subject: node id / log id / watcher id (per kind)                                                                                                                                                                                               |
| +3     | `WORLD`      | world key, batch token, or include mask (per kind)                                                                                                                                                                                                      |
| +4     | `TIME`       | microseconds since the previous event (delta encoding; saturates at 2^31−1, and a saturated delta emits a `clock-sync` event carrying an absolute timestamp in its arg slots)                                                                           |
| +5..+7 | `ARG0..ARG2` | kind-specific integers: seq, walk ticket, duration in µs, counts, label ids                                                                                                                                                                             |

The event **id** is a monotonic counter that doubles as the event's
sequence number and its address. In RING mode, a record's position is
`id & (capacity − 1)`, so an id names an event and locates it until
overwritten (a decoder detects overwrite by comparing ids; a drop counter
records how many events a lagging subscriber lost). In SESSION mode, with
`chunkSize` a power of two, the position is
`chunks[id >> log2(chunkSize)]` at slot `(id & (chunkSize − 1)) * stride` —
ids are stable addresses for the whole session. Because ids are dense and
monotonic, **losslessness is provable, not promised**: a decoder verifies a
SESSION capture by checking that the ids it holds form one gap-free range
with no `truncation-marker` inside it, and the tooling surfaces exactly that
("events 0–1,842,113, verified complete"). **Labels and other strings**
never enter the records: they are interned once (at node creation / first
use) into a table mapping small integer label ids to strings, and records
carry the ids. **Rare object payloads** — an absorb's old/new values, a
thenable identity — go into a small side **ref-ring** (a plain array,
default capacity 256, parallel-indexed by its own counter; the trace record
stores the ref-ring index in an arg slot). Documented retention rule: the
ref-ring retains those objects until overwritten — bounded by its capacity,
but it _can_ extend object lifetimes, so its capacity is configurable and 0
disables ref capture entirely (events still record, payload slots read as
"dropped").

**Event kinds and their payloads** (fields mapped onto the record slots
above):

| kind                                                                        | payload                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `atom-write`                                                                | atom id, op, batch token, seq; flags: applied?, equality-dropped?  |
| `log-append` / `log-coalesce` / `truncate`                                  | atom id, log id, batch token                                       |
| `batch-retired`                                                             | token, entries stamped; flags: committed?                          |
| `absorb`                                                                    | atom id, old/new via ref-ring; flags: changed?                     |
| `computed-eval`                                                             | node id, world key, duration µs, deps-read count; flags: memo-hit? |
| `notify-walk`                                                               | atom id, walk ticket, nodes stamped, watchers collected            |
| `notify` / `broadcast`                                                      | node id, watcher id; flags: cutoff-suppressed?                     |
| `entangle`                                                                  | watcher id, batch token; flags: fallback-taken?                    |
| `effect-run`                                                                | node id, duration µs                                               |
| `render-pass-start/end`                                                     | container label id, pin, include mask                              |
| `render-read`                                                               | node id, world key; flags: resolved-via (kernel / replay / memo)   |
| `suspend` / `settle`                                                        | node id, thenable ref-ring index, world key                        |
| `mark-repair` / `sweep` / `quiescence` / `clock-sync` / `truncation-marker` | counts / absolute time / drop-boundary event id                    |

**The decoder view.** The verbose "object event" (`{id, time, cause, type,
…named fields}`) exists only as a **lazy decoder view over the packed
records** — generated hydrators that materialize one event object on
demand — never as a second recorder. Everything human-facing sits on that
view: the subscription API (subscribers receive decoded events in batches at
operation boundaries, and in SESSION mode may instead consume whole sealed
chunks as they seal — the feed for the planned Chrome devtools timeline
extension), the cause-chain helpers (`whyDidRerun(computedOrLabel)`,
`whyDidRender(componentLabel)`, `effectRunCount(label)`, which walk `CAUSE`
edges _inside the packed records_ and only decode the events they return),
and the DOT renderer (16.4).

**The two use cases, documented as recipes:**

- _Devtools-open ring:_ opening the devtools extension (or calling
  `startTracing({ mode: 'ring' })`) records the flight recorder; the
  timeline shows the ring's live tail and marks overwrite-loss with the drop
  counter.
- _Whole-boot capture:_ `startTracing({ mode: 'session', … })` must run
  **before the engine's first operation** to capture a truly complete boot.
  The ordering that makes this work is documented and asserted: import
  `cosignal/tracing` and start the session before any application module
  creates its first atom — the tracer slot is checked per emit, so events
  before installation are simply never recorded, and the decoder's
  completeness proof will show the trace starting at event id 0 only when
  the session was installed first. (The engine itself initializes lazily on
  first use, so no import-cycle gymnastics are needed — just "tracing setup
  first" in the app entry point.)

**Cost, gated.** Untraced: one `tracer !== undefined` check per site (G-18,
zero within noise). Traced: per event, a bounds-masked bump, seven integer
stores, and one `performance.now()` — no allocation in RING mode, and in
SESSION mode one `Int32Array` chunk allocation amortized per `chunkSize`
events (G-20). The falsifiable target: with tracing enabled (RING, default
capacity, ref-ring off), tier-0 shapes run at **≤1.15× untraced**, measured
and recorded at M6 (gate G-19), with SESSION mode measured alongside and
required to match RING within noise (same emit path); if the measured
numbers beat the ceiling, the measured numbers become the pinned regression
gates thereafter.

### 16.3 Handle inspection: DevTools custom formatter and terminal twin

Without help, a handle wrapping node id 42 logs as a useless object with one
integer in it. Two opt-in dev tools fix this, both over the debug twin's
hydrators:

- **Chrome DevTools custom object formatter.** `installFormatters()`
  (exported from `cosignal/tracing`, dev builds) pushes a
  `{header, hasBody, body}` formatter onto the page-global
  `devtoolsFormatters` array (users enable "Custom formatters" in DevTools
  settings; Firefox supports the same API, and Node works via `--inspect`).
  The formatter detects the handle brand (a symbol-keyed property carrying
  the id in dev builds), reads the live plane, and renders a one-line header
  like `Computed(#42 "cartTotal" PENDING·marked subs:3 memo:2 worlds)` with
  an expandable body of decoded fields, dependencies, subscribers, live tape
  records, and world-memo entries — each neighbor rendered as a further
  clickable handle. **Hydration is lazy by construction**: the header
  decodes one record; the body decodes neighbors only when expanded, so
  logging a handle in a hot loop stays cheap.
- **Terminal twin.** The same handles carry `util.inspect.custom` (dev
  builds), so plain Node `console.log` prints the identical decode. Cost
  when unused: one extra symbol property per handle in dev builds; zero in
  production (the installer is a no-op unless the debug define is set).

### 16.4 Graphviz renderers (`cosignal/graphviz`)

Emits DOT source (render with `dot -Tsvg`; DOT survives graph sizes that
crash lighter-weight renderers):

- `dependencyGraphToDot(handles)` — snapshot of the live graph reachable
  from the given signals: kinds, labels, staleness flags, LIVE/marked state,
  live log tapes (as small record tables), watcher attachment. Diffing two
  dumps is the workhorse for wiring bugs.
- `traceToDot(events, filter?)` — the causal graph of trace events
  (write → walk → broadcast → render → absorb chains).

Layering is strict: `tracing` records without importing any visualizer;
`graphviz` imports only _types_ from tracing and reads the planes through
the debug twin's accessors. Either loads without the other.

### 16.5 The traced kernel build

Kernel-internal detail (flag transitions, link churn, scratch-stack depth)
is deliberately _not_ behind per-site tracer checks in the production
kernel — the production kernel contains zero tracing instructions. When
that detail is needed, the generated **traced kernel stamp** (15.2) — the
same code with integer event emits spliced at its `/*TRACE*/` marks,
writing `flags-transition` / `link` / `unlink` / `stack-depth` records
through the same recorder, in whatever mode it is running (16.2) — is
swapped in at an operation boundary using
the growth machinery (rebuild the engine closure over the same buffers).
Attach and detach on a running app; the production stamp's type feedback is
never touched.

### 16.6 Debug builds and the invariant sweeper

`__COSIGNAL_DEBUG__` builds enable the kernel invariant assertions (8.8),
tape invariants (the W0 fold equals the kernel value after every
absorption), memo validity audits, and `verifyArena()` — the generated
sweeper that walks the planes and, like a database integrity check, reports
_all_ problems rather than stopping at the first: allocation partition
(every record on exactly one of live graph / free list / pendingFree;
free-list chains acyclic, terminating at 0, below the bump pointer; record 0
all-zero), field typing from the schema's `kind` strings (a `LinkId` field
is 0 or a live link of the right role; spares read 0; exactly one kind bit
per live node), graph coherence (every link present exactly once in both of
its intrusive lists, prev/next coherent both directions, tails reachable),
memo-plane coherence (node memo chains acyclic and terminating; every live
memo record's `NODE` owns a `memos` head that reaches it; `SLOT_NEXT`
nonzero only on writer's-world keys and every chained record's slot matches
its head; certificate runs in bounds; tombstones' `memoVals` slots
`undefined`; stale node heads only ever point at records failing the `NODE`
guard), side-column hygiene (freed records' `values`/`fns`/`memos` slots
are `undefined`/0), and scheduler coupling (queued ids have kind bits;
broadcast-queue tokens are 0 or live; scratch stack pointers at their bases
at operation boundaries). It runs at natural barriers: end of flush, end of
batch, after every conformance case in debug CI, and inside every
randomized-oracle step (17.2). Production builds compile all of it out
(15.4).

---

## 17. Testing plan

Seven suites. CI runs them cheapest-signal-first (17.1, 17.5, 17.3, 17.4,
17.2's pinned cases, 17.6, 17.7, then 17.2's long fuzz). Build order is the
reverse of nothing: the plan's one sequencing rule is that **the oracle
(17.2) is built before the overlay machinery it checks** — the naive model
is deliberately cheap to write (a snapshot-everything reference), and the
sweep, coalescing, and mark-repair code must be developed _against_ it, not
tested by it after the fact. Nothing ships on assertion of similarity to
prior art; every inherited behavior is re-verified against this engine.

### 17.1 Core conformance

- The reactive-framework conformance suite (179 cases as configured in this
  repo's harness — the bar alien-signals itself sets), run against the core
  API adapter, **including** the growth-stress configuration
  (`initialRecords: 2`, forcing every doubling path so every case crosses
  closure rebuilds) and exact dynamic-pull-count assertions
  (`testPullCounts: true`: never re-run a formula whose inputs did not
  change).
- Kernel unit tests: laziness, cutoff, dynamic dependency trimming, repeated
  reads, re-entrant writes and cycle rejection under both
  `forbidWritesInComputeds` settings, effect ordering (outer-before-inner),
  scope disposal, generation-counter staleness, boundary growth/reclaim
  under adversarial dispose-during-flush sequences.
- Benchmark-contract tests: synchronous effect flush, fresh mid-batch reads,
  exact pull counts.
- Debug CI runs this suite once in the debug build with `verifyArena()`
  after every case (16.6).

### 17.2 The randomized replay oracle (the highest-value test in the project)

The overlay is the most invariant-dense plane in the design — pins, retire
stamps, walk tickets, coalescing legality, memo validity — and hand-picked
examples cannot cover its interleavings. So the overlay's primary defense is
an **oracle**: a deliberately naive reference implementation that the real
engine must agree with on every observable, across randomized schedules.

**The naive model.** Per atom, a plain JavaScript array of
`{seq, op, payload, batchToken, applied, retiredSeq}` — every write ever, no
sweeping, no coalescing, no slots. Reads implement the visibility rule
(10.2) literally: filter, sort by seq, replay (set replaces, update applies,
dispatch reduces, equality folds). Computeds are memo-free recursive
functions that re-derive from oracle atom reads in the same context every
time. No marks, no memos, no tapes, no walks: the model is too slow to ship
and too simple to be wrong.

**Watcher decisions are derived from world values — never from any walk.**
This rule is what makes the oracle able to catch notification holes instead
of reproducing them: a model that mirrored the engine's topology walks would
agree with the engine about every watcher the walks miss. So the oracle's
broadcast set is computed from first principles: at each drain, for each
watcher and each world the drain could affect (the writing batch's writer's
world for a deferred drain; every live deferred writer's world _plus_ the
newest world for an urgent drain), fully replay the watched node's value in
that world and compare it — by the node's equality — with the last value the
oracle recorded as broadcast or rendered for that world. The watchers whose
values changed are the expected `setState` set, each tagged with the world's
batch token (the lane the engine must schedule it into). Nodes whose
dependency on the written atom exists only in a pending world fall out of
this automatically, because the oracle re-derives every computed from
scratch per world.

**The schedule generator** emits randomized interleavings of: urgent and
deferred writes (`set`/`update`/`dispatch`, including equal-value writes
onto logged and unlogged atoms) across 1–33 concurrent batches (33 forces
the slot-exhaustion fallback), render passes (pin + random include mask +
lineage) with reads in every context at random points, pass **yields with
reads and writes inside the gaps** (asserting they resolve `NEWEST` and are
legal), resumes and restarts, retirements (`committed` both true and false)
in random legal orders, per-root commit events for spanning batches,
truncations, sweeps at random boundaries, coalescing-eligible write runs,
world-divergent computed topologies (17.4's shapes, generated — including
divergence onto not-yet-logged atoms), fresh nodes created mid-pass, new
edges appearing mid-era (exercising mark repair and the post-eval re-check),
growth events (forced doubling mid-schedule, including with a pass held
open), promise suspensions and settlements, and quiescence (assert the 9.7
residue-zero postconditions, then keep going in the new era with schedules
crafted to re-use seq values).

**The assertions.** At every read point: real engine equals oracle — same
node, same context, same world. At every retirement: the absorbed kernel
value equals the oracle's fold. At every broadcast drain: the set of
(watcher, batch token) `setState` calls the engine issues equals the set
the oracle derives from world values as above. In debug builds,
`verifyArena()` runs after every step.

**Seed and shrinking discipline** (supplied here because it matters as much
as the oracle): the suite runs on fast-check's model-based command runner.
Every failure prints its seed and path; CI re-runs are reproducible from
them. Shrinking is enabled so a failure arrives as the _minimal_
desynchronizing op sequence, and every shrunk failure is committed as a
pinned deterministic regression case before the fix lands. The pinned list
starts with the design's known danger cases: the rebase walkthrough (10.7),
the two-batch write into an already-marked region and its same-batch
cutoff-suppressed variant (9.8), the flushSync-exclusion case (9.1) and its
one-computed-downstream variant (the unmarked-cone tear that mandates
mark-on-tape-creation, 9.3), the equal-urgent-SET-over-pending-transition
case (the receipt that must not be dropped, 9.3), the divergent-dep
follow-up write with its atom unlogged at first read (certificate zeros,
10.5), a same-batch write after a cutoff-suppressed drain reaching a
divergent-only node (slot-chain re-validation, 9.8), set-superseded-
by-urgent, functional replay over a moved base, a pass pinned across two
retirements (retention), slot reuse after retire, a suspended entry
surviving commit, writer's-world memo across another batch's retirement and
across a settlement (epoch bumps), the era-crossing memo with re-used seq
values (the quiescence epoch bump, 9.7), seq-counter and walk-counter wrap
(forced counter values), and coalescing blocked by an open pass.

CI budget: a short fuzz (fixed seed count) on every push; a long nightly
fuzz with fresh seeds.

### 17.3 Overlay unit scenarios (no React; simulated fork)

A fake external runtime driving the bridge lets every concurrency scenario
run as a fast, deterministic unit test: the pin/include visibility truth
table (each clause of 10.2 in isolation and combination), the rebase
walkthrough (10.7) and its functional-update variants, absorption folds with
interleaved urgent/deferred/equal writes, the equality/receipt matrix (drop
allowed only on tapeless atoms, including the UPDATE/DISPATCH
evaluate-once-against-base variant; equal writes onto logged atoms append
and fold), `committed = false` folds (the writes are real), sweep
correctness under multiple pinned passes, truncation, slot-exhaustion
fallback, coalescing legality (never across an open pass; coalesced writes
still notify), quiescence resets (era floor, seq, planes G and W, slot memo
heads, the epoch bump), the write-gate boundary matrix (DIRECT at
quiescence, LOGGED from the first batch-open edge, DIRECT again only at
full quiescence; `strictLanes` pinning), the mark invariant under
tape-creation walks (urgent and deferred) and new-edge repair (8.7.3), the
post-eval stamp re-check shapes (fresh node mid-pass; new branch into a
logged atom), world-memo validity across appends/coalesces/absorptions/
retirements/truncations/settlements (10.5), certificate zeros for
unlogged-at-read atoms, nested-evaluation certificate flattening (parent
invalidated by grandchild-source appends, both on child re-evaluation and
on child memo hits), the stale-memo-head guard after a plane reset, memo
keying across pass restarts, and the deferred-notify matrix of 9.8: second
write same batch (cutoff-suppressed first write), second write different
batch, urgent-then-deferred and deferred-then-urgent on one atom, drain
grouping triggers (in-stack for plain writes; at close for `batch()`),
per-token drain groups entangled into their own lanes, slot-chain
re-validation on deferred and urgent drains, and wide fan-out with shared
node memos (one evaluation, many watchers).

### 17.4 World-divergent dependency scenarios

A computed's dependency set can differ per world: `c = () => flag.state ?
a.state : b.state` reads `a` only where the pending world's `flag` is true.
Any engine that derives invalidation from one world's topology while serving
another world's cache tears on this family; this design is immune by
construction — overlay evaluations re-walk dependencies per world, and memo
validity keys on the _re-observed_ source set (10.5) — and these tests keep
it that way. Common setup: atoms `flag=false, a=0, b=0`; computed `c` as
above; a watcher on `c`; deferred batch k.

- **T1, the core tear test:** evaluate `c` canonically (reads `flag,b` → 0);
  write `flag=true` in k; read `c` in k's world (reads `flag,a` → 0, memo
  cached — note `a` is **unlogged** at this read, so its certificate pair is
  `(a, 0)`); **same batch**, write `a=1` in k. Assert three separate
  mechanisms fired: the k-world read of `c` returns 1 (the write created
  `a`'s tape, so the certificate's zero pair mismatches the new tail —
  10.5); the watcher is notified _in k's lane_ (the canonical walk from `a`
  reaches nothing — `c` never read `a` canonically — so this notification
  can only come from the drain re-validating slot k's memo chain and
  scheduling the bump through the entanglement API — 9.8); and the
  committed-world read still returns 0 via `b`.
- **T2, no tear from the committed-only dep:** after T1's divergence, write
  `b=5` in k. Assert: k-world `c` still 0 (its world reads `a`), committed
  `c` still 0 (deferred writes invisible). Over-invalidation (a wasted
  re-evaluation returning 0 again) is acceptable; a wrong value or a
  spurious broadcast past the equality cutoff is not.
- **T3, the shared dep:** after divergence, write `flag=false` in k. Assert:
  k's cached evaluation invalidates, `c` re-evaluates down the `b` branch,
  watcher notified only if the value changed.
- **T4, urgent write to the committed-only dep:** after divergence, urgent
  `b=7`. Assert: committed/newest `c` is 7 and committed watchers re-render
  urgently; k-world `c` still 0 (its world reads `a`, and `b` is not in its
  re-observed set — but the memo may validly re-evaluate, since `b`'s tape
  moved; it must return 0 either way).
- **T5, urgent write to the pending-only dep:** after divergence, urgent
  `a=9`. Assert: k-world `c` returns 9 (k's world includes applied urgent
  entries, per the writer's-world/pass rules), committed `c` unchanged at 0
  with no committed broadcast (equality cutoff).
- **T6, retire/reuse hygiene:** run T1 through k's retirement; open batch
  k2 that reuses k's slot; repeat the dance with branch polarity flipped.
  Assert correct reads despite any leftover per-world bookkeeping.
  Staleness must over-approximate, never under-approximate: a stale mark or
  dead memo entry may cost a re-evaluation, never a wrong answer.
- **T7, suspended-lane divergence** (view-set rather than dep-set
  divergence): two live batches render together, one suspends, the other
  commits alone — multi-bit and single-bit include masks over the same
  nodes.

The same shapes feed the 17.2 generator so the fuzz explores their
interleavings with everything else.

### 17.5 Frozen-kernel contract suite and the invisibility tests

"The proven kernel is untouched" must be verifiable by construction, not by
claim. Two mechanisms:

- **Contract suite against the frozen artifact.** The pre-overlay donor
  kernel is kept building as a reference ("frozen") artifact. A standalone
  suite drives the shipping kernel (with its five overlay additions, overlay
  empty) and the frozen kernel through identical operation sequences —
  including the full 17.1 conformance suite — asserting behavioral identity:
  identical `update`/recompute call sequences (order and count — the
  exact-pull-count property), identical notify sets, identical final flags
  words for every node, identical link topology, and the quiescence residue
  of 9.7/14.3 at zero throughout (plane G untouched, no live slots, no live
  marks). Per-function contracts pin the additions themselves: the notify
  walk stamps exactly the subscriber-reachable cone and is idempotent per
  ticket; mark repair fires only on marked-producer insertions; `invalidate`
  is equivalent to a value-changing write minus the value move;
  log-plane alloc/free round-trips preserve free-list integrity.
- **Invisibility tests (the conformance suite inside a synthetic episode).**
  The entire 17.1 suite is re-run through two special adapters: (a) every
  write opens a synthetic deferred batch and immediately retires and absorbs
  it; (b) the whole suite runs while an unrelated live deferred batch holds
  a log on an unrelated atom (LOGGED mode, marks live somewhere else).
  Steady answers must be identical everywhere — the overlay must be
  semantically invisible both when it contains everything and when it
  contains nothing relevant.

### 17.6 React integration

Adopt the react-concurrent-store harness wholesale (vitest + jsdom + RTL,
transitions held open by controlled promises, TestLogger render-order asserts
with afterEach-empty, inline DOM snapshots for tear checks, listener-leak
asserts, controlled thenables for Suspense) and its 14-scenario suite as the
conformance bar — including turning its documented known-bug case (sync
mount mid-transition with suspending pending state) into a passing test.
Plus, from this design's specifics:

- signal+React-state lockstep inside one transition; interruption and
  rebase; `flushSync` render excluding a pending default-priority batch (the
  case that forces the always-log rule, 9.1), including the
  one-computed-downstream variant (marks from tape creation, 9.3);
- **the yield-gap test (10.1):** hold a transition render open across a
  yield; from a real event handler in the gap, write an atom (must not
  throw, must classify urgent) and read signals (must resolve newest, not
  the pass's pinned world); resume and assert the pass still reads its
  pinned world;
- **the grouped-drain lane test (9.8):**
  `batch(() => { a.set(1); startTransition(() => b.set(2)) })` — assert b's
  watchers re-render in the transition's lane and commit with the
  transition (one commit, no torn frame), even though the drain ran after
  the transition scope closed;
- **the write-gate contract family (9.1):** (i) loose default — while React
  is fully idle, a `setTimeout` writes an atom, the broadcast schedules
  default-lane work, and a same-task `flushSync` runs: assert the documented
  loose behavior (the signal's new value is visible in the flushSync render;
  the schedule converges; nothing is lost); (ii) the same schedule under
  `strictLanes: true`: assert exact `useState` parity (the flushSync render
  excludes the idle write); (iii) the watcher-count counterexample: the
  app's _first_ transition writes a signal before any watcher exists, a
  subscriber mounts mid-transition, and both the pending and committed
  worlds read correctly (the quiescence gate logged the write). Any future
  gate change must pass all three;
- **the entanglement test (13.2):** hold a transition open, mount a late
  subscriber to a signal the transition wrote, and assert exactly **one**
  commit containing both the transition's updates and the corrective
  re-render — plus the fallback: retire the batch between subscription and
  fixup and assert the urgent-correction path repaints before paint; plus
  the no-false-positive variant: mount a subscriber _inside_ a transition
  pass with no gap writes and assert the fixup issues nothing (the
  world-aware comparison, 13.2);
- **the two-batch re-notify test (9.8), full stack:** two overlapping
  transitions writing the same atom region; assert the second transition's
  render includes every subscribed component (no missed setState in the
  second lane);
- **the divergent-dep notify test (T1, full stack):** a component watching
  `c = flag ? a : b` during a transition that set `flag` then `a`; assert
  the component re-renders within the transition's own commit;
- **the per-root committed test (13.4):** a batch spanning two roots; after
  root A commits (token still pending on root B), root A's
  `useSignalEffect`s observe the batch's values and root B's do not; B's
  flush at B's commit;
- multiple roots with a spanning batch (per-root lock-in); `useComputed`
  over props+state+signals; `useSignalEffect` re-run sources (deps vs
  absorption); the **ReducerAtom vs useReducer side-by-side**: identical
  action streams through both across a held-open transition with urgent
  interleaving, committed values equal at every step; infinite-loop
  rejection (a signal-write storm hits React's nested-update error, not a
  hang); MutationObserver window (observer sees app mutations, never
  React's); strict-mode double-mount (observed-lifecycle nets to one
  subscription); hydration; tearing stress (sustained writes during
  time-sliced renders, zero torn frames by DOM snapshot).

### 17.7 Reconciler-level fork tests

The fork's own test suite (inherited and extended): batch-token registry
edges (claim/mint/pending/backfill/finish/close), async-action parking,
per-root commit lock-in and `onBatchCommitted` delivery (exactly once per
(token, root), before retirement on the last root), pass start/end pairing
across yields and restarts, **yield/resume pairing** (strict alternation
between one start and its end; edges fire on the should-yield exit and on
resumption; none for synchronous passes), **render-lineage stability** (same
integer across yields, restarts, and Suspense retries of one lane set's
work; new integer for new work; retired with the work), exactly-once
retirement, integer-token encoding (deferred bit, no reuse while live,
generation rollover, lane reuse under a live batch),
**`unstable_runInBatch`**: updates scheduled inside join the batch's lanes
(one commit), retired-token false return, commit-phase scheduling re-pends
the token (no race window), nesting rules, and drain-shaped usage (called
after the originating transition scope closed, updates still land in the
batch's lanes); mutation-window bracketing including View Transitions and
`flushSync`; listener-error isolation; and inertness (no listener →
reconciler trace diff is empty).

---

## 18. Performance engineering

Numbers, not adjectives. Every claim in this section is either a **gate**
(CI-enforced or milestone-blocking; the build fails or the milestone does
not exit) or a **report** (measured and published, informing the ratchet).
Conformance is a precondition for any number: a benchmark result from a
non-conformant build is not a result.

### 18.1 Methodology (hard-won rules; violating them produced wrong conclusions before)

- Rank only **one-framework-per-process** runs; same-process suite order
  biases results up to 3× via megamorphic pollution.
- The primary suite is the milomg reactivity-benchmark fork (current
  alien-signals; the tb fork pins a two-majors-stale alien-signals and is
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
- **Experiment ledger**: every attempted optimization gets an entry
  (hypothesis, method, best-of-N, an untouched control framework in the same
  run, keep/rollback decision); wins must exceed the machine's demonstrated
  thermal drift.

### 18.2 The gate table

| #    | mode / measurement                                                                                                                                                                                                                                | baseline                 | number                                                                                                                                                                                                                                                                                          | kind                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| G-1  | core DIRECT, every tier-0 shape                                                                                                                                                                                                                   | alien-signals v3         | ≤1.0× each (donor reference points: deep 0.90, broad 0.84–0.88, diamond 0.89, reads 0.74–0.87, create 0.96)                                                                                                                                                                                     | gate, M1                                           |
| G-2  | core DIRECT, steady parity                                                                                                                                                                                                                        | frozen kernel artifact   | ≤1.03× each tier-0 shape (the dormant-overlay tax must be one branch)                                                                                                                                                                                                                           | gate, M1, re-run every later milestone             |
| G-3  | kairo suite, GC-inclusive, bundled child                                                                                                                                                                                                          | alien-signals v3         | ≤1.4× every test (the measured current reality — an honest ceiling, not an aspiration); ratchet reviews at each milestone may only lower it; ≤1.25× is the M7 target via pre-registered ledger experiments, and if unmet, M7 exits with the ratcheted number adopted and published in its place | gate (1.4×) + ratchet                              |
| G-4  | mounted-but-quiet (watchers exist, React idle), tier-0 — measured twice: loose default (gate at DIRECT) and `strictLanes` (LOGGED idle)                                                                                                           | core DIRECT              | loose: identical within noise (the quiescence gate's whole point); strictLanes: ≤2% regression                                                                                                                                                                                                  | gate, M2                                           |
| G-5  | LOGGED read of an unmarked node                                                                                                                                                                                                                   | DIRECT read              | ≤1.1×                                                                                                                                                                                                                                                                                           | gate, M2                                           |
| G-6a | **first** logged write to an atom (tape creation + mark-only cone walk, 9.3), measured across cone sizes 10/100/1000                                                                                                                              | DIRECT write             | ≤N×; N measured and pre-registered at M2 per cone size (once per atom per era — an amortized event, priced so its cone-proportional cost is a number, not a surprise)                                                                                                                           | gate, M2                                           |
| G-6b | **steady** logged urgent write (append + apply + broadcast bookkeeping; tape already exists)                                                                                                                                                      | DIRECT write             | ≤2×                                                                                                                                                                                                                                                                                             | gate, M2 (priced on day one of the tape milestone) |
| G-7  | logged **deferred** write, drain-amortized (notify walk + writer's-world broadcast evaluations + slot-chain re-validation), fan-out shapes 1 atom → 10/100/1000 watchers **crossed with** registered-node counts 0/10/100 on the slot chain (9.8) | DIRECT write             | ≤N×; N measured and pre-registered at M2 with provisional ceiling 3×; breaking the ceiling triggers the pre-registered fallbacks (always-broadcast mode for evaluations, the edge-plane escalation for chain scans, 9.8)                                                                        | gate, M2                                           |
| G-8  | held-open transition, hot NEWEST read loop over the marked cone (the world-memo gate; the inner loop is the packed certificate scan, 10.5, measured at certificate lengths 1/4/16)                                                                | DIRECT read of same cone | ≤1.5× while a batch is live                                                                                                                                                                                                                                                                     | gate, M3                                           |
| G-9  | quiescent-overlay read                                                                                                                                                                                                                            | DIRECT read              | identical within noise                                                                                                                                                                                                                                                                          | gate, M3                                           |
| G-10 | absorption                                                                                                                                                                                                                                        | —                        | a 1000-write transition absorbs in <1 ms; linear in touched atoms, ≤1 propagation per changed atom (counter-verified)                                                                                                                                                                           | gate, M3                                           |
| G-11 | React: signal-driven re-render, click → paint                                                                                                                                                                                                     | `useState` equivalent    | within 10%                                                                                                                                                                                                                                                                                      | gate, M7                                           |
| G-12 | React: 10k `useSignal` mounts                                                                                                                                                                                                                     | 10k `useState`           | within 15%                                                                                                                                                                                                                                                                                      | gate, M7                                           |
| G-13 | React handler path, steady re-render traffic                                                                                                                                                                                                      | —                        | zero engine allocations, verified by heap profiling                                                                                                                                                                                                                                             | gate, M7                                           |
| G-14 | tearing stress (writes sustained during time-sliced renders)                                                                                                                                                                                      | —                        | zero torn frames (DOM-snapshot verified)                                                                                                                                                                                                                                                        | gate, M5                                           |
| G-15 | memory: effects-10k retained heap                                                                                                                                                                                                                 | alien-signals            | ≥30% reduction (report `heapUsed` + plane bytes side by side)                                                                                                                                                                                                                                   | gate, M7                                           |
| G-16 | log-plane residue after quiescence                                                                                                                                                                                                                | —                        | zero bytes, zero live slots                                                                                                                                                                                                                                                                     | gate, M3                                           |
| G-17 | speculation high-water marks (plane G bytes, memo counts) on transition benchmarks                                                                                                                                                                | —                        | published per run                                                                                                                                                                                                                                                                               | report                                             |
| G-18 | tracing unloaded                                                                                                                                                                                                                                  | no-tracing build         | zero overhead within noise (one check per site)                                                                                                                                                                                                                                                 | gate, M6                                           |
| G-19 | tracing enabled (RING, default capacity, ref-ring off), tier-0 shapes; SESSION measured alongside                                                                                                                                                 | untraced build           | ≤1.15× (the packed-recorder budget, 16.2), SESSION within noise of RING (same emit path); the measured numbers become the pinned regression gates thereafter                                                                                                                                    | gate, M6                                           |
| G-20 | traced run, engine + recorder                                                                                                                                                                                                                     | —                        | RING: zero allocations per event; SESSION: zero per event with exactly one chunk allocation amortized per `chunkSize` events (heap-profile verified — the fidelity property of 16.2)                                                                                                            | gate, M6                                           |
| G-21 | SESSION losslessness under sustained engine load until `maxBytes` breach                                                                                                                                                                          | —                        | decoder proves one gap-free event-id range up to the emitted `truncation-marker`; zero silent loss; sealed chunks streamed during recording decode identically to post-hoc                                                                                                                      | gate, M6                                           |

Asymptotic claims (O(1) truncation splice, O(live entries) retirement,
O(cone) notify walk) are verified by instrumented counters in debug builds,
never eyeballed.

### 18.3 Bytecode budgets (CI-enforced authoring constraint)

V8 (Node 24 defaults) refuses to inline callees above ~460 bytecodes,
greedily inlines at or under 27, and caps cumulative inlined bytecode per
optimized function at 920 — and typed-array field access generates roughly
2× the bytecode of a named-property load, so arena code hits these ceilings
at half the source size object code would. The proven case: the monolithic
edge-tracking helper measured 475 bytecodes and was silently never inlined
into the read paths; splitting the insertion tail out took the hot path to
168 bytecodes and won −8% to −13% on traversal shapes. Silence is the
danger — nothing warns when a refactor pushes a function past the ceiling —
so budgets are declared and enforced:

- **Every function reachable from `readAtom`, `readComputed`, `write`,
  `propagate`, `checkDirty`, `notifyWalk`, or world resolution carries a
  comment declaring its measured bytecode size**, and the budget table in
  `tools/schema.ts` (15.2) mirrors it.
- The perf harness dumps actual sizes via `node --print-bytecode
--print-bytecode-filter=<names>` over a warmup script; **CI fails if any
  budgeted function exceeds its declared budget by more than 10%**.
- Initial budget pins: `link` ≤ 200 (measured 168 — this one guards the
  inlining cliff and may not be raised without a ledger entry);
  `linkInsert` declared out-of-line with a raised budget and a justifying
  comment (it is deliberately the never-inlined slow half, and it is where
  the overlay's mark repair lives — a CI grep asserts `link` itself contains
  no repair code); `propagate`, `checkDirty`, `notifyWalk` ≤ 460 each;
  `readAtom`, `write` fast paths ≤ 200.
- Hot-path helpers keep their rare tails out-of-line (allocation slow paths,
  insertion paths, growth triggers, error throws). No accessor functions for
  plane fields — raw `M[id + C.FIELD]` is the idiom (27-bytecode accessors
  would inline greedily but burn the cumulative budget deep engine chains
  need for real helpers).
- The same harness asserts optimized-code status of hot functions after
  warmup and monomorphic IC states on kernel call sites (natives-syntax
  probes behind a version-pinned wrapper).

### 18.4 Pre-registered experiments

Registered before implementation so the results can't be argued with after:

- **E1 — DIRECT/LOGGED write gate: scalar branch vs closure swap.** The
  branch is the safe default: closure rebuild is proven for _monotonic_
  swaps (growth — O(log n) events, feedback re-stabilizes), but the
  quiescence gate oscillates per interaction burst (LOGGED while React has
  work, DIRECT at every idle gap), and a call site that has seen two closure
  identities keeps polymorphic feedback — risking the measured +34–43%
  mutable-binding cost class on every handle call site. The swap wins only
  if steady regression stays under the branch's **and** feedback stays
  specialized across 1,000 mode oscillations, checked with `--trace-deopt`.
  (`strictLanes` builds never oscillate, but the default must be measured
  as the default behaves.)
- **E2 — broadcast-cost fallback threshold.** If G-7's measured N exceeds
  3×, compare the memoized-cutoff broadcast against always-broadcast
  (render-time bailout) on the same fan-out shapes before choosing the
  default.
- **E3 — log-plane locality.** If kairo-scale transition profiles show
  cache misses on interleaved tapes, test per-batch segment allocation
  against the global bump pointer.

### 18.5 Benchmark matrix

| mode                                                                  | measures                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| core, DIRECT                                                          | kernel parity vs alien-signals v3 (the donor numbers are the floor)                                                                         |
| core, LOGGED, no batches live                                         | the read-gate and write-gate overhead in the worst "engaged but idle" state                                                                 |
| synthetic transition (fake fork): N deferred writes → retire → absorb | log append throughput, notify-walk + broadcast cost (G-7), absorption cost per entry, sweep cost                                            |
| held-open transition + hot read loop                                  | world-memo effectiveness (G-8)                                                                                                              |
| React app benches                                                     | click-to-paint vs `useState`; 10k-subscription mount; transition with M signal writes vs M setStates; suspense resolve-to-paint             |
| memory                                                                | retained heap + plane bytes on effects-10k and grid shapes; log-plane residue after quiescence (must be zero); speculation high-water marks |
| growth stress                                                         | full suite at `initialRecords: 2` (correctness) and growth-event timing (must stay boundary-only)                                           |

---

## 19. Milestones and build order

Each milestone has falsifiable exit gates drawn from sections 17–18. Two
standing rules apply to every milestone:

- **Price on entry.** A milestone that introduces a hot-path mechanism
  measures that mechanism's cost as its _first_ deliverable, before anything
  is built on top — unpriced costs do not accumulate.
- **Nothing green goes stale.** Every milestone from M2 onward re-runs the
  steady-parity gate (G-2), the frozen-kernel contract suite (17.5), and the
  bytecode budgets (18.3) as part of its exit. A gate that only ran once is
  a claim, not a gate.

**M0 — Fork.** The complete protocol surface, frozen before anything builds
on it: integer batch-token registry (6.2), pass lifecycle **including
yield/resume edges and render lineage** (6.3), write classification (6.4),
batch entanglement (6.5), per-root commit notification (`onBatchCommitted`,
6.1), mutation window (6.6). These are protocol-surface facts — the ones
that are expensive to discover missing later, because every milestone above
builds on section 6 as frozen. _Exit:_ reconciler suite 17.7 green,
including the entanglement tests (with the drain-shaped usage),
yield/resume pairing, lineage stability, per-root commit delivery, and
token-encoding edge cases.

**M1 — Kernel with dormant overlay.** Port the donor kernel onto the schema
(15.2); add the five overlay-support mechanisms (8.7), present but dormant
— including the stride-2 broadcast queue and the notify walk's mark-only
variant; stand up codegen (planes M, G, and W all schema'd from day one),
the debug twin, budget CI, and the frozen-kernel contract suite. _Exit:_
179/179 conformance including growth stress and exact pull counts; contract
suite green (behavioral identity with the frozen artifact, overlay empty);
G-1 (≤1.0× alien-signals) and G-2 (≤1.03× frozen artifact) on every tier-0
shape; budgets green.

**M2 — Tape mechanics, priced on day one.** The quiescence write gate
(9.1), batch-slot interning (9.2), `appendLog` with mark-on-creation and
the equality/receipt rule (9.3), applied/unapplied writes (9.4), the notify
walk and token-grouped drain (9.8, without memo machinery yet), driven by
the simulated fork. _First deliverable:_ the measurements this
architecture's viability rests on — the tape-creation cost across cone
sizes (G-6a), the steady logged write tax (G-6b, ≤2×), and the
deferred-write drain cost (G-7, N registered, provisional ≤3×) — plus
mounted-quiet in both gate configurations (G-4) and the unmarked-read gate
(G-5, ≤1.1×). Run experiment E1 (18.4) and fix the write-gate mechanism.
_Exit:_ those gates green with numbers recorded; the write-gate boundary
matrix (17.3) green; standing rules.

**M3 — Worlds, oracle-first.** Build the naive model and schedule generator
(17.2) **before** the machinery — with the oracle's watcher decisions
derived from world values, so it models the corrected semantics rather than
any walk. Then implement against the running fuzz: visibility (10.2–10.3),
plane W with certificates, the collector, and the slot memo chains (10.5 —
this milestone's data structures, not a later optimization), the drain
re-validation (9.8), the post-eval re-check (10.4), retirement/absorption
(9.5), sweep/truncation (9.6), coalescing, and quiescence including the
epoch bump and plane-W reset (9.7). _Exit:_ oracle suite and pinned
regressions green; overlay unit scenarios (17.3) and divergent-dep tests
(17.4, including T1's three-mechanism assertion) green; invisibility tests
(17.5) green; G-8 (marked-cone reads ≤1.5×, certificate-scan dimensions),
G-7's registered-node dimension re-measured with re-validation live, G-9,
G-10, G-16 green; standing rules.

**M4 — Policy layer.** Atom/ReducerAtom/Computed, wrappers and boxes (11.2–
11.3), the updater/reducer purity contract with its debug assertion (12.2),
promise protocol with lineage-keyed caches and settlement epoch bumps
(12.3), observed lifecycle (12.4), `configure` (including `strictLanes`),
FinalizationRegistry (14.2). _Exit:_ full core API tests; suspense unit
tests; standing rules.

**M5 — React bindings.** Bridge (with yield/resume context flips and
per-root committed views), hooks, watcher broadcast, world-aware
post-subscribe fixup with entanglement (13.2), transitions helpers, SSR
(per-request engines, serialize/initialize helpers, 13.8). _Exit:_ the
React integration suite 17.6 — the 14-scenario bar, the known-bug
mount-mid-transition case, the yield-gap test, the grouped-drain lane test,
the write-gate contract family (loose, strict, and the watcher-count
counterexample), the entanglement single-commit test with its
no-false-positive variant, the two-batch re-notify test, the divergent-dep
notify test, the per-root committed test, the ReducerAtom/useReducer
differential, the flushSync exclusion with its one-computed-downstream
variant, tearing stress (G-14) — all green; standing rules.

**M6 — Tracing, formatter, graphviz.** Tracer slot, the packed trace
recorder in all three modes (OFF/RING/SESSION) and its decoder view (16.2),
DevTools formatter and terminal twin (16.3), DOT renderers (16.4),
traced-kernel stamp swap (16.5). _Exit:_ G-18 (zero overhead unloaded);
G-19 (tracing-enabled overhead measured against the ≤1.15× ceiling, SESSION
within noise of RING, both pinned); G-20 (allocation discipline per mode,
heap-profile verified); G-21 (SESSION losslessness: gap-free event-id proof,
truncation-marker on `maxBytes` breach with degrade-to-RING, sealed-chunk
streaming decodes identically during and after recording); whole-boot
capture recipe test (session started before first engine operation; decoder
verifies completeness from event id 0); cause-chain answer tests
(`whyDidRender` et al.) running as decoder views over the packed records;
ring-overwrite and drop-counter tests; DOT snapshot tests;
attach/detach-traced-kernel test; standing rules.

**M7 — Benchmarks and hardening.** Register in the js-reactivity-benchmark
(core mode, in-transition mode, LOGGED-idle mode); React microbenches;
memory regression suite (mount/unmount churn, transition churn back to
baseline, FinalizationRegistry sweeps under `node --expose-gc`,
growth-then-quiescence); kairo ratchet review (G-3: close to ≤1.25× via
ledger experiments or adopt-and-publish the honest number); docs pass (every
public symbol documented in plain English with its invariants). _Exit:_ the
full 18.2 gate table, every row.

---

## 20. Open risks

Ordered by expected annoyance. Every risk names its mitigation and, where
one exists, its gate.

1. **The watcher broadcast does world evaluation on the write path.** Wide
   fan-outs (one atom, thousands of watchers) pay one memoized evaluation
   per written node per drain plus a per-watcher compare, and the drain
   additionally re-validates the pending world's registered memos (the slot
   chain, 9.8). Designed mitigations: node-level memo sharing (10.5–10.6),
   drain-level walk sharing, chains bounded by touched nodes (9.8). Gate G-7
   with a pre-registered ceiling, the always-broadcast fallback (E2), and
   the edge-plane escalation for chain scans (9.8). Residual risk:
   pathological shapes where many _distinct_ marked nodes each carry
   watchers, or a single world evaluates very many nodes.
2. **World-memo invalidation is conservative.** A memo's certificate scan
   invalidates when _any_ recorded source's tape moves, even from an
   unrelated batch that folds to the same value, and the epoch bump
   wholesale-invalidates every memo at each retirement, truncation, and
   overlay-relevant settlement — wasted re-evaluations, never wrong answers.
   A long transition with frequent urgent commits re-evaluates its cone per
   commit. Gate G-8 bounds the common case; the trace event `computed-eval`
   with `memo-hit?` makes the pathological case diagnosable.
3. **Absorption spikes.** A transition holding very many logged writes
   absorbs at one commit. Coalescing (9.3) bounds tape length per atom; the
   residual risk is many _distinct_ atoms. Gate G-10 (<1 ms per 1000
   writes); if a real workload breaks it, absorption can incrementalize
   (absorb per-atom across microtasks) at the cost of a more complex W0
   invariant — flagged, not designed.
4. **The loose write-gate contract is a real, documented parity deviation.**
   An idle-time write does not inherit the lane of the notification it
   triggers, and the setTimeout/flushSync schedule can paint a one-frame
   cross-component mismatch (9.1). Risk: an application depends on exact
   lane semantics for idle writes without realizing it. Mitigations: the
   contract is documented where users will read it (9.1 and the `configure`
   doc comment), `strictLanes` restores exact parity with one option, and
   the contract-documentation tests (17.6) make the behavior a pinned,
   deliberate fact rather than an emergent one.
5. **The flushSync-excludes-default case is load-bearing for the always-log
   rule inside LOGGED mode (9.1).** If React's behavior around entangled
   default lanes shifts, the rule could relax; conversely any future "skip
   logging" optimization must re-prove this case _and_ pass the write-gate
   contract family. The 17.6 tests pin it.
6. **Batch entanglement (6.5) reaches deeper into the reconciler than any
   other fork API** — it overrides lane assignment, not just observes it —
   and the token-grouped drain (9.8) makes it a routine path, not a rare
   fixup. The commit-phase re-pend rule (6.5) is the subtle part.
   Mitigations: the 17.7 tests run against every React rebase; the fallback
   path (urgent correction) is always correct, merely less atomic, so a
   regression here degrades to an extra frame, not a wrong value.
7. **FinalizationRegistry reclamation latency** leaves records allocated
   until GC runs. Bounded cost; a pathological create-and-drop loop of
   module-level atoms grows the plane. Documented; deterministic `dispose()`
   on handles is the pressure valve if needed.
8. **Fork drift.** The registry, entanglement, and yield/resume hooks touch
   the work loop's most-edited files. Mitigation: the patch is additive and
   small (6.7); the reconciler suite runs on every rebase; the version-skew
   rule fails loudly on stock React.
9. **Two engine instances from bundle duplication** would each intern tokens
   independently — correct but wasteful, and watchers would split across
   engines. A `globalThis` symbol guard warns loudly in dev.
10. **Multiple simultaneous renderers** (react-dom + a custom renderer):
    write attribution answers from the first registered provider (6.1).
    Documented limitation, matches upstream precedent.
11. **Counter wraparound** (tokens 6.2, seqs 9.7, walk tickets 9.7, the
    epoch) is handled by design, but the wrap paths are nearly untestable
    in production-like conditions; they get direct unit tests with forced
    counter values (17.2's pinned list).
12. **Log-plane locality** degrades if many atoms interleave writes (each
    tape's records scatter in global append order). Seq order equals append
    order, so replay walks are forward-only; if profiles show misses,
    per-batch segment allocation is the pre-registered fix (E3). The memo
    plane's certificate region shares the exposure and the fix.

---

## Appendix A: Decision record

Why this architecture, in ten bullets. This appendix is the only place the
document discusses roads not taken; everything above it is the road taken.

1. **The log-overlay won a four-way adversarial review.** Four candidate
   architectures were specified in full and judged across four lenses
   (React correctness, performance, implementability, risk): this design;
   a _versioned core_ that threads world metadata through every node and
   link of the hot graph; _forked worlds_ that copy shadow values per
   pending batch and serve reads from per-world planes; and a _minimal
   kernel_ that quarantines the proven engine behind a host protocol and
   maintains a second shadow topology for pending worlds. The log-overlay
   ranked first overall and was the only candidate whose worst findings
   were a specification gap and a bounded slowness rather than a wrongness
   — the other three each computed wrong values, lost writes, or committed
   torn frames in at least one legitimate schedule.
2. **Correctness was weighted as the product, and this design's visibility
   model is React's own.** The visibility rule (10.2) maps clause-for-clause
   onto React's hook-queue lane filtering; the rebase walkthrough (10.7)
   reproduces React's updater-queue result exactly; and this is the only
   design of the four that can even _represent_ the same-event
   flushSync-excludes-default-batch case (9.1) — the case that forces
   always-logging and that no "skip the log when nothing looks concurrent"
   scheme survives.
3. **Rejected: the no-log urgent write path** (from the versioned-core
   candidate). Applying urgent functional updates directly and discarding
   them makes the commit-time fold provably wrong (it computes 3 where
   React computes 4 in the standard interleaving), and the only repair —
   retaining urgent entries — _is_ the always-log rule. The write tax is
   the honest price; it is gated at ≤2× (G-6b) instead of wished away.
4. **Rejected: drop-on-abort retirement** (from the forked-worlds
   candidate). Discarding a batch's writes when it produced no React work
   means `startTransition(() => atom.set(x))` with no subscribed component
   silently reverts — whether a write persists must never depend on who
   happened to be subscribed. Here, `committed = false` batches fold
   identically (9.5); the flag is trace metadata.
5. **Rejected: pin-free worlds invalidated through canonical topology**
   (also from forked-worlds). Deriving invalidation from one world's
   dependency set while serving another world's cache tears on
   world-divergent dependencies. This design re-walks dependencies per
   world; keys memo validity on the _re-observed_ read set, recorded in full
   — unlogged reads included, as zero pairs — in packed certificates (10.5);
   carries per-world registries (the slot memo chains) so pending-world-only
   dependencies still notify watchers (9.8); and keeps the divergence
   scenarios as a permanent test family (17.4). An earlier draft of this
   design recorded only logged atoms in certificates and walked only
   canonical topology — both holes were found in review and closed at
   design time; the certificate-zeros rule and the drain re-validation are
   the closures.
6. **Rejected: the dual-kernel shadow topology and per-recompute host
   indirection** (from the minimal-kernel candidate). Maintaining a second
   subscriber topology for pending worlds pays a permanent tax on
   benchmarks the donor kernel already wins and makes "did we sync every
   shadow edge?" a standing completeness obligation whose failure is a
   committed mixed-world frame. The single-kernel overlay makes both
   problems unrepresentable: there is one topology, and speculation lives
   in a side plane that resets to zero.
7. **Imported from the losers: their process discipline.** The randomized
   replay oracle (17.2) and its build-it-first sequencing, the
   whole-suite-inside-an-episode invisibility tests (17.5), comment-declared
   CI-enforced bytecode budgets (18.3), pre-registered experiments (18.4),
   per-milestone numeric exit gates with re-runs (19), the frozen-artifact
   contract suite (17.5), the placement table (11.4), and the
   template-stamping codegen with regenerate-and-diff CI (15.2) all
   originated in the three rejected designs. Their architectures died; their
   engineering hygiene is most of sections 15–19.
8. **The write-mode gate was decided in three rounds, and the loose
   contract is a chosen trade, not an oversight.** _Watcher-count gating_
   ("log once someone subscribes") was rejected as unsound — the app's
   first transition writes before any watcher exists and leaves no receipt
   for the component that mounts mid-transition. _Permanent logging from
   bridge activation_ was rejected as the default because it taxes every
   imperative write in every React app forever, including idle-time timer
   and socket writes React never sees. The adopted _quiescence gate_ logs
   exactly the writes any future render could need to exclude — everything
   concurrent with open or pending React work — and knowingly gives up lane
   inheritance for writes made while React is fully idle: the documented
   loose contract (9.1), bounded to a convergent one-frame mismatch, with
   `configure({ strictLanes: true })` restoring exact parity for
   applications that want it and both rejected gates' counterexamples kept
   as permanent gatekeeper tests (17.6).
9. **Everything else rejected was rejected on measurement or premise, with
   the numbers kept.** The object-graph implementation (a
   previous-generation engine with per-atom object logs supplied this
   design's semantics nearly verbatim; the arena kernel beat it on every
   tier-0 shape, and log records are precisely the short-lived small
   objects arenas eliminate best); heap-object world memos (packed plane-W
   records won on the certificate-scan inner loop that the
   held-open-transition gate prices); parallel struct-of-arrays columns
   (1.8× worse on deep chains); accessor/DataView struct libraries (never
   compile to `M[id + LITERAL]`); bounds-check masking (+21% creation); a
   WASM kernel (~100 ns/call boundary tax per read); every buffer-binding
   strategy other than closure constants (+26% to +83%);
   `useSyncExternalStore` and per-subscriber snapshots (forced synchronous
   re-rendering is the de-opt this project exists to eliminate); and, at
   the fork boundary, exposing lane bitmasks (recycled bits cannot name
   batches over time, and they leak reconciler internals) or object batch
   tokens (an interning Map hop per logged write) — integer tokens carry
   the same information for one Int32 store.
10. **The known fallback, should this design's premises fail.** If the
    deferred-write pricing (G-7) or the world-memo gate (G-8) prove
    unmeetable at scale, the minimal-kernel candidate's quarantined-kernel
    plan is the designated fallback base — at a known, measured performance
    price on already-won benchmarks. The milestone structure (19) is
    arranged so that verdict arrives by M3, before the policy and React
    layers are built on top.

---

_End of spec._
