# FX2 simplify-loop backlog

These are working leads, not a locked priority order. The implementer chooses
one coherent candidate per round. Accepted, rejected, and retry evidence lives
in `RESULTS.md`; a rejected item stays here only when its recorded retry
condition still leaves a useful direction.

## Open leads

- Correct comments and docs that still describe deleted `committed()` / per-root committed views, the removed requestAnimationFrame pump, two clocks, multiple unwrap owners, or React installing plural paint-lane pumps; remove implementation-history lore instead of documenting successive designs. Do not spend a performance round on comment-only residue.
- Correct `ThenableBox.parkedNodes`' comment to cover computeds and effects with the next related `asyncs.ts` source change; do not spend a performance round on comment-only residue.
- Rename private `invalidateComputed` only with the next related `graph.ts` source change; it now invalidates computeds and schedules effects, so its name no longer covers the full mechanism.
- Delete dead switches and wrappers only when one coherent owner disappears; keep `FORBID_WRITE_FROM_COMPUTED` enabled.

## Current priority by concept convergence

Round 127's post-Round-125 source/profile/history survey and near-miss revisit
found no further simplification with an equal-or-better execution path. Resume
only after a natural adjacent layout/runtime change satisfies a recorded retry
condition, or after human review broadens the work to algorithm or scheduling
design.

## Other unmeasured broader leads

- Specialize atom world memos only if direct revision/value fields reduce net types, branches, and code while preserving certificate inheritance, memo identity, retirement, retained heap, and GC behavior; do not add a parallel memo representation for speed alone.
- Avoid allocating a computed world state that equality immediately replaces with the prior state; preserve error/suspension identity, custom equality, trace order, and world memo stability.
- Encode dependency-link membership in an existing detached pointer sentinel only if promotion, trimming, disposal, and GC invariants remain direct; retry the Round 19 narrow/wide lifecycle and dynamic-tracking controls.
- Remove the per-render `RenderWorldNote` object only if scalar ambient owners plus a generation token preserve same-stack root handoff, suspended renders, and stale scheduled expiry.
- Move node and draft causal storage into tracer-owned weak state only if detached execution loses `causeEvent`, `openEvent`, and `lastWriteEvent` fields/stores while queued delivery, late wakes, session replacement, and GC remain exact.
- Cache `latestWorld()` by live-draft membership only if open, retire, and discard remain its sole invalidators, creation order stays exact, and dead `Draft` records are released immediately.
- Converge the render-notify double buffer with lane queue state only if nested delivery still cannot overwrite a buffer under iteration; this is a high-risk follow-up to per-lane reentrancy, not an independent first round.

## Recorded retry leads

