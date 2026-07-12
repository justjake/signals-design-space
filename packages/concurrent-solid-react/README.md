# concurrent-solid-react

Concurrent React signals built as a **minimum evolution of Solid 2.0's
reactive core**. The engine is the actual `solid-signals` source (vendored
into `src/solid/`), edited only at the seams React hosting requires. A thin
bridge maps the shared React batch registry onto machinery Solid already has:
React transitions become
Solid transitions, React Suspense consumes Solid's pending statuses, and
React's commit becomes Solid's commit.

This package is one of several experiments in this repository at the same
problem (see `packages/cosignals`, `cosignals-alt-a`, `cosignals-alt-b`). The
others build concurrency-native engines from scratch; this one asks how far
Solid's existing model gets you, and what has to change.

## Why Solid's model almost fits

Concurrent React needs a store that can show **two versions of state at
once**: the committed world (what urgent renders see) and one or more
speculative worlds (what transition renders see). Solid 2.0 already has a
double-buffered value model built for exactly this shape:

- every node has a committed value (`_value`) and a staged value
  (`_pendingValue`),
- a `Transition` collects staged writes and holds them — plus any effects
  they caused — until the transition completes, then commits them atomically,
- async state is **graph state**: a pending computed carries status bits, the
  fetch lives on the node, and a first load is distinguishable from a refetch
  (`STATUS_UNINITIALIZED`).

The React adaptation is mostly a re-wiring of *who drives these mechanisms*:
in Solid, the engine decides when transitions complete and holds the UI
itself; hosted in React, **React decides** (batch retirement = commit), and
React renders the speculative world instead of the engine holding the DOM.

## Architecture

```
src/solid/    vendored solid-signals core (edits tagged [react-adapt E#])
src/reader.ts render-phase reads (probe) + per-component reader nodes
src/bridge.ts React batch registry adapter: batch tokens <-> Solid transitions
src/hooks.ts  useSignal / useSelector / useComputed / useSignalEffect / ...
```

### The world mapping

Every **deferred fork batch token** (a `startTransition` scope) owns one Solid
`Transition`:

1. When the shared registry creates a deferred batch, the bridge creates a
   Solid transition and pushes a
   *retainer* into it — the transition cannot complete while the retainer is
   present.
2. Every `setSignal` asks the registry which batch it belongs to. Deferred writes run
   with that batch's transition active, so they stage into `_pendingValue`;
   committed values are untouched. Urgent writes leave the ambient world
   alone and commit at the next flush.
3. Render passes resolve values per world: a pass whose `includedBatches`
   name the token reads staged values (`runInTransition` + stale posture); an
   urgent pass reads committed values. Both go through the same `read()`.
4. When React retires the batch (`onBatchRetired`, inside the retiring
   commit), the bridge releases the retainer and flushes: Solid's own
   completion path commits staged values and runs the held user effects.
   **Solid's commit point is React's commit point.**

### Suspense

A pending read during render throws Solid's `NotReadyError`. The hook layer
converts it into a **promise held on the async source node** (resolved by a
one-shot `_onStatusSettled` callback when the node settles). Because the
promise lives on the node, every Suspense retry sees the same thenable and
converges — no refetch loops, no per-render identity.

The **two-level rule** decides suspension vs stale content:

- never-settled value (`STATUS_UNINITIALIZED`) → throw: first loads suspend
  (fallback outside a transition, held UI inside one);
