# FX2 simplify-loop backlog

These are working leads, not a locked priority order. The implementer chooses
one coherent candidate per round. Accepted, rejected, and retry evidence lives
in `RESULTS.md`; a rejected item stays here only when its recorded retry
condition still leaves a useful direction.

## Open leads

- Cache React shared internals once, if React object replacement is not a supported runtime transition.
- Drain settled thenable sets without snapshot arrays while preserving clear-before-observable-work and thrown-flush cleanup.
- Remove internal uses of `untracked(() => ...)`; converge on direct graph/world mechanisms that restore every collector correctly.
- Continue scheduled-effect ownership convergence only if a real owner or version mirror disappears without mixing React policy into graph mechanism.
- Converge Atom and Computed construction only with retained-allocation and V8 pretenuring parity.
- Replace the shallow/deep resolver split with one resolver only if the common shallow path remains equal or better.
- Converge pull validation between computed and watcher paths without hiding watcher disposal semantics in a helper.
- Converge world-key construction without reintroducing deferred string flattening or extra collections.
- Remove `pokeRebasedAtom`'s temporary Set only with dense-draft controls.
- Simplify lifetime transitions only if both the common zero-crossing call and flush-time snapshot/closure work disappear coherently.
- Simplify `ErrorBox` branding without adding a registry or compatibility representation.
- Add a non-allocating pendingness query only if it is simpler than constructing the complete affected-draft list.
- Normalize rebase-log lifecycle ownership without changing retirement timing or adding retained cursor state.
- Simplify graph traversal storage only with explicit reentrancy and GC-retention proof.
- Remove unmounted scopes from historical draft audiences if no late correction still consults them.
- Remove duplicate hook ownership only after preserving hook order and missing-provider diagnostics.
- Delete dead switches and wrappers only when one coherent owner disappears; keep `FORBID_WRITE_FROM_COMPUTED` enabled.
- Converge package and harness test adapters as a measurement-free maintenance round.
- Have `materializeAtom` return the materialized value so its callers do not re-read `atom.value`.

## Recorded retry leads

- Validate cached world membership against canonical `liveDrafts` after content-clock changes; retry only under the Round 46 conditions.
- Move `draftRevisionByAtom` into `RebaseLog`; retry the exact Round 48 model only under a stable control window.
- Replace internal ambient-state getters with ESM live bindings; retry the exact Round 50 three-getter diff under a stable control window.
- Let React own scheduled-effect versions; retry only with the Round 42 write/rerender controls.
- Drain settled thenable membership directly; reuse the Round 39 mechanism only with a stable construction control.
- Remove the world equality fallback only after a natural compiler/runtime/layout change; do not source-shape-tune the Round 43 deletion.

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

