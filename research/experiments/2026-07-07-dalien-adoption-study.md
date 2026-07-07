# dalien-signals → cosignals adoption study — architecture, terms, and shapes

Date: 2026-07-07. Read-only study; no code changed. Companion to the
2026-07-06 optimization port study (`dalien-optimizations-port-study.md`),
which was perf-focused; several of its rows have since LANDED in cosignals
(checkDirty wrapper + chainCheck, the FREE_NEXT freelist fix, bytecode
budgets) and one was REJECTED BY MEASUREMENT (B3 quiet-epoch). This study
answers the owner's architecture framing: naming/typing techniques, arena
de-fragmentation, the side-array strategy vs the `Computed`/`ComputedNode`/
`Map<Id, Node>` layering, and whether cosignals' kernel should rebase onto
dalien's.

Sources, as on disk:

- `packages/dalien-signals` — NOTE the submodule is the post-"userspace
  graduation" main: the **upstream-split** architecture (src/system.ts = a
  host-seam kernel taking `update`/`notify`/`watched`/`unwatched`/`freed`/
  `allocated` callbacks; src/index.ts = the whole signal library as one
  host, with the side columns, the id tier, and the callable tier). The
  fused single-file engine the 2026-07-06 study read is history.
- `packages/cosignals` — post-Great-Refactor (S0–S7) + S5R reclamation:
  graph.ts (kernel), concurrent.ts (engine), index.ts (handles),
  World.ts/WorldArena.ts/Batch.ts/WriteLog.ts/RenderPass.ts/deliver.ts/
  observation.ts/settlement.ts/Subscription.ts/engine.ts (mechanisms).
- Measured precedent: research/RESEARCH.md §1.6, research/packed-structs-
  guide.md, research/experiments/2026-07-07-great-refactor-outcome.md, and
  the dalien campaign records (memory notes; BENCHMARKS.md).

## 0. Orientation: the kernels are already siblings

Both kernels are children of the same research program (libs/arena → the
179/179 conformance lineage) and share the load-bearing DNA:

- one interleaved Int32Array arena, stride 8, premultiplied ids, record 0
  burned (dalien system.ts:114-182; cosignals graph.ts:128-232)
- link records with the FREE_NEXT=7 freelist discipline (freed links keep
  real fields intact for mid-walk stale reads) — dalien system.ts:176-181;
  cosignals graph.ts:151-166; the world arenas carry the same rule with a
  different spare field (WorldArena.ts:106-115, FREE_NEXT aliases VERSION)
- the link/linkInsert split, the checkDirty wrapper + two-level fast path +
  chainCheck + out-of-line loop (dalien system.ts:1328-1700; cosignals
  graph.ts:487-853 — cosignals' comment cites the dalien port study row 10)
- persistent Int32Array walk stacks, deferred record free at operation
  boundaries, GEN tenancy stamps, packed no-hole side columns, same-file
  const-enum discipline, bytecode-budget test suites on both sides
- FinalizationRegistry reclamation of dropped handles (independent designs,
  same posture: leaks are bugs)

The divergences are exactly where each package's product lives: dalien's
kernel is **policy-free with host seams** (its whole library is one host);
cosignals' kernel is **fused with cold policy sites** (boxes, cycle error,
lifecycle refcounts, reclamation guards) and carries the engine keying the
concurrent-worlds layer stands on. That asymmetry decides most verdicts
below, including the rebase question.

---

## 1. Candidate A — lenient branded id types  [ADOPT]

**What dalien does.** system.ts:525-535:

