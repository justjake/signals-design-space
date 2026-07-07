# The Great Refactor — one always-concurrent engine, composed mechanisms

STATUS: DRAFT for adversarial review. No code moves until the reviews' findings
are discussed with the owner. Inputs: the structure map, naming audit, jargon
audit, and magic-number audit (2026-07-07), plus the owner's rulings below.

## 1. Mandate (owner rulings, 2026-07-07, verbatim where it matters)

- "The code is huge, monolithic, and abstracted. CosignalBridge is a 5000-line
  class. This is not acceptable." Divide the monoliths into well-factored
  mechanisms that we compose. Scope: all of index.ts, all of concurrent.ts.
- "I do not think it's worth 'installing' concurrency. We should always be
  doing the concurrent things; having the layering between the two just makes
  everything harder to understand, and it duplicates concepts."
- Inline utility functions with a single caller (example: `makeKernelGetter`)
  and trivial single-expression functions — except load-bearing splits.
- Apply the jargon, naming, and magic-number cleanups as we go.
- ONE NODE ID SPACE: always use the kernel record id; the dense id space dies.
- Vocabulary rulings: `Tape` → **WriteLog** (`atom.log`); `ShadowArena` →
  **WorldArena**; Int32Array buffers are **memory** (+ **watermark**), kernel
  included; **World stays** (not Branch); **batch everywhere, token deleted**
  (not transaction); slot → **BatchSlot**, set form **BatchSlotSet**, both
  internal to the batch module; maps named `<from>To<to>`; "pass" dies as a
  standalone word → **RenderPass**; the word **"plane" stays banned**.
- File naming: a module named after its main exported type is `MainType.ts`
  (WriteLog.ts, Batch.ts, WorldArena.ts, RenderPass.ts, World.ts,
  Subscription.ts); mechanism modules are lowercase (graph.ts, engine.ts,
  settlement.ts, observation.ts, suspense.ts, lifecycle.ts, deliver.ts).
- vendor/react is NO LONGER PROTECTED. Evergreen; no backward compat anywhere.
  Approved fork change: **protocol v2** — the driver supplies the BatchId at
  batch open; every protocol surface speaks BatchId; the mapping tables die.

## 2. Non-goals and invariants

- NO observable behavior change, with exactly two ruled exceptions:
  (a) protocol v2 changes the React↔engine number handshake (invisible to
  applications); (b) the test-isolation pattern changes from
  many-engine-instances to one-engine-plus-reset (invisible to applications).
- The reference model's SEMANTICS are untouched. Oracle edits are limited to
  mechanical name co-evolution (renamed ops/events/fields), each listed in the
  stage that makes it, so lockstep comparison stays exact.
- No public API redesign beyond the deletions and renames listed here.
- No performance regressions: every stage passes the bench gates below with
  STOP authority. The kernel's speed identity (same-file const-enum inlining,
  the V8 split families, the bench-pinned fast arms) survives by construction.

## 3. Target architecture

### 3.1 Module map

