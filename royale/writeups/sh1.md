## How it works

SH1 is an operation-log software transactional memory layered on a conventional lazy signal graph. “World” means the ordered list of live
transactions whose operations a particular read is allowed to see. React does not own the signal state or understand the operations; it
reports lane, render, commit, and mutation facts, and the binding turns those facts into worlds.

The graph is in `packages/signals-royale-sh1/src/index.ts`. `Node<T>` stores an equality function and a `Set` of either downstream
`Computation` objects or callback subscribers. `Atom<T>` adds one canonical field, `base`; lazy initializers materialize that field on the
first read, write, or subscription. `Computation<T>` stores dependency nodes, the values last read from them, dirty state, and temporary
dependency-collection state. `Computed<T>` adds a cached canonical value and async state. `Effect` is a computation scheduled through
`pendingEffects`; effects always run without a transaction world, so speculative state cannot leak into side effects.

Dependency collection starts as an array. `Computation.track` uses `includes` for the common narrow case and creates a `Set` when the eighth
distinct dependency is collected. `replaceDeps` detaches removed dependencies, attaches the new set when the computation is observed, and
records a second array of dependency values. Invalidation pushes dirty state through computation subscribers; recomputation pulls
dependencies and can stop if their equality functions say the recorded values did not change. Unobserved computeds recheck a global `epoch`
so they do not retain a live graph.

Each `Transaction` contains:

- `writes: Map<Atom, Update[]>`, where an update is either a literal `set` or a functional `update`;
- `bases: Map<Atom, value>`, capturing canonical state at the atom’s first deferred write;
- `rebases: Map<Atom, Update[]>`, recording later urgent operations for root-owned transactions;
- `roots`, the Fiber roots on which React scheduled the transaction;
- `containers`, the host containers whose committed view contains it;
- `landed`, `closed`, `rebaseOnCanonical`, and `revision` lifecycle fields.

The process-wide `transactions` array is chronological newest intent. `currentTransaction` classifies writes; `currentWorld` selects
visibility. `rootWorlds` weakly maps a DOM container to transactions already visible on that root but not yet globally retired. The binding
has parallel tables from batch id to transaction and lane, from root and lane to transaction, and from root to its committed transaction
list.

`startTransitionWrite` is the only automatic React-facing classifier. It calls `openTransaction`, stores the transaction by id, enters
`React.startTransition`, and nests the user scope inside both the fork’s `unstable_Signals.run(id, ...)` and the engine’s
`runInTransaction`. A write is deferred only while that engine dynamic scope is active. Ordinary writes, including writes inside an
unwrapped React transition, are urgent. If the scope schedules no React root, it commits immediately.

On a deferred `write`, the engine folds that transaction over the atom to compute the before-value, drops an equal result, captures
`atom.base` on the first write, appends the operation, increments the transaction revision, and delivers the transaction to React
subscribers. It does not alter `atom.base`, increment the canonical epoch, invalidate canonical computeds, or run effects.

On an urgent `write`, the engine evaluates against `atom.base` and returns on equality. For every live, root-owned transaction that already
wrote the same atom, it appends the urgent operation to that transaction’s `rebases`. It then changes `atom.base`, invalidates the canonical
graph, notifies React, and flushes effects. Thus the canonical graph sees urgent state immediately while each speculative world retains
enough order information to reconstruct its own result.

`fold(atom, world)` starts from the current canonical `atom.base` and visits transactions in world order. Normally it applies each
transaction’s write log. When a root-owned transaction has urgent rebases, it instead resets to that transaction’s captured base, applies
deferred writes, then urgent rebases. For example, deferred `* 3` followed by ordinary urgent `* 2` produces 6 in dispatch order. Inside raw
`flushSync`, the fork calls `runtime.flush(true)`, which raises `urgentRebaseDepth`; an urgent write then sets `rebaseOnCanonical`. Such a
world starts from the already-urgent canonical base and reapplies deferred operations, so deferred `* 2`, then flush-synchronous urgent
`+ 1`, produces 4. Direct engine transactions have no roots and also replay over the current canonical base.

