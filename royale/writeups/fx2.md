## How it works

FX2 keeps concurrency out of the canonical reactive graph. The graph in `packages/signals-royale-fx2/src/graph.ts` has three node kinds: `CellNode`,
`DerivedNode`, and `WatcherNode`. Every node carries a value generation `version`, `Clean | Check | Dirty` state, intrusive dependency and subscriber
lists of `Link` objects, an observer count, and React-facing epochs. A link stores the dependency version observed by its consumer. Canonical writes
push `Check` marks only through watched subscriber edges; reads pull dirty derived nodes and compare link versions before recomputing. Equality
therefore stops a canonical change at the derived node's version, although, as discussed below, the current React notification path does not preserve
that cutoff perfectly.

`trackRead` reuses a link when the dependency remains at the current tail or at the next position in the prior dependency list. `trimDeps` removes the
unrevisited suffix. Watched derived nodes install their links in each dependency's subscriber list; unwatched derived nodes point only toward their
dependencies and validate lazily against the global `writeEpoch`. Effects are watchers rooted in those lists. Leaf watchers created by `observeNode`
are the React subscription channel and receive callbacks after canonical effects have settled.

Canonical cell state is just `CellNode.value`. `writeCell` materializes a lazy initializer, applies the cell equality function, advances the cell
version, `writeEpoch`, `reactEpoch`, and `canonicalEpoch`, then propagates. A graph batch records each written cell's pre-batch value and version in
`batchBase`; if the cell returns to an equal value before `endBatch`, its version is restored, so downstream version checks treat the batch as a net
no-op.

Concurrency begins in `worlds.ts`. A `Draft` has an integer ID, an `open | sealed | retired | discarded` state, and a `Set` of cells it touched.
`liveDrafts` retains open and sealed drafts in creation order. The first draft write to a cell creates a `RebaseLog` containing the canonical base
value and an array of `Intent` records. An intent is either `set(payload)` or `update(function)`, has a global dispatch sequence, and points to its
draft; urgent intents use `draft: null`. The sequence number is diagnostic in the current implementation: per-cell array insertion order is what
replay uses.

Draft writes do not mutate `CellNode.value`. `appendDraftIntent` appends the intent, adds the cell to `draft.cells`, advances `worldEpoch`, pokes
speculative leaf subscribers, and tells the host that the draft changed. An urgent write to a cell with a rebase log first appends an urgent intent,
then updates the canonical cell normally. Thus the log preserves the interleaving. For base 1, draft `+2`, then urgent `*2`, canonical state is 2
while the draft world folds the same array as `(1 + 2) * 2 = 6`.

`replayLog(cell, world)` starts at the captured base and scans the log in dispatch order. It applies every urgent intent, every retired draft intent,
and only those live draft intents included by the requested world. Update functions are executed during each replay, not reduced to values at
dispatch.  They therefore need reducer-style purity and may run more than once.

A `World` is `{ drafts, sig }`: an ordered list of live `Draft` objects and a comma-joined ID signature. `SignalScope` supplies an ID array; `worldOf`
normalizes it against `liveDrafts` and caches the result by ID-array identity and `worldEpoch`. Canonical world resolution goes through the ordinary
graph.  For a draft world, a cell replays its log and a derived node calls its function again under `withWorld`, so nested reads resolve the same
world. This evaluation is untracked: there is no separate dependency graph per world. Instead, each node has a `Map` from world signature to
`{writeEpoch, worldEpoch, envelope}`.  Any canonical write or draft-state change invalidates these coarse memos; `reconcileEnvelopes` preserves
envelope identity when the result is equal.

Write classification has two paths. `startTransitionWrite` and `useSignalTransition` explicitly call `openDraft`, broadcast its ID, run the callback
under `runInDraft`, and seal it. Plain `React.startTransition` is recognized by `host.ts` reading React's private shared-internals field `T`.
`draftsByTransition`, a `WeakMap` keyed by that transition object, creates and broadcasts one draft on its first signal write. With neither an
explicit draft nor a live `T`, the write is urgent.

