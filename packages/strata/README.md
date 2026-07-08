# Strata signals

Strata is a zero-dependency push-pull signals library. Its canonical graph stores
only committed state. While React is concurrent, each atom additionally keeps a
short operation journal; a render folds exactly the operations belonging to its
lanes over the committed base. Functional updates remain functions in that journal,
so deferred work rebases with the same arithmetic as React state queues.

```ts
import { atom, computed, effect } from 'strata-signals';

const count = atom(1);
const doubled = computed(() => count.state * 2);
const stop = effect(() => console.log(doubled.state));

count.update((value) => value + 1);
stop();
```

`Atom` supports custom equality, labels, lazy initialization, and an observed
lifecycle callback. The lifecycle is active while the atom is reachable through
any observed computed, engine effect, or React subscriber, and same-tick
unobserve/reobserve flaps are coalesced.

Computeds are lazy, cached, dynamically tracked, and may use promises without
serializing independent requests:

```ts
const profile = computed((context) => ({
	user: context.use(loadUser()),
	team: context.use(loadTeam()),
}));
```

The read family is `signal.state`, `latest(signal)`, `committed(signal)`,
`isPending(signal)`, and `refresh(computed)`. `Runtime` creates a fully isolated
graph for request-scoped SSR. `serialize`, `initialize`, and `installState` use
application-provided keys and do not materialize lazy initializers during install.

`trace(runtime, capacity)` from `strata-signals/trace` attaches a bounded causal
log. `log.explain(target)` follows the most recent render, delivery, or effect back
through batch retirement to its originating write; `overflow` counts evicted
events.
