# Reactivity optimization research

Goal: find algorithmic and data-structure/data-layout changes that could beat
`alien-signals` (v3.2.1, the fastest conformant JS signals implementation) on
the standard benchmarks, or that trade differently in ways worth exploring.

Companion documents:
- [IDEAS.md](./IDEAS.md) — ten library designs to build (independent
  lineages, alien-equivalent semantics).
- [LIBRARIES.md](./LIBRARIES.md) — study guide to the libraries vendored
  as submodules under `vendor/` (anod deep-dive, lite-signal, reactively,
  Solid 2.0 `next`, Svelte 5, Preact Signals, cellx, signia).
- [sources/](./sources/) — six full research reports (alien-signals history,
  language ports, JS reactivity SOTA, incremental-computation academia,
  spreadsheet engines, data-oriented JS) with complete link indexes. This
  file is the synthesis; the reports carry the detail.
- Prior in-house work: `~/src/react-signals-fable-v2` — a signals library
  built 2026-07-02/03 whose `docs/design/DESIGN.md` §10.1–10.2 and
  `packages/benchmarks/src/spike/soa-core.ts` contain measured results that
  directly inform this project (§7 below).

---

## 1. How alien-signals works (v3.2.1)

Source: `upstream-alien-signals/src/system.ts` (algorithmic core, 262 lines)
and `src/index.ts` (public API layer, 441 lines).

### 1.1 Data structures

```ts
interface ReactiveNode {
  deps?: Link; depsTail?: Link;   // my dependency list (what I read)
  subs?: Link; subsTail?: Link;   // my subscriber list (who reads me)
  flags: ReactiveFlags;
}
interface Link {                  // one dependency edge, member of TWO lists
  version: number;                // cycle stamp — intra-run dedup only
  dep: ReactiveNode; sub: ReactiveNode;
  prevSub?: Link; nextSub?: Link; // position in dep.subs list
  prevDep?: Link; nextDep?: Link; // position in sub.deps list
}
```