Each root is expected to contain one `SignalScope`. Its `useReducer` state is `{ids, rev}`. Broadcasting calls every registered scope's reducer
dispatch from inside the owning transition. React therefore assigns that update its own lane: an urgent render skips the pending reducer update, a
transition render includes it, and React's normal queue rebase reconstructs it after an interruption. `WorldContext` gives every descendant in one
render pass the same ID array. FX2 does not inspect a lane or maintain a parallel lane table.

The revision exists for writes appended after a pass already rendered a draft, as can happen across an async action. `SignalScope` marks every ID it
renders. A later append makes `handleDraftAppend` dispatch that ID again to uncommitted recipients; `worldsReducer` returns a new state with the same
IDs and an incremented `rev`, forcing the transition pass to restart rather than committing a partial logical batch.

`useValue` combines this context with `useSyncExternalStore`. Its store snapshot is not the resolved value and is not world-specific. Scoped hooks
snapshot `node.reactEpoch`; hooks outside a scope snapshot `node.canonicalEpoch`. The render then separately calls `resolveEnvelope` for the context's
IDs. A draft append can notify the subscription, but the epoch is unchanged, so `useSyncExternalStore` does not reinterpret the draft as a concurrent
external-store mutation and force React into a synchronous retry.  Urgent writes, settlement, rollback, and loud folds advance the relevant epoch.
Silent folds advance only `canonicalEpoch`, repairing unscoped readers without rerendering scoped readers that already received the value in their
transition pass.

Plain `latest()` is context-sensitive. Inside a draft evaluation it uses that world; inside a canonical computed or effect it makes a tracked
canonical read; outside evaluation it uses the current render world if the host can identify one, otherwise all live drafts. The render lookup is
indirect: `SignalScope` and every FX2 hook save the latest context IDs, while private shared-internals field `H` says whether a known hook dispatcher
is currently rendering. This is why a plain `latest()` before any FX2 hook in a subtree has the residual hole described under Bugginess.

On each `SignalScope` layout-effect commit, `confirmCommit` records that root's ID array in `committedWorlds`, pokes draft cells so `useCommitted`
subscribers can compare their per-container snapshots, and removes the root from each draft's recipient set. The last recipient retires the draft.
Retirement first marks it retired, then batches over its cells and writes the full canonical replay through `writeCell`. Passes still carrying the ID
now normalize to the canonical world, which has the same result. The fold is silent only if every currently mounted scope was in the original
broadcast audience; a scope that mounted later requires a loud fold. Discard instead removes the draft without changing canonical values, bumps
epochs, and pokes readers to resolve without it. When no live draft remains, rebase logs and all world memos are cleared.

Async state lives beside canonical derived state in `asyncs.ts`. A global `WeakMap` gives each thenable a `ThenableBox` containing status, result or
reason, parked canonical nodes, and parked `Episode` objects. An episode owns one stable promise for one pending span. Canonical `use(thenable)`
returns a settled value, throws a stable rejection reason, or records the derived node and throws the internal `PARKED` sentinel. `finishCompute`
converts that into pending graph state while retaining the last settled value as stale data.

Settlement is treated as a write. `settle` advances the world epoch, batches `invalidateDerived` over parked canonical nodes, eagerly reevaluates them
so a multi-stage computation can park on its next thenable, flushes graph effects, and only then resolves the episode promises that wake Suspense.
Draft-world evaluation has the analogous `WORLD_PARKED` path and memoizes its envelope per world. At the React boundary, a pending transition world
throws its episode promise so the old UI remains; an urgent render serves stale data when one exists; a never-settled value suspends in either case.
`refresh` creates an always-tracked hidden nonce cell and routes its increment through normal write classification, so a transition-owned refetch
stays in that draft.

The React fork diff contains 186 added lines: 11 product lines in `ReactFiberWorkLoop.js` and a new 175-line protocol test. The product lines are
fully accounted for as follows.

- At `flushMutationEffects` entry, three comment lines state the contract, one
  line reads `globalThis.__FX2_MUTATION_WINDOW__` into a local, and one line null-checks it and calls `(root.containerInfo, true)`. This is the exact
  pre-host-mutation edge and identifies the committing root. It fires even if the commit has no mutation effects.
