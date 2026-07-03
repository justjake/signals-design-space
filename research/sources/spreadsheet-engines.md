# Spreadsheet Calculation Engines: Recalc Algorithms & Data Layout — Deep Research Report

Research domain: highest-performing spreadsheet engines, for transferable ideas into alien-signals (push-pull signals, doubly-linked dependency Links, version counters, flag-based dirty propagation).

---

## 1. Microsoft Excel: dependency trees + a self-optimizing linear calc chain

Primary sources: [Excel Recalculation (XLL docs)](https://learn.microsoft.com/en-us/office/client-developer/excel/excel-recalculation), [Excel performance: Improving calculation performance](https://learn.microsoft.com/en-us/office/vba/excel/concepts/excel-performance/excel-improving-calculation-performance) (authored by Charles Williams), [Decision Models "Calculation Secrets": dependencies](https://www.decisionmodels.com/calcsecretsd.htm) and [calculation process](https://www.decisionmodels.com/calcsecretsc.htm), [calcChain.xml / Open XML](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-the-calculation-chain).

### The three-stage model
1. **Dependency tree construction** — which cells are precedents of which. Rebuilt on structural change (new formula, insert/delete row, rename sheet…). Maintained *even in manual calc mode*.
2. **Calculation chain construction** — a single **linear list of all formula cells** in intended execution order. Initial order is roughly **reverse entry order (LIFO)**, then fixed up by dependencies.
3. **Recalculation** — walk the chain, evaluating dirty cells.

### The key trick: lazy, self-optimizing chain reordering
During recalc, Excel walks the chain in order; **if a formula depends on a cell not yet calculated, the formula is "sent down the chain" to be recalculated later** (the cell and its dependents get moved after the uncalculated precedent). A formula can therefore be evaluated **multiple times in one recalc pass**. Critically, per the docs: *"As part of the calculation process, Excel reorders and restructures the calculation chain to optimize future recalculations"* — the chain **converges to a valid topological order and is memoized**, so steady-state recalcs do a straight linear scan with zero graph traversal or sorting. This is why *"calculation times can often improve in a worksheet that has just been opened in the first few calculation cycles"* and why the second calculation is much faster than the first. The converged order is even persisted into the `.xlsx` file as `xl/calcChain.xml` — an ordered list of `<c r="B2" i="1"/>` cells with **no dependency information at all, only last-used execution order**; partial-calc reordering ("formulas previously ignored… move to first on the calculation chain") is explicitly described in ISO/IEC 29500.

### Dirty marking and smart recalc
- On any edit, **all direct and indirect dependents are flagged dirty** immediately (eager push phase), even in manual mode; recalc then only evaluates: dirty cells, their dependents, volatile functions, and visible conditional formats.
- **No value-equality cutoff**: *"Excel continues calculating cells that depend on previously calculated cells even if the value of the previously calculated cell does not change."* (alien-signals' version-check cutoff is strictly smarter here.)
- Pre-2007, dependency tracking had a hard limit of **65,536 unique dependency entries**, after which Excel fell back to full recalculation — evidence the dependency store was a fixed-size table, not per-cell linked lists.
- `Workbook.ForceFullCalculation` exists because *"for some complex workbooks the time taken to build and maintain the dependency trees… is larger than the time saved by smart recalculation"* — a good reminder that incremental bookkeeping is not always a win.
- Excel **deduplicates identical formulas, storing duplicates as pointers to the first occurrence** (confirmed in the TACO paper's related-work section, their ref [22]) — memory-level compression of the formula store, but not used to accelerate dependency traversal.

### Multithreaded calculation (MTC, Excel 2007+)
The chain is partitioned into **independent sections that are not interdependent** and dispatched to threads; Excel *"tries to optimize the way the calculations are spread across the cores based on the results of the previous calculation"* (thread partitioning is also memoized/adaptive). Median measured gain on a dual-core in Microsoft's study: **1.92×**; large workbooks scale *"almost linearly with physical processors."* A blacklist of functions forces single-threaded evaluation: INDIRECT, CELL("format"/"address"), GETPIVOTDATA, PHONETIC, HYPERLINK, cube functions, VBA/COM UDFs, circular-reference cells, data tables. Note the pattern: **functions whose dependencies can't be statically known (INDIRECT/OFFSET) poison both volatility and parallelism** — the same class of problem as dynamic dependency tracking in signals.

### Volatile functions & async UDFs
Volatile cells (NOW, TODAY, RAND, RANDBETWEEN, OFFSET, INDIRECT, INFO/CELL/SUMIF depending on args) are re-evaluated every recalc together with all dependents. Async UDFs: the engine saves formula state, continues down the chain, and when async results arrive runs an extra pass for their dependents.

---

## 2. HyperFormula (Handsontable): numeric-id sparse-array graph, range decomposition, partial Tarjan

Sources: [dependency graph guide](https://hyperformula.handsontable.com/docs/guide/dependency-graph.html), [DeepWiki architecture](https://deepwiki.com/handsontable/hyperformula/2-core-architecture), source: [Graph.ts](https://raw.githubusercontent.com/handsontable/hyperformula/master/src/DependencyGraph/Graph.ts), [TopSort.ts](https://raw.githubusercontent.com/handsontable/hyperformula/master/src/DependencyGraph/TopSort.ts), [DenseStrategy.ts](https://raw.githubusercontent.com/handsontable/hyperformula/master/src/DependencyGraph/AddressMapping/DenseStrategy.ts), [performance guide](https://hyperformula.handsontable.com/docs/guide/performance.html).

### Graph representation (very relevant data-layout precedent)
- Every vertex gets a sequential numeric `idInGraph`; **`nodesSparseArray: Node[]`** and **`edgesSparseArray: NodeId[][]`** (adjacency lists of numeric ids in plain JS arrays). Dirty/volatile sets are id arrays too (`dirtyAndVolatileNodeIds`).
- Edge insert dedupes with `array.includes()` — a code comment flags this O(deg) check as a bottleneck and suggests `Set<Node>[]`; a lesson on the cost of dedup in adjacency structures.
- Vertex taxonomy: `ValueCellVertex`, `FormulaCellVertex`, `EmptyCellVertex`, `ParsingErrorVertex`, `ArrayVertex`, `RangeVertex`.

### Address → vertex mapping: dense vs sparse per sheet
`ChooseAddressMappingPolicy` picks per-sheet: **DenseStrategy = `CellVertex[][]` 2D array indexed `mapping[y][x]`** (rows possibly undefined), **SparseStrategy = maps**, or `DenseSparseChooseBasedOnThreshold` by fill ratio. Configurable: `AlwaysDense` recommended for full rectangular datasets.

### Range handling without O(n²) edges
A column of `B1=SUM(A1:A1) … B100=SUM(A1:A100)` would need ~n²/2 edges. HyperFormula represents **each range as a composition: `A1:A100` depends on `A1:A99` + cell `A100`** (RangeVertex reuse; `B5:D20` = `B5:D19` + 3 tail cells). So each SUM has O(1) new edges and associative aggregates (SUM/MAX/COUNT) can **reuse the smaller range's cached aggregate incrementally**. This is a chain-of-prefix-sums summary-edge scheme.

### Recalc ordering: partial topological sort with SCC detection
`getTopSortedWithSccSubgraphFrom(modifiedNodes, operatingFunction, onCycle)` runs an **iterative (explicit-stack) Tarjan SCC algorithm** seeded from the modified/dirty node ids only. Nodes track `entranceTime`, `low`, status (`ON_STACK/PROCESSED/POPPED`); non-singleton SCCs and self-loops are marked cyclic (`#CYCLE!` results) and excluded; a `shouldBeUpdatedMapping` propagates "needs recompute" along adjacency during the sort, so only the affected subgraph is reordered and evaluated. Structural edits (row/col insert/delete) don't rewrite ASTs eagerly — `LazilyTransformingAstService` queues reference-shifting transformations applied lazily at next evaluation (default cap 50 pending transforms).

---

## 3. LibreOffice Calc: columnar cell storage, formula groups, SIMD/OpenCL/threaded group interpretation, logarithmic range-listener index

Sources: [Michael Meeks FOSDEM 2018 slides "Calc: the challenges of scalable arithmetic"](https://meeksfamily.uk/~michael/data/2018-02-03-calc-threading.pdf), [Tor Lillqvist LibOCon 2017 "Making Calc calculate in parallel"](https://conference.libreoffice.org/assets/Conference/Rome/Slides/libocon-2017-novideos.pdf), [threading default commit](https://cgit.freedesktop.org/libreoffice/core/commit/?id=5222910f969390c64c18866834d9af53e7c4c189), [tdf#65046](https://bugs.documentfoundation.org/show_bug.cgi?id=65046), source: `sc/source/core/inc/bcaslot.hxx`, `sc/source/core/data/bcaslot.cxx` (read directly from the GitHub mirror).

### Columnar, typed-block cell storage (`mdds::multi_type_vector`)
`ScDocument → ScTable → ScColumn`; each column is a **multi_type_vector of homogeneous blocks: raw `double` blocks, `svl::SharedString` blocks, `EditTextObject` blocks, `ScFormulaCell*` blocks** — i.e., contiguous typed arrays for runs of same-typed cells, with parallel columnar structures for broadcasters (listeners), notes, text widths. This is the struct-of-arrays layout in production: numeric ranges are literally `double[]` slabs that the interpreter can consume directly.

### Formula groups: one program, many cells (the big data-layout idea)
Adjacent cells in a column with the **same formula token structure (differing only by relative-reference row offset) share a single `ScFormulaCellGroup` pointing at one shared `ScTokenArray` (tokens + compiled RPN)**. Group interpretation (`InterpretFormulaGroup`):
1. Examine the RPN for "safe" cases (no INDIRECT/OFFSET/MATCH/CELL/TableOp — functions that *mutate the dependency graph during calculation*; macros blacklisted).
2. **Collect the inputs of the whole group into a linearized matrix (aggregated arrays of doubles/strings)** — input collection is done once for the group instead of per cell.
3. Evaluate the whole group as a data-parallel kernel: OpenCL-compiled from the RPN, or a software path with SSE2, or the **threaded path: rows of the group sliced across a thread pool** (`CPU_THREADED_CALCULATION`, default since LO 6.x when OpenCL is off).

Prerequisite for threading: **pre-calculate all cells the group depends on before entering threads** ("pre-calculate dependent cells to control recursion outside of threads"), so the kernel never triggers recursive `Interpret()`; thread-locals hold the calculation stack and current document; a `ScInterpreterContext` is threaded through all functions. Reported numbers: re-calculating **100k formulas over 1M doubles: 8.5s → 2.5s with 4 threads (3.4×); 4.7s → 0.86s with 8 threads (~5.5×)** — and initially the new threaded path was *slower* than the single-threaded group/SIMD path because per-cell input collection was repeated ("collecting data from sheets, branching, type handling, again and again for each formula cell — expensive; threading doesn't help"), reinforcing that **shared input gathering matters more than parallelism**.

### Range dependencies: `ScBroadcastAreaSlotMachine` (spatial hash with logarithmic slices)
Single-cell dependencies use per-cell `SvtBroadcaster`s stored columnar next to cells. Range ("area") listeners use a per-sheet **slot grid with logarithmic distribution**: from `bcaslot.cxx` — first segment slots cover **128 rows × 16 columns each**; after 32k rows the row-slice doubles (256, 512, …), and after 1024 columns the column-slice doubles, so *"upper and leftmost sheet part … gets fine grained resolution, larger data in larger hunks."* Each slot is an `unordered_set<ScBroadcastArea*>` hashed by range; a listening range is inserted into **every slot it intersects** (one refcounted `ScBroadcastArea` object shared across slots, deduped so identical ranges share one broadcaster). A cell change computes its slot offset in O(1) and intersect-tests only the areas in that slot. Bulk operations batch notifications (`ColumnSpanSet` per area). `FormulaGroupAreaListener` registers **one area listener per formula group** rather than per cell — group-level summary edges.

---

## 4. IronCalc (Rust): no dependency graph at all

Sources: [IronCalc repo](https://github.com/ironcalc/IronCalc), [docs.rs ironcalc_base](https://docs.rs/ironcalc_base), source `base/src/model.rs`.

`Model.evaluate()` is a **full recompute** driven by **demand-driven recursive evaluation with memoization**: a scratch map `cells: HashMap<(sheet, row, col), CellState>` where `CellState ∈ {Evaluating, Evaluated}`; `evaluate_cell` recursively evaluates references as encountered; hitting a cell already `Evaluating` yields `#CIRC!`. Cell storage is `sheet_data: HashMap<i32, HashMap<i32, Cell>>` (sparse nested maps). There is no incremental dirty tracking — every edit re-evaluates the workbook, each cell once. Simple, cache-unfriendly, but a useful baseline: for write-heavy workloads a memoized full sweep beats maintaining a graph (the Excel `ForceFullCalculation` lesson from the other direction). Also notable in the same ecosystem: [Formualizer](https://github.com/psu3d0/formualizer) (Rust) advertises a **CSR (compressed sparse row) edge format** for its dependency graph, topological scheduling, and optional Rayon-parallel evaluation.

---

## 5. Grist (Python engine): column-granularity nodes + Relation objects instead of per-cell edges

Sources: [grist-core sandbox/grist/depend.py](https://raw.githubusercontent.com/gristlabs/grist-core/main/sandbox/grist/depend.py), [engine.py](https://raw.githubusercontent.com/gristlabs/grist-core/main/sandbox/grist/engine.py).

- **Node = (table_id, col_id)** — one graph node per *column*, never per cell. An `Edge(out_node, in_node, relation)` carries a **`Relation` object that maps dirty rows of the precedent to affected rows of the dependent** (e.g. identity relation for same-row formulas, reference relation for lookups). This is exactly "millions of cell deps compressed into one edge + O(1) translation function" — same spirit as TACO's pattern metadata.
- Dirtiness: `recompute_map: node → SortedSet(row_ids) | ALL_ROWS`; `invalidate_deps` propagates with an iterative worklist, calling `edge.relation.get_affected_rows(dirty_rows)` per edge, short-circuiting when nothing new got marked, and collapsing to the `ALL_ROWS` sentinel for whole-column invalidation.
- Evaluation is **demand-driven with dynamic reordering via exceptions**: formulas are evaluated in batches per column; if a formula reads a cell that is itself dirty, the engine raises **`OrderError`** — the update loop *"push[es] the current work item back on the stack"* and first computes the needed cell (docstring: *"Formulas used to be evaluated recursively, on the program stack, but now ordering is organized explicitly by watching for this exception"*). Circularity detected via `_locked_cells` set. This is Excel's send-down-the-chain reorder implemented with exceptions + an explicit work stack.

---

## 6. Others: GRID, Quadratic, EtherCalc/SocialCalc

- **GRID** ([engine post-mortem blog](https://grid.is/blog/we-built-a-spreadsheet-engine-from-scratch-heres-what-we-learned)): dependency graph with **one node per range reference** (a VLOOKUP over 10k×4 cells is *one* dependency, not 40k), plus an **R-Tree to find all range references covering a changed cell**. Volatile NOW/RAND; iterative convergence for cycles. Notably: engine in pure JS; a Rust→WASM port showed gains that were *"not significant"* vs JIT'd JS.
- **Quadratic** ([repo](https://github.com/quadratichq/quadratic), [technology page](https://www.quadratichq.com/technology)): Rust core compiled to WASM, calculations modeled as transactions across formula/Python/JS cells; public docs are thin on graph internals (repo tree not accessible at research time).
- **EtherCalc/SocialCalc** ([POSA chapter](https://aosabook.org/en/posa/from-socialcalc-to-ethercalc.html), source `socialcalc-3.js` read directly): **full recalc on every edit**. `SocialCalc.RecalcCheckCell` performs an explicit-stack DFS over each formula's parsed token list — a `checkinfo[coord]` map holds per-cell traversal state (token position, range iteration cursor, back-pointer `oldcoord` forming the stack), **ranges are walked cell-by-cell** inside the DFS, on-stack revisits mark circular refs; output is a linear `calclist` executed in `setTimeout` timeslices for UI responsiveness. A cautionary baseline: per-cell range expansion is exactly what the compressed-edge schemes above avoid.

---

## 7. Academic work

### TACO — "Efficient and Compact Spreadsheet Formula Graphs" (Berkeley/UIUC, ICDE 2023; [arXiv 2302.05482](https://arxiv.org/abs/2302.05482)) — the deepest result on compressed dependency edges
Insight: **tabular locality** — adjacent formula cells (autofilled/copy-pasted) have parallel dependency structure. TACO replaces sets of parallel cell→range edges with a single **compressed edge `(prec-range, dep-range, pattern, meta)`** where `meta = (hRel, hFix, tRel, tFix)` records the relative offsets of the referenced range's head/tail vs the formula cell, or fixed head/tail cells. Four basic patterns:
- **RR (relative+relative)** — sliding windows, e.g. `Ci=SUM(A(i):B(i+2))`;
- **RF (relative head, fixed tail)** / **FR (fixed head, relative tail)** — shrinking/expanding windows (cumulative sums, `=SUM(A$1:A1)`);
- **FF (fixed)** — everyone references the same range (lookup tables);
- plus **RR-Chain** for `A2=A1+1`-style chains (direction flag `l=ABOVE/BELOW`), avoiding repeated hops through single compressed edges.

Per-pattern **O(1)** primitives `addDep/findDep/findPrec/removeDep` reconstruct exact per-cell dependents/precedents from the offsets ("back-calculating" head/tail via invariants like `d_h + tRel = prec_tail(d_h)`). Optimal compression (CEM) is **NP-hard** (reduction from rectilinear picture compression), so a greedy insert algorithm finds candidate compressed edges by shifting the new dep ±1 cell in 4 directions and querying an **R-Tree over graph vertices**; heuristics prefer column-wise compression and exploit `$` dollar-sign cues. Finding dependents = modified BFS over compressed edges.
**Numbers:** Enron dataset 23.7M edges → **1.2M (5.0%)**; Github dataset 179.8M → **3.5M (1.9%)**. Querying dependents up to **34,972× faster** than an uncompressed adjacency list + R-Tree baseline; **up to 632× faster than Excel itself** via VBA (Excel's worst case: 79.8s to enumerate dependents; TACO 442 ms); build time ~2× the uncompressed graph (16.6s vs 7.7s worst case, Enron).

### Antifreeze — "Anti-Freeze for Large and Complex Spreadsheets: Asynchronous Formula Computation" (SIGMOD 2019, DataSpread group; [ResearchGate](https://www.researchgate.net/publication/333863638_Anti-Freeze_for_Large_and_Complex_Spreadsheets_Asynchronous_Formula_Computation))
Asynchronous recalc: on edit, identify impacted cells in **bounded time** using a **lossily compressed dependency table (≤~20 bounding ranges per cell, false positives allowed)**, gray them out, return control immediately, then schedule background recomputation to **maximize the number of cells available to the user over time** (scheduling also NP-hard; on-the-fly heuristic). Related: [Transactional Panorama (VLDB 2023)](https://www.vldb.org/pvldb/vol16/p1494-tang.pdf) formalizes what users may observe during incremental refresh — **visibility, consistency, monotonicity** — a useful vocabulary for glitch-freedom guarantees when exposing intermediate states. [DataSpread](https://github.com/dataspread/dataspread-web) itself is the spreadsheet-over-Postgres system these plug into.

### The lord.io survey — ["How to Recalculate a Spreadsheet"](https://lord.io/spreadsheets/) (author of the `anchors` Rust crate)
Taxonomy directly relevant to signals: **dirty marking** (Adapton-style; wasteful when values don't change), **height-based topological recalc** (Jane Street Incremental: `height = max(input heights)+1`, min-heap of pending nodes keyed by height, O(log n) heap overhead, glitch-free by construction), **Salsa-style revision counters** (`verified_at`/`changed_at` global revisions; degenerate when unobserved inputs churn), **Adapton demand-driven dirty flags** (degenerates when observation set is stable but formulas change), and **Anchors' hybrid**: three node states — *necessary* (in Incremental's height-ordered engine), *clean*, *dirty* — unobserved nodes fall back to Adapton-style dirty marking; nodes promote to "necessary" on observation, avoiding graph walks in both degenerate cases.

---

## 8. Transferable ideas for alien-signals (synthesis)

1. **Memoized linear calc chain (Excel).** Instead of re-deriving evaluation order per propagation via linked-list traversal, maintain a persistent flat array of computed/effect nodes in last-known-good topological order; on recalc, scan linearly, and when a node reads a not-yet-updated dependency, punt it down the chain (swap/append) — amortized topological sort that converges, then becomes a branch-predictable linear sweep over a flat array. Grist shows the same reorder implemented with an explicit work stack; SocialCalc shows the fully-explicit DFS-state variant.
2. **Numeric-id + SoA graph storage (HyperFormula, Formualizer, LibreOffice).** HyperFormula ships a JS production engine storing nodes in `Node[]` sparse arrays and edges as `NodeId[][]` — node ids into typed arrays (flags, versions, heights in `Int32Array`s; CSR for stable edges, small side-arrays for churn) is a proven direction; watch the `includes()` dedup bottleneck they flagged.
3. **Summary/compressed edges for parallel dependencies (TACO, Grist, GRID, HyperFormula ranges).** Where many sibling computeds depend on the same source (or shifted windows of an array), one relation-carrying edge + O(1) row/index translation replaces N Links: 20–50× edge reduction and up to 4 orders of magnitude faster dependent-finding in TACO's measurements. For signal arrays/selectors this is the `Relation` object of Grist or the pattern-meta edge of TACO.
4. **Group interpretation (LibreOffice).** Computeds sharing one function body over different indices → dedupe to a shared "token array" (one closure + parameter), collect inputs once into a contiguous buffer, evaluate as a batch (vectorizable, thread-friendly). The LibreOffice measurement that repeated per-cell input collection erased threading gains is the key warning.
5. **Coarse spatial slots for one-to-many notification (LibreOffice slot machine).** For dependency fan-out over keyed/indexed collections, bucket listeners into logarithmically-sized slots and intersect at notify time instead of registering per-key edges; refcount-share listener objects across buckets.
6. **Height-based heaps vs chain reordering (lord.io/Incremental vs Excel).** Two ways to get glitch-free ordering without full traversal; the Anchors hybrid (necessary/clean/dirty tri-state) is the most signals-shaped formulation and maps onto alien-signals' existing flag machinery.
7. **Know when to *not* track (Excel ForceFullCalculation, IronCalc).** Dependency maintenance can dominate; a memoized full-sweep fallback (evaluate-with-Evaluating/Evaluated-marks) is trivially cache-friendly and worth having as an escape hatch/benchmark baseline.
8. **Async/partial results vocabulary (Antifreeze, Transactional Panorama).** Bounded-time dependent identification via lossy compressed dependent sets + explicit visibility/consistency/monotonicity guarantees, if alien-signals ever exposes intermediate propagation states or chunked flushes.

## Key links

- [Excel Recalculation (Microsoft Learn, XLL docs)](https://learn.microsoft.com/en-us/office/client-developer/excel/excel-recalculation) — Canonical description of dependency tree → calc chain → recalc, on-the-fly chain reordering, volatile functions, MTC
- [Excel performance: Improving calculation performance](https://learn.microsoft.com/en-us/office/vba/excel/concepts/excel-performance/excel-improving-calculation-performance) — Charles Williams-authored deep dive: calc phases, chain reorder-for-future-optimization, smart recalc, single-threaded function list
- [Decision Models: Excel Dependencies (Calculation Secrets)](https://www.decisionmodels.com/calcsecretsd.htm) — Pre-2007 65,536-dependency limit, tree rebuild triggers, sheet-order effects
- [Decision Models: Excel Calculation Process](https://www.decisionmodels.com/calcsecretsc.htm) — LIFO initial chain order, multiple evaluations per pass, first-vs-second calc costs, iteration/circular handling
- [TACO: Efficient and Compact Spreadsheet Formula Graphs (arXiv 2302.05482)](https://arxiv.org/abs/2302.05482) — Compressed pattern edges (RR/RF/FR/FF/RR-Chain), O(1) dep queries, 5%/1.9% edge counts, 34,972× vs baseline, 632× vs Excel
- [HyperFormula dependency graph guide](https://hyperformula.handsontable.com/docs/guide/dependency-graph.html) — Range-as-composition-of-smaller-ranges trick avoiding O(n²) edges
- [HyperFormula TopSort.ts (source)](https://raw.githubusercontent.com/handsontable/hyperformula/master/src/DependencyGraph/TopSort.ts) — Iterative Tarjan SCC partial topological sort seeded from modified node ids
- [HyperFormula Graph.ts (source)](https://raw.githubusercontent.com/handsontable/hyperformula/master/src/DependencyGraph/Graph.ts) — Numeric-id sparse-array node/edge storage; includes() dedup bottleneck comment
- [Michael Meeks FOSDEM 2018: Calc threading slides](https://meeksfamily.uk/~michael/data/2018-02-03-calc-threading.pdf) — mdds columnar blocks, FormulaCellGroups/shared token arrays, group interpretation, threading benchmarks (8.5s→2.5s)
- [LibreOffice bcaslot.hxx (ScBroadcastAreaSlotMachine)](https://github.com/LibreOffice/core/blob/master/sc/source/core/inc/bcaslot.hxx) — Logarithmic slot grid (128-row × 16-col slices, doubling) for range-listener lookup
- [Grist depend.py (source)](https://raw.githubusercontent.com/gristlabs/grist-core/main/sandbox/grist/depend.py) — Column-level nodes + Relation objects: compressed edges with row-mapping, ALL_ROWS sentinel, worklist invalidation
- [Grist engine.py (source)](https://raw.githubusercontent.com/gristlabs/grist-core/main/sandbox/grist/engine.py) — OrderError exception-driven dynamic reordering with explicit work stack; locked-cell cycle detection
- [How to Recalculate a Spreadsheet (lord.io)](https://lord.io/spreadsheets/) — Survey: dirty marking vs height-heap topo sort vs Salsa/Adapton/Incremental; Anchors necessary/clean/dirty hybrid
- [Anti-Freeze: Asynchronous Formula Computation (SIGMOD 2019)](https://www.researchgate.net/publication/333863638_Anti-Freeze_for_Large_and_Complex_Spreadsheets_Asynchronous_Formula_Computation) — Lossy bounded-size compressed dependent sets (~20 bounding ranges) + availability-maximizing scheduling
- [GRID: We built a spreadsheet engine from scratch](https://grid.is/blog/we-built-a-spreadsheet-engine-from-scratch-heres-what-we-learned) — One node per range reference + R-Tree covering-cell lookup; JS vs WASM performance observation
- [IronCalc model.rs (source)](https://raw.githubusercontent.com/ironcalc/IronCalc/main/base/src/model.rs) — No dependency graph: memoized demand-driven full recompute with Evaluating/Evaluated cell states
- [Working with the calculation chain (calcChain.xml, Open XML)](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-the-calculation-chain) — Excel persists last-used linear calc order (no dependency info) into the file; partial-calc reordering per ISO 29500
- [Transactional Panorama (VLDB 2023)](https://www.vldb.org/pvldb/vol16/p1494-tang.pdf) — Visibility/consistency/monotonicity framework for exposing partially-recomputed results
