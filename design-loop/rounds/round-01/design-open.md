# Design open: exact projection worlds

Status: round-01 author design. This is one architecture, not a menu. It
chooses a closed canonical arena plus sparse, exact React-world projections.

## 1. One-page summary

A **receipt** is an append-only record of one atom write. In React mode every
write gets a receipt containing the operation, a monotonically increasing
write sequence, and the integer batch token supplied by the fork. A **world**
is an immutable rule for selecting receipts: it contains a retirement
frontier and, for each still-live included batch, that batch's visible write
cutoff. Folding one atom's receipts in global write order gives exactly the
value React should see for that world. This is React's skip-and-rebase rule,
including the non-commutative updater arithmetic in C3.

The normal signals engine remains a closed, monomorphic arena. With no React
bridge installed it is the whole implementation and executes no concurrency
code. Installing the bridge once swaps the public node prototypes to React
entry points. The same arena then represents the **head** (all writes in write
order), which is what non-render JavaScript and core effects read. A React pass
whose exact receipt selection equals the head may alias its cache. Before any
later receipt append, the engine detaches every open aliasing pass while the
old head topology is still available; resumed reads then use the pass's pinned
sparse world. All non-head renders use that sparse path from their first read.
A fork callback identifies the active render pass on the current JavaScript
call stack. A yield removes the call-stack binding but retains the pass and its
pinned world, so a click in the gap reads and writes the head while the resumed
pass keeps its old world.

Each non-head world has a sparse arena graph. It contains records only for
nodes actually read in that world, and those records contain that world's
real dependency edges and cached values. The world descriptor never changes,
so signal writes cannot stale its synchronous cache. Promise settlement may
append a replacement memo record, but never changes the selected atom values.
Discarding a pass deactivates its graph from notification walks; committing a
pass makes its graph the root's current graph. Thus speculative render reads
do not install subscriptions or leave an observable notification path after
discard.

Notification uses a **projection frontier**. For every live world graph whose
real reverse edges reach a mounted watcher from the written atom, the engine
then compares every live view of that watcher before and after rebasing the
writer receipt. It also compares each pending after-value with the new
writer-only base. It retains after-world graphs even when custom equality
suppresses `setState`. Therefore a branch-changing equal write records the new
branch, and both "pending changed" and "pending stayed put while its base
changed" are detected. A changed writer projection calls the watcher's
`setState` synchronously in the writer's context. An affected other pending
batch receives the update through the fork's `runInBatch` surface. Delivery is
per write, not grouped, so nested `batch`/`startTransition` scopes preserve
lane attribution and two batches can notify an already-stale watcher
independently.

Hooks are provider-free. A small fork hook supplies an integer render-cell
identity stable for one hook position across suspended retries and StrictMode
replay. `useComputed` stages its closure and graph under that cell and the
render lineage; only a commit publishes the stage. Layout subscription then
checks every live batch projection. A mismatch is corrected with
`runInBatch(token, setState)`, so the correction joins the original pending
batch; a retirement race falls back to token `0`, defined by the fork as an
urgent pre-paint scope. `useSignalEffect` is separate from core `effect`: it
runs from the retired/committed world only.

Suspense cells are keyed by stable render cell, exact world key, computed
stage, and `ctx.use` position. A stable fork lineage owns a lifetime reference
but is not an identity discriminator, so a projection evaluated before its
first pass and a later retry share the cell. A retry with the same receipt
selection finds the same thenable even if an unrelated excluded batch wrote;
a signal-visible rebase gets a different world key (and a props/state-only
rebase gets a different hook stage where needed). A new world whose recorded
dependencies all verify equal aliases the old memo/cell, so unrelated commits
do not refetch. Multiple included batches are part of the key, so no
single-token approximation exists.

Version 1 deliberately supports one React root at a time. A second root is
detected at root registration and throws before rendering; portals remain
legal because they belong to the registered root. This removes per-root
committed-world policy from the first version while preserving every required
single-root schedule. The protocol has eight seam touch-points and passes only
integers, booleans, small enums, and callbacks--never fibers, lanes, or update
queues.

## 2. Scope and terms

An **atom** is a writable node. A **computed** is a cached function over other
nodes. A **watcher** is one committed React hook subscription to one output
node; it owns a React `setState` dispatcher. The hook passes a module-stable
integer-bump updater, so notification allocates no updater closure. An
**effect** is a function that tracks all nodes it reads and reruns after an
effective dependency change.

A **batch token** is a fork-minted integer. Its low bit states whether the
batch is deferred; the remaining bits are a generation-bearing identity. The
fork never reuses an identity while either React or the bridge can refer to
it. Token `0` is reserved for an urgent, pre-paint execution scope and is
never a real batch.

A **render pass** is one root attempt from fresh stack to completion or
discard. A **render lineage** is a fork integer shared by retries that select
the same logical React update set. A pass may yield and resume many times. A
pass is **open** from start to end, but is **call-stack active** only while
React is executing its render functions.

A **ticket** is a lexicographically ordered `(era,low)` pair of unsigned plane
fields; zero/zero means absent. Incrementing a low-word wrap increments era.
A batch has a **tail cutoff**, the largest signal write ticket attributed
to it so far. Retirement gives the batch a **retirement sequence**. Retirement
means the batch has left React's books after a commit or a no-work/aborted
close. Both outcomes persist signal writes; the `committed` callback bit is
diagnostic and controls reconciliation urgency, not persistence.

An exact world key is the canonical tuple

```
(episode, retirePin, [(token, tailCutoff), ... sorted by token])
```

`retirePin` is the largest retirement sequence visible when the world was
captured. The sparse list contains included live batches with a nonzero signal
tail; included React-only batches remain in separate owner metadata with no
effect on signal-world identity. The interner hashes the tuple but verifies
every field after a hash match. No hash collision can establish identity.

For receipt `e` and world `w`, visibility is exactly:

```
visible(e, w) =
  (e.retiredAt != ZERO && e.retiredAt <= w.retirePin) ||
  (w.cutoff(e.batch) != ZERO && e.seq <= w.cutoff(e.batch))
```

The atom value in `w` is its episode base followed by every visible receipt
in increasing `seq` order. A set receipt replaces the accumulator; an update
receipt calls its updater on the accumulator; a reducer receipt calls its
reducer with the recorded action. Equality does not remove receipts.

The **head** is the fold with every receipt visible. It is maintained eagerly
in the canonical arena for ordinary JavaScript reads. The **committed world**
is the exact world whose `retirePin` includes all batches retired so far and
no live batch. In the declared one-root scope it is also the state passive
signal effects may observe. Where the acceptance battery says "canonical
world," this design means that committed React world; the mutable core/head
cache is a separate newest-state service.

## 3. Mechanism inventory (7)

1. **Mode-specialized canonical arena.** The measured closed integer kernel
   implements DIRECT semantics and the React-mode head. Bridge installation
   swaps entry-point prototypes once; head-equivalent passes alias it until a
   detach-before-append edge. No world fields enter primary links or DIRECT
   traversal.
2. **Receipt and retirement ledger.** Per-atom ordered tapes, global write and
   retirement sequences, generation-bearing batch slots, and quiescent
   episode compaction implement exact visibility and replay.
3. **Exact sparse world graphs.** Interned immutable world descriptors own
   sparse memo/topology records with the real dependencies read in that world;
   complete dependency re-verification aliases equal records across worlds.
   Render-lineage hook stages live in the same side arena.
4. **Projection-frontier notification.** Reverse walks over live real-world
   graphs, before/after projection pulls, equality cutoff, retained equal
   frontiers, and per-write lane delivery jointly decide watcher work.
5. **Eight-touch fork protocol and pass context.** Fork events maintain open
   passes and a call-stack render binding; fork execution scopes attribute
   writes and corrections to existing batches.
6. **Commit bridge.** Stable hook cells, commit-only watcher publication,
   late-subscription correction, observed-count flap damping, retirement
   reconciliation, and committed-only `useSignalEffect` connect graph state
   to React lifetime.
7. **Positional suspense cells.** Generation-checked cells keyed by exact
   world, hook/stage, node, and call position, with lineage/frontier lifetime
   refs, stabilize suspension and settlement across retries.

Tracing, SSR serialization, schema generation, debug checking, and benchmark
harnesses observe or validate these mechanisms; they are not additional
participants in the concurrency decision.

## 4. Mechanism 1: canonical arena and policies

### 4.1 Packed kernel

Nodes and links occupy one interleaved `Int32Array` plane. Node ids are
premultiplied record offsets and branded at the TypeScript boundary. A packed,
never-holey `unknown[]` holds values, functions, payloads, and stable sentinel
boxes. Hot traversal fields stay in the interleaved records; cold labels,
trace metadata, and receipt heads use side columns.

The kernel uses the donor shape established by the measured facts: stride-8
records, a dependency-tail retrack cursor, iterative propagation with reused
typed scratch stacks, and split link fast/insert paths. Buffers are closure
constants. Growth happens only between public operations by rebuilding the
closure over larger buffers. Same-file non-exported `const enum` values define
record offsets and flags. CI rejects bytecode growth past the measured V8
inlining budgets and ranks V8 and JSC separately.