Every edge is a `Link` participating simultaneously in the consumer's
doubly-linked *deps* list and the producer's doubly-linked *subs* list
(Preact's "quad-linked Node" refined). Double linking buys O(1) `unlink`.
One merged node type serves signals/computeds/effects/scopes. The API layer
subtypes it: signals carry **two value slots** (`pendingValue`/
`currentValue` — a write only marks Dirty; commit happens on next read, so
A→B→A write sequences recompute nothing); child effects are linked *as
dependencies of* their parent effect (drives hierarchical disposal and
outer-before-inner ordering). Public API = bound functions over the node.

### 1.2 Flags state machine

`Mutable=1, Watching=2, RecursedCheck=4, Recursed=8, Dirty=16, Pending=32`
(+ API-layer `HasChildEffect=64`). `Dirty` = definitely stale; `Pending` =
possibly stale, verify by pulling. `RecursedCheck`/`Recursed` govern
re-entrancy (writes inside the running consumer). Equivalent to Reactively's
clean/check/dirty coloring, MobX's UP_TO_DATE/POSSIBLY_STALE/STALE, TC39's
clean/checked/dirty, Salsa's red-green.

### 1.3 Algorithms

- **Write** → `propagate(subs)`: iterative DFS over subscriber lists with a
  heap-allocated `{value, prev}` cons stack (pushed only at nodes with ≥2
  subs). First visit marks `Pending` and `notify()`s watchers; already-
  marked nodes terminate descent (repeat writes are O(direct subs)).
  Effects queue into a flat array; `notify` walks up the parent-effect
  chain and reverses the inserted segment (outer-before-inner).
- **Read** → `computedOper`: `Dirty` → recompute; `Pending` →
  `checkDirty(deps)`: iterative DFS down dep lists **in recorded order**
  (same discipline rustc's try_mark_green requires for soundness with
  dynamic deps); recomputes a dep only when `Mutable|Dirty`; on confirmed
  value change (`!==`), `shallowPropagate` upgrades sibling `Pending` subs
  to `Dirty`. Nothing changed → clear `Pending`, no recompute (early
  cutoff).
- **Flush**: flat `queued` array, `batchDepth` gate, re-check per effect,
  error containment in `finally`.

### 1.4 The allocation story (why it's already fast)

- **Tail-cursor link reuse**: before re-run, `depsTail = undefined`; each
  read either matches the next existing link (stamp version, advance —
  zero allocation) or splices a new one; `purgeDeps` trims the remainder.
  Author-confirmed (issue #108): stable graphs hit the zero-alloc path 100%.
- **Intra-run dedup** via `Link.version === cycle` (added in 54fe1b3 for
  issue #81; dedups repeat reads without Sets).
- **No recursion, no Array/Set/Map** in the core (README constraints);
  benchmarked under `node --jitless` — interpreter-friendliness is an
  explicit goal.
- Rejected upstream experiments worth knowing: PR #95 removed
  `Link.version`+`Recursed`+`isValidLink` for a 5% microbench win — all of
  alien's own tests passed, but Vue's suite caught it. **The correctness
  envelope exceeds the local test suite**; any variant must run
  [reactive-framework-test-suite](https://github.com/johnsoncodehk/reactive-framework-test-suite)
  (180 cases; alien-signals is the only library passing all 180). Effect
  queue flip-flopped array↔linked-list across versions; array wins in JS,
  intrusive list wins ~20% in Dart AOT (issue #93) — data-structure choices
  are runtime-dependent.

### 1.5 Measured baseline costs (Node 24, macOS arm64, stock build)

| thing | heap cost |
|---|---|
| `Link` | **80 B** = 24 B header + 7×8 B fields (Node ships without pointer compression) |
| `signal()` | ~120 B (node + bound function) |
| `computed()` | ~246 B (node + bound fn + getter closure) |
| `effect()` | ~331 B (node + bound fn + closure + 1 link) |

Equivalent stride-8 `Int32Array` record: 32 B/link, GC-invisible, no write
barriers on splices. Upstream's own `memoryUsage.mjs` crashes in its tree
phase on v3.2.1 (`effect(() => last())` returns a number that `run()`
treats as a cleanup function) — fix before comparing.

### 1.6 Micro-experiments (this repo)

`research/experiments/layout-bench.mjs` (131k-link chains; "shuffled" =
scattered like a long-lived heap):

| experiment | result |
|---|---|
| truncate+refill 64-elem array ×1000 | `.length=` + push 0.200 ms vs `endIndex` overwrite **0.039 ms** (5×) |
| traverse, sequential layout | objects 0.156 / SoA-columns 0.068 / AoS-packed 0.129 ms |
| traverse, shuffled layout | objects 1.382 / SoA-columns 0.774 / AoS-packed 1.048 ms |
| allocate 131k links | objects 3.60 ms vs arena bump **0.36 ms** (10×, pre-GC) |

**Correction from workload-scale data**: my SoA-columns-beat-AoS result is
an artifact — the loop touches only 2 of 7 fields through hoisted bounds
checks. The in-house spike (§7) measured the opposite at workload scale:
naive parallel column arrays were **1.8× worse than objects** on deep
chains; **record interleaving** (whole record in one cache line, one
bounds-check domain) is where the wins are. Trust the spike numbers;
locality (9–11× swing sequential↔shuffled) and allocation (10×) remain the
governing effects either way.

### 1.7 Where the remaining time goes (vs benchmark shapes)

1. Pointer-chasing traversals over 80 B heap objects (deep chains stress
   `checkDirty`; broad fans stress `propagate` + subs walks).
2. `{value, prev}` stack cons **allocated during propagation** at branch
   points — the author-conceded weakness (issue #108): array-based `anod`
   beats alien by −37% time/−89% heap on wide dense updates; alien wins
   deep/diamond. "Linked lists favor deep propagation and O(1) unlink;
   arrays favor wide fan-out and lower allocation pressure."
3. Graph surgery on dynamic shapes (kairo unstable/dynamic): cursor misses
   → allocate + 4-pointer splices + dead-Link GC churn.
4. Property-probe type dispatch (`'getter' in node`) in update/unwatched.
5. No global quiet-fast-path: every read of a `Pending` node re-walks deps
   even when nothing anywhere has changed (Preact/Angular/Svelte all have
   one; Vue added `globalVersion` on top of its alien port).

### 1.8 The two benchmark suites (diverged — use milomg's)

| | `milomg-reactivity-benchmark` | `tb-reactivity-benchmark` |
|---|---|---|
| alien-signals | **3.1.2** (current) | **1.0.0-alpha.1** (two majors stale) |
| structure | monorepo: core/node/web (vite browser runner) | single package |
| frameworks | Angular 21, **@solidjs/signals 0.10 (Solid 2.0 core)**, pota, svelte 5.51, preact 2.8 | older set + signia, oby, molWire, kairo |
| correctness | vitest suite over adapters + pull-count asserts | pull-count asserts only |
| activity | active | last real change = alien 1.0-alpha bump |

The famous README chart comes from the **tb fork measuring v1**. Target
milomg's suite; adapters implement a tiny `ReactiveFramework` interface —
one file per prototype. **Methodology (hard-won in the sibling project)**:
same-process suite runs are order-biased and megamorphic — the first-run
framework's numbers improve up to 3× vs its own late-run numbers. Rank only
from **one-framework-per-process** runs. The harness reports fastest-of-N,
which hides GC costs — also record mean/p99 + GC time when comparing
arena designs. `dynamicBench` configs are named `nSources-width x layers -
dyn% - lazy%` and map directly onto per-idea predictions.

---

## 2. Ports of alien-signals (full report: `sources/-ports-of-alien-signals-*.md`)

**Nobody changed the algorithm — every serious port varies only allocation
and layout.** The interesting ones:

- **Rust, ohkami-rs/alien-signals-rs**: two global chunked bump arenas
  (1024-item chunks, stable addresses), raw `NonNull` handles; Link is
  exactly 7 machine words (compile-time asserted); values ≤16 B are
  memcpy'd inline (`SmallAny`), else `Rc<dyn Any>`. **Never reclaims** —
  open issue #24; reclamation is the hard part of arenas.
- **Rust, samara/signals**: the closest analog to an index-based TS
  rewrite — everything in two **slotmaps** (u32 index + u32 generation,
  dense Vec + free list, real `remove()`), unchecked indexing in release,
  one **persistent `Vec` as traversal scratch** (cleared per call, replaces
  alien's allocated cons stacks), cold data (cleanups/contexts) in
  side-maps off the hot node. **JIT-honest benchmarks** (M2 Pro, node 22):
  1×1 parity (39 vs 41 ns), 100×100 parity, 100×1000 → 2.8×, 1000×1000 →
  **6×**. V8's JIT'd object lists are at native speed until graph size
  makes GC + cache misses dominate — that's where layout work pays.
- **Dart, void_signals vs alien_signals port**: 5–15% macro wins purely
  from devirtualization and field placement (intrusive `nextEffect` on the
  base class, `final class`, raw int flag math) — same-algorithm layout
  tuning moves whole benchmarks.
- **Go**: GC structs, PGO shipped in-repo; survives 10k-deep graphs where
  recursive ports stack-overflow.
- **warp-core** (TS, SharedArrayBuffer Int32 arena, 8-word nodes/6-word
  links, Atomics futexes): toy-grade, no real algorithm — an existence
  proof that the layout is writable in TS, not prior art of quality.
- **Gap confirmed**: no port combines SoA/arena layout *with* the full v3
  algorithm. That combination is open territory (and is Idea 4).

## 3. JS reactivity SOTA (full report: `sources/-state-of-the-art-in-js-ts-*.md`)

Three edge-storage families across the field:

1. **Linked link-objects** (Preact quad-Node, Vue 3.5+, Angular *current*,
   alien-signals, Solid 2.0, cellx): O(1) splice, one allocation per edge
   reused indefinitely; pointer-chasing + object headers.
2. **Arrays with swap-remove slots** (Solid 1.x `sourceSlots`/
   `observerSlots`, S.js `nodeslots`): array locality, O(1) removal via
   mirror index arrays.
3. **Parallel arrays per consumer = SoA** (old Angular, live today as the
   **TC39 signal-polyfill**: `producerNode[]`, `producerLastReadVersion[]`,
   `producerIndexOfThis[]` + cursor): production precedent for array/SoA
   edges. Angular later migrated *back* to linked `ReactiveLink`s for
   cheaper reuse under dynamic deps — the tradeoff is not one-sided.

Mechanisms alien-signals lacks, proven elsewhere:

- **Global quiet fast paths**: Preact `globalVersion` (one compare skips
  everything), Angular `epoch`+`lastCleanEpoch`, Svelte global
  `write_version`/`read_version` (per-node `wv`/`rv` — resolves "check"
  state with one number per node, no per-edge versions; `rv` gives O(1)
  duplicate-read dedup), Solid 2.0 `clock`/`_time`.
- **Liveness split** (Angular's live vs poll-only consumers; Preact/Vue 3.5
  lazy subscription): reverse edges exist only where an effect is
  transitively watching; writes never walk unwatched subgraphs; unwatched
  computeds are GC-able with no unsubscribe API.
- **Height-keyed min-heap flush**: **Solid 2.0 ships it today**
  (`heap.ts`, dirtyQueue keyed on `_height`) — topological flush without
  recursive up-walks.
- **Re-traversal guards**: Svelte `WAS_MARKED`, MobX `lowestObserverState_`
  (per-node summary of observer states skips whole waves).
- **Inline first dep**: S.js `source1` (single-dep nodes allocate no
  arrays) — most nodes have degree 1.
- Vue 3.6 = alien-signals port + `globalVersion` fast path; its js-framework-
  benchmark score barely moved (author: the algorithm mostly "requires
  accurately identifying bottlenecks", i.e. reactivity is rarely the app
  bottleneck — the wins show in memory and pathological shapes, >30× on
  Vue 3.5's 1000-refs-1-computed cliff).

## 4. Incremental computation (full report: `sources/-incremental-computation-*.md`)

The Build-Systems-à-la-Carte frame: every system = **scheduler ×
rebuilder**. alien-signals ≈ *suspending* scheduler + dirty-bit-filtered
*verifying* rebuilder. The main alternatives:

- **Jane Street Incremental (V7)** — the data-structure goldmine:
  - **Recompute heap = array of intrusive doubly-linked lists indexed by
    height** + a monotone `height_lower_bound` scan pointer: O(1) push/pop,
    no comparisons, no allocation (heights only grow mid-stabilization).
    Perfect fit for `Int32Array` (`heads[height]`, `nextInHeap[]`).
  - **`can_recompute_now`**: single-parent (or parent-height ≤ min) nodes
    recompute immediately, bypassing the heap — chains skip all scheduling
    machinery; Jane Street tracks counters proving these paths dominate.
  - **Adjust-heights heap** fires only when an added edge violates
    `child.height < parent.height`; doubles as **cycle detection** (open
    alien-signals issue #123: cycles currently hang/OOM).
  - **Two stamps per node** (`changed_at` ≤ `recomputed_at`): edge
    staleness = one integer compare; "recomputed but equal" backdates.
  - Node layout: **`parent0` inline + spill array** for the ≥2 case;
    mirror index arrays for O(1) swap-removal; ~30 ns/node fire.
- **Salsa / rustc red-green**: pull-only verification in recorded execution
  order (alien's checkDirty is the same discipline); **durability** — a
  small vector of revisions by change-frequency class makes validation of
  stable subgraphs one compare (rust-analyzer: keystroke cost fell from
  ~300 ms of pure verification walks to ~0). rustc keeps validation
  metadata (fingerprints/colors) loadable *without* the cached values —
  hot/cold separation as a layout principle.
- **Adapton/miniAdapton**: demand-driven two-phase (dirty-marking stops at
  dirty nodes; compute drops old sub-edges first, re-checks dirtiness after
  compute). **Nominal Adapton** = keyed memoization (the theory behind
  keyed `mapArray`). The athunk record is alien's node in miniature.
- **Anchors (lord.io "How to Recalculate a Spreadsheet")** — the best
  comparative analysis of this space. Failure modes: Salsa wastes
  verification walks when unobserved inputs churn; Adapton wastes marking
  walks when hot inputs feed unobserved outputs; Incremental wastes
  necessity walks when the observed set toggles. Anchors runs **both
  algorithms on one graph** via a per-node three-state machine
  (necessary → Incremental height queue; clean → nothing; dirty → Adapton
  marking). alien-signals treats all nodes uniformly — state-splitting by
  observation status is an open upgrade.
- **Order-maintenance timestamps** (Acar '02) as the alternative to
  heights: O(1) maintenance under insertion, PQ keyed by timestamp gives
  from-scratch order. Fresh evidence this beats dirty-flag spine walking:
  **Spineless Traversal for Layout Invalidation (2024): mean 1.80× on
  83% of 2,216 browser-layout benchmarks**; also a 2025 incremental
  type-checker (275× vs from-scratch). Better than heights when graphs
  restructure often.
- **DBSP/differential dataflow**: incrementality over *collections*
  (Z-sets, `Q^Δ = D∘↑Q∘I`, work ∝ |delta|). When a "signal" is a big
  collection, node-graph recomputation is the wrong tool — the hybrid is
  delta-typed edges for collection combinators.
- **Parallel self-adjusting computation** (SPAA '21, SP/RSP trees):
  recording *where the graph is unordered* unlocks safe parallel
  propagation — future frontier.

## 5. Spreadsheet engines (full report: `sources/-spreadsheet-calculation-engines-*.md`)

- **Excel**: dependency trees + a **single linear calc chain** in
  last-known-good order; recalc walks the chain and **punts any cell whose
  precedent isn't computed yet down the chain** (multiple evaluations
  possible in pass 1); the chain **converges and is memoized** — steady
  state is a branch-predictable linear sweep, no traversal — and is even
  persisted to `calcChain.xml`. À-la-Carte calls this a *restarting*
  scheduler. Excel has **no equality cutoff** (alien is smarter there),
  and `ForceFullCalculation` exists because dependency maintenance can
  cost more than it saves. MTC partitions the chain into independent
  sections, adaptively re-partitioned from previous runs (~1.92× dual-core
  median).
- **HyperFormula** (production JS): numeric-id vertices,
  `edgesSparseArray: NodeId[][]`, partial iterative-Tarjan toposort seeded
  from dirty ids only; **ranges decompose as `A1:A100 = A1:A99 + A100`**
  (O(1) edges per SUM + incremental aggregate reuse); flagged their own
  `includes()` dedup as a bottleneck.
- **LibreOffice**: columnar typed-block cell storage (`double[]` slabs);
  **formula groups** — same-shape formulas share one compiled token array,
  inputs gathered **once** into contiguous buffers, evaluated as a
  data-parallel kernel (SIMD/OpenCL/threads; 3.4–5.5×) — and the killer
  detail: threading *without* shared input gathering was slower.
  Range listeners live in a **logarithmic spatial slot grid** (fine slots
  near the origin, doubling outward).
- **Grist**: **column-granularity nodes** with `Relation` objects mapping
  dirty rows → affected rows (millions of cell deps = one edge + O(1)
  translation); ordering via `OrderError` exception + explicit work stack
  (Excel's punt, implemented differently).
- **TACO (ICDE '23)**: compressed pattern edges `(prec-range, dep-range,
  pattern, offsets)` — RR/RF/FR/FF patterns; Enron 23.7M edges → 1.2M
  (5%); dependent queries up to 34,972× faster than adjacency lists, 632×
  faster than Excel. The general lesson: **structured fan-out should be
  one summary edge, not N links**.
- **IronCalc**: no graph at all — memoized demand-driven full recompute
  (Evaluating/Evaluated marks). A useful "know when not to track"
  baseline.

## 6. Data-oriented JS (full report: `sources/-data-oriented-design-in-javascript-*.md`)

- **Closest published prior art**: the source-map optimization (mraleph) —
  100k+ small graph-record objects → one `Int32Array`, 6 slots per record,
  plus monomorphization: **4.2× total**. Structurally identical to Links.
- **V8 cost model**: object = 3-word header + tagged fields; polymorphic
  IC threshold ~4 shapes, megamorphic = global hash per access;
  `PACKED→HOLEY` transitions are permanent; Smi fields overflow at 2^30
  (a global epoch counter in an object field flips the field to Double —
  the React `performance.now()` cliff; in a Uint32Array it's just 4
  bytes); **write barriers fire on every heap-pointer store** — link-list
  splicing is 4–6 barriered stores, while typed-array stores have none.
- **GC**: scavenger cost ∝ *survivors*, so short-lived garbage is nearly
  free, but a persistent dependency graph means Links get promoted and
  then churn old space; **naive object pooling backfires** (old→new
  remembered-set traffic, defeats die-young economics). The SoA move
  deletes the problem class rather than managing it.
- **ECS libraries** (bitECS/wolf-ecs/piecs): the mechanical toolkit —
  dense/sparse sets with swap-remove, generation bits packed in u32
  handles, fixed-capacity SoA columns; ~2× iteration over object ECS.
- **Growth**: resizable ArrayBuffers carry a per-access penalty (distinct
  hidden class + generalized bounds check) — prefer fixed buffers +
  explicit doubling, or segmented chunk tables; **const bindings only**
  (see §7).
- **WASM core rejected with evidence**: ~100 ns/call boundary × per-read
  calls + values can't cross without externref bookkeeping; AssemblyScript
  with GC ran 80× slower on allocation-heavy work. Layout wins are
  available *inside* JS.

## 7. In-house prior art: react-signals-fable-v2 (2026-07-02/03)

`~/src/react-signals-fable-v2/docs/design/DESIGN.md` §10; spike at
`packages/benchmarks/src/spike/soa-core.ts`. Findings (measured, this
machine):

1. **Field ranking** (isolated per-process): alien-1.0-alpha ~1.6× ahead
   of the field (the "featurelessness dividend" — never-read computeds
   cost it nothing), @reactively #2 (two-phase marking wins partially-read
   dynamic graphs), alien-v3 #3. Everything else (Preact, Solid, Vue,
   MobX, Svelte, Angular) 2–4× behind.
2. **DoD spike** (stride-8 interleaved Int32Array records, alien-minimal
   semantics): **beats alien SOURCE on every isolated shape** — creation
   6× (22.8 vs 139 ms), unread-write throughput 1.6×, deep-chain par,
   cellx 0.9×. Proven gotchas:
   - naive **parallel column arrays lose** (deep chain 1.8× worse than
     objects) — record interleaving is where the wins come from;
   - **buffers must be const bindings** (growth by reassignment = 2× on
     every hot path; production needs segmented buffers);
   - **type-segregated value columns rejected** (Float64Array+tag worse
     than one packed `unknown[]`);
   - spike node records have 3 spare slots (stride 8, 5 used) — room for
     inline edges/height/etc.
3. **The headline caveat**: shape-level supremacy did **not** transfer to
   suite scale (spike total 3854 vs object core 2815) — cross-suite state
   accumulation, no reclamation, one shared heap region. Suite-level
   integration (lifecycle, arenas, growth) is its own engineering problem.
4. **Conformance gap**: the spike over-recomputes up to 20% on dynamic
   suites (missing alien's exact re-run trimming) — the full checkDirty
   subtlety is load-bearing for both correctness and honest benchmarks.
5. Optimization ledger for object cores: per-eval `array.length = 0`
   truncation was **~60% of deep-chain time** (replaced by a validity
   boolean); lazy recording arrays; frameless fast paths. Rejected as
   no-ops: frame pooling, getter micro-ordering.

## 7a. Gap reports (second research wave)

Four follow-up reports in `sources/gap-*.md`; what changed our picture:

- **FRP scheduling literature** (`gap-frp-scheduling.md`): the strongest
  *counter-evidence* to height/level scheduling — FrTime paid PQ re-keying
  under dynamic edges, Scala.React paid level-mismatch abort-hoist-retry,
  and Garnet/Amulet (TOPLAS 2001) found mark-and-sweep "generally
  outperforms" topological sorting. Since Solid 2.0 ships heights and
  Spineless (2024) shows OM-PQ winning, the literature is genuinely split
  → build-and-measure, don't assume. New techniques: **runtime
  linear-chain fusion** (Lowering PEPM '07: 2.8–78× on real programs,
  16,000× micro; Flapjax did it dynamically; *no TS signals library has
  ever adopted it*) with the documented §3.9 pathology — fusion deletes
  intermediate equality-cutoff points, so only fuse single-subscriber
  unwatched intermediates whose cutoff never fires; **constant/dead-region
  elimination** (no Mutable ancestor → snapshot + unlink); **SID-UP
  source-ID bitmask** skip-filters for propagate/checkDirty.
- **Rust UI graphs** (`gap-rust-ui-reactivity.md`, leptos now vendored):
  Leptos 0.7's famous retreat from the 0.6 slotmap arena to Arc'd nodes
  was driven by **manual-memory leaks (nested signal collections) and
  Send/Sync — never performance** (no perf claim exists; 0.7 pays weak
  fat-pointer upgrades + RwLocks + set clones per hop). Under a GC with
  closure-wrapped handles, those failure modes mostly vanish — but they
  return verbatim if *values* move into arenas. Rule confirmed: arena-ize
  edges + hot scalars (deterministic lifetimes), keep values/closures
  GC'd. Sycamore 0.9 independently moved *to* a slotmap arena with
  `SmallVec<[NodeId;1]>` inline deps. **Order-preserving edge removal is
  a documented correctness constraint** in two codebases (nested-effect
  ordering) — tombstones preserve order, swap-remove doesn't. New
  benchmark shape to adopt: scope create/dispose (arena bulk-free wins,
  refcount designs pay churn).
- **Skip/SKStore + Noria** (`gap-skip-noria.md`): creation-order Time as
  a free topological priority (valid only when construction order is
  constrained — Skip enforces it structurally); **hierarchical version
  stamps** (subtree-max summaries prune clean regions during pull
  validation — the tree generalization of per-link versions);
  flat-sorted-array + small delta overlay + periodic flatten as the
  churn-tolerant layout; eviction economics (Noria: fully-evicted state
  *increased* write throughput 4× because pushes into cold state are
  dropped — the database-scale argument for liveness splitting).
- **Parallel propagation** (`gap-parallel-propagation.md`): don't
  parallelize single waves (break-even ~10⁴ nodes/wave vs 5.5 µs worker
  wake); values can't cross threads, so parallelism = worker-owned
  partitions with SAB flags/versions bridging (Atomics.or mark +
  waitAsync wake); FrameSweep's strict cross-thread consistency costs
  20–25% single-thread tax. Recommendation matches our plan: SoA layout
  first (SAB-compat comes free), threads later if ever.

## 8. Research frontiers (open questions worth prototyping)

1. **Interleaved-record arena + full v3 conformance** — unclaimed
   territory (§2 gap, §7 spike): does the 6× creation / 1.6× write-path
   win survive reclamation, segmented growth, and exact re-run trimming?
2. **Liveness/observation state-splitting** (Angular live-set + Anchors
   tri-state): can a feature-complete library buy alpha's featurelessness
   dividend back for the lazy region?
3. **Scheduling without verification walks**: height buckets (Incremental
   V7 / Solid 2.0) vs order-maintenance timestamps (Spineless 2024) vs
   Excel's learned calc chain — three ways to make steady-state flushes
   linear scans; none has been tried in a mainstream JS signals core
   except Solid 2.0's heap.
4. **Summary edges for structured fan-out** (TACO/Grist/HyperFormula):
   collection primitives (`mapArray`, selectors, stores) that carry one
   relation edge instead of N links.
5. **Durability lanes** (Salsa): near-free O(1) validation for
   rarely-changing subgraphs on top of any version-counter design.
6. **Global quiet-epoch fast path** (Preact/Angular/Svelte/Vue-3.6): the
   cheapest known win absent from alien-signals core.
7. **Cycle detection for free** via adjust-heights (fixes upstream #123).
8. Parallelism (SP-trees, Excel MTC chain partitioning, SharedArrayBuffer
   arenas) — real but further out.

Anti-frontiers (evidence says don't): WASM core (§6); type-segregated
value columns (§7); naive per-field SoA (§7); object pooling of links
(§6 GC economics); removing the version/Recursed/isValidLink machinery
(upstream PR #95).
