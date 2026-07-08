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

## In progress / exact next actions

**Cutover (next step)**: make CosignalEngine.ts the one kernel.
1. Re-point every `from './Kernel.js'` import to `'./CosignalEngine.js'`:
   concurrent.ts, World.ts, WorldArena.ts, RenderPass.ts, Batch.ts,
   WriteLog.ts, settlement.ts, ObservationIndex.ts, index.ts (also its
   `export ... from './Kernel.js'` lines), suspense.ts + lifecycle.ts
   consumers (concurrent.ts imports `./suspense.js` seams; ObservationIndex
   imports lifecycle seams via index).
2. index.ts: re-export SuspendedRead/__ctxUse from './CosignalEngine.js';
   import __resetLifecycleForTest etc. from it; add ONE new composition
   line: `__setLifecycleWritePath(__lifecycleWrite)` (the engine's new
   late-bound seam replacing lifecycle.ts's runtime import of index).
3. Delete src/Kernel.ts, src/suspense.ts, src/lifecycle.ts.
4. tests/trace-off.spec.ts ENGINE_MODULES: replace the three deleted paths
   with 'src/CosignalEngine.ts' (document as a re-point, semantics
   preserved: the zero-cost source scans now cover the fused module).
5. Any test importing '../src/Kernel.js' or suspense/lifecycle directly:
   re-point (grep first: `grep -rn "src/Kernel\|src/suspense\|src/lifecycle"
   tests ../cosignals-react ../react-seam-bench ../../harness`); document
   each in this file.
6. Run full suite; expect green (same algorithm; clocks are write-only so
   far). Bytecode budgets: the kernel function names are unchanged and the
   spec bundles src/index.ts, so budgets should still resolve; clock bumps
   add ~10-20 bytecodes to write/updateComputed — budgets have slack
   (write 130 vs 96 measured; updateComputed 420 vs 362). If a budget
   trips, raise it in tests/bytecode.spec.ts with a comment (re-pin for the
   new shapes is sanctioned at campaign end).
7. Commit ("flattening: cutover — CosignalEngine.ts is the kernel").

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

## Suite state (honest)

- Baseline before any change: full cosignals suite green (fresh worktree,
  pnpm install needed first — remember `mise trust` in fresh worktrees).
- After commit A (schema + skeleton + CycleError move): typecheck green;
  docs-gate + schema-gen green; full suite run pending at the time of
  writing (old composition untouched — expected green).

## Environment notes for successors

- Fresh worktree needs `mise trust` then `pnpm install` (lockfile churn, if
  any, stays UNCOMMITTED per mission).
- Commit with explicit paths only; never push. NEVER touch
  packages/dalien-signals, packages/cosignals-alt-a, packages/cosignals-alt-b,
  milomg-reactivity-benchmark, pnpm-lock.yaml, spec/, harness/results,
  vendor/react, plans/, research/.
- Docs-gate bans (shipped sources): "mint*", the word "plane" (say arena),
  the word "token" (say batch), § references, plans// research/ paths,
  research-stage shorthand in comments. The generator's output must stay
  clean too (it lands in src/CosignalEngine.ts, which is scanned).
- Do NOT run perf benches (the lead owns A/B).
