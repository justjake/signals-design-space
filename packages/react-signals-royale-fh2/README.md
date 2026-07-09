# react-signals-royale-fh2

React bindings for the `signals-royale-fh2` concurrent signal engine, built
on a small React fork seam. The design is **fiber-granular**: every
subscribed component instance is its own engine subscriber, scheduled
precisely — urgent changes ride React's ambient priority, transition drafts
ride exactly the owning transition's lane, and corrective re-renders land
inside the owning batch's commit rather than beside it.

## The fork seam (211 diff lines)

Stock React never tells an external store when it starts, discards, or
commits a render pass, so a store either tears under concurrent rendering
or opts out of transitions entirely (the documented `useSyncExternalStore`
limitation). The seam adds exactly the render identity a store needs, and
nothing else:

- **outbound**: one injectable runtime — pass started / pass discarded
  (root + lanes), and per-commit phases (`mutation-start`, `mutation-stop`
  bracketing exactly React's DOM mutation, then `committed` with the
  committed lanes, before layout effects);
- **inbound**: `runWithLane(lane, fn)` (pin the lane of updates dispatched
  inside — how a late subscriber joins a live transition's commit),
  `currentTransitionLane()` (key a draft batch by the same lane React will
  render), `scheduleRootLane(root, lane)` (a guaranteed close edge: the
  lane commits even with zero subscribed components), and
  `isRenderPhase()` (reject writes during render).

The seam's existence is the handshake: registration fails loudly on a React
build without the `unstable_externalSignals` export. Rebuild it with
`./build.sh`; regenerate from `patches/` against upstream base
`e71a6393e66b0d2add46ba2b2c5db563a0563828`.

## How a transition works end to end

1. A write inside `startTransitionWrite` (or any React transition scope)
   classifies into the draft batch keyed by the transition's lane; the
   batch gets a close-edge kick so it always retires.
2. The engine delivers the draft synchronously to each subscribed
   component's own forcer with the batch's lane pinned — React schedules
   exactly those fibers on exactly that lane.
3. When React renders those lanes, each hook resolves the pass's **world**
   (committed base plus the batches being rendered) — siblings can never
   tear, and React's own store-consistency pass corrects any render that
   raced a write synchronously inside the same commit.
4. When a commit carries the lane, the batch retires inside the commit:
   its operations replay canonically (updater-queue rebase arithmetic)
   before layout effects run.
5. Committed views update from committed renders only — a suspended or
   discarded render never reports, so `committed(x, container)` matches
   each screen exactly.

## Hooks

- `useValue(x)` — subscribing read; resolves the render pass's world;
  claims its engine subscription at commit with post-subscribe fixup. At a
  pending async value: a transition render suspends on the engine's retry
  thenable (the transition holds); an urgent render with settled history
  serves the stale value (`useIsPending` is the indicator); never-settled
  suspends.
- `useComputed(fn, deps)` — component-owned memoized computed.
- `useSignalEffect(fn)` — engine effect for the component's lifetime;
  observes canonical state only, never drafts.
- `useIsPending(x)`, `useCommitted(x)`, `useAtom(initial, opts)`.
- `startTransitionWrite(scope)` — marries `React.startTransition` with an
  engine batch.

Also exported: `onDomMutation(cb)` — the DOM mutation window (a
MutationObserver can disconnect while React mutates and reconnect after),
and `traceView()` — causality queries over the engine tracer
(`whyLastDelivery(x)` walks a re-render back to its originating write or
retirement).

## Verification

`tests/` is the real-React gate: the RULES scenario list (transitions,
rebase arithmetic, mount-mid-transition, flushSync exclusion, multi-root,
StrictMode, time slicing, Suspense family, lifetime effects, causality,
mutation window, SSR) plus GC/leak audits, all against this package's own
fork build via raw `createRoot` + `act`. The fork's own protocol invariants
live in the React tree (`ReactDOMExternalSignals-test.js`). `bench/` holds
the seam benchmark (fanout / transition / mount vs a stock
useSyncExternalStore baseline).
