# Ten reactivity libraries to build

Brief: ten libraries **roughly semantically equivalent to alien-signals**
(auto-tracked signal/computed/effect, lazy computeds, dynamic deps,
equality cutoff, glitch freedom, nested effects + cleanup, batching) but
**not required to derive from its code or concepts**. Each entry names its
design lineage, the mechanism, where it should win, and its main risk.

Companions: [RESEARCH.md](./RESEARCH.md) (§refs), [LIBRARIES.md](./LIBRARIES.md)
(vendored source studied for each lineage).

**Shared ground rules** (evidence in RESEARCH.md):
- Conformance gate: upstream tests + 180-case reactive-framework-test-suite
  green before reporting any number (PR #95 and the spike's 20%
  over-recompute both prove fast-but-wrong is easy).
- Benchmarks: milomg suite, one framework per process, per-shape reporting,
  mean/p99 + GC time alongside fastest-of-N, `--jitless` pass.
- Layout facts already paid for: record interleaving ≫ parallel columns;
  const buffer bindings with **closure-rebuild growth** (segment tables
  +35–40%/access and resizable ArrayBuffers +66–83% are measured rejects
  — v8-growable-buffer-bindings note, RESEARCH.md §7); one packed
  `unknown[]` value column; never truncate arrays (endIndex/validity
  flags); no object pooling of short-lived nodes; no WASM core.

**Control (not one of the ten): tuned alien-v3.** Persistent scratch
stacks replacing propagate/checkDirty cons cells + Preact-style global
quiet epoch. Days of work, upstreamable, and it raises the bar every
library below must clear.

---

## 1. `arrayd` — anod-lineage array core with auto-tracking

