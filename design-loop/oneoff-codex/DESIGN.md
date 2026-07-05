# ROOT-CELL — a one-off, fork-native, single-root design

Status: **from-scratch candidate, not implementation-ready**. This document
separates verified facts from proposed fork behavior. `model.test.mjs` is an
executable model of the queue and dependency rules; it is not a React-fork
prototype.

The priority order is: simple semantics, correctness inside a deliberately
small v1 scope, then adequate performance. This design does **not** satisfy
every frozen seed requirement. The deviations are listed before the design so
they cannot be mistaken for solved cases.

---

## 1. What the design process established

The five rounds and the later one-offs repeatedly confirmed a small stable
core:

1. A React-visible write cannot overwrite one shared value. A sync render may
   exclude an earlier default update, and overlapping updater functions must
   rebase in insertion order.
2. A render attempt needs one frozen world across yields. A mask without a
   temporal frontier is insufficient because a cell may be read for the first
   time after a yield.
3. Notification must use the dependency set of the world that read the value.
   The newest/committed graph cannot represent every pending branch.
4. Delivery must be lane-correct and value-blind. Equality cannot decide
   whether already-rendered but uncommitted work needs another update.
5. Render state must be work-in-progress state. Publishing render-discovered
   dependencies, hook closures, or allocations before commit creates cleanup,
   StrictMode, and error-boundary obligations.
6. Per-root committed worlds and mutable hook evaluators were the two largest
   multipliers. They introduced lock views, watermarks, version chains,
   publication ordering, promotion delivery, and long retention rules.

What did not converge was equally consistent:

- canonical-topology-only notification missed pending-only dependencies;
- a second HEAD graph did not cover arbitrary subset worlds or dependencies
  discovered after the relevant write;
- userspace world caches needed an expanding validity-source table;
- delivery suppression repeatedly stranded a later write;
- pin-only evaluator versions tore across roots;
- counter/slot reuse and forced reclamation made otherwise local state
  globally load-bearing;
- render-time taps moved React's current/work-in-progress distinction into
  the library and needed their own adoption and abandonment protocol.

ROOT-CELL takes those failures literally: React owns the React world, update
queue, and render dependency lifetime. The signals library does not mirror
them.

---

## 2. Scope: the cuts that pay for the design

| surface | v1 rule | consequence |
| --- | --- | --- |
| Roots | Exactly one registered root per signal runtime. A second root throws at `createSignalRoot`. Portals remain supported because they belong to the same root. | C11 uses its allowed single-root resolution. No lock views, per-root caches, or cross-root evaluator publication. |
| Hook-created computeds | `useComputed(fn, deps)` returns a render-local value. It is not a shareable `Computed` node. Global `Computed` functions are immutable. | No mutable evaluator versions, stage tables, or promotion protocol. |
| React effects | There is no dynamically tracked `useSignalEffect` in v1. Read with `useSignal`, then use React's `useEffect`/`useLayoutEffect` on the returned value. | No second effect-subscription graph and no accidental over-execution past computed equality. |
| Reducers | `ReducerAtom` has one immutable reducer. A hook reducer is fixed at mount; a changed reducer identity throws in development and remains unsupported. | Stable-reducer parity is supported; React's latest-reducer swap semantics are not. |
| Async transitions | Signal writes follow React's current rule: a write after `await` is ambient unless wrapped in another `startTransition`. | Automatic post-`await` attribution from seed C12 is out of scope. No compiler transform, async carrier, scheduler shims, or batch watermarks. |
| Suspense | `ctx.use` accepts a stable thenable. Creating a promise/resource inside a computed is unsupported. No lazy factory form. | Promise identity comes from application/resource state; no lineage capsule cache. |
| Computed history | `ctx.previous` is not exposed in v1. | No world-specific previous-value store. |
| Render allocation | `new Atom`, `new Computed`, and `new ReducerAtom` during render throw. Hook-local values use React hooks instead. | No pass-owned arena records or commit-grain allocator. |
| Update functions | `Atom.update` and reducer callbacks are deterministic, non-throwing, and may not read or write signals. | The same operation can be replayed safely, like a React updater queue. |
| Rollback | No truncation/optimistic rollback API. Writes persist until their lane commits. | C17 is absent. |
| Deferred product work | RSC/Flight, tracing, and multi-root support are not designed here. | They cannot be inferred from this architecture. |