Policy stays outside the traversal. Custom equality wraps a computed result
into a reference-stable value box. Thrown errors and suspension are stable
sentinel boxes, so a getter publishes a complete result or a complete error;
its provisional links are never left half-installed. The kernel compares box
identity only.

### 4.2 DIRECT and React activation

The default `Atom`, `Computed`, and effect prototype methods call DIRECT
kernel closures. Importing `cosignal/react` performs a version handshake and
installs the bridge before any root registration. Installation is monotonic
for that module instance and swaps the prototypes to logged read/write entry
points. Existing instances change with their prototype; no watcher count is
consulted. A duplicate package instance or stock React fails during install.

This arrangement gives a literal zero concurrency-instruction DIRECT path:
no mode test, receipt test, render test, or side-plane access exists in the
functions a core-only process calls. In React mode, an ordinary read performs
one call-stack-pass slot check. If empty it reads the head kernel; if occupied
it reads either the pass's head alias or its exact sparse world graph.

A pass is **head-equivalent** when its retirement pin and included token
cutoffs select every receipt currently in the head. Such a pass reads existing
global nodes through the canonical cache, while staged hook computeds still use
their sparse stage records. The pass records each consumed logical output and
captures its exact descriptor at start. Before every React-mode receipt append,
M2 first detaches all open head-equivalent passes: M4 may traverse the still-old
head topology for their consumers, and all later reads in those passes route to
their captured sparse world. The detach happens even for a head-equal receipt.
Thus an uninterrupted ordinary render pays the canonical path, while any write
that could make a paused pass drift switches it before mutating the head.

### 4.3 Core graph semantics

DIRECT computeds are lazy and cached. Writes mark downstream nodes possibly
stale. A read verifies dependencies bottom-up and recomputes only an actually
changed path; stable custom equality stops propagation. Dynamic dependencies
are retracked in place. This path is the frozen 179-case/exact-pull-count
kernel.

`effect()` observes the newest head. Outside `batch()` its consequences are
flushed synchronously under the benchmark configuration; other documented
schedulers may enqueue the same ordered flush. `batch()` defers only core
effect flushing. It does not defer React watcher delivery, which is why mixed
React priority scopes remain attributable.

An evaluation stack bit detects a computed reading itself, and an effect-flush
generation detects a signal-only feedback loop. Both throw with the node
labels and dependency path. React-coupled storms use ordinary React state
updates and therefore React's own render/update limits.

Writes inside a computed are allowed in DIRECT/head evaluation when they do
not encounter the evaluation stack and
`configure({forbidWritesInComputeds:false})` is in force. The default may be
set to true. Every sparse world evaluation sets a stricter write guard because
it represents a pure React world; a write there throws before claiming a
batch or appending a receipt.

## 5. Mechanism 2: receipt and retirement ledger

### 5.1 Records

Each atom has a base value and a singly linked receipt tape in write order.
The hot append tail is stored on the atom's cold side record. A receipt has:

```
atomId | next | opKind | payloadIndex | batchSlot | slotGeneration |
writeEra | writeLow | retireEra | retireLow
```

The slot record stores the full fork token, its current tail write sequence,
its deferred bit, the head of its receipts, and the head of watchers/effects
touched by it. Slots are an implementation index only; equality always checks
the full token and generation.

Every React-mode `set`, `update`, and reducer dispatch first calls
`claimWrite`, then appends exactly one receipt. This includes equal writes,
urgent writes, default-priority writes, and writes with no subscribers. The
operation is then applied to the head kernel in write order. A head-equal
result may suppress head propagation, but cannot remove the receipt or skip
the projection walk.

### 5.2 Folding and replay

World reads scan one atom's tape in sequence order and apply the visibility
formula from section 2. The sparse world memo pays that scan only on its first
atom read. Reducer actions and updater functions remain as user-supplied
references in the packed payload column; the engine does not allocate a
closure per receipt.

Retirement assigns one retirement sequence to the token and stamps its
receipts. It advances the committed world even when `committed` is false.
The head does not need recomputation: it already contains all writes in the
same global order. Retirement can recycle a live slot only after no world
descriptor refers to its token/cutoff pair; stamped tape entries retain the
full token and no longer depend on the slot.

After stamping, M3 canonicalizes each batch-owned **future frontier**: it
advances to the new committed retirement pin, removes the retired token from
the owner set, and retains every other live owner at its tail. Open/pinned pass
descriptors do not change. If the canonicalized tuple selects the same
receipts as an existing graph, its memo records may be referenced by an alias;
otherwise they evaluate lazily. Obsolete future frontiers release only after
their replacement is live, while an open pass keeps its independent ref.

At full quiescence--no live token, open pass, retained lineage, pending
suspense cell, or effect flush--all receipts are folded into atom bases in
write order. The tape and sparse world planes reset together and the episode
increments before sequence numbers restart. A long-lived skipped transition
retains later updater receipts because arbitrary updater composition cannot
be summarized without changing semantics; this is the same history pressure
as a React update queue rebasing over a skipped update.

No optimistic truncation API exists. An aborted or no-React-work batch still
retires and persists. Consequently there is no half-removed receipt state to
represent.

## 6. Mechanism 3: exact sparse world graphs

### 6.1 Capture and interning

On a pass's first active entry, the bridge captures the current retirement
sequence and the current tail sequence of every included live token emitted
by the fork. It sorts token/cutoff pairs into reused integer scratch storage
and probes an open-addressed typed-array interner. The complete tuple is
compared before reuse. World descriptors and pair lists come from bump/free
arenas, so a steady pass creates no JavaScript object or array.

An excluded live batch is absent. Therefore an unrelated write to that batch
does not change the key and cannot destabilize a suspense retry. A write to an
included batch after capture is above its cutoff and is absent until React
starts a replacement pass.

### 6.2 Sparse evaluation

A world graph record is keyed by `(worldId, logicalNodeId, stageId)`. It holds
a state, a stable value/error/suspension box, and heads for dependency and
reverse-dependency links. The evaluator reads an atom by folding receipts for
the descriptor. It evaluates a computed into provisional links, then publishes
the value and links as one operation. A throw publishes an error box after
unwinding the evaluation stack. A suspension publishes a suspension box tied
to mechanism 7.

On a record miss, the node's nearest live predecessor memo is an exact
re-verification candidate. The evaluator reads **every** dependency recorded
there in the target world, including atoms that had no receipt when the old
memo ran. If all dependency boxes compare equal, it publishes a target-world
alias with the same output box, real links, and positional suspense cells. If
any differs, it runs the function and records the target world's actual,
possibly different dependencies. Nested candidates are verified bottom-up.
This is a complete dependency list, not a list filtered to concurrent atoms.
It lets unrelated retirement/frontier changes reuse a computed or pending
thenable without weakening exact world selection.

Synchronous successful records never become stale because their descriptor's
receipt selection is immutable. A settled thenable makes the suspended record
retryable; retry appends and atomically activates a replacement record. The
old record remains generation-addressable until no traversal can hold it.
Thus promise settlement changes an external input, not the world's atom
assignment.

`ctx.previous` in DIRECT/head evaluation is the preceding successful head
value. In a React world it is the value of the same stage in the pass's base
world: the captured committed world with live included tokens removed. It is
`undefined` if that stage has no successful base value. This choice is stable
across retries, independent of evaluation order, and shared by all components
reading that stage.

### 6.3 Live topology and render purity

World records can be cached while inactive, but reverse notification walks
consider a graph only while at least one of these references is live:

- it is the current committed graph of a mounted watcher;
- an open pass, including a yielded pass, owns it;
- a live batch owns it as a retained projection frontier; or
- a layout subscription check owns it until the check finishes.

Render evaluation never attaches a watcher and never changes observed counts.
Each hook read does register a **render consumer** in its pass record: the
logical output id, the value box read, and its already-created React state
dispatcher. This is not a subscription, contributes no observed count, and is
reachable only while that pass/finished lineage is live. It lets a write in a
yield gap invalidate an initial mount that has no committed watcher yet.
Pass end removes the open-pass reference. A discarded lineage's hook stages
and graphs become inactive before any later user callback can write. A
committed stage is published in layout and its graph becomes the watcher's
current graph; layout also replaces its render consumer with the committed
watcher. Cached inactive records cannot be traversed for notification.

Construction for speculative purity:

- Base: before a pass starts, none of its stages or graph records has a live
  reference, subscription, or observed count.
- Step: each render read can append private memo/topology records, but the only
  externally consulted bit is the pass reference installed by pass start. A
  write while the pass is open may use those edges only to invalidate that
  very attempt or its pending batch, which is required render scheduling.
- End step: completion keeps only a lineage reference until layout publishes
  the selected stages; discard or uncommitted token retirement removes it.
  Since notification walks filter on a live pass/lineage and watcher lists are
  commit-only, records from a discarded pass cannot schedule a later update or
  alter lifecycle counts.

### 6.4 Hook staging

`useComputed` obtains a stable integer cell from the fork. The tuple
`(cell, lineage)` indexes a staged node configuration containing `fn`, `deps`,
and options. Equal deps reuse the preceding staged configuration and closure,
matching `useMemo`; changed deps append a stage. Concurrent lineages never
overwrite each other. Reads during that pass resolve the stage before probing
the world graph. Commit publishes the stage as the cell's outside-render
configuration; discard only releases the lineage reference.

