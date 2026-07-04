# cosignal-arena (Variant D): Minimal Kernel, Maximal Policy

Design spec for **cosignal**, a from-scratch signals library for React with
first-class concurrent-rendering support, built on a data-oriented
(`Int32Array` record) core. This variant takes the policy/mechanism split to
its extreme: the packed, JIT-friendly kernel is the *smallest possible*
synchronous dependency-graph engine, and **everything else** — concurrency,
transitions, suspense, promises, equality, labels, tracing — lives in an
ordinary-JavaScript policy tier above it, speaking to the kernel through a
narrow integer protocol.

Status: COMPLETE DRAFT. Self-contained: no prior knowledge of cosignal, the
sibling research repos, or React internals is assumed; every concept is
defined in plain English where it first appears.

---

## Table of contents

1. [Overview: what we are building and the three bets](#1-overview)
2. [Vocabulary: every concept in plain English](#2-vocabulary)
3. [Requirements](#3-requirements)
4. [Architecture: minimal kernel, maximal policy](#4-architecture)
5. [Public API](#5-public-api)
6. [The kernel](#6-the-kernel)
   - 6.1 What a kernel instance is
   - 6.2 Data layout: field tables and byte math
   - 6.3 The kernel protocol: exact signatures
   - 6.4 Algorithms, in plain English
   - 6.5 Constants without `const enum`: the schema compiler
   - 6.6 Growth and reclamation
   - 6.7 Kernel stamping: one kernel per world, and the traced stamp
   - 6.8 Kernel invariants
7. [The policy tier](#7-the-policy-tier)
   - 7.1 The policy node table and handles
   - 7.2 Values, equality, and the `refresh` callback
   - 7.3 Worlds: committed base, head, and pass views
   - 7.4 The write log and the read rule
   - 7.5 Batches, retirement, and rebasing
   - 7.6 Shadowing: how the head world gets its graph
   - 7.7 Promises and suspense (`ctx.use`)
   - 7.8 Atom observed-lifecycle effects
   - 7.9 Core effects and scheduling
   - 7.10 Writes inside computeds, cycles, and configuration
   - 7.11 The monomorphism discipline
8. [React integration](#8-react-integration)
   - 8.1 The React fork API (redesigned, integer tokens)
   - 8.2 The DOM mutation window
   - 8.3 `useSignal`
   - 8.4 `useAtom`, `useReducerAtom`, `useComputed`, `useSignalEffect`
   - 8.5 Transitions end to end: a worked example
   - 8.6 Infinite-loop protection, multiple roots, SSR and hydration
9. [Tracing and visualization](#9-tracing-and-visualization)
10. [Where every requirement lands (placement table)](#10-placement-table)
11. [Memory footprint and byte budgets](#11-memory-footprint)
12. [Testing plan](#12-testing-plan)
13. [Benchmark plan](#13-benchmark-plan)
14. [Performance targets and predicted costs](#14-performance-targets)
15. [Open risks and mitigations](#15-open-risks)
16. [Repository layout and build](#16-repository-layout-and-build)

---

## 1. Overview

<a name="1-overview"></a>

cosignal is a signals library: applications create little containers of state
(**atoms**), derived values that recompute automatically (**computeds**), and
reactions that re-run automatically (**effects**). React components read
signals with hooks and re-render when — and only when — the values they
actually used change.

Unlike every mainstream signals-for-React library, cosignal does **not** use
`useSyncExternalStore`. That API forces any external-store change to be
rendered synchronously and forces React to throw away concurrent renders that
race with store writes, which means store state can never ride inside a
`startTransition`. cosignal instead makes signal writes flow through React's
own update machinery (each subscribed component's `setState`, called in the
writer's execution context) and uses a small React fork API to learn which
"version of the world" each render pass wants to see. Signal state and React
state move through transitions, Suspense, and interruptions **in lockstep**,
with no tearing and no forced synchronous de-optimizations.

The variant-D architecture makes three bets:

**Bet 1 — a closed, packed kernel wins the constant factors.** The hot 20% of
any signals library is graph bookkeeping: walking dependency edges to mark
things stale, and walking them again to verify what actually needs to
recompute. We put exactly that — and nothing else — into a **kernel**: a
self-contained engine whose entire state is one `Int32Array` of fixed-size
records. Nodes and edges are integers. The kernel has no values, no equality
functions, no promises, no labels, no React concepts. Prior measured work
(see §4.3) shows this layout beats the fastest object-graph implementation
(alien-signals v3) on every tier-0 shape benchmark when the kernel is kept
monomorphic — and loses those wins the moment varied user-level policy leaks
into its compiled code.

**Bet 2 — everything above the kernel is policy, and policy cannot pollute
the kernel.** Concurrency (multiple in-flight "worlds" of values), rebasing,
suspense, custom equality, atom lifecycle callbacks, tracing — all of it
lives in a plain-JavaScript policy tier. The kernel calls policy through
exactly four callbacks registered once per kernel instance, and policy calls
the kernel through ~20 integer-only functions. Because the kernel's compiled
code only ever sees `Int32Array` loads and one callback target, the JIT's
type feedback for the kernel stays monomorphic *no matter what* users do
above it. Policy variety is quarantined by construction, not by discipline.

**Bet 3 — concurrency is cheapest as two kernels, not one clever one.** A
concurrent React app needs at most three simultaneous views of signal state
(§7.3): the committed **base** world, the optimistic **head** world while a
transition is pending, and rare per-render-pass views. Rather than teaching
one kernel about versions or lanes, we run **two kernel instances** — one
tracking staleness in the base world, one (lazily populated, bulk-reset
between transitions) tracking staleness in the head world — and resolve the
rare pass views entirely in policy with a per-atom write log. Each kernel
stays tiny, closed, and identical; the "multi-version store" is a policy
data structure, not a kernel feature.

The React fork API is redesigned in this variant around **integer tokens**
(§8.1): batches and roots cross the React↔userspace boundary as plain
numbers minted from a monotonic counter, never recycled, with the batch
class (urgent vs. deferred) encoded in the low bit. No Fiber objects, no
lane bitmasks, and no allocations cross the boundary on the hot path.

---

## 2. Vocabulary

<a name="2-vocabulary"></a>

Plain-English definitions for every term this spec relies on. Read this once;
everything later leans on it.

**Signal.** An observable container of state. Reading it inside a tracked
computation records "this computation depends on that container." Writing it
eventually causes dependents to update. In cosignal's public API the writable
signal is called an **Atom** and the derived signal a **Computed**.

**Atom.** A writable signal: `atom.state` reads it, `atom.set(v)` /
`atom.update(fn)` write it. A **ReducerAtom** is an atom whose writes are
actions folded in by a reducer function, like React's `useReducer`.

**Computed.** A derived signal defined by a function. It caches its result,
recomputes lazily (only when read), and only when some dependency actually
changed. Its dependencies are discovered automatically by running the
function and watching what it reads.

**Effect.** A function that re-runs when signals it reads change. React
components get `useSignalEffect`; non-React code gets a core `effect()`.

**Dependency graph.** The bookkeeping structure connecting signals: every
"X read Y" becomes an edge from dependency Y to subscriber X. Signals
libraries are, at bottom, engines for maintaining this graph and walking it.

**Push-pull.** The two-phase update strategy this design uses (inherited from
alien-signals, the fastest published TypeScript implementation). When a
signal is written, the engine cheaply **pushes** a "possibly stale" mark
along edges to subscribers. Nothing recomputes yet. When someone later
**pulls** (reads) a possibly-stale node, the engine verifies, bottom-up,
whether anything that node depends on *actually* changed (using equality
checks as cut-offs), and recomputes only what is truly stale. Push is cheap
marking; pull is exact verification. This gives lazy evaluation with exact
recompute counts.

**Kernel.** This spec's name for the closed engine that stores the dependency
graph and runs push/pull. A kernel knows nodes only as integers and answers
one question: "given the invalidations you told me about, is node N stale,
and in what order should things recompute?" It stores no user values.

**Policy tier.** Everything above the kernel: the classes users touch, the
values, the concurrency rules, React integration, tracing. "Policy" because
it decides *what should happen*; the kernel is "mechanism," *how graph
bookkeeping is carried out*. The split is the Unix mechanism/policy
separation applied hard: the kernel never reads policy state to decide
whether work happens; policy never touches a record field directly.

**Arena.** A big pre-allocated block of memory (here, one `Int32Array`) from
which small fixed-size **records** are handed out by bumping a pointer or
popping a free list. Allocation is a few instructions; freeing is pushing an
index; the garbage collector never scans it. Node and edge records live in
the arena; an integer **id** (a pre-multiplied offset into the array)
identifies each record.

**Record / stride.** A record is one fixed-size slot in the arena: 8
consecutive `Int32` fields (the **stride**), 32 bytes. An id is
`recordIndex * 8`, so field access is `M[id + FIELD]` with no multiply.

**World.** One self-consistent assignment of values to all atoms. Concurrent
React can have several worlds alive at once: the **base** world (what
committed screens show, including urgent writes), and a **head** world (base
plus all pending transition writes). A **render pass** may need a third,
in-between view. §7.3 defines these precisely.

**Batch.** React groups the state updates caused by one event or one
transition into a batch and renders them together. In our React fork, each
batch is identified by an integer **token**. A **deferred** batch is one
scheduled at transition-like priority (it may render in the background and
commit later); an **urgent** batch renders promptly.

**Transition (`startTransition`).** React's mechanism for marking updates as
non-urgent: React keeps showing the old screen (interactive) while preparing
the new one in the background. "Parity with transitions" means a signal write
inside `startTransition` behaves exactly like a `useState` write there: the
old screen keeps showing old signal values; the prepared screen shows new
ones; both can be on screen (in different renders) with no mixing.

**Suspense.** React's mechanism for waiting: a component (or here, a
computed) that needs an unresolved promise "suspends"; React shows a fallback
and retries when the promise settles. cosignal computeds support
`ctx.use(promise)` with the same thenable protocol React uses.

**Render pass.** One attempt by React to render a root: from a fresh stack to
either completion or abandonment. Concurrent React can pause a pass, yield to
the browser, and resume it later; unrelated writes may land in between. A
pass must observe a frozen, self-consistent world for its whole life
("no tearing").

**Commit.** The moment React applies a finished render's changes to the DOM.
Only after commit is a batch's work on screen. **Retirement** is this spec's
word for a batch leaving React's books — almost always by committing.

**Lane.** React-internal priority bitmask attached to every update. Our fork
deliberately does **not** expose lanes; it exposes batch tokens, which are
stable identities (lane bits get recycled; tokens never do).

**Monomorphic / polymorphic / megamorphic.** V8 (the JavaScript engine)
compiles hot functions with **inline caches (ICs)**: per-call-site and
per-property-site memos of "what shape of thing did I see here?" A site that
only ever sees one shape (monomorphic) compiles to a direct load or call. A
few shapes: polymorphic (a dispatch chain; the practical cliff is ~4 shapes).
Many: megamorphic — a hash lookup per access, an order of magnitude slower.
"Type feedback" is the recorded history that drives this. **Type-feedback
pollution** is when unrelated variety (many closure identities, many object
shapes) flows through one shared function and degrades its ICs — this is the
chief failure mode this architecture is designed to make impossible in the
kernel (§4.3).

**Hidden class (shape).** V8's internal descriptor for an object's layout.
Objects constructed with the same properties in the same order share one
hidden class; property access on a known hidden class is one offset load.

**Closure / feedback vector.** A closure is a function value plus captured
variables. V8 attaches type feedback to the closure *instance*, and its
optimizer can specialize compiled code to a closure's captured constants
("context specialization") — this is why the kernel closes over its buffer
as a `const` (§6.6) and why per-kernel closures isolate feedback (§6.7).

**Thenable.** Any object with a `.then` method — a promise from the engine's
point of view. React's `use()` protocol stamps `status`/`value`/`reason`
fields onto thenables it has seen; cosignal follows the same convention.

**`useSyncExternalStore` (uSES).** React's built-in hook for external stores,
and the thing we are *not* using. It guarantees consistency by forcing
synchronous re-renders and discarding concurrent work — precisely the
de-optimization cosignal exists to eliminate.

---

## 3. Requirements

<a name="3-requirements"></a>

These come from the project brief and are restated here so the spec is
self-contained. Section 10 maps each to its home in the architecture.

### 3.1 Functional

- **R1 — Atom**: `new Atom<T>({ state, effect?, isEqual?, label? })` with
  `atom.state` (read), `atom.set(v)`, `atom.update(fn)`. The optional
  `effect` runs when the atom first becomes observed and its returned cleanup
  runs when it stops being observed (for remote subscriptions).
- **R2 — Computed**: `new Computed<T>({ fn: (ctx) => T, isEqual?, label? })`
  with automatic dependency tracking and `ctx.use(promise)` suspense support.
- **R3 — ReducerAtom**: `new ReducerAtom({ state, reducer, isEqual?, label? })`
  with `dispatch(action)`.
- **R4 — Hooks**: `useSignal(signal)`, `useAtom(options)`,
  `useReducerAtom(options)`, `useComputed(fn, deps, options?)` (may close
  over props/state; accepts `{isEqual, label}`), `useSignalEffect(fn, deps)`.
- **R5 — Transitions**: full `useTransition`/`startTransition` integration; a
  transition can carry React state and signal state in lockstep. Optional
  `startSignalTransition` batching helper.
- **R6 — Suspense parity**: computeds can suspend on promises; components
  reading a suspended computed suspend the React way; a component mounting
  in the middle of a transition whose head state suspends must behave
  correctly (this is a known bug in the React team's own
  react-concurrent-store experiment; it must be a passing test here).
- **R7 — Infinite-loop rejection**: integrate with React's own
  infinite-update protection where React is involved; bound signal-only
  cycles in the core.
- **R8 — Writes inside computeds**: tolerated when acyclic; a library
  configuration flag can forbid them at initialization time; render-pass
  evaluation always rejects them.
- **R9 — Multiple React roots** work; batches spanning roots retire
  correctly.
- **R10 — SSR/hydration**: hydrating from vanilla server rendering is
  possible (RSC/Flight out of scope for v1).
- **R11 — Tracing**: a lazily-loadable tracing module with full causality
  ("why did my computed re-run?", "why did my component re-render?", "how
  many times did my effect run?"), suitable as the base for a devtools
  timeline; plus a separate Graphviz module rendering (a) the causal graph
  of trace events and (b) the current dependency graph.
- **R12 — React fork**: a minimal, maintainable patch exposing concurrent
  render state and lifecycle; **no Fiber objects and no lane bits** may
  cross the boundary. It must also expose when React is about to mutate the
  DOM and when it is done (so an application `MutationObserver` can ignore
  React's own mutations) — unrelated to signals, but part of the same patch.

### 3.2 Performance

- **P1**: re-render-on-signal-change competitive with plain
  `useState`/`useReducer` (within noise).
- **P2**: pure-core performance on par with or ahead of alien-signals on the
  happy path (the js-reactivity-benchmark suites); exact lazy pull counts
  (the benchmark's `testPullCounts: true` contract).
- **P3**: the untraced cost of the tracing hooks is one null check per site;
  the concurrency machinery costs nothing when no React binding or
  transition is active (pure-core users and benchmarks never pay for it).

### 3.3 Engineering

- **E1**: pnpm; TypeScript; prefer `type X = ...` over `interface`; prefer
  `undefined` over `null` unless `null` measurably performs better (this
  spec justifies each `null` it uses). *Amended constraint (2026-07-03):*
  the original stripping-only rule is relaxed — `const enum` is acceptable
  because the library ships through a compile step (tsdown/esbuild bundle);
  §6.5 documents the exact toolchain requirement this imposes and the
  fallback for stripping-only consumers. `namespace` remains avoided.
- **E2**: plain-spoken code and docs; no invented terms of art; invariants
  written down where they live; signals internals explained, not mystified.
- **E3**: the React patch must be small, documented, and rebuildable
  (`scripts/build-react.sh` producing `build/oss-experimental/*`, linked via
  pnpm overrides).

---

## 4. Architecture

<a name="4-architecture"></a>

### 4.1 The three tiers

```
┌────────────────────────────────────────────────────────────────────┐
│ React (forked): unstable_externalRuntime — integer batch tokens,    │
│ render-pass events, retirement events, DOM-mutation window (§8.1)   │
└───────────────▲────────────────────────────────────────────────────┘
                │ integers + 5 event callbacks
┌───────────────┴────────────────────────────────────────────────────┐
│ POLICY TIER (plain JS, one hidden class for all nodes)              │
│  values · write logs · worlds & read rule · batches/retirement ·    │
│  equality · promises/suspense · atom lifecycle · effect queue ·     │
│  hooks · tracing emit · FinalizationRegistry reclamation            │
└───────▲──────────────────────────────▲─────────────────────────────┘
        │ K0: integer protocol          │ K1: integer protocol
┌───────┴──────────────┐       ┌───────┴──────────────┐
│ KERNEL K0 (base)     │       │ KERNEL K1 (head)     │
│ one Int32Array:      │       │ same code, stamped   │
│ nodes, links, flags, │       │ separately; lazily   │
│ propagate + verify   │       │ populated, bulk-reset │
└──────────────────────┘       └──────────────────────┘
```

- The **kernel** (§6) is the complete alien-signals-style push/pull graph
  algorithm — propagate, verify (`checkDirty`), link/unlink with re-track
  trimming, the re-entrancy flag machinery — over integer records. It is
  *closed*: its only inputs are integer-argument calls, and its only outputs
  are integer-argument calls to four host callbacks (`refresh`, `notify`,
  `watched`, `unwatched`) registered once at creation.
- The **policy tier** (§7) owns every value and every decision. It maps user
  objects to kernel node ids, stores values in its own columns, applies
  equality, implements the multi-world read rule, talks to React, and runs
  effects. When the kernel needs a node recomputed it calls
  `host.refresh(node, handle)` and the policy tier does everything —
  including deciding "did it change?" — returning a boolean.
- The **React fork** (§8.1) tells policy which batch a write belongs to,
  which batches a render pass includes, and when batches retire. Everything
  crosses as integers.

### 4.2 What the kernel is NOT allowed to contain, and why

The kernel has **no**:

| Excluded from kernel | Where it lives | Why excluded |
| --- | --- | --- |
| Values (of any type) | Policy columns (§7.2) | Values are polymorphic; one `unknown[]` next to the kernel was the old design. Moving them up lets the kernel's compiled code touch only `Int32Array` — and lets *different* value policies (plain, versioned, logged) exist without new kernel code. |
| Equality functions | Policy `refresh` (§7.2) | User `isEqual` closures are unbounded variety. A kernel call site invoking them would go megamorphic. Policy keeps the `Object.is` default on a separate branch from custom equality so the common path stays monomorphic. |
| Version/sequence stamps | Policy write log (§7.4) | Multi-version concurrency is policy. The kernel's job is staleness in *one* world; we run one kernel per world (§6.7) instead of teaching one kernel about versions. (Note: the kernel *does* keep alien-signals' per-link re-track version — that is dependency-tracking mechanism, not value versioning.) |
| Lanes, batches, React anything | Policy + fork (§7.5, §8.1) | React concepts change; graph mechanism doesn't. The placement rule from the project's design review: concurrent-React features land as policy plus, at most, new kernel *facts* — never kernel branches named after React concepts. |
| Promises / suspense | Policy (§7.7) | A suspended computed is, to the kernel, just a node whose `refresh` returned "changed" or "unchanged". Thenable bookkeeping is value policy. |
| Labels, tracing payloads | Policy + tracing module (§9) | Strings in the hot path are pure poison; the kernel's traced variant (§6.7) emits integer events only. |
| Effect queue & scheduling | Policy (§7.9) | *When* reactions run (sync flush, microtask, after commit) is the most policy-like decision in the system. The kernel only reports "this watched node became stale" via `notify`. |
| Node kinds (Atom vs Computed vs …) | Policy `kind` field | The kernel knows two structural facts: "does this node have a refresh action?" (DERIVED) and "does the host want staleness callbacks?" (WATCHED). Atom/ReducerAtom/Computed/watcher specialization is a policy `switch` on its own table. |

### 4.3 Why the kernel stays closed: the type-feedback argument

This architecture's chief motivation is a JIT failure mode we have measured
rather than theorized:

1. **Shared closures accumulate everyone's variety.** Feedback (which shapes
   a property site saw, which targets a call site saw) is recorded per
   function instance and per site. A signals engine whose hot walk calls
   user code — equality functions, getters, effect bodies — from *inside*
   the walk shares those call sites across every signal in the process. In
   benchmark terms: running multiple frameworks (or multiple usage styles)
   in one process degraded the first-run framework's numbers by up to 3×
   purely through feedback pollution; the practical polymorphic cliff is ~4
   shapes per site, then megamorphic hash-lookup costs on every access.
   A library embedded in a real app *is* the multi-framework case: every
   product team's atoms and equality functions flow through the same engine.
2. **Bundling demotes module constants.** esbuild bundling rewrites
   module-scope `const` into mutable `var` (for lazy-init and scope-merge
   hoisting), which costs V8's optimizer its constant-folding: measured
   **+15–21%** on kairo-scale workloads. Field offsets and flag bits must
   therefore reach the emitted JavaScript as *numeric literals*, not as
   module-scope constants. §6.5 specifies the strategy: a same-file
   `const enum` (with a documented toolchain requirement) plus a
   literal-emitting fallback for stripping-only consumers.
3. **Inline budgets are finite and shared.** V8 inlines callees into an
   optimized function only under bytecode-size budgets (460 per callee, 920
   cumulative per caller, defaults as of Node 24). Typed-array field access
   generates roughly 2× the bytecode of a named-property load, so a packed
   kernel is *always* near the budget: the original arena `link()` was 475
   bytecodes — 15 over the limit — and silently never inlined into the read
   path until it was split (fast path 168 bytecodes), worth 8–13% on the
   affected shapes. Every policy branch that leaks into a kernel function
   spends budget the graph walk needs.

The kernel therefore admits **no policy code and no policy data**. Its
compiled functions see: one `Int32Array` (a closure constant), integer
locals, and one host object with four function-valued fields whose
identities never change after creation. Every property site in the kernel is
monomorphic by construction; every call site has exactly one target per
kernel instance. Nothing a user can write — no matter how many atoms,
equality functions, or React roots — adds a shape or a call target to any
kernel site. That is what "policy variety cannot pollute kernel type
feedback" means concretely.

The residual variety that *must* exist (user getters, reducers, equality)
executes in policy functions whose polymorphic sites run **once per actual
recompute** (a leaf operation), never once per graph step. This is the
capability rule from the project's packed-authoring review: state that the
marking/verification walks touch must be reachable as `M[id + FIELD]`
without leaving the plane; state touched only at leaves may live in ordinary
GC objects.

### 4.4 Why two kernel instances (one per world)

Concurrency needs per-world *staleness*, not just per-world values: a
transition write makes downstream computeds stale **in the head world only**
— their committed caches are still perfectly valid, and invalidating them
would force the committed screen to recompute for a change it must not see.

Variant D refuses to put world-awareness in the kernel (that would be
version stamps, dual flag planes, or lane sets in-core — exactly the growth
this variant exists to test against). Instead:

- **K0 (base kernel)** tracks staleness of the base world. It exists for the
  process lifetime, is always warm, and is the *only* kernel non-React and
  benchmark code ever touches.
- **K1 (head kernel)** tracks staleness of the head world. It is empty until
  the first deferred write of a "fork" (the period while ≥1 deferred batch
  is live), gets nodes **shadowed** into it on demand (§7.6), and is
  bulk-reset to empty when the fork ends. Its arena never shrinks; reuse
  across transitions keeps its JIT feedback warm.
- **Render-pass views** that match neither world (rare; §7.3) are resolved
  by pure policy computation over the write log with a per-pass memo — no
  third kernel, because such passes are short-lived and infrequent by
  construction.

Two kernels also give a free isolation dividend: K0's feedback never sees
K1's usage pattern (transitions have bursty allocate-reset behavior that
would otherwise sit in K0's ICs and inline decisions). §6.7 explains how the
two instances are stamped from one template so each gets its own compiled
code and its own closure-constant buffer.

### 4.5 Fast-path guarantee (P3 made concrete)

When no React binding is registered and no batch is live — the benchmark
case, the server case, and most of an app's frames:

- an atom write is: one policy equality check, one `K0.invalidate`, and (if
  anything is watched) a synchronous effect flush;
- an atom read is: one policy property load (`n.base`), plus `K0.pull` only
  when inside a tracked computation;
- no log entry is allocated, no token is minted, no world logic runs — the
  write log short-circuits on `hasReactBindings === false` before touching
  any of it, and that flag is a module-level boolean set once by the React
  entry point.

---

## 5. Public API

<a name="5-public-api"></a>

Package: `cosignal`, with subpath exports `cosignal/react`,
`cosignal/tracing`, `cosignal/graphviz`. Nothing in `cosignal` (the core)
imports React.

```ts
// ---- cosignal (core) -------------------------------------------------------

export type AtomCtx<T> = {
  /** Read the atom's current value without tracking. */
  get(): T;
  /** Write the atom (same rules as atom.set). */
  set(value: T): void;
};

export type AtomOptions<T> = {
  state: T;
  /** Runs when the atom becomes observed (0 -> 1 watchers); the returned
   * cleanup runs when it becomes unobserved (1 -> 0). Delivered on a
   * microtask so same-tick flapping does not thrash subscriptions. */
  effect?: (ctx: AtomCtx<T>) => (() => void) | void;
  /** Change cutoff. Default Object.is. Returning true suppresses updates. */
  isEqual?: (a: T, b: T) => boolean;
  /** Debug-tools name. Never read on a hot path. */
  label?: string;
};

export class Atom<T> {
  constructor(options: AtomOptions<T>);
  get state(): T;                    // world-aware read (§7.3)
  set(value: T): void;
  update(fn: (current: T) => T): void;
}

export type ComputedCtx<T> = {
  /** Suspense: returns the fulfilled value of the thenable or suspends this
   * computed (§7.7). Identity-stable across re-evaluations per world. */
  use<U>(thenable: PromiseLike<U>): U;
  /** Previous cached value of this computed in the world being evaluated,
   * or undefined on first run. */
  previous: T | undefined;
};

export type ComputedOptions<T> = {
  fn: (ctx: ComputedCtx<T>) => T;
  isEqual?: (a: T, b: T) => boolean;
  label?: string;
};

export class Computed<T> {
  constructor(options: ComputedOptions<T>);
  get state(): T;                    // world-aware, lazily verified read
}

export type ReducerAtomOptions<S, A> = {
  state: S;
  reducer: (state: S, action: A) => S;
  isEqual?: (a: S, b: S) => boolean;
  label?: string;
};

export class ReducerAtom<S, A> {
  constructor(options: ReducerAtomOptions<S, A>);
  get state(): S;
  dispatch(action: A): void;
};

/** Reaction for non-React code. Runs immediately (tracked); re-runs
 * synchronously on flush when tracked signals change. Returns a disposer.
 * React code should prefer useSignalEffect. */
export function effect(fn: () => void | (() => void)): () => void;

/** Group writes; effects flush once at the end. Reads inside the batch see
 * fresh values (the benchmark contract). */
export function batch<T>(fn: () => T): T;

/** Read signals without creating dependencies. */
export function untracked<T>(fn: () => T): T;

/** One-time initialization switches. Throws if called after first use. */
export function configure(options: {
  forbidWritesInComputeds?: boolean;   // default false (tolerated if acyclic)
  initialKernelRecords?: number;        // default 16384 (see §11)
}): void;

// ---- cosignal/react --------------------------------------------------------

export function useSignal<T>(signal: Atom<T> | Computed<T> | ReducerAtom<T, unknown>): T;
export function useAtom<T>(options: AtomOptions<T>): Atom<T>;
export function useReducerAtom<S, A>(options: ReducerAtomOptions<S, A>): ReducerAtom<S, A>;
export function useComputed<T>(
  fn: (ctx: ComputedCtx<T>) => T,
  deps: unknown[],
  options?: { isEqual?: (a: T, b: T) => boolean; label?: string },
): T;
export function useSignalEffect(
  fn: () => void | (() => void),
  deps?: unknown[],
): void;

/** Optional helper: startTransition that also opens a core batch so many
 * signal writes propagate once. Semantically identical to calling
 * startTransition and writing signals inside it. */
export function startSignalTransition(scope: () => void): void;
export function useSignalTransition(): [isPending: boolean, start: (scope: () => void) => void];

// ---- cosignal/tracing (lazy; §9) -------------------------------------------
export function installTracer(options?: { ringCapacity?: number }): Tracer;
// ---- cosignal/graphviz (lazy; §9) ------------------------------------------
export function dependencyGraphToDot(signals: Iterable<Atom<unknown> | Computed<unknown>>): string;
export function traceToDot(events: Iterable<TraceEvent>, filter?: TraceFilter): string;
```

Notes:

- No `<SignalsProvider>` component is required. The fork's global listener
  registry (§8.1) carries root identity in every event, so multiple roots
  need no React context. (The brief permits a mandatory top-level component
  "if strictly necessary"; it is not.)
- `Atom`/`Computed`/`ReducerAtom` are classes (not closures) so all
  instances share one hidden class per public type and the policy tier can
  attach a `FinalizationRegistry` to them for record reclamation (§6.6).
- Core `effect()` exists for non-React consumers and the benchmark adapter;
  the React bindings never use it.

---

## 6. The kernel

<a name="6-the-kernel"></a>

### 6.1 What a kernel instance is

A kernel instance is a closure bundle created by a factory:

```ts
const K0 = createKernel0(host0, initialRecords);  // stamped copies, §6.7
const K1 = createKernel1(host1, initialRecords);
```

Inside, its entire mutable universe is:

- `M: Int32Array` — the **plane**: one flat array holding every node record
  and every link record, interleaved, stride 8 (a closure `const`; growth
  rebuilds the closure, §6.6);
- two persistent `Int32Array` scratch stacks (for the iterative propagate
  and verify walks; re-entrant calls save/restore a base pointer);
- a handful of integer counters (bump pointer, free-list heads, tracking
  cursor state, cycle counter);
- the `host` object — four callback fields, set once, never replaced.

The kernel exposes ~20 functions (§6.3). Every parameter and return value is
a `number` (or `boolean`/`void`). The kernel never allocates a JS object
after creation, never reads a JS object other than `host`, and throws in
exactly two situations: arena exhaustion mid-operation (a sizing error) and
a dependency cycle discovered during pull (a graph-level error the policy
tier wraps with labels, §7.10).

**Semantics contract.** The kernel implements exactly the alien-signals v3
graph discipline — the industry-strongest push/pull algorithm, whose full
subtlety (re-track version trimming, `Recursed`/`RecursedCheck` re-entrancy
flags, `isValidLink` validation, shallow re-propagation after a verified
change) is load-bearing for both correctness and honest benchmark numbers
(a prior spike missing it over-recomputed up to 20% on dynamic graphs). The
starting implementation is a mechanical extraction from this repository's
`libs/arena/src/index.ts`, which passes the 179-case cross-framework
conformance suite; variant D removes its value/function columns and kind
dispatch, replacing them with the host protocol.

### 6.2 Data layout: field tables and byte math

One plane, stride 8, `Int32` fields. An id is a **pre-multiplied record
offset**: `id = recordIndex * 8`, so field access is `M[id + FIELD]` — one
add, one indexed load, no multiply. Record 0 is burned as the null record so
`0` means "none" everywhere (this is why upstream's `!== undefined` checks
become `!== 0`).

**Node record** (one per signal-graph participant):

| Offset | Name | Meaning |
| --- | --- | --- |
| +0 | `FLAGS` | State + structure bits (table below). `0` = freed record. |
| +1 | `DEPS` | Link id: head of this node's dependency list ("what I read"). Doubles as the free-list next pointer while the record is freed. |
| +2 | `DEPS_TAIL` | Link id: tail of the dependency list; also the re-track cursor during tracking (§6.4). |
| +3 | `SUBS` | Link id: head of this node's subscriber list ("who reads me"). |
| +4 | `SUBS_TAIL` | Link id: tail of the subscriber list. |
| +5 | `GEN` | Generation counter, incremented on free. Stale ids are detected by comparing a remembered generation (§6.6). |
| +6 | `HANDLE` | Opaque 32-bit policy handle. The kernel stores it at `alloc` and passes it back in every host callback; it never interprets it. (Policy uses it as a dense index into its node table, §7.1.) |
| +7 | — | Spare (pads the record to 32 bytes; reserved for a future scheduling field such as height/epoch, which the capability rule would place in-plane). |

**Link record** (one per dependency edge; interleaved in the same plane):

| Offset | Name | Meaning |
| --- | --- | --- |
| +0 | `VERSION` | The kernel's tracking-cycle number when this edge was last confirmed. Lets re-runs reuse the existing edge list in place and drop edges not re-confirmed (alien-signals' re-track trimming). Not a value version. |
| +1 | `DEP` | Node id of the dependency (the thing read). |
| +2 | `SUB` | Node id of the subscriber (the reader). |
| +3 | `PREV_SUB` | Link id: previous edge in `DEP`'s subscriber list. |
| +4 | `NEXT_SUB` | Link id: next edge in `DEP`'s subscriber list. |
| +5 | `PREV_DEP` | Link id: previous edge in `SUB`'s dependency list. |
| +6 | `NEXT_DEP` | Link id: next edge in `SUB`'s dependency list. Doubles as the free-list next pointer while freed. |
| +7 | — | Spare. |

Every edge appears in two doubly-linked lists at once (the dep's subscriber
list and the sub's dependency list) — that is why one record carries four
list pointers. Interleaving node and link records in **one** plane (rather
than two parallel planes) is a measured decision: one base register, one
bump pointer, and it was worth −2% to −8% on traversal shapes versus split
planes.

**Flag bits** (node `FLAGS`):

| Bit | Value | Name | Meaning |
| --- | --- | --- | --- |
| 0 | `1` | `LIVE` | Record is allocated. `FLAGS === 0` means freed; walks re-check liveness after running host callbacks (a callback may dispose nodes). |
| 1 | `2` | `DERIVED` | Node has a refresh action: when verification finds it possibly-stale, the kernel calls `host.refresh` on it. Sources (atoms) do not have this bit; their changes are declared by policy via `invalidate`. |
| 2 | `4` | `WATCHER` | Persistent: the host wants `host.notify` when this node becomes stale. |
| 3 | `8` | `ARMED` | One-shot notification arming: cleared when `notify` fires, re-set by `poll`/`endTrack`/`setWatcher`. `WATCHER & ARMED` together are equivalent to alien-signals' single `WATCHING` bit (§6.4 explains the split). |
| 4 | `16` | `DIRTY` | Known stale: must refresh before next use. |
| 5 | `32` | `PENDING` | Possibly stale: a dependency propagated a mark; verification must decide. |
| 6 | `64` | `RECURSED_CHECK` | This node is currently being tracked/refreshed (re-entrancy guard; detects self-reads and validates mid-run writes). |
| 7 | `128` | `RECURSED` | A write reached this node while it was running (alien-signals' re-run marker). |
| 8–30 | — | — | Reserved. Kind bits deliberately do NOT exist here (policy owns kinds). |

`MUTABLE` from alien-signals (can act as a change source) is subsumed by
`LIVE` plus structure (sources are invalidated, DERIVEDs are refreshed);
otherwise the port keeps the exact ladder `libs/arena` proved. The
flag-transition ladder must be preserved verbatim — it is the part of
alien-signals that took years to get right.

**Byte math.**

- Record: 8 fields × 4 bytes = **32 bytes** (half a typical cache line; two
  records per line, and a node's hottest fields — FLAGS, DEPS, SUBS — land
  in one line with room from the id premultiplication).
- A signal with one subscriber costs: 1 node record + 1 link record =
  64 bytes in-plane, plus its policy-node object (§7.1, ~80–112 bytes on
  V8 including value slots) — versus ~200+ bytes for a comparable
  object-graph node with link objects, with none of it GC-scanned.
- Plane size for `records` records: `records × 32` bytes. Defaults (§11):
  K0 = 16,384 records = 512 KiB; K1 = 4,096 records = 128 KiB; both grow by
  doubling.
- Scratch stacks: 2 × `Int32Array(4096)` = 32 KiB per kernel, grown by
  doubling when a walk exceeds them.

### 6.3 The kernel protocol: exact signatures

The whole boundary between mechanism and policy. Everything is integers;
"handle" values are stored blindly and passed back.

```ts
// Branded integer types: zero runtime cost (brands erase; arithmetic yields
// plain number, which is what flag math wants), but they make it a compile
// error to pass a LinkId where a NodeId goes, or to forget that a raw plane
// load must be cast to say what the field holds.
type NodeId = number & { readonly __brand: 'NodeId' };   // 0 = none
type LinkId = number & { readonly __brand: 'LinkId' };   // 0 = none
type Handle = number & { readonly __brand: 'Handle' };   // policy-owned meaning

type KernelHost = {
  /** Recompute `node` in this kernel's world and store the result on the
   * policy side. Return true if the node's output CHANGED (after applying
   * whatever equality policy applies). For source nodes (no DERIVED bit)
   * this is where policy folds coalesced writes and applies the write
   * cutoff. MUST NOT throw: user errors become error-valued results
   * (return true — "changed to an error"). Called re-entrantly. */
  refresh(node: NodeId, handle: Handle): boolean;
  /** `node` (a WATCHER) became stale in this kernel's world. Runs
   * synchronously inside invalidate/verification, in the writer's execution
   * context — policy must only schedule here (queue an effect, call a
   * hook's setState), never run user reactions inline. */
  notify(node: NodeId, handle: Handle): void;
  /** `node` gained its first subscriber (0 -> 1). */
  watched(node: NodeId, handle: Handle): void;
  /** `node` lost its last subscriber (1 -> 0). For DERIVED nodes the kernel
   * has already torn down the node's own dependency edges and marked it
   * DIRTY (mechanism); this callback is for policy lifecycle (atom
   * `effect` cleanup scheduling, §7.8). */
  unwatched(node: NodeId, handle: Handle): void;
};

type KernelStats = {
  records: number;      // plane capacity, in records
  used: number;         // bump-pointer high water, in records
  nodeFree: number;     // records on the node free list
  linkFree: number;     // records on the link free list
  growths: number;      // closure rebuilds so far
};

type Kernel = {
  // -- lifecycle --------------------------------------------------------
  /** Allocate a node record. `flags` is a combination of DERIVED/WATCHER
   * (plus LIVE, implied). DERIVED nodes start DIRTY so their first pull
   * refreshes them. Returns the node id. */
  alloc(flags: number, handle: Handle): NodeId;
  /** Unlink all edges now; return the record to the free list at the next
   * safe point (§6.6). Bumps GEN. */
  free(node: NodeId): void;
  gen(node: NodeId): number;
  handleOf(node: NodeId): Handle;
  isLive(node: NodeId): boolean;

  // -- writes -------------------------------------------------------------
  /** Policy declares: this source's output changed in this kernel's world.
   * Marks the source DIRTY and pushes possibly-stale marks to subscribers
   * (notifying stale WATCHERs). `innerWrite` is true when the write
   * happened inside a running reaction in THIS kernel (policy knows; it
   * runs the reactions) — it drives the re-run marker for
   * write-inside-effect semantics. */
  invalidate(source: NodeId, innerWrite: boolean): void;

  // -- reads / verification -----------------------------------------------
  /** Make `node` fresh: if known-stale, refresh it; if possibly-stale,
   * verify bottom-up (refreshing exactly what actually changed) and either
   * refresh or absolve it. Then, if a tracker is active, record the edge
   * "tracker depends on node". This is THE read operation. Throws the
   * kernel's cycle error if `node` is currently being refreshed
   * (RECURSED_CHECK) — a true dependency cycle; policy wraps it (§7.10). */
  pull(node: NodeId): void;
  /** For a notified watcher, decide "do I really need to re-run?": true if
   * verification confirms a real change (caller will re-run it under
   * beginTrack/endTrack); false absolves it and re-arms notification. */
  poll(watcher: NodeId): boolean;

  // -- tracking -------------------------------------------------------------
  /** Start collecting dependencies for `sub` (an effect/watcher re-run, or
   * any policy-driven evaluation). Resets the re-track cursor, sets the
   * re-entrancy flag, returns the previous tracker (0 if none). The kernel
   * calls the equivalent internally around host.refresh of DERIVED nodes —
   * policy only needs beginTrack/endTrack for evaluations the kernel did
   * not initiate. */
  beginTrack(sub: NodeId): NodeId;
  /** Stop collecting: drop dependency edges not re-confirmed during this
   * run (exact re-track trimming), clear the re-entrancy flag, re-arm
   * notification if `sub` is a WATCHER, restore the previous tracker. */
  endTrack(sub: NodeId, prevSub: NodeId): void;
  /** Replace the active tracker, returning the old one. `swapTracker(0)` +
   * restore implements untracked(). */
  swapTracker(sub: NodeId): NodeId;
  activeTracker(): NodeId;

  // -- structure ------------------------------------------------------------
  hasSubs(node: NodeId): boolean;
  /** Turn WATCHER on/off after alloc (used when a hook subscribes to an
   * existing node, and by atom observed-lifecycle bookkeeping). */
  setWatcher(node: NodeId, on: boolean): void;
  /** Create the edge dep -> sub directly, without tracking and without
   * resolving either node (no refresh, no verification). Used by policy for
   * explicit single-dependency watchers (§8.3) and for shadowing a subgraph
   * into the head kernel (§7.6). Idempotent if the edge exists. */
  linkEdge(dep: NodeId, sub: NodeId): void;

  // -- memory ----------------------------------------------------------------
  /** Safe point: sweep deferred frees, grow (rebuild) if the watermark was
   * crossed. Policy calls this at operation boundaries (public API entry,
   * before effect flush). No-op when nothing is pending. */
  runBoundary(): void;
  stats(): KernelStats;

  // -- read-only iteration (tracing, graphviz, tests; never on hot paths) ----
  firstDep(node: NodeId): LinkId;
  nextDep(link: LinkId): LinkId;
  firstSub(node: NodeId): LinkId;
  nextSub(link: LinkId): LinkId;
  linkDep(link: LinkId): NodeId;
  linkSub(link: LinkId): NodeId;
  flagsOf(node: NodeId): number;
};

function createKernel0(host: KernelHost, initialRecords: number): Kernel;
function createKernel1(host: KernelHost, initialRecords: number): Kernel;
// (Two stamped factories from one template — §6.7. Growth rebuilds the
// internal closures and reassigns the Kernel object's function fields; the
// Kernel object identity policy holds is stable for the process lifetime.)
```

Call-graph summary (who calls whom):

```
policy write  ──► invalidate ──► [propagate walk] ──► host.notify (schedule only)
policy read   ──► pull ──► [verify walk] ──► host.refresh ──► policy evaluates,
                                             │                 calls pull() on deps
                                             └─ (re-entrant; scratch-stack safe)
policy flush  ──► poll ──► [verify walk] ──► host.refresh (for deps that must settle)
              ──► beginTrack / run user fn (policy) / endTrack
```

### 6.4 Algorithms, in plain English

The kernel is a port of the alien-signals v3 algorithm as already proven in
`libs/arena` (179/179 conformance); this section explains what each piece
does and what variant D changes. The port rule: **preserve the flag ladder
and walk structure verbatim; replace value/function-column touches with host
callbacks; delete kind dispatch and effect-queue machinery.**

**Linking (how edges form).** While a tracker is active, every `pull(dep)`
records an edge dep→tracker. Re-runs don't rebuild the edge list: the
tracker's dependency list is kept in place and a **cursor** (`DEPS_TAIL`)
advances along it as dependencies are re-confirmed in order. Three cases,
cheapest first: (1) the next edge in the list is already this dep — stamp
its `VERSION` with the current tracking cycle and advance (the steady-state
path: a computed re-reading the same deps in the same order allocates
nothing); (2) same dep as the cursor's current edge — pure repeat read,
return; (3) otherwise insert a new link record between cursor and list.
When tracking ends, edges after the cursor were not re-confirmed and are
unlinked (**re-track trimming** — this is what keeps recompute counts exact
on graphs whose dependencies change shape at runtime).

*Inlining note (measured):* the insert case must live in a separate
function (`linkInsert`) from the three-case fast path. Monolithic, the
function is ~475 bytecodes — over V8's 460-byte inline budget — and never
inlines into the read path; split, the fast path is ~168 bytecodes and
inlines everywhere, worth 8–13% on traversal shapes. The kernel template
marks both functions with their budget in a comment, and CI asserts the
bytecode counts (§12).

**Invalidate + propagate (push phase).** `invalidate(source)` marks the
source known-stale and walks its subscriber lists transitively, setting
possibly-stale (`PENDING`) marks. The walk is iterative (an explicit
`Int32Array` stack, not recursion — 10k-deep graphs must not overflow), and
the flag ladder decides at each node whether to mark, skip (already
marked), or handle re-entrant cases (a write reaching a node that is
currently running). When the walk reaches a node with `WATCHER|ARMED`, it
calls `host.notify(node, handle)` and clears `ARMED` — one notification per
watcher per going-stale, no matter how many writes pile up before it re-runs
(policy re-arms on poll/endTrack). Propagate runs **no user code** (notify
only schedules), so it needs no try/finally and always drains its stack.

**Pull + verify (the lazy phase).** `pull(node)`:

1. If `DIRTY` (known stale): refresh it (below).
2. Else if `PENDING` (possibly stale): run **checkDirty** — walk *down* the
   node's dependency list, and for each possibly-stale dependency, recurse
   (iteratively, with the scratch stack) until reaching known-stale nodes;
   refresh those; if their output actually changed (host said so), the
   change re-marks the level above known-stale, and the walk unwinds
   refreshing exactly the chain that truly changed. If nothing changed, the
   `PENDING` mark is cleared without any recompute (**equality cut-off**,
   except the equality decision itself belongs to policy inside `refresh`).
3. Then, if a tracker is active, link node→tracker.

**Refreshing a node.** For a `DERIVED` node the kernel brackets the host
callback with tracking choreography: advance the global tracking cycle,
reset the node's cursor, set `RECURSED_CHECK` (the re-entrancy flag), call
`host.refresh(node, handle)` — during which policy evaluates the user
function, and every signal read inside it calls `pull`, forming edges —
then trim unconfirmed edges, clear the flag, and if the host returned
"changed," shallow-propagate: promote direct subscribers' possibly-stale
marks to known-stale (and notify armed watchers among them). For a source
node, refresh is a bare `host.refresh` call (policy folds pending writes and
applies its cutoff); the kernel clears the source's `DIRTY` either way.

`host.refresh` is re-entrant by design: policy's evaluation calls `pull`,
which may run `checkDirty`, which may refresh other nodes. The scratch
stacks use base-pointer save/restore so an inner walk unwinds to its own
base (this replaces upstream alien-signals' allocated linked-list stacks —
and eliminates their measured GC cost, ~1.5 ms per deep-chain benchmark
run).

**Poll.** For a watcher that got notified: `poll` runs the same verification
as pull steps 1–2 but reports the outcome instead of refreshing the watcher
itself (watchers have no refresh action of their own — their "recompute" is
policy running an effect body or a component render). Returns true if a real
change was confirmed (`DIRTY`, or `PENDING` verified true); false absolves
the mark and re-arms `ARMED`.

**Watched/unwatched (observability edges).** When a node's subscriber list
goes empty→nonempty the kernel calls `host.watched`; nonempty→empty,
`host.unwatched`. For DERIVED nodes, unwatched also (mechanically) tears
down the node's own dependency edges and marks it DIRTY — an unobserved
computed stops tracking and will fully re-evaluate when next pulled. This is
graph mechanism (it keeps dead subgraphs from being marked forever); what
*policy* does with the callbacks (atom `effect` lifecycle, §7.8) is its own
business.

**What variant D deletes from the proven kernel.** (a) The `values`/`fns`
side columns and their `id >> 2`/`id >> 3` addressing — gone entirely;
(b) kind bits and `update()`'s kind dispatch — replaced by the DERIVED bit
and `host.refresh`; (c) the effect queue, `notify`'s parent-effect chain
walk, `HAS_CHILD_EFFECT`, and `flush` — effect ordering and nesting are
policy (§7.9); (d) `signalOper/computedOper/effectOper` public wrappers —
policy is the wrapper. What remains is ~450 lines of walks, flags, and
allocation. That *is* the minimal kernel.

**Two flag bits replace alien's one `WATCHING`.** Alien clears `WATCHING`
on notify so a queued effect is not re-queued, then re-sets it after the
run. Since the kernel no longer owns the queue, "this node wants
notifications" (`WATCHER`, persistent) and "the next staleness should
notify" (`ARMED`, one-shot: cleared by notify, re-set by poll/endTrack) are
separated. Alien's `WATCHING` ≡ `WATCHER & ARMED`. This keeps the
duplicate-suppression property (at most one notify between re-runs) without
the kernel knowing anything about queues.

### 6.5 Constants without demotion: `const enum` and its fallback

The offsets and flag bits of §6.2 must reach the emitted JavaScript as
numeric literals. Two measured hazards rule out the naive spellings:
module-scope `const NAME = 5` is demoted to a mutable `var` by esbuild-style
bundlers (costing constant-folding: +15–21% on kairo-scale runs), and any
scheme that loads constants from another module adds a property access per
field touch.

**Primary strategy: a same-file, non-exported `const enum`.**

```ts
// kernel.template.ts — inside the one file that uses them
const enum C {
  FLAGS = 0, DEPS = 1, DEPS_TAIL = 2, SUBS = 3, SUBS_TAIL = 4,
  GEN = 5, HANDLE = 6,
  VERSION = 0, DEP = 1, SUB = 2, PREV_SUB = 3, NEXT_SUB = 4,
  PREV_DEP = 5, NEXT_DEP = 6,
  LIVE = 1, DERIVED = 2, WATCHER = 4, ARMED = 8,
  DIRTY = 16, PENDING = 32, RECURSED_CHECK = 64, RECURSED = 128,
  REC_SLACK = 1280,
}
// usage compiles to: M[id + 3 /* SUBS */] — a literal in every toolchain below
```

Toolchain requirement this imposes (verified in this repo's toolchain):
same-file, non-exported `const enum` members are inlined as literals by
esbuild (both transform and bundle modes — so tsx and vitest are safe), by
tsc, and by swc; the library's published artifacts are compiled JS (via
tsdown/esbuild), so **consumers never see the `const enum` at all** — the
constraint binds only contributors' dev tools. What is *not* allowed:
exporting the enum or referencing it from another file (cross-file const
enums become runtime property accesses under per-file transforms and under
`tsc --isolatedModules`). CI enforces "the enum is not exported and appears
in exactly one file per stamp."

**Fallback for stripping-only consumption of the *source*** (e.g. running
the TS sources directly under a loader that cannot inline const enums): the
kernel stamping generator (§6.7) already rewrites the template; given
`--literals` it additionally replaces every `C.X` with its numeric literal
and a `/* X */` comment, producing const-enum-free stamps. The schema stays
authored exactly once, in the template's enum.

**Dev assertions are stripped by `define`, not by constants.** A hot
function guarded by literal-false (`if (__DEV__) …` under
`--define:__DEV__=false`) generates bytecode identical to the unguarded
function; the same guard spelled with a module `const DEV = false` still
generates the dead check's bytecode (~10× a small function's budget) and
wrecks inline decisions. All kernel invariant checks (§6.8) are `__DEV__`-
guarded; production stamps contain zero of their bytecode.

### 6.6 Growth and reclamation

**Growth = closure rebuild.** The plane `M` is a closure `const`: V8's
optimizer embeds the buffer's base address in compiled kernel code like a
compile-time constant (measured at exact parity with module consts; every
alternative — segment tables, resizable ArrayBuffers, mutable `let`
bindings, per-function aliases — measurably taxes the steady-state read
path by 26–83%). Growing therefore cannot mutate a binding; instead the
factory is re-invoked over doubled buffers (`new Int32Array(n*2)` +
`.set(old)`), and the stable `Kernel` object's function fields are
reassigned. Rebuilds happen only at **operation boundaries** — no kernel
frame that captured the old buffers may be live, tracked by an
`enterDepth` counter around every host-callback bracket. Growth *events*
are near-free and O(log n) ever; only growth *support* on the read path
costs, and this design has none.

**Watermark.** Allocators never grow inline (an allocation can happen
mid-walk). Crossing the watermark — keep at least `REC_SLACK` (1280)
records AND half the plane free — sets a `growPending` flag; `runBoundary`
(called by policy at public-API entry and before effect flushes) performs
the rebuild. If a single operation out-allocates the entire remaining slack
the allocator throws rather than corrupt an in-flight walk; the slack is
sized so the conformance suite and benchmark workloads allocate tens of
records per flush, three orders of magnitude below it.

**Free lists.** Freed node records thread through their `DEPS` field; freed
link records through `NEXT_DEP`; allocation pops the free list before
bumping. `free(node)` unlinks edges immediately but parks the record on a
pending list — records return to the free lists only at a boundary when the
policy effect queue is empty, so a queued reaction or in-flight walk can
never see a recycled id. `GEN` increments on the actual free; policy
snapshots `gen(node)` in disposers and checks it before acting, making
stale disposers no-ops.

**Who frees what (policy side).**

- Effects/watchers: freed by their disposer (hook unmount, `dispose()`).
- Atoms and computeds: owned by user-held objects. Policy registers every
  `Atom`/`Computed`/`ReducerAtom` with a `FinalizationRegistry`; when the
  user drops the last reference, the registry callback frees the kernel
  records (both kernels) and recycles the policy handle. This closes the
  known leak documented in the donor kernel ("dropping the last reference
  to a signal/computed handle leaks its record"). Finalization latency is
  acceptable because unreferenced records cost only arena slack, not GC
  pressure; tests force `gc()` to verify reclamation (§12).
- K1 wholesale: when the last deferred batch retires and no render pass is
  pinned, policy **bulk-resets** K1 — bump pointer back to the first
  record, free lists cleared, `k1Epoch` incremented. Policy-side `id1`
  fields are invalidated *lazily* by comparing their stored epoch against
  `k1Epoch` (§7.6), so the reset itself is O(1) plus clearing K1's pending
  lists. The arena never shrinks; a transition-heavy session converges to
  a steady K1 size and reuses it with warm JIT feedback.

### 6.7 Kernel stamping: one kernel per world, and the traced stamp

V8 records type feedback per closure instance, but *optimized code* can be
shared across closures of one function literal — and context specialization
(embedding a specific closure's constants, which the growth strategy relies
on) is only guaranteed profitable when a function literal has effectively
one live instance. Rather than gamble, the build **stamps** the kernel
template into textually separate factories:

- `kernel.k0.ts` → `createKernel0` — the base-world kernel;
- `kernel.k1.ts` → `createKernel1` — the head-world kernel;
- `kernel.traced.ts` → `createKernelTraced` — every state transition emits
  an integer event (§9); built into the tracing chunk, loaded lazily.

Each stamp has its own function literals → own feedback vectors, own
compiled code, own embedded buffer base. K0's ICs never see K1's usage
pattern; enabling tracing never deoptimizes the production stamps. The
stamps are generated by `scripts/stamp-kernel.ts` from
`kernel.template.ts` (a ~40-line text transform: rename exports, optionally
inline literals, splice trace emits at marked points); CI regenerates and
diffs to keep stamps honest (§12, §16).

Swapping a live kernel to its traced stamp reuses the growth machinery:
at an operation boundary, rebuild the kernel functions from the traced
factory **over the same buffers and counters**. Tracing can therefore be
attached to a running app without restarting it, and detached the same way.

### 6.8 Kernel invariants

Checked by `__DEV__` assertions and the conformance suite; documented here
because humans maintain this file.

1. Record 0 is never allocated; field reads of id 0 are undefined behavior
   guarded by callers' `!== 0` checks.
2. Every allocated record is reachable as exactly one of: a live node
   (`FLAGS & LIVE`), a live link (present in both of its lists), a
   free-list member, or a pending-free member. (The invariant sweeper walks
   the plane in dev builds and proves partition.)
3. A link's `DEP`/`SUB` always name live nodes; unlink precedes any free.
4. Edge-list order is preserved by all operations (order carries re-track
   and nested-reaction semantics; tombstone-free removal is safe only
   because lists are doubly linked — no swap-remove).
5. `propagate` runs no user code; `checkDirty`/refresh may re-enter the
   kernel but always restore scratch-stack bases and the tracker
   (try/finally on the host-callback brackets only — the walks themselves
   are finally-free by construction).
6. `enterDepth === 0` ⇔ no kernel frame holds the current buffers ⇒ only
   then may rebuild/sweep run.
7. `ARMED` is cleared exactly at notify and set exactly at
   alloc/poll(false)/endTrack/setWatcher(true): at most one notify per
   watcher per stale period.
8. The kernel never calls `host.*` while holding partially-updated list
   pointers (callbacks fire only at consistent states).
9. Kernel functions marked `@inline-budget` in the template must stay under
   460 bytecodes (CI-measured); `link`'s fast path under 200.

---

## 7. The policy tier

<a name="7-the-policy-tier"></a>

Everything above the kernels: ordinary TypeScript with GC-managed objects,
free to use maps, promises, and user callbacks — because none of it executes
inside a kernel walk. Policy's own hot paths follow a monomorphism
discipline (§7.11), but a mistake here degrades *policy* ICs only; the
kernels are unpollutable from above (§4.3).

### 7.1 The policy node table and handles

Every user-visible signal object (Atom, ReducerAtom, Computed) and every
internal subscriber (hook watcher, signal-effect, core effect) is backed by
**one policy node** — a plain object of a single hidden class, constructed
by one factory that initializes every field in a fixed order:

```ts
type PNode = {
  kind: number;        // NK_ATOM | NK_REDUCER | NK_COMPUTED | NK_WATCHER | NK_EFFECT (smi)
  pf: number;          // policy flag bits: QUEUED, SUSPENDED0/1, ERROR0/1, HAS_LIFECYCLE, OBSERVED, ...
  handle: number;      // this node's index in the `nodes` table (== kernel HANDLE field)

  id0: number;         // K0 node id (0 until allocated; atoms/computeds allocate eagerly)
  gen0: number;        // K0 generation snapshot, guards against stale ids after free
  id1: number;         // K1 shadow id; meaningful only while epoch1 === k1Epoch (§7.6)
  epoch1: number;

  // Values. For atoms: `pending` is the newest base-world write, `base` the
  // last kernel-confirmed base value (the two-slot dance that preserves
  // exact change cutoffs); `head` mirrors that for the head world while
  // forked; `floor` is the value from before the oldest retained log entry.
  // For computeds: `base`/`head` are the cached results per world
  // (`pending`/`floor` unused).
  pending: unknown;
  base: unknown;
  head: unknown;
  headPending: unknown;
  floor: unknown;

  log: LogEntry[] | undefined;      // atoms only; exists only while it must (§7.4)

  fn: Function | undefined;         // computed fn / reducer / effect body / watcher callback
  isEqual: ((a: unknown, b: unknown) => boolean) | undefined;

  aux: PNodeAux | undefined;        // cold state, allocated on demand, single shape
  label: string | undefined;
};

type PNodeAux = {
  lifecycle: Function | undefined;      // atom observed-effect (R1)
  cleanup: (() => void) | undefined;    // pending lifecycle/effect cleanup
  err0: unknown; err1: unknown;         // error or suspension record per world
  useCache0: unknown[] | undefined;     // positional ctx.use caches per world (§7.7)
  useCache1: unknown[] | undefined;
  parent: PNode | undefined;            // effect nesting (§7.9)
  children: PNode[] | undefined;
  passMemo: unknown;                    // per-pass overlay slot (§7.4), keyed by pass identity
  passMemoKey: unknown;
};

const nodes: (PNode | undefined)[] = [];   // dense; index == handle
const freeHandles: number[] = [];
```

The `handle` is what the kernel stores in its `HANDLE` field and passes back
in every callback, so `host.refresh(node, handle)` reaches the policy node
with **one dense-array load** — no Map, no id→object hash — and the same
handle works for both kernels (K0 and K1 records of one signal share the
policy node). Public classes (`Atom` etc.) are thin: they hold the `PNode`
reference and forward; a `FinalizationRegistry` registered on the public
object frees kernel records and recycles the handle when users drop it
(§6.6).

### 7.2 Values, equality, and the `refresh` callback

Each kernel gets its own host object at startup; both delegate to shared
world-parameterized helpers, but each `host.refresh` is a distinct closure
so each kernel's call site stays single-target:

```ts
const host0: KernelHost = {
  refresh: (id, h) => refreshNode(nodes[h]!, /*world*/ 0),
  notify: (id, h) => notifyNode(nodes[h]!, 0),
  watched: (id, h) => observedChanged(nodes[h]!, true),
  unwatched: (id, h) => observedChanged(nodes[h]!, false),
};
// host1: same shape, world 1; watched/unwatched from K1 are ignored for
// lifecycle (shadow subscriptions are transient; §7.8).

function refreshNode(n: PNode, world: 0 | 1): boolean {
  switch (n.kind) {
    case NK_ATOM:
    case NK_REDUCER: {
      // Source fold: confirm the pending write for this world and report
      // whether the confirmed value really changed (the write cutoff).
      const prev = world === 0 ? n.base : n.head;
      const next = world === 0 ? n.pending : n.headPending;
      const changed = n.isEqual === undefined
        ? !Object.is(prev, next)
        : !n.isEqual(prev, next);
      if (world === 0) n.base = next; else n.head = next;
      return changed;
    }
    case NK_COMPUTED:
      return evaluateComputed(n, world);   // §7.7 — tracked; never throws
    default:
      return true; // watchers/effects have no cached output; poll() callers re-run them
  }
}
```

`evaluateComputed` sets the module-level **evaluation context**
(`evalWorld`, plus the pass object when world = pass) so that every
`atom.state` / `computed.state` read inside the user function resolves in
the right world and registers the dependency in the right kernel. The
kernel has already bracketed this call with tracking (§6.4), so a read in
world 0 is: resolve value per §7.4, then `K0.pull(dep.id0)` — the pull both
verifies the dep and creates the edge.

Equality discipline: the `Object.is` default and the custom-`isEqual` call
are separate branches (the default path's IC never sees user closures);
custom equality runs once per actual recompute — a leaf, per §4.3.

### 7.3 Worlds: committed base, head, and pass views

Three worlds, defined precisely:

- **BASE** — the values produced by every *retired* write plus every
  pending **urgent** (non-deferred) write, applied in write order. This is
  what a fresh urgent render would show, and what non-React code sees.
  Rationale: React's sync/default updates always render promptly and are
  included in every subsequent render, so folding them into the base world
  eagerly matches React's own update-queue behavior.
- **HEAD** — BASE plus every pending **deferred** write, newest-wins. The
  optimistic "where the app is heading." Exists as a distinct world only
  while ≥1 deferred batch is live; this period is called **forked**, and
  `forked` is a module-level boolean.
- **PASS(p)** — what render pass `p` must see: writes whose batch retired
  before the pass began, plus writes belonging to batches the pass
  includes, both as of the pass's start. Formalized by the read rule below.

Staleness tracking: K0 tracks BASE; K1 tracks HEAD (while forked); PASS
views are resolved without a kernel (below). Value caches: `n.base`,
`n.head`, plus a per-pass memo.

**Where a read resolves** (the read context decision, in priority order):

1. **Inside a policy evaluation** (`evalWorld` set): that world. This keeps
   a whole recompute self-consistent.
2. **Inside a render pass** (the fork API says so, §8.1): the pass view —
   with two fast paths that cover almost all real passes:
   - the pass includes every live batch and no writes landed since its pin
     → identical to HEAD → use `K1.pull` + `n.head` (or BASE/K0 when not
     forked);
   - the pass includes no live batch and nothing retired since its pin
     → identical to BASE → `K0.pull` + `n.base`;
   - otherwise (a genuinely mixed or raced pass): the log-filtered read
     rule with the per-pass memo.
3. **Otherwise (event handlers, effects, benchmarks, server)**: HEAD if
   forked, else BASE. "Newest write wins" — reads between writes in a batch
   see fresh values (the benchmark contract).

### 7.4 The write log and the read rule

Per-atom, policy-level, and **existence-gated**: log entries are created
only when someone could tell the difference — while `forked`, or while any
render pass is active, or when the write itself is deferred. A benchmark
loop or a simple app between frames never allocates an entry (§4.5).

```ts
type LogEntry = {
  seq: number;       // global write ticket (monotonic module counter)
  batch: number;     // fork-API batch token (integer; 0 = no React batch)
  retired: number;   // 0 while the batch is pending; a fresh ticket at retirement
  value: unknown;    // for set(): the value          (fn === undefined)
  fn: Function | undefined; // for update()/dispatch(): the updater — stored,
                     // not evaluated, so each world can replay it (rebasing)
};
```

One global ticket counter (`seq`) gives every write and every retirement a
position on a single timeline. Each render pass records `pin = seq` at
pass start.

**The read rule** (for an atom read in PASS(p); this is the concurrency
heart, mirrored from React's own hook-update-queue semantics): return the
value of the newest log entry that satisfies either clause —

1. *Already part of the past when the pass began*: `retired !== 0 && retired <= p.pin`;
2. *Brought along by this pass*: `p.included.has(batch) && seq <= p.pin`;

— replaying `fn` entries in write order among the qualifying set; if no
entry qualifies, the atom's `floor` value (its value from before the oldest
retained entry). Clause 2 is React's lane-filtering rule for queued
`setState` updates; the `<= pin` conditions mirror React hiding updates
that arrive mid-render from the in-progress render; clause 1 using the
*retirement* time (not write time) is what keeps a yielded-and-resumed pass
consistent when an unrelated root commits during the yield.

**Computeds in a mixed pass** use a per-pass memo: `n.aux.passMemoKey`
holds the pass object, `n.aux.passMemo` the computed result; on a memo
miss, policy evaluates the computed with `evalWorld = PASS` (reads inside
resolve by the read rule recursively; dependent computeds memo the same
way). No kernel participates: no edges are built, no flags change, and the
memo dies with the pass. Render-pass evaluation rejects writes (§7.10), so
the memo cannot have side effects. Cost: at worst one recompute of the
reachable subgraph per mixed pass — accepted because mixed passes require
an urgent write racing a held-open transition (or two independent
overlapping transitions), which are rare, short windows; §14 budgets it.

**Sweeping.** After any retirement and after each pass ends: drop entries
whose batch retired at or before every active pass's pin (they are
represented in `base`/`floor`), advance `floor` accordingly, and delete the
log array when it empties. If no passes are active, this collapses to
"retire → fold → clear."

### 7.5 Batches, retirement, and rebasing

A **batch record** exists per fork-API token that has carried at least one
signal write:

```ts
type Batch = {
  token: number;       // integer from the fork API; LSB = deferred (§8.1)
  deferred: boolean;
  writes: PNode[];     // atoms written under this token (deduped)
  retired: boolean;
};
const batches = new Map<number, Batch>();   // small: live batches only
```

**Write paths** (`Atom.set/update`, `ReducerAtom.dispatch`):

```
classify: deferred = hasReactBindings && unstable_isCurrentWriteDeferred()
gate:     mustLog  = forked || anyPassActive || deferred

URGENT write (deferred = false):
  n.pending = value | fn(n.pending)              // two-slot base-world write
  if mustLog: append LogEntry (token = current batch or 0), register in batch
  K0.invalidate(n.id0, innerWrite)               // kernel does cutoff via refresh0
  if forked:                                     // urgent writes are in HEAD too
    n.headPending = value | fn(n.headPending)
    ensureShadow(n); K1.invalidate(n.id1, innerWrite)
  if !inBatch && !hasReactBindings: flushEffects()   // benchmark/core path

DEFERRED write:
  token = unstable_getCurrentWriteBatch()        // mints lazily, stable per batch
  if !forked: fork()                             // k1 becomes live (§7.6)
  append LogEntry; register in batch
  n.headPending = value | fn(n.headPending)
  ensureShadow(n); K1.invalidate(n.id1, innerWrite)
  // K0 untouched: the base world must not see this yet.
```

`K0.invalidate` → `host0.notify` reaches hook watchers synchronously in the
writer's context, so their `setState` calls inherit whatever priority React
gives the current event — that is the entire trick that makes signal writes
batch, prioritize, and entangle exactly like `useState` (§8.3). Same for
`K1.invalidate` inside a `startTransition` scope: the notified hooks call
`setState` inside the transition, so React schedules a transition render.

**Retirement** (fork API `onBatchRetired(token, committed)`, exactly once
per token):

1. Stamp `retired = ++seq` on the batch's entries.
2. For each written atom, **replay**: recompute the base value from `floor`
   forward over entries that are retired or pending-urgent, in `seq` order,
   applying `fn` entries functionally. Set `n.pending` to the result and
   `K0.invalidate(n.id0, false)` — the ordinary kernel cutoff decides
   whether anything downstream actually changed. Replay-in-order is what
   makes interleaved urgent/deferred functional updates land exactly as
   React's own update-queue rebasing would (worked example in §8.5); it
   also prevents an old transition from clobbering a newer urgent write.
3. Hook watchers notified by (2) run the **reconcile check** (§8.3): if the
   committed tree already rendered this batch's world (the normal
   transition commit), the hook's last-rendered value equals the new base
   value and no re-render is scheduled — folding is invisible.
4. Queue `useSignalEffect`s / core effects whose inputs' base values
   changed; flush on a microtask ("effects observe committed worlds only").
5. Sweep logs (§7.4). If this was the last live deferred batch and no pass
   is pinned: `unfork()` — bulk-reset K1, `k1Epoch++`, `forked = false`.

Updaters (`update`/`dispatch` functions) must be pure: an updater may run
once per world that includes it (head evaluation, pass replay, retirement
replay). This is the same contract React's `setState(fn)` imposes, tested
side-by-side with a real `useReducer` (§12).

**Batches spanning multiple roots** retire once, when the batch leaves the
*last* participating root's books; the fork API owns that bookkeeping
(commit vs. unmount-prune per root) and the policy tier sees exactly one
`onBatchRetired`.

### 7.6 Shadowing: how the head world gets its graph

K1 starts empty. Deferred staleness can only propagate along K1 edges, and
those edges must exist *before* the propagate reaches them — so the first
deferred write to an atom this fork-epoch copies the relevant subgraph in:

```
ensureShadow(n):                        // O(1) when already shadowed
  if n.epoch1 === k1Epoch: return
  n.id1 = K1.alloc(kernelFlagsFor(n.kind), n.handle)
  n.epoch1 = k1Epoch
  if computed: n.head = n.base          // head cache starts agreeing with base
  if atom:     n.headPending = n.pending

shadowSubtree(atom):                    // called once per atom per fork epoch,
  ensureShadow(atom)                    // before the first K1.invalidate on it
  for each K0 subscriber edge (dep -> sub) reachable from atom
      (depth-first over K0.firstSub/nextSub, visiting each node once,
       skipping nodes already shadowed this epoch):
    ensureShadow(sub)
    K1.linkEdge(shadowOf(dep), shadowOf(sub))   // eager edges, no evaluation
```

Shadowed computeds are created **clean** (not dirty), with `head` seeded
from `base`: the subsequent `K1.invalidate` marks exactly the downstream
region possibly-stale, verification recomputes only what the deferred write
actually changes, and the equality cutoff works in the head world from the
first read. Shadowed watchers keep their explicit dependency edges, so
head-world notify reaches the same hooks base-world notify would.

Shadow maintenance while forked: whenever a computed re-tracks in K0 (its
`refreshNode(world 0)` ran) and it has a live shadow, policy re-syncs the
shadow's edges from the fresh K0 dependency list (`linkEdge` any missing;
extra stale edges are harmless — they can only cause a spurious verify,
never a wrong value — and the shadow's next head refresh trims them).
Watchers subscribing while forked shadow themselves at subscribe time. The
residual risk (a topology change whose K1 edge is missing exactly when a
deferred write needs it) is closed by the hook-level fixup protocol (§8.3)
and called out in §15.

Cost model: one subtree copy per newly-touched atom per fork epoch —
proportional to the propagate wave the write performs anyway, paid in
arena bulk allocations (the layout's strongest suit: measured 6× faster
record creation than object graphs). `unfork()` throws it all away in O(1).

### 7.7 Promises and suspense (`ctx.use`)

`evaluateComputed(n, world)`:

1. Reset the world's positional `use` cursor (`useCache0/1`).
2. Run `n.fn(ctx)` in a try/catch with `evalWorld` set.
3. `ctx.use(thenable)`: look up the cursor position in this world's cache;
   if the *same* thenable (or its cached settled state) is there, reuse —
   identity is stable across re-evaluations, which React's replay machinery
   requires. New thenables are stamped with `status/value/reason` handlers
   (the same convention React's `use()` uses, so promises can flow between
   cosignal and React unchanged). Fulfilled → return value; rejected →
   throw the reason; pending → throw the thenable itself.
4. Catch: a thrown thenable becomes a **suspension record**
   `{ thenable }` stored in `aux.errW` with the `SUSPENDEDw` bit; any other
   throw becomes an **error record** with `ERRORw`. Both count as "changed"
   (unless the previous state was the same record — suspensions compare by
   thenable identity, errors by `Object.is` of the thrown value). The
   function returns normally: **a throwing user getter can never corrupt
   kernel flags**, which repairs a known hazard class in alien-signals.
5. On success, clear the bits, compare with the world's previous value via
   the §7.2 equality discipline, store, return changed.

Reads of a suspended computed: during render, the hook re-throws through
React's `use(thenable)` (conditional `use` is legal; React owns retry and
fallback — §8.3). Outside render (core `.state`, effects): the read throws
the suspension's thenable for callers that opt in, and policy attaches a
settle listener that `K.invalidate`s the computed in the world(s) that hold
the suspension when the promise resolves — watchers get a fresh notify and
re-render/re-run then. (Kernel note: `invalidate` on a DERIVED node is
legal and is exactly "force this to re-evaluate and tell dependents"; §6.3.)

### 7.8 Atom observed-lifecycle effects

`AtomOptions.effect` (R1) runs when the atom becomes observed and its
cleanup when it stops. "Observed" means: some watcher — a mounted hook, a
signal-effect, or a computed that is itself transitively watched — reaches
it. That is precisely K0's subscriber-list emptiness, delivered by
`host0.watched`/`host0.unwatched` (K1 shadows deliberately do not count:
a transition previewing an atom is not a subscription).

Delivery is deferred to a microtask with flap damping: `watched` followed
by `unwatched` in the same tick nets to nothing, so remounting components
or re-tracking computeds never thrash a remote subscription. The lifecycle
callback receives `AtomCtx` (`get`/`set` on the atom, untracked); its
returned cleanup is stored in `aux.cleanup` and run on the unobserve edge
or at atom finalization.

### 7.9 Core effects and scheduling

For non-React consumers (and the benchmark adapter): `effect(fn)` allocates
a `NK_EFFECT` policy node + a K0 `WATCHER` record, runs `fn` once tracked
(`beginTrack`/`endTrack`), and returns a disposer (gen-checked, §6.6).

- `host0.notify` pushes the node onto a policy queue if its `QUEUED` bit is
  clear (sets it).
- Flush points: end of the outermost `batch()`; after any top-level write
  when React bindings are absent (synchronous flush — the benchmark
  contract); after retirement folds when they are present (effects observe
  the base world only).
- Flush loop: pop; clear `QUEUED`; `if (K0.poll(id0))` re-run: dispose
  children (nested effects re-register during the run), run stored
  `cleanup`, `beginTrack`, run `fn`, `endTrack`, store new cleanup. `poll`
  returning false re-arms and costs one verification walk — exact lazy
  semantics, no spurious re-runs.
- Nesting: `aux.parent`/`aux.children` reproduce alien-signals' "outer
  effect re-run disposes and recreates inner effects" semantics in policy;
  a queued child that was disposed by its re-running parent is skipped by
  its generation check. Ordering (parents before children) follows from
  disposal-then-recreate, matching the conformance suite's nested-effect
  ordering cases.
- Effect errors: caught, reported via `reportError`/global hook, flush
  continues; the failed effect stays subscribed with its last-good deps
  (kernel `endTrack` ran in a finally).

`useSignalEffect` shares `NK_EFFECT` machinery but schedules on the React
side (§8.4): notify marks it; the run happens after commit, and only for
base-world changes.

### 7.10 Writes inside computeds, cycles, and configuration

- Default: a write during computed evaluation is **tolerated** if it
  creates no dependency cycle. Mechanism: the write's `invalidate` runs the
  kernel's re-entrancy ladder (`RECURSED`/`RECURSED_CHECK` + `isValidLink`)
  — a propagation that reaches the currently-evaluating node, or a read of
  a node currently evaluating, raises the kernel's cycle error (the one
  non-memory error the kernel throws; §6.3). Policy wraps it with labels
  and the evaluation stack for a readable diagnosis. Effect flushes are
  deferred while any evaluation is running.
- `configure({ forbidWritesInComputeds: true })`: the policy write path
  throws immediately whenever `evalWorld` is set for a computed evaluation
  — writes never reach a kernel.
- **Render-pass evaluation always rejects writes** regardless of
  configuration: React may replay or discard a render, so a pass-world
  evaluation (§7.4 memo, or any `.state` read served during render) must be
  pure. Policy checks "am I evaluating for a pass?" — one boolean.
- Signal-only reaction loops (effect writes atom → effect re-runs) are
  bounded by a policy re-entrancy budget on the flush loop (default 100
  iterations, then throw with the cycle's labels) — mirroring React's
  nested-update limit philosophy for the no-React case (§8.6 covers the
  React-integrated limits).

### 7.11 The monomorphism discipline

Rules the policy tier's own hot paths follow (reviewed in CI by the
bytecode/IC harness, §12):

1. **One hidden class per table.** All `PNode`s from one factory; all
   `PNodeAux` from one factory; all `LogEntry`s literal-constructed with
   all five fields. No conditional property adds, ever.
2. **Kind is data, not shape.** Behavior varies by `switch (n.kind)` on a
   small integer, in one function per concern (`refreshNode`,
   `notifyNode`, `readNode`) — call sites stay single-target; branches are
   cheap and predictable.
3. **User functions run at leaves only** (computed fn, reducer, isEqual,
   effect bodies, lifecycle callbacks): once per actual recompute/re-run,
   never per graph step. Their call sites are expected-megamorphic and
   deliberately isolated in tiny wrapper functions so the pollution cannot
   spread into the dispatchers.
4. **Default paths never share ICs with custom paths**: `Object.is` vs
   `isEqual`, log-free vs logged reads, unforked vs forked writes each
   split before the polymorphic operation, not after.
5. **No allocation on steady-state paths**: no closures in write/read/flush
   loops; the pass object is allocated once per render pass; tokens,
   tickets, handles are numbers.
6. **`null` appears in exactly one place** — the lazy tracer slot (§9),
   because `tracer !== null` compiles to a pointer compare with no
   undefined-hole subtleties; everywhere else optionality is `undefined`
   per E1.

---

## 8. React integration

<a name="8-react-integration"></a>

### 8.1 The React fork API (redesigned, integer tokens)

**What exists and why.** React's public API cannot tell an external store
three things it must know to participate in concurrent rendering: (1) which
batch a write issued *right now* belongs to, (2) which batches the render
pass currently executing includes, and (3) when a batch's updates leave
React's books. A prior iteration of this project built exactly that as a
fork: an `unstable_externalRuntime` channel following React's established
`ReactSharedInternals` renderer-registration pattern (the reconciler fills
provider slots at module init; isomorphic code reads them), with opaque
*object* tokens for batches and container objects for roots, plus a
DOM-mutation window. That patch surface is proven (a reconciler-level test
suite exists for the token protocol, including async-action parking,
per-root commit lock-in, and pruned-vs-committed batch roots) and is the
semantic baseline. Variant D **redesigns the wire format around integers**
while keeping the registration pattern and hook placement.

**Why integers.** Lane bits (React's internal priority masks) are recycled,
so exposing them would alias different batches over time — that is why the
original design minted opaque objects. But object tokens force a
`Map<object, Batch>` hop and an allocation per batch on the userspace side.
A **monotonic integer mint** gives identity-that-never-aliases with none of
that: 53-bit integer space cannot plausibly overflow (at one batch per
microsecond, ~285 years), comparison is `===` on smis for the first 2³¹
batches, tokens index a plain `Map<number, Batch>` (or array), and nothing
allocates. Roots are likewise announced with a small integer `rootId`
(minted per root at first render) alongside the container object where the
consumer genuinely needs it (the MutationObserver use case).

**Encoding.** `token = (mintCounter++ << 1) | (deferred ? 1 : 0)` — the low
bit classifies the batch for its whole life (a batch's priority class is
fixed at mint), so `isBatchDeferred(token)` is `(token & 1) === 1` with no
lookup on either side of the boundary. Token `0` is reserved for "no React
batch" (a write outside any React context).

**The full surface** (package `react`, all `unstable_`-prefixed):

```ts
// ---- subscription (isomorphic; reconciler registers a provider internally)
type ExternalRuntimeListener = {
  /** A render pass began on rootId. `includedBatches`: tokens of every live
   * batch this pass renders. A pass spans yields; it ends by completing or
   * being discarded — both fire onRenderPassEnd. Listener errors are
   * reported like uncaught errors and never corrupt the commit. */
  onRenderPassStart?: (rootId: number, includedBatches: readonly number[]) => void;
  onRenderPassEnd?: (rootId: number) => void;
  /** Exactly once per token, when the batch's updates leave React's books.
   * `committed` is false only for batches that never produced React work.
   * For a batch spanning several roots, fires after the LAST participating
   * root commits or prunes it (a root that committed keeps including the
   * token while others remain pending — its committed tree already shows
   * that world; an unmount only prunes, never locks in). */
  onBatchRetired?: (token: number, committed: boolean) => void;
  /** DOM mutation window, §8.2. Container passed for MutationObserver use. */
  onBeforeMutation?: (rootId: number, container: unknown) => void;
  onAfterMutation?: (rootId: number, container: unknown) => void;
};
function unstable_subscribeToExternalRuntime(l: ExternalRuntimeListener): () => void;

// ---- queries (allocation-free on every hot path)
/** 0 outside render; the rendering root's id during a render pass. */
function unstable_getRenderContext(): number;
/** Would a write issued right now join a deferred (transition-like) batch?
 * Pure classification; mints nothing. The policy tier's log gate (§7.4)
 * runs on this before ever asking for a token. */
function unstable_isCurrentWriteDeferred(): boolean;
/** Token of the batch a write issued right now belongs to (minted lazily on
 * first use, stable for the batch's life). 0 if none. */
function unstable_getCurrentWriteBatch(): number;
/** The container object for a rootId (for MutationObserver bookkeeping). */
function unstable_getRootContainer(rootId: number): unknown;
```

**Boundary rules (the "no leakage" contract).**

- No Fiber objects, no lane bitmasks, no update-queue internals cross the
  boundary — only minted integers and (for the DOM window) the container
  the caller already owns. The reconciler-side registry maps its internal
  lanes/roots to tokens/ids privately and can change its internals freely.
- Concurrency safety of integer tokens: minting is confined to React's
  single-threaded work loop (same discipline the object registry already
  required); tokens are never reused; the deferred bit is immutable; and
  because tokens are values (not references), retaining one can never
  retain React memory — strictly safer than object tokens on that axis.
- Everything is inert until the first listener subscribes: with no
  listener, each hook site costs one property read + branch.
- Each reconciler hook site documents its invariant in place ("fires after
  X, before Y"), the two known-delicate ones being: batch retirement must
  distinguish committed and pruned roots per token, and pending edges
  created by setState-*before*-store-write ordering must still be repaired
  (both have dedicated reconciler tests in the baseline fork; the redesign
  keeps those tests, re-typed to integers).
- Multiple renderers: the first registered provider answers write/render
  queries (only one renderer renders at a time on a thread); token spaces
  are per-provider but namespaced by the mint being global. Documented
  best-effort limitation, unchanged from the baseline.

**Build**: `scripts/build-react.sh` → `build/oss-experimental/*`, linked by
pnpm overrides; rebuilding React does not require reinstalling the app.

### 8.2 The DOM mutation window

Unrelated to signals but part of the same registry (R12): applications that
run their own `MutationObserver` need to ignore React's own DOM writes.
`onBeforeMutation`/`onAfterMutation` bracket exactly React's commit
mutation phase. Placement matters and is inherited from the baseline fork:
the hooks live inside the reconciler's `flushMutationEffects` — not
`commitRoot` — because with View Transitions the mutation phase runs later,
inside the browser's `startViewTransition` update callback; bracketing
`commitMutationEffects` + `resetAfterCommit` there covers every commit path
(including `flushSync`) and fires only when mutations will actually occur.
Documented exceptions (caller filters if it cares): the layout-phase
`<img src>` reassignment, suspensey-CSS `<link>` insertion, imperative
Float APIs (`preload`/`preinit`), View Transition name attributes, and user
effect code.

### 8.3 `useSignal`

The one hook that closes the loop. Anatomy (per hook instance):

- **State**: `const [, bump] = useState(0)` — a version counter whose only
  job is to make React re-render this component. Plus a ref holding the
  hook's watcher `PNode` and its `lastRendered` value.
- **Render (read)**: resolve the signal's value with the current render's
  read context (§7.3 — the fork API supplies rootId → policy's pass record
  supplies pin + included batches). A component *mounting inside a
  transition render* therefore reads the pending world directly — no queued
  update needed, no double render, and the mount-mid-transition case that
  is a known bug in react-concurrent-store just works (R6 test). Record
  `lastRendered`. If the value is a suspension record, call React's
  `use(thenable)` — conditional `use` is legal — so React owns the retry;
  the per-world positional cache (§7.7) keeps the thenable identity stable
  across React's replays.
- **Subscribe** (layout effect, so it precedes paint): allocate the watcher
  node (`NK_WATCHER`, kernel `WATCHER` flag) if needed, `K0.linkEdge(dep,
  watcher)` (+ shadow into K1 when forked, §7.6), with
  `fn = () => bump(v => v + 1)`. From then on: kernel notify → `bump()`
  runs synchronously in the writer's context → React assigns the writer's
  priority — transition writes schedule transition renders, event-handler
  writes schedule urgent renders, and React's batching/entanglement apply
  to signal updates exactly as to `useState`. Graph-level equality cutoffs
  (§7.2) mean no notify — hence no render — when a write doesn't change
  this node's output in the relevant world.
- **Post-subscribe fixup** (same layout effect; the race window is
  render-to-subscribe): compare `lastRendered` against the current base
  value — if a write landed in the gap, `bump()` now (pre-paint
  correction); and against the head value when forked — if a deferred write
  landed, `bump()` inside `startTransition` so the correction joins the
  pending batch. This is the standard subscribe-then-recheck protocol,
  needed only in race windows, not on every mount.
- **Reconcile check** (the retirement path, §7.5 step 3): the notify
  triggered by a fold calls the watcher's reconcile function instead of
  bumping blindly — if `lastRendered` equals the new base value (the
  normal case: the committed tree was rendered from exactly this world),
  no re-render is scheduled. Folding a transition is invisible; only a
  watcher whose on-screen value genuinely differs re-renders.
- **Unmount**: dispose the watcher (kernel free, §6.6); K0's
  watched/unwatched edges drive atom lifecycle (§7.8).

### 8.4 `useAtom`, `useReducerAtom`, `useComputed`, `useSignalEffect`

- **`useAtom(options)` / `useReducerAtom(options)`**: a component-owned
  `Atom`/`ReducerAtom` held in a ref, created on first render (initial
  `state` read once, like `useState`), disposed on unmount. Returns the
  atom object — stable identity — which the component or its children read
  via `useSignal` or pass around.
- **`useComputed(fn, deps, options?)`**: a component-local `Computed` held
  by `useMemo`-style memoization, **recreated when `deps` change**
  (compared like `useMemo`). `fn` may close over props and state freely —
  that is exactly what `deps` is for; signal reads inside `fn` are
  auto-tracked by the graph, so the hook re-renders on signal changes even
  with `deps` unchanged. The returned value is read like `useSignal` on
  the local node (same subscribe/fixup/suspense protocol). This is the
  answer to "closure variety" at the React layer: each component instance
  gets its own computed node, but all of them are `NK_COMPUTED` policy
  nodes whose evaluation runs at leaves.
- **`useSignalEffect(fn, deps?)`**: passive effect. Runs `fn` tracked after
  commit; re-runs when `deps` change (React pathway) or when a tracked
  signal's **base-world** value changes (the graph queues it during
  retirement folds / urgent flushes and runs it after the corresponding
  commit, matching `useEffect`'s after-commit timing). Cleanup like
  `useEffect`. Head-world changes never run effects: effects observe
  committed worlds only.
- **`useSignalTransition` / `startSignalTransition`**: sugar —
  `startTransition` + a core `batch()` so a burst of signal writes
  propagates once. Semantically equivalent to plain `startTransition` with
  writes inside; provided because the brief allows an optional batching
  helper for performance.

### 8.5 Transitions end to end: a worked example

`count` atom = 1. A transition runs `count.update(x => x + 1)` (deferred
batch D, token `0b…1`); while D is still pending, a click handler runs
`count.update(x => x * 2)` (urgent batch U).

| # | Event | Kernel/policy action | What each world now reads |
| --- | --- | --- | --- |
| 1 | deferred write `+1` | fork; log `[+1 @D]`; `headPending = 2`; shadow; `K1.invalidate` → transition-lane `bump()`s | BASE 1 · HEAD 2 |
| 2 | urgent write `×2` | log `[+1@D, ×2@U]`; `pending = 2` (×2 over base 1); `headPending = 4` (×2 over head 2); `K0.invalidate` + `K1.invalidate` | BASE 2 · HEAD 4 |
| 3 | urgent render (includes U, not D) | pass fast-path = BASE → `K0.pull` → refresh folds base to 2 | screen shows 2; transition still invisible ✓ |
| 4 | U retires (commit) | replay: floor 1 → `×2` (D excluded from base… D pending) → base 2; entries for U stamped retired | BASE 2 · HEAD 4 |
| 5 | transition render (includes D) | pass fast-path = HEAD → `K1.pull` → head 4 | prepared tree shows 4 = `+1` then `×2` ✓ |
| 6 | D retires (commit) | replay in write order: floor 1 → `+1` → `×2` = **4**; `K0.invalidate`; reconcile: hooks last rendered 4 → no re-render; unfork, K1 reset | BASE = HEAD = 4 |

Step 6's replay is the rebase: the transition's `+1` applies *first* (its
write-order position), the urgent `×2` on top — final 4, exactly what two
queued `setState` updaters produce in React, even though the urgent write
committed to the screen first. A mixed pass (e.g. React re-rendering the
urgent world *while* D is also live and a third write raced the pass's
start) falls off the fast paths into the §7.4 read rule + pass memo — same
answers, computed per-atom instead of per-kernel.

### 8.6 Infinite-loop protection, multiple roots, SSR and hydration

- **Infinite loops** (R7): every component re-render flows through a real
  `setState`, so React's own guards apply verbatim — update-depth
  protection for commit-phase loops (`NESTED_UPDATE_LIMIT` = 50) and
  render-phase re-render limits (= 25). Effect→write→effect loops that
  never touch React hit the policy flush budget (§7.10). Nothing to patch:
  riding React's machinery here was a design goal of the setState-based
  notify path.
- **Multiple roots** (R9): all fork events carry `rootId`; policy keeps one
  pass record per root (only one pass executes at a time per thread, but
  pins are per-pass); batch retirement is once-per-token across roots
  (§8.1). No `<Provider>` needed.
- **SSR** (R10): on the server the React entry point never registers fork
  listeners; reads resolve BASE, no subscriptions form, no atom lifecycle
  runs. Apps serialize atom state (a documented recipe + `snapshotAtoms` /
  `restoreAtoms` helpers over labeled atoms), ship it, and initialize atoms
  before `hydrateRoot`; hydration renders from identical base values, so
  markup matches. No `getServerSnapshot` analogue is needed — reads are
  plain property loads.

---

## 9. Tracing and visualization

<a name="9-tracing-and-visualization"></a>

### 9.1 Architecture: the policy tier is the choke point

A payoff of the minimal-kernel split: **every semantically meaningful
event already passes through policy** — writes, refreshes (with their
changed/unchanged verdicts), notifies, watched/unwatched edges, batch
lifecycle, pass lifecycle, effect runs, suspensions. The tracing module
therefore instruments policy only; the production kernel stamps contain
zero tracing code (not even null checks).

- `cosignal/tracing` is lazily loadable. Loading it sets the module-level
  slot `tracer` (the codebase's one `null`-typed variable, §7.11) and every
  policy emit site is `tracer !== null && tracer.emit(...)` — one pointer
  compare when disabled, nothing at all in the kernel.
- **Event schema**: every event has `id` (monotonic int), `time`
  (`performance.now()`), `cause` (the id of the event that provoked it),
  and a type-specific payload of integers/handles/labels. Types:
  `atom-write` (atom, batch, seq, world, deferred), `invalidate`,
  `notify`, `refresh` (node, world, changed, durationMicros), `pull`,
  `poll`, `effect-run`, `lifecycle` (watched/unwatched), `batch-created`,
  `batch-retired` (committed), `fold` (atom, oldBase→newBase),
  `render-pass-start` (rootId, includedBatches, pin), `render-pass-end`,
  `render-read` (hook, node, value world), `suspend`, `settle`, `shadow`,
  `unfork`, `kernel-grow`, `kernel-sweep`.
- **Causality**: a module-level `currentCause` id is set around each
  emitting operation (write → its propagation's notifies carry the write's
  id as `cause`; a refresh caused by a pull carries the pull's id; a
  React re-render's `render-read` events carry the notify that scheduled
  it, threaded through the hook's watcher). Helpers walk cause chains to
  answer R11's questions directly: `whyDidRecompute(computed)`,
  `whyDidRender(componentLabel)`, `runCount(effect)`.
- **Storage**: ring buffer (capacity a finite non-negative integer;
  capacity 0 keeps the live subscription stream without retaining history)
  plus a subscribe API for the future devtools timeline extension.

### 9.2 The traced kernel stamp

For kernel-internal forensics (exact flag transitions, ladder decisions,
link churn), `createKernelTraced` (§6.7) emits low-level integer events
(`flags-transition`, `link`, `unlink`, `stack-depth`) into the same ring
via a preregistered sink. Attaching it is an operation-boundary rebuild
over the live buffers; detaching likewise. This keeps R11's "full
visibility" honest without making the production kernel pay even a null
check.

### 9.3 Graphviz renderers (`cosignal/graphviz`)

Emits Graphviz DOT source (render with `dot -Tsvg`; DOT tolerates graph
sizes that break Mermaid). Strict layering: `tracing` records without any
visualizer code; `graphviz` imports only *types* from tracing.

- `dependencyGraphToDot(signals)`: snapshot of the live graph reachable
  from the given signals via the kernel iteration API (§6.3) — atoms,
  computeds, watchers with labels/kinds from policy nodes; per-world value
  summaries and dirty/pending flags while forked; K1 shadow edges drawn as
  a distinct style so a forked graph is visibly two-layered.
- `traceToDot(events, filter?)`: the causal graph (write → invalidate →
  notify → render/effect chains), filterable by event type, time range, or
  node.

---

## 10. Where every requirement lands (placement table)

<a name="10-placement-table"></a>

The variant's thesis in one table: the kernel row count is tiny and closed;
everything a product engineer would ever ask for is policy or fork.

| Requirement | Kernel | Policy | React bindings | Fork | Why there |
| --- | :-: | :-: | :-: | :-: | --- |
| Dependency tracking, staleness, exact recompute order | ● | | | | The hot walks; must be packed & monomorphic (§4.3). The only row that is pure kernel. |
| Atom/ReducerAtom/Computed classes, `set`/`update`/`dispatch` | | ● | | | Value semantics = policy; kernel sees `invalidate`/`refresh` facts only. |
| Equality (`isEqual`, `Object.is` cutoffs) | | ● | | | User closures must never enter kernel ICs; decisions return as one boolean (§7.2). |
| Concurrency: worlds, write log, read rule, rebasing | | ● | | | Multi-versioning is policy by definition here; kernel gets one extra *instance*, not one extra concept (§4.4, §7.3–7.5). |
| Batch identity & lifecycle | | ● | | ● | Fork mints integer tokens (§8.1); policy keeps the batch records. |
| Promises / suspense (`ctx.use`) | | ● | ● | | Thenable protocol is value policy (§7.7); rethrow-through-`use` is a binding concern (§8.3). |
| Atom observed-lifecycle `effect` | | ● | | | Driven by kernel watched/unwatched *facts* (§7.8). |
| Effect queue & flush timing | | ● | ● | | "When reactions run" is scheduling policy (§7.9); passive-effect timing rides React (§8.4). |
| Hooks (`useSignal` …) | | | ● | | Hook protocol, fixups, reconcile check (§8.3–8.4). |
| Transitions / `startTransition` parity | | ● | ● | ● | Fork classifies writes; policy logs/rebases; bindings put `bump()` in the writer's context (§8.5). |
| Infinite-loop rejection | | ● | ● | | React's own guards via real setState; policy budget for signal-only loops (§8.6). |
| Writes-in-computeds toleration + forbid switch | ● | ● | | | Cycle *detection* is graph mechanism (re-entrancy flags); the *policy choice* to forbid is configuration (§7.10). |
| Multiple roots, SSR/hydration | | ● | ● | ● | rootIds from fork; recipes in bindings (§8.6). |
| Tracing & causality | ● (traced stamp only) | ● | ● | | Policy is the natural choke point (§9.1); kernel forensics via swap-in stamp (§9.2). |
| Graphviz renderers | | ● | | | Read-only iteration API + labels (§9.3). |
| DOM mutation window | | | | ● | Pure React-commit concern (§8.2). |
| Growth & reclamation | ● | ● | | | Kernel: free lists, rebuild, generations. Policy: FinalizationRegistry, unfork resets — lifetime *policy* (§6.6). |
| Labels | | ● | | | Debug metadata; never on a hot path. |

The kernel stays closed because nothing in the left column changes when a
new product feature arrives: new node behaviors are policy `kind`s; new
scheduling is policy; new React semantics are fork facts. The kernel would
change only if the *graph algorithm itself* changed — and that is exactly
the code one wants frozen, proven, and monomorphic.

---

## 11. Memory footprint and byte budgets

<a name="11-memory-footprint"></a>

Defaults (all configurable via `configure({ initialKernelRecords })` /
`COSIGNAL_KERNEL_RECORDS` env for tests):

| Region | Default size | Notes |
| --- | --- | --- |
| K0 plane | 16,384 records × 32 B = **512 KiB** | Nodes + links interleaved; doubles on watermark (≥1,280 records + half-plane slack kept free). |
| K0 scratch stacks | 2 × 16 KiB | Propagate/verify stacks; double on demand. |
| K1 plane | 4,096 records × 32 B = **128 KiB** | Allocated lazily at first fork; never shrinks; bulk-reset per unfork. |
| K1 scratch stacks | 2 × 16 KiB | Lazily with K1. |
| Policy `nodes` table | 8 B/slot (pointer) | Dense, recycled via `freeHandles`. |
| One `PNode` | ~120–160 B on V8 (17 fields + header) | One per signal/watcher/effect; `aux` (~90 B) only for nodes that need cold state. |
| One `LogEntry` | ~56 B | Exists only while observable (§7.4); swept aggressively. |
| Batch record | ~100 B + writes array | Live batches only; typically 0–2 alive. |
| Tracing ring | user-set capacity × ~120 B | Zero when tracing not loaded. |

Sizing arithmetic for review: a 10,000-signal app with 30,000 edges uses
40,000 records = 1.25 MiB of plane (after two growths from the default) +
~1.6 MiB of policy nodes — with the plane invisible to the GC's marking
phase, which is where object-graph signal libraries pay their long-tail
cost (measured on the donor kernel: −38% retained heap on effect-heavy
workloads, zero GC events on deep-chain propagation vs. 23/run for the
object implementation).

Per-operation steady-state costs (no allocation): read = pull (verify walk
over `Int32Array`) + one or two policy property loads; write = equality
check + invalidate walk; re-render = those plus one `setState`. Allocation
happens at: node creation, first-time edges, fork shadowing, log entries
while observable, growth events.

---

## 12. Testing plan

<a name="12-testing-plan"></a>

### 12.1 Kernel (mechanism) tests

- **Model checking against a reference.** A ~150-line plain-object
  implementation of the same protocol (naive, obviously-correct) runs
  side-by-side with the kernel under randomized operation sequences
  (alloc/free/invalidate/pull/poll/track nests, biased toward re-entrancy
  and free-during-walk). Assert identical `refresh` call sequences (order
  and count — this is the exact-pull-count property), identical notify
  sets, identical final flags. Shrinking on failure.
- **Conformance**: the 179-case cross-framework reactive suite runs against
  a thin adapter (policy-lite: plain values, `Object.is`) over K0 — the
  donor kernel already passes it; the extraction must keep it at 179/179,
  including with `COSIGNAL_KERNEL_RECORDS=2` (growth stress on every
  allocation) and with forced sweeps between cases.
- **Bytecode/IC budget CI**: a harness compiles the stamps under Node with
  `--allow-natives-syntax`, asserts every `@inline-budget` function is
  under 460 bytecodes (`link` fast path < 200), asserts optimized-code
  status of the hot functions after warmup, and asserts monomorphic IC
  states on the kernel's property/call sites (`%GetFunctionFeedback`-style
  natives behind a version-pinned wrapper).
- **Invariant sweeper** (dev builds): after every conformance case, walk
  the plane and prove the §6.8 partition invariant.

### 12.2 Policy tests

- Write log & read rule: unit tests over synthetic batch/pass timelines
  (property: for every pass, the read rule result equals a from-scratch
  replay of qualifying entries — the naive spec is executable).
- Rebasing: the §8.5 table as a test; plus a side-by-side harness
  dispatching identical actions through a `ReducerAtom` and a real
  `useReducer` across a held-open transition with urgent interleavings —
  committed values must match at every step.
- Suspense: controlled thenables; identity stability across re-evaluation
  and across worlds; settle → invalidate → notify path.
- Lifecycle: observed/unobserved flap damping; FinalizationRegistry
  reclamation under forced GC (`--expose-gc`), asserting kernel records
  return to free lists and handles recycle.
- Shadowing: fork mid-graph, assert K1 subtree equals the K0 subtree
  reachable from written atoms; dynamic-dependency switches while forked
  re-sync edges; unfork resets and epoch-invalidates `id1`s.

### 12.3 React integration tests

Adopt the react-concurrent-store harness wholesale (vitest + jsdom + RTL;
transitions held open by controlled promises; render-order logging with
afterEach-empty assertions; inline DOM snapshots for tear checks;
listener-leak assertions) and its 14-scenario suite as the conformance
bar — **including making its known-bug case (sync mount mid-transition
with suspending head state) pass**. Plus: signal + React state lockstep in
one transition; interruption/rebase; multiple roots (batch spanning roots
retires once); `useComputed` over props + state + signals; `useSignalEffect`
re-run matrix (deps change vs signal change vs both); infinite-loop
rejection (both React limits and the policy budget); MutationObserver
window (observer sees app mutations, not React's); hydration parity.
Reconciler-level: the fork's existing batch-token test suite, re-typed to
integer tokens (mint monotonicity, LSB classification, async-action
parking, per-root commit lock-in, pruned-vs-committed retirement).

### 12.4 Contract tests for the protocol itself

The kernel/policy boundary gets its own suite: every `Kernel` function is
exercised against its §6.3 doc comment (e.g. "linkEdge is idempotent",
"poll(false) re-arms", "free defers until boundary with empty queue",
"gen changes exactly on actual free"). These are the tests that keep the
kernel swappable (variant A/B/C kernels of this research program could
implement the same protocol and reuse the entire policy tier and its
tests).

---

## 13. Benchmark plan

<a name="13-benchmark-plan"></a>

Methodology rules (hard-won; violating them produced misleading numbers in
prior rounds):

1. **One framework per process.** Same-process suite runs are order-biased
   and megamorphic — first-run numbers improve up to 3× vs late-run. Every
   published comparison is from single-framework child processes.
2. **Bundled children.** Benchmark through the same esbuild bundling as a
   real consumer (this is what exposed the const-demotion cliff);
   additionally run a transform-only (tsx) child to catch toolchain
   regressions in the const-enum strategy.
3. **Report medians + p99 + GC attribution** (Node ≥24:
   `PerformanceObserver({type:'gc', buffered:true})` with timestamp-window
   attribution), not just fastest-of-N — fastest-of-N hides GC and growth
   costs, which are exactly what arena designs trade.
4. **Checksum-verified work**: every shape validates its computation result
   so dead-code elimination can't fake a win, and pull-count assertions run
   in the harness (`testPullCounts: true` club).

Suites:

- **Tier-0 shapes** (fast iteration, ~0.4 s/framework): deep chain, broad
  fan-out, diamond, quiet reads, isolated writes, creation, scope
  create/dispose (arena bulk-free showcase), plus this variant's additions:
  **fork/unfork churn** (transition storm), **shadow-subtree cost** vs
  subtree size, **mixed-pass read rule** microbench.
- **milomg js-reactivity-benchmark** (primary ranking suite; kairo + cellx
  + dynamic + mol): adapter over core `effect`/`batch`. Target table in
  §14.
- **React-mode benches** (the brief's requirement to measure "as though
  inside React"): the same graph workloads driven (a) pure core, (b) with
  React bindings registered but idle (measures the observability gate),
  (c) inside `startTransition` (measures log + shadow + K1), (d) urgent
  writes racing a held transition (measures mixed passes). Plus a
  re-render benchmark against `useState` and against a uSES-based signals
  library (jotai or preact-signals adapter) on identical component trees.
- **Memory benches**: retained heap + plane bytes on effects-10k and
  grid-scale graphs; GC pause counts during sustained propagation.

---

## 14. Performance targets and predicted costs

<a name="14-performance-targets"></a>

Baselines to beat come from the donor kernel's measured results (same
machine, one-framework-per-process, vs alien-signals v3.2.1 = 1.0×; lower
is better):

| Shape | Donor kernel today | Variant-D target | Predicted delta source |
| --- | --- | --- | --- |
| deep chain | 0.90× | ≤ 0.95× | +`host.refresh` call per recompute leaf (call through host object vs direct `fnTab` load) — estimated ≤3–5% on recompute-dense shapes, 0 on marking. |
| broad fan-out | 0.84–0.88× | ≤ 0.90× | same |
| diamond | 0.89× | ≤ 0.93× | same |
| reads / isolate (quiet) | 0.74–0.87× | ≤ 0.87× | unchanged — reads don't cross the host boundary when clean; the read-context check adds one smi compare, only when bindings are registered. |
| creation | 0.96× | ≤ 1.0× | +1 policy object per node vs donor's side-arrays; offset by no fn/values column maintenance. |
| kairo suite total | trails at scale (broad 98.6 vs 70.3 ms) | ≤ 1.2× alien, stretch 1.0× | open effect-queue/notify investigation inherited from the donor (§15); policy-owned queue is the redesign that gets to attack it. |
| React re-render on change | n/a | within noise of `useState` (P1) | notify = one armed-watcher walk + one `setState`; render read = one property load + pull. |
| write, bindings idle | n/a | ≤ 5% over pure core (P3) | the gate is `hasReactBindings && isCurrentWriteDeferred()` — one boolean + one fork-API call (a property read + branch in React). |
| transition write (forked) | n/a | ≤ 3× pure-core write amortized | log entry + head fold + K1 invalidate; shadowing amortizes to O(1) per node per fork epoch. |

Non-negotiable contracts regardless of targets: exact pull counts;
synchronous effect flush outside batches (core mode); fresh mid-batch
reads; no tearing in any RTL scenario.

---

## 15. Open risks and mitigations

<a name="15-open-risks"></a>

1. **The `host.refresh` indirection tax is unmeasured.** The donor kernel
   calls `fnTab[id >> 3]` directly; variant D routes every recompute
   through `host.refresh` → `nodes[handle]` → `switch (kind)` → user fn —
   one extra call and one extra load per recompute. Predicted ≤5% on
   recompute-dense shapes, but it must be measured *first* (milestone M1
   below) because it is the price of the whole architecture. Fallback if
   it disappoints: fuse the policy dispatcher into the kernel stamp at
   codegen time (the template gains a `/*REFRESH*/` splice point), keeping
   the source-level separation while flattening the call — policy still
   owns the code, the generator owns the fusion.
2. **Context specialization across two stamps.** The growth strategy
   assumes V8 embeds each stamp's buffer as a constant. Stamping separate
   function literals maximizes the odds (own SFI, own feedback), but V8's
   heuristics are version-dependent. Mitigation: the CI optimized-code
   assertions (§12.1) pin the behavior per Node version; the fallback is
   the donor kernel's measured worst case (context-cell load per access,
   ~the "per-function aliases" penalty of +26–30% — bad but bounded, and
   K0-only since K1 is off the steady-state path when unforked).
3. **Shadow completeness under forked topology churn.** §7.6's re-sync
   covers K0 re-tracks and new subscriptions; the class of bugs where a K1
   edge is missing exactly when a deferred write propagates is subtle.
   Mitigations: the §12.2 shadowing property tests; the hook fixup
   protocol as a semantic backstop (a missed notify surfaces as a
   corrected render, not a wrong committed value); and a dev-mode
   validator that, while forked, cross-checks every K1 propagate against a
   brute-force recompute.
4. **Mixed-pass recompute cost.** The §7.4 pass memo recomputes reached
   computeds without kernel help; a pathological app (huge graph + urgent
   typing storm + permanently-held transition) could pay repeatedly.
   Mitigations: per-batch write-sets bound the recompute frontier; the
   tier-0 mixed-pass bench watches the cost; escape hatch if real apps
   hit it: per-batch dirty-summaries (a policy bloom/bitset per batch) to
   skip unaffected computeds — designed but not built until evidence.
5. **FinalizationRegistry latency and platform variance.** Records of
   dropped signals return to free lists only at GC's whim; a long-lived
   session creating ephemeral signals without dropping references to the
   arena's satisfaction grows the plane. Bounded by: plane bytes are cheap
   (32 B/record), growth is O(log n) events, and `stats()` exposes
   occupancy for leak dashboards; tests force `gc()`.
6. **React fork drift.** Every React upgrade must re-validate hook
   placement (especially `flushMutationEffects` + View Transitions and the
   setState-before-write pending-edge repair). Mitigations: the
   reconciler-level test suite lives *in the fork* and runs in its CI; the
   listener surface is small and semantic (6 events, 4 queries) so
   rebasing is mostly mechanical.
7. **Two sources of truth for edges while forked** (K0 vs K1) is the
   design's essential complexity. The alternative — one kernel with
   per-world flag planes — was variant-B territory and rejected here to
   keep the kernel closed; if shadowing proves buggier than measured-slow,
   that is the architectural revisit point.

---

## 16. Repository layout and build

<a name="16-repository-layout-and-build"></a>

```
packages/cosignal/
  src/
    kernel/
      kernel.template.ts      # THE kernel source: const enum C schema + walks;
                              # @inline-budget annotations; /*TRACE*/ splice marks
      kernel.k0.ts            # generated stamps (checked in; CI regenerates + diffs)
      kernel.k1.ts
      kernel.traced.ts
      reference-kernel.ts     # plain-object model for §12.1 (test-only)
    policy/
      nodes.ts                # PNode/PNodeAux factories, handle table
      worlds.ts               # read contexts, write paths, log + read rule
      batches.ts              # batch records, retirement, rebasing, sweep
      shadow.ts               # fork/unfork, ensureShadow/shadowSubtree
      suspense.ts             # ctx.use, thenable protocol
      effects.ts              # core effect queue + flush
      lifecycle.ts            # observed-effect delivery
      api.ts                  # Atom/Computed/ReducerAtom/effect/batch/configure
    react/
      runtime.ts              # fork-API subscription, pass records, tokens
      useSignal.ts / useComputed.ts / useSignalEffect.ts / useAtom.ts
      transition.ts           # useSignalTransition helpers
    tracing/  graphviz/
  scripts/
    stamp-kernel.ts           # template -> stamps (+ --literals fallback mode)
    assert-budgets.mjs        # bytecode/IC CI harness
vendor/react                  # fork (submodule); scripts/build-react.sh
harness/                      # shapes.ts tier-0 benches, process-isolated runners
```

Build: tsdown/esbuild bundle for publishing (inlines the const enum;
`--define:__DEV__=false` strips assertions); `pnpm generate` re-stamps the
kernel; CI = typecheck (strict, branded ids), unit + conformance + RTL
suites, budget assertions, regenerate-and-diff.

**First implementation action** (M1, one day): extract
`kernel.template.ts` from `libs/arena/src/index.ts` by deleting
values/fns/kinds and adding the host protocol; wire the reference kernel +
model-check harness; run the 179-case suite through a minimal policy shim;
measure the `host.refresh` tax on deep/broad/diamond. This settles risk #1
before any concurrency code exists. M2: policy value layer + effects →
full core conformance + benchmark adapter. M3: fork rebase to integer
tokens + reconciler tests. M4: worlds/log/shadowing + hooks → RTL suite.
M5: tracing + graphviz + budget CI.

---

*End of spec.*
