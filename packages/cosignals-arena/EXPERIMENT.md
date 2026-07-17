# Data-oriented graph experiment

> Historical naming: `signals-royale-fx2` is now named `cosignals`.

This package ports the `signals-royale-fx2` node/link graph to numeric records while keeping JavaScript state on the public `Signal` and `Computed` handles. The handle is the node: `.node` is only a compatibility alias and no second `ReactiveNode` object is allocated.

## Result

The port is correct but slower than the object graph on V8. On 2026-07-11, three isolated rounds of `milomg-reactivity-benchmark` produced a 1.405x geometric-mean ratio and a 1.403x aggregate-time ratio (Dalien fork divided by current FX2).

| Benchmark             | FX2 ms | fork ms | ratio |
| --------------------- | -----: | ------: | ----: |
| create signals        |   4.42 |    5.68 | 1.29x |
| create computations   |  77.10 |  146.61 | 1.90x |
| update signals        | 324.06 |  528.88 | 1.63x |
| avoidable propagation | 137.63 |  182.08 | 1.32x |
| broad propagation     |  96.87 |  170.26 | 1.76x |
| deep propagation      |  42.74 |   70.55 | 1.65x |
| diamond               | 100.70 |  147.24 | 1.46x |
| mux                   |  86.66 |  125.48 | 1.45x |
| repeated observers    |  22.08 |   25.62 | 1.16x |
| molBench              |  15.30 |   14.80 | 0.97x |
| 4-1000x12, dynamic 5% | 270.38 |  326.26 | 1.21x |
| 25-1000x5             | 324.26 |  362.25 | 1.12x |

Command:

```sh
cd milomg-reactivity-benchmark
node packages/node/dist/isolated.js --rounds 3 --no-memory "Royale FX2" "Royale FX2 Dalien"
```

All 329 package tests, 179 conformance cases, the oracle fuzz suite, GC tests, React tests, and the 150,000-node iterative traversal test pass.

## What the port established

- Nodes and links share an interleaved, 8-word `Int32Array` arena. Link identity is a numeric record offset.
- `Signal` and `Computed` own `value`, `fn`, equality, async, lifetime, and world state. There is no JS internals object per arena record.
- A dense `pinnedInternals` table is still required. A numeric link keeps only a dependency ID, so a live graph edge must pin and recover the corresponding handle. Reference counts clear the pin with the last link.
- Dropped handles require `FinalizationRegistry` registration to return node and link IDs. The object graph gets this tracing and reclamation directly from the JS collector.
- Records are 32 bytes instead of 64. Changed clocks use a `Float64Array` view; validation clocks and cold numeric passes use typed columns.
- Capacity is deliberately fixed at 2,097,152 records while tuning. The typed buffers reserve 112 MiB: 64 MiB for records, 16 MiB for validation clocks, and 32 MiB for four `Int32` columns. Growth was not added because it cannot repair the remaining hot-path gap and would complicate measurements.

## Why it is slower

The initial port was 1.598x slower geometrically. The following changes reduced it to 1.405x:

- packed 16-word records to 8 words;
- removed an unused unregister token from finalizer registration and deferred registration in bounded batches;
- split dependency insertion from retracking, reducing `trackRead` from 183 to 165 V8 bytecodes and confirming that V8 inlines it into signal/computed reads;
- kept the ID-to-handle table dense rather than holey;
- passed already-read flags into validation frames.

The remaining costs are structural. Creation pays for arena allocation bookkeeping and a finalizer cell per GC-owned handle. Reads traverse typed numeric records, then perform an ID-to-handle lookup before executing handle-owned `fn`, `equals`, or value logic. FX2's object links hold those object references directly, and V8 optimizes their stable hidden-class fields well. A CPU profile after the creation fix attributed 17.6% of non-library samples to dependency tracking, 15.0% to validation, and 8.6% to writes.

### Per-field JS column follow-up

A follow-up kept the public object handles but moved `value`, `initializer`, `equals`, and computed `fn` into canonical per-field JS arrays. Handle properties became compatibility accessors; graph reads, writes, equality checks, and computed invocation consumed the columns directly.

The naive record-indexed columns wrote four entries for every interleaved link and regressed construction badly. A corrected layout gave only cells/computeds a dense host index stored in their node record, moved link reference counts to a typed column, and retained a handle only for validation frames that could execute user code. It passed conformance, fuzz, graph-tier, and GC tests.

