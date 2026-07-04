# cosignal-arena: a concurrent-React signals library on integer arenas

**Status: final design specification, approved for implementation.**

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
  sequences that oracle *before* the machinery it checks.

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

Four facts are impossible to observe from userspace, and are exactly what our
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
4. **How to schedule an update *into* a specific existing batch** — so a
   component that subscribed a moment too late can issue a corrective
   re-render that commits *with* the pending batch it missed, not after it
   (the batch-entanglement API, section 6.5; used by section 13.2).

Plus one unrelated nicety (also from the fork): a bracket around the window
where React mutates the DOM, so a `MutationObserver` can ignore React's own
mutations. Section 6.6.

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
| **write log / log / tape** | Per-atom singly-linked chain of log records in the log plane: the atom's recent writes, each tagged with operation, batch slot, and sequence tickets. Empty for almost every atom almost all the time. |
| **base record** | The first record of every log: a synthetic entry holding the atom's value from the moment the log was created. Replays start from it. |
| **seq / ticket** | A number from one global take-a-number counter, stamped on every log record at append time. Gives every logged write a position on one shared timeline. |
| **retirement** | The moment a batch leaves React's books — its commit, or the close of a batch that never produced React work. Delivered exactly once per token by the fork. |
| **absorption** | Folding a retired batch's log entries into canonical kernel state: replay visible entries in seq order, write the result through the kernel (which propagates staleness and queues effects). |
| **truncation** | Discarding log entries without absorbing them (speculation abort, optimistic rollback, devtools). |
| **canonical world (W0)** | The world the kernel's values describe: all committed state, plus urgent writes that were applied directly (section 9.4). The only world the kernel knows. |
| **pass world (Wp)** | The world one render pass must see: determined by its **pin** and **include mask**. |
| **newest world (Wn)** | Every write visible, pending or not. What reads outside render see. |
| **writer's world** | For a given write: the world containing all committed state, all retired entries, and the writing batch's own entries. The world used to decide whether a watcher must be told about the write (section 10.6). |
| **pin** | The seq-counter value captured when a render pass starts. The pass may not see anything that happened after its pin, even if it yields and resumes. |
| **include mask** | The 32-bit batch-slot mask of the batches a render pass includes (from the fork's `includedBatches`). |
| **overlay mark** | A per-node stamp meaning "some atom below me currently has a log". Nodes without the mark can answer any world from the kernel cache. Written by the notify walk. |
| **notify walk** | The overlay's downstream walk from a written atom: stamps overlay marks and collects watchers for broadcast. Runs on every deferred write (once per drain for batched writes), not just the first — this is what guarantees watchers hear about *every* deferred write, including a second write from a different batch into an already-marked region (section 9.8). |
| **walk ticket** | The id of a notify walk, from a monotonic counter. A node's overlay mark stores the last walk ticket that visited it; "marked" means the stored ticket is newer than the **era floor**. |
| **era floor** | A scalar holding the walk-ticket value at the last quiescence. Bumping it to the current ticket counter un-marks every node in O(1), with no walk. |
| **world memo** | A per-computed, per-world cache of an overlay evaluation, validated by re-checking the log tails of the logged atoms *that evaluation actually read* (section 10.5). The mechanism that keeps long-lived transitions from degenerating marked regions into recompute-per-read. |
| **quiescence** | The state of having no live logs, no live batches, and no open render pass. The overlay resets itself to zero cost at quiescence. |
| **handle** | The user-facing object (`Atom`, `Computed`, …) wrapping a node id. Handles are ordinary objects; the arena records behind them are reclaimed when handles are garbage-collected or deterministically disposed. |
| **oracle** | The deliberately naive reference implementation of the overlay (plain per-atom arrays, replay-everything reads, memo-free computeds) that the real engine must agree with on every read across randomized schedules (section 17.2). |
| **frozen kernel artifact** | The donor arena engine, built without any overlay support, kept as a reference build. The contract suite (section 17.5) proves the shipping kernel is behaviorally identical to it whenever the overlay is empty. |

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
core's single checked slot; not loading it costs one `tracer !== undefined`
check per traced site. The tracer records into a packed integer ring
(zero allocation per event — traces of a zero-allocation engine must not
manufacture the GC pressure they claim to observe); human-readable events are
a lazy decoder view. `cosignal/graphviz` renders DOT source for the live
dependency graph and for causal trace timelines, and imports only *types* from
tracing.

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
│   log plane G, seq tickets, batch slots, notify walks, marks,      │
│   visibility resolution, world memos, absorption/truncation        │
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
  benchmark never execute a single overlay instruction. (Whether this gate is
  a scalar branch or a closure swap is a pre-registered experiment with the
  branch as the safe default — section 18.4.)
- **Read gate** — one branch per read. For atoms it is folded into the flags
  word the read loads anyway (`FLAG_LOGGED`); for computeds it is
  `overlayLive !== 0 && M[c + OVERLAY_STAMP] > eraFloor` — when the overlay
  is quiescent, the first scalar comparison short-circuits. This is the "log
  empty?" branch of the design brief, and it is the *only* overlay cost the
  canonical engine ever pays while quiescent.

Life of a write, end to end, in LOGGED mode:

1. `atom.set(x)` — policy checks `isEqual(newest-visible value, x)`; equal
   writes stop here.
2. Ask the fork: `isCurrentWriteDeferred()`, `getCurrentWriteBatch()` (an
   integer token). Intern the token to a batch slot (0–31).
3. Append a log record to the atom's log (creating the log, with its base
   record, if empty): operation, batch slot, payload, seq ticket. If the
   write is urgent (not deferred), *also* apply it through the kernel
   immediately and mark the record APPLIED (section 9.4).
4. Notify downstream. For an **urgent** write, the kernel's own propagation
   walk queues core effects and collects **watchers** (React subscriptions)
   onto a broadcast list. For a **deferred** write — which by design does not
   touch kernel propagation — the overlay runs a **notify walk** from the
   atom: a pure integer walk over subscriber edges that stamps overlay marks
   ("a log exists below me") and collects watchers onto the same broadcast
   list. The notify walk runs for *every* deferred write (shared once across
   a batched group of writes), not just the first write into a region — this
   is what guarantees a second deferred write, even from a different batch
   into an already-marked region, still reaches watchers (section 9.8).
5. The write call drains the broadcast list synchronously before returning:
   for each collected watcher, evaluate the watched node **in the writer's
   world** (memoized per node per world, section 10.5–10.6) and call the
   watcher's `setState` in the writer's stack if the value changed — so React
   lanes are inherited.
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
  external state*), the registry skips serials still held by its ≤31 live
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
(object → integer) plus the entanglement entry point (6.5). The per-edge cost
with no live tokens is an integer/null check.

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

### 6.5 Batch entanglement (`unstable_runInBatch`)

The problem this solves: a component can subscribe to a signal *after* a
pending deferred batch already wrote to it (the component mounted, or first
read the signal, in the gap between that batch's write and this component's
commit). The component must now be re-rendered *as part of that batch* — its
corrective update has to render with the batch's other updates and commit in
the same frame. Wrapping the corrective `setState` in a fresh
`startTransition` is **not** enough: `startTransition` starts a *new*
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
*reconciliation* mutations. Documented exclusions callers must filter
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
  a per-root active-pass set.
- `packages/react-reconciler/src/ReactFiberBatchRegistry.js` — new: the
  31-slot token registry, its five edges (6.2), and the lane-override scope
  backing `unstable_runInBatch` (6.5).
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

The field tables in this section are the human-readable rendering of the
layout schema; the schema file itself (`tools/schema.ts`, section 15) is the
single source of truth, and the tables in `docs/layout.md` are generated from
it so they cannot rot. The tables are reproduced here so this document stands
alone.