- Remove the last internal `Computed.peek()` untracked adapter only after a natural compiler/runtime/layout change; retry the exact Round 109 source plus pending/collector falsifiers with all five frozen modes, and do not resample or tune source shape.
- Remove `Flag.Watching` only after a natural compiler/runtime/graph-layout change; retry the exact Round 110 three-file diff with its tier falsifier, seven modes, retained-byte checks, provenance, and bytecode pins.
- Move `draftRevisionByAtom` into `RebaseLog` only after a natural runtime/world-layout change; retry the exact Round 111 source plus complete-lifetime ABA falsifier and all five modes, without tombstones, retained empty logs, or an atom field.
- Converge effect-run release only after a broader effect-lifetime change removes first-error aggregation from successful child-release reruns; retain Round 112's six modes and thrown-`undefined`, sibling, ordering, poisoning, tracing, and unlink falsifiers without options/callbacks/results.
- Delete `RenderedResolution.live` only after a natural React/runtime layout change; retry the exact Round 114 three-file diff with direct hydration, first mount, held render, empty-world, repair, resolved-runtime coverage, and all four frozen modes. Do not vary the sentinel representation or resample the stable rerender regression.
- Have `materializeAtom` return the installed/current value only after a natural compiler/runtime/layout change; retry the exact Round 115 source and custom-equality falsifier with all seven frozen modes. Do not tune the return expression or resample the eager-first-read regression.
- Move world-memo ownership off every producer only after a natural runtime/lookup-layout change; retry the exact Round 117 replaceable module `WeakMap` design with its property-shape and live-draft GC falsifiers plus all ten frozen modes. Do not add a cache, hybrid owner, or resample the stable lookup regressions.
- Collapse read/write prohibition into one scalar policy only after a natural compiler/runtime/guard-layout change; retry the exact Round 119 three-state model with its error/restoration falsifiers and all eight frozen modes. Do not tune the tag values or guard expressions around the stable hot-path regressions.
- Remove the world equality fallback only after a natural compiler/runtime/layout change; do not source-shape-tune the Round 43 deletion.
- Build both multi-draft world keys from canonical `Draft[]`, reuse `Draft.world` for singleton `worldOf`, and delete `latestWorld`'s parallel ID array only after a natural compiler/runtime/layout change; retry the exact Round 116 diff with all 13 frozen modes. Do not vary signature materialization or resample the stable multi-draft regressions.
- Select rebased draft audiences from canonical `liveDrafts` plus `Draft.atoms`, deleting the intent scan and temporary Set; retry the exact Round 69 diff only after a natural compiler/runtime/layout change, keeping the sparse unrelated-draft mode as a hard gate.
- Move Computed methods from own slots to a shared object-literal prototype; retry the exact Round 72 `__proto__` diff only after a natural compiler/runtime/layout change, keeping retained-size, no-GC construction, 1.2M pretenuring/subwindow, read, and Atom controls.
- Replace hosted drafts' parallel recipient/audience Sets with one audience-status Map plus pending count; retry the exact Round 74 diff only after a natural compiler/runtime/layout change, keeping the 64-root lifecycle as a hard gate.
- Make hosted-draft audience history weak while strong recipients continue to own retirement; retry the exact Round 76 Set-to-WeakSet diff only after a natural compiler/runtime/layout change, keeping non-empty construction/retirement modes as hard gates.
- Remove render-watcher staleness and let `Scheduled` plus queue membership own pending notification; retry the exact Round 95 model only after a natural propagation-layout change, keeping first-cause base waves, latest-cause draft pokes, the 280-byte `propagateWave` pin, and both notification controls.
- Direct-index tracer events only after a natural tracer layout makes the oldest retained ID canonical without another private owner or a public-field behavior change; retain Round 97's empty, wrapped, stopped, replacement-session, exposed-event-mutation, malformed-ID, and causal-chain falsifiers.
- Lazily allocate only `ThenableBox.parkedNodes` after a natural async/runtime/layout change removes first-membership and nullable-settlement costs; retry the exact Round 126 shape with synchronous fulfillment/rejection, world-only pending, base pending/settlement, and suspension construction frozen, without variants or resampling.
- Use React's stable reducer dispatch as the root identity only after the commit handshake disappears or a broader commit-layout change already owns its active-root marker; retry the exact Round 100 design with the frozen host-transition mode as a hard gate, not by tuning the rejected ESM-binding shape.
- Let `useValue`'s pending-draft Set also own the zero repair sentinel only after a natural representation/runtime change; retry the exact Round 104 design with mount and 100-write burst modes as hard gates, retaining the scalar boolean until then.
- Restore the React transition slot directly to null only after a naturally stable React-control window; retry the exact Round 105 one-file diff with all three modes, callback mutation/throw invariants, sampler provenance, and an independent controller emission.
- Let the before-paint lane request also own lifetime settlement only after a natural runtime/scheduling change; retry the exact Round 107 source, docs, focused suite, and five modes without adding another token, callback, or ordering representation.
- Keep the computed-cycle throw extraction parked: after the latest plain-value fast path `recompute` is pinned at 590 bytes, farther above V8's 460-byte limit than Round 90's 464-byte shape. Reconsider only after a natural change moves the whole function near the limit; do not source-shape-tune it or retry the slower shared helpers.

## Completed or deliberately closed

