## How it works

`fx1` moves batch semantics out of React and into the signal engine. React still decides when work runs, yields, retries, and commits, but the engine creates
the batch identity, owns its value log, claims a React transition lane for it, and decides when its state can retire. The implementation calls one transition
batch an `Episode` and one render-visible state an engine `Frame`.

The canonical graph lives in `packages/signals-royale-fx1/src/engine.ts`. A `Cell<T>` stores its materialized canonical `value`, an equality function, a
`version`, and `baseSeq`, the global canonical-write sequence at which the value last changed. `Derived<T>` stores one canonical raw `slot`—a value, `Pending`,
or `Failure`—plus its version, dirty state, dependency arrays, observer arrays, and canonical or per-world async contexts.

Canonical dependency tracking is a lazy push/pull graph. `linkSource` records parallel source, backlink-slot, and source-stamp arrays. A cold derived has only
forward edges marked `COLD_EDGE`, so its sources do not retain it; it polls source stamps when read. `bumpLive` installs reverse edges when a subscriber or
effect makes the node hot, and `dropLive` removes them at the last watcher.  Cells are stamped by value rather than version, so a write and revert can be
rejected at poll time.  Deriveds are stamped by version because `commitSlot` already applies their equality cutoff.

A cell acquires a `pend` queue only while an open episode refers to it. The queue contains the canonical base captured when the queue formed and an array of
`PendingOp`s. Each operation records either a replacement or reducer function, its issuing episode or `null` for urgent work, and a write sequence. The
operation array remains in original dispatch order. There is no separate materialized draft object per transition.

An `Episode` is keyed by an arbitrary token object in `episodesByToken`. It has a creation sequence, state, touched-cell set, version, optional derived refresh
marks, and a map from roots to subscribers whose episode delivery has not committed. `openEpisodes` preserves creation order. A world is the live canonical base
plus the operations belonging to a selected ordered set of episodes; `Frame` represents that world together with a pinned canonical write sequence.

Write classification begins in `writeCell`. The React `EngineHost.currentBatchToken()` reads `ReactSharedInternals.T`. `null` means urgent. A transition object
means deferred: `runtime.ts` first asks the fork for a lane, stores it once as `transition._signalLane`, and `episodeFor` maps the object identity to an
`Episode`. Thus React's ambient transition identity and engine batch identity are the same object; there is no React-to-engine batch-id translation table.

An urgent write with no `pend` queue computes the new value and calls `setCanonical` directly.  `setCanonical` optionally records MVCC history for live passes,
advances `writeSeq`, updates the cell and version, marks the canonical graph, and collects subscriber deliveries. If a queue exists, the urgent operation is
appended with `ep: null`; `foldQueue` recomputes the visible canonical fold while excluding open-episode operations.

A transition write goes through `recordEpisodeOp`. It computes the value currently shown by that episode's world, drops an equal plain `set`, appends the tagged
operation, records the cell on the episode, increments the episode version, and notifies subscribers under that episode. It never changes `Cell.value`, so
canonical reads, effects, and an urgent render cannot observe the draft.

Canonical notifications and draft notifications deliberately differ. `notifyDownstream` calls `markObservers` only for canonical changes; effects therefore
never run over speculative state.  Both kinds call `collectSubDeliveries`. That function walks live derived edges to subscribers.  Because a draft evaluation
may take dependencies absent from the canonical graph, `renderRead` also captures its touched cells and `speculativeSubs` is scanned for those shadow
dependencies.

`pendingDeliveries` deduplicates by subscriber and episode until `flushDeliveries`. Canonical deliveries may be skipped when the raw slot is reference-identical
to the last committed snapshot; draft deliveries are always sent. Before a rooted draft delivery, `Episode.noteDelivery` records that root and subscriber. The
host's `deliver` method temporarily restores the episode token to `ReactSharedInternals.T` around the hook's reducer bump, so React assigns every original
delivery, late corrective join, and owned async settlement to the episode's pinned lane.

