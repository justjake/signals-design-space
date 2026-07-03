# Rust UI Reactive-Graph Implementations: Evidence For and Against Arena/Index-Based Data Layouts

Research method: shallow-cloned leptos (v0.6.15 tag + main), sycamore, dioxus, floem, and rust-signals; read the actual reactive-runtime source files; cross-checked against release notes, PRs, discussions, and blog posts. All file references below were verified against source at these commits (sycamore @ 7d1c602, 2026-06-15; others @ current main / v0.6.15).

**Headline for the alien-signals project**: The Rust ecosystem ran a natural experiment on exactly the question we're asking (central arena + integer-index handles vs. per-node heap objects + reference counting). Three frameworks (leptos 0.5–0.6, sycamore 0.9, floem) shipped central-table + Copy-integer-handle designs and love the *performance/ergonomics*; leptos then **partially retreated** from it in 0.7 — but crucially, *not for performance reasons*. The retreat was driven by (a) memory leaks inherent to non-refcounted index handles over dynamically-created nodes, (b) dangling-handle/use-after-dispose hazards, and (c) Send/Sync + per-request isolation needs on the server. All three of these are ownership/lifetime problems that JavaScript's GC either solves for free or reproduces in a different form (see synthesis, §8).

---

## 1. leptos_reactive 0.6: the canonical arena/index design (evidence FOR)