At scheduling, the binding’s `runtime.schedule(root, lane, batchId)` records the first lane for the batch, adds the root to the transaction,
and records the transaction under that root and lane. Subsequent corrective or promise-settlement updates enter `unstable_Signals.run` with
the same batch; the fork asks `runtime.lane` and reuses the recorded lane.

Before each sync or concurrent render call, React calls `runtime.render(root, renderLanes)` once. The binding removes closed entries from
that root’s committed list, copies it, and appends root-lane transactions whose lane intersects `renderLanes`. React stores
`{render, committed}` in shared internals for the whole render call stack. `useValue` reads under `render`; `useCommitted` reads under
`committed`; and the binding’s `latest` also enters `render`, preventing an ambient-newest read from crossing the render boundary. Because
JavaScript cannot run an event in the middle of one call stack and every sibling observes the same transaction array, a pass cannot mix
transaction membership. An interruption starts another call and obtains another world.

`runtime.commit(root, committedLanes, remainingLanes)` runs after React has computed the root’s remaining lanes and before commit side
effects. It ignores transactions still remaining. For each finished lane it records whether the lane actually committed, removes that root’s
ownership, and keeps landed transactions in the root’s committed view while other roots remain. When the final root releases a transaction,
`retireTransaction` commits it if any root landed it and aborts it otherwise. A commit folds the appropriate write/rebase order into
canonical atoms in one engine batch while suppressing duplicate React delivery, then sends one targeted visibility-flip delivery per written
atom. An abort sends a global flip so anything that could have seen the draft returns to canonical. Retirement also removes the transaction
from every container world. Root maps are weak, and the strong batch and lane maps are deleted at quiescence.

React subscription happens in `useSubscription`. Render records a global mutation version; `useLayoutEffect` installs an exact per-cell
callback and an engine subscription, then forces an update if a transaction already contains the atom or the version changed between render
and commit. Deferred delivery schedules the reducer update inside the owning batch. Canonical delivery is driven by the ordinary graph.
Since speculative evaluation does not install world-specific dependencies, every mounted computed callback is conservatively notified when
any draft atom changes. The urgent form used by `useIsPending` calls the fork’s `urgent`, which clears both React’s transition and SH1’s
batch context around the reducer update.

Async state is keyed first by promise identity in the engine-wide `resources` `WeakMap`. During a computed evaluation, `pendingReads`
changes `use(promise)` from immediate control flow into collection: unresolved promises are appended and evaluation continues with
`undefined`; after the function returns, `Computed.join` throws one `Promise.all` thenable. `pendingParts`, `pendingThenable`, and
`pendingWorld` reuse that thenable while the world key—the concatenated transaction ids and revisions—has not changed. Resolution stores a
value or reference-stable error, increments `epoch`, and notifies React in the transaction that owned the first read. `latest` and
`committed` catch a thenable and return the last computed value. At the React boundary, `useValue` suspends on first load or inside a
transaction world; on an urgent canonical refresh it returns the `stale` weak-map value.

The React fork is small but every insertion is semantically loaded:

- `ReactSharedInternalsClient.js` adds `X` for the registered runtime, `B` for the dynamic batch id, and `R` for the current render world,
  initialized to `null`, `0`, and `null`. Its exported `unstable_Signals` object registers exactly one runtime, returns an identity-checked
  disposer, restores nested batch ids with `try/finally`, exposes `world`, provides the transition-and-batch clearing `urgent` scope, and
  resets all three slots for tests.
- `ReactClient.js` imports and re-exports that same object. The seven public React entry files each add the identical `unstable_Signals`
  export, making the protocol available in development, production, stable, experimental, and Facebook entry variants; these lines add no
  behavior.
- `requestUpdateLane` in `ReactFiberWorkLoop.js` asks the runtime for an existing lane when `B` is nonzero, returning it before React
  chooses a new transition lane. `scheduleUpdateOnFiber`, after marking the root updated, reports `(root, lane, B)` so the library can
  create that association.
