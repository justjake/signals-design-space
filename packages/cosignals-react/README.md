# cosignals-react

React bindings for [`cosignals`](https://www.npmjs.com/package/cosignals)'s
concurrent engine: signals that stay correct under React's concurrent
rendering. Pending transitions see their own view of the state, the
committed UI never shows a mixture of old and new values, and components
that mount in the middle of an in-flight update reconcile against
committed state before the browser paints.

## The problem this package solves

React's **concurrent rendering** splits work by urgency. A **transition**
(`startTransition`) marks an update as non-urgent: React renders it in
the background over several interruptible slices ("time-slicing"), while
urgent updates — typing, clicks — keep landing and committing in between.
React may also throw a partially rendered transition away and restart it.

This is safe for React's own `useState`, because React keeps one value
per pending update internally. An external store has one current value,
which breaks in two ways:

- **Tearing.** A torn frame is a single rendered frame showing a mixture
  of old and new state. If the store changes while a render is paused,
  components read at two different moments and disagree within one
  frame. Equally bad: an urgent render can observe a value that only a
  pending transition should have been able to see.
- **Lost pending state.** If the store refuses to change until commit
  (the `useSyncExternalStore` approach), transitions degrade: every
  store change forces a synchronous de-opt and the "render the next
  screen in the background while the current one stays interactive"
  behavior is lost.

The cosignals engine solves this by recording every write as a **log entry** —
a compact record of the operation, the **batch** it belongs to (the group
of writes making up one UI update), and its position on one global
timeline. Each view of the state (a **world**) is computed by replaying
exactly the log entries that view is allowed to see: a pending render's
world (its batches plus committed state, frozen when the render started),
the committed world of a root (what is on screen), and the newest world
(everything). This package wires those worlds to React: every component
reads the world of the render it is part of, so no frame can mix views.

Example — the known failure mode this package exists to fix: a transition
writes the store and its render suspends on data; while it is pending, an
urgent update mounts a brand-new component that reads the same store. A
naive store hands the new component the mutated value and it tears
against its committed siblings. Here the new component reads the
committed world and matches its siblings; the pending value appears only
when the transition itself commits. (This exact scenario is pinned in the
test suite.)

## Requirements

React itself does not expose when it starts, pauses, or commits a render,
so these bindings require a patched build with private signals taps. The
fork reports raw scheduling facts through React's private internals:

- render events (start with the included batches, yield, resume,
  end with committed/discarded disposition), per-root commit events, and
  batch retirement events;
- the current write lane and render context;
- an operation that schedules a state update in a live lane.

`react-signals-utils` is the sole owner of batch identity and retirement. It
converts those facts into stable batches for all signal implementations; the
React fork does not expose a public signals API.

`registerCosignalReact()` feature-detects the protocol at startup: on a
stock React (where these entry points simply don't exist) it throws
immediately with a descriptive error rather than tearing silently later.

## Setup

```tsx
import { createRoot } from 'react-dom/client';
import { Atom } from 'cosignals';
import { registerCosignalReact, useSignal } from 'cosignals-react';

registerCosignalReact(); // once, after importing react-dom/client,
                         // before rendering any root

const count = new Atom(0);

function Counter() {
  const value = useSignal(count);
  return <button onClick={() => count.set(value + 1)}>{value}</button>;
}

createRoot(document.getElementById('root')!).render(<Counter />);
```

`registerCosignalReact()` attaches the engine's driver — write
classification and per-render world routing — and subscribes to the
protocol events. It returns a handle
(`{ bridge, shim, dispose }`: the engine surface, the protocol adapter,
and a teardown); `dispose()` releases the React-side registrations
(mainly for tests).

This package re-exports the app-facing part of the engine surface —
`Atom`, `Computed`, `ReducerAtom`, `effect`, `effectScope`, `batch`,
`untracked`, `SuspendedRead` and their option types — so applications can
import them from `cosignals-react` directly. Engine internals (the `engine`
surface object, `attachDriver`, trace and log-entry types, …) are
deliberately not re-exported;
import those from `cosignals` if you are writing engine-level tooling.

## Hooks

### `useSignal(signal)`

Subscribes the component to an atom (or a `useComputed` result) and
returns its value **in the world of the render the component is part
of** — a transition render sees the transition's pending value, an urgent
render sees committed state, and every component in one render sees
the same frozen view.

Mounting is the subtle case. A component can mount while other updates
are in flight, and its subscription only activates at commit — so writes
could slip by unobserved between its render and its commit. `useSignal`
closes that window in a layout effect (after commit, before paint):

- for every still-live batch that touched relevant state but was not
  part of this component's render, a corrective re-render is scheduled
  *into that batch's own lane* (a lane is React's internal unit of
  scheduling priority; work in one lane renders and commits together) —
  so the component joins the pending update instead of revealing it
  early or missing it;
- one comparison against committed-state-as-of-now catches anything that
  committed or retired during the window, and fixes it urgently before
  paint.

Net effect: a newly mounted component never paints a frame that
disagrees with its siblings, and never leaks a pending value into a
committed frame.

### `useComputed(fn, deps)`

A derived value scoped to the component — same mental model as `useMemo`:
while `deps` are equal, you keep the same node; when `deps` change, a
fresh node is created with the new closure (kept if the render
commits, dropped if it is discarded). Returns a real `Computed` handle
whose `.state` reads in the current render's world.

Why recreate instead of swapping the function in place: a computed's
function must stay immutable for the node's whole life, because pending
worlds *replay* evaluation — if a live node's function could change, one
world could observe another closure's output mid-flight.

Inside `fn`, `ctx.previous` is a hint carrying the last committed value
(it may be stale or `undefined`; the function must be correct without
it), and `ctx.use` reads async data — while a promise is pending, the
component suspends via React Suspense; settlement re-evaluates. Two
forms, matching React's own `use()` contract:

- **`ctx.use(promise)`** — for a promise your data layer (react-query,
  SWR, Relay, a hand-rolled cache) or component state already caches.
  Fulfilled returns the value; rejected throws the reason; pending
  suspends. The bindings store nothing — caching is the caller's job,
  exactly as with React's `use()`.
- **`ctx.use(key, factory)`** — the built-in per-node cache: the node
  keeps a per-key map of promises for its own lifetime, so the factory
  runs once per key and the same promise is reused across re-renders and
  across concurrent render attempts. The key is the identity of the
  thing being fetched and must carry every input that varies the
  request — e.g. `ctx.use(['user', userId], () => fetchUser(userId))`.

The parity boundary — the same lifecycle React documents for its own
`use()`: the keyed cache lives exactly as long as the node. Changing
`deps` recreates the node (the `useMemo` rule), and a **discarded mount
attempt** — React throwing away speculative work that included this
component's very first render — throws away hook state and with it the
node, so the next attempt re-runs the factory and may refetch. Apps that
need request dedup across such discards cache the promise in their data
layer and pass it with the one-argument form; a component that survives
(the normal case) never refetches on re-render.

### `useReducerAtom(reducer, initial)`

`[value, dispatch]` with `useReducer` parity, backed by an atom. The
reducer is fixed at creation and must be pure: dispatched actions are
stored and replayed to compute each world's value, so an impure or
swapped reducer would make worlds disagree. Passing a different reducer
on a later render warns in development and keeps the original (remount
with a `key` to change reducers).

### `useSignalEffect(fn, deps?)`

One effect that can be requested to run two ways: by a committed React
dependency (`deps`) change, or by a change reaching a signal the effect read on
its previous run. Both requests share one cleanup/body owner. If one write
reaches the effect through both a committed render and signal propagation, it
runs once with the committed React closure and committed signal values — never
first with old props and new signals.

A signal-only change runs the body directly and does **not** schedule a React
render. Matching React work defers the signal request until that render
commits or is discarded; a suspended render never races an older closure.
If React invokes the hook more than once in one render pass, only the final
dependency report participates in commit arbitration. A signal write from
inside the body queues any resulting rerun until the current run finishes,
and never re-renders the component from inside the body.
Signal reads resolve in the committed world of the component's root, never
pending state, and are retracked as ordinary graph edges after every run.

The durable-change contract is **at-least-once** —
re-fire decisions are made by change clocks, never by comparing values, so
a round trip that lands back on an equal value (write A→B, then B→A,
across separate updates) may re-fire the effect even though everything it
reads compares equal to its last run. Two things do not change: writes
inside one update still coalesce into one re-fire, and write acceptance
still honors the atom's equality (writing an equal value is not an
accepted change and triggers nothing). Keep effect bodies idempotent —
the discipline React's own Strict Mode teaches. Cleanup-then-run ordering
and `deps` behave like `useEffect`.

