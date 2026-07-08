# signals-royale-fh1

A reactive signal engine built for concurrent UIs. Every write is a
version-stamped record; every reader is a visibility predicate evaluated over
small per-signal write histories. That one idea gives you React-grade
concurrency semantics — transactional "draft" writes, rebasing functional
updates, tear-free render snapshots, per-screen committed views — with plain
signals ergonomics and zero dependencies.

```ts
import { atom, computed, effect } from 'signals-royale-fh1';

const count = atom(0);
const doubled = computed(() => count.get() * 2);
const stop = effect(() => console.log(doubled.get()));
count.set(2); // logs 4
stop();
```

## Core

- `atom(initial, opts?)` — writable signal. `initial` may be a function: a
  lazy initializer that runs once, untracked, at first read, write, or
  subscription (never at construction). Options: `equals` (equal writes
  drop), `label`, and `effect` — an observed-lifecycle callback that runs
  while the atom has at least one subscriber of any kind (computed chain,
  effect, or UI hook) and cleans up when the last one leaves. Subscribe and
  unsubscribe churn within one tick coalesces.
- `computed(fn, opts?)` — lazy, cached, equality-cutoff derived value with
  dynamic dependency tracking. `fn` receives a `use` function for async
  reads (below).
- `effect(fn)` / `effectScope(fn)` — side effects with cleanup, returning
  disposers. Effects observe canonical state only — never speculative drafts.
- `batch(fn)` / `startBatch()` / `endBatch()` — synchronous write coalescing:
  one effect flush per scope. `untracked(fn)` — read without subscribing.

## Deferred batches (the concurrent model)

A `Batch` is a transaction of intent. Writes made inside `batch.run(fn)` are
drafts: invisible to canonical readers and effects until the batch retires.

```ts
const b = createBatch();
b.run(() => count.update((x) => x + 1)); // a draft
count.update((x) => x * 2); // urgent: applies now
count.get(); // 0*2 = 0 ... urgent only
b.retire(); // replay: (0 + 1) * 2? No — in sequence order: (0+1) folded under *2
```

Functional updates replay: the engine keeps the interleaved log of updaters
per atom, and a retiring batch refolds the whole sequence from the base — a
transition's `+2` under a later urgent `*2` lands as `(base+2)*2`, exactly
like a React updater queue. `discard()` drops a batch's intent and
re-notifies anyone who saw it.

A `World` is a visibility predicate: canonical history up to a cutoff
sequence, plus the drafts of listed batches replayed on top. Hosts (like the
React bindings) give every render pass one world, so sibling readers always
agree. At quiescence — no live batches, no open worlds — every history, log,
draft edge, and world cache is reclaimed; the steady state costs nothing and
holds nothing.

## The read family

- `read(x)` / `x.get()` — canonical: committed state plus applied urgent
  writes; drafts hidden.
- `latest(x)` — newest intent including drafts; never suspends (serves the
  last settled value while an async evaluation loads). Inside a computed
  evaluation or a render pass it resolves that context's own world.
- `committed(x, container?)` — what is on screen (per-root when the host
  installs per-container cutoffs); never subscribes.
- `isPending(x)` — cheap flip-only probe: true while newer data loads behind
  the value being shown. Never refetches.
- `refresh(x)` — force refetch with unchanged inputs; the stale value keeps
  serving; latest-wins on races; a refresh inside a batch belongs to it.

## Async

Pending and error are graph state, not control flow. Inside `computed(fn)`,
`use(thenable)` unwraps settled work synchronously and parks the evaluation
on unresolved work by throwing a reference-stable `PendingValue` box;
settlement behaves as a write (invalidate, then propagate, attributed to the
batch that owns the fetch). Rejections become stable errors rethrown at read
sites. The keyed form `use(key, factory)` caches per node and refresh epoch,
so re-evaluations reuse in-flight requests — fetch counts stay stable across
retries — while `refresh` re-runs factories.

## Causality debug log

`startTrace(opts?)` attaches an event log where every event carries the id of
the event that caused it: writes (with batch attribution), batch open /
retire / discard, deliveries to subscribers, effect runs, settlements,
observations. `handle.explain(id)` formats the causal chain. Detached, every
emit site costs one branch. `{ ring: n }` bounds memory to the newest n
events; overflow is counted, never silent.

## SSR

`serializeAtomState(atoms, replacer?)` and
`initializeAtomState(json, atoms, reviver?)` move canonical values across the
wire with app-supplied keys. Install is not a write: no notifications, and
lazy initializers do not run.

## Verification

- 179/179 on the reactive-framework-test-suite conformance battery.
- A randomized oracle fuzzes the engine against a naive fold model of these
  exact semantics (`ROYALE_FUZZ_SEEDS` env-tunable).
- A GC audit proves dropped handles reclaim and quiescence leaves nothing.