`useAtom` and `useReducerAtom` use the same stable cell registry. A suspended
first mount therefore finds the same staged logical node on retry. Writes in
that render are rejected, so no uncommitted stage can leak state. Sequential
reuse after unmount requires both a new cell generation and a generation match
at every registry lookup.

## 7. Mechanism 4: projection-frontier notification

### 7.1 Projection

Every live graph also records its **owner set**: the still-live batches whose
future render it represents. For live graph `v`, batch `k`, and cutoff `s`,
`project(v,k,s)` starts with the **current committed world**, adds every live
owner of `v` at that owner's current tail, then adds/replaces k at `s`. Cutoff
zero contributes no k receipts, although k may remain in owner metadata. This
is the world React will build after rebasing that pending work, not the
immutable pinned pass.
The pinned pass keeps its original descriptor. The interner makes repeated
projections share graphs and values.

For a write in `k`, let `oldTail` be the token tail before append and
`newTail` the receipt's sequence. The notification operation is:

1. Reserve `newTail`. Before publishing it, walk the still-old head topology
   for every head-alias consumer--a committed watcher or an open pass--and
   record those reached. Detach open aliasing passes to their already-captured
   exact descriptors before the head can change.
2. Append the receipt, advance the token tail, and apply the operation to the
   head kernel. Head equality cannot skip subsequent projection work.
3. For each live sparse graph with a real reverse path from the written atom,
   walk that graph iteratively. Record every reached mounted watcher or live
   render consumer as a candidate. Direct atom consumers are seeds too; merge
   the alias candidates from step 1. Once a logical output is a candidate,
   enumerate **all** of that consumer's live worlds, not just the graph through
   which the source reached it.
4. For each such world `v`, pull the consumed output in
   `before=project(v,k,oldTail)` and `after=project(v,k,newTail)`. Also pull
   `baseAfter`, the current committed world plus only k at `newTail`. The pulls
   share memo records. Publish and retain the after graph
   as the `(v,k)` projection frontier even when values compare equal. Once per
   candidate, also compare k at old/new tail over the current committed world;
   this is the writer pair.
5. If the writer pair differs, call the state dispatcher once in k's current
   execution context. For each other live token present in v, call the
   dispatcher inside `runInBatch(token, ...)` when either
   `before != after` (the pinned attempt became stale) or
   `after != baseAfter` (that pending world's post-write value differs from the
   base that may commit first). Multiple discoveries in one write share a
   scratch delivery ticket per `(consumer,targetToken)`.
6. Add each committed watcher and any reached committed signal effects to `k`'s
   retirement lists. Release superseded frontier references only after the
   new records are active.

Walk tickets and preallocated pair tables deduplicate the same candidate,
world comparison, and `(consumer,targetToken)` reached through diamonds or
multiple active records during one write. They do not deduplicate across
writes. React coalesces same-batch state updates; the signals engine
deliberately keeps per-write delivery.

If `runInBatch` reports that a non-writer token retired during the call, the
watcher is compared with the now-committed world and, if still different,
scheduled through token `0`. Acceptance of a `runInBatch` call pins the token
until the callback has enqueued its update.

### 7.2 Why divergent dependencies remain reachable

The reachability construction assumes React-world computeds are pure; writes
from them are rejected before graph mutation.

- Base: a mounted watcher or live render consumer has read its output in world
  `v`. Its live sparse graph--or a head alias before detach--contains exactly
  every dependency used by that evaluation.
- First-divergence step: compare evaluation in `v` with evaluation after some
  batch receipts. Both executions read the same atom prefix until the first
  atom whose selected value differs. That atom was read in `v`, so its write
  has a reverse path to the output in `v`. The projection walk reaches the
  watcher and evaluates the after world.
- Inductive step: after every reached write, the after-world's actual links
  are retained even when its output is equal. If a later write targets a
  dependency introduced by the changed branch, that dependency has a reverse
  path in the retained frontier. If it targets no dependency there, it cannot
  affect that evaluation until another reached write changes control flow;
  that control-flow write installs the next actual frontier by the same step.
- Multi-batch step: the operation is performed from every live base world and
  projection owner. Reaching a watcher through any one real graph causes all
  of that watcher's live owner sets to be compared. Each future projection is
  rebuilt over the current committed base; `before != after` catches a stale
  pinned value and `after != baseAfter` catches an unchanged pending value
  whose base moved. Therefore the induction applies independently to each
  included-token set and to either side of an urgent rebase.

This base-and-step argument is the reason equality-suppressed topology is
retained and inactive/discarded topology is excluded. Removing either rule
breaks one side of the induction.

### 7.3 Equality and scheduling semantics

Equality is tested on the watched output between the two exact projections.
For direct atom watchers it is the atom's `isEqual`; for computed watchers it
is the computed's stable policy box. A same-batch first write that changes
only topology schedules nothing but retains the topology. An effective second
write is then reachable and schedules normally.

Notification pulls stay boxed: they catch cached errors and suspensions rather
than throwing into `set`/`dispatch`. Equal stable boxes cut off; a changed
value/error/suspension box schedules the consumer, whose subsequent render
unboxes and returns, throws the error, or suspends through React.

A write can change an already-pending world's eventual rebase without changing
the writer-only world. In that case step 5 schedules the owner pending token
with `runInBatch`; writer-context notification alone is insufficient. This is
the T5 branch of C1. The common writer projection still uses synchronous
writer-context `setState`, preserving React's priority, batching, and loop
guards.

There is no implicit notification drain and no same-batch receipt coalescing.
An explicit `batch()` delays core effects only. This deletes a context-capture
problem rather than encoding it in another queue.

## 8. Mechanism 5 and `fork-protocol` v1

The binding requires `react.concurrentSignals.version === 1` and all eight
touch-points below. Missing or mismatched protocol support throws during
module installation. There is no stock-React fallback.

### 8.1 Seam touch-points (8)

| # | direction | protocol surface | contract |
| --- | --- | --- | --- |
| 1 | library -> fork | `claimWrite(): BatchToken` | Return/mint the current action or event batch. The low bit classifies deferred. Preserve the token through supported async actions. |
| 2 | fork -> library | `onRoot(root, phase)` | `OPEN`, `CLOSE`, or quiescent `RESET`; integer root only. `OPEN` is edge-triggered from root registration. |
| 3 | fork -> library | `onPass(pass, root, lineage, phase)` | `START`, `RESUME`, `YIELD`, `COMPLETE`, or `DISCARD`. `START` creates an inactive open record; `RESUME` binds it to the call stack. |
| 4 | fork -> library | `onPassBatch(pass, token)` | Emitted after `START` and before first `RESUME`, once for every batch included by the pass. |
| 5 | fork -> library | `onBatchRetire(token, committed)` | Exactly once, after commit bookkeeping or no-work/aborted close, and only after an async action settles. |
| 6 | library -> fork | `runInBatch(token, callback): boolean` | Run synchronously with updates attributed to that live token. Return false if retired. Token `0` means urgent pre-paint execution and always succeeds while a root is open. |
| 7 | hook -> fork | `useRenderCell(): RenderCell` | Custom hook returning an integer stable for a component hook position across retries and StrictMode replay, with a generation on later reuse. |
| 8 | fork -> library | `onDomMutation(root, phase)` | `BEGIN`/`END` edges around the mutation window; used by dev assertions and tracing, not world selection. |

`onPass(START)` is followed by zero or more `onPassBatch` calls and then
`onPass(RESUME)` before user render code. On yield, `YIELD` clears only the
call-stack binding. The pass record and world reference stay open. A later
`RESUME` restores the same pass. `COMPLETE` and `DISCARD` both clear a binding
if present and end the pass; only commit publication distinguishes completed
work from abandoned stages.

The library uses a small stack rather than a wall-clock boolean for the active
pass. JavaScript event handlers run with an empty stack because the fork has
already emitted `YIELD`. Nested renderer entry, should React introduce it, is
paired by pass id and therefore restores the preceding binding.

`claimWrite` is lazy. A transition with only a signal write still mints and
parks a token. A default-priority write in an event remains pending through a
same-stack `flushSync`; its no-work retirement cannot occur until the event
batch closes. An async action token is carried by the fork's action context
across `await` and cannot retire until the returned thenable settles.

`runInBatch` is synchronous and edge-scoped. Inside its callback,
`claimWrite` would return that token, although notification callbacks only
call React `setState`. A successful call pins retirement until callback exit
and update enqueue. The fork accepts a dispatcher belonging to a live
not-yet-committed render cell and restarts that attempt; this is how a yielded
initial mount is invalidated. It does not expose or accept a lane mask.

### 8.2 Root scope

The first `OPEN` records the sole root integer. A different root's `OPEN`
throws synchronously before its first render and names the unsupported
multi-root condition. A portal emits no root open and is legal. After `CLOSE`,
a sequential replacement root is legal only after all tokens, passes,
lineages, and effect flushes from the old root retire; otherwise it is treated
as a second root and rejected.

Named future work is a per-root committed retirement pin plus per-root watcher
publication table. Receipt visibility, exact world tuples, and token cutoffs
already carry no global-DOM assumption; adding that table and fork per-root
lock-in events extends rather than replaces the ledger. Those events are not
part of v1 and no multi-root behavior is implied here.

