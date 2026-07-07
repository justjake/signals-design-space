# The Great Refactor — one always-concurrent engine, composed mechanisms

STATUS: REVISION 2, for re-review. Revision 1 was reviewed adversarially by
codex (not-ready: 7 blockers, 4 majors) and an independent max-effort reviewer
(another-pass: 2 blockers, 6 majors); every finding is resolved in this text,
and the owner ruled on the six items that needed him (2026-07-07, §1a). No
code moves until the re-review round's findings are discussed with the owner.

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
  `mintSeq`→`nextSeq`, the fork's `getOrMintBatchToken`→
  `getOrCreateBatchToken`).
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
R-4 Column density: the graph stores a NODE ORDINAL in each node record's
    memory at allocation (a field, written once — an internal packing
    detail, never an identity, never a map). Engine columns index by
    ordinal; identity remains the kernel record id alone.
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
| `graph.ts` | packed dependency graph: NodeField/LinkField/NodeFlag/RecordGeom enums (RecordGeom is the renamed kernel `Arena` geometry — frees the word), allocation (records carry the R-4 node ordinal), link/unlink, propagate/checkDirty family, update/notify/run/dispose, flush queue, growth/rebuild, `nextSeq` | `memory`, `watermark`, allocator heads, `values`/`fns` columns, walk scratch, `queued`, `cycle`, `activeSub`, `batchDepth` (the SYNCHRONOUS `batch()` effect-flush counter — kernel-native, unrelated to Batch.ts; review finding, now owned) |
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
pattern if the gate objects); column indexing uses the R-4 ordinal (read from
record memory), NOT a cross-module RecordGeom shift — the shift appears only
inside graph.ts and the checker seam's data handoff.

### 3.2 State threading: factories with a swap point, one engine, no class

CORRECTED from revision 1 (review finding): the kernel's speed identity is
NOT bare module `let`s — hot functions capture `memory` as a closure constant
inside a rebuilt op table whose unique hidden class is measured worth 15-25%.
The mechanism modules keep exactly that pattern: each exports a factory that
closes over its state and returns its op table; engine.ts composes the
factories and holds the swap point (growth rebuild and `__resetEngineForTest`
re-run factories and re-link tables — the existing `createEngine`/carry
mechanism, generalized). Cross-module reads are table calls; cross-module
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

### 3.4 Protocol v2 (fork change; design corrected per review)

The fork's batch registry keeps a stable per-batch Slot on every creation
path (verified: render-phase, transition, discrete/sync all funnel through
one creation site). v2 changes:

- At Slot creation the fork calls the driver's REGISTERED ALLOCATOR
  (`allocateBatchId(deferred)`) — the driver→React id-allocation edge the
  revision-1 sketch lacked (the listener bus is void broadcast and cannot
  return values; the allocator is a dedicated registration, not a listener).
- `slot.token` stores the returned BatchId; every protocol surface
  (`getCurrentWriteBatch`, `runInBatch`, retirement + commit reports) speaks
  it. `getOrMintBatchToken` → `getOrCreateBatchToken`.
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
it). Engine columns index by the R-4 NODE ORDINAL stored in record memory —
dense in node count, immune to the shared node/link allocator's holes
(review finding: link records dominate the id space ~3:1; ordinal indexing
keeps columns packed-SMI where record-id indexing would go holey/dictionary
on hot read paths, multiplied per arena).

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
  the ordinal; per-arena `nodeToShadow` re-keys by ordinal.
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

As revision 1 (single-caller + trivial inline; keep-list: budget-pinned
names, V8 split families, cold throwers, bench-pinned fast arms, hoisting-
required policy functions, referee surface, `visibleAt` as the documented
readability exception). Dead code deleted in S0: `__kernelGen` — NOTE
(review): S2's P3 seam is a NEW kernel-GEN referee read designed with S2,
not a resurrection; `captureActive`.

## 8. Comments, docs, and the guide

As revision 1 (fresh self-contained module headers; the index.ts package
guide; citation-token deletion; real prose at the shim's CR5 ordering
guarantee, the K1 ghost, the "HEAD order" comment, the graphviz glossary),
plus: the module headers are written in the final vocabulary from birth (no
transitional prose), and the four banned/retired words (plane, mint, token,
pass-standalone) are grep-gated in S6.

