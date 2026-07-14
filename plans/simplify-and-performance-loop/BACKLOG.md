# FX2 simplify-loop backlog

These are working leads, not a locked priority order. The implementer chooses
one coherent candidate per round. Accepted, rejected, and retry evidence lives
in `RESULTS.md`; a rejected item stays here only when its recorded retry
condition still leaves a useful direction.

## Open leads

- Delete the zero-production-caller `currentDraftChange` and `isErrorBox` exports with the next related source change. The runtime call site that made the Round 64 brand deletion measurable disappeared with `useCommitted`; do not retain test-only production APIs.
- Correct comments that still describe deleted `committed()` / per-root committed views or the removed requestAnimationFrame pump; do not spend a performance round on comment-only residue.
- Delete dead switches and wrappers only when one coherent owner disappears; keep `FORBID_WRITE_FROM_COMPUTED` enabled.

## Current priority after the split-effect rewrite

1. Make each watcher's pinned `Link` the sole dependency owner: remove the duplicate effect `compute` reference, copied label, and unused dynamic-tracking cursor state if construction, retained-size, promotion, and inlining probes improve without shape polymorphism regressions.
2. Delete watcher staleness marks if falsification confirms `Scheduled` plus queue membership fully owns pending work. Current effect drains and render delivery clear watcher stale bits without reading them; keep computed visited-set behavior byte-for-byte.
3. Give each lane one reentrancy owner. First add a same-lane nested-drain falsifier for `flushScheduledEffects()` inside a cleanup/handler; only then replace the sync-only `flushing` owner if cursor and tail ownership remain exact.
4. Let the before-paint microtask also settle lifetime transitions, deleting `lifetimeFlushScheduled` and its separate microtask only if activation ordering, StrictMode flaps, and `onObserved` writes remain exact.
5. Merge `WatchDraft` into `WatchRender` if the current invariant remains true that every render subscriber is draft-aware and every effect is base-only; keep draft cutoff and pendingness coverage.
6. Collapse the React commit-marker/rendered/committed handshake only if descendant layout ordering can make the committed stash canonical while preserving held transitions, aborted renders, hydration, silent folds, and late-subscription repair.
7. Compare a smaller two-shape watcher design with fusing the private effect compute and watcher. The latter can delete one node, one pinned link, and one propagation hop, but must preserve async settlement, deferred equality, nested ownership, and lane ordering.
8. After the commit handshake no longer needs mutable connection state, test using React's stable reducer dispatch as the root identity so the connection wrapper and provider `useMemo` can disappear without changing multi-root audience or tracer identity.
9. Make `worldsReducer` allocate its draft-id array only when membership changes while still returning a fresh wrapper for a repeated live id, which deliberately restarts a transition render after later writes.
10. Specialize atom world memos only if their one-entry certificate can collapse into direct revision/value fields while preserving certificate inheritance, memo identity, retirement, retained heap, and GC behavior.

## Other unmeasured broader leads

- Remove `draftEvaluate`'s per-evaluation `worldUse` closure and captured suspension cell only if one saved/restored ambient suspension owner is clearer and allocation-free under nested/reentrant evaluation; keep the Round 37 synchronous, fulfilled, suspension, and error controls.
- Reuse `Draft.world` for one-live-draft `worldOf` results instead of rebuilding an equivalent world object; first prove signature, identity, render-lane, retirement, and memo semantics against the Round 67 controls.
- Move world-memo ownership off every producer only if a module-level weak owner preserves quiescent sweeping and collection while deleting the per-node field and global strong sweep list; keep construction, retained-heap, finalization, and GC controls.
- Avoid allocating a computed world state that equality immediately replaces with the prior state; preserve error/suspension identity, custom equality, trace order, and world memo stability.
- Encode dependency-link membership in an existing detached pointer sentinel only if promotion, trimming, disposal, and GC invariants remain direct; retry the Round 19 narrow/wide lifecycle and dynamic-tracking controls.
- Specialize the lane-pump protocol now that only after-paint is host-configurable; delete sync/before-paint impossible pump fields and the stale defensive before-paint pre-drain only if nested drains, hidden/headless hosts, and total lane order remain exact.
- Remove the per-render `RenderWorldNote` object only if scalar ambient owners plus a generation token preserve same-stack root handoff, suspended renders, and stale scheduled expiry.
- Lazily allocate a thenable's parked-node and parked-suspension Sets on first membership; preserve invalidate-before-resolve ordering, mixed base/world consumers, throwing settlement, and collection.
- Move node and draft causal storage into tracer-owned weak state only if detached execution loses `causeEvent`, `openEvent`, and `lastWriteEvent` fields/stores while queued delivery, late wakes, session replacement, and GC remain exact.
- Unify the tracer's root and suspension object-ID allocators only if semantic numbering remains stable; this is attached-tracer-only cleanup, not a runtime-path round.
- Replace `RenderedResolution.live` with an existing nullable state only if first render, aborted render, hydration, and late subscription repair remain distinguishable without a hidden mode.
- Give the three Royale adapters one shared autorun shim and the four playground bridges one shared legacy split-effect composer; both utilities have multiple callers, but keep conformance and measurement surfaces frozen while extracting them.
- Converge the render-notify double buffer with lane queue state only if nested delivery still cannot overwrite a buffer under iteration; this is a high-risk follow-up to per-lane reentrancy, not an independent first round.