React reports the lane mask when a pass starts. `runtime.ts:episodesInLanes` scans open episodes and selects those whose pinned lane intersects the mask, then
`beginPass` creates the root's `Frame`.  It includes episodes already committed on this root but still waiting for another root, sorts them by creation
sequence, and pins the current `writeSeq`. Starting a new pass on the same root discards the prior frame as interrupted work.

Tear prevention comes from that pin, not from hoping React restarts every stale render. While any frame is live, `setCanonical` appends `[replacedAtSeq,
priorValue]` to a cell's `hist`. `baseValueAt` returns the value visible at the frame's pin. `frameCellRead` starts there and uses `foldQueue` to apply only
urgent or retired operations visible by the pin plus the frame's explicit episodes.  Every component in a time-sliced pass therefore reads the same base even if
urgent writes race it.

`frameDerivedRead` caches derived slots per frame. Its canonical-share fast path is allowed only when `Frame.touches` says none of the world's cell operations
or refresh marks affect the derived and `newestSourceSeq` says no transitive input postdates the pin. Otherwise `evaluateInFrame` runs the function with
`activeFrame` set, without editing canonical graph edges, and records direct world dependencies and touched cells for later validation and notification.

Rebase is a consequence of queue order. For base `1`, episode `x => x + 2`, then urgent `x => x * 2`, canonical excludes the episode and shows `2`; retirement
makes the earlier episode operation visible without moving it, so the full fold is `(1 + 2) * 2 = 6`. `retireEpisode` restamps the episode operations at the
retirement write sequence, folds each affected cell into canonical state, and only collapses the queue when no open episode or live frame still needs it.

Retirement is engine-owned. `commitPass` removes the committed root from every named episode and retires one when its outstanding-root map is empty. An episode
delivered to two roots can therefore be visible on one screen while remaining open for the other; `committedByRoot` keeps it in the first root's later frames.
`Episode.subGone` removes unmounted subscribers, and `armAutoRetire` retires an episode one microtask later if no rooted subscriber ever received it.
`abortEpisode` instead drops its operations, removes world async contexts, and re-notifies canonical readers.

Per-root screen truth is captured in `commitPass`, after mutation and before layout effects. When worlds are in play, it reads each registered root subscriber
through the committing frame into `rootViews`; `committed(node, root)` reads that map. The unqualified form uses the most recent commit involving the node. At
quiescence `pruneRootViews` removes snapshots equal to canonical state, `pruneHistory` drops MVCC histories, and `sweepQueues` removes obsolete operation
queues.

Async evaluation uses `EvalCtx`. `use(thenable)` indexes slots by call order, attaches settlement handlers once, and returns an inert placeholder so later async
reads in the same function can also register. A parked run returns one stable `Pending` box and representative promise. Settlement queues `repull`; a completed
canonical repull or world repull calls `announceSettlement`, which acts like a write and dispatches under the context's owning episode.

`Pending` also retains the last settled value. `hooks.ts:surface` throws its stable promise during a transition render so React holds the old screen, serves
stale data during an urgent render when a settled value exists, and suspends everywhere on first load. `Failure` preserves error identity.  Input changes clear
thenable slots; settlement reruns keep them. `refresh` clears the fetch generation eagerly, and transition refresh marks force evaluation in that episode's
world.

At retirement, `adoptWorldContexts` removes the retiring episode from each context key. If none remain, it installs that context as the canonical one and sets
`settleRerun`, preserving slots so commit does not refetch. A refresh mark that no world evaluated is carried to `canonicalRefresh`.  On abort,
`dropWorldContexts` makes later settlements zombies; it does not cancel the underlying request.

The read API exposes the model directly. `read` is canonical. `latest` folds all open episodes over the live base, except inside a computed, frame evaluation,
or executing React render, where it must use that context's frame to avoid read-ahead tearing. `isPending` compares exact cell values but is topology-based for
deriveds so it never evaluates or starts a fetch. `refresh` is a no-op on cells.

The production React diff is exactly 80 inserted lines and every group has a specific role:

- `ReactFiberSignalScheduler.js` is a new 44-line module. Its header and comments define the
  contract; two type imports support a six-field Flow type. Three React-filled functions claim a lane, expose the current root and render lanes, and report
  whether execution is in render.  Three store-filled callbacks report pass start, commit, and mutation start/stop. The object starts with six `null` fields and
  is published as `globalThis.__SIGNALS_ROYALE_FX1__`.