## 9. Magic numbers

As revision 1, updated: `WriteKind` replaces the HostOp/OpKind twins
(§1 ruling); `NotifyKind` in deliver.ts; the WEAK link-mode bit named in
ArenaLinkField; ArenaGeom absorbs A_STRIDE/A_SHIFT/A_CLOCK_LIMIT; walk-guard
cap named; the named-const list (tape rebase, pool cap, default/min records,
scratch seeds, eval stack, pow2 floor); `BATCH_NONE`; checker-seam
MARK/CLOCK_LIMIT extensions for the arena-sd hand-copies.

## 10. Staging

- **S0 prep** — dead code, named consts, checker-seam extensions.
- **S1 renames in place** — R1 arena domain; R2 token→batch + BatchSlot +
  trace kinds + oracle name co-evolution; R3 pass→RenderPass family +
  oracle; R4 ride-alongs (WriteLog, WriteLogEntry, committedAdvance,
  nextSeq + mint sweep, map convention, misc). Class renames skipped
  (the class dies in S5).
- **S2 one id space** (monolith) — P1(both halves)/P2/P3 tests first, the
  merge of id spaces, the ordinal column re-key, AND the harness
  co-evolution IN-STAGE (review blocker): the twin's id-equality assertions
  become ordinal/name-keyed, the checker and decode layers audited for
  id-shape assumptions, leak probes + bench trio + elements-kind probes.
- **S3 protocol v2** (fork + driver) — the allocator registration, Slot
  field, the three converted flag sites, `getOrCreateBatchToken`, mapping
  tables deleted, fork tests updated.
- **S4 extraction** — grouped by the REAL dependency structure (review
  finding: worlds/arenas/settlement/retirement are strongly connected):
  E1 errors + deliver's queue; E2 observation; E3 WriteLog; E4 Batch;
  E5 the SCC group {World, WorldArena, settlement} extracted together as
  factories with one internal table; E6 Subscription; E7 RenderPass (+ the
  retirement orchestration's cross-module mutation converted to table
  calls); E8 graph.ts + suspense.ts + lifecycle.ts out of index.ts;
  E9 engine.ts assembly. Pure moves + in-scope inlining; each E gate-green.
- **S5 the merge** — hooks die, §4 shapes land, attachDriver, adoption
  family deleted, R-2 equality unification (pinned tests), R-3 effect-write
  classification (corpus vocabulary + coverage), the class dissolves,
  `__resetEngineForTest` (R-6: watermark scrub + epoch), THE ORACLE EDIT
  LIST (R-1 license): delete model `registered`/register-op/guards/quiet
  clause; add writing-core-effect ops; equality order/count alignment.
  Test-scope workstream (review-expanded): TwinDriver + oracle-adapter +
  react harness + one-core's zero-cost probes and once-per-process pins
  (die with their concepts, replaced by driver-attach pins) + the
  pre-registration scar (dies with the era) + per-instance options become
  reset parameters (devChecks, arenaInitInts) + the ~15 direct-construction
  spec files + the harness WeakMap ordinal keying and the debounced-
  unsubscribe cross-reset microtask (guard by engine epoch).
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

## 12. Standing risks for the re-review

1. The E5 SCC-group extraction — is the {World, WorldArena, settlement}
   grouping sufficient, or does retirement (E7) belong inside it?
2. R-4 ordinal: allocation-site cost (one extra memory write per node
   record) and any consumer the ordinal misses.
3. The S5 oracle edit list — complete? (Attack: any model semantics beyond
   registration/equality/effect-writes that the merge implicitly changes.)
4. The reset scrub — state it would miss (fable's checklist is folded in:
   kernel lets, configure leakage, lifecycle queue + its scheduled
   microtask, settleTap, trace attachment, armed epilogue checks; find
   more).
5. Protocol v2's allocator registration — reentrancy (allocator called
   during a React render? during commit?), multiple-driver guard.
6. R-2/R-3 pinned-test sufficiency for the two sanctioned behavior changes.
