# react-signals-royale-fm1

React bindings for [`signals-royale-fm1`](../signals-royale-fm1) over a
~190-line React fork (the **signal seam**). Transitions hold speculative
signal state off screen until React commits them; urgent writes commit
alone, immediately; sibling components can never tear.

## The seam

The fork adds one small module and five call sites. React reports **lanes as
opaque numbers** — a pass started on a root covering some lanes, a root
committed some lanes, the DOM mutation window opened and closed — and
answers two questions: *which lane would a write issued right now take*,
and *which root and lanes are rendering on the current stack*. It also lets
the runtime schedule an update pinned to a specific lane.

Everything else lives here, in userland:

- **Write classification.** A write inside a React transition maps to one
  engine batch per transition instance (async continuations keep their
  batch). The lane the transition will render on is recorded against the
  batch — the lane-to-batch map is a plain userland `Map`.
- **Render-pass worlds.** When a pass starts, the runtime pins an engine
  snapshot: the canonical world at that moment plus the open batches the
  pass's lanes carry. Every hook read in that pass resolves through the
  snapshot, so one pass sees one world.
- **Commit is a fold.** When a root commits lanes, the batches those lanes
  carried retire: their write intents replay onto the current canonical
  base (React updater-queue arithmetic) and install. Subscribers on other
  roots woken by the fold re-render *inside* the batch's pending pass there
  — the fold runs under the batch's lane pin, so a corrective render lands
  inside the owning commit, never beside it.
- **Per-root committed views** are just epochs: each root records the
  canonical epoch of its last commit, and `committed(x, container)` answers
  with the canonical value as of that epoch.

## Hooks

```tsx
import { register, atom, set, useValue, startTransitionWrite } from 'react-signals-royale-fm1';

register(); // fails loudly on a stock React build

const query = atom('');
function Results() {
  const q = useValue(query);
  return <List query={q} />;
}
// urgent: visible this commit        transition: held until React commits it
set(query, 'a');                      startTransitionWrite(() => set(query, 'ab'));
```

- `useValue(x)` — subscribing read; resolves the render pass's world and
  claims its engine subscription at commit, with post-subscribe fixup (a
  component that mounts mid-transition first shows the committed value,
  then joins the transition's commit through a lane-pinned update).
- `useComputed(fn, deps)`, `useSignalEffect(fn)`, `useIsPending(x)`,
  `useCommitted(x)`, `useAtom(initial)` (component-owned, reclaimed after
  unmount), `useTransitionWrite()`.
- Write-during-render throws. Unmounted subscribers receive nothing.
  StrictMode double-mounts net one subscription and one lifetime-effect
  observation.

## Suspense

A computed that parks on a thenable suspends with one stable promise, so
Suspense retries never refetch. At React boundaries the two-level rule
applies: a transition render hands React the thenable (the transition
holds); an urgent render with settled history serves the stale value with
`isPending` as the indicator (no fallback flash); a never-settled value
suspends everywhere.

## Debugging

`trace()` starts a causality log: `whyLastDelivery(x)` formats the causal
chain from a component's latest re-render back to the write or batch
retirement that caused it.

`onDomMutation(cb)` brackets exactly React's DOM mutation phase per root
commit — a MutationObserver client can disconnect while React mutates and
reconnect after, so it only observes third-party mutations.

## Building the fork

`./build.sh` applies `patches/` to a pristine React checkout at the pinned
base and builds it (see the script). The bindings link against
`vendor/react/build/oss-experimental/*`.
