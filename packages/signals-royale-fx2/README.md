# signals-royale-fx2

A reactive state engine with first-class support for React concurrent
rendering. It is two layers:

- a conventional signal graph — writable signals, lazy cached computeds,
  effects, batching — with exact recompute counts and equality cutoff;
- a small concurrency overlay — WORLDS — that lets speculative writes (React
  transitions) stay invisible to committed readers until they land, while
  every reader still sees an internally consistent snapshot.

The package is React-free and dependency-free. TypeScript source is the
artifact (`exports` points at `src/index.ts`); every syntax used is erasable,
so it also runs directly under Node's type stripping.

## Core API

```ts
import { signal, computed, effect, batch, untracked } from 'signals-royale-fx2';

const count = signal(1);
const double = computed(() => count.get() * 2);
const stop = effect(() => console.log(double.get())); // runs now, then on change

count.set(2);                 // effect logs 4
count.update((x) => x + 1);   // functional update
batch(() => {                 // one flush for the whole scope
  count.set(10);
  count.set(1);               // net no-op: nothing recomputes, nothing runs
});
stop();
```

- **Equality:** writes that compare equal are dropped. Pass
  `{ equals }` to customize; pass `{ label }` to name a signal in traces.
- **Lazy initializers:** `signal(() => expensive())` runs the function once,
  untracked, at first use (read, write, or subscription — never at
  construction). A `set` before the first read still runs it, because the
  equality contract needs the base value. Initializers must not write.
- **Computeds** are lazy and cached, track dependencies dynamically (a
  branch not taken this evaluation is not a dependency), and only recompute
  when an input's value generation actually advanced.
- **Effects** re-run when their dependencies change; returning a function
  registers a cleanup. `effectScope(fn)` collects every effect created
  inside and returns one disposer.

## Intents, drafts, and worlds

Writes are INTENTS: either a value (`set`) or a function to re-execute
against whatever the base turns out to be (`update`). Urgent intents apply
immediately. Intents issued inside a React transition are recorded into a
DRAFT instead — an ordered log attached to that transition.

A WORLD is "committed state plus a specific set of drafts". Resolving a
value in a world replays, in original dispatch order, the intents that world
is allowed to see. That single rule produces React's updater-queue behavior:

```ts
const n = signal(1);
// transition records: update(x => x + 2)     (draft D)
// urgent write:       update(x => x * 2)
n.get()      // 2      — urgent skipped the draft: 1 * 2
// world with D: (1 + 2) * 2 = 6   — replay in dispatch order, never reorder
```

When a draft RETIRES (its transition committed everywhere), the full replay
folds into committed state through the ordinary write path — effects run,
equality applies — and renders still holding the draft's id resolve the same
values, so retirement is invisible to them. A discarded draft rolls back:
speculative readers are re-notified and re-resolve without it. When the last
draft dies, every per-draft structure is dropped; a quiescent engine holds
nothing extra.

## The read family

```ts
count.get()        // committed state plus applied urgent writes; drafts hidden
latest(count)      // newest intent, drafts included; never suspends
committed(count)   // what is on screen (per root with committed(x, container))
isPending(count)   // true while newer data exists behind the shown value
refresh(query)     // force a refetch with unchanged inputs; stale keeps serving
```

Inside a computed evaluation (or a render pass, through the React bindings)
`latest` and `get` resolve that context's own world — reading ahead of your
world would be a tear. In a canonical computed or effect, `latest(x)` is
also a tracked dependency: when `x` changes, the reader re-runs. What
distinguishes `latest` from `get` is that it never suspends, not that it
reads a different world from inside an evaluation.

## Async values

Pending and error are graph STATE, not control flow:

```ts
const user = computed((use) => use(fetchUser(id.get())));
```

- `use(thenable)` returns the settled value, or parks the evaluation. A
  parked computed keeps serving its last settled value ("stale") and exposes
  one stable pending promise per span, so a suspended React render retries
  exactly once per settlement and never re-issues fetches.
- Settlement behaves as a write: it invalidates and propagates, and parked
  computeds re-evaluate eagerly so chained requests progress without a
  reader.
- Errors rethrow the same reason object at every read site.
- Keep thenables stable per input set (derive them from state, as above).
  A function that creates a brand-new promise on every evaluation would
  refetch on every settlement — that is a data-layer bug this engine cannot
  paper over.

## Observed lifecycle

```ts
const price = signal(0, {
  onObserved: ({ get, set }) => {
    const socket = subscribePrices(set);
    return () => socket.close();
  },
});
```

The callback runs when the atom gains its FIRST subscriber of any kind
(effect, watched computed chain, or React component) and the cleanup runs
when the LAST subscriber of every kind is gone. Subscribe/unsubscribe flaps
within a tick coalesce, so a StrictMode double-mount nets one activation.

## Server rendering

```ts
serializeAtomState([a, b]);            // or { name: atom } records
initializeAtomState(json, [a2, b2]);   // fresh client atoms
installState(atom, value);             // one atom
```

Installing is not a write: no propagation, no equality check, and lazy
initializers do not run — the installed value satisfies the first read.

## Causality tracing

```ts
const t = attachTracer({ capacity: 4096 });
// ... run your app ...
t.whyLastDelivery(node); // ["#42 deliver", "#41 write \"count\"", ...]
t.events();              // ring contents; t.dropped counts evictions
t.stop();
```

Every event carries a causal parent: a re-render chains to the write that
caused it, a fold write chains to the draft retirement, a retirement chains
to the transition's last write. Unrelated operations never chain. Detached
cost is one null check per emit site; the ring never grows past its
capacity and overflow is counted, never silent.

## Ownership and reclamation

- Computeds hold references toward their dependencies only, and join
  subscriber lists only while observed. Dropping the last reference to an
  unobserved computed chain makes the whole chain collectible.
- Effect disposers are FinalizationRegistry-backed: a dropped, uncalled
  disposer reclaims its effect. Calling it is still deterministic and
  preferred.
- Draft retirement clears rebase logs and world memos (see above).

Leaks are bugs here, not optimizations.