These restrictions are library-specific and detectable except for JavaScript's
loss of async context after `await`. That last row deliberately follows React
instead of pretending the unsupported write stayed in the original action.

---

## 3. The whole design in one page

There are two state representations because they answer genuinely different
questions:

- **K0** is the ordinary signals kernel and always holds the newest state. It
  serves event handlers, non-React code, and core `effect()`.
- **Root cells** are React-owned update queues. They hold the committed state
  and pending lane-tagged operations for the one registered root. They serve
  render passes and React effects.

An atom write first asks the fork to reject render-phase use, evaluates its
pure operation against K0 without publishing, enqueues that same operation
into the atom's root cell using React's current update lane, then publishes
the staged K0 value. A thrown operation or failed enqueue therefore changes
neither representation. React schedules the
root even when the cell has no component consumer, so store-only transitions
still commit.

Each render attempt receives a monotonically increasing **pin** and React's
render lanes, plus the root's current commit version. At pass start, the fork processes every dirty root cell by using
React's update-queue algorithm, but only operations at or below the pin.
Skipped lanes remain in the base queue; included operations after a skip are
cloned as committed operations and replay later. The resulting cell states are
work-in-progress state and become current atomically with the DOM commit.
Post-pin writes cannot drift a resumed pass: they are absent from that pass's
cell snapshot. A post-pin write in an included lane invalidates the attempt
before commit. Any intervening commit invalidates every older attempt before
it can resume or install cell state; the commit-version check prevents an old
attempt from rolling current cells backward.

When a component reads a root cell, the fork records the dependency on the
work-in-progress Fiber. A cell keeps committed and open-pass consumers. Every
write schedules both sets in the writer's lane. A dependency discovered after
a write also scans that cell's remaining queue: any excluded or post-pin lane
is scheduled retroactively. This is the missing half of every late-edge
counterexample.

Global computeds are evaluated once per pass and memoized only for that pass.
Their memo stores the flattened atom leaves. A second component hitting the
memo replays those leaves into its own Fiber dependency list. No render-world
computed value or dependency survives commit; only each Fiber's committed
atom dependencies do.

`useSignal` keeps the last committed result in its React hook record. It may
reuse that reference when the signal's `isEqual` says a newly evaluated result
is equivalent. This does not suppress rendering or delivery; it only preserves
the value identity observed by the component and ordinary React effect deps.
Core `effect()` remains newest-state by contract.

That is the entire concurrency model: one native queue, one native
current/work-in-progress dependency lifetime, one pass-local computed cache.

---

## 4. Mechanisms

### M1. K0: newest-state core

K0 is the closed arena kernel class already proven by `libs/arena`. Its graph,
computed cache, equality cutoffs, and core effects describe only NEWEST.
React render evaluation never writes K0 dependencies or computed caches.

The pure-core package entry contains no root-cell calls. The React entry adds
the bridge at atom reads and writes. This is an implementation boundary, not a
claim that the React entry has zero idle cost.

In React mode, equal writes are still enqueued into M2. Equality may preserve
K0's object reference, but it cannot delete a lane-specific operation.

### M2. React-owned root cells

One `RootCell<T>` is created lazily for each atom read or written after the
root registers:

```ts
type RootCell<T> = {
  current: QueueState<T>
  sharedPending: Update<T> | undefined
  consumers: CellDependency | undefined
}

type Update<T> = {
  lane: ReactInternalLane
  seq: number
  apply: (state: T) => T
  next: Update<T> | undefined
}

type QueueState<T> = {
  value: T
  baseState: T
  baseQueue: Update<T> | undefined
}
```

These are fork-internal types. The library receives only an opaque cell
handle; lane values and Fibers never cross the boundary.

