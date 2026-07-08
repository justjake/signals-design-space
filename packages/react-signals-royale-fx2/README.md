# react-signals-royale-fx2

React bindings for [`signals-royale-fx2`](../signals-royale-fx2), plus the
11-line React patch they require.

## The design premise: React is the world clock

Most signal bindings treat React as a display driver: the store changes, the
binding forces components to re-render. That model collapses under
concurrent rendering — React may be preparing several futures at once
(transitions), and a store that changes mid-flight either tears or forces
everything synchronous (the documented `useSyncExternalStore` fallback).

These bindings invert the relationship. The engine never decides what a
render pass may see; React does:

- Each root gets a `SignalScope` (installed automatically by the packaged
  `createRoot` wrapper). Its only state is a list of TRANSITION DRAFT ids,
  managed by `useReducer`.
- A transition write opens an engine draft and dispatches its id to every
  scope from inside `React.startTransition`. The dispatches ride the
  transition's own lanes, so React's update queues — not this library —
  decide which render passes include the draft: urgent passes skip it,
  the transition's passes carry it, interrupted work recomputes it.
- Reads resolve against exactly the drafts in the current pass's scope
  state. Urgent writes land immediately and pending drafts REPLAY over
  them in dispatch order, which is how a counter at 1 with a pending "+2"
  transition shows 2 after an urgent doubling and settles at 6 — never a
  reorder, never a torn 3.
- The `useSyncExternalStore` subscription underneath compares stable
  identities (resolved value, pending span, or error box). Transition
  drafts never touch that snapshot, so React's transition machinery — 
  holding, time slicing, interruption, retries — keeps working; there is
  no synchronous fallback and no tearing window.

A draft retires when every root that received it has committed it; the
engine then folds it into committed state, and passes still holding the id
resolve identical values. What is on screen per root is queryable at any
time (`committed(x, container)`, `useCommitted`).

Roots without a `SignalScope` still work, in a degraded mode: their
components only ever see committed state (no transition previews), and when
a transition commits elsewhere the fold itself re-renders them — hooks
outside any scope subscribe to a canonical change counter that folds always
advance, so they converge instead of holding a transition or going stale.

## The fork: 11 lines, one file

Everything above runs on stock React semantics. One required capability
does not exist there: the DOM MUTATION WINDOW — events bracketing exactly
React's own DOM mutation phase per commit, so a `MutationObserver` client
can blind itself to React's mutations while still catching everyone
else's.

Why it cannot be userland: React exposes no per-commit hook at the
mutation-phase boundary. `getSnapshotBeforeUpdate` fires only on fibers
with pending updates (a commit caused by unrelated state bypasses any
fixed component), layout effects run after the phase with no "first"
guarantee tied to phase entry, and a `MutationObserver` only reports after
the fact — too late to disconnect. Bracketing the phase requires standing
inside the commit.

So the patch (`patches/`, one commit against
`e71a6393e66b0d2add46ba2b2c5db563a0563828`) adds to
`ReactFiberWorkLoop.js`:

- a call to `globalThis.__FX2_MUTATION_WINDOW__(containerInfo, isStart)`
  at entry and exit of the mutation phase in `flushMutationEffects` — the
  single choke point both the synchronous and view-transition commit paths
  go through;
- `globalThis.__FX2_REACT_PROTOCOL__ = 1` at module load, the handshake
  `registerReactSignals()` checks so a stock build fails loudly instead of
  silently losing the window.

`build.sh` applies the series to a pristine checkout and builds.

## API

```tsx
import { createRoot } from 'react-dom/client';
import {
  registerReactSignals, wrapCreateRoot,
  useValue, useComputed, useSignalEffect, useIsPending, useCommitted, useAtom,
  startTransitionWrite, useSignalTransition, onDomMutation,
} from 'react-signals-royale-fx2';
import { signal } from 'signals-royale-fx2';

registerReactSignals(); // throws on a build without the fx2 protocol

const root = wrapCreateRoot(createRoot)(container);
const count = signal(0);

function Counter() {
  const n = useValue(count);            // this render pass's world
  const pending = useIsPending(count);  // newer data behind the screen?
  return <button onClick={() => count.set(n + 1)}>{n}{pending ? '…' : ''}</button>;
}

startTransitionWrite(() => count.update((x) => x * 2)); // draft until commit
```

- `useValue(x)` — subscribing read; resolves the pass's world; suspends by
  handing React the engine's stable pending promise (a transition holds; an
  urgent render with settled history serves stale instead — no fallback
  flash).
- `useComputed(fn, deps)` — component-scoped computed.
- `useSignalEffect(fn)` — engine effect on committed values; cleanup
  honored; StrictMode nets one.
- `useIsPending(x)` / `useCommitted(x)` — the pending probe and the
  per-root committed view.
- `useAtom(initial, opts?)` — component-owned atom, reclaimed after
  unmount.
- `startTransitionWrite(scope)` / `useSignalTransition()` — transition
  batches. Plain `React.startTransition` also works: the first engine write
  inside any transition context is classified into a draft automatically.
- `onDomMutation(cb)` — the mutation window per root commit.
- Writing during render throws. Registration on stock React throws.
- Multiple roots are supported; one transition can span them, and each
  root's committed view stays internally consistent.

## Tests and benchmarks

- `tests/` — the real-React gate: transition invisibility, rebase
  arithmetic, sibling consistency, mount-mid-transition, flushSync
  exclusion, multi-root consistency, StrictMode, unmount silence,
  write-during-render, the suspense family, time slicing, lifetime
  effects, causality traces, the mutation window, lazy initializers, SSR
  install, and host guarantees (loud registration, reclamation,
  quiescence).
- `bench/react-bench.mjs` — write-to-commit fanout, urgent latency during a
  large transition, and mount cost, against a plain `useSyncExternalStore`
  baseline. No leaks in either contender: cells are dropped per run and the
  engine reclaims structurally.
