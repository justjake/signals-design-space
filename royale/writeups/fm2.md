## How it works

FM2 divides state into canonical graph state, transition-local draft operations, and render worlds. The graph is React-independent; the binding maps
React lanes onto the engine's batches and installs the appropriate world for each render slice.

An `AtomNode` owns `base`, `canonical`, and, only while deferred work touches the atom, `queue: QueuedOp[]`. `base` is the prefix of operations that
can no longer be reordered by an open batch. `canonical` is the value visible to ordinary reads and effects: `base` folded through every currently
committed/urgent queue entry while skipping deferred entries. Each queued entry is `{batch, op}`, where `batch === null` means committed and `op` is
either `{set}` or `{fn}`. The queue therefore preserves original dispatch order without copying a value per world.

Atoms and computeds implement a small producer/consumer graph. Every producer has a version and a `Set` of subscribers. Consumers retain dependency
arrays, the versions observed, and atom values used for net-change validation. During a stable dependency shape, `trackedEvaluate` rewrites those
arrays in place. On the first shape divergence it creates three prefix copies, collects the new shape, and `reconcileDeps` adjusts live edges.
Canonical atom writes send `Check`, not unconditional `Dirty`, so downstream computeds can compare versions and recorded atom values and suppress a
write-then-revert episode.

`ComputedNode` stores one canonical settled result, a pending `Suspension`, a global-version validation stamp, canonical dependency edges, an optional
thenable cache, and a map of world results. A live computed holds push edges to its canonical dependencies. A non-live computed validates dependency
versions on pull. Equality prevents its node version from changing when recomputation produces the same value. Effects are canonical-only consumers;
they queue once per synchronous batch, validate `Check` notifications before running, dispose children before rerun, and contain cleanup errors.

`createBatch(true)` creates a `WorldBatch` with an increasing id, version, status, a `touched` atom set, and a `cacheHolders` purge set. A `World` is
simply an ordered array of open batches. `runInWriteBatch` sets the process-global `currentWriteBatch` for a synchronous scope.  `withWorld` and
`setAmbientWorld` similarly select the process-global read world.

Write classification occurs in `AtomNode.write`. With no deferred current batch, the write is urgent. It materializes a lazy initializer, applies the
operation to `canonical`, drops an equal result, and either writes `base` directly or appends a null-batch entry if deferred entries already require a
queue. It then increments the atom and global versions and notifies the canonical graph.

With a deferred current batch, `draft` reads the value in the singleton world `[batch]`, applies the operation, drops only an equal constant set,
appends a batch-tagged entry, increments the batch version, and records the atom in `batch.touched`. Functional operations are never discarded merely
because they are equal now: rebasing them against a later base may change their result.  Drafting does not alter canonical versions or canonical
computed caches.

An atom read first checks a `CommittedView`, then the ambient world. A canonical read returns `canonical`. A world read scans the queue for a relevant
deferred entry, constructs a comma-separated batch-id key and a stamp consisting of the global version plus batch versions, and folds `base` through
null-batch entries and entries owned by that world, in queue order. The result is cached per key.  `latest` uses the current computed-evaluation
world, then the ambient render world, and otherwise all open batches in id order. This context priority is why an urgent render cannot read ahead
through `latest` while an out-of-render call can still inspect newest intent.

World computed results use the same key and stamp. `worldEntry` evaluates the function under the selected world, keeps the prior settled value while
newer work is pending, and caches `{settled, pending, usedKeys}`. It intentionally runs untracked, so it neither changes the computed's canonical
dependency edges nor creates separate world dependency edges. That choice is important to both the low conceptual surface and a residual correctness
defect discussed below.

Canonical notifications propagate through the normal subscriber graph. A draft has no canonical graph event, so `notifyExternal` walks outward from
the touched producer through live computed subscribers until it reaches each `ExternalSub`.  The external listener receives the owning batch. A
visited `Set` prevents a diamond from delivering repeatedly within that walk.