- Scope ownership and React root naming.
- Commit-handshake collapse is closed until React exposes different ordering: making the committed stash canonical during root confirmation requires a second marker or insertion-effect phase to keep the root registered before descendant layout effects.
- The sole-caller `expiryFor` helper remains: its exact TypeScript 7 inline regressed expiry arming 6.58% and the pre-reviewed paired arm/control ratio 13.63% in Round 102. Reopen only after a natural toolchain change, not with callback syntax variants.
- `worldsReducer` always returns a fresh React state wrapper but reuses the canonical draft-ID array while live membership is unchanged; only adding or pruning materializes a replacement array.
- `WatchRender` alone identifies render subscribers for both base delivery and draft awareness; the duplicate `WatchDraft` capability is gone, while `WatchRunEffect` remains base-only.
- Render subscriptions alone own one permanent pinned `Link`; their dedicated watcher shape has six fields and no effect-only state.
- Tracer diagnostic ownership, causal events, weak delivery retention, and removal of `draftWakeStats`.
- One dynamically traversed collection for `draftsAffecting`.
- The stale `draftsAffecting` import in `index.ts` was removed; `react/host.ts` remains its real production consumer for late-subscription repair.
- Canonical `liveDrafts` validates cached world membership after broad content changes; unchanged membership retains identity and skips normalization/allocation, while included retirement or discard still rebuilds.
- Direct graph/async bindings; mutable installer seams removed.
- Direct atom propagation ownership; sole-caller `propagateFrom` removed.
- Draft revision ownership candidate investigated and restored under inconclusive timing.
- Internal live-binding candidate investigated and restored under inconclusive timing.
- Internal `activeConsumer`, `currentWorld`, and `currentPark` consumers now read their canonical ESM live bindings directly; the three zero-policy getter wrappers and ten calls are gone while public `getActiveTracer()` remains a function.
- The playground's `alt-a`, `alt-b`, and `cosignals` adapters share one three-caller split-effect composer; Solid and Royale retain their distinct lifecycle mechanisms.
- Tracer ring `head` plus `size` own occupancy; private slots are non-optional and `events()`/`find()` no longer defend against impossible holes.
- Root and suspension trace IDs share one two-caller allocation mechanism while retaining two weak owners and separate fixed per-session numbering.
- Public effect-scope, batch, start/end-batch, and untracked controls are direct graph re-exports; their five local runtime alias bindings are gone.
- Public `flushScheduledEffects` is a direct graph re-export; its import-only local binding and separate export are gone.
- Lane state owns only queue, cursor, and request state; before-paint schedules directly, and one scalar after-paint pump is the sole host-configurable scheduler owner.
- Orphaned React error channel removed in favor of tracer events.
- React client-internals container cached once; mutable `H` and `T` fields remain live reads.
- `ensureFresh` owns detached graph and world-source collector isolation; the two internal `untracked(() => ensureFresh(...))` adapters are gone.
- Package and root-harness conformance adapters share one test-only handle and computed-write policy owner; the root adapter only overrides its result slug.
- Private `ErrorBox` class identity owns error branding; the duplicate `WeakSet`, factory, and accidental public type/guard exports are gone.
- Computed pendingness and late-subscription repair share the one exact `draftsAffecting` closure walk; the former consumes only whether its returned ID list is empty, while atoms retain their direct fast path.
- One `graphChangeClock` now owns base writes, draft activity, and thenable settlement; a base-change watermark preserves the narrower single-draft cutoff question, and the parallel draft clock plus settlement installer are gone.
- `unwrapResolved` is the one resolved-state reader for values, errors, and suspension policy; the duplicate evaluation and read-site unwraps are gone, along with the zero-production-caller `currentDraftChange` and `isErrorBox` exports.
- Settlement's graph-clock tick remains necessary: user code can catch the internal parked sentinel and publish a plain/error world memo that retains no `Suspension`, so suspension-owned invalidation would require another hidden dependency representation.
- Thenable membership sets exist only while pending; settlement detaches and traverses them directly, terminal boxes retain no collections, and the first terminal callback wins.
- Throwing settlement notifications still restore `currentCause` and release detached suspensions before the original notification error escapes; an unchanged noisy control cannot veto this supported-surface correctness fix.
- One dynamically tracked `EffectNode` owns evaluation, dependencies, cleanup, delivery state, and children while sharing the computed evaluator; lane state owns delivery scheduling. The private computed, effect watcher, pinned link, observer tier, and propagation hop are gone.
- Each lane's active cursor owns same-lane drain reentrancy; the sync-only `flushing` flag is gone, test reset preserves an active cursor, and a nested before-paint flush cannot let after-paint work overtake the next before-paint round.
- `releaseDraft` owns dead-prefix folding and the zero-live log/world-memo sweep; retirement and discard no longer coordinate a repeated two-call teardown protocol.
- Per-root committed worlds, container keys, `committed()`, and `useCommitted` are gone; base state is the only committed view while React connections carry pending render worlds.
- Atoms and plain world memo records omit the impossible async payload; computed nodes retain their stable nullable slot, and async world records retain their ErrorBox or Suspension.
- Drafts now have one live state, `open`, plus the distinct terminal `retired` and `discarded` outcomes; the unsupported `sealed` state, `sealDraft`, equivalent branches, and test-only calls are gone.
- Nullable one-shot `Suspension.resolve` owns pendingness, identity reuse, and settlement; the parallel `settled` boolean is gone.
- `graph.withWorld` owns the selected world and both graph collectors; draft evaluation no longer wraps it in `untracked`, and scheduled effects establish their collectors inside the world boundary.
- Node 24 bytecode pins now match the exact accepted `writeAtom`, `flush`, and `resolveState` sizes with no headroom; `recompute` remains separately unresolved.
- React owns `useIsPending`'s external boolean snapshot; the former split-owner `useCommitted` path was subsequently deleted with the public committed-view model.
- Shared graph-traversal scratch was rejected as slower and harder to follow; retain invocation-local `WaveFrame` and `PokeFrame` chains.
- Lifetime-context convergence into Atom was rejected before editing: its retained `get`/`set` capability is deliberately base-only and untracked, unlike public world-aware/policy-bearing Atom methods.
- Shallow `ensureFreshAt` and deep `chainResolve` remain distinct: one uses the JS stack for common branching graphs, while the other adds reusable iterative scratch only after depth 16 so 150,000-node unary chains do not overflow.
- The Round 73 nested-discard value-loss case is closed from the active backlog: its reproducer requires direct internal `discardDraft` access or the exported reset test seam during an updater/equality callback; no normal `.` or `./react` runtime path synchronously discards a draft there. Reopen only with a supported-surface reproduction.
