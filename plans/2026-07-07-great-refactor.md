# The Great Refactor — one always-concurrent engine, composed mechanisms

STATUS: REVISION 3, for the verification pass. Round 1 (codex 7 blockers +
4 majors; independent reviewer 2 blockers + 6 majors) is fully resolved and
was verified resolved by round 2. Round 2 (codex not-ready; independent
another-pass) converged on plan-text items — all resolved in this text; no
new owner rulings were needed beyond §1a. No code moves until the
verification pass's findings are discussed with the owner.

## 1. Mandate (owner rulings, 2026-07-07)

- Divide the monoliths (packages/cosignal/src/index.ts ~2600 lines,
  concurrent.ts ~5400 lines, one 5000-line class) into composed mechanisms.
- Always-concurrent: no "installing" concurrency, no kernel/bridge layering,
  no adoption (lazy discovery is the same smell — creation is one step).
- Inline single-caller utilities and trivial single-expression functions,
  except load-bearing splits (§7).
- ONE NODE ID SPACE: the kernel record id everywhere; the dense id space dies.
- Vocabulary: `Tape`→**WriteLog** (`atom.log`); `Receipt`→**WriteLogEntry**
  (locals: `entry`); `ShadowArena`→**WorldArena**; buffers are **memory** /
  **watermark** (kernel included); **World stays**; **batch everywhere,
  token deleted**; `BatchSlot`/`BatchSlotSet`, internal to Batch.ts;
  maps named `<from>To<to>`; "pass" dies standalone → **RenderPass**;
  `HostOpKind` literal union dies → one **`const enum WriteKind`**;
  `BridgeEvent`→**TraceEvent** with the packed view renamed **TraceRecord**
  (both owned by trace.ts, beside the decoder);
  **BANNED WORDS: "plane", "mint/minting/minted"** (use create/created;
  `mintSeq`→`nextSeq`); "token" dies in the FORK too (vendor is ours):
  `getOrMintBatchToken`→`getOrCreateBatchId`, `slot.token`→`slot.batchId`,
  and the registry's prose — the old names appear in this plan only inside
  rename instructions.
- Files: main-type modules are `MainType.ts`; mechanism modules lowercase.
- vendor/react is unprotected; evergreen; protocol v2 approved (§3.4).

### 1a. Review rulings (owner, 2026-07-07 findings discussion)