- `renderRootSync` and `renderRootConcurrent` each call `runtime.render` before work begins, publish its result as `R`, and clear `R` after
  the work loop and dispatcher restoration. This is the render-pass visibility boundary and the signal used to reject writes during render.
- `commitRoot` calls `runtime.commit(root, lanes, remainingLanes)` immediately after `markRootFinished`. This supplies both positive commit
  and prune information before mutation and layout effects.
- `flushMutationEffects` calls `runtime.mutation(root, true)` before `commitMutationEffects` and calls `runtime.mutation(root, false)` in
  `finally` after `resetAfterCommit`. This brackets host mutation, not the before-mutation or layout phases.
- `ReactDOMFlushSync.js` captures `X`, calls `runtime.flush(true)` before clearing React’s transition and raising update priority, and calls
  `flush(false)` in `finally` before restoring them. The captured runtime and the engine’s depth counter make nesting balanced.
- The added 99-line reconciler test file contains setup plus three protocol tests: `R` exists only during render and commit is reported; a
  later update for one batch reuses its original lane; and a competing runtime is rejected while `reset` permits a new registration. It does
  not itself test flush scopes, lane pruning, mutation placement, or multiple batches sharing a lane.

The remaining hooks are thin compositions: `useComputed` memoizes one engine computed and calls `useValue`; `useSignalEffect` creates a
canonical engine effect from `useEffect`; `useAtom` stores an atom in a ref; `useIsPending` uses an urgent subscription; and `register`
reference-counts the one global runtime registration. `setRenderProbe` injects `protocol.world() !== null` into the engine’s direct write
path, so `Atom.set` and `Atom.update` throw during render rather than relying on an adapter.

## Advantages of the approach

Relative to the incumbent 1,510-line React fork, SH1’s 94 non-test fork lines establish a much narrower contract: React reports facts it
already owns, while transaction policy remains in the 1,217-line library. React stores only a runtime pointer, a dynamic integer, and an
opaque world pointer. It has no atom table, write log, batch registry, rebase algorithm, or signal dependency code. This is the main
adoptable result: the reconciler need not be the concurrent-signal runtime.

Several correctness properties follow from representation rather than repair code. Deferred writes cannot affect canonical effects because
they never change `Atom.base` or invalidate the canonical graph. Aborts cannot roll back canonical memory because there is nothing
speculative in it to undo. Functional updates replay without rerunning the event body. A render’s transaction membership cannot tear because
React obtains one array before entering the work loop. Per-root screen state is explicit rather than guessed from the globally newest value.
Sparse transactions copy only operation arrays for touched atoms, not all atoms or all computed values.

The properties that do not follow structurally are visible and localized: post-subscribe repair, late-mount enrollment, targeted retirement
delivery, ordinary-versus-flushSync ordering, and stale Suspense policy each have a named code path. The design does not hide these behind a
general-purpose arena. That makes schedule reasoning easier than in the incumbent architecture even though the engine file itself is dense.

Compared with “lane-facts listener” entries—designs where React publishes lane and commit events to userland—SH1 asks for more than the
minimal 11- or 48-line seam, but gets a direct render-stack world and an explicit prune boundary. It does not infer commit survival from
layout effects or encode world identity in a React updater queue. The cost is stronger dependence on work-loop call sites and a global
protocol object.

Compared with a single global operation log folded four ways, SH1 partitions operations by transaction and atom. Canonical reads stay O(1),
retirement touches only written atoms, and a render fold skips transactions that did not touch the atom. The separate logs also make
multi-root ownership and abort local to one transaction. It gives up the single-log family’s globally obvious dispatch order and therefore
needs `bases`, `rebases`, and `rebaseOnCanonical` to encode two ordering rules.

Compared with snapshot-world designs, SH1 does not create a full value snapshot or retain a version history for every signal. Creating a
transaction is cheap, sparse drafts use memory proportional to writes, and urgent canonical state remains one field per atom. Snapshot
designs make repeated reads cheap and can pin dependency sets to an epoch; SH1 instead pays to refold atoms and re-evaluate computeds
whenever a transaction world is read.