- `ReactFiberRootScheduler.js` adds the bridge import, then the only scheduling override. At the
  start of `requestTransitionLane`, a non-null transition with `_signalLane` returns that lane; otherwise upstream's per-event lane algorithm is unchanged.
  After the function, one assignment exposes `claimTransitionLane` by calling the upstream allocator with `null`. These additions are 13 lines including
  comments and spacing.

- `ReactFiberWorkLoop.js` adds the bridge import and 22 other lines. Two assignments expose
  `workInProgressRoot` with `workInProgressRootRenderLanes` and derive `isRendering` from `executionContext & RenderContext`. `prepareFreshStack`, after queued
  concurrent updates are finished, calls `onPassStart(root, lanes)`. `flushMutationEffects` calls `onMutation(root, true)` immediately before React's mutation
  branch and `false` immediately after it, including commits with no host mutations. After `root.current = finishedWork` and before layout effects, it calls
  `onCommit(root, lanes)`. No upstream scheduling or commit data structure is replaced.

The same fork diff adds a 238-line test file, excluded from the 80-line production metric. Its setup and eight tests verify bridge publication; one pinned lane
across events; ordinary per-event lane allocation without a pin; root-and-lane pass/commit reports; a MutationObserver-proven mutation window with layout
effects outside it; `isRendering`; work-in-progress introspection; and `flushSync` excluding pinned transition work.

`runtime.ts:register` feature-detects the global, installs the three callbacks, and installs the engine host. `onPassStart` and `onCommit` translate lane masks
back to episodes. `currentPassFrame` first checks `isRendering`, so an event between yielded slices sees newest intent rather than the suspended pass.
Registration is process-global and fails loudly on an unpatched React build.

`hooks.ts:useValue` holds only a reducer bump plus `HookSubState`; values are never copied into React state. During render it asks `currentRenderFrame` for the
root and frame, calls `renderRead`, and surfaces the slot. A passive effect subscribes after commit. Its two repairs compare canonical state against the
rendered slot and join every already-open episode that affects the node, covering the render-to-subscribe race and a component mounted mid-transition. A second
effect records the slot and shadow-cell set that actually committed.

`useIsPending` installs a probe subscriber driven by `pendingEpoch`. `useCommitted` registers a committed-view watcher for its root. `useComputed`, `useAtom`,
and `useSignalEffect` provide component ownership over the engine primitives. `useTransitionWrite` wraps React's `useTransition`; `startTransitionWrite` reuses
an ambient transition token or temporarily installs a new one for its synchronous scope. `onDomMutation` exposes the fork's exact mutation bracket.

## Advantages of the approach

Relative to the incumbent 1,510-line fork, the main gain is removal of React's external batch registry. The incumbent exposes batch-id allocation, current-write
classification, pass start/yield/resume/end, per-root commit generations, exactly-once batch retirement, `runInBatch`, work-in-progress discard, and test reset.
`fx1` leaves React with one lane override, two render introspection functions, and three fact callbacks. Rebase, root accounting, async ownership, and
retirement become ordinary TypeScript library code.

That is a materially smaller React rebase surface, not just line compression: the fork does not own engine IDs, values, roots, or batch lifecycles. Its 80
production lines touch three reconciler files versus a product-line subsystem. The trade is that the engine grows to 2,343 counted lines, but that code can be
tested without rebuilding React and can evolve independently of Fiber internals.

The lane pin is stronger than a passive lane-facts listener. Many small-fork designs merely observe which lane React assigned and reconstruct a batch afterward.
Here the engine claims the lane when the first transition write is classified and retains it on the transition object. A corrective join or settlement in a
later event therefore has the lane before it schedules React work. Same-commit membership follows from React's lane machinery; it is not repaired after a commit
boundary.

The 11 peer reviews were unusually consistent: every reviewer singled out the pinned episode lane as the main reusable idea. Their recurring objections were
engine size, topology-only pending, construction cost, and the two initially untested defects.