R-1 The oracle-edit license for S5 is GRANTED, scoped: delete the
    registration dimension from the model (its `registered` state, the
    register op/guards, the quiet clause) and add writing-core-effect
    vocabulary (R-3's corpus coverage). Every oracle edit is listed in S5.
R-2 Equality semantics: the KERNEL's order and count — `isEqual(current,
    incoming)`, invoked once per accepted write — everywhere. The quiet
    path's flipped/double invocation is corrected to match; the oracle
    co-evolves; a pinned test freezes order and count.
R-3 Effect writes observed during the eager apply CLASSIFY NORMALLY
    (recorded into the ambient/driver batch). Today they silently bypass
    recording — a latent bug (`bridgeApplying` suppression, reproduced by
    review); the merge fixes it. The model's core effects gain a write op so
    the corpus referees the fixed semantics.
R-4 Column density: the graph stores a NODE INDEX (`nodeIndex` — renamed
    from revision 2's "ordinal", which collides with the kernel's existing
    record-ordinal vocabulary) in each node record's memory at allocation —
    an internal packing detail, never an identity, never a map. Engine
    columns index by nodeIndex; identity remains the kernel record id.
R-5 `openBatch` with no driver attached: devChecks throws; the documented
    contract is "hosts that open batches must retire them" (it is the
    host-agnostic embedding surface).
R-6 `__resetEngineForTest` is a watermark-bounded scrub (the arena-release
    precedent), not a reallocation, and carries an ENGINE EPOCH counter
    (consumed by reclamation, plans/2026-07-07-signal-reclamation.md).

## 2. Non-goals and invariants

- NO observable behavior change, with the ruled exceptions: (a) protocol v2's
  handshake; (b) test isolation via reset; (c) R-2's equality unification;
  (d) R-3's effect-write classification fix. (c) and (d) are corrections of
  divergent/buggy behavior, each landing with its own pinned tests and
  oracle co-evolution.
- Oracle edits: mechanical name co-evolution throughout, PLUS the R-1
  license, exercised only in S5 and itemized there.
- No public API redesign beyond the deletions and renames listed here.
- Perf: flat-or-STOP per stage on the bench gates (§11). The kernel's speed
  identity survives by carrying its actual mechanisms (§3.2): closure-
  captured memory, the rebuilt op-table with a unique hidden class, same-file
  const enums on hot paths, the V8 split families, the bench-pinned fast
  arms.

## 3. Target architecture

### 3.1 Module map

| File | Main export / contents | State it owns |
|---|---|---|
| `graph.ts` | packed dependency graph: NodeField/LinkField/NodeFlag/RecordGeom enums (RecordGeom is the renamed kernel `Arena` geometry — frees the word), allocation (records carry the R-4 nodeIndex), link/unlink, propagate/checkDirty family, update/notify/run/dispose, flush queue, growth/rebuild, `nextSeq` | `memory`, `watermark`, allocator heads, `values`/`fns` columns, walk scratch, `queued`, `cycle`, `activeSub`, `batchDepth` (the SYNCHRONOUS `batch()` effect-flush counter — kernel-native, unrelated to Batch.ts; review finding, now owned) |
| `WriteLog.ts` | `WriteLog`, `WriteLogEntry`, compaction, rebase | per-atom logs, `uncompactedAtoms`, compaction cursors |
| `Batch.ts` | `Batch`, `BatchId`, `BatchSlot`/`BatchSlotSet` (internal), open/retire/settle lifecycle, slot interning + reclamation, committed-bits rebuild | `idToBatch`, slot table, live count, ambient batch |
| `World.ts` | `World`, `visibleAt`, `foldAtom`, `applyOp`, `eqAtom` (R-2 semantics), `evaluate`, read routing | active world, routing state, eval marks/depth, fold-callback guard |
| `WorldArena.ts` | `WorldArena` (`memory`, links, dirty lists, suspended list), ArenaField/ArenaLinkField/ArenaFlag/ArenaGeom enums, the `arena*` walk family INCLUDING `walkArenaStrong` and the delivery-walk inner loops (hot arena walks stay same-file with their enums — review finding), serve/update/checkDirty, claim/release/pool/decay, fan-out | `rootToArena`, pool, arena frames, serve override, walk scratch that indexes arena memory |
| `RenderPass.ts` | `RenderPass`, `Watcher` (carries a GENERATION STAMP beside its node id — review finding: bare ids alias reused records), start/yield/resume/end, mount/defer/reveal, snapshots, mount fixup, `commitBatches` | `idToRenderPass`, `rootToOpenRenderPass`, `idToWatcher`, `nodeToWatchers` |
| `deliver.ts` | the notification queue (`NotifyKind`), `correctWatcher`, committed-observer drains, the walk ORCHESTRATION that calls WorldArena's walks | notify columns |
| `Subscription.ts` | `Subscription`, capture frames, boundary revalidation | `idToSubscription`, capture frame, counts |
| `settlement.ts` | settle tap, queue, drain loop, operation epilogue | settle queue/set, drain flags, op depth |
| `observation.ts` | the observation index | `obsRefs`, `obsDeps`, capture list |
| `suspense.ts` | `SuspendedRead`, thenable instrumentation, `ctx.use`, exception storage, self-heal reads | use-cache keys, sentinel creation |
| `lifecycle.ts` | observed-lifecycle option (states, flap-damped flush) — WITHOUT rooting handles (reclamation requirement: the state map must not strongly pin the handle; design in the reclamation plan) | states, queue |
| `engine.ts` | composition root: `Atom`/`Computed`/`ReducerAtom`/`effect`/`effectScope`/`batch()`/`untracked`/`configure`, `const enum WriteKind`, THE write path, quiet derivation, quiesce/epoch, `attachDriver`, probes, errors, `__resetEngineForTest` (+ engine epoch) | quiet, seq/committedAdvance clocks, driver slot, devChecks, reset epoch |
| `index.ts` | thin barrel + THE PACKAGE GUIDE (reading order; the load-bearing concepts — write log, batch, world, arena, render pass, watcher — defined once; the life-of-a-write walkthrough) | none |
| `trace.ts` | as today + `TraceRecord` (packed) / `TraceEvent` (decoded, né BridgeEvent) and the renamed vocabulary | — |
| `graphviz.ts` | as today + a four-line glossary header; `tape:`→`log:` labels | — |

Const-enum discipline: each module owns its hot enums same-file. Known
cross-module warm sites are enumerated and bench-checked: `applyOp`'s
WriteKind comparison in World.ts (falls back to the documented same-file twin
pattern if the gate objects); column indexing uses the R-4 nodeIndex (read from
record memory), NOT a cross-module RecordGeom shift — the shift appears only
inside graph.ts and the checker seam's data handoff.

### 3.2 State threading: factories with a swap point, one engine, no class

CORRECTED from revision 1 (review finding): the kernel's speed identity is
NOT bare module `let`s — hot functions capture `memory` as a closure constant
inside a rebuilt op table whose unique hidden class is measured worth 15-25%.
The mechanism modules keep exactly that pattern: each exports a factory that
closes over its state and returns its op table; engine.ts composes the
factories and holds the swap point. REBUILD SCOPE (round-2 correction — the
two rebuild events differ): GROWTH re-runs the GRAPH factory ONLY (the
existing `createEngine`/carry mechanism: memory doubles, records copy,
ids/GEN stable — verified not a resurrection axis); growth fires at
operation boundaries INSIDE open episodes, so no other mechanism's state may
evaporate — durable cross-rebuild scalars stay module-level exactly as the
kernel keeps them today, and every cross-module reference to the graph table
reads through the one mutable table slot the rebuild re-links, never a
captured stale table. RESET (`__resetEngineForTest`, R-6) re-runs ALL
factories, behind preconditions (§10 S5). Cross-module reads are table
calls; cross-module
MUTATION of another mechanism's clocks/state goes through table functions,
never exported `let`s (review finding: ESM live bindings are read-only from
importers; also avoids init-order/TDZ hazards, which the composition root
sidesteps by constructing factories in dependency order).

There is ONE engine per process. `CosignalBridge` is deleted during
extraction — never renamed. Multi-instance dies; reset (R-6) replaces it.

### 3.3 The driver seam

```ts
engine.attachDriver({
  allocateBatchId(deferred: boolean): BatchId,  // protocol v2: the fork calls
                                                // this at batch creation
  worldFor(): World | undefined,
  onDelivery / onMountCorrective / onCorrection,
})
```

Replaces: the four hook setters, the 11 `__host*`/`__kernel*` seam functions
(+`__HOST_MISS`), the four `*Impl` hook bodies, `registerBridge`/
`registerReactBridge`, `writeClassifier`, `readAdopter`, `setWorldProvider`,
the notify-sink setters, `activeBridge`, `publiclyRegistered`,
`syncReadRouting` arming, `bridgeApplying` (per R-3), and THE ENTIRE
ADOPTION FAMILY: `adoptAtom`, `adoptComputed`, `readAdopter`,
`resolveStamped`, `_hostStamp`, per-handle discovery, base seeding from
kernel-current, and the pre-adoption-era semantics with its scar tests
(the era ceases to exist — a handle exists ⟺ the engine knows it).
Batch context is no longer pulled per write: with protocol v2 the classified
write reads the fork's current batch id directly (one foreign call, no map).

THE DRIVER CONTRACT (round-2 additions):
- Single driver: a second `attachDriver` throws (replacing the dying
  `publiclyRegistered` once-latch as the enforcement).
- `allocateBatchId` envelope: ALLOCATION-ONLY — increments a counter and
  returns; no operation epilogue, no drains, no engine mutation beyond the
  counter. It must be legal at `opDepth > 0`, inside open render frames,
  and mid-commit (the fork demonstrably creates batch identity in all three
  positions), and ids retire out of order (≥2 outstanding is fork-pinned).
- BatchIds are MONOTONIC ACROSS RESETS (the counter survives
  `__resetEngineForTest`): the fork's lane table can legally hold an id
  across an engine reset, and monotonicity guarantees a stale id can never
  collide with a post-reset batch.

### 3.4 Protocol v2 (fork change; design corrected per review)

The fork's batch registry keeps ONE PERSISTENT SLOT PER LANE; batch identity
is created when a write finds the slot's batch field empty (retirement
clears the field and keeps the Slot; all creation paths — render-phase,
transition, discrete/sync — funnel through the one creation site). v2
changes:

- At BATCH-IDENTITY creation (the empty-slot-field arm — round-2
  correction: NOT "Slot creation", which happens once per lane) the fork
  calls the driver's REGISTERED ALLOCATOR (`allocateBatchId(deferred)`) —
  the driver→React id-allocation edge the revision-1 sketch lacked (the
  listener bus is void broadcast and cannot return values; the allocator is
  a dedicated registration, not a listener).
- `slot.batchId` (the field currently named `slot.token`) stores the
  returned BatchId; every protocol surface (`getCurrentWriteBatch`,
  `runInBatch`, retirement + commit reports) speaks it.
  `getOrMintBatchToken` → `getOrCreateBatchId`; the registry's own
  vocabulary renames with it (S3 rewrites these lines anyway).
- Test seam (round-3 hardened): the fork's protocol reset hook clears the
  FULL slot tenancy — batch field, root sets, committed-root sets, parked
  state — not just the batch field, and parked settlement callbacks
  SELF-INVALIDATE (each captures its BatchId and no-ops if the slot's
  current id differs when it fires). Reset ownership and order are
  explicit: `__resetEngineForTest` invokes the driver's protocol reset
  FIRST, then scrubs the engine. Never production; with monotonic BatchIds
  this is belt-and-suspenders against stale lane entries crossing a reset.
- The deferred flag becomes a STORED FIELD on the Slot. The three load-
  bearing low-bit reads convert (enumerated; review finding): the fork's
  run-in-batch scheduling branch, the fork's async-action park decision at
  the close edge, and the driver's classifier check (which becomes a field
  on the open event / a driver-side record).
- `BATCH_NONE = 0` stays the no-context sentinel on both sides.
- Both mapping tables die. Fork tests updated in-stage.

## 4. The merge (always-concurrent)

Final shapes (engine.ts):

```
Atom.set(v)     → write(WriteKind.SET, v):
                    policy asserts (R-2 equality: isEqual(current, incoming), once)
                    → quiet ? quietFold : recordedWrite(currentBatch())
