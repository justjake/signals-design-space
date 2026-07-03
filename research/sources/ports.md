# Ports of alien-signals to other languages: data-structure adaptations

Research scope: every port listed in the [alien-signals README "Other Language Implementations"](https://github.com/stackblitz/alien-signals#other-language-implementations) plus GitHub-wide searches for `alien-signals` / `alien_signals`. All repos were shallow-cloned and source-inspected (clones under `/tmp/alien-ports/`). **No Swift, Kotlin, Zig, Python, or C++ ports exist** as of 2026-07 (searched GitHub repo + code search; `alien-sh/signals` in C++ is unrelated Unix-signal code).

Benchmark caveat that matters for every cross-language claim below: upstream's own bench script (`upstream-alien-signals/package.json`) runs `node --jitless --expose-gc benchs/propagate.mjs`. Ports that reused that script (ohkami-rs) compared against a JIT-disabled V8; ports that dropped `--jitless` (samara) show V8 in a *much* better light.

---

## 1. Rust: [ohkami-rs/alien-signals-rs](https://github.com/ohkami-rs/alien-signals-rs) — chunked bump arena + raw pointers

Crate [`alien-signals` on crates.io](https://crates.io/crates/alien-signals) ([docs.rs](https://docs.rs/alien-signals/latest/alien_signals/)), v0.1.4, faithful port of the v3 algorithm (same flags, cycle/version link dedup, iterative propagate/checkDirty).

**Memory layout** ([src/node.rs](https://github.com/ohkami-rs/alien-signals-rs/blob/main/src/node.rs), [src/primitive.rs](https://github.com/ohkami-rs/alien-signals-rs/blob/main/src/primitive.rs)):
- Two **global static `ChunkedArena<T, 1024>`** bump allocators — one for links, one for nodes. Each chunk is a `Box<[MaybeUninit<T>; 1024]>`; `alloc` writes into the next free slot and returns `NonNull<T>`. Chunks are never moved, so raw pointers stay stable (no index indirection at all).
- `LinkFields` is exactly **7 machine words** (compile-time asserted): `version: usize, dep, sub, prev_sub, next_sub, prev_dep, next_dep`. `NodeFields` is exactly **6 words**: `flags (u8, padded), deps, deps_tail, subs, subs_tail, context: Box<NodeContext>`.
- Handles `Link` / `Node<C>` are `Copy` wrappers around `NonNull` — 1 word each, `Option<Link>` is also 1 word via null-pointer niche. All field access is raw `unsafe { (*ptr).field }`, single-threaded by decree (`unsafe impl Sync` on the static arena).
- Node payloads are a boxed enum `NodeContext { Signal | Computed | Effect | None }`; node kind is dispatched by matching this enum, with `Node<SignalContext>`-style phantom-typed handles for the public API.
- **Value storage: `SmallAny`** — values with `size ≤ 16 bytes && !needs_drop` are memcpy'd into an inline `[u8; 16]`; everything else goes in `Rc<dyn Any>`. Equality and getters are type-erased `Box<dyn Fn>` closures that `downcast_ref_unchecked`.
- Flags are a `u8` newtype (6 flags fit easily).

**Notable algorithmic detail**: `notify()` avoids allocating the chain by pushing the effect chain directly onto the global `VecDeque` queue and then **reversing the newly-pushed slice in place** (`q.as_slice_mut()[chain_head_index..].reverse()`).

**Known weakness — no reclamation**: the bump arena never frees; unlinked Links and disposed nodes leak forever. Tracked in open issue [#24 "Reuse arena slots for unused nodes"](https://github.com/ohkami-rs/alien-signals-rs/issues/24). Also interesting: [#15](https://github.com/ohkami-rs/alien-signals-rs/pull/15) fixed a stacked-borrows (Miri) violation in the arena, [#18](https://github.com/ohkami-rs/alien-signals-rs/issues/18) (multi-thread) and [#19](https://github.com/ohkami-rs/alien-signals-rs/issues/19) (no_std) are open.

**Benchmarks** (README, i7-1280P): Rust ~78ns vs Node-**jitless** ~832ns for `propagate 1×1`; 350µs vs 3.01ms at 100×100 (~8-10x). Misleading vs real V8 — see samara below.

## 2. Rust: [wuzekang/samara `crates/signals`](https://github.com/wuzekang/samara/tree/main/crates/signals) — generational slotmap + u64 keys

The closest existing analog to an index-based TS rewrite. Faithful v3 algorithm, but **everything lives in two [slotmap](https://docs.rs/slotmap) `SlotMap`s** owned by a single `ReactiveSystem` struct ([src/system.rs](https://github.com/wuzekang/samara/blob/main/crates/signals/src/system.rs)):

```rust
pub struct ReactiveSystem {
    cycle, batch_depth, notify_index, queued_length: usize,
    queued: Vec<NodeKey>,      // effect queue, reused
    stack: Vec<LinkKey>,       // traversal scratch, reused across propagate/check_dirty
    nodes: UnsafeSlotMap<NodeKey, ReactiveNode>,
    links: UnsafeSlotMap<LinkKey, Link>,
    cleanups / contexts: SparseSecondaryMap<NodeKey, …>,  // cold data OUT of the hot node
}
```

- `NodeKey`/`LinkKey` are slotmap keys: **32-bit index + 32-bit generation** packed in a u64; storage is a dense `Vec` with a built-in free list, so **removed links' slots are reused** (contrast with ohkami's leak). `unlink()` does `links.remove(key)` — real reclamation.
- `UnsafeSlotMap` ([src/types/slotmap.rs](https://github.com/wuzekang/samara/blob/main/crates/signals/src/types/slotmap.rs)) overrides `Index` to use `get_unchecked` — skipping both bounds and generation checks in the hot path; generation checks are effectively debug-only.
- `Link` = `{version: usize, dep: NodeKey, sub: NodeKey, prev_sub/next_sub/prev_dep/next_dep: Option<LinkKey>}` ([src/types.rs](https://github.com/wuzekang/samara/blob/main/crates/signals/src/types.rs)). `ReactiveNode` = alien-signals' 4 list heads (`deps/deps_tail/subs/subs_tail`) **plus** an intrusive ownership tree `parent/child/next/prev: Option<NodeKey>` for effect scopes, flags, a `NodeInner` enum (`Signal(*mut dyn Any + borrow-state Cell)` / `Computed(Rc<RefCell<dyn ComputedOps>>)` / `Effect(Rc<RefCell<dyn FnMut()>>)`), and a debug caller `Location`.
- Traversal scratch: instead of alien-signals' allocated one-way-link stacks, propagate/checkDirty use the **single persistent `stack: Vec<LinkKey>`, `.clear()`ed per call** ([src/system/propagation.rs](https://github.com/wuzekang/samara/blob/main/crates/signals/src/system/propagation.rs)). `notify()` uses the same push-then-swap-reverse-in-place trick on the persistent `queued` Vec.
- Whole graph is serde-Serializable (nice devtools side effect of centralizing state).

**Benchmarks** ([README](https://github.com/wuzekang/samara/blob/main/crates/signals/README.md), Apple M2 Pro, node 22 **with JIT**) — the most honest TS-vs-native numbers found anywhere:

| propagate | TS (JIT) | Rust slotmap |
|---|---|---|
| 1×1 | 41.1 ns | 39.3 ns (parity) |
| 100×100 | 245 µs | 252 µs (parity) |
| 100×1000 | 6.35 ms | 2.25 ms (2.8x) |
| 1000×1000 | 137.8 ms | 23.1 ms (**6x**) |

Takeaway for the TS work: V8's JIT'd GC-object linked lists are already at native speed for small/medium graphs; the arena layout only pulls decisively ahead at large graph sizes where GC pressure and cache misses dominate. That's where a typed-array/SoA TS layout should be expected to pay off too — and where it should be benchmarked.

## 3. Go: [delaneyj/alien-signals-go](https://github.com/delaneyj/alien-signals-go) — GC pointers, PGO, generics-embedded values

Port of the **v1-era** algorithm (flags `Computed/Effect/Tracking/Notified/Recursed/Dirty/PendingComputed/PendingEffect`, `link` has no `prevDep`, no version counters). Data structures ([types.go](https://github.com/delaneyj/alien-signals-go/blob/main/types.go), [signals.go](https://github.com/delaneyj/alien-signals-go/blob/main/signals.go)):
- Plain GC heap structs with pointers; **one unified `signal` struct** for all node kinds (`ref interface{}` back-pointer to the typed wrapper); `WriteableSignal[T comparable]` **embeds** the `signal` struct so node header + typed value are a single allocation (value `T` inline, no boxing).
- `flags` is `uint16`; effect queue is a hand-monomorphized singly-linked `OneWayLink_signal`; explicit `ReactiveSystem` receiver instead of globals; pause/resume tracking via a `[]*signal` stack.
- Ships a `default.pgo` profile in the repo root — Go's profile-guided optimization is auto-applied at build.
- README benchmarks: Go is ~1.5-2.6x *slower* than JIT'd Node at small sizes (1×1: 125ns vs 48.6ns), roughly at parity mid-scale, and **survives 10000-wide/deep cases where the old recursive Node version dies with "Maximum call stack size exceeded"**. Explicitly not thread-safe.

## 4. C#: two ports, opposite layout philosophies

- [CTRL-Neo-Studios/csharp-alien-signals](https://github.com/CTRL-Neo-Studios/csharp-alien-signals) (v2-era flags): `Link` and nodes are classes accessed **through interfaces** (`ILink`, `IReactiveNode`) with auto-properties — adds interface dispatch + property call overhead on every pointer hop; structured for Unity ergonomics, not speed.
- [hbtweb/alien-signals-cs](https://github.com/hbtweb/alien-signals-cs) (3.1.2 port): `sealed class Link` / `class ReactiveNode` with **public mutable fields** and an explicit comment: *"Fields are public and mutable: the algorithm reads and writes them directly, so accessor encapsulation would only add cost."* Same 7-field Link (`Version,Dep,Sub,PrevSub,NextSub,PrevDep,NextDep`). Neither C# port uses structs/arrays — both stay pointer-chasing GC objects.

## 5. Java: [CTRL-Neo-Studios/java-alien-signals](https://github.com/CTRL-Neo-Studios/java-alien-signals) (v1-era, public-field POJOs + `Dependency`/`Subscriber` interfaces) and [hbtweb/alien-signals-java](https://github.com/hbtweb/alien-signals-java) (3.1.2). Straight object ports, nothing layout-novel. [hbtweb/alien-signals-php](https://github.com/hbtweb/alien-signals-php) likewise.

## 6. Dart: the most instructive managed-runtime tuning

- [medz/alien-signals-dart](https://github.com/medz/alien-signals-dart) (`alien_signals` on pub.dev, faithful v3): flags are an **`extension type ReactiveFlags._(int)`** — a zero-cost compile-time-only wrapper over int; `final class Link` (devirtualized); aggressive `@pragma('vm:prefer-inline')` / `dart2js:tryInline` / `wasm:prefer-inline` on every hot function; effect queue is an **intrusive linked list** (`nextEffect` field) rather than upstream TS's array queue.
- [void-signals/void_signals](https://github.com/void-signals/void_signals): a tuned v3 rewrite that **beats the alien_signals Dart port in 26 of ~30 benchmarks by ~5-15%** ([auto-generated benchmark report](https://github.com/void-signals/void_signals/blob/main/benchmark/bench/BENCHMARK_REPORT.md), e.g. broadPropagation 215ms vs 244ms, cellx2500 16.4ms vs 19.3ms; also beats state_beacon, preact_signals, mobx, solidart ports). The deltas come from micro-layout: `nextEffect` **hoisted into the base `ReactiveNode` class "to avoid type checks"** (monomorphic field access instead of downcast), `final class` everywhere, `@pragma('vm:align-loops')` on the flush loop, raw int flag math (`flags &= -3`), Link with `final dep/sub` + mutable `version` and 4 sibling pointers — i.e., even within the same algorithm, field placement and devirtualization move macro-benchmarks 5-15%.
- [vowdemon/jolt](https://github.com/vowdemon/jolt) builds *on* alien_signals rather than porting it.

## 7. Lua family

- [Nicell/alien-signals-luau](https://github.com/Nicell/alien-signals-luau) (v1-era): nodes/links are plain tables; effect queue is an **array (`notifyBuffer`) with running index** instead of a linked list; Luau native bitwise ops for flags.
- [YanqingXu/alien-signals-in-lua](https://github.com/YanqingXu/alien-signals-in-lua) (tracks v3.2.1): pure-Lua port that needs a `bit.lua` **arithmetic shim** (`a * 2^n`, `math.floor(a / 2^n)`) where bitwise ops are unavailable — a reminder that flag bit-ops sit on the hottest path. Includes a `refactored/` modular split (graph.lua = link-list ops, scheduler.lua = batching/queue, engine.lua = propagate/dirty-check) and uses a **weak-key table mapping user closures → nodes** for `isSignal`-style brand checks.
- [xuhuanzy/alien-signals-lua](https://github.com/xuhuanzy/alien-signals-lua): Lua 5.4 (native integers + bitwise operators), EmmyLua-typed, faithful.

## 8. Adjacent: [VrilLabs/warp-core](https://github.com/VrilLabs/warp-core) — SharedArrayBuffer flat arena in TypeScript

Not a port (self-described "designed to supersede Alien Signals"; toy-grade, 0 stars, Int32-only values, no real dirty-propagation algorithm — treat as an existence proof, not prior art of quality). Its layout ([src/signal-arena.ts](https://github.com/VrilLabs/warp-core/blob/main/src/signal-arena.ts)) is nonetheless a concrete sketch of the direction you're exploring:
- One `SharedArrayBuffer` viewed as `Int32Array`; **node = 8×Int32** (`flags, version, value_lo, value_hi, dep_head, sub_head, effect_q, owner_tid`), **link = 6×Int32**; field access is `view[nodeOffset + F_FLAGS]`-style constant offsets.
- Bump allocation via `Atomics.add` on word 0 (no free list); per-node **version word doubles as the futex** for `Atomics.notify` / `Atomics.waitAsync` cross-thread wakeups; per-node spinlock via CAS on `owner_tid`.

---

## Cross-cutting lessons for the TS optimization work

1. **Nobody changed the algorithm.** Every serious port keeps alien-signals' doubly-linked Link lists, flags, and version/cycle dedup verbatim; all variation is in allocation and layout. The two Rust ports prove the algorithm maps cleanly onto both (a) stable-pointer bump arenas and (b) index-based generational arenas with head/tail indices per node — so an `Int32Array`-backed Link pool in TS (fields at fixed offsets, `-1` as null, free list threaded through a dead field, exactly like slotmap) is a proven-shape refactor.
2. **Samara's JIT-honest numbers bound the upside**: parity with Rust at ≤100×100, ~3-6x at 10^5-10^6 links. Expect SoA typed-array wins in TS to show up mainly on large graphs / allocation-heavy phases (link churn, `cellx`, broadPropagation), not microbenchmarks.
3. **Reclamation is the hard part of arenas** — ohkami's open issue #24 (slots never reused) vs samara's slotmap free-list `remove()`. A TS typed-array port must thread a free list through dead link slots or it will strictly regress memory vs GC.
4. **Reusable scratch buffers**: samara replaces alien-signals' per-traversal `{value, prev}` stack allocations with one persistent `Vec` cleared per call; both Rust ports replace the notify chain allocation with *push onto the queue array, then reverse the pushed slice in place*. Both tricks port directly to TS today, independent of any arena work.
5. **Intrusive beats external queue in managed runtimes**: both Dart ports switched the effect queue to an intrusive `nextEffect` field on the node (void_signals deliberately put it on the base class for monomorphic access) and void_signals' 5-15% macro wins over an already-faithful port came purely from such devirtualization/field-placement tweaks — the same class-shape/monomorphism discipline applies to V8 hidden classes.
6. **Inline small values**: ohkami's 16-byte `SmallAny` and Go's generics-embedded `value T` keep the value in the node allocation. The SoA analog is a parallel `Float64Array`/values array indexed by node id for numeric signals.
7. **Nothing exotic remains unexplored**: no port has tried SoA-with-typed-arrays *plus* the full v3 algorithm — warp-core has the layout without the algorithm; samara has the algorithm with an AoS arena. Combining them in TS is genuinely new territory.

Local clones for further digging: `/tmp/alien-ports/{alien-signals-rs,samara,alien-signals-go,csharp-alien-signals,java-alien-signals,alien-signals-dart,alien-signals-luau,alien-signals-in-lua,void_signals,warp-core,alien-signals-cs,alien-signals-lua}`.

## Key links

- [ohkami-rs/alien-signals-rs — src/node.rs](https://github.com/ohkami-rs/alien-signals-rs/blob/main/src/node.rs) — Chunked bump arena + raw-pointer handles; exact 7-word Link / 6-word Node layout with compile-time size asserts
- [ohkami-rs/alien-signals-rs — src/primitive.rs](https://github.com/ohkami-rs/alien-signals-rs/blob/main/src/primitive.rs) — ChunkedArena<T,1024> bump allocator and SmallAny 16-byte inline value storage
- [ohkami-rs issue #24: Reuse arena slots for unused nodes](https://github.com/ohkami-rs/alien-signals-rs/issues/24) — Open admission that the bump arena leaks — reclamation is the hard part of arena ports
- [wuzekang/samara signals crate](https://github.com/wuzekang/samara/tree/main/crates/signals) — Slotmap (u32 index + u32 generation) port with unchecked indexing — the closest analog to an index-based TS rewrite
- [samara signals README benchmarks](https://github.com/wuzekang/samara/blob/main/crates/signals/README.md) — JIT-honest TS vs Rust numbers: parity at ≤100×100, 6x Rust win at 1000×1000 — bounds the expected upside of arena layouts
- [samara — system/propagation.rs](https://github.com/wuzekang/samara/blob/main/crates/signals/src/system/propagation.rs) — v3 propagate/checkDirty rewritten over slotmap keys with one persistent reusable Vec as traversal stack
- [samara — types/slotmap.rs (UnsafeSlotMap)](https://github.com/wuzekang/samara/blob/main/crates/signals/src/types/slotmap.rs) — get_unchecked Index impl: generation/bounds checks stripped from the hot path in release
- [delaneyj/alien-signals-go](https://github.com/delaneyj/alien-signals-go) — GC-pointer port with generics-embedded values, ships default.pgo; benchmarks show Go slower than JIT'd Node at small scale but immune to stack overflow
- [void-signals/void_signals benchmark report](https://github.com/void-signals/void_signals/blob/main/benchmark/bench/BENCHMARK_REPORT.md) — Shows 5-15% macro wins over a faithful port purely from devirtualization + intrusive-queue field placement
- [medz/alien-signals-dart](https://github.com/medz/alien-signals-dart) — Zero-cost extension-type flags, final classes, inline pragmas, intrusive nextEffect queue
- [hbtweb/alien-signals-cs — Link.cs](https://github.com/hbtweb/alien-signals-cs/blob/main/src/AlienSignals/Link.cs) — Public-mutable-field sealed classes with explicit anti-encapsulation performance rationale
- [VrilLabs/warp-core — signal-arena.ts](https://github.com/VrilLabs/warp-core/blob/main/src/signal-arena.ts) — SharedArrayBuffer Int32 arena in TS: 8-word nodes, 6-word links, bump alloc, version-word futex (toy-grade but concrete SoA sketch)
- [stackblitz/alien-signals README — ports list](https://github.com/stackblitz/alien-signals#other-language-implementations) — Canonical list of community ports; also note its bench script uses node --jitless, which skews cross-language comparisons
