# signals-royale-sm1

`signals-royale-sm1` is a dependency-free reactive state library with lazy computed values,
effects, batching, asynchronous resources, and concurrent render views. Its TypeScript source is
the package artifact; no build step is required.

```ts
import { atom, computed, effect, batch } from "signals-royale-sm1";

const count = atom(1, { label: "count" });
const doubled = computed(() => count.state * 2);
const stop = effect(() => console.log(doubled.state));

batch(() => {
  count.update((value) => value + 1);
  count.update((value) => value * 3);
});

stop();
```

Atoms accept custom equality, lazy initializers, stable serialization keys, and an observed-lifetime
effect. A lazy initializer runs once on the first read, write, or subscription. The lifetime effect
runs while at least one computed, effect, or React component observes the atom; quick unsubscribe
and resubscribe cycles are coalesced in a microtask.

Computeds are lazy and dynamically track dependencies. An asynchronous computed can return a
thenable directly or use every thenable it needs before becoming pending:

```ts
const userRequest = loadUser();
const teamRequest = loadTeam();
const profile = computed((use) => {
  const user = use(userRequest);
  const team = use(teamRequest);
  return { user, team };
});
```

Pending and error states remain cached on the graph. `latest`, `committed`, `isPending`, and
`refresh` provide non-suspending inspection and stale-while-refresh behavior. Functional atom
updates are retained as functions so a deferred render can replay them over newer committed state.

Use `serializeAtomState` and `initializeAtomState` with a keyed atom record for server rendering.
`installState` bypasses lazy initialization and does not emit a write. `startTrace()` attaches a
bounded causality log; detached tracing adds only the event-site branch.

The package is React-free. React integration is provided by `react-signals-royale-sm1`.
