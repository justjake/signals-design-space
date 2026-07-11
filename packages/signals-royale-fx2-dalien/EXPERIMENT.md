# Data-oriented graph experiment

This package ports the `signals-royale-fx2` node/link graph to numeric records while keeping JavaScript state on the public `Signal` and `Computed` handles. The handle is the node: `.node` is only a compatibility alias and no second `ReactiveNode` object is allocated.

## Result

The port is correct but slower than the object graph on V8. On 2026-07-11, three isolated rounds of `milomg-reactivity-benchmark` produced a 1.405x geometric-mean ratio and a 1.403x aggregate-time ratio (Dalien fork divided by current FX2).

| Benchmark | FX2 ms | fork ms | ratio |
| --- | ---: | ---: | ---: |
| create signals | 4.42 | 5.68 | 1.29x |
| create computations | 77.10 | 146.61 | 1.90x |
| update signals | 324.06 | 528.88 | 1.63x |
| avoidable propagation | 137.63 | 182.08 | 1.32x |
| broad propagation | 96.87 | 170.26 | 1.76x |
| deep propagation | 42.74 | 70.55 | 1.65x |
| diamond | 100.70 | 147.24 | 1.46x |
| mux | 86.66 | 125.48 | 1.45x |
| repeated observers | 22.08 | 25.62 | 1.16x |
| molBench | 15.30 | 14.80 | 0.97x |
| 4-1000x12, dynamic 5% | 270.38 | 326.26 | 1.21x |
| 25-1000x5 | 324.26 | 362.25 | 1.12x |

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
