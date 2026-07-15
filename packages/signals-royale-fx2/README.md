# signals-royale-fx2

A reactive state engine with first-class support for React concurrent
rendering. It is two layers:

- a conventional signal graph — writable atoms, lazy cached computeds,
  effects, batching — with equality cutoff and batched delivery;
- a small concurrency overlay — WORLDS — that lets drafted writes (React
  transitions) stay invisible to committed readers until they land, while
  every reader still sees an internally consistent snapshot.

The root entry (`signals-royale-fx2`) is React-free and dependency-free.
React bindings ship as a subpath — `signals-royale-fx2/react` — with
`react`/`react-dom` (>= 19) as peer dependencies; they run on stock React,
no patches or build flags. TypeScript source is the artifact (`exports`
points at `src/`): consume it with any TypeScript-compiling toolchain
(bundlers, vitest, tsc). Numeric constant families are `const enum`s, so
loaders that only strip types (Node's `--experimental-strip-types`) are not
supported.

## Core API

```ts
import { createAtom, createComputed, effect, batch, untracked } from 'signals-royale-fx2';

const count = createAtom(1);
const double = createComputed(() => count.get() * 2);
const stop = effect(
  () => double.get(),              // compute: tracked, pure
  (value) => console.log(value),   // handler: untracked side effect
); // the handler runs now, then when the settled value changes

count.set(2);                 // handler logs 4
count.update((x) => x + 1);   // functional update
batch(() => {                 // one flush for the whole callback
  count.set(10);
  count.set(3);               // net revert: the handler never runs
});
stop();
```

- **Equality:** writes that compare equal are dropped. Pass
  `{ equals }` to customize; pass `{ label }` to name an atom in traces.
- **Lazy initializers:** `createAtom(() => expensive())` runs the function once,
  untracked, at first use (read, write, or subscription — never at
  construction). A `set` before the first read still runs it, because the
  equality contract needs the base value. Initializers must not write.
- **Computeds** are lazy and cached, track dependencies dynamically (a
  branch not taken this evaluation is not a dependency), and only recompute
  when an input's value generation actually advanced.
- **Effects** are two functions. The compute uses the same evaluator and
  semantics as a computed — tracked, cached, cut off by `equals`, and
  async-capable through `use()` — but its state lives on the effect itself.

  The handler runs untracked with the compute's settled `(value, previous)`
  pair when that value changes, and may return a cleanup that runs before
  the next handler run and at disposal. Reads the effect should react to
  belong in the compute; handler reads are untracked.

  A pending compute is silent: settlement fires the handler only when the
  settled value differs. A compute error rethrows from the drain site without
  calling the handler. `effectScope(fn)` collects every effect created inside
  and returns one disposer.
- **Schedules:** `effect(compute, handler, { schedule })` picks when
  signal-triggered re-runs drain: `'sync'` (default — inside the flush
  when the write settles), `'before-paint'`, or `'after-paint'`, both
  coalesced per window with a net value cutoff. The first run at creation
  is always synchronous. `flushScheduledEffects()` drains the paint lanes
  now (tests, headless hosts). See `docs/effects.md` for the full
  contract.

## Intents, drafts, and worlds

Writes are INTENTS: either a value (`set`) or a function to re-execute
against whatever the base turns out to be (`update`). Urgent intents apply
immediately. Intents issued inside a React transition are recorded into a
DRAFT instead — an ordered log attached to that transition.

A WORLD is "committed state plus a specific set of drafts". Resolving a
value in a world replays, in original dispatch order, the intents that world
is allowed to see. That single rule produces React's updater-queue behavior:

```ts
const n = createAtom(1);
// transition records: update(x => x + 2)     (draft D)
// urgent write:       update(x => x * 2)
n.get()      // 2      — urgent skipped the draft: 1 * 2
// world with D: (1 + 2) * 2 = 6   — replay in dispatch order, never reorder
```

When a draft RETIRES (its transition committed everywhere), the full replay
folds into committed state through the ordinary write path — effects run,
equality applies — and renders still holding the draft's id resolve the same
values, so retirement is invisible to them. A discarded draft rolls back:
draft readers are re-notified and re-resolve without it. When the last
draft dies, every per-draft structure is dropped; a quiescent engine holds
nothing extra.

## The read family

```ts
count.get()        // committed state plus applied urgent writes; drafts hidden
latest(count)      // newest intent, drafts included; never suspends
isPending(count)   // true while newer data exists behind the shown value
```

There is deliberately no `committed()` query: the committed view is
implicit, exactly as in React and Solid. Ordinary reads outside a render
pass are base state — committed writes and retired transitions, drafts
hidden — so "what is on screen" is what everything that did not opt into
a draft already sees.

Inside a computed evaluation (or a render pass, through the React bindings)
`latest` and `get` resolve that context's own world — reading ahead of your
world would be a tear. In a base-state computed or effect, `latest(x)` is
also a tracked dependency: when `x` changes, the reader re-runs. What
distinguishes `latest` from `get` is that it never suspends, not that it
reads a different world from inside an evaluation.

## Async values

Pending and error are graph STATE, not control flow:

```ts
const user = createComputed((use) => use(fetchUser(id.get())));
```

- `use(thenable)` returns the settled value, or parks the evaluation. A
  parked computed keeps serving its last settled value ("stale") and exposes
  one stable pending promise per span, so a suspended React render retries
  exactly once per settlement and never re-issues fetches.
- Settlement behaves as a write: it invalidates and propagates, and parked
  computeds re-evaluate eagerly so chained requests progress without a
  reader.
- Errors rethrow the same reason object at every read site.
- Keep thenables stable per input set (derive them from state, as above).
  A function that creates a brand-new promise on every evaluation would
  refetch on every settlement — that is a data-layer bug this engine cannot
  paper over.

## Refetching

To refetch with unchanged inputs, own the trigger: keep a version atom,
read it inside the computed, and bump it to fetch again. There is no
dedicated refetch API because a version bump is an ordinary write, and
ordinary writes already do everything a refetch needs.

```ts
const userVersion = createAtom(0);
const user = createComputed((use) => use(fetchUser(id.get(), userVersion.get())));

userVersion.update((v) => v + 1); // refetch now; user keeps serving stale
```

- While the new fetch is pending the computed serves its last value and
  `isPending(user)` is true — exactly as if `id` had changed.
- It composes with transitions for free: the bump is classified like any
  other write, so a bump inside a transition refetches in that transition's
  world — the current screen holds, and the result commits with it.
- Include the version in the request's cache key (as in `fetchUser` above)
  so each bump creates exactly one new request.

## Observed lifecycle

```ts
const price = createAtom(0, {
  onObserved: ({ get, set }) => {
    const socket = subscribePrices(set);
    return () => socket.close();
  },
});
```

The callback runs when the atom gains its FIRST subscriber of any kind
(effect, watched computed chain, or React component) and the cleanup runs
when the LAST subscriber of every kind is gone. Subscribe/unsubscribe flaps
within a tick coalesce, so a StrictMode double-mount nets one activation.

## Server rendering

```ts
serializeAtomState([a, b]);            // or { name: atom } records
initializeAtomState(json, [a2, b2]);   // fresh client atoms
installState(atom, value);             // one atom
```

Installing is not a write: no propagation, no equality check, and lazy
initializers do not run — the installed value satisfies the first read.

## Causality tracing

```ts
const t = attachTracer({ capacity: 4096 });
// ... run your app ...
t.whyLastDelivery(node); // ["#42 deliver", "#41 write \"count\"", ...]
t.events();              // ring contents; t.dropped counts evictions
t.stop();
```

Every event carries a causal parent: a re-render chains to the write that
caused it, a fold write chains to the draft retirement, a retirement chains
to the transition's last write. Unrelated operations never chain. Detached
cost is one null check per emit site; the ring never grows past its
capacity and overflow is counted, never silent.

## Ownership and reclamation

- Computeds hold references toward their dependencies only, and join
  subscriber lists only while observed. Dropping the last reference to an
  unobserved computed chain makes the whole chain collectible.
- Effects, effect scopes, and subscriptions retain graph edges until their
  returned disposer is called.
- Draft retirement clears rebase logs and world memos (see above).

Leaks are bugs here, not optimizations.

# React bindings: `signals-royale-fx2/react`

Bindings for stock React — no patches, no build flags, no globals.
Developed and tested against the React 19.3 canary
(`19.3.0-canary-e71a6393-20260702`); any React >= 19 satisfies the peer
range.

## The design premise: React is the world clock

Most signal bindings treat React as a display driver: the store changes, the
binding forces components to re-render. That model collapses under
concurrent rendering — React may be preparing several futures at once
(transitions), and a store that changes mid-flight either tears or forces
everything synchronous (`useSyncExternalStore` renders every store change
at sync priority, no matter where the write came from).

These bindings invert the relationship. The engine never decides what a
render pass may see; React does:

- `SignalsFrameworkProvider` connects a React subtree to the signals runtime;
  the packaged `createRoot` wrapper installs one around the root. Providers
  cannot be nested. A provider's only state is a list of transition draft ids
  managed by `useReducer`. Its context value is identity-stable, so publishing
  the connection never re-renders consumers.
- A transition write opens an engine draft. The draft id is dispatched from
  inside `React.startTransition` to each root connection and, for each written
  atom, to exactly the subscribers of that atom (and of computeds over
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
- Base-state changes travel the SAME channel: the engine notifies a
  subscriber, and the hook dispatches into its own reducer only if
  re-rendering would actually show the committed tree something different
  (a per-subscriber compare — equal resolutions, foreign transitions, and
  already-delivered folds all stay silent). There is no
  `useSyncExternalStore` underneath and no store snapshot: subscriptions
  attach in effects, and the gap between rendering and attaching is closed
  by a commit-time repair.

### Writes re-render with exactly `useState`'s urgency

Because every wake is a reducer dispatch made in the write's own context,
the re-render gets the lane React would give a `setState` from the same
place: synchronous before paint from a click handler, default priority from
a timeout, a promise, or a network callback (it may land after a paint —
wrap the write in `flushSync` when you need the DOM updated immediately,
exactly as for React state), and the owning transition's lanes for drafted
writes. An atom write and a `setState` in the same async callback commit
in ONE render. This deliberately diverges from `useSyncExternalStore`-based
stores, which escalate every store change to sync priority.

A draft retires when every root that received it has committed it; the
engine then folds it into committed state, and passes still holding the id
resolve identical values. Base state is therefore the committed view —
drafts hidden, folds included. With multiple roots it converges at
retirement, so while a transition one root already committed is still held
by another, that root's screen momentarily runs ahead of base state.

Plain `latest(x)` / `isPending(x)` calls in render bodies resolve the
current pass's world through a validity-gated note: the note is written by
the pass that owns it and expires at the end of its synchronous window, so
a pass that did not refresh it (an urgent pass over an untouched subtree,
another root's render, an interleaved flush) falls back to BASE rather
than consuming a stale world or leaking live drafts into an urgent frame.

Every provider-dependent hook (`useValue`, `useComputed`, and
`useIsPending`) requires a `SignalsFrameworkProvider` above it and throws
without one. The root connection carries transition worlds, so a
subscriber outside a provider has no channel for them. Create roots with
`wrapCreateRoot(createRoot)` or wrap the tree in
`<SignalsFrameworkProvider>`. `useSignalEffect` and
`useSignalLayoutEffect` observe base state, which needs no root channel,
so they work without a provider — as do the plain function reads
(`latest`, `isPending`).

## Out of scope: DOM-mutation attribution

Bracketing exactly React's own DOM mutation phase per commit (so a
`MutationObserver` client could blind itself to React's mutations while
still catching everyone else's) needs cooperation from inside the
reconciler: stock React exposes no signal at mutation-phase entry or exit,
and anything observable from userland (snapshot lifecycles, layout effects,
the observer's own async records) fires either on the wrong fibers or too
late to disconnect. This package deliberately does not patch React, so it
does not offer a DOM mutation window.

## React API

```tsx
import { createRoot } from 'react-dom/client';
import {
  registerReactSignals, wrapCreateRoot,
  useValue, useComputed, useSignalEffect, useSignalLayoutEffect,
  useIsPending, useAtom,
  startSignalTransition, useSignalTransition,
} from 'signals-royale-fx2/react';
import { createAtom } from 'signals-royale-fx2';

registerReactSignals(); // stock React; idempotent

const root = wrapCreateRoot(createRoot)(container);
const count = createAtom(0);

function Counter() {
  const n = useValue(count);            // this render pass's world
  const pending = useIsPending(count);  // newer data behind the screen?
  return <button onClick={() => count.set(n + 1)}>{n}{pending ? '…' : ''}</button>;
}

startSignalTransition(() => count.update((x) => x * 2)); // draft until commit
```

- `useValue(x)` — subscribing read; resolves the pass's world; suspends by
  handing React the engine's stable pending promise (a transition holds; an
  urgent render with settled history serves stale instead — no fallback
  flash).
- `useComputed(fn, deps)` — component-owned computed.
- `useSignalEffect(compute, handler, deps, opts?)` /
  `useSignalLayoutEffect(...)` — the engine effect with React-phase setup.
  Mount and `deps` changes create the effect (and first-run it) exactly in
  React's passive or layout phase and tree order; signal-triggered re-runs
  drain in the matching lane (after-paint at React's own passive priority;
  before-paint in a microtask — the only host timing guaranteed to precede
  the rendering steps). The handler sees the latest committed render's
  props without re-creating the effect; cleanup honored; StrictMode nets
  one; base state only — a transition reaches it once, at retirement.
- `useIsPending(x)` — the pending probe, delivered urgently (an indicator
  must not be held hostage by the transition it indicates).
- `useAtom(initial, opts?)` — component-owned atom, reclaimed after
  unmount.
- `startSignalTransition(fn)` / `useSignalTransition()` — transition
  batches. Plain `React.startTransition` also works: the first engine write
  inside any transition context is classified into a draft automatically.
- Writing during render throws.
- Multiple roots are supported; one transition can span them, and each
  root's render passes stay internally consistent.