- After `commitMutationEffects`, active-instance blur handling, and
  `resetAfterCommit`, one call line plus its separating blank line invokes the same callback with `false`. It is before `root.current = finishedWork`
  and before layout effects, so the window contains host mutation work but not layout or passive effects. `flushMutationEffects` is also the choke
  point used by the staged view-transition path.
- At module end, a blank line, two comments, and one assignment set
  `globalThis.__FX2_REACT_PROTOCOL__ = 1`. `registerReactSignals` checks this marker before installing the callback, making stock React fail at
  registration rather than silently omitting mutation events.

The 175 test lines add setup and cleanup for the global callback, a small event recorder, and six cases: marker presence; paired, non-reentrant
start/stop for every commit; DOM records confined to the window with layout and passive effects after stop; correct container identity across two
roots; an empty window for a mutation-free commit; and unchanged rendering when no hook is installed. In the bindings, the installed global callback
traces the edge and fans it out to `onDomMutation` subscribers while catching subscriber errors.

The remaining hooks are thin compositions over these mechanisms.  `useComputed` creates one engine computed with `useMemo` and reads it through
`useValue`; `useSignalEffect` creates a canonical engine effect from a passive effect; `useIsPending` subscribes to the node but snapshots ambient
pendingness; `useCommitted` snapshots the container's recorded world; and `useAtom` creates one signal with `useState`. `wrapCreateRoot` is the
supported way to ensure the root has both `SignalScope` and its container identity.

## Advantages of the approach

Relative to the incumbent architecture, the main gain is removal of duplicated scheduler state. The incumbents use a 1,510-product-line fork with a
React-side batch registry, batch-ID allocation, current-write-batch queries, render-pass start/yield/resume/end events, root-commit reports,
retirement events, and a `runInBatch` lane pin for corrective renders. FX2's fork is 11 product lines, and its two libraries total 2,239 normalized
lines versus roughly 4,700-4,900 for the incumbents. The complexity did not disappear, but React's reducer queue now owns pass membership, retry, and
lane rebase instead of a second registry attempting to mirror them.

Several properties follow structurally from that choice. One pass gets one `WorldContext` state object, so subscribed siblings cannot choose different
draft sets. An urgent render cannot accidentally include a transition reducer update because React itself skips that lane. A retried transition
receives the same logical update through React's queue rebase. Draft writes cannot trigger canonical effects because they never enter the canonical
graph. No corrective component update needs to be scheduled into the owning lane after commit: the transition render already carried the speculative
value, and the later canonical fold can remain silent.

Other properties are enforced by FX2 code rather than supplied by React.  Per-cell intent replay enforces urgent/draft arithmetic. Recipient and
audience sets decide retirement and silent-fold eligibility. The revision dispatch prevents late appends from committing half a batch. Dual epochs
repair readers that no render-pass world reached. Those are state-machine obligations and should not be credited as automatic consequences of the
reducer carrier.

A lane-facts design is a smaller-fork alternative in which React reports facts such as the current write lane, render-pass boundaries, included lane
sets, and root commits to userland listeners. It gives an exact render context and host cancellation edges, but it still requires a cross-boundary
event protocol, lane-to-batch mapping, lifecycle ordering, and usually a pin operation. FX2 avoids those listener-ordering states entirely for world
membership. Its cost is reliance on a provider, layout effects, and private `H`/`T` reads where the lane-facts seam would give exact supported
answers.

An operation-log-fold design represents most or all state as a global journal and obtains canonical, latest, render, and committed views by folding
different predicates over it. FX2 uses the same useful idea only where a live draft touches a cell. Quiescent and canonical reads stay on a
conventional versioned graph; unrelated cells do not scan a global log; derived world results are memoized. That localization is a plausible reason it
remained much closer to Alien Signals than the pure operation-log entries.

A snapshot-world design pins a render epoch and retains old cell values or a copied snapshot until every pass releases it. That makes a world a total
historical view but requires pass-start/pass-end hooks, history retention, and careful reclamation. FX2's world is only a set of draft IDs. Later
urgent intents participate in the same per-cell replay, so rebase is represented directly rather than by copying or patching a snapshot. At quiescence
the engine can drop all overlay state.

