# Binding constraints for fork-diet synthesis

1. **The DOM mutation window (onBeforeMutation/onAfterMutation) is REQUIRED**
   (owner, 2026-07-08). It serves the PROMPT.md MutationObserver use case
   (userspace must disconnect its observer while React mutates the DOM) —
   it is unconsumed by alt-a/alt-b but is NOT deletable. Both Fable reports'
   deletion items covering it (alt-a §1.3 ~59 LoC; alt-b D3 ~90 LoC) are
   overridden. Treat it as a fixed cost in every curve point including the
   minimal protocol.
2. runInBatch + transition-lane pin: keystone, irreducible (unanimous).
3. Any registry-relocation plan (alt-a's F2) must preserve alt-b's consumed
   registry behaviors (backfill, re-pend lock-ins, async-action parking) or
   price their loss explicitly.
4. **Fork-side LoC is the top objective; raw React facts MAY cross the
   boundary** (owner, 2026-07-08, superseding the earlier "no lanes, no
   fibers escape React" rule — owner explicitly regrets it). The fork
   exposes, in React's own terms (lanes, roots/containers, thenables), only
   what userspace physically cannot see or do; ALL cooked/nicety layers
   (batch identity, merge, backfill, lock-ins, parking) move OUT of the
   fork. Rationale: teammate feedback that React-fork code is ~10× less
   desirable to own than monorepo TypeScript.
5. **No duplication across engines**: the relocated registry logic lives
   ONCE, in a shared monorepo package (working name
   `packages/react-signals-utils`), consumed by both bridges. This
   dissolves the synthesis §1.1 objection to F2 (2× re-implementation);
   the drift-risk findings there become the shared package's test
   obligations (oracle/fuzz coverage for backfill, lock-ins, parking).