The root owns one safe-integer `externalSeq`. A pass pins its value at start.
The counter never resets. Before `Number.MAX_SAFE_INTEGER`, creation of a new
update throws in all builds. There is no wrap, epoch, slot reuse, token reuse,
or renumbering protocol.

At pass start, the fork directly builds work-in-progress states for the
root's dirty cells. For each queue, in insertion order:

1. Operations with `seq > pin` stay pending for a later attempt.
2. An operation whose lane is excluded is cloned into the new base queue.
   The state immediately before the first skipped operation becomes the new
   base state.
3. An included operation is applied. If an earlier operation was skipped, it
   is also cloned into the base queue with React's committed/no-lane marker so
   future renders replay it after the skipped operation.
4. Custom atom equality is applied stepwise. On equality, the accumulator
   retains its previous reference.

On root commit, all work-in-progress cell states install in the same commit
as the rendered tree, but only if the pass's captured commit version still
equals the root's current version. Dirty cells are processed even if no
component read them. A cell that became dirty after pass start is processed
lazily on its first read with the pass pin; otherwise its post-pin work stays
pending. Remaining queue lanes keep the root scheduled.

The processor also carries React's entangled-async-action check. If it reads
an included update belonging to a still-pending action, the root attempt
suspends on that action's thenable just as `useReducer` does. This keeps the
synchronous prefix of an async action pending until settlement; only raw
post-`await` writes use the separately documented ambient lane.

This is not merely “receipt math inspired by React.” The intended fork change
is to factor the existing queue processor for detached root cells. The current
React source already has the two required constructions:

- current/work-in-progress queue double buffering and persistent update lists
  in `ReactFiberClassUpdateQueue.js`;
- skipped-lane base queues and committed/no-lane replay clones in
  `ReactFiberHooks.js` and `ReactFiberClassUpdateQueue.js`.

The fork still needs a prototype: sharing an algorithm is plausible from the
source, but detached root cells do not exist in stock React.

### M3. Fiber leaf dependencies

`readRootCell(cell)` does three things:

1. returns the pass's M2 snapshot value;
2. appends an internal `CellDependency` to the currently rendering Fiber's
   work-in-progress dependency list;
3. examines the cell's base/pending queues and schedules this Fiber in every
   lane not represented by this pass, including post-pin operations.

The cell also links the dependency into an intrusive reverse list. A write:

- requests its lane once;
- schedules every committed consumer;
- schedules every consumer in an open pass that already read the cell;
- always marks root-cell work in that lane, even with no consumers.

There is no delivery equality cutoff or cross-write suppression. React may
coalesce multiple markings of the same Fiber/lane.

At commit, work-in-progress cell dependencies replace the rendered Fibers'
current dependencies. At pass discard, they are unlinked. Dependencies from
Fibers that did not render remain current. Dependency records are pooled, but
pooling is an optimization and not part of correctness.

Committed dependency changes also call the cell's library-owned observed-count
callback. K0 subscribers and committed Fiber consumers contribute to one Atom
count; the Atom's 0→1 setup and 1→0 cleanup remain microtask-damped. WIP reads
do not count as observation until they commit.

This deliberately follows React Context's lifetime rather than inventing a
library adoption protocol: current React resets the work-in-progress context
dependency list before a render, records reads on the rendering Fiber, and
marks matching consumer lanes and their ancestor paths on propagation. A root
cell needs a keyed reverse list instead of Context's tree scan, but the
current/work-in-progress ownership rule is the same.

### M4. Pass-local computed evaluation

A pass owns scratch storage keyed by immutable global `Computed` identity.
Each entry is `{ value | error | thenable, leaves }`. `leaves` is the deduped
list of root cells read by the evaluation, including nested computeds.

- Cache miss: evaluate against M2, directly accumulating leaves.
- Cache hit: return the cached outcome and replay every leaf through M3 for
  the current Fiber.
- Pass end/discard: clear the scratch in O(entries) and reuse its arrays.

`useComputed(fn, deps)` is different: it is an ordinary hook-local render
calculation and returns `T`, not `Computed<T>`. React already versions its
closure with the Fiber. Its signal reads go through M3.

