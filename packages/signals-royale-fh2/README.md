# signals-royale-fh2

A concurrent signal engine designed for React. It is a complete reactive
system on its own — writable atoms, lazy cached computed values, effects —
plus the concurrency layer React needs and ordinary signal libraries lack:
speculative **draft batches** that model pending React transitions, world
folds that let a render read a self-consistent speculative state, and a
five-member read family that distinguishes what is committed, what is
newest, and what is on each screen.

The package is React-free and dependency-free. TypeScript source is the
artifact (`exports` points at `./src/index.ts`).

## The model

Canonical state lives in a push-pull reactive graph: atoms hold values,
computeds cache derivations with equality cutoff and dynamic dependency
tracking, effects re-run when what they read changes.

Concurrency is layered on top as **update queues**. A write made inside a
draft batch (in React terms: inside a transition) never touches canonical
state — it joins the atom's insertion-ordered update queue, owned by its
batch. Readers fold the queue over the base on demand:

- canonical readers skip operations owned by open batches;
- a **world** (a set of batches) folds its own batches' operations in;
- batch **retirement** makes its operations canonical in place and replays
  the whole queue — React's updater-queue rebase arithmetic, so functional
  updates re-execute in insertion order with later urgent updates
  re-applied on top. A counter at 1, `+2` in a transition, then an urgent
  `*2` shows 2 immediately and (1+2)*2 = 6 when the transition lands —
  never a reordered 4, never a torn 3.

Batches are episodic: when the last one retires, queues compact away, world
caches drop, and the engine holds nothing — quiescence costs nothing.

## API sketch

```ts
import {
  atom, computed, set, update, read, latest, committed, isPending, refresh,
  effect, effectScope, batch, untracked, subscribe,
  openBatch, retireBatch, discardBatch, readInWorld,
  serializeAtomState, initializeAtomState, installState,
  attachTracer,
} from 'signals-royale-fh2';

const count = atom(0);
const doubled = computed(() => read(count) * 2);
const dispose = effect(() => console.log(read(doubled)));
set(count, 2); // logs 4
```

### The read family

- `read(x)` — canonical: committed plus applied urgent writes; drafts
  hidden. Inside a render pass or computed evaluation it resolves that
  context's own world.
- `latest(x)` — newest intent: every open batch folded in. Never suspends;
  a pending async computed with settled history serves the stale value.
- `committed(x, container?)` — what is on screen (per root when a container
  is given). Never subscribes.
- `isPending(x)` — true while newer data loads behind stale content: an
  open batch touches the value, a fetch is in flight, or a refresh is
  outstanding. Never refetches, never suspends.
- `refresh(x)` — force a refetch with unchanged inputs. The stale value
  keeps serving until the new data settles (no fallback flash); races are
  latest-wins; a refresh inside a transition belongs to that transition.

### Async as graph state

A computed receives a `use` function. Reading a settled thenable returns
its value; an unresolved one registers for settlement and marks the
evaluation pending — the body keeps running so parallel fetches all
register before the evaluation parks. Pending is a reference-stable
sentinel value, not control flow: downstream computeds forward it,
effects see it change exactly once per generation, and settlement
invalidates like a write, committing with the world that owns it.
Rejections become one stable error box, rethrown at read sites.

```ts
const user = computed((use) => use(`user:${read(userId)}`, () => fetchUser(read(userId))));
```

The keyed form caches the factory per key; the single-argument form
`use(thenable)` deduplicates by thenable identity — pass a stable promise
(cache it outside, or in an atom) or use a key.

### Atoms

- **Lazy initializers**: `atom(() => expensive())` runs once, untracked, at
  first read, write, or subscription — never at construction. A `set`
  before the first read still runs it (equality needs the base).
- **Custom equality**: equal writes drop; every queue-replay step is gated
  by the same equality.
- **Lifetime effects**: `atom(v, { effect: (ctx) => cleanup })` runs when
  the atom gains its first subscriber of any kind (computed chain, effect,
  or host subscription) and cleans up when the last one is gone;
  same-tick flaps coalesce.

### Host integration (how React plugs in)

`host` seams classify writes (which draft batch owns a write), guard
render-phase writes, and resolve ambient render worlds. `subscribe` creates
per-subscriber watchers that receive canonical deliveries synchronously and
draft deliveries tagged with the owning batch. `reportCommittedValue`
records per-root committed views from committed renders. Everything is
weakly keyed: dropped handles reclaim.

### SSR

`serializeAtomState(atoms)` / `initializeAtomState(json, atoms)` with
positional or label keys. `installState` is not a write: no propagation, no
lifetime effects, no lazy initializer.

### Causality tracer

`attachTracer()` records writes (with batch attribution), batch lifecycle,
render passes, commits, deliveries, effect runs, and settlements — each
with a causal parent, so "why did this re-render?" is a chain walk.
Detached cost is one branch per emit site; ring mode bounds memory and
counts overflow.