Draft invisibility is structural: transition writes never mutate canonical cells. Urgent isolation and functional-update rebase are also largely structural
because visibility changes without reordering the operation array. Tear freedom is not automatic; it is enforced by the pass-start callback, pinned `writeSeq`,
retained history, and routing every render read through its frame.  Retirement is likewise enforced by the engine's per-root delivery accounting rather than by
lanes alone.

Compared with designs that fold one global operation log or a list of STM transactions on reads, `fx1` localizes replay to affected cells. A canonical cell with
no open episode has no queue, and a derived outside a changed world can share its canonical cache. It avoids making every read scan an application-wide log,
while retaining the useful rule that dispatch position never changes.

Compared with snapshot-world designs, it does not copy the graph or retain a full world store.  Canonical state is one value per cell; temporary MVCC history
exists only while a pass is live; draft state is the per-cell operation queue. Functional updates re-execute during fold, so urgent rebase does not require
rewriting a captured snapshot.

Compared with pure visibility-predicate worlds—such as a cutoff sequence plus a batch set—`Frame` has more state but owns derived and async caches explicitly.
That makes “the fetch started in this world and lands with it” representable without a separate cache protocol, and retirement can adopt the exact settled
context rather than refetching.

The cold/hot graph split is another structural benefit. Cold deriveds cannot leak through reverse edges because those edges do not exist; hot deriveds still get
push invalidation. Episode auto-retirement closes a lifecycle hole that listener-only designs can leave when a transition write reaches no component and React
will never report a relevant commit.

The React seam measurements support the scheduling claim. In the entry's table, fanout is 0.431 ms versus 0.389 ms and mount is 27.9 ms versus 27.4 ms against a
`useSyncExternalStore` baseline, while urgent p95 during a 2,000-cell transition is 5.29 ms versus 77.26 ms. The important result is not general engine speed;
it is that pinned transition work stays preemptible while a stock external-store subscription forces synchronous rendering.

## Disadvantages

Complexity is concentrated rather than eliminated. `engine.ts` combines a reactive graph, MVCC history, per-cell replay queues, render frames, root lifecycle,
speculative dependency repair, Suspense contexts, refresh generations, committed views, effects, and leak reclamation. Bugs at the intersection of those
subsystems are hard to isolate, as the judgement defects demonstrate.

The integration depends on private React details: the client-internals export, its `T` field, mutation of transition objects with `_signalLane`, transition-lane
bit layout, module-global work loop state, and an unversioned global bridge. A React rebase can preserve types while changing a timing invariant. Multiple React
copies or another user of the same global/property have no negotiated ownership protocol.

`startTransitionWrite` is synchronous. It restores `ReactSharedInternals.T` in `finally`, so writes after an `await` do not remain in the episode unless another
integration re-enters the token. This is weaker than a first-class async action/batch context and easy for application code to misuse.

Lane identity is finite. React cycles 15 transition lanes, and `claimTransitionLane` also follows upstream per-event caching. Independent long-lived or
same-event episodes can share a bit; then `episodesInLanes` folds them together and they may commit together. The result remains untorn, but the engine cannot
promise independent reveal timing under lane reuse.

`isPending` is exact for cells and intentionally inexact for deriveds. It asks whether an open episode topologically touches the derived, not whether the folded
derived value differs, so an equal-after-fold transition can briefly report pending. Avoiding evaluation is defensible, but the observable is not a precise “new
value differs” predicate.

World-only dependencies require per-render touched-cell sets and a global `speculativeSubs` scan on cell changes. This is sound but can over-notify, allocates
on speculative renders, and makes cost depend on the number of speculative subscribers rather than only the changed node's canonical edges.

When any world is in play, `commitPass` can snapshot every subscriber registered to the root, not only nodes changed by that commit. The no-world urgent path
avoids this and fixed a severe fanout regression, but large roots with a held transition still pay an O(root subscribers) commit cost.

The async cache is keyed by comma-joined episode sequences and thenable call order. Retirement splits strings, filters episode arrays, and rekeys contexts;
overlapping worlds can create a large state space. Requests are not cancelled on refresh or abort. Superseded contexts are made inert, but the underlying I/O
and promise callbacks still run.