- initialized value refetching → serve the last committed value ("stale
  content, no fallback flash"), with `useIsPending` reporting the refetch —
  **unless** the reading world is the very transition that caused the
  refetch, which must suspend (that's how a transition stays pending in
  React until its data lands).

### Which world does a read see?

The contract, by read site:

| read site | world |
|---|---|
| component render (`useSignal`/`useSelector`/`useComputed`) | the render pass's world: staged values for a transition render, committed values otherwise |
| memo / effect *compute* inside the engine | the world that invalidated the node (a transition's cone recomputes in that transition) |
| `useSignalEffect` / `createTrackedEffect` observation | committed values only, at every commit that changes them — an urgent commit reaches effects even while an unrelated transition is held; a transition's own writes reach them at that batch's commit |
| bare accessor call outside render (event handler, timer, promise continuation) | committed values only — a pending transition's draft is invisible — **except** inside the very scope that staged the value: code in a `startTransition` callback (or a re-wrapped async-action continuation) reads its own writes back |
| render-phase writes | rejected (throw): React renders speculatively and replays renders freely |

### Component subscription (leak-free two-phase reads)

React may discard any render, so renders must not mutate the graph:

- **Render**: the selector runs in a tracking frame against a shared probe
  node. Dependencies link exactly like a normal Solid compute (lazy memos
  initialize, dirty memos refresh, pending reads throw), then the links are
  harvested into an array and removed. A discarded render leaves zero
  residue.
- **Commit**: a layout effect links the component's persistent *reader* node
  (shaped like a Solid tracked effect) to the harvested deps, then runs a
  post-subscribe fixup: if the value moved between render and subscribe, or
  a live transition world disagrees with what this commit shows (a component
  that mounted urgently during a pending transition), a corrective re-render
  is delivered **inside that batch** through the registry, so it commits
  with the batch instead of tearing beside it.
- **Wake-ups** fire synchronously in the writer's stack, so the re-render
  inherits the writer's priority; optimistic invalidations force the urgent
  path (`runInBatch(0)`) so optimistic UI escapes the transition scope that
  wrote it. Deferred writes also eagerly wake the affected readers through
  the memo cone (see E-table: store-only batches would otherwise be retired
  by React before the engine's flush runs).
- Unmount disposal is microtask-debounced (StrictMode's unmount/remount nets
  to one live reader), with a `FinalizationRegistry` backstop for
  component-owned nodes created by renders React discarded.

## The evolution ledger

Every change to the vendored core is tagged `[react-adapt E#]` in the source.

| # | Change | Why React needs it |
|---|---|---|
| E1 | No ambient transition creation (`initTransition()` with no argument is a no-op); `isPending`'s backing signal is plain instead of optimistic, re-derived at commit points | In stock Solid every async suspension conjures a transition so the *engine* can hold the UI. Hosted in React, held UI is React's job; engine-held urgent writes would deadlock against React's model |
| E2 | `createBridgeTransition` / `retainTransition` / `releaseTransition` | Transitions complete when React retires the batch, not when the engine thinks async settled |
| E3 | `setWriteRouter` classification hook in `setSignal`; dual-channel urgent writes to transition-held signals (commit now + rebase the staged value) | Write-time batch classification; React's lane semantics for urgent updates during a pending transition — the arrival-order updater fold `(1+1)*2 = 4` |
| E5 | Generalized two-level pending-read rule (stock only served stale values for transition-held nodes, because refetches always had transitions) | Urgent refetches have no transition here, but must still serve stale content to renders |
| E8 | Explicit world routing for staged/optimistic nodes (per-transition lists, no wholesale adoption; transition stamps at staging time); flush restructure | Urgent and deferred writes coexist: parking a transition must not hold urgent staged values, and completing one must not commit another's |
| E9 | Per-node world re-entry (`_reentryWorld` mark from `insertSubs`, scoped restore in `recompute`); world-aware value selection; transition-held signals skip the fast path | Stock Solid runs one flush under one ambient transition; with mixed urgent/deferred cones in one flush, each node must recompute in the world that dirtied it |
| E10 | Effects born under a live transition enqueue into the transition's stash | User effects must observe committed values only; they run when React commits the batch |
| E11 | `_onStatusSettled` one-shot hook fired when pending clears or errors | Backs the node-held stable Suspense thenable |
| E13 | `runTracked` (explicit-observer tracking frames) and `deferUnobserved` (batched unobserved reactions during dep re-sync) | Render-phase probe reads; commit-time dependency swaps must not tear down and refetch a dep that is immediately re-linked |

Not vendored: the store layer, `createLoadingBoundary`/`createErrorBoundary`
(React Suspense/error boundaries play that role), `createRevealOrder`, and
`action()` (React's `startTransition`/async actions own the transaction
lifecycle here).

## API

Engine (Solid 2.0 surface): `createSignal`, `createMemo` (async-capable:
return a promise or async iterable), `createEffect`, `createOptimistic`,
`createRoot`, `isPending`, `latest`, `refresh`, `untrack`, `flush`, ...

React:

- `registerConcurrentSolidReact()` — attach to the forked React build
  (throws loudly on stock React; a silent degraded mode would reintroduce
  tearing with no error at the cause). Call after importing
  `react-dom/client`, before creating roots.
- `useSignal(accessor)` / `useSelector(() => expr)` — subscribe and read in
  the current render's world.
- `useComputed(fn, deps)` — component-owned memo; signal reads inside `fn`
  are tracked reactively and do not belong in `deps`.
- `useSignalState(initial)` — component-owned signal.
- `useIsPending(() => expr)` / `useLatest(() => expr)` — Solid's `isPending`
  / `latest`, reactive.
- `useSignalEffect(fn)` — tracked effect observing committed values only.

Host long-lived graphs in `createRoot`: an unowned memo keeps Solid's stock
lazy+autodispose semantics and will tear down when unobserved.

## What the gates pin (test/react-real.test.tsx, real fork build)

- lockstep: signal writes + React state in one transition commit, never a
  mixed frame
- a held transition keeps committed state on screen; urgent writes render
  immediately and the transition commits **rebased on top** (`(1+1)*2 = 4`)
- a component mounting urgently during a pending transition shows committed
  state, then joins the transition's commit
- first-load Suspense fallback; refetches keep stale content with
  `useIsPending`, never flashing the fallback
- interleaved pending transitions keep distinct per-node data (pending lives
  on nodes, so there is nothing positional to alias)
- `refresh()` inside a transition; `useLatest` loading-indicator pattern;
  `createOptimistic` overrides visible immediately and reverting exactly at
  the batch's commit
- flushSync parity with a useState mirror; multi-root consistency;
  StrictMode double-mount netting; committed-only `useSignalEffect`

Engine-level pins (no React) live in `test/engine.test.ts`.

```sh
pnpm -C packages/concurrent-solid-react test        # requires the fork build
pnpm -C packages/concurrent-solid-react typecheck
```

## Known divergences and limitations

- **Async memos' committed copies lag under rebase.** An urgent write to a
  transition-held signal updates both value channels, and the *sync* memo
  cone over it is refreshed in the committed world synchronously (an
  untracked shadow pass — `refreshCommittedCone` — so an urgent frame never
  paints a fresh signal beside a stale derived). A memo whose compute
  returns a promise is skipped by that pass (a committed-world refetch would
  collide with the transition's in-flight one), so *async* memos' committed
  copies still lag until the transition commits.
- **Transitions entangle more readily than React lanes.** Two live batches
  that write the same signal, or that React renders in one pass, merge into
  one Solid transition and then commit together. Disjoint batches stay
  independent (each parks separately and commits at its own retirement).
- **`isPending` is world-blind.** The pending flag reflects the engine's
  view at each commit point, not a per-world answer; a refetch owned by one
  transition reads as pending everywhere once staged.
- **One React renderer per engine.** The engine is a module singleton (like
  stock Solid); the bridge is a singleton attached to one React runtime.