`RESET` is legal only at that quiescent boundary. It lets fork-owned token,
pass, lineage, and render-cell serials recycle with a new generation. The
library checks that its own episode is also quiescent before accepting it.

### 8.3 Fork-side invariants and hook sites

The fork maintains a private map from its current lane/update-batch identity
to protocol tokens. That map and all lane arithmetic remain inside React.
Every event is emitted from a place React already changes the corresponding
fact:

- root open/close at root registration/disposal;
- pass start and included batches when a fresh render stack is prepared;
- yield/resume at scheduler handoff edges;
- complete/discard when React drops or finishes that stack;
- retirement at the single batch registry close path, after commit or no-work
  closure and after action parking reaches zero;
- mutation begin/end immediately around mutation effects; and
- render-cell identity in hook-list traversal, using hook ordinal and logical
  fiber generation internally but returning only an integer.

With no installed listener each event site pays one null check. `claimWrite`,
`runInBatch`, and `useRenderCell` are unreachable from stock applications
unless the protocol is installed. Proposed fork budget is at most six
reconciler files, two public/export files, 600 changed non-test lines, and one
new internal concept: the batch-token registry. These are implementation
exit budgets, not measured facts.

### 8.4 Retirement ordering

For a successful single-root commit, mutation and layout work complete before
`onBatchRetire`. This lets layout subscriptions join the still-live token. For
a no-work or abandoned close, retirement fires at the registry close edge;
the library may use token `0` to reconcile affected mounted watchers before
the browser is allowed to paint. `committed` reports whether that token took
part in a DOM commit, but the callback is exactly once in both cases.

### 8.5 Rebase drill

| React change | fork work | signals-library work |
| --- | --- | --- |
| Lane names/bits are replaced | Re-map internal batch membership to the same integer tokens and included-token events. | None. |
| Render-stack or yield code moves | Move paired `onPass` edges and rerun lifecycle tests. | None. |
| Commit phases move | Re-establish mutation edges and retirement-after-layout invariant. | None. |
| Hook queue representation changes | Re-implement `runInBatch` attribution and render-cell stability against the new internals. | None. |
| Transition/action context changes | Re-implement `claimWrite` and async parking while preserving token identity. | None. |
| Fiber representation changes | Re-key the private render-cell table; continue returning generation-bearing integers. | None. |

The library changes only for a versioned protocol semantic change. Internal
React types are neither imported nor structurally mirrored.

### 8.6 Fork reconciler tests

The fork owns these tests, separate from library integration tests:

1. Deferred, discrete, default, and token-0 contexts classify correctly; one
   logical batch keeps one token and distinct live batches differ.
2. A signal-only default batch stays live across same-event `flushSync` and
   retires once afterward.
3. An async transition action keeps its token across `await` and retires only
   after settlement.
4. Pass events are `START`, all inclusions, `RESUME`, paired yield/resume
   edges, then exactly one terminal event.
5. A handler in a yield gap observes no active render binding.
6. A restart gets a new pass id; a retry with unchanged logical update set
   keeps lineage; a true rebase changes lineage or its exact included set.
7. `runInBatch(k)` enqueues an update in `k`'s batch for both committed and
   live initial-mount dispatchers; accepted execution pins retirement; retired
   `k` returns false; token `0` is urgent pre-paint.
8. Layout effects can join a committing token before retirement.
9. Retirement is exactly once for committed, no-work, and abandoned batches.
10. A spanning second root is observable as a second `OPEN` before render;
    portals emit no open.
11. `useRenderCell` is stable through StrictMode double invocation, suspended
    initial-mount retry, time-slice restart in one lineage, and changes
    generation after real unmount/reuse.
12. Mutation begin/end edges nest correctly around every DOM mutation path.
13. With no listener, instrumentation is inert and every site executes only
    its null check.
14. Forced-small token/pass/lineage/cell counters reset only after quiescent
    `RESET` and never reuse a live integer identity.

## 9. Mechanism 6: hooks, subscriptions, and effects

### 9.1 Hook surface

The package exports provider-free hooks:

- `useSignal(signal)` reads the active pass world and subscribes at layout;
- `useAtom(options)` and `useReducerAtom(reducer, initial, options?)` allocate
  or recover a staged stable-cell node and then behave as `useSignal`;
- `useComputed(fn, deps, options?)` stages the closure as described in 6.4;
- `useSignalEffect(fn, deps?)` installs a committed-world effect in passive
  commit processing.

Each render records on the hook: output node/stage, exact world id, rendered
value box, included live tokens, and its React state dispatcher. The record is
the pass-local render consumer from 6.3. No watcher is attached during render.

### 9.2 Layout publication and late join

Layout publication removes any preceding committed subscription for the
cell, publishes the selected stage, attaches the watcher to the output node,
removes the pass-local consumer, and increments that node's observed count.
Watcher lookup is by logical output id, so a concurrent stage of the same
`useComputed` cell reaches the same dispatcher without publishing that stage.
It then performs this check before paint:

1. Compare the rendered box with the current committed-world box.
2. For each live token, compare it with the output in the exact projection of
   the rendered base world through that token's current tail.
3. For every differing live projection call
   `runInBatch(token, watcher.setState)`.
4. If a call returns false, re-read committed state and use
   `runInBatch(0, watcher.setState)` only if a difference remains.

A successful live-token call pins retirement through enqueue, so the
correction and token participate in one commit. Starting a fresh transition
would mint a different token and permit the original token to commit first;
this protocol never does that.

On unmount, layout cleanup detaches exactly the watcher generation it
attached. A later StrictMode mount has the same render cell but a new
attachment generation; stale cleanup cannot remove it.

### 9.3 Observed atom lifecycle

Every atom keeps an integer observed count across committed watchers and core
effects. A 0->1 or 1->0 edge only marks a desired state and schedules one
microtask per atom. At the microtask, the final count is compared with the
running resource state. A positive count starts `options.effect` once and
stores its cleanup; zero runs cleanup once. A StrictMode attach/detach/attach
within the turn therefore starts once, while a true later unmount cleans up.
No render-stage reference affects the count.

### 9.4 Retirement reconciliation

Each token records mounted watchers reached by its projection walks. On
retirement the bridge constructs the new committed world and compares those
watchers' last rendered boxes with it. A watcher already correct needs no
update. A mismatch after `committed:false`, or a subscription race around a
commit, is scheduled with token `0`. The touched list depends on writes and
topology, never on whether a watcher existed when the first receipt was
appended; receipt persistence is independent of this list.

### 9.5 Committed-only React effects

`useSignalEffect` has a committed-world dependency graph and is queued on a
token when a write's reverse walk reaches one of its dependencies. The queue
is not flushed on write. At that token's retirement, after the committed
world advances, the effect verifies its dependencies bottom-up in that world.
If an equal computed cuts off, the user function does not rerun. Otherwise it
runs once, retracks real committed dependencies, and records the new box.

An unrelated token's retirement processes only its own effect queue. Thus a
live default batch is excluded even if its operation was already applied to
the head. The initial mount effect also captures the post-commit committed
world. Core `effect()` deliberately differs: it reads and reacts to the newest
head, including unretired writes.

## 10. Mechanism 7: suspense cells

`ctx.use(thenable)` increments a call-position counter on the current computed
evaluation. Its cell key is:

```
(episode, renderCellGeneration, stageId, logicalNodeId,
 exactWorldId, callPosition)
```

The exact world id expands to the verified retirement frontier and complete
sorted token/cutoff list. A multi-batch world is therefore not represented by
one arbitrary token. `pass` and `lineage` are intentionally absent from cell
identity: passes change on retry, and writer projection can evaluate before a
render lineage exists. A stable lineage and each live projection frontier hold
refs to the same cell and thereby define its lifetime.
For a non-hook `Computed`, render-cell generation is reserved zero and the
logical node generation supplies uniqueness.

On first use, the cell stores the input thenable, `pending` status, and a
generation-checked settlement continuation. The computed publishes a stable
suspension box and throws the stored thenable through React's `use` protocol.
On replay, a newly created input at the same position is ignored while this
cell is live; the original thenable is returned or its settled result is used.
Settlement marks the sparse memo retryable and asks every owning live lineage
to retry. Fulfillment returns the stored value; rejection throws a stable error
box.

If any visible receipt set changes, the exact world id changes. Complete memo
re-verification aliases the preceding cell when every dependency read before
the suspension is equal; otherwise the changed world may create a new cell. A
write in an excluded live batch does not change the key. Cells remain until all
lineage, frontier, pass, and pending-thenable refs release them. A late
continuation checks cell generation before touching a reused slot.

The head kernel has a distinct non-React suspension cache. The committed React
world does not probe either head or another world's cell, so a transition-only
suspension is absent there. An outside-render core read follows the documented
newest-head contract and may independently suspend on the transition input.

## 11. User-facing API semantics

### 11.1 Atoms and reducers

`new Atom<T>({state, effect?, isEqual?, label?})` creates a node. `.state` is
tracked in computed/effect evaluation and untracked otherwise; `set(value)`
and `update(fn)` use the current execution mode. `isEqual` defaults to
`Object.is`. The optional observed resource follows 9.3.