Error handling at the React callback boundary is quiet. `register` catches pass, commit, and mutation listener failures into `RuntimeHandle.errors`; production
code that never inspects the array can continue after the engine missed a lifecycle fact. That avoids throwing through React's commit, but it needs an explicit
reporting policy before production use.

Unqualified `committed(x)` means the most recent commit anywhere, which is ambiguous for a signal shown differently on multiple roots. Correct multi-root
callers must retain and pass the root container. The hook does this; the free function permits the ambiguous form.

## Room for optimization

The authoritative CI result is 5,141 ms over 20 suites, or **1.426× Alien Signals**. That is better than most entries but outside the incumbent performance
band. The entry's noisier local isolated run reports a 1.58× geometric mean and locates the gap: `createComputations` at 6.97× Alien, Cellx construction at
4.31–6.12×, and propagation suites mostly at 1.3–1.8×. Its React fanout and mount numbers are already near the baseline, so engine construction and graph
traversal deserve priority over more fork work.

The highest-payoff change is reducing per-node construction. Every `Derived` eagerly creates five dependency/observer arrays, and every `Cell` creates two,
before it has an edge. Lazy allocation, inline storage for the first source/observer, or a compact pooled edge arena should directly attack the creation and
Cellx gaps. Expected payoff: high for build-heavy workloads and memory; moderate implementation risk because hot/cold backlink updates are index-sensitive.

The next lever is the poll-then-evaluate double walk already identified by the entry's profile as roughly the next 30%. A practical fast path is to mark
deriveds `DIRTY` on ordinary unbatched source changes, reserving `CHECK` and value-stamp verification for scopes where write-then-revert coalescing is possible.
That lets common propagation evaluate once rather than poll dependencies and then reread them. Expected payoff: medium to high in broad/deep propagation;
correctness risk is high unless batching, custom equality, effects, and re-entrant writes remain on the checked path.

Urgent writes to a cell with a live episode currently append the urgent op and refold the entire queue. Canonical `cell.value` already represents all visible
urgent and retired operations, so the new urgent op can usually be applied directly to it while retaining the op in the queue for future world folds. That
changes repeated urgent traffic beside a long-held episode from quadratic to linear total work. Expected payoff: high for the exact concurrent workload, small
for ordinary benchmarks; the replay-order tests must cover several overlapping retire/abort orders.

`collectSubDeliveries` allocates a visited `Set` and closure for each notification; `pendingDeliveries` adds a `Map<Sub, Set<Episode|null>>` and snapshots it
into arrays. Generation stamps plus reusable intrusive work arrays could preserve deduplication without those allocations.  Expected payoff: medium in
high-fanout React and effect graphs, low in cold scalar use; re-entrant delivery makes this more than a mechanical rewrite.

Frame analysis repeats graph walks. `touches` is memoized, but `newestSourceSeq` is not, and the canonical-share check calls both before and after canonical
evaluation. One frame-local memo that computes `{touches, newestSeq}` together would remove repeated transitive walks and can be allocated lazily only for
episode frames. Expected payoff: medium for deep draft worlds, low for canonical benchmarks, with low semantic risk.

Speculative evaluation allocates `Frame.cache` eagerly, a dependency tuple array, and touched-cell sets that are repeatedly unioned. Lazy frame maps plus
compact cell arrays with frame-generation deduplication would reduce transition render churn. Expected payoff: medium for large concurrent renders, negligible
for the measured canonical creation gap. Shared mutable scratch space must not cross simultaneously live root frames.

The root snapshot walk can be narrowed by recording which subscribed nodes were rendered or delivered in the committing frame and updating only those
`rootViews` entries. Expected payoff: high for large roots while any episode is held—the case where the existing no-world optimization does not help—but
multi-root committed semantics make the bookkeeping nontrivial.

Finally, composite async-context keys should become an interned world identity or ordered numeric key rather than strings repeatedly split and joined during
retirement. Cache `episodeAffects` frames for late joins and avoid spread/filter copies in rare abort/retire paths. Expected payoff: low in current benchmarks,
but worthwhile after profiles show async overlap or many simultaneous episodes; these changes should follow, not precede, node and propagation work.

