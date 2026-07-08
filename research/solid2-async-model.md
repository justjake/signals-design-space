# Solid 2.0's Async Model: Status Bits, Suspense, Transitions, Lanes, Optimistic

A unified specification of Solid 2.0's advanced reactive features — first-class async
derivations, loading boundaries ("suspense"), implicit transitions, optimistic updates —
precise enough to implement a compatible `resource`/`createAsync` in another library.

*Verified 2026-07: all test suites cited below were executed against the vendored source
(`npx vitest run` in `packages/solid-signals`) — 273/273 tests pass
(`createMemo`, `createLoadingBoundary(.on)`, `createOptimistic`, `action`,
`transitionEntanglement`, `onSettled`, `syncThenable`, `enforceLoadingBoundary`).*

**Ground truth** is the vendored source at
`/Users/jitl/src/alien-signals-opt/vendor/solid` (branch `next`), package
`packages/solid-signals`: core in
`src/core/{constants,types,error,graph,core,async,effect,scheduler,lanes,owner,heap,action}.ts`,
API in `src/signals.ts` and `src/boundaries.ts`. Every behavioral claim cites a source
function and/or a test name from `packages/solid-signals/tests/` — the tests are the
executable spec. Secondary sources (design rationale only) at the bottom.

**Headline correction to common assumptions**: Solid 2.0 has **no `createAsync`, no
`createResource`, no `startTransition`/`useTransition`, no `Suspense` primitive**. The
`packages/solid/src/index.ts` "Not Implemented" block says it directly: `createResource →
"all computations"`, `Suspense → Loading`, `onMount → onSettled`, `from → "handled by
async iterators"`, `startTransition` gone (replaced by `action`). Async is folded into
`createMemo` / `createSignal(fn)` / `createEffect`'s compute phase / projections: **any
compute function may return a `PromiseLike<T>` or `AsyncIterable<T>`** and the node
becomes an async source. A "resource" in Solid 2.0 is just `createMemo(async () => ...)`
plus `refresh()`.

---

## 0. Terms and the cast of characters

- **Node**: a `Signal<T>` (plain value cell) or `Computed<T>` (has `_fn`, deps, owner
  role). Effects are `Computed`s with `_type ∈ {EFFECT_RENDER=1, EFFECT_USER=2,
  EFFECT_TRACKED=3}` and a separate side-effect function (`effect.ts`).
- **Firewall signal**: an internal signal owned by a computed (`_firewall` points to it),
  used by projections/stores. For status purposes the *owner* (`_firewall || el`) carries
  the status bits; reads of the child signal consult the owner (`read()` in `core.ts`).
- **`_flags`**: *dirtiness* bits (`REACTIVE_DIRTY`, `REACTIVE_CHECK`,
  `REACTIVE_OPTIMISTIC_DIRTY`, `REACTIVE_ZOMBIE`, ...) — scheduling state.
- **`_statusFlags`**: *async status* bits (`STATUS_PENDING`, `STATUS_ERROR`,
  `STATUS_UNINITIALIZED`) — a **separate field** from `_flags` (`constants.ts:23-26`,
  `types.ts` `Computed`).
- **`NotReadyError`**: the exception thrown by a tracked read of a pending source
  (`error.ts`). Carries `.source` (the async node that is actually waiting). It is the
  *suspension signal*; boundaries catch it. `StatusError` wraps real user errors and
  carries `.source` + `.cause`.
- **Clock / heap**: a global `clock` incremented once per flush cycle; per-node `_time`
  stamps the cycle of last recompute. Dirty nodes go into a min-heap keyed by graph
  `_height` (`heap.ts`, `dirtyQueue`/`zombieQueue`) so recomputation is topological.
- **Transition**: an implicit batch that holds committed state stable while async work it
  caused is in flight (`scheduler.ts` `Transition`). Created automatically — there is no
  user-facing "startTransition".
- **Lane** (`lanes.ts` `OptimisticLane`): the propagation context of one optimistic
  write; owns its own effect queues so optimistic UI flushes independently of the
  held transition.
- **Boundary**: `createLoadingBoundary` / `createErrorBoundary` (`boundaries.ts`) — a
  `CollectionQueue` spliced into the owner's queue chain that intercepts status
  *notifications* (not throws) for one status dimension.

