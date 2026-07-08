# The flattening — build state

Campaign: merge packages/cosignals' kernel + concurrent machinery into ONE
arena-based engine module per plans/2026-07-08-the-flattening.md (revision 3,
FINAL — its two mechanism sections are normative: the bump table, the episode
boundary lists, the repealed equality-count pin). Branch: `flattening`.
This file is the succession log: update it BEFORE each commit; a successor
must be able to continue from it alone.

## Normative additions since the plan

- Coordinator clarification (pinned): "re-track dependencies every
  evaluation" means re-track IN THE EVALUATING WORLD'S dependency records
  only — never one always-current edge set. A transition render re-tracking
  a conditional to the a-branch leaves the committed world's edge set (with
  b) untouched until that root commits; an urgent write to b while the
  transition is pending notifies committed watchers through the committed
  edges. Enforced by concurrent-battery.spec.ts case 1
  "V-urgent-committed-branch" (cherry-picked from main 1a2da40; on this
  branch as 526f8ca). Worlds keep real per-world dependency records;
  committed-root routing persists across quiescence.

## Done

1. **Cherry-pick 526f8ca** — the V-urgent-committed-branch lockstep pin
   (passes against the current engine; must keep passing through the
   rebuild).
2. **Schema generator** (`packages/cosignals/tools/schema.ts`): schema
   types + validation + the schema instance + generators + CLI in one file
   (run via `pnpm gen` = `node --experimental-strip-types tools/schema.ts`).
   Emits (a) the marked layout region in src/CosignalEngine.ts — const enums
   NodeField/LinkField/NodeFlag/ArenaShape plus generated column scrub/reset
   functions (scrubNodeColumnsOnFree / scrubLinkColumnsOnFree /
   resetSideColumnsForTest) — and (b) the debug twin
   src/debug/layout.debug.ts (field tables, flag decoding, hydrators, column
   roster). Regen-diff gate: tests/schema-gen.spec.ts (regenerates in
   memory, string-compares; also pins marker failure modes).
3. **Engine module skeleton** (`packages/cosignals/src/CosignalEngine.ts`,
   ~3250 lines, compiling, docs-gate-clean): the whole kernel carried over
   from Kernel.ts (algorithm unchanged), suspense.ts and lifecycle.ts folded
   in as sections, plus the new clocks machinery (below). Old modules
   untouched and still live — the new module is dead code until cutover, so
   every suite stays green.
4. **CycleError moved** index.ts → errors.ts (index re-exports; public
   surface unchanged). Reason: the engine must not import the policy module
   at runtime (kills the Kernel↔index cycle at cutover).
