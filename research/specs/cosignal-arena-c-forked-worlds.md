# cosignal-arena (Variant C): Forked Worlds

A from-scratch signals library for React with first-class concurrent rendering
support, built on a data-oriented (arena / `Int32Array` record) core. This is
the **Forked Worlds** variant: every speculative React render pass reads
through its own lightweight *world* — a compact delta region layered over one
canonical arena — created cheaply at pass start, merged into canonical state
on commit, and discarded in constant time on abort.

Status: DESIGN SPEC (complete, self-contained). Audience: an engineer with no
prior exposure to this project, to cosignal, to alien-signals internals, or to
React internals. Every concept is defined before it is used.

---

## Table of contents

1. [What this is, in one page](#1-what-this-is-in-one-page)
2. [Background: why concurrent React breaks external stores](#2-background)
3. [Vocabulary](#3-vocabulary)
4. [Architecture at a glance](#4-architecture-at-a-glance)
5. [Public API](#5-public-api)
6. [The React fork: `unstable_externalRuntime`, redesigned](#6-the-react-fork)
7. [Data layout: planes, records, field tables, byte math](#7-data-layout)
8. [Authoring constraints: constants, inlining, dev checks](#8-authoring-constraints)
9. [The steady-mode kernel](#9-the-steady-mode-kernel)
10. [Forked mode: batches, worlds, folds](#10-forked-mode)
11. [The kernel/policy cut](#11-the-kernel-policy-cut)
12. [Promises and Suspense](#12-promises-and-suspense)
13. [React bindings](#13-react-bindings)
14. [Growth and reclamation](#14-growth-and-reclamation)
15. [Tracing and debugging](#15-tracing-and-debugging)
16. [Testing plan](#16-testing-plan)
17. [Benchmark plan and performance targets](#17-benchmark-plan-and-performance-targets)
18. [Open risks and rejected alternatives](#18-open-risks-and-rejected-alternatives)
19. [Appendix: field tables and byte math quick reference](#19-appendix)

---

## 1. What this is, in one page

**A signals library** lets application code declare state cells (*atoms*) and
derived values (*computeds*) whose dependency relationships are discovered
automatically: when a computed's function reads an atom, the library records
"this computed depends on that atom", and when the atom changes, the library
knows exactly which computeds and subscribers are affected — no manual
subscription lists, no over-broad re-render storms.

**cosignal-arena** is such a library with two unusual properties:

1. **Data-oriented core.** Graph bookkeeping (dependency edges, dirty flags,
   version counters) does not live in JavaScript objects. It lives in one flat
   `Int32Array` — an *arena* — where every node and every edge is a fixed-size
   record of eight 32-bit integers. A prior lab in this repo
   (`libs/arena`, a mechanical port of alien-signals v3.2.1 onto this layout)
   passes all 179 conformance cases and beats the fastest mainstream object
   core on every tier-0 benchmark shape (deep 0.90x, broad 0.84–0.88x,
   diamond 0.89x, reads 0.74–0.87x, creation 0.96x), with a measured and
   documented list of layout rules that make that possible. This spec builds
   on those rules; they are restated here in full (§7, §8) so this document
   stands alone.

2. **No-compromise concurrent React integration.** React 18+ can prepare a
   render in the background (a *transition*) while the current screen stays
   interactive. State libraries that live outside React normally cannot
   participate: they have one current value per cell, so a background render
   either sees writes it should not (a *tear*) or forces React to abandon
   concurrency (`useSyncExternalStore` forces synchronous re-renders). This
   library instead gives each speculative render pass a **forked world**: a
   private, cheap, discardable view of the state graph in which the
   transition's pending writes are visible, while the canonical state — what
   committed screens show — is untouched until React commits. A small,
   maintainable patch to React (§6) tells the library when passes start and
   end, which update batches each pass includes, and when each batch commits
   or is discarded.

The headline bets of the Forked Worlds design, each argued in detail later:

- **One canonical arena, many cheap worlds.** Speculation never copies the
  graph. A world is: (a) the set of pending writes it includes, (b) a handful
  of *shadow records* in a separate small arena holding speculative values,
  and (c) transient mark bits riding in spare bits of the canonical records.
  Forking a world for a render pass is O(number of pending writes) in the
  worst case and O(1) in the common case (§10.3).
- **Worlds are read-only over topology.** Speculative evaluation never adds,
  removes, or reorders dependency edges in the canonical graph. This single
  rule eliminates the hardest class of merge problems (§10.4).
- **Commit is replay, not memory merge.** When React commits a batch, the
  library replays that batch's recorded writes into the canonical arena in
  global write order (the same rebasing rule React applies to its own
  `useState` queues) and lets the ordinary invalidation machinery do the
  rest. No bulk copying of world memory into canonical memory ever happens
  (§10.5).
- **Abort is O(1).** A discarded render pass abandons its world: one table
  entry is cleared; its shadow records become unreachable and are swept in
  bulk when the speculation episode ends (§10.6).
- **The steady state pays (almost) nothing.** When no React speculation is in
  flight — including for pure-core users who never load the React bindings —
  reads and writes run the proven arena kernel with a single
  scalar-load-and-branch of overhead per public operation, and the library's
  benchmark numbers are the `libs/arena` numbers (§9, §17).

---

## 2. Background

This section explains, from scratch, the two worlds this library straddles.
Readers who know both alien-signals and React's lane model can skim; the
vocabulary section (§3) is still required reading because this spec uses its
terms precisely.

### 2.1 How a pull-based signals graph works

Application code creates **atoms** (writable cells) and **computeds** (derived
cells with a function). Reading a computed inside another computed's function
records a dependency edge. The engine maintains, per cell:

- its current **value**;
- **flags** — a small bitmask recording, among other things, whether the cell
  is possibly stale;
- doubly-linked lists of **dependency edges** (what this cell reads) and
  **subscriber edges** (who reads this cell). One edge record belongs to both
  lists at once, which is why edges are their own records rather than array
  entries.

When an atom is written, the engine **propagates**: it walks subscriber edges
transitively, setting a "possibly stale" flag on everything downstream. This
is deliberately cheap — no user code runs during propagation. When someone
later **reads** a possibly-stale computed, the engine **verifies**: it walks
the computed's dependency edges checking whether anything it read actually
changed (recursively, deepest first), re-running computed functions only when
a real change is found, and comparing each recomputed value to the previous
one (**equality cutoff**) so that a change that produces an equal value stops
invalidation from spreading. This push-then-pull scheme — cheap eager marking
followed by lazy exact verification — is the alien-signals algorithm; it
recomputes the provable minimum (the conformance suite checks exact recompute
counts, and this library must keep that property: "exact pull counts", §16).

**Effects** are subscribers that run a function when their dependencies
change: the propagation walk pushes reached effects onto a queue, and a flush
loop runs the queue. **Watchers** are this design's name for the leaf
subscribers owned by the React bindings; when reached, they call into React
(`setState`) instead of running user code (§13).

### 2.2 What concurrent React does, and why external state tears

React schedules rendering work in **update batches**. When an event handler
calls `setState`, the update is tagged with a priority; updates caused inside
`startTransition` are tagged as **deferred** (transition) work. React may:

- render deferred work **in the background** over multiple slices of time
  (yielding to the browser between slices), while the committed screen stays
  interactive;
- **interleave**: start an urgent render (a keystroke) while a transition
  render is mid-flight, commit the urgent one first, then **restart** the
  transition render so it includes ("rebases onto") the urgent change;
- **discard** a speculative render entirely (the transition was superseded);
- run a component **for the first time** inside a transition render (a
  "mount mid-transition") — that new component has no update queue history,
  it just renders in whatever world the pass is rendering.

React's own state (`useState`/`useReducer`) handles all this because every
queued update carries its batch tag, and a render at a given set of batches
applies exactly the matching updates and rebases the rest — React's update
queue is a small multi-version store.

External state — one mutable value per cell — breaks in exactly three ways:

1. **A background render cannot see the transition's writes** (or, if the
   library eagerly applies writes, the *committed* screen's re-renders
   wrongly see them). One value cannot serve two worlds.
2. **A paused render can resume after an unrelated write** and read a
   mixture of old and new values — a tear inside one render pass.
3. **The library cannot know when pending writes become the committed
   truth**, so it cannot run "the value really changed" effects at the right
   time or reclaim speculation state.

`useSyncExternalStore` "solves" this by forbidding concurrency: every store
change schedules synchronous work, and any store write during a concurrent
render forces React to throw the render away and re-render synchronously.
Store state can never ride in a transition. That is the de-opt this design
eliminates.

### 2.3 What the React patch provides (summary; full spec in §6)

A small fork of React (maintained as a patch series over `vendor/react`;
prior art built and validated in the sibling project `react-signals-fable`)
exposes exactly the facts userspace cannot observe, and nothing else — no
Fiber objects, no lane bitmasks:

- **Batch identity**: "the write I am issuing right now belongs to batch
  token T, and T is (or is not) deferred." Tokens are minted once per real
  batch and never reused, so they are safe to compare and store.
- **Render pass lifecycle**: "a render pass just started on root R and it
  includes batches {T1, T2}; …the pass on R just ended." A pass spans yields:
  pause/resume is one pass; a restart is a new pass.
- **Batch retirement**: "batch T has left React's books" — exactly once per
  token, whether the batch committed, was pruned by unmounts, or never
  produced React work at all.
- **DOM mutation window** (unrelated to signals, same channel): "React is
  about to mutate the DOM under root R … and is done." Provided so an
  application `MutationObserver` can ignore React's own mutations. Required
  by the product brief; specified in §6.6.

### 2.4 The proven arena substrate this design builds on

`libs/arena` in this repo is a full transliteration of alien-signals v3.2.1
onto interleaved `Int32Array` records, passing 179/179 conformance cases with
exact pull counts. Its measured findings are load-bearing constraints for
this spec:

- **Record interleaving wins; parallel per-field arrays lose.** Nodes and
  edges are eight-integer records in one flat plane; all fields of a record
  are adjacent (one cache line fetch covers a whole record and its neighbor).
  A naive structure-of-arrays split (one array per field) measured 1.8x
  *worse* than plain objects on deep chains.
- **Buffers must be captured as `const` bindings inside a factory closure**,
  and growth must **rebuild the closure** over doubled buffers, swapping one
  module-level engine reference at an operation boundary. V8's optimizing
  compiler embeds closure-constant buffer bases like compile-time constants;
  every alternative growth strategy was measured and rejected (segment
  tables +35–40% per access; resizable ArrayBuffers +66–83% on traversal;
  mutable `let` bindings +34–43%; per-function aliases +26–30%). Growth
  *events* are near-free; only growth *support* on the read path costs.
- **Hot helpers have hard size budgets.** V8 refuses to inline functions
  above 460 bytecodes (typed-array field access generates roughly twice the
  bytecode of a named-property load), so the hottest helper in the port
  originally never inlined; splitting its rare insertion tail into a separate
  function (`link`/`linkInsert`) recovered 8–13% on tier-0 shapes. All hot
  functions in this design carry an explicit bytecode budget (§8.2).
- **Values and functions stay in ordinary JavaScript arrays** ("side
  columns"), indexed off the record id. Type-segregated numeric value columns
  (e.g. a `Float64Array` for number-valued cells) measured worse than one
  packed `unknown[]`. The garbage collector, not the arena, owns user values.
- **Bounds-check masking is unnecessary**: applying the `& MASK` idiom to
  every plane access was measured as noise-to-harmful; V8's typed-array
  bounds checks are effectively free on data-dependent graph walks.
- **Field offsets and flag values must reach V8 as numeric literals.**
  Module-scope `const` offsets are demoted to mutable `var` by bundlers
  (esbuild's lazy-init/scope-merge hoisting), costing a measured 15–21% on
  macro benchmarks. The primary strategy is a **same-file `const enum`**
  (members inline as literals under esbuild transform and bundle modes, tsx,
  vitest, and tsc alike — but only when the enum and its uses share a file).
  §8.1 specifies the toolchain requirement this imposes and the generated-
  literal fallback for stripping-only consumers.

### 2.5 Semantics inherited from the cosignal design

A sibling project (`react-signals-fable`; its design document is
`DESIGN.md` there) worked out, against a real React fork and a real test
suite (including the React team's own `react-concurrent-store` scenario
suite), *what the correct observable behavior is* for signals under
concurrent React: which value a read must return in every context, how
functional updates rebase, when effects fire, how mounts inside transitions
behave. This spec adopts those semantics — they are restated precisely and
self-containedly in §10.1 and §10.7 — but implements them with a different
machine: where cosignal-v1/v2 kept a per-atom write log and resolved every
read against a "read context" by scanning log entries, Forked Worlds
materializes each render pass's view once, up front, into arena records, so
per-read work in a pass is a table hit instead of a rule evaluation. The
behavioral contract is identical; the two designs must pass the same tests
(§16).

---

## 3. Vocabulary

Every term this spec uses with a precise meaning. Terms marked (React) come
from React or the React patch; terms marked (new) are introduced by this
design. Plain-English definitions; no formal notation anywhere in this spec.

**Arena.** A large, flat `Int32Array` holding fixed-size records. Records are
addressed by integer ids. There is no per-record JavaScript object.

**Record / id.** Eight consecutive 32-bit integers in an arena. An id is the
element offset of the record's first field (ids are pre-multiplied by the
stride: `id = recordIndex * 8`), so field access is `M[id + FIELD]` with no
shift. Id 0 is burned as the null record; "no record" is always id 0.

**Plane.** One arena buffer plus its side columns, treated as a unit. This
design has two: the **canonical plane** (the durable graph) and the
**speculation plane** (short-lived world state). (new)

**Side column.** An ordinary JavaScript array indexed off record ids, holding
things an `Int32Array` cannot: user values, functions, labels. The values
column holds two slots per node record; the functions column one.

**Node.** A record representing an atom, computed, effect, scope, or watcher.

**Link.** A record representing one dependency edge. A link belongs to two
doubly-linked lists at once: the dependency list of its subscriber and the
subscriber list of its dependency.

**Atom.** A writable state cell. Public class `Atom<T>` (and `ReducerAtom`,
which is an atom whose functional updates are `(state, action)` reductions —
§11.3).

**Computed.** A derived cell: a function plus a cached result. Lazy: it
recomputes only when read while possibly stale.

**Effect.** A subscriber that runs user code when dependencies change. Core
effects flush synchronously via an explicit queue; React-side signal effects
are policy on top (§13.4).

**Watcher.** (new) A node kind owned by the React bindings: a leaf subscriber
whose "run" is a notification callback into React (`setState`). Watchers
participate in graph walks exactly like effects but never run user code
during a flush.

**Propagate / verify (checkDirty) / equality cutoff.** See §2.1. "Verify"
and "checkDirty" are used interchangeably; checkDirty is the function name.

**Batch.** (React) A set of updates React renders and retires as a unit. In
this spec a batch is always named by its **token**: a positive integer,
minted once, never reused (§6.2). A batch is **deferred** if it is
transition-like: its renders do not block paint and it commits later.

**Write-set.** (new) The engine's record of the writes belonging to one
pending batch: for each written atom, an entry holding the written value (or
the update function — see *entry*), in global write order.

**Entry.** (new) One recorded write: which atom, which batch, a global
sequence number (**seq** — a ticket from a take-a-number counter shared by
all writes program-wide), and either a plain value or a stored update
function (for `atom.update(fn)` / `reducerAtom.dispatch(action)`; functions
are stored, not evaluated, and replayed per world — §10.1).

**Base value.** (new) For an atom with pending entries: the canonical value
from before the oldest retained entry. Replays start here.

**World.** (new) A view of the graph in which some set of pending batches is
visible on top of canonical state. Concretely: a world id, a set of included
batches, and shadow records + mark bits carrying its speculative state.
Three flavors:
- the **canonical world**: no batches; reading it is just reading the
  canonical plane (it needs no world machinery at all);
- the **HEAD world**: all pending batches visible — "newest write wins".
  Outside-render reads use HEAD. Long-lived (as long as any batch is
  pending);
- **pass worlds**: one per React render pass, containing exactly the pass's
  included batches. Short-lived (the duration of one pass). A pass whose
  included batches are exactly the live batch set **aliases** HEAD instead
  of forking its own records (§10.3).

**Shadow record.** (new) A record in the speculation plane holding one
node's speculative state for one world: its value slot, its world-local
status flags, which world owns it. Shadow records for the same node chain
together; the canonical node record points at the newest one.

**Mark bits.** (new) Two bits in the canonical flags word (world-pending,
world-dirty) used by the *current mark owner* world for its propagation
marks. Exactly one world owns the mark bits at a time (§10.3); ownership
switches are explicit and re-derivable, so marks are a cache, never truth.

**Fold.** (new) The commit-side merge: when a batch retires committed, the
engine replays affected atoms' entries in seq order into the canonical
plane, propagates canonically, and notifies effects. "Fold" is used for the
per-atom replay-and-store; "retirement" for the batch-level event.

**Copy-out.** (new) The preservation step that protects paused render
passes: when a canonical value is about to be overwritten (by a fold or by a
lazy canonical recompute) while render passes that must not see the new
value are still alive, the old value is first copied into a shadow record
for each such pass. §10.5.

**Episode.** (new) A maximal period during which speculation exists: begins
when the first pending batch or world appears in a previously quiet engine,
ends when the last batch retires and the last pass ends. The speculation
plane is bump-allocated within an episode and reset wholesale at episode
end.

**Steady mode / forked mode.** (new) Steady: no episode in progress; the
engine is exactly the proven arena kernel plus one scalar check per public
operation. Forked: an episode is in progress; reads dispatch through world
resolution. The mode lives in one module-level counter (§9.4).

**Render pass.** (React) One attempt by React to render a root: fresh stack
through completion or discard, spanning yields (pause/resume is the same
pass; a restart is a new pass). The patch brackets passes with events.

**Root.** (React) An independent React tree (`createRoot(container)`).
Identified across the patch boundary by its container object. Multiple roots
are fully supported (§13.6).

**Retirement.** (React patch) The moment a batch leaves React's books,
exactly once per token, with a boolean: committed (its updates are part of a
committed tree — including empty commits after unmount pruning) or not (the
batch never produced React work; its writes were external-only).

**Pin.** (new, degenerate here) In log-based designs a pass "pins" history
it may still need. Forked Worlds has no read-time history rule; the
equivalent protection is copy-out (§10.5). The term appears only when
comparing designs.

**Observability gate.** (new) The check that keeps all of this machinery
out of pure-core use: batch/world bookkeeping activates only when the React
runtime adapter is installed *and* the current write is classified as
belonging to a live or deferred batch. A program that never imports the
React bindings never opens an episode.

**Kernel / policy.** The mechanism/policy cut (§11): the kernel owns ids,
layout, graph algorithms, world mechanics, and reports facts; policy layers
(class wrappers, React bindings, schedulers, tracing) decide what to do with
the facts. The kernel never contains a branch named after a React concept.

---

## 4. Architecture at a glance

```
                        POLICY LAYER (plain JS/TS, GC-owned)
  Atom / ReducerAtom / Computed classes     React bindings (hooks, watchers)
  equality options, labels, observed-       batch adapter (token -> local index),
  lifecycle effects, suspense ctx.use       fold scheduling, effect scheduling,
  FinalizationRegistry reclamation          tracing module (lazy), graphviz
────────────────────────────────────────────────────────────────────────────
                        ENGINE (one file, generated constants)
   steady kernel (alien-equivalent):        world machinery (forked mode only):
   read/write/computedRead/effect flush     write-set entries, world table,
   propagate / checkDirty / link            fork, world-read, world-verify,
   closure-rebuild growth                   fold + copy-out, episode sweep
────────────────────────────────────────────────────────────────────────────
                        STORAGE
   CANONICAL PLANE (Int32Array M)           SPECULATION PLANE (Int32Array W)
   node records + link records,             shadow records (bump-allocated
   stride 8, interleaved, free lists        per episode; no free lists)
   side columns: values[], fns[]            side column: wvalues[]
   scratch stacks, effect queue             touched lists, batch table (JS)
────────────────────────────────────────────────────────────────────────────
                        REACT FORK (vendor/react patch series)
   integer batch tokens; render-pass events (start includes batch list, end);
   batch retirement events; write classification queries; DOM mutation window
```

Life of a transition, end to end (each step is specified later):

1. `startTransition(() => { atomA.set(1); setReactState(x) })` — the write
   classifies as deferred (patch query), the engine opens an episode if
   quiet, records an entry in batch T's write-set, updates the HEAD world,
   and notifies subscribed watchers *synchronously in the writer's context*
   so React tags their `setState` with the same batch (§10.1, §13.2).
2. React starts a background render pass for batch T on root R. The patch
   fires "pass started on R, includes {T}". The engine forks a pass world —
   in the common case (T is the only live batch) it aliases HEAD: O(1)
   (§10.3).
3. Components render. `useSignal(computedC)` reads C *in the pass world*:
   if C is unaffected by T's writes, the read falls through to the canonical
   plane after one epoch check; if affected, the engine verifies/evaluates C
   in-world and caches the result in a shadow record (§10.4).
4. Meanwhile an urgent keystroke writes atomB. Urgent writes fold into the
   canonical plane immediately (with an entry retained for rebasing, and
   copy-out protecting the paused pass if it could observe atomB) and notify
   watchers in the urgent context; React interleaves an urgent render (its
   pass world is canonical: zero fork cost), commits it, restarts the
   transition pass; the restart forks a fresh world that now sees both the
   committed urgent value and T's pending writes (§10.5, §10.7).
5. React commits the transition. The patch fires "batch T retired,
   committed". The engine folds T: replays each written atom's entries in
   global write order (functional updates rebase exactly like `useState`
   updaters), stores changed values canonically, propagates, queues signal
   effects (§10.5).
6. No batches remain and no pass is live: the episode ends. Touched nodes
   are swept clean of shadow pointers and mark bits; the speculation plane's
   bump pointer resets; the engine returns to steady mode (§10.8).

If instead the transition had been superseded, step 5–6 would be: passes
discarded (O(1) each), batch retires uncommitted, entries dropped, HEAD
recomputed, episode ends. Canonical state was never touched — abort costs
nothing beyond the sweep already owed (§10.6).

---

## 5. Public API

The public surface is the product brief's API, verbatim in shape; this
section pins down signatures, semantics, and which layer implements each
piece. TypeScript style rules: prefer `type X = ...` over `interface` (use
an interface only for a specific variance reason); prefer `undefined` over
`null` unless it worsens performance.

### 5.1 Core: `Atom`

```ts
type AtomOptions<T> = {
  state: T
  /** If set, runs when the atom becomes observed (first watcher, effect, or
   * transitively-watched computed subscribes); the returned cleanup runs when
   * it is no longer observed. Intended for remote subscriptions. Delivery is
   * deferred to a microtask so a same-tick observe/unobserve flap does not
   * thrash the remote end. */
  effect?: (ctx: AtomCtx<T>) => (() => void) | void
  /** Equality cutoff; defaults to Object.is. Checked at three sites: write
   * short-circuit, fold-time canonical change detection, and world-level
   * change detection. */
  isEqual?: (a: T, b: T) => boolean
  /** Debug tools only; never read on hot paths. */
  label?: string
}

class Atom<T> {
  constructor(options: AtomOptions<T>)
  /** Current value for the caller's read context (see §10.2): the pass world
   * during render, HEAD outside render, canonical in committed effects. Reads
   * are tracked when a computed/effect is evaluating. */
  get state(): T
  set(next: T): void                      // like setState(value)
  update(fn: (current: T) => T): void     // like setState(fn); fn stored & replayed, must be pure
}

type AtomCtx<T> = {
  /** Write from inside the observed-lifecycle effect (e.g. push a remote
   * update into the atom). Classified like any other write. */
  set(next: T): void
  readonly label: string | undefined
}
```

### 5.2 Core: `Computed`

```ts
type ComputedOptions<T> = {
  fn: (ctx: ComputedCtx<T>) => T
  isEqual?: (a: T, b: T) => boolean
  label?: string
}

class Computed<T> {
  constructor(options: ComputedOptions<T>)
  /** Lazy read with tracking, world-aware. Throws the cached error if the
   * last evaluation threw; suspends (see §12) if the last evaluation used a
   * still-pending promise. */
  get state(): T
}

type ComputedCtx<T> = {
  /** Suspense integration: returns the promise's value if fulfilled, throws
   * its reason if rejected, and otherwise marks this computed suspended and
   * aborts evaluation. Promise identity is cached per world and per call
   * position so replays see stable identities (§12). */
  use<U>(promise: PromiseLike<U>): U
  readonly label: string | undefined
}
```

Computed functions may write atoms (tolerated by default; a dependency cycle
between the write and the evaluating computed throws a cycle error;
`configure({ forbidWritesInComputeds: true })` makes any in-computed write
throw at write time). A computed evaluated *inside a React render pass* may
never write — React can replay or discard the pass, so pass-world evaluation
always rejects writes with an error (§10.4).

### 5.3 Core: `ReducerAtom`

```ts
type ReducerAtomOptions<T, A> = {
  state: T
  reducer: (state: T, action: A) => T
  isEqual?: (a: T, b: T) => boolean
  label?: string
}

class ReducerAtom<T, A> {
  constructor(options: ReducerAtomOptions<T, A>)
  get state(): T
  dispatch(action: A): void
}
```

`dispatch(action)` records the *action* (not the reduced value) in the write
entry; every world that includes the entry replays `reducer(prev, action)` on
the value accumulated so far in that world — exactly `useReducer`'s rebasing
behavior (a differential test dispatches identical actions through a
`ReducerAtom` and a real `useReducer` across a held-open transition with
urgent interleaving; committed values must match at every step — §16.3).
Reducers must be pure: one action can be replayed once per world that
includes it. `ReducerAtom` is pure policy over the same kernel record as
`Atom` (§11.3).

### 5.4 Core: standalone effects and batching

For non-React use (and the reactivity benchmark):

```ts
function effect(fn: () => void | (() => void)): () => void   // returns dispose
function effectScope(fn: () => void): () => void             // dispose all inside
function startBatch(): void
function endBatch(): void
function untracked<T>(fn: () => T): T
function configure(options: { forbidWritesInComputeds?: boolean }): void
```

Core effects flush synchronously (outermost write returns after the cascade
settles), ancestors before descendants, each effect at most once per flush
per real change — the benchmark contract. Reads between writes inside a batch
see fresh values (HEAD semantics degenerate to "the one current value" when
no React batches exist).

### 5.5 React hooks

```ts
/** Subscribe this component to a signal; re-renders (through setState, never
 * useSyncExternalStore) when the signal's output changes in the component's
 * world. */
function useSignal<T>(signal: Atom<T> | Computed<T> | ReducerAtom<T, unknown>): T

/** Component-owned atom; identity stable across renders (like useState's
 * cell). */
function useAtom<T>(options: AtomOptions<T>): Atom<T>
function useReducerAtom<T, A>(options: ReducerAtomOptions<T, A>): ReducerAtom<T, A>

/** Like useMemo, but re-renders the component when any signal read inside fn
 * changes output. fn may close over props/state (that is what deps are for);
 * signal reads inside fn are auto-tracked. Recreated when deps change,
 * compared like useMemo. */
function useComputed<T>(
  fn: (ctx: ComputedCtx<T>) => T,
  deps: unknown[],
  options?: { isEqual?: (a: T, b: T) => boolean; label?: string },
): T

/** Like useEffect, and also re-runs when a signal read during the last run
 * changes committed value. Cleanup supported. Runs after commit; observes
 * committed (canonical) state only. */
function useSignalEffect(fn: () => void | (() => void), deps: unknown[]): void
```

No provider component is required (the brief permits one "if strictly
necessary" — the patch's process-wide registry makes it unnecessary; multiple
roots work because every patch event carries the root's container).

### 5.6 Transitions

Signal writes inside `startTransition` / `useTransition` are automatically
deferred and land in the same batch as React state updates made in the same
scope — a transition works over React state and signal state in lockstep with
no extra API. Two optional helpers are provided as pure sugar:

```ts
/** Equivalent to startTransition(() => { startBatch(); try { scope() }
 * finally { endBatch() } }): one notification sweep for many writes. */
function startSignalTransition(scope: () => void): void
function useSignalTransition(): [isPending: boolean, start: (scope: () => void) => void]
```

They exist so heavy multi-write transitions can pay one propagation instead
of several; they add no semantics.

### 5.7 Tracing and visualization entry points (lazy modules)

```ts
// module "cosignal-arena/tracing" — loading it installs the tracer (§15)
function startTracing(options?: { ringCapacity?: number }): TraceSession
// module "cosignal-arena/graphviz" — imports only types from tracing
function dependencyGraphToDot(signals: Array<Atom<unknown> | Computed<unknown>>): string
function traceToDot(events: TraceEvent[]): string
```

Zero overhead unless loaded: every emit site in the engine is guarded by one
`tracer !== null` check (§15.4).

---

## 6. The React fork

This design may not read Fiber objects or lane bitmasks from userspace, and
the patch must stay small and maintainable. The patch specified here is a
*redesign* of a fork that already exists and is validated by a
reconciler-level test suite in the sibling project (`react-signals-fable`,
`vendor/react` patch series: an isomorphic `ReactExternalRuntime` channel
following the established `ReactSharedInternals` renderer-registration
pattern, plus a `ReactFiberBatchRegistry` that is edge-triggered from the
four places the reconciler already mutates its own batch bookkeeping). The
redesign keeps that architecture — the registry's edge set is the hard-won
part — and changes the token representation and one event payload.

### 6.1 Design rules for the patch

1. **No implementation shapes cross the boundary.** Batches cross as opaque
   integer tokens; roots cross as their container identity (for react-dom,
   the DOM container element — which is also exactly what a
   `MutationObserver` caller needs). Nothing else crosses.
2. **Additions are unconditional but inert**: no feature flag; until a
   listener subscribes, the per-commit cost is one property read and branch,
   and hot reconciler paths pay one null/integer check per site.
3. **Edge-triggered, never sampled.** Every registry transition fires from a
   line the reconciler already executes when its own bookkeeping changes
   (batch claim, first scheduled work per root, commit, event-close). This is
   what makes token identity safe against lane-bit recycling (§6.2).
4. Each hook site documents its invariant ("fires after X, before Y") in the
   patch itself; the reconciler-level test suite asserts the protocol
   (§16.4).
5. Listener errors are reported like uncaught errors and never corrupt a
   commit.

### 6.2 Batch tokens are integers

A **batch token** is a positive safe integer (`number`), minted from a
monotonically increasing counter the first time an external consumer asks for
the current batch's identity, and **never reused for the life of the page**
(a JavaScript number counter does not wrap at any achievable rate; tokens are
compared by value).

Why integers instead of the previous fork's `{deferred, id}` objects:

- **Minting is allocation-free.** `getCurrentWriteBatch()` sits on the write
  path of every deferred signal write; returning a small integer keeps the
  engine's "zero allocations in the write path" property end to end
  (validated by heap profiling in the prior project; §17.4 keeps the check).
- **Tokens can live in Int32 records.** The engine maps each live token to a
  small *local batch index* (there are at most 31 live batches — one per
  React lane — so an index fits in 5 bits) and stores indices in speculation
  records; the token-to-index map is a tiny policy-layer table. Integer
  tokens make that mapping a `Map<number, number>` hit with no object
  identity concerns.
- **Concurrency safety is unchanged.** Lane *bits* are recycled (React's
  transition lane cursor wraps after a handful of claims), which is exactly
  why raw lanes must not cross the boundary; token safety comes from the
  edge-triggered mint-once-per-claim discipline, not from the token's runtime
  type. An integer minted once and never reused is as alias-proof as an
  object. If a lane bit is claimed again while its previous batch is still
  pending, React itself cannot distinguish the two batches — they render and
  retire together — and the registry mirrors reality by reusing the existing
  token (explicit merge), exactly as the validated fork does.

The deferred/urgent classification moves out of the token into the query
surface (`isCurrentWriteDeferred()`, already the observability gate's first
call) and into the pass-start event payload, so nothing needs to carry a
boolean on the token itself.

### 6.3 The `unstable_externalRuntime` surface

One subscription function and three queries, exported from the `react`
package (isomorphic; renderers register a provider through the shared
internals object, following the same pattern React already uses for
`onStartTransitionFinish`; with multiple renderers loaded, batch attribution
is best-effort and documented as such):

```ts
type ExternalRuntimeListener = {
  /** A render pass began on `container`. `includedBatches` lists the token of
   * every live batch this pass renders, with its deferredness. A pass spans
   * yields (pause/resume is one pass); a restarted render is a new pass.
   * Invariant: fires after React commits to rendering these lanes on this
   * root, before any component function runs. */
  onRenderPassStart?: (
    container: unknown,
    includedBatches: ReadonlyArray<{ token: number; deferred: boolean }>,
  ) => void
  /** The pass on `container` completed or was discarded. Invariant: after the
   * last component function of the pass, before the commit phase (on
   * completion) or before the next pass starts on this root (on restart). */
  onRenderPassEnd?: (container: unknown) => void
  /** Batch `token` left React's books — exactly once per token. `committed`
   * is false only for batches that never produced React work (external-only
   * writes); batches whose React updates died with unmounted trees still
   * retire through an ordinary (possibly empty) commit with committed=true. */
  onBatchRetired?: (token: number, committed: boolean) => void
  /** DOM mutation window — see §6.6. */
  onBeforeMutation?: (container: unknown) => void
  onAfterMutation?: (container: unknown) => void
}

function unstable_subscribeToExternalRuntime(l: ExternalRuntimeListener): () => void

/** Pure classification, no minting, no allocation: would a write issued right
 * now belong to a deferred (transition-like) batch? */
function unstable_isCurrentWriteDeferred(): boolean
/** Token of the batch a write issued right now belongs to; mints on first
 * use; stable for the batch's life; 0 when no batch context exists. */
function unstable_getCurrentWriteBatch(): number
/** undefined outside render; { container } while a render pass is executing
 * on the current thread. Drives read-context selection (§10.2). */
function unstable_getRenderContext(): { container: unknown } | undefined
```

### 6.4 Registry semantics the engine relies on

These are promises the patch makes (all inherited from the validated fork,
restated here because the engine's correctness argument cites them):

- **Claim edge**: a token can be minted from the moment React claims a lane
  for the current event (inside `startTransition`, this is when the
  transition lane is claimed).
- **Pending edge**: the registry records every root a batch schedules work
  on. Updates scheduled *before* the batch's first external write (ordinary
  line order: `setState(x); atom.set(y)`) are repaired by a backfill step in
  the root scheduler's microtask, so the finish edge — not the close edge —
  retires such batches.
- **Finish edge**: on each commit, batches whose lane is no longer pending on
  that root are marked done there; a token retires when its last pending root
  finishes. A root that commits the batch while other roots remain pending is
  remembered: later passes on that root keep *including* the batch (its
  committed tree already shows those writes — hiding them from its urgent
  renders would tear against its own DOM). `includedBatches` therefore
  contains committed-but-not-retired batches on such roots; the engine treats
  them like any included batch.
- **Close edge**: at the end of the scheduling microtask, a batch that never
  scheduled React work retires immediately (committed=false) — *unless* the
  transition turned out to be an async action (the scope returned a promise),
  in which case the registry parks the batch on the action's thenable and
  re-decides when it settles. This is what keeps store-only writes inside
  `async startTransition` from leaking into committed state mid-action, and
  it is how **entangled async actions** reach the engine: the batch simply
  stays pending longer, and updates from post-await continuations join the
  same token.
- **Discarded passes are not retirements.** A restarted or abandoned render
  pass fires `onRenderPassEnd` only; its batch stays pending and will be
  rendered by a later pass.

### 6.5 What the engine must NOT assume

- No ordering between `onRenderPassEnd` on one root and `onRenderPassStart`
  on another beyond "at most one pass executes at any instant on a thread".
  Passes on different roots interleave arbitrarily (§10.3's mark-owner
  protocol exists for exactly this).
- No assumption that every included batch has entries in the engine
  (React-state-only batches appear in `includedBatches`; the engine ignores
  tokens it has no write-set for).
- No assumption that retirement order matches batch creation order.

### 6.6 DOM mutation window

Unrelated to signals, carried on the same channel because it is the same
kind of lifecycle fact. `onBeforeMutation(container)` /
`onAfterMutation(container)` bracket exactly React's commit mutation phase
for that root, firing only when there are mutations to apply. The hooks live
inside React's mutation-effects flush (not the outer commit entry point)
because with View Transitions the mutation phase runs later, inside the
browser's `startViewTransition` update callback; bracketing there covers
every commit path including `flushSync`. Scope is React's *reconciliation*
mutations. Documented exclusions (callers filter these themselves): the
layout-phase `<img src>` reassignment, suspensey-CSS `<link>` insertion,
imperative Float APIs (`preload`/`preinit`), View Transition name
attributes, and user effect code. The intended use — disconnecting a
`MutationObserver` around React's own writes while observing everything
else — lives entirely in application code; this library never references
`MutationObserver`.

### 6.7 Build and maintenance

The patch is a rebased commit series over the React submodule
(`vendor/react`), built via a repo script into `build/oss-experimental/*`
and linked into the workspace through pnpm overrides (rebuilds require no
reinstall). Size discipline: the validated fork's series is roughly one
registry module (~300 lines), one channel module (~175 lines), and ~120
lines of single-line call sites in the reconciler — the redesign must stay
in that envelope. Every reconciler touchpoint is a call to a registry
function guarded by "has listeners", so upstream rebases mostly re-anchor
call sites rather than re-derive logic.

---

## 7. Data layout

Two planes, their side columns, and the small amount of GC-owned bookkeeping.
The residency rule for every field (adopted from the packed-authoring
analysis in this repo, restated so this spec stands alone):

- **Storage rule** (mechanically checkable): every plane record is either on
  a free list or has its kind bits set; every plane field's owning alloc/free
  site is named in the schema.
- **Design rule** (for every new field): *will `propagate`, `checkDirty`,
  `link`, `notify`, or world resolution read it while walking?* Then it must
  be reachable as `M[id + FIELD]` without leaving the plane. Touched only at
  leaves (actual recomputes) or boundaries (subscribe, fold, fork, sweep)?
  Then it lives in a GC side structure keyed off the id. Lifetime gives the
  default (engine-created/destroyed state goes in the plane); the capability
  test promotes or demotes from there.

This is why values, functions, labels, equality functions, observed-lifecycle
refcounts, batch write-sets, and per-world suspense slots are all GC-side,
while flags, edges, versions, generations, shadow pointers, and world marks
are all in-plane. The prior `libs/arena-links` experiment proved the negative
case: keeping only edges in the arena while flags stayed on objects lost to
plain objects everywhere, because marking walks paid one dependent load per
step to hop between the two representations. Walk state must be one
representation, end to end.

### 7.1 Canonical plane `M`

One `Int32Array`, stride-8 records, node records and link records interleaved
in the same plane (single base register, single bump pointer, two free lists;
plane merge measured −2% deep / −8% diamond versus split planes). Ids are
pre-multiplied element offsets (`id = recordIndex * 8`); record 0 is burned
as null so "no record" is always `0` and every existence check is `!== 0`.

**Node record** (all offsets relative to `id`):

| offset | name        | meaning |
|-------:|-------------|---------|
| 0 | `FLAGS`     | kind bits + state machine bits + world mark bits (table below) |
| 1 | `DEPS`      | first link in this node's dependency list; doubles as free-list next pointer for freed node records |
| 2 | `DEPS_TAIL` | tracking cursor / last dependency link (the re-track cursor) |
| 3 | `SUBS`      | first link in this node's subscriber list |
| 4 | `SUBS_TAIL` | last subscriber link |
| 5 | `GEN`       | generation counter, bumped on free; disposers and finalizers capture it to defuse stale ids |
| 6 | `SHADOW`    | head of this node's shadow-record chain in the speculation plane; 0 when the node has no speculative state (the overwhelmingly common case). Meaningful only during an episode; swept to 0 at episode end (§10.8) |
| 7 | `PENDINGX`  | index into the GC-side pending-entry table for atoms with retained write entries, else 0 (§10.1). Meaningful only during an episode; swept at episode end |

**Link record** (same plane, same stride; a link is never confused with a
node because links are only ever reached through link-field pointers):

| offset | name       | meaning |
|-------:|------------|---------|
| 0 | `VERSION`  | tracking version stamp (which evaluation cycle last confirmed this edge) |
| 1 | `DEP`      | node id of the dependency (the thing read) |
| 2 | `SUB`      | node id of the subscriber (the reader) |
| 3 | `PREV_SUB` | previous link in the dependency's subscriber list |
| 4 | `NEXT_SUB` | next link in the dependency's subscriber list |
| 5 | `PREV_DEP` | previous link in the subscriber's dependency list |
| 6 | `NEXT_DEP` | next link in the subscriber's dependency list; doubles as free-list next for freed links |
| 7 | —          | spare |

**Flags word** (node records). Bits 0–10 are the alien-semantics machine and
kind bits, proven in `libs/arena`; bits 11–13 are this design's additions.

| bit | value | name | meaning |
|----:|------:|------|---------|
| 0 | 1    | `MUTABLE`        | can change: atoms always; computeds while they have deps |
| 1 | 2    | `WATCHING`       | is an effect/watcher wanting notification |
| 2 | 4    | `RECURSED_CHECK` | evaluation re-entrancy guard (cycle detection) |
| 3 | 8    | `RECURSED`       | inner-write recursion marker |
| 4 | 16   | `DIRTY`          | definitely stale (canonical world) |
| 5 | 32   | `PENDING`        | possibly stale, needs verification (canonical world) |
| 6 | 64   | `HAS_CHILD_EFFECT` | owns nested effects that re-runs must unlink |
| 7 | 128  | `K_SIGNAL`       | kind: atom |
| 8 | 256  | `K_COMPUTED`     | kind: computed |
| 9 | 512  | `K_EFFECT`       | kind: effect |
| 10 | 1024 | `K_SCOPE`       | kind: effect scope |
| 11 | 2048 | `K_WATCHER`     | kind: React watcher (leaf subscriber; notify calls policy, never user code) |
| 12 | 4096 | `W_PENDING`     | possibly stale *in the mark-owner world* (§10.3). A cache, not truth: valid only for the current mark owner; swept on owner switch and episode end |
| 13 | 8192 | `W_DIRTY`       | definitely stale in the mark-owner world |
| 14 | 16384 | `S_ERROR`      | last canonical evaluation threw; values slot holds the error (§12) |
| 15 | 32768 | `S_SUSPENDED`  | last canonical evaluation suspended; values slot holds the thenable (§12) |

Kind dispatch is a bit test on the same 4-byte load as the state check —
that is the point of packing kinds into the flags word. `KIND_MASK` covers
bits 7–11. World mark bits live in the same word so a pass-world read that
finds them clear (the common case for unaffected nodes) has already paid for
the load: **the canonical-read fast path and the world-read fast path load
the same single field.**

**Byte math.** One record = 8 fields × 4 bytes = 32 bytes (half a 64-byte
cache line; a record never straddles two lines when the buffer is 32-byte
aligned, which `Int32Array` over a fresh `ArrayBuffer` is). A graph of
100,000 nodes and 300,000 edges = 400,000 records = 12.8 MB of plane — off
the JS heap's object graph entirely (invisible to `heapUsed`-style metrics;
the benchmark plan reports it separately, §17.4). Default initial size:
`1 << 16` records (2 MiB), doubling by closure rebuild (§14.1);
`COSIGNAL_ARENA_INITIAL_RECORDS` overrides for benchmarks.

### 7.2 Canonical side columns

```
values: unknown[]            // 2 slots per node record: values[id >> 2]     = current/computed value
                             //                          values[(id >> 2)+1] = atom pending-write scratch OR effect cleanup fn
fns: (Function | undefined)[] // 1 slot per node record: fns[id >> 3] = computed/effect function
```

Plain arrays, grown by `push` (plain-array growth has no binding problem and
stays PACKED). One packed `unknown[]` value column — never type-segregated
(measured worse). Policy-layer per-node options (`isEqual`, `label`,
observed-lifecycle callback and refcount) live in the wrapper objects
(`Atom`/`Computed` instances) — they are touched only at boundaries, and the
wrapper object already exists as the user's handle. The kernel calls
equality through one `equalityFns` side column slot only for nodes that have
a custom `isEqual` (flag-free: slot `undefined` means `Object.is` inline).

### 7.3 Speculation plane `W`

A second, much smaller `Int32Array` plus one side column `wvalues: unknown[]`.
Bump-allocated only — **no free lists**: records are allocated during an
episode and the whole plane resets when the episode ends. This is the O(1)
abort story: discarding a world writes nothing at all; dead records are
simply never reached again, and the bump pointer rewinds only at episode end
when nothing can reference them (§10.6, §10.8).

**Shadow record** (stride 8, same pre-multiplied id convention, record 0
burned):

| offset | name      | meaning |
|-------:|-----------|---------|
| 0 | `S_NODE`   | canonical node id this shadow belongs to |
| 1 | `S_FLAGS`  | world-local status: `SV_READY` (value slot valid), `SV_DIRTY`, `SV_EVALUATING` (in-world cycle guard), `SV_ERROR`, `SV_SUSPENDED`, `SV_PRESERVED` (copy-out record: holds a canonical value preserved for a paused pass) |
| 2 | `S_WORLD`  | id of the owning world (monotonic int, never reused within an episode) |
| 3 | `S_NEXT`   | next-older shadow record for the same node (the per-node chain; the chain head is canonical `SHADOW`) |
| 4 | `S_SEQ`    | seq of the newest write entry reflected in this value (HEAD records are updated in place; this stamp orders them) |
| 5 | `S_USE`    | index into the GC-side per-world suspense slot table (0 = none) (§12.3) |
| 6 | —          | spare |
| 7 | —          | spare |

Value: `wvalues[sid >> 3]` (one slot per record). Default plane size:
`1 << 12` records (128 KiB), doubling by the same closure-rebuild mechanism;
speculation volume is bounded by (write-set sizes + evaluated-in-world
computeds + copy-outs) per episode, which for real transitions is tens to
hundreds of records.

**Why chains, not a hash map.** A world read must answer "does node N have
speculative state in world V?" The canonical record's `SHADOW` field plus a
short chain walk answers it with loads that stay adjacent to the flags load
already performed; an open-addressed map would be a second data structure
with its own growth story, and the chain length is bounded by the number of
live worlds that touched the node (in practice 1–2: HEAD plus at most one
bespoke pass world; preservation records add one per paused pass, and live
passes are bounded by the number of React roots).

### 7.4 GC-side bookkeeping (policy structures, boundary-touched)

All plain JavaScript, allocated only during episodes, dropped at episode end:

```
type PendingEntry = {
  seq: number                    // global write ticket
  batch: number                  // local batch index (1..31)
  kind: 'set' | 'fn'
  value: unknown                 // for 'set'
  fn: ((prev: unknown) => unknown) | undefined  // for 'fn' (update/dispatch closures)
  next: PendingEntry | undefined // older entry for the same atom
}
pendingTable: (PendingEntry | undefined)[]   // indexed by canonical PENDINGX
baseValues: unknown[]                        // parallel: replay base per pending atom

type LiveBatch = {
  token: number            // React fork token
  deferred: boolean
  writes: number[]         // canonical node ids written, in first-write order
  retired: boolean
}
batchByToken: Map<number, number>   // token -> local index
batches: (LiveBatch | undefined)[]  // 1..31; index freed on retire

type World = {
  id: number               // monotonic within episode; 0 = canonical, 1 = HEAD
  batchMask: number        // bit i set = includes batches[i]
  aliasHead: boolean       // pass world identical to HEAD (common case)
  live: boolean
  container: unknown       // root, for pass worlds
}
worlds: World[]            // live-world table, small
markedNodes: number[]      // nodes carrying mark bits for the current owner
touchedNodes: number[]     // nodes with SHADOW/PENDINGX set this episode (for the end-of-episode sweep)
```

Per the design rule, none of these are read inside `propagate`/`checkDirty`/
world-resolution inner loops; they are consulted at write time, fork time,
fold time, and sweep time only. The one exception-shaped case — "is world id
X live?" during a chain walk — is answered by a dense `Int32Array` bitmap
(`liveWorldBits`) sized to the episode's world count, not by the `worlds`
array.

### 7.5 Scratch structures

Persistent `Int32Array` stacks for `propagate` and `checkDirty` with
base-pointer save/restore (re-entrant walks push above the caller's base and
unwind to it — a computed's getter can re-enter the engine), a plain
`number[]` effect queue with index-based draining, and the world-propagation
mark stack (shared with the propagate stack; world propagation never runs
user code, so no re-entrancy interleaving between the two uses of the stack
can occur mid-walk).

---

## 8. Authoring constraints

The engine is one file with hard rules. These are measured constraints, not
style preferences; each carries its evidence.

### 8.1 Constants: same-file `const enum`, generated-literal fallback

Field offsets, flag values, and stride math must reach V8 as numeric
literals. The measured failure mode: module-scope `const` bindings are
demoted to mutable `var` by esbuild bundling (lazy-init and scope-merge
hoisting), which costs TurboFan its constant-folding of these hot numbers —
+15–21% on kairo-scale workloads through a bundled child process.

**Primary strategy: a `const enum` declared in the engine file itself.**
Same-file const-enum members are inlined as numeric literals by esbuild
(both transform and bundle modes), tsx, vitest, and tsc alike, so codegen
stops depending on how the library is packaged. Two obligations follow:

1. **Same-file discipline.** Cross-file const enums are packaging-dependent
   (esbuild transform mode — what tsx and vitest use per-file — leaves
   `C.FLAGS` as a runtime property access on an imported object; `tsc
   --isolatedModules` does the same). The enum and every hot use of it live
   in the engine file. The schema tables in §7 are documentation of that
   enum, not a separate module.
2. **Toolchain requirement (documented for consumers).** The library itself
   compiles with a real compile step (e.g. tsdown/rolldown or tsc) — it does
   not require consumers to do anything, because the *published* artifact
   already contains literals. The constraint binds only this repo's build:
   `isolatedModules`-style pure stripping of the engine source would break
   the inlining, so the build pipeline must run a whole-program transform
   for the engine package. CI asserts the property directly: a build check
   greps the published engine bundle for `C.` member accesses (there must be
   none) and spot-checks that known hot functions contain the expected
   literal offsets.

**Fallback for stripping-only consumers of the source** (kept specified in
case the toolchain constraint is ever unacceptable): a repo-owned generator
reads the schema (the same enum, in a `schema.ts` used only at build time)
and rewrites a marked region of the engine file, replacing symbolic names
with decimal literals plus name comments (`M[id + 1 /* DEPS */]`); a CI
verifier regenerates and diffs. The generated file is stripping-safe by
construction. This fallback costs authoring ergonomics, which is why it is
the fallback.

### 8.2 Bytecode budgets and the link-split rule

V8 (Node 24 defaults) refuses to inline callees above 460 bytecodes of
bytecode, greedily inlines callees at or under 27, and caps cumulative
inlined bytecode per optimized function at 920. Typed-array field access
generates roughly 2x the bytecode of a named-property load, so arena code
hits these ceilings at half the source size object code would. The proven
consequence: the monolithic edge-tracking helper (`link`) was 475 bytecodes
and never inlined into the read paths despite running on every tracked read;
splitting its rare insertion tail out (`linkInsert`) took the hot path to
168 bytecodes and measured −8% deep / −10% broad / −13% diamond.

Rules:

- Every function reachable from `read`, `computedRead`, `write`,
  `propagate`, `checkDirty`, or world resolution carries a comment stating
  its measured bytecode size (`node --print-bytecode` in the perf harness
  dumps them; the harness fails if a budgeted function exceeds its stated
  budget by more than 10%).
- Hot-path helpers keep their rare tails out-of-line (allocation slow paths,
  insertion paths, growth triggers, error throws).
- No accessor functions for plane fields. Raw `M[id + C.FIELD]` is the
  idiom; 27-bytecode accessors would inline greedily but burn cumulative
  budget that deep engine call chains need for real helpers, and accessor
  indirection has already been measured as a historical loss in this repo.

### 8.3 Dev checks are stripped by `define`, not by runtime constants

Invariant checks (record-kind assertions, chain-walk step limits, free-list
integrity) are guarded by a build-time `__DEV__` define. Measured: a hot
function guarded by literal `false` (what `--define:__DEV__=false`
produces) generates bytecode identical to the unguarded function — Ignition
folds literal-false branches at bytecode generation — while the same guard
via a module-scope `const DEV = false` generates ~10x the function's
bytecode and blows the §8.2 budgets without ever executing. Dev builds run
the full checker; prod builds contain zero trace of it.

### 8.4 Branded ids for compile-time safety, zero runtime cost

```ts
type NodeId = number & { readonly __brand: 'NodeId' }
type LinkId = number & { readonly __brand: 'LinkId' }
type ShadowId = number & { readonly __brand: 'ShadowId' }
```

Branded numbers are subtypes of `number`: indexing `M[id + C.FLAGS]` needs
zero casts and emits zero JavaScript, while passing a `LinkId` where a
`NodeId` is expected, or an un-premultiplied record index as an id, is a
compile error. The honest cost is that every load of an id-typed field into
a local needs an `as NodeId` cast — that noise is the documentation of what
the field holds. Verified locally in this repo's exact toolchain.

### 8.5 Monomorphism and type-feedback hygiene

- The engine factory is instantiated with identical object-literal shape
  every time (growth rebuilds), so `E.method` call sites stay monomorphic on
  the engine map.
- Steady and forked behavior are NOT two engine closures — mode is a scalar
  branch inside one engine (§9.4). Rationale: closure-rebuild is proven for
  *monotonic* swaps (growth: O(log n) events ever, feedback re-stabilizes
  after each), but mode oscillates per transition; a call site that has seen
  two different closure identities keeps polymorphic feedback, and V8's
  context specialization (the mechanism that embeds the buffer base as a
  compile-time constant) applies only to monomorphic closure feedback.
  Oscillating engine swaps would risk permanently de-specializing every
  handle's call site — the exact "mutable binding" cost class the growth
  research measured at +34–43%. §17.3 still schedules an A/B experiment
  (swap vs. branch) because the branch also has a cost; the branch is the
  safe default, the experiment can only upgrade it.
- One packed `unknown[]` values column keeps value loads' feedback
  homogeneous (elements feedback, not shape feedback); user-value
  polymorphism lives at the policy layer where it belongs.

---

## 9. The steady-mode kernel

Steady mode is the whole engine when no React speculation exists. It is a
faithful implementation of alien-signals v3.2.1 semantics on the §7 layout —
the exact machine that already passes 179/179 conformance cases in
`libs/arena` — so this section specifies behavior and the handful of
deliberate deltas, not a re-derivation of the algorithm.

### 9.1 Semantics contract

- **Lazy exact recomputation.** Computeds evaluate only when read while
  possibly stale; verification (`checkDirty`) recursively re-validates
  dependencies deepest-first, re-running only what a real change reaches,
  with equality cutoff at every recompute. The conformance suite's dynamic-
  graph cases check exact pull counts; over-recomputation is a test failure,
  not a perf footnote (the prior DoD spike's 20% over-recompute on dynamic
  suites is the documented cautionary tale — the full checkDirty subtlety,
  including link version stamps, the `RECURSED`/`RECURSED_CHECK` recursion
  ladder, and `isValidLink` revalidation, is load-bearing).
- **Dependency tracking with cursor reuse.** Re-evaluating a subscriber
  reuses its existing link records in order via the `DEPS_TAIL` cursor;
  unchanged dependency sequences allocate nothing. After evaluation, links
  past the cursor are pruned (`purgeDeps`) — canonical evaluation is the
  only context allowed to prune (worlds never prune; §10.4). Link removal
  preserves list order (a documented correctness constraint for nested
  effect ordering; swap-remove is forbidden).
- **Synchronous effect flush.** A top-level write that reaches watchers or
  effects flushes the queue before returning, outermost-first (parent
  effects before children — the notify path inserts a parent chain child-
  first and reverses the inserted segment in place). `startBatch`/`endBatch`
  defer the flush; reads inside a batch see fresh values.
- **Writes inside computeds** tolerated by default with cycle detection
  (propagation reaching the currently-evaluating node, or reading a node
  currently evaluating, throws a cycle error); a configure flag forbids them
  outright at write time. Effect flush is deferred during evaluation.
- **Throw-safety.** A computed getter that throws does not corrupt flags:
  the evaluation frame's `finally` restores the tracking context, clears the
  re-entrancy bit, and prunes the cursor; the error is cached as the node's
  result state (§12) rather than left as half-updated flags. (This fixes an
  upstream alien-signals hazard where a throwing getter corrupts the flag
  machine.)
- **Effect/scope disposal** returns records to the free list, deferred to
  the next operation boundary (a mid-flush dispose can never recycle a
  record the queue or an in-flight walk still references); generation
  counters defuse stale disposers.

### 9.2 Operation boundaries and growth

Public operations run engine frames; a module-level `enterDepth` counts live
frames. `enterDepth === 0` is an **operation boundary**: the only place the
engine may grow (rebuild the closure over doubled buffers and swap the one
module-level engine reference — captured buffer bases in live frames make
mid-walk swaps unsound) or sweep deferred frees (only while the effect queue
is empty, so a queued id can never be recycled under the queue). Allocators
set a `growPending` flag when the bump pointer crosses a watermark that
guarantees a slack floor (default 1280 records) at every boundary; a single
operation that out-allocates the entire remaining slack throws rather than
corrupt in-flight walks. Boundary work also hosts fold scheduling and
episode sweeps in forked mode (§10.5, §10.8).

### 9.3 What steady mode never touches

No shadow chains (SHADOW is 0 everywhere), no pending entries, no batch
table, no world table, no seq counter movement, no mark bits. The
speculation plane is not even allocated until the first episode opens. The
benchmark adapter (§17) runs the library exactly here.

### 9.4 The mode gate

One module-level counter:

```
let speculating = 0   // live batches + live worlds; 0 = steady
```

Public read/write entry points branch on it once:

- `Atom.set` in steady mode: equality short-circuit, store, propagate,
  flush. In forked mode: classify the write (§10.1) — which may still take
  the steady path if the write is urgent and the atom has no pending
  entries and no live pass could observe it.
- reads in steady mode: the plain kernel read. In forked mode: resolve the
  read context (§10.2) — which for canonical contexts is one extra
  comparison before the same plain read.

The gate is a scalar load and a well-predicted branch (speculation episodes
are rare relative to reads); the global quiet-epoch check is the cheapest
known fast-path idiom in the survey of shipping reactivity libraries, and
§17.3 gates the release on the measured steady-mode delta staying under 2%
on tier-0 shapes. (Why not zero-cost via engine swap: §8.5.)

---

## 10. Forked mode

Everything in this section happens only while `speculating !== 0`, and only
when the React runtime adapter is installed (pure-core programs cannot open
episodes: the observability gate short-circuits on "no adapter").

### 10.1 Writes: classification, entries, HEAD update, notification

Every `Atom.set` / `update` / `dispatch` resolves a **write context**, in
order:

1. **Inside a render pass?** (`unstable_getRenderContext()` non-null and the
   engine knows a pass is live) — *forbidden*. Pass evaluation is pure;
   React may replay or discard it. Throw.
2. **Inside a computed evaluation?** Steady-mode rules apply (§9.1) — the
   write executes in the writer's ambient context below.
3. **Deferred batch?** `unstable_isCurrentWriteDeferred()` — the pure,
   allocation-free classification — decides. If deferred:
   `unstable_getCurrentWriteBatch()` mints/fetches the token; the adapter
   maps it to a local batch index (allocating one of the 31 slots on first
   sight; opening an episode if the engine was quiet).
4. Otherwise the write is **urgent**.

**Deferred write path** (batch B, atom a, payload v-or-fn):

- Append a `PendingEntry{seq: nextSeq++, batch: B, ...}` to a's entry chain
  (creating the chain and stamping `PENDINGX`, recording a's `baseValue`,
  and pushing a onto `touchedNodes` on first entry). Record a in B's
  `writes` list on first write.
- Update the **HEAD world**: compute a's HEAD value by replaying its chain
  (base value, then entries in seq order — cheap: chains are short) and
  store it into a's HEAD shadow record (creating or updating in place;
  `S_SEQ` stamps the entry it reflects). If the new HEAD value equals the
  previous HEAD value under the atom's equality, stop: nothing observable
  changed in any pending world; no propagation, no notification.
- **World-propagate in HEAD**: ensure HEAD owns the mark bits (§10.3), then
  walk a's canonical subscriber links transitively — the same traversal
  shape as canonical `propagate`, same stack, but setting `W_PENDING`
  instead of `PENDING`, appending newly-marked nodes to `markedNodes`, and
  **never touching canonical state bits**. Reached watchers with
  `W_PENDING` newly set are notified.
- **Notification runs synchronously in the writer's execution context.**
  A watcher's notify calls its policy callback (a bound `setState`); because
  the call happens inside the user's `startTransition` scope, React tags the
  resulting update with the same batch — lane assignment, batching,
  async-action entanglement, and infinite-update-loop protection are all
  inherited rather than reimplemented. This is the single most important
  line in the React integration.
- Canonical flags, canonical values, and canonical `PENDING` marks are
  untouched. Committed-tree re-renders and committed effects cannot observe
  the write. **Canonical readers never see speculation.**

**Urgent write path** (no batch, or a non-deferred batch):

Urgent updates commit almost immediately, and outside-render reads must see
them at once, so urgent writes go to the canonical plane eagerly — but with
two forked-mode obligations:

- If the atom has a pending-entry chain (a deferred write raced ahead of
  this urgent one), append an entry for the urgent write too (kind and
  payload as written): the chain must contain every write in seq order so
  later folds can rebase functional updates correctly. The canonical store
  below is then the *replay of base + retired + urgent entries* — which for
  a plain `set` is just the written value, but for `update(fn)` on a chain
  with pending deferred entries is the function applied to the last
  *urgent-visible* value, not to HEAD. (This mirrors what `useState` does:
  an urgent updater never sees unfinished transition state.)
- **Copy-out before overwrite** (§10.5): if any live pass world excludes
  this urgent write and could fall through to this atom's canonical value,
  preserve the old canonical value into those worlds first.
- Then: canonical store, canonical propagate, flush, watcher notification in
  the writer's (urgent) context. Also update the atom's HEAD shadow if a
  chain exists (HEAD includes urgent writes by definition) and HEAD-mark its
  cone, so a transition pass forked later sees the urgent value composed
  with pending deferred values.

An urgent write with no pending chain, no live passes, and no episode… is
just a steady write; the classification path falls through to the steady
kernel without allocating anything. This keeps "forked mode" from taxing
apps that mount the React adapter but rarely use transitions.

**The seq counter** is global and monotonic across all atoms and batches —
one shared timeline. Folds replay per-atom chains in seq order; because
chains are appended in write order, "replay the chain oldest-first" is the
whole rebasing rule.

### 10.2 Reads: context resolution

Every public read resolves to a world:

| caller context | world | how detected |
|---|---|---|
| inside a live render pass | that pass's world | engine pass bookkeeping (set at `onRenderPassStart`, cleared at `onRenderPassEnd`); `unstable_getRenderContext()` cross-checks in dev builds |
| outside render, episode live | HEAD | default in forked mode |
| committed effects (`useSignalEffect` bodies, fold-notified core effects) | canonical | the effect scheduler sets a "canonical context" flag while draining (§13.4) |
| steady mode | (the one world) | `speculating === 0` |

The read paths:

**Canonical-context read** (committed effects during an episode): the plain
kernel read. Shadow chains and mark bits are simply not consulted. Zero
added cost beyond the mode gate.

**World read of an atom** (world V, atom a):
1. Load `FLAGS`; load `SHADOW` (same record, adjacent field).
2. If `SHADOW === 0`: **unaffected** — plain canonical value read. Note
   that no dependency tracking happens in any world read: subscription
   inside components is explicit (watcher nodes created in layout effects,
   §13.1), and in-world computed evaluation never links (§10.4). Tracked
   reads exist only in canonical/steady evaluation contexts.
3. Else walk the chain for the best match: a record with `S_WORLD === V.id`;
   or, if V aliases HEAD, `S_WORLD === HEAD_ID`; or an `SV_PRESERVED` record
   targeted at V. Chain misses fall through to canonical. Dead-world records
   (their `S_WORLD` bit clear in `liveWorldBits`) are unlinked from the
   chain opportunistically during the walk.

**World read of a computed** (world V, computed c):
1. `FLAGS`/`SHADOW` as above; if no chain entry and no valid mark for V →
   **unaffected** → canonical read (which may run canonical checkDirty —
   canonical staleness is canonical business; V doesn't care why canonical
   is fresh, only that it is canonical).
2. Chain entry with `SV_READY` for V → return its `wvalues` slot (rethrow /
   suspend per `SV_ERROR`/`SV_SUSPENDED`; §12).
3. Marked `W_PENDING` for V (or chain entry dirty) → **world verification**
   (§10.4), which either confirms "unaffected after all" (clear the mark for
   V, fall through to canonical) or evaluates c in-world and caches a shadow
   record.

The fast paths are deliberately aligned: for the dominant read population
(nodes untouched by the transition), a pass-world read costs the canonical
read plus one already-loaded-field test (`SHADOW === 0` sits in the same
32-byte record as `FLAGS`). This is the "delta lookup must not tax canonical
reads" requirement, discharged by layout instead of by cleverness.

### 10.3 Worlds: fork, alias, mark ownership

**World creation at `onRenderPassStart(container, includedBatches)`:**

1. Translate tokens to local batch indices; ignore unknown tokens
   (React-state-only batches); compute `batchMask`.
2. If `batchMask` equals the mask of *all* live engine batches — the common
   case: one transition in flight, its own render pass — the pass world
   **aliases HEAD**: `{aliasHead: true}`, no records created, no marks
   moved. Cost: a table write. **O(1).**
3. If `batchMask` is empty (urgent pass, no deferred batches included): the
   pass world **is canonical**: reads use the canonical context. Cost: a
   table write. **O(1).**
4. Otherwise (bespoke subset — interleaved transitions, multi-root
   partial-commit lock-in): allocate a world id, and **materialize atom
   shadows eagerly**: for each batch in the mask, for each atom in its
   `writes` list, replay the atom's chain *filtered to entries whose batch
   is in the mask* (in seq order, from the base value) and store the result
   in a shadow record for this world. Cost: proportional to the included
   write-sets — tens of records for real transitions. Computeds are not
   materialized; they are marked lazily via mark ownership below.

**Mark ownership.** The `W_PENDING`/`W_DIRTY` bits in canonical flags words
belong to exactly one world at a time — the **mark owner** — because only
one render pass executes at any instant (§6.5) and HEAD is only read
outside passes. A module-level `markOwner` names it. Switching owner (a
pass starts while HEAD owns marks; HEAD needs marks back after a pass ends;
a paused pass resumes after another root's pass ran):

1. Clear the outgoing owner's marks: walk `markedNodes`, clear the two bits,
   truncate the list. Cost proportional to the outgoing cone.
2. Propagate the incoming world's marks: for each atom in its included
   write-sets (for HEAD: all atoms with pending chains), walk canonical
   subscriber links setting `W_PENDING`, filling `markedNodes`.

Owner switches happen at pass boundaries and at the first outside-render
read/write after a pass — a handful of times per transition, each costing
one write-cone walk (the same cost class as one propagation). They do not
happen per read. A pass world that aliases HEAD *shares* HEAD's marks —
no switch needed in the common case, because the included batches are
identical by definition of aliasing.

Marks are a cache with single-owner validity, never ground truth: world
verification (§10.4) re-derives staleness from chains + canonical topology
whenever marks are absent, so a lost mark can cause a wasted verification
walk, never a wrong value. (Dev builds cross-check by re-deriving.)

**Why this is sound with interleaved roots**: pass A pauses (owner: A's
world), pass B starts on another root (owner switches to B: A's marks are
cleared but A's *shadow records and chains* — the truth — survive), B ends,
A resumes (owner switches back to A: A's marks are re-propagated from the
same frozen write-sets that produced them the first time — write-sets of
included batches cannot change while the pass lives, because a new write to
an included batch schedules React work that *restarts* the pass; §6.4).
Re-propagation is deterministic replay of a pure marking function over
unchanged inputs.

### 10.4 World verification and evaluation

Worlds never mutate canonical topology. In-world evaluation does not link,
does not move `DEPS_TAIL`, does not purge — the canonical dependency lists
are read-only inputs. This has three consequences that make the whole
design tractable:

1. **No merge problem for edges.** Commit never reconciles two link lists;
   there is only ever one.
2. **No world dep-tracking needed for invalidation.** Within one world,
   included write-sets are frozen (§10.3), so a shadow value computed once
   is valid for the world's whole life: nothing to invalidate. (HEAD is the
   exception — new writes arrive — and it invalidates by re-marking from
   the written atom, §10.1; its shadow records update in place.)
3. **Marking through canonical topology reaches every affected node.** If a
   computed would produce a different value in world V, then something it
   reads differs in V; for its *first* point of divergence, the different
   input is visible through its canonical dependency list (a node's dep
   set only diverges after its inputs diverge — divergence cannot begin at
   a node whose canonical inputs are all unaffected). Induction from the
   written atoms: the canonical-subscriber cone of the write-set contains
   every node whose in-world value can differ. Marking that cone
   (fork/owner-switch) therefore over-approximates, never misses. This is
   the same soundness argument alien-style push-pull already relies on,
   applied to a hypothetical world.

**World verification** (computed c marked `W_PENDING` in world V) — the
in-world analogue of checkDirty:

- Walk c's canonical dependency links. For each dep d:
  - resolve d **in V** (recursive world read: shadow hit, or recurse if d is
    itself marked, or canonical value if unaffected);
  - compare d's in-V value with d's canonical value (the value c's canonical
    cache was computed from). Custom equality applies.
- Any difference → **evaluate c in V**: run c's function with the world
  read context (reads resolve in V; tracking disabled; writes rejected;
  `SV_EVALUATING` on c's shadow record guards in-world cycles), store the
  result in a shadow record for V (with equality cutoff against c's
  canonical value: an equal result stores a *clean* shadow marking "verified
  unaffected", so nodes above c stop re-verifying through it).
- No difference → clear c's `W_PENDING` (owner-local), fall through to
  canonical.

Subtlety: "the value c's canonical cache was computed from" — canonical
lazily recomputes too. World verification first ensures d's *canonical*
read is fresh (running canonical checkDirty/update as needed — legal: that
is ordinary canonical work triggered from a world context, and copy-out
protects other paused worlds if values get overwritten, §10.5), then
compares in-V versus canonical. Both sides of the comparison are then
well-defined current values.

Cost model: verification touches only the marked cone (bounded by the
write-set's canonical subscriber cone), and each evaluated computed pays one
shadow record + one evaluation — the same work a committed write would
eventually pay, done early for exactly the nodes the speculative UI actually
reads. Unread marked nodes cost two flag bits and one `markedNodes` slot.

### 10.5 Commit: retirement, fold, copy-out

`onBatchRetired(token, committed)`:

**committed = false** (the batch never produced React work): drop its
entries from every chain it wrote (splice by batch index), recompute those
atoms' HEAD shadows, release the batch slot. If chains empty, clear
`PENDINGX`. No canonical change, no notification. (Writes that never touch
React and never commit are speculative state that never happened — the
validated fork guarantees this retirement only occurs for batches with no
React updates anywhere.)

**committed = true**: fold each atom in the batch's `writes` list:

1. Compute the new canonical value: replay from `baseValue` the atom's
   entries that are now **retired** (their batch has retired committed) plus
   **pending urgent** entries, in seq order. Functional entries apply to the
   value accumulated so far — this is the React rebasing rule, verbatim:
   an older transition folding after a newer urgent write replays *under*
   it, never wiping it out (worked example in §10.7).
2. Equality-check against the current canonical value. Unchanged → done
   (prune fully-retired entries; keep the chain if other batches remain).
3. Changed → **copy-out**, then store: for every *live* pass world whose
   `batchMask` excludes this batch (a paused pass that must keep rendering
   the old world), write an `SV_PRESERVED` shadow record for this atom
   carrying the old canonical value into that world's view (chain-linked
   like any shadow). Then store the new value canonically, propagate
   canonically, queue reached effects and notify reached watchers (in the
   retirement's execution context — commit-time notifications are urgent).
4. Prune retired entries; when an atom's chain empties, clear `PENDINGX`
   and its base value; when the batch slot's last atom is pruned, free the
   batch index and decrement `speculating`.

**Copy-out for computeds** is lazy and lives at the two overwrite sites.
Fold-time propagation marks canonical computeds `PENDING`; their canonical
values die later, one at a time, inside `updateComputed`/`updateSignal`
when a canonical recompute overwrites the cached value. Those two functions
— in forked mode, when live non-including passes exist — first preserve the
old value into an `SV_PRESERVED` record per such pass. So the price of
protecting paused passes is proportional to *values actually overwritten
while a pass is paused*, not to cone sizes. A resumed pass finds preserved
values through the ordinary chain walk; its own marks are unaffected
(preservation records are not marks; they are values).

Why paused passes need this at all: a pass world's reads fall through to
canonical for unaffected nodes (§10.2). "Unaffected by my batches" was
decided against canonical-at-fork-time; if canonical moves mid-pass (this
fold), fall-through reads would tear. Copy-out pins the fall-through target
for exactly the values that moved. Together: reads in a pass observe the
canonical plane *as of pass start* composed with included write-sets — the
same guarantee cosignal-v2 got from seq pins and retirement stamps, paid at
fold time instead of on every read. Passes are short and folds-during-pause
are rare; the amortized cost rounds to zero, and the read path stays flat.

**Effects on fold**: watchers notified by fold propagation produce ordinary
urgent re-renders (the committed tree catches up); signal effects queue and
drain in a microtask against the canonical context (§13.4), which is what
"effects observe committed worlds only" means operationally.

**Multi-root lock-in** needs no engine feature: a root that committed the
batch early keeps *including* it in later passes (§6.4), so those passes'
worlds contain the batch's writes; other roots' passes exclude it and read
old canonical protected by chains that only prune at full retirement.

### 10.6 Abort

A discarded pass fires `onRenderPassEnd` like any other: clear the pass's
world-table entry and `liveWorldBits` bit, decrement `speculating`. Nothing
else. Its shadow records sit unreachable in the speculation plane (chain
walks skip-and-unlink them lazily); its marks, if it owned them, are cleared
on the next owner switch (or by the episode sweep). **O(1) in the strict
sense: constant work at abort time**, with the deferred cleanup folded into
walks and sweeps that were already running. A superseded transition's batch
eventually retires (committed or not) through the registry, which prunes its
entries as §10.5.

### 10.7 Rebasing walkthroughs (the contract, worked)

The two canonical interleavings, matching React's own update-queue behavior
bit for bit. Setup: atom `x` with canonical value 1.

**Plain sets.** Transition T writes `x.set(2)`; while T is pending, an
urgent handler writes `x.set(5)`.

- Chain: `{seq1, T, set 2} → {seq2, urgent, set 5}`, base 1. Urgent path
  stores 5 canonically at write time (entry retained), notifies urgently.
- Urgent render pass: includes no deferred batches → canonical world → sees
  5. Screen shows the urgent change; transition still invisible. React
  commits; the urgent batch retires; its entry is marked retired.
- Transition pass (restarted after the urgent commit): world = HEAD-alias;
  x's HEAD shadow replays base 1 → set 2 (seq1) → set 5 (seq2) = **5**.
  The transition lands on top of the urgent change, never wiping it out.
- T retires committed: fold replays retired entries in seq order → 5.
  Equality: canonical already 5 → no-op fold. Chain empties.

(Had the writes been to *different* atoms, the transition pass would show
its own atom's 2 and the urgent atom's committed 5 — each read resolves
independently; same rule.)

**Functional updates.** Canonical `x = 1`; transition T does
`x.update(v => v + 1)`; urgent handler then does `x.update(v => v * 2)`.

- Chain: `{seq1, T, fn +1} → {seq2, urgent, fn *2}`, base 1.
- Urgent write replays for the *urgent-visible* world: base 1, skip seq1
  (deferred, not retired), apply *2 → canonical becomes **2**. The doubling
  applied to committed state, exactly like a `useState` urgent updater
  skipping queued transition updaters.
- Transition pass world: HEAD replay: 1 → +1 = 2 → *2 = **4**.
- T retires committed: fold replays base 1 → +1 (seq1) → *2 (seq2) = **4**.
  Canonical 2 → 4, propagate, effects fire once with 4. Two queued
  `useState` updaters produce exactly this.

**Entangled async actions**: T's scope returns a promise; the registry parks
T (§6.4). Nothing special happens in the engine — T's entries simply stay
pending longer; post-await writes inside the action join the same token
(React entangles them); HEAD and pass worlds keep composing them; one
retirement at action end folds everything in order. The engine has no
concept of "async action" — that is the point of the token protocol.

**Batch merge** (lane reuse while pending): the registry hands out the same
token (§6.2); the engine sees more entries under a batch index it already
has. Merge is the absence of a feature.

### 10.8 Episode end

At any operation boundary where `speculating === 0` (no live batches, no
live passes): walk `touchedNodes`, clearing `SHADOW`, `PENDINGX`, and mark
bits; drop the GC bookkeeping (chains, batch table, world table,
`markedNodes`); reset the speculation plane's bump pointer; return to
steady mode. Cost proportional to nodes touched during the episode — the
same order as the work the episode already did. There is no state carried
between episodes; a fresh episode starts from zeros. (If an episode's
speculation plane grew, the enlarged buffer is kept — growth is monotonic
and episodes reuse it.)

A long-lived episode (a transition held open for many seconds while passes
restart repeatedly) accumulates dead shadow records, since the plane only
resets at episode end. Quiet boundaries *within* an episode (no live passes)
may run a compaction: rebuild live chains (HEAD records + preserved records
of live worlds) into a fresh region via the closure-rebuild primitive —
the same mechanism as growth, reusing its safety argument (only at
`enterDepth === 0`, no live pass frames). This is the one place the
closure-swap trick serves worlds directly; it is an optimization with a
trigger threshold (plane half-full), not a correctness requirement.

---

## 11. The kernel/policy cut

The engine (kernel) owns mechanism and reports facts; wrappers own policy.
The dividing test: **the kernel never contains a branch named after a React
or product concept** — no "transition", no "suspense", no "reducer" inside
the engine file. Concurrent features land as wrapper policy plus, at most,
new kernel *facts*.

### 11.1 Kernel surface (mechanism)

```ts
type Engine = {
  // allocation & lifecycle
  newNode(kindFlags: number): NodeId
  gen(id: NodeId): number
  dispose(id: NodeId): void
  // canonical graph
  read(id: NodeId): unknown                      // tracked, mode-gated
  write(id: NodeId, v: unknown): boolean         // steady path; returns "changed & had subscribers"
  computedRead(id: NodeId): unknown
  runEffect(id: NodeId): void
  flush(): void
  // forked-mode facts & operations (called only by the runtime adapter)
  appendEntry(id: NodeId, batch: number, kind: number, payload: unknown, seq: number): void
  refreshHead(id: NodeId): boolean               // replay chain into HEAD shadow; returns "HEAD changed"
  markWorld(worldId: number, atoms: number[]): void   // owner-switch propagation
  forkWorld(desc: WorldDesc): number
  endWorld(worldId: number): void
  foldAtom(id: NodeId, retiredMask: number): boolean  // replay + copy-out + store; returns "canonical changed"
  sweepEpisode(): void
  // registration of policy callbacks
  setNotifyWatcher(fn: (watcherId: NodeId) => void): void
  setEqualityFor(id: NodeId, eq: ((a: unknown, b: unknown) => boolean) | undefined): void
}
```

The engine decides *what is dirty and what a value is*; it never decides
*whether work should happen now*. `write` returns a fact; the wrapper
decides to flush. `foldAtom` returns a fact; the adapter decides which
watchers' roots to poke. Replay itself is kernel (it manipulates chains and
plane state under bytecode budgets); *when* to fold is policy (driven by
patch events the kernel never sees).

### 11.2 Policy layers

1. **Class wrappers** (`Atom`, `Computed`, `ReducerAtom`): handle identity
   (the object users hold), option storage, equality registration,
   label/tracing identity, observed-lifecycle refcounting and microtask
   delivery, FinalizationRegistry reclamation (§14.2).
2. **Runtime adapter** (React bindings' engine-facing half): subscribes to
   the patch, owns the token-to-index map and batch/world tables, sequences
   fork/fold/sweep calls, classifies writes (the observability gate), owns
   the watcher notification callback, and schedules the two effect queues.
3. **Hooks** (§13): pure consumers of the adapter.
4. **Tracing** (§15): a null-checked emitter slot the kernel calls into;
   everything else lives outside.

### 11.3 Atom versus ReducerAtom (worked policy example)

The kernel has one writable-cell record kind. `Atom.update(fn)` appends a
`kind:'fn'` entry whose payload is `fn`. `ReducerAtom.dispatch(action)`
appends a `kind:'fn'` entry whose payload is `(prev) => reducer(prev,
action)` — a closure the *wrapper* builds (one small allocation per
dispatch, on the deferred path only; the steady path applies the reducer
immediately and stores a plain value). Replay, rebasing, worlds, and folds
are entirely reducer-agnostic. The differential test against `useReducer`
(§16.3) validates the policy layer; the kernel needs no test changes when
`ReducerAtom` semantics evolve.

### 11.4 Promise-suspense placement

The kernel knows three result states (value / error / suspended) as flag
bits plus a payload slot — it must, because verification walks and world
resolution dispatch on them (capability rule). Everything else — thenable
status stamping, positional caches, React `use` rethrow, settle listeners —
is policy (§12). The kernel never calls `.then`.

---

## 12. Promises and Suspense

### 12.1 Result states

A computed's evaluation outcome is one of:

- **value** — the normal case; payload in the values column.
- **error** — the function threw; `S_ERROR` set, payload is the error.
  Reads rethrow at the read site. Errors participate in equality as
  "never equal", so downstream recomputes.
- **suspended** — the function called `ctx.use(promise)` on a pending
  promise; `S_SUSPENDED` set, payload is the *thenable*. Reads suspend at
  the read site (below).

Evaluation never throws *through the graph*: the evaluation frame catches,
stores the state, restores tracking, and returns; flags are never left
half-updated (§9.1). World evaluations store the same three states in
shadow records (`SV_ERROR`/`SV_SUSPENDED`).

### 12.2 `ctx.use(promise)` mechanics

`use` stamps React's own thenable protocol onto the promise
(`status`/`value`/`reason` fields, installed once with a `then` handler):

- fulfilled → returns the value;
- rejected → throws the reason (the computed becomes **error**);
- pending → throws a private suspension sentinel; the frame records the
  thenable and marks the computed **suspended**.

**Identity stability**: within one computed's evaluation, `use` calls are
numbered by call position; the (world, node, position) triple keys a slot
table (canonical: on the wrapper object; worlds: the `S_USE` side table)
that returns the *same* thenable across re-evaluations in the same world,
so React's replay machinery and our re-verification see stable promise
identities instead of freshly-allocated promises that would never resolve
for them. A slot is invalidated when the computed re-evaluates with
different dependencies-before-the-slot (positional caching, same policy as
the validated prior design).

### 12.3 Suspended reads by context

- **Inside a render pass** (`useSignal` of a suspended computed): the hook
  rethrows via React's `use(thenable)` — conditional `use` is legal — so
  React's Suspense handles fallback, retry, and replay. When the thenable
  settles, React re-renders; our positional cache hands back the settled
  thenable; evaluation completes normally. No engine involvement.
- **Core watchers / non-render consumers** (a core `effect` reading a
  suspended computed): the policy layer attaches one settle listener to the
  thenable; on settle it marks the computed dirty and notifies, so the
  effect re-runs and reads the settled result. The engine sees an ordinary
  invalidation.
- **World evaluation suspends**: the shadow record stores `SV_SUSPENDED` +
  thenable; the pass's `useSignal` rethrows it into React exactly as above.
  A *transition* render that suspends parks the whole batch on React's side
  (async action machinery, §6.4) — the engine just sees a long-lived batch.
  This is the mount-mid-transition suspense case the reference test suite
  covers (§16.4): because the pass world resolves reads *directly* (no
  guessing between committed and pending), the known-bug scenario in the
  React team's own userspace attempt becomes a passing test here, as it did
  in the validated prior design.

### 12.4 Atom effects and promises

Observed-lifecycle `effect(ctx)` on atoms is unrelated to Suspense (it is a
subscription lifecycle hook), but its deliveries are microtask-deferred and
its `ctx.set` writes classify like any write — including landing in a
deferred batch if the remote push happens inside a transition scope
(unusual but well-defined).

---

## 13. React bindings

All bindings ride on two primitives: **watcher nodes** (kernel) and the
**runtime adapter** (policy). No `useSyncExternalStore` anywhere.

### 13.1 `useSignal(signal)`

- One `useState(0)` version counter per hook — the re-render trigger and
  the thing that inherits React's batching/lanes/loop protection.
- The rendered value is *always read from the graph* with the current
  pass's world (§10.2). Mounts inside a transition render read the pending
  world directly: no double render, no guessing.
- Subscription: a watcher node linked as a subscriber of the signal's node,
  created in a layout effect on mount. The watcher's notify (§10.1) calls
  `setVersion(v => v + 1)` synchronously in the writer's context.
- **Race fixup** in the same layout effect (covers writes landing between
  render and subscription): compare the rendered value against the current
  canonical value (mismatch → immediate `setVersion`, pre-paint correction)
  and against HEAD (mismatch → `setVersion` inside `startTransition`, so
  the correction joins the pending batch). Needed only in race windows, not
  on every mount.
- Suspended computed → rethrow via `use` (§12.3).
- Unmount: unlink the watcher; observed-refcounts (atom `effect` option)
  decrement on the microtask.

### 13.2 Notification and equality

Watchers are notified only when their subscribed node's output *changes in
the notifying world* (equality cutoff runs before notification in both the
HEAD-update path and the fold path). A write that produces an equal value
in the writer's world costs subscribers nothing — no `setState`, no render.
Because notifications are plain `setState` calls in the writer's context,
every React protection applies: `throwIfInfiniteUpdateLoopDetected` on
broadcasts, nested-update limits at commit, render-phase re-render limits.
Pure signal-to-signal effect cycles that never touch React are bounded by
the core's own re-entrancy guard (§9.1).

### 13.3 `useAtom` / `useReducerAtom` / `useComputed`

- `useAtom(options)`: a stable `Atom` held in a `useRef`-equivalent slot;
  disposal via the wrapper's FinalizationRegistry (component unmount drops
  the last reference) plus eager release on unmount effect cleanup.
- `useComputed(fn, deps, options?)`: a component-local `Computed` held by
  `useMemo`, recreated when `deps` change (compared like `useMemo`); `fn`
  closes over props/state freely — that is what `deps` is for; signal reads
  inside `fn` are auto-tracked. Subscription/read exactly as `useSignal` on
  the local node. The evaluation happens during render, therefore in the
  pass world, therefore tracked as a world evaluation when speculation is
  visible — closures over fresh props compose correctly with speculative
  signal values because the world only shadows *signal* state.
- `useReducerAtom(options)`: `useAtom` shape over `ReducerAtom`.

### 13.4 `useSignalEffect(fn, deps)` and effect scheduling

Two queues, one contract:

- React pathway: deps change → run after commit (passive effect), cleanup
  first — plain `useEffect` mechanics.
- Signal pathway: the effect's watcher participates in **canonical**
  propagation only (fold-time and urgent-write-time). Queued effects drain
  in a microtask with the canonical read context pinned (§10.2), so effect
  bodies observe committed values only — matching `useEffect`'s "after
  commit" meaning. Deferred writes never run signal effects early; the fold
  runs them exactly once per committed change (equality-cut).

Core-mode `effect()` (§5.4) keeps its synchronous flush; the two schedulers
are separate policy objects over the same kernel queue facts.

### 13.5 SSR and hydration

Server rendering reads canonical values with no subscriptions and no atom
`effect` mounting (watchers are created in layout effects, which do not run
on the server). Hydration renders from the same canonical values; the
documented recipe serializes atom state on the server and initializes atoms
before `hydrateRoot`, with a helper for the wiring. No snapshot API is
needed — reads are plain reads. RSC/Flight is explicitly out of scope for
v1.

### 13.6 Multiple roots

Every patch event carries the root's container; pass worlds are per-root by
construction; the batch registry's per-root commit lock-in (§6.4) is
consumed, not reimplemented. Two roots rendering the same batch, one root
committing early, and unmount-pruned roots are all §16 scenarios. One
process-wide engine serves all roots (worlds are cheap; roots share the
canonical graph).

---

## 14. Growth and reclamation

### 14.1 Growth (both planes): closure rebuild

Buffers are captured as `const` bindings in the engine factory's closure;
TurboFan embeds their base addresses like compile-time constants. Growth
therefore never mutates a binding: at an operation boundary (`enterDepth
=== 0`), the factory re-runs over doubled buffers (`.set` copy), producing
a new engine whose methods close over the new buffers, and the one
module-level engine reference is swapped. Scalar state (bump pointers, free
lists, counters) lives at module level and survives the swap; ids are
buffer offsets and remain valid. Live-but-paused render passes hold only
ids and module-level bookkeeping — never buffer references — so growth
between passes' slices is safe. A single operation that exhausts the
remaining slack throws (watermarks keep at least the slack floor free at
every boundary; the flush loop performs boundary work before, not during,
draining). Rejected growth designs, measured, not to be relitigated:
segment tables, resizable ArrayBuffers, mutable `let` bindings,
per-function const aliases.

The speculation plane grows the same way with a smaller initial size; its
bump-only allocator makes copies trivially safe (no free lists to rethread).

### 14.2 Node reclamation

- **Effects and scopes**: disposal returns records to the free list,
  deferred to the next boundary with an empty queue; `GEN` defuses stale
  disposers. (Proven mechanism.)
- **Atoms and computeds** are owned by user-held wrapper objects. The prior
  lab documented the leak and deferred the fix; this design requires it:
  each wrapper registers in a `FinalizationRegistry` keyed by `(id, gen)`;
  finalization pushes the id onto a pending-free list drained at boundaries
  (same rules as disposal: unlink deps, refuse while referenced by the
  queue, generation bump). GC latency means reclamation is eventual, not
  prompt — acceptable because an unreferenced node is unreachable for reads
  and its subscriber list is empty (nothing keeps notifying it); its record
  and links are the only cost while it waits. Dev builds expose a
  `debugLeakCheck()` that diffs live wrapper count against live records.
- **Watchers** die with their owning hook's unmount effect —
  deterministic, no registry involvement.
- **Speculation state** reclaims per episode (§10.8); nothing in the
  speculation plane survives an episode, so it needs no per-record story.

### 14.3 Memory accounting

The arena is invisible to JS-heap metrics; the tracing module exposes
`memoryReport()`: plane sizes, bump watermarks, free-list lengths, records
by kind, episode speculation high-water mark. The benchmark plan reports
retained-heap *and* arena bytes so wins are honest (§17.4) — the prior lab
measured object-core heap wins of 18–38% on link-heavy shapes alongside
the off-heap arena bytes, and that reporting discipline continues.

---

## 15. Tracing and debugging

The product goal: full causality visibility — "why did my computed re-run",
"why did my component re-render", "how many times did my effect run" — with
zero cost unless the tracing module is loaded, feeding a future devtools
timeline extension.

### 15.1 Event schema

Every event: `id` (monotonic), `time`, `cause` (the id of the event that
triggered it — write causes propagate causes notify causes render-read…),
plus a type-specific payload naming nodes by id and label. Event types:

- graph: `atom-write`, `computed-eval`, `notify`, `effect-run`,
  `render-read`, `link-added`, `link-pruned`
- concurrency: `batch-open`, `entry-append`, `head-update`, `world-fork`,
  `world-alias`, `owner-switch`, `mark-propagate`, `world-eval`,
  `world-discard`, `copy-out`, `fold`, `batch-retire`, `episode-begin`,
  `episode-end`
- suspense: `suspend`, `settle`
- memory: `grow`, `sweep`, `compact`, `reclaim`

Cause chains answer the product questions mechanically: a component
re-render's `notify` event's cause chain walks back through `world-eval` /
`fold` / `propagate` to the originating `atom-write` and its batch. Helper
`explain(eventId)` renders the chain as prose.

### 15.2 Ring buffer and sessions

`startTracing({ ringCapacity })` returns a session with a bounded ring plus
a subscription stream (for live devtools). Capacity must be a finite
non-negative integer; capacity 0 keeps the live stream without retaining
history. Sessions can be stacked (devtools plus a test recorder).

### 15.3 Graphviz module (`cosignal-arena/graphviz`)

Emits Graphviz DOT source (render with `dot -Tsvg`; DOT handles graph sizes
that break in-browser renderers). Two renderers:

- `dependencyGraphToDot(signals)`: snapshot of the live graph reachable
  from the given handles — atoms, computeds, watchers, edges; during an
  episode, per-world shadow values and mark states annotate nodes, and
  worlds render as colored overlays.
- `traceToDot(events)`: the causal graph of a trace slice, filterable by
  event type.

Layering is strict: `tracing` installs and records without loading any
visualizer; `graphviz` imports only *types* from tracing.

### 15.4 Cost discipline

One module-level `tracer` slot, `null` unless installed; every emit site is
`tracer !== null && tracer.emit(...)`. In prod builds without tracing
loaded, the cost is one null check per site (and emit sites sit off the
per-field hot loops — at operation and transition granularity, not per plane
access). Labels and ids resolve lazily at render time, not at emit time.
Dev-only invariant checkers (§8.3) reuse the same event stream when tracing
is active, so "trace + check" is one instrumented mode.

---

## 16. Testing plan

Four suites, in dependency order. Nothing ships on assertion of similarity
to prior art; every inherited behavior is re-verified against this engine.

### 16.1 Core conformance (steady mode)

- The 180-case reactive-framework-test-suite (the repo's conformance bar:
  179 applicable cases) with exact pull counts (`testPullCounts: true`),
  run against the core adapter. Also run under growth stress
  (`COSIGNAL_ARENA_INITIAL_RECORDS=2`) so every suite case crosses closure
  rebuilds.
- Kernel unit tests: laziness, cutoff, dynamic dependency swaps, repeated
  reads, cycles, write-in-computed policies (tolerate + forbid modes),
  observed-lifecycle refcounting and microtask delivery, disposal during
  flush, effect ordering (ancestors first, order-preserving unlink),
  throw-through-getter flag integrity, benchmark contract (sync flush,
  fresh mid-batch reads).

### 16.2 Forked-mode semantic equivalence

- **The whole 16.1 suite re-run inside a synthetic episode**: a test
  harness adapter that opens a batch for every write and immediately folds
  it, and one that holds all writes in a deferred batch and reads through
  HEAD. Steady and forked answers must be identical everywhere — worlds
  must be semantically invisible when they contain everything or nothing.
- **Model-checking fuzz**: a reference implementation (naive: full-graph
  snapshot per world, recompute everything from scratch) and a random
  program generator (writes, update fns, batch opens, forks with arbitrary
  batch subsets, folds, aborts, interleaved in random order with reads in
  every context). The arena engine and the naive model must agree on every
  read. This is the primary defense for the mark-owner protocol, copy-out,
  and chain pruning — the parts with the least obvious invariants.

### 16.3 React semantics

- Adopt the react-concurrent-store harness wholesale (vitest + jsdom + RTL,
  transitions held open by controlled promises, render-order logging
  asserted empty in afterEach, inline DOM snapshots for tear checks,
  listener-leak asserts, controlled thenables) and its 14-scenario suite as
  the conformance bar — including the scenario that is a known bug there
  (sync mount mid-transition with suspending pending state), which must
  pass here.
- The §10.7 walkthroughs as tests, plus: signal + React state lockstep in
  one transition; interruption and rebase (urgent write mid-transition,
  DOM asserted at each commit); paused-pass tear protection (fold during
  an artificially held-open pass; the resumed pass must render pre-fold
  values — exercises copy-out on both atoms and lazily-recomputed
  computeds); multi-root: shared batch across roots, one root commits
  first (lock-in), root unmounted mid-batch (pruned retirement); aborted
  transitions leave no canonical trace; `useComputed` over props + state +
  signals; `useSignalEffect` re-run matrix (deps change vs. committed
  signal change vs. both); infinite-loop rejection (a signal-write loop in
  an effect must hit React's nested-update limit, not hang); DOM mutation
  window (MutationObserver sees app mutations, not React's); hydration
  recipe.
- **ReducerAtom / useReducer differential**: identical action streams
  dispatched through both across a held-open transition with urgent
  interleaving; committed values must match at every step.

### 16.4 Patch protocol tests

The reconciler-level suite from the validated fork, ported to the integer-
token redesign: token mint-once and merge-on-lane-reuse; pending-edge
backfill (`setState` before first store write); close-edge retirement of
store-only batches; async-action parking and settle; per-root commit
lock-in and pruned roots; pass start/end bracketing across yields and
restarts; mutation-window bracketing including the View Transitions path;
listener-error isolation; inertness (no listeners → no tokens minted, no
behavior change — asserted by diffing reconciler traces).

---

## 17. Benchmark plan and performance targets

### 17.1 Methodology (repo standard)

milomg-reactivity-benchmark is primary; rank only one-framework-per-process
(cross-suite state accumulation and allocator warmup poison shared-process
numbers — the headline lesson of the prior DoD spike, where shape-level
supremacy did not transfer to suite scale until integration effects were
isolated). Conformance before numbers: no benchmark result is reported for
a build that is not 179/179. The repo's tier-0 shape harness
(`harness/bench/shapes.ts`: ~0.4s/framework, ratio-focused,
checksum-verified, GC-attributed, p99) is the iteration loop; kairo-scale
suites are the checkpoint.

### 17.2 Modes measured

1. **Steady core** (no React imports): the library must land at
   `libs/arena` parity — all tier-0 shapes at or under 1.0x alien-signals
   v3 (deep 0.90, broad 0.84–0.88, diamond 0.89, reads 0.74–0.87, create
   0.96 are the proven reference points), kairo within the current arena
   port's envelope, with GC-attribution reported (arena's zero-GC deep
   chains net out alien's cons-cell GC costs).
2. **Adapter installed, no transitions** ("mounted but quiet"): the mode
   gate's price. Gate: ≤2% regression versus steady core on tier-0.
3. **Inside a transition** (benchmark harness opens a deferred batch,
   renders through a HEAD-aliased world, folds at end): measures write
   classification, entry append, HEAD update, world reads. Targets: write
   path ≤2x steady writes at benchmark scale; unaffected reads within 10%
   of steady reads; affected reads dominated by (unavoidable) evaluation.
4. **Interleaving stress**: forked shapes with urgent writes mid-pass —
   measures copy-out and owner switching; budget: fork O(1)/alias
   confirmed by counter, owner switch cost linear in cone with constant
   factor comparable to one propagate.
5. **React harness** (from the sibling project): steady ops/s and handler
   ops/s with **zero engine allocations on the handler path** verified by
   heap profiling; re-render-on-change within noise of `useState`.

### 17.3 Experiment ledger discipline

Every attempted optimization gets a ledger entry (hypothesis, method,
best-of-N, control framework in the same run, keep/rollback); wins must
exceed the machine's demonstrated thermal drift, measured with an untouched
control per sample. Two pre-registered experiments: (E1) mode gate as
scalar branch versus engine-closure swap (§8.5 — swap wins only if steady
regression stays under the branch's and feedback stays specialized across
1,000 mode oscillations, checked with `--trace-deopt`); (E2) shadow chain
versus open-addressed side map for worlds with hundreds of shadowed nodes.

### 17.4 Memory reporting

Retained JS heap and arena bytes reported side by side (effects-10k and
grid shapes are where link-heavy layouts win: −31%/−18% retained heap in
the links-only lab with ~2.5 MB off-heap for ~40k links; the full-arena
numbers must be re-measured, not assumed). Speculation high-water mark
reported for transition benchmarks.

---

## 18. Open risks and rejected alternatives

### 18.1 Open risks, with mitigations

1. **Mode-gate cost on steady reads.** One scalar branch per public op
   could show up on read-dominated shapes. Mitigation: §17.2 gate at 2%;
   E1 fallback to closure swap if the branch measurably loses and the swap
   proves feedback-safe.
2. **Mark-owner thrashing.** Pathological alternation (outside-render reads
   interleaved with pass slices at high frequency) re-propagates marks per
   switch. Cost is bounded per switch by the write cone, but a hot loop
   could multiply it. Mitigations: HEAD-alias passes share marks (no
   switch in the common case); a switch-count trace event to detect it;
   fallback design (two mark-bit banks, owner per bank) specified but not
   built until evidence demands.
3. **Copy-out coverage** is the subtlest correctness surface (it must
   catch *every* canonical overwrite while a non-including pass lives —
   fold stores and lazy canonical recomputes are the two audited sites;
   any future overwrite site must join the audit). Mitigations: overwrite
   funneling through exactly two kernel functions, dev-build assertion
   that a live pass never reads a canonical value newer than its fork
   point (cheap: compare a per-value store-seq in dev builds only), and
   the 16.2 fuzz which hammers exactly this.
4. **Conservative fold invalidation.** Fold-time canonical propagation
   marks cones that speculative rendering already evaluated; the committed
   re-render then re-verifies. Verification is cheap (equality cutoffs at
   the shadow-confirmed values), but it is not free; if profiles show it,
   an optimization (promote a committed batch's world shadows into
   canonical caches when the fold value equals the shadow's input basis)
   is specified in a follow-up note — deliberately out of v1.
5. **31-batch ceiling.** Local batch indices assume at most 31 live
   batches, mirroring React's 31 lanes and the registry's one-slot-per-
   lane structure. If React ever changes lane counts, the index width is a
   constant in the schema; the design does not otherwise depend on 31.
6. **Long episodes.** A transition held open for minutes with heavy
   restart churn grows the speculation plane; compaction (§10.8) is
   specified but adds a rarely-exercised code path — it ships behind the
   same fuzz coverage as folds.
7. **React fork drift.** The patch is small and edge-triggered, but each
   React upstream rebase must re-validate §16.4. The token protocol was
   already once trimmed to survive an upstream refactor in the prior
   project (renderLanes removed from the surface); the integer-token
   redesign further shrinks the contract.
8. **FinalizationRegistry latency** delays record reclamation for
   handle-owned nodes; a pathological create-and-drop loop can grow the
   plane before finalizers run. Mitigation: growth absorbs it; a dev-mode
   counter surfaces it; explicit `dispose()` on wrappers for hot-churn
   call sites (documented escape hatch).

### 18.2 Rejected alternatives (with reasons)

- **Copy-on-write canonical plane per pass** (fork = COW the whole arena):
  no page-mapping tricks exist in JS; copying megabytes per render pass
  violates the pass-start budget by orders of magnitude. Rejected on
  arithmetic.
- **Per-batch persistent worlds** (worlds live as long as batches, passes
  reuse them): saves re-evaluation across restarted passes, but demands
  world invalidation on interleaved urgent writes (per-world dependency
  tracking — per-world link lists in the plane), which reintroduces the
  edge-merge problem that read-only topology eliminates. The savings are
  bounded (React re-renders restarted passes anyway); the complexity is
  not. Per-pass worlds + frozen write-sets won.
- **Log-overlay reads** (per-read rule evaluation over a write log — the
  Variant A architecture): proven semantics, but pays rule evaluation and
  log scanning on hot reads *during* speculation and needs read-time
  history retention (pins). Forked Worlds spends that cost once at fork
  time; the read path stays a table hit. The two variants share the §16
  contract; this one bets on materialization.
- **Two engine closures for mode dispatch**: §8.5. Branch first, measure,
  upgrade only on evidence.
- **Per-world link lists / world-local topology**: the merge problem, plus
  doubled link memory, plus a second linking budget per evaluation.
  Read-only topology with over-approximating marks is strictly simpler
  and its waste is bounded by equality cutoffs.
- **Type-segregated value columns, naive SoA field splitting, `& MASK`
  bounds-check elision, object pooling of links, WASM core**: all
  measured dead ends in this repo or its sources; carried as
  anti-frontiers so nobody relitigates them.
- **`useSyncExternalStore` fallback mode**: defeats the entire point;
  the library refuses to degrade silently (if the patch is absent, the
  React bindings throw at install with instructions).

---

## 19. Appendix

### 19.1 Field tables, one screen

```
CANONICAL node (stride 8 = 32 B)      CANONICAL link (stride 8 = 32 B)
 0 FLAGS  kind|state|marks             0 VERSION
 1 DEPS   → link (free-next)           1 DEP    → node
 2 DEPS_TAIL → link                    2 SUB    → node
 3 SUBS   → link                       3 PREV_SUB → link
 4 SUBS_TAIL → link                    4 NEXT_SUB → link
 5 GEN    counter                      5 PREV_DEP → link
 6 SHADOW → shadow record              6 NEXT_DEP → link (free-next)
 7 PENDINGX → pending table            7 (spare)

SHADOW record (stride 8 = 32 B)       FLAGS bits
 0 S_NODE  → node                      1 MUTABLE      128 K_SIGNAL
 1 S_FLAGS SV_* states                 2 WATCHING     256 K_COMPUTED
 2 S_WORLD world id                    4 RECURSED_CHECK 512 K_EFFECT
 3 S_NEXT  → older shadow              8 RECURSED    1024 K_SCOPE
 4 S_SEQ   newest entry seq           16 DIRTY       2048 K_WATCHER
 5 S_USE   suspense slots             32 PENDING     4096 W_PENDING
 6 (spare)                            64 HAS_CHILD_EFFECT 8192 W_DIRTY
 7 (spare)                            16384 S_ERROR  32768 S_SUSPENDED

side columns:  values[id>>2], values[(id>>2)+1], fns[id>>3], wvalues[sid>>3]
```

### 19.2 Byte math worked examples

- **Steady app**, 20k nodes + 60k links = 80k records = 2.56 MB plane
  (fits the default 2 MiB plane after one doubling), plus packed side
  columns (~2 slots × 20k values + 20k fns ≈ 320 KB of array backing +
  the user values themselves, GC-owned).
- **One transition** writing 5 atoms with a 400-node subscriber cone, pass
  reads evaluating 60 affected computeds: write-set 5 entries (GC), HEAD
  shadows 5 + evaluated shadows 60 = 65 shadow records = 2,080 B of
  speculation plane; marks: 400 flag-bit sets + a 400-entry
  `markedNodes`. Fork cost with HEAD alias: one table write. Episode sweep:
  405 field clears.
- **Worst-case interleave**: fold of 5 atoms during one paused pass →
  5 `SV_PRESERVED` records (160 B) + lazy computed copy-outs only for
  computeds the canonical side actually recomputes while the pass lives.

### 19.3 Reading order for implementers

1. §7 + §8 (layout and rules) with `libs/arena/src/index.ts` open — the
   steady kernel is a port target, not a rewrite.
2. §10.1–10.2 (writes and reads) — the semantics core.
3. §10.3–10.5 (worlds and folds) against the §16.2 fuzz harness built
   first.
4. §6 patch redesign against the fork's existing test suite (§16.4).
5. §13 bindings against the react-concurrent-store harness.

Build order note: the fuzz model (§16.2) is deliberately cheap to write
(snapshot-everything reference) and should exist before the mark-owner and
copy-out code, not after.
