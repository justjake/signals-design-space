## judge packages/signals-royale-fh1

> Historical naming: `signals-royale-fx2` is now named `cosignals`.
score out of 10: 9.3
favorite thing: The 167-line fact-only seam and per-atom ordered history form the cleanest end-to-end concurrency model in the field.
least favorite thing: The nearly two-thousand-line library still admits a resumed-pass staleness corner for unsubscribed atoms.
something you learned: A render world can be represented as a cutoff plus a small batch predicate instead of a materialized overlay.

## judge packages/signals-royale-fh2
score out of 10: 9.1
favorite thing: Fiber-granular subscriptions give draft delivery exact ownership while the Alien-shaped graph stays only 1.28 times behind its baseline.
least favorite thing: The 2,733-line library and direct root-scheduling hook make the design harder to audit than its seam count suggests.
something you learned: React lanes can serve directly as batch keys when the host can both force a lane and schedule a root-only close edge.

## judge packages/signals-royale-fm1
score out of 10: 8.7
favorite thing: Value-aware polling and a compact replay engine preserve equality cutoffs without sacrificing the full concurrent feature set.
least favorite thing: The direct-set fix required a second suppression fix, and epoch-based committed views stop being exact after snapshot history is released.
something you learned: Per-edge seen values can make write-then-revert batching disappear without weakening lazy push-pull invalidation.

## judge packages/signals-royale-fm2
score out of 10: 8.9
favorite thing: The entire React mechanism is only 48 production lines yet still delegates world choice and update ordering cleanly to React.
least favorite thing: The host has no dead-lane prune edge, so an unmounted parked transition can leave a batch live for later lane reuse.
something you learned: Layout-effect commit reports can make per-root committed views ground truth without storing speculative values in React state.

## judge packages/signals-royale-fx1
score out of 10: 9.4
favorite thing: Engine-owned episode lanes yield an 80-line fork, precise corrective joins, and the strongest demonstrated urgent-under-load behavior.
least favorite thing: The 2,343-line library still allocates sets and frames in important delivery paths and deliberately over-reports pending derived values.
something you learned: Pinning a lane on the transition object lets async settlements and late subscribers rejoin an episode across separate events.

## judge packages/signals-royale-fx2
score out of 10: 8.6
favorite thing: Reducing the fork to an 11-line mutation hook while retaining a green battery and near-Alien core speed is exceptional.
least favorite thing: A plain latest call early in a hook-free render can still inherit the previous pass's world, and the mutation stop lacks a finally guard.
something you learned: React state and context can carry speculative world membership so the fork need not know anything about signal batches.

## judge packages/signals-royale-sh1
score out of 10: 8.0
favorite thing: At 1,217 library lines and 94 fork lines, SH1 covers an astonishing amount of the required surface with readable machinery.
least favorite thing: The pending probe can evaluate computeds and the async model relies on stable external promises, while core throughput is nearly four times Alien.
something you learned: A small transaction write set can be sufficient when React supplies the rendering world and retirement boundary.

## judge packages/signals-royale-sh2
score out of 10: 7.0
favorite thing: The typed node and intrusive edge slabs are a bold, concrete attempt to make canonical allocation costs explicit.
least favorite thing: Committed computeds, permanent abandonment, and general async transforms remain partial, while the global lane pin is cleared when the first root commits.
something you learned: Typed-array storage can make atom creation extremely cheap without making propagation automatically fast.

## judge packages/signals-royale-sm2
score out of 10: 7.4
favorite thing: The capsule model keeps hostless writes direct and produces a compact 1,524-line library after replacing the inherited fork.
least favorite thing: Independent capsules do not compose operations across simultaneously included batches, so the oracle validates last-capsule-wins instead of a true ordered fold.
something you learned: Commit-stop after layout is a useful boundary because mount-time corrective updates can keep their owning lane pending before retirement.

## judge packages/signals-royale-sx1
score out of 10: 6.1
favorite thing: The generic external-runtime API is carefully documented and its mutation bracket is robust across commit errors and View Transitions.
least favorite thing: The claimed ordered log is a render-dependent three-phase fold, the 476-line fork is the field's largest, and Cellx did not finish in fifteen minutes.
something you learned: Whether urgent work arrives before or after a draft has rendered is not a safe substitute for preserving global dispatch order.

## judge packages/signals-royale-sx2
score out of 10: 7.0
favorite thing: The corrected per-atom operation history and 112-line fork give the entry a much stronger foundation than its first-round status suggested.
least favorite thing: Direct atom writes during render bypass the binding guard, dropped top-level effects have no finalizer, and async settlement can return an untransformed promise value.
something you learned: A lane bitmask can be both batch identity and render-world selector, avoiding a per-render batch-array allocation.