`ReducerAtom` records each `dispatch(action)` as an action receipt. Every
world invokes the reducer in receipt order from its selected base. It never
stores merely the latest reduced value, so skipped actions and later urgent
actions rebase identically to `useReducer`.

### 11.2 Computeds

`new Computed<T>({fn(ctx), isEqual?, label?})` is lazy. `ctx.use` follows
section 10. `ctx.previous` follows 6.2. Dynamic dependencies are exact in the
head and in every sparse world graph. Errors and suspensions are cached boxes;
provisional dependency records are committed only with their corresponding
box.

### 11.3 Core control

`untracked(fn)` temporarily clears the dependency collector but not the active
React world, so reads remain world-consistent without adding links.
`batch(fn)` defers core effects and preserves receipt order; watcher delivery
stays synchronous per write. `configure` controls effect scheduling,
write-in-computed rejection, tracing, and dev checks. No `effectScope` is
included in v1 because ordinary disposal handles the required API and a scope
does not earn a concurrency mechanism.

`startSignalTransition(fn)` is a thin call to the fork's transition action
surface and returns its result; it does not create a signal-side batch.
`useSignalTransition` similarly exposes React's pending state while invoking
the same fork action. Plain `startTransition` needs no wrapper because
`claimWrite` observes it.

### 11.4 SSR and hydration

SSR runs a fresh DIRECT graph and serializes atom ids/labels plus base values;
no React receipt episode is live. Hydration restores those bases before bridge
root `OPEN`, validates the schema/version and duplicate ids, then starts a new
episode. Server errors or suspensions use the renderer's normal protocol.
RSC/Flight transfer is outside v1.

## 12. Counters, generations, and reclamation

All semantic counters are unsigned integer fields in typed planes. Tests can
compile them with 3- or 4-bit horizons. Wrap handling is part of the operation,
not a probabilistic assumption.

| counter/id | retained references | reuse/reset rule | forced test |
| --- | --- | --- | --- |
| `episode` | every receipt, world, memo, suspension cell, trace cause | Increment only at full quiescence. Before episode wrap, zero/reset every side plane and generation table, then restart at 1. | Old world/memo with colliding write values never validates after reset. |
| write ticket `(era,low)` | receipts and token cutoffs | Low wrap increments era. Full pair exhaustion resets only with episode increment after tapes/worlds sweep; if not quiescent, append throws before mutation rather than reuse. | Low wrap preserves ordering; forced full exhaustion with a pinned pass refuses; next episode may reuse low bits safely. |
| retirement ticket `(era,low)` | receipt `retiredAt` and world `retirePin` | Same two-word rule and paired episode reset; full exhaustion with an open world refuses retirement before changing visibility. | Old retirement frontier cannot include a new episode's receipts. |
| fork batch token | receipts, slots, worlds, touched lists | Generation is encoded in integer identity; no reuse while referenced. Full serial wrap requires quiescent `onRoot(RESET)`. | 31 live plus repeated retire/reuse; exact token checks reject stale slot. |
| batch-slot generation | receipts until stamped, world pair lookup | Increment before reuse after reference count zero. On generation wrap, clear every slot-indexed stamp column before reuse. | Stale pair with same slot but older generation is rejected. |
| node id/generation | wrappers, links, watchers, memos | Free only after all graph/link refs release; increment generation. Exhausted generation quarantines slot until episode reset. | Late promise and stale watcher cannot reach reused node. |
| link id/generation | traversal scratch and deferred free list | Links free only at operation boundary; generation checked before deferred unlink. Wrap clears link/scratch planes at quiescence. | Growth plus nested retrack cannot unlink a new link. |
| world id/generation | passes, frontiers, watchers, suspense cells | Tuple interner holds a ref; free at zero, increment generation; quarantine on wrap. | Reused index with old memo does not hit. |
| memo/stage id generation | reverse links, hook cell, promise callback | Publish after complete construction; reuse only at zero refs and increment. | Discard/replay and late settlement ignore prior stage. |
| walk ticket | node/watcher scratch stamps | On next value zero, clear the stamp columns before issuing ticket 1. It is never stored in a semantic cache. | Diamond walk across forced wrap visits each current pair. |
| fork pass/lineage/render-cell ids | open records, stages, suspense lifetime refs and render-cell keys | Fork encodes generations and resets only at quiescent root `RESET`. | Suspended initial mount across forced serial wrap keeps identity until release. |
| trace sequence | ring/lossless records | Two 32-bit words; ring overwrite is intentional and tagged by generation; lossless mode stops with explicit overflow before full wrap. | Causality never links overwritten generation. |

World-interner hashes are not identities and may wrap freely because a hit
always compares episode, retirement pin, pair count, every token, and every
cutoff. Observed-lifecycle scheduling uses a pending bit rather than a ticket.

## 13. Tracing

Every instrumentation site performs one load of a recorder slot and branches
away when it is zero. A lazily imported recorder installs either a fixed-size
typed ring or a chunked lossless session. Event fields are integers and
payload indices; recording allocates no object. Lossless chunk allocation is
allowed only at operation boundaries and is reported separately.

Events include node create/free, receipt append, batch claim/retire, world
intern/hit/free, pass phase, projection edge visit, cutoff result, watcher
delivery with target token, stage publish/discard, effect queue/flush,
suspense cell/settle, and arena growth. Each carries a trace sequence and
cause sequence. Queries walk integer cause links to answer "which write caused
this render/suspension/effect?" Graphviz exporters reconstruct head or chosen
world dependency graphs outside the hot path. Ring loss reports overwritten
generations; lossless sessions fail explicitly at their configured bound.

## 14. Cost model and numeric gates

Complexities use `d` for traversed dependency links, `r_a` for receipts on the
read atom since its base, `v` for live world graphs having a path from the
written atom, and `q` for watched outputs reached. The architecture does not
hide the concurrency-active multiplication by `v`.

| path | time | steady engine allocation | CI gate |
| --- | --- | --- | --- |
| DIRECT atom read/write | O(1) plus ordinary graph propagation | 0 | At or below alien-signals v3 on every tier-0 shape; 179/179 with exact pull counts and growth stress. |
| DIRECT computed pull | O(exact dirty cone) | 0 | Donor measured ranges remain the starting bar: deep <=0.90x, broad <=0.88x, diamond <=0.89x, reads <=0.87x, create <=0.96x alien. |
| React bridge installed, head-equivalent pass | O(DIRECT path), one active-pass/alias check | 0 | <=1.02x DIRECT across quiet tier-0 reads and pulls. |
| React receipt append/head update | O(1) plus head propagation | 0 until arena growth | <=2.00x DIRECT isolated write, the always-log gate established by the research facts. |
| First atom read in exact world | O(`r_a`) | 0 until arena growth | Unmeasured: SP-R1; proposed gate p95 <=1.50x replaying an equivalent React reducer queue of the same length. |
| Exact-world cache hit | O(1) tuple/node lookup | 0 | Unmeasured: SP-R1; proposed held-transition read gate <=1.10x head computed cache hit. |
| New-world memo re-verification | O(recorded dependency cone until first change) | 0 until arena growth | Unmeasured: SP-R1; exact pull counts recorded separately; unchanged broad/deep verification proposed <=1.20x donor dirty verification. |
| Projection notification | O(sum `d` over reached live graphs + projected pulls) | 0 until arena growth | Unmeasured: SP-R2; proposed one-live-transition fan-out <=1.25x the same eager cutoff work in one head graph, and scaling linear in visited links with slope <=1.15x per additional graph. |
| Hook mount, 10k subscriptions | O(10k) | node/watcher arena growth only | <=1.15x equivalent `useState` mount. |
| Signal-driven re-render | Head-equivalent: canonical hit; divergent: projected pull; plus React render | 0 | <=1.10x equivalent `useState` update in the one-batch gate, with divergent cases reported separately. |
| Steady re-render with unchanged world | O(1) memo hits per read | 0 | Zero engine allocations; report `heapUsed` and typed-plane bytes separately. |
| Untraced site | O(1) recorder-slot load | 0 | Bytecode budget includes exactly one slot check per site. |

SP-R1 and SP-R2 are required spikes, not performance assertions. SP-R2 runs
deep, broad, diamond, isolated-write, held-transition, and C1/C5 branch-flip
shapes with 1, 2, 8, and 31 live graph references. If the one-transition gate
fails, this architecture is rejected rather than silently replacing exact
cutoff with notify-all. If only high-`v` scaling fails, the product may impose
a measured concurrent-batch admission limit lower than React's 31 only after a
new requirements decision; this spec does not impose one.

Benchmarks run one framework per process and include a bundled child so
module-const demotion is detected. Bytecode CI caps hot callees below 460 and
cumulative inlining paths below 920 bytecodes, with at most 27 greedy inline
sites. V8 and JSC rankings are independent. Arena growth is excluded from
steady samples but tested separately and included in GC-inclusive kairo runs;
kairo must remain <=1.4x alien and targets <=1.25x without claiming it now.

## 15. Construction proofs used by the case walks

### 15.1 One world is internally consistent

- Base: a world descriptor is captured before its first user read, with one
  retirement pin and one cutoff for every included token.
- Read step: every atom fold tests receipts against only those immutable
  fields. A computed recursively reads through the same descriptor and
  publishes its cache only after all dependencies complete.
