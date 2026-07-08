# react-signals-royale-sx2

React bindings for `signals-royale-sx2`. The package reads the exact render world reported by its small React fork, subscribes components after commit, and pins late corrective renders to the transition lane that owns them.

```tsx
import { atom } from "signals-royale-sx2";
import {
  register,
  startTransitionWrite,
  useIsPending,
  useValue,
  write,
} from "react-signals-royale-sx2";

register();
const page = atom(1);

function Pager() {
  const value = useValue(page);
  const pending = useIsPending(page);
  return (
    <button onClick={() => startTransitionWrite(() => write(page, value + 1))}>
      Page {value}
      {pending ? "…" : ""}
    </button>
  );
}
```

Call `register()` after loading `react-dom/client` and before creating a root. Registration throws on stock React so an incompatible renderer cannot silently fall back to tearing behavior.

The fork exposes only write-lane classification, render lanes and root identity, lane-pinned scheduling, render disposition, root commit facts, and exact DOM mutation-phase edges. `onDomMutation` can disconnect a `MutationObserver` while React mutates and reconnect it afterward. `trace()` records bounded causal chains for writes, batches, component deliveries, effects, Suspense settlement, render passes, and root commits.

The package also exports `useComputed`, `useSignalEffect`, `useCommitted`, `useIsPending`, `useAtom`, `write`, `reduce`, and `startTransitionWrite`.