```ts
// Branded number types, deliberately LENIENT: any plain number is
// assignable to them (arena reads need no casts — `const dep: SignalId =
// M[l + LinkSlot.Dep]` just works), but the brands are mutually exclusive,
// so a SignalId handed where a LinkId belongs is still a compile error.
declare const IdOf: unique symbol;
export type SignalId = number & { [IdOf]?: 'signal' };
export type LinkId   = number & { [IdOf]?: 'link' };
export type SignalGen = number & { [IdOf]?: 'generation' };
```

The mechanism: the brand property is **optional**, so `number` (every arena
load, every arithmetic result) assigns freely — zero casts anywhere (the
landing commit swept all `as`-casts); but the payloads `'signal'` vs
`'link'` are incompatible, so cross-brand assignment errors. One symbol key
shared by all brands keeps them mutually exclusive by payload. index.ts:60-61
extends the idea with a phantom **value type**: `SignalIdOf<T> = SignalId &
{ [ValueOf]?: (value: T) => T }` — `get(id)`/`set(id, v)` are fully typed
through a bare number, invariant in T (the function-typed phantom).

**What cosignals does today.** Plain aliases, deliberately un-branded:
graph.ts:85-105 (`NodeId`, `LinkId`, `RecordId`, `NodeFlags`, `Version`,
`Generation`, `RecordCount`, `ValueIndex` — "zero runtime cost, no
branding, no casts") and concurrent.ts:192-236 (`NodeId` again, `NodeIndex`,
`Seq`, `Epoch`, `CommitGen`, `WalkGen`, `EvalGen`, plus Batch.ts's
`BatchId`/`BatchSlot`/`BatchSlotSet`). index.ts:870 even labels the export
group "scalar brands" — they aren't, yet. The 2026-07-05 style rule
("plain aliases, not brands — no casts in hot code") was set against
heavy brands that force casts; lenient brands satisfy the no-casts
constraint by construction, so adopting them supersedes rather than
violates that rule (memory should be updated on the ruling).

**Why it pays here specifically.** cosignals has MORE id spaces than
dalien, and they collide in the same functions:

- kernel `NodeId` (premultiplied) vs engine `NodeIndex` (dense ordinal,
  `id >> 3`-derived) — mixing these is the package's most plausible
  silent-corruption class; concurrent.ts:199-203 documents the distinction
  in prose only.
- world-arena shadow record ids (a THIRD id space, WorldArena.ts) vs kernel
  ids — `arenaCheckDirty` walks one arena while consulting kernel memory.
- `BatchSlot` (0–30 slot ordinal) vs `BatchSlotSet` (31-bit mask) vs
  `BatchId` — `1 << slot.id` sites (concurrent.ts:1855) are exactly where a
  set/ordinal swap type-checks today.
- `Seq` vs `Generation` vs `Epoch` — all compared, never mixed on purpose.

**Verdict: ADOPT.** Type-level only; zero runtime delta; zero cast risk by
the lenient construction. The one design decision: `RecordId` (the shared
bump pointer/allocator space) stays a plain `number` — the escape hatch
both `NodeId` and `LinkId` accept from and assign to (dalien has the same
shape implicitly: `allocLink` returns from the shared `recNext`).

**Migration sketch.** (S, ~half day)
1. One `declare const IdOf: unique symbol` per layout-owning file (kernel
   brands in graph.ts; engine brands — NodeIndex, Seq, BatchSlot,
   BatchSlotSet — in their owning modules; the arena's shadow-record id in
   WorldArena.ts, file-local).
2. Convert the existing aliases in place; signatures already use the alias
   names, so the sweep is mostly no-op. Fix what the compiler then flags —
   each flag is either a genuine annotation gap or a real latent hazard.
3. Do NOT brand `NodeFlags`/`ValueIndex`-style derived numbers where every
   use is arithmetic (mask results are plain `number` and assign anyway;
   brand value is nil).
4. Gates: none (tsc + docs-gate only). No bench impact possible.

---

## 2. Candidate B — arena de-fragmentation  [ADAPT — port the mass-teardown free-list ordering]

**What dalien does.** Two mechanisms, both about REUSE ORDER, not about
moving live records (nothing compacts; the arena never moves):

1. `sweepPendingFree` (system.ts:1228-1262): when a boundary sweep is a
   mass teardown — `end > MASS_TEARDOWN_RECORDS (4096) && end * 64 >=
   recNext`, i.e. the freed batch is a sizable fraction of everything ever
   allocated — the pending node frees are sorted ascending (Int32Array
   sort, pushed descending so pops come off ascending). Otherwise the plain
   loop runs; steady small-graph churn never pays.
2. `sortLinkFreeList` (system.ts:1264-1300): the link free list is
   rethreaded ascending via a **bitmap** — one pointer-chase walk marks
   record bits, then a sequential scan rethreads. No comparison sort, no
   second random-access walk.

Why: free lists are LIFO, so a whole-graph dispose hands out the HIGHEST
records first; the next graph builds scattered across the arena — side
columns lose density and neighboring nodes lose cache adjacency. Measured
(campaign records): a 2M-node dispose-then-rebuild went from ~30s to
build-from-fresh speed (create 30.1s → 2.1s, first-eval 7.3s → 285ms);
the bitmap variant took the sort from 25.7% → 7.5% of the rebuild profile
(post-teardown setup 471 → 268ms).

**What cosignals does today.** graph.ts:446-451 `sweepPendingFree` is the
plain loop; both free lists stay LIFO forever. The hazard population is
real but smaller than dalien's: React unmount storms (effect/scope
disposal cascades), `useComputed` re-key churn (`disposeComputed`,
concurrent.ts:1291-1310), and reclamation bursts all queue through
`pendingFree` and are swept at boundaries (graph.ts:1893-1920 — note the
sweep already waits for `queuedLength === 0`). Two cosignals-specific
observations sharpen the value assessment:

- The hole/dictionary-mode hazards dalien's memory notes describe are
  ALREADY defended here: kernel columns gap-fill at alloc
  (graph.ts:412-418), engine columns gap-fill at `indexNode`
  (concurrent.ts:1143-1165) and clear only within bounds
  (__onRecordFree:1331). The defrag's remaining benefit is **locality of
  rebuilt graphs** plus keeping engine `NodeIndex` assignment dense-ish
  (NODE_INDEX is slot-tied, so scattered record reuse scatters the
  ix-keyed columns exactly as much as the id-keyed ones).
- World arenas do NOT need it: they release wholesale to a pool
  (columns dropped, claimGen bumped) and renumber at quiescence — there is
  no long-lived LIFO churn inside one arena's lifetime.

**Verdict: ADAPT.** Port mechanism 1+2 into graph.ts's sweep verbatim
(the trigger arithmetic, the bitmap, the descending push). Skip any
notion of live-record compaction — neither codebase does it, and
cosignals' NODE_INDEX inheritance contract (freeNode leaves field 7
untouched, graph.ts:433) must survive the sort untouched — sorting reuse
order changes WHICH slot you get next, never a slot's index.

**Migration sketch.** (S–M)
1. `MASS_TEARDOWN_RECORDS = 4096` + the proportional trigger inside
   `sweepPendingFree`; `sortLinkFreeList` bitmap over `recNext`.
2. The record-free hook fires per freed node either way (order changes,
   count doesn't) — the engine scrub is order-independent by construction;
   assert with the existing leak-audit + reclaim suites.
3. Gates: PKG (leak-audit, reclaim, elements-kind, freelist); CONF
   unaffected (no semantic change). Add one probe bench (mass-dispose →
   rebuild, spkk1-adjacent shape) to demonstrate the win and pin the
   trigger — today no gate exercises the scenario, which is also honest
   evidence that the win is **latent** for current workloads: this is
   insurance for exactly the React unmount-storm profile the package
   targets, not a current-gate mover.
4. Deeper root-cause option, recorded not recommended: two-ended
   allocation (nodes from the bottom, links from the top) would make node
   records dense by construction and eventually let NODE_INDEX retire —
   an L-effort layout change touching every allocator/consumer; only worth
   revisiting if index-keyed columns ever dominate a profile.

---

## 3. Candidate C — side arrays, node objects, and the layer question  [ADAPT: delete the Map layer, keep object nodes, fix the naming]

The owner's framing: dalien keys everything by id in side arrays; cosignals
has `Computed` vs `ComputedNode` plus `Map<Id, SomeNodeType>`; is the array
more efficient; can the layers collapse or at least cohere?

### 3.1 What dalien does

index.ts:71-119: NO per-node engine object exists. Five parallel columns
indexed by record number (`id >> Arena.NodeIndexShift`): `currentVals`,
`pendingVals`, `fns`, `cleanups`, `owned` — plus queue twins
`queued`/`queuedGens` and the kernel-side `hostState`. Everything needed to
"do signal things" is (arena record) + (a few column rows). The public
callable is the only object, and it is just a closure over the id
(index.ts:1321-1350). This works because (a) the GRAPH lives in interleaved
Int32 records — the traversal-heavy state is one cache line per record,
one bounds-check domain; and (b) each operation touches 1–2 columns, at
distinct sites (a read touches `currentVals`; a recompute adds `fns`).

### 3.2 What cosignals does today — the full inventory

Layers per public atom/computed:

1. **Handle** (`Atom`/`ReducerAtom`/`Computed`, index.ts:531-739): public
   object, GC-owned, flat fields `_id`, `_isEqual`, `_node`, `label`
   (+`_fn` on Computed, +`reduce` on ReducerAtom). This layer is priced and
   deliberate (D7; reclamation registration rides the constructor).
2. **Kernel record** (+ kernel columns `values`/`fns`): serves newest.
3. **Engine node** (`AtomNode`/`ComputedNode`, concurrent.ts:239-351):
   allocated lazily at first ENGINE CONTENT (log entry, watcher, arena
   presence, routed read) — plain handles never create one.
4. **Registries**: `idToNode: Map<NodeId, AnyNode>` (concurrent.ts:869)
   AND its dense twin `nodesArr: (AnyNode|undefined)[]` keyed by NodeIndex
   (:916), plus per-field dense columns `lastWalk`, `evalMark`, `obsRefs`,
   `obsDeps`, `nodeToWatchers` (:909-930) — the dalien pattern already in
   use for the walk-hot state.

**AtomNode field census** (concurrent.ts:239-292), classified by hottest
consumer:

| field | type | hottest consumers | class | column-able? |
|---|---|---|---|---|
| `kind` | `'atom'` literal | every dispatch (`evaluate`, write path) | HOT (shape-discriminant, 1 monomorphic load) | would become a flag bit — only if the object dies |
| `id` | NodeId | `writeNewest` (concurrent.ts:1733,1888), delivery entry, kernel reads | HOT | it IS the key; stays |
| `ix` | NodeIndex | every dense-column probe (deliver.ts:169-173, WorldArena.ts:1285,1519,1624) | HOT | cached key; stays |
| `name` | string | traces/errors only | COLD | yes, trivially |
| `base` | Value | `foldAtom` (World.ts:560), quiet fold (:1707-1725), drop checks (:1821), compaction | HOT (logged+quiet) | yes — but co-read with `log`/`equals` |
| `baseSeq` | Seq | quiet fold, compaction | WARM | yes |
| `log` | `WriteLog` object | `foldAtom` (World.ts:558), `writeInner` push (:1843), compaction, retirement | HOT while logged | it is ALREADY six parallel packed columns inside one object (WriteLog.ts:65-138) |
| `equals` / `eqIsDefault` | fn / bool | `eqAtom` (World.ts:654), write fast-arms (:1814,1880) | HOT | fn column possible; bool column possible |
| `retirementStamp` | Seq | retirement dedup only (Batch.ts:407,421) | WARM-COLD | yes |
| `_h` | Atom \| WeakRef | cold accessor, backlink clear (:1354-1358) | COLD | must stay object-adjacent (see below) |
| `lastTouchBatch` | BatchId | `writeInner` touch dedup (:1846) | WARM | yes |

**ComputedNode field census** (concurrent.ts:308-351):

| field | type | hottest consumers | class | column-able? |
|---|---|---|---|---|
| `kind` | `'computed'` | dispatch | HOT | as above |
| `id`, `ix` | NodeId/NodeIndex | walks, arenas | HOT | keys; stay |
| `name` | string | traces/errors, cycle messages | COLD | yes |
| `fn` | ComputedFn | world evals (World.ts:775; WorldArena.ts:1067) | HOT (per world eval) | fn column possible |
| `_h` | Computed \| WeakRef | cold | COLD | as `_h` above |
| `ctxShaped` | bool | suspension fold arm (World.ts:814), resolution | WARM-COLD | yes |
| `isEqual` | Equals? | arena refolds (WorldArena.ts:1067), `changedValue` (World.ts:668) | WARM | yes |
| `prevCell` | `{value}` cell | commit update (RenderPass.ts:653), ctx.previous | COLD | see micro-cleanup below |

**Consumers that hold node REFERENCES (not ids):** `uncompactedAtoms:
Set<AtomNode>` (WriteLog.ts:166), `batch.atomsTouched: AtomNode[]`,
`obsDeps: Set<AnyNode>[]`, watcher collection buffers, `oneAtomBuf`. These
are what make the node an object identity, not just a row.

### 3.3 "Isn't an array more efficient?" — the honest, measured answer

Split the question in two:

**For the Map — yes, and the array already exists.** `idToNode` and
`nodesArr` are maintained in lockstep (indexNode:1143-1165; scrub
:1327-1347). NodeIndex is slot-tied (NODE_INDEX inherited by the slot's
next tenant, which by construction has the SAME record id), so
`idToNode.get(id)` and `nodesArr[kernelNodeIndexOf(id)]` have identical
aliasing behavior — both need the GEN stamp where staleness matters
(Watcher.nodeRecordGen already does this, RenderPass.ts:216-223). The Map
is strictly redundant. Full consumer census (14 sites): concurrent.ts:601
(lifecycle write resolution, warm), :1145 (set), :1292/:1301 (dispose,
cold), :1328/:1330 (scrub, cold), :1376 (reclaim guards, cold), :1447
(`kernelStrongDepsOf`, warm — per observed kernel re-run), :2049 (quiesce
residue, cold — and it is exactly `uncompactedAtoms`, an even better
iteration source); RenderPass.ts:217 (`resolveWatcherNode`, warm — every
watcher consumer), :651 (commit), :825/:848 (diagnostics closure);
graphviz.ts:37 (iteration). None are in the hottest loops (fold/delivery
already hold node refs), so this is a **cohesion win with a mild perf
tailwind** (two dependent array loads beat a Map hash probe on V8), not a
gate mover.

**For the node objects — no; the measurement says the opposite.** This
repo's own workload-scale spike is unambiguous: research/RESEARCH.md
§1.6 — "naive parallel column arrays were **1.8× worse than objects** on
deep chains; record interleaving (whole record in one cache line, one
bounds-check domain) is where the wins are. Trust the spike numbers." Same
conclusion in packed-structs-guide.md:84 (row 5: interleaved AoS beats
parallel SoA for graph traversal; parallel columns 1.8× worse). dalien's
side arrays win because the traversal state is in the Int32 arena and each
op touches 1–2 columns; cosignals' engine-node fields are touched
TOGETHER — `foldAtom` reads `log + base + equals + eqIsDefault` in one
pass; `writeInner` reads `log`, `eqIsDefault`, `base`, `lastTouchBatch`,
`id`, `ix` in one write. Exploding AtomNode into 8–10 per-field columns
converts one monomorphic map-checked object load into 8–10 separate array
loads with separate bounds checks — the exact shape the spike measured as
the regression. And the payloads are JS references (functions, WriteLog,
WeakRef), so none of it becomes Int32 rows; nothing about the dalien
arena's cache-line argument transfers.

Two fields CANNOT leave object-shape regardless:

- `_h` (the handle backlink): the reclamation rule is directional — handle
  pins node, node must not pin handle (concurrent.ts:264-272). A WeakRef
  per node in a column changes nothing (it would still be one WeakRef
  object); keeping it beside the fields its lifecycle is entangled with
  (clearHandleBacklink at scrub) is strictly clearer.
- `log`: it is already the packed-columns design INTERNALLY — six parallel
  arrays + start/n window (WriteLog.ts:65-138), the package's measured
  precedent that "parallel arrays for homogeneous, windowed, integer-heavy
  data" is the right tool WHERE the access pattern is columnar. Per-atom
  logs keyed by nodeIndex into global columns would entangle unrelated
  atoms' windows; per-atom objects are correct.

### 3.4 What SHOULD collapse — the recommendation for (c)

1. **Delete `idToNode`; resolve by NodeIndex everywhere** (M effort).
   Replace the 14 sites with `nodesArr[kernelNodeIndexOf(id)]` behind one
   helper (`nodeById(id)` keeping the current name); iteration sites move
   to `uncompactedAtoms` (quiesce residue — semantically exact) and a
   `nodesArr` scan (graphviz, cold). The engine surface getter
   (concurrent.ts:2249) and tests/model-view follow. This answers the
   owner's "isn't an array more efficient" with: yes — and S2 already
   built the array; the Map is the vestige. Gates: PKG (one-id-space,
   leak-audit, reclaim, model-comparison suites); no CONF exposure; SA/SPK
   untouched paths.
2. **Keep AtomNode/ComputedNode object-shaped** — they are the engine's
   RECORDS, object-shaped because their payloads are JS references and
   their fields are co-accessed. Declining the full side-array move is a
   measured decision ((§3.3), not a taste call.
3. **Make the three layers legible instead of pretending they can merge**
   (S effort, naming only). The layers are load-bearing: handle (public,
   GC-owned identity), kernel record (newest world), engine content
   (worlds/history) — merging handle+node would let engine containers
   (`uncompactedAtoms`, `atomsTouched`, obs sets) pin public handles, the
   exact leak class S5R's weak-backlink design exists to prevent. What IS
   wrong is the vocabulary: "Node" collides with the kernel's node records,
   and `_node` reads as "the kernel thing" when it means "the engine
   content". Proposal for the ruling: rename `AtomNode`/`ComputedNode` →
   `AtomContent`/`ComputedContent` (+ `Atom._node` → `_content`,
   `nodeForAtom` → `contentForAtom`, `idToNode`'s successor already renamed
   by item 1). "Content" is already the term of art in every comment
   ("engine content", "content allocation", "content-lazy"). One concept,
   one name; the kernel keeps "node record" exclusively. Mechanical rename;
   engine surface types are exported type-only, so the public break is a
   type alias re-export (`AtomNode = AtomContent` deprecated alias if
   sibling packages need a beat).
4. **Micro-cleanup:** `ComputedNode.prevCell` is a `{value}` cell allocated
   per node (concurrent.ts:334) whose only readers close over `node`
   already (ctx getter :1231; commit write RenderPass.ts:653) — flatten to
   a plain `prevCommitted` field; one dead allocation and one hop removed.

**Verdict: ADAPT** as items 1–4. Adopt dalien's *keying discipline*
(dense index over map — item 1) and its *"one system" feel* (item 3);
decline its *no-node-objects* end state on this repo's own measurements.

---

## 4. Candidate D — the f64 epoch/version stamp  [DECLINE — measured, do not retry]

dalien: slots 6-7 hold ONE float64 version snapshot read via a
Float64Array view (`versions[(id >> 1) + 3]`, system.ts:127-162, 1000);
`get`/`readComputed` serve the cached value when snapshot == globalVersion
(index.ts:446-453, 1011-1022); entry-captured stamping in updateComputed
(:799-807); stamp killed at unwatched (system.ts:1754-1768) and setFlags.
Halved stamp traffic vs two int32 stores (~4% on deep chains, per the
campaign records).

cosignals ported exactly this as B3 (2026-07-06) — completely, with the
subtleties pinned and mutation-tested — and it measured **net-negative on
every gate shape** (reads +3.1%, isolate +9.2%, write +1.5%,
deepPropagate +7.9%). Structural cause: a stamp hit requires flags to be
clean anyway, so over cosignals' one-load flags fast path the stamp is a
strictly redundant second certificate; dalien needs it because its read
ladder is heavier (retired check, getter carry, host-seam crossing). The
rejection is archived with a ceiling argument at
`research/experiments/b3-quiet-epoch-rejected/`; the port study's own
addendum says "do not retry without invalidating the ceiling argument."
Nothing in the current tree invalidates it — if anything the S5 merge made
the read path leaner. Node fields 6-7 are now LIFECYCLE and NODE_INDEX,
both load-bearing; there is no free aligned f64 slot left. **DECLINE.**

## 5. Candidate E — chainCheck / checkDirty walk shortcuts  [ALREADY ADOPTED]

cosignals graph.ts:644-853 is the full dalien family: entry wrapper with
shallow + two-level fast paths (:651-727), stackless chainCheck (:750-790),
out-of-line loop (:794-853), `updateAndShallow` (:733). Byte-budget pinned
(tests/bytecode.spec.ts, 46 checks re-pinned at S7). One residual worth
recording, not acting on: the world-arena twin `arenaCheckDirty` has NO
chain fast path — deliberate divergence (guard-countered walks, weak-subs
second list, VALID/BOX semantics; the TWINNING OBLIGATION at graph.ts:477
says port the rule, not the text); arena walks are not on the SA gates'
critical path today. Nothing to do.

## 6. Candidate F — owner-object lifetime binding + deferred registration  [DECLINE]

dalien: `createNode(owner)`/`adoptNode` (system.ts:942-966), the
`signalOwner`/`computedOwner` stamped-owner pattern (index.ts:1261-1276),
scope REGIONS (owned (id,gen) pair lists freed on a microtask,
index.ts:87, 597-629), and **deferred, bounded** registry registration
(pendingRegister + 16384-drain, system.ts:783-808 — measured: unbounded
deferral pins owners across in-burst GCs; bounded went 18.5ms → 7.7ms on
milomg createSignals).

cosignals: the handle IS the owner (Atom/Computed constructors register
`this` on the allocation op, graph.ts:1127-1133, index.ts:554, 692), and
S5R's reclamation is a SUPERSET of dalien's orphan flow — an engine guard
hook (watchers, obs retains, write logs, render arenas, suspended lists),
per-guard retry tickets, two-phase deferred cleanups, per-epoch registry
(graph.ts:1458-1855). Critically, cosignals **measured and rejected
dalien's deferral**: graph.ts:1573-1583 records the binding — "Measured
rejects: per-handle unregister keys (+103ns), WeakRef schemes (+93ns),
deferred/batched and lazy registration" — and S5R's creation budget was
accepted as a STOP finding (Atom ≈59ns; FinalizationRegistry.register
+14.2ns on this V8). The two libraries reached opposite deferral verdicts
because their creation benchmarks differ (dalien optimizes milomg
create-burst cells; cosignals priced leak-freedom per-constructor and
accepted it). No owner-parameter API belongs on cosignals' class surface —
the class instance already plays that role. **DECLINE**; revisit deferral
only if a create-burst gate ever becomes binding, and then re-measure
under cosignals' registry (the +37% burst pathology dalien found was
UNBOUNDED deferral, which cosignals never had).

## 7. Candidate G — the two-tier function/id API shape  [DECLINE public; already true internally]

dalien's README frames the library as two interoperating tiers over one
graph: callables (GC-owned, leak-free default) and the id tier
(`signalId`/`get`/`set`/`dispose` — zero allocation per node, explicit
lifetime; README.md:77-113). cosignals' public API is the class layer by
explicit ruling (D7), aimed at React apps — an id tier on the public
surface would reintroduce the manual-lifetime footguns the reclamation
campaign just closed, for users who don't need it. Internally the shape
already exists: the kernel's `Engine` op table IS an id tier
(graph.ts:305-339), and the engine surface (concurrent.ts:2185) is the
embedding tier the oracle/bindings drive. The one transferable idea is
DOCUMENTARY: dalien's README explains tier choice by lifetime discipline
("choose by lifetime discipline, not by speed") — cosignals' README could
adopt that framing for handle-vs-engine-surface. **DECLINE** as an API
change; fold the framing sentence into the docs backlog.

## 8. Candidate H — vocabulary and term alignment  [ADOPT selectively]

Where the packages already agree (keep): arena, record, premultiplied id,
burned record 0, GEN/generation, boundary, sweep, free list, side columns,
kind bits, host-owned.

Divergences worth aligning or flagging:

| concept | dalien | cosignals | recommendation |
|---|---|---|---|
| record field enums | `NodeSlot`/`LinkSlot` | `NodeField`/`LinkField` | keep cosignals' ("field" reads better against "side column slots"); no churn |
| geometry enum | `Arena` (shifts/offsets) | `RecordGeom` | keep cosignals' — more precise |
| write counter | `globalVersion` (+ f64 snapshot) | n/a (B3 declined) | nothing to align |
| tracking pass | `cycle` | `cycle` | aligned already |
| "retire(d)" | an arena/engine GENERATION retiring at growth | a BATCH's terminal transition | collision across repos; cosignals never retires engines (rebuild, no forwarding) so no internal conflict — add one disambiguating line to concurrent.ts's vocabulary block |
| "epoch" | historical name for the write counter | TWO meanings already: `engineEpoch` (test-reset counter, graph.ts:269-278) and `Epoch` (quiescence episode counter, concurrent.ts:215-216) | the internal double-booking predates this study; if any rename is taken, `Epoch` → `EpisodeId` is the honest one (its doc comment already says "episode counter") — propose for ruling, low priority |
| engine content object | (none — columns) | `AtomNode`/`ComputedNode` | → `AtomContent`/`ComputedContent` per §3.4 |
| shared record-0 scalars | `SysSlot.EnterDepth` in arena memory | module `let enterDepth` (exported read-only) | keep cosignals' — record-0 slots exist in dalien BECAUSE host and kernel are separate compilation units sharing the arena; cosignals' kernel and its "host" are one module |

**Verdict: ADOPT** the two flagged items (retire disambiguation line;
AtomContent rename per §3.4); decline mechanical renames that only chase
dalien's spelling.

## 9. Candidate I — codegen-cloned engine generations + growth posture  [ADAPT — measure first, port only on evidence]

dalien: a second instantiation of the SAME engine function literal
permanently disables V8 function-context specialization process-wide
(~1.9× walk-heavy steady state, measured); so generations after the first
compile from `String(createEngine)` via `new Function` — fresh function
identities, kept specialization — with a CSP fallback and an eager
clone-works smoke (system.ts:538-641); the host tier clones the same way
(index.ts:156-176). Precondition: the factory is CLOSED (only params +
globals free) — pinned by codegen tests on both tiers.

cosignals: growth rebuilds `createEngine` at boundaries (graph.ts:1911-
1919) — the second instantiation, so the despecialization applies in
principle. But three things temper it: (a) `createEngine` is NOT closed —
it captures cross-module imports (`lifecycleWatched`, `storeThrown`,
`boxedRead`, `POLICY_CTX`, module scalars), so the port is not a
transliteration; closing it means threading a deps record like dalien's
`EngineShared`, a real refactor of the kernel's spine; (b) cosignals'
handles route through the `E` table per call (no closure-captured M in
user-facing handles), so there is NO retired-forwarding need and the
post-growth cost profile differs from dalien's (the prior study row 9
made the same point); (c) the priced default is generous
(DEFAULT_INITIAL_RECORDS = 2^20 units = 3·2^20 records, env +
configure({initialRecords}) both raise it, graph.ts:1387-1400) — most
processes never grow. **ADAPT**: run the one missing measurement (force a
growth, re-run T0/SPK walk shapes, compare steady state) and record the
number beside the growth comment; port the codegen-clone ONLY if the tax
shows up at gate-relevant size. Do not restructure the kernel
speculatively — the SPEED IDENTITY block (graph.ts:55-62) exists precisely
to prevent casual restructuring.

## 10. Smaller parity notes (no action or ride-alongs)

- **Bytecode budgets** — both sides have them; cosignals' 46 checks were
  re-pinned at S7 with a scope-merge collision guard. Parity.
- **Microtask maintenance** (dalien system.ts:769-877): cosignals'
  reclamation already nudges via epoch-guarded microtasks
  (scheduleReclaimNudge, graph.ts:1640-1654) and its nudge runs the full
  `maybeBoundary` (growth + sweep). Residual gap: a plain dispose burst
  with no reclamation activity waits for the next public op to sweep.
  ~10-line ride-along candidate with Candidate B (schedule the nudge from
  `dispose`), not standalone work.
- **Effect-queue gen stamps** (dalien `queuedGens`, index.ts:101-105):
  cosignals instead defers ALL frees while the queue is non-empty
  (boundaryWork's `queuedLength === 0` gate, graph.ts:1904-1909). Both
  are sound; dalien's own history moved from scrubbing to gen stamps for
  JSC-quadratic reasons cosignals' design never triggers. No action.
- **Column growth micro-deltas** (prior study row 7): still open as a tidy
  ride-along (size columns only in the fresh-record branch); noise-level.
- **watched/unwatched host state**: dalien keeps it in an id-indexed array
  (system.ts:1416-1440); cosignals' lifecycle keeps a Map of ACTIVE
  records only (lifecycle.ts:64) with the dormant callback in the atom's
  own `fns` slot — cold path, sparser population; the Map is the right
  container there. No action.

---

## 11. THE REBASE QUESTION — could cosignals' kernel become (or vendor) dalien's kernel?

### 11.1 What cosignals' kernel carries that dalien's does not

Enumerated against graph.ts; each is inside the kernel because a cold site
of a HOT function needs it — the exact placements dalien's seams cannot
host without new crossings:

- **HAS_BOX / BOX_SUSPENDED sentinel boxes** — the catch sites live INSIDE
  `updateComputed` and `computedReadSlow` (graph.ts:1000-1006, 1276-1282),
  with flag-preservation rules threaded through the eval-start rewrite
  (:982-983) and the boxed read tail (:1292-1296). dalien's `update` seam
  hands the host the whole update (host does everything) — hosting boxes
  there means cosignals reimplements updateComputed host-side anyway.
- **CycleError on re-entrant computedRead** (D2, :1249-1251) — one test on
  the already-loaded flags word; upstream/dalien serve the stale cache.
- **LIFECYCLE per-link refcount** (D1) inside `linkInsert`/`unlink`
  (:538-541, :550-553) with HOST_OWNED exclusion — dalien's
  watched/unwatched fires on first/last subscriber only; cosignals' union
  refcount counts every non-engine link and excludes engine computeds.
- **HOST_OWNED flag + markHostOwned retro-release** (:1317-1336) — the
  engine/kernel ownership boundary for the observation index.
- **NODE_INDEX field 7 + dense-index assignment in allocNode + the
  record-free hook** (:391-444, 1442-1456) — the keying contract the whole
  concurrent layer (columns, arenas, watchers, use-cache) stands on.
  dalien has no equivalent field (its slot 7 is half the f64 stamp) and no
  free hook with an index payload (its `freed(id)` seam is close but the
  inherited-index contract is cosignals-specific).
- **Reclamation guard architecture** — engine guard hook, skip tickets,
  per-id retries at kernel clearing sites (unwatched's `reclaimSkippedN`
  bail, :944-951), two-phase deferred cleanups, per-epoch registry
  (:1458-1855). dalien's orphan flow (Orphaned bit + reclaim at last
  unlink, system.ts:1775-1800) is the simple special case of this.
- **POISON fold-purity table + the fold-guard swap pair** (:1415-1436,
  2011-2019) — hot paths carry zero fold instructions because the TABLE is
  swapped; dalien has no fold concept.
- **routingActive + the policy write tails** (`writeAtom`, `writeNewest`,
  :246-266, 1883-1891, 2046-2051) — same-module residency is the point
  (cyclic-import binding reads cost per-access checks; the S5 fix round).
- **The evaluation ctx** (POLICY_CTX passed to every getter, :76-83) and
  the equality wrapper reading kernel flags (index.ts:707-714).
- **Cold policy ops** on the table: invalidateComputed, disposeComputed,
  reclaimStructure, markLifecycle, activeIsComputed (D5).
- **Engine-epoch test discipline + watermark/REC_SLACK growth rule**
  (:269-278, 355-362) vs dalien's 3/4 growAt.

### 11.2 What dalien's kernel carries that cosignals' lacks

- host seams as a PRODUCT (createReactiveSystem options; the "build your
  own framework" surface, README §Build-your-own + hostPrimitives proof)
- the f64 version snapshot machinery (declined, B3)
- codegen-cloned generations + retired-engine forwarding (Candidate I)
- growCapacity/max-capacity public API, capacity units (records/MB)
- `reset()` as a public generation lifecycle (cosignals: test-only scrub)
- mass-teardown free-list ordering (Candidate B — being adopted)
- deferred bounded owner registration (measured-rejected here, §6)
- record-0 SysSlot shared scalars (unneeded in a one-module kernel, §8)

### 11.3 The seam evidence — why the split shape would cost cosignals

dalien's own upstream-split campaign is the controlled experiment: the SAME
algorithms, arena, and layout, re-hosted behind seams, ran an unattributed
**~1.08–1.18× on recompute kernels vs the fused engine** for weeks of
bisection; per-item nulls read zero (the gap was a sum of sub-noise items:
seam calls, module-slot loads, cross-unit compilation shape), and the only
thing that closed it was moving the ENTIRE hot host tier into one closed
factory closure per arena generation — at which point the split engine's
hot units matched the fused engine because they had effectively re-fused
(module-scope-vs-factory alone was measured as 26–48% fatter optimized
code for identical source). The final board reached parity ONLY with that
re-fusion plus codegen cloning. cosignals' kernel is ALREADY the fused
shape with policy at cold sites; rebasing onto dalien's seam kernel means
buying back the exact residual dalien spent that campaign extinguishing,
while ALSO porting every §11.1 item either into the host (rewriting
updateComputed/read outside the kernel — the seam-crossing tax lands on
the hottest paths) or into a fork of dalien's kernel (which is then not a
dependency, just a rename).

### 11.4 Dependency-management reality

dalien-signals is the owner's separate, published project with its own CI,
benchmarks, README claims, and release cadence; packages/dalien-signals is
a submodule that is already checked out off its recorded pointer in this
tree. A kernel dependency would couple cosignals' conformance surface
(179/179 + oracle lockstep + fuzz + divergence checker + 46 bytecode
budgets) to an external release train, and every §11.1 feature would be a
patch dalien has no reason to carry (several — boxes, CycleError — are
semantic DIVERGENCES from alien-signals that dalien, as an
alien-compatible library, should refuse). A vendored copy decays into the
fork we already have, minus the two years of cosignals-specific comments.
The evergreen-fork model that DOES work is the one already practiced: port
rules and mechanisms with attribution (the checkDirty family, FREE_NEXT,
the budgets all cite dalien in comments), keep the conformance suite as
the shared contract, and let this study + the port study be the sync
ledger.

### 11.5 Verdict

**No rebase — neither dependency nor vendored kernel.** The kernels are
siblings by construction; the valuable transfers are mechanism-sized
(Candidates A, B, C-items, I-on-evidence), and the architectural residue
(seams) is the one part dalien's own measurements argue against importing.
Continue the port-the-rule discipline; adopt the vocabulary fixes so the
sibling relationship is legible in the code.

---

## 12. Ranked recommendations (value ÷ effort; correctness/clarity first)

1. **C1 — delete `idToNode`, resolve via NodeIndex + `nodesArr`** (M).
   Directly answers the owner's Map complaint; one keying discipline
   package-wide; mild warm-path win; S2 already did the hard part.
2. **A — lenient branded ids** (S). Real hazard classes (NodeId vs
   NodeIndex vs shadow ids; BatchSlot vs BatchSlotSet) closed at zero
   runtime cost; supersedes the plain-alias style rule pending ruling.
3. **C3 + H — the AtomContent/ComputedContent rename + retire/epoch
   vocabulary notes** (S). Pure legibility; makes the three layers read as
   one designed system, which was the owner's underlying complaint.
4. **B — mass-teardown free-list ordering (sort + bitmap rethread)** (S–M).
   Insurance for the React unmount-storm profile with dalien-measured
   upside at scale; needs one new probe bench to pin; zero hot-path risk.
5. **C4 — flatten `prevCell`** (XS). One allocation and one hop per
   computed node; rides item 3's touch.
6. **I — post-growth despecialization measurement** (S measure; L port).
   Measure first; port dalien's codegen-clone only if the ~1.9× class
   shows at gate-relevant sizes. Do not pre-emptively restructure.
7. **Ride-alongs** (XS each, opportunistic): dispose-burst maintenance
   nudge (§10), column-growth micro-tidy (§10), README "choose by lifetime
   discipline" framing (§7).
8. **Declined, recorded with reasons**: full side-array node explosion
   (§3.3 — 1.8× workload-scale counter-evidence), f64 stamp (§4 — B3
   ceiling argument), owner-API + deferred registration (§6 —
   measured-rejected binding), public id tier (§7), kernel rebase (§11).