- Yield/replay step: yield changes the call-stack binding, not the descriptor;
  resume restores the same world id. A retry either interns the same complete
  tuple or, after a visible change, a different tuple.

Therefore all reads made through one pass use one receipt selection. The
argument applies recursively to every computed edge; no head value is a
fallback for a missing world record.

### 15.2 Replay matches React update queues

- Base: before any episode receipt, atom base equals React's pre-batch base.
- Sequence step: inspect receipts by global sequence. If a receipt is not
  visible, leave the accumulator unchanged but retain the operation for a
  future world. If visible, apply that exact set/updater/reducer operation.
- Rebase step: a later world that includes a formerly skipped receipt scans
  from the same base and applies it at its original position; already retired
  later operations are encountered afterward and re-applied.

This is React's skip-and-clone arithmetic. A set remains replacing rather than
becoming an updater, and action order cannot change.

### 15.3 Equal receipt retention

- Base: with no receipt removed, every world's fold is defined solely by its
  key and ordered tape.
- Step: appending an equal-to-head receipt changes no earlier receipt or world
  key. A world excluding earlier history may still select the new receipt;
  because it exists, that world applies it. Equality is evaluated only between
  complete before/after projection results.

Thus head equality cannot erase a value needed by another world. C8 is the
minimal witness.

### 15.4 Episode reuse

- Base: quiescent compaction removes every old tape, pass, frontier, stage,
  and suspense reference, then increments episode before resetting sequences.
- Within-episode step: every reusable indexed object checks its generation;
  every world/memo/cache checks episode or an id containing generation.
- Wrap step: a generation that would collide triggers column clearing or slot
  quarantine; fork serial wrap requires quiescent `RESET`.

No retained semantic record can match only a reused counter. Forced-small
tests exercise each row in section 12.

## 16. Acceptance-battery walks

Mechanism references use M1--M7 from section 3. `W(x)` denotes the exact
world value of `x`; `F(v,k,s)` denotes a retained projection frontier.

### C1: a pending branch introduces a dependency absent from committed topology

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | setup / M1,M3,M6 | Committed world `V0`: `flag=false,a=0,b=0,c=0`; sparse real edges `flag->c`, `b->c`; watcher W attached to `c`. |
| 2 | k writes `flag=true` / M2 | Append `(flag,set true,k,s1)`; `tail(k)=s1`; head becomes `flag=true,c=0` and tracks `a`. |
| 3 | projection / M4 | Walk `flag->c` in `V0`. Compare `project(V0,k,0): c=0` with `F(V0,k,s1): c=0`; equality suppresses W's setState, but retained frontier edges are `flag->c,a->c`. |
| 4 | optional k read / M3 | The read hits the same exact frontier and caches `c=0`; committed `V0` remains `c=0` via `b`. |
| 5 | k writes `a=1` / M2,M4 | Append `(a,set 1,k,s2)`. The retained real edge `a->c` reaches W. Before projection at `s1` is 0; after at `s2` is 1. |
| 6 | delivery / M4,M5 | W's setState runs synchronously while `claimWrite` is k, so React assigns k's lanes. A k pass includes W and reads exact world `{k@s2}`: `flag=true,a=1,c=1`. |
| 7 | commit / M2,M6 | Before k retirement committed reads still use `V0` and return `b=0,c=0`. Retirement advances committed world to both k receipts; W already rendered 1. |

outcome: k commits `c=1` with W rendered in k, while the old committed world
stays `c=0` until retirement. The first-divergence construction in 7.2 covers
the absent canonical `a->c` edge.

residual risk: dropping an equality frontier or filtering notification to the
head graph regresses this; the exact schedule is a fork integration test and
a randomized branch-flip oracle seed.

C1 variants:

| variant step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| T2 | k writes committed-only `b` after `flag=true` / M4 | `F(V0,k,old)` already reads `a`; before/after projected `c` are equal, so no W delivery. The after frontier remains on `a`. An implementation may also visit `V0`'s `b` edge, but exact pull cuts off. |
| T3 | k writes `flag=false` / M4 | Projection re-evaluates through `b`; even if value stays 0, retained after edges become `flag->c,b->c`. A later k write to `b` is reachable. |
| T4 | urgent U writes `b` / M2,M4 | Committed projection through U changes `c` and schedules W in U. k's U-rebased projection stays on `a` and remains 0, but U-only `baseAfter` becomes the new `b` value. Because k-after differs from base-after, M4 also invokes `runInBatch(k,W.setState)`; k cannot later commit a stale U frame. |
| T5 | urgent U writes `a` / M4,M5 | U-only writer pair remains `c=0` via `b`, but the live k frontier has `a->c`. Comparing k's future before/after U changes 0->1, and its after also differs from U-only base. M4 invokes `runInBatch(k,W.setState)` so W has k-lane work without an unnecessary U update. The next k pass includes retired U and reads 1. |
| T6 | k retirement and slot reuse / M2,M3 | Receipts get `retiredAt`; a world pair retains full token+slot generation. Slot reuse increments generation; quiescence increments episode before seq reset. Old frontier ids fail generation/episode checks. |
| T7a | pass includes T1+T2 / M3,M7 | Key contains both exact token cutoffs; its topology/cache and thenables are separate from any single-token world. It may suspend without mutating either tape. |
| T7b | T1-only pass commits / M2,M3 | Key contains T1 only, folds no T2 receipts, and becomes committed after T1 retirement. T2 remains live. |
| T7c | T2 retry / M3,M7 | New key contains retirement pin including T1 plus T2 cutoff. It neither reuses the stale combined value under a false key nor loses the lineage-stable T2 suspense cell when the exact key is unchanged. |

outcome: all seven members use exact token sets and actual per-world edges;
single- and multi-batch caches never alias on a partial key.

residual risk: an interner that trusts only hash/mask or a scheduler that omits
the T5 `runInBatch(k)` update; tuple-collision, two-batch Suspense, and urgent
rebase tests pin these paths.

### C2: `flushSync` excludes a pending default batch

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | default write / M2,M5 | `claimWrite` returns D; append `a=1` at `s1`; head is `a=1,c=11`; D remains unretired through the event stack. |
| 2 | notification / M4 | From committed `V0`, compare no-D `a=0,c=10` with D projection `a=1,c=11`; schedule D watcher work and retain real D topology. |
| 3 | `flushSync` pass / M5 | Fork emits a pass with no D inclusion. M3 captures old retire pin and empty token list. |
| 4 | atom/computed reads / M2,M3 | D receipt fails both visibility clauses. `a` folds to 0; `c` evaluates in the same sparse graph from `a=0` and caches 10, never consulting head `c=11`. |

outcome: the sync frame is `{a:0,c:10}`. Always-log preserves both the older
world and D's later world.

residual risk: a computed head-cache fallback would tear; a paired atom and
computed DOM assertion during same-event `flushSync` pins it.

### C3: skipped deferred updater rebases before later urgent updater

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | T update / M2 | Base `a=1`; append T `+1` at s1; head becomes 2. |
| 2 | U update / M2 | Append U `*2` at s2; head becomes 4. Both operations remain. |
| 3 | U render / M3 | World includes U only. Fold from 1: skip T, apply U => 2. |
| 4 | U retire / M2 | U receipt gets retire sequence r1; committed fold still skips live T and applies retired U => 2. Head remains 4. |
| 5 | T render / M2,M3 | World has retirePin r1 plus T cutoff. Fold in seq order: 1, T `+1` =>2, retired U `*2` =>4. |
| 6 | T retire / M2 | Both are retired and visible; committed value is 4; quiescent compaction sets base 4. |
| 7 | replacing set subcase / M2 | Pending T `+1`, then visible `set 5`: fold applies `+1` then replacement, ending 5 rather than 6. |

outcome: every step matches side-by-side `useReducer`; the proof is 15.2.

residual risk: compacting U to a scalar base while T is skipped changes 4 to
3; differential updater-queue arithmetic and replacing-set tests pin it.

### C4: a second batch writes an already-stale region

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | T1 writes `a` / M2,M4 | Projection changes watched `c`; W setState runs in T1 and a T1 frontier is retained. |
| 2 | T2 writes before render / M2,M4 | Walk tickets are per write, not a persistent ARMED bit. T2 projects from each live base through its own old/new tail; changed `c` is found again. |
| 3 | delivery / M4,M5 | W setState runs in T2 context. If T1's rebased view also changes, `runInBatch(T1)` marks that pending view too. |

outcome: W carries both T1 and T2 lane work despite no intervening render.

residual risk: replacing per-write tickets with once-per-staleness dedup loses
T2; a test inspects both pending lanes through protocol-visible commits.

### C5: equal branch change followed by an effective same-batch write

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | k writes `a:0->1` / M2,M4 | `c=a*0+b` compares equal. No setState, but `F(V,k,s1)` is evaluated and retained with real `a,b` edges. |
| 2 | k writes `b=7` / M4 | The retained `b->c` edge reaches W. Before frontier yields old `b`; after yields 7. |
| 3 | delivery / M4 | Equality now fails; W setState runs in k and the k pass reads 7. |

outcome: cutoff suppresses only the first broadcast, not topology or the
second notification.

residual risk: releasing equal frontiers; a render-count plus final-value test
requires zero update for step 1 and one k update for step 2.