Value buffers on every node (`types.ts` `RawSignal`): `_value`, `_pendingValue`
(sentinel `NOT_PENDING` when empty), `_overrideValue` (sentinel `NOT_PENDING` = "armed
but inactive"; `undefined` = not optimistic-capable), `_snapshotValue`, plus two lazily
created helper nodes `_pendingSignal` (backs `isPending`) and `_latestValueComputed`
(backs `latest`). See §3.

---

## 1. The status model

`STATUS_NONE = 0`, `STATUS_PENDING = 1<<0`, `STATUS_ERROR = 1<<1`,
`STATUS_UNINITIALIZED = 1<<2` (`constants.ts`). They live in `Computed._statusFlags`;
plain signals have no status (their firewall owner does). Alongside them:

- `_error`: the current `NotReadyError` (when pending) or error (when errored).
- `_pendingSource` / `_pendingSources: Set` — *which upstream async node(s)* this node
  is waiting on (`async.ts` `addPendingSource`/`removePendingSource`). One field for the
  common single-source case, promoted to a Set when waiting on several.
- `_blocked: boolean` — set when this node's **own body** threw `NotReadyError`
  (`core.ts` `recompute` catch). Distinguishes "my execution aborted, re-run me at
  settle" from "status was forwarded to me without execution" (§4).
- `_inFlight: PromiseLike | AsyncIterable | null` — the async result the node is
  currently subscribed to. Guards stale resolutions (`asyncWrite` checks
  `el._inFlight !== result`) and blocks error-retry while a fetch is outstanding.

### Meaning and transitions

- **`STATUS_UNINITIALIZED`** — "no value has ever committed". Set at construction
  (`computed()` object literal: `_statusFlags: STATUS_UNINITIALIZED`). Cleared in two
  places only: `clearStatus(el, /*clearUninitialized*/ true)` when a create-time compute
  completes synchronously, and `commitPendingNode` (`scheduler.ts`):
  `if (!(c._statusFlags & STATUS_PENDING)) c._statusFlags &= ~STATUS_UNINITIALIZED` —
  i.e. **uninitialized clears when the first real value commits at flush**, not when the
  promise resolves. (Regression test for exactly this ordering: *"isPending fires on the
  FIRST refresh when it is the only consumer (#2806)"*, `createOptimistic.test.ts`.)
  Also forces the first async resolution through the not-equal path regardless of
  `equals` (`recompute`: `valueChanged = (!isEffect && wasUninitialized) || ...`; test
  *"should ignore equals on first async resolution without a seeded baseline"*,
  `createMemo.test.ts`).
- **`STATUS_PENDING`** — "an async value I need is in flight". Two flavors, same bit:
  *self-pending* (this node's own compute returned an unresolved promise; its `_error`
  is a `NotReadyError` whose `.source === el`) and *forwarded-pending* (`_error.source`
  is some upstream node, recorded in `_pendingSource(s)`). Set by `notifyStatus`
  (`async.ts`), preserving `STATUS_UNINITIALIZED`:
  `el._statusFlags = STATUS_PENDING | (el._statusFlags & STATUS_UNINITIALIZED)`.
  Cleared by `clearStatus` (successful recompute), by `settlePendingSource` when the
  last pending source settles, or overwritten by a real error.
- **`STATUS_ERROR`** — compute threw a non-`NotReadyError`, or the promise rejected
  (`handleError` in `handleAsync`). Clears `STATUS_UNINITIALIZED` (`notifyStatus`:
  `status | (status !== STATUS_ERROR ? ... UNINITIALIZED : 0)`). A rejection that *is* a
  `NotReadyError` is treated as pending, not error (`handleAsync.handleError`).

### How `updateIfNecessary` treats status (`core.ts:333-355`)

```ts
if (el._flags & REACTIVE_CHECK) { ...poll deps recursively, stop on DIRTY... }
if (el._flags & (REACTIVE_DIRTY | REACTIVE_OPTIMISTIC_DIRTY) ||
    (el._error && el._time < clock && !el._inFlight)) {
  recompute(el);
}
```

The middle clause is the async-specific rule: a node in **error or pending state from a
*previous* clock cycle re-runs when pulled** — but never while its own async is still
`_inFlight`. This is the retry semantics: reading an errored async source from a tracked
scope in a later cycle refetches (`read()`: *"Only a genuine reactive re-read may retry
an errored async source"* — requires `tracking && !pendingCheckActive && el._time <
clock`; untracked reads and `isPending` probes rethrow without refetching). Error
boundaries also rely on it: `createErrorBoundary`'s `reset()` explicitly `recompute`s
captured sources (test *"error boundary fallback observes repeated async errors from the
same source (#2701)"*, `createMemo.test.ts`; *"clears held errors after a refresh
resolves successfully"*, `createLoadingBoundary.test.ts`).

### How a compute becomes async (`recompute` → `handleAsync`)

`recompute` calls `el._fn(prevValue)`. If the result is an object, `handleAsync`
(`async.ts:150`) probes it *untracked* for `Symbol.asyncIterator`, then for a `.then`
(Promises/A+ shape). Neither → plain value. Otherwise it stores `el._inFlight = result`
and subscribes:

- **Thenable that settles synchronously** (e.g. a resolved custom thenable): the `isSync`
  double-flag trick captures the value and **returns it synchronously — no suspension at
  all** (tests *"should resolve sync thenable immediately without NotReadyError"*,
  *"should surface a synchronously-rejecting thenable to the error boundary (#2764)"*,
  `syncThenable.test.ts`).
- **Still-pending thenable**: `globalQueue.initTransition(...)` (every async suspension
  enters/creates a transition — §5) then `throw new NotReadyError(context!)` — the node
  suspends *itself*; the recompute catch marks it `STATUS_PENDING`, `_blocked = true`.
- **AsyncIterable**: drains synchronously-available values first (`iterate()`); if none,
  suspends like a promise. Each later `yield` is a value write (`asyncWrite` with a
  continuation that requests the next item), so a generator is *pending only until its
  first value*, then simply updates: *"should not be pending between yields in same
  sequence"*, *"should show isPending=false for initial generator load"*; `refresh()`
  restarts the sequence (*"should show isPending=true after refresh triggers new
  generator sequence"*), and the old iterator's `return()` is called on
  invalidation/disposal (*"should call async iterator return when invalidated"* /
  *"...when disposed"*, `syncThenable.test.ts`). This is also the `from(observable)`
  replacement (`syncThenable.test.ts` "fromObservable pattern").

Note the hybrid: Ryan's essay ("Async Derivations in Reactivity") describes throw-based
propagation; the shipped code **both** throws `NotReadyError` through the *reading* node
**and** stores pending as graph state (`_statusFlags` + `_pendingSource`) so subsequent
propagation can be notification-only (§4). Async memos are **eager** when observed
(scheduled, not lazy-pulled) exactly to avoid read-order waterfalls — see the diamond
test in §4 and the "Scheduling Derivations" essay.

---

## 2. What triggers suspense, exactly

Two independent gates decide what happens when a pending value is read: a **per-read
throw rule** (does this read throw `NotReadyError`?) and a **per-boundary catch rule**
(does a Loading boundary show its fallback, or does the pending escalate into a
transition hold?).

### 2.1 The read-throw rule (`read()` in `core.ts`, the `STATUS_PENDING` block)

Let `c` = the current tracking computation (memo/effect compute), `owner` = the status
owner (`el._firewall || el`), `stale` = true only during render-effect and
tracked-effect compute phases (`recompute` sets it for `isEffect && isEffect !==
EFFECT_USER`; `trackedEffect` uses `staleValues`).

```
if (owner is PENDING):
  if (c && !(stale && owner._transition && activeTransition !== owner._transition)):
      throw owner._error                     // suspend the reader
      (exception: per-lane rules — an optimistic-lane reader only throws if the
       pending node is in ITS lane and has no active override; §5/§6)
  else if (c && owner !== el && owner is UNINITIALIZED):  // firewall child, stale path
      throw owner._error
  else if (!c && owner is UNINITIALIZED):
      throw owner._error                     // top-level read of never-loaded value
  // otherwise: fall through and serve a stale/held value (§3)
```

In plain English:

- **Inside any tracking scope, a pending read throws** — first load *or* refresh. That
  is what propagates pending down the graph.
  - *Except*: a **stale reader** (render-effect compute) reading a node whose pending
    state is **held by a transition that is not currently active** falls through and
    reads the committed value. This is "held UI": during a transition the DOM keeps
    rendering old values instead of suspending. (Verified indirectly by every
    transition test where render effects keep observing old values, e.g. *"should flush
    held signals when action completes"*, `action.test.ts`.)
- **Outside any tracking scope**: throws **only if `STATUS_UNINITIALIZED`** — i.e. the
  famous *uninitialized-vs-has-value rule*. Tests, verbatim:
  - *"should throw when reading uninitialized async computed outside reactive scope"* —
    `a()` throws before first resolution.
  - *"should return stale value when reading re-pending async computed outside reactive
    scope"* — after `set(2); flush()`, `a()` returns `1` (the committed value) while the
    refetch is in flight. (both `createMemo.test.ts`)

Dev-mode additions: `strictRead` makes an *untracked* read of a pending value a hard
error (`PENDING_ASYNC_UNTRACKED_READ`; test *"throws dev error when pending async value
is read outside tracking scope with strictRead"*, `createLoadingBoundary.test.ts`), and
reading pending inside `createTrackedEffect`/`onSettled` warns
(`PENDING_ASYNC_FORBIDDEN_SCOPE`).

### 2.2 The boundary-catch rule (`boundaries.ts`)

The `NotReadyError` thrown out of an effect's compute is caught by `recompute`, which
sets the effect's status and calls its `_notifyStatus`. **Render effects** notify their
queue chain with both status dimensions (`notifyEffectStatus`:
`this._queue.notify(this, STATUS_PENDING | STATUS_ERROR, actualStatus, actualError)`).
**User effects do not report pending at all** — their side-effect phase is simply
skipped (`_modified` never set because the error path skips the value-changed block) and
they re-run at settle via `_blocked`. So *only render effects (and boundary trees) drive
suspense and transitions*.

The notification climbs the queue tree (`Queue.notify` forwards to `_parent`) until a
`CollectionQueue` with `_collectionType & STATUS_PENDING` (a Loading boundary) handles
it:

- **Uninitialized boundary** (its content has never committed): capture
  `error.source` into `_sources`, set `_disabled = true` → the boundary accessor
  computed re-evaluates and returns `fallback()`. The notification is **consumed** (not
  forwarded), so it never reaches the transition bookkeeping. **First-load pending ⇒
  fallback, no held transition.** Test: *"shows fallback while async projection is
  pending"*; also *"split async: boundary-caught does not hold transition for outside
  async"* (`createLoadingBoundary.on.test.ts`) proves boundary-caught pending doesn't
  block a concurrent transition.
- **Initialized boundary** (`_initialized === true`, set the first time the accessor
  reads its tree successfully while enabled): `if (_collectionType & STATUS_PENDING &&
  this._initialized) return super.notify(...)` — **pass the pending upward**. It reaches
  `GlobalQueue.notify`, which registers `error.source → reporter` in
  `activeTransition._asyncReporters` (§5). **Refresh-pending ⇒ no fallback; the
  transition is held and the boundary keeps showing stale content.** Test: *"reports
  pending on first refresh after an async projection resolves"* — after `refresh()`,
  the boundary renders `[1, true]` (stale value + `isPending`), never `"loading"`.
- **`on` option** (`createLoadingBoundary(fn, fallback, { on })`): when the `on`
  accessor's value changes, `_initialized` is reset and `_sources` cleared inside
  `CollectionQueue.notify` — the *next* pending shows the fallback again. This is the
  opt-in "new navigation = fresh boundary" behavior (tests *"shows fallback when
  on-value changes and data is pending"*, *"does not show fallback when on-value is
  unchanged (stale content during transition)"*, `createLoadingBoundary.on.test.ts`).
- **Boundary release**: at every flush finalization, `checkBoundaryChildren` →
  `CollectionQueue.checkSources()` prunes `_sources` entries that no longer carry the
  status; when empty, `_disabled = false` and content re-renders — even if the resolved
  data is `equals`-unchanged (tests *"clears loading state even when data unchanged"*,
  *"does not re-run compute when resolving same value"*: the boundary flips back
  without recomputing user code).
- **Error notify-through**: a real error passing a Loading boundary is remapped to the
  ERROR dimension and forwarded to the nearest `Errored` (`CollectionQueue.notify`
  comment "Notify-through"; tests *"nested Loading does not suppress eventual error
  fallback"*, *"surfaces async rejection consistently for Loading/Errored orderings"*).
- With **no boundary at all**: the pending reaches `GlobalQueue.notify`, registers as an
  async reporter on the (auto-created) transition, and — in dev, during `render()` — the
  `ASYNC_OUTSIDE_LOADING_BOUNDARY` warning fires: "The root mount will be deferred until
  all pending async settles" (`effect.ts`; tests in `enforceLoadingBoundary.test.ts`).

So "what suspends a boundary vs. what sets `isPending`" is decided by **boundary
initialization state, not by the node's `STATUS_UNINITIALIZED` alone**: a *fresh
boundary* mounted around an *already-initialized but currently-refreshing* source still
shows fallback (test group *"fresh boundary around updating async source"*, e.g. *"shows
fallback when a keyed subtree directly inserts an external pending async source"*),
while an *initialized boundary* around a *refreshing* source shows stale content and the
pending surfaces only through `isPending`/transition holds (tests *"shows inline pending
when a keyed subtree revalidates an external async source with isPending"*).

### 2.3 `isPending` reads and suspension

`isPending(fn)` never *subscribes* to values, but during **first load** it participates
in suspense: if `fn`'s read throws a `NotReadyError` whose source is still
`STATUS_UNINITIALIZED` and we're inside a reactive context, `isPending` **rethrows** —
suspending the surrounding boundary (`isPending` catch:
`if (foundPending && !(e.source?._statusFlags & STATUS_UNINITIALIZED)) return true; if
(context) throw e;` and the `pendingCheckActive` block in `read()` which throws for
`PENDING & UNINITIALIZED` owners). Once a value exists, `isPending` returns
`true`/`false` without suspending. Tests: *"isPending participates in Loading during
initial async"*, *"isPending keeps old branches on stale pending status"*
(`createMemo.test.ts`).

---

## 3. Prior-value presentation: the multi-buffer

Four value buffers plus two helper nodes. Which buffer a read returns is the whole
"concurrent UI" story:

| Buffer | Written by | Served to |
|---|---|---|
| `_value` | `commitPendingNode` at flush end / transition completion; direct writes on create or lane paths | Untracked/top-level reads; **stale readers** (render-effect computes) when the node is held by a non-active transition; readers inside an optimistic lane (committed view); everyone after commit |
| `_pendingValue` | `setSignal` (every non-optimistic write stages here + `queuePendingNode`); `recompute` result staging for non-create, non-lane computeds; async resolution holding a revert target under an active override | Tracked readers during the same tick / mid-transition: memos, **async drivers**, user-effect computes — anything that must see the newest data to compute/fetch correctly |
| `_overrideValue` | `setSignal` on an optimistic node (`NOT_PENDING` = armed/resting) | **Everyone**, highest priority (`read()`: override wins before all other selection), until reverted/corrected (§6) |
| `_snapshotValue` | snapshot capture (hydration/SSR `createSnapshot` plumbing) | Only readers inside a snapshot scope (`CONFIG_IN_SNAPSHOT_SCOPE`); mismatch marks the reader `REACTIVE_SNAPSHOT_STALE` for recompute at scope release. Orthogonal to async; listed for completeness (`snapshot.test.ts`) |

Key asymmetry verified by *"latest() on upstream signal during transition"*
(`createMemo.test.ts`): after `setX(2); flush()` with an async memo downstream,
`$x()` (top-level) → `1` (committed) while the transition holds, but the async driver
recomputed with `2` (staged) — drivers read `_pendingValue`, presentation reads
`_value`.

### `latest(fn)` (`core.ts:1215`)

Reads inside `fn` are rerouted (`latestReadActive`) through the node's lazily-created
`_latestValueComputed` — an **optimistic computed** `optimisticComputed(() => read(el))`
detached from any owner, with `_parentSource = el` (parent-child lane link, §5). Exact
semantics:

- The helper recomputes like any tracked reader, so it sees `_pendingValue` → for a node
  **upstream of the async** (the signal you wrote, sync memos derived from it),
  `latest()` returns the **in-flight value**.
- If the helper itself lands `STATUS_PENDING` (i.e. `el` is the async node and has no
  new value yet), `read` returns the *visible* value: `_overrideValue` if active, else
  `_value` → for the **async node itself**, `latest()` returns the **committed (stale)
  value**, never throws mid-transition.
- Outside any context, a `NotReadyError` from the helper is swallowed and the visible
  value returned.

Test, verbatim (*"latest() on upstream vs downstream of async"*): during the refetch,
`latest($x) === 2`, `$x() === 1`, `latest(syncMemo) === 4`, `syncMemo() === 2`,
`latest(asyncMemo) === 20 === asyncMemo()`. Also *"should track pending value changes
for loading indicator pattern"* (a render effect on `latest(id)` shows the new id
during the transition). Cross-lane guard: under an optimistic lane, `latest` of a node
pending in a *different* lane keeps returning the committed value until that lane's
async resolves (`read()` "Cross-lane stale read" block; checkout tests in
`createOptimistic.test.ts` §"parallel independent optimistic with latest()").

### `isPending(fn)` (`core.ts:1244`)

Runs `fn` with `pendingCheckActive = true`. Every read collects its node (and firewall
owner) into `pendingCheckSources`; afterwards each source's lazy `_pendingSignal`
(`Signal<boolean>`, an *optimistic* signal so lane reversion resets it) is read — that
read is what a wrapping memo/effect **subscribes** to, so `isPending` inside a tracked
scope is reactive. Returns `true` iff any collected source computes pending.

`computePendingState` (`core.ts:1095`) — "pending" strictly means **stale data exists
while newer data loads**:

1. `STATUS_PENDING && !STATUS_UNINITIALIZED` → true (async refetch in flight).
2. Initialized node with a staged `_pendingValue` (value held by a transition) → true —
   *except* a resting optimistic node, whose staged value is a revert target, not a
   refetch (#2799 comment in source).
3. Active optimistic override → true while the override is in force (helper nodes with
   `_parentSource` instead consult their lane's `_pendingAsync`).
4. First load (`STATUS_UNINITIALIZED`) → **false**. Tests: *"isPending full lifecycle -
   false to true to false"*, *"should show isPending=false for initial generator
   load"*, *"isPending stays false for upstream-only initial reads"*, *"isPending
   returns true during revalidation"* (`createMemo.test.ts`); *"isPending reports
   pending while refresh() refetches an async optimistic accessor (#2799)"*
   (`createOptimistic.test.ts`).

Subscription is made with a **pending-observer link** (`link(dep, sub,
pendingObserver=true)`; `Link._pendingObserver`, `types.ts`): if the source later hits a
*real* error, `notifyStatus` re-runs the observer instead of forwarding the error
through it — matching the synchronous `isPending`, which swallows real errors
(`async.ts` comment at the `link._pendingObserver` check). Consistency guarantee:
`[isPending(x), x()]` pairs update atomically in one effect run (tests *"single async -
[isPending(x), x()] pairs update atomically"*, *"chained async - each [isPending(x),
x()] pair tracks its own resolution atomically"*).

---

## 4. Downstream propagation

**The model is a hybrid — this matters for a port.**

### First encounter: execute-and-abort

When a computed's body reads a pending source in a tracked scope, the body **has
executed up to that read** and the read **throws `NotReadyError`**, aborting the rest of
the body. `recompute`'s catch marks the node `STATUS_PENDING`, `_error = e`,
`_blocked = true`, and calls `notifyStatus`. The node's previous value stays in place;
no result is produced. There is **no execute-with-latest** (the body does not continue
with a stale substitute) and **no re-entry with a different value**. Consequence:
dependencies read *after* the throwing read are not (re)registered this round —
`trimStaleDeps` is skipped on the error path (`recompute`: `if (!el._error) {
trimStaleDeps(el); ... }`), so previously-registered later deps are retained
conservatively; a genuinely new dep after the pending read is only discovered when the
body re-runs at settle (see the dep-trim regression test *"should drop stale
dependencies when an async memo suspends after untracked branching (#2695)"*).

### Transitive propagation: forward-without-execute

From the newly-pending node, `notifyStatus` (`async.ts:356`) walks subscribers **and
firewall-children subscribers** (`forEachDependent`) recursively and, without running
any body: stamps `sub._time = clock`, records the pending source
(`addPendingSource`), sets `STATUS_PENDING` (preserving `UNINITIALIZED`), sets `_error =
NotReadyError(source)`, refreshes `_pendingSignal`, and queues the node
(`queuePendingNode`) so the status-only change still participates in commit. Dedup: a
sub already waiting on that source is skipped, so a node can accumulate *several*
pending sources (`_pendingSources` Set) and stays pending until **all** settle — test
*"keeps shared downstream pending after one async source settles unchanged"*
(`createMemo.test.ts`), where a shared downstream stays pending after source A settles
to an unchanged value while source B is still fetching.

Effects at the leaves: render effects report to their queue chain (boundary/transition,
§2.2); user effects just don't run their side-effect phase this turn.

### While paused

Nothing is scheduled. The pending subtree is quiescent — no heap entries, no effect
queue entries (an effect whose compute threw never sets `_modified`). The only live
object is the source's `_inFlight` subscription. Disposal of a paused subtree cancels
cleanly: boundaries prune disposed sources (test *"stops loading when a pending child is
disposed before its promise settles"*, `createLoadingBoundary.test.ts`), and
`asyncWrite`/`handleError` no-op when `_inFlight` was cleared by disposal
(`disposeChildren` nulls `_inFlight`).

### At settle (`asyncWrite` + `settlePendingSource`, `async.ts`)

1. Guards: ignore if `_inFlight !== result` (superseded) or the node was re-dirtied by a
   newer write (`REACTIVE_DIRTY|OPTIMISTIC_DIRTY` check) — latest-wins.
2. `initTransition(resolveTransition(el))` — re-enter the transition this async belongs
   to (transition context survives across the await; test *"should maintain transition
   context across async boundaries"*, `action.test.ts`).
3. `clearStatus(el)` (keeps `UNINITIALIZED` until commit), lane bookkeeping, then the
   value is written through one of four routes: projection `setter`; **override-hold**
   (active optimistic override: stash as `_pendingValue` revert target, don't commit);
   **lane write** (direct `_value` write + optimistic `insertSubs` so lane effects can
   flush independently); or plain `setSignal(el, () => value)` — which stages
   `_pendingValue` and marks subscribers dirty.
4. `settlePendingSource(el)`: BFS over dependents removing `el` from each node's pending
   set. When a node's set empties: clear `STATUS_PENDING`, clear the `NotReadyError`,
   update `_pendingSignal`, and **iff `_blocked`, enqueue the node to re-execute**
   (`enqueueForRerun` → height heap or tracked-effect queue). Forwarded-only nodes do
   *not* re-execute from here — they re-run only if the settled value actually changed
   (normal dirty propagation from step 3). If another pending source remains, just
   repoint `_error` at it.
5. `schedule(); flush()` — settlement drains synchronously in the microtask that
   resolved the promise.

### Waterfalls — deliberate semantics

Sibling async memos fetch **in parallel** because async computeds are evaluated eagerly
at creation/invalidation, not lazily at read (essay: "If you go with throwing ... and
derived values are lazy, you ... have accidentally created a waterfall"). Test *"diamond
should not cause waterfalls on read"*: both fetches start once each per turn even though
the effect reads `b()` then `c()` and `b` throws first. But an async memo that *reads
another async memo* genuinely waterfalls — its body re-runs after the dep settles and
only then produces its own promise: test *"should waterfall when dependent on another
async with shared source"* counts `async2` running twice per cycle (once aborted, once
after `a` resolves).

### Error propagation rules

- Real throw/rejection → `STATUS_ERROR`, `_error = StatusError(el, original)` (wrapping
  preserves `.source` and `.cause`; `NotReadyError`/`StatusError` pass unwrapped).
- Forwarded to dependents without execution (same `forEachDependent` walk; clears their
  pending-source sets).
- Reads throw `_error`; a *tracked* read on a later clock cycle retries (§1). `isPending`
  observers get re-run instead of receiving the error (pending-observer links, §3).
- User effects route errors to their `error` handler
  (`createEffect(compute, { effect, error })`) or to the nearest `Errored` boundary via
  `queue.notify(STATUS_ERROR)`; unhandled → rethrow (`notifyEffectStatus`,
  `runEffect`).
- Loading boundaries pass errors through to Errored boundaries even when nested either
  way (§2.2).

---

## 5. Transitions + lanes

### Transitions are implicit and automatic

`Transition` (`scheduler.ts:157`):

```ts
{ _time, _asyncReporters: Map<Computed, Set<Computed>>, _pendingNodes: Signal[],
  _optimisticNodes, _optimisticStores, _actions: Generator[],
  _queueStash, _done: boolean | Transition, _gatedSubs: Set<Computed> }
```

`GlobalQueue.initTransition()` is called from every async touchpoint: when a compute
suspends (`handleAsync` before throwing `NotReadyError`), when an async result arrives
(`asyncWrite`/`handleError`), when a node carrying `_transition` is written or
recomputed, and when an `action()` starts. If no `activeTransition` exists, one is
created; if a different one is active they **merge** (`mergeTransitionState`; the
absorbed transition's `_done` points at the survivor and `currentTransition` follows the
chain — tests *"should merge actions when one action calls another"*, *"should isolate
independent transitions that don't share signals"*, `action.test.ts`).

**Pending-value capture**: any plain `setSignal` stages into `_pendingValue` and calls
`queuePendingNode`; `initTransition` adopts the global pending list into the transition
(same array identity afterwards), and stamps each node's `_transition`. That is how a
sync write that *triggers* async work is retroactively held: *"should hold regular
signal updates during action"* (`$x()` stays `0` mid-action, commits to final value at
completion), *"should commit final signal values when action completes"*.

### What "a transition waiting on async" means mechanically

`_asyncReporters` maps **async source → set of reporter nodes** (render
effects/boundary trees that observed its pending while the transition was active;
registered exclusively in `GlobalQueue.notify`). At each flush,
`transitionComplete(t)` decides:

1. `t._actions` non-empty (a generator between `yield`s) → not complete (*"should keep
   transition alive while action is running"*, *"should only complete transition when
   ALL actions finish"*).
2. For each `(source, reporters)`: drop reporters that no longer *block* the source —
   `reporterBlocksSource` checks (a) the reporter still lists `source` in its pending
   set, or (b) still has a dep whose `_parentSource`/`_firewall` chain reaches
   `source`, or (c) its own pending `_error.source === source`; a reporter that is
   zombie/disposed never blocks. If live reporters remain **and** the source is still
   self-pending (`source._error.source === source`) → not complete. Dropping dead
   reporters is what prevents disposed UI from holding a transition forever (*"stops
   loading when a pending child is disposed..."*; *"transition holds when upstream
   resolves first - pending source does not leak"*, `createOptimistic.test.ts`).
3. Any optimistic node with an active override that is pending on a *foreign* source →
   not complete (optimistic UI must not revert before its consequences land).

**Incomplete-transition flush** (`GlobalQueue.flush`): run the dirty heap (recomputes
see staged `_pendingValue`s — the "other world" evaluates forward), run the zombie heap,
run any *ready lanes'* effect queues (see below), **stash** all effect queues into
`t._queueStash`, keep `_pendingNodes` uncommitted, `clock++`, park the transition
(`activeTransition = null`). UI holds because: staged values aren't committed, stashed
effects don't run, and stale readers fall through to `_value` (§2.1). Subtrees replaced
mid-transition become **zombies** — marked `REACTIVE_ZOMBIE`, moved to `zombieQueue`,
disposal deferred to `_pendingDisposal`/`_pendingFirstChild` until completion (test
*"should not auto-dispose zombie computed when it loses subscribers during
transition"*).

**Completing flush**: `restoreQueues(stash)`, `commitPendingNodes` (staged →
committed; clears `UNINITIALIZED`), re-run heap, `resolveOptimisticNodes` (§6), replay
`_gatedSubs`, clear optimistic stores, `cleanupCompletedLanes` (running any leftover
lane effects), then run RENDER and USER queues — one atomic reveal.

**Entanglement gate** (`read()` "Entanglement gate" block + `_gatedSubs`): a reader
recomputing *under an optimistic lane* that reads a plain signal with a staged
mid-transition write sees the **committed** value (optimistic projections must not leak
unrelated in-flight writes), and is recorded in `_gatedSubs` for a replay recompute at
commit. Async drivers are not under a lane, so they read staged values and fetch with
the newest inputs. Executable spec: `transitionEntanglement.test.ts` — *"Shape A —
optimistic O1 DIFFERS from committed: E1 observes 99:a then 2:b"* and *"Shape B —
... E1 observes 2:a then 2:b"* (exactly one mid-transition frame with
`override + committed-plain`, one commit frame with final pair).

### Lanes: independent flush contexts for optimistic writes

A transition *holds* effects; an optimistic write must *show* immediately — including
new async it spawns, without being blocked by (or blocking) the held transition. Lanes
reconcile this (`lanes.ts`):

- Each optimistic write gets/reuses an `OptimisticLane` for its signal
  (`getOrCreateLane`), owned by the current transition. Propagation marks subscribers
  `REACTIVE_OPTIMISTIC_DIRTY` and assigns/merges the lane (`insertSubs(node, true)` →
  `assignOrMergeLane`; union-find via `_mergedInto`).
- While a node recomputes under `currentOptimisticLane`, any effects it enqueues route
  to the **lane's** `_effectQueues`, not the global ones (`Queue.enqueue`).
- Async spawned under the lane registers in `lane._pendingAsync` (recompute's catch);
  `runLaneEffects` flushes a lane's queues as soon as `_pendingAsync` is empty — even
  while the enclosing transition is stashed (test *"lane effects run even when
  transition is stashed"*). Lanes with pending async keep their effects held (test
  *"isPending holds until merged lane completes, not just individual async"*).
- Lanes **merge** when their dependency cones overlap (test *"lanes merge when computed
  depends on multiple optimistic sources"*); writes in the same action share a lane
  (*"concurrent optimistic writes in same action share a lane"*); independent writes
  keep separate lanes and flush independently (*"independent optimistic writes create
  separate lanes"*, the three-node checkout tests around *"latest() allows independent
  progressive display for parallel optimistic paths"*).
- **Parent-child lanes**: the helper nodes (`_pendingSignal`, `_latestValueComputed`)
  carry `_parentSource`; their lanes are children of the source's lane and deliberately
  do *not* merge with it (`assignOrMergeLane` parent-child carve-out) so
  `isPending`/`latest` indicators update without waiting for the parent's async.
- Cross-lane isolation at read time: under lane A, a node pending in lane B (with no
  override) does not throw; committed values are served (per-lane suspension check in
  `read()`; test *"cross-lane reads return committed value during optimistic
  context"*).
- Cleanup: `cleanupCompletedLanes` runs when the owning transition completes (or on a
  no-transition flush for orphan lanes), draining leftover lane effects and clearing
  `activeLanes`/`signalLanes` (tests *"two full cycles - lanes clean up properly between
  transitions"*).

### `action(genFn)` (`core/action.ts`)

The only user-facing "transition control": wraps a generator; each invocation
`initTransition()`s and pushes the iterator into `t._actions`; every `yield`ed thenable
is awaited with the transition context **restored around the resume**
(`restoreTransition`), so all writes between yields batch into the same transition;
non-thenable yields are just batched steps. Returns a promise of the generator's return
value; errors reject it and remove the action from the transition (which may then
complete — *"should remove action from transition on error but let transition
continue"*). `yield*` composes helpers (whole *"yield\* with helper generators"*
describe block).

---

## 6. Optimistic updates

`createOptimistic(value)` → `optimisticSignal` (a signal with `_overrideValue =
NOT_PENDING`, i.e. *armed but resting*); `createOptimistic(fn)` → `optimisticComputed`
(an async-capable derived source that additionally accepts overrides). `undefined`
`_overrideValue` means "not optimistic-capable at all".

### Override lifecycle (`setSignal` optimistic path, `core.ts:961`)

1. **Write**: compute the "current" as the active override (else `_value`); if
   `equals`, still re-propagate computeds with an active override (downstream
   `_inFlight` may be stale — the "no change" fast path is unsafe under async). First
   override on this node: stage `_pendingValue = _value` (the **revert target**) and
   push onto `_optimisticNodes` (global → adopted by the transition). Set
   `_overrideSinceLane = true`, get/create the lane, set `_overrideValue = v`.
2. **Visibility**: `insertSubs(el, optimistic=true)` marks subscribers
   `OPTIMISTIC_DIRTY` + lane; their recomputes run under the lane; effects go to lane
   queues → **optimistic UI flushes immediately**, even while a transition is stashed
   (§5). Reads of the node return the override for *every* read context (tests *"should
   update signal via setter and revert on flush"*, *"should show optimistic value during
   async transition and revert when complete"*, *"should show each optimistic update
   during transition"*).
3. **Revert** — overrides are always temporary. `resolveOptimisticNodes`
   (`scheduler.ts:186`) runs at transition completion (or at the very next flush when
   there is no transition — an optimistic write outside an action reverts immediately:
   *"should update signal via setter and revert on flush"*): commit staged
   `_pendingValue → _value`, set `_overrideValue = NOT_PENDING`, and if the committed
   value differs from the last-visible override, `insertSubs(node, true)` **with no
   lane** — subscribers' lanes are cleared and the correction flushes through the
   regular queues. Equal values produce no effect run (*"should not trigger effect if
   optimistic value matches original"*; `transitionEntanglement` Shape B still re-runs
   once because the entangled plain signal flips).
4. **Correction while pending** (`recompute` + `asyncWrite`): if fresh upstream data
   arrives while an override is active, the override is *corrected in place* —
   lane-propagated recompute: `_overrideValue = value` unconditionally; async
   resolution on the node itself: stash the fresh value as `_pendingValue` (new revert
   target) without committing; non-lane async resolution corrects the override only if
   the user hasn't re-written it since the lane began (`_overrideSinceLane` guard).
   Tests: *"should combine pending value with optimistic write when transition
   completes"*, the *"async chain"* mismatch tests (*"first async resolves first,
   optimistic value does NOT match computed result"*, etc.).

### Interaction with pending

- An **active override on a pending node is an "optimistic boundary"**
  (`notifyStatus`: `isOptimisticBoundary`/`startsBlocking`): pending status is **not**
  forwarded to its dependents (they should render the override, not suspend); only
  effect-level `_notifyStatus` sees the blocked status. The transition still refuses to
  complete while such a node is pending on a foreign source (`transitionComplete`,
  §5 item 3).
- `isPending` on an optimistic node: `true` while an override is active (user-created
  nodes), or while its lane has pending async (helper nodes); a **resting** optimistic
  node behaves exactly like a plain async memo — pending only for real refetches, and
  its held revert target must *not* read as pending (#2799/#2806/#2685 tests, §3).
- Recommended composition is `action` + optimistic write + `refresh` (test *"action
  pattern: setOptimistic -> yield api -> refresh"* and the whole "real-world pattern"
  describe block).
- `createOptimisticStore`/projections reuse the same machinery at store granularity
  (`trackOptimisticStore`, `GlobalQueue._clearOptimisticStore`; out of scope here).

---

## 7. API surface (signatures + semantics + tests)

All in `src/signals.ts` / `src/boundaries.ts` / `src/core/{action,scheduler,core}.ts`
unless noted. `Accessor<T> = () => T`; accessors carry a `$REFRESH` brand pointing at
the node (`accessor()`), which is what `refresh()` dereferences.

| API | Signature | Semantics |
|---|---|---|
| `createSignal` | `(value, opts?) → [get, set]` or `(fn: (prev) => T \| PromiseLike<T> \| AsyncIterable<T>, opts?) → [get, set]` | Plain signal, or **writable (async) memo**: derives from `fn`, and `set` (via `setMemo`) writes a manual value that *wins over any recompute queued in the same tick* (`suppressComputedRecompute`, `REACTIVE_MANUAL_WRITE`; tests *"should let a manual setSignal write to a memo win over a queued recompute (#2692)"* et al.) |
| `createMemo` | `(fn: (prev) => T \| PromiseLike<T> \| AsyncIterable<T>, opts?) → Accessor<T>` | The async source primitive (§1). `lazy: true` opts into lazy+autodispose; async memos are eager once observed. `sync: true` asserts sync-only (skips async probe; dev-checks `SYNC_NODE_RECEIVED_ASYNC`) |
| `createEffect` | `(compute, effectFn \| { effect, error }, opts?)` | Two-phase: tracked compute (may suspend — effect phase then skipped until settle) + untracked side effect returning optional cleanup. `error` handler intercepts compute/effect errors |
| `createRenderEffect` | same shape | Render-queue effect; **the only effect kind that reports pending to boundaries/transitions** (§2.2) |
| `createTrackedEffect` | `(fn, opts?)` | Same-scope tracking effect; stale reads; children/`onCleanup` forbidden; pending reads throw (dev-warn) |
| `createOptimistic` | same overloads as `createSignal` | Optimistic signal / optimistic writable async memo (§6) |
| `action` | `(function* (...args) { ... yield promise ... }) → (...args) => Promise<R>` | Generator transaction; each invocation is (merged into) a transition; writes between yields are held/optimistic-scoped until completion (§5) |
| `isPending` | `(fn: () => any) → boolean` | "Is any read in `fn` showing stale data while newer async is in flight?" Reactive when wrapped in a tracked scope; false on first load; rethrows to suspend on uninitialized first load (§3) |
| `latest` | `(fn: () => T) → T` | Read through the in-flight overlay: upstream-of-async → in-flight value; the async node itself → last committed value; never suspends mid-transition (§3) |
| `refresh` | `(accessor \| refreshable store) → void` | Write-like invalidation: marks the node DIRTY and schedules; does **not** read; no-op on plain signals; dev-errors on unbranded wrappers (tests *"should handle refreshes"*, *"should only refresh the targeted memo, not its upstream memos (#2691)"*, *"refresh() does not throw upstream pending reads from a plain memo (#2694)"*) |
| `resolve` | `(fn: () => T) → Promise<T>` | Await first fully-settled value of a reactive expression; must be called untracked (dev-throws otherwise); one-shot, then disposes (tests *"should resolve to a value with resolveAsync"*, *"should throw when resolve is used in a tracking scope"*) |
| `flush` | `() → void` or `(fn) → T` | Synchronous drain; also drains parked transitions (`while (scheduled \|\| activeTransition)`) |
| `onSettled` | `(cb: () => void \| cleanup) → void` | One-shot "run after the graph fully settles" (replaces `onMount`); owner-backed form may return a cleanup (tests *"should wait for async to settle before running"*, `onSettled.test.ts`) |
| `createLoadingBoundary` | `(fn, fallback, { on? }) → Accessor` | Suspense: fallback on first load (or after `on` changes); stale-content + transition hold on refresh (§2.2) |
| `createErrorBoundary` | `(fn, (err, reset) => U) → Accessor` | Catches `STATUS_ERROR` dimension; `reset()` recomputes captured sources |
| `createRevealOrder` | `(fn, { order?: "sequential"\|"together"\|"natural", collapsed? })` | Coordinates sibling Loading boundaries' reveal timing (`createRevealOrder.test.ts`) |
| `NotReadyError` | class, `.source` | Exposed for interop layers bridging the pending-throw protocol |
| store layer | `createStore(fn/projection)`, `createProjection`, `createOptimisticStore` | Async-capable at property granularity via firewall signals; same status machinery |

Composition guarantees worth citing: `isPending(() => latest(x))` checks the *latest
helper's* pending (async in flight) rather than the transition-held original (`read()`
header comment; tests *"latest(signal) with sync consumer - isPending(() => latest(x))
is false, contrasts with isPending(x)"* and *"latest(signal) consumed by async memo -
isPending(() => latest(x)) true until downstream async resolves"*,
`createMemo.test.ts`).

---

## 8. Comparison: Solid 2.0 vs cosignals-alt-a / alt-b

Our alt engines (`packages/cosignals-alt-a/src/{api,engine}.ts`,
`packages/cosignals-alt-b/src/engine.ts`) adopted a Solid-*inspired* "pending is graph
state" model, but with deliberate divergences. Each row flags the consequence for a
future `resource` port.

| Dimension | Solid 2.0 (`solid-signals`) | alt-a | alt-b | Consequence of divergence |
|---|---|---|---|---|
| **Pending representation** | Status **bits** (`_statusFlags`) + `_pendingSource(s)` + `_error: NotReadyError`, separate from the value buffers | **Value-domain box**: `SuspendedBox { thenable }` stored in the node's ordinary value slot | `SuspendedBox { thenable, latest? }` in the value slot | Boxes ride the existing propagation/equality/memo machinery for free (one channel); bits need a parallel notification channel (`notifyStatus`, boundary queues) but keep the value slot type-pure and let status change *without* value churn. A port to a box engine must synthesize `STATUS_UNINITIALIZED` (alt-b: `latest === undefined`) and `_pendingSources` multiplicity (alt-a: joined thenables) |
| **Reader hits pending dep** | **Execute-and-abort**: tracked read throws `NotReadyError`; body stops; node marked pending + `_blocked` | **Execute-to-completion with `undefined`**: `forwardPending` records the thenable on the eval frame, read returns `undefined`; ALL pending deps register in one pass (`api.ts` §"Solid-2.0-adapted suspense" comment) | **Execute-with-latest**: read returns `box.latest` (dep's last settled value) and records the thenable (`engine.ts` `get state`) | Solid bodies must tolerate mid-body aborts (fine for pure computes; deps after the abort point aren't refreshed until re-run). Alt bodies must tolerate `undefined`/stale inputs flowing through user code — a correctness risk Solid avoids, but it buys intra-node parallel fetch registration. For a resource port: an abort-based engine gets Solid semantics directly; a continue-based engine must guard user code against stale/undefined composites |
| **Transitive propagation** | **Forward-without-execute** (`notifyStatus` walk sets bits; bodies keep old values; only `_blocked` nodes re-run at settle) | Box IS the value → normal `propagate`/`shallowPropagate`; downstream *evaluations* run and forward by returning `undefined` | Same, forwarding `latest` | Solid's split (aborted nodes re-execute; forwarded nodes only flip bits) minimizes re-execution. Box engines re-evaluate every downstream node to produce its own box — simpler, more body runs. Equality cutoffs (below) claw most of that back |
| **Suspension identity / host protocol** | Throws its own `NotReadyError`; boundaries are in-graph (`CollectionQueue`); no React | Boundary read **throws the store-held (joined) thenable** — stable identity for React `use()`/Suspense replay; node×world thenable slots keep retries seeing the same promise | Same: top-level read throws `box.thenable`; box identity stable while thenable+latest unchanged ("what React use() retries key on") | The **replay-boundary adaptation**: React re-runs render after suspension, so thenable identity across retries is load-bearing; Solid never replays (graph resumes execution itself), so its NotReadyError identity is irrelevant. A resource port hosted in React must keep alt-style stable store-held thenables |
| **First-load vs refresh** | `STATUS_UNINITIALIZED` bit (per node) + `_initialized` (per boundary) + `on` reset | prev-box caching (canonical value) distinguishes; no uninitialized bit per se | `latest === undefined` ⇒ uninitialized | Solid's *two-level* rule (node bit for read-throw; boundary bit for fallback) is the part most often missed. Port must implement both or refreshes will flash fallbacks |
| **Settlement** | `asyncWrite` → staged commit + `settlePendingSource` walk + `_blocked` rerun; latest-wins guards on `_inFlight` and dirty flags | Settlement = `invalidate` the waiting node → normal recompute; canonical thenable slots cleared on settled completion (latest-wins via dirty-gating) | `onThenableSettled`: invalidate all waiters, global write shaping, epoch bump | Equivalent outcomes; Solid's staged `_pendingValue` commit gives transactional reveal (needed for transitions), the alts' immediate invalidation is simpler but has no held-UI notion |
| **Equality / cutoff** | `_equals` on values; status changes bypass equality (notification channel); `UNINITIALIZED` defeats `equals` once | Box-aware equality: same thenable ⇒ box reference reused ⇒ no downstream churn (`defaultBoxedEq`) | `broadcastEqual`: suspended boxes equal iff same thenable (structural — worlds mint distinct box objects) | Both models converge: "still waiting on the same promise" must read as *unchanged*. Solid gets it by not re-notifying an already-registered pending source (`notifyStatus` dedup); ports must preserve this or pending states will thrash subscribers |
| **Transitions / held UI** | Full machinery: implicit transitions, `_asyncReporters`, stashed queues, staged commits, zombie subtrees, entanglement gate | None (React owns concurrency; overlay epochs handle writer's-world consistency) | Worlds/overlay planes (writer's world W0, per-world memo slots) — a different concurrency mechanism solving optimistic reads, not held UI | Biggest gap for a port. If the host is React, Solid-style held UI duplicates React transitions — the alts deliberately delegate. A Solid-faithful resource in our engines would need at minimum: staged value buffer + "reporter" accounting + a commit point. Decide *per host* |
| **Optimistic** | `_overrideValue` buffer + lanes (own effect queues, merge, parent-child) + auto-revert at transition end | overlay epoch bumps; no dedicated override | Writer's-world overlay: optimistic value lives in a diverged world, canonical untouched | Same goal (speculation never corrupts canonical state), three mechanisms. Solid's is the only one with *automatic revert tied to async settlement*; a port needs an equivalent of `_optimisticNodes` + `transitionComplete` to know when to drop speculation |
| **`isPending` / `latest`** | Lazy helper nodes per source (`_pendingSignal`, `_latestValueComputed`) — reactive, lane-aware | `boxed` getter exposes the box (caller inspects); pending join set | `box.latest` carries the stale value inline | alt-b's inline `latest` is Solid's `_value`+`latest()` collapsed into the box — cheaper, but can't distinguish "upstream in-flight value" from "my committed value" (Solid's `latest()` on upstream returns the *new* value; a box only holds the *old* one). A port wanting Solid's loading-indicator pattern (`latest(id)` shows the new id) needs staged-value access, not just box.latest |
| **Waterfall stance** | Eager scheduled async ⇒ sibling parallelism; accepts intra-body waterfall after first pending read | No intra-body waterfall (all `ctx.use`/pending reads in one eval register in parallel) | Same | alt engines are strictly better at intra-node fan-out; Solid relies on "one async per node, compose via graph" style. Port guidance: keep frame-recorded parallel registration if bodies commonly `use()` several promises |
| **Retry semantics** | Errored async retries on tracked re-read in a later clock cycle; `isPending` never refetches | Settled canonical slots cleared ⇒ next dirty evaluation refetches (latest-wins) | Invalidate-on-settle; no probe/read distinction | Solid's "probes don't refetch" rule (`!pendingCheckActive` guard) is subtle and test-pinned; ports exposing an `isPending`-like probe must not let it trigger fetches |

---

## Sources

Primary (ground truth — all paths under
`/Users/jitl/src/alien-signals-opt/vendor/solid/packages/solid-signals/`):

- `src/core/constants.ts` (status/flag bits), `src/core/types.ts` (node layout),
  `src/core/error.ts` (`NotReadyError`, `StatusError`)
- `src/core/core.ts` (`read`, `recompute`, `updateIfNecessary`, `setSignal`, `isPending`,
  `latest`, `refresh`, `computePendingState`, pending/latest helper nodes)
- `src/core/async.ts` (`handleAsync`, `asyncWrite`, `notifyStatus`, `clearStatus`,
  `settlePendingSource`, pending-source bookkeeping)
- `src/core/scheduler.ts` (`GlobalQueue.flush`, `Transition`, `initTransition`,
  `transitionComplete`, `commitPendingNode(s)`, `resolveOptimisticNodes`, lane flushing)
- `src/core/lanes.ts` (per-override lanes, union-find merge, parent-child lanes)
- `src/core/effect.ts` (effect types, `notifyEffectStatus`), `src/core/owner.ts`
  (owners, zombies, disposal), `src/core/action.ts` (`action`)
- `src/signals.ts`, `src/boundaries.ts` (public API, `CollectionQueue` boundaries)
- `docs/QUEUE_NOTIFICATION_SYSTEM.md`, `docs/QUEUE_EXECUTION_CONTROL.md`,
  `docs/BITWISE_OPERATIONS.md` (maintainer prose, corroborates §2.2)
- Tests cited throughout, from: `createMemo.test.ts`, `createLoadingBoundary.test.ts`,
  `createLoadingBoundary.on.test.ts`, `createOptimistic.test.ts`, `action.test.ts`,
  `transitionEntanglement.test.ts`, `syncThenable.test.ts`, `onSettled.test.ts`,
  `enforceLoadingBoundary.test.ts`, `createErrorBoundary.test.ts`, `snapshot.test.ts`
- Not-implemented list: `vendor/solid/packages/solid/src/index.ts` (bottom comment
  block)

Secondary (design rationale; fetched 2026-07):

- Ryan Carniato, [Async Derivations in Reactivity](https://dev.to/this-is-learning/async-derivations-in-reactivity-ec5) —
  throw-based propagation, colorless async, why `.latest`-as-default breaks
  composability.
- Ryan Carniato, [Scheduling Derivations in Reactivity](https://dev.to/this-is-learning/scheduling-derivations-in-reactivity-4687) —
  push-pull, "lazy + throwing async = accidental waterfall", phased effect scheduling.
- [The Road to 2.0 · solidjs/solid Discussion #2425](https://github.com/solidjs/solid/discussions/2425) —
  primitive consolidation (async permutations + optimistic collapsed into eager async
  computations).
- [SolidJS 2.0 Beta: First-Class Async, Reworked Suspense and Deterministic Batching — InfoQ](https://www.infoq.com/news/2026/05/solidjs-2-async/).
- Historical `createAsync` (1.x/solid-router era, superseded in 2.0 core):
  [solid-router Discussion #375](https://github.com/solidjs/solid-router/discussions/375),
  [docs](https://docs.solidjs.com/solid-router/reference/data-apis/create-async).

Our context for §8: `research/sources/js-reactivity-sota.md` §2 (note: it places
`_asyncReporters` under lanes — it actually lives on `Transition`, `scheduler.ts:159`),
`packages/cosignals-alt-a/src/api.ts` (§11.3 boxes, eval frames, joined thenables,
node×world thenable slots), `packages/cosignals-alt-b/src/engine.ts` (`SuspendedBox`
with `latest`, `evalPending` frame, `stampThenable`/`onThenableSettled`,
`broadcastEqual`).