The async join is a compact useful idea in its valid domain: stable external promises plus one active world produce one thrown thenable for
all parallel reads, so Suspense retries do not restart the computed. Likewise, the array-to-`Set` threshold at eight is a reasonable
small-degree graph tactic, and weak per-root maps plus explicit strong-map deletion give a legible quiescence story.

The React seam also exposes two generally useful hooks independent of SH1’s engine: the exact host mutation bracket, and a `flushSync` scope
callback. The former cannot be reconstructed precisely from public effects; the latter lets a runtime apply its own ordering policy without
replacing the public `flushSync` function.

## Disadvantages

The compact source concentrates several models in one 930-line engine file: canonical graph invalidation, transaction folding, two
urgent-order rules, async resources, lifetime ownership, serialization, tracing, and React delivery. The design is small by line count, but
`write`, `fold`, `retireTransaction`, `Computed.get`, and the binding’s `runtime.commit` form one coupled correctness kernel. A change to
operation order can alter screen visibility, effect timing, pending identity, and root retirement at once.

The transaction semantics are not uniform. A direct engine transaction replays its deferred updates over the latest canonical base. A
root-owned transaction with ordinary urgent writes reconstructs captured base → deferred log → urgent rebase log. A root-owned transaction
touched inside `flushSync` reconstructs canonical base → deferred log. These rules satisfy the required examples, but the meaning of the
same operation sequence depends on root ownership and a dynamic flush scope.

World reads are computational, not snapshots. Every atom read scans the selected transaction list and may execute functional update closures
again. Every computed read with `currentWorld` defined runs `evaluateWorld` without canonical caching or world-specific dependency
installation. Repeated reads can rerun user computation, and dynamic world dependencies are handled in React by notifying all mounted
computed readers on every draft-atom change.

The binding is global. One React module can register one runtime; the engine has one mutable `renderProbe`; `currentTransaction`,
`currentWorld`, pending collection, batching, tracing, and effect queues are process-wide. This is compatible with synchronous JavaScript
scopes but constrains multiple runtimes, multiple React copies sharing an engine, and any future async context that crosses the dynamic
scope.

The root bookkeeping assumes one transaction per lane per root: `rootLanes` is `Map<lane, Transaction>`. React’s own `requestTransitionLane`
explicitly assigns all transitions in one event the same lane. Two `startTransitionWrite` calls in one event can therefore overwrite the
first map entry while the first transaction still retains the root in `roots`. The first draft is then absent from the render world and has
no map entry through which commit can release its root. This appears to be an untested correctness and quiescence defect, not merely a
missing edge check; the map must represent multiple transactions per lane or the API must coalesce them.

Async state is less general than the report’s “per world revision” wording. Each `Computed` has only one `pendingParts` array and one
`pendingThenable`, not a table by world. If two roots or transaction worlds interleave with different pending sets, returning to the first
world creates another joined thenable. A resource also records its owner only on the promise’s first use, so a promise first read
canonically and later used by a transaction settles outside that transaction. Both constraints are poor fits for multi-root concurrent data.

Pending collection relies on returning `undefined` from `use(promise)` so evaluation can reach other reads. Arithmetic happens to continue,
but property access, method calls, or a branch on the result can throw or choose a path before the join is formed. A computed that creates a
fresh promise each evaluation can also start one extra request after settlement. Keyed resource slots are therefore a semantic requirement
for general inline fetching, not an optional convenience.

`isPending(computed)` is not the specified cheap flip-only probe. It installs the all-transactions world and calls `node.get()`, which can
execute the computed and create or refetch resources. Three peer reviews independently flagged this. Atoms get a cheap transaction scan, but
computed pending state is discovered by evaluation rather than stored as queryable graph state.

The render world fixes transaction membership, not an immutable copy of canonical atom values. SH1 relies on JavaScript run-to-completion
and React restarting interrupted work after urgent updates. That is a reasonable integration assumption, but it is weaker than a value
snapshot and should not be generalized to workers or an asynchronously resumable evaluator.

