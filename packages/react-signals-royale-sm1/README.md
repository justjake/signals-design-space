# react-signals-royale-sm1

`react-signals-royale-sm1` lets React components read `signals-royale-sm1` state without tearing
across concurrent renders. It requires the included small React patch, which exposes scheduling and
commit facts that ordinary external stores cannot observe.

Register the runtime once before mounting roots:

```tsx
import { atom, register, startTransitionWrite, useValue } from "react-signals-royale-sm1";

const runtime = register();
const count = atom(0);

function Counter() {
  return <button onClick={() => count.update((value) => value + 1)}>{useValue(count)}</button>;
}

startTransitionWrite(() => count.update((value) => value * 2));
// Call runtime.dispose() after every root using the runtime has unmounted.
```

The engine keeps one replayable operation history. A React render reads the committed operations
plus the deferred lanes React selected for that pass. At commit, the runtime records which lanes are
on screen for that root. If a component subscribes after a deferred write, its layout commit detects
the missed lane and schedules one corrective render into that same lane, so the correction belongs
to the owning commit.

The package exports `useValue`, `useComputed`, `useAtom`, `useSignalEffect`, `useCommitted`, and
`useIsPending`. `startTransitionWrite` combines a React transition with engine batching. Refreshes
serve the previous settled value while `useIsPending` reports loading, and first loads suspend with a
stable thenable.

`onDomMutation` emits `start` and `stop` around React's mutation phase. An observer can disconnect on
`start` and reconnect on `stop` to ignore React changes while continuing to see third-party DOM
changes. `startTrace` records writes, render passes, commits, deliveries, effects, settlements, and
their causal parents.

Run `./build.sh` to build the patched React artifacts. The patch series in `patches/` is generated
from the pinned upstream base and can be applied to a clean checkout.
