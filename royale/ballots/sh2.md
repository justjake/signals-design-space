## judge packages/signals-royale-fh1

> Historical naming: `signals-royale-fx2` is now named `cosignals`.
score out of 10: 9.1
favorite thing: Worlds as visibility predicates over one versioned write history make the 167-line seam remarkably clean.
least favorite thing: The roughly 1.95x Alien geomean and resumed-pass staleness caveat keep the elegant model from feeling completely closed.
something you learned: A per-root committed view can be a cutoff over the operation history rather than a separately materialized snapshot.

## judge packages/signals-royale-fh2
score out of 10: 9.3
favorite thing: The fiber-granular runWithLane design is the most explicit and convincing bridge between draft delivery and React scheduling.
least favorite thing: The 2,733-line library and per-component useSyncExternalStore-plus-reducer machinery are a substantial tax for that precision.
something you learned: Scheduling a no-subscriber root lane can provide a deterministic close edge for a write-only batch.

## judge packages/signals-royale-fm1
score out of 10: 8.5
favorite thing: Value-aware polling over a compact replay log gives strong revert semantics with a small 188-line fork and 1,780-line library.
least favorite thing: The reentrant canonical-set suppression regression and lack of a React abandonment edge expose fragility at the graph-world boundary.
something you learned: Suppression around canonical replay must be per-atom and consumed before a synchronous effect flush can reenter the writer.

## judge packages/signals-royale-fm2
score out of 10: 8.7
favorite thing: The 48-line inert host protocol is an excellent demonstration that React can expose scheduling facts without owning signal policy.
least favorite thing: Dead-lane batches can linger and every transition retirement knowingly spends a value-equal subscriber render.
something you learned: Layout-effect claims can record per-root committed views only for renders that actually reached the screen.

## judge packages/signals-royale-fx1
score out of 10: 9.1
favorite thing: Pinning an episode lane on the transition object yields a tiny 80-line bridge and excellent urgent-interruption latency.
least favorite thing: Computed construction and Cellx remain roughly six to seven times Alien despite otherwise strong propagation results.
something you learned: MVCC pass frames plus a scheduling-ordered atom queue can preserve both tear-free reads and urgent-write rebase.

## judge packages/signals-royale-fx2
score out of 10: 8.9
favorite thing: Carrying worlds in React state reduces the fork to an audacious 11 lines while keeping the engine near a 1.28x Alien geomean.
least favorite thing: A direct latest() call before any fx2 hook in an urgent pass can still inherit the previous pass's world.
something you learned: A useSyncExternalStore snapshot can be only a subscription epoch while React state transports the speculative world separately.

## judge packages/signals-royale-sh1
score out of 10: 8.3
favorite thing: The entry covers the full shared battery in only about 1,217 library lines and a 94-line fork.
least favorite thing: The 3.93x summed core slowdown and fresh-promise retry caveat are large costs for such a compact implementation.
something you learned: A small transactional write set plus weakly keyed root worlds can cover surprisingly broad concurrent semantics.

## judge packages/signals-royale-sm1
score out of 10: 7.2
favorite thing: The single dispatch-ordered history and explicit root-pending and event-end protocol form a rigorous concurrency model.
least favorite thing: A 320-line fork, 2,146-line library, and roughly 6.2x Alien geomean make the mechanism too expensive overall.
something you learned: Event-closure and root-pending callbacks give a userland runtime enough evidence to prune lanes without guessing from commits alone.

## judge packages/signals-royale-sm2
score out of 10: 8.1
favorite thing: Replacing the incumbent-derived fork with a 186-line lane-fact protocol was a major architectural correction without losing gate coverage.
least favorite thing: The capsule engine remains about 2.99x Alien and carries complex per-world dependency and root-retirement bookkeeping.
something you learned: Emitting commit-stop after layout lets a mount-time corrective update keep its lane pending before the capsule retires.

## judge packages/signals-royale-sx1
score out of 10: 6.6
favorite thing: One operation log provides a conceptually uniform basis for canonical, latest, render, and committed folds.
least favorite thing: The 476-line fork, partial async and interruption proof, and Cellx run that failed to finish after fifteen minutes are serious liabilities.
something you learned: A compact source count can conceal pathological complexity when every view is implemented as a global log fold.

## judge packages/signals-royale-sx2
score out of 10: 7.9
favorite thing: The canonical async-cell model stays coherent across pending, stale, error, and draft state in a 112-line fork and compact library.
least favorite thing: The 4.443x summed core slowdown and graph-wide computed subscriber invalidation leave substantial performance debt.
something you learned: Marking a computed observed before its first effect-driven evaluation prevents repeated validation from exploding in deep lazy DAGs.