### 7.1 Layout principles (each one measured, not aesthetic)

- **Record interleaving, not parallel columns.** A record's fields live
  contiguously (one cache line, one bounds-check domain). Naive
  one-array-per-field layouts measured 1.8× *worse* than objects on deep
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

| offset | name | meaning |
| --- | --- | --- |
| +0 | `FLAGS` | state machine + kind bits (table below) |
| +1 | `DEPS` | first link of my dependency list; free-list next when freed |
| +2 | `DEPS_TAIL` | last *confirmed* dependency link (re-run cursor) |
| +3 | `SUBS` | first link of my subscriber list |
| +4 | `SUBS_TAIL` | last subscriber link |
| +5 | `GEN` | generation counter, bumped on free; stale disposers no-op |
| +6 | atoms: `LOG_HEAD` — first log record id in plane G, 0 = no log. computeds / effects / watchers: `OVERLAY_STAMP` — the walk ticket of the last notify walk that visited me; overlay-marked iff greater than the global `eraFloor` |
| +7 | atoms: `LOG_TAIL` — last log record id. computeds: `MEMO_KEY` — the world key of the first entry in my world-memo list (fast hit check; section 10.5). effects/watchers: reserved (0) |

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
| `memos` | `id >> 3` | 1 | computeds: world-memo list — a small array of per-world overlay memo entries (valid per the seq-check rule in section 10.5); `undefined` when the node has never been overlay-evaluated |
| `meta` | `id >> 3` | 1 | policy metadata object, only for nodes that need one: `{ label?, isEqual?, reducer?, observeEffect?, liveCount, lastBroadcast?, thenableCache?, finalizerToken? }`. `undefined` for plain nodes. |
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
  program-wide), `loggedAtomCount`, `seqCounter`, `walkCounter` (notify-walk
  ticket counter), `eraFloor` (walk-ticket value at last quiescence; marks
  at or below it are stale), `overlayEpoch` (bumped on retirement and
  truncation — the tape events that change world values *without* appending;
  world memos carry it, section 10.5), `writeMode` (DIRECT/LOGGED), and the
  pass set: `passOpen`, `passSerial`, `passPin`, `passIncludeMask`,
  `passContainer`.
- `loggedAtoms: number[]` — ids of atoms with live logs (absorption and
  sweep iterate this; append on first log entry, compact on sweep).
- Persistent traversal scratch: `propStack`, `checkStack` (Int32Array,
  doubling, with base save/restore so re-entrant walks unwind to their own
  base — these replace the per-propagation cons-cell allocations that cost
  the object-based competitor ~1.5 ms of GC per deep-chain benchmark run).
  The notify walk reuses `propStack` under the same discipline.

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
| world memo entry | one small object (~48–80 B: value ref + world key + source-atom/seq arrays), allocated once per overlay *evaluation* (never per read), reclaimed at sweep/quiescence | n/a |

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
2. **Notify walk.** `notifyWalk(atom, walkTicket)`: walk every node reachable
   from the atom through subscriber edges, using `propStack`. At each node:
   if `M[node + OVERLAY_STAMP] === walkTicket`, stop (already visited by
   *this* walk — the diamond dedup); otherwise store the ticket into
   `OVERLAY_STAMP` and continue into the node's subscribers. Nodes carrying
   the `IMMEDIATE` flag (watchers) are additionally pushed onto
   `broadcastQueue`. The stored ticket doubles as the overlay mark: a node is
   "marked" iff its stamp exceeds `eraFloor`, so re-walking a region with a
   fresh ticket both refreshes marks and re-collects watchers. The walk is a
   pure integer traversal; it runs no user code and allocates nothing. The
   overlay calls it on every deferred write (shared across a batched drain —
   section 9.8); this repetition is deliberate and is the mechanism by which
   *every* deferred write reaches watchers.
