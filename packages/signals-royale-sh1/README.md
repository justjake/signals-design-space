# signals-royale-sh1

A small, dependency-free signal graph with transactional worlds. Ordinary writes update canonical state immediately. Deferred writes append `set` and functional-update operations to a transaction; reads can select canonical state, the newest intent, or a specific transaction world. Committing replays those operations over the current canonical base, so an intervening urgent update is never overwritten by an old snapshot.

```ts
import { atom, computed, effect, openTransaction, runInTransaction, retireTransaction } from 'signals-royale-sh1';

const count = atom(1);
const doubled = computed(() => count.state * 2);
const stop = effect(() => console.log(doubled.state));

const transaction = openTransaction();
runInTransaction(transaction, () => count.update((value) => value * 2));
count.update((value) => value + 1); // canonical value is now 2
retireTransaction(transaction, true); // replayed result is 4
stop();
```

Computeds are lazy and cached, trim dynamic dependencies, and stop propagation when their value is equal. Effects run only against canonical state. `batch` coalesces synchronous changes, while `untracked` suppresses dependency collection. Atoms support lazy initialization, custom equality, labels, serialization keys, and an observed-lifetime effect that spans all computed, effect, and UI subscribers.

Promise reads are collected as graph state. A computed registers all pending reads reached during evaluation and exposes one stable joined thenable until they settle. `latest`, `committed`, `isPending`, and `refresh` provide the remaining read modes needed by Suspense-aware integrations.

Top-level effect disposers are watched with `FinalizationRegistry`; dropping a disposer releases its graph subscription. Explicit disposal remains the deterministic choice.