Retirement preserves dispatch order rather than replaying a separate log.  `retireBatch` marks the batch retired, removes it from `openBatches`, and
calls `replayBatch` on every touched atom inside an engine batch. `replayBatch` changes matching queue entries' batch field to null in place.
`compactQueue` advances `base` only through the now-committed prefix; null entries behind another open batch remain in place. It then recomputes
`canonical` from `base` plus every remaining null entry. Thus draft `+1`, then urgent `*2`, produces urgent `2` and eventual `(1 + 1) * 2 = 4`.
Retirement notifications are canonical notifications.

`abortBatch` instead removes the batch's entries, compacts the queue, and sends another batch-specific external poke so readers that saw the draft can
repair.  Both retirement and abort purge registered atom and computed world caches and clear the batch's ownership sets. The React binding uses
retirement but has no production path to call abort.

Async computation is integrated into the same invalidation model. `sharedUse` is one allocation-free function shared by all computeds.  During an
evaluation it looks up a thenable by the supplied key (or the thenable itself) and refresh epoch, attaches settlement handlers for a new entry,
returns a value, throws an error, or throws a `Suspension`. A pending episode retains the same `Suspension` object across reads, and that object is
thenable via `Promise.race`. Forwarded pending dependencies can be aggregated when evaluation continues through stale values. A first unresolved
direct `use` still throws immediately, so two direct first-load calls are not automatically started in parallel.

Settlement is accepted only if the entry remains in the node's current thenable map. It marks the computed dirty, increments the global version, sends
`Check` notifications, increments an open owner batch's version, and performs a world poke. `refresh` increments an epoch and records the current
deferred write batch as owner. The previous settled value remains available, the next evaluation creates a fresh thenable, and settlement is therefore
attributed to the transition that requested the refresh. Superseded entries are ignored.

The React side keeps `Map<Lane, LaneBatch>`. `startTransitionWrite` enters `React.startTransition`, calls the fork's lane probe, reuses or creates the
batch for that lane, and runs the user scope under `runInWriteBatch`. A zero lane falls back to a normal engine batch. This classification covers only
the synchronous scope of this helper; a plain signal write in `React.startTransition`, or a write after an `await`, is not automatically attached to
the transition.

At `render-start`, `hostEvent` creates the root view if needed, selects every open batch whose lane intersects the render lanes, sorts them by batch
id, pushes the previous ambient world, installs the new world, records the container, and enables the write-during-render guard.  `render-stop`
restores the previous world and clears the guard at depth zero. Because every signal read in the slice sees one ambient array, sibling reads and
Strict Mode replays resolve one world.

At `commit`, the host retires every open batch whose lane intersects the commit lanes and removes it from `laneBatches`. This happens at the beginning
of `commitRoot`, before React mutates the host tree. Canonical state can therefore advance in the same commit that starts showing the draft. Canonical
retirement notifications also schedule an urgent value-equal repair render; that is what eventually updates roots that did not participate in this
particular commit.

Per-root screen state is separate from retirement. `viewFor` stores a `CommittedView` in a `WeakMap` keyed by the root container and registers cleanup
with `FinalizationRegistry`. `useValue` captures the current render container in state and, in a layout effect, calls `recordCommitted(container,
node, value)`.  Only a render that reaches layout effects can record, so suspended and discarded renders do not alter the view. View values use weak
node keys.

All subscribing hooks use a bump counter, not a signal value in React state.  `useValue` reads the engine in the render body and `useSubscription`
subscribes in a passive effect. A canonical delivery clears React's transition slot and bumps urgently; a draft delivery calls `royaleRunWithLane` so
the bump joins the batch's lane. The post-subscribe fixup rereads canonical state and also schedules one pinned bump for every open batch, covering
writes between render and effect and components mounted while a transition is already in flight. React's own update queue decides which bump belongs
in each render pass; the render body then rereads the engine's matching world.