Render evaluation is read-only. Writes throw before K0 or M2 changes.

---

## 5. Fork surface and invariants

The public seam is opaque and small:

```ts
type SignalRoot = {
  assertCanWrite(): void
  createCell<T>(initial: T, apply: Apply<T>, observed: (delta: 1 | -1) => void): CellHandle<T>
  enqueue<T>(cell: CellHandle<T>, operation: unknown): void
  read<T>(cell: CellHandle<T>): T
  replayDependency(cell: CellHandle<unknown>): void
}
```

`createSignalRoot(container)` registers the only root and returns the normal
root facade. Stock React and a second root fail loudly.

The fork must prove these invariants in reconciler-level tests:

1. **Queue parity.** For the same reducer operations and lanes, a root cell
   and `useReducer` produce identical render and commit values, including
   suspension on an included entangled-action update.
2. **Pin freeze.** A pass never processes an operation with `seq > pin`, even
   when that cell is first read after a yield.
3. **Included post-pin restart.** A post-pin root-cell write in a render's
   included lanes prevents that attempt from committing.
4. **Atomic monotone commit.** Root-cell work-in-progress state becomes current
   in the same commit that installs its DOM. The install is rejected if any
   newer root commit changed the captured commit version; that older attempt
   is synchronously discarded before it can resume.
5. **Store-only progress.** A root-cell update schedules and commits the root
   even when the reverse consumer list is empty.
6. **Dependency lifetime.** WIP dependencies are visible to subsequent writes,
   promote only with their Fiber, and disappear on discard/error abandonment.
7. **Retroactive lane delivery.** A newly recorded dependency schedules every
   queued lane excluded by the pass; an included post-pin lane restarts it.
8. **Yield truth.** `read` is available only on the rendering call stack.
   Handlers in yield gaps use K0 and writes are allowed.
9. **No-op delivery is value-blind.** Equal operations still mark consumers
   and root-cell work.

Facts 1–9 are obligations, not claims about stock React. A fork prototype is
the next gate.

Rebase drill: lane representation, queue fields, work-loop phases, and Fiber
types may change entirely. The library-facing five calls and the nine
behavioral tests remain; only the fork implementation moves.

---

## 6. Public API semantics

```ts
new Atom<T>({ state, effect?, isEqual?, label? })
new Computed<T>({ fn, isEqual?, label? }) // fn immutable
new ReducerAtom<S, A>({ state, reducer, isEqual?, label? }) // reducer immutable

atom.state
atom.set(value)
atom.update(pureOperation)
reducerAtom.dispatch(action)

useSignal(signal): T
useComputed(fn, deps): T
```

`useSignal` and `useComputed` retain their last committed result in ordinary
hook state. `isEqual(next, committed)` may select the committed reference for
the hook result. Computed functions must treat `isEqual` values as semantically
interchangeable; there is no shared React-world computed cache.

`batch()` delays core-effect flushing only. It never delays M3 delivery,
so a transition nested inside `batch()` keeps its own lane. `untracked()`
suppresses dependency recording but still reads the current context's value:
M2 during render/effect, K0 otherwise.

A stable thenable passed to `ctx.use` delegates to React `use` in render. In
core evaluation it is cached as the computed's thrown outcome. Resource
creation/caching is an application concern in v1.

---

## 7. Correctness battery

The table distinguishes supported cases from deliberate scope cuts.