User mutation listeners run directly inside React’s commit path. An exception in a listener can interrupt `runtime.mutation` and therefore
React commit processing; there is no error isolation. Similarly, tracing and delivery are global facilities rather than per-root services.

## Room for optimization

The authoritative CI run measured 14,252 ms for SH1 versus 3,604 ms for Alien Signals: **3.954×**. The entry’s isolated local run was
consistent at 7,680.81 versus 1,953.55 ms, or **3.932×**. Its worst local categories expose a graph-core problem, not primarily a React-fork
problem: `updateSignals` was 4.31×, broad propagation 4.75×, `cellx1000` 9.90×, `cellx2500` 8.88×, and the dense `25-1000x5` case 5.24×
Alien.

The React seam numbers are much closer: 1.73 versus 1.47 ms median single-cell write-to-commit (SH1 17.7% slower), 27.70 versus 29.70 ms
urgent p95 during a 2,000-cell transition, and 50.02 versus 54.21 ms median 5,000-cell mount. Those are one machine-sharing run without
confidence intervals, but they indicate that replacing the fork protocol is not the first performance lever.

The realistic levers, in expected-payoff order, are:

1. **Replace `Set`-and-array graph edges with intrusive adjacency and version flags — high payoff, high implementation cost.**
   Allocation-free edge reuse, O(changed edges) unlinking, and integer state are the main reasons Alien-class engines win wide and dense
   graphs. This is the only lever likely to move SH1 from roughly 4× toward the incumbent band by itself; it is also a graph-core rewrite,
   not a local tune-up.
2. **Stop rereading and reallocating dependency state — high payoff.** `Computed.refresh` may call `depsChanged`, then `run`, then
   `replaceDeps`; `replaceDeps` allocates `depValues` with `map` and reads every dependency again. Collect `(node, value)` once during
   evaluation and reuse stable edge records. This directly targets creation, update, fan-in, and dense-graph results.
3. **Specialize the quiescent canonical path — medium-to-high payoff.** When there are no transactions, tracers, React listeners, render
   probe, or effects, an atom write should be an equality check, store, and graph propagation. Today it still crosses optional global
   mechanisms, writes the `causes` `WeakMap` even when `emit` returns zero, and visits generic notification code. A maintained mode bit can
   make those costs conditional without changing transaction semantics.
4. **Remove hot-path snapshots — medium payoff.** `notify` allocates `[...node.subscribers]` per changed atom and `flushEffects` allocates
   `[...pendingEffects]` per wave. Mutation-safe intrusive traversal or generation-tagged queues removes those arrays. This matters most in
   `updateSignals`, broad propagation, and effect-heavy workloads.
5. **Make draft dependency delivery exact — medium payoff for React transitions, little effect on the core CI ratio.** `computedCallbacks`
   broadcasts every draft atom to every mounted computed reader. Recording per-world dependency edges or atom-to-computed subscriber sets
   would turn this into targeted delivery. The added state must be retired with the transaction; otherwise it trades CPU for leaks.
6. **Collapse each transaction’s three atom maps — medium concurrency payoff.** One map from atom to `{base, writes, rebases}` removes
   repeated hashing and entries, and makes fold and retirement fetch one record. Keep the arrays because they preserve dispatch order; do
   not create a normalized intermediate representation unless profiling shows closure replay itself dominates.
7. **Cache world folds by atom plus transaction revisions — medium payoff for render-heavy transitions.** A per-render cache would ensure a
   functional update runs once per atom per render call. A longer-lived cache needs invalidation on canonical writes, urgent rebase append,
   retirement, and equality changes, so the likely first step is a short-lived cache attached to `RenderWorld`.
8. **Represent async identity without strings — low-to-medium payoff, high correctness value.** `worldKey` allocates an `id:revision;`
   string. A render-world object with a monotonically increasing version can be the key, and a weak per-world pending table can preserve
   multiple joined thenables. Keyed resource slots would simultaneously eliminate the documented fresh-promise request.
9. **Reduce root-array churn only after profiling — low payoff.** `slice`, `includes`, spread append, `filter`, and new `live` arrays are
   allocation-heavy in isolation, but live transaction counts are normally small. Fixing lane-to-multiple-transaction correctness should
   choose the final structure; optimizing the current one first would harden the wrong model.