| File | Main export / contents | State it owns |
|---|---|---|
| `graph.ts` | the packed dependency graph: record layout enums (NodeField, LinkField, NodeFlag, RecordGeom — the current kernel `Arena` enum renamed to free the word), allocation, link/unlink, propagate/checkDirty family, update/notify/run/dispose, flush queue, growth/rebuild | `memory`, `watermark`, allocator heads, `values`/`fns` side columns, walk scratch, `queued`, `cycle`, `activeSub` |
| `WriteLog.ts` | `WriteLog` (per-atom pending-write history: batch, seq, op, payload, retirement stamp), compaction, rebase | per-atom logs, `uncompactedAtoms`, compaction cursors |
| `Batch.ts` | `Batch`, `BatchId`, `BatchSlot`/`BatchSlotSet` (internal encoding), open/retire/settle lifecycle, slot interning + reclamation, committed-bits rebuild | `idToBatch`, slot table, live count, ambient batch |
| `World.ts` | `World` (the visibility rule `visibleAt`, folding `foldAtom`, `applyOp`, `eqAtom`), `evaluate`, read routing (active world, sinks, tracked/untracked readers) | active world, routing state, eval marks/depth, fold-callback guard |
| `WorldArena.ts` | `WorldArena` (one world's packed graph copy + folded values: `memory`, links, dirty lists, suspended list), the `arena*` walk family, serve/update/checkDirty, claim/release/pool/decay, fan-out | `rootToArena`, pool, arena frames, serve override |
| `RenderPass.ts` | `RenderPass`, `Watcher`, start/yield/resume/end, mount/adopt/defer, snapshots, mount fixup, `commitBatches` (né commitTokens), restaled bookkeeping | `idToRenderPass`, `rootToOpenRenderPass`, `idToWatcher`, `nodeToWatchers` |
| `deliver.ts` | delivery walks, the notification queue (NotifyKind enum), `correctWatcher`, committed-observer drains | walk scratch, notify columns |
| `Subscription.ts` | `Subscription` (committed-policy observers), capture frames, revalidation at boundaries | `idToSubscription`, capture frame, counts |
| `settlement.ts` | suspense settle tap, queue, drain loop, the operation epilogue | settle queue/set, drain flags, op depth |
| `observation.ts` | the observation index (retain/release shifting over dependency closures) | `obsRefs`, `obsDeps`, capture list |
| `suspense.ts` | `SuspendedRead`, thenable instrumentation, `ctx.use`, exception storage, self-heal reads | use-cache keys, sentinel minting |
| `lifecycle.ts` | observed-lifecycle option: states, flap-damped flush | states map, queue |
| `engine.ts` | composition root: `Atom`/`Computed`/`ReducerAtom`/`effect`/`effectScope`/`batch()`/`untracked`/`configure`, THE write path (quiet fold | recorded write), quiet derivation, quiesce/epoch, the driver seam, probes, errors (`ScheduleError`, `InvariantViolation`), `__resetEngineForTest` | quiet flag, seq/committedAdvance clocks, driver slot, devChecks |
| `index.ts` | thin barrel: public exports + THE PACKAGE GUIDE (the entrypoint introduction: what each module is, the six load-bearing concepts defined once, how a write travels) | none |
| `trace.ts`, `graphviz.ts` | unchanged roles; renamed vocabulary; graphviz gains a four-line glossary header | — |

Each module owns its const enums same-file (the tsx inlining rule shapes
boundaries). Cross-module calls are direct imported-function calls (fine under
both toolchains); cross-module const enums appear ONLY on cold paths (the W10
precedent) — reviewers should hunt for accidental hot-path violations.

### 3.2 State threading: one engine, module state, no class

Mechanism state lives in module-scope bindings (the kernel's current style —
the fast style), initialized by each module. There is ONE engine per process.
`CosignalBridge` is deleted — not renamed — during extraction; no engine class
replaces it. Public classes remain `Atom`/`Computed`/`ReducerAtom`.

Consequence: multi-instance engines die. Today they exist only as a test
affordance (TwinDriver constructs a fresh bridge per test; the foreign-bridge
isolation test exists only because registration exists). Replacement:
`__resetEngineForTest()` — a full-state reset generalizing the existing growth
rebuild (createEngine carry) + quiesce machinery. Test-harness rework is a
scoped workstream (TwinDriver, oracle-adapter, react harness) in S5.

### 3.3 The driver seam (all that survives of "installing")

The React package installs ONE record, once:

```ts
engine.attachDriver({
  batchContext(): BatchId,          // 0 = none; protocol v2 makes this OUR id
  worldFor(): World | undefined,    // the render's world, if a render is open
  onDelivery / onMountCorrective / onCorrection,  // re-render scheduling sinks
})
```

That replaces: `__setHostWrite`/`__setHostRead`/`__setHostComputedRead`/
`__setSettleTap`, `registerBridge`/`registerReactBridge` arming,
`writeClassifier`, `readAdopter`, `setWorldProvider`, the three notify-sink
setters, `activeBridge`, `publiclyRegistered`, and `syncReadRouting`'s
dynamic hook arming (becomes one inline routing check).

### 3.4 Protocol v2 (fork change, owner-approved)

The fork's batch-open path asks the driver for an id (or accepts one on its
batch record); every protocol surface — `unstable_getCurrentWriteBatch`,
`unstable_runInBatch`, retirement and commit reports — then speaks that
BatchId. The deferred flag moves from low-bit number encoding into the
open event's payload. `reactBatchToBatch`/`batchToReactBatch` both die; the
per-classified-write Map.get dies with them. Return type stays `number`
(BatchId is a number) — no React-side allocation. 0 remains "no batch
context" (`BATCH_NONE` named constant). Fork tests updated in the same stage.