`useIsPending` uses the same subscription with every bump forced urgent, so a pending indicator remains visible while a transition parks.
`useCommitted` subscribes both to the node and to view-record changes, then evaluates through the root's view. `useComputed` keeps the latest closure
in a ref and creates a computed when its dependency list changes. `useSignalEffect` creates one engine effect in a passive effect. `useAtom` creates
one component-owned atom.

The fork's 48 production additions are all in `ReactFiberWorkLoop.js`:

- A module scalar `royaleForcedLane` starts at `NoLane`; `royaleEvent` reads `ReactSharedInternals.royaleHost`, performs one null check,
  and invokes the registered callback with kind, root container, and lanes.
- `royaleProbeLane` asks for the current transition and returns the lane React's
  own `requestTransitionLane` would choose, or `NoLane` outside a transition.
- `royaleRunWithLane` saves the scalar, sets it for one synchronous callback,
  and restores it in `finally`, including nested calls and thrown callbacks.
- Three lines at the top of `requestUpdateLane` return the forced lane before
  React's legacy, render-phase, transition, and priority classification.
- One `render-start` call is placed after dispatchers are pushed in each of
  `renderRootSync` and `renderRootConcurrent`; one `render-stop` call is placed after context dependencies reset and before dispatchers/execution
  context are restored. These four calls bracket normal sync and time-sliced render slices.
- One `commit` call is the first statement in `commitRoot`, supplying the root
  container and the lanes about to commit.
- `mutation-start` and `mutation-stop` directly surround
  `commitMutationEffects`. They exclude layout and passive effects and occur only when React enters its mutation phase.

The remaining fork diff is a 164-line test file, not production machinery. Its setup resets modules and attaches a callback; six tests verify helper
presence, paired normal render slices plus intersecting commit lanes, mutation ordering and full-bailout silence, stable nonzero probing inside a
transition, lane pin and unwind, and inert operation without a host. Those tests cover every added hook point on the normal path, but not exceptional
unwinding.

## Advantages of the approach

Relative to the incumbent 1510-line fork, FM2 removes React-owned signal policy.  The incumbent creates external batch tokens, keeps a live registry,
reports pass start/yield/resume/end and retirement/discard state, tracks per-root commit information, and exposes a broader public unstable API. FM2
asks React only for facts React already has (render lanes, commit lanes, mutation boundaries) and one control (schedule this callback on a specified
lane). The production patch is 48 additive lines in one reconciler file, with no second token namespace or React-side batch registry. That materially
reduces merge and upgrade surface.

Draft invisibility is structural: deferred operations never alter canonical state or the canonical graph. Render consistency is also structural once
the fork brackets a slice: all reads consult the same ambient world. Dispatch-order rebase follows from leaving operations in one atom-local queue and
changing only their visibility tag at retirement. It is not reconstructed from commit order. Canonical reads with no open draft take a direct value
path and allocate no world object, key, or history entry.

The design also avoids storing speculative values in React. Hook state is only a counter, so there is no React snapshot to synchronize with an engine
snapshot and no value equality policy duplicated across layers. React's updater queue already retains lane membership and replays skipped counter
updates. FM2 uses that scheduling mechanism while keeping value arithmetic in the engine.

The layout-effect committed view is a useful separation of concerns. A write does not guess what any root displays, and a render that suspends cannot
publish speculative screen state. Compared with snapshot-world designs, FM2 does not retain old atom versions merely because a root is behind; it
records only values that hooks actually commit. Weak root and node keys make that record reclaimable.

Compared with operation-log-fold designs, FM2 has no global log and does not fold historical operations on ordinary canonical reads. Only atoms
touched by an open batch acquire a queue, and retirement mutates tags in place. This keeps unrelated nodes and the idle path independent of transition
history.

Compared with broader lane-facts listener designs, FM2 does not mirror pass objects, remaining-lane tables, or root pending sets in the binding. Lane
intersection is enough to select a render world, and React's own queue carries the subscriber bump. The cost is that lifecycle facts omitted from the
seam cannot later be recovered, most notably root release and dead-lane pruning.