| case | mechanisms and result | status |
| --- | --- | --- |
| C1 divergent dependency | `flag` write reaches W through committed leaves. The T pass reads `a`, installing a WIP M3 dependency. A later `a@T` schedules W and invalidates the pass. If `a@T2` occurred before the read, the M3 retro-scan schedules W in T2. Pass values come from M2, never K0. | Both abstract timing orders model-verified; real Fiber scheduling unverified. |
| C2 default excluded by `flushSync` | D is in M2's queue. Sync render excludes D, so atom read is 0 and the pass-local computed derives 10 from the same snapshot. | Model-verified. |
| C3 rebase | T `+1`, U `×2`: U render skips T and gets 2; it clones U with no lane. T render replays T then U and gets 4. A later set overwrites preceding updaters. | Model-verified, including a small exhaustive matrix. |
| C4 two batches | Every write marks consumers in its requested lane; no once-stale or cross-write suppression state exists. | Specified; fork test required. |
| C5 equal first result, effective second | M3 delivery is value-blind. Both writes remain queued; the eventual pass-local computed reads the final M2 values. | Queue half model-verified; Fiber half unverified. |
| C6 grouped lanes | `batch()` does not group delivery. Each enqueue calls React lane selection in its actual call stack. | Specified; fork differential test required. |
| C7 yield gap | Pass pin freezes M2. The handler has no render context, so it reads/writes K0; its M2 update is post-pin and cannot drift the resumed attempt. | Pin model-verified; fork yield/restart behavior unverified. |
| C8 equal overlapping writes | React-mode writes always enqueue. U-only and T-only renders each retain their own set operation. | Model-verified. |
| C9 mount mid-transition | A mount reads the pass's root-cell snapshots on its first render. `useComputed` is render-local, so “fresh node” has no global arena allocation or stale K0 cache. | Specified within v1 API; React integration unverified. |
| C10 late subscription | M3 records the leaf and scans pending/base queues. A live excluded lane is scheduled on the mounting Fiber; a post-pin included update restarts. With one root, a committed-state change cannot race and preserve this WIP tree: the intervening root commit discards/rebases it. | Excluded-lane model-verified; commit/restart races unverified. |
| C11 roots | `createSignalRoot` rejects a second root before it renders signal consumers. | Explicit single-root restriction; detection must be fork-tested. |
| C12 store-only | Every enqueue marks root-cell work, so a subscriber is unnecessary. Synchronous transition writes commit through the dirty-cell pass. Raw post-`await` writes follow React and require another `startTransition`. | Abstract sync half model-verified; root-only fork commit unverified; seed async attribution unsupported. |
| C13 lifecycle | One non-reset safe-integer seq; object/cell identities are not recycled while live; React owns lane reuse; WIP dependencies die with WIP. Hard throw replaces wraparound. | Specified; forced-small-horizon and lane-reuse fork tests required. |
| C14 StrictMode | M2/M3/M4 are WIP state. Discard removes dependencies and scratch. Writes and global node construction throw before mutation. Stable thenables are user/resource-owned. | Pre-mutation rejection model-verified; fork StrictMode/error lifecycle unverified. |
| C15 suspense | The root cell or stable resource returns the same thenable object to every pass that sees the same state. Mid-transition mounts therefore use the same thenable; retries read the same queued value. No promise factory is allowed in the computed. | Reasoned under stable-thenable restriction; React integration unverified. |
| C16 committed effects | The dedicated dynamically tracked hook is absent. The supported composition is `const v = useSignal(s); useEffect(() => fn(v), [v])`; React runs it only after the render containing `v` commits. An unrelated commit excluding the signal lane does not produce that render. Core effects read newest by contract. | Native React composition; binding integration unverified; seed auto-tracking unsupported. |
| C17 rollback | No truncation surface exists. | Absent by scope. |

Additional schedules that killed prior designs:

- A T1-only pass discovering `a` after an earlier excluded `a@T2` schedules
  T2 at the read site; the old `seq > pin`-only retro-scan bug is not present.
- BASE and HEAD may agree while a subset differs; M2 calculates the subset and
  M3 records its actual leaves. No BASE/HEAD induction is used.
- A cell write after a component's pass-local computed memo was created marks
  that component through WIP leaf dependencies. A second component that hit
  the memo is also marked because M4 replayed the leaves.
- There are no evaluator promotions, root lock-ins, batch-slot sweeps, or
  suspense capsule generations to validate.

---

## 8. Performance: hypotheses and gates, not claims

Only the pure-core baseline is measured in this repo. The React paths below
are unmeasured until a fork prototype exists.

