# signals-royale-fx1

A reactive signal engine designed to sit under a concurrent UI scheduler.
React-free, zero runtime dependencies, TypeScript source consumed directly.

## Why another signal engine

Ordinary signal libraries have one timeline: a write happens, everything
downstream recomputes, subscribers hear about it. A concurrent UI needs two:
urgent changes that must be visible now, and deferred changes that should be
prepared in the background and revealed atomically later. This engine makes
that second timeline a first-class concept — an **episode** — instead of
something bolted on with snapshots.

- **Urgent writes** replace an atom's canonical value immediately.
- **Episode writes** (issued inside a transition scope the host classifies)
  never touch the canonical value. They append operations to the atom's
  update queue, tagged with their episode.
- A **world** is "the canonical base plus the operations of some episodes,
  replayed in scheduling order". Functional updates re-execute against
  whatever base they replay on, so an urgent `x => x * 2` over a pending
  `x => x + 2` on `1` shows `2` now and `(1 + 2) * 2 = 6` when the episode
  lands — the update-queue arithmetic a React user expects.
- When the host reports that an episode is fully committed, the episode
  **retires**: its ops fold into the canonical base once and every trace of
  it is reclaimed. A quiescent engine holds nothing per-episode.

Render passes read through a **frame**: the base pinned at a write-sequence
plus the episodes the pass covers. Pinning is MVCC-style — urgent writes that
land while a time-sliced render is in flight stay invisible to that pass, so
one pass always reads one self-consistent world.

## Core API

```ts
import { atom, computed, effect, batch, untracked } from 'signals-royale-fx1';

const count = atom(0);
const doubled = computed(() => count.get() * 2);
const stop = effect(() => console.log(doubled.get()));
count.set(2); // logs 4
stop();
```

- `atom(initial, opts?)` — writable value. A function initial value is a lazy
  initializer: it runs once, untracked, at first read/write/subscription, and
  must not write. `opts.equals` drops equal writes; `opts.onObserved` is a
  lifetime effect (below); `opts.label` names the atom in traces.
- `computed(fn, opts?)` — lazy, cached, equality cutoff, dynamic dependency
  tracking with trimming. `fn` receives `use` for async reads (below).
- `effect(fn)` — runs now and on canonical changes; returns a disposer. A
  disposer that is dropped without being called is reclaimed through a
  FinalizationRegistry: dropped handles never leak.
- `effectScope(fn)` — collects effects into one disposable scope.
- `batch(fn)` / `startBatch()` / `endBatch()` — coalesce: one flush per
  outermost scope, judged by net value change (write-then-revert is a no-op).
- `untracked(fn)` — read without registering dependencies.

### Memory model

Only live subscriptions hold strong references. A computed nobody watches
keeps forward pointers only — nothing points back at it, so dropping your
reference reclaims it and everything it captured; it revalidates by version
polling when read again. Watched computeds flip to push-invalidation and
flip back when the last watcher leaves.

### The read family

- `read(x)` — canonical: committed state plus applied urgent writes; drafts
  hidden.
- `latest(x)` — newest intent: every open episode folded over the live base.
  Inside a render pass or computed evaluation it resolves that context's own
  world. Never suspends (a pending evaluation serves its last settled value).
- `committed(x, container?)` — what is on screen; per-root when a container
  is given. Never subscribes.
- `isPending(x)` — cheap flip-only probe: true while newer data (a draft or
  a refetch) is loading behind what canonical readers see. Never evaluates
  anything, so it can never refetch or suspend.
- `refresh(x)` — refetch with unchanged inputs. The stale value keeps
  serving; latest-wins on races; a refresh inside a transition belongs to
  that transition.

### Async computeds

```ts
const user = computed((use) => use(fetchUser(userId.get())));
```

`use(thenable)` on an unsettled thenable records it and returns an inert
placeholder so the rest of the function still runs — every async read the
function can reach registers in one pass, so independent fetches start in
parallel. The evaluation then parks as *pending*: downstream evaluations
forward the pending state, and readers get a stable representative promise
(retrying a suspended render re-reads the same evaluation instead of
refetching). Thenable slots are keyed by call order and survive re-runs
caused by settlements; they reset exactly when a real input changed or
`refresh()` forced new fetches. Errors become reference-stable and rethrow
at read sites. A settlement behaves as a write and is owned by the world
that started the fetch: data fetched for a transition commits with that
transition.

### Lifetime effects

```ts
const price = atom(0, {
  onObserved: ({ set }) => {
    const socket = subscribe('price', set);
    return () => socket.close();
  },
});
```

`onObserved` runs when the atom gains its first watcher of any kind — an
effect, a live computed chain, or a UI subscriber — and its cleanup runs when
the last watcher of every kind is gone. Flaps within a tick coalesce, so a
strict-mode double-mount nets one observation.

### SSR

`serializeAtomState(atoms, replacer?)` writes canonical values keyed by atom
labels (positional keys as fallback); `initializeAtomState(json, atoms,
reviver?)` installs them. Installing is not a write: no notifications, no
equality checks, and lazy initializers do not run — the server value replaces
them.

### Causality tracing

`startTrace()` attaches a bounded ring buffer of events (writes with batch
attribution, batch open/retire, render pass start/end, commits, deliveries,
effect runs, settlements), each with a causal parent. `whyLastDelivery(x)`
formats the chain from the latest delivery about `x` back to the write or
retirement that caused it. Detached, tracing costs one null check per site;
ring overflow is counted, never silent.

## Host integration

Everything UI-shaped is behind a small host protocol (`setHost`, `beginPass`,
`commitPass`, `subscribe`, `renderRead`, …): the host classifies writes into
batch tokens, tells the engine which episodes each render pass covers, and
reports commits. `react-signals-royale-fx1` is the React host.
