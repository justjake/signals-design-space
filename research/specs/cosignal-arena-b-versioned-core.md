# cosignal-arena (Variant B): Versioned Core

Design spec for a from-scratch, data-oriented signals library with full concurrent-React
integration. In this variant, **multi-versioning is a first-class kernel concern**: every
node record can hold values for several "versions of the world" at once, the propagation
algorithm itself is version-aware, and the tokens React hands us are plain integers that
index directly into kernel tables. There is no overlay or side log bolted onto a
single-version engine — one engine, versioned.

Status: COMPLETE DRAFT. Companion spec: `cosignal-arena-a-log-overlay.md` (Variant A,
same goals, log-overlay architecture). This document is self-contained: it assumes no
prior knowledge of cosignal, alien-signals, or our research; everything is defined in
plain English as it is introduced.

---

## Table of contents

1. [What this is, and the goals it must meet](#1-what-this-is-and-the-goals-it-must-meet)
2. [Background: signals, and why concurrent React breaks them](#2-background)
3. [Vocabulary](#3-vocabulary)
4. [Public API surface](#4-public-api-surface)
5. [Architecture summary and the kernel/policy cut](#5-architecture-summary)
6. [Data layout: planes, records, field tables, byte math](#6-data-layout)
7. [Clocks, stamps, world slots, and views](#7-clocks-stamps-world-slots-and-views)
8. [The read rule](#8-the-read-rule)
9. [Version-aware algorithms: write, propagate, checkDirty](#9-version-aware-algorithms)
10. [Commit, rebase, and abort as kernel operations](#10-commit-rebase-abort)
11. [Promises and Suspense](#11-promises-and-suspense)
12. [The React fork API (integer tokens end-to-end)](#12-react-fork-api)
13. [React bindings: the hooks](#13-react-bindings)
14. [Growth and reclamation](#14-growth-and-reclamation)
15. [Constant inlining strategy](#15-constant-inlining)
16. [Tracing and debugging](#16-tracing-and-debugging)
17. [Testing plan](#17-testing-plan)
18. [Benchmark plan and performance targets](#18-benchmarks-and-performance-targets)
19. [Open risks and alternatives considered](#19-open-risks)
20. [Build order](#20-build-order)

---

## 1. What this is, and the goals it must meet

cosignal-arena is a signals library for React applications. "Signals" means: small
reactive state cells (`Atom`), derived values that recompute automatically when their
inputs change (`Computed`), and effects that re-run when values they read change. The
library must satisfy every requirement of the project brief (PROMPT.md of the
react-signals project), restated here so this document stands alone:

- **Fully concurrent React integration, no `useSyncExternalStore`.** A signal write
  inside `startTransition` must ride that transition exactly like a `useState` update:
  the screen keeps showing the old value while React prepares the new tree in the
  background, urgent updates can interleave without being lost, and nothing "tears"
  (no render ever shows a mix of old and new values).
- **Suspense parity.** A computed can consume a promise; components reading it suspend
  and resume exactly like components using React's own `use()`.
- **The full API surface**: `Atom` (with observed-lifecycle effect, custom equality,
  labels), `atom.set` / `atom.update`, `Computed` with `ctx.use(promise)`,
  `ReducerAtom.dispatch`, and hooks `useSignal`, `useAtom`, `useReducerAtom`,
  `useComputed` (closing over props/state), `useSignalEffect`. An optional
  `startSignalTransition` batching helper is allowed.
- **React's infinite-render-loop rejection applies to signal-driven renders.**
- Writes to atoms from inside computeds are tolerated (unless configured to be
  forbidden), as long as there is no dependency cycle.
- **Multiple React roots** work. Hydration from vanilla server rendering works.
- **A minimal, maintainable React patch** may expose concurrent-rendering lifecycle to
  userspace, but must not leak Fibers or lane bitmasks; internal React shapes stay
  encapsulated. The patch also exposes a DOM-mutation window (when React is about to
  mutate the DOM and when it finished) so an application `MutationObserver` can ignore
  React's own mutations — this is unrelated to signals but ships in the same patch.
- **A lazy-loadable tracing module** giving full causality visibility ("why did my
  computed re-run?"), plus Graphviz renderers for the dependency graph and the causal
  event graph; zero overhead when not loaded.
- **Performance**: competitive with `useState`/`useReducer` for re-render-on-change;
  on par with or ahead of alien-signals (the fastest mainstream signals engine) on the
  pure-signals happy path.
- **Plain-spoken code and writing**; humans must be able to read and maintain it.
- Toolchain conventions: pnpm, TypeScript, prefer `type` over `interface`, prefer
  `undefined` over `null` unless it costs performance. The original brief assumed
  type-stripping-only compilation (no `const enum`); that constraint has since been
  relaxed — the library ships through a compile step (e.g. tsdown), so same-file
  `const enum` is the primary constant-inlining strategy, with a documented fallback
  for stripping-only consumers (section 15).

What makes Variant B distinctive, beyond the brief:

- **Data-oriented storage.** Nodes and dependency edges are fixed-size integer records
  inside one large `Int32Array` (an "arena"), not JavaScript objects. Our research repo
  proved this layout passes the full 179-case reactive-framework conformance suite while
  beating alien-signals on every tier-0 shape benchmark (deep 0.90x, broad 0.84–0.88x,
  diamond 0.89x, reads 0.74–0.87x, creation 0.96x, effect memory −38%). This spec
  builds on that proven kernel (`libs/arena/src/index.ts`).
- **Versioning inside the kernel.** Concurrent React means several "drafts" of
  application state exist at once (the committed state, plus what one or more pending
  transitions would produce). In Variant B the kernel's records, flags, and algorithms
  natively store and propagate several versions; React's transition identity arrives as
  a small integer that selects which version a read or write touches.

### Non-goals (v1)

- React Server Components / Flight integration (hydration from plain SSR is in scope).
- Cross-thread / SharedArrayBuffer operation (the layout is compatible by construction,
  but nothing in v1 crosses threads).
- Persistent undo/history for arbitrary depth (the kernel keeps only the versions React
  can still ask about).

---

## 2. Background

### 2.1 Signals in one page

A signals library is a spreadsheet for program state. An **atom** is a cell holding a
value. A **computed** is a formula cell: a function that reads other cells and produces
a value. The library records which cells each formula read (its **dependencies**), so
when an atom changes it knows exactly which formulas might be stale and which parts of
the UI need to update. An **effect** is a subscription: a function the library re-runs
whenever anything it read changes (used for logging, imperative DOM work, or — in our
React bindings — scheduling a component re-render).

The engine we start from (alien-signals v3.2.1 semantics) works "push-pull":

- **Push (cheap):** when an atom is written, walk its subscriber edges and mark
  downstream nodes "possibly stale" (a flag write per node). Nothing recomputes yet.
- **Pull (exact):** when someone reads a computed marked possibly-stale, walk its
  dependencies, recompute only the ones whose inputs really changed (comparing values —
  the **equality cutoff**), and clear the flags. A formula whose inputs turn out to be
  unchanged is not re-run.

This gives **glitch freedom**: a reader can never observe a state where one formula has
updated but another formula it depends on has not, because reads resolve dependencies
depth-first before producing a value. It also gives **laziness**: formulas nobody reads
cost nothing when their inputs change.

### 2.2 Why concurrent React breaks external state

React 18+ renders concurrently. `startTransition(fn)` tells React: the state updates
made inside `fn` are low priority; keep showing the current screen, prepare the new
screen in the background, and swap when ready. While that background render is in
progress, urgent updates (typing, clicks) can interrupt it, commit first, and the
background work is redone on top. React can also pause a background render mid-way,
yield to the browser, and resume later.

React can do this for its own state (`useState`, `useReducer`) because every `setState`
is queued with a **lane** — a priority tag — and each render applies exactly the queued
updates whose lanes it includes, "rebasing" the rest on top later. React state is
therefore multi-versioned: the same hook can answer "what is your value in the committed
world?" and "what is your value in the world where this transition landed?" differently.

External stores — anything holding state in a plain variable outside React — have only
one current value. React's escape hatch, `useSyncExternalStore`, forces consistency by
brute force: every store change schedules synchronous work, and a store write during a
concurrent render makes React throw away the whole background tree and re-render
synchronously. External state can never ride a transition. That de-opt is what this
library eliminates.

To participate correctly, an external store must know three things only React knows,
plus have somewhere to put multiple values:

1. **Which batch a write belongs to.** When code inside `startTransition` writes an
   atom, that write belongs to the same "batch" as the `setState` calls next to it, and
   must become visible exactly when that batch's render commits — not before.
2. **Which batches a render includes.** When React renders, reads from our store must
   return the values belonging to that render's batches (plus everything already
   committed), even for components mounting for the first time with no subscription yet.
3. **When a batch retires.** When the batch's updates leave React's books (its tree
   committed, or the batch turned out to produce no React work), its writes must fold
   into the committed state, effects must fire, and bookkeeping must be reclaimed.

Our React fork (section 12) exposes exactly these three, plus the DOM-mutation window.
The kernel (sections 6–10) is the "somewhere to put multiple values": every node can
hold, next to its committed value, the value it would have in each pending batch.

### 2.3 Why an arena, and what we already measured

Storing nodes and edges as fixed-stride integer records in one `Int32Array` (instead of
linked JavaScript objects) buys, measured in this repo:

- **Creation** is a bump-pointer increment plus a few integer stores — 40% faster than
  object allocation at benchmark scale, 6x in isolation.
- **Traversal** touches sequential memory with no pointer-chasing GC objects; the
  propagation walk reads flags and links from the same cache lines.
- **No GC pressure** from edges: alien-signals' propagation stacks alone cost it
  roughly 1.5 ms and 23 collections per deep-chain benchmark run; the arena's cost is
  zero.

Measured constraints the design must respect (research summary section 7/7a/7b; these
were all learned the hard way and are treated as walls, not suggestions):

- **Record interleaving wins; parallel per-field arrays lose** (1.8x worse on deep
  chains). Hot fields of a record must sit contiguously.
- **Buffers must be closure `const` bindings.** Growth rebuilds the engine closure over
  doubled buffers ("closure-rebuild growth"); resizable ArrayBuffers, segment tables,
  and mutable bindings all measured 25–80% slower on the read path.
- **Values never move into the arena.** JavaScript values (and functions) stay in
  ordinary packed arrays indexed by record id; type-segregated numeric value columns
  measured slower, and value-in-arena designs re-create Leptos's leak bugs.
- **V8's inliner budget is 460 bytecodes** and typed-array field access costs about
  twice the bytecode of a named-property load: hot helpers must be split so their fast
  paths stay inlinable (the kernel's `link()` fast-path split is worth 8–13%).
- **Module-scope `const` is demoted to `var` by bundlers**, destroying constant folding
  (+15–21%): field offsets and flag masks must reach the JIT as literals by some other
  route than `const enum`, which the toolchain rules forbid (section 15).

---

## 3. Vocabulary

Every term used later, defined once. Read this section; everything else leans on it.

- **Arena / plane:** one large `Int32Array` holding many fixed-size records. We call
  each such array a plane. The main plane is called **M**; a small cold plane for
  version metadata is called **V** (section 6).
- **Record / id:** a record is a fixed run of 8 consecutive int32 slots in a plane. An
  id is the record's byte-order offset (`recordIndex * 8`), so field access is
  `M[id + FIELD]` with no multiply. Id 0 is burned as "none": every "is there one?"
  test is `!== 0`.
- **Node:** a record representing an atom, computed, effect, scope, or watcher.
- **Link:** a record representing one dependency edge ("computed X read atom Y"),
  doubly linked into two lists: Y's subscriber list and X's dependency list. Nodes and
  links share plane M (interleaving them measured faster than split planes).
- **Side columns:** ordinary JavaScript arrays indexed off the id that hold what cannot
  live in an Int32Array: values (`unknown`), functions, error objects, promise state.
- **Committed world:** the state every finished React commit agrees on. When no
  transition is in flight, it is simply "the state".
- **Batch:** a group of updates React renders and retires as a unit; what a
  `startTransition` call (or one event's urgent updates) produces. Batches are the
  library-visible face of React's lanes, without exposing lane bits.
- **Stamp:** the integer identity of a batch, minted by our React fork. Never reused
  within the epoch you can observe it (section 7.2). 0 means "no batch / immediate".
- **Deferred batch:** a transition-like batch — its render does not block paint, its
  writes must stay invisible to the committed world until it retires. Only deferred
  batches create versions in the kernel; urgent writes go straight to the committed
  world (matching React, whose urgent updates commit before the current frame paints).
- **World slot (or slot):** one of a small fixed number (three in v1) of kernel-side
  containers for a live deferred batch's writes. The kernel maps stamp to slot; slot
  indexes are what the packed data structures store. If a fourth concurrent deferred
  batch appears, it **spills** (section 7.4).
- **View:** the set of state a particular read should see: always the committed world,
  plus zero or more world slots. Encoded as a 3-bit **view key** (bit per slot); view
  key 0 is "committed only". A React render pass that includes batches A and B reads
  through the view containing A's and B's slots.
- **Pending entry:** a node's cached value for one view: (view key, state tag, value,
  sequence number it was validated at). Each node has two inline pending-entry
  positions plus a spill table (section 6.4).
- **Chain:** the per-atom, per-slot list of writes made under one batch: plain values
  from `set`, updater functions from `update`, actions from `dispatch`. Chains are what
  make React-style rebasing possible (section 10.2). They live in the policy layer,
  keyed by (node, slot); the kernel only knows "this atom was touched in slot k".
- **Seq (the global clock):** a single monotonically increasing integer, bumped on
  every write and every commit fold. Every write, every pending entry, and every render
  pass carries a seq; comparisons against it implement "did anything relevant happen
  since?" and "was this write visible when this render started?".
- **Pin:** the seq a render pass noted when it started. For the rest of that pass (even
  across yields), reads ignore anything with a newer seq — this is what keeps a paused
  and resumed render self-consistent.
- **Retire:** a batch leaving React's books, exactly once per stamp — normally because
  its tree committed everywhere, occasionally because it never produced React work.
  Retiring **commits** the batch's chains into the committed world (section 10.1).
- **Abort:** a kernel operation that discards a slot's chains without folding them.
  Today's React never asks for this (even discarded work retires through a commit); the
  operation exists for symmetry, tests, and future cancellation APIs (section 10.4).
- **Watcher:** a node kind representing a React hook subscription. Its "run" is a
  policy callback (`setState` on the owning component) instead of a user effect.
- **Kernel:** the single-file, monomorphic engine over the planes: allocation, links,
  flags, version slots, propagation, validation, commit/rebase/abort, the effect queue.
  It never sees React, promises, reducers, or user options.
- **Policy layer:** everything above the kernel: the `Atom`/`Computed`/`ReducerAtom`
  classes, equality options, observed-lifecycle effects, chains and folding, promise
  protocol, React bindings, tracing installation.

---

## 4. Public API surface

The full user-facing API. Everything here is policy-layer; none of it is kernel.

### 4.1 Core signals (framework-independent, `cosignal/core`)

```ts
type AtomCtx<T> = {
  /** The atom's current committed value. */
  readonly state: T
  set(next: T): void
  update(fn: (current: T) => T): void
}

type AtomOptions<T> = {
  state: T
  /**
   * If set, runs when the atom becomes observed (first watcher/effect/watched
   * computed subscribes), and its returned cleanup runs when the atom is no
   * longer observed. Intended for remote subscriptions. Delivery is deferred
   * to a microtask so observe/unobserve flaps within one tick do not thrash.
   */
  effect?: (ctx: AtomCtx<T>) => (() => void) | void
  /** Custom equality; Object.is otherwise. Equal writes do not propagate. */
  isEqual?: (a: T, b: T) => boolean
  /** Shown in tracing and Graphviz output. */
  label?: string
}

class Atom<T> {
  constructor(options: AtomOptions<T>)
  /** Read (auto-tracked when read inside a computed/effect/render). */
  get state(): T
  set(next: T): void
  update(fn: (current: T) => T): void
  readonly label: string | undefined
}

type ComputedCtx<T> = {
  /**
   * Consume a promise inside a computed. If pending, the computed enters the
   * "suspended" state (readers suspend / effects wait); once settled, the
   * computed re-evaluates and `use` returns the value or throws the reason.
   * Identity is cached positionally per evaluation so re-runs are stable.
   */
  use<U>(promise: PromiseLike<U>): U
  /** The previous value this computed produced in this view, if any. */
  readonly previousValue: T | undefined
}

class Computed<T> {
  constructor(options: {
    fn: (ctx: ComputedCtx<T>) => T
    isEqual?: (a: T, b: T) => boolean
    label?: string
  })
  /** Read (auto-tracked; may throw a stored error or suspend). */
  get state(): T
  readonly label: string | undefined
}

class ReducerAtom<T, A> {
  constructor(options: {
    state: T
    reducer: (state: T, action: A) => T
    isEqual?: (a: T, b: T) => boolean
    label?: string
  })
  get state(): T
  dispatch(action: A): void
  readonly label: string | undefined
}

/** Effect over signals: runs now, re-runs when anything it read changes.
 * Returns a disposer. Core effects observe the committed world only. */
function signalEffect(fn: () => (() => void) | void): () => void

/** Batch multiple writes: effects and watcher notifications flush once at the end. */
function batch<T>(fn: () => T): T

/** Read without registering a dependency. */
function untracked<T>(fn: () => T): T

type CosignalConfig = {
  /** Throw at write time if a computed evaluation writes any atom. Default: allow
   * (cycles are still detected and rejected either way). */
  forbidWritesInComputeds?: boolean
  /** Initial arena capacity in records (default 2^20 * 3; env override honored). */
  initialRecords?: number
}
function configure(config: CosignalConfig): void
```

### 4.2 React bindings (`cosignal/react`)

```ts
/** Subscribe this component to a signal; returns the value for the current
 * render's view. Works with Atom, Computed, and ReducerAtom. */
function useSignal<T>(signal: Atom<T> | Computed<T> | ReducerAtom<T, unknown>): T

/** Component-owned atom, like useState but a first-class Atom. */
function useAtom<T>(options: AtomOptions<T>): Atom<T>

/** Component-owned reducer atom, like useReducer. */
function useReducerAtom<T, A>(options: {
  state: T
  reducer: (state: T, action: A) => T
  isEqual?: (a: T, b: T) => boolean
  label?: string
}): ReducerAtom<T, A>

/** Like useMemo, but re-renders the component when a signal read inside fn
 * changes. fn may close over props/state (that is what deps are for) and read
 * atoms/computeds freely (auto-tracked). */
function useComputed<T>(
  fn: () => T,
  deps: ReadonlyArray<unknown>,
  options?: { isEqual?: (a: T, b: T) => boolean; label?: string },
): T

/** Like useEffect, but also re-runs when a signal read inside fn changes
 * (observing committed values only, after commit — useEffect semantics). */
function useSignalEffect(
  fn: () => (() => void) | void,
  deps?: ReadonlyArray<unknown>,
): void

/** Optional helper: startTransition that also opens a signal batch so many
 * writes coalesce into one notification flush. Semantically identical to
 * calling startTransition and writing atoms inside it. */
function startSignalTransition(fn: () => void): void
function useSignalTransition(): [isPending: boolean, start: (fn: () => void) => void]
```

No provider component is required: the fork's registry callbacks are global and carry
the root's container identity, so multiple roots work without a wrapper. (The brief
allows a library-owned top-level component "if strictly necessary" — it is not.)

### 4.3 Tracing (`cosignal/tracing`, lazy) and Graphviz (`cosignal/graphviz`)

```ts
type TraceEvent = { id: number; time: number; cause: number; type: string; /* payload per type */ }
function installTracer(options?: { ringCapacity?: number }): Tracer
type Tracer = {
  subscribe(fn: (event: TraceEvent) => void): () => void
  ring(): ReadonlyArray<TraceEvent>
  whyDidItRun(target: Atom<unknown> | Computed<unknown>, eventId?: number): TraceEvent[]
}

// cosignal/graphviz — imports only types from tracing; either module loads without the other.
function dependencyGraphToDot(roots: Iterable<Atom<unknown> | Computed<unknown>>): string
function traceToDot(events: Iterable<TraceEvent>, filter?: (e: TraceEvent) => boolean): string
```

### 4.4 SSR (`cosignal/server`)

```ts
/** Serialize the committed values of the given atoms (for embedding in HTML). */
function dehydrateAtoms(atoms: Iterable<Atom<unknown>>): string
/** Before hydrateRoot: initialize atoms from a dehydrated payload. */
function hydrateAtoms(payload: string, registry: Record<string, Atom<unknown>>): void
```

Server rendering reads committed values, mounts no subscriptions, and never runs atom
observed-lifecycle effects. There is no `getServerSnapshot` analogue because reads are
plain reads.

---

## 5. Architecture summary

### 5.1 One engine, versioned

The system is two layers over one storage substrate:

```
┌────────────────────────────────────────────────────────────────────────┐
│ POLICY (classes & closures, GC-managed)                                │
│  Atom / Computed / ReducerAtom handles: labels, isEqual, reducers,     │
│  observed-lifecycle effects, write chains + folding, promise protocol, │
│  React bindings (hooks, pass tracking, stamp→slot mapping, pins),      │
│  configure(), tracing installation, SSR helpers                        │
├────────────── the cut: 6 function slots + integer calls ───────────────┤
│ KERNEL (one file, monomorphic, no React / promises / options)          │
│  M plane: node + link records (topology, flags, committed-world seq)   │
│  V plane: per-node version window (2 inline pending entries)           │
│  side columns: values, pending values, functions                       │
│  world-slot table (3 slots), global seq clock, per-slot write clocks   │
│  algorithms: read/write, propagate(worldMask), checkDirty(view),       │
│  entry validation, commitSlot / rebase / abortSlot, effect queue,      │
│  watcher notify, growth (closure rebuild), reclamation (free lists)    │
└────────────────────────────────────────────────────────────────────────┘
```

The defining property of Variant B: **there is exactly one propagation engine and it is
version-aware.** The committed world is world slot "committed" of the same machinery
that serves pending batches; there is no separate overlay log with its own read path.
When no deferred batch is live (`liveSlotsMask === 0`), every version-aware operation
collapses to the proven single-version arena kernel through one branch on one module
scalar — the benchmark and non-React users pay one load-and-branch per write and
nothing per read (section 9.1).

### 5.2 How a transition flows through the system (worked example)

1. `startTransition(() => { atom.set(5); setTab('b') })` runs. The write calls the
   fork: `isCurrentWriteDeferred()` returns true, `currentWriteStamp()` mints stamp
   `s` (an integer) for the transition's batch and guarantees a retire event later.
2. Policy maps stamp `s` to world slot `k` (allocating slot `k` if this is the batch's
   first write; section 7.3), appends `set 5` to the atom's chain for slot `k` with the
   next global seq, and calls the kernel's deferred write: the kernel marks the atom
   touched in slot `k`, bumps slot `k`'s write clock, and propagates "pending in slot
   k" hints down the subscriber links.
3. Watchers (component subscriptions) reached by the propagation are checked: the
   kernel pulls each watcher's node value **in the view committed+k**; only if it
   really changed does policy call that component's `setState` — synchronously, still
   inside the transition scope, so React queues it in the same batch as `setTab('b')`.
4. React renders the transition. At pass start the fork reports the pass's included
   stamps; policy computes the pass's view key (committed + slot k) and pins the
   current seq. Every `useSignal` read during that pass resolves through the read rule
   (section 8) against that view and pin: components see 5.
5. Meanwhile an urgent click writes `atom.set(6)`. Not deferred → committed-world
   write: value 6 lands in the committed column immediately with a fresh seq, effects
   flush, watchers re-check in the committed view and re-render urgently. The kernel
   also bumps every live slot's write clock (a rebase signal): slot-k readers must
   re-fold. The transition's chain entry (`set 5`, older seq) is now superseded — the
   next slot-k read folds the chain over committed and, because the chain entry's seq
   is older than the committed value's seq, produces 6, exactly what React's own
   update-queue rebasing would produce for `useState` (last write wins in write order;
   updater functions replay — section 10.2).
6. React commits the transition; the fork retires stamp `s` with `committed: true`.
   The kernel folds every chain in slot `k` into the committed columns (seq-ordered),
   propagates committed-world changes (equality-cutoff), queues committed-observing
   effects (`useSignalEffect`, `signalEffect`) for a microtask flush, releases slot
   `k`, and reclaims chains.

### 5.3 The kernel/policy cut, precisely

The kernel is a single generated-and-hand-tuned file whose only data types are `number`
and the side columns' `unknown` slots. It calls up into policy through a table of six
function slots, installed once at startup (monomorphic call sites):

```ts
type PolicyOps = {
  /** Fold an atom's chain for (node, slot) over a base value; returns folded value.
   * Executes user updaters/reducers; kernel treats result as opaque. */
  foldChain(node: number, slot: number, base: unknown): unknown
  /** Run a computed's function for (node, view); returns value, records deps via
   * kernel link calls, may record error/suspended state via kernel entry setters. */
  runComputed(node: number, viewKey: number): unknown
  /** Compare two values for node (honors per-node custom isEqual). */
  isEqual(node: number, a: unknown, b: unknown): boolean
  /** Deliver a watcher notification (calls the component's setState). */
  notifyWatcher(node: number): void
  /** Observed-lifecycle edge: node gained its first subscriber / lost its last. */
  onWatchedEdge(node: number, nowWatched: boolean): void
  /** A slot retired; policy releases chains/thenable caches for its touched nodes. */
  onSlotReleased(slot: number, touched: Int32Array, count: number): void
}
```

Rules of the cut:

- The kernel never holds a reference to an `Atom`/`Computed` instance, a promise, a
  reducer, or an options object. It stores `unknown` values and calls `PolicyOps`.
- Policy never touches a plane. It manipulates nodes only through kernel exports that
  take and return integers.
- Custom equality: nodes with a custom `isEqual` carry a flag bit; the kernel inlines
  `Object.is`-style comparison (`a === b || (a !== a && b !== b)`) when the bit is
  clear and calls `PolicyOps.isEqual` when set, so the common case never leaves the
  kernel.
- Everything React-specific (stamps, passes, pins, hooks) lives in policy; the kernel
  knows only slots, views, and seqs. You can drive the versioned kernel entirely
  without React (that is how the property tests work, section 17.2).

## 6. Data layout

All numbers below assume the proven baseline: ids are pre-multiplied record offsets
(`id = recordIndex * 8`), record 0 burned as "none".

### 6.1 The M plane (hot): nodes and links, stride 8, 32 bytes per record

Identical to the proven arena kernel, with two field reassignments (node fields 6–7,
link field 7 were spare).

**Node record (M plane):**

| offset | name        | meaning                                                                    |
| ------ | ----------- | -------------------------------------------------------------------------- |
| +0     | `FLAGS`     | flag word: state bits, kind bits, version-presence bits (table below)      |
| +1     | `DEPS`      | first link in this node's dependency list; free-list next when freed       |
| +2     | `DEPS_TAIL` | last link in dependency list (also the re-track cursor during evaluation)  |
| +3     | `SUBS`      | first link in this node's subscriber list                                  |
| +4     | `SUBS_TAIL` | last link in subscriber list                                               |
| +5     | `GEN`       | generation counter, bumped when the record is freed (defuses stale ids)    |
| +6     | `C_SEQ`     | seq of the last committed-world change of this node's value                |
| +7     | `W_HINT`    | packed: 2 inline-entry occupancy nibbles + spill flag + touched-slots bits |

**Link record (M plane, same stride, interleaved with nodes):**

| offset | name       | meaning                                                          |
| ------ | ---------- | ---------------------------------------------------------------- |
| +0     | `VERSION`  | tracking version of the last evaluation that confirmed this edge |
| +1     | `DEP`      | node id of the dependency (the thing read)                       |
| +2     | `SUB`      | node id of the subscriber (the thing that read it)               |
| +3     | `PREV_SUB` | previous link in DEP's subscriber list                           |
| +4     | `NEXT_SUB` | next link in DEP's subscriber list                               |
| +5     | `PREV_DEP` | previous link in SUB's dependency list                           |
| +6     | `NEXT_DEP` | next link in SUB's dependency list; free-list next when freed    |
| +7     | `WORLDS`   | view-membership bits: committed bit + one bit per world slot     |

`WORLDS` records which views have confirmed this edge (committed evaluation sets the
committed bit; evaluation in view containing slot k sets bit k). Propagation for a
write in slot k follows links whose `WORLDS` intersects {committed, k} — a pending
view's dependency set may diverge from the committed one (a computed can read different
atoms in different worlds), and both sets must carry marks (section 9.3). Slot bits go
stale when a slot is reused for a new batch; stale bits cause at worst an unnecessary
"maybe stale" hint, never a missed update, and are lazily rewritten on the next
evaluation (section 9.5).

**Flag word bits (node FLAGS):**

| bit   | mask   | name              | meaning                                                        |
| ----- | ------ | ----------------- | -------------------------------------------------------------- |
| 0     | 1      | `MUTABLE`         | can produce a new value (atoms and computeds)                  |
| 1     | 2      | `WATCHING`        | is an effect/watcher that must be notified                     |
| 2     | 4      | `RECURSED_CHECK`  | currently evaluating (re-entrancy / cycle guard)               |
| 3     | 8      | `RECURSED`        | wrote-while-propagating marker (inner-write handling)          |
| 4     | 16     | `DIRTY`           | committed world: value definitely stale                        |
| 5     | 32     | `PENDING`         | committed world: value possibly stale (verify via checkDirty)  |
| 6     | 64     | `HAS_CHILD_EFFECT`| owns child effects that need unlinking on re-run               |
| 7–9   | 128/256/512 | `P_DIRTY(k)` | slot k (0..2): pending-view value definitely stale hint        |
| 10–12 | 1024/2048/4096 | `P_PENDING(k)` | slot k (0..2): pending-view value possibly stale hint    |
| 13    | 8192   | `HAS_ENTRIES`     | node has at least one live pending entry (gate for cold paths) |
| 14    | 16384  | `CUSTOM_EQ`       | policy owns equality for this node                             |
| 15–19 | 32768… | `K_ATOM` / `K_COMPUTED` / `K_EFFECT` / `K_SCOPE` / `K_WATCHER` | node kind (dispatch on the same load as state) |

Bits 0–6 are byte-for-byte the proven kernel's semantics; the committed world runs on
them unchanged. Bits 7–14 are the versioning additions; in steady state they are all
zero and no code path reads them (the `HAS_ENTRIES` / `liveSlotsMask` gates come first).

### 6.2 The V plane (cold): per-node version window, stride 4, 16 bytes per record

Allocated lazily the first time any deferred batch writes (a page of all-zeros until
then costs nothing but address space; we allocate the whole plane at the same record
capacity as M so ids index it directly: `V[recordIndex * 4 + field]`, i.e.
`V[(id >> 1) + field]`).

Each node owns two **inline pending entries** (positions 0 and 1). Per entry, two int32
fields in V; the entry's value and auxiliary slot live in the `pendingVals` side column.

| offset | name     | meaning                                                                     |
| ------ | -------- | --------------------------------------------------------------------------- |
| +0     | `E0_META`| entry 0: view key (3 bits) + state tag (2 bits) + slot-epoch check (24 bits) |
| +1     | `E0_SEQ` | entry 0: seq at which this entry was last validated                          |
| +2     | `E1_META`| entry 1: same packing                                                        |
| +3     | `E1_SEQ` | entry 1: same                                                                |

`META` packing (low to high): `viewKey` (3 bits, 0 = empty entry since views always
include committed implicitly and a "committed-only" entry is the main columns), `state`
(2 bits: 0 value, 1 error, 2 suspended), `epoch` (24 bits: the low bits of the global
**slot epoch** at validation time — the epoch increments whenever any slot retires, so
entries referencing dead batches are recognized as empty without a sweep; section 10.3).

Why a separate cold plane instead of widening M to stride 16: the research rule
"parallel arrays lose" applies to fields read on the same hot traversal. V-plane fields
are read only when `HAS_ENTRIES` is set on a node reached under a live view — never
during steady-state propagation or committed reads — so they are not on the same
traversal, and keeping M at 32 bytes preserves the exact record density the tier-0
numbers were measured at. (Risk logged in section 19 with a measurement plan.)

### 6.3 Side columns

| column        | element        | slots per record | resident when                     | contents                                                                 |
| ------------- | -------------- | ---------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `vals`        | `unknown`      | 2 (`id >> 2`)    | always                            | slot 0: committed value / computed committed result; slot 1: atom staging value, effect cleanup, or computed committed aux (error / thenable record) |
| `pendingVals` | `unknown`      | 4 (`id >> 1`)    | first deferred batch ever         | per inline entry: value slot + aux slot (error / thenable cache)          |
| `fns`         | `Function?`    | 1 (`id >> 3`)    | always                            | computed getter, effect fn, or watcher callback                           |

Chains, spill entries, and reducers are policy-side (ordinary `Map`s keyed by
`(id << 2) | slot`), because they exist only for nodes actively touched by a live
deferred batch — a set that is small and short-lived by construction.

### 6.4 Spill structures (the rare path)

- **Third-plus concurrent view on one node:** if a node needs a pending entry and both
  inline positions hold live entries for *different* view keys, the entry goes to a
  kernel-side `Map<number, SpillEntry>` keyed by `(id << 3) | viewKey`. The node's
  `W_HINT` spill flag is set so lookups know to check the map. Expected occupancy:
  approximately zero (needs three simultaneously rendered distinct view combinations
  touching the same node — e.g. two suspended transitions plus a third live one).
- **Fourth-plus concurrent deferred batch:** the slot table has three slots. A fourth
  live stamp gets `slot = SPILL (3)`, which has no packed representation: its chains
  still record normally (policy-side), but reads in views containing a spilled stamp
  take a slow resolution path that folds chains directly with no cached entries, and
  propagation treats "pending in spilled slot" as "pending in all slots" (over-mark,
  never under-mark). Correct, allocation-heavy, measured-rare: React itself coalesces
  concurrent transitions into shared lanes long before four distinct batches with
  distinct render schedules exist.

### 6.5 Global tables and scalars

| structure          | type                        | purpose                                                            |
| ------------------ | --------------------------- | ------------------------------------------------------------------ |
| `seq`              | int (module scalar)         | the global clock; bumped per write and per commit fold             |
| `slotEpoch`        | int                         | bumped when any slot retires; validates pending entries            |
| `liveSlotsMask`    | int (bits 0..2 + bit 3 spill)| which world slots are live; 0 = steady state                      |
| `slotStamp[4]`     | Int32Array                  | stamp currently owning each slot (0 = free)                        |
| `slotWriteSeq[4]`  | Int32Array                  | seq of the last write affecting that slot (includes rebase bumps)  |
| `slotTouched[4]`   | growable int stack          | node ids touched in the slot (commit/abort iteration; deduped via W_HINT touched bits) |
| `stampSlotByLane`  | Int8Array(32)               | direct index from a stamp's lane-index bits to its slot (section 7.3) |
| `committedRetained`| `Map<number, [seq, unknown][]>` | prior committed values retained while an active pass's pin predates them (section 8.3) |
| `minActivePin`     | int                         | oldest pin among active render passes; gates retained-value sweeps |
| scratch stacks     | Int32Array + save/restore   | propagate / checkDirty traversal stacks (proven design, unchanged) |
| effect queue       | int array + notifyIndex     | queued effect/watcher ids awaiting flush (proven design, unchanged)|

### 6.6 Byte math

Per record, steady state (no deferred batch ever seen):

- M plane: 32 B (8 × int32)
- `vals`: 2 pointer slots = 16 B
- `fns`: 1 pointer slot = 8 B
- Total resident: **56 B per record** — identical to the proven kernel. A dependency
  edge (link) is one record: 32 B in M plus its (unused) side-column slots.

After the first deferred batch (lazily, process-wide):

- V plane: +16 B per record
- `pendingVals`: +32 B per record (4 pointer slots)
- Total: **104 B per record** ceiling, of which the extra 48 B are cold arrays the
  steady-state paths never touch.

Sizing examples: a small app with 10,000 nodes and 30,000 links occupies 40,000
records = 1.25 MiB of M plane (+2.5 MiB of side-column headroom); the research
harness's default capacity of 3 × 2^20 records (one million nodes' worth plus link
headroom, matching the proven kernel's benchmark configuration) is 96 MiB of M plane.
The shipped library does NOT pre-reserve at benchmark scale: it starts at
`initialRecords` = 2^16 records (2 MiB M plane) and doubles via closure-rebuild growth
(section 14), so footprint tracks actual graph size. The V plane and `pendingVals`
column follow the same capacity and are allocated only when the first deferred batch
appears.

Global-table overhead is constant (a few hundred bytes) plus `slotTouched` stacks
proportional to nodes actually written in a live batch.


## 7. Clocks, stamps, world slots, and views

### 7.1 The global clock (`seq`)

One integer, incremented at two kinds of moment:

- every write to any atom (whether committed-world or into a chain), and
- every commit fold that changes a committed value (section 10.1).

Everything time-ordered in the system — chain entries, pending-entry validation,
committed change stamps (`C_SEQ`), render-pass pins — carries a seq. All reasoning
about "before/after" is integer comparison against this clock.

`seq` is an int32 stored in typed arrays, so it wraps after roughly two billion ticks.
The kernel performs a **renumbering sweep** at an operation boundary once `seq`
crosses 2^30: subtract a rebase constant from every live seq (each node's `C_SEQ`, V
plane `E*_SEQ` fields, slot write clocks, chain entry seqs via a policy callback,
active pins). The sweep is linear in record count, happens at most once per billion
writes, and is fully testable by starting the clock near the threshold.

### 7.2 Stamps: the integer identity of a batch

A **stamp** is the fork-minted identity of one batch, designed so the kernel can index
its tables with bit operations instead of hashing:

```
bit 0..4    laneIndex   (0..30: which React lane slot the batch occupies)
bit 5..28   generation  (per-lane counter, increments each time the lane is reused)
bit 29      deferred    (1 = transition-like batch)
```

Properties:

- Always a positive integer below 2^30 → a Smi (small integer) on every V8
  architecture; no allocation, no boxing, identity comparison is `===` on numbers.
- `laneIndex` is extracted with `stamp & 31` and indexes fixed 32-entry tables
  directly — this is the "stamps index directly into kernel structures" requirement.
  The generation bits make a reused lane distinguishable: kernel tables that cache
  stamp-derived state always store the full stamp and compare it, so a stale entry for
  a previous batch on the same lane can never be confused with the current one.
- Generation wraps after 16.7 million reuses of one lane. A wrap could alias only if a
  batch stayed live across 16.7 million later batches on the same lane index —
  impossible, because a live batch *occupies* its lane slot in React (the fork reuses
  the existing token while a lane's batch is pending, exactly as today's object-token
  registry does).
- Stamp value 0 is reserved for "no batch": an urgent write outside any batch context.

Why the same trick is safe where raw lanes are not: React recycles lane *bits*
(the transition lane cursor wraps after 10 claims), so a lane bit cannot name a batch
across time — the bugs this causes are why the current fork uses object tokens. The
generation field restores unambiguous identity while keeping the integer form. The
registry's edge-triggered design (mint on first external write; pending edge on
markRootUpdated; backfill in the scheduling microtask; finish edge on commit; close
edge for store-only batches; async-action parking) carries over from the proven
object-token registry verbatim — only the token representation changes.

### 7.3 The world-slot table

The kernel packs per-batch state into three **world slots** (indexes 0, 1, 2), plus
the pseudo-slot `SPILL = 3`. The mapping from stamps:

```
stampSlotByLane: Int8Array(32)   // laneIndex → slot index + 1, or 0 = none
slotStamp:       Int32Array(4)   // slot → full stamp (0 = free); checked to defuse lane reuse
```

- On the first deferred write of a batch: look up `stampSlotByLane[stamp & 31]`; if it
  names a slot whose `slotStamp` equals this stamp, use it; otherwise allocate the
  lowest free slot, record both tables, and set the slot's bit in `liveSlotsMask`.
- If no slot is free, the batch maps to `SPILL` (section 6.4). Slots are freed at
  retire (section 10.3), so occupancy equals the number of simultaneously live
  deferred batches — nearly always 0 or 1, occasionally 2 (a second transition starts
  while one is suspended), 3+ in stress tests.
- Slot lookup is two loads and two compares; it appears only on deferred write paths
  and pass-start, never on reads (reads carry a resolved view key).

### 7.4 Views and view keys

A **view** answers "which pending batches should this read see, on top of committed?"
Encoded as a 3-bit **view key**: bit k set = include world slot k. View key 0 =
committed only.

- **Writers** never need a view: a write targets either the committed world (urgent)
  or exactly one slot (its batch's).
- **Readers inside a React render pass** use the pass's view: at pass start the fork
  reports the pass's included stamps; policy maps each to its slot (ignoring stamps
  that never wrote — they own no slot) and ORs the bits. If any included stamp is
  spilled, the pass view carries a `spilled` flag forcing the slow resolution path.
- **Readers outside render** (event handlers, effects, benchmarks) read "newest wins":
  the committed world plus every live slot the current execution context's batch has
  written — in practice, outside-render reads during a transition scope resolve in the
  view of that transition's slot (so `atom.set(5); atom.state` inside one transition
  reads 5), and plain outside-render reads resolve committed-only. This matches the
  external contract "reads mid-batch see fresh values" while never leaking one pending
  batch's writes into another context.
- Multi-bit views are real and common: React renders all pending transition lanes as
  one group, so two live batches usually render together in one pass whose view has
  both bits. They diverge (single-bit views) when one batch's lanes are suspended —
  then React renders the other alone. Both shapes are first-class here.

### 7.5 Where each concept lives

| concept        | owner  | representation                                              |
| -------------- | ------ | ----------------------------------------------------------- |
| stamp          | fork   | int (lane index + generation + deferred bit)                |
| slot           | kernel | index 0..2 (+3 spill); tables in section 6.5                |
| view key       | kernel | int 0..7 (+ spilled flag as bit 3 internally)               |
| pass (pin, view) | policy | per-container record updated by fork pass events          |
| chain          | policy | array of `{ seq, kind, payload }` in a Map by (node, slot)  |

## 8. The read rule

Every read — `atom.state`, `computed.state`, a tracked read inside an evaluation, a
render read via `useSignal` — resolves as `readNode(node, viewKey, pin)`. Plain-English
statement of what a read returns, followed by the mechanism.

**The rule.** A read in view V pinned at P returns the value the node would have if:
(1) you started from the newest committed value whose seq is at or below P, and
(2) you applied, in global write order, every chain entry recorded under a slot in V
whose seq is at or below P.
Reads outside render use P = "now" (no pinning) and the view described in 7.4.

Each half mirrors something React itself does for `useState` queues: clause 2's slot
filter is React's rule for which queued updates apply in a given render (a transition
render applies transition updates; an urgent render skips them), and the "at or below
P" tests mirror React's hiding of updates that arrive while a render is in progress —
they belong to the next pass, not this one (this is what keeps a paused-and-resumed
pass consistent).

### 8.1 Fast paths (in order tried)

`readNode` is structured so each successive check is only reached in rarer states:

1. **Steady state** (`liveSlotsMask === 0`, so V must be 0): exactly the proven
   kernel's read — resolve committed flags (DIRTY/PENDING → checkDirty → maybe
   recompute), return `vals` slot 0. No versioning code executes; the only cost
   relative to the baseline kernel is that the enclosing function checks one module
   scalar. Applies to benchmarks and all non-React usage always.
2. **Committed view while batches are live** (V = 0): same as (1), plus pin handling —
   if the node's `C_SEQ` exceeds P, the pass started before the latest committed
   change, so the value comes from `committedRetained` (section 8.3). One extra
   compare of an already-loaded field in the common no-conflict case.
3. **Pending view, valid entry:** node's `HAS_ENTRIES` flag set; find the node's
   pending entry for V (two inline META compares, then the spill map only if the
   `W_HINT` spill flag is set). The entry is trusted if its `epoch` matches the
   current slot epoch and its `E_SEQ` is at or above every relevant clock:
   `slotWriteSeq[k]` for each k in V, and the node's own `C_SEQ`. That is at most
   four integer compares to serve a read with **zero** graph traversal — the
   steady-state cost model of a transition render.
4. **Pending view, missing/stale entry:** resolve it (section 9.4): for atoms, fold
   the chains; for computeds, run version-aware checkDirty and possibly re-evaluate in
   view V. Store the result in a pending entry so the next read is case 3.
5. **Spilled view:** no entries; fold/evaluate directly every time (correctness path).

### 8.2 Tracking

Reads inside a tracked evaluation (a computed or effect body) link the dependency edge
exactly as the proven kernel does (`link(dep, sub, version)` with the tail-cursor
dedupe fast path), with one addition: the link's `WORLDS` word ORs in the bit for the
evaluating view (committed bit for view 0, slot bits otherwise). Reads inside a React
render are *not* graph-tracked (components are not graph nodes; their subscription is
an explicit watcher created by `useSignal` — section 13.1); render reads only resolve
values.

### 8.3 Retained committed values (pin protection)

When a commit fold or urgent write changes a node's committed value while some render
pass's pin predates the change, the *previous* `[seq, value]` pair is appended to
`committedRetained` for that node (a Map touched only in this race window). Case-2
reads look up the newest retained pair at or below their pin. When the oldest active
pin advances (pass ends), retained lists are swept. This is the versioned-core
equivalent of "keep old values while someone might still read them"; it is bounded by
(nodes changed during a pass) × (concurrent passes), both small, and empty whenever no
render is in flight.

## 9. Version-aware algorithms

The kernel's five core walks, each stated as a delta over the proven single-version
algorithm (which is alien-signals v3.2.1 semantics transliterated to records —
propagate / shallowPropagate / checkDirty / update / notify with exact re-run
trimming, cycle guards, and the 460-bytecode fast-path splits).

### 9.1 Write

```
writeCommitted(node, value):                     // urgent / steady-state path
  stage value; set DIRTY; seq++; C_SEQ = seq     // proven kernel behavior
  if liveSlotsMask !== 0:                        // ONE branch on a module scalar
    retainIfPinned(node)                         // section 8.3
    bump slotWriteSeq[k] for every live k        // rebase signal, ≤3 stores
    propagate(node.SUBS, worldMask = ALL)        // one walk marks all worlds
  else:
    propagate(node.SUBS, worldMask = COMMITTED)  // exactly the proven walk
  flush effects if not batching

writeDeferred(node, slot, entryKind, payload):   // inside a deferred batch
  seq++
  policy appends {seq, kind, payload} to chain(node, slot)
  if first touch: push node onto slotTouched[slot]; set touched bit in W_HINT
  slotWriteSeq[slot] = seq
  propagate(node.SUBS, worldMask = COMMITTED|bit(slot))   // marks hints + notifies
  flush watcher notifications (in writer's context — lane attribution)
```

The committed write in steady state is bit-identical to the proven kernel plus one
scalar branch. A deferred write never touches `vals` (the committed value is not
disturbed) — its cost is a chain append, a touched-list push (first time), and the
propagation walk.

### 9.2 Propagate with a world mask

`propagate(startLink, worldMask, innerWrite)` is the proven iterative walk (scratch
stack, RECURSED/RECURSED_CHECK ladder, notify on WATCHING) with two changes:

- **Flag targeting.** For the committed bit in the mask it sets the classic
  `PENDING`/`DIRTY` bits (unchanged). For each slot bit it sets `P_PENDING(k)` — a
  hint meaning "something upstream changed in world k; verify before trusting a
  k-containing entry". In steady state the mask is committed-only and the emitted
  flag stores are the proven ones; the multi-world path ORs a precomputed flag
  constant, so the walk body stays one load, one OR, one store per visited node.
- **Link filtering.** A link is followed if `WORLDS & followMask` is nonzero, where
  `followMask = COMMITTED_BIT | (worldMask slot bits)`. Committed links are followed
  for slot writes too (a pending view's dependencies default to the committed
  dependency shape until a pending evaluation diverges them); links exclusive to
  *other* slots are skipped. In steady state every link has only the committed bit
  and the filter compiles to an always-true test on the same loaded word.

Notification is unchanged in structure: WATCHING nodes are appended to the effect
queue (outer-before-inner ordering preserved by the proven segment-reverse). What
changed is *when a watcher actually fires*: the flush step re-validates each queued
watcher in the world it is watching (committed for effects, the writer's view for
React watchers) and drops it if its observed value did not really change — the
equality cutoff (section 13.2).

### 9.3 Why both committed and slot-exclusive links must exist

A computed's dependency set can differ per view: `fn = () => flag.state ? a.state :
b.state` where `flag` is true only in the pending world reads `a` in the pending view
and `b` in the committed view. If pending-view evaluation did not record its own links
(on `flag` and `a`) with the slot bit, a later deferred write to `a` would not mark or
notify it — a missed update, i.e. a tear. If committed links were not followed by slot
writes, a deferred write to `b`... would be fine (pending view does not read b), but a
deferred write to `flag` — read in both views, link carries both bits — must reach it.
The union-following rule with per-view bits handles every combination; the cost is one
extra int32 per link (the spare field) and one AND per traversed link.

### 9.4 Version-aware checkDirty and evaluation

`checkDirtyInView(node, viewKey, pin)` is the proven checkDirty (iterative, exact
re-run trimming: a node is re-evaluated only after some dependency *proved* changed,
and cleared to clean when none did) parameterized by view:

- Where the proven walk reads a dependency's committed flags, the view walk consults
  the flags relevant to the view: committed `DIRTY|PENDING` plus `P_DIRTY(k)|P_PENDING(k)`
  for slots in the view.
- Where it reads a dependency's value to compare, it reads the dependency **through
  the read rule in the same view and pin** (recursively resolving that dependency's
  entry first — this depth-first order is what makes each view individually
  glitch-free: by the time a formula re-runs in view V, every dependency it consults
  already has its settled view-V value; a reader can never observe a half-updated
  view. The proven kernel's argument, per view.)
- Where it re-evaluates, it calls `PolicyOps.runComputed(node, viewKey)` with
  `activeSub = node` and `activeView = viewKey` so tracked reads inside resolve and
  link in the same view (section 8.2), then compares old/new entry values (equality
  cutoff, custom-eq flag honored) and performs the view analogue of shallowPropagate:
  downstream nodes whose only evidence of staleness was this node get their hint bits
  settled (promoted to definitely-stale on real change; validation otherwise happens
  lazily by seq, section 9.5).
- Evaluation in a pending view **must not run committed-world side effects**: it
  cannot write atoms at all (any write during render-pass evaluation throws — React
  may replay or discard the pass; section 13.5), and effects created during it are
  rejected the same way.

The result updates the node's pending entry for the view: value/aux slots in
`pendingVals` (or spill map), META (view key, state tag, current slot epoch), and
`E_SEQ = current seq`.

### 9.5 Hint hygiene (why per-slot flags can be sloppy and still correct)

Per-slot P_PENDING/P_DIRTY bits are *accelerator hints*, not ground truth — validity
is always decided by seq comparison (`E_SEQ` versus `slotWriteSeq[k]` / `C_SEQ`).
Consequences, stated so maintainers do not "fix" them:

- Evaluating one view does not clear another view's hint bits; a hint may stay set
  after the last relevant entry was validated. Harmless: the seq fast path (case 3 of
  8.1) short-circuits before consulting hints; hints only steer checkDirty descents.
- Slot reuse leaves stale slot bits on links and stale P_ bits on nodes. Harmless:
  they cause at most an unnecessary follow/verify; the entry epoch check (section
  10.3) prevents stale *values* from being served. Bits are rewritten by the next
  evaluation that touches them, and all P_ bits for a slot are bulk-cleared lazily on
  the slot's first reuse write per node.
- False positives cost one verification walk; false negatives are impossible by
  construction (every write bumps `slotWriteSeq`, and every entry check compares
  against it — the flags are never the last line of defense).


## 10. Commit, rebase, and abort as kernel operations

These are the three operations that move state between worlds. All three are kernel
entry points (`commitSlot(slot)`, rebase is a mode of the committed write path,
`abortSlot(slot)`); policy decides *when* to call them (commit on the fork's retire
event; abort never, today) and supplies the fold semantics through `PolicyOps`.

### 10.1 Commit (`commitSlot(k)`, driven by `onBatchRetired(stamp, committed)`)

Runs at an operation boundary (never inside a flush or evaluation):

1. For each node id in `slotTouched[k]` (deduped):
   - `folded = PolicyOps.foldChain(node, k, committedBaseOf(node))` — policy replays
     the chain's entries whose seq exceeds the node's `C_SEQ`, in seq order: `set`
     entries replace the accumulator, `update` entries apply the stored function,
     `dispatch` entries apply the node's reducer (section 10.2).
   - If `folded` differs from the committed value (equality respecting `CUSTOM_EQ`):
     retain the old pair if pinned (section 8.3), store `folded` in `vals`, `seq++`,
     `C_SEQ = seq`, set `DIRTY`, and record the node in a local changed-list.
2. `propagate(changed nodes, worldMask = COMMITTED | remaining live slots)` — one walk
   per changed node marks committed consumers stale *and* nudges other live views
   (their fold base moved, so their entries must re-validate; their `slotWriteSeq`
   is bumped once for the whole commit).
3. Queue and flush notifications: committed-observing effects (`signalEffect`,
   `useSignalEffect`) and watchers, each gated by the equality cutoff against the
   value that watcher/effect last observed — a component that already rendered these
   values via the pending view does not re-render when they become committed
   (section 13.3).
4. Release the slot: `slotEpoch++` (instantly invalidating every pending entry whose
   META epoch no longer matches — including entries of *other* views that contained
   slot k), `slotStamp[k] = 0`, clear `stampSlotByLane` for the stamp's lane, clear
   the slot bit in `liveSlotsMask`, hand `slotTouched[k]` to
   `PolicyOps.onSlotReleased` so policy frees chains and per-slot thenable caches,
   then reset the touched stack.
5. If `liveSlotsMask` is now 0, the system is back in steady state: subsequent
   operations take the proven fast paths unconditionally.

A batch that retires with `committed: false` (it never produced React work — a
"store-only" batch, e.g. `startTransition(() => atom.set(x))` with nothing subscribed)
takes the identical path: its writes are real and must land. The flag exists for
tracing and for future policies, not to skip folding. This matches the object-token
design's retirement semantics, where both commit and prune fold the log.

Cost: linear in nodes the batch actually wrote plus the propagation frontier of real
changes. No full-graph sweeps anywhere — the epoch bump replaces "walk all entries and
delete slot-k ones" with lazy invalidation, at the price that *unrelated* live views'
entries also re-validate after a commit (one checkDirty-style verification each; risk
logged in section 19).

### 10.2 Rebase (why chains store operations, not results)

React's contract for `useState`/`useReducer` under interleaving is: updates apply in
write order, each functional update sees the accumulated value in *its* world. The
versioned core meets it by storing chain entries as operations and folding lazily:

- Worked example (matches a real test): committed value 1; a pending transition does
  `update(x => x + 1)` (chain entry seq 10); an urgent click does `update(x => x * 2)`.
  The urgent updater is *not* deferred, so it folds immediately over committed: kernel
  reads committed 1, applies ×2, commits 2 at seq 11 (`C_SEQ = 11`). The urgent render
  shows 2 — the transition's +1 is invisible to it (its chain sits in slot k, not in
  the committed world). Transition-view reads now fold: base = committed 2, chain
  entries with seq above `C_SEQ`... entry seq 10 is BELOW 11 — and this is where the
  simple "replay newer-than-base" filter would be wrong, because React replays the +1
  *on top* of the ×2 (queue order: +1 at 10, ×2 at 11 → 1+1=2, 2×2=4 — committed
  useState ends at 4 when the transition lands).
- The correct fold, therefore: **functional entries are never dropped by the seq
  filter; only `set` entries older than a newer committed `set`/fold are superseded.**
  Concretely, `foldChain` replays the chain interleaved with the committed timeline:
  it reconstructs "base as of just before each functional entry" using the retained
  committed pairs (section 8.3) plus `C_SEQ`, which reduces to three cheap cases:
  1. no committed change newer than any chain entry → fold entries in order over
     current committed (the overwhelmingly common case);
  2. committed changed after a plain `set` entry → the set is superseded; drop it;
  3. committed changed after a *functional* entry → re-apply the functional entries in
     seq order against the new committed base (functions re-run; they are required to
     be pure, same as React's updaters — documented, and exercised by a side-by-side
     `ReducerAtom` versus `useReducer` lockstep test).
  Case 3 needs only the current committed value, not history: replaying all functional
  entries over the newest base in write order produces exactly React's queue-rebase
  result, because React too re-applies skipped updaters on the newer base when the
  transition finally renders. (React's queue keeps urgent-applied results as the new
  base and replays transition updaters on top; write order between two functional
  updates in *different* worlds is preserved by seq ordering within the merged
  timeline — the pathological ordering "pending fn, then urgent fn, fold pending"
  yields fn-then-fn in seq order either way.)
- Pending-view reads use the same fold (that IS the read rule's clause 2); commit
  reuses it, so pending renders and final committed state agree by construction.

`update()` and `dispatch()` outside any deferred batch skip chains entirely: read
committed, apply, write committed — the steady-state path.

### 10.3 Slot epochs (how released slots cannot haunt)

Every pending entry's META carries the low 24 bits of `slotEpoch` at validation time.
Any slot retire bumps the epoch, so every entry validated before the retire fails its
epoch check and reads as "empty" — no sweep of the V plane or spill map is needed.
Policy's `onSlotReleased` frees the heavyweight state (chains, `pendingVals` value/aux
slots for touched nodes are cleared to release object references for GC). The 24-bit
truncation is safe because an entry older than 16.7 million epochs cannot exist: any
active pass pins its view's slots (a slot is never released while a pass that includes
it is active — the fork's per-root lock-in guarantees retire fires after the last
including pass ends), and inactive entries are rewritten on next use.

### 10.4 Abort (`abortSlot(k)`)

Identical to commit with step 1 and the changed-list propagation replaced by nothing:
chains are discarded unfolded, the slot is released, the epoch bumps. Watchers are not
notified (there is no value change in any surviving world; React discards its own tree
the same way). Exposed for: kernel property tests (simulating schedules where a batch
evaporates), a documented policy hook for future React cancellation semantics, and
`useSignalTransition`'s error path (if the transition scope throws before React sees
any update, policy aborts the slot so the half-written batch cannot leak). Not wired
to any current fork event — today every minted stamp retires through
`onBatchRetired`.

### 10.5 Ordering invariants (the ones tests pin down)

1. A stamp's chains fold exactly once, at its retire event (or are discarded exactly
   once, at abort). The fork guarantees exactly-one retire per stamp.
2. Between a batch's last write and its retire, committed reads never observe chain
   contents; pending-view reads always do.
3. After retire, reads in ANY view observe the folded values (the batch's world ceased
   to exist; its effects are part of committed history).
4. Commit folds and urgent writes are the only mutations of committed columns, and
   both happen outside render passes (React never yields control to event handlers
   mid-pass on the main thread; passes observe frozen committed state via pins even
   across yields).
5. Effects observe committed state only, after the fold, in a microtask — never
   pending values (useEffect parity).

## 11. Promises and Suspense

### 11.1 The computed states

A computed's cached result — committed or per-view — is one of three states (the
2-bit tag in entry META; committed uses the aux slot in `vals`):

- **value**: normal result.
- **error**: the function threw; the error object is stored (aux slot). Reads rethrow
  it. Evaluation never lets an exception unwind through kernel walks (the throw is
  caught at the evaluation boundary and recorded — this fixes the known
  alien-signals hazard where a throwing getter corrupts flag state mid-walk).
- **suspended**: the function called `ctx.use(promise)` on a pending promise. The
  promise (a thenable record) is stored in the aux slot. Reads *suspend* (below).

### 11.2 `ctx.use` mechanics

Inside `Computed.fn`, `ctx.use(promise)`:

1. Looks up the promise in the evaluation's **positional thenable cache** — an array
   in the entry's aux slot, keyed by call order within the evaluation (first `use`
   call is position 0, and so on). Positional caching keeps promise identity stable
   across re-evaluations in the same view, which React's replay machinery requires.
   The cache is per (node, view): a transition-view evaluation and a committed
   evaluation of the same computed each have their own.
2. Stamps React's thenable protocol onto it (`status`/`value`/`reason` fields,
   attaching a settle handler if absent) — the same convention React's own `use` uses,
   so a thenable that already settled resolves synchronously.
3. If fulfilled: returns the value. If rejected: throws the reason (becomes an
   **error** state if uncaught by user code). If pending: throws a private suspension
   marker; the evaluation boundary catches it, records the **suspended** state with
   the thenable, and registers exactly one settle listener per (node, view, thenable).

### 11.3 Who wakes what on settle

- **React render reads** of a suspended computed rethrow the stored thenable. In a
  component, `useSignal` surfaces it through React's `use(thenable)` (calling `use`
  conditionally is legal), so *React* owns suspending the pass, pinging the lane when
  the thenable settles, and replaying the render — with the correct batch attribution
  for free, because React tracked which lanes suspended on it. On replay, the read
  re-enters case 4 of the read rule, re-evaluates, and `ctx.use` now returns the
  settled value. Our settle listener for render-visible entries only marks the entry
  stale (bumps nothing else): the re-render React schedules does the pull.
- **Committed-world observers** (effects, non-render reads) need our own wake: the
  settle listener bumps `seq`, marks the computed `DIRTY` in the committed world,
  propagates, and flushes — standard urgent-write shape, in a microtask.
- A suspended **pending-view** entry whose batch retires before settling: the fold
  carries the suspension into the committed entry (the computed is suspended,
  full stop — its inputs are committed now, and the promise is still pending); wakes
  then follow the committed path above.

### 11.4 Policy owns all of this

The kernel knows only the 2-bit state tag and the opaque aux slot. `PolicyOps.runComputed`
implements `ctx.use`, the positional cache, the marker-catching boundary, and settle
listeners. Equality across states: transitions between states always count as
"changed"; two error states compare by error identity; two suspended states compare by
thenable identity (so a re-evaluation that suspends on the same promise does not
re-notify watchers).

## 12. The React fork API (integer tokens end-to-end)

This section specifies the fork as if writing it fresh, then the delta from the
already-built object-token fork (which exists on the react-signals repo's vendored
React, with a reconciler-level test suite).

### 12.1 Design principles (carried over, still binding)

- **No React internals cross the boundary.** No Fiber objects, no FiberRoot, no lane
  bitmasks. Batches cross as integer stamps whose bit layout is *our fork's* contract
  (documented, versioned), not React's; roots cross as their container (the DOM
  element passed to `createRoot`) — an identity token that is also exactly what a
  MutationObserver caller needs.
- **Edge-triggered, never sampled.** All registry state changes ride existing
  reconciler mutations (claim / pending / backfill / finish / close edges), so a
  recycled lane can never be observed under a stale stamp.
- **Inert until subscribed.** Every hook site is one null-or-flag check when no
  listener/provider is registered; additions are unconditional (no feature flag) but
  cost near-zero when unused.
- **Documented invariants per hook site** ("fires after X, before Y"), and the patch
  stays small enough to rebase across React releases (current measured surface:
  roughly 600 added lines + 300 of tests across 8 files).

### 12.2 The isomorphic surface (`react` package)

```ts
// Stamps: positive int31. 0 = none. Layout (fork contract v2):
//   bits 0..4  laneIndex, bits 5..28 generation, bit 29 deferred.
type Stamp = number

type ExternalRuntimeListener = {
  /** A render pass began on `container`. `stamps[0..count-1]` are the stamps of
   * every live batch this pass renders (render lanes + batches this root already
   * committed while they stay pending elsewhere). The Int32Array is OWNED BY REACT
   * and reused across events: copy what you need synchronously. */
  onRenderPassStart?: (container: unknown, stamps: Int32Array, count: number) => void
  /** The pass on `container` completed or was discarded (restart or interruption).
   * Passes span browser yields; exactly one end per start. */
  onRenderPassEnd?: (container: unknown) => void
  /** Exactly once per stamp: the batch left React's books. `committed` is false
   * only for batches that never produced React work. */
  onBatchRetired?: (stamp: Stamp, committed: boolean) => void
  /** DOM-mutation window (unrelated to signals; see 12.5). */
  onBeforeMutation?: (container: unknown) => void
  onAfterMutation?: (container: unknown) => void
}

function unstable_subscribeExternalRuntime(l: ExternalRuntimeListener): () => void

/** Would a write issued right now belong to a deferred (transition-like) batch?
 * Pure classification: no minting, no allocation. The library's observability
 * gate runs on this before asking for a stamp. */
function unstable_isCurrentWriteDeferred(): boolean

/** The stamp of the batch a write issued right now belongs to; mints the stamp
 * (integer, no allocation beyond the registry slot's first use) and guarantees
 * a future onBatchRetired for it. Returns 0 when there is no batch context. */
function unstable_currentWriteStamp(): Stamp

/** Non-null during a render pass on the current thread: the pass's container.
 * The library correlates it with pass state cached from onRenderPassStart. */
function unstable_renderContainer(): unknown
```

Registration follows the established `ReactSharedInternals` renderer-provider pattern
(the same shape the object-token fork already uses): the isomorphic module owns the
listener set and a provider list; the reconciler registers a provider at module init
and calls emit functions at lifecycle points; listener exceptions are reported like
uncaught errors and never corrupt a commit. With multiple renderers loaded, the first
registered provider answers write-classification queries (documented best-effort
limitation, unchanged).

### 12.3 Reconciler-side lifecycle edges (where each event fires)

| edge      | reconciler site                        | behavior                                                                 |
| --------- | -------------------------------------- | ------------------------------------------------------------------------ |
| claim     | `requestTransitionLane`'s once-per-event claim | lane slot association exists; no stamp minted yet                 |
| mint      | `unstable_currentWriteStamp` (write classification mirrors `requestUpdateLane`, minus fiber-specific legacy cases; gesture transitions classify as non-deferred) | stamp = `laneIndex | generation << 5 | deferred << 29`; bumps nothing else; `ensureScheduleIsScheduled()` so a store-only batch still reaches its close edge |
| pending   | `markRootUpdated` wrapper              | record root in the stamp's root set (only if a stamp was minted — integer/null checks otherwise) |
| backfill  | root-scheduler microtask, per root with work | repair pending edges for updates scheduled before the batch's first store write (ordinary `startTransition(() => { setState(); atom.set(); })` line order) |
| finish    | after `markRootFinished`, per commit   | a stamp is done on a root when its lane leaves that root's pending lanes; retire fires when the last root finishes. Committed-here-but-pending-elsewhere roots are recorded so their later passes keep including the stamp (per-root lock-in — their committed tree already shows the batch) |
| close     | end of the scheduling microtask        | a stamp whose batch never scheduled React work retires now (`committed: false`) — unless the transition turned out to be an async action, in which case the slot parks on the action's thenable and re-decides when it settles |
| pass      | `prepareFreshStack` (start; also implicitly ends a discarded pass) and render-loop completion (end) | pass events with the included-stamp set from render lanes + lock-ins |

All of this logic exists and is tested in the object-token fork; the versioned core
inherits it.

### 12.4 Delta from the built object-token fork

1. **Token representation**: `BatchToken` objects (`{deferred, id}`) become integer
   stamps. The registry's 31 lane slots gain a per-slot generation counter; minting
   composes the stamp arithmetically. `batchTokensForRender` writes into a reusable
   `Int32Array(32)` instead of allocating an array of objects.
2. **API naming**: `getCurrentWriteBatch` → `unstable_currentWriteStamp`;
   `getRenderContext()` (object with container) → `unstable_renderContainer()`
   (container or null; drops the wrapper allocation).
3. **Listener signature**: `onRenderPassStart` passes `(container, Int32Array, count)`
   with the documented copy-out contract, replacing a fresh `Array<token>`.
4. Everything else — edge set, async-action parking, per-root commit lock-in,
   backfill, close-edge semantics, the DOM-mutation window, error isolation, the
   build pipeline (`scripts/build-react.sh` → `build/oss-experimental/*`, pnpm
   overrides) — carries over unchanged, as does the reconciler test suite (updated
   assertions for integer stamps).

Why integers are React-concurrency-safe here: the object tokens existed to make
identity survive lane recycling; the generation bits provide the same guarantee
arithmetically (7.2). Nothing else about the object design depended on object-ness.

### 12.5 DOM-mutation window (verbatim requirement, carried over)

`onBeforeMutation(container)` / `onAfterMutation(container)` bracket exactly React's
commit mutation phase. The hooks live inside `flushMutationEffects` — not `commitRoot`
— because with View Transitions the mutation phase runs later, inside the browser's
`startViewTransition` update callback; bracketing `commitMutationEffects` +
`resetAfterCommit` there covers every commit path (including `flushSync` via
`flushPendingEffects`) and fires only when mutations will actually occur. Scope is
React's reconciliation mutations; documented exceptions (callers filter, the bracket
does not cover them): layout-phase `<img src>` reassignment, suspensey-CSS `<link>`
insertion, imperative Float APIs (`preload`/`preinit`), View Transition name
attributes, and user effect code. The signals library itself never references
MutationObserver; this surface exists for application code with its own observers.


## 13. React bindings: the hooks

The bindings register one `ExternalRuntimeListener` at module load (idempotent) and
keep a small per-container pass table: `Map<container, { viewKey, pin, spilled }>`,
written by `onRenderPassStart` (mapping the copied stamps through the slot table) and
cleared by `onRenderPassEnd`. `unstable_renderContainer()` keys reads into it.

### 13.1 `useSignal(signal)`

- **Render trigger**: one `useState(0)` version counter. The rendered value is never
  taken from React state — it is always read from the graph with the current pass's
  `(viewKey, pin)`, so a component mounting inside a transition render reads the
  pending world directly with no subscription yet, no double render, and no
  mount-mid-transition suspense bug (the scenario react-concurrent-store documents as
  its known bug becomes a passing test).
- **Subscription**: a **watcher node** (kind `K_WATCHER`) created in a layout effect,
  linked as a subscriber of the signal's node; `fns` holds the bound
  `setVersion(v => v + 1)`. When a write's flush validates the watcher (13.2), policy
  calls that setter **synchronously in the writer's execution context**, so React
  assigns the writer's lane: transition writes schedule transition re-renders, urgent
  writes urgent ones — lane lockstep with zero lane-awareness in the library.
- **Race fixup in the same layout effect** (covers writes landing between render and
  subscription): after linking, compare the value rendered against (a) the current
  committed value — mismatch means an urgent write raced; call setVersion directly
  (pre-paint correction); and (b) the value in any live pending view that includes
  this node — mismatch means a transition write raced; re-issue setVersion inside
  `startTransition` so the correction joins the pending batch. Needed only in race
  windows, not on every mount.
- **Suspense**: if the resolved read is a suspended computed, rethrow through React's
  `use(thenable)` (section 11.3).
- **Unmount**: dispose the watcher (unlink + free-list reclamation; watcher records
  are hook-owned, so explicit disposal covers them — no finalizer needed).

### 13.2 The notify path and equality cutoff

A write's propagation queues watcher nodes (`WATCHING` bit) like effects. The flush
step, still synchronous inside the write:

1. For each queued watcher, resolve its watched node **in the watcher-relevant view**:
   the writer's view for a deferred write, the committed view otherwise.
2. Compare against the watcher's last-delivered value (stored in the watcher's `vals`
   slot). Unchanged → drop silently (graph-level cutoff: no setState, no render).
3. Changed → store the new value as last-delivered and call `PolicyOps.notifyWatcher`
   → `setVersion` → React queues an update in the writer's lane.

The last-delivered comparison also powers commit-time dedupe (13.3). Note the
watcher's last-delivered value is per-watcher, not per-view: delivering a pending-view
value updates it, and the commit of that same value compares equal — exactly the
dedupe we want; an urgent write in between compares unequal and re-notifies — exactly
the wake we want.

### 13.3 Commit-time behavior

When `commitSlot` folds values a component already rendered via the pending view, its
watcher's last-delivered value equals the folded value, so no setState fires: the
transition's own commit does not echo a redundant re-render. Watchers on *other* roots
(or ones that never rendered the pending view) see a real change and re-render
urgently — which is correct: their screens show stale committed values.

### 13.4 `useAtom`, `useReducerAtom`, `useComputed`, `useSignalEffect`

- `useAtom` / `useReducerAtom`: a `useMemo`-held Atom/ReducerAtom whose node is
  created lazily and disposed on unmount (effect cleanup). Semantics otherwise
  identical to module-level atoms — including transitions: dispatching inside
  `startTransition` chains like any deferred write.
- `useComputed(fn, deps, options)`: a component-local `Computed` held by `useMemo`,
  recreated when `deps` change (compared like `useMemo`); `fn` closes over props and
  state freely — that is what `deps` is for; signal reads inside are auto-tracked.
  Subscription and reads run through the same watcher machinery as `useSignal` on the
  local node. The old node is disposed when deps change or on unmount.
- `useSignalEffect(fn, deps)`: a committed-world effect node (`signalEffect`) whose
  body runs after commit (registered from a passive effect), re-armed when `deps`
  change via the React pathway, and re-run when a tracked signal's **committed** value
  changes — the graph queues it during commit folds/urgent writes and flushes in a
  microtask. Cleanup supported like `useEffect`.

### 13.5 Render purity and loop protection

- Any atom write during a render pass evaluation throws (`configure` cannot relax
  this): React may replay or discard passes, so render-time mutation of graph state
  can never be safe. Writes inside computeds *outside* render remain allowed by
  default (cycle-guarded by the kernel's re-entrancy machinery: a write whose
  propagation reaches the currently-evaluating node throws a cycle error), and
  `configure({ forbidWritesInComputeds: true })` upgrades every in-computed write to
  a write-time error.
- All component re-renders flow through `setState`, so React's own protections apply
  to signal-driven loops: `throwIfInfiniteUpdateLoopDetected` (nested-update limit
  50) and the render-phase re-render limit (25). Pure signal-to-signal effect cycles
  that never touch React are bounded by the kernel's flush re-entrancy guard.

### 13.6 SSR and hydration

Server rendering reads committed values (there are no batches on the server), mounts
no watchers, and never runs observed-lifecycle effects. The documented recipe:
serialize with `dehydrateAtoms`, ship in the HTML, call `hydrateAtoms` before
`hydrateRoot` so first client render reads identical committed values. Multiple roots:
all state is global to the library; per-root state is only the pass table entry.

### 13.7 `startSignalTransition` / `useSignalTransition`

Thin sugar: `startTransition` + `batch` so many writes coalesce into one notify flush
(fewer setVersion calls, one propagation frontier). Adds no semantics — the same
writes without it are attributed to the same stamp; this is purely a
notification-coalescing performance helper, plus the abort-on-throw guard (10.4).

## 14. Growth and reclamation

All mechanisms below are proven in the research kernel; deltas for versioning are
called out.

### 14.1 Growth: closure rebuild at operation boundaries

The engine closure captures `const M` (and now `const V`) so TurboFan embeds the base
addresses like module constants — the only buffer-binding strategy measured at exact
const parity (rejected by measurement: segment tables +35–40% per access, resizable
ArrayBuffers +66–83% traversal, mutable bindings +34–43%, per-function aliases
+26–30%). Growth therefore rebuilds the engine: allocate doubled buffers, copy via
`.set`, re-create the closure, swap one module-level engine reference — only ever at
an **operation boundary** (`enterDepth === 0`: no engine frame that captured the old
buffers is live), never mid-walk. Allocators set `growPending` when crossing the slack
watermark (keep at least 1,280 free records AND half the plane); public wrappers and
the flush loop's entry perform the rebuild. A single operation that out-allocates the
entire remaining slack throws rather than corrupt in-flight walks.

Versioning deltas:

- M and V grow together in one rebuild (same record capacity), as do the side columns.
- Scalar state that must survive rebuilds (seq, slot tables, epoch, free-list heads,
  queue indexes) lives at module level, exactly like the proven kernel's counters.
- A rebuild can occur while a render pass is *paused* (passes are not engine frames;
  they hold pins and view keys, which are integers, not buffer references) — ids are
  stable across rebuilds, so nothing a pass cached goes stale.

### 14.2 Reclamation

- **Links**: freed to the link free list on unlink (order-preserving removal — the
  research notes document swap-remove breaking nested-effect ordering in two
  codebases; we keep list order).
- **Effects, scopes, watchers**: disposal returns records to the free list, deferred
  to the next operation boundary so a mid-flush dispose cannot recycle a record the
  queue or an in-flight walk still references; the record's `GEN` counter defuses
  stale disposers.
- **Atoms and computeds owned by hooks**: explicitly disposed by hook cleanup (13.4).
- **Module-level atoms/computeds whose handles are garbage-collected**: a
  `FinalizationRegistry` on the handle objects pushes their node ids (with generation)
  onto a pending-free list swept at boundaries. The research kernel documented this as
  the known leak and deliberately skipped it; the product library ships it, guarded by
  a "handles are the only owners" invariant: a node is finalizer-freed only if
  unwatched and subscriber-free, otherwise it is quarantined until unwatched. Cost is
  one registry registration per created signal (creation-path allocation; measured
  budget in section 18).
- **Version state**: chains and spill entries die with their slot (10.1/10.3);
  `committedRetained` sweeps when the oldest pin advances; `slotTouched` stacks reset
  on release. Nothing versioned needs tracing by the GC beyond the values themselves.

## 15. Constant inlining strategy

The kernel's speed depends on field offsets and flag masks reaching TurboFan as
literals. Measured walls (verified in this repo's toolchain): esbuild BUNDLING demotes
module-scope `const` to mutable `var` (+15–21% on kairo workloads); cross-file
`const enum` is packaging-dependent (esbuild transform mode and `tsc
--isolatedModules` leave runtime property accesses); dev-only checks are free only
under a build-time `define` (a literal-false branch folds at bytecode generation; a
module-`const` false costs ~10x a hot function's inline budget).

Strategy, in order of preference:

1. **Primary: same-file `const enum`.** The project has relaxed the original
   stripping-only rule and ships through a compile step (e.g. tsdown), so the kernel
   declares its schema as a `const enum` **in the same file as every hot consumer**
   (the kernel is one file precisely for this). Same-file const-enum members inline as
   numeric literals under esbuild (transform AND bundle modes), tsx, vitest, and tsc
   alike — codegen independent of packaging. Toolchain requirements this imposes,
   documented in the repo: `isolatedModules`-safe because same-file; consumers never
   import the enum (it is not exported); CI includes a **bundle audit** test that
   builds the library with the shipping bundler and asserts the output contains no
   `var <Enum>` declaration and no `<Enum>.` property access in kernel functions.
2. **Fallback for stripping-only consumers** (if a downstream toolchain must consume
   the TypeScript source directly): a generated-literals region. The schema lives in a
   small data file (`schema.ts`, plain runtime objects — also imported by tests,
   tracing, and Graphviz tooling, which want runtime access to field names); a repo
   codegen script rewrites the kernel file's marked region, emitting each constant as
   a numeric literal with a name comment (`M[id + 3 /* SUBS */]`). Byte-identical
   output to const-enum inlining, zero toolchain assumptions, at the cost of a
   generated region in a source file. The audit test covers this mode too.
3. **Function-scope `const` for anything not hot-path**: bundlers preserve
   function-scope consts, and the engine-factory closure already context-specializes
   them (the same mechanism that embeds the buffer bases); used for derived masks and
   cold-path tables where a literal would hurt readability.

Dev-time invariant checks (`assertNodeId`, flag-state assertions) compile to
`if (__DEV__) …` and are stripped by `define: { __DEV__: 'false' }` in production
builds — never guarded by runtime constants. Branded id types (`NodeId`, `LinkId` as
`number` subtypes) are used throughout kernel signatures: they erase to nothing and
catch id-kind and premultiplication mistakes at compile time.

## 16. Tracing and debugging

### 16.1 The tracer slot

The kernel and policy share one module-level `tracer` binding, `undefined` unless
`cosignal/tracing` is loaded. Every interesting transition is instrumented as
`tracer !== undefined && tracer.emit(type, cause, a, b, c)` — the untraced cost is one
scalar null check per site (measured pattern from the object design; sites are chosen
so no check sits inside the innermost propagation loop: propagate emits once per
frontier, not once per link).

### 16.2 Event schema (versioning-aware)

Every event: `id` (monotonic), `time`, `cause` (id of the triggering event — writes
cause propagations cause notifies cause renders cause reads), plus type payloads.
Types: `atom-write` (node, stamp, slot, kind: set/update/dispatch), `chain-append`,
`propagate` (worldMask, frontier size), `entry-eval` (node, viewKey, result state),
`entry-validate` (node, viewKey, verdict), `notify` (watcher, delivered or cut off),
`render-pass` (container, viewKey, pin, stamps), `render-read` (node, viewKey,
value-state), `batch-retired` (stamp, committed), `commit-fold` (slot, changed count),
`rebase` (node, case 1/2/3 of 10.2), `abort` (slot), `suspend` / `settle` (node,
viewKey), `effect-run`, `grow` (old/new records), `sweep`. Helpers answer "why did X
re-run / re-render" by walking cause chains backward; a ring buffer (finite
non-negative capacity; zero keeps the live stream without history) plus a subscription
API feed the future Chrome-devtools timeline extension.

### 16.3 Graphviz module

`cosignal/graphviz` emits DOT source (imports only *types* from tracing, so either
module loads without the other):

- `dependencyGraphToDot(roots)`: the live graph reachable from the given signals —
  atoms, computeds, effects, watchers; labels; per-view values while batches are live
  (a node touched in slot k renders its committed and per-view values side by side);
  stale flags; and per-edge world-membership coloring (`WORLDS` bits), which makes
  divergent pending dependencies visually obvious.
- `traceToDot(events, filter)`: the causal graph of trace events.

Because node state is packed integers, both renderers read the planes directly
(via exported debug accessors over `schema.ts` field names) with no per-node
allocation until render time — dumping a hundred-thousand-node graph is cheap enough
to do in a paused debugger.


## 17. Testing plan

### 17.1 Kernel, steady state (world 0)

- The full reactive-framework conformance suite (the 180-case suite; the research
  kernel passes its applicable 179) must pass with versioning code present but
  dormant, including with `initialRecords=2` growth stress and exact lazy pull counts
  (`testPullCounts: true` class behavior: never re-run a formula whose inputs did not
  change).
- Kernel unit tests for the flag ladder, cycle detection, write-in-computed policies,
  observed lifecycle edges, disposal generations, order-preserving unlink.

### 17.2 Kernel, versioned (no React): property tests against an oracle

The versioned kernel is exercised by a generator producing random schedules:
interleaved committed writes, deferred writes across 1–5 stamps (forcing spill),
`update`/`dispatch` entries, render passes (view + pin) with reads at random points,
yields, commits and aborts in random legal orders, growth events. The **oracle** is a
deliberately naive reference implementation of the read rule (section 8): a plain
write log per atom, values computed by replaying entries with the view/pin filter, and
computeds as memo-free recursive functions. Every read in the real kernel must equal
the oracle. This is the single highest-value test in the project: the versioned
algorithms' subtle parts (seq filters, rebase cases, epoch invalidation, hint
staleness, spill paths, pin retention) all reduce to "agrees with the naive replay".

Deterministic regression cases pinned from the design analysis: the 10.2 rebase
worked example; set-superseded-by-urgent; functional-entry replay over moved base;
suspended entry surviving commit; two views sharing a slot; slot reuse after retire;
pass pinned across two commits (retained values); epoch wrap simulation; seq
renumbering sweep.

### 17.3 React integration

Adopt the react-concurrent-store test harness wholesale (vitest + jsdom + RTL;
transitions held open by controlled promises; render-order logging with
afterEach-empty assertion; inline DOM snapshots for tear checks; listener-leak
asserts; controlled thenables for suspense) and its 14-scenario suite as the
conformance bar — including making its documented known-bug case (sync mount
mid-transition with suspending pending state) pass. Additional required scenarios:

- signal + `useState` lockstep inside one transition (single commit, no tear);
- urgent interruption and rebase (`ReducerAtom` versus real `useReducer` dispatching
  identical actions across a held-open transition: committed values match at every
  step);
- multiple roots (batch spanning roots; per-root lock-in; retire after last root);
- suspended-lane divergence (two live batches render together, one suspends, the
  other commits alone — exercises multi-bit and single-bit views on the same nodes);
- `useComputed` over props + state + signals; deps-change node replacement;
- `useSignalEffect` re-runs on committed changes only;
- infinite-loop rejection (a signal-effect echo loop trips React's nested-update
  limit, not a hang);
- MutationObserver window (observer sees app mutations, not React's);
- hydration parity (server HTML equals first client render);
- tracing: cause chains span write → propagate → notify → render-read → commit-fold.

The fork itself keeps its reconciler-level batch-registry suite (claim/pending/
backfill/finish/close/park edges, per-root lock-in), re-asserted for integer stamps,
plus stamp-encoding unit tests (generation rollover, lane reuse under live batch).

### 17.4 Memory and lifecycle

Heap-growth regression tests: mount/unmount churn (watcher reclamation), transition
churn (slots, chains, retained values return to baseline), FinalizationRegistry
sweeps under forced GC (node --expose-gc), arena growth then quiescence.

## 18. Benchmark plan and performance targets

### 18.1 Suites and modes

- **js-reactivity-benchmark** (the fork pinned by our research repo): registered as a
  framework adapter over `cosignal/core`; conformance tests must pass with exact pull
  counts. Modes: (a) pure — no React loaded; (b) transition-shaped — every write batch
  wrapped so it takes the deferred path with one live slot, reads resolved through a
  pending view (simulated stamps; no React needed); (c) post-commit — same, plus a
  commit fold per batch. Modes (b)/(c) are the honest price sheet for versioning.
- **Tier-0 shapes harness** (`harness/bench/shapes.ts`): deep, broad, diamond, reads,
  isolate, create — ratio-focused versus alien-signals v3.2.1 and versus the frozen
  research kernel (regression sentinel), with GC attribution and p99.
- **React-side microbench**: re-render-on-change latency and throughput versus
  `useState`/`useReducer` and versus `useSyncExternalStore` equivalents, under urgent
  writes, transitions, and interleaving; plus a tearing stress test that must show
  zero torn frames while sustaining writes during renders.

### 18.2 Targets (gates, not aspirations)

| surface                                            | target                                                        |
| -------------------------------------------------- | ------------------------------------------------------------- |
| steady-state tier-0 shapes vs alien-signals        | ≤ 1.0x each (research kernel already: 0.74–0.96x)             |
| steady-state vs frozen research kernel             | ≤ 1.03x each (the versioning tax must be one branch)          |
| bulk creation (kairo createComputations class)     | ≥ 1.3x faster than alien (research kernel: −40%)              |
| tier-0 create shape incl. FinalizationRegistry     | ≤ 1.0x vs alien (research kernel: 0.96x without finalizers)   |
| effect memory                                      | ≥ 30% below alien                                             |
| deferred write (one live slot)                     | ≤ 2x a steady-state write                                     |
| render read, valid entry (case 3 of 8.1)           | ≤ 4 integer compares + column load over a committed read      |
| commit fold                                        | linear in touched nodes; ≤ 1 propagation per changed node     |
| `useSignal` re-render vs `useState`                | within measurement noise (p50 and p95)                        |
| allocations on: steady read/write, valid-entry read, pass start (after first per container) | zero |

### 18.3 Methodology rules (from the research repo, binding)

One framework per process; conformance before any number; min-of-N with GC
attribution; never trust call-free micro-loops for binding/layout decisions (engine-
scale only); bundle through the shipping pipeline before measuring (const demotion).

## 19. Open risks and alternatives considered

1. **V-plane coldness is an assumption.** The claim "version metadata off the hot
   traversal costs nothing" must be measured with `HAS_ENTRIES` set on realistic
   fractions of nodes. Fallback if wrong: widen M to stride 12 for entry meta
   (interleave), accepting the density regression, or move `E*_SEQ` into M's spare
   budget by shrinking META. Measure before M2 exits (section 20).
2. **Epoch-bump invalidation is coarse.** Any slot retire invalidates every pending
   entry system-wide (they re-validate lazily, one verification walk each). Under
   many short transitions layered over one long one, the long transition's views
   re-validate repeatedly. Mitigation if measured hot: per-slot epochs (entries store
   a 3-slot epoch vector — costs META bits), or skip the bump when the retiring slot's
   touched set is empty. Decide on benchmark evidence.
3. **Two clocks of truth.** Correctness leans on seq comparisons (robust) with flags
   as hints (sloppy-by-design, 9.5). The risk is a maintainer "optimizing" a seq check
   into a flag check. Mitigations: the oracle property suite; loud comments at each
   hint site; dev-mode assertions that hint-verdicts never contradict seq-verdicts.
4. **Rebase case 3 re-runs user functions** (updaters/reducers replay on a moved
   base). This is React's own documented contract for updaters (purity required), but
   it is new for "signals" users; documented prominently, and the lockstep test makes
   the parity claim concrete.
5. **Fork maintenance.** ~600 lines across 8 reconciler/isomorphic files, rebased per
   React release. Contained by: edge-triggered design touching stable functions
   (`markRootUpdated`, `markRootFinished`, `prepareFreshStack`, root scheduler
   microtask), the reconciler test suite, and no behavioral changes to React when
   unsubscribed. Integer stamps do not change this surface.
6. **Multi-renderer processes** (react-dom + react-three-fiber): write classification
   answers from the first registered provider — best-effort, documented (inherited
   limitation). Batches from the second renderer classify as immediate writes; state
   stays correct (urgent path), transitions on that renderer degrade to non-transition
   behavior for signals only.
7. **Spill-path performance cliff.** Four-plus concurrent deferred batches or three-
   plus distinct views on one node fall to fold-every-read. Bounded by React's own
   lane economics; stress-tested for correctness; if real apps hit it, the slot count
   is a compile-time constant (bits exist for up to 8 slots in META/WORLDS layouts at
   the cost of 5 more flag bits and wider hint masks).
8. **`committedRetained` under long-paused passes.** A pass pinned while heavy urgent
   churn rewrites many nodes retains one old value per node. Bounded by nodes-changed-
   during-pass; passes are short (React yields but completes or restarts); restart
   drops the pin. Monitored by a tracing counter in dev.
9. **Alternatives considered and rejected**:
   - *Log overlay over a single-version kernel* — Variant A's territory; rejected here
     by assignment, but the honest tradeoff is: A pays log resolution on pending reads
     and keeps the kernel untouched; B pays kernel-wide versioning complexity and gets
     O(1) pending reads, kernel-uniform semantics, and no dual read-path divergence.
   - *Per-batch worlds as full graph copies* (persistent-data-structure style):
     memory and creation costs defeat the arena's entire advantage.
   - *Object tokens into the kernel* (skip stamps): forces a Map hop on every
     deferred-path operation and pollutes monomorphic int call sites.
   - *Merging kernel worlds when React renders batches together*: wrong when lanes
     later diverge (suspended-lane splits); views-as-masks handle divergence without
     merging state.
   - *Type-segregated value columns, naive SoA, links-only arena, WASM core, resizable
     ArrayBuffers*: all previously rejected by measurement in this repo; do not
     relitigate without new evidence.

## 20. Build order

Milestones, each gated by tests/benchmarks from sections 17–18:

- **M0 — Fork v2.** Integer stamps in the batch registry; listener/provider surface
  renamed; reconciler suite green with stamps; stamp-encoding tests. (Small delta over
  the existing built fork.)
- **M1 — Kernel with dormant versioning.** Research kernel + new field assignments
  (C_SEQ, W_HINT, WORLDS), const-enum schema + bundle audit, `liveSlotsMask` gates in
  write/read paths. Gate: 17.1 suite green; 18.2 steady-state parity versus the
  frozen research kernel.
- **M2 — Versioned kernel.** Slot table, chains + fold (in a minimal headless policy),
  V plane + entries, world-mask propagate, view checkDirty, commit/rebase/abort, seq
  sweep, spill paths. Gate: 17.2 oracle suite; 18.1 mode (b)/(c) numbers within
  targets; V-plane coldness measurement (risk 1).
- **M3 — Policy layer.** Atom/Computed/ReducerAtom, equality, observed lifecycle,
  promise protocol, configure, FinalizationRegistry. Gate: full core API tests;
  suspense unit tests.
- **M4 — React bindings.** Pass table, hooks, notify/cutoff/fixup, SSR helpers.
  Gate: 17.3 suite including the 14-scenario bar and the known-bug case.
- **M5 — Tracing + Graphviz.** Gate: zero-overhead check (tracer unloaded), cause-
  chain tests, DOT snapshot tests.
- **M6 — Benchmarks + hardening.** js-reactivity-benchmark registration, React
  microbenches, memory regression suite, docs pass (every public symbol documented in
  plain English with its invariants).

---

*End of spec.*
