# react-signals-royale-fh1

React bindings for [signals-royale-fh1](../signals-royale-fh1), riding a
~170-line React fork ("the signal seam") that lets external signals
participate in concurrent rendering without tearing and without the
useSyncExternalStore de-opt: writes made inside `startTransition` render at
transition priority and commit with the transition, while urgent updates keep
committing on time.

## The seam

Stock React cannot tell an external store which render pass is running, which
lanes a commit finished, or how to attribute a store write to a transition —
so external stores fall back to synchronous re-renders. The fork adds one
small channel (published on React's shared internals; `register()` fails
loudly on a stock build):

- facts: pass start, root updated, commit (entanglement-expanded lanes),
  and a bracket around exactly the DOM mutation phase;
- queries: the transition lane a write issued right now belongs to, and the
  container currently rendering;
- one control: a pinned transition lane, so a corrective update can ride
  INSIDE a pending batch's own lane and commit with it, never beside it.

Everything else — batches, worlds, committed views — lives in the engine.
Every transition lane with signal writes maps to one engine batch; every
render pass gets one world (a cutoff plus the batches the pass renders);
every commit advances that root's committed cutoff and retires the batches
it finished.

Build the fork: `./build.sh` (applies `patches/` onto the pinned React base
and builds; artifacts land in `vendor/react/build/oss-experimental`).

## Hooks

- `useValue(x)` — subscribing read. Renders resolve the pass's own world, so
  sibling readers never tear and StrictMode replays agree. The subscription
  is claimed at commit with drift fixup, and a subscriber arriving while a
  transition is pending joins that transition's commit. Suspense follows the
  two-level rule: a transition render hands React the thenable (the
  transition holds); an urgent render with settled history serves the stale
  value; never-settled suspends.
- `useComputed(fn, deps)` — a derived value subscribed like `useValue`.
- `useSignalEffect(fn)` — an engine effect for the component's lifetime;
  re-runs on committed-value changes, cleanup honored.
- `useIsPending(x)` — true while newer data loads behind the shown value;
  flips are delivered urgently even while the owning transition parks.
- `useCommitted(x)` — this root's committed view of `x`.
- `useAtom(initial, opts?)` — a component-owned atom, reclaimed after
  unmount.
- `useTransitionWrite()` / `startTransitionWrite(scope)` — React transitions
  married to engine write classification.
- `onDomMutation(cb)` — start/stop callbacks bracketing exactly React's DOM
  mutation phase per commit, so a MutationObserver can ignore React's own
  mutations while catching third-party ones.

Writing a signal during render throws. Unmounted subscribers receive
nothing. Multiple roots each get per-root consistency and committed views.

## Benchmarks

`node bench/react-bench.mjs` — three seam scenarios against a stock
useSyncExternalStore baseline (jsdom, real timers, one child process per
scenario). The transition scenario is the reason the fork exists: p95 urgent
latency during a 2000-cell transition rewrite is ~5 ms here versus ~400 ms
for the blocking useSyncExternalStore path.

## Tests

`pnpm test` runs the real-React gate: the 18 required scenarios (one commit
per write, held transitions, rebasing retirement, tear checks, mount
mid-transition, flushSync exclusion, two roots, StrictMode, unmount,
write-during-render, the suspense family, time slicing, branch state,
lifetime effects, causality traces, the mutation window, lazy initializers,
SSR) against this package's own fork build.
