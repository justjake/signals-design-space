# Background primer (frozen seed) — read this first

You are designing with zero prior context. This file gives you the domain,
the vocabulary, and the named artifacts the other seeds reference. It
describes the *problem*, not any solution; nothing here mandates a
mechanism.

## Signals in one page

A **signal** is a container for a value that remembers who reads it. An
**atom** holds a writable value. A **computed** holds a function over other
signals: reading it returns the cached result; the library records which
signals the function actually read (its dependencies — discovered by running
it, so they can change run to run). An **effect** re-runs automatically when
signals it read change. Two disciplines make this fast, and both are
requirements (P2): **push-pull** — a write cheaply marks downstream
"possibly stale" and nothing recomputes until someone reads it, at which
point the library verifies bottom-up and recomputes only what truly changed
("exact pull counts"); and **equality cutoff** — a recompute that produces
an equal value stops propagation.

## What concurrent React does, and why external stores tear

React's `startTransition` renders updates *in the background*: the screen
keeps showing the current state while React builds a tree for the future
state. Urgent updates (typing, clicks) can interrupt; React renders them
first — *without* the transition's changes — and finishes the transition
later. So at one moment there are **two live versions of the world**: the
committed one on screen and the pending one being prepared. Background
renders are also **time-sliced**: React pauses ("yields") to keep the page
responsive — event handlers and timers run in those gaps — then resumes, or
throws the partial tree away and restarts. Any code that runs during
rendering must be pure, and everything a single render pass reads must be
mutually consistent for the pass's whole life, across yields. A frame where
one component shows new state and a sibling shows old state for the same
logical version is a **torn frame** — the cardinal sin in this domain.

React's own state survives all this because `setState` does not overwrite:
it appends an **update** to a per-hook queue, tagged with a **lane**
(React's internal priority/batch bitmask). A render for some lanes applies
exactly the queued updates in those lanes, skips the rest, and **rebases**:
skipped updates are re-applied later over the newer base, in original queue
order (this is why interleaved functional updates commute correctly — see
case C3). External stores have a single current value, so React's escape
hatch `useSyncExternalStore` forces consistency by de-optimizing: every
store change re-renders synchronously, and store writes during a concurrent
render discard it. External state can never ride in a transition. **This
project exists to eliminate that de-opt**: signals must move through
transitions, Suspense, and interruptions in lockstep with React state.

## The fork premise

We maintain our own build of React (a fork we fully control — see
`fork-charter.md`). The fork can expose facts userspace cannot observe
(which batch a write belongs to, what a render pass includes, when a batch
retires, pass yields/resumes) and can offer control surfaces (e.g.
scheduling an update into an existing batch's lanes). The signals library
and the fork protocol are **co-designed**; the seam between them is a scored
deliverable.

## Vocabulary used by the other seeds

- **batch** — the set of updates React renders and retires as a unit (one
  event, or one transition). **urgent** = renders promptly (discrete input
  is sync-priority; timers/network land in a *default* priority that renders
  soon but asynchronously — so a `flushSync` in the same event can legally
  render *without* a pending default batch: case C2). **deferred** =
  transition-like, renders in the background, commits later.
- **token** — a stable integer identity for a batch across the fork
  boundary. Lane *bits* are recycled by React and leak internals; tokens are
  minted, never reused while live. At most 31 batches are live at once (one
  per lane).
- **render pass** — one attempt to render a root: fresh stack → completion
  or discard. Spans yields; a restart is a new pass.
- **world / view** — one self-consistent assignment of values to all atoms:
  the committed world, a pending world (committed + some batches), or
  whatever a specific pass must see. A pass's world must not drift while it
  is paused. How worlds are represented is the design's business; *that*
  they exist is the requirement.
- **retirement** — a batch leaving React's books (commit, or closing with
  no React work). Writes must survive retirement regardless of who was
  subscribed (case C12).
- **watcher** — whatever the design calls a mounted component's
  subscription. The one load-bearing, settled trick (DECISIONS D5): notify
  a component by calling its `setState` synchronously in the *writer's*
  execution context, so React assigns the writer's priority — transition
  writes schedule transition re-renders, urgent writes urgent ones, and
  React's batching/loop-guards apply for free.
- **tracked read** — a read inside a computed/effect evaluation that
  registers a dependency edge. **untracked** — a read that must not.
- **StrictMode** — dev mode where React double-invokes renders and
  mount/unmount cycles; designs must tolerate replayed renders and
  double-mounts (case C14).

## Named artifacts (so citations elsewhere make sense)

- **alien-signals (v3.2.1)** — the fastest published conformant object-graph
  signals library; our performance baseline ("1.0×"). Its push-pull
  algorithm with exact re-verification is the semantics bar.
- **the 179-case conformance suite** — a cross-framework reactive-semantics
  test suite (laziness, cutoffs, dynamic dependencies, re-entrancy, effect
  ordering) with `testPullCounts: true` asserting *exact* recompute counts.
  Passing it, including under forced arena-growth stress, is table stakes.
- **js-reactivity-benchmark (milomg fork)** — the primary ranking suite
  (includes the **kairo** workloads and **tier-0 shapes**: deep chain,
  broad fan-out, diamond, quiet reads, isolated writes, creation). Rankings
  are only valid one-framework-per-process (see research-facts.md).
- **react-concurrent-store** — the React team's own experimental userspace
  concurrent store; its harness and 14 scenarios (plus its documented
  known-bug: mount-mid-transition with suspending pending state) are the
  React-integration conformance bar (case C9/C15).
- **arena / plane** — a large pre-allocated `Int32Array` treated as an
  array of fixed-size integer records, identified by integer ids: GC-
  invisible, cache-friendly, bump-allocated. The measured facts about what
  makes arena layouts fast (or slow) are in `research-facts.md`; no
  specific record layout is prescribed.
