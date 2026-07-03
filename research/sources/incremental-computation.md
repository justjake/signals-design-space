# Incremental Computation: Academic & Systems State of the Art — Research Report

Research target: ideas transferable to **alien-signals** (push-pull TypeScript signals; doubly-linked `Link` lists between nodes; version counters; flag-based dirty propagation).

---

## 1. Umut Acar's Self-Adjusting Computation (SAC)

**Sources:** [Adaptive Functional Programming (POPL '02, PDF)](https://www.cs.cmu.edu/~guyb/papers/popl02.pdf) · [Acar's thesis, CMU-CS-05-129 (PDF)](https://www.cs.cmu.edu/~rwh/students/acar.pdf) · [umut-acar.org/self-adjusting-computation](https://www.umut-acar.org/self-adjusting-computation) · [Imperative Self-Adjusting Computation (PDF)](https://home.ttic.edu/~amal/papers/impselfadj.pdf) · [Experimental analysis of SAC (TOPLAS)](https://dl.acm.org/doi/10.1145/1596527.1596530)

### Core machinery (grounded in the POPL '02 paper)
- Programs read/write **modifiables** (mutable ref cells). Every `read` is recorded as an edge in a **Dynamic Dependence Graph (DDG)**: data dependencies (which reads observed which modifiable) *plus control dependencies* (which reads are nested inside which).
- Every read gets a **timestamp interval** (start/end) in a *total order of execution*, maintained by a **Dietz–Sleator order-maintenance structure** (O(1) amortized insert-after, O(1) compare). This is the critical trick: it gives a topological/temporal order that survives *dynamic* graph changes, which plain heights or allocation-order integers do not.
- **Change propagation:** when modifiables change, all affected reads go into a **priority queue ordered by start timestamp**. Pop the earliest read, re-execute it; re-execution **discards the old trace interval** between the read's timestamps — any queued reads whose timestamps fall inside that interval are simply deleted from the queue (they belonged to dead computation). This is how SAC handles what signals libraries call "dynamic dependencies" / conditional branches without glitches.
- Later work (the thesis, DeltaML) adds **computation memoization + trace stability**: re-execution can *splice back in* matching sub-traces from the old run instead of rebuilding them, so an insertion into the middle of a list only pays for the delta. "Trace stability" is the formal metric: cost of update ≈ edit distance between old and new traces.
- **Traceable data types** ([SIGPLAN](https://dl.acm.org/doi/abs/10.1145/1809028.1806650)) coarsen dependency tracking from individual cell reads to abstract-data-type operations (queue, priority queue ops), shrinking the trace dramatically.

### CEAL / DeltaML numbers
[CEAL: a C-based language for SAC (PLDI '09)](https://dl.acm.org/doi/10.1145/1542476.1542480), [PDF](https://home.ttic.edu/~chenyan/paper/ceal.pdf), [project page](http://matthewhammer.org/pldi09/): from-scratch runs are **6–19× slower than plain C** (that's the price of building the trace), but small-input-change updates are **orders of magnitude faster than recomputation**; ~3–5× less memory than the SML implementation. [Self-adjusting computation with Delta ML](https://www.semanticscholar.org/paper/Self-adjusting-Computation-with-Delta-ML-Acar-Ley-Wild/a1b9b2d220f19fb396d7ef358ec002ee340a8769) is the SML dialect version.

**Takeaway for signals:** SAC solves a *harder* problem (arbitrary control flow, not a static-ish node graph) and pays a 6–19× constant factor for it. Signals libraries win by making the graph explicit. But two pieces transfer: (a) **order-maintenance timestamps as a topological order that's O(1) to maintain under insertions** (vs. height adjustment cascades), and (b) the queue-ordered-by-execution-order discipline that guarantees each node re-executes at most once per wave (glitch freedom) *and lets you cancel queued work that belongs to discarded branches*.

---

## 2. Adapton, miniAdapton, Nominal Adapton

**Sources:** [Adapton PLDI '14 paper (Tufts PDF)](https://www.cs.tufts.edu/~jfoster/papers/cs-tr-5027.pdf) · [ACM page](https://dl.acm.org/doi/10.1145/2666356.2594324) · [miniAdapton (arXiv 1609.05337)](https://arxiv.org/abs/1609.05337) · [miniAdapton code](https://github.com/fisherdj/miniAdapton) · [Nominal Adapton (arXiv 1503.07792)](https://arxiv.org/abs/1503.07792) / [OOPSLA '15](https://dl.acm.org/doi/abs/10.1145/2814270.2814305) · [adapton-lab.rust](https://github.com/cuplv/adapton-lab.rust)

### The DCG and the two-phase algorithm (read directly from the miniAdapton paper)
Adapton is **demand-driven (lazy)** incremental computation. Its **Demanded Computation Graph (DCG)** nodes are *athunks* — "mutable promises" that cache a computation's result. The entire microAdapton core is one record:

```
athunk = { thunk;               // the suspended computation
           mutable result;      // cached value
           mutable sub;         // set of subcomputations (dependencies)
           mutable super;       // set of supercomputations (dependents)
           mutable clean? }     // is cached result valid
```

Two operations, strictly separated into a **dirtying phase** and a **propagation phase** — exactly the shape of alien-signals' push (flags) + pull (validate) split:

- **`adapton-dirty!`(a):** if `a` is clean, mark it dirty and recurse to all `super` (dependents). *Recursion stops at already-dirty nodes*, so between forces the graph is traversed at most once no matter how many mutations occur — O(1) amortized re-dirtying. This is the classic "dirty bits absorb repeated invalidation" trick.
- **`adapton-compute`(a):** if clean, return cached result. Otherwise: (1) **remove all sub-edges** (the old dependency set is void — this is how conditional dependencies are dropped), (2) mark clean, (3) run the thunk (re-adding edges via `adapton-force`, which tracks a `currently-adapting` global and calls `adapton-add-dcg-edge!(super, sub)` after each forced sub-node returns), (4) **loop: recompute again if the athunk got re-dirtied during its own computation** (handles mutation-during-computation edge cases). Order matters: edges removed *before* computing; result stored after marking clean.
- **From-scratch consistency** is the correctness contract: forcing after any mutations returns exactly what a from-scratch run would. Proven for the core calculus.
- Refs are athunks whose thunk returns their own `result`; `ref-set!` = write + `dirty!`. Memoization tables (`memoize` keyed on args → athunk) give function-call reuse; "avars" store *expressions* (thunks) in refs, giving spreadsheet-formula semantics.
- Key contrast with Acar-style eager SAC (from the PLDI '14 paper): Adapton supports **lazy/demand-driven re-evaluation, sharing (DAG reuse across observers), and switching** (dependencies entering/leaving the demanded set, e.g. toggling a formula back and forth restores memoized results). Adapton "dramatically outperforms state-of-the-art IC" on interactive/lazy patterns.

### Nominal Adapton
Structural memoization fails when a program *rebuilds* fresh structure each run (new cons cells ⇒ no cache hits below the change). Nominal Adapton adds **first-class names** — stable identities supplied at allocation points — so the memo table matches "the same logical node" across runs even though its content changed. Result: "large speedups over both from-scratch and [classic] Adapton" on maps/folds/unfolds/tries. **Signals analogy:** this is exactly keyed list reconciliation (`mapArray` with keys in signals frameworks); worth stealing for any `computedArray`/collection helper for alien-signals.

---

## 3. Jane Street Incremental — the data-structure goldmine

**Sources:** [Introducing Incremental](https://blog.janestreet.com/introducing-incremental/) · [Seven Implementations of Incremental (blog + video)](https://blog.janestreet.com/seven-implementations-of-incremental/), [talk page](https://www.janestreet.com/tech-talks/seven-implementations-of-incremental/), [YouTube](https://www.youtube.com/watch?v=G6a5G5i4gQU), [transcript mirror (currently broken JS app; content surfaced via search)](https://devblogs.sh/posts/seven-implementations-of-incremental) · **primary source code:** [janestreet/incremental](https://github.com/janestreet/incremental) — I read `recompute_heap.ml/.mli`, `adjust_heights_heap.mli`, `node.mli`, `types.ml`, `state.ml` raw.

### The seven-implementations arc (what each iteration taught)
- **V1 (Weeks/Stanojevic)** followed the Acar papers: every node gets a **timestamp**; recompute in timestamp order via priority queue. Naive "timestamp at allocation" **falls apart for dynamic graphs** — nodes allocated inside `bind` must sort *between* existing nodes; the fix in early versions was Acar-style **order-maintenance "logical time"** (fast insert-between + compare).
- Middle versions fought: order-maintenance overhead, GC pressure (OCaml GC + finalizers/weak pointers used to collect unobserved nodes), semantics of unused/unobserved parts of the graph.
- **V6 eliminated the total order entirely**: "a top sort totally orders all nodes, but a partial order is enough" — introducing **"pseudo-heights"** ("similar to height but not as painful to compute"). Insight: you don't need Acar's execution order for a *first-order* explicit DAG; any function monotone on edges suffices for glitch-free scheduling.
- **V7 (current)** keeps real heights + a bucket "heap" (below), replaces GC magic with explicit **observers** and reference-counted necessity. Cost quoted in *Introducing Incremental*: **~30 ns per node fire**.

### V7 mechanisms (from source)
- **Recompute heap = array of intrusive doubly-linked lists indexed by height** (`nodes_by_height : Node or_null Uniform_array`, `height_lower_bound`, `length`). `add`/`remove` are O(1) pointer splices using per-node embedded fields `next_in_recompute_heap`/`prev_in_recompute_heap`/`height_in_recompute_heap`; `remove_min` advances the monotone `height_lower_bound` scan pointer. **No comparisons, no allocation, amortized O(1) pop** — heights only grow during a stabilization, so scanning never restarts. This is a perfect fit for a typed-array SoA port.
- **Stabilization loop:** pop min-height node, recompute; if its value changed (per **cutoff**), enqueue parents. Node invariant: necessary ⇒ `height(child) < height(parent)`, and `needs_to_be_computed = is_necessary && is_stale` ⇔ in-heap.
- **Cutoffs & staleness via two stabilization-numbers per node:** `recomputed_at` and `changed_at` (set only when the cutoff says the value really changed). `edge_is_stale(child,parent) := child.changed_at > parent.recomputed_at` — constant-time, no hashing. That's salsa's "backdating"/early cutoff done with integer stamps. Per-node `cutoff` is configurable (phys-equal default, custom equality, `Cutoff.never`, etc.).
- **`can_recompute_now` fast path** (state.ml): when a changed node's *single* parent is eligible (e.g. `Map`/`Bind_lhs_change` whose one child is this node, with scope-height checks), **recompute the parent immediately, skipping the heap entirely**; also, if `parent.height <= Recompute_heap.min_height`, recompute directly "and save adding it to and then removing it from the recompute heap". Two stats counters track how often this fires (`num_nodes_recomputed_directly_because_one_child` / `because_min_height`). For alien-signals (where chains of 1-child computeds are common) this is a big deal: most propagation can bypass any scheduling structure.
- **Adjust-heights heap** (`adjust_heights_heap.mli`): when `bind` adds an edge with `child.height >= parent.height`, ancestors are visited **in increasing pre-adjusted height**, setting `height = child.height + 1` etc.; if the walk ever reaches the original child ⇒ **cycle detected, raise**. Same bucket-list structure, with `height_in_adjust_heights_heap` frozen at insertion. `max_height_allowed` bounds the bucket array (grown explicitly).
- **Node memory layout** (types.ml) — very relevant to data-layout work: parents stored as **inline `parent0` field + spill array `parent1_and_beyond`** (optimizes the overwhelmingly-common ≤1-parent case, avoids an array for chains); mirror index arrays `my_parent_index_in_child_at_index` / `my_child_index_in_parent_at_index` give **O(1) edge removal by swap** (the same job alien-signals' doubly-linked `Link` does, but array-based); all heap membership is intrusive fields, zero allocations during stabilization.
- **Necessity/observability:** a node is *necessary* iff it's a descendant of an observer (or a `Freeze`). Becoming observed/unobserved walks the graph adjusting parent lists + heights; only necessary nodes are ever in the recompute heap. `bind` introduces **scopes**: nodes created on the RHS are registered on `all_nodes_created_on_rhs` and **invalidated wholesale when the LHS changes** (`is_valid`, `should_be_invalidated`) — the eager analog of Adapton's "remove sub-edges before recompute".
- Good secondary write-up: [timilearning: A Library for Incremental Computing](https://timilearning.com/posts/incremental-computing/).

---

## 4. Salsa & rustc's red-green incremental compilation

**Sources:** [Salsa book: the red-green algorithm](https://salsa-rs.github.io/salsa/reference/algorithm.html) · [Salsa overview](https://salsa-rs.github.io/salsa/overview.html) · [Ilya Lakhin, "Salsa Algorithm Explained"](https://medium.com/@eliah.lakhin/salsa-algorithm-explained-c5d6df1dd291) · [Durability docs](https://docs.rs/salsa/latest/salsa/struct.Durability.html) · [rust-analyzer: Durable Incrementality](https://rust-analyzer.github.io/blog/2023/07/24/durable-incrementality.html) · [rustc dev guide: incremental compilation](https://rustc-dev-guide.rust-lang.org/queries/incremental-compilation.html)

### Salsa (rust-analyzer)
- Global integer **revision** R, bumped on every input `set`. Per memoized query: cached value + dependency edges + two stamps, **`verified_at`** (last revision we confirmed validity) and **`changed_at`/`updated_at`** (last revision the value actually changed; always ≤ verified_at).
- **Fetch:** if `verified_at == R` return cache. Else run the **deep-verify recursion** (pull-based, no push at all): recursively verify each input; if every input's `changed_at <= self.verified_at`, just stamp `verified_at = R` (no recompute). Otherwise re-execute; then compare result (hash/Eq) with the old cache — if equal, **backdate**: bump only `verified_at`, keep old `changed_at`, so *downstream* validation stays cheap. This is exactly "early cutoff", and structurally identical to what alien-signals' version-check pull does.
- **Weakness** (called out in [lord.io's analysis](https://lord.io/spreadsheets/)): every unrelated input change bumps R, so a fetch after any change must re-walk the (possibly huge, unchanged) dependency subgraph. **Durability** is the fix: a small **vector of revisions, one per durability level** (LOW = workspace files, HIGH = stdlib/deps). Each query records the minimum durability of its inputs; if no revision at ≤ that durability changed, validation of the whole subtree is one integer compare. rust-analyzer's motivating number: before durability, any keystroke in `src/lib.rs` cost **~300 ms just walking stdlib-related queries to re-verify them** — pure traversal, zero recomputation. Durability converts that walk into O(1).
- Salsa also handles: cycle detection/recovery, interruption/cancellation mid-update (safe because verification is pull-only), LRU eviction of memo tables.

### rustc's red-green
- Serialized **query DAG from the previous compilation** + **fingerprints** (128-bit hashes of results). On rebuild, `try_mark_green(Q)`: walk Q's recorded `reads(Q)` **in the original execution order**, recursively determining each read's color; input reads are red/green by comparing the source; if all reads green ⇒ Q is green *without re-execution or deserialization*; if some read is red ⇒ re-run Q and compare fingerprints (red-green determination = "verifying traces" + early cutoff). Visiting reads **in original execution order** is required for soundness with dynamic dependencies (a query whose early reads are red might, when re-run, never perform its later recorded reads). Alien-signals' `checkDirty` walking the `deps` linked list in recorded order is the same discipline.
- Node **color** is computable without loading the cached **result** (hashes stored separately from values) — a memory-layout lesson: keep validation metadata (versions/hashes/flags) dense and separate from payloads.

---

## 5. Differential Dataflow, Timely, DBSP — collection-oriented incrementality

**Sources:** [DBSP paper (arXiv 2203.16684, VLDB '23 best paper)](https://arxiv.org/abs/2203.16684) (I read the PDF) · [differential dataflow mdbook — arrangements chapter](https://timelydataflow.github.io/differential-dataflow/chapter_5/chapter_5.html) · [differential-dataflow repo](https://github.com/TimelyDataflow/differential-dataflow) · CIDR '13 paper "Differential Dataflow" (McSherry et al.)

- **Different object of incrementality:** not "recompute node f", but "maintain output *collection* of query Q under input *deltas*". Collections are bags of `(data, time, diff)` **update triples**; a **Z-set** maps records to integer weights (insert = +1, delete = −1).
- **DBSP algebra** (from the paper): streams are functions ℕ→A; primitive ops are lifting `↑f`, and **delay `z⁻¹`**; **integration** `I` (running sum) and **differentiation** `D` are inverse stream operators. The **fundamental equation**: incremental version of any query is `Q^Δ = D ∘ ↑Q ∘ I`. Optimizations: **chain rule** `(S1 ∘ S2)^Δ = S1^Δ ∘ S2^Δ` (incrementalize a plan operator-by-operator); **linear operators are their own incremental versions** (filter, map, projection: work ∝ |delta|); **bilinear operators (join)** get the product rule `(a⋈b)^Δ = Δa⋈b + a⋈Δb + Δa⋈Δb` — work ∝ delta size but requires **state ∝ input size** (the integrated inputs). Recursion/fixpoints handled by **nested streams** (streams of streams) with `δ0`/`∫`; supports non-monotonic recursion, giving incremental Datalog.
- **Differential dataflow proper** additionally indexes deltas by **partially-ordered (lattice) timestamps** — needed so an update can flow both "around the loop" (iteration count) and "forward in input time" independently; DBSP simplifies this to totally-ordered time + nesting.
- **Arrangements** (mdbook ch. 5): the workhorse data structure — a shared, reference-counted **indexed trace of update batches**; "many operators do exactly the same thing… build and maintain an index of the updates" — arrangements build the index once, share it among all operators, and maintain it as a **LSM-like sequence of sorted immutable batches merged/compacted over time**. This is the collection-world analog of sharing one dependency structure among many readers.
- **When this beats node-graph reactivity:** whenever a "signal" is really a large collection whose per-update change is small (tables, lists, indexes, aggregations, joins, recursive queries). A signals graph recomputes `f(wholeCollection)`; DD/DBSP does work proportional to |delta|·log. When the object is a scalar or the function is opaque, node graphs win. Hybrid idea for alien-signals: keep the node graph, but let a computed opt into **delta-typed edges** (receive `(add/remove)` diffs rather than a snapshot).

---

## 6. Anchors — the Adapton × Incremental hybrid

**Sources:** [lord.io "How to Recalculate a Spreadsheet"](https://lord.io/spreadsheets/) (fetched in full) · [docs.rs/anchors](https://docs.rs/anchors/latest/anchors/) · repo (migrated off GitHub): [code.lord.io/anchors archive](https://code.lord.io/anchors/)

The essay is the best comparative analysis of this exact design space. Its taxonomy of failure modes:
- **Salsa-style pull/verify:** wasted graph walks when unobserved things change often (every observe re-walks a mostly-clean subgraph).
- **Adapton-style eager dirty-marking:** wasted marking walks when frequently-changing nodes feed mostly-unobserved outputs.
- **Incremental-style necessity + heights:** no marking waste, but *changing the observed set* forces full necessary/unnecessary graph walks each toggle.

**Anchors runs both algorithms on one graph** with a per-node three-state machine:
- **NECESSARY** (transitively demanded by an observer): use **Incremental's algorithm** — on change, enqueue into a **height-ordered recompute queue**; propagate only if output changed.
- **CLEAN** (was necessary, currently not, inputs unchanged since): do nothing on observe.
- **DIRTY** (clean node whose input changed): use **Adapton's algorithm** — eagerly mark dependents dirty (stopping at dirty nodes), recompute on demand, then return the node to the necessary/height regime.

Transitions: unobserve ⇒ NECESSARY→CLEAN (one walk, cached thereafter); input change on CLEAN ⇒ DIRTY (Adapton marking); input change on NECESSARY ⇒ heights queue only (no marking). So repeatedly toggling which output you observe costs a walk **only the first time**; and stable-observer/high-churn workloads never do marking walks. The docs.rs summary confirms: the single-threaded engine is "capable of both Adapton-style pull updates and — if `mark_observed`/`mark_unobserved` are used — Incremental-style push updates."

Also notable: dependencies are expressed **monadically** (`anchor.then(|v| ...)` returns an `Anchor`), i.e. explicit switching à la Incremental's `bind`, instead of Adapton's implicit `get!()` tracking with a `currently-adapting` global. Implementation uses `arena-graph`/`typed-arena` (arena-allocated node graph with generational tokens) — a Rust cousin of a slotmap/SoA layout.

**Direct relevance:** alien-signals is *already* a push(flags)/pull(versions) hybrid, but it treats all nodes uniformly. Anchors shows the win from **state-splitting the graph by observation status** and using different propagation disciplines per region — e.g. alien-signals' `effect`-reachable region could use eager height/queue scheduling while unwatched computeds fall back to pure dirty-bit + on-demand validation.

---

## 7. Build Systems à la Carte — shared vocabulary

**Source:** [Mokhov, Mitchell, Peyton Jones, ICFP '18 (PDF)](https://www.microsoft.com/en-us/research/wp-content/uploads/2018/03/build-systems.pdf) (read directly; figures 8–10 confirm the table) · [Haskell models](https://hackage.haskell.org/package/build-1.0)

Every incremental system = **scheduler × rebuilder**:
- **Schedulers** (order of processing): **topological** (needs static deps: Make, CloudBuild, Buck); **restarting** (run in a guessed order — Excel's persisted **calc chain** — and on discovering an unbuilt dynamic dep, *abort the task, move the dep earlier, restart*: Excel, Bazel's build queue with "blocked" keys re-enqueued); **suspending** (start the target, recursively suspend on each `fetch` of a dep: Shake, Nix, and — in our world — every pull-based signals `get`).
- **Rebuilders** (decide rebuild vs. reuse): **dirty bit** (Make's mtimes, Excel's per-cell bit); **verifying traces** (store hashes of deps at last build; rebuild iff a hash mismatches — Shake, rustc fingerprints, salsa's stamp discipline); **constructive traces** (also store the *result* keyed by input hashes — Bazel/CloudBuild cloud caches); **deep constructive traces** (key only on terminal inputs; enables shallow "skip the middle" builds — Buck, Nix).
- Key properties: **minimality** (each task at most once, only if needed); **early cutoff** (stop when a rebuilt value is unchanged — needs verifying traces or dirty-bit+value-compare; = salsa backdating = Incremental cutoffs = alien-signals version non-bump); **self-tracking** (formula/code changes are themselves tracked inputs — Excel does it, most build systems don't; signals equivalent: a computed's function identity as a dependency); **dynamic dependencies** (Excel/Shake yes, Make no).
- Mapping our domain: **alien-signals ≈ suspending scheduler + (dirty-bit push filter over a verifying/version rebuilder)**; Jane Street Incremental ≈ **topological (height) scheduler + verifying (stamp) rebuilder with early cutoff**; salsa ≈ **suspending + verifying traces**; Adapton ≈ suspending + dirty-bit-guarded verifying.

---

## 8. Recent SOTA (2020–2026)

- **[Efficient Parallel Self-Adjusting Computation (SPAA '21, arXiv 2105.06712)](https://arxiv.org/abs/2105.06712)** (Anderson, Blelloch, Baweja, Acar; [code: cmuparlay/psac](https://github.com/cmuparlay/psac), [PDF](https://danielanderson.net/papers/3409964.3461799.pdf)). First general **parallel change propagation** for nested-parallel programs. Computation represented as an **RSP tree**: an **SP (series–parallel) tree** — S nodes (ordered sequential composition), P nodes (unordered parallel composition), leaf strands — augmented with **R (read) nodes** recording data dependencies on "modifiables". Change propagation walks the SP tree: affected reads in *parallel* branches re-execute concurrently (work-stealing), sequential ones in order; work/span bounds are given in terms of a computation-distance metric. Demonstrated on dynamic sequences/trees with large work savings vs from-scratch and good parallel scaling. Earlier related: ["round-synchronous" parallel CP] and [A proposal for parallel SAC (DAMP '07)](https://dl.acm.org/doi/10.1145/1248648.1248651); thesis-length treatment: [CMU-CS-21-133](http://reports-archive.adm.cs.cmu.edu/anon/2021/CMU-CS-21-133.pdf). **Relevance:** if alien-signals ever batches independent computeds, the SP-tree insight is that you only need to record *where the graph is unordered* to unlock safe parallel propagation.
- **[Spineless Traversal for Layout Invalidation (arXiv 2411.10659, 2024–25)](https://arxiv.org/abs/2411.10659)** — directly applicable. Browser layout dirty-propagation classically walks the tree "spine" (parent pointers + dirty-descendant bits) to find dirty nodes, thrashing cache on auxiliary nodes. Spineless replaces it with a **priority-queue over order-maintenance timestamps**: each node carries a timestamp giving its from-scratch traversal order (maintained under tree edits by an order-maintenance structure); dirty nodes go straight into a PQ keyed by those timestamps, so recomputation happens in exactly from-scratch order **without touching clean intermediate nodes**. Results: faster on **83.0% of 2,216 benchmarks, mean speedup 1.80×** on latency-critical interactions (hover/typing/animation). This is the strongest recent evidence that *"order-maintenance timestamp + PQ" can beat "walk the dirty spine"* — the signals-graph analog of the spine walk is alien-signals' subscriber-list flag propagation.
- **[Incremental Bidirectional Typing via Order Maintenance (arXiv 2504.08946, 2025)](https://arxiv.org/abs/2504.08946)** — incremental type checker using order-maintenance structures to prioritize update propagation; Agda-verified equivalent to reanalysis; **275.96× speedup** vs from-scratch on a large stress test. Confirms the same scheduling recipe (OM timestamps as priorities) in yet another domain.
- **[Interactive Abstract Interpretation with Demanded Summarization (TOPLAS '24)](https://dl.acm.org/doi/full/10.1145/3648441)** — Adapton-lineage "demanded" computation applied to program analysis (demanded abstract interpretation graphs); shows the DCG approach scaling to analyses with cyclic/fixed-point structure.
- **DBSP/Feldera** (above) is itself 2022–24 SOTA on the collections side; differential dataflow remains the engine of Materialize.

---

## 9. Synthesis — concrete ideas for alien-signals

**Scheduling / algorithms**
1. **Height-bucketed recompute queue** (Incremental V7): array of intrusive singly/doubly-linked lists indexed by height + monotone `height_lower_bound`. O(1) push/pop, no comparators, no allocation. Heights fit in a byte/short for real UIs → lives happily in an `Int32Array`. Gives *inherent glitch freedom* and "each node recomputed ≤ once per stabilization" instead of relying on recursive `checkDirty` walks.
2. **`can_recompute_now` fast paths**: when the changed node has exactly one parent (alien-signals: `subs === subsTail`), or parent height ≤ current min height, recompute the parent immediately — skip all queue machinery. Incremental keeps explicit counters proving these paths dominate.
3. **Adjust-heights-on-edge-add** with cycle detection (Incremental's second heap), only triggered when `child.height >= parent.height` — cheap because dynamic edges are rare relative to propagations.
4. **Order-maintenance timestamps as an alternative to heights** (Acar '02; Spineless '24; typing '25): O(1) maintenance under node insertion (no ancestor height cascades), PQ keyed by timestamp gives from-scratch order. Beats heights when graphs restructure frequently (lots of `bind`-like conditional dependency churn).
5. **Backdating/early cutoff done with two stamps** (`changed_at` ≤ `recomputed_at`/`verified_at`): staleness of an edge is one integer compare (`child.changed_at > parent.recomputed_at`). Alien-signals' version counters are close; the salsa/Incremental formulation makes "recomputed but equal ⇒ don't bump changed_at" an explicit, per-node-cutoff-configurable contract.
6. **Durability levels** (salsa / rust-analyzer): partition the global version into a small vector by change-frequency class; a computed depending only on high-durability signals validates with one compare instead of a dependency walk. Cheap to add to a version-counter design; rust-analyzer's 300 ms→~0 anecdote is the payoff.
7. **Anchors' three-state hybrid**: treat the observer-reachable ("necessary") region with eager queue scheduling and the unobserved region with Adapton dirty bits + demand-driven validation; cache the necessary/clean distinction so toggling observers doesn't re-walk the graph.
8. **Adapton's re-dirtying rules**: dirty-marking recursion stops at dirty nodes (alien-signals does this via flags — keep it); *remove/neutralize the old dependency edges before recompute, and re-check dirtiness after compute* to be robust to mutation-during-recompute.
9. **Nominal/keyed memoization** for collection combinators (keyed `mapArray`); **delta-typed edges** (DBSP: linear ops pass deltas through; join-like combinators need integrated state) for large-collection signals.
10. **Parallel batch propagation** (PSAC): record which subscriber sets are order-independent; propagate waves of equal-height nodes in parallel workers.

**Data layout**
11. Incremental's node record is a lesson in **intrusive everything**: heap membership, list links, and both direction's edge indexes live *inside* the node (`parent0` inline + spill array; `my_parent_index_in_child_at_index` arrays for O(1) unlink). An SoA/typed-array port of alien-signals can mirror this: `flags: Uint8Array`, `height: Int32Array`, `version/changed_at/recomputed_at: Float64Array|Int32Array`, edge pool as parallel `Int32Array`s (`dep`, `sub`, `nextDep`, `prevSub`, `nextSub`) — i.e., alien-signals' `Link` records become indices into arrays; the recompute "heap" is just `heads: Int32Array` per height + `next_in_heap: Int32Array`.
12. rustc separates **validation metadata from cached values** (colors/fingerprints loadable without results) — keep hot flags/versions dense and cold values boxed.
13. Differential dataflow's **arrangements** (shared immutable sorted batches, LSM-style merging) are the pattern for sharing one index among many consumers if alien-signals grows collection primitives.

## Other useful URLs
- [Adapton project overview (Racket docs)](https://docs.racket-lang.org/adapton/index.html)
- [Salsa GC discussion in rust-analyzer](https://github.com/rust-lang/rust-analyzer/issues/73)
- [Heaps for incremental computation (Tim Vieira)](https://timvieira.github.io/blog/post/2016/11/21/heaps-for-incremental-computation/)
- [Incremental topological ordering literature, e.g. arXiv 0803.0792](https://arxiv.org/pdf/0803.0792) / [arXiv 1105.2397](https://arxiv.org/pdf/1105.2397) — for maintaining priorities under edge insertions
- [A Theory of Changes for Higher-Order Languages (ILC, static differentiation)](https://arxiv.org/pdf/1312.0658) — the static (non-tracing) alternative family

## Key links

- [Seven Implementations of Incremental (talk video)](https://www.youtube.com/watch?v=G6a5G5i4gQU) — Data-structure evolution (timestamps → order maintenance → pseudo-heights → height buckets) for exactly the signals problem
- [janestreet/incremental source (recompute_heap.ml, state.ml, types.ml)](https://github.com/janestreet/incremental) — Primary source: height-bucket heap, adjust-heights heap, can_recompute_now fast paths, intrusive node layout
- [How to Recalculate a Spreadsheet (lord.io)](https://lord.io/spreadsheets/) — Best comparative analysis of Salsa vs Adapton vs Incremental failure modes; describes Anchors' 3-state hybrid
- [Salsa red-green algorithm reference](https://salsa-rs.github.io/salsa/reference/algorithm.html) — Revisions, verified_at/changed_at, backdating, durability — closest published cousin of alien-signals' version-pull
- [rust-analyzer: Durable Incrementality](https://rust-analyzer.github.io/blog/2023/07/24/durable-incrementality.html) — Durability vector kills 300ms validation walks — cheap add-on to version-counter designs
- [rustc dev guide: incremental compilation (try_mark_green)](https://rustc-dev-guide.rust-lang.org/queries/incremental-compilation.html) — Verifying-trace validation in original execution order; colors separated from cached values
- [miniAdapton (arXiv 1609.05337)](https://arxiv.org/abs/1609.05337) — Complete minimal Adapton: athunk struct, dirty!/compute algorithms, DCG edge maintenance in <50 lines
- [Adapton: Composable Demand-Driven Incremental Computation (PLDI'14)](https://www.cs.tufts.edu/~jfoster/papers/cs-tr-5027.pdf) — The lazy DCG + from-scratch consistency model behind alien-signals' pull phase
- [Nominal Adapton (arXiv 1503.07792)](https://arxiv.org/abs/1503.07792) — First-class names fix structural memoization — the theory behind keyed list reconciliation
- [Adaptive Functional Programming (Acar/Blelloch/Harper POPL'02)](https://www.cs.cmu.edu/~guyb/papers/popl02.pdf) — Origin of change propagation: DDG, Dietz-Sleator order maintenance, timestamp-ordered priority queue
- [Spineless Traversal for Layout Invalidation (arXiv 2411.10659)](https://arxiv.org/abs/2411.10659) — 2024 proof that order-maintenance PQ beats dirty-spine walking: 1.80x mean speedup on 83% of 2216 benchmarks
- [Efficient Parallel Self-Adjusting Computation (arXiv 2105.06712)](https://arxiv.org/abs/2105.06712) — SP/RSP-trees enable safe parallel change propagation with work/span bounds; code at cmuparlay/psac
- [Build Systems à la Carte (ICFP'18)](https://www.microsoft.com/en-us/research/wp-content/uploads/2018/03/build-systems.pdf) — Scheduler × rebuilder taxonomy (minimality, early cutoff, self-tracking) for classifying all these systems
- [DBSP: Automatic Incremental View Maintenance (arXiv 2203.16684)](https://arxiv.org/abs/2203.16684) — Z-sets, Q^Δ = D∘Q∘I, chain rule; when delta/collection incrementality beats node-graph recomputation
- [Differential dataflow mdbook: arrangements](https://timelydataflow.github.io/differential-dataflow/chapter_5/chapter_5.html) — Shared LSM-style indexed update batches — the data layout for collection-valued reactivity
- [anchors crate docs](https://docs.rs/anchors/latest/anchors/) — Hybrid engine: Adapton-style pull + Incremental-style push in one graph (arena-allocated)
- [CEAL: C-based self-adjusting computation (PLDI'09)](https://home.ttic.edu/~chenyan/paper/ceal.pdf) — Cost baseline: 6-19x from-scratch overhead bought orders-of-magnitude update speedups
- [timilearning: A Library for Incremental Computing](https://timilearning.com/posts/incremental-computing/) — Secondary write-up of height-heap scheduling and observed-node demand-driven recomputation