### C6: explicit engine batch contains urgent and transition writes

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | `batch` opens / M1 | Core effect depth increments; no React notification queue is created. |
| 2 | `a.set(1)` / M2,M4,M5 | `claimWrite` returns the surrounding urgent/default token; projection and watcher setState complete synchronously in that context. |
| 3 | nested `startTransition`, `b.set(2)` / M2,M4,M5 | `claimWrite` returns deferred token T; projection and watcher setState complete before the transition scope exits, in T. |
| 4 | transition and batch close / M1 | Transition context exits; outer `batch` then flushes only core newest-head effects. No stored watcher loses its token. |
| 5 | legal `startTransition(()=>batch(...))` | Every write claims T; all watcher updates are T; core effects flush at inner batch close against newest head. |
| 6 | legal plain transition writes/helper | Unbatched writes and `startSignalTransition` both execute under the fork transition action, so `claimWrite` returns T. |

outcome: mixed context is handled, not forbidden; urgent and transition cones
receive their own lanes without a grouped drain.

residual risk: a future optimization that queues watcher delivery until batch
close would misattribute T; a protocol token assertion at each dispatcher call
pins the rule.

### C7: a handler reads and writes while a transition pass is yielded

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | k pass starts / M3,M5 | Exact k world `Vk` captured and call-stack bound; reads use `Vk`. |
| 2 | fork yields / M5 | `YIELD` pops call-stack binding but retains open-pass reference and `Vk` graph. |
| 3 | click reads / M1,M5 | Active-pass slot is empty, so `a.state` reads newest head, not `Vk`. |
| 4 | click writes / M2,M4,M5 | No render-write guard is active. `claimWrite` returns click token U. Before append, any head alias for the pass is traversed and detached; then the receipt logs under U. Projection against open `Vk` may use its render consumer and call `runInBatch(k)` to invalidate/rebase k. |
| 5 | pass resumes / M3,M5 | `RESUME` restores the original `Vk`; a detached pass now uses its sparse graph, whose immutable cutoff excludes the click receipt, so repeated reads match its earlier reads. React processes the queued invalidation before any stale commit. |

outcome: handler access is newest and legal while the old pass remains pinned.

residual risk: treating open pass as call-stack active; a scheduler-controlled
yield test runs the handler between explicit YIELD/RESUME events.

### C8: equal-to-head writes still need independent receipts

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | T sets 1 / M2 | Append T receipt; head changes 0->1. |
| 2 | U sets 1 / M2 | Append U receipt even though head equality holds; head propagation may stop, projection processing may not. |
| 3 | U render / M2,M3 | U-only world skips T and applies U set, yielding 1. |
| 4 | U/T retirement / M2 | If T closes first or is abandoned, U still retires and persists 1. If both retire, ordered sets yield 1. |
| 5 | overlapping transitions / M2,M3 | T1-only and T2-only keys each select their own equal set and show 1; a combined key applies both and shows 1. |

outcome: no world relies on an equal receipt from another batch; 15.3 supplies
the retention proof.

residual risk: applying head equality before append; tests assert two receipt
ids and independent single-token renders.

### C9: an existing and a fresh node mount in a transition world

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | k writes / M2 | Receipts append under k and the k tail advances. |
| 2 | transition pass starts / M3,M5 | Pass key captures k and its current cutoff before any component read. |
| 3 | existing computed read / M3 | Lookup uses `(world,existingNode,stage)`; miss evaluates atoms by k fold and installs actual k-world edges. It never asks whether canonical/head marks exist. |
| 4 | fresh `useComputed` / M5,M6 | `useRenderCell` returns the lineage-stable hook position; M6 stages its closure without publishing a subscription. |
| 5 | fresh first read / M3 | There is no fast-path assumption for a new node. The evaluator routes directly through the active world, folds k receipts, and publishes a sparse k-world memo/edges. |
| 6 | layout / M6 | Successful commit publishes the stage and watcher; a discarded attempt publishes neither. No corrective double render is needed when the value already matches k. |

outcome: both nodes read k on their first render; freshness is not inferred
from absent marks.

residual risk: a convenience fallback from missing sparse record to head
cache; mount-mid-transition tests cover existing, fresh, equal-valued, and
branch-divergent nodes.

### C10: a late subscription must join the already-pending batch

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | k writes with no watcher / M2 | Receipt persists and k remains live; no subscription is needed to keep it. |
| 2 | component renders elsewhere / M3,M6 | It records rendered box `x`, world `V`, and stable cell, then commits/mounts before k. |
| 3 | layout attach / M6 | Watcher attaches. Check computes `project(V,k,tail(k))`; suppose its box `y != x`. |
| 4 | entanglement / M5,M6 | `runInBatch(k,setState)` succeeds and pins k through enqueue. The correction is in k's own lanes, not a new transition token. |
| 5 | one pending commit | k's render includes the watcher, reads y from the exact k world, and one commit contains k plus correction. |
| 6 | retirement race | If k retired before step 4, `runInBatch` returns false; layout rechecks committed y and uses token 0, producing an urgent pre-paint correction. If it returned true, pinning prevents the race until enqueue. |

outcome: the normal path has exactly one k commit with both changes; the race
path does not paint a contradictory frame.

residual risk: implementing correction with `startTransition` would mint a
new token and permit k to commit alone; fork tests assert token identity and
pre-paint fallback ordering.

### C11: v1 rejects a second React root

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | root A registers / M5 | `onRoot(A,OPEN)` records A as sole root before its first pass. |
| 2 | portal from A | No root event occurs; portal renders under A's pass/world and is legal. |
| 3 | root B attempts registration / M5 | `onRoot(B,OPEN)` differs from A. Bridge throws `cosignal/react v1 supports one root; second root B registered while A is live` before B renders or subscribes. |
| 4 | sequential replacement | A may close; B may open only after bridge quiescence and episode cleanup. |

outcome: scope is explicitly v1 single-root and violation is detected, never
silently rendered with a global committed world.

residual risk: a root creation path that omits `OPEN`; fork tests exercise
legacy/concurrent roots, overlays, devtools-style roots, and portals.

### C12: store-only and async transitions persist

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | store-only transition writes 5 / M2,M5 | `claimWrite` lazily mints k; receipt logs despite zero watchers; head is 5. |
| 2 | action closes / M5 | With no React work the fork still retires k exactly once with `committed=false`. |
| 3 | retirement / M2,M6 | Receipt gets retirement sequence and committed world folds to 5. No watcher/touched-list condition is consulted. |
| 4 | async action begins / M5 | k2 writes 1, then action awaits. Fork parks k2; no retirement callback fires. Head may read 1, committed world remains 5. |
| 5 | after await / M2,M5 | Async action context restores k2; set 2 appends after set 1 under the same token. |
| 6 | settlement / M2,M5 | Only now k2 retires; committed fold applies 1 then 2 and ends 2. |

outcome: all writes persist independently of subscribers, and async writes do
not become committed before action settlement.

residual risk: losing action context after await or treating
`committed=false` as discard; fork async/no-work tests and a head-vs-committed
assertion pin both.

### C13: counter and world identity reuse after quiescence

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | episode E runs / M2,M3,M7 | Receipts, worlds, stages, frontiers, and cells carry E plus their id generations. |
| 2 | quiescence / M2 | All batches retire, passes/lineages/cells release, effects flush; tapes fold into bases and side planes clear. |
| 3 | reset / M2,M3,M5 | Increment episode to E+1 before resetting write/retire counters; fork `RESET` changes generations before serial reuse. |
| 4 | forced collision / all | New counters equal old numeric low bits. Lookups compare episode and/or id generation; world interner compares the full tuple; stale callbacks compare cell/node generation. None matches. |
| 5 | within-episode wraps | Walk stamps clear before ticket 1; slot/link generations clear their stamp columns or quarantine before collision, per section 12. |

outcome: reused numeric components cannot validate an old semantic record;
15.4 gives the base, step, and wrap construction.

residual risk: adding an unlisted counter or cache without epoch/generation;
schema-generated counter inventory and forced-small builds require one wrap
test per table row.

### C14: StrictMode and replayed renders

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | first render invocation / M3,M5,M6 | Stable render cell and lineage stage are obtained; sparse memo/topology is pass-referenced only; watcher and observed count are unchanged. |
| 2 | attempted render write / M1,M3 | Sparse-world guard throws before `claimWrite`; no receipt or head mutation exists to double-fire. |
| 3 | replay/discard / M3,M6 | Same lineage/cell reuses the stage, or discard removes the pass reference. Only committed layout publishes a watcher. |
| 4 | double mount cycle / M6 | Attach/detach/attach changes desired observed count, but one microtask sees final positive count and starts one atom resource; generation-specific cleanup cannot detach the final watcher. |
| 5 | repeated suspension / M7 | Same cell+stage+exact-world+position selects the same thenable cell; the stable lineage keeps its ref alive, so React observes stable identity until settlement. |

outcome: replay has no persistent subscription/lifecycle mutation, render
writes are rejected, and suspension identity remains stable.

residual risk: publishing stages in render or keying thenables by pass id;
StrictMode initial mount, suspended mount, discard, and resource-call-count
tests pin each edge.