The Round 2 work already removed two genuine quadratic paths: dependency collection promotes to a `Set` at width eight, and effect-child
disposal iterates the `Set` directly rather than repeatedly scanning tombstones. It also replaced all-component canonical broadcasts with
exact per-cell subscriptions. Those changes improved the entry’s local ratio from 5.186× to 3.932×, so another measurement-led graph pass is
credible; the remaining gap is too large to close with fork changes or minor syntax edits.

## Bugginess

The independent judge’s final verdict was clean only after a fix round. The original judged entry implemented write-during-render rejection
in the verification adapter, so direct `Atom.set` in a component silently mutated state. It also wrapped the adapter’s `flushSync` with a
library helper, meaning callers of raw `react-dom` `flushSync` did not get the advertised rebase order. Finally, the contextual `latest`
claim had no test and the binding could read ambient newest intent.

Those three fixes are real, not test-seam patches. `write` now consults a render probe installed by the binding, and the regression calls
`value.set` directly. Raw ReactDOM `flushSync` now brackets the runtime through three fork lines and a nested engine depth counter; the
adapter is a plain re-export. Engine and React tests now cover canonical-versus-world `latest`, including an urgent render while a newer
transition is suspended. The judge independently used library-only imports for the render-write probe and re-ran the suites. Fix quality is
good, although the render probe remains a replaceable global callback and the fork’s own protocol tests do not exercise `flush`.

Before judgement, the shared 25-test battery found five further defects after the entry’s first green claim: atoms did not expose pending
flips; root-owned urgent/deferred updates replayed in the wrong order; a subscriber mounted during a suspended transition could miss
retirement; branch state could show an intermediate frame; and the resulting causal chain was wrong. Round 2 added captured bases and urgent
rebase logs, a flush ordering flag, atom `pendingTransaction` enrollment, suppression of duplicate canonical deliveries, and one targeted
retirement notification. These are coherent fixes and avoid returning to a global component broadcast. They also created the design’s
highest-risk state machine, and that state machine is covered by examples rather than a model oracle.

The randomized oracle is strong for the simpler direct-engine semantics—300×90 by default and 1,200×90 in the deep run—but it never adds
roots. Urgent writes therefore never populate `rebases`, `landed` never drives retirement, and `rebaseOnCanonical` is not exercised. It also
excludes computeds, Suspense, lane assignment, subscription timing, and multiple roots. The 179 generic conformance tests establish the
canonical graph, not the concurrent overlay.

React coverage is 16 entry tests plus the 25 shared battery cases, and the leak audit has two cases. That is useful schedule coverage,
including time slicing and multi-root commit, but thin for the cross-product of multiple live transactions, same-event transitions, pruning,
settlement, refresh, and unmount. The three fork tests verify publication, lane reuse for one batch, and registry reset; they do not verify
remaining-lane retirement or concurrent batch collisions.

Two gaps are already documented by the author: an abandoned render may never emit a trace discard until another render or commit occurs, and
a computed that creates a new promise per evaluation can start an extra request after settlement. The peer reviews add the non-passive
`isPending(computed)` problem. The source audit adds two more material risks: the one-transaction-per-lane overwrite, which appears capable
of losing visibility and leaking a transaction, and the single pending-thenable slot, which cannot preserve identity for interleaved worlds
with different pending sets.

I would not ship SH1 unchanged as a production concurrent-signals runtime. Confidence is high in the ordinary canonical graph and in the
specific schedules pinned by the battery; confidence is moderate in the fork’s fact-reporting shape; confidence is low in untested
multi-transaction and multi-world async composition. The pieces worth adopting are the narrow React fact protocol, opaque render-world
publication, exact mutation and flush scopes, sparse per-atom operation logs, and targeted retirement delivery. Before production use, the
lane-collision model needs a fix and a failing regression, the root-owned rebase/retirement path needs a randomized oracle, and async
pending state needs explicit per-world keyed storage plus a genuinely passive query.