## 4. The merge (always-concurrent)

Deleted outright (from the seam inventory): the 4 hook setters, the 11
`__host*`/`__kernel*` seam functions and `__HOST_MISS` (each inlines into its
now-same-module caller), `hostWriteImpl`/`hostReadImpl`/`hostComputedReadImpl`/
`settleTapImpl`, the `registered` concept, `bridgeApplying` (its purpose —
suppressing hook re-entry during eager apply — dies with the hooks; S5 must
verify no other consumer), `_hostStamp` (dies in S2 with the id merge), the
re-export block (index.ts becomes the barrel).

Final public read/write shapes (engine.ts):

```
Atom.set(v)    → write(kind=SET, v):    policy asserts → quiet? quietFold : recordedWrite(driverBatch())
Atom.state     → activeSub? graph.read : routingActive? routedRead : graph.read
Computed.state → activeSub? graph.computedRead : routingActive? routedComputedRead : graph.computedRead
```

`quiet` remains the derived flag (registered-clause deleted; a driver-attached
clause is NOT added — quiet derives purely from pipeline state, and with no
driver no batch can ever open). Eager apply becomes: one code path writes
graph memory and the WriteLog together — no cross-package seam, no re-entry
guard, no mirror vocabulary.

## 5. One id space

The kernel record id (premultiplied dense index) is THE `NodeId`, package-wide.
Engine side columns index by `id >> RecordGeom.SHIFT`. Deleted: the dense id
space, `nextNode`, `nodeGen`, `byKernelId` (map convention moot — the map
itself dies), `indexNode`'s allocation half, `_hostStamp` on both handle
classes (adoption = column presence), the exported `KernelId` alias (merged
into `NodeId`).

Proof obligations (S2 gates, tests written FIRST):
- P1 generation coincidence: every path that retires an engine node must
  coincide with the kernel record free (disposeComputed, quiesce, watcher
  teardown) so the kernel GEN stamp alone provides reuse tenancy. Enumerate
  the paths; a divergence is a STOP finding, not a workaround.
- P2 column slack: side columns become sized to ALL kernel records (effects
  and scopes occupy ids). Leak-audit probes re-run; a growth probe pins the
  slack is bounded (columns grow with the record arena, not independently).
- P3 arena `nodeToShadow` (`byNode`) inside WorldArena re-keys by the same
  shift; the walk code changes are mechanical but touch the hottest arena
  paths — bench trio gates S2 specifically.

## 6. Naming (the complete old→new table lives with S1's commits)

