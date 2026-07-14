# FX2 simplify-loop backlog

These are working leads, not a locked priority order. The implementer chooses
one coherent candidate per round. Accepted, rejected, and retry evidence lives
in `RESULTS.md`; a rejected item stays here only when its recorded retry
condition still leaves a useful direction.

## Open leads

- Remove the now-unused internal `draftsAffecting` import from `index.ts` with the next source change touching that import block; do not spend a standalone performance round on emit-elided cleanup.
- Delete dead switches and wrappers only when one coherent owner disappears; keep `FORBID_WRITE_FROM_COMPUTED` enabled.
- Restore the Node 24 inlining gate without hiding `recompute` behind a larger budget: it is 503 bytecodes, above V8's 460-byte inline limit. Audit the stale `writeAtom`, `flush`, and `resolveState` pins separately because those functions remain below the limit or are deliberately over it.

## Recorded retry leads

- Validate cached world membership against canonical `liveDrafts` after content-clock changes; retry only under the Round 46 conditions.
- Move `draftRevisionByAtom` into `RebaseLog`; retry the exact Round 48 model only under a stable control window.
- Replace internal ambient-state getters with ESM live bindings; retry the exact Round 50 three-getter diff under a stable control window.
- Let React own scheduled-effect versions; retry only with the Round 42 write/rerender controls.
- Remove the world equality fallback only after a natural compiler/runtime/layout change; do not source-shape-tune the Round 43 deletion.
- Have `materializeAtom` return the materialized value; retry the exact Round 52 model only after a natural compiler/runtime change and with both eager and lazy controls.
- Delete the private one-caller `isErrorBox` guard; retry the exact Round 64 diff only after a natural compiler/runtime/layout change and keep its committed error/value, base error/value, and direct-brand controls.
- Build both multi-draft world keys from canonical `Draft[]` and delete `latestWorld`'s parallel ID array; retry the exact Round 67 `worldFromDrafts` plus materialized-signature diff only after a natural compiler/runtime/layout change, keeping all 12 frozen modes.
- Share the atom/watched-clean-computed pull decision between computed and watcher validation; retry the exact Round 68 two-caller helper only after a natural compiler/runtime/layout change, keeping all six frozen modes and watcher disposal at its caller.
- Select rebased draft audiences from canonical `liveDrafts` plus `Draft.atoms`, deleting the intent scan and temporary Set; retry the exact Round 69 diff only after a natural compiler/runtime/layout change, keeping the sparse unrelated-draft mode as a hard gate.
- Move Computed methods from own slots to a shared object-literal prototype; retry the exact Round 72 `__proto__` diff only after a natural compiler/runtime/layout change, keeping retained-size, no-GC construction, 1.2M pretenuring/subwindow, read, and Atom controls.
- Replace hosted drafts' parallel recipient/audience Sets with one audience-status Map plus pending count; retry the exact Round 74 diff only after a natural compiler/runtime/layout change, keeping the 64-root lifecycle as a hard gate.
- Make hosted-draft audience history weak while strong recipients continue to own retirement; retry the exact Round 76 Set-to-WeakSet diff only after a natural compiler/runtime/layout change, keeping non-empty construction/retirement modes as hard gates.
- Replace the mutable thenable-settlement installer with the direct ESM binding and delete `currentDraftChange`; retry the exact Round 86 semantic diff only after a natural layout/runtime change or separately stable suspension-control window, retaining both artifacts' pre/post manifests and all four frozen modes.

## Completed or deliberately closed

- Scope ownership and React root naming.
- Tracer diagnostic ownership, causal events, weak delivery retention, and removal of `draftWakeStats`.
- One dynamically traversed collection for `draftsAffecting`.
- World-cache membership candidate investigated and restored under its failed control.
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
- Scheduled effects use the graph watcher's links as their sole dependency-identity owner and the committed-value array length as its sole count; React's parallel link-head and count fields are gone while React retains comparison and scheduling policy.
- `releaseDraft` owns dead-prefix folding and the zero-live log/world-memo sweep; retirement and discard no longer coordinate a repeated two-call teardown protocol.
- React root connections own their committed draft IDs directly; the committed-world WeakMap now serves only external container keys, and the test-only root `committedSnapshot` export is gone.
- Atoms and plain world memo records omit the impossible async payload; computed nodes retain their stable nullable slot, and async world records retain their ErrorBox or Suspension.
- Drafts now have one live state, `open`, plus the distinct terminal `retired` and `discarded` outcomes; the unsupported `sealed` state, `sealDraft`, equivalent branches, and test-only calls are gone.
- Nullable one-shot `Suspension.resolve` owns pendingness, identity reuse, and settlement; the parallel `settled` boolean is gone.
- `graph.withWorld` owns the selected world and both graph collectors; draft evaluation no longer wraps it in `untracked`, and scheduled effects establish their collectors inside the world boundary.
- React owns `useIsPending`'s external boolean snapshot; specialized `useCommitted` retains its faster root-local identity check and repairs writes around layout attachment exactly once.
- Shared graph-traversal scratch was rejected as slower and harder to follow; retain invocation-local `WaveFrame` and `PokeFrame` chains.
- Lifetime-context convergence into Atom was rejected before editing: its retained `get`/`set` capability is deliberately base-only and untracked, unlike public world-aware/policy-bearing Atom methods.
- Shallow `ensureFreshAt` and deep `chainResolve` remain distinct: one uses the JS stack for common branching graphs, while the other adds reusable iterative scratch only after depth 16 so 150,000-node unary chains do not overflow.
- The Round 73 nested-discard value-loss case is closed from the active backlog: its reproducer requires direct internal `discardDraft` access or the exported reset test seam during an updater/equality callback; no normal `.` or `./react` runtime path synchronously discards a draft there. Reopen only with a supported-surface reproduction.
