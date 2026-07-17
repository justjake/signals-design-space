## judge packages/signals-royale-fh1

> Historical naming: `signals-royale-fx2` is now named `cosignals`.
> score out of 10: 9.1
> favorite thing: The visibility-predicate world model gets updater replay, per-root views, and quiescent reclamation from one compact per-signal history.
> least favorite thing: The resumed-pass hole for unsubscribed atoms and roughly 2x core cost keep the elegant model from feeling completely closed.
> something you learned: A world can be represented as a cutoff plus visible batches instead of an allocated overlay store.

## judge packages/signals-royale-fh2

score out of 10: 9.4
favorite thing: Fiber-granular draft delivery is rigorously connected to explicit lane pinning and an external-only close edge while remaining near Alien on core throughput.
least favorite thing: The 2733-line library and per-component subscriber machinery buy correctness and speed at a noticeable mount and comprehension cost.
something you learned: Scheduling an otherwise empty lane on an owning root gives a store-only batch a real React commit edge without inventing a second lifecycle.

## judge packages/signals-royale-fm1

score out of 10: 8.6
favorite thing: Value-aware edge snapshots make write-then-revert a true no-op while the ordered rebase log keeps speculative state conceptually direct.
least favorite thing: The canonical-set hook needed two judgement repairs, including a reentrant cross-atom regression, which makes the replay boundary feel fragile.
something you learned: A one-shot per-atom suppression consumed before synchronous notification can distinguish replay writes without swallowing reentrant effect writes.

## judge packages/signals-royale-fm2

score out of 10: 8.8
favorite thing: The 48-line inert host protocol is the cleanest small fork that still supplies render worlds, lane pinning, commits, and exact mutation edges.
least favorite thing: A permanently abandoned transition can retain a batch indefinitely because the host protocol has no prune or root-release edge.
something you learned: Layout effects can record committed screen values as ground truth because suspended and discarded renders never execute them.

## judge packages/signals-royale-fx1

score out of 10: 9.0
favorite thing: Engine-owned episodes and pinned transition objects make original deliveries, late repairs, and async settlements share one commit across separate events.
least favorite thing: The engine remains large and construction-heavy, with roughly 7x computed creation and two required read and refresh defects found only during judgement.
something you learned: Cold computeds can keep only dependency-ward pointers for collection and acquire reverse invalidation edges only when they become observed.

## judge packages/signals-royale-fx2

score out of 10: 8.7
favorite thing: Carrying world identity through ordinary React reducer and context state reduces the fork to an exceptional 11 production lines while retaining strong core performance.
least favorite thing: A plain latest call early in a render with no preceding fx2 hook can still resolve the previous pass or ambient world, leaving a required tearing corner open.
something you learned: A useSyncExternalStore snapshot can be only a subscription epoch while React state carries the actual speculative world.

## judge packages/signals-royale-sh1

score out of 10: 7.8
favorite thing: The final 1217-line transactional engine is impressively compact for the amount of React, async, tracing, SSR, and lifetime behavior it covers.
least favorite thing: isPending on a computed calls node.get in the all-transaction world, so the advertised passive probe can evaluate or refetch user code.
something you learned: A tiny flushSync scope hook can preserve urgent rebase semantics without wrapping the public flushSync in the adapter.

## judge packages/signals-royale-sh2

score out of 10: 6.9
favorite thing: The typed node slab and reusable intrusive edge arena are a distinctive allocation-conscious representation with extremely cheap raw atom creation.
least favorite thing: Permanent batch abandonment, committed computed views, and general transformed async computations remain explicitly incomplete despite the green shared battery.
something you learned: A typed slab can beat Alien at raw signal creation while still losing substantially in computed evaluation and propagation.

## judge packages/signals-royale-sm1

score out of 10: 7.2
favorite thing: The corrected single sequence-ordered operation history and remaining-lane retirement logic give the final concurrency model clear semantics.
least favorite thing: A 320-line React seam and roughly 6.2x core geomean are too much mechanism and runtime cost for the achieved result.
something you learned: An event-end callback gives external-only transition batches a principled retirement edge even when no root receives work.

## judge packages/signals-royale-sm2

score out of 10: 7.4
favorite thing: The fork rewrite replaces the incumbent-sized registry with a much cleaner 186-line lane-fact protocol and keeps the capsule engine comparatively small.
least favorite thing: Materialized per-batch values overwrite rather than compose, so overlapping batches touching one atom do not preserve a single global updater order across arbitrary retirement order.
something you learned: Commit-stop must follow layout effects so a mount-time correction can keep its owning lane pending through the corrective render.

## judge packages/signals-royale-sx2

score out of 10: 8.0
favorite thing: Canonical cells, per-root screen snapshots, and trace state have deliberately separate lifetimes in a relatively small library and 112-line fork.
least favorite thing: The 4.44x core result and direct-resource-biased async evaluator leave substantial performance and transformed-promise risk behind the otherwise broad green gates.
something you learned: Pending reads can remain graph state and form a stable aggregate thenable only when evaluation reaches a Suspense boundary.
