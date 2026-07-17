## judge packages/signals-royale-fh1

> Historical naming: `signals-royale-fx2` is now named `cosignals`.
> score out of 10: 8.7
> favorite thing: The visibility-predicate model gets robust replay, root views, and quiescent cleanup without allocating whole world tables.
> least favorite thing: Correctness of resumed passes still leans on subscriber pokes, leaving the admitted unsubscribed-atom staleness risk.
> something you learned: A render world can be represented compactly as a sequence cutoff plus a set of visible batches folded over per-signal history.

## judge packages/signals-royale-fh2

score out of 10: 8.8
favorite thing: Fiber-granular delivery on the owning lane is precise, fast, and backed by unusually thorough engine and React testing.
least favorite thing: The 2,733-line library and per-component subscription machinery are a large complexity and mount-cost tax.
something you learned: React's lane can serve directly as both batch identity and the scheduling handle for corrective subscriber renders.

## judge packages/signals-royale-fm1

score out of 10: 8.3
favorite thing: Value-aware dependency edges compose elegantly with a single call-ordered rebase log and keep reverted writes from propagating.
least favorite thing: Per-root committed semantics remain materially weaker for computeds and long-idle roots than for atoms.
something you learned: A one-shot per-atom suppression token is necessary when replay writes can synchronously trigger unrelated reentrant writes.

## judge packages/signals-royale-fm2

score out of 10: 8.1
favorite thing: The 48-line inert host protocol is an excellent demonstration of how little React-specific mechanism the library actually needs.
least favorite thing: The mutation-window stop is outside the mutation call's finally block, and abandoned root work can also leave a batch live.
something you learned: Layout-effect value capture can provide exact per-root committed views without adding cost to the signal write path.

## judge packages/signals-royale-fx1

score out of 10: 8.8
favorite thing: Engine-owned episodes with a lane pinned onto the React transition deliver excellent interruption latency through a very small fork.
least favorite thing: The 2,343-line library carries substantial episode, frame, speculative-dependency, and async-context complexity.
something you learned: Corrective joins and async settlements can share one commit when the store owns a stable lane for the entire episode.

## judge packages/signals-royale-fx2

score out of 10: 8.2
favorite thing: An 11-line mutation-only fork paired with React-carried world state is the field's boldest and smallest integration design.
least favorite thing: Plain latest() in a render before any fx2 hook can still resolve the previous pass's world, which is a real required-semantics corner.
something you learned: A reducer and context inside the React tree can carry external-store world identity without any lane bookkeeping in the fork.

## judge packages/signals-royale-sh2

score out of 10: 6.5
favorite thing: The typed-array node slab and reusable intrusive edge slab are a distinctive, allocation-conscious foundation.
least favorite thing: Permanent batch abandonment, committed computeds, and general transformed async computations remain explicitly incomplete.
something you learned: Numeric handles can make raw atom creation extremely cheap even when the surrounding concurrent engine remains propagation-bound.

## judge packages/signals-royale-sm1

score out of 10: 6.7
favorite thing: The final single operation history states dispatch ordering directly and is supported by a genuinely independent randomized oracle.
least favorite thing: A 320-line fork and roughly 6.19-times Alien core slowdown are too much mechanism and cost for the resulting design.
something you learned: Keeping urgent and deferred operations in separate groups silently destroys global updater-queue order even when each group is internally ordered.

## judge packages/signals-royale-sm2

score out of 10: 7.8
favorite thing: Per-batch reducer capsules are an understandable middle ground between full world copies and replaying a global tape on every read.
least favorite thing: The rewritten design is still about three times Alien overall and loses the final React fanout, transition, and mount comparisons.
something you learned: Materialized batch values preserve updater ordering if every urgent operation is also flowed through each live capsule.

## judge packages/signals-royale-sx1

score out of 10: 6.2
favorite thing: The checkpointed operation log unifies canonical, render, latest, and committed reads in a conceptually direct way.
least favorite thing: Cellx failed to emit a single row after fifteen minutes, while fresh-promise retry identity and pass disposition also remain incomplete.
something you learned: Retaining urgent operations only after a draft has rendered can model React's rebase checkpoint without copying whole worlds.

## judge packages/signals-royale-sx2

score out of 10: 7.4
favorite thing: The compact canonical-cell engine and 112-line fork achieve full battery coverage with a relatively small total source surface.
least favorite thing: Core throughput is about 4.44 times Alien and arbitrary placeholder-consuming or fresh-promise async expressions remain risky.
something you learned: Pinning an allocation-free canonical world during computed evaluation prevents nested latest() from leaking ambient drafts into canonical caches.
