# State of the Art in JS/TS Reactivity Internals — Deep Research Report

Scope: internals of Reactively, SolidJS 1.x & 2.0, Preact Signals, Vue 3.4→3.6, Svelte 5, Angular Signals, TC39 Signals, MobX, S.js, cellx, uSignal, @maverick-js/signals. For each: dependency tracking, dirty propagation, version/memo tricks, memory layout, scheduling, tradeoffs. All claims below come from fetched primary sources (source files, PRs, blog posts), linked inline.

---

## 1. Reactively (milomg) — the canonical clean/check/dirty ("graph coloring") algorithm

Sources: [blog post "Super charging fine-grained reactive performance"](https://milomg.dev/2022-12-01/reactivity), [core.ts source](https://raw.githubusercontent.com/milomg/reactively/main/packages/core/src/core.ts), [repo README](https://github.com/milomg/reactively).

**Data layout**: one `Reactive<T>` class for everything (signal, memo, effect). Fields: `_value`, `fn?`, `observers: Reactive[] | null`, `sources: Reactive[] | null` (plain **arrays**, not linked lists; "sources in reference order, not deduplicated"), `state: CacheState`, `effect: boolean`, `cleanups`, `equals`.

**States**: `CacheClean = 0`, `CacheCheck = 1` ("might be stale, check parents"), `CacheDirty = 2` ("parents have changed"). This is the three-color algorithm: on write, the changed node's **direct** observers are marked `Dirty` (red) and all transitive descendants are marked `Check` (green) — a cheap push phase that touches each downstream node at most once (`stale()` early-exits if `this.state >= state`). No per-edge or per-node version numbers needed.

**Pull phase — `updateIfNecessary()`** (verbatim logic):
```ts
if (this.state === CacheCheck) {
  for (const source of this.sources!) {
    source.updateIfNecessary();
    if (this.state === CacheDirty) break; // a source actually changed → stop polling others
  }
}
if (this.state === CacheDirty) this.update();
this.state = CacheClean;
```
Recursing up from the read leaf gives topological recomputation order for free; equality checks in `update()` stop the dirty wave (only if the recomputed value differs do observers get promoted from Check→Dirty).

**Dynamic-dependency trick (widely copied)**: while a computation runs, a module-global `CurrentGets`/`CurrentGetsIndex` pair implements *prefix reuse*: each `get()` compares the read source against `sources[CurrentGetsIndex]`; if equal, just `CurrentGetsIndex++` (zero allocation); on first mismatch, start accumulating a `CurrentGets` array. Afterward only the suffix from the divergence point is unlinked/relinked. Stable dependency sets therefore allocate nothing on re-run.

**Scheduling**: effects push themselves onto a global `EffectQueue` when they first leave Clean; `stabilize()` is deferred via `queueMicrotask`. Blog benchmark claim: fastest across varied topologies on M1 vs Solid/Preact/S.js at the time (2022); this benchmark grew into [js-reactivity-benchmark](https://github.com/transitive-bullshit/js-reactivity-benchmark).

**Tradeoff**: the Check state means a read of a checked node must *poll all its sources* (O(indegree) pointer chases) even when nothing changed. Preact/Angular/Svelte attack this with version counters; alien-signals attacks it with flags + link traversal.

---

## 2. SolidJS 1.x internals, and Solid 2.0's new core

### Solid 1.x ([signal.ts](https://raw.githubusercontent.com/solidjs/solid/main/packages/solid/src/reactive/signal.ts))
- **Data layout**: `SignalState { value, observers: Computation[] | null, observerSlots: number[] | null, tValue?, comparator? }`; `Computation { fn, state, tState?, sources: SignalState[] | null, sourceSlots: number[] | null, updatedAt, pure, owner, ... }`.
- **Slot-based O(1) unsubscribe**: parallel arrays `observers`+`observerSlots` / `sources`+`sourceSlots` store, for each edge, the index of the mirror entry on the other side. Unsubscribe is swap-remove: pop the tail, write it into the vacated index, patch the moved node's slot (`n.sourceSlots![s] = index`). This is the array analog of a doubly-linked list, with better locality but edges are still two-sided.
- **Dirty propagation**: two states, `STALE = 1` and `PENDING = 2` (≈ Dirty/Check). `writeSignal` runs `comparator`, then marks direct observers STALE and calls `markDownstream` which marks transitive memo observers PENDING and pushes them into queues (`if (o.pure) Updates.push(o); else Effects.push(o)`).
- **Execution — `runTop`**: for each queued node, walk the **owner chain** upward collecting stale ancestors, then run from the top down; ancestors with `updatedAt >= ExecCount` are skipped. This uses the ownership tree as a cheap topological proxy instead of graph height.
- **Two queues**: `Updates` (pure memos) fully drains before `Effects` (user effects) — "pure phase before effect phase".
- **Transitions**: a global `Transition { sources: Set, effects, promises: Set, disposed, queue }`; signals carry a **forked value** `tValue` and computations a forked `tState`; on commit, `tValue → value` is copied for all touched sources. This double-buffering is how 1.x does concurrent/async rendering.
- **Tradeoff**: eager push of memo invalidation + `runTop` owner walks; memos are eagerly recomputed during the update pass (not lazy), which is exactly what Reactively/alien-signals improve on.

### Solid 2.0 core (branch `next`, [`packages/solid-signals/src/core/`](https://github.com/solidjs/solid/tree/next/packages/solid-signals/src/core) — files: `core.ts`, `effect.ts`, `scheduler.ts`, `heap.ts`, `lanes.ts`, `async.ts`, `owner.ts`, `graph.ts`)
Milo (reactively's author) works on this core; it merges the coloring algorithm with alien-signals-style plumbing plus first-class async:
- **Linked lists everywhere**: deps via `_deps`/`_depsTail` with `_nextDep`; subscribers via `_subs`/`_subsTail`; ownership as an intrusive child list (`_firstChild`, `_nextSibling`, `_prevSibling`).
- **Flags**: `REACTIVE_NONE / REACTIVE_DIRTY / REACTIVE_CHECK / REACTIVE_LAZY / REACTIVE_DISPOSED / REACTIVE_OPTIMISTIC_DIRTY`, plus status bits `STATUS_UNINITIALIZED / STATUS_PENDING / STATUS_ERROR` for async — pending/error propagate through the graph as state bits rather than thrown promises.
- **updateIfNecessary** is reactively's, extended: `if (el._flags & (REACTIVE_DIRTY|REACTIVE_OPTIMISTIC_DIRTY) || (el._error && el._time < clock && !el._inFlight)) recompute(el)`.
- **Clock + height scheduling**: a global `clock` with per-node `_time` for staleness, and per-node `_height` (graph depth). Dirty nodes go into a **min-heap keyed by `_height`** (`dirtyQueue`; a separate `zombieQueue` for `REACTIVE_ZOMBIE` nodes), so recomputation proceeds in topological order without recursive source polling (`if (queue._min > s._sub._height) queue._min = s._sub._height`). See `heap.ts`.
- **Values are multi-buffered**: `_value`, `_pendingValue` (in-flight transition value), `_overrideValue` (optimistic, `NOT_PENDING` sentinel), `_snapshotValue`.
- **Lanes** (`lanes.ts`): optimistic transitions get their own lane with its own effect queues (`lane._effectQueues[type-1]`), `_asyncReporters: Map<Computed, Set<Computed>>` to know when a transition settles, mergeable lanes, selective revert of optimistic values.
- **Scheduler**: two effect types (`EFFECT_RENDER`, `EFFECT_USER`) in a hierarchical queue; single `queueMicrotask(flush)` guarded by `!syncDepth && !globalQueue._running`. [InfoQ on the 2.0 beta](https://www.infoq.com/news/2026/05/solidjs-2-async/): "computations can return Promises and the reactive graph handles suspension and resumption automatically"; deterministic microtask batching with explicit `flush()`.
- Ryan Carniato's design rationale essays: [Scheduling Derivations in Reactivity](https://dev.to/this-is-learning/scheduling-derivations-in-reactivity-4687) (push-pull = "a Pull system built inside a Push one"; lazy deriveds + throw-on-pending accidentally create async waterfalls; hence scheduled async nodes) and [Async Derivations in Reactivity](https://dev.to/this-is-learning/async-derivations-in-reactivity-ec5).

---

## 3. Preact Signals

Sources: [blog "Signal boosting"](https://preactjs.com/blog/signal-boosting/), [current core source](https://github.com/preactjs/signals/blob/main/packages/core/src/index.ts).

- **Edge representation**: one **quad-linked Node per (source,target) pair** — `{ _source, _prevSource, _nextSource, _target, _prevTarget, _nextTarget, _version, _rollbackNode }`. The same object sits simultaneously in the target's source list and the source's target list, so one allocation covers both directions and is reused for the lifetime of the edge ("allocate only one Node per dependency-dependent pair and then use that Node indefinitely"). They moved to this from `Set`s because Set iteration was slower than arrays and dynamic dependencies caused Set churn.
- **Node recycling protocol**: before a computed/effect runs, `prepareSources` marks each existing Node `_version = -1` (recyclable) and stashes it at `signal.node` (with `_rollbackNode` for nesting). During the run, a read that finds a `-1` node recycles it and moves it to the list tail; `cleanupSources` then walks backwards, unsubscribing nodes still at `-1`. O(1) work per dependency per run, zero allocation in steady state.
- **Versions instead of colors**: each signal has `_version` (incremented only when the value actually changes); each Node caches the version it last saw. Plus a **`globalVersion`** bumped on every plain-signal write: `computed._refresh()` first checks `globalVersion` — if unchanged since last run, *nothing anywhere* changed and it returns immediately (fast-path for repeated reads in a quiet system). Then: if TRACKING and not OUTDATED, skip; else `needsToRecompute` polls sources **in access order** (first changed source short-circuits); recompute only bumps `_version` if the new value differs.
- **Flags**: `RUNNING=1, NOTIFIED=2, OUTDATED=4, DISPOSED=8, HAS_ERROR=16, TRACKING=32` in one int.
- **Lazy liveness**: a computed only subscribes to its sources (i.e., inserts target-list nodes) while it has subscribers itself — otherwise GC can collect it; linked lists make sub/unsub O(1) so this costs nothing.
- **Scheduling**: intrusive singly-linked batch list `effect._nextBatchedEffect`; `batch()` maintains `batchDepth`/`batchIteration`; `NOTIFIED` prevents duplicate enqueue ("cascading notification stampedes").
- **Tradeoff**: push of OUTDATED notifications goes through target lists eagerly on every write (no Check state); the version polling is per-edge. Diamond-heavy graphs re-notify but versions prevent recompute.

---

## 4. Vue 3.4 → 3.5 → 3.6

- **Vue 3.4** — [PR #5912 "more efficient reactivity system" (johnsoncodehk, merged 2023-10)](https://github.com/vuejs/core/pull/5912): introduced `dirtyLevels` (NotDirty / MaybeDirty / Dirty — the clean/check/dirty scheme) so computeds that recompute to an equal value no longer trigger effects/watch/render; chained computeds stop re-running per write (their timer demo: `min_counter` drops from 10,000,001 to 10,001 runs). New scheduling with `pauseScheduling`/`resetScheduling`, 2.5–4.5x faster scheduling.
- **Vue 3.5** — [PR #10397 (Evan You)](https://github.com/vuejs/core/pull/10397): rewrote dep tracking to **version counting + doubly-linked lists explicitly "inspired by Preact signals"**. Each dep has `version`; a global version fast-paths computeds; `Link` objects form both dep-list and sub-list. Memory for 1000 refs + 2000 computeds + 1000 effects: **1426 kB → 631 kB (−56%)**; computeds lazily subscribe only when they gain their first subscriber (GC-safe, fixed SSR leaks). Known weakness: pull-model cliff when "a large number of computeds are read after changing a ref."
- **Vue 3.6** — alien-signals adoption by Johnson Chu: [PR #12349 ports alien-signals 0.4.4 (merged 2024-12)](https://github.com/vuejs/core/pull/12349) — "alien-signals is a research-oriented signal library rewritten based on Vue 3.4's reactivity system... currently the fastest implementation among all signal libraries". Ports `system.ts` into `effect.ts`. Reported: **~13% lower memory** (2.3MB→2.0MB) and **>30x** on the 3.5 pathological case (1000 refs → 1 computed: 5,776→19,686 hz without effect, 6,268→22,764 hz with effect), 1.2–3.5x across effect benches. Then [PR #12570 ports alien-signals 1.0.0](https://github.com/vuejs/core/pull/12570), [#12791 syncs 1.0.4](https://github.com/vuejs/core/pull/12791), [#14057 syncs alien-signals 3.0.0 (2025-11)](https://github.com/vuejs/core/pull/14057), [#14813 syncs latest system.ts (2026-05)](https://github.com/vuejs/core/pull/14813). Vue is effectively a continuous downstream consumer of alien-signals' `system.ts`.

---

## 5. Svelte 5 runes

Sources: [runtime.js](https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/runtime.js), [sources.js](https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/reactivity/sources.js), [deriveds.js](https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/reactivity/deriveds.js).

- **Data layout**: plain JS objects. Source: `{ f (flags int), v (value), reactions: array|null, equals, rv (read version), wv (write version) }`. Derived adds `deps`, `effects`, `fn`, `parent`, `ac` (AbortController for async). Flags include `DERIVED, DIRTY, CLEAN, MAYBE_DIRTY, CONNECTED, INERT, DESTROYED, ERROR_VALUE, WAS_MARKED, REACTION_RAN, ASYNC, REACTION_IS_UPDATING, EFFECT_PRESERVED`.
- **Versions, not per-edge state**: a **global `write_version`** counter; on a real change `source.wv = increment_write_version()`. A reaction records the `wv` it ran at. `is_dirty(reaction)`: DIRTY → true; MAYBE_DIRTY → for each dep, (update async/derived deps first, then) `if (dependency.wv > reaction.wv) return true`; if all clean and CONNECTED, reset to CLEAN. So Svelte's "check" resolution is a **version comparison per dep**, not per-edge stored versions — one number per node.
- **Read-version dedup**: a global `read_version` increments per reaction execution; each signal's `rv` is stamped on first read in the current run (`if (signal.rv < read_version)`), giving O(1) duplicate-read detection with no Set.
- **Prefix-reuse**: same trick as reactively, with explicit names: `if (new_deps === null && deps !== null && deps[skipped_deps] === signal) skipped_deps++; else (new_deps ??= []).push(signal)` — "avoids array reallocation when dependencies haven't changed."
- **Write propagation** (`internal_set` → `mark_reactions`): equality-gated; deriveds get `MAYBE_DIRTY` and are recursed into only `if ((flags & WAS_MARKED) === 0)` (a mark bit preventing re-traversal of already-notified subgraphs — cheaper than alien-signals re-walking); effects get `schedule_effect` only if not already dirty; a special `eager_effects` set flushes synchronously. Writes are captured into a `Batch` (`Batch.ensure(); batch.capture(source, value)`) which supports forks (async/await in deriveds) and old-value capture.
- **Scheduling**: root-effect queue flushed in a microtask (`flush_queued_root_effects`); effects are organized in the effect tree, and `untrack`/`REACTION_IS_UPDATING` gate dependency registration.
- **Tradeoff**: object-shaped nodes + arrays of reactions; `wv > reaction.wv` polling requires deps arrays but avoids storing per-edge versions; `WAS_MARKED` requires a clearing pass.

---

## 6. Angular Signals

Sources: [primitives/signals README (deep dive)](https://github.com/angular/angular/blob/main/packages/core/primitives/signals/README.md), [graph.ts current](https://github.com/angular/angular/blob/main/packages/core/primitives/signals/src/graph.ts), [signal-polyfill graph.ts (older Angular snapshot)](https://github.com/proposal-signals/signal-polyfill/blob/main/src/graph.ts).

- **Producer/consumer model**: everything is a `ReactiveNode`; computeds are both. **Live vs non-live consumers**: only live consumers (effects/watchers, or nodes depended on by live consumers — transitively) get reverse edges (producer→consumer) and push notifications. Non-live computeds are *poll-only*: "when `double()` is read, it polls its producers... and checks whether any of them report having changed." Liveness is the GC story: reverse references exist only where a consumer reference already exists, so **no unsubscribe API is needed** and dropped computeds are collectable.
- **Versions + epoch**: every producer has `version` ("semantic identity of the value", bumped only on non-equal recompute); a **global `epoch`** increments on every source `set`. Each node stores `lastCleanEpoch`; `producerUpdateValueVersion` short-circuits: (1) live and not dirty → trusted clean; (2) `lastCleanEpoch === epoch` → nothing in the world changed, skip polling entirely; (3) otherwise `consumerPollProducersForChange()` compares per-edge `lastReadVersion` vs `producer.version`, and recomputes only on mismatch. Two-phase push/pull: push only invalidates (no recompute, no effects — glitch-free); pull recomputes on read.
- **Memory layout evolution — important precedent**: the polyfill (older Angular code, Google copyright header) uses **parallel arrays, i.e. struct-of-arrays for edges on each consumer**: `producerNode: ReactiveNode[]`, `producerLastReadVersion: Version[]`, `producerIndexOfThis: number[]`, all sharing indices, with a `nextProducerIndex` cursor implementing the same prefix-reuse pointer trick ("each dependency read is compared against the dependency from the previous run at the pointer's current location"), and reverse edges as `liveConsumerNode[]`/`liveConsumerIndexOfThis[]` with swap-remove. **Current Angular main has migrated to linked `ReactiveLink` edges**: `{ producer, consumer, knownValidAtEpoch, lastReadVersion, prevConsumer, nextConsumer, nextProducer }` with `producers/producersTail` + `consumers/consumersTail` heads on nodes — i.e., Angular converged on alien-signals/Preact-style link lists (single-linked on the producer direction, doubly-linked on the consumer direction), with per-link `knownValidAtEpoch` for reuse validation and last-accessed-producer dedup ("if the last producer we accessed is the same as the current one, skip adding a new link").
- **Scheduling**: Angular's primitives don't schedule; `consumerMarkedDirty` hooks into the framework (change detection / effect scheduler).
- **Tradeoffs**: polling non-live computeds does O(indegree) version comparisons per read (mitigated by `lastCleanEpoch`); no Check-state marking pass at all in the non-live world — writes are O(live subtree) only.

---

## 7. TC39 Signals proposal + signal-polyfill

Sources: [proposal README](https://github.com/tc39/proposal-signals), [signal-polyfill](https://github.com/proposal-signals/signal-polyfill).

- **Standardized algorithm**: `Signal.Computed` has four states — `dirty`, `computing`, `clean`, `checked` — i.e., the reactively coloring algorithm plus a computing state for cycle detection. On `State.set`: "set the state of all sinks... to dirty if they were previously clean" (direct sinks dirty, transitive ones checked). On read: "recurse up via sources to find the deepest, left-most recursive source which is a Computed marked dirty" → topological recompute. Auto-tracking via a global `computing`; caching guarantee is normative ("computations that don't have changes in their dependencies do not need to be re-evaluated"); `equals` defaults to `Object.is` and gates dirtying of dependents.
- **Effects are not built-in**: `Signal.subtle.Watcher` (states waiting/watching/pending) fires `notify` synchronously during `set` "after graph coloring has completed", and may not read/write signals — frameworks build their own schedulers on `getPending()`.
- **Implementation**: the polyfill's `graph.ts` is **verbatim Angular code** (Google LLC license header; `producerNode`/`producerLastReadVersion`/`producerIndexOfThis` parallel arrays, epoch counter). So the "standard" algorithm = reactively coloring semantics implemented on Angular's version/epoch machinery. Proposal's perf note: "native C++ implementations... can be slightly more efficient by a constant factor... no algorithmic changes are anticipated vs. a polyfill."

---

## 8. Others: MobX, S.js, cellx, uSignal, @maverick-js/signals

### MobX ([derivation.ts](https://github.com/mobxjs/mobx/blob/main/packages/mobx/src/core/derivation.ts), [observable.ts](https://github.com/mobxjs/mobx/blob/main/packages/mobx/src/core/observable.ts))
- Four derivation states: `NOT_TRACKING_(-1), UP_TO_DATE_(0), POSSIBLY_STALE_(1), STALE_(2)` — clean/check/dirty predates reactively here, with POSSIBLY_STALE only used for `ComputedValue` dependencies. `shouldCompute`: POSSIBLY_STALE → call `.get()` on each computed dep and see if that transitions self to STALE.
- Push functions on observables: `propagateChanged` (→STALE), `propagateMaybeChanged` (→POSSIBLY_STALE, only from computeds), `propagateChangeConfirmed` (computed recomputed and actually changed → promote POSSIBLY_STALE to STALE). Each observable caches `lowestObserverState_` to skip redundant propagation waves — a per-node summary of observer states.
- **Memory layout**: `observers_` is a `Set<IDerivation>`; deps are re-bound per run via `newObserving_` array (preallocated length 100 or previous size) + a global `runId_`, then `bindDependencies` does a three-phase **diffValue marking diff** (mark new =1 dedupe, unobserve old =0, addObserver new =1). Unobserved observables go to a `pendingUnobservations` queue processed at batch end.
- Tradeoffs: Sets + per-run rebind diffing allocate more than pointer tricks; eager `reaction` scheduling via transactions (`Reaction.onBecomeStale_ → schedule`). MobX computeds recompute during the push if observed (glitch-free via 2-state marking), lazily if unobserved.

### S.js ([S.ts](https://github.com/adamhaile/S/blob/master/src/S.ts))
- Synchronous **clock model**: `Clock { time, changes: Queue<DataNode>, updates: Queue<ComputationNode>, disposes: Queue }`. Writes during a running tick go to `node.pending` (`NOTPENDING` sentinel), committed at tick boundaries (`applyDataChange`), and the loop runs to quiescence (`while changes.count || updates.count`), incrementing `time` each round — glitch-free eager evaluation with **node ages** (`age` vs clock time) to detect same-tick conflicts.
- Layout: `ComputationNode { fn, value, age, state: CURRENT|STALE|RUNNING, source1, sources[], log, owned[], cleanups }` — note the **`source1` inline-first-dependency optimization** (single-dep nodes never allocate arrays), and `Log { node1, nodes[], nodeslots[] }` with slot indices for O(1) removal (this is where Solid 1.x's slots came from).
- Tradeoff: fully eager (every downstream computation reruns each tick), no lazy memo skipping; predictable but does more work than push-pull on wide graphs.

### cellx ([Cell.ts](https://github.com/Riim/cellx/blob/master/src/Cell.ts), [README](https://github.com/Riim/cellx))
- States `'actual' | 'dirty' | 'check'` — again clean/check/dirty. `_actualize()` recursively resolves `check` by actualizing dependencies, then `pull()` if dirty. Dependencies and dependents are **intrusive linked lists** (`_nextDependency`, `_nextDependent`, `_currentDependency` cursor during pull). Global `Cell_CommonState { pendingCells: Cell[], currentCell, lastUpdateId }`; `_addToRelease()` marks dependents dirty/check and pushes to `pendingCells`, released on `nextTick` — push-pull with microtask batching plus an event/listener layer (`onChange`, `onError` with error propagation through the graph). `_active` = has deps and (dependents or listeners) gates whether a cell tracks at all.
- Perf claims are in a Habr benchmark (computing layers of 4-ary dependency chains); cellx historically won deep-chain synthetic benchmarks due to minimal per-node work and lazy activation.

### uSignal ([index.js](https://github.com/WebReflection/usignal/blob/main/esm/index.js))
- Minimalist: bidirectional `Set`s (`this.c = new Set // computeds`, `this.r = new Set // related signals`), lazy computeds via a should-update flag, effects batched in an array, optional `queueMicrotask` async effects. No coloring, no versions; performance comes purely from being tiny. Good baseline for what Sets cost vs links.

### @maverick-js/signals ([core.ts](https://github.com/maverick-js/signals/blob/main/src/core.ts))
- Direct descendant of reactively/Solid: states `STATE_CLEAN=0, STATE_CHECK=1, STATE_DIRTY=2, STATE_DISPOSED=3`; `_sources[]`/`_observers[]` arrays; the identical `currentObservers`/`currentObserversIndex` prefix-reuse trick; notify cascades CHECK; effects via `queueMicrotask(runEffects)` with `tick()` for sync flush; ownership through a `[SCOPE]` symbol and child chains. Used by Vidstack; benchmarked near reactively.

---

## Cross-cutting synthesis — the design space

**Dirty propagation (all modern libs are push-pull):**
- Pure eager push: S.js, Solid 1.x memos (with 2-queue phasing). Cost: recompute on every write.
- 3-color push-pull (Dirty/Check + pull-time source polling): reactively, maverick, cellx, MobX, TC39, Solid 2.0, Vue 3.4, alien-signals (flags variant).
- Version-polling push-pull (push invalidation only to live/subscribed consumers; pull compares version counters): Preact, Vue 3.5, Angular, Svelte 5 (hybrid: MAYBE_DIRTY marking + `wv` comparison instead of per-edge versions).

**Global monotonic counter fast paths** (cheap, alien-signals currently lacks): Preact `globalVersion` (skip everything if no signal wrote since last read), Angular `epoch` + per-node `lastCleanEpoch` (skip polling entirely), Svelte global `write_version` (one comparison per dep resolves Check without per-edge storage) and `read_version` (O(1) same-run dedup without Sets or link searching), Solid 2.0 `clock`/`_time`, S.js `time`/`age`, MobX `runId_`.

**Dependency-edge storage — three families:**
1. **Arrays with swap-remove slots** (Solid 1.x `sourceSlots`/`observerSlots`, S.js `nodeslots`, old-Angular/polyfill `producerIndexOfThis`): O(1) unlink, better cache locality than pointer chasing, but 2–4 parallel arrays per node.
2. **Parallel arrays = struct-of-arrays per consumer** (old Angular/signal-polyfill: `producerNode[]` + `producerLastReadVersion[]` + `producerIndexOfThis[]` + `nextProducerIndex` cursor): the closest existing precedent to a typed-array/SoA layout; versions live in a numeric array that could be a `Float64Array`/`Uint32Array`. Angular later moved to linked `ReactiveLink`s (matching alien-signals), reportedly for cheaper edge reuse/removal under dynamic deps — evidence the tradeoff is not one-sided.
3. **Linked link-objects** (Preact quad-linked Node, Vue 3.5 Link, Angular current ReactiveLink, alien-signals Link, Solid 2.0 `_nextDep`, cellx): one allocation per edge shared by both directions, O(1) insert/remove, indefinite reuse; cost = pointer-chasing on poll and per-edge object headers.

**Universal prefix-reuse trick**: reactively `CurrentGetsIndex`, Angular `nextProducerIndex`, Svelte `skipped_deps`, maverick `currentObserversIndex`, Preact node-recycling + tail-reordering — stable dep sets must be zero-allocation; only the divergent suffix is relinked. alien-signals does this with `depsTail` cursoring; the array variants show the same idea with better locality.

**Avoiding re-traversal on repeated writes**: Preact `NOTIFIED` flag; Svelte `WAS_MARKED`; reactively's `state < state` early exit; MobX `lowestObserverState_` (per-node summary of observer states, skips whole propagation waves); Angular's live-only push (non-live subgraphs are never walked at all).

**Scheduling:**
- Microtask batch + intrusive queue: Preact (`_nextBatchedEffect` singly-linked), maverick, cellx (`pendingCells` array), Svelte (root-effect queue), reactively (`EffectQueue` array).
- Phased queues: Solid 1.x `Updates` then `Effects`; Solid 2.0 `EFFECT_RENDER`/`EFFECT_USER` + lanes.
- **Height-keyed min-heap for topological flush without recursion**: Solid 2.0 `dirtyQueue`/`zombieQueue` keyed on `_height` with tracked `_min`/`_max` — the only mainstream lib doing priority-queue scheduling; eliminates the up-walk (`updateIfNecessary` recursion / `runTop` owner walk) at flush time.
- Owner-tree walk as topo proxy: Solid 1.x `runTop`.

**Equality gating** is universal: version/coloring promotion happens only when recompute yields a non-equal value (Preact `_version++` conditional, Angular `version` bump, Svelte `equals` before `wv` bump, reactively promoting Check→Dirty in observers only on change).

**Async/transitions**: Solid 1.x `tValue`/`tState` double-buffering; Solid 2.0 lanes + `_pendingValue`/`_overrideValue` + STATUS_PENDING bits flowing through the graph; Svelte 5 batches with forks + per-derived `AbortController`. If alien-signals ever wants async-capable deriveds, state-bit propagation (not thrown promises) is the converged answer.

**Ideas most directly applicable to alien-signals** (given its doubly-linked Links + version counters + flag propagation):
1. Global epoch/`lastCleanEpoch` skip (Angular) and/or `globalVersion` fast path (Preact) to make reads in quiet systems O(1) instead of O(deps).
2. Svelte-style single global `write_version` per node compared against the reader's run version — can replace per-Link version storage (shrinks Link) at the cost of one field per node.
3. Read-version (`rv`) stamping for O(1) duplicate-dependency detection.
4. `WAS_MARKED`-style bit to prevent re-walking already-notified subgraphs on repeated writes between flushes.
5. Height-keyed min-heap flush (Solid 2.0 `heap.ts`) to replace recursive checkDirty walks for effect flushing.
6. SoA precedent: signal-polyfill/old-Angular's `producerNode[]`+`producerLastReadVersion[]`+`producerIndexOfThis[]` parallel arrays are a working production design for array/typed-array edge storage with slot-based O(1) removal (swap-remove on `liveConsumerNode`) — but note Angular's subsequent migration to linked lists suggests measuring dynamic-dep churn carefully.
7. `source1` inline-first-dep (S.js) / last-accessed-producer dedup (Angular) micro-optimizations for the very common 1-dependency node.
8. Liveness distinction (Angular/Preact/Vue 3.5): only maintain reverse (subscriber) links for watched subgraphs; unwatched computeds are poll-only and GC-able.

## Key links

- [Super charging fine-grained reactive performance (milomg)](https://milomg.dev/2022-12-01/reactivity) — Canonical explanation of the clean/check/dirty two-phase graph coloring algorithm used by reactively, TC39, Solid 2.0
- [reactively core.ts](https://raw.githubusercontent.com/milomg/reactively/main/packages/core/src/core.ts) — Reference implementation: arrays for sources/observers, CurrentGetsIndex prefix-reuse trick, updateIfNecessary
- [Preact 'Signal boosting' blog post](https://preactjs.com/blog/signal-boosting/) — Explains quad-linked dependency Nodes, node recycling, per-signal versions + globalVersion — direct ancestor of alien-signals/Vue 3.5 design
- [Preact signals-core index.ts](https://github.com/preactjs/signals/blob/main/packages/core/src/index.ts) — Current flags, Node structure, prepareSources/cleanupSources recycling, batch mechanics
- [Angular signals deep-dive README](https://github.com/angular/angular/blob/main/packages/core/primitives/signals/README.md) — Producer/consumer polling design, live-consumer liveness for GC without unsubscribe, epoch + version semantics
- [Angular graph.ts (current, linked ReactiveLink)](https://github.com/angular/angular/blob/main/packages/core/primitives/signals/src/graph.ts) — Shows Angular's migration from parallel arrays to alien-signals-style linked edge lists with per-link lastReadVersion/knownValidAtEpoch
- [signal-polyfill graph.ts (old Angular snapshot)](https://github.com/proposal-signals/signal-polyfill/blob/main/src/graph.ts) — TC39 polyfill is literally Angular code; parallel-array (SoA) edge layout: producerNode[]/producerLastReadVersion[]/producerIndexOfThis[] with nextProducerIndex cursor
- [TC39 Signals proposal](https://github.com/tc39/proposal-signals) — Standardized dirty/computing/clean/checked state machine, Watcher semantics, normative caching guarantees
- [SolidJS 1.x signal.ts](https://github.com/solidjs/solid/blob/main/packages/solid/src/reactive/signal.ts) — STALE/PENDING states, sourceSlots/observerSlots swap-remove arrays, runTop owner-walk, transition tValue double-buffering
- [Solid 2.0 signals core (next branch)](https://github.com/solidjs/solid/tree/next/packages/solid-signals/src/core) — New core: linked dep lists, clock/_time, height-keyed min-heap dirtyQueue, lanes for optimistic async transitions
- [Vue PR #12349: ports alien-signals 0.4.4](https://github.com/vuejs/core/pull/12349) — Vue 3.6 adoption of alien-signals with full benchmark tables (>30x on pull-model pathological case, −13% memory)
- [Vue PR #10397: version counting + doubly-linked lists (3.5)](https://github.com/vuejs/core/pull/10397) — Preact-inspired refactor: −56% memory, lazy computed subscription; its weakness motivated the alien-signals port
- [Vue PR #5912: dirtyLevels refactor (3.4)](https://github.com/vuejs/core/pull/5912) — The clean/check/dirty adoption that alien-signals itself was rewritten from
- [Svelte 5 runtime.js](https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/runtime.js) — is_dirty via wv/rv version counters, skipped_deps prefix reuse, MAYBE_DIRTY resolution without per-edge versions
- [Svelte 5 sources.js](https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/reactivity/sources.js) — mark_reactions with WAS_MARKED re-traversal guard, batch capture, eager effects
- [MobX derivation.ts](https://github.com/mobxjs/mobx/blob/main/packages/mobx/src/core/derivation.ts) — NOT_TRACKING/UP_TO_DATE/POSSIBLY_STALE/STALE states, bindDependencies diffValue diffing, runId tracking
- [MobX observable.ts](https://github.com/mobxjs/mobx/blob/main/packages/mobx/src/core/observable.ts) — propagateChanged/MaybeChanged/ChangeConfirmed and lowestObserverState_ propagation-skipping summary
- [S.js source](https://github.com/adamhaile/S/blob/master/src/S.ts) — Synchronous clock/tick model, pending value commit, source1 inline-first-dep, slot arrays — origin of Solid's slots
- [cellx Cell.ts](https://github.com/Riim/cellx/blob/master/src/Cell.ts) — actual/dirty/check states on intrusive linked dependency lists with nextTick release queue
- [@maverick-js/signals core.ts](https://github.com/maverick-js/signals/blob/main/src/core.ts) — Compact reactively-derivative: same 3-state + currentObserversIndex trick, scope ownership via symbol
- [Scheduling Derivations in Reactivity (Carniato)](https://dev.to/this-is-learning/scheduling-derivations-in-reactivity-4687) — Design-space analysis: lazy vs scheduled deriveds, phased execution, why lazy+throw creates async waterfalls
- [Async Derivations in Reactivity (Carniato)](https://dev.to/this-is-learning/async-derivations-in-reactivity-ec5) — Rationale for propagating pending/error state bits through the graph (Solid 2.0 approach)
- [SolidJS 2.0 Beta InfoQ coverage](https://www.infoq.com/news/2026/05/solidjs-2-async/) — First-class async, deterministic microtask batching with flush(), optimistic actions in the shipped 2.0 beta
- [js-reactivity-benchmark](https://github.com/transitive-bullshit/js-reactivity-benchmark) — The cross-library benchmark suite (grown from reactively's) used by Vue/alien-signals to validate perf claims
- [uSignal source](https://github.com/WebReflection/usignal/blob/main/esm/index.js) — Set-based minimal baseline — useful contrast for what linked/array layouts buy