That best column layout was still slower. Three isolated rounds measured 1.477x geometric mean and 1.451x aggregate time versus FX2, compared with 1.405x and 1.403x for handle-owned fields. Signal creation moved from 5.68 to 8.43 ms, while computation creation was essentially unchanged at 148.20 versus 146.61 ms. The implementation commits (`a32a82b`, `67edd18`, and `3d7759b`) are preserved and then reverted by `173fefd`, `c005c52`, and `35223b8`.

The lifetime constraint prevents columns from eliminating handle recovery: validating a dependency can run user code that removes the current computed's last graph pin. The active validation frame must acquire and strongly retain that object before descending. Columns therefore added host-index loads and array maintenance without removing the required handle ownership path. A single `SignalInternals`/`ComputedInternals` column has the same limitation. Numeric public handles could avoid it, but are outside the required API.

## Complexity

Compared with the current object package, `graph.ts` grows from 1,601 to 1,834 lines while `index.ts` shrinks from 540 to 495: a net increase of 188 lines in the two core files. The added mechanisms are record layout, free lists, pin reference counts, finalizer registration, arena reset, and typed auxiliary columns. Big-O graph behavior is unchanged; constant factors and lifetime machinery increase.

The useful result is therefore not a replacement recommendation. The object graph remains the baseline for this object-handle API. Both handle-owned fields and per-field indexed columns were measured; the columns made this hybrid slower. Arena growth should not be implemented unless another design first closes the fixed-arena execution gap.

## 2026-07-12 optimization round: 1.405x to 1.06x

A second round revised the conclusion above. The gap was not structural; it
was a set of identifiable per-operation costs, each with a fix that keeps
the arena design and the full test surface (329 package tests, 179
conformance cases, oracle fuzz at 5,000 seeds, GC/leak suite) green.

Measured on the same three-round isolated `milomg-reactivity-benchmark`
protocol, the geometric-mean ratio against `signals-royale-fx2` moved from
1.405x to 1.0618x, with the arena now winning eight of twenty rows outright
(signal creation 0.74x, the three large dynamic-graph cases 0.78-0.91x,
update-heavy writes 0.93x). Both packages were under active development
during the round; the reference numbers name the fx2 working tree at
measurement time. Machine load was elevated but shared by the alternating
protocol.

What closed the gap, in landing order:

- **Persistent integer stack for the invalidation wave.** The wave never
  runs user code, so one module-lifetime `Int32Array` replaces a heap cons
  cell per branching descent.
- **Trace-guarded cause stores.** The per-visit causal-event store only
  runs while a tracer is attached.
- **No `fill()` builtins in reclaim.** Freed records are cleared with
  explicit stores of exactly the slots each record kind can have dirtied —
  a freed watcher record, for instance, provably dirties only its dep list
  head/tail and validation watermark.
- **Lazy records.** Cells and computeds are born pointing at a shared,
  immutable detached-state record that carries their born flags word; the real
  record and finalizer registration materialize at first graph
  participation. A handle dropped before that point frees with ordinary
  GC. Writes to a recordless cell store the value and skip the clock
  entirely unless a draft world is live or a tracer is attached (both can
  observe a cell from outside the edge graph).
- **Cell record detachment.** A cell record's only owners are its incoming
  links, so when the last one drops, the record returns to the free pool
  and the live handle points back at the detached-state record. Cells linked by
  reads therefore never touch the FinalizationRegistry at all; only
  computeds (whose records own dep links a dead handle must free) and
  tracer/draft-materialized cells register.
- **Generation-stamped typed effect queue.** The flush queue stores
  (record id, generation) pairs instead of handles: enqueueing is two int
  stores with no handle lookup and no write barrier, and a record
  reclaimed between schedule and drain gen-mismatches into a no-op.
- **Bytecode diet.** Typed-array field access compiles to roughly double
  the bytecode of a named-property access, which starved V8's inlining
  budgets. Moving cold bodies (cycle throw, children/cleanup disposal,
  stale-edge freeing, batch-base save, detach) out of hot functions
  restored inlining across the validate/recompute/track cluster.
- **Stackless chain validation.** A node with exactly one dependency
  validates with one reading compare, and a chain of single-dep,
  single-subscriber possibly-stale computeds validates with one descent
  and one climb — no recursion frames. Deep-chain propagation went from
  1.4x to parity.
