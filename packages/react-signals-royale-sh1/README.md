# react-signals-royale-sh1

React bindings for `signals-royale-sh1` and its small React protocol patch. The protocol reports update lanes, the transaction world selected for each render call stack, root commits, and the exact host-mutation window. Transaction storage, dependency tracking, rebase, Suspense state, tracing, and per-root committed views remain in the library.

```tsx
import { atom, register, startTransitionWrite, useIsPending, useValue } from 'react-signals-royale-sh1';

register();
const count = atom(1);

function Counter() {
  const value = useValue(count);
  const pending = useIsPending(count);
  return <button onClick={() => startTransitionWrite(() => count.update((n) => n + 1))}>
    {value}{pending ? '…' : ''}
  </button>;
}
```

`useValue` claims its engine subscription during commit and performs a post-subscribe version check. `useComputed`, `useSignalEffect`, `useCommitted`, `useIsPending`, and `useAtom` cover derived values, canonical effects, screen state, pending indicators, and component-owned atoms. Registration throws on stock React so a missing protocol cannot silently degrade concurrency.

`onDomMutation` emits `start` and `stop` around React's host mutation phase. This lets a `MutationObserver` disconnect for React-owned changes and reconnect before layout and passive effects. `trace` records bounded causal chains from writes through component delivery, render passes, root commits, effects, and promise settlement.

Run `./build.sh` to verify the patches apply to the pinned React base and rebuild the local React packages.
