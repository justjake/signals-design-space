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