- **Plain-success recompute inline.** The seam that folds async outcomes
  into node state is only called for async-touched evaluations; a plain
  successful evaluation resolves to the equality cutoff inline.
- **Engine core in a single-instantiation closure + local const views.**
  Bundlers emit module state as mutable top-level `var`s, so every arena
  access compiled to a context-slot load that could not be folded or
  reused across calls. Binding the arena views as function-scope consts
  (and opening hot functions with local views) removed most of those
  loads; wide fan-out propagation improved from ~1.4x to ~1.2x.
- **Free-record stacks.** Intrusive free lists chain a dependent memory
  read through every allocation; explicit stack arrays make each pop an
  independent indexed load. The dense create/dispose lifecycle driver
  (100 effects x 1000 reads) went from 11.3 ms to 3.7 ms.

What remains (the current 1.06x): the read-and-validate paths still pay
more per operation than object fields — a tracked read costs an id load
plus a typed-array flags load where the object graph pays one field load,
and the same multiplier applies through validation loops and effect
re-runs. The rows still losing are exactly the small, cache-resident
graphs dominated by those paths (wide fan-out 1.43x, effect
create+dispose 1.38x, equality-cutoff chains 1.34x). The identified next
step, not taken in this round, is a hybrid split: keep links, clocks, and
propagation in the arena (where the large-graph rows are won) and move
per-node hot words (flags, dep-cursor) onto the handles.

Two claims from the earlier conclusion did not survive re-testing.
Typed-array bounds checks were already exonerated by the masking
experiment and remain exonerated. The finalizer-registration cost, judged
inherent above, was removable for the dominant cell lifecycle via
record detachment.

## 2026-07-12, continued: 1.06x measured frontier

Follow-up work after the first table: dependency cursors moved to handle
fields, watcher reclaim slimmed to its three dirty slots, watched-edge
insertion fused, node records returned to 8 words with side columns
(the 16-word colocation had doubled creation's arena footprint for no
measured walk gain), and two-ended arena allocation (nodes grow up,
links grow down) so node records stay dense, the pin table spans only
the node region, and link allocation is a bare bump.

Result, on a quiet machine against the object-graph package at the same
commit, three independent 3-round isolated runs: geometric-mean ratios
1.0455, 1.0794, 1.0571 — mean 1.0607. The arena wins signal creation
(0.93), every large dynamic-graph row (0.86-0.96), and update-heavy
writes (1.00); it loses the small cache-resident validate/recompute rows
by a uniform 1.10-1.28.

Why the remaining gap does not close within this design: the split
representation pays double addressing at its boundary. A node's hot
state is consulted two ways — by handle (reads, recomputes) and by raw
record id (the invalidation wave, dependency-validation loops, chain
climbs). Any field moved onto the handle makes the handle-side cheaper
by one load and the id-side more expensive by at least two (an owner
lookup plus the field), and the id-side loops dominate exactly the rows
that are behind. Counting loads per operation for every candidate split
(flags on handles with per-link owner arrays; clocks as handle doubles)
gives a non-positive net on this suite. The object graph's advantage on
small hot graphs is that all per-node state sits behind one pointer at
fixed offsets; the arena's advantage is density and no garbage-collector
coupling, which is why it wins every row whose working set outgrows the
cache. The two designs are each optimal on their own side of that line,
and this suite weighs the small-graph side 12 rows to 6.

## 2026-07-12 source convergence

The fork now carries the source package's deterministic watcher ownership,
conservative batch-revert semantics, structural `Atom`/`Computed` API,
explicit signal policy errors, lazy ambient transition ownership, and
React-phase tracked signal effects. The latter use two arena watchers per
mounted effect: one owns the user's dependency edges and cleanup, while the
other owns flattened draft-world source edges used only to wake root-relative
comparisons. No per-node column or internals object was added.

One representation experiment was rejected before commit. Making computed
handles with `Object.create(ReactiveNode.prototype)` and storing `get` and
`peek` as own fields, like the object-graph source package, regressed the
isolated suite to 1.3015x geometric / 1.2619x aggregate. Keeping the same
structural public type but using a private, non-exported class expression puts
the shared methods on its prototype and restored the previous handle shape.
The committed result measured 1.0395x geometric / 1.0049x aggregate over the
20-row, three-round isolated comparison.

