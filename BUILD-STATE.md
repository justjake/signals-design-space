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
   - Flake FIXED in the same unit: one bytecode-spec run transiently
     reported every arena fn uncovered — the bare-substring
     lastIndexOf('@@SMOKE-START') parse had landed on a late constant-pool
     dump of the marker string, cutting the parse window. The marker match
     is now line-anchored (/^@@SMOKE-START$/m); documented in the spec.

## Done (continued 4)

9. **Growth verdict fix (lead A/B convicted the resizable-ArrayBuffer
   choice; leg 3 first item)** — replaced with dalien-signals' proven
   fixed-full-reservation pattern:
   - Each WorldArena shell allocates its WHOLE reservation once at
     construction: `new Int32Array(ArenaGeom.MAX_BUFFER_BYTES >> 2)` (2^26
     bytes = 64MiB = 2M stride-8 records) + a Float64Array clock column at
     one slot per record (16MiB). Zero-fill demand paging makes the
     reservation address-space-cheap; resident memory tracks touched
     records only. Buffer identity stable by construction; views are plain
     fixed-length typed arrays (full V8 element access); NO growth
     machinery exists — arenaGrow is deleted, and the bump allocators throw
     `arenaExhausted()` if a single world view ever exceeds the reservation
     (mirrors the kernel's exhaustion throw).
   - ARENA_POOL_CAP (8) documented as the pool's named address-space bound.
   - `arenaInitInts` is INERT (kept for reset-API stability): documented in
     EngineResetOptions + the ArenaInitInts type + the EngineCore field;
     the arena-sa2/sd `arenaInitInts: 16` pins re-commented — they once
     forced mid-op growth, they now pin the same flows against the
     fixed-reservation contract. This is the coordinator's option (b),
     chosen because with fixed buffers there is no committed-capacity
     accounting anything reads — a watermark row would be dead state.
   - **Interleaved gate (medians of 3, spka-sa-gates via harness/ for tsx;
     COSIGNAL_ROOT both ways)**: cold-render main 398.75 vs worktree 402.29
     ns (+0.9%); wide-mask main 168.96 vs worktree 169.13 µs (+0.1%).
     Confirmation round after re-apply: 410 vs 410.6 (+0.15%) and 169.2 vs
     157.1 (-7%, worktree faster). GATE PASSED (±5%). Checksums identical
     both sides.
   - **Bare-write +9% investigation (separate item)**: reproducible, not
     noise — interleaved spkw-direct SHAPE=bare medians: main 5.87 vs
     worktree 6.28 ns/write (+7%). NOT arena-related (the bare path never
     constructs a WorldArena). Attribution probe (write()'s durable-clock
     bump commented out): recovers only ~0.11ns of the ~0.41ns delta — the
     normative bump-table store is a MINOR contributor; the remaining
     ~0.3ns is a fused-module effect on the standalone write chain (write()
     grew ~25 bytecodes with the bump; plausibly inlining-budget
     displacement across Atom.set → writeAtom → E.write). Deeper
     attribution (--trace-turbo-inlining) left to the lead; the bump-table
     row is normative, so removing the bump is not builder-discretionary.
   - CAUTION for successors: a `git checkout <file>` used to revert a
     temporary probe ALSO reverted the leg's uncommitted edits to that file
     (the schema-gen regen-diff caught the mismatch immediately). Probes on
     uncommitted work must be reverted by re-editing, never by checkout.
   - Suites after re-apply: cosignals 360 green (incl. regen-diff), react
     72/72, conformance 179/179, oracle 82 green.

## Done (continued 5)

10. **Episodes (priority 4) — the episode lifecycle replaces WriteLog
    compaction** (this run's one commit):
    - **WriteLog reshaped into the chunked episode tape** (WriteLog.ts):
      entries live in fixed-size `TapeChunk`s (TAPE_CHUNK_ENTRIES = 1024,
      power of two; every non-tail chunk is FULL/sealed by construction, so
      the write path detects the seal transition with one mask). No window,
      no rebase, no per-entry fix-ups: a dropped chunk releases its packed
      arrays whole. Log-level `length`/`unretired`/`maxRetiredSeq` fields;
      per-chunk `n`/`unretired`/`maxRetiredSeq` (retirement stamping
      maintains all of them; stamps are monotone so plain assignment
      maintains the maxes, recomputed only when a fold drops a chunk).
    - **createCompaction → createEpisodeLifecycle** (same factory style):
      `holds` (touched atoms with live tapes — membership added by the write
      path at first entry, EXACTLY the old uncompactedAtoms shape) +
      `sealedLogs` (fold-valve candidates, added at the seal transition) +
      `foldSealedChunks()` (the bounded-memory valve: a sealed PREFIX chunk
      all-retired and ≤ every live render pin folds into base per entry —
      replay fidelity — and drops whole; runs at retirement and render end,
      one size check when no sealed chunk exists, i.e. every normal
      episode) + `maybeCloseEpisode()` (the close: at liveBatchCount 0 ∧
      openRenders 0, per-holds-atom DURABLE HANDOFF — base ← kernel newest
      BY IDENTITY (untracked read), baseSeq ← tape's newest seq, tape reset
      — then holds/sealedLogs clear, retired batch records drop wholesale
      (+ per-id write-path batch-cache invalidation), then
      reclaimRetryAllSkipped(), the membership row's wholesale retry
      trigger).
    - **Close placement (deviation from the plan's letter, documented)**:
      the plan says the drop happens "after operation/notification/
      settlement queues drain"; the close actually runs INSIDE the
      transition operation (retireInner tail — after slot release + ambient
      clear, before recomputeQuiet; renderEnd both arms — after
      reclaimAfterRenderEnd, before recomputeQuiet). Reason: quiet must
      re-arm exactly where the reference model's derivation does, so
      notification/settlement callbacks of the same operation classify
      their writes identically (model parity is observable through
      quiet-write vs write events). Verified value-transparent to queued
      work: notifications hold object refs (never id lookups), settlement
      folds read post-handoff state that is fold-identical by the
      eager-apply invariant.
    - **The retired-history drop arm** (writeInBatchInner — REQUIRED for
      lockstep; the fuzz caught its absence at seed 5/step 43): the model's
      eager boundary folds empty its log, re-arming its empty-log drop
      check; the engine's equivalent one-value state is `log.unretired ===
      0 && log.maxRetiredSeq <= getMinLivePin()` (provably exactly the
      states where the model's log is empty — argued both directions in the
      arm's comment), comparing against kernel newest (untracked read; the
      one value every world folds to). Same acceptance counts as the
      empty-log cell; pinned in the rewritten matrix.
    - **THE ONE SANCTIONED SEMANTIC CHANGE executed**: equality-
      semantics.spec.ts rewritten — retirement's per-entry compaction
      equality re-invocation REPEALED (the close adopts newest by identity:
      comparator invoked ZERO times, pinned); world folds still re-invoke
      per entry (unchanged, pinned); NEW pins for the retired-history drop
      cell and for the sealed-chunk valve (parked action holds the episode
      open across 1224 writes; the valve replays exactly the 1024 sealed
      entries in kernel order, the close then drops the tail with zero
      invocations). Acceptance-decision semantics untouched.
    - **Batch bookkeeping is episode-lifetime**: Batch.liveLogEntries,
      releaseLogEntry, maybeReclaimBatch, isBatchMaskedByOpenRender DELETED
      (records persist to the close; the never-quiescent leak-audit churn
      still bounds because each iteration's close drops them).
      renderEnd's mask-lapse reclaim loop deleted with it. quiesce()'s
      retired-batch/ended-render sweeps + cache reset removed (dead by
      construction — the close owns them); its residue check now reads
      `episodeHolds`.
    - **Reclamation**: the write-log guard row is now per-record episode
      membership (`episodeHolds.has(node)`); retry triggers = the close's
      wholesale sweep + the per-atom edge trigger when a mid-episode chunk
      fold empties a tape.
    - **onCompact → onLogEntryDrop** (engine surface + host slice
      getOnLogEntryDrop): fires per entry leaving the tape (chunk folds,
      episode drop); feeds the referee mirror (model-view retention shadow
      fold) and cosignals-react's test harness unchanged in role.
    - **World.ts foldAtom** restructured over chunks: measured 170 bytes vs
      the 190 budget — NO re-pin needed. EngineCore: `compactAll` slot →
      `foldSealedChunks` + `maybeCloseEpisode`.
    - Boundary revalidation table verified UNCHANGED at all five rows
      (per-root commit → that root; retirement/settlement → all roots even
      write-free; quiet folds → all roots; open frames defer to close;
      effect writes classify by pending durable work —
      effect-write-classify green).
    - Test re-points (documented; assertions preserved unless noted):
      graph-consumers A10/T10 (batch records episode-lifetime — same
      asserts), reclaim.spec WriteLog row (membership wording +
      `log.length`), leak-audit churn (`log.length`/`chunks.length`),
      helpers.ts + model-view.ts (mirror feed rename), cosignals-react
      tests/helpers.tsx (rename).
    - **Known accepted memory shape**: under a HELD-OPEN episode, retired
      batch records accumulate until the close (episode-lifetime by plan);
      the hard entry budget with backpressure stays the documented fallback
      if the lead's A/B convicts it.

## Done (continued 6)

11. **Owner ride-along: MACHINERY_OWNED doc rewritten to teach the feature**
    (coordinator-relayed feedback; schema-side so the generated region
    carries it). tools/schema.ts NodeFlag.MACHINERY_OWNED doc now follows
    the required shape: (1) the feature — the observed-lifecycle callback,
    AtomOptions.effect, refcount fed from kernel dependency links; (2) the
    websocket example; (3) the problem — engine bookkeeping reads (world
    folds, subscription revalidation, test surface) create links from
    engine-internal readers that would otherwise count as observation;
    (4) the rule — set on engine-created reader records only, lifecycle
    refcount sites skip machinery readers; (5) the permanence line (every
    flag-word rewrite masks it through). `pnpm gen` re-emitted the layout
    region; regen-diff + docs-gate + full suite green.

## Owner ruling (mid-leg-5, plan amended as c6c03d3 — cherry-picked bfdc85c)

Observer re-fire semantics are AT-LEAST-ONCE. {lastValue, lastValidatedAt}
baselines repealed — observers store ONLY lastValidatedAt (the reserved
link clock slots). Revalidation: producer clean + clock match = skip; clock
mismatch = RE-FIRE, no value comparison at the re-fire decision. Net-no-
change multi-boundary sequences re-fire spuriously by accepted design.
Custom isEqual still gates write acceptance + per-root refold clock bumps
(bump table unchanged — clocks only move on changed results; leg-5
consequence: arenaNoteThrow's conservative unconditional bump must become
outcome-gated, or every marked still-suspended refold re-fires observers).
Watcher corrective gates: clock-decided; lastRenderedValue dies UNLESS a
non-refire-gating contract requires a retained value (report survivors).
Consequences owned by leg 5: value-gated re-fire pins → at-least-once pins
(documented per rewrite); boundary coalescing (many writes, one boundary,
one re-fire) UNCHANGED; SANCTIONED oracle co-evolution (per-node accepted-
change counters, minimal + documented); cosignals-react useSignalEffect doc
update.

Leg-5 exactness design (argued in full; the corpora are the referee):
- Engine per-(root, node) committed clock ≡ model per-(root, node)
  accepted-change counter over a committed fold cache {outcome, counter}.
- The model's cache refreshes ONLY inside observer-machinery committed
  evaluations (drain full scan, quiet scan, sub re-check, commit populator,
  capture) — these mirror the engine's arena refold consults one-to-one at
  value-changing events: between boundaries committed folds are fixed, so
  test reads refold nothing on either side; marks make every value-changing
  boundary a candidate/scan on both sides; refresh-set differences at
  UNCHANGED values are invisible (no counter movement).
- The model never skips (always evaluates; its evaluation is pure); the
  engine's clean+match skip is invisible because clean ⇔ no pending marks ⇔
  fold unchanged since the stamp.
- Watcher commit stamp rule (both sides): at commit, populator evaluates
  committed-now (refresh/refold); stamp := (render value ≡ committed-now,
  by the node's comparator) ? clock-now : 0 (0 forces the next drain's
  correction — the restaled carry). The populator value compare is KEPT: it
  is a cross-world (render vs committed) commit-integrity check, not an
  observer re-fire gate on producer changes (per-root clocks cannot express
  cross-world equivalence; killing it means correct-every-watcher-every-
  commit, which breaks the react contract).
- Mount fixup: four-condition fast-out already clock/generation-decided;
  its post-evaluation compare (mountFix world vs the rendered register) is
  KEPT for the same cross-world reason. Scars' catch-up-vs-urgent split
  untouched.

## Owner ruling 2 (mid-leg-5, plan amended as 7a5ff4f — cherry-picked b28602c)

ALL arenas must support resizing — exhaustion is never fatal. Kernel
already complies (closure-rebuild growth, untouched). Leg 3's fixed-
reservation-with-arenaExhausted-throw is REVERSED in its growth half:
restore grow-by-copy (doubling) for world-arena buffers + columns, mid-
operation capable through the shell indirection (a.memory reassigned; the
reload-after-allocation discipline confined to the allocation sites and
ENUMERATED in the schema/generated region — generated-or-listed, never
folklore). KEEP: plain fixed-length views (length-tracking resizable-
buffer views stay banned — the +56% conviction), the generous initial
reservation (growth stays rare), ARENA_POOL_CAP, generated column
coherence (growWorldArenaColumns back to real duty; extras/clock slots
ride the roster automatically). SEQUENCING: observers unit finishes FIRST;
growth restoration is the unit immediately after (same leg if budget
allows, else FIRST successor item). Growth-unit gate: cold-render +
wide-mask at parity with leg-start numbers (interleaved medians-of-3 — an
explicit exception to the no-perf-bench rule for that unit only), plus a
real mid-operation doubling test (arena-sa2/sd pins return to honest
growth-pin duty); the reversal noted in BUILD-STATE + the commit message.

## Done (continued 7) — leg 5

12. **Schema v3 (commit A)**: extras general per-record object column
    (growArray, 1 slot, scrubOnFree node, ID_TO_EXTRAS_SHIFT); WatcherField
    + SubscriptionField families (observer records = kernel node-allocator
    records; slots 1/5/7 keep allocator meanings); NodeFlag K_WATCHER /
    K_SUBSCRIPTION / OBSERVER_LIVE (outside KIND_MASK — kernel dispatch
    never sees observer records); ALLOCATOR_FAMILIES introduced — kernel
    scrub/grow functions now emit per ALLOCATOR (names unchanged), plus
    generated growNodeSideColumns (allocNode's grown-together loop — the
    hand-written while-push pair replaced) and generated
    scrubWorldLinkColumnsOnFree (arenaFreeLink calls it; world links' clock
    slots = subscription dep lastValidatedAt, no longer "reserved").
    allocNode is unbudgeted; arenaFreeLink stayed within its 50 budget.

13. **Watchers as arena records (commit B1 — storage only, semantics
    untouched)**: the Watcher class moved into CosignalEngine.ts's new
    "observer records" section as a lean handle — own fields are ONLY
    `id` (the monotone watcher id: deliveries/drains fire in id order =
    the model's map order, so it never recycles) and `rec` (the kernel
    record, allocated via the new Kernel.newObserver/disposeObserver ops;
    POISON rows added). State storage: NODE/NODE_GEN/NODE_IX/DEDUP_BITS
    Int32 fields (WatcherField), OBSERVER_LIVE flag bit (the live setter
    shifts observation through a module slot RenderPass registers per
    composition — __setWatcherObservationShift), lastRenderedValue in the
    values column, name/root/flattened-snapshot in the extras object
    (snapshot setter rewrites 5 fields in place — no commit allocation).
    dropWatcher frees the record LAST (deferred to the boundary sweep;
    generated scrub clears every column slot). RenderPass re-exports
    Watcher/WatcherSnapshot so every import chain held. `name` gained a
    setter (the bindings rename watchers after mount). NOTE for the lead's
    pricing: deliver()'s dedupBits/root reads went from own-field loads to
    E.buffer()/extras reads (the record-storage shape).
    Suites: cosignals 362/1skip, oracle 82, react 72/72 — green.

14. **Subscriptions as arena records + SubscriptionManager dies (commit C1
    — storage only, semantics untouched)**: SubscriptionManager.ts DELETED;
    the whole lifecycle (mount/captureRun/captureRead/remove/replay/
    boundary revalidation) is the engine's "committed observers" section —
    a factory (createCommittedObservers) that assigns its operation table,
    the subscription store included, onto the core record
    (core.idToSubscription + five ops + revalidateCommittedSubscriptions;
    no manager object). Subscription is a lean handle: own fields id
    (monotone — registration order = the boundary scan's iteration order =
    the model's map order) + rec (K_SUBSCRIPTION record, OBSERVER_LIVE at
    alloc) + ONE cached extras-object reference. Storage: refire in the fns
    column (the dormant-callback pattern, mission-normative); everything
    cold ({name, root, deps pairs, obsDeps, body, lastValue, runs,
    cleanups}) in the ONE extras object — held by the column (scrubbed at
    free) AND by the handle: the counters are TOMBSTONE DIAGNOSTICS (the
    battery reads a removed subscription's runs/cleanups after later
    boundaries; record Int32 fields zero at the sweep, so counters could
    not live there — SubscriptionField deliberately has no RUNS/CLEANUPS).
    removeSubscription frees the record (flags zero immediately — queued
    refires read live=false and no-op; free defers to the sweep).
    CaptureFrame type moved to the engine; World.ts/concurrent.ts/
    ConcurrentEngine re-pointed; trace-off ENGINE_MODULES: the dead
    SubscriptionManager.ts path removed (CosignalEngine.ts entry covers the
    section — documented in the list comment).
    Suites: cosignals 362/1skip, oracle 82, react 72/72 — green.

15. **At-least-once observers (commit D — the ruling's semantics; layout
    v4)**. THE CENTRAL DESIGN DISCOVERY (the fuzz corpora convicted the
    first cut): fold-time clock bumps make observer re-fire behavior depend
    on READ TIMING — committed-member writes are committed-visible
    immediately, so any committed read between boundaries (test asserts,
    the differ's own per-step snapshots) refolds shadows and hops the
    chain; a flip-flop consulted mid-window re-fired on the engine but not
    the model (seed 137 / long seed 9004). The fix CONVERGES both sides:
    **consult-driven clocks** — settleObserverClock (createWorldArena; core
    slot) is the ONE clock-advance site, called by the observer consults
    (durable drain, quiet drain, settlement drain, boundary re-check,
    commit populator, capture reads via core.committedDepStamp) right after
    their committed evaluations; it compares the shadow's folded value
    against the new `cutoffVals` world column (the observer coalescing
    register, layout v4) with the node's own change rule
    (core.isValueChanged: custom isEqual, sentinel identity) and moves the
    clock only on change (clock 0 = never consulted; evict scrubs both).
    Plain reads refold values but never move clocks. The model's
    per-(root,node) fold cache {v, counter} refreshes at exactly the
    mirrored sites — the engine's (cutoff, clock) and the model's
    (v, counter) are literal twins, so lockstep is exact BY CONSTRUCTION.
    Fold-site bumps deleted (arenaUpdateShadow/arenaFoldOutcome/
    arenaNoteThrow — budgets shrank; comments updated).
    - Sub deps: {lastValidatedAt} on world-arena LINK records (one-sided
      chain off SubscriptionField.DEP_HEAD/DEP_TAIL — on NO producer subs
      list, so every walk/checker sees pre-observer structure; built by the
      capture close from read-time stamps — read-time because effect bodies
      may write mid-run; freed at recapture/removal via the generated link
      scrub). The dep ARRAY (extras) keeps {node, value, stamp} — value is
      a capture ARTIFACT (trace values array + sub.lastValue), never a gate.
    - Re-check gate: skip iff shadow clean (VALID, no DIRTY/PENDING/BOX) ∧
      tenancy GEN ok ∧ link.DEP still names the shadow ∧ clock === stamp ∧
      Object.is(cutoff, vals) (the register-agreement conjunct: a plain
      read may have consumed marks — only the cutoff knows); otherwise
      evaluate → settle → re-fire iff settled clock ≠ stamp. Thrown
      SuspendedRead: skip, NO settle (model mirror: refresh conveys thrown
      outcomes WITHOUT caching) — still-pending suspensions are not flips
      and unchanged round trips through a suspension stay quiet.
    - Watchers: lastValidatedAt = the watcher record's kernel clock slot.
      Drain/quiet/settlement corrections gate on clock-vs-stamp (stamp
      advances at the correction). TWO CROSS-WORLD VALUE COMPARES SURVIVE
      (the ruling's survivor clause, REPORTED as required): (1) mount
      fixup's vFx compare (mountFix world vs the rendered register), (2)
      candidates re-rendered/mounted by the CURRENTLY COMMITTING render
      (core.committingRender, set for renderEnd's commit half) — their
      registers were just reset from the RENDER world and the commit's own
      lock-in moves committed truth by exactly what the screen already
      shows; a clock gate would correct every watcher at every commit
      (react-contract breaker). Per-root clocks cannot express
      render↔committed equivalence. (3) the commit populator's
      restale/validate decision keeps its value compare for the same
      cross-world reason: register ≡ committed-now ⇒ stamp := clock-now;
      differs ⇒ restaled + stamp := 0 (never — forces the next drain's
      correction even if truth flips back; model mirrors identically).
      lastRenderedValue SURVIVES as the rendered-content register (NOT a
      gate): the bindings read it at mount and write it at resubscribe,
      ctx.previous feeds from it at commits, and the correction records'
      from/to payloads carry it (model-compared streams).
    - arenaDecay keep-the-dirt gains the obsRefs clause: dropping an
      OBSERVED shadow to cold would have made its next refold a cold
      re-materialization; under consult-clocks it also keeps values
      resident for the register compare.
    - MODEL CO-EVOLUTION (sanctioned; all edits marked "[SANCTIONED MODEL
      CO-EVOLUTION]"): committedFold cache + refreshCommitted; watcher
      lastSeen + counter gates in drain/quiet; per-dep lastSeen stamped at
      capture reads; effect re-check counter gate (thrown outcomes
      conveyed, not cached); commit populator-analog + committingRender
      discriminant; stamp rules mirrored exactly.
    - PINS: ZERO existing cells needed rewriting — the consult-driven
      chain coalesces exactly where the old value gate did (intra-window
      flip-flops, unconsulted windows, equality-cutoff computeds), and the
      sanctioned spurious class only opens when ANOTHER observer consulted
      the intermediate state. THREE NEW at-least-once pins added to the
      battery: (1) equal-value round trip with a co-consulting watcher +
      deferred sub RE-FIRES (the spurious class, pinned on both twins),
      (2) intra-batch round trip coalesces (boundary coalescing unchanged),
      (3) the fast negative guard skips an untouched clean dep with ZERO
      re-evaluation (engine leg, evaluation-counted).
    - cosignals-react: useSignalEffect doc teaches the at-least-once
      contract (idempotent bodies, Strict-Mode analogy).
    Suites: cosignals 368/1skip (365 + 3 pins), oracle 82, react 72/72,
    conformance 179×2, typecheck ×3 (one pre-existing worktree artifact:
    an untracked user-draft src/Allocator.ts fails tsc locally — not mine,
    not committed, left untouched).

## Done (continued 8) — leg 5 fix round (lead A/B verdict)

16. **Storm conviction root-caused + fixed: the episode tape's chunk
    churn — NOT the observer rebuild.** The lead's verdict blamed the
    subscription revalidation; the convicted bench (spkb-sb untracked-fan
    writeStormNsPerWrite) has NO subscriptions and its timed region is the
    raw write loop. Commit-bisect on interleaved diagnostics: the
    regression exists at LEG-5 START (8d61a97: 234ns vs main 95ns; leg-5
    commits add ~10% on top) — it shipped with the EPISODES leg. Root
    cause, isolated with per-phase + gc-toggle + arena-toggle
    discriminators: the episode close drops every TapeChunk wholesale
    (log.reset() — chunks = []), so under a write storm EVERY EPISODE
    re-allocated six columns per chunk and re-grew them entry by entry;
    the bench's per-rep full GC left those fresh backing stores cold
    (gc-per-rep: +111%; no-gc: +13%). The pre-flattening log never paid
    this: its flat arrays kept their capacity across compactions
    implicitly. FIX: a capped TapeChunk shell pool (CHUNK_POOL_CAP = 16;
    release scrubs the payload column — a parked shell can never pin
    values) reused by acquire/release at the two whole-chunk drop sites
    (episode close, fold valve), with index stores in push. A first cut
    ALSO preallocated the columns at capacity — the wide-mask drain
    convicted it immediately (+86%: a 48KB preallocation per touched atom;
    sparse logs are the common case) — REVERTED: columns append-grow;
    capacity retention comes from the pool alone. Gates (interleaved
    medians-of-3, this box): storm WT 144.5 vs main 140.8 (+2.6%, within
    ±5%; was +64-93% convicted); wide-mask WT 176.3 vs main 169.5 (+4.0%);
    cold-render WT 394.0 vs main 416.7 (-5.4%, faster); logged watch1
    112-120 vs leg-end's 162-244 (dramatically better, variance
    collapsed; residual vs main +9%). Full suites re-green (cosignals 368
    + user draft, oracle 82, react 72/72, conformance 179×2).
    RESIDUAL, stated per the verdict's demand: ~+13% on the no-gc write
    loop exists at leg-5 START vs main (151 vs 134 ns) — a pre-leg-5
    branch-level residue (episodes/cutover era), NOT consult-clock cost
    (the consult machinery never runs in the storm's timed region; the
    at-least-once mechanism's cost is confined to boundary consults and
    gates fine). Left for the lead's branch-level ledger; not silently
    accepted.

## In progress / exact next actions

**Priority 5 (observers) is COMPLETE** (items 12-15 above; commits b22b174,
853bc66, 65a3f42, ebd5244) **plus the lead-verdict fix round (item 16)**.
Successor order, per owner ruling 2's sequencing:

1. **World-arena growth restoration (owner ruling 2 — the unit the ruling
   queued immediately after observers).** Restore grow-by-copy (doubling)
   for world-arena buffers + ALL columns (memory, clocks — now also
   cutoffVals; the schema roster keeps every column in the growth loop
   automatically), mid-operation capable through the shell indirection
   (a.memory reassigned; hot walks that cached `memory` locals must
   re-load after any allocating call — CONFINE the discipline to the
   allocation sites and ENUMERATE those sites in the schema/generated
   region, generated-or-listed, never folklore). KEEP: plain fixed-length
   views (length-tracking resizable-buffer views stay banned — the +56%
   conviction), the generous initial reservation, ARENA_POOL_CAP,
   arenaExhausted dies (exhaustion is never fatal). Re-express the
   arena-sa2/sd arenaInitInts pins as REAL mid-operation growth pins again
   (note the reversal in BUILD-STATE + the commit message). GATE: cold-
   render + wide-mask interleaved medians-of-3 at parity with leg-start
   (an explicit exception to the no-perf-bench rule for this unit only),
   plus a growth-path test exercising a mid-operation doubling. NOTE for
   the builder: observer dep chains live in arena link records and
   subscription DEP_HEAD/DEP_TAIL name arena link ids — growth must keep
   link ids stable (grow-by-copy does; only the buffer object changes).
2. **Priority 6 — render integration** (RenderPass machinery folds into
   the engine module; protocol v2 contract unchanged). Then priorities
   7-10 as listed under "Unstarted".

WORKTREE NOTE: the user is actively drafting src/Allocator.ts +
tests/allocator.spec.ts (untracked) in THIS worktree — likely the growth
unit's allocator sketch. Leave both alone; they pass standalone as of this
writing. Full-suite tallies may drift by their test count while untracked.

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
- Run 5 (third builder, leg 5 — priority 5 observers + owner rulings 1+2
  landed mid-leg): commits b22b174 (schema v3: extras column + observer
  families + allocator-keyed generated scrub/grow), 853bc66 (watchers as
  arena records), 65a3f42 (subscriptions as arena records; SubscriptionManager
  deleted), ebd5244 (at-least-once observers: consult-driven clocks +
  cutoffVals layout v4 + model co-evolution + 3 new battery pins), plus
  cherry-picks bfdc85c/b28602c (the two owner plan amendments). Suites at
  run end: cosignals 368 passed / 1 skipped (365 + the 3 at-least-once
  pins; excludes the user's untracked draft spec), oracle 82, cosignals-
  react 72/72 (real fork), conformance FRAMEWORK=cosignals 179/179 +
  cosignals-concurrent 179/179 (this worktree's harness), typecheck clean
  for cosignals + cosignals-react + cosignals-oracle. NOT run: daishi
  verifier, perf benches (lead owns; the growth unit carries its own
  sanctioned gate). Next action: growth restoration (above).
- Run 4 (second builder, priority 4 — episodes): one commit (episodes; see
  Done continued 5). Suites at run end: cosignals 31 files / 362 passed /
  1 skipped (the 2 new equality pins joined), oracle 82 passed,
  cosignals-react 72/72, conformance FRAMEWORK=cosignals 179/179 +
  cosignals-concurrent 179/179 (run from THIS worktree's harness — its
  node_modules/cosignals symlinks this worktree's package), typecheck clean
  for cosignals + cosignals-react + cosignals-oracle. WORKTREE-ONLY
  environment artifact (not flattening-caused, main-repo harness
  typechecks clean): `pnpm -C harness typecheck` fails on bench/child.ts
  TS7006 because the untracked milomg-reactivity-benchmark dir does not
  propagate into worktrees (never-touch; ignore). Bench child measured:
  foldAtom 170 (budget 190 — no re-pin). NOT run: daishi verifier, perf
  benches (lead owns). Next action: priority 5 in "In progress / exact
  next actions".