Headline renames beyond the rulings already listed: `AF`/`AFlag` →
`ArenaField`/`ArenaLinkField`/`ArenaFlag` + `ArenaGeom` (STRIDE, SHIFT,
CLOCK_LIMIT — closing the module-const demotion exposure); `a*` function
family → `arena*`; `cas` → `committedAdvance`; `tp` → `log`; `kid` →
`kernelId`→ plain `id` post-S2; `sr` → `suspendSentinel`; `{b,n}` stamp keys
die with the stamp; Subscription locals `e` → `sub`; `dirtyAtoms` →
`uncompactedAtoms`; `adoptMount`/`deferMount` → `adoptRevealedMount`/
`deferMountEffects`; trace kind strings rename with their concepts
('pass-start' → 'render-start', 'batch-*' stay, 'retired' stays; no
recorded-trace compat — evergreen ruling); 'referee marker' phrasing leaves
shipped vocabulary (the two post-consequence kinds are documented as commit
checkpoint markers); graphviz `tape:N` label → `log:N`. The kernel walk family
(propagate/checkDirty/link) keeps upstream names — the twin-drift protection
depends on side-by-side reading, and the arena twins now say `arenaPropagate`.
Maps: `<from>To<to>` everywhere (`nodeToWatchers`, `rootToArena`,
`idToBatch`, …).

## 7. Inlining policy

Inline: every single-caller utility and trivial single-expression function in
the structure map's list — including `makeKernelGetter`,
`makeAdoptedKernelGetter`, `makeCtxWorldFn`, `routedRead`, `boundaryWork`,
`throwFold`, `scheduleLifecycleFlush`, `attachSettle` — EXCEPT the keep-list:

- bytecode-budget-pinned names (each budget row is keyed by function name);
- the V8 split families: link/linkInsert, checkDirty/chainCheck/
  checkDirtyLoop, computedRead/computedReadSlow/boxedRead, arenaCheckDirty/
  arenaCheckDirtyLoop, arenaFoldOutcome/arenaEqCold/arenaSyncObsAfterRefold,
  the cold throwers (walk-cycle guards);
- the three bench-pinned write-path fast arms (comments carry the numbers);
- hoisting-required policy functions (ctxPrevious/ctxUse feeding POLICY_CTX);
- the referee/test seams and the public operational surface the lockstep
  harness drives;
- `visibleAt` — single-caller but THE visibility rule; kept as a named
  function deliberately (readability exception, documented at the site).

Dead code deleted in S0: `__kernelGen`, `captureActive`.

## 8. Comments, jargon, and the guide