The `useSyncExternalStore` epoch is independently valuable. Separating the world-independent mutation snapshot from the world-dependent render value
avoids both documented external-store failure modes: detecting a different snapshot during a transition and forcing synchronous fallback, or detecting
the canonical fold after commit and scheduling a repair render for every subscriber. The React benchmark demonstrates the behavioral consequence:
FX2's worst urgent delay stayed near one 10 ms slice while the plain external store had a 329.05 ms blocking outlier.

The canonical graph also has sound production-oriented details that are not specific to concurrency: version validation gives exact effect
recomputation, net-revert batching restores versions, unwatched derived ownership points toward dependencies, ownerless effects use finalizer
reclamation, and the hidden refresh nonce makes refetch classification use the same write path as ordinary state.

## Disadvantages

The small fork moves difficult coordination into ordinary library code.  `providers`, `draftRecipients`, `draftAudience`, `renderedDrafts`,
`draftsByTransition`, `committedWorlds`, live drafts, per-cell logs, world memos, two node epochs, and a global last-render-world value must agree.
The incumbent's fork is large, but its render-pass and retirement facts are exact; FX2 reconstructs part of that truth from reducer commits and
layout-effect bookkeeping.

The integration is not based only on public React API. Plain transition write classification depends on private field `T`, and render detection
depends on private field `H` plus a `WeakSet` of dispatchers previously observed by an FX2 hook. Those names and meanings can change between React
revisions. The fork marker says the mutation protocol exists; it does not version or validate the private-internals assumptions.

`SignalScope` is mandatory for full behavior. A bare root sees only canonical state and needs the fold to repair it. More subtly, the context carrier
cannot answer a plain function called before any FX2 hook in a selectively rendered subtree, because React may render that subtree without rerendering
the scope.  The process-global `lastRenderWorldIds` may then describe an earlier pass or a different root.

World resolution is coarse. Every canonical write invalidates every draft-world memo through global `writeEpoch`; every append, settlement,
retirement, or discard invalidates them through global `worldEpoch`. A derived world run is untracked and reevaluates its whole function rather than
validating a world-specific dependency list. This is simple and correct for covered cases, but unrelated activity can repeatedly recompute expensive
speculative graphs.

Replay cost grows with the number of intents retained for a cell. Membership testing uses `world.drafts.includes(draft)` inside the intent loop, so it
is `O(intents * drafts)` in the worst case. Update functions execute on each resolution and again at fold. Side-effecting or nondeterministic updaters
are not representable safely, and expensive updaters amplify read cost.

The host is process-global and single-instance. `__FX2_MUTATION_WINDOW__` is a last-writer-wins global slot; duplicate library copies silently
disconnect the first copy's subscribers. The active tracer, classifier hooks, provider registry, and render-world note are also module singletons.
Multiple roots are handled, but multiple independently bundled runtimes are not.

The async machinery retains parked canonical nodes in a thenable box until the thenable settles. If application code retains a never-settling promise,
that box strongly retains dropped computed nodes and their graph. The leak suite does not exercise this shape. Draft-world episodes can likewise
remain in a box until settlement after their world memo is otherwise obsolete.

Finally, the fork's stop edge is not protected by a `finally`. React normally captures commit-phase errors, and FX2's installed callback catches its
own subscribers, but an escaping host error or an overwritten global callback can leave a client believing the mutation window is still open. The
global hook can also throw at the start edge and abort the commit. The 11-line minimum is therefore less defensive than a slightly larger protocol.

## Room for optimization

The authoritative CI core result is 4,784 ms for FX2 versus 3,604 ms for Alien Signals, a **1.327x** total-time ratio. The entry's local three-round
medians show where that aggregate comes from: writes were 1.19x, broad/deep/diamond propagation 1.27-1.43x, avoidable propagation 1.55x, and the
dynamic `unstable` case 2.96x. Creation was already faster than Alien, so constructor work is not the priority.