The React seam benchmark also runs under the fork now (its child processes
need Node's transform-types mode for the arena's `const enum`). One adjacent
source/fork sample measured:

| scenario                      |  source fx2 |  arena fork |
| ----------------------------- | ----------: | ----------: |
| fanout median write-to-commit |    4.095 ms |    4.626 ms |
| transition p95 urgent latency |   10.434 ms |   10.270 ms |
| transition completion         | 1664.513 ms | 1752.093 ms |
| 5000-cell median mount        |   60.032 ms |   65.303 ms |

These single React samples are direction checks, not stable estimates; the
isolated graph comparison is the repeatable performance gate. Typecheck and
all 337 package tests, including the nine adversarial scheduled-effect cases,
pass at this point.

## 2026-07-15 source convergence: the split-effect model

The fork now carries the source package's split-effect rewrite and everything
that followed it, re-expressed in the arena:

- `effect(compute, handler, {schedule})` with three drain lanes (sync /
  useLayoutEffect / useEffect), two-phase drains (pull all computes, then run
  cleanups and handlers), and the last-handled value anchor. Effect nodes
  share the derived evaluator: one record type carries the compute's value,
  dependency list, and async state, plus handle-owned delivery fields.
- The old scheduled-effect machinery is gone: `WatchSchedule`, `WatchDraft`,
  the two-watcher world-source scheme, and the watcher validation loop are
  deleted; render watchers hold one pinned link and are never validated.
- Lane queues keep the (record id, generation) typed enqueue on the write
  path; the drain's pull phase resolves survivors into a retained handle
  array for the run phases, and generation stamps make reclaimed entries
  drain as no-ops.
- The tracer seam is the 3-method sink (`emitEvent`/`startSpan`/`endSpan`)
  with the API-vocabulary kinds; `./debug` (tracer + inert inspect) and
  `./ssr` subpaths match the source package.
- One clock: draft activity and settlement tick the graph clock, and a base
  watermark answers "did base state change since X" (the separate
  DraftChangeClock is deleted).

Two lifetime rules earned their own machinery during the port:

- **Pin identity is watcher liveness.** A disposed watcher's record may be
  reclaimed and reused, so its flags word can never be read again; every
  post-dispose entry point (double dispose, owner-alive checks, wake and
  notify delivery) tests `pinnedInternals[id] === handle` instead. Record
  reclaim is immediate at dispose, in both cases where a party still holds
  the handle: a pending thenable's parked set checks the handle-owned
  `disposed` mark before settlement addresses the record (a dead effect is
  terminal, so skipping it is also the right semantics), and an effect
  disposed by its own evaluation leaves the record for that evaluation's
  unwind to return after its final stamps. No effect record waits on the
  collector; the FinalizationRegistry serves only dropped derived handles.
- **Pins retain closure scope chains.** An unwatched chain keeps forward
  links, each link pins its dependency's handle, and a pinned handle retains
  its compute closure's whole scope chain. If that scope chain contains a
  higher handle of the same chain (every computed built in one shared
  function scope does this), the pin roots a cycle the collector can never
  break — the object-graph source package collects the same cycle wholesale
  because nothing engine-side roots it. Chains built through per-level
  factory scopes reclaim fully, one level per collection round (each level's
  finalizer drops the pin below it). This is the standing cost of numeric
  links + strong pins; a fix would need weak pins for unwatched edges.

Typecheck and all 414 package tests (179 conformance cases, the oracle fuzz
suite, GC/leak suite, React suites) pass at this point.

### Post-port measurement (2026-07-15)

Three-round isolated `milomg-reactivity-benchmark` A/B, this package at
`4392ea4` against the source package's working tree near `51dbf9d`
(both engines changed since the 1.06 stamp — the source package landed its
own effect-tax and propagation work in the same window). Machine load was
elevated (~15) but shared by the alternating protocol; ratios are the
signal, absolute times are inflated.