Several guarantees are enforced rather than structural. Late-mount correctness depends on the passive-effect reread and pinned poke loop.  Pending
visibility depends on clearing React's private transition slot before urgent bumps.  Cross-root convergence depends on the value-equal retirement
repair. Render purity depends on a global guard installed by correctly paired fork callbacks.  These mechanisms are small, but removing any one
changes semantics.

The evidence for the intended surface is unusually broad: 179 conformance tests, 204 engine tests, a 1200-seed oracle sweep with a successful negative
control, five forced-GC checks, 31 package React tests, the independent 25-test battery, six fork protocol tests, and all 76 adjacent react-reconciler
suites. The judge also separately verified contextual `latest`, lifetime-effect union semantics, and the real MutationObserver window.

## Disadvantages

Complexity is concentrated rather than eliminated. `AtomNode` must maintain `base`, `canonical`, a mixed queue, deferred counts, world caches,
equality, versions, subscribers, and lifetime state. `ComputedNode` combines canonical push/pull caching, untracked world caching, stale-while-pending
async state, thenable generations, and committed-view evaluation. The 48-line fork is easy to audit; the 1,587-line core is where most semantic
coupling resides.

World identity and invalidation are string-based. Every relevant world read constructs an id string and a version string, scans queues with
`world.includes`, and uses substring matching when purging. Batch id `2` can therefore cause an unnecessary purge of a key containing `12,`; this is
harmless invalidation but illustrates the fragility of string encoding. Multi-batch folds are linear in queue length times world-membership search.

World computed evaluation does not own dependency edges. This avoids changing the canonical graph for speculative branches, but means the notification
graph does not represent all values that can affect a rendered world. A correct implementation needs either per-world dependency edges, a conservative
broader subscription set, or a revision source that always re-pokes rendered worlds.  Adding that mechanism will increase both state and hot-path
work.

Batch identity is one global map keyed only by a lane bit. Two transition-write calls assigned the same lane share a batch, even if the calls are
conceptually separate. Lanes are scheduling categories, not durable globally unique episode ids. A commit on any root retires the matching batch
globally. This is compact and works for the tested shared-signal, multi-root schedules, but it cannot express independent same-lane episodes or wait
for an explicit set of owning roots.

The same omission prevents reclamation. The host receives lanes at commit but not remaining lanes, render discard, root release, or a global “no root
can still commit this lane” edge. A transition parked on an unmounted root can leave its batch, atom operations, functional-update closures, and
caches reachable indefinitely. The 16 transition lanes bound the number of map entries, not the size or lifetime of the retained object graphs.

Write classification is an opt-in synchronous API. Application code must use `startTransitionWrite`; React cannot classify arbitrary signal writes for
it.  An async callback loses `currentWriteBatch` after its first `await`, although React may still treat subsequent React updates as transition work.
Plain writes inside `React.startTransition` are urgent to the engine. This is a sharp integration constraint for data libraries and async action code.

The binding relies on undocumented React internals twice: the three fork fields and the pre-existing shared-internals transition slot `T`, which
`runUrgent` temporarily clears. `requestTransitionLane`, `requestUpdateLane`, commit ordering, and the exact render-loop placement are
version-sensitive. The patch is small, but it still requires a custom React build and a re-audit for every reconciler upgrade.

Global mutable context assumes one synchronous JavaScript renderer execution.  `currentWorld`, `currentWriteBatch`, render depth, write guard, current
container, and the forced lane are module scalars. Normal nested scopes restore most state, but the container is not a stack, and the fork's render
callbacks are not in a `finally`. Unexpected throws or unusual nested renderer activity can strand or misattribute ambient state.

Every `useValue` call creates a reducer, passive effect, external subscriber, captured reread closure, container state cell, and layout effect.
Calling it twice for the same node in one component creates two subscriptions. Retirement then deliberately schedules one extra value-equal render per
subscriber. The approach favors semantic transparency over hook and commit economy.