## Recorded retry leads

- Move `draftRevisionByAtom` into `RebaseLog`; retry the exact Round 48 model only under a stable control window.
- Replace internal ambient-state getters with ESM live bindings; retry the exact Round 50 three-getter diff under a stable control window.
- Remove the world equality fallback only after a natural compiler/runtime/layout change; do not source-shape-tune the Round 43 deletion.
- Have `materializeAtom` return the materialized value; retry the exact Round 52 model only after a natural compiler/runtime change and with both eager and lazy controls.
- Build both multi-draft world keys from canonical `Draft[]` and delete `latestWorld`'s parallel ID array; retry the exact Round 67 `worldFromDrafts` plus materialized-signature diff only after a natural compiler/runtime/layout change, keeping all 12 frozen modes.
- Select rebased draft audiences from canonical `liveDrafts` plus `Draft.atoms`, deleting the intent scan and temporary Set; retry the exact Round 69 diff only after a natural compiler/runtime/layout change, keeping the sparse unrelated-draft mode as a hard gate.
- Move Computed methods from own slots to a shared object-literal prototype; retry the exact Round 72 `__proto__` diff only after a natural compiler/runtime/layout change, keeping retained-size, no-GC construction, 1.2M pretenuring/subwindow, read, and Atom controls.
- Replace hosted drafts' parallel recipient/audience Sets with one audience-status Map plus pending count; retry the exact Round 74 diff only after a natural compiler/runtime/layout change, keeping the 64-root lifecycle as a hard gate.
- Make hosted-draft audience history weak while strong recipients continue to own retirement; retry the exact Round 76 Set-to-WeakSet diff only after a natural compiler/runtime/layout change, keeping non-empty construction/retirement modes as hard gates.
- Replace the mutable thenable-settlement installer with the direct ESM binding; retry the exact Round 86 semantic diff only after a natural layout/runtime change or separately stable suspension-control window, retaining both artifacts' pre/post manifests and all four frozen modes.
- Keep the computed-cycle throw extraction parked: after the latest plain-value fast path `recompute` is pinned at 590 bytes, farther above V8's 460-byte limit than Round 90's 464-byte shape. Reconsider only after a natural change moves the whole function near the limit; do not source-shape-tune it or retry the slower shared helpers.

## Completed or deliberately closed

- Scope ownership and React root naming.
- Tracer diagnostic ownership, causal events, weak delivery retention, and removal of `draftWakeStats`.
- One dynamically traversed collection for `draftsAffecting`.
- The stale `draftsAffecting` import in `index.ts` was removed; `react/host.ts` remains its real production consumer for late-subscription repair.
- Canonical `liveDrafts` validates cached world membership after broad content changes; unchanged membership retains identity and skips normalization/allocation, while included retirement or discard still rebuilds.
- Direct graph/async bindings; mutable installer seams removed.
- Direct atom propagation ownership; sole-caller `propagateFrom` removed.
- Draft revision ownership candidate investigated and restored under inconclusive timing.
- Internal live-binding candidate investigated and restored under inconclusive timing.
- Orphaned React error channel removed in favor of tracer events.
- React client-internals container cached once; mutable `H` and `T` fields remain live reads.
- `ensureFresh` owns detached graph and world-source collector isolation; the two internal `untracked(() => ensureFresh(...))` adapters are gone.
- Package and root-harness conformance adapters share one test-only handle and computed-write policy owner; the root adapter only overrides its result slug.
- Private `ErrorBox` class identity owns error branding; the duplicate `WeakSet`, factory, and accidental public type/guard exports are gone.
- Computed pendingness traverses current dependencies and early-exits through canonical atom rebase logs; it no longer constructs an exact draft-id list for a boolean answer, while atoms retain their direct fast path.
- Thenable membership sets exist only while pending; settlement detaches and traverses them directly, terminal boxes retain no collections, and the first terminal callback wins.
- Throwing settlement notifications still restore `currentCause` and release detached suspensions before the original notification error escapes; an unchanged noisy control cannot veto this supported-surface correctness fix.
- Effects are a tracked private compute plus an untracked handler delivered by one lane watcher; the old React-owned scheduled-effect versions, dependency arrays, world-source watcher, and rerender handshake are gone.
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