Sources: [ARCHITECTURE.md (v0.6.15)](https://github.com/leptos-rs/leptos/blob/v0.6.15/ARCHITECTURE.md), [leptos_reactive/src/runtime.rs](https://github.com/leptos-rs/leptos/blob/v0.6.15/leptos_reactive/src/runtime.rs), [node.rs](https://github.com/leptos-rs/leptos/blob/v0.6.15/leptos_reactive/src/node.rs), origin PR [leptos#637 "feat: new reactive system implementation"](https://github.com/leptos-rs/leptos/pull/637).

### Memory layout
The entire reactive graph is one thread-local `Runtime` struct of parallel maps keyed by `NodeId` (a slotmap key = 64-bit: 32-bit index + 32-bit generation — i.e., a *versioned index*, directly analogous to alien-signals' version counters but used for slot reuse safety, not change detection):

```rust
pub(crate) struct Runtime {
    pub nodes: RefCell<SlotMap<NodeId, ReactiveNode>>,
    pub node_subscribers: RefCell<SecondaryMap<NodeId, RefCell<FxIndexSet<NodeId>>>>,
    pub node_sources:     RefCell<SecondaryMap<NodeId, RefCell<FxIndexSet<NodeId>>>>,
    pub node_owners:      RefCell<SecondaryMap<NodeId, NodeId>>,
    pub node_properties:  RefCell<SparseSecondaryMap<NodeId, Vec<ScopeProperty>>>,
    pub pending_effects: RefCell<Vec<NodeId>>,
    pub observer: Cell<Option<NodeId>>, pub owner: Cell<Option<NodeId>>,
    pub batching: Cell<bool>, /* + contexts, cleanups, stored_values, resources */
}
```

This is effectively **struct-of-arrays**: node state in one table, subscriber edges in a parallel `SecondaryMap`, source edges in another, ownership in a third. `ReactiveNode` itself is small: `{ value: Option<Rc<RefCell<dyn Any>>>, state: enum{Clean,Check,Dirty,DirtyMarked}, node_type: enum{Trigger,Signal,Memo{f},Effect{f}} }`. **Edges are pure integers** — each dependency edge is one `NodeId` (8 bytes) in an `FxIndexSet` (indexmap with FxHash; insertion-ordered hash set backed by a `Vec`). User-facing `ReadSignal<T>`/`Memo<T>` are `Copy + 'static` wrappers around a `NodeId` + `PhantomData<T>`.

### Algorithm (Reactively lineage — same family as alien-signals)
PR #637 (March 2023) states the pre-0.5 system was "a naive push-based system" where "memos are implemented as an effect that writes into a signal" causing diamond-problem glitches, and that the rewrite "works much like that of the Reactively library in JavaScript": set → mark self Dirty, descendants Check, queue effects; read of a memo runs `update_if_necessary` which recursively checks sources, with early exit ("as soon as a single parent has marked us dirty, we can stop checking them"). The author reported it corrected over-re-running "without any measurable effect on bundle size or js-framework-benchmark results."

Noteworthy micro-engineering in `runtime.rs::mark_dirty` (the push phase):
- **Iterative DFS with a stack of live iterators** instead of buffering a to-visit list; uses the `self_cell` crate to hold `(Ref<'a, FxIndexSet<NodeId>>, indexmap Iter<'a>)` self-referential pairs so it never clones subscriber sets during traversal.
- **Single-subscriber fast path**: `if children.len() == 1 { child = children[0]; continue; }` — "avoid going through an iterator in the simple pseudo-recursive case." (Alien-signals' linked list gets this for free; in an index design it's an explicit branch.)
- A fourth state `DirtyMarked` doubles as the "visited" bit so re-entrant marking terminates without a separate visited set.
- `update_if_necessary` clones a node's source list into a `Vec` before iterating (RefCell discipline), with a hand-written `Vec::with_capacity + extend` "in case Vec::from_iterator specialization doesn't work."

### Execution-order guarantee via IndexSet (relevant to alien-signals' linked lists)
`cleanup_sources` uses `shift_remove` (O(n), order-preserving) rather than `swap_remove` (O(1)) with a long comment: dependencies of a signal must always trigger **in subscription order** — e.g. an outer effect that checks `.is_some()` must run before an inner one that `.unwrap()`s. Both leptos generations pay O(n) removal to keep this ordering. **Alien-signals' doubly-linked Link list gives O(1) unlink *and* stable order — this is a genuine advantage of linked lists that any array/typed-array port must consciously preserve** (swap-remove reorders; shift-remove is O(n); tombstones + compaction is the usual answer).

### Disposal model
Ownership is graph-encoded: `node_properties` maps each owner node → `Vec<ScopeProperty>` of everything created under it; disposing a node recursively disposes children, runs cleanups untracked, then removes the node from `nodes` and surgically removes its id from each subscriber's source set. The book's framing: Leptos implements "a 'garbage collector' in which the lifetime of data is tied to the lifetime of the UI, not Rust's lexical scopes" ([ARCHITECTURE.md](https://github.com/leptos-rs/leptos/blob/v0.6.15/ARCHITECTURE.md)).

---

## 2. Why Leptos 0.7 retreated to Arc: the cautionary tale (evidence AGAINST — with caveats)

Sources: [v0.7.0 release notes](https://github.com/leptos-rs/leptos/releases/tag/v0.7.0), [discussion #2565 (0.7.0-preview2)](https://github.com/leptos-rs/leptos/discussions/2565), [book appendix "The Life Cycle of a Signal"](https://book.leptos.dev/appendix_life_cycle.html).

Three documented failure modes of the pure arena + Copy-handle model:

1. **Leaks from nested dynamic signals.** Release notes, verbatim: the Copy arena "made it possible to leak memory if you have a collection of nested signals and do not dispose them." Canonical case: `RwSignal<Vec<RwSignal<Todo>>>` — removing a todo from the Vec does *not* dispose its inner signal; the arena slot lives until the whole owner is dropped. The handle is "just an integer: say, 3 if it's the 3rd signal in the application. You can copy that number all over the place… the number 3 that you've copied all over the place can't be invalidated" (book appendix). The 0.6 workaround was manual `.dispose()`, which Sycamore's author independently called "error-prone and boilerplate-y" (see §4).
2. **Use-after-dispose hazards.** Signals created low in the ownership tree but stored/read higher up outlive their owner's cleanup: updating a disposed signal warned; reading one panicked ("tried to access a disposed value"); `try_get`/`try_with` were the escape hatches. Copy handles cannot be statically prevented from dangling.
3. **Thread-affinity and server isolation.** The 0.6 `Runtime` was thread-local (with `TASK_RUNTIME` hacks for async server tasks). 0.7's headline: "Reactive system is now Send/Sync" (#2565), motivated by multithreaded Axum servers and thread-safe native UIs.

### What 0.7's reactive_graph actually looks like
Sources: [reactive_graph docs](https://docs.rs/reactive_graph), source under [reactive_graph/src](https://github.com/leptos-rs/leptos/tree/main/reactive_graph/src).

- **Nodes are individually heap-allocated Arc'd objects.** `ArcRwSignal<T> = { value: Arc<RwLock<T>>, inner: Arc<RwLock<SubscriberSet>> }` (signal/arc_rw.rs). `ArcMemo`'s `MemoInner` holds `value: Arc<RwLock<Option<T>>>`, the compute fn, an `Owner`, and `reactivity: RwLock<{ state: ReactiveNodeState, sources: SourceSet, subscribers: SubscriberSet, any_subscriber }>` (computed/inner.rs).
- **Edges are type-erased fat weak pointers.** `AnySource(usize, Weak<dyn Source + Send + Sync>)` and `AnySubscriber(usize, Weak<dyn Subscriber + Send + Sync>)` — the `usize` is `Arc::as_ptr as usize`, used for identity/hash; every graph hop is a `Weak::upgrade` + dynamic dispatch (graph/source.rs, graph/subscriber.rs). So one edge costs ≈3 words *per direction* plus refcount traffic, vs. 8 bytes in 0.6.
- **Edge containers**: `SourceSet`/`SubscriberSet` are `FxIndexSet` wrappers; module doc says "implemented as linear maps built on a Vec… for the sake of minimizing binary size… on the assumption that the M:N relationship… usually consists of fairly small numbers" (graph/sets.rs). `unsubscribe` again insists on order-preserving `shift_remove` with the same nested-effect-ordering justification.
- **Algorithm: 3-state Clean/Check/Dirty graph coloring** (graph/node.rs), explicitly credited: "The reactive-graph algorithm used in this crate is based on that of [Reactively](https://github.com/modderme123/reactively), as described in [this article](https://dev.to/modderme123/super-charging-fine-grained-reactive-performance-47ph)" (lib.rs) — i.e., the same ancestor as alien-signals. Signal write → `mark_dirty` → `mark_subscribers_check` **`.take()`s (clears!) the subscriber set** and calls `sub.mark_dirty()` on each (signals therefore rely on subscribers re-registering on their next run — Solid-style dynamic resubscription). Memo `mark_dirty` sets state=Dirty then propagates `mark_check` to a **clone** of its subscriber set (clone taken so the lock isn't held during user code — a lock-ordering tax the 0.6 single-RefCell design didn't pay). `update_if_necessary` on a memo: Clean→false, Dirty→true, Check→`sources.any(|s| s.update_if_necessary() || state==Dirty)`; on recompute it runs under `owner.with_cleanup` + `with_observer`, compares with `PartialEq`, and only `mark_dirty`s subscribers on change (skipping the current Observer to avoid self-retrigger).
- **Effects are async tasks**, not synchronous queue entries: `EffectInner { dirty: bool, observer: Sender, sources: SourceSet }`; `mark_dirty/mark_check` just `notify()` a 1-slot channel whose receiver loop (spawned via `any_spawner::Executor`) reruns the effect on the next tick — "async runtime agnostic" scheduling (effect/inner.rs, lib.rs design notes).
- **The arena survives as a thin ownership/ergonomics layer.** `RwSignal<T> = ArenaItem<ArcRwSignal<T>>` where `ArenaItem` is a Copy `NodeId` into a **global** `SlotMap<NodeId, Box<dyn Any + Send + Sync>>` behind a `RwLock` (owner/arena.rs, owner/arena_item.rs; `sandboxed-arenas` feature swaps in per-request thread-local arenas restored on every `Future::poll` for SSR isolation). Disposal: each `Owner` (`OwnerInner { parent: Weak, nodes: Vec<NodeId>, cleanups, children: Vec<Weak<OwnerInner>> }`) removes its registered NodeIds from the slotmap on cleanup, dropping the boxed `ArcRwSignal` and decrementing the refcount. So 0.7 = **refcounted nodes for correctness + arena of refcount-owners for Copy ergonomics**. Nested-signal collections use `ArcRwSignal` directly and leak nothing.

**Performance framing**: neither release notes nor discussions claim the Arc design is faster; leptos' own microbench suite (benchmarks/src/reactive.rs: 1000-memo chains, 1000→1 narrowing, 1→1000 fan-out, scope create/dispose, vs leptos 0.4 and sycamore 0.8) accompanied the *0.5* rewrite. The 0.7 rewrite trades per-edge overhead (weak fat pointers, RwLocks, set clones per notification) for leak-freedom, Send/Sync, and dropping the central-runtime lock contention point. For a GC language, the leak problem it solves is partially moot — see §8.

---

## 3. Sycamore 0.9: an independent *move toward* the slotmap arena (evidence FOR)

Sources: [PR #612 "Reactivity v3"](https://github.com/sycamore-rs/sycamore/pull/612), [v0.9.0 announcement](https://sycamore.dev/post/announcing-v0-9-0), [2022 "New reactive primitives" post](https://sycamore.dev/post/new-reactive-primitives) (the *previous* design), source [packages/sycamore-reactive/src/root.rs, node.rs](https://github.com/sycamore-rs/sycamore/tree/main/packages/sycamore-reactive/src).

History is instructive because Sycamore moved in the **opposite direction from leptos**, at almost the same time:
- **0.8 (2022)**: signals were `&'a Signal<T>` bump-arena-allocated inside `Scope<'a>` — real Rust lifetimes as the disposal mechanism. Problems (from the 2022 post + PR): lifetimes infected every API (`cx` threading), "a complicated orchestration of thread-locals," no async/await ("after a `.await` suspension point, we could no longer know what reactive scope we were in"), arena dealloc only en masse (signals created in loops/effects leak until scope death).
- **0.9 (Nov 2024, PR #612)**: "huge rewrite… from scratch," to `'static + Copy` signals backed by a `SlotMap`. lukechu10 explicitly weighed the leptos leak problem: nested signals in a `Vec` "will keep on holding onto its data which essentially causes a memory leak. Leptos solves this issue by adding a `.dispose()` method… I believe, however, that this approach is error-prone and boilerplate-y" — his preferred long-term answer being a Solid-style Store API rather than refcounting. He also accepted the dangling-handle risk with eyes open: a signal "can still be accessed even after the scope is dropped, causing the app to immediately panic. In practice, however, these situations are rare enough that they justify the added ergonomics."

### Layout: everything inline in one node table (AoS in a slotmap)
```rust
pub(crate) struct ReactiveNode {
    value: Option<Box<dyn Any>>, callback: Option<Box<dyn FnMut(&mut Box<dyn Any>) -> bool>>,
    children: Vec<NodeId>, parent: NodeId,             // ownership tree
    dependents: Vec<NodeId>,                            // outgoing edges (plain Vec, dup-tolerant)
    dependencies: SmallVec<[NodeId; 1]>,                // incoming edges, 1 inline
    cleanups: Vec<Box<dyn FnOnce()>>, context: Vec<Box<dyn Any>>,
    state: enum{Clean,Dirty}, mark: enum{Temp,Permanent,None},  // DFS bits stored in-node
}
```
Signals, memos, effects, and scopes are all this one type inside `Root { nodes: RefCell<SlotMap<NodeId, ReactiveNode>>, tracker, rev_sorted_buf, node_update_queue, batch_depth, … }`; `Signal<T>` is Copy `{ id: NodeId, root: &'static Root }`. Notable: **the traversal marks live in the node table** (no side visited-set), and `rev_sorted_buf` is a **reused scratch Vec** for propagation to avoid per-update allocation.

### Algorithm: eager, topologically-sorted push (different family than alien-signals)
`propagate_updates(start)`: DFS from the updated node over `dependents`, using Temp/Permanent marks (cycle → panic), producing a reverse topological order into the shared buffer; then walk it in topo order, re-running only nodes whose `state == Dirty`; each rerun (`run_node_update`) unlinks old dependency edges (`dependents.retain(|id| id != current)` per source — O(n) per edge), reruns the callback under a fresh tracker, relinks via `DependencyTracker { dependencies: SmallVec }`, and if `changed` marks direct dependents Dirty. Reads of memos call `ensure_node_is_clean` (lazy pull within batches). Effects are just nodes whose callback has side effects — updates are **eager per set()** unless batched (`batch_depth` counter, queue drained at outermost batch end). Cost profile: every `set` walks the *entire reachable subgraph* (to topo-sort) even if nothing recomputes — this is the classic MobX-style tradeoff that Reactively/alien-signals' Check-coloring avoids; but all traffic is integer indices in one cache-friendly table with zero per-edge allocations.

---

## 4. Dioxus generational-box: generational cells, not a contiguous arena (middle path)

Sources: [generational-box](https://github.com/DioxusLabs/dioxus/tree/main/packages/generational-box) (lib.rs, unsync.rs, sync.rs, entry.rs), [dioxus-signals signal.rs](https://github.com/DioxusLabs/dioxus/blob/main/packages/signals/src/signal.rs), [core reactive_context.rs](https://github.com/DioxusLabs/dioxus/blob/main/packages/core/src/reactive_context.rs).

- **Storage**: *not* a slotmap. Each cell is an individually `Box::leak`ed `&'static UnsyncStorage { borrow_info, data: RefCell<StorageEntry<…>> }`; freed cells are pushed onto a thread-local free-list (`UNSYNC_RUNTIME: RefCell<Vec<&'static UnsyncStorage>>`) and recycled on next allocation. `GenerationalBox<T>` is Copy = `{ storage: &'static S, generation: NonZeroU64 }`; every access checks `entry.generation == pointer.generation` — **runtime lifetime checking via generation counters** ("You can think of the cells as something like `&'static RefCell<Box<dyn Any>>` with a generational check," README). Recycle increments the generation, invalidating all outstanding Copy handles; stale access returns `BorrowError::Dropped` (Result, not panic) with the creation `Location` in debug builds. The entry is an enum `{ Data(Box<dyn Any>), Rc(RcStorageEntry), Reference(GenerationalPointer), Empty }` — so the same cell system supports plain owned data, refcounted data, and pointer-chasing references (`point_to`), the latter added for signal aliasing in props. `SyncStorage` is the same design with `RwLock` (parking_lot) instead of RefCell.
- **Disposal**: `Owner(Arc<Mutex<OwnerInner { owned: Vec<GenerationalPointer> }>>)` recycles everything it owns on Drop — a flat runtime lifetime guard, one per component scope; no ownership *tree* in the storage layer (the tree lives in Dioxus's VirtualDom scopes).
- **Reactivity layer (coarser than alien-signals)**: `SignalData<T> = { subscribers: Arc<Mutex<HashSet<ReactiveContext>>>, value: T }` inside a GenerationalBox. The subscriber is a `ReactiveContext` (per component scope / memo / future), which stores back-edges as `HashSet<PointerHash<Arc<dyn SubscriberList>>>` so it can unsubscribe itself on rerun/drop — **bidirectional edges as hash sets on both sides, Arc-pointer-hashed**. Write path: `signal.set` → `subscribers.retain(|rc| rc.mark_dirty())` (retain doubles as dead-subscriber pruning; comment notes they must not hold the lock during `mark_dirty` because user code may re-subscribe → deadlock). `mark_dirty` just invokes a boxed `update` callback (schedule scope re-render or wake a future). Memos add a `dirty: Arc<AtomicBool>` + recompute-on-read with PartialEq gate. No Check state, no topological anything — glitch-freedom is delegated to VirtualDom scheduling order (subtree re-render), i.e., much coarser granularity than alien-signals.

---

## 5. Floem's reactive crate: the leptos_reactive descendant that kept integer IDs (evidence FOR, simplified)

Source: [floem/reactive](https://github.com/lapce/floem/tree/main/reactive) (runtime.rs, id.rs, signal.rs, effect.rs, memo.rs); README credits "reactive primitives inspired by leptos_reactive."

- **Layout**: `Id(u64)` from a global `AtomicU64` counter — **monotonic, never recycled** (no generations needed; no ABA); node storage is `HashMap<Id, SignalState>` + `HashMap<Id, Rc<dyn EffectTrait>>` in a thread-local `Runtime`, plus `children: HashMap<Id, HashSet<Id>>` / `parents: HashMap<Id, Id>` for the scope tree. `SignalState = { id, value: enum{Sync(Arc<dyn Any+Send+Sync>), Local(Rc<dyn Any>)}, subscribers: Arc<Mutex<HashSet<Id>>> }`. So: hash maps everywhere instead of slotmap+secondary maps — simpler, more indirection, no insertion-order guarantee on subscriber iteration (they accept nondeterministic effect order, mitigated by sorting pending effects by `(priority, Id)` — Id order approximates creation order).
- **Algorithm**: push-only, eager. No Clean/Check/Dirty coloring at all: `set` → for each subscriber Id, `add_pending_effect` (dedup HashSet + SmallVec queue) → `run_pending_effects` sorts by `(Reverse(priority), id)` (two-level `EffectPriority::{High, Normal}`) and reruns each effect, which first disposes children scopes and unsubscribes from all previous sources (`observer_clean_up`), then re-tracks. **Memos are eager**: an effect that writes into a backing `RwSignal` guarded by `PartialEq` — exactly the pre-#637 leptos design, diamond glitches and all, deemed acceptable for a desktop UI toolkit.
- **Threading**: main runtime is UI-thread-only (enforced by `assert_ui_thread` panics); a separate `SYNC_RUNTIME` holds signals shared across threads, queues effect Ids and disposals from other threads, and pokes the UI event loop via a registered waker; disposal off-thread is bounced back to the UI thread (`SYNC_RUNTIME.enqueue_disposals`).

---

## 6. futures-signals (Pauan): no graph at all — the pull/poll counterexample

Sources: [rust-signals repo](https://github.com/Pauan/rust-signals), [docs.rs tutorial](https://docs.rs/futures-signals), src/signal/mutable.rs, src/internal.rs.

- **State layout**: `Mutable<A>` = `Arc<MutableState { senders: AtomicUsize, lock: RwLock<MutableLockState { value: A, signals: Vec<Weak<ChangedWaker>> }} }>`. Each *listener* (`MutableSignal`) owns an `Arc<ChangedWaker { changed: AtomicBool, waker: Mutex<Option<Waker>> }>`; the mutable holds only `Weak` refs to them. Write path: `set/replace/lock_mut(drop)` → `signals.retain(upgrade → wake(changed=true))` — sets each listener's changed flag, wakes its task waker, and prunes dead listeners in the same pass. Read path (`poll_change`): swap-and-clear the `changed` AtomicBool; if set, read the current value under the RwLock and yield it; if all `Mutable` senders dropped, yield `None` (stream end); else park the waker. (The "lock-free" reputation overstates it — flags are atomics but value+waker use RwLock/Mutex; README claims "zero-cost" in the sense of pay-for-what-you-use.)
- **The dependency graph is the type system.** There are no stored edges: derived signals are combinator structs (`map`, `map_ref!`, `switch`, `dedupe`, `filter_map`…) that **embed their upstream signal by value** and implement `poll_change` compositionally (see `MapRef1`/`PollResult { done, changed }` merging in internal.rs). The whole graph is monomorphized into one nested struct = one allocation for the entire pipeline, no per-edge bookkeeping, and "updates" are demand-driven future polls.
- **Semantics are deliberately lossy**: "`for_each`, `to_stream`, and *all* other `SignalExt` methods are *lossy*: they might skip changes… they only care about the *most recent value*" (lib.rs docs). This buys glitch-freedom-by-coalescing (diamonds collapse because the executor polls once per wake batch) at the cost of never seeing intermediate values — a fundamentally different contract from alien-signals. `MutableVec`/`MutableBTreeMap` compensate by sending granular diffs (`VecDiff`) instead of whole values.
- **Relevance**: proof that for push-notify/pull-compute with latest-value-only semantics, you can delete the entire Link data structure. Not directly portable to alien-signals' synchronous glitch-free memo semantics, but its *flag-per-subscriber + prune-on-notify Vec<Weak>* observer list is the minimal observer structure any design can be benchmarked against.

---

## 7. Comparison table

| System | Node storage | Edge storage | Handle | Dirty algorithm | Disposal |
|---|---|---|---|---|---|
| leptos 0.6 | central `SlotMap<NodeId, ReactiveNode>` (thread-local Runtime) | 2× `SecondaryMap<NodeId, RefCell<FxIndexSet<NodeId>>>` (int ids, order-preserving) | Copy NodeId (versioned index) | Reactively-style Clean/Check/Dirty(+DirtyMarked), lazy memos, iterative DFS w/ single-child fast path | ownership tree in side maps; manual `.dispose()` for nested; **leaks + dangling handles** |
| leptos 0.7 | per-node `Arc<RwLock<…>>` trait objects | `FxIndexSet<AnySource/AnySubscriber>` of `(usize, Weak<dyn …>)` fat pointers, both directions | `Arc*` types Clone; Copy `ArenaItem(NodeId)` → global `SlotMap<NodeId, Box<dyn Any>>` holding the Arc | Clean/Check/Dirty (Reactively-credited); signals clear subscriber set on notify; effects = async tasks woken by channel | refcounting + Owner tree of `Weak<OwnerInner>`; arena slot removal drops one Arc strong ref |
| sycamore 0.9 | central `SlotMap<NodeId, ReactiveNode>` — everything inline (AoS) | inline `Vec<NodeId>` dependents + `SmallVec<[NodeId;1]>` dependencies | Copy `(NodeId, &'static Root)` | eager: per-set DFS **topological sort** (Temp/Perm marks in-node) then rerun Dirty in topo order; 2-state Clean/Dirty | parent/children NodeIds in-node; recursive dispose; panics on stale handle accepted |
| dioxus | individually leaked cells + thread-local **free-list**, generation per cell | `Arc<Mutex<HashSet<ReactiveContext>>>` per signal; reverse: `HashSet<PointerHash<Arc<dyn SubscriberList>>>` | Copy `(&'static cell, NonZeroU64 gen)`; stale → `Err(Dropped)` | none (coarse): notify = `retain(mark_dirty)` → schedule scope/task; memos: AtomicBool dirty + PartialEq | flat `Owner{ owned: Vec }` recycles on Drop; gen bump invalidates handles |
| floem | `HashMap<Id, …>` maps, `Id` = monotonic AtomicU64 | `Arc<Mutex<HashSet<Id>>>` per signal (both directions via HashSets) | Copy `Id(u64)`, never reused | none: eager push, pending queue dedup + (priority, Id) sort; memos eager w/ PartialEq | children/parents HashMaps; recursive dispose; cross-thread disposal queued to UI thread |
| futures-signals | one `Arc<RwLock<…>>` per Mutable; combinators embed upstream by value | `Vec<Weak<ChangedWaker>>`, pruned on notify | `Clone` Arc handles | none: AtomicBool changed-flag per listener; poll latest value (lossy) | pure Rust Drop/refcounts |

---

## 8. Synthesis: what this means for alien-signals' SoA/typed-array rewrite

1. **The performance evidence favors the arena/index layout; the failures were all about *manual memory management*, which JS mostly doesn't have.** Leptos 0.7's retreat and Dioxus's generation checks exist because Copy integer handles in Rust are invisible to the borrow checker AND to any GC. In alien-signals today, a `Computed` unreachable from JS is collected, edges and all, by the GC. **If you move nodes/Links into typed arrays, you re-import the leptos 0.6 problem verbatim**: an index into a Float64Array/Int32Array pins its slot forever unless you build explicit disposal — and user-held handle objects that outlive their slot need either (a) leptos-0.6-style ownership scopes (alien-signals has none; it's a library, not a framework), (b) slot reuse + **generation counters** (slotmap keys / generational-box; cheap: pack index+generation in a 53-bit number or keep a parallel gen array), or (c) FinalizationRegistry-driven reclamation of slots when handle wrappers die (nondeterministic, but the only fully-automatic option). The leptos story is the strongest argument for keeping *values and callbacks* as ordinary GC'd objects and moving **only the Link/edge structure and hot scalar fields (flags, versions, depth)** into typed arrays — edges die with explicit `endTracking` bookkeeping already present in alien-signals, so they have deterministic lifetimes and are the safe part to arena-ize.
2. **Order-preserving edge removal is a real constraint.** Two independent codebases (leptos 0.6 `shift_remove` comment; reactive_graph `unsubscribe` comment) document that subscriber-notification order must match subscription order for nested-effect correctness. Alien-signals' doubly-linked Links do ordered O(1) removal; naive `Vec`+swap_remove ports lose the ordering, and shift_remove ports lose O(1). Options with typed arrays: keep the linked list but as index-typed `prevSub/nextSub/prevDep/nextDep` arrays (SoA linked list — preserves the algorithm exactly, replaces pointer-chasing objects with int32 loads), or per-node edge arrays with tombstones + periodic compaction.
3. **Sycamore shows inline SmallVec-style dependencies are viable**: `SmallVec<[NodeId;1]>` acknowledges most nodes have 1 dependency — matches alien-signals' single-Link fast paths; a typed-array port could reserve 1–2 inline edge slots per node before spilling to an overflow region.
4. **Algorithm lineage check**: leptos 0.5+/0.7 and alien-signals both descend from Reactively's Clean/Check/Dirty coloring, so leptos 0.6 is the closest existing "alien-signals on a slotmap" artifact — its `mark_dirty` stack-of-iterators traversal, DirtyMarked-as-visited-bit, and single-subscriber fast path are directly transplantable ideas. Sycamore's eager whole-subgraph topo-sort per set is the approach alien-signals already beats; floem/dioxus are coarser-grained and not algorithmically competitive for memo-heavy graphs.
5. **Locking/cloning overheads in leptos 0.7 are Rust-specific taxes** (RwLock per node, subscriber-set clones to avoid holding locks during user code, Weak upgrades per hop) that a single-threaded JS engine doesn't pay — so 0.7's design should NOT be read as "per-object graphs beat arenas"; it was never claimed to be faster than 0.6.
6. **Benchmark shapes worth stealing** (leptos benchmarks/src/reactive.rs): 1000-deep memo chain create/update, 1000→1 narrowing, 1→1000 fan-out, and *scope creation/disposal* — the last one is where arena designs win big (bulk free) and where per-object designs pay refcount churn; worth adding to the alien-signals benchmark matrix alongside the existing milomg/tb suites.

## Key source files (all verified)
- leptos 0.6: [ARCHITECTURE.md](https://github.com/leptos-rs/leptos/blob/v0.6.15/ARCHITECTURE.md) · [runtime.rs](https://github.com/leptos-rs/leptos/blob/v0.6.15/leptos_reactive/src/runtime.rs) · [node.rs](https://github.com/leptos-rs/leptos/blob/v0.6.15/leptos_reactive/src/node.rs) · [PR #637](https://github.com/leptos-rs/leptos/pull/637)
- leptos 0.7: [v0.7.0 release](https://github.com/leptos-rs/leptos/releases/tag/v0.7.0) · [discussion #2565](https://github.com/leptos-rs/leptos/discussions/2565) · [reactive_graph src](https://github.com/leptos-rs/leptos/tree/main/reactive_graph/src) (graph/{node,sets,source,subscriber}.rs, computed/inner.rs, signal/{arc_rw,subscriber_traits}.rs, effect/inner.rs, owner.rs, owner/{arena,arena_item,storage}.rs) · [docs.rs/reactive_graph](https://docs.rs/reactive_graph) · [book: life cycle appendix](https://book.leptos.dev/appendix_life_cycle.html) · [book: reactive graph appendix](https://book.leptos.dev/appendix_reactive_graph.html)
- sycamore: [PR #612](https://github.com/sycamore-rs/sycamore/pull/612) · [v0.9.0 announcement](https://sycamore.dev/post/announcing-v0-9-0) · [2022 primitives post](https://sycamore.dev/post/new-reactive-primitives) · [sycamore-reactive src](https://github.com/sycamore-rs/sycamore/tree/main/packages/sycamore-reactive/src) (root.rs, node.rs, signals.rs)
- dioxus: [generational-box](https://github.com/DioxusLabs/dioxus/tree/main/packages/generational-box) · [signals/src/signal.rs](https://github.com/DioxusLabs/dioxus/blob/main/packages/signals/src/signal.rs) · [core/src/reactive_context.rs](https://github.com/DioxusLabs/dioxus/blob/main/packages/core/src/reactive_context.rs)
- floem: [reactive crate](https://github.com/lapce/floem/tree/main/reactive) (runtime.rs, id.rs, signal.rs, effect.rs, memo.rs)
- futures-signals: [repo](https://github.com/Pauan/rust-signals) · [docs](https://docs.rs/futures-signals) (signal/mutable.rs, internal.rs, lib.rs "Signals are lossy")
- lineage: [Reactively](https://github.com/milomg/reactively) · [Milo's algorithm article](https://dev.to/modderme123/super-charging-fine-grained-reactive-performance-47ph)

Local clones for further inspection: /tmp/rust-reactive/{leptos-0.6, leptos-main, sycamore, dioxus, floem, rust-signals}

## Key links

- [leptos PR #637: new reactive system implementation](https://github.com/leptos-rs/leptos/pull/637) — Origin of leptos' slotmap Clean/Check/Dirty graph, explicitly modeled on Reactively — the closest existing 'alien-signals on an arena' artifact
- [leptos v0.7.0 release notes](https://github.com/leptos-rs/leptos/releases/tag/v0.7.0) — Documents exactly why the Copy arena was demoted: nested-signal memory leaks, fixed via ArcRwSignal refcounting
- [Leptos book: The Life Cycle of a Signal](https://book.leptos.dev/appendix_life_cycle.html) — Best prose explanation of arena-handle leak/dangle failure modes ('the number 3 you've copied everywhere can't be invalidated')
- [leptos 0.6 leptos_reactive/runtime.rs](https://github.com/leptos-rs/leptos/blob/v0.6.15/leptos_reactive/src/runtime.rs) — Full arena implementation: SlotMap + SecondaryMap edges, iterative mark_dirty with single-subscriber fast path, shift_remove ordering guarantee
- [reactive_graph source (leptos 0.7)](https://github.com/leptos-rs/leptos/tree/main/reactive_graph/src) — Arc/Weak trait-object graph, AnySource/AnySubscriber, thin ownership arena (ArenaItem), async effect scheduling
- [Sycamore PR #612: Reactivity v3](https://github.com/sycamore-rs/sycamore/pull/612) — Independent move TO a slotmap arena; author critiques leptos' manual .dispose() as error-prone and accepts panic-on-stale-handle tradeoff
- [sycamore-reactive root.rs](https://github.com/sycamore-rs/sycamore/blob/main/packages/sycamore-reactive/src/root.rs) — All-inline node table with Vec/SmallVec integer edges and eager DFS topological-sort propagation
- [Dioxus generational-box](https://github.com/DioxusLabs/dioxus/tree/main/packages/generational-box) — Generation-counter runtime lifetime checks over recycled leaked cells — the ABA-protection pattern a typed-array port needs for handle safety
- [futures-signals (Pauan/rust-signals)](https://github.com/Pauan/rust-signals) — Counterexample with zero stored graph: Vec<Weak<ChangedWaker>> observer lists, changed-flag + poll pull model, deliberately lossy semantics
- [Milo's Reactively algorithm article](https://dev.to/modderme123/super-charging-fine-grained-reactive-performance-47ph) — Shared algorithmic ancestor of both leptos and alien-signals; cited verbatim in reactive_graph's docs
- [floem reactive crate](https://github.com/lapce/floem/tree/main/reactive) — leptos_reactive descendant using monotonic u64 IDs + HashMaps, eager push with priority-sorted effect queue