5. **UpdatedAt clocks (bump-table rows that live at kernel level)**:
   - `clocks`: Float64Array, ONE slot per record (node slot = durable
     updated-at over tagged outcomes; link slot = observer lastValidatedAt),
     created + carried by createKernel exactly like the arena (alt-b growth
     discipline; a push-grown plain array would put a capacity check in the
     link allocator's hot path). `Kernel.clocks()` accessor; POISON poisons
     it.
   - `clockSource`: module-level f64 counter (survives rebuilds; reset by
     the test reset). Stamps are process-monotone f64 — never a wrapping
     u32 (plan's representation rule).
   - Bump sites landed: atom write acceptance (inside write()'s identity
     gate — covers standalone accepted writes, eager newest application,
     and refolds via writeNewest since all funnel through write());
     updateComputed on changed tagged outcome (both return arms);
     computedReadSlow first evaluation. updateSignal (pending→current
     promotion) deliberately does NOT bump — the node is DIRTY between
     write-accept and promotion, and observers never clock-skip a dirty
     producer.
   - Nothing READS clocks yet: readers arrive with worlds/subscriptions.

## Done (continued)

6. **Cutover** — CosignalEngine.ts is the one kernel. All `./Kernel.js`,
   `./suspense.js`, `./lifecycle.js` imports re-pointed to
   `'./CosignalEngine.js'` (src: concurrent, World, WorldArena, RenderPass,
   Batch, WriteLog, settlement, ObservationIndex, index; tests:
   trace-events, reclaim.spec, oracle-adapter, helpers, leak-audit.spec,
   arena-checker, freelist.spec); prose references to the three dead files
   rewritten to section language; Kernel.ts/suspense.ts/lifecycle.ts
   DELETED. index.ts gained the one composition line
   `__setLifecycleWritePath(__lifecycleWrite)`.
   Documented test re-points (semantics preserved):
   - tests/trace-off.spec.ts ENGINE_MODULES: the three dead paths →
     'src/CosignalEngine.ts' (same zero-cost source scans, now over the
     fused module).
   - tests/bytecode.spec.ts: two budgets re-pinned with justification —
     updateComputed 420→445 (measured 432; the durable-clock bump on both
     return arms), freeLink 40→50 (measured 42; the generated clock-slot
     scrub call). Both still under the 460 inline limit. All other budgets
     unchanged and passing (function names survived the move).

## Suites run against the fused engine (post-cutover)

- cosignals: 31 files, 360 passed, 1 skipped — GREEN (includes docs-gate,
  leak-audit, reclaim probes, bytecode budgets, concurrent battery with the
  V-urgent-committed-branch pin, fuzz, scars, equality-semantics).
- cosignals-oracle: 82 passed — GREEN.
- harness conformance: FRAMEWORK=cosignals 179/179, cosignals-concurrent
  179/179 (also alien-v3 baseline 179/179) — GREEN.
- cosignals-react (react 72 against the real fork): 72/72 — GREEN.
- NOT run: daishi concurrent verifier (separate playwright/jest harness,
  needs its own npm install; final-gate material), perf benches (lead owns
  A/B).

## Unstarted (campaign priority order)

- **(3) Worlds re-derived**: per-world dependency records under the schema
  (new record family/-ies in tools/schema.ts, layoutVersion bump), one
  arena per open world, pooled + bump-reset, clocks per the bump table
  (per-root committed clocks — never one global clock; render world
  pin-frozen). Retire WorldArena's mid-operation-growth-with-reload in
  favor of alt-b's closure-rebuild discipline. Read WorldArena.ts +
  World.ts + alt-b engine.ts world/memo sections first. The
  V-urgent-committed-branch pin is the contract for edge-set independence.
- **(4) Episodes**: episode lifecycle replaces WriteLog compaction —
  episode = first pending durable work → full quiescence; write/action
  records in JS heap, append-only, per-atom tape with immutable episode-
  start base; sealed fixed-size chunks folding into base WHOLE when all
  entries retired + below every live render pin (hard entry budget w/
  documented backpressure is the fallback if folding measures badly);
  durable handoff (canonical newest IS the durable result at quiescence);
  committed-root routing structure persists (NOT episode-lifetime);
  edges purge/re-link per re-track (append-only applies to write records
  ONLY). THE ONE SANCTIONED SEMANTIC CHANGE: compaction's per-entry
  custom-equality re-invocation at retirement dies; REWRITE the
  equality-count pin in tests/equality-semantics.spec.ts to the new
  mechanism explicitly (never silently break it). Reclamation guard: the
  old log-empty row becomes per-record episode membership (episode.holds),
  with the drop as its retry trigger.
- **(5) Observers/watchers/subscriptions as arena records** + side columns
  (values/fns/extras/clocks); subscription dependency = {lastValue,
  lastValidatedAt} (link clock slots); watchers keep lastRenderedValue;
  baselines advance only after committed render / urgent correction /
  completed recapture. Corrective delivery + mount fixups keep ALL causal
  metadata (per-write seq/batch/slot, per-batch touched sets, watcher
  pins/masks/slots/commit generations) — clocks only gate re-comparison.
  Watcher/Subscription classes + managers die; `extras` column joins the
  schema then.
- **(6) Render integration + driver** (protocol v2 contract unchanged).
- **(7) Reclamation re-expression** (episode.holds membership; teardown
  order: readers unreachable → episode refs detached → owner dropped +
  membership cleared → wholesale retry sweep at next boundary). Move the
  reclamation section to the END of the module (mission's reading order) —
  deferred until then to avoid churn.
- **(8) Suite migration** (internals-coupled tests re-point; document each).
- **(9) SSR serialize/initialize** (alt-b react.ts §13.8 shape) — LAST.
- **(10) Bytecode re-pin (unique names + collision assertion) + docs-gate
  final pass.**

## Decisions taken (plan left open / builder's choice)

- **Clock representation**: process-monotone f64 via one shared
  `Float64Array` clock column, one slot per record, indexed by record
  ordinal (id >> ID_TO_CLOCK_SHIFT, shift 3). Node slot = updatedAt; link
  slot = lastValidatedAt. Chosen over an (episodeGeneration, counter) pair
  for single-compare reads; over in-record Int32 because the plan bans bare
  wrapping u32; over a per-world clock column because links/nodes share one
  allocator and the record-ordinal keying gives both for free.
- **NODE_INDEX stays an in-record field (slot 7)** rather than the plan
  sketch's "side column if the suspense cache wants it": the layout sketch
  is explicitly "the schema's starting point; schema decides", the slot is
  genuinely spare for nodes (links use 7 as FREE_NEXT), the suspense
  request cache + record-free scrub + reclaim guard hook all key by it
  today, and an in-record field is strictly cheaper than a parallel column.
  Revisit only if slot 7 is needed for something hotter.
- **One schema file** (schema + generator + CLI in tools/schema.ts), vs
  alt-b's schema.ts + gen-layout.ts pair — the mission suggested one file;
  the regen-diff test imports it directly.
- **Generated scrub functions take the clock buffer as a parameter**
  (closure-owned buffer; values/fns are module consts) — no module mirror
  binding needed.
- **Bytecode budgets stay in tests/bytecode.spec.ts** (not moved into the
  schema like alt-b's) until the campaign-end re-pin, to avoid perturbing
  the suite mid-rebuild.
- **Coexistence strategy**: build the fused module alongside the live old
  modules; cut over atomically (one commit re-points all importers +
  deletes the three absorbed files) so the tree is green at every commit.
- **Late-bound lifecycle write seam** (`__setLifecycleWritePath`): the
  lifecycle context's set/update needs the POLICY write path (policy
  asserts + engine-internals dispatch), which lives in index.ts; the old
  lifecycle.ts imported index at runtime (a cycle). The engine now exposes
  a setter index calls once at composition. Dies when the policy write
  dispatch itself moves into the engine.
- **Section order note**: the module currently reads storage → kernel →
  clocks → op table/growth/reclamation (as carried) → evaluation policy →
  lifecycle. Worlds/episodes/observers/render sections will land after the
  clocks section; the reclamation section moves to the end when it is
  re-expressed (priority 7). The mission's final order is normative for the
  finished file, not each intermediate commit.

## Deviations from the plan (with reasons)

- None semantic so far. The clocks column is WRITE-ONLY until worlds and
  subscriptions land (the plan's readers); bump sites match the bump table
  rows that exist at kernel level today.

## Done (continued 2)

7. **WorldArena moved into the engine** (verbatim carry, commit pending at
   the time of writing): src/WorldArena.ts's whole body — the
   ArenaField/ArenaLinkField/ArenaFlag/ArenaGeom/ArenaWalk const enums, the
   WorldArena class, the arena walk family, createWorldArena — now lives in
   CosignalEngine.ts as the "world arenas" section (after the test-reset
   seams; section shuffle comes with the re-derivation). This is a
   PREREQUISITE for the schema re-derivation: generated layout enums must
   be same-file with the hot arena walks. Adjustments in the move: the
   local `type Generation` and duplicate WALK_STACK_SEED dropped (the
   engine's own serve); InvariantViolation joined the engine's errors
   import; type-only imports of EngineCore/World (World.ts) and the entity
   types (concurrent.ts) added — ERASED at emit, so the engine still never
   imports machinery modules at runtime. Importers re-pointed (RenderPass,
   NotificationQueue, ConcurrentEngine, World, concurrent,
   tests/one-id-space). trace-off re-points documented: the dead
   WorldArena.ts path left ENGINE_MODULES (covered by the CosignalEngine.ts
   entry) and the trace-slot line scan.

## Done (continued 3)

8. **Worlds re-derived under the schema (priority 3)** — layoutVersion 2:
   - tools/schema.ts restructured into two domains (`kernel`, `worldArena`),
     each with families/flag enums/shape enum; the world domain adds the
     per-instance column roster (nodeToShadow, vals, suspIdx, walk,
     weakSubs, weakSubsTail, clocks) with grow/evict/release metadata. The
     generated region now also emits ArenaField/ArenaLinkField/
     ArenaLinkMode/ArenaFlag/ArenaGeom (module-local, same-file with the
     hot walks) and three world column functions: growWorldArenaColumns
     (the grown-together loop), scrubWorldShadowColumnsOnEvict (vals +
     clocks), resetWorldArenaColumnsOnRelease (every column). The
     hand-written Arena* enums are deleted; values identical.
   - **Growth re-expression (the retired reload style)**: WorldArena
     buffers are now RESIZABLE ArrayBuffers (maxByteLength =
     ArenaGeom.MAX_BUFFER_BYTES = 2^28, virtual reservation) with
     length-tracking views; arenaGrow resizes IN PLACE, so buffer identity
     never changes and every cached view/local stays valid across growth
     BY CONSTRUCTION — the hand-maintained "re-load a.memory after any
     allocating call" discipline is gone. Rationale documented in the
     WorldArena.buffer doc: per-arena closure rebuilds would allocate per
     claim and go polymorphic; boundary-only growth would break the pinned
     mid-op growth capability (arena-sa2/sd shrink arenaInitInts to force
     it). PERF NOTE for the lead's A/B: length-tracking RAB-backed typed
     arrays carry a small V8 bounds-check cost vs fixed arrays — if the
     arena walks regress, the documented fallback is fixed views refreshed
     per operation + per-access reads on alloc paths.
   - **World clocks (bump table)**: per-record float64 clock column per
     arena (shadow slot = the node's per-root committed clock — per-root by
     construction since each root owns its arena; link slot reserved for
     subscription lastValidatedAt, priority 5). Bumps draw from the
     engine's ONE clockSource and are gated on `WorldArena.bumpsClocks`
     (committed arenas only — render worlds are pin-frozen; the gate is set
     per tenancy at claim). Bump sites: arenaUpdateShadow (changed atom
     refold), arenaFoldOutcome (changed value outcome; fresh suspension),
     arenaNoteThrow (thrown outcome — conservative unconditional bump:
     spurious bump = one extra re-compare, missed bump = stale-skip bug).
     Cold materialization (prevValid=false) counts as changed and bumps —
     observers at lastValidatedAt=0 re-compare anyway. NOTHING reads world
     clocks yet (readers land with subscriptions, priority 5).
   - Bytecode re-pin: arenaFoldOutcome 340→385 (measured 367; the two
     bump arms), justified in the table. All other budgets unchanged.
   - Suites after this unit: cosignals 360 green, react 72/72, conformance
     179/179 ×2, oracle 82 green.
   - NOTE (flake watch): one bytecode-spec run showed a transient
     "smoke exercises every budgeted function" failure (16 arena fns
     reported uncovered) that vanished on re-run — suspect the
     lastIndexOf('@@SMOKE-START') marker parse can land on a late
     constant-pool dump under unlucky compile ordering. If it recurs,
     harden the marker parse (e.g. match the line-anchored bare marker).

## In progress / exact next actions

**Priority 4 — episodes (batches/log/handoff/drop).** Nothing started.
The write/action records, batch bookkeeping, and render-attempt worlds
become episode-lifetime JS-heap state dropped wholesale at quiescence;
WriteLog compaction is replaced by the episode lifecycle (sealed chunks
folding into base whole; durable handoff at quiescence; the ONE sanctioned
semantic change is the equality-count pin rewrite in
equality-semantics.spec.ts). Read WriteLog.ts + Batch.ts +
concurrent.ts's log/batch sections + settlement.ts first; the plan's
"Episode lifecycle replaces compaction" section is normative, including
the boundary lists and the reclamation membership row
(episode.holds).

## Environment notes for successors

- Fresh worktree needs `mise trust`, then `pnpm install` (lockfile churn
  stays UNCOMMITTED per mission), then submodules for the full gate:
  `git submodule update --init vendor/react upstream-alien-signals`;
  upstream-alien-signals needs its prebuilt esm/cjs/types copied from the
  main checkout (`cp -R /Users/jitl/src/alien-signals-opt/upstream-alien-signals/{esm,cjs,types} upstream-alien-signals/`)
  followed by `pnpm install --force`; the react fork builds with
  `./fork/build-react.sh` (run it ONCE, from a clean vendor/react/build —
  a concurrent second run nests the mv and corrupts the layout; fix is
  `rm -rf vendor/react/build` + rebuild).
- Commit with explicit paths only; never push. NEVER touch
  packages/dalien-signals, packages/cosignals-alt-a, packages/cosignals-alt-b,
  milomg-reactivity-benchmark, pnpm-lock.yaml, spec/, harness/results,
  vendor/react, plans/, research/.
- Docs-gate bans (shipped sources): "mint*", the word "plane" (say arena),
  the word "token" (say batch), § references, plans// research/ paths,
  research-stage shorthand in comments. The generator's output must stay
  clean too (it lands in src/CosignalEngine.ts, which is scanned).
- Do NOT run perf benches (the lead owns A/B).
- Known pre-existing (NOT flattening-caused): react-seam-bench's typecheck
  fails on its dalien adapter (`Cannot find module 'dalien-signals'`) even
  with the submodule initialized — the dalien package likely needs its own
  build; its cosignals-facing code typechecks fine. Ignore unless working
  on that bench.

## Run log

- Run 1 (first builder): commits 526f8ca (cherry-pick), b144141 (schema +
  skeleton + clocks), 0e97bee (kernel cutover), 0e741c3 (world-arena move).
  Tree at run end: flattening @ 0e741c3, only pnpm-lock.yaml uncommitted,
  cosignals 360 green / react 72 / conformance 179×2 / oracle 82.
  Next action: priority 3 step 1 in "In progress / exact next actions".