### C15: transition suspension remains world-specific across a mid-mount

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | k changes async input / M2 | k receipt exists; committed world still selects old input. |
| 2 | k pass evaluates c / M3,M7 | Exact key contains retirement pin plus all included token/cutoff pairs, including k. At `ctx.use` position p, M7 stores a pending thenable under cell/stage/world/position; lineage L owns a ref and a k-world suspension box is published. |
| 3 | component mounts mid-transition / M5,M6,M7 | Stable render cell/stage reads c in the same exact world. It reaches the same world memo/cell and suspends through React `use`; no watcher is committed. |
| 4 | canonical read / M1,M3 | Committed and newest-head spaces are distinct. The canonical committed React pass excludes k and evaluates/caches old c; it does not address the k suspension box. A core outside-render head read follows its documented newest-state contract. |
| 5 | promise settles / M7 | Generation-checked cell stores result and marks the k-world memo retryable; lineage L is retried. |
| 6 | retry / M3,M7 | If receipt selection is unchanged, the full tuple interns the same world id and position finds the settled cell. If only unrelated committed receipts changed the tuple, complete dependency re-verification aliases that cell. If multiple batches are included, every token/cutoff remains in the tuple; pass id changes do not matter. |
| 7 | k commit / M6 | Retry returns settled value, layout publishes watchers, and k retires into committed state. |

outcome: the mount suspends and retries against k's stable thenable, while the
committed world never observes that suspension. Identity is exact world plus
stable cell/stage/position; lineage supplies lifetime, and neither one token
nor pass serial approximates the world.

residual risk: the fork must keep lineage stable only while the logical update
set is stable; fork lineage tests plus two-batch/rebase Suspense tests pin it.

### C16: React signal effects read committed state only

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | default D writes / M2,M4,M6 | Receipt applies to head and queues reached `useSignalEffect` id on D; D is live, so committed retire pin excludes it. Core `effect()` may synchronously read the new head. |
| 2 | unrelated K retires / M6 | Only K's effect list flushes. Any effect there evaluates with the new committed retire pin, which still excludes live D. It reads old D-dependent values. |
| 3 | D retires / M2,M6 | D receipt gets retirement sequence; committed world advances. D's queued effects verify/retrack there and run seeing the new value. |

outcome: `useSignalEffect` never sees applied-but-uncommitted D, while the
documented core effect contract is newest-head.

residual risk: flushing one global effect queue against head; a test keeps D
live while retiring an unrelated store-only token.

### C17: optimistic truncation is not exposed

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | API inspection | There is no truncate/rollback function in core, React bindings, or fork protocol; user code cannot express the schedule. |
| 2 | nearby supported abort / M2,M5 | React may abandon a render, but the associated token retires once with `committed=false`; all receipts become committed together at one retirement sequence. |
| 3 | readers / M3 | Worlds captured before retirement keep their old retirement pin; worlds captured afterward include the entire token. No world selects a partially removed batch. |

outcome: the optional case is resolved by deleting the policy surface; React
abandonment persists the atomic batch rather than truncating it.

residual risk: adding developer rollback without a new design; API snapshot
tests reject an accidental export.

## 17. Open-question resolutions

| question | resolution in this architecture |
| --- | --- |
| O1 per-world dependencies | They live in the separate sparse world arena as actual edges keyed by exact immutable receipt selection. No world bits enter primary links. |
| O2 host callback tax | No host callback is on a recompute. Canonical and sparse evaluators are schema-generated/fused against their own closure-constant planes. The queued host-tax spike does not decide this design. |
| O3 shadow sync | There is no mutable shadow of canonical topology. Each sparse record tracks its own evaluation, so no sync site list exists. |
| O4 React-owned atom queues | Rejected: shared atoms are many-consumer, core reads still need a fold, and exposing queue processing would make reconciler rebase work dominate. The receipt ledger gives the same selected values behind a narrow protocol. |
| O5 yield/resume | Edge callbacks update an integer call-stack binding. Reads pay one local slot check; they do not call into React. |
| O6 grouped delivery | Watcher delivery is synchronous per write. `runInBatch` is used only for an affected already-pending projection and late join, not to recover a lost drain context. |
| O7 per-root committed views | v1 rejects a second root at registration, so one committed retirement frontier exists. |
| O8 Suspense world key | Exact verified world tuple plus stable render-cell/stage/position; stable lineage/frontier refs retain the cell but do not alter identity. |
| O9 held-transition reads | The exact immutable world memo is a cache hit; a new tuple verifies the predecessor's complete dependency list and aliases it when equal. No write clock is needed because a descriptor never widens its cutoff. |
| O10 coalescing | Not included. Every write remains a receipt and notification opportunity; arbitrary updater/action composition and open passes make a safe general coalescer not worth a mechanism slot. |

## 18. Verification and delivery sequence

The process apparatus is used as given, in this order:

1. Build the randomized receipt-fold oracle and a side-by-side `useReducer`
   oracle before implementing the ledger. Generate sets, non-commutative
   updaters, actions, retirements, include sets, yields, and restarts.
2. Freeze the canonical arena contract: 179/179 conformance with
   `testPullCounts:true`, forced growth, dynamic dependencies, reentrancy,
   equality, errors, and exact effect order in DIRECT mode.
3. Implement protocol event recording in the fork and make all 14 fork tests
   in 8.6 pass with no signal implementation attached.
4. Implement receipts and exact atom folds; differential-test every generated
   world against the oracle before adding sparse computed records.
5. Add sparse graphs and projection frontiers. Run C1 variants after every
   change, plus randomized conditional dependency trees comparing brute-force
   all-watcher evaluation with reached/equality-filtered watchers.
6. Add hooks, layout join, StrictMode, and committed effects. Run the full
   14-scenario `react-concurrent-store` harness plus explicit C9 and C15 tests
   that turn its documented mount/suspend bug into a required pass.
7. Add suspense cells, forced counter horizons, SSR/hydration, tracing, and
   invariant sweepers.
8. Run one-framework-per-process performance and allocation gates. SP-R1 and
   SP-R2 must complete before claiming P1/P3/P4.

Schema/codegen is the single source for record offsets, branded ids, debug
hydrators, counter inventory, invariant sweeps, and bytecode budget tables.
Regenerate-and-diff CI rejects hand drift. Production builds use `__DEV__` as
a compile-time define. Public TypeScript uses `type`, uses `undefined` for
absence, and uses no `null` value; the fork listener's internal no-listener
sentinel may remain React's existing `null` convention and never crosses the
package boundary.

Required library/integration suites are:

- all C1--C17 traces, including every named C1 variant and both C6 legal
  compositions;
- 179 core cases with exact pull counts in DIRECT and inside a synthetic
  receipt episode whose worlds all select the same values;
- generated useReducer arithmetic and replacing-set parity at every render
  and retirement;
- react-concurrent-store's scenarios plus mount-mid-suspense, fresh hook node,
  late join, yielded-handler, and default-excluded-by-flushSync cases;
- StrictMode resource call counts and stable positional thenables;
- one-root rejection across accidental overlay/devtools root creation;
- every forced-wrap row in section 12;
- zero-allocation steady render/write sampling, heap plus plane-byte reports,
  bundled bytecode budgets, V8/JSC rankings, and one-framework processes; and
- tracing-off bytecode/branch checks plus ring loss and lossless causality.

## 19. Known gaps and declared risks

No acceptance-battery case is unwalked. C11 is satisfied at the explicitly
allowed v1 single-root scope, and C17 is satisfied by omitting truncation.

Two performance facts remain unmeasured: first sparse-world fold/cache costs
(SP-R1) and projection-frontier fan-out over multiple live graphs (SP-R2).
Their proposed numeric gates are in section 14. Either spike can reject this
architecture; the spec does not report those targets as achieved. The fork
file/line budget is likewise an implementation exit target until the patch
exists and is counted.

The longest-lived transition retains every later non-commutative updater that
may need rebasing. This memory is semantic history, not a leak, and is reported
as plane bytes. A future coalescer would require a separate proof for sets,
updates, reducers, open pass cutoffs, and thenable worlds; it is not silently
assumed here.

## 20. Compact compliance ledger

| requirement | mechanism/section |
| --- | --- |
| R1 atoms and observed resources | M1,M6; 9.3, 11.1 |
| R2 computed, previous, errors, suspense | M1,M3,M7; 6.2, 10, 11.2 |
| R3 reducer parity | M2; 5.2, C3 |
| R4 provider-free hooks | M5,M6; 9.1 |
| R5 transition parity/helpers | M2,M4,M5; 11.3, C1--C8 |
| R6 Suspense and fresh mid-mount | M3,M6,M7; C9,C15 |
| R7 loop rejection | M1; 4.3 |
| R8 computed writes | M1,M3; 4.3 |
| R9 multiple roots | M5; 8.2, C11 single-root rejection |
| R10 SSR/hydration | 11.4 |
| R11 tracing | 13 |
| R12 fork | M5; fork-protocol section 8 |
| R13 core and benchmark integration | M1; 4.3, 11.3, 14 |
| P1--P4 | 4, 6, 14; SP-R1/SP-R2 declared |
| Engineering rules | 4.1, 12, 18 |

Final inventory: **7 mechanisms**. Final seam: **8 protocol touch-points**.
Unwalked acceptance cases: **none**.