## Bugginess

The final judged revision is clean against its declared gates, but it did not arrive there clean.  The engine has 198 passing tests, the React package 29, the
shared battery 25, the fork protocol 8, and 121 passing adjacent upstream React tests with one upstream skip. The judge also applied the patches to a pristine
base, rebuilt React, ran a 1,200-seed oracle sweep, and reran leak audits.  That is substantial evidence, not proof that the cross-product of worlds and async
schedules is closed.

The entry's own synchronous oracle found two earlier defects. A pass pinned before a cell first grew an update queue read the queue's newer base; the fix makes
`foldQueue` fall back to `baseValueAt` when `pend.baseSeq` postdates the pin. Retirement also collapsed a queue while another live pass still contained that
episode; `frameHolds` now defers collapse, and an explicit frame continues to include retired operations through its commit. Both fixes target the violated
invariant and have named shrunk regressions.

The independent judge then found two required features reported as complete with no covering test.  First, `latest(a)` in an urgent React render beside a held
transition returned the draft while `useValue(a)` returned canonical state. Engine evaluations set `activeFrame`; a component body did not, so `latest`
incorrectly fell through to the all-open world.

The fix added optional `EngineHost.currentPassFrame` and made `latest` consult it. The runtime gates the answer on the fork's `isRendering`, then reads the
current root frame. This is a good fix: it extends the existing context rule instead of adding a second value model, fails on the pre-fix revision, and is now
exercised by both a named React regression and the sync oracle. The remaining coverage hole is that no test fires an event handler literally between yielded
slices; the judge validated the `executionContext` restoration in React source instead.

Second, `refresh()` inside a transition with unchanged inputs could do nothing forever. The canonical-share fast path saw no changed source and bypassed the
episode's refresh mark, so no world fetch started and retirement had nothing to adopt. The fix made refresh marks participate in `Frame.touches`, forced that
world to evaluate, adopted its context at retirement, and carried a never-evaluated mark through `canonicalRefresh`.

That fix is directionally right and the common React paths have strong regressions: stale serving, new generation creation, settlement in the episode's commit,
no double fetch, unused-mark carry, and zombie settlement. It is not complete for the public engine host API. The judge demonstrated this schedule: evaluate a
world async context, issue another refresh mark in the same episode, then retire without reevaluating. `retireEpisode` treats mere world-context key existence
as consumption, ignoring whether `ctx.refreshSeen` reached the new mark count, and silently loses the refetch.

The judge classified that edge as not reachable through the shipped React surface because `startTransitionWrite` is synchronous and a live refresh subscriber
forces reevaluation before commit. It remains a real engine defect for a custom host. The cheap hardening is to require the matching context's consumed refresh
count to cover the episode mark, not just its key to contain the episode. I would fix and name-test it before treating the engine host protocol as
production-ready.

Other documented residual semantics are not hidden bugs but can surprise callers: derived `isPending` over-reports equal folds; overlapping or lane-reused
episodes can reveal together; equal refreshes still pass through a pending/version change and can refetch downstream async deriveds; speculative dependency
repair may over-notify; and abort stops ownership but not I/O.

The largest test soft spot is async composition. The 488-line randomized oracle models synchronous values, writes, refresh value-neutrality, passes,
retirements, and aborts, but cannot observe fetch generations or arbitrary thenable settlement order. Async behavior is covered by nine focused engine tests and
React scenarios, not property-based schedules. There is also no named abort-plus-refresh async regression, and the Daishi tearing and seam-benchmark adapters
were typechecked but not integrated into their external runners in this checkout.

My shipping confidence is split. The 80-line fork protocol and the transition-object lane-pin idea are small, well tested, and reasonable candidates for
production hardening, provided private-React rebases and callback-error reporting are owned explicitly. I would not ship the 2,343-line engine wholesale yet.
Its normal React path is credible, but one latent refresh defect remains and the highest-risk subsystem—async world adoption across overlapping episodes—does
not have a randomized oracle. Adopt the lane pin, pass-frame pinning, never-observed auto-retirement, and world-context adoption ideas independently; require
the latent fix plus async schedule fuzzing before promoting this implementation itself.
