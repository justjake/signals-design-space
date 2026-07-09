# react-signals-royale-fx2

React bindings for [`signals-royale-fx2`](../signals-royale-fx2). Runs on
stock React — no patches, no build flags, no globals. Developed and gated
against React 19.3.0 built from commit `e71a6393e6` (the same commit the npm
canary `19.3.0-canary-e71a6393-20260702` is cut from).

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
  managed by `useReducer`; its context value is an identity-stable record,
  so the scope itself never re-renders its subtree.
- A transition write opens an engine draft. The draft id is dispatched from
  inside `React.startTransition` to each root's scope AND — per written
  cell — to exactly the subscribers of that cell (and of computeds over
  it), each through its own `useReducer`. The dispatches ride the
  transition's own lanes, so React's update queues — not this library —
  decide which render passes include the draft: urgent passes skip it, the
  transition's passes carry it, interrupted work recomputes it. A
  transition's render passes therefore re-render only the components its
  writes actually touch, not every subscriber in the app.
- Reads resolve against exactly the drafts in the current pass's React
  state. Urgent writes land immediately and pending drafts REPLAY over
  them in dispatch order, which is how a counter at 1 with a pending "+2"
  transition shows 2 after an urgent doubling and settles at 6 — never a
  reorder, never a torn 3.
- The `useSyncExternalStore` subscription underneath snapshots a
  subscription epoch — never a value. Transition drafts never touch that
  snapshot, so React's transition machinery — holding, time slicing,
  interruption, retries — keeps working; there is no synchronous fallback
  and no tearing window.

A draft retires when every root that received it has committed it; the
engine then folds it into committed state, and passes still holding the id
resolve identical values. What is on screen per root is queryable at any
time (`committed(x, container)`, `useCommitted`).

Plain `latest(x)` / `isPending(x)` calls in render bodies resolve the
current pass's world through a validity-gated note: the note is written by
the pass that owns it and expires at the end of its synchronous window, so
a pass that did not refresh it (an urgent pass over an untouched subtree,
another root's render, an interleaved flush) falls back to CANONICAL rather
than consuming a stale world or leaking live drafts into an urgent frame.

Roots without a `SignalScope` still work, in a degraded mode: their
components only ever see committed state (no transition previews), and when
a transition commits elsewhere the fold itself re-renders them — hooks
outside any scope subscribe to a canonical change counter that folds always
advance, so they converge instead of holding a transition or going stale.

## Out of scope: DOM-mutation attribution

Bracketing exactly React's own DOM mutation phase per commit (so a
`MutationObserver` client could blind itself to React's mutations while
still catching everyone else's) needs cooperation from inside the
reconciler: stock React exposes no signal at mutation-phase entry or exit,
and anything observable from userland (snapshot lifecycles, layout effects,
the observer's own async records) fires either on the wrong fibers or too
late to disconnect. This package deliberately does not fork React, so it
does not offer a DOM mutation window.

## API

```tsx
import { createRoot } from 'react-dom/client';
import {
  registerReactSignals, wrapCreateRoot,
  useValue, useComputed, useSignalEffect, useIsPending, useCommitted, useAtom,
  startTransitionWrite, useSignalTransition,
} from 'react-signals-royale-fx2';
import { signal } from 'signals-royale-fx2';

registerReactSignals(); // stock React; idempotent

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
- Writing during render throws.
- Multiple roots are supported; one transition can span them, and each
  root's committed view stays internally consistent.

## Tests and benchmarks

- `tests/` — the real-React gate: transition invisibility, rebase
  arithmetic, sibling consistency, mount-mid-transition, flushSync
  exclusion, multi-root consistency, StrictMode, unmount silence,
  write-during-render, the suspense family, time slicing, lifetime
  effects, causality traces, lazy initializers, SSR install, and host
  guarantees (stock registration, reclamation, quiescence).
- `tests/production-regressions.spec.tsx` — the tear family (a pass that
  did not refresh the render-world note cannot consume a stale one: urgent
  pass over an unrelated subtree, two roots back-to-back, interleaved
  flushSync mid-transition, StrictMode) and the wake family (a transition
  drafting one cell re-renders exactly that cell's subscriber; late appends
  re-dispatch only to affected subscribers, in the owning transition's
  lane; interleaved transitions keep distinct audiences).
- `bench/react-bench.mjs` — write-to-commit fanout, urgent latency during a
  large transition, and mount cost, against a plain `useSyncExternalStore`
  baseline. No leaks in either contender: cells are dropped per run and the
  engine reclaims structurally.
