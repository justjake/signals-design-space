# signals-royale-sx2

`signals-royale-sx2` is a small reactive engine built around async cells. A settled cell is the fast path; pending values, stale refreshes, errors, and transition drafts use the same cell state instead of separate resource and signal layers.

```ts
import { atom, computed, effect, useThenable } from "signals-royale-sx2";

const count = atom(1);
const doubled = computed(() => count.get() * 2);
const profile = computed(() =>
  useThenable(fetch("/api/profile").then((r) => r.json())),
);

const stop = effect(() => console.log(doubled.get()));
count.update((value) => value + 1);
stop();
```

Atoms support lazy initialization, custom equality, reducer updates, observation-lifetime effects, batching, and deterministic disposal. Computeds are lazy and cached, trim dynamic dependencies, propagate pending graph state, preserve stale settled values during refresh, and throw stable thenables or error boxes only at read boundaries.

The five read operations are `read`, `latest`, `committed`, `isPending`, and `refresh`. Transition updates are stored as replayable operations, so an urgent update can commit immediately while a deferred reducer later replays over that new base.

Server state can be transferred with `serializeAtomState` and `initializeAtomState`. Give atoms stable `key` options when serialized data must survive array reordering.

The package has no runtime dependencies and ships its TypeScript source directly.