### `startSignalTransition(fn)`

Transition integration with the exact rule React's own `startTransition`
has. `fn` takes no arguments — writes inside it are ordinary writes:

```ts
startSignalTransition(async () => {
  filter.set(draft);            // synchronous part: joins the transition batch
  const data = await fetchResults(draft);
  startSignalTransition(() => { // after await: re-enter, same as React
    results.set(data);
  });
});
```

- Writes in the **synchronous part** of `fn` are classified into the
  transition's batch — they render at transition priority as one pending
  update. No special API is needed: inside the callback, the transition
  is the ambient batch context, so plain `set`/`update`/`dispatch` land
  in it.
- Writes **after an `await`** are urgent/ambient unless re-wrapped in
  another `startSignalTransition` call, because the async continuation
  runs on a fresh call stack with no ambient transition context — the
  same rule, the same fix, and the same reason as React's own
  transitions. The library warns in development when a bare write lands
  while an async action is pending.

Returning a promise from `fn` parks the transition until it settles
(React async-action semantics), so the pending state stays pending across
the whole action.

## Server rendering

The browser bindings use one default engine instance: `registerCosignalReact()`
with no argument binds it, and `Atom`/`Computed`/`ReducerAtom` imported from
this package (or from `cosignals`) belong to it.

For SSR, each request needs its own isolated graph so concurrent requests never
share state. Create a per-request instance with `createCosignals()` (see the
`cosignals` README for the engine-level serialize/hydrate recipe) and bind it
for one synchronous render:

