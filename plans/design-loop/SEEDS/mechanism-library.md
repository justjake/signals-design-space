# Mechanism library (frozen seed): parts à la carte

Extracted mechanisms from four legacy design attempts (labeled A log-overlay,
B versioned-core, C forked-worlds, D minimal-kernel — labels are provenance
only) and their synthesis. Authors may adopt, adapt, or ignore any of these
— **but may not read the legacy specs themselves** (whole designs anchor;
mechanisms don't). **None of these is a default**: a design that uses none
of them and walks the battery is at no disadvantage. The binding constraints
live in `requirements.md`; the binding *facts* (what measured fast or slow)
live in `research-facts.md` — innovate new structure from those facts
freely. Each entry: what it is / what it solves / known cost or caveat.

## Proven artifacts available for reuse (optional, not prescribed)

- **Arena kernel** (`libs/arena/src/index.ts`): alien-signals v3 semantics on
  one Int32Array plane, stride 8, interleaved node+link records,
  premultiplied ids, DEPS_TAIL re-track cursor, iterative walks with
  persistent scratch stacks, `link`/`linkInsert` split. 179/179 conformant,
  beats alien-signals on every tier-0 shape. Available as a starting point
  or as an existence proof of what the layout class achieves; a design may
  propose a different layout if it respects the measured facts (and prices
  the deviation).
- **Closure-rebuild growth**; watermark slack; deferred frees + GEN
  generation counters; free-list discipline. (Substrate.)
- **Schema/codegen**: `tools/schema.ts` single source → const-enum region,
  debug-twin hydrators, docs tables, invariant sweeper, budget table;
  regenerate-and-diff CI. (Process, settled.)
- **Wrapper + sentinel boxes** (A §11): custom equality/errors/suspense as
  policy wrappers returning reference-stable values/boxes — kernel compares
  identity only, stays monomorphic. Solves policy-in-kernel pollution.
- **Host protocol** (D §6.3): kernel as closed integer engine with four host
  callbacks (`refresh/notify/watched/unwatched`), values owned by policy.
  Solves: kernel swappability, feedback isolation. Cost: one callback
  indirection per recompute (UNMEASURED — spike) with a codegen-fusion
  fallback.

## Multi-world value semantics

- **Per-atom write tape + base record + global seq tickets** (A §9, D §7.4
  equivalently): every write in React mode appends {op, batch, seq,
  retiredSeq}; worlds fold by filtering + replay in seq order. ONE known
  mechanism producing the settled semantics of DECISIONS D3 — the semantics
  are required, this representation is not. Caveat if adopted: always-log is
  load-bearing (C2); coalescing legal only with no open pass.
- **Visibility rule as math** (A §10.2 = D §7.4 read rule): entry visible
  iff (retired ≤ pin) or (batch ∈ include-mask and seq ≤ pin). This is the
  clause-for-clause statement of React's lane filtering — any design's world
  answers must AGREE with it (D3), however they are computed.
- **Writer's-world** (A §10.2): retired ∪ applied ∪ own-batch — the world a
  batch's own render will show; useful for pre-render cutoff decisions.
  Caveat: eager per-write evaluation against it is the expensive shape.

## Per-world staleness & invalidation (the contested axis — C1 lives here)

- **Second kernel for the head world** (D §4.4/§7.6): K1 lazily shadowed
  from K0, **head evaluations re-track their real deps in K1**, bulk-reset at
  unfork with epoch-guarded ids. Solves C1/C4-class problems structurally
  (the pending world has a real topology). Costs: shadow-sync obligation for
  canonical re-tracks while forked (dev-mode brute-force validator
  specified); K1 memory (~128 KiB, reused warm); notify granularity needs a
  per-batch fix (ARMED is once-per-staleness → C4 gap; a K1 subscriber walk
  with per-token dedup is sound because K1 edges are real).
- **Per-link world bits + union-follow propagation** (B §8.2/§9.2/§9.3):
  pending-view evaluations tag links with slot bits; propagation follows
  committed ∪ writing-slot bits. Solves C1 in one kernel. Cost: invades
  every hot walk (per-link AND, view-parameterized checkDirty) — the exact
  cost class the kernel's wins came from; judged disqualifying for the
  primary walks, but fine for a *separate* overlay structure.
- **Per-slot write clocks** (B §6.5/§8.1): `slotWriteSeq[k]` bumped on every
  k-write; any cached value for a world containing k validates against it.
  Coarse (any k-write invalidates all k-view caches), sound, trivially
  cheap. The simplest known validity mechanism for world-value caches —
  prefer it over per-read certificates unless re-validation cost measures
  too high.
- **Overlay marks + era floor** (A §8.7.2/§9.7): per-node walk-ticket stamps
  meaning "worlds may disagree below here"; O(1) bulk clear by raising the
  floor. Solves the read-gate fast path. Caveats (from review): the mark
  invariant must cover urgent-created history (C2 one node downstream), and
  mark-stopped walks cannot deliver per-batch notifications (C4); marks are
  a fast-path filter, never the notification mechanism.
- **Compensated single kernel** (A-repaired, review 2026-07-04T08-52):
  full read-certificates (all reads, tail-seq-or-0) + per-slot registries of
  world-memoized nodes + drain re-validation (writing slot on deferred
  drains, all live slots on urgent) + evaluate-then-recheck for fresh nodes.
  Works; four cooperating mechanisms with semantic completeness obligations.
  This is the fallback shape if second-kernel costs disqualify D-style.

## Per-world value storage

- **Speculation plane + (node, world) shadow chains** (C §7.3): bump-only
  side plane, chain per node, bulk episode reset, mid-episode compaction.
  Good storage shape if you need per-world caches outside a kernel.
- **Two-slot value dance** (D §7.1 pending/base + head/headPending): change
  cutoffs per world without history. Pairs with tape for mixed passes.
- **Copy-out / preserved records** (C §10.5): protect paused non-including
  passes from in-place canonical overwrites at the (audited, few) overwrite
  sites. Only needed by designs that mutate canonical state in place while
  passes are pinned; a pin+retention rule on the tape (A §9.6) is the
  alternative that needs no audit.

## Batch & world lifecycle

- **Integer batch tokens** (all): `(serial<<1)|deferred`, minted lazily,
  never reused while live; ≤31 live ⇒ 5-bit slot interning + 32-bit include
  masks; slot recycles only when its unswept-entry count is 0.
- **Registry edges** (fork): claim / mint / pending(+microtask backfill) /
  finish(+per-root commit lock-in) / close(+async-action parking). Proven in
  the previous-generation fork's reconciler suite.
- **Episode/quiescence resets** (A §9.7, C §10.8, D unfork): plane bump
  reset + epoch/era bump + counter restart. Rule from review: every counter
  reset must be paired with an epoch bump or generation check on everything
  that retained the old counter's values (C13).

## React binding mechanics

- **Watcher = setState in the writer's context** (all four; the load-bearing
  trick): notify synchronously in the writer's stack so React assigns the
  writer's lane; batching/entanglement/loop-limits inherited. Grouped drains
  must preserve per-write batch context (C6) — `runInBatch` or per-write
  delivery.
- **Reconcile check at fold** (D §8.3): on retirement folds, compare the
  watcher's last-rendered value before bumping — makes commit-time folding
  invisible to already-correct components.
- **Post-subscribe fixup + batch entanglement** (A §13.2 / fork §6.5):
  layout-effect re-check of the render-to-subscribe gap; corrective setState
  scheduled INTO the pending batch's lanes via `unstable_runInBatch`
  (retired-token fallback → urgent). Solves C10.
- **Per-world positional thenable caches** (A §12.3 / D §7.7): stable
  suspense identity across replays; the cache key across multi-batch passes
  is an open problem (C15) — candidates must define it (fork-provided render
  lineage id is the known clean answer).

## Testing/process mechanisms (inherit wholesale)

- Randomized replay oracle built BEFORE the machinery (B's contribution);
  invisibility tests (whole conformance suite inside a synthetic episode);
  frozen-kernel contract suite; bytecode-budget CI; pre-registered
  experiments; per-milestone numeric gates with re-runs; useReducer
  side-by-side differential; react-concurrent-store 14-scenario harness.