**Lineage**: anod (vendored deep-dive), S.js `source1`, Solid 1.x slots.
**Design**: no edge objects at all. Inline `dep0`/`sub0` fields + array
spill per node; tombstoned subscriber arrays with threshold compaction;
scratch-stack dep reconciliation that allocates a new deps array only on
divergence; clock stamps (`time`/`ctime`/scratch-stamp `SEED+=2`) instead
of per-edge versions; level-bucketed phased flush. Unlike anod: keep
alien's ergonomics (global auto-tracking, two-slot signal values,
parent-chain effect ordering) so it's a drop-in semantic equivalent.
**Should win**: wide fan-out (anod's −37%t/−89%h evidence), creation,
GC pressure, unstable.
**Risk**: deep chains (alien +17% over anod there) — inline `dep0` chain
walking must close that gap.
**Effort**: 2–3 weeks. The highest-confidence challenger.

## 2. `arena` — interleaved-record data-oriented core ★flagship

**Lineage**: in-house DoD spike (§7), samara slotmap, leptos, mraleph's
source-map Int32Array, bitECS.
**Design**: stride-8 `Int32Array` records for nodes and links (or
idea-1-style array edges inside the arena — A/B), packed `unknown[]`
values, kind-bits-in-flags dispatch, free lists, closure-rebuild growth
(engine factory over const buffers, swapped at operation boundaries),
per-system arena instances, full v3-equivalent semantics
including exact re-run trimming. Handles = bound closures over ids.
**Should win**: creation (spike: 6×), memory (~2.5×), write throughput
(1.6×), everything at large graph scale (samara: 6× at 1000×1000).
**Risk**: suite-scale lifecycle (the spike's documented loss) — arenas,
reclamation, and conformance are the actual project.
**Effort**: multi-week. De-risk stage: links-only arena under object
nodes.

## 3. `pull` — epoch/liveness core (no subs lists for lazy nodes)

**Lineage**: Angular signals, signia, Salsa, Vue 3.5 — none of alien's
push machinery.
**Design**: global epoch (+ Salsa durability lanes: 2–4 counters by
change-frequency class); per-node `changedAt`/`checkedAt`; lazy nodes
store `(dep, epochSeen)` pairs and validate by pull only — **writes to
unwatched subgraphs are O(1)**; only the effect-reachable region keeps
reverse edges for push notification (Anchors' necessary/clean/dirty
transitions, cached). Signal writes bump epoch; quiet reads are one
compare.
**Should win**: lazy-heavy (`lazy80%` dynamics, sBench never-read,
avoidable — chasing alpha's 1.6× featurelessness dividend structurally),
mixed hot/cold app graphs (durability).
**Risk**: read-heavy stable graphs with frequent unrelated writes
(O(deps) revalidation per epoch bump) — kairo diamond/mux guard rails.
**Effort**: 2–3 weeks.

## 4. `heights` — eager topological scheduler core

**Lineage**: Jane Street Incremental V7, Solid 2.0 `heap.ts` (both
vendored/studied) — no Pending flags, no verification DFS.
**Design**: live region recomputes in height order from bucket queues
(`heads[height]` + intrusive `nextInHeap`, monotone min cursor — O(1)
push/pop, no comparators); `can_recompute_now` single-parent bypass
(chains never touch the queue); adjust-heights on edge add doubles as
**cycle detection** (fixes upstream #123's hang); two stamps per node for
cutoff; lazy region delegates to pull (pairs with #3 = Anchors).
**Should win**: convergent shapes (diamond/triangle/mux — no double
marking or re-walks), deep chains via bypass.
**Risk**: height churn under `unstable`'s dep flips — the designated
stress test.
**Effort**: 2–3 weeks on #2's substrate.

## 5. `omt` — order-maintenance timestamp core

**Lineage**: Acar's self-adjusting computation; Spineless Traversal
(2024: 1.80× mean over dirty-spine walking on 83% of 2,216 layout
benchmarks); the 2025 incremental type checker. Never tried in a JS
signals library.
**Design**: every node carries an order-maintenance timestamp giving its
from-scratch evaluation order; timestamps are O(1) to maintain under node
insertion (no height cascades); dirty nodes go into a PQ keyed by
timestamp; recomputation replays from-scratch order touching **no clean
intermediate nodes**. The OM structure (Dietz–Sleator two-level tags in a
Uint32Array/Float64Array) is the interesting engineering.
**Should win**: everything #4 wins, plus graphs that restructure
frequently (where height adjustment cascades) — dynamic suites.
**Risk**: OM relabeling constants in JS are unproven; PQ overhead vs
bucket arrays.
**Effort**: 3 weeks. The most research-flavored bet, with the freshest
supporting evidence.

## 6. `chain` — learned linear calc-chain core

**Lineage**: Excel's converged calc chain (persisted to disk it's so
valuable), Grist's OrderError reordering; À-la-Carte "restarting
scheduler". Never tried in a signals library.
**Design**: live region keeps a `Uint32Array` chain in last-known-good
topo order + hierarchical dirty bitset; writes set a bit (O(1), cheaper
than any propagate); flush sweeps from `minDirtyPos`, punting order
violations down the chain — converges once, then steady-state recalc is
a branch-predictable linear array scan with equality cutoff (which Excel
lacks). Density threshold falls back to ordinary marking.
**Should win**: steady-state repeated updates on stable graphs — the
entire warmed kairo suite, cellx, molBench — approaching the theoretical
floor.
**Risk**: cold start, shape churn, effect-ordering constraints encoded as
chain constraints. Highest variance; best writeup even if it loses.
**Effort**: 3+ weeks.

## 7. `bound` — static-deps-first core with dynamic escape hatch

**Lineage**: anod's bound mode (`compute(dep, fn)` — "significantly
faster", tracking skipped entirely), Svelte's compiler-known deps,
LibreOffice formula groups.
**Design**: the API makes **fixed dependencies the default fast path**:
`computed([a, b], (av, bv) => ...)` compiles to a node with inline dep
slots, no tracking, no reconciliation, no cursor — recompute is a direct
call with pre-read values. Auto-tracked `computed(fn)` remains available
(idea-1 machinery) for dynamic graphs; a hybrid node can start bound and
degrade to tracked on first untracked read. Group evaluation as a stretch:
N bound computeds sharing one body evaluate as a batch over packed inputs.
**Should win**: every static-graph benchmark (most of the suite is
static!); real-world derived-state code where deps are obvious.
**Risk**: it changes the *authoring* contract (opt-in explicitness) —
semantically equivalent output, different API feel. Conformance suite
still applies to the tracked mode.
**Effort**: 1–2 weeks over #1.

## 8. `keyed` — summary-edge collection core

**Lineage**: TACO compressed pattern edges (23.7M→1.2M), Grist
column-nodes + Relations, HyperFormula range decomposition, Nominal
Adapton keys.
**Design**: structured fan-out gets one summary edge instead of N links:
`selector(source, key)` / `mapArray(list, fn)` register a relation
(key→subscriber map, range pattern) on the source; a write resolves
affected subscribers in O(changed keys). Keyed memoization for list
computeds. Core graph underneath can be any of #1–#4.
**Should win**: stores with 10k subscribers where one key changes,
grid/table shapes — O(Δ) vs O(N) is unbounded; needs a dedicated
benchmark (the suites under-represent this).
**Risk**: not a suite-mover on kairo; API surface design is the work.
**Effort**: ~2 weeks, orthogonal.

## 9. `delta` — diff-propagation core

**Lineage**: signia's `computeDiff` + `HistoryBuffer` (production DBSP-
lite, vendored), DBSP's `Q^Δ = D∘↑Q∘I`.
**Design**: edges optionally carry **diffs, not just invalidation**: a
computed can declare `(prev, diffsSinceMyEpoch) => next`, consuming each
upstream's ring buffer of `[fromEpoch, toEpoch, diff]` entries; falls
back to full recompute when the buffer can't bridge the gap
(RESET_VALUE). Collection signals push add/remove/update deltas; linear
combinators (map/filter) pass deltas through untouched.
**Should win**: incremental maintenance of large derived collections —
sorted views, indexes, aggregations — where recompute is O(N) today.
Complements #8 (that compresses edges; this changes edge payloads).
**Risk**: API complexity; epoch bookkeeping must not tax non-diff users.
**Effort**: 2–3 weeks over #3 (it wants the epoch substrate).

## 10. `sweep` — no-graph memoized-revalidation baseline

**Lineage**: IronCalc (no dependency graph at all), Excel
`ForceFullCalculation`, and the finding that dependency bookkeeping can
cost more than it saves.
**Design**: signals bump a global epoch and record their own
`changedAt`. No subscriber lists anywhere. Computeds memoize with
`(deps, epochsSeen)` recorded on first run; reads revalidate by
comparing dep epochs (recursively, memoized per flush with an
Evaluating/Evaluated mark — cycle detection for free). Effects
re-validate on every flush; a flush happens per batch. That's the whole
library — maybe 200 lines.
**Should win**: small graphs (< a few hundred nodes — most real apps!),
write-heavy workloads, creation benches; and it calibrates *exactly* how
much every other library's bookkeeping buys.
**Risk**: O(effects × deps) per flush at scale — it's supposed to lose
big somewhere; the point is the crossover curve.
**Effort**: days. Build first after the control.

---

## Cross-cutting techniques (apply to any of the ten)

From the second research wave (RESEARCH.md §7a):

- **Runtime linear-chain fusion** (Lowering/Flapjax): inline a computed
  into its subscriber when it has exactly one subscriber, isn't watched,
  and its equality cutoff never fires (track a "cutoff ever hit" bit;
  de-fuse on divergence). 2.8–78× in FrTime programs; never tried in a
  TS signals library. Biggest fit: `chain` (#6) and `bound` (#7), where
  fused bodies become straight-line code.
- **Constant/dead-region elimination**: a node with no `Mutable` ancestor
  can never change — snapshot its value and unlink its whole region.
- **Source-ID bitmask skip-filter** (SID-UP): fixed-width per-node bitset
  of reachable source ids (hashed); skip marking/pulling subtrees whose
  mask misses the writing source. Only for wide graphs with localized
  writes; bound the maintenance cost with 64-bit masks.
- **Subtree version summaries** (SKStore's TickRange): fan-in nodes carry
  max-child-version so pull validation prunes clean regions in O(log)
  instead of walking every dep.
- **Order-preserving removal is a correctness constraint** (two Rust
  codebases document nested-effect ordering breakage under swap-remove):
  tombstones and linked lists are safe; swap-remove is not — this
  validates #1's tombstone design and constrains #2's edge arrays.
- **Scope create/dispose benchmark** (from leptos's suite): add it to the
  matrix — arena designs win bulk-free, refcount/object designs pay churn;
  the existing suites don't measure disposal at all.

**Honest tension to resolve by measurement, not argument**: the FRP
literature (FrTime PQ re-keying, Scala.React abort-hoist-retry, Garnet
TOPLAS 2001 "mark-and-sweep generally outperforms topological sorting")
argues *against* #4/#5's scheduled designs under dynamic edges — while
Solid 2.0 ships heights in production and Spineless (2024) shows OM-PQ
beating dirty-spine walking 1.80× mean. Both camps have real data on
different workloads; that's exactly why #4/#5/#6 are framed as an A/B/C
on one substrate.

## Portfolio logic & build order

Three families, so failures are informative:
- **Layout bets** (1, 2, 7): same push-pull semantics, cheaper edges.
- **Scheduler bets** (4, 5, 6): delete verification/marking walks.
- **Complexity-class bets** (3, 8, 9, 10): change what work exists.

```
control (days) → 10 sweep (days) → 1 arrayd → 7 bound (on 1)
                                  → 2 arena  → 4 heights / 5 omt / 6 chain (A/B/C on 2)
                                  → 3 pull   → 9 delta (on 3)
                                  → 8 keyed  (on any)
```

Shared harness from day one: one `ReactiveFramework` adapter file per
library, conformance runner, per-process benchmark script, per-shape
result table. The deliverable isn't one winner — it's the shape→design
map with honest numbers.
