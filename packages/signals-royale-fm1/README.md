# signals-royale-fm1

A reactive signals engine designed for concurrent React, built around one
idea: **speculative state is a replay, not a copy**.

Canonical state lives in an ordinary reactive graph — writable atoms, lazy
cached computeds, effects. Speculative state (what a React transition wants
the world to become) never touches that graph. Instead, every write issued
inside a transition is recorded as a *write intent* — a value, or a function
of the previous value — in a per-atom log. Reading through a *snapshot*
replays the log; committing a transition replays the log and installs the
result. There is no second store to reconcile, no world to fork and merge:
the world **is** the replay.

## The reactive graph

```ts
import { atom, computed, effect, batch, untracked } from 'signals-royale-fm1';

const count = atom(1);
const doubled = computed(() => count.get() * 2);
const dispose = effect(() => console.log(doubled.get()));
count.set(2); // logs 4
```

- **Atoms** hold values, drop equal writes (custom `equals` supported), and
  accept a lazy initializer: `atom(() => expensive())` runs the initializer
  once, untracked, at the first read, write, or subscription — never at
  construction. A `set` before the first read still runs it, because the
  equality contract needs a base value to compare against.
- **Computeds** are lazy, cached, and cut off propagation when their value
  comes out equal. Dependency tracking is dynamic with trimming: each
  evaluation records exactly what it read.
- **Validation is value-aware.** Each dependency edge remembers what the
  consumer last saw. A write that reverts inside a `batch` — set to 5, set
  back to 0 — never re-runs anything downstream, because polling finds no
  real difference.
- **Effects** re-run when a dependency's canonical value changes; the return
  value of the effect function is its cleanup. Effect scopes collect effects
  for group disposal.
- **Lifetime effects**: `atom(0, { onObserved: (ctx) => { …; return teardown } })`
  runs when the atom gains its first subscriber of any kind (computed chain,
  effect, or React component) and tears down when the last one leaves.
  Subscribe/unsubscribe flaps within one tick coalesce to nothing — mount a
  socket exactly while something watches.

## Concurrent worlds

```ts
import { openBatch, withAmbientBatch, write, update, commitBatch, Snapshot } from 'signals-royale-fm1';

const b = openBatch();
withAmbientBatch(b, () => update(count, (x) => x + 1)); // recorded, not applied
count.peek();      // unchanged: drafts are invisible to canonical readers
commitBatch(b);    // the intent replays onto whatever is canonical NOW
```

Writes are classified. Urgent writes hit canonical state immediately.
Transition writes are recorded in a `Batch`. While any batch holds intents
for an atom, *every* write to it — urgent included — appends to the atom's
rebase log in call order. Each world replays the entries it can see:

- **Canonical** sees urgent writes and retired batches.
- **A snapshot** (one render pass's world) sees those plus the open batches
  that pass is rendering, pinned at a fixed history point so an async render
  never tears.
- **Retirement** replays urgent + retired entries and installs the result:
  a transition that added 2 under an urgent doubling lands as `(base+2)*2` —
  React's updater-queue arithmetic, replay without reordering.

Effects observe canonical state only; a draft can never leak into one.

## Reading

Five reads, five questions:

- `x.get()` / `x.peek()` — canonical: committed plus applied urgent writes.
- `latest(x)` — newest intent including open drafts; never suspends; inside
  a snapshot it answers for *that* world (reading ahead would be a tear).
- `committed(x, container?)` — what is on screen (per React root when the
  bindings supply a container).
- `isPending(x)` — cheap flip-only probe: is newer data loading behind the
  current value? Never refetches, never suspends.
- `refresh(x)` — force a refetch with unchanged inputs; the stale value
  keeps serving while the new evaluation loads.

## Async

Pending and error are graph states, not control flow. A computed's function
receives `use`:

```ts
const user = computed((use) => use(fetchUser(id.get())));
```

An unresolved thenable parks the evaluation: the computed holds one stable
promise that read sites rethrow (a Suspense boundary retries against the
same promise, so nothing refetches), every thenable touched before the park
registers first (parallel fetches), and settlement behaves like a write —
invalidate, propagate, flush once. Errors become reference-stable and
rethrow at every read site.

## Debugging

`Tracer` records a causal event log — writes, batch opens and retirements,
settlements, effect runs — where every event carries its causal parent.
Detached it costs one branch per emit site; the ring mode bounds memory and
counts overflow instead of dropping it silently.

## SSR

`serializeAtomState(atoms)` / `initializeAtomState(json, atoms)` with
app-supplied keys. Install is not a write: no notifications, and lazy
initializers do not run — the installed value simply becomes the base.

## Memory

Nothing here leaks by design: batches, logs, and snapshots are per-episode
state reclaimed at quiescence; dropped atoms, computeds, and disposed
effects are unreachable immediately (plain GC, no registries to scrub).
The test suite includes a `--expose-gc` audit proving it.
