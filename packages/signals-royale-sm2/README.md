# signals-royale-sm2

A small dependency-free signal graph with lazy computeds, synchronous effects, batching, async
graph state, and concurrent render worlds.

```ts
import { atom, batch, computed, effect } from "signals-royale-sm2";

const price = atom(10);
const quantity = atom(2);
const total = computed(() => price.get() * quantity.get());

const dispose = effect(() => {
  console.log(total.get());
});

batch(() => {
  price.set(12);
  quantity.update((value) => value + 1);
});

dispose();
```

Atoms accept `equals`, `label`, `key`, and `effect` options. A function initial value is lazy: it
runs once, without dependency tracking, when the atom is first read, written, or subscribed.
`effect` on an atom observes its lifetime rather than its values; it starts at the first subscriber
of any kind and cleans up after the last subscriber leaves.

Computeds are lazy and cached. They trim dynamic dependencies, stop downstream propagation when
their value remains equal, and accept a `use(promise)` argument for async graph state. Pending work
is retained in the graph, so repeated reads throw the same thenable and every async read encountered
by one evaluation is registered before it parks.

The read family is available from a `Runtime`: canonical reads use `.get()`, `latest` includes the
current render world, `committed` reads a root's on-screen world, `isPending` is a non-fetching probe,
and `refresh` re-evaluates async work while retaining settled data.

For server rendering, give atoms stable `key` values and use `serializeAtomState` and
`initializeAtomState`. Installing serialized state does not run a lazy initializer and does not count
as a write.