The first high-confidence lever is a true quiescent fast path. Every ordinary `set` currently checks render policy, classifies the write, and calls
`appendUrgentIntent`, which performs a `rebaseLogs.get`, even when no draft exists anywhere. After classification says urgent, a `rebaseLogs.size ===
0` branch can skip intent logging entirely; a React-free installation can also skip ambient classification. Expected payoff: medium across
update-heavy cases, with low implementation risk; it will not by itself erase the propagation gap.

The largest canonical-graph opportunity is to validate external leaf watchers before changing their snapshot. `mark` advances a derived node's React
epochs as soon as any upstream dependency is possibly stale. A React subscriber then rerenders even if `ensureFresh` recomputes the derived value and
its equality function cuts the change off. Effects already compare dependency versions before running. Giving canonical leaf delivery the same
validation step should pay highly in `avoidablePropagation` and computed-heavy React fanout while preserving the world-independent snapshot rule.

Dynamic dependency tracking deserves a targeted rewrite. `trackRead` reuses the previous link only when order remains at the tail or next position;
branch reordering creates links and later unlinks the stale suffix. Reusing displaced links through a generation-stamped intrusive index, without
allocating a new `Map` per evaluation, should materially reduce the 2.96x `unstable` result.  Expected payoff: high for branch churn, medium for the
total CI ratio.

Node layout is broad: even a plain cell carries subscriber tails, dependency fields, two epochs, tracing, labels, and a world-memo slot. Moving rare
async, world, lifetime, and tracing state to side records, or using narrower shapes per node kind, would improve cache density. Expected payoff:
medium but invasive; profile it after the preceding algorithmic changes.

The React benchmark reports fanout at 3.12 ms versus 2.64 ms and mount at 57.04 ms versus 48.77 ms, about 18% overhead. Every React subscription
creates a watcher, closures, and a `FinalizationRegistry` registration even though React deterministically unsubscribes it. A non-finalized
subscription path for `useSyncExternalStore`, stable cached subscribe functions per readable, and fewer per-hook closures should have high payoff for
mount and modest payoff for updates, without affecting core CI.

Draft activity currently walks watched derived edges and notifies all leaf watchers per appended intent. `useValue` then compares an unchanged epoch
and bails; only pending/committed probes need some of those wakes. Separate leaf channels, plus one generation-stamped traversal per synchronous draft
scope and at most one reducer redispatch per async turn, would remove repeated graph walks for a 2,000-cell transition. Expected payoff: high for
transition construction and completion, low for the 1.327x canonical benchmark.

The React transition benchmark shows the trade: p95 urgent latency is 10.11 ms versus the bare store's 2.72 ms, but max latency is 10.28 ms versus
329.05 ms; the transition finishes in 1,781 ms versus 1,427 ms. FX2 is paying scheduler, context, world-resolution, and notification overhead to
preserve time slicing.  Batching draft notifications and removing redundant world evaluation should target the 25% completion penalty without
compromising the 10 ms bound.

World representation needs both a correctness and performance cleanup.  Reducer state should remove globally retired IDs; otherwise every future
dispatch copies and searches the entire transition history. After that, replace comma-joined signatures and `Map<string, ...>` lookups with an
interned world identity, cache the ambient all-drafts world per `worldEpoch`, and use a small-set/large-set membership strategy during replay. Pruning
has very high long-running payoff; the signature and membership work is medium only when several drafts overlap.

Finally, world memo invalidation could use the versions of actually read inputs rather than global write epochs. That would turn an unrelated urgent
write from a full speculative-cache flush into a constant-time miss check.  Expected payoff is high for large applications with a long suspended
transition, but this is the most complex lever because FX2 currently avoids maintaining per-world dependency sets by design.

## Bugginess

The independently judged result was clean only after a fix round. Before that round, a transition committed through a scoped root could silently fold
while a subscriber in a bare root remained at the old value forever. The fix added `canonicalEpoch` for unscoped hooks and `draftAudience` so a scope
mounted after broadcast forces a loud fold. This is a focused repair with regression tests for both bare and late-mounted roots and a fuzz canary that
blinds the canonical snapshot. Its quality is good, but the need for two epochs and an audience predicate shows that silent retirement is not
structurally safe for all subscriber shapes.