| path | expected work | prototype gate |
| --- | --- | --- |
| Pure core | Existing arena kernel only. | Re-run 179/179 conformance and tier-0 baselines unchanged. |
| Quiet atom read | Root-cell snapshot lookup + one Fiber dependency record. | ≤15% mount overhead at 10k subscriptions; ≤10% rerender overhead vs equivalent `useState`. |
| Dirty pass start | One queue replay per dirty atom, regardless of consumer count. | No more than 1.15× equivalent collections of `useReducer` queues. |
| Atom write | One update allocation, K0 write, reverse-list walk, root mark. | No more than 2× DIRECT write at matched fan-out; report fan-out separately. |
| Global computed read | One evaluation per pass plus leaf replay per consuming Fiber. | Record leaf count and memo-hit replay cost; reject if a 10k × 1-leaf mount misses the mount gate. |
| Memory | One root cell per React-touched atom; current/WIP queues; current/open dependency records; pass scratch. | Heap and retained dependency counts return to baseline after discard/unmount soak. |

No zero-allocation steady-render claim is made. No claim is made that the fork
diff is small. The design accepts a deeper fork in exchange for deleting the
userspace concurrency state machine.

---

## 9. Evidence and falsification gates

### Verified now

- `node --test design-loop/oneoff-codex/model.test.mjs` covers C2, C3, C8,
  post-pin read freezing, same-lane pending-only dependencies, earlier
  excluded-lane retro-delivery, late mounts, computed-memo leaf replay,
  store-only commits, pre-mutation render rejection, and a small exhaustive
  two-update rebase matrix.
- The repo's arena conformance and benchmark records establish K0 as a viable
  core. They do not measure ROOT-CELL.
- React source at commit `e71a6393e66b0d2add46ba2b2c5db563a0563828`
  confirms the donor constructions: double-buffered persistent update queues,
  skipped-lane base queues, committed replay clones, WIP context dependency
  lists, and lane propagation through consumer ancestors.
  See [`ReactFiberClassUpdateQueue.js`](https://github.com/facebook/react/blob/e71a6393e66b0d2add46ba2b2c5db563a0563828/packages/react-reconciler/src/ReactFiberClassUpdateQueue.js),
  [`ReactFiberHooks.js`](https://github.com/facebook/react/blob/e71a6393e66b0d2add46ba2b2c5db563a0563828/packages/react-reconciler/src/ReactFiberHooks.js), and
  [`ReactFiberNewContext.js`](https://github.com/facebook/react/blob/e71a6393e66b0d2add46ba2b2c5db563a0563828/packages/react-reconciler/src/ReactFiberNewContext.js).

### Not verified; must block implementation claims

1. Factoring the queue processor for root-owned detached cells without
   changing hook/class semantics.
2. A root commit with only dirty cells and no Fiber consumer.
3. Reverse dependency lifecycle through Suspense, Activity/Offscreen, error
   boundaries, hydration, and StrictMode.
4. Pre-commit invalidation for an included-lane post-pin write.
5. Hook-local equality reference preservation through hidden/revealed trees.
6. Every performance gate in §8.

### Prototype exit rule

Do not add userspace receipts, K1, lock views, evaluator chains, or validity
stamps to rescue a failed fork spike. If detached queues or dependency
lifetime cannot pass the nine fork invariants directly, reject ROOT-CELL and
fall back to the receipt/tap family with its costs stated. Accreting both
families recreates the designs that the rounds already disproved.

---

## 10. Minimal implementation order

1. Copy the queue algorithm into a fork-only test type and differential-test
   it against `useReducer` before exposing any signal API.
2. Add dirty-cell-only root work and prove store-only commit.
3. Add one atom read dependency per Fiber; test current/WIP/discard lifecycle.
4. Add retroactive excluded-lane scheduling and pin tests, including C1's two
   timing orders and C10.
5. Bind the existing K0 atom write/read path.
6. Add pass-local immutable computeds and leaf replay.
7. Add stable-thenable Suspense tests.
8. Run correctness before performance. If correctness passes, measure the §8
   gates on a quiet machine, one implementation per process.

This sequence deliberately has an early kill point: steps 1–4 decide whether
the architecture is real before any broad library implementation begins.
