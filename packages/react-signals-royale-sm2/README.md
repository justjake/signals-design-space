# react-signals-royale-sm2

React bindings for `signals-royale-sm2`, including non-blocking signal transitions, Suspense,
per-root committed reads, component-owned atoms, causal tracing, and exact DOM mutation windows.
This package requires the included React patch series; `register()` throws when loaded with stock
React.

```tsx
import {
  atom,
  register,
  startTransitionWrite,
  useIsPending,
  useValue,
} from "react-signals-royale-sm2";

register();
const count = atom(0);

function Counter() {
  const value = useValue(count);
  const pending = useIsPending(count);
  return (
    <button onClick={() => startTransitionWrite(() => count.update((n) => n + 1))}>
      {value} {pending ? "updating" : ""}
    </button>
  );
}
```

`useValue` subscribes at commit and schedules a post-subscribe correction into every live batch the
component missed. `useComputed` creates a component-owned computed, `useSignalEffect` observes only
canonical values, `useCommitted` reads the value displayed by the current root, and `useAtom` creates
an atom whose lifetime follows its component.

`onDomMutation` emits `start` and `stop` around React's host mutation phase. A MutationObserver can
disconnect at `start` and reconnect at `stop`, excluding React's DOM work while still seeing later
third-party mutations.

`trace()` attaches a bounded causal log at runtime. Its event list includes writes, batch lifecycle,
render passes, root commits, component renders, effect runs, and Suspense settlements.
`whyLastDelivery(value)` formats the chain from the latest component render back to its write.

Run `./build.sh` to apply the patch series to a clean checkout at the supported React base and build
the linked `react`, `react-dom`, and `scheduler` packages.