Every extracted module gets a fresh self-contained header (what it is, its
terms defined or pointed at index.ts's guide, how it composes). index.ts
carries the package introduction: the reading order, the six load-bearing
concepts (write log, batch, world, arena, render pass, watcher), and the
life-of-a-write walkthrough. The jargon audit's ~190 sites resolve by its own
finding: delete citation tokens where the rule is stated inline (the vast
majority); real prose at the four exceptions (the shim's CR5 ordering
guarantee spelled out; the K1 ghost paragraph deleted; the "HEAD order"
comment rewritten; graphviz glossary). Stage codes, § references, ruling
dates, review ids, seed citations, "referee"/"lockstep"/"oracle" all leave
shipped comments; bench-pinned numbers stay (numbers, not ids).

## 9. Magic numbers

The audit's 17 fixes land as: S0 — checker-seam MARK/CLOCK_LIMIT for the
arena-sd hand-copies; walk-guard cap named; tape-rebase, pool cap, default/min
records, scratch seeds, eval-stack depth, pow2 floor named consts. S1 — the
`ArenaGeom` fold, the WEAK link bit member, `NotifyKind`, kernel `HostOp`
enum (same-file twin of the batch module's op codes), trace op-code derived
from OP_NAMES. S3 — `BATCH_NONE` for the protocol sentinel (replacing the
fork-token 0 comments). Deferred-bit constant dies with protocol v2.

## 10. Staging

Every stage: explicit-path commits, full gate stack (below), STOP on any gate
breach — the finding goes to the owner before workarounds.

- **S0 prep** — dead code, named consts, checker-seam extensions. Cheap.
- **S1 renames in place** (so extraction diffs are pure moves) — four commits:
  R1 arena domain (ArenaField family, arena*, memory, WorldArena);
  R2 token→batch everywhere + BatchSlot + trace kinds + oracle co-evolution;
  R3 pass→RenderPass family + oracle co-evolution; R4 ride-alongs (WriteLog,
  committedAdvance, map convention, misc). Class renames are SKIPPED —
  CosignalBridge dies in S5, renaming it first is wasted churn; its name
  survives S1-S4 as a known-dead name.
- **S2 one id space** (in the monolith, before extraction shrinks review
  surface): proofs P1-P3 as failing-first tests, then the merge of id spaces.
  Leak probes + bench trio mandatory.
- **S3 protocol v2** (fork + driver): driver-supplied BatchId, deferred flag
  in the open payload, mapping tables deleted, fork tests updated.
- **S4 extraction** — dependency order, one commit per module: errors+notify
  → observation → WriteLog → Batch → Subscription+settlement → WorldArena
  (module functions, then the class-state slice) → World → RenderPass →
  graph.ts+suspense.ts+lifecycle.ts out of index.ts → engine.ts assembly.
  Pure moves + the inlining policy applied to moved code. The straddlers
  (endRenderPass orchestration, retirement, writeInner, quietWrite,
  settlementDrain) live in their owning module as orchestrators that call
  mechanisms — reviewers should attack the ownership choices.
- **S5 the merge**: hooks die, read/write paths fuse per §4, attachDriver,
  the class dissolves into module state, `__resetEngineForTest`, test-harness
  isolation rework, T8-style registration tests re-pinned or deleted with
  their concept. The corpus referees this stage above all.
- **S6 comments + guide**: headers, the index.ts introduction, README
  updates (kernel/bridge story → engine story), graphviz glossary.
- **S7 final**: bytecode budget re-pin audit (keys renamed with functions,
  rows deleted with inlined functions — each deletion justified), full
  7-family CI bench A/B against the pre-refactor anchor, outcome document.

## 11. Verification protocol

Per stage: cosignal suite (corpus + bytecode inside) · oracle suite ·
cosignal-react suite · conformance ×3 · typecheck ×3 · the bench trio
(spkw write family, spkw-quiet, cold-pass/wide-mask gates) as interleaved
A/B against the stage-start anchor, flat within run-to-run spread or STOP.
S7 additionally runs the full 7-family matrix against the pre-refactor
anchor. The oracle changes only by listed name co-evolutions. Bytecode
budget keys migrate in the same commit as any rename; function moves across
files keep names (the suite measures a bundle by name).

## 12. Risks and open questions (reviewers: attack these)

1. One-engine singleton + reset-for-test — is any production embedding lost?
   (Decided: no multi-instance; the reviewers should try to break the reset
   seam's completeness — POISON/growth interplay, module-state coverage.)
2. P1 generation coincidence — find a path where engine-node retirement and
   kernel record free diverge (watcher-held nodes? adopted-then-disposed
   computeds? quiesce ordering?).
3. Column slack (P2) — effects/scopes inflating engine columns: bounded?
4. Module boundaries and hot paths — find a hot-path cross-module const enum
   or a call that today inlines within the class and won't across modules
   (aServe→foldAtom? evaluate→arenaServe? deliver→queueNotify?).
5. Protocol v2 — does the fork have a stable per-batch record at open time
   on every batch-creation path (transitions, discrete events, deferred)?
   Where exactly does the driver's id get stored?
6. The quiet derivation without `registered` — can quiet be true before a
   driver attaches while a manual `openBatch` exists? (It must not; the
   live-batch clause covers it — verify.)
7. The straddler ownership choices in §10 S4.
8. Anything in the always-concurrent merge that changes WHEN kernel effects
   fire for standalone (no-driver) programs (they must keep firing exactly
   as the kernel does today — the conformance kernel framework pins this).