The async model is capable but idiosyncratic. `use` is not React's public `use`; it is valid only during a computed evaluation. The cache is keyed by
arbitrary strong keys, refresh is lazy, first-load direct uses short-circuit evaluation, and committed recomputation may serve the canonical settled
value when pending.  These rules need explicit application-level documentation.

## Room for optimization

The authoritative CI field run took 6,642 ms for FM2 versus 3,604 ms for Alien Signals, a **1.843×** ratio over the 20-suite total. The entry's
isolated run reported roughly 2.0× geometric mean: propagation was usually 1.1–2.3×, while `createSignals` was 4.8×, `createComputations` 5.0×,
`unstable` 4.8×, and `cellx2500` 4.6×. This shape points first to construction and dependency-shape costs, not to the React fork or transition worlds.

The highest-payoff engine change is lazy subscriber storage. Every atom and computed currently creates a `Set`, and every effect creates a child
`Set`, even when it never has multiple subscribers or children. A null/single/intrusive-list representation would remove one allocation from most
nodes and reduce Set iterator overhead. Given the approximately 5× creation gap, this has high expected payoff for creation and moderate payoff for
propagation, at the cost of more careful removal and mutation-during-notify semantics.

The next target is dynamic dependency reconciliation. Divergence creates three prefix arrays, then `reconcileDeps` calls `newDeps.includes` for every
old edge, which is quadratic in dependency count. Reuse growable arrays and mark edges with an evaluation generation, or perform a direct indexed
reconciliation with mutable cursors. Expected payoff is high for `unstable` and large cellx cases, moderate for the overall CI ratio, and negligible
for stable small graphs.

Draft propagation allocates a visited `Set` for every draft and snapshots each subscriber set with `[...node.subs]`. A producer visitation generation
and mutation-safe direct traversal would remove allocations and make cost closer to the number of reached nodes. This has little effect on the
canonical-only CI run but potentially high payoff for large transition fanout.

Replace string world keys/stamps with numeric identities and version tuples.  The common one-batch world can have a dedicated cache slot keyed by
batch object and versions; multi-batch worlds can use a host-created stable world object.  That removes repeated string construction, substring purge
scans, and most `world.includes` calls. Expected payoff is medium for transition-heavy renders and low for the reported canonical benchmark.

Several retirement paths allocate unnecessarily: abort uses `filter`, purge copies map keys, host commit copies `laneBatches`, and `openLaneBatches`
allocates and sorts for every subscribing effect. In-place queue compaction and direct mutable loops are straightforward.  Expected payoff is low in
steady state but meaningful for batch churn and late-mount storms.

Thenable settlement currently creates an array of every map value merely to check whether an entry is current. Store its key on the entry and compare
`map.get(key) === entry`; similarly, track used keys with generations rather than new `Set` objects per world evaluation. This is a small
async-specific win with low overall benchmark impact.

On the React side, the entry measured fanout at 2.04 ms versus 1.92 ms for stock `useSyncExternalStore`, and 5,000-cell-by-five-root mount at 59.5 ms
versus 45.8 ms. Sharing one subscription per component/node pair or providing a selector hook could reduce reducer/effect/subscriber multiplicity. The
expected mount payoff is medium, but deduplication needs component-local bookkeeping and can easily cost more than it saves for the common one-read
case.

Transition p95 was 12.9 ms versus 3.74 ms for the stock baseline, with 1.49 ms versus 0.36 ms spent synchronously starting the rewrite. The stock
baseline is not semantically equivalent because it de-optimizes the store transition into synchronous work; its scheduler is idle during the urgent
probes. Within FM2, the realistic levers are cheaper draft graph walks, stable world identities, and eliminating retirement repair renders. The first
two should have medium payoff. Avoiding repair renders could have high payoff, but requires per-root acknowledgement or remaining-lane lifecycle state
and therefore expands the seam.

Correctness work comes before interpreting optimized numbers. Tracking draft-world dependencies and fixing computed committed views will add state or
work to precisely the paths current benchmarks omit. Performance should be remeasured after those semantics are fixed; optimizing the current
missed-poke behavior would preserve an invalid advantage.

## Bugginess

