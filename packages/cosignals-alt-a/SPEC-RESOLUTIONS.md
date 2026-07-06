# Coordinator-supplied spec resolutions (oracle-validated by alt-b; adopt, do not rediscover)

Working notes for the cosignals-alt-a implementation. These override/patch the shared
sections of react-concurrent-signals-arena-alt-a.md where it is ambiguous or defective.

## Seven resolutions

1. **§10.6 vs §17.2 contradiction (urgent-drain decision world).** Implement W0
   decisions PLUS per-live-deferred-world expansion: on urgent drains,
   re-validate/expand every live deferred world's memos.
2. **§9.8 "urgent writes skip the walk" is UNSOUND.** An equal-value urgent write
   onto a tape never propagates via the kernel yet shifts every pending world's
   fold. Applied logged writes must ALWAYS queue a token-0 walk.
3. **First-divergence completeness gap.** An urgent write can CAUSE first
   divergence for world k (branch flip onto k's entries) with no k-memo existing.
   Closed by the same per-live-deferred-world expansion as (1).
4. **Truncation re-notification.** Truncation must re-notify the rolled-back
   batch's lane (spec is silent; otherwise the lane is stale until an unrelated
   drain).
5. **Unmarked-nested-child certificate hole.** Overlay frames must ALWAYS recurse
   via overlayEvaluate — never take the kernel path for children inside an
   overlay frame — else unlogged grandchild sources escape the parent
   certificate.
6. **Fork double: onBatchOpened edge.** §9.1 needs it; §6.1 lacks it. Add
   onBatchOpened to the fork-double interface.
7. **Minor.** (a) Stamp ONE retire-time ticket per retirement (not per entry).
   (b) Missing-world broadcast default = current W0, with subscription-time
   seeding of live deferred worlds.

## Five pitfalls the oracle catches (build right the first time)

- Per-token walk tickets in grouped drains.
- Truncation re-notification (see resolution 4).
- W0-no-op retirement shifting other worlds.
- Snapshot-before-re-evaluate in chain re-validation.
- Re-validation ordered BEFORE broadcast decisions.
