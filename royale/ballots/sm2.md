## judge packages/signals-royale-fh1

> Historical naming: `signals-royale-fx2` is now named `cosignals`.
> score out of 10: 8.8
> favorite thing: The 167-line raw-facts seam and predicate-based histories keep React policy-free while preserving updater-order replay.
> least favorite thing: A yielded pass can still commit a pre-urgent value when it first discovers an otherwise unsubscribed atom, so restart correctness depends on prior subscription coverage.
> something you learned: A world can be represented as a cutoff plus visible batch IDs instead of an allocated overlay table.

## judge packages/signals-royale-fh2

score out of 10: 9.0
favorite thing: Fiber-granular delivery combines canonical useSyncExternalStore updates with lane-pinned draft forcing in a precise and fast design.
least favorite thing: The 2,733-line library and per-component store, reducer, and commit-reporting state impose the field's clearest mount-time complexity tax among the top entries.
something you learned: A store-only batch can obtain a guaranteed close edge by scheduling its lane on a root even when no fiber update exists.

## judge packages/signals-royale-fm1

score out of 10: 8.3
favorite thing: Value-aware edge polling and one call-order rebase log produce compact code with unusually explicit replay semantics.
least favorite thing: The canonical-set suppression mechanism needed two fix rounds to survive synchronous reentrancy, and silent React abandonment still has no direct close edge.
something you learned: Replay suppression must be consumed before subscriber notification because an effect can synchronously write another atom before the outer set returns.

## judge packages/signals-royale-fm2

score out of 10: 7.1
favorite thing: The 48-line fork exposes just enough render-slice state for userland to own worlds, replay, and per-root views.
least favorite thing: Unmounting a root with a parked transition can leave its batch live indefinitely, which violates the tournament's quiescence and no-leak contract.
something you learned: Layout-effect reporting can ground committed views in what actually reached the screen while naturally excluding suspended and discarded renders.

## judge packages/signals-royale-fx1

score out of 10: 9.2
favorite thing: Engine-owned episode lanes deliver an 80-line fork, strong lifecycle closure, and the best demonstrated React responsiveness in the field.
least favorite thing: The 2,343-line library is sizable, and topology-only isPending can report pending work whose folded value is unchanged.
something you learned: Claiming a lane once and pinning it on a transition object lets later deliveries join the same commit across event boundaries.

## judge packages/signals-royale-fx2

score out of 10: 7.6
favorite thing: Carrying world IDs in ordinary React reducer state reduces the fork to 11 mutation-window lines while retaining near-Alien core performance.
least favorite thing: A plain latest call early in an urgent render can resolve the previous pass's world, leaving an acknowledged required render-context tear.
something you learned: External worlds can ride React's own update queues through rebases and retries instead of mirroring lane state in the library.

## judge packages/signals-royale-sh1

score out of 10: 6.5
favorite thing: The final 1,217-line library and 94-line fork pack a broad transactional feature set into remarkably little source.
least favorite thing: isPending evaluates the target and can therefore refetch, while fresh inline promises still lack stable retry identity.
something you learned: Dependency tracking can stay linear for common tiny lists and promote to a Set only after a measured width threshold.

## judge packages/signals-royale-sh2

score out of 10: 5.9
favorite thing: The typed-array node slab and intrusive edge arena are the field's most distinctive data-oriented engine design.
least favorite thing: Abandoned overlays, committed computed views, and general transformed async evaluations remain explicitly incomplete correctness work.
something you learned: Slab allocation can make raw signal creation exceptionally cheap without guaranteeing fast propagation or world folding.

## judge packages/signals-royale-sm1

score out of 10: 6.7
favorite thing: Event-end and remaining-lane edges give the operation log a principled way to close both rooted and external-only episodes.
least favorite thing: The 320-line fork and 6.55-times core gap are costly, and the mutation window opens before React's before-mutation phase rather than exactly at host mutation.
something you learned: An event-end callback cleanly retires transition-classified external writes that never schedule work on any root.

## judge packages/signals-royale-sx1

score out of 10: 5.2
favorite thing: The 1,295-line library has disciplined per-source subscriptions and unusually thorough finalizer-backed handle reclamation.
least favorite thing: The 476-line fork is the field's largest, fresh-promise identity remains incomplete, and Cellx could not emit one result after fifteen minutes.
something you learned: A contextual computed read must invalidate its canonical cache afterward or a draft evaluation can poison ordinary reads.

## judge packages/signals-royale-sx2

score out of 10: 7.3
favorite thing: A 112-line fact-oriented fork and 1,367-line library form a compact, coherent lane-keyed async-cell implementation.
least favorite thing: Direct Atom.set calls during render bypass the binding's lane-probe guard, and arbitrary fresh-promise expressions remain an admitted async risk.
something you learned: Pinning an allocation-free canonical world around computed evaluation makes nested latest reads obey their evaluation context.