The judge also found that transition-owned `refresh` performed the correct in-world refetch but `useIsPending` never flipped. The nonce append
notified only direct leaf observers, while the probe subscribed to the computed above the nonce. `pokeLeafObservers` now walks watched derived edges
with a seen set and excludes canonical effects. The fix is semantically appropriate and has engine and React regressions, though it makes each draft
notification a graph traversal.

Round 2 had already fixed three substantial defects. Canonical computeds used to let `latest()` read a draft and failed to track that read, creating
both a tear and permanent staleness after fold. A sticky render-world global made ambient `latest()` inherit the preceding render. Those became a
tracked canonical read and an `H`-gated provider. Separately, finalizer registration on scope-owned effect disposers let GC kill live effects under
heap pressure; the sound ownership fix arms reclamation only for ownerless effects. These were not cosmetic findings: the GC bug produced benchmark
assertion storms.

One documented correctness hole remains and all 11 peer reviewers selected it as their main objection. A plain `latest()` call early in a selectively
rendered subtree, before any FX2 hook notes that pass's context, can resolve the previous pass's world. In a multi-root process that note may also
belong to another root. The README's advice to use `useValue` in render is a usage restriction, not a mechanism-level fix. An exact render-context
seam or a public API that makes such calls impossible is required before claiming full tear freedom.

Current code also has an unreported long-running retention defect.  `worldsReducer` only appends IDs; it never removes retired ones. Every later scope
render loops those historical IDs, `confirmCommit` scans them, and a new dispatch copies the full array. Worse, `markDraftRendered` re-adds old IDs to
the module-level `renderedDrafts` set after their one retirement-time deletion, so that set also grows. Engine logs and memos quiesce, but the React
binding does not. A long-lived root therefore has linear memory and work in the number of transitions. No existing test runs enough sequential
transitions to expose it.

`isPending` is not transitive through derived chains. After establishing `a -> b -> c`, drafting `a` makes `isPending(a)` and `isPending(b)` true but
leaves `isPending(c)` false, because `isPendingPassive` scans only direct cell dependencies. The post-judgement traversal fix wakes the `c`
subscriber, but its snapshot still computes the wrong boolean. This is a present correctness bug, not just a performance concern.

The engine implements `discardDraft`, but the React binding never calls it.  Its only host outcomes are commit-driven retirement, no-recipient
retirement, and retirement when providers unregister. Consequently there is no end-to-end React abandonment or rejected-action path that rolls a draft
back; the tested rollback guarantee exists only at the engine seam. Whether a normal React transition eventually commits or is interrupted does not
supply the missing explicit disposition for error and cancellation cases.

Async reclamation is another soft spot. The six GC tests cover unwatched computed chains, ownerless effects, leaf subscriptions, scopes, and quiescent
draft state, but not a dropped computed parked on a retained never-settling thenable. `ThenableBox.parkedNodes` strongly retains that node until
settlement.  This should be treated as a leak risk until a failing-before/fixed-after GC test demonstrates a cancellation or weak-retention strategy.

The test volume is real: 224 engine cases, 31 real-React cases, 25 shared cross-entry scenarios, 1,200 deep fuzz seeds, six fork protocol tests, and
adjacent upstream React suites all passed in the final judgement. The oracle has genuine sabotage canaries and an independent replay model. Its
boundary is also clear: it models engine replay, not React scheduling, async cancellation, private-internals drift, browser hydration, Offscreen
behavior, rejected async actions, duplicate bundles, or long-lived transition churn. The SSR React test is only engine serialization plus a client
render because the fork build lacks `react-dom/server`.

I would not ship this implementation unchanged. Confidence is high in the canonical graph's covered synchronous semantics and reasonably high in the
happy-path scoped transition/rebase mechanism. Confidence is materially lower for a long-lived production integration because the known `latest()`
tear, unbounded scope history, transitive-pending bug, absent host discard path, private `H`/`T` dependency, async retention risk, and non-finally
mutation bracket cross exactly the boundaries that production concurrency stresses.  The reducer-carried world, epoch snapshot, refresh nonce, and
ownership-gated finalizer are worth adopting as ideas; the current package needs those edges closed and browser-level soak coverage before it is a
shipping candidate.