| Benchmark              | source ms | fork ms | ratio |
| ---------------------- | --------: | ------: | ----: |
| createSignals          |      1.32 |    1.04 |  0.79 |
| createComputations     |     58.82 |  108.06 |  1.84 |
| updateSignals          |    486.68 |  844.54 |  1.74 |
| avoidablePropagation   |    124.13 |  140.44 |  1.13 |
| broadPropagation       |    142.44 |  173.23 |  1.22 |
| deepPropagation        |     46.31 |   50.72 |  1.10 |
| diamond                |    104.74 |  123.63 |  1.18 |
| mux                    |     94.16 |  104.64 |  1.11 |
| repeatedObservers      |     20.52 |   22.53 |  1.10 |
| triangle               |     30.72 |   38.06 |  1.24 |
| unstable               |     22.30 |   24.61 |  1.10 |
| molBench               |     15.26 |   15.34 |  1.01 |
| cellx1000              |      6.34 |    8.03 |  1.27 |
| cellx2500              |     18.95 |   25.62 |  1.35 |
| 2-10x5 lazy80%         |    186.00 |  210.33 |  1.13 |
| 6-10x10 dyn25% lazy80% |    109.20 |  119.08 |  1.09 |
| 4-1000x12 dyn5%        |    267.55 |  270.80 |  1.01 |
| 25-1000x5              |    308.13 |  263.57 |  0.86 |
| 3-5x500                |     83.67 |   80.30 |  0.96 |
| 6-100x15 dyn50%        |    160.51 |  143.21 |  0.89 |

Geometric mean 1.1310; aggregate 1.2098. The big-graph structure holds
(signal creation and every large dynamic-graph row still win), but the
effect-drain rows regressed well past the old frontier: updateSignals was
at parity and is now 1.74, and createComputations moved from ~0.94 to
1.84. Ranked suspects, unprofiled:

- chainResolve now runs on every single-dep effect pull and pays a handle
  store into the scratch path plus a pin lookup at level 0, even when the
  dependency is a plain cell one compare would settle — the retired
  stackless variant walked ints only;
- per-drain delivery ceremony new to the split model (survivor handle
  stores, the last-handled equality call, handler-context saves and the
  unconditional cause swap) on top of what the old single tracked body
  paid;
- the disposed-mark probe at recompute entry (an absent-property load on
  the hottest call).

The next optimization round starts from a profile of updateSignals and
createComputations; none of these suspects is load-bearing for
correctness, so each can be A/B'd in isolation.

### Recovery round (2026-07-15, later): 1.13 back to ~1.07-1.09

A whole-suite profile put chainResolve at 9% of self time and recompute
at 16%; three changes, each gated on the full 414-test suite:

- **Shallow validation stays on recursion frames.** ensureFresh entered
  chainResolve for ANY watched single-dep StaleCheck node — including
  every single-dep effect pull, the write-heavy rows' hot path. It now
  engages only at recursion depth 16, like the source package: one
  reading compare per shallow level, handles held by the frames (which
  is also what resolves the levels above a mid-climb restructure), and
  chainResolve absorbs only the deep tail. This alone took updateSignals
  from 1.74 to ~1.15.
- **chainResolve records ids, not handles.** The descent path lives in a
  persistent integer scratch; climb compares are integer loads, a pinned
  handle resolves only on levels that actually recompute, and early
  climb bails (start disposed, interior unpinned by re-entrant user
  code) return false so the caller's generic frames finish the rest.
- **Class-expression watcher handles and a phase-free one-entry drain.**
  Watcher handles are constructed with one stable shape instead of
  Object.create plus incremental stores, the disposed probe moved off
  recompute's entry onto the two guarded ensureFresh sites (as
  pin-identity tests gated by the entry flags), and a one-entry drain
  round — a plain write waking one effect — runs pull, cleanup, and
  handler over one local survivor with no phase bookkeeping
  (write-to-handler micro: 1.19x → ~1.07x).

Attribution for what remains, from a three-way driver (pre-port fork /
current fork / current source) over every create/dispose shape: the
fork's effect lifecycle is unchanged from before the port (13.6 vs 12.4
ms on 200k single-dep create+dispose, within noise at every fan-in), so
the createComputations row's move from ~1.38 to ~1.68 measures the
source package's own effect-tax round, not a fork regression. The last
pre-port ratio recorded against a contemporaneous source tree was
1.1272.

Two 3-round isolated runs at the final code (fork `9c8057b`), elevated
shared load: geometric means **1.0913 and 1.0699** (aggregates 1.0708,
1.0531). The loss profile matches the pre-port frontier's shape —
equality-cutoff chains ~1.31 (was 1.34), wide fan-out 1.15-1.18 (was
~1.43), cellx 1.01-1.16, effect create+dispose the one row above its
old band (1.68, attributed above) — and every large dynamic-graph row
still wins (0.85-0.94).