3. **Mark repair on new edges.** In `linkInsert` (the out-of-line slow path —
   zero cost on the cursor-hit fast path): if the overlay is live and the new
   producer is marked (or is a LOGGED atom), stamp the consumer and its
   transitive subscribers with the current `walkCounter` value. This
   maintains the mark invariant — *every node reachable via subscriber edges
   from a logged atom is marked* — when a canonical re-evaluation picks up a
   brand-new dependency mid-era.
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
- Scratch stack pointers return to their saved bases on every exit path
  (including the notify walk's).
- No kernel function allocates a JS object. (The only allocations are
  Int32Array doubling and side-column pushes, both at boundaries.)
- `eraFloor <= walkCounter` always; no node's `OVERLAY_STAMP` exceeds
  `walkCounter`.
- While quiescent (`loggedAtomCount === 0`): no node's `OVERLAY_STAMP`
  exceeds `eraFloor`, plane G's bump pointer is 0, and `seqCounter` is 1.

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
is unsound. The proof case: an event handler does an urgent `atom.set(x)`
while a default-priority batch from earlier in the same event is still
pending, and then calls `flushSync`. React renders the flushSync work
*without* the default-priority batch — a legitimate render of a world in
which the urgent write has happened but the earlier batch has not. If the
urgent write had skipped the log and gone straight to the canonical value,
nothing could reconstruct that older world; only a log entry lets the
flushSync render answer correctly. No "is anything concurrent live?"
predicate can rescue the skip, either: at the moment of the urgent write
there may be no pass open and no deferred batch live, and the flushSync
arrives later in the same event. So we take the always-log rule and make the
log entry cheap instead: ~6 Int32 stores plus one side-array store, gated at
≤2× a DIRECT write (18.2).

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

Note what `appendLog` does **not** do: it does not notify anyone. Downstream
notification — marks and watcher broadcast — is a separate step that runs on
*every* write, not just the tape-creating one; section 9.8 specifies it.

**Same-batch coalescing** (bounds tape growth for hot atoms during long
transitions): if the tail entry belongs to the same batch, is unretired, and
*no render pass is currently open* (an open pass may be pinned between the
two writes), then a new SET replaces the tail record's payload and seq
in place, and a new UPDATE/DISPATCH may compose onto a tail UPDATE/DISPATCH
of the same batch (function composition is input-independent, so composing is
always sound; composition allocates one closure and is applied only after the
tape for that batch exceeds a small threshold, default 8 entries). With
coalescing, per-atom tape length is O(live batches) between passes. A
coalesced write is still a write: it goes through the same notification step
as an ordinary append (9.8).

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
- drops world-memo entries (10.5) whose world key names a retired batch, and
  trims memo lists opportunistically (memo validity is self-checking, so
  this is garbage hygiene, not correctness).

**Truncation** is the abort primitive: `truncateBatch(slot)` unlinks every
entry of a batch from every tape *without folding*, fixing up chains and
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
- `eraFloor = walkCounter` — every overlay mark in the graph becomes stale in
  O(1), with no walk (a mark is live only if its stored walk ticket exceeds
  `eraFloor`, and no stored ticket exceeds the counter);
- `seqCounter` resets to 1 — pins and retire stamps from the previous era are
  all dead, so tickets can restart, making 31-bit seq overflow unreachable in
  practice (an era would need 2^31 logged writes with no quiescent moment).

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
2. **Watchers must be told about *this specific write*** so they can decide —
   per the writer's world — whether to schedule a re-render (10.6). This is
   a per-write fact. A design that only walks on the *first* write into a
   region has no path from a second write to the watchers below it: the
   region is already marked, the walk would stop immediately, and a deferred
   write triggers no kernel propagation. Concretely: transition T1 writes
   atom `a`, marking the cone and notifying watcher W in T1's lane; then
   transition T2 (a different batch) writes `a` again. Without a per-write
   walk, W never issues a setState in T2's lane, T2's render never includes
   W's component, and T2 commits a frame where W shows stale state — a
   missed-update tear. The same failure hits a *second write from the same
   batch* whose first write was suppressed by the broadcast cutoff (the
   first write didn't change the watched value, the second one does).

The rule, therefore: **every deferred write runs the notify walk (8.7.2)
before its wrapper returns.** The walk stamps marks and collects watchers in
one pass; the wrapper then drains the broadcast list, evaluating each
watcher's watched node in the writer's world and calling `setState` only on
real change (10.6).

Cost containment, since this walk is the overlay's most-repeated act:

- **One walk ticket per drain, shared across a write group.** Inside an
  engine `batch()` (including `startSignalTransition`, and React's own
  event-handler scope where the bindings batch broadcasts), the walk for all
  writes in the group runs at drain time with a single fresh ticket:
  `walkCounter++` once, then `notifyWalk(atom, walkCounter)` per written
  atom. Overlapping cones dedup against the shared ticket, so a 50-write
  transition over one region walks the region once, not 50 times. Watchers
  are collected once and evaluated once per drain against the writer's
  world — which now includes all 50 writes.
- **The walk is pure integer traversal** — no user code, no allocation,
  same cost class as the kernel's own `propagate` over the same cone. The
  expensive part is never the walk; it is the per-watcher world evaluation,
  which is memoized per (node, world) and shared across watchers of the same
  node (10.5–10.6).
- **Priced, not presumed.** The full deferred-write cost — walk plus
  broadcast evaluations — is measured on day one of the overlay milestone
  and carries a pre-registered gate (≤N× a DIRECT write for the standard
  fan-out shapes, N recorded at that milestone with a provisional ceiling of
  3×; section 18.2). If the measured cost breaks the ceiling, the fallback
  is also pre-registered: an "always broadcast, let React bail out" mode
  that skips the world evaluation and lets the watcher's render-time world
  read discover no-change (React's own bailout then prunes the render) — a
  slowness trade, never a correctness one.

Urgent writes need none of this machinery: they apply through the kernel, so
`propagate` reaches watchers via the broadcast list (8.7.1), and the region's
marks are already maintained (the tape-creating write marked it; new edges
repair via 8.7.3). The two-batch scenario above, its same-batch cutoff
variant, and the urgent/deferred interleavings are pinned as unit scenarios
in 17.3 and generated at random by the oracle fuzz in 17.2.

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
if and only if either:

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
cached value). The overlay mark (stamped by the notify walk 8.7.2, repaired
by 8.7.3, cleared in bulk by raising `eraFloor`) is a conservative "may
differ" bit:

```
readComputed(c, ctx):
  if loggedAtomCount == 0 or M[c+OVERLAY_STAMP] <= eraFloor:
      return kernelComputedRead(c)                     // the fast path
  if ctx == NEWEST and unappliedEntries == 0:
      return kernelComputedRead(c)   // Wn == W0 when nothing is unapplied
  return overlayEvaluate(c, ctx)
```

Marks over-approximate (a marked computed might still be world-identical);
the cost of a false positive is one overlay evaluation — and usually less,
because of the world memos below — never a wrong answer.

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

**The memo entry.** Each overlay evaluation of computed `c` in world `w`
records, into the `memos[c >> 3]` list:

```
{ key: worldKey(w),      // integer; encoding below
  epoch: overlayEpoch,    // structural-tape-event counter at eval time
  value: result,          // or an error/suspended box, like any cached value
  srcAtoms: int[],        // ids of the LOGGED atoms this evaluation read,
                          //   in this world (collected by the read wrapper
                          //   during the evaluation — the re-observed set)
  srcSeqs: int[] }        // for each srcAtom: the seq of its tape's tail
                          //   record (G[M[a + LOG_TAIL] + SEQ]) at eval time
```

`srcAtoms` is the **re-observed dependency set**: the logged atoms this
world's evaluation actually touched, which may differ from the canonical
dependency list (a world where a feature flag is on reads different inputs
than the canonical world where it is off). Keying validity on the re-observed
set rather than the canonical one is load-bearing: it is what makes a
same-batch follow-up write to a world-only dependency invalidate the memo
(the tear class that sinks designs which derive invalidation from one world's
topology while serving another world's cache — tested exhaustively in 17.4).

**World keys** (disjoint integer encodings):

| world | key |
| --- | --- |
| newest (Wn) | `0` |
| a render pass's world (Wp) | `(passSerial << 2) | 1` |
| a writer's world for batch token t | `(t << 2) | 2` |

**Validity.** A memo entry answers a read when its key matches the reader's
world, its `epoch` equals the current `overlayEpoch`, and:

- **Pass worlds: key and epoch match suffice.** A pass's world cannot change
  mid-pass: new appends carry seqs above the pin (invisible by 10.2), and
  retirements stamp `RETIRED_SEQ` above the pin (clause 1 fails; clause 2's
  answer for included batches is unchanged). Each pass start bumps
  `passSerial`, so a restarted pass — which may legitimately see newer
  state — misses the old memos by key. Two integer comparisons, no seq
  checks.
- **Newest world and writer's worlds: key and epoch match plus source-tail
  checks.** For each `srcAtoms[i]`: the atom must still carry the `LOGGED`
  flag and its tail seq (`G[M[a + LOG_TAIL] + SEQ]`) must equal
  `srcSeqs[i]`. Any mismatch — a new append, a coalesce (which rewrites the
  tail seq), an absorption that swept the tape — invalidates the entry, and
  the read re-evaluates and re-memoizes. The check is a handful of integer
  loads per source atom, and transitions touch few atoms, so `srcAtoms` is
  short.

Why the epoch exists: appends move a tape's tail seq, but two tape events
change world values *without* appending — **retirement** (stamping RETIRED
on batch entries makes them visible in *other* batches' writer's worlds and
in the newest-world's committed component) and **truncation** (unlinking a
mid-tape entry leaves the tail untouched). Both bump `overlayEpoch`
(9.5/9.6), wholesale-invalidating memos at commit/abort frequency — cheap,
conservative, and it keeps the high-frequency event (appends during a
held-open transition) on the precise per-source check.

The combined check is deliberately one-sided: it may re-evaluate
unnecessarily (an append to a source atom in an unrelated batch invalidates
a newest-world memo that would have folded to the same value) but can never
serve a stale value: any write that could change the answer in world `w`
must either append to some logged atom the evaluation read in `w` (moving
that atom's tail seq) or restructure a tape (bumping the epoch).

**Storage and hygiene.** The list lives in the `memos` side column; the node
field `MEMO_KEY` mirrors the key of the list's first entry so the common
"same world reads the same node repeatedly" case hits with one Int32 load
before touching the list. Lists are small (one entry per live world that
actually read the node — in practice: the newest world, one or two pass
worlds, a writer's world or two) and are trimmed at sweep (entries whose key
names a retired batch or a closed pass) and abandoned wholesale at
quiescence, when the read gate stops consulting them entirely.

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

For unmarked nodes (no overlay anywhere below), the kernel's ordinary cutoff
already guarantees notify fires only on real change; the watcher broadcasts
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
(everything users can configure). The test for every future feature: *if it
inspects a user value, a user option, or React, it is policy; if it is
integer math over the planes, it is mechanism.*

### 11.1 The cut, operation by operation

| operation | mechanism (kernel/overlay) | policy (kinds/React layer) |
| --- | --- | --- |
| create | record allocation, flags init | handle construction, meta allocation, wrapper synthesis |
| tracked read | `link` cursor/splice, flags checks | read-context selection, log replay payload application |
| write | pending-value slot, `propagate`, broadcast/effect queues, notify walk | equality short-circuit, log append decision, deferred/urgent classification |
| recompute | `checkDirty` walk, `update` call, `!==` compare, `shallowPropagate` | what "evaluate" means: ctx, isEqual, error/suspense capture (all inside the stored wrapper fn) |
| notify | queue discipline, outer-before-inner order, IMMEDIATE routing | watcher broadcast rule (world evaluation + cutoff + setState) |
| log lifecycle | record packing, chains, slots, seq tickets, visibility *mask* math, sweep/truncate splicing | replaying payloads (SET/UPDATE/DISPATCH semantics), absorption equality, when to absorb (retirement orchestration) |
| world memos | memo-list storage, key/seq validity math | what gets memoized (evaluation results, boxes) |
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
noise (validated in the shapes harness before committing to this cut; see
18.5).

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

### 11.4 The placement table: where every future feature lands

The cut's thesis in one table. The kernel column is tiny and closed;
everything a product engineer will ever ask for lands in the overlay, the
policy kinds, the React bindings, or the fork. When a new requirement
arrives, find its row (or its nearest neighbor) before writing code — a
feature with no natural row is a design smell to resolve in review, not in
the kernel.

| concern | kernel | overlay | policy kinds | React bindings | fork | why there |
| --- | :-: | :-: | :-: | :-: | :-: | --- |
| Dependency tracking, staleness, exact recompute order | ● | | | | | The hot walks; must stay packed and monomorphic. The only pure-kernel row. |
| Write logging, visibility, absorption, sweep | | ● | | | | Multi-versioning is tape math over plane G; the kernel gets memory mechanics only (8.7.5). |
| Notify walk, marks, era floor | ● (walk) | ● (when) | | | | The walk is integer traversal (kernel mechanism); *when* to walk is overlay policy (9.8). |
| World memos | | ● | | | | Validity is integer seq math; contents are opaque values. |
| Atom/ReducerAtom/Computed classes, `set`/`update`/`dispatch` | | | ● | | | Value semantics are policy; kernel sees invalidate/update facts only. |
| Equality (`isEqual`, cutoffs) | | | ● | | | User closures never enter kernel call sites (11.2). |
| Promises / suspense (`ctx.use`) | | | ● | ● | | Thenable protocol is value policy (12.3); suspending a component is a binding concern (13.2). |
| Atom observed-lifecycle `effect` | | | ● | | | Driven by kernel LIVE-bit facts (8.6, 12.4). |
| Effect queue and flush timing | ● | | ● | ● | | Queue mechanics are kernel; "when reactions run" is policy; passive-effect timing rides React (13.4). |
| Batch identity and lifecycle | | ● (slots) | | ● (orchestration) | ● (tokens) | Fork mints integer tokens (6.2); overlay interns slots (9.2); bindings orchestrate retirement (13). |
| Batch entanglement | | | | ● (uses) | ● (provides) | Only the reconciler knows lanes (6.5); only the bindings know when a fixup needs it (13.2). |
| Hooks (`useSignal` …) | | | | ● | | Hook protocol, watcher lifecycle, fixups (13). |
| Transitions / `startTransition` parity | | ● (logs) | | ● (broadcast in writer's stack) | ● (classification) | Fork classifies writes (6.4); overlay logs/rebases; bindings inherit lanes (13.1). |
| Infinite-loop rejection | | | ● | ● | | React's own guards via real setState; engine cycle checks for signal-only loops (4.7). |
| Writes-in-computeds toleration + forbid switch | ● (detection) | | ● (choice) | | | Cycle detection is graph mechanism (RECURSED flags); forbidding is configuration (12.5). |
| Multiple roots, SSR/hydration | | | | ● | ● | Containers from fork; recipes in bindings (13.7–13.8). |
| Tracing and causality | ● (traced build) | ● (choke points) | ● | ● | | Tape append + overlay read are the two semantic choke points (16.2); kernel detail via the generated traced build (16.5). |
| Graphviz renderers | | | ● | | | Read-only iteration over planes + labels (16.4). |
| DOM mutation window | | | | | ● | Pure React-commit concern (6.6). |
| Growth and reclamation | ● | ● | ● (Finalization) | | | Kernel: free lists, rebuild, generations. Policy: handle lifetime (14). |
| Labels, devtools formatting | | | ● | | | Debug metadata; never on a hot path (16.3). |

The kernel column changes only if the graph algorithm itself changes — and
that is exactly the code this project wants frozen, proven, and monomorphic.

---

## 12. Signal kinds and promise handling

How the three public kinds sit above the kernel. Each kind is: a handle
class, a meta record (only if it has options), and rules for the three policy
sites (write, replay, recompute).

### 12.1 Atom

- `set(v)` → equality gate → DIRECT: kernel write. LOGGED: append SET
  (+ apply if urgent), then notify per 9.8.
- `update(fn)` → the *function* is the payload (never pre-evaluated in LOGGED
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
known-bug test we inherit and turn green, 17.6). If the value is a
`SuspendedBox`, call React's `use(thenable)` — a conditional `use` is legal —
so Suspense fallbacks and replays behave exactly as for a suspending
`useState` initializer.

Commit phase (layout effect): create/rebind the watcher node and link it to
the signal, then run the **post-subscribe fixup** for writes that raced into
the gap between render and subscription. The watcher remembers the world key
and value it rendered with; the fixup compares against the worlds that exist
*now*:

- **Committed value moved past what we rendered** (an urgent write or an
  absorption landed in the gap): call `setVersion` immediately, in the
  layout effect's own (urgent) context — a pre-paint correction, the same
  shape React uses for its own layout-effect updates.
- **A deferred batch wrote in the gap**: for each live deferred batch slot
  whose tape entries affect the watched node, evaluate the node in that
  batch's writer's world (10.2, memoized per 10.5) and compare with the
  rendered value. For each batch where the value differs, issue the
  corrective `setVersion` through the fork's batch-entanglement API:
  `unstable_runInBatch(token, () => setVersion(bump))`. The correction is
  thereby assigned to the pending batch's own lanes — it renders with that
  batch and commits in that batch's frame (6.5). If `runInBatch` returns
  false, the batch retired between our check and the call; its values are
  already absorbed into committed state, so the first rule (immediate
  urgent `setVersion`) already covers it — the fixup re-checks the committed
  comparison and falls back to that path.

Why `startTransition` around the corrective setState would be wrong, and why
entanglement is required: a fresh `startTransition` mints a *new* batch with
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
  record ids onto the free list when handles are collected. Registration
  happens once per handle at construction; finalization latency is bounded by
  the watermark slack (a record lingering costs 32 B + side slots, never
  correctness). Unwatched computeds already drop their dependency links
  (kernel `unwatched`), so an unreferenced computed holds no graph edges
  while awaiting finalization.
- **Log entries**: swept by chain splice (9.6); the whole plane resets at
  quiescence (9.7).
- **World memos**: trimmed at sweep, abandoned at quiescence (10.5); a
  previously-marked computed may retain one small dead list until its next
  overlay use — bounded, documented, harmless.

### 14.3 Memory-visible guarantees (tested)

- Quiescent overlay = zero log-plane residue, zero live batch slots, all
  marks stale (stamps at or below `eraFloor`).
- Steady-state re-render traffic allocates nothing in the engine (log
  records in LOGGED mode come from the plane; broadcast closures and version
  bumps allocate nothing; world-memo entries allocate only on overlay
  *evaluations*).
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
the emitted code carries literals no matter how the *library* is built.
Cross-file `const enum` is packaging-dependent (esbuild transform mode and
`tsc --isolatedModules` leave runtime property accesses) and is forbidden.
The enum is never exported; nothing crosses the public `.d.ts` boundary.

This choice deliberately overrides the project's general "assume
stripping-only TypeScript transforms" guideline, and here is the honest
accounting. The guideline exists so *consumers* never need a real TS
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

- all three planes (`M` stride 8, `G` stride 4, and the tracing module's
  ring plane `T` stride 8 — section 16.2; ids pre-multiplied; record 0
  burned in M and G);
- every record family and field: slot number, a `kind` string (`flags`,
  `NodeId`, `LinkId`, `LogId`, `u31`, `spare`), a doc comment, and an owner
  note (which operation writes the field, which clears it);
- the flag-bit registry (the generator fails on overlapping bits) and
  derived masks (`KIND_MASK`);
- side-column addressing (`values` at `id >> 2`, `fns`/`memos`/`meta` at
  `id >> 3`, `logVals` at `gid >> 2`);
- named constants (`REC_SLACK = 1280`, watermarks, `LAYOUT_VERSION`);
- the bytecode-budget table for hot functions (consumed by CI, 18.3).

Spare slots are *named* (`SPARE7`), so claiming one is a schema edit plus
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
type NodeId = number & { readonly __brand: 'NodeId' }
type LinkId = number & { readonly __brand: 'LinkId' }
type LogId  = number & { readonly __brand: 'LogId' }
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
visibility must be *built*, and cheaply. One economy runs through this whole
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

**Storage: a packed arena ring, not an object stream.** Trace events are
fixed-size integer records in their own `Int32Array` ring (the trace plane
`T`, stride 8, capacity a power of two, default 2^16 records = 2 MiB). The
reasoning is the same asymmetry that shaped every other plane in this
design: the **write side is hot** — per-read and per-write events fire at
engine frequency — while the **read side is rare and human** (someone opened
devtools). So writes are packed integer stores and reads hydrate lazily.
Three consequences make this a requirement rather than a preference:

- **Fidelity.** An object-allocating tracer perturbs exactly the thing being
  observed: this is a zero-allocation library, and its GC behavior is a
  measured, gated property (18.2). A tracer that allocates one object per
  event manufactures GC pressure that isn't there untraced, making every
  traced profile a lie. A zero-allocation recorder is the only way traces of
  a zero-allocation engine are trustworthy.
- **Flight-recorder mode.** Because recording is allocation-free and
  fixed-cost, the ring can run *always-on* in development ("last 65k events
  before the bug"), overwriting oldest records — feasible only packed; an
  object stream with this policy would be a permanent allocation storm.
- **The decoder is not extra cost.** Reading the ring requires an
  id-to-object decoder — which the design already builds: the generated
  debug twin (15.2) that powers the DevTools formatter and `verifyArena`.
  The trace record layout lives in `tools/schema.ts` like every other plane,
  so its decoder, docs table, and field constants are generated by the same
  pipeline. The human-facing outputs (timeline, cause-chain queries, DOT
  renderings) are required deliverables regardless of representation; only
  the recorder's cost model was at stake, and packing wins it.

**Record layout** (trace plane `T`, stride 8; generated from the schema):

| offset | name | meaning |
| --- | --- | --- |
| +0 | `KIND` | event-kind tag (6 bits) + kind-specific flag bits (applied?, cutoff-suppressed?, memo-hit?, committed?, fallback-taken?, equality-dropped?) |
| +1 | `CAUSE` | event id of the provoking event (the causality edge); 0 = root cause. A module-level `currentCause` scalar is set around each emitting operation, so a broadcast carries its write's event id and a render-read carries the broadcast that scheduled it |
| +2 | `NODE` | primary subject: node id / log id / watcher id (per kind) |
| +3 | `WORLD` | world key, batch token, or include mask (per kind) |
| +4 | `TIME` | microseconds since the previous event (delta encoding; saturates at 2^31−1, and a saturated delta emits a `clock-sync` event carrying an absolute timestamp in its arg slots) |
| +5..+7 | `ARG0..ARG2` | kind-specific integers: seq, walk ticket, duration in µs, counts, label ids |

The event **id** is a monotonic counter; a record's ring position is
`id & (capacity − 1)`, so an id both names an event and locates it until
overwritten (a decoder detects overwrite by comparing ids; a drop counter
records how many events a lagging subscriber lost). **Labels and other
strings** never enter the ring: they are interned once (at node creation /
first use) into a table mapping small integer label ids to strings, and
records carry the ids. **Rare object payloads** — an absorb's old/new
values, a thenable identity — go into a small side **ref-ring** (a plain
array, default capacity 256, parallel-indexed by its own counter; the trace
record stores the ref-ring index in an arg slot). Documented retention rule:
the ref-ring retains those objects until overwritten — bounded by its
capacity, but it *can* extend object lifetimes, so its capacity is
configurable and 0 disables ref capture entirely (events still record,
payload slots read as "dropped").

**Event kinds and their payloads** (fields mapped onto the record slots
above):

| kind | payload |
| --- | --- |
| `atom-write` | atom id, op, batch token, seq; flags: applied?, equality-dropped? |
| `log-append` / `log-coalesce` / `truncate` | atom id, log id, batch token |
| `batch-retired` | token, entries stamped; flags: committed? |
| `absorb` | atom id, old/new via ref-ring; flags: changed? |
| `computed-eval` | node id, world key, duration µs, deps-read count; flags: memo-hit? |
| `notify-walk` | atom id, walk ticket, nodes stamped, watchers collected |
| `notify` / `broadcast` | node id, watcher id; flags: cutoff-suppressed? |
| `entangle` | watcher id, batch token; flags: fallback-taken? |
| `effect-run` | node id, duration µs |
| `render-pass-start/end` | container label id, pin, include mask |
| `render-read` | node id, world key; flags: resolved-via (kernel / replay / memo) |
| `suspend` / `settle` | node id, thenable ref-ring index, world key |
| `mark-repair` / `sweep` / `quiescence` / `clock-sync` | counts / absolute time |

**The decoder view.** The verbose "object event" (`{id, time, cause, type,
…named fields}`) exists only as a **lazy decoder view over the ring** —
generated hydrators that materialize one event object on demand — never as a
second recorder. Everything human-facing sits on that view: the subscription
API (subscribers receive decoded events in chunks at operation boundaries —
the feed for the planned Chrome devtools timeline extension), the cause-chain
helpers (`whyDidRerun(computedOrLabel)`, `whyDidRender(componentLabel)`,
`effectRunCount(label)`, which walk `CAUSE` edges *inside the ring* and only
decode the events they return), and the DOT renderer (16.4).

**Cost, gated.** Untraced: one `tracer !== undefined` check per site (G-18,
zero within noise). Traced: per event, a bounds-masked bump, seven integer
stores, and one `performance.now()` — no allocation. The falsifiable target:
with tracing enabled at default capacity (ref-ring off), tier-0 shapes run
at **≤1.15× untraced**, measured and recorded at M6 (gate G-19); if the
measured number beats the ceiling, the measured number becomes the pinned
regression gate thereafter.

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
`graphviz` imports only *types* from tracing and reads the planes through
the debug twin's accessors. Either loads without the other.

### 16.5 The traced kernel build

Kernel-internal detail (flag transitions, link churn, scratch-stack depth)
is deliberately *not* behind per-site tracer checks in the production
kernel — the production kernel contains zero tracing instructions. When
that detail is needed, the generated **traced kernel stamp** (15.2) — the
same code with integer event emits spliced at its `/*TRACE*/` marks,
writing `flags-transition` / `link` / `unlink` / `stack-depth` records into
the same trace ring (16.2) — is swapped in at an operation boundary using
the growth machinery (rebuild the engine closure over the same buffers).
Attach and detach on a running app; the production stamp's type feedback is
never touched.

### 16.6 Debug builds and the invariant sweeper

`__COSIGNAL_DEBUG__` builds enable the kernel invariant assertions (8.8),
tape invariants (the W0 fold equals the kernel value after every
absorption), memo validity audits, and `verifyArena()` — the generated
sweeper that walks both planes and, like a database integrity check, reports
*all* problems rather than stopping at the first: allocation partition
(every record on exactly one of live graph / free list / pendingFree;
free-list chains acyclic, terminating at 0, below the bump pointer; record 0
all-zero), field typing from the schema's `kind` strings (a `LinkId` field
is 0 or a live link of the right role; spares read 0; exactly one kind bit
per live node), graph coherence (every link present exactly once in both of
its intrusive lists, prev/next coherent both directions, tails reachable),
side-column hygiene (freed records' `values`/`fns`/`memos` slots are
`undefined`), and scheduler coupling (queued ids have kind bits; scratch
stack pointers at their bases at operation boundaries). It runs at natural
barriers: end of flush, end of batch, after every conformance case in debug
CI, and inside every randomized-oracle step (17.2). Production builds
compile all of it out (15.4).

---

## 17. Testing plan

Seven suites. CI runs them cheapest-signal-first (17.1, 17.5, 17.3, 17.4,
17.2's pinned cases, 17.6, 17.7, then 17.2's long fuzz). Build order is the
reverse of nothing: the plan's one sequencing rule is that **the oracle
(17.2) is built before the overlay machinery it checks** — the naive model
is deliberately cheap to write (a snapshot-everything reference), and the
sweep, coalescing, and mark-repair code must be developed *against* it, not
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
dispatch reduces). Computeds are memo-free recursive functions that re-derive
from oracle atom reads in the same context every time. Watcher decisions
re-derive the writer's-world value from scratch. No marks, no memos, no
tapes: the model is too slow to ship and too simple to be wrong.

**The schedule generator** emits randomized interleavings of: urgent and
deferred writes (`set`/`update`/`dispatch`) across 1–33 concurrent batches
(33 forces the slot-exhaustion fallback), render passes (pin + random
include mask) with reads in every context at random points, pass yields and
restarts, retirements (`committed` both true and false) in random legal
orders, truncations, sweeps at random boundaries, coalescing-eligible write
runs, world-divergent computed topologies (17.4's shapes, generated), new
edges appearing mid-era (exercising mark repair), growth events (forced
doubling mid-schedule), and quiescence (assert the 9.7 residue-zero
postconditions, then keep going in the new era).

**The assertions.** At every read point: real engine equals oracle — same
node, same context, same world. At every retirement: the absorbed kernel
value equals the oracle's fold. At every broadcast drain: the set of
watchers that called `setState` equals the set the oracle derives (this is
what makes the deferred-notify path of 9.8 fuzz-verified, not just
scenario-tested). In debug builds, `verifyArena()` runs after every step.

**Seed and shrinking discipline** (supplied here because it matters as much
as the oracle): the suite runs on fast-check's model-based command runner.
Every failure prints its seed and path; CI re-runs are reproducible from
them. Shrinking is enabled so a failure arrives as the *minimal*
desynchronizing op sequence, and every shrunk failure is committed as a
pinned deterministic regression case before the fix lands. The pinned list
starts with the design's known danger cases: the rebase walkthrough (10.7),
the two-batch write into an already-marked region and its same-batch
cutoff-suppressed variant (9.8), the flushSync-exclusion case (9.1),
set-superseded-by-urgent, functional replay over a moved base, a pass pinned
across two retirements (retention), slot reuse after retire, a suspended
entry surviving commit, seq-counter and walk-counter wrap (forced counter
values), and coalescing blocked by an open pass.

CI budget: a short fuzz (fixed seed count) on every push; a long nightly
fuzz with fresh seeds.

### 17.3 Overlay unit scenarios (no React; simulated fork)

A fake external runtime driving the bridge lets every concurrency scenario
run as a fast, deterministic unit test: the pin/include visibility truth
table (each clause of 10.2 in isolation and combination), the rebase
walkthrough (10.7) and its functional-update variants, absorption folds with
interleaved urgent/deferred/equal writes, `committed = false` folds (the
writes are real), sweep correctness under multiple pinned passes,
truncation, slot-exhaustion fallback, coalescing legality (never across an
open pass; coalesced writes still notify), quiescence resets (era floor,
seq, plane G, memo abandonment), the mark invariant under new-edge repair
(8.7.3), world-memo validity across appends/coalesces/absorptions (10.5),
memo keying across pass restarts, and the deferred-notify matrix of 9.8:
second write same batch (cutoff-suppressed first write), second write
different batch, urgent-then-deferred and deferred-then-urgent on one atom,
wide fan-out with shared node memos (one evaluation, many watchers).

### 17.4 World-divergent dependency scenarios

A computed's dependency set can differ per world: `c = () => flag.state ?
a.state : b.state` reads `a` only where the pending world's `flag` is true.
Any engine that derives invalidation from one world's topology while serving
another world's cache tears on this family; this design is immune by
construction — overlay evaluations re-walk dependencies per world, and memo
validity keys on the *re-observed* source set (10.5) — and these tests keep
it that way. Common setup: atoms `flag=false, a=0, b=0`; computed `c` as
above; a watcher on `c`; deferred batch k.

- **T1, the core tear test:** evaluate `c` canonically (reads `flag,b` → 0);
  write `flag=true` in k; read `c` in k's world (reads `flag,a` → 0, memo
  cached); **same batch**, write `a=1` in k. Assert: k-world read of `c`
  returns 1 (the cached 0 must have been invalidated by the tail-seq check
  on `a`), the watcher is notified in k's lane, and the committed-world read
  still returns 0 via `b`.
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
  case that forces the always-log rule, 9.1);
- **the entanglement test (13.2):** hold a transition open, mount a late
  subscriber to a signal the transition wrote, and assert exactly **one**
  commit containing both the transition's updates and the corrective
  re-render — plus the fallback: retire the batch between subscription and
  fixup and assert the urgent-correction path repaints before paint;
- **the two-batch re-notify test (9.8), full stack:** two overlapping
  transitions writing the same atom region; assert the second transition's
  render includes every subscribed component (no missed setState in the
  second lane);
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
per-root commit lock-in, pass start/end pairing across yields and restarts,
exactly-once retirement, integer-token encoding (deferred bit, no reuse
while live, generation rollover, lane reuse under a live batch),
**`unstable_runInBatch`**: updates scheduled inside join the batch's lanes
(one commit), retired-token false return, commit-phase scheduling re-pends
the token (no race window), nesting rules; mutation-window bracketing
including View Transitions and `flushSync`; listener-error isolation; and
inertness (no listener → reconciler trace diff is empty).

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

| # | mode / measurement | baseline | number | kind |
| --- | --- | --- | --- | --- |
| G-1 | core DIRECT, every tier-0 shape | alien-signals v3 | ≤1.0× each (donor reference points: deep 0.90, broad 0.84–0.88, diamond 0.89, reads 0.74–0.87, create 0.96) | gate, M1 |
| G-2 | core DIRECT, steady parity | frozen kernel artifact | ≤1.03× each tier-0 shape (the dormant-overlay tax must be one branch) | gate, M1, re-run every later milestone |
| G-3 | kairo suite, GC-inclusive, bundled child | alien-signals v3 | ≤1.4× every test (the measured current reality — an honest ceiling, not an aspiration); ratchet reviews at each milestone may only lower it; ≤1.25× is the M7 target via pre-registered ledger experiments, and if unmet, M7 exits with the ratcheted number adopted and published in its place | gate (1.4×) + ratchet |
| G-4 | LOGGED mode, mounted-but-quiet (watchers exist, no batches live), tier-0 | core DIRECT | ≤2% regression | gate, M2 |
| G-5 | LOGGED read of an unmarked node | DIRECT read | ≤1.1× | gate, M2 |
| G-6 | logged **urgent** write (append + apply + broadcast bookkeeping) | DIRECT write | ≤2× | gate, M2 (priced on day one of the tape milestone) |
| G-7 | logged **deferred** write, drain-amortized (notify walk + writer's-world broadcast evaluations, standard fan-out shapes: 1 atom → 10/100/1000 watchers) | DIRECT write | ≤N×; N measured and pre-registered at M2 with provisional ceiling 3×; breaking the ceiling triggers the pre-registered fallback (always-broadcast mode, 9.8) | gate, M2 |
| G-8 | held-open transition, hot NEWEST read loop over the marked cone (the world-memo gate) | DIRECT read of same cone | ≤1.5× while a batch is live | gate, M3 |
| G-9 | quiescent-overlay read | DIRECT read | identical within noise | gate, M3 |
| G-10 | absorption | — | a 1000-write transition absorbs in <1 ms; linear in touched atoms, ≤1 propagation per changed atom (counter-verified) | gate, M3 |
| G-11 | React: signal-driven re-render, click → paint | `useState` equivalent | within 10% | gate, M7 |
| G-12 | React: 10k `useSignal` mounts | 10k `useState` | within 15% | gate, M7 |
| G-13 | React handler path, steady re-render traffic | — | zero engine allocations, verified by heap profiling | gate, M7 |
| G-14 | tearing stress (writes sustained during time-sliced renders) | — | zero torn frames (DOM-snapshot verified) | gate, M5 |
| G-15 | memory: effects-10k retained heap | alien-signals | ≥30% reduction (report `heapUsed` + plane bytes side by side) | gate, M7 |
| G-16 | log-plane residue after quiescence | — | zero bytes, zero live slots | gate, M3 |
| G-17 | speculation high-water marks (plane G bytes, memo counts) on transition benchmarks | — | published per run | report |
| G-18 | tracing unloaded | no-tracing build | zero overhead within noise (one check per site) | gate, M6 |
| G-19 | tracing enabled, default ring capacity, ref-ring off, tier-0 shapes | untraced build | ≤1.15× (the packed-recorder budget, 16.2); the measured number becomes the pinned regression gate thereafter | gate, M6 |
| G-20 | traced run, engine + recorder | — | zero allocations per event (heap-profile verified — the fidelity property of 16.2) | gate, M6 |

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
  branch is the safe default: closure rebuild is proven for *monotonic*
  swaps (growth — O(log n) events, feedback re-stabilizes), but mode
  oscillates per transition, and a call site that has seen two closure
  identities keeps polymorphic feedback — risking the measured +34–43%
  mutable-binding cost class on every handle call site. The swap wins only
  if steady regression stays under the branch's **and** feedback stays
  specialized across 1,000 mode oscillations, checked with `--trace-deopt`.
- **E2 — broadcast-cost fallback threshold.** If G-7's measured N exceeds
  3×, compare the memoized-cutoff broadcast against always-broadcast
  (render-time bailout) on the same fan-out shapes before choosing the
  default.
- **E3 — log-plane locality.** If kairo-scale transition profiles show
  cache misses on interleaved tapes, test per-batch segment allocation
  against the global bump pointer.

### 18.5 Benchmark matrix

| mode | measures |
| --- | --- |
| core, DIRECT | kernel parity vs alien-signals v3 (the donor numbers are the floor) |
| core, LOGGED, no batches live | the read-gate and write-gate overhead in the worst "engaged but idle" state |
| synthetic transition (fake fork): N deferred writes → retire → absorb | log append throughput, notify-walk + broadcast cost (G-7), absorption cost per entry, sweep cost |
| held-open transition + hot read loop | world-memo effectiveness (G-8) |
| React app benches | click-to-paint vs `useState`; 10k-subscription mount; transition with M signal writes vs M setStates; suspense resolve-to-paint |
| memory | retained heap + plane bytes on effects-10k and grid shapes; log-plane residue after quiescence (must be zero); speculation high-water marks |
| growth stress | full suite at `initialRecords: 2` (correctness) and growth-event timing (must stay boundary-only) |

---

## 19. Milestones and build order

Each milestone has falsifiable exit gates drawn from sections 17–18. Two
standing rules apply to every milestone:

- **Price on entry.** A milestone that introduces a hot-path mechanism
  measures that mechanism's cost as its *first* deliverable, before anything
  is built on top — unpriced costs do not accumulate.
- **Nothing green goes stale.** Every milestone from M2 onward re-runs the
  steady-parity gate (G-2), the frozen-kernel contract suite (17.5), and the
  bytecode budgets (18.3) as part of its exit. A gate that only ran once is
  a claim, not a gate.

**M0 — Fork.** Integer batch-token registry (6.2), pass lifecycle (6.3),
write classification (6.4), batch entanglement (6.5), mutation window (6.6).
*Exit:* reconciler suite 17.7 green, including the entanglement tests and
token-encoding edge cases.

**M1 — Kernel with dormant overlay.** Port the donor kernel onto the schema
(15.2); add the five overlay-support mechanisms (8.7), present but dormant;
stand up codegen, the debug twin, budget CI, and the frozen-kernel contract
suite. *Exit:* 179/179 conformance including growth stress and exact pull
counts; contract suite green (behavioral identity with the frozen artifact,
overlay empty); G-1 (≤1.0× alien-signals) and G-2 (≤1.03× frozen artifact)
on every tier-0 shape; budgets green.

**M2 — Tape mechanics, priced on day one.** Batch-slot interning (9.2),
`appendLog` (9.3), applied/unapplied writes (9.4), the notify walk and drain
(9.8), driven by the simulated fork. *First deliverable:* the two
measurements this architecture's viability rests on — the logged urgent
write tax (G-6, ≤2×) and the deferred-write drain cost (G-7, N registered,
provisional ≤3×) — plus mounted-quiet (G-4, ≤2%) and the unmarked-read gate
(G-5, ≤1.1×). Run experiment E1 (18.4) and fix the write-gate mechanism.
*Exit:* those four gates green with numbers recorded; standing rules.

**M3 — Worlds, oracle-first.** Build the naive model and schedule generator
(17.2) **before** the machinery: then implement visibility (10.2–10.3),
world memos (10.5), retirement/absorption (9.5), sweep/truncation (9.6),
coalescing, and quiescence (9.7) against the running fuzz. *Exit:* oracle
suite and pinned regressions green; overlay unit scenarios (17.3) and
divergent-dep tests (17.4) green; invisibility tests (17.5) green; G-8
(marked-cone reads ≤1.5×), G-9, G-10, G-16 green; standing rules.

**M4 — Policy layer.** Atom/ReducerAtom/Computed, wrappers and boxes (11.2–
11.3), promise protocol (12.3), observed lifecycle (12.4), `configure`,
FinalizationRegistry (14.2). *Exit:* full core API tests; suspense unit
tests; standing rules.

**M5 — React bindings.** Bridge, hooks, watcher broadcast, post-subscribe
fixup with entanglement (13.2), transitions helpers, SSR recipe. *Exit:*
the React integration suite 17.6 — the 14-scenario bar, the known-bug
mount-mid-transition case, the entanglement single-commit test, the
two-batch re-notify test, the ReducerAtom/useReducer differential, the
flushSync exclusion, tearing stress (G-14) — all green; standing rules.

**M6 — Tracing, formatter, graphviz.** Tracer slot, the packed trace ring
and its decoder view (16.2), DevTools formatter and terminal twin (16.3),
DOT renderers (16.4), traced-kernel stamp swap (16.5). *Exit:* G-18 (zero
overhead unloaded); G-19 (tracing-enabled overhead measured against the
≤1.15× ceiling and pinned); G-20 (zero allocations per traced event,
heap-profile verified); cause-chain answer tests (`whyDidRender` et al.)
running as decoder views over the ring; ring-overwrite and drop-counter
tests; DOT snapshot tests; attach/detach-traced-kernel test; standing
rules.

**M7 — Benchmarks and hardening.** Register in the js-reactivity-benchmark
(core mode, in-transition mode, LOGGED-idle mode); React microbenches;
memory regression suite (mount/unmount churn, transition churn back to
baseline, FinalizationRegistry sweeps under `node --expose-gc`,
growth-then-quiescence); kairo ratchet review (G-3: close to ≤1.25× via
ledger experiments or adopt-and-publish the honest number); docs pass (every
public symbol documented in plain English with its invariants). *Exit:* the
full 18.2 gate table, every row.

---

## 20. Open risks

Ordered by expected annoyance. Every risk names its mitigation and, where
one exists, its gate.

1. **The watcher broadcast does world evaluation on the write path.** Wide
   fan-outs (one atom, thousands of watchers) pay one memoized evaluation
   per written node per drain plus a per-watcher compare. Designed
   mitigations: node-level memo sharing (10.5–10.6), drain-level walk
   sharing (9.8). Gate G-7 with a pre-registered ceiling and the
   always-broadcast fallback (E2). Residual risk: pathological shapes where
   many *distinct* marked nodes each carry watchers.
2. **World-memo invalidation is conservative.** A newest-world memo
   invalidates when *any* of its source atoms' tapes move, even from an
   unrelated batch that folds to the same value — a wasted re-evaluation,
   never a wrong answer. A long transition plus high-frequency urgent writes
   to a shared source atom re-evaluates per drain. Gate G-8 bounds the
   common case; the trace event `computed-eval` with `memo-hit?` makes the
   pathological case diagnosable.
3. **Absorption spikes.** A transition holding very many logged writes
   absorbs at one commit. Coalescing (9.3) bounds tape length per atom; the
   residual risk is many *distinct* atoms. Gate G-10 (<1 ms per 1000
   writes); if a real workload breaks it, absorption can incrementalize
   (absorb per-atom across microtasks) at the cost of a more complex W0
   invariant — flagged, not designed.
4. **The flushSync-excludes-default case is load-bearing for the always-log
   rule (9.1).** If React's behavior around entangled default lanes shifts,
   the rule could relax; conversely any future "skip logging" optimization
   must re-prove this case. The 17.6 test pins it.
5. **Batch entanglement (6.5) reaches deeper into the reconciler than any
   other fork API** — it overrides lane assignment, not just observes it.
   The commit-phase re-pend rule (6.5) is the subtle part. Mitigations: the
   17.7 tests run against every React rebase; the fallback path (urgent
   correction) is always correct, merely less atomic, so a regression here
   degrades to an extra frame, not a wrong value.
6. **FinalizationRegistry reclamation latency** leaves records allocated
   until GC runs. Bounded cost; a pathological create-and-drop loop of
   module-level atoms grows the plane. Documented; deterministic `dispose()`
   on handles is the pressure valve if needed.
7. **Fork drift.** The registry and entanglement hooks touch the work loop's
   most-edited files. Mitigation: the patch is additive and small (6.7); the
   reconciler suite runs on every rebase; the version-skew rule fails loudly
   on stock React.
8. **Two engine instances from bundle duplication** would each intern tokens
   independently — correct but wasteful, and watchers would split across
   engines. A `globalThis` symbol guard warns loudly in dev.
9. **Multiple simultaneous renderers** (react-dom + a custom renderer):
   write attribution answers from the first registered provider (6.1).
   Documented limitation, matches upstream precedent.
10. **Counter wraparound** (tokens 6.2, seqs 9.7, walk tickets 9.7) is
    handled by design, but the wrap paths are nearly untestable in
    production-like conditions; they get direct unit tests with forced
    counter values (17.2's pinned list).
11. **Log-plane locality** degrades if many atoms interleave writes (each
    tape's records scatter in global append order). Seq order equals append
    order, so replay walks are forward-only; if profiles show misses,
    per-batch segment allocation is the pre-registered fix (E3).

---

## Appendix A: Decision record

Why this architecture, in ten bullets. This appendix is the only place the
document discusses roads not taken; everything above it is the road taken.

1. **The log-overlay won a four-way adversarial review.** Four candidate
   architectures were specified in full and judged across four lenses
   (React correctness, performance, implementability, risk): this design;
   a *versioned core* that threads world metadata through every node and
   link of the hot graph; *forked worlds* that copy shadow values per
   pending batch and serve reads from per-world planes; and a *minimal
   kernel* that quarantines the proven engine behind a host protocol and
   maintains a second shadow topology for pending worlds. The log-overlay
   ranked first overall and was the only candidate whose worst findings
   were a specification gap and a bounded slowness rather than a wrongness
   — the other three each computed wrong values, lost writes, or committed
   torn frames in at least one legitimate schedule.
2. **Correctness was weighted as the product, and this design's visibility
   model is React's own.** The visibility rule (10.2) maps clause-for-clause
   onto React's hook-queue lane filtering; the rebase walkthrough (10.7)
   reproduces React's updater-queue result exactly; and this is the only
   design of the four that can even *represent* the same-event
   flushSync-excludes-default-batch case (9.1) — the case that forces
   always-logging and that no "skip the log when nothing looks concurrent"
   scheme survives.
3. **Rejected: the no-log urgent write path** (from the versioned-core
   candidate). Applying urgent functional updates directly and discarding
   them makes the commit-time fold provably wrong (it computes 3 where
   React computes 4 in the standard interleaving), and the only repair —
   retaining urgent entries — *is* the always-log rule. The write tax is
   the honest price; it is gated at ≤2× (G-6) instead of wished away.
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
   world, keys memo validity on the *re-observed* source set (10.5), and
   carries the divergence scenarios as a permanent test family (17.4).
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
8. **The object-graph implementation was rejected on measurement, not
   taste.** A previous-generation object-based engine with per-atom object
   logs supplied this design's semantics nearly verbatim, but the arena
   kernel beat the equivalent object core on every tier-0 shape, and log
   records are precisely the short-lived small objects arenas eliminate
   best. Likewise rejected with numbers: parallel struct-of-arrays columns
   (1.8× worse on deep chains), accessor/DataView struct libraries (never
   compile to `M[id + LITERAL]`), bounds-check masking (+21% creation), a
   WASM kernel (~100 ns/call boundary tax on per-read calls), and every
   buffer-binding strategy other than closure constants (+26% to +83%).
9. **Rejected: `useSyncExternalStore` and per-subscriber snapshot models.**
   Forced synchronous re-rendering on every store change is the de-opt this
   project exists to eliminate, and per-subscriber value copies buy
   consistency with per-subscriber memory and no transition parity.
   Similarly rejected at the fork boundary: exposing lane bitmasks (recycled
   bits cannot name batches over time, and they leak reconciler internals)
   and object batch tokens (an interning Map hop on every logged write);
   integer tokens carry the same information for one Int32 store.
10. **The known fallback, should this design's premises fail.** If the
    deferred-write pricing (G-7) or the world-memo gate (G-8) prove
    unmeetable at scale, the minimal-kernel candidate's quarantined-kernel
    plan is the designated fallback base — at a known, measured performance
    price on already-won benchmarks. The milestone structure (19) is
    arranged so that verdict arrives by M3, before the policy and React
    layers are built on top.

---

*End of spec.*