Atom.update(fn) → same, WriteKind.UPDATE
Atom.state      → activeSub ? graph.read : routingActive ? routedRead : graph.read
Computed.state  → activeSub ? graph.computedRead : routingActive ? routedComputedRead : graph.computedRead
```

- The node-less arm (review finding m5): a handle with NO engine-side content
  (no log entries, no watchers, no arena presence — the common standalone
  case) takes the graph write directly after the quiet check; engine columns
  allocate on first CONTENT, not on creation. Creation cost and the
  standalone write path are bench-pinned (creation gains only reclamation's
  registration — see the companion plan).
- `quiet` derives purely from pipeline state (no registered clause, no
  driver clause — verified by review: a batch cannot exist before something
  opens it, and openBatch precedes any classified write).
- Effect writes during the fused apply classify normally (R-3), corpus-
  refereed via the model's new writing-core-effect vocabulary.
- Kernel `batch()`/`batchDepth` (synchronous effect coalescing) is graph.ts
  state, untouched by Batch.ts (review finding — now owned, §3.1).

## 5. One id space

The kernel record id is THE `NodeId`, package-wide (`KernelId` merges into
it). Engine columns index by the R-4 NODE INDEX (`nodeIndex`) stored in the
node record's spare field (field 7 — verified spare; the shared stride is
untouched, so links pay nothing) — dense in node count, immune to the shared
node/link allocator's holes (review finding: link records dominate the id
space ~3:1; nodeIndex indexing keeps columns packed-SMI where record-id
indexing would go holey/dictionary on hot read paths, multiplied per arena).

NODE-INDEX LIFECYCLE (round-2 blocker, resolved): the nodeIndex RECYCLES
with the record slot — it persists in field 7 across node-slot reuse (node
free lists thread through a different field, so the value survives free)
and a reused record inherits its slot's index. Every nodeIndex-keyed column
is therefore SCRUBBED AT THE RECORD-FREE BOUNDARY: one shared free hook that
each column-owning module registers its clear into (use-cache, observation
refs, watcher-index rows, walk stamps, per-arena node lookups). This is what
bounds columns by node count (no fresh-index-forever growth under
create/drop churn) and prevents a new tenant being served the previous
tenant's rows. Consumer cost (round-2): node objects cache their nodeIndex;
raw id-driven walks read it from record memory — one extra Int32 load per
visited node on hot walks, priced by the bench trio.

Deleted: the dense id allocator (`nextNode`), `nodeGen`, `byKernelId`,
`indexNode`'s allocation half, `_hostStamp`.

Proof obligations (S2 gates, tests first):
- P1 allocator coincidence (verified plausible by review — dispose defers to
  the boundary sweep; no reuse while GEN is stale) AND consumer coincidence
  (review counterexample): every id-holding consumer — watchers, snapshots,
  notify queues, retry sets — carries a generation stamp or resolves through
  a generation-checked lookup. The dormant-watcher aliasing scenario
  (dispose → id reuse → late commit) becomes a pinned regression test.
- P2 column shape: columns stay packed (elements-kind probes, the
  monomorphic-array spot-check methodology) and bounded by node count via
  nodeIndex recycling + the free-hook scrub; per-arena `nodeToShadow`
  re-keys by nodeIndex.
- P3 the GEN test seam: S2 introduces the kernel-GEN referee reads the old
  `nodeGen` seams provided (`__bumpNodeGenForTest` equivalent against
  kernel GEN — sequenced WITH S2, not deleted-then-reintroduced).

## 6. Naming

As §1 plus: `AF`/`AFlag`/`A_*` → ArenaField/ArenaLinkField/ArenaFlag/
ArenaGeom; `a*` functions → `arena*`; `cas` → `committedAdvance`; `tp` →
`log`; `sr` → `suspendSentinel`; Subscription locals `e` → `sub`;
`dirtyAtoms` → `uncompactedAtoms`; `adoptMount`/`deferMount` →
`adoptRevealedMount`/`deferMountEffects` (the WATCHER-reveal sense of adopt
survives; handle adoption dies); trace kinds rename with concepts
('pass-*' → 'render-*'; kind strings are evergreen — no decode compat);
"referee marker" leaves shipped vocabulary (commit checkpoint markers);
mint→create sweep (comments, `nextSeq`, fork). The kernel walk family keeps
upstream names (twin-drift protection). Maps: `<from>To<to>`.

## 7. Inlining policy

INLINE (single caller or trivial single-expression, per the structure map):
`makeKernelGetter`, `makeAdoptedKernelGetter`, `makeCtxWorldFn`,
`routedRead`, `boundaryWork`, `throwFold`, `scheduleLifecycleFlush`,
`attachSettle`, `consumerCount`, `arenaQuiesceSweep`'s wrapper layer, the
trivial delegate methods (the batch/node/render lookups, `quiescent`,
`oneAtomBuf`), and every `__host*`/`__kernel*` seam function that collapses
into a same-module call site at the merge.

KEEP (load-bearing; each keep documented at the site):
- every function whose name carries a bytecode budget or over-limit pin;
- the V8 split families: link/linkInsert, checkDirty/chainCheck/
  checkDirtyLoop, computedRead/computedReadSlow/boxedRead,
  arenaCheckDirty/arenaCheckDirtyLoop, arenaFoldOutcome/arenaEqCold/
  arenaSyncObsAfterRefold, and the cold walk-cycle throwers;
- the three bench-pinned write-path fast arms (their comments carry the
  measured regression numbers that forbid folding);
- hoisting-required policy functions (`ctxPrevious`/`ctxUse` feeding the
  shared context object);
- the referee/test seams and the public operational surface the lockstep
  harness drives (write/renderStart/renderEnd/retire/commitBatches/...);
- `visibleAt` — single-caller but THE visibility rule; kept as a named
  function deliberately (readability exception, documented at the site).

Dead code deleted in S0: `__kernelGen` (zero callers; S2's P3 seam is a NEW
kernel-GEN referee read designed with S2, not a resurrection) and
`captureActive` (zero callers).

## 8. Comments, docs, and the guide

- Every extracted module gets a fresh, self-contained header — what it is,
  its terms defined locally or pointed at the package guide, how it
  composes — written in the final vocabulary from birth (no transitional
  prose, no old names).
- index.ts carries the PACKAGE GUIDE: the reading order across modules, the
  load-bearing concepts defined once (write log, batch, world, arena,
  render pass, watcher, subscription, quiet), and the life-of-a-write
  walkthrough from `atom.set` to paint.
- CITATION-TOKEN DELETION (the jargon audit's full inventory rides S6):
  ~130 offending comment sites in concurrent.ts, ~30 in index.ts, ~12 in
  the shim, ~8 in trace.ts, ~5 each in hooks.ts and graphviz.ts. The
  audit's key finding governs the method: at the vast majority of sites the
  reasoning is already stated inline and the violation is a trailing
  citation — so the fix is deletion or a one-phrase substitution, not a
  rewrite. Categories swept: stage codes (S-A/S-B/S-C/S-D, ~102 hits),
  plan §-references (~106), NF2 (~30), referee/lockstep/oracle/twin
  (~60, including the shipped trace vocabulary), contract clause ids
  (RT/EF/OL/UM/RCC/CR, ~30), dated ruling citations, review/bench item ids
  (W*/B*/m*/M*), fuzz-seed citations-as-authority, test-file paths, and
  research-spike references (the `w*` ghost names).
- REAL PROSE at exactly four sites (the audit's exceptions where the
  citation IS the content): the shim's CR5 ordering guarantee spelled out
  in full; the K1 ghost paragraph (describes deleted machinery) rewritten
  or deleted; the "HEAD order" comment rewritten; graphviz.ts gains a
  four-line glossary header.
- Shipped-vocabulary fixes: "referee marker" leaves the trace event table
  (the two post-consequence kinds become commit checkpoint markers with
  self-contained descriptions); graphviz's rendered `tape:` label becomes
  `log:`; bench-pinned NUMBERS stay in comments, bench IDs go.
- S6 closes with grep gates over shipped sources for the banned/retired
  vocabulary: plane, mint/minting/minted, token, standalone "pass",
  "donor", "shadow" (arena sense), the section-sign character, and stage
  codes.

## 9. Magic numbers

The audit's full fix list, mapped:
- `const enum WriteKind { SET, UPDATE }` replaces BOTH prior twins
  (kernel `HostOpKind` literal union + engine `OpKind`) — owner ruling;
  single definition beside the hot write path (§3.1 discipline).
- `const enum NotifyKind` (delivery / mount-corrective / correction /
  subscription-refire) in deliver.ts — today one comment names the 0-3
  codes at eight bare sites.
- The weak-link mode bit becomes a named ArenaLinkField member (today a
  bare `& 1` at five sites).
- `ArenaGeom` absorbs `A_STRIDE`/`A_SHIFT`/`A_CLOCK_LIMIT` (also closing
  the module-const bundling-demotion exposure the kernel engineered away).
- The arena walk-guard cap (1,000,000 — six value copies plus two prose
  copies today) becomes one named constant that also feeds the two error
  strings.
- Named consts: the write-log rebase threshold (1024), the arena pool cap
  (8), default initial records (1<<20), minimum records (2, plus its error
  string), the walk-scratch seeds (4096 ×4), the tracer eval-stack depth
  (1024 ×3, must-stay-equal), the pow2 capacity floor (8 ×3).
- `BATCH_NONE = 0` names the protocol's no-context sentinel (both sides,
  protocol v2).
- trace.ts's op-code re-derivation (`'set' ? 0 : 1`) derives from
  `OP_NAMES` instead of restating the pair.
- The checker-internals seam gains MARK and CLOCK_LIMIT fields so the
  arena-sd spec's two hand-copied constants die (S0).

## 10. Staging

- **S0 prep** — dead code, named consts, checker-seam extensions.
- **S1 renames in place** — R1 arena domain; R2 token→batch + BatchSlot +
  trace kinds + oracle name co-evolution; R3 pass→RenderPass family +
  oracle; R4 ride-alongs (WriteLog, WriteLogEntry, committedAdvance,
  nextSeq + mint sweep, map convention, misc). Class renames skipped
  (the class dies in S5).
- **S2 one id space** (monolith) — P1(both halves)/P2/P3 tests first, the
  merge of id spaces, the nodeIndex column re-key, AND the harness
  co-evolution IN-STAGE (review blocker): the twin's id-equality assertions
  become nodeIndex/name-keyed, the checker and decode layers audited for
  id-shape assumptions, leak probes + bench trio + elements-kind probes.
- **S3 protocol v2** (fork + driver) — the allocator registration, Slot
  field, the three converted flag sites, `getOrCreateBatchId` + the
  registry vocabulary rename, mapping
  tables deleted, fork tests updated.
- **S4 extraction** — grouped by the REAL dependency structure, with a
  RESIDENCY RULE for the orchestrators (round-2: retirement fans across six
  groups and render-commit calls retirement back — no ordering makes those
  pure moves): E1 errors + deliver's queue; E2 observation; E3 WriteLog
  MECHANISM (compaction's batch-state edge — the live-entry decrement and
  reclaim check — stays resident); E4 Batch MECHANISM only (ids, slots,
  interning, committed-bits; retirement stays resident); E5 the SCC group
  {World, WorldArena, settlement} as factories with one internal table;
  E6 Subscription; E7 THE ORCHESTRATION CONVERSION: retirement, render
  commit/end, and the compaction→batch edge move together, with their
  cross-module mutation converted to table calls — the one stage whose
  commits are rewires rather than pure moves, reviewed as such;
  E8 graph.ts + suspense.ts + lifecycle.ts out of index.ts; E9 engine.ts
  assembly. Each E gate-green.
- **S5 the merge** — hooks die, §4 shapes land, attachDriver (with the
  §3.3 contract), adoption family deleted, the class dissolves.
  R-2 EQUALITY, full inventory (round-3 complete): engine sites — quiet
  fold, writeInner's drop check AND eager apply, compactAtom, AND the
  ordinary world-replay fold (foldAtom's per-entry comparator — round-3:
  leaving it flipped makes an asymmetric comparator fold worlds wrongly) —
  align to kernel order; model sites, individually named — quietWrite,
  the write drop, the eager-advance decision, foldAtom, shadowFoldAtom,
  compactAtom — align in the same commit (a shadow-fold lag breaks the
  retention invariant for asymmetric comparators). The "once" contract is scoped to THE ACCEPTANCE DECISION
  (folds and compaction re-invoke per entry by design — documented).
  Pinned matrix: {standalone, quiet, recorded} × {set, update, dispatch} ×
  {empty, nonempty log}, order pinned by an asymmetric comparator, count
  by a counting comparator. The corpus gains a CUSTOM-EQUALS topology
  member (asymmetric + counting) — without it R-2 is lockstep-invisible
  (today zero oracle atoms carry custom equality).
  R-3 EFFECT WRITES, executable spec (round-3): FIRST freeze the named
  finding seeds (29/97/173 and the long-seed set) as stored literal
  schedules in their spec files — their pinned regressions survive any
  generator change; THEN the generator adds a writing-core-effect band
  freely (seed streams for archival seeds no longer constrain it).
  Convergence by construction: writing effects write ONLY into a disjoint
  "effect-output" atom subset that no core effect reads (acyclic by
  generation rule), with payloads derived from the effect's own run count
  under equality cutoff — a bounded number of effective writes per
  trigger, then drops. Classification is refereed directly (snapshot +
  event placement, engine vs model).
  `__resetEngineForTest` (R-6): watermark scrub + engine epoch + PRE-
  CONDITION ASSERTS via one exhaustive assertIdle (round-4 complete):
  quiescent; batchDepth/opDepth/enterDepth === 0; evalDepth === 0;
  inFoldCallback === false (updater/equality callbacks are their own
  frame); no capture frame; no arena evaluation frame; no settle or
  notify drain in progress; S5R's deferred-cleanup drain guard clear — a
  test that threw mid-batch or resets from inside any user-code frame
  must fail loudly here, not corrupt the next test),
  and the scrub checklist (round-2 additions in CAPS): kernel allocator
  heads and counters, queued/pendingFree, VALUES/FNS SIDE COLUMNS (stale
  ctx.previous and wrapper closures otherwise survive id reuse), walk
  scratch, configure state incl. DESIREDRECORDS, forbidWrites, lifecycle
  map + queue + its SCHEDULED FLUSH MICROTASK, THE SETTLE-DRAIN MICROTASK,
  settleTap, THE THENABLE LISTENERS' UNHANDLED-RETHROW MICROTASK (inert
  only once memory AND values are both scrubbed — asserted), PROBES
  COUNTERS, trace attachment, armed checker state, every engine field,
  and reclamation's registry/queues (per its plan §2). THE ORACLE EDIT
  LIST (R-1 license, complete): delete model registered/register-guards/
  quiet-clause; equality alignment at the three model sites above; add
  writing-core-effect ops + the custom-equals topology.
  Test-scope workstream (review-expanded): TwinDriver + oracle-adapter +
  react harness + one-core's zero-cost probes and once-per-process pins
  (die with their concepts, replaced by driver-attach pins) + the
  pre-registration scar (dies with the era) + per-instance options become
  reset parameters (devChecks, arenaInitInts) + the ~15 direct-construction
  spec files + the harness WeakMap keying and ALL cross-reset microtasks
  (debounced unsubscribe, settle drain, lifecycle flush — engine-epoch
  guarded).
- **S6 comments + guide** — headers, the index.ts introduction, READMEs,
  graphviz glossary, banned-word grep gates.
- **S7 final** — bytecode strategy REPLACED (review finding: name-keyed
  budgets can silently measure a renamed collision): per-module unique
  top-level names for budgeted functions + a collision-detection assertion
  in the suite (fails on `name2` symbols); budget re-pin audit; full
  7-family bench A/B vs the pre-refactor anchor; outcome document.

Reclamation (plans/2026-07-07-signal-reclamation.md) lands as **S5R** after
S5, and its requirements shape S5's design (lifecycle rooting, aux-slot
backreference, engine epoch).

## 11. Verification protocol

Per stage: cosignal suite (corpus + bytecode inside) · oracle suite · react
suite · conformance ×3 · typecheck ×3 · bench trio interleaved A/B vs the
stage anchor (flat within spread or STOP) · S2 adds elements-kind probes ·
S7 the full matrix vs the pre-refactor anchor. Oracle edits: name
co-evolutions throughout; the R-1 semantic list in S5 only. Bytecode: unique
budgeted names + collision assertion (§10 S7); rows deleted with inlined
functions, each justified.

## 12. Standing risks for the verification pass

1. The nodeIndex lifecycle — a column the free-hook scrub misses, or a
   consumer that reads a stale cached nodeIndex off a node object after
   reuse.
2. The E7 orchestration conversion — transient seams during its rewires
   that a gate can't see (ordering invariants across the retirement fan).
3. The R-2 matrix and the custom-equals topology — sufficient to referee
   order AND count at every aligned site?
4. The R-6 precondition + scrub checklist — anything still missing.
5. Protocol v2's allocator envelope — a fork call position outside the
   documented three (render, commit, settlement listeners).
6. The rebuild-scope split (growth = graph only) — any mechanism state
   that growth's mid-episode timing can still invalidate.