The independent judge required no fix round: FM2 was clean on its first formal judgement. The judge reproduced every declared gate, verified that no
conformance tests were skipped, negative-controlled the oracle, replayed the fork patches on the pinned base, and confirmed the benchmark direction.
Additional probes found contextual `latest`, mixed-kind lifetime effects, mutation observer suppression, and full-bailout mutation silence working as
intended.

There was nevertheless a real pre-judgement design correction. The original committed view captured each atom's pre-write value into every root and
cleared the view at commit. The shared battery's held-one-root/two-root scenario showed that a global write-time capture cannot identify which root
actually shipped.  The author moved recording to `useValue` layout effects. That fix is conceptually sound for commit-surviving renders and removes
write-path work. A subsequent commit changed both root and node maps to weak keys, which is also the right reclamation fix.

That correction is incomplete for computed nodes. `useValue(computed)` records the computed object and rendered value in the view, but
`ComputedNode.read` under a committed view ignores a direct recorded value and calls `committedEvaluate`.  Only atom reads inside that evaluation
consult the view. If no hook separately recorded those atoms, the computation uses current canonical atoms rather than what the root displayed. A
direct probe recorded computed value 10, changed its source from 1 to 2, and `committed(computed, view)` returned 20. This is a confirmed defect in a
normal `useValue(c)` plus `useCommitted(c)` shape.

There is also a confirmed missed-delivery defect for dynamic world dependencies.  In a canonical branch `gate ? x : y`, the canonical computed
subscribes to `gate` and `x`. A batch changing `gate` to false can render the world value from `y`, but `worldEntry` evaluates untracked and creates
no edge to `y`. In a direct probe, an urgent `y = 2` afterward produced no `ExternalSub` delivery (`seen=[]`), while an explicit reread returned world
value 2 and canonical value 0. A React component can therefore retain a stale completed transition subtree until some unrelated poke or the
post-retirement repair. The report's claim of “per-world dependency sets” is stronger than the implementation and test.

The documented abandoned-transition issue is also production-significant. A root unmounted while its transition is parked supplies neither commit nor
abort, so `laneBatches`, `openBatches`, touched atoms, queued operations, closures, and caches remain live. Later reuse of the same lane can merge new
work into the stale batch. Calling the leak “bounded by 16 lanes” understates retained payload and semantic contamination. This needs a
root-release/dead-lane protocol, not only a periodic cache cleanup.

Lane collisions are adjacent risk: independent calls on the same lane share operations and one commit retires all of them. Writes after `await`
classify urgent. Both behaviors are disclosed, but neither has a named test defining acceptable semantics across independent roots and async actions.

Fork cleanup is happy-path only. `mutation-stop` is after `commitMutationEffects`, not in a `finally`; a thrown mutation path leaves a
MutationObserver client disconnected. `render-stop` is likewise an epilogue, not guaranteed cleanup around the render call. Host callbacks and
mutation subscribers are not contained, despite the exposed `HostHandle.errors` array, which is never populated. The protocol tests verify ordinary
pairing and lane pin unwind, but do not inject throws into render, commit, mutation, or user callbacks.

The test suite's strongest parts are canonical graph conformance, updater-order fuzzing, ordinary Suspense retry identity, and the calibrated React
schedules.  Its soft spots align with the residual defects: the oracle explicitly rereads every world rather than checking whether the right
subscriber was notified; committed-computed tests pre-record source atoms; async tests use one direct thenable; and there are no parked-root unmount,
same-lane independent episode, post-`await` write, world-only dependency, or exceptional fork-unwind cases.

I would not ship this implementation unchanged. Confidence is high in the small probe/pin/render/commit seam as an architectural direction, and
reasonably high in the canonical graph and atom queue's tested dispatch-order arithmetic.  Confidence is low for production concurrent correctness
until world dependency delivery, computed committed reads, and abandoned batch lifecycle are fixed and covered at the React level. The ideas are
suitable for selective adoption; the current engine is not yet a safe replacement for the incumbent.
