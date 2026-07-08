# signals-royale-fm2

A concurrent signal engine designed to sit under React, with no React
dependency of its own. Alongside the usual signal toolkit — writable atoms,
cached computeds, effects, batching — it models *pending write batches*:
groups of writes that stay invisible to normal readers until an external
scheduler (in practice, a React commit) retires them.

```ts
import { atom, computed, effect, set, update, batch } from 'signals-royale-fm2';

const count = atom(1);
const doubled = computed(() => count.get() * 2);
const stop = effect(() => {
	console.log(doubled.get());
});
set(count, 3); // logs 6
stop();
```

## The state model

Every atom keeps a committed base value plus a dispatch-ordered queue of
writes. Each queued write is tagged with the batch that issued it; writes
issued outside any batch are urgent and canonically visible immediately.

- A **canonical read** (`x.get()`, `read(x)`) folds the base through urgent
  writes only. Drafts from open batches are hidden.
- A **world** is a set of open batches. Reading inside a world
  (`withWorld([b], () => x.get())`) folds the base through urgent writes
  *and* that world's drafts, still in dispatch order.
- **Retiring** a batch marks its writes as committed in place and advances
  the base through the committed prefix of the queue. Functional updates
  (`update(x, fn)`) therefore replay against whatever base the interleaved
  urgent writes produced — exactly React's update-queue arithmetic: a counter
  at 1 with a pending `+1` draft and an immediate `×2` shows 2 now and 4
  after the draft's batch retires.
- **Aborting** a batch drops its drafts and re-notifies anyone who saw them.

With no open batches anywhere, the queue machinery costs nothing: urgent
writes land directly on the base value.

## Read family

- `read(x)` — canonical value (committed plus applied urgent writes).
- `latest(x)` — newest intent: folds every open batch. Inside a computed
  evaluation or a render pass it resolves that context's own world. Serves
  the last settled value while an async evaluation is pending.
- `committed(x, view?)` — what a host (a React root) last put on screen,
  via a `CommittedView` the host records into at its commits. Never
  subscribes. Without a view: canonical state.
- `isPending(x)` — true while newer data (an open draft or an async refetch)
  loads behind the visible value. Never refetches, never suspends.
- `refresh(x)` — force a computed to refetch with unchanged inputs. The
  stale value keeps serving; races resolve latest-wins; a refresh issued
  inside a batch belongs to that batch.

## Async computeds

A computed's function receives `use`:

```ts
const user = computed((use) => use(`user-${id.get()}`, () => fetchUser(id.get())));
```

`use(thenable)` or `use(key, factory)` unwraps a promise-like value. If it
has not settled, the evaluation parks as *pending*: every async read made
before parking registers first (parallel fetches), downstream computeds
forward the pending state, and read sites throw a reference-stable pending
box that doubles as a thenable — React can rethrow it across Suspense
retries without triggering new fetches. Settlement behaves like a write:
it invalidates and propagates, and it belongs to the batch that owned the
fetch. Rejections become reference-stable error boxes rethrown at read
sites.

## Atoms

```ts
const a = atom(0, {
	equals: (x, y) => x === y, // equal writes drop
	label: 'a',
	effect: (ctx) => {          // lifetime effect (observed lifecycle)
		const socket = connect((v) => ctx.set(v));
		return () => socket.close();
	},
});
```

- **Lazy initializers**: `atom(() => expensive())` runs the initializer
  once, untracked, at first read, write, or subscription — never at
  construction. A `set` before the first read still runs it, because the
  equality contract needs the base value. Initializers must not write.
- **Lifetime effects**: the `effect` option runs when the atom gains its
  first subscriber of any kind (engine effect, live computed chain, or host
  subscription) and its cleanup runs when the last one leaves. Exactly one
  observation across all kinds; subscribe/unsubscribe flaps within a tick
  coalesce to nothing.

## Effects and scopes

`effect(fn)` runs immediately and re-runs when a canonical dependency
changes; return a cleanup from `fn` and it runs before each re-run and at
disposal. Effects observe canonical state only — never drafts. Effects
created inside a running effect are disposed before the outer effect
re-runs. `effectScope(fn)` collects effects for one-call disposal.
`batch(fn)` coalesces notifications into one flush; writes that revert
within a batch trigger nothing downstream.

## SSR

```ts
const json = serializeAtomState({ count, name });
// on the client, before the first render:
initializeAtomState(json, { count, name });
```

`installState` (and `initializeAtomState`, which calls it per key) replaces
an atom's value without write semantics: no equality check, no
notifications, and lazy initializers do not run — installing is not a
write, so the first client render matches the server exactly.

## Causality tracing

`startTrace()` attaches a bounded ring log (overflow is counted, never
silent). Every event — writes with batch attribution, batch open/retire,
settlement, effect runs, plus whatever the host emits (render passes,
commits, deliveries) — carries a causal parent, and `tracer.why(pred)`
formats the chain from the newest matching event back to its root cause.
Detached, every emit site costs one branch.

## Leak posture

Dropped handles reclaim: producers hold no references to non-subscribed
consumers, disposal is deterministic everywhere (`effect`, `effectScope`,
`subscribeNode` all return disposers), retired and aborted batches release
every draft and cache they own, and quiescence leaves no per-episode state.
The test suite pins this under `--expose-gc`.