```tsx
import { createCosignals } from 'cosignals';
import { registerCosignalReact } from 'cosignals-react';

const instance = createCosignals();
const count = new instance.Atom(0);
instance.initializeAtomState(state, { count }); // hydrate this request's atoms

const handle = registerCosignalReact(instance); // bind this request's engine
try {
  const html = renderToString(<App count={count} />); // synchronous
} finally {
  handle.dispose();
}
```

While `instance` is bound, every hook — and every handle created with
`instance.Atom` / `useComputed` / `useReducerAtom` — routes through that
request's graph. A handle from a *different* instance passed to a hook throws a
clear "handle belongs to a different engine instance" error rather than reading
the wrong graph.

Scope and limits — read before relying on this:

- **Synchronous only.** `renderToString` runs to completion on one call stack,
  so the register → render → dispose block is race-free. Because registration is
  a single **global** active shim (one at a time), it is **not** safe for
  streaming or concurrent SSR that keeps several instances live at once — a
  second concurrent `registerCosignalReact` throws rather than corrupting.
  Streaming SSR with per-request isolation is a planned follow-up.
- Serialize/hydrate the request's state through the engine (`instance`'s
  `serializeAtomState` / `initializeAtomState`); those require no live batch or
  render, so SSR never captures a speculative world.

## How writes are classified

Every `atom.set` / `atom.update` / `reducerAtom.dispatch` is attributed
to the batch context in which it executes: an event handler's discrete urgent
batch, a transition or async-action batch, or the ambient default batch when no
context exists. Functional updates and reducer actions are recorded
whole — not pre-folded — so each world replays them against its own view.
Corrective re-renders and deliveries are scheduled back into the live lane
of the batch that caused them.

## Testing

The suite runs against a real protocol React build (via jsdom and
`react-dom/client`), not mocks: hook behavior (StrictMode double-mount
netting, deps-keyed recreation, replay fidelity of functional updates,
Suspense via both `ctx.use` forms), fifteen concurrency scenarios —
subscription, interleaved urgent writes mid-transition, the
mid-transition mount with suspended pending state described above,
multi-root skew, async actions — plus a React-level run of the engine's
correctness battery and a tracer smoke test.

## License

MIT
