# Round 4 design — exact-world consolidation

Status: complete consolidation candidate. Stance: `consolidate-b`, inheriting
the round-3 two-kernel champion. This design adds no mechanism. It replaces
several narrow fast-path repairs with one coarser invariant, unifies three
parallel validity records, and deletes the saturation state machine.

## One-page summary

The single-world engine is the measured donor arena, called **K0**. The
non-React entry point is a DIRECT build whose emitted hot paths are the donor
hot paths: no receipt checks, fork calls, or world branches. Importing the
React binding activates the LOGGED build monotonically. Every later write,
urgent or deferred, appends a receipt before it updates K0. Receipts are
replayed in write order, filtered by a render pass's token set, sequence pin,
and immutable per-root committed-prefix view. This is React's update-queue
arithmetic expressed for a many-consumer store.

The consolidation rule is deliberately coarse: **if any unswept receipt
exists anywhere, every render-phase signal read uses its exact pinned world**.
The same is true after that pass stages a hook evaluator. Only a render pass
with no receipt history and no staged evaluator may read K0 directly. Core
reads outside React still read K0's newest state. This rule deletes the
`WORLD_TAINT` bit, its missing tracked-serve propagation, per-node staged
probes, `RENDER_NEWEST` and its demotions, and the saturation spill flag. A
receipt cannot disappear while an older pass needs it: retirement may release
the receipt's 5-bit slot, but compaction of the receipt itself waits until all
live pins include its retirement. Therefore the coarse gate remains closed
for every pass that could otherwise see a cache from the wrong world.

World evaluations record real dependency edges in a second, add-only arena,
**K1**. K0 remains unchanged. Every write performs a value-blind reach walk
over K0 union K1 and calls each reached watcher's `setState` synchronously in
the writer's batch context. A per-walk generation terminates union cycles;
full walks execute no user code and edge-add deliveries use the already
required deferred-delivery drain, so walks never nest and one `lastWalk`
column is sufficient. K1 also preserves K0 edges removed while receipt
history exists. At quiescence, observed K1 nodes refresh into K0 and K1 resets;
a twice-writing refresh target carries its full reverse-reachable K1 cone.

World memos and positional Suspense capsules share one canonical **basis**:
the world header, included-slot write clocks, atom fingerprint plus value
entries, computed stage-id plus value entries, and thenable settlement
entries. There is no separate evaluator-stamp vector, suspense prefix, or
lock-term fingerprint. On a moved fact, the consumer re-folds or re-evaluates
the referenced value; equality keeps the old reference and restamps the same
basis. A resource factory runs again only when a basis value really changes
or the evaluator containing that factory changes.
Hook stage identity and F9 publication identity are the same immutable
`stageId`, stable for equal deps within one render lineage and never shared by
an unpublished stage across lineages.

Each root holds an immutable **lock view** of token prefixes already committed
on that root. Every lock-in or watermark advance re-mints the view and its
`lockViewId`; that id is the sole lock visibility version. Per-slot
`lockStamp` and per-atom `lockTerm` are deleted. World keys observe the view
id, Suspense bases value-revalidate when it moves, and affected committed
effects are forced through the slot's durable touched list. Before a root
publishes a new view, the fork ends every other resumable pass on that root;
a retry captures the new immutable view. Other roots retain their own views.

Mount fixup has two independent, simple duties. For each still-live reached
token, it skips a lane correction only when that token and all its writes up
to the render pin were included; otherwise it schedules `setState` into that
token with `runInBatch`. It then **always** compares the rendered value with
the current committed-for-this-root value and issues an urgent pre-paint
correction if they differ. There is no vacuous “all live tokens were skipped”
guard. A mount from a token's own committed pass compares equal because root
lock-in precedes layout effects; a token retiring in the render-to-subscribe
window is absent from the first loop but is caught by the comparison.

Async actions retain the existing split: fork parking controls lifetime and
the continuation carrier controls attribution. The carrier uses AsyncContext
when available, otherwise the measured twin-build transform plus armed-only
wrappers for the enumerated host registrars. Every wrapper invokes the same
live-token bracket; nested registration composes, and a token that retires
before invocation degrades to ambient classification with a development
warning. `ActionScope.set/dispatch` is the explicit opaque-boundary escape
hatch. No `ActionScope.runSync` surface remains.

The concurrency mechanism inventory falls from ten to six. The price is
intentional: one pending or pin-retained receipt routes unrelated render reads
through world memos. That cost is unmeasured and must pass the existing
restart/typeahead and React-parity gates; this round does not add a fallback.
DIRECT performance, the K0 layout, receipt semantics, K1 delivery, and the
fork seam remain the champion's architecture.

## 1. Scope and user contract

### 1.1 Public core API

- `Atom<T>({state, effect?, isEqual?, label?})` exposes tracked `state`,
  `set`, and `update`. Its optional observed-lifecycle effect runs after a
  microtask-stable 0-to-1 observer transition and cleans up after a
  microtask-stable 1-to-0 transition.
- `Computed<T>({fn(ctx), isEqual?, label?})` is lazy and cached. `ctx.use`
  accepts a thenable or a lazy factory; the lazy form is required for
  side-effectful acquisition. `ctx.previous` follows section 6.5.
- `ReducerAtom<S,A>` logs actions and replays them with the effective reducer
  of the evaluated world. Constructor reducers are immutable. A hook-owned
  reducer may stage a new reducer under the rules in section 8.
- `effect`, `batch`, `untracked`, and `configure` form the non-React API.
  `batch` delays core-effect flushing only; it never delays watcher delivery.
  Synchronous effect flushing is a documented configuration for benchmark
  adapters.
- Writes inside ordinary computeds are accepted when the graph remains
  acyclic. `configure({forbidWritesInComputeds:true})` rejects them. Every
  render-world evaluation rejects writes. Signal access from an updater or a
  replayed reducer callback throws in all builds.
- React-coupled update storms use React's own render/update-depth limits
  because delivery is a real `setState`. Signal-only evaluation/write cycles
  use the engine's generation-checked cycle and flush-depth limits.

Errors and suspensions are reference-stable sentinel values until the getter
boundary rethrows them. Graph tracking always closes in `finally`, so a throw
cannot leave half-installed edges.

### 1.2 React API

`cosignal/react` exports `useSignal`, `useAtom`, `useReducerAtom`,
`useComputed(fn,deps,opts?)`, and `useSignalEffect(fn,deps?)`. Hook computeds
close over props/state and auto-track signal reads. It also exports
`startSignalTransition(fn(scope))`; `scope` has only `set` and `dispatch`.
Ordinary `startTransition` and `useTransition` require no provider. Importing
the binding feature-detects fork protocol v4 and fails loudly on stock or
version-skewed React.

`useSignalEffect` reads only committed-for-root state. Its function/deps
identity is owned by React's native effect re-fire; it does not use staged
evaluator publication. Core `effect()` instead observes K0 NEWEST and may run
before React commits.

### 1.3 Multi-root scope

Full spanning batches are supported. Roots may commit at different times, but
each root's later renders and effects include every prefix already committed
on that root. A token retires globally exactly once after its React work and
parked action have closed.

A hook-stageable signal node has one owning hook/root, already identified by
its F9 publication record. Subscribing that node from another root throws at
subscription time. This detectable restriction avoids inventing per-root
evaluator publication: share ordinary atoms, computeds, and constructor
ReducerAtoms across roots; create a separate `useComputed` or
`useReducerAtom` per root. Portals remain in their parent root and are legal.

### 1.4 SSR and hydration

SSR runs DIRECT and serializes atom ids, generations, and values. Hydration
restores K0 before the React bridge activates LOGGED. No receipt exists at the
switch, so every restored cache has the restored committed basis. RSC/Flight
is outside v1.

## 2. Mechanism inventory — six

1. **K0 and twin builds.** The closed donor arena is the only DIRECT engine;
   the LOGGED build adds policy at operation boundaries while retaining its
   packed hot layout.
2. **Receipt ledger and exact worlds.** Per-atom tapes, one sequence line,
   stable batch tokens, generation-checked live slots, pass pins, immutable
   per-root lock views, replay folds, retirement, and pin-gated compaction are
   one value-history mechanism.
3. **K1 reach plane.** Real world edges, E-PRESERVE, per-slot reach masks and
   durable touched lists, edge-add carry/delivery, quiescent refresh, and cone
   carry form one reach mechanism beside K0.
4. **World evaluation basis.** The coarse receipt/stage gate, pinned world
   memos, one flattened basis representation, positional lineage capsules,
   and equality revalidation form one cache mechanism.
5. **Value-blind delivery and bindings.** Non-reentrant union walks,
   `walkGen`, watcher/slot render-cycle dedup, synchronous `setState`, mount
   fixup, reconcile checks, and committed-effect drains form one delivery
   mechanism.
6. **Versioned fork/build seam.** Protocol facts F1-F9, stage/publication
   records, action parking, the continuation transform, registrar wrappers,
   retired-token fallback, and `ActionScope.set/dispatch` form one boundary
   mechanism.

Tracing, schema generation, tests, allocators, epochs, and numeric gates are
process/substrate, not additional concurrency mechanisms.

### 2.1 Consolidation ledger

Deleted outright:

- `WORLD_TAINT` and every set/clear/propagate rule;
- per-node staged-evaluator routing probes;
- `RENDER_NEWEST`, write/stage demotion, and its pass state;
- `fastPathDisabled(pass)`, `lastRetireSeq`, retained retired slots, and the
  saturation force-clear policy;
- per-(root,slot) `lockStamp` and per-atom `lockTerm` scans;
- separate evaluator-stamp vectors and separate Suspense content prefixes;
- a second fn stamp distinct from F9 publication id;
- `ActionScope.runSync`.

Unified:

- world-memo validity, evaluator identity, lock-view identity, and Suspense
  content validity consume the same basis;
- a stage record's `stageId` is also its F9 publication id;
- every registrar wrapper and transformed continuation uses the same
  live-token carrier bracket.

### 2.2 Settled obligations under the simpler invariant

The design preserves D1-D18's product semantics. Three prior implementation
invariants change representation rather than being ignored:

- I33's world-leak obligation remains, but its taint implementation is
  deleted. The receipt-count/pin-retention induction in sections 4.5 and 6.1
  covers direct untracked reads and every tracked parent uniformly.
- I34 still has one root-scoped version minted at every lock-in/advance and a
  durable flush. The immutable view's existing id is that version; a second
  per-slot stamp and `lockTerm` are redundant.
- I10/I39 required retired-slot retention or a spill flag because cleared
  reach bits could authorize K0. Reach bits no longer authorize render reads.
  Old tape entries keep `(slot,slotGen)` and `receiptCount` keeps exact-world
  routing closed, so the same forced schedules permit immediate generated-
  slot release. A recycled generation cannot match an old pass.

Always-log, replay order, K0 closure, clocks, value-blind delivery, lineage
identity, F9 publication, reducer semantics, and the async support boundary
are unchanged.

## 3. Packed substrate

K0 starts from the measured arena donor: one interleaved `Int32Array` plane
for node/link records, packed `unknown[]` value/fn side columns, iterative
walks, persistent scratch stacks, and split `link`/`linkInsert` fast paths.
Buffers remain closure constants; growth rebuilds closures only at operation
boundaries. Same-file non-exported `const enum` values provide offsets. K1 is
a separate warm-reused arena so no world bit or branch enters K0 traversal.

World memos, bases, receipts, basis entries, watcher records, and lock views
use bump/free-list side planes with generation-checked ids. Collections are
built directly with loops and mutation. No steady render constructs a JS
array, `Map`, `Set`, closure, or iterator. Custom equality and sentinel policy
live in wrappers; K0 compares stable references.

Implementation uses TypeScript `type` declarations, branded integer ids, and
`undefined` for absence. No runtime `null` sentinel is needed. Development
branches use the build-time `__DEV__` define, never a runtime constant.

The measured donor ratios versus alien-signals v3 are deep 0.90, broad
0.84-0.88, diamond 0.89, reads 0.74-0.87, and create 0.96. Those are inherited
targets, not re-measured claims. [ARENA][SYNTH §18.2] Full-arena
storage, interleaving, closure
constants, and bytecode budgets are retained because the seed measurements
show their alternatives lose materially.

## 4. Receipt ledger and world arithmetic

### 4.1 Identities and records

A **token** is a stable integer batch identity with a deferred bit. It is
never reused while live. A live token occupies one of at most 31 slots and
has a `slotGen`; masks are always interpreted with the captured generation.
Retired tape entries retain `{slot,slotGen}` even after the slot is recycled.

`globalSeq` is one monotone integer line. Writes, retirements, lock-view ids,
and stage ids mint from it. A pass captures `pin=globalSeq` at start. Each atom
has a base and a tape of:

```
{ seq, slot, slotGen, op, retiredSeq }
```

`op` is `set(value)`, updater, or reducer action. The tape is in `seq` order.
`retiredSeq=0` means live. `receiptCount` counts unswept entries globally; it
is the already required “any live history” fact used by E-PRESERVE and episode
quiescence. It falls only when entries leave tapes, never when their slot
retires. `wc[slot,slotGen]` is the global sequence of that generated token's
latest write, so it is directly comparable with a pass pin.

### 4.2 Write path

In LOGGED, a write executes in this order:

1. F1 returns or lazily mints the writer's token and live slot.
2. Mint `seq`, append the receipt, increment `receiptCount`, and set the slot
   write clock `wc[slot,slotGen]=seq`.
3. Apply the op to K0 NEWEST with stepwise equality. On equal, retain the old
   reference.
4. Run the K0 union K1 reach/delivery walk in the writer's context.
5. Flush core effects only if the outer engine `batch` closes.

The append precedes the K0 mutation. Thus no callback can observe a changed K0
while `receiptCount==0`.

An equal write may be dropped only when that atom's tape is empty and the op's
meaning is world-invariant: plain `set`, an updater on an ordinary Atom, or an
action under an immutable constructor reducer. A hook-stageable ReducerAtom
always appends. With nonempty history every op appends, including an equal
`set`.

### 4.3 Visibility and fold

A render world is:

```
{ rootId, included[(slot,slotGen)], pin, lockView, episode, passStages }
```

Receipt `e` is visible exactly when at least one clause holds:

1. `e.retiredSeq != 0 && e.retiredSeq <= world.pin`;
2. `(e.slot,e.slotGen)` is included and `e.seq <= world.pin`;
3. the captured lock view contains `(e.slot,e.slotGen,watermark)` and
   `e.seq <= min(world.pin, watermark)`.

Fold starts at the atom base and visits receipts in increasing `seq`, applying
only visible ops. Equality is applied after every op and retains the old
reference when equal. Updater/reducer callbacks run under a guard that rejects
all signal reads and writes.

**Replay invariant.** Base case: before any receipt, fold equals the base and
React's queue has the same base. Inductive step: for the next receipt, both
models either skip it because its batch is excluded or apply the same op to
the same accumulator; stepwise equality preserves the same representative.
Retirement changes visibility, not order. Therefore every prefix has the same
value as React's lane-filtered updater queue.

### 4.4 Immutable root lock views

Each root points to an immutable sorted vector of
`{slot,slotGen,watermark}` and an id minted from `globalSeq`. A root commit
raises each included token's watermark to the committing pass pin and swaps a
new pooled view if any entry changed. Dropping a retired token also re-mints.
The committing pass is the only same-root pass allowed to survive that swap;
F2 ends/discards other resumable passes first. Old vectors remain until their
last captured reference drops.

`lockViewId` is the only lock visibility version. It is in world keys and the
common basis header. A lock change forces committed effects reached through
the changed slot's durable touched list. No atom fingerprint scans a view.

### 4.5 Retirement, slot release, and compaction

Retirement occurs once per token, whether or not React committed work.
`committed=false` does not discard writes. In order:

1. Mint one retirement sequence and write it to every receipt of the token.
   Mint `retireVisStamp` on each touched atom.
2. Publish any root lock-view removals only after those stamps exist.
3. Force committed-effect/reconcile drains by enumerating the token's durable
   touched list; the write-time queue is only an optimization.
4. Clear this slot's reach bits and watcher dedup through that same list, then
   release the slot and increment `slotGen`.
5. Compact only the all-retired tape prefix whose every `retiredSeq` is at or
   below the minimum live pass pin. Decrement `receiptCount` for removed
   entries and preserve replay order in the base.

Retired entries can therefore outlive their slot, but generation checks keep
old masks distinct from a recycled occupant. Since only live tokens own
slots, the 31-live-token premise is the complete capacity bound; there is no
saturation state.

**Pin-retention invariant.** Base: a new pass pins before later retirements.
Step: an entry whose retirement is later than that pin fails the compaction
predicate, so `receiptCount>0` and the entry remains foldable. Only after the
last excluding pin ends may compaction remove it, at which point no pass can
ask for the older world. This is the construction that permits immediate
slot release without a spill flag.

## 5. K1 reach and delivery

K1 records the real dependency edges discovered by exact-world evaluations.
It is a union across worlds and may contain cycles even though every single
world evaluation is cycle-free. Edges are add-only within an episode.

For a write in slot `s`, a full walk over K0 union K1:

- stamps each visited record with the current `walkGen`;
- ORs `(s,slotGen)` into each node's reach mask and appends the node once to
  `touchedList[s,slotGen]`;
- calls each reached watcher at most once for `(watcher,s,slotGen,renderCycle)`;
- follows every outgoing edge regardless of dirty/equality state.

The watcher call is `setState` in the writer's stack. Marks never stop the
walk. A watcher re-arms its slot bit when it renders, so a later write after a
completed render can deliver again.

When a K1 edge is added, existing reach bits propagate through existing
out-edges to a fixed point. For every newly carried still-live token, watcher
delivery runs in `runInBatch(token)`. Edge additions discovered in a render
slice drain at yield/end. Edge additions discovered while a full walk has
`walkDepth=1` join that same drain and run after the walk. Core effects flush
after it. Full walks contain no reducer, equality, computed, effect, or other
user callback; React's state enqueue does not synchronously render. Hence
`walkDepth` never exceeds one.

**Walk termination.** Base: the start record is stamped with generation G.
Step: an unstamped record is stamped once before its finite outgoing edges are
pushed; a stamped record pushes nothing. With no nested full walk, no other G
can overwrite a stamp until completion. The finite union graph is therefore
visited at most once per record, including when it contains a cycle.

**E-PRESERVE.** While `receiptCount>0`, every edge removed by a K0 retrack is
copied to K1 with endpoint generations. This is not slot-scoped. If no receipt
exists, a removed branch cannot matter to another world; a later receipt on
the branch selector creates history before K0 mutates and its evaluation
records the needed world path.

At true quiescence—`receiptCount==0`, no live pass, no unpublished stage, and
no active delivery—refresh every K1-touched node with a committed watcher or
effect snapshot through K0 NEWEST, then reset K1 and bump the episode. A
target that writes during refresh retries once. On a second failure it is
exempt and its full reverse-reachable K1 cone is carried to the next episode.
For a fixed observed set, the rank
`sum(2 - failures[target])` decreases on every failed refresh, so the sweep
terminates in at most `2N+1` attempts; ordinary signal-loop limits cover an
unbounded stream of newly observed targets.

## 6. Exact-world evaluation and the common basis

### 6.1 The only render read gate

Every active render slice has a pass frame supplied by F2. A signal read in
that slice executes:

```
if receiptCount == 0 && passStages is empty:
  return K0.read(node)
return readInWorld(node, pass.world)
```

There is no node-local reach, taint, cleanliness, newest, or spillover
conjunct. During a yield the pass frame is absent, so handlers and core effects
read K0 NEWEST.

**World-isolation invariant.** Base: with no receipts and no stages, every
world equals K0. Step for a write: the append makes `receiptCount>0` before K0
changes, so all subsequent render reads fold. Step for retirement: an
excluding live pin retains the receipt and count; without such a pin the
retired value is committed for every possible pass. Step for a stage: the
pass table becomes nonempty before the staged evaluator is read. Step for
discard/promotion: the stage table dies or becomes committed, and F2 prevents
a same-root stale pass from resuming across publication. Thus a K0 render
serve occurs only when its world and evaluator basis are identical.

This proof covers tracked parents of untracked children without propagation:
when an untracked K0 read could embed a receipted value, `receiptCount>0`, so
neither that child nor any tracked parent can be served from K0 to a render.

### 6.2 World memos

Atoms fold directly. A computed is memoized by `(nodeGen, worldKey)`, where
the key contains episode, root, included slot generations, pin, and
`lockViewId`. A pass pins the exact memo record it uses; another pass may
create another record but never overwrite it. `EVALUATING` in the same world
throws a cycle. Evaluation rejects writes, tracks ordinary reads into K1, and
folds untracked reads in the same world without adding an edge or a basis
dependency.

Fresh nodes take this path whenever history or stages exist, so their first
evaluation cannot leak K0.

### 6.3 One canonical basis

A basis is a flat packed sequence built directly during evaluation:

- header: episode, world identity, `lockViewId`;
- one `(slot,slotGen,wc)` for each included/locked live slot;
- tracked atom `(atomId,nodeGen,fingerprint,valueRef)` entries;
- computed `(nodeId,nodeGen,effectiveStageId,valueRef)` entries for completed
  nested reads, flattened through those reads;
- the resource-owning computed's effective stage id in the header;
- thenable `(capsuleGen,settlementVersion)` entries.

`fingerprint` is the atom's newest world-visible receipt seq, base seq,
reducer stage id, and `retireVisStamp`. Lock visibility is represented once by
the header, not per atom.

Validation first compares generations, episode, world identity, stage ids,
and slot clocks. If every cheap fact matches, it serves. On a moved atom fact,
it folds that atom in the candidate world and applies the atom's equality; on
equal it retains `valueRef` and restamps. On a moved nested-computed stage id,
it evaluates that completed child under the effective stage and compares its
stable output reference; on equal it restamps. A changed value invalidates the
consumer. The resource-owning evaluator has no completed output at its
`ctx.use` position, so its stage-id change invalidates the capsule directly:
the factory code itself may have changed. Settlement changes invalidate the
throwing/suspending sentinel.

This single representation is consumed by world memos, `ctx.previous`
records, effect snapshots, and Suspense capsules. Consumers may stop at the
first changed value, but they do not maintain translated copies.

### 6.4 Suspense capsules

The fork supplies a render lineage id stable across retries/replays for one
root and logical batch set. `ctx.use(factory)` owns a capsule at
`(nodeGen,lineageId,position)`. The capsule stores its settled/pending thenable
and the common basis prefix at that position.

On retry, equal basis values reuse the identical thenable. A moved header,
clock, fingerprint, or nested stage id runs the value revalidation above.
Equal values restamp the capsule in place; a changed value or owning-stage id
generation-drops this position and later positions, then calls the factory
again. The eager `ctx.use(thenable)` form can guarantee identity only when the
caller supplies the same thenable.

For a pass containing several batches, identity is lineage, while content is
the full world basis. A token alone, a mask alone, and a pass serial are never
keys.

### 6.5 Previous values

K0 NEWEST uses the donor's previous value. A world evaluation uses the prior
value of the exact pinned memo record. A fresh world record uses a K0 value
only when the render gate would allow K0; otherwise `ctx.previous` is
`undefined`. Errors and suspension boxes count as values for this rule.

## 7. Delivery, subscriptions, and effects

### 7.1 Watchers

A watcher is a mounted component record containing its root, node, last
rendered value, render world, render pin, and a 31-bit delivery mask paired
with slot generations. Delivery synchronously increments a private React
state cell. Calling it in the writer's execution context gives the update the
writer's priority and token. No implicit notification batch exists.

Delivery is value-blind. Equality still cuts off K0 and world recomputation,
but it does not decide whether already-finished React work is safe. The
per-(watcher,slot,render-cycle) bit only deduplicates work already scheduled in
that same token; rendering clears that token's bit.

At fold/reconcile time, the binding compares the watcher's last rendered
value against the value in the committing root world. An equal value retains
the reference and needs no new React update. This reconcile comparison never
suppresses the original write-time delivery.

### 7.2 Mount and subscribe fixup

The layout-phase subscription records the rendered value/world first, then:

```
for each live written token t whose generated slot is in reachMask(node):
  if renderWorld includes t && wc[t] <= renderPin:
    continue
  if runInBatch(t, () => setState(watcher)) == RETIRED:
    setState(watcher) // urgent pre-paint fallback

now = evaluate(node, committedForRoot(root))
if !node.isEqual(now, renderedValue):
  setState(watcher)   // urgent pre-paint correction
```

The skip applies only to the token-lane correction. The committed comparison
is unconditional. Layout cannot run for an uncommitted mount; F3 installs the
root lock view before layout, so a mount from its own committing pass compares
against a world containing the prefix it rendered. A token that retired
before the loop is caught by the comparison. A token retiring between the
test and `runInBatch` returns `RETIRED` and takes the fallback.

### 7.3 Late edges and reconcile backstop

A K1 edge created after a write carries every still-live reach bit and queues
the corresponding `runInBatch` deliveries before that render pass can commit.
The fork also invokes a pre-mutation reconcile check for a root: every watcher
rendered by the candidate commit is compared to the pass world it claims. A
late update inserted after completed work makes React restart that work; it is
not allowed to commit and repair a torn frame later.

### 7.4 Effects and observed lifecycle

`useSignalEffect` records a common basis snapshot of its committed-for-root
reads. It is considered for re-run at:

- a root commit containing a reached token;
- every lock-view lock-in or watermark advance, by the changed token's
  durable touched list;
- token retirement, by the retiring token's durable touched list;
- thenable settlement.

Lock-view drains force basis revalidation even though no per-atom lock stamp
exists. Cleanup runs before the next committed invocation. A deps change uses
React's own effect cleanup/re-fire and retracks from scratch.

Core `effect()` uses K0 NEWEST, is queued by the ordinary graph, and flushes at
the configured engine batch boundary. Atom observed-lifecycle counts include
watchers and effects; microtask damping makes StrictMode mount/unmount flaps
net to one start and one eventual cleanup.

## 8. Hook evaluator identity and F9 publication

### 8.1 Immutable evaluator records

Each hook-stageable node has an immutable committed evaluator record
`{fn,depsValues,stageId,ownerRoot,ownerHookGen}`. A pass invocation selects in
this order:

1. if incoming deps equal the committed record, use that record;
2. else if they equal this lineage's current record for the hook, reuse it;
3. else create a record whose `stageId=++globalSeq` and replace the lineage's
   current pointer, retaining the old record while any pass/capsule holds it.

Equal deps use the record's old function, matching `useMemo`. `stageId` is
also the opaque F9 publication id; there is no second fn stamp. A pass that
selects a noncommitted record puts it in `passStages` before any read of the
node, forcing all later render reads through exact-world evaluation.

If deps oscillate A-to-B-to-A within one lineage, committed A is reused when
available. An uncommitted A that was displaced may receive a new id; that is a
real evaluator transition, but the common basis retains a resource when its
re-evaluated output is equal. An unpublished record is never reused by another
lineage. Once F9 promotes it, it is the committed record and all later
lineages may select it.

### 8.2 Publication

Render attaches the stage id plus `(nodeGen,ownerRoot,hookSlot,workGen)` to
the exact WIP hook. F9 emits only records whose hooks become current. Hidden
Offscreen hooks count as current; error-abandoned children and stale
alternates do not. A generation CAS rejects an obsolete publication.

For one commit the order is:

1. publish winning evaluator/reducer records;
2. dirty each published K0 node and run its value-blind delivery walk in the
   committing batch context;
3. for a promoted ReducerAtom with pending receipts, replay those receipts
   from its committed base under the new reducer and install the equality-
   stable K0 NEWEST result;
4. install the root's new lock view;
5. perform retirements/folds due at this commit;
6. run reconcile checks, then user layout effects.

The publication walk is required even when the current value compares equal:
the new evaluator can change a downstream result on its next inputs. Reducer
re-fold precedes the walk's reconcile read.

`publicationsComplete(passId)` releases that pass's hook attachments. Pass
discard releases pass refs but not the lineage cache: retries in the same
lineage must retain its current immutable record. F5 lineage death releases
unpublished lineage records and capsules; published records are committed
ownership.

### 8.3 Reducer rules

Constructor ReducerAtoms have immutable reducers and use ordinary receipt
drop rules. Hook ReducerAtoms always append actions. A pass folds with its
selected reducer record; committed/core NEWEST uses the committed record.
Promotion reinterprets pending actions, never actions already compacted into
the committed base. Publication precedes same-commit retirement, so both use
the reducer that produced the committed tree.

The single-owner-root check in section 1.3 is performed when a watcher first
subscribes. It is unnecessary for immutable constructor reducers and ordinary
computeds.

## 9. Async actions and carrier boundaries

Parking and attribution are separate. F3 keeps an action token live until the
thenable returned from the transition action settles. The carrier tells F1
which live token owns a post-await write.

Carrier ladder:

1. native AsyncContext, when the host provides the required semantics;
2. the measured twin-build transform [I30/SP-F8]: compiled async bodies dispatch through
   a token-carrying generator only while an action is armed;
3. Node AsyncLocalStorage by explicit server opt-in only;
4. otherwise registration fails its loud asynchronous boot probe.

At rung 2, wrappers are installed on the 0-to-1 armed-action transition and
removed on 1-to-0 if they still own the host property. They cover callback
registration for `setTimeout`, `setInterval`, `queueMicrotask`,
`requestAnimationFrame`, `requestIdleCallback`, and same-realm
`MessagePort.addEventListener('message', cb)`/`onmessage` assignment. Each
captures the current token at registration and invokes through:

```
if token is still live-and-parked: push token; call; finally restore
else: call under ambient context; dev-warn once for this registration
```

An async callback invoked inside the bracket instantiates its transformed
body while the token is current. A nested registration captures the same
token. Every interval tick repeats the liveness test. A pre-existing
MessagePort listener triggered by `postMessage` inside an action is not a
registration inside the action and belongs to the documented opaque-boundary
class; use `scope.set/dispatch` in that listener. Cross-realm ports cannot
carry tokens.

If a transformed continuation itself resumes after settlement, its push uses
the same liveness check and falls back to ambient classification. It never
re-interns a retired token or extends parking for an un-awaited child.

`ActionScope.set(atom,value)` and `ActionScope.dispatch(atom,action)` supply
the captured token explicitly after checking realm, generation, and
liveness. Calls after settlement throw “ActionScope closed.” Raw post-await
writes in untransformed code are attributed to their ambient batch, are never
lost, and warn while another action is armed. The support matrix says to
transform that code, use ActionScope, or use an AsyncContext host.

## 10. Fork protocol v4

The boundary carries only opaque integer ids, generated token tuples, and
callbacks. No Fiber, lane mask, or React update-queue object crosses it.
There are nine facts and **16 seam touch points**.

### 10.1 Facts

**F1 — write context.** `currentBatch()` returns `{token,deferred,realm}` or
ambient. It lazily claims a token for store-only work. A carried token is
returned only while live-and-parked.

**F2 — render pass lifecycle.** Start supplies
`{passId,rootId,includedTokens,lineageId}` and the binding captures
`pin=globalSeq` in the resulting frame. Yield removes the render frame; resume
restores it; end declares complete or discarded. Before F9 publishes a new
evaluator basis or F3 changes a root lock view, every other resumable pass on
that root receives discard.

**F3 — root commit and retirement.** Root commit supplies the exact included
token watermarks. A token retires exactly once after all root work and its
returned async action settle. `committed=false` is diagnostic only and does
not change persistence. F9 publication and lock-in/retirement ordering follow
section 8.2.

**F4 — lane-scoped scheduling.** `runInBatch(token,callback)` executes the
callback so React queues its updates in that live token and returns `JOINED`;
if retirement won the race it does not run the callback and returns
`RETIRED`.

**F5 — render lineage.** A lineage id is stable across retries/replays of one
root and logical batch set and dies at commit or abandonment. It is not a pass
serial or token-set hash.

**F6 — DOM mutation window.** One edge reports entry/exit so tracing and the
reconcile backstop can distinguish pre-mutation correction from user layout.

**F7 — root identity.** Every pass and commit carries a stable root id; ids
are generation-checked and never reused live. Portals report the parent root.

**F8 — action parking and capabilities.** Park/settle edges expose the token
lifetime. Protocol registration reports carrier and registrar-wrapper
capabilities so the binding can run its per-bundle boot probe.

**F9 — hook publication.** Render attaches an opaque stage id to one WIP hook;
commit emits winning ids before root lock/fold/layout and completes the pass's
publication set.

### 10.2 The 16 touch points

1. protocol registration/capability negotiation;
2. current-batch classification and lazy claim;
3. pass start;
4. pass yield;
5. pass resume;
6. pass end/discard;
7. lineage death;
8. root commit/lock watermark publication;
9. exactly-once token retirement;
10. `runInBatch` override scope;
11. DOM mutation-window edge (one paired site);
12. action park;
13. action settle;
14. WIP-hook publication attachment;
15. winning-hook publication emission;
16. publication-complete sweep.

### 10.3 Fork invariants

- A live token maps to one lane/batch identity; its integer stays stable while
  React may recycle internal lane bits.
- A pass's included tokens and pin never mutate. Yield/resume changes only
  call-stack activity.
- Same-root evaluator publication and lock changes first discard other
  resumable passes; a discarded pass cannot emit F9 or commit.
- F9 emission, root lock publication, retirement folds, reconcile, and layout
  occur in that order.
- Retirement is exactly once and waits for async parking independently of
  subscriber count.
- `runInBatch` either joins the exact live token or reports retirement; it
  never silently creates a replacement transition.

### 10.4 Rebase drill

- Lane names, counts, or update-queue representation change: reimplement F1,
  F2's include set, and F4 inside the fork; the signals library changes zero
  lines.
- Scheduler/yield implementation moves: re-anchor F2 start/yield/resume/end
  to the semantic stack edges and rerun the pass tests.
- Commit phases or Offscreen internals move: re-anchor F3/F9 to “hook becomes
  current, then root prefix becomes committed, before user layout.” No signal
  type changes.
- Entangled-action internals move: reimplement F8 parking and settle; carrier
  build code is unchanged.
- If React can no longer provide a fact with its stated invariant, protocol
  version changes and the binding fails loudly. It never samples an internal
  approximation.

### 10.5 Fork-owned tests

1. urgent/default/deferred classification and lazy store-only token claim;
2. token stability while lane bits recycle;
3. pass include set plus binding-captured pin across restart;
4. yield removes render context and resume restores it;
5. handler in a yield gap classifies ambient urgent/default;
6. discard cannot later commit;
7. same-root urgent commit discards an older yielded pass before F9/lock
   publication;
8. two roots receive distinct stable ids; portals retain the parent id;
9. spanning token locks independently into A then B and retires once;
10. store-only token retires with `committed=false` and persists;
11. parked async action cannot retire before settle;
12. `runInBatch` joins the original token;
13. `runInBatch` retirement race returns `RETIRED`;
14. updates inserted after completed work force restart before commit;
15. lineage id survives Suspense retries and dies at commit/abandon;
16. DOM mutation edges bracket mutation and precede layout;
17. hidden Offscreen hook publishes when it becomes current;
18. error-abandoned hook publishes nothing;
19. stale alternate fails publication CAS;
20. F9 publication precedes reducer fold and layout;
21. root lock watermark equals the committing pass pin;
22. post-await write extends a parked token watermark without leaking early;
23. transformed await retains carrier identity;
24. timer, microtask, rAF, idle, interval, and registered MessagePort callback
    retain a live token;
25. retired callback falls back ambient and warns once;
26. nested registrar callbacks retain then lose the token at settlement;
27. per-bundle boot probe rejects a missing transform;
28. protocol version skew fails before the first signal write.

## 11. Lifecycles, counters, and reclamation

| item | minted/set | retained by | clear/reset and collision defense |
|---|---|---|---|
| `globalSeq` | writes, retirements, views, stages | receipts, pins, stamps, ids | quiescent renumber rewrites retained values and bumps episode |
| token serial | F1 | fork registry, receipts | never reused live; wrap only after quiescence + token epoch bump |
| slot + `slotGen` | live-token claim | live token, masks, receipts | reach state clears at retirement; gen increments before reuse |
| `wc[slot,gen]` | each write | basis headers | zeroed only after gen increments; gen mismatch invalidates |
| pass pin/id | F2 start | pass, memo pins | pass end; ids generation-checked |
| `lockViewId` | every view re-mint | root, pass, basis | pooled view dies after refs; episode in every key |
| lineage id | F5 | stage records, capsules | lineage death; fork generation prevents reuse collision |
| `stageId` | changed lineage deps | records, basis, F9 | globalSeq/episode; unpublished records swept |
| `walkGen/lastWalk` | each full walk | K0/K1 records | with `walkDepth=0`, wrap clears the whole column then restarts at 1 |
| node/link gen | allocator reuse | edges, memos, watchers | increment before free-list reuse; mismatch rejects |
| `retireVisStamp` | retirement touching atom | bases, snapshots | globalSeq/episode renumber |
| capsule generation | content change | thenable callbacks | increment before suffix reuse; stale settlements ignored |
| receipt count | append/sweep | render gate, E-PRESERVE | reaches zero only after all tapes empty |

Quiescent global renumber runs only at an operation boundary with no active
walk. Forced-small-counter tests invoke the same rewrite. If a configured
horizon is reached with live passes/tokens, the runtime performs a full
order-preserving rewrite under the existing operation-boundary stop; it does
not wrap. `walkGen` has its own whole-column clear because full walks cannot
nest.

Abandoned fresh arena nodes are reclaimed through pass-owned allocation
lists: commit transfers them to ordinary ownership; discard returns their
records after generation increment. StrictMode repeated mount/abandon cannot
grow the bump plane without bound.

## 12. Tracing and diagnostics

Tracing is a lazily imported module. Each event site performs one recorder-
slot check. When absent it allocates nothing. Ring mode writes fixed integer
records into a preallocated plane and overwrites old records with a loss
counter; lossless-session mode grows only at operation boundaries. Events
include write/token/seq, pass and world ids, fold decisions, K0/K1 edges,
delivery cause, F9 publication, lock view, retirement, carrier fallback, and
effect flush.

Queries walk integer causality links for “why did this watcher render?”, “why
is this memo invalid?”, and “which receipt is visible here?”. Graphviz exports
K0, K1, and a selected world without mutating them. Labels are cold side data.

Development assertions include the strong E-PRESERVE reach comparison, mask
generation checks, pass/lock ordering, publication ownership, reducer-fold
guard, no-user-code full walks, and receipt-count/tape agreement.

## 13. Costs and release gates

All ratios are medians from one-framework-per-process runs on an idle machine;
unmeasured rows are release-blocking spikes, not claims.

| gate | budget | current status |
|---|---|---|
| core semantics | 179/179, exact pull counts, forced growth | inherited donor target; must rerun |
| DIRECT tier-0 | no slower than alien-signals v3 on every shape | donor measured below 1.0; symbol/bytecode diff must prove no concurrency op |
| React rerender | <=1.10x equivalent `useState` | unmeasured |
| 10k subscriptions | <=1.15x equivalent hooks | unmeasured; mount pays one committed cached eval |
| LOGGED quiet | <=1.02x tier-0 | at risk: prior 1.024-1.038 floor [SPKHQ -> OPEN O19]; idle rerun or requirements decision required |
| logged write | <=2.0x DIRECT | unmeasured |
| union delivery | <=2.0x DIRECT propagation; <=1 spurious render per watcher/token/cycle | unmeasured, includes `walkGen` |
| exact-world active render | <=1.10x equivalent React state; cost proportional to rendered reads, not whole graph | unmeasured; coarse `receiptCount` gate is the consolidation bet |
| lock view | O(number of locked live tokens), max 31, pooled; atom fp O(1) | implementation assertion; benchmark dense commits |
| basis validation | O(included slots + flattened tracked prefix) | unmeasured; deep-prefix/typeahead grid required |
| retirement | <=2.0x DIRECT `batch()` for core; <=2.0x equivalent useState commit for React | unmeasured; reports callback time separately |
| carrier | unarmed approximately 0; armed <=15 ns/await | measured transform +12 ns/await [I30/SP-F8]; registrar wrapper costs unmeasured |
| allocation | zero engine allocations in steady rerender; report heapUsed and plane bytes side by side | allocator counters in CI |

If the coarse exact-world row fails, this design fails the round: no
certificate, taint, frontier, pinless cache, or other fallback is smuggled
into a consolidation artifact. The inherited process order is oracle first,
frozen K0 contract, schema regenerate-and-diff, bytecode budgets, then the
pre-registered performance grid.

### 13.1 Open-item disposition

| open item | disposition in this design |
|---|---|
| O1 | K1 remains the real per-world dependency plane; no compensated-single-kernel fallback is added |
| O3 | E-PRESERVE uses the strong reading; its brute-force dev validator is measured, and over 10% dev cost selects the already listed sampled-validation policy |
| O7 / O23 | F3 root watermarks and F9 hook publication remain implementation existence proofs; fork tests 7-9 and 17-22 gate them |
| O12 | delivery remains value-blind; the existing fan-out grid and held-batch row decide viability, with no new suppression rule |
| O18 | the coarse exact-world gate deliberately accepts restart revalidation; the pinless-frontier fallback is not admitted in a no-new-mechanism round |
| O19 | the 2% quiet requirement remains at risk and needs the idle rerun or explicit requirement decision |
| O21 | the common basis owns flattened-prefix and staged-value revalidation cost; the deep/typeahead grid measures it |
| O22 | registrar matrix includes armed install cost, nested callbacks, retired fallback, warning rate, and the exact MessagePort boundary |

O20 remains closed by the measured twin-build carrier and loud per-bundle
probe. No closed decision is reopened.

## 14. Round-4 attack docket — re-derived walks

These walks attack only math introduced or merged in round 3. Each outcome is
obtained with an existing mechanism or by deleting the attacked mechanism.

### A1 — taint set/clear, tracked serves, and DIRECT-to-LOGGED caches

Setup: `c = untracked(() => a.state)`, `p = c.state + 1`; `p` tracks `c`.
K0 initially caches `c=0,p=1`. T writes `a=1`; a sync pass S excludes T.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | T write / receipt ledger | append `a:{T,s1,set1}` before K0 becomes 1; `receiptCount=1`; no `a->c` edge, correctly |
| 2 | NEWEST core read | K0 may evaluate/cache `c=1`; a tracked K0 read may then cache `p=2`; no taint is recorded or needed |
| 3 | S render / coarse gate | `receiptCount!=0`, so S cannot serve either K0 cache; world-evaluate p, then c; c's untracked atom fold excludes T and returns 0; p=1 |
| 4 | yield and T retirement | S's frame is absent during the gap; retirement gets `r>s.pin`, so pin-gated compaction retains the receipt and count despite immediate slot release |
| 5 | S resume | count is still nonzero; exact fold still excludes T; no clear race exists |
| 6 | S ends | compaction may now fold/remove the retired receipt; every possible future pass includes that committed value, so K0's cached 1/2 is a legal temporally stale untracked result |
| 7 | pre-existing DIRECT cache variant | bridge activation occurs with zero receipts; first LOGGED append raises count before K0 mutation, so the old cache is served only while all worlds equal |

outcome: the judge's tracked-serve blocker is removed, not patched. No cache
containing pending state can cross into a render while history exists.

residual risk: the coarse gate's cost, pinned by the held-transition and
typeahead performance rows.

### A2 — `walkGen` under edge-add delivery reentrancy

Setup: K0 union K1 contains `c->d->c`; an outer write walk reaches a place
where React work later creates an edge carrying another live token.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | outer delivery walk | set `walkDepth=1`, mint G1; stamp c then d; d's edge to c sees G1 and stops |
| 2 | watcher enqueue | `setState` only appends React work; it invokes no render or user callback inside the walk |
| 3 | edge-add request while depth 1 | existing deferred edge-delivery drain records `(token,edge,slotGen)`; it does not start a full walk or overwrite `lastWalk` |
| 4 | outer completion | set depth 0; every G1 record was visited once |
| 5 | drain | generation/liveness-check the queued token; invoke `runInBatch`; any required new full walk now mints G2 after G1 is finished |
| 6 | reducer/effect variants | reducer/equality/evaluation happened before the walk under guards; effects flush after the drain, so none can nest a full walk |

outcome: a single `lastWalk` cell is sufficient because full walks are
serialized with the already existing edge-delivery drain.

residual risk: a future React enqueue path that synchronously renders would
violate the no-user-code assertion; fork test 14 and a `walkDepth` dev throw
pin it.

### A3 — immutable lock views, yielded same-root passes, and fingerprint cost

Setup: root A pass P captures lock view V1 and yields; urgent U commits on A
and would advance a token watermark.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | P start | retain immutable V1/id1 and pin p1 |
| 2 | U pre-commit / F2 | emit `passEnd(P,discard)` before the root view changes; P's frame, memo pins, and unpublished stages release |
| 3 | U commit / F3 | mint V2/id2 with raised watermark and atomically swap A's pointer |
| 4 | retry P2 | capture V2; no continuation can resume with V1 on A |
| 5 | root B | B's independent view/id do not move; no cross-root fingerprint churn |
| 6 | observers | world keys and basis header compare id2; touchedList for the advanced slot force-revalidates only reached committed effects |
| 7 | atom fingerprint | reads base/visible seq/reducer/vRetire only: O(1); no <=31-entry `lockTerm` scan |

outcome: `lockViewId` replaces both lock stamps and lock terms while retaining
root scoping and immutable pass snapshots.

residual risk: the fork must prove the discard-before-swap edge on every
same-root commit path, including Offscreen; tests 7 and 21 pin it.

### A4 — lineage-stable ids under deps oscillation and lineage changes

Setup: one hook sees deps A, then B, then A across retries of lineage L; a
second lineage L2 later renders the hook.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | L/A | A equals committed record E0; reuse E0 stage id, no unpublished stage |
| 2 | L/B | mint E1 with `stageId=publicationId=s1`; store as L's current record |
| 3 | pure B retry | deps equal E1; reuse s1, so the positional capsule identity/basis does not churn |
| 4 | L/A | compare committed first; reuse E0. If A were only an older unpublished alternative, mint E2; common-basis value revalidation retains resources whose input stayed equal |
| 5 | L abandonment / lineage death | E1/E2 publish nothing and die when unreferenced; an ordinary retry discard retains the lineage pointer |
| 6 | L2 | cannot reuse unpublished L records; it selects committed E0 or mints its own record |
| 7 | L commit-B variant | F9 promotes E1; L2 may now select E1 as the immutable committed record |

outcome: pure retries are stable, oscillation has React/useMemo semantics,
and unpublished identities cannot leak across lineages.

residual risk: deps comparison and record retention are pinned by A/B/A,
StrictMode, discard, and forced-id-wrap rows.

### A5 — value-revalidated prefixes through staged evaluators

Setup: a staged child evaluator changes stage id before a downstream
`ctx.use(factory)`. In one branch the child's equality-stable output is the
same; in the other it changes. The prefix depth is N.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | retry basis compare | child `(id,oldStage,oldValueRef)` mismatches current stage id |
| 2 | world evaluator | evaluate child with the staged record before reaching the downstream use position |
| 3a | equal branch | child equality retains `oldValueRef`; update the basis stage id in place; continue through remaining entries; reuse the same settled thenable |
| 3b | changed branch | new value reference differs; generation-drop this and later positions; invoke factory once for the changed content |
| 4 | lock/retire stamp variant | fold the moved atom, use the same equality rule, and restamp on equal |
| 5 | owning-evaluator variant | if the stage id belongs to the computed containing this `ctx.use`, invalidate directly because the factory code may differ and no completed output exists yet |
| 6 | deep chain | visit at most N flattened entries and fold only moved ones; no secondary vector or hash is built |

outcome: a nested evaluator-id move is value-revalidated; an owning-evaluator
move refetches because it changes the acquisition code itself.

residual risk: linear prefix work is unmeasured and release-blocking in the
deep-prefix/typeahead grid.

### A6 — F9/reducer ordering across roots and former saturation

Setup: spanning T has pending actions on root-A-owned hook ReducerAtom RA and
root-B-owned hook ReducerAtom RB. A stages reducer rA1; B stages rB1. Both
have older committed reducers.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | T writes | append RA and RB actions under T; both remain replayable; delivery schedules each owning root |
| 2 | A commit | F9 publishes only A's winning stage; re-fold RA pending actions under rA1; value-blind notify; lock T through A's pin; then fold retirements due on A |
| 3 | B still pending | B's stage record and world memo remain pass-owned; A cannot publish or mutate RB's owner record |
| 4 | B commit | publish rB1, re-fold RB, lock B's prefix, then retire/fold in the same order |
| 5 | T global retirement | after both roots/actions close, stamp tapes once; constructor/shared immutable signals remain legal across roots |
| 6 | illegal shared stageable node | second-root subscription throws before either commit; supporting it would require the forbidden new per-root evaluator mechanism |
| 7 | old “promotion during saturation” | no retired slot is retained: retirement drains and increments slotGen before reuse; promotion's union walk runs atomically, while pin-retained tape keeps `receiptCount>0` and exact-world routing |

outcome: each root publishes the reducer that produced its own tree before
folding its receipts, and deletion of retained slots removes the promotion x
saturation interleaving.

residual risk: the owner-root restriction and publication order require
fork/binding differential tests with both commit orders.

### A7 — registrar liveness, nested registration, and MessageChannel

Setup: T registers an async timer callback which registers a microtask and a
MessagePort listener; T may settle before any invocation.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | registration under T | each installed wrapper captures `(T,tokenGen,realm)`; no token is copied through message data |
| 2a | timer before settle | liveness passes; wrapper pushes T; transformed async body captures T; nested microtask/listener registration captures T |
| 2b | timer after settle | liveness fails; callback runs ambient and warns once; its transformed body captures ambient, never retired T |
| 3 | settle between callback and await | synchronous prefix cannot interleave with settle; each later transformed resumption checks liveness again and becomes ambient if retired |
| 4 | interval | every tick independently checks; early ticks use T, later ticks ambient |
| 5 | registered MessagePort callback | listener registered under T uses the same bracket on delivery; a listener installed before T is explicitly boundary-class and uses ActionScope for T-owned writes |
| 6 | nested action | `armedActions` refcount keeps wrappers installed; inner token shadows during its registration and finally restores outer T |
| 7 | final settle | 1-to-0 restores host functions only if wrapper identity still matches, avoiding clobbering another patcher |

outcome: token lifetime is checked at every actual continuation entry, nested
capture is stack-correct, and MessageChannel support has an exact boundary.

residual risk: cached original host functions and unlisted registrars are the
documented boundary, measured by warning-rate and coverage tests.

### A8 — slot release during an open pass or walk

Setup: old pass P excludes token D; D retires while P is pinned, and a new
token needs D's slot. Also consider an active delivery walk.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | D retirement | stamp D's receipts; durable-drain touchedList; clear D reach bits; increment slotGen and release slot |
| 2 | receipt retention | `retiredSeq(D)>P.pin`, so tape compaction refuses; `receiptCount>0` |
| 3 | P resume | coarse gate forces exact-world fold; D's retirement clause fails at P.pin, so P sees the old value despite cleared reach bits |
| 4 | new token J | occupies same slot with new gen; P's captured gen and D receipts cannot match J; J clock/dedup start zero |
| 5 | active full walk | retirement/write interleaving cannot occur because the walk calls no user code; an edge-delivery drain completes before returning to code that can retire/claim |
| 6 | queued render edge after D retired | queued `(D,oldGen)` liveness check fails and is dropped; committed comparison/retirement drain already covers observers |
| 7 | P end | compaction may remove D; only now can `receiptCount` reach zero and permit K0 render reads |

outcome: the spillover state machine is unnecessary; only live tokens consume
the 31 slots, and exact-world history—not a pass flag—protects old pins.

residual risk: generation comparison must be present at every mask/clock/
dedup consumer; schema-generated audits and forced 2-slot tests pin it.

### A9 — mount-fixup skip versus retirement race

Setup: compare a mount from k's own committing pass with an urgent mount that
excluded k and whose layout effect runs after k retires.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1a | own-pass mount | render world contains k through pin; root commit installs that prefix before layout |
| 2a | token loop | if k remains globally live, inclusion+clock skips only `runInBatch(k)`; if retired, it is absent |
| 3a | unconditional compare | committed-for-root contains the same locked/retired prefix, so equality yields no urgent update and no double render |
| 1b | excluding urgent mount | render omits k; if k live, loop schedules correction into k; committed world still equals rendered, so compare is quiet |
| 2b | k retires before layout | k is absent from the loop; committed-for-root now includes it; unconditional compare differs and schedules urgent pre-paint correction |
| 3b | retire between loop and call | `runInBatch` returns RETIRED; urgent fallback fires |
| 4 | mixed tokens | included live prefixes are already in this root's lock view; excluded live tokens get lane updates; every retired difference is visible to the unconditional comparison |

outcome: no vacuous quantifier controls the comparison. C9 avoids an extra
token render and the retire-race fallback remains total.

residual risk: layout ordering is pinned by F3/F9 tests and the mixed
included/excluded/retired mount matrix.

## 15. Acceptance battery — complete walks

Notation: `RM(n)` is a node's generated reach mask, `TL(s)` is the durable
touched list, `M(n,w)` is a pinned world memo, and `LVr` is root r's immutable
lock view. All steps occur in LOGGED unless explicitly DIRECT.

### C1: world-divergent dependency and seven variants

Setup: `flag=false,a=0,b=0`; `c=flag?a:b`; W watches c. K0 edges are
`flag->c,b->c`.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | k writes flag=true | append `flag:{k,s1}`; K0 newest flag=true; union walk uses K0 `flag->c`, sets `RM(c)+=k`, `TL(k)+=c/W`, and delivers W in k |
| 2 | k pass reads c | count nonzero -> world path; fold flag=true; read a=0; `M(c,wk)=0`; K1 records `flag->c,a->c`; basis records k clock and atom values |
| 3 | k writes a=1 | append s2 and bump `wc[k]`; union walk follows K1 `a->c`; if W rendered since step 1 it re-delivers, otherwise its existing k update covers s2 |
| 4 | k reads/retries | memo clock moved; fold/evaluate gives c=1; K1 topology remains real for k |
| 5 | before root commit | a committed/excluding world folds flag=false and b=0, so c=0; no K0 cache is render-served while history exists |
| 6 | k commit | reconcile reads wk=1; root lock view installs k prefix; W and siblings commit 1 together |

outcome: the later write reaches c through its real K1 edge, and every render
uses the correct fold.

residual risk: K1 edge omission or edge-add delivery; pinned by the core C1
test and randomized branch-flip oracle.

Variants:

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| T2 | k writes committed-only b | K0 edge may deliver conservatively; wk has flag=true and folds a, so c remains 1 by equality; no wrong cache serve |
| T3 | k sets flag=false | clock invalidates M; world eval selects b and records `b->c`; c follows k's b value; union retains both branch edges safely |
| T4 | urgent U writes b | U receipt/delivery uses its token; a k view with flag=true still selects a, so c does not change even after U retirement becomes visible |
| T5 | urgent U writes a | U render excludes k and evaluates its own world; after U retires, a fresh k pass pin includes U and folds k flag plus retired U a, so c reflects U |
| T6 | k retires and slot recycles | old receipts/masks carry old `slotGen`; new token gen cannot match; old pinned pass exact-folds retained receipt; episode bump guards later reuse |
| T7a | pass includes k+j | key/memo/basis contain both generated tokens and their clocks; it may suspend without changing either pin or LV |
| T7b | j commits alone | same-root older pass is discarded before LV changes; retry captures new LV; a different root's old pass retains its own immutable LV and exact world |

outcome: every branch, urgent, reuse, and multi-batch variant has an explicit
world identity and dependency path.

residual risk: multi-root commit ordering; fork tests 7, 9, 21 plus C11 cover
it.

### C2: flushSync excludes a pending default batch

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | default D writes a=1 | append D receipt before K0=1; `receiptCount=1`; K0/K1 walk marks and delivers a/c watchers in D |
| 2 | `flushSync` pass starts | F2 include set excludes D; pin may be after s1 but mask does not contain D |
| 3 | pass reads a | coarse gate -> fold; live D fails retired/include/lock clauses, so a=0 |
| 4 | pass reads c | coarse gate forbids K0's possible 11; M evaluates from folded a=0, so c=10 |
| 5 | commit | reconcile sees one world `(a=0,c=10)`; D remains scheduled separately |

outcome: atom and computed show the same D-excluding world.

residual risk: append/K0 ordering and include-set accuracy; unit test pauses
between internal write steps and fork test 1 pins both.

### C3: updater rebase parity

Setup: a=1; T `+1`; U `x2`.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | T write | tape `[T:+1@s1]`; K0 NEWEST=2 |
| 2 | U write | tape adds `[U:x2@s2]`; K0 NEWEST replays live order ->4 |
| 3 | U render | fold base1, skip T, apply U ->2 |
| 4 | U retirement | stamp U; do not discard/reorder its op around older live T; K0 newest remains 4 |
| 5 | T render after U | apply T +1 then retired-visible U x2 ->4 |
| 6 | T retirement/compaction | fold ordered prefix to base4; tapes leave only after pins allow |
| 7 | plain set variant | base1, T +1, later visible `set5` -> set replaces accumulator, final 5 rather than 6 |
| 8 | useReducer differential | each world feeds the same included/skipped action sequence to the effective immutable reducer; snapshots match React after every step |

outcome: values are 2, then 4, then committed 4, matching React queue order.

residual risk: compaction across skipped entries; randomized queue oracle and
side-by-side `useReducer` pin it.

Staged-reducer extension:

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| R1 | T dispatches A under committed r0 | hook ReducerAtom always appends; K0 evaluates pending A with r0 |
| R2 | committing pass stages r1 | exact world folds A with pass r1; F9 id is attached |
| R3 | commit | publish r1, re-fold pending A under r1, value-blind deliver, then retire/fold under r1 |
| R4 | no-op-under-r0 action | it was not dropped; if r1 makes it effective, the pass and React `useReducer` both apply it |

outcome: evaluator publication cannot leave K0, tape folds, and the committed
tree using different reducers.

residual risk: publication ordering; fork test 20 and swap-with-pending
differentials.

### C4: two batches write an already-stale region

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | T1 writes a | full walk G1 reaches c/W; watcher dedup bit T1 set; `setState` queued in T1 |
| 2 | T2 writes before render | full walk G2 does not stop at dirty marks; distinct watcher bit T2 was clear, so `setState` queues in T2 |
| 3 | joint or separate render | each included set folds its own receipts; rendering clears only included token dedup bits |

outcome: W has work in both lanes; staleness never gates a walk.

residual risk: accidental shared stamp pruning; tests assert two update queue
tokens before any render.

### C5: equal first write, effective second write in one batch

Setup: `c=a*0+b`, W watches c; k writes a then b.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | k writes a=1 | receipt and clock move; value-blind delivery queues W even though a later pull keeps c equal; pure-core K0 equality still cuts off propagation |
| 2a | W has not rendered | its existing k update necessarily reads through pin including the later b write; dedup need not enqueue twice |
| 2b | W rendered between writes | render clears W's k bit; second full walk reaches W and enqueues again |
| 3 | k writes b=7 | append/clock invalidates M; exact evaluation gives c=7; no first-evaluation cache can validate |

outcome: conservative first delivery or re-armed second delivery both ensure W
commits 7.

residual risk: confusing core equality with React delivery; separate counters
and a regression assert the distinction.

### C6: lane attribution inside engine `batch`

Schedule: `batch(() => { a.set(1); startTransition(() => b.set(2)) })`.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | outer engine batch | delays core-effect flush only; captures no lane for later watcher delivery |
| 2 | a write | F1 returns urgent/default token A; synchronous walk calls a-watchers in A context |
| 3 | transition b write | F1 returns deferred token T; synchronous walk calls b-watchers before the transition scope exits, in T context |
| 4 | outer close | flush core effects; it does not replay/group watcher calls |
| 5 | `startTransition(()=>batch(...))` | all writes see T and deliver in T; legal |
| 6 | plain transition writes / helper | ordinary writes see T; `startSignalTransition` additionally supplies ActionScope and parking |

outcome: attribution is preserved per write; there is no implicit grouping to
misclassify.

residual risk: future notification coalescing is forbidden by a lane-token
trace assertion.

### C7: reads and writes in a yielded pass gap

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | transition pass P starts | F2 installs pass frame/world/pin; reads exact P world while history exists |
| 2 | P yields | F2 removes frame but retains immutable P data/memo pins |
| 3 | click handler reads a | no render frame -> K0 NEWEST, not P |
| 4 | handler writes a | allowed; F1 classifies click token U, appends U receipt, delivers in U |
| 5 | P resumes | F2 restores original world and pin; U receipt after pin is excluded unless P is discarded/restarted |
| 6 | render write check | only an active resumed render frame rejects writes; the gap had none |

outcome: handler observes/writes newest while P remains internally pinned.

residual risk: missing a scheduler yield edge; fork tests 4-5.

### C8: equal writes keep receipts

Setup: a=0; T set1; U set1.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | T set1 | tape was empty, value changes, append T; K0=1 |
| 2 | U set1 | tape is nonempty, so append U despite equality with K0; K0 retains old reference |
| 3 | U render excluding T | fold base0, skip T, apply U set1 ->1 |
| 4 | T closes/aborts first | committed=false still stamps/folds T; U receipt independently represents 1 |
| 5 | overlapping transitions same value | each nonempty-history write has its own receipt/token and each single-token world folds to 1 |

outcome: equality never erases a world-visible write once history exists.

residual risk: “equal K0” fast-return before append; write-path order test
forbids it.

### C9: mount mid-transition, existing and fresh nodes

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | k writes atoms | receipts make count nonzero; write walks establish all currently known reach paths |
| 2 | k pass reads existing c | coarse gate -> exact `M(c,wk)`; atom folds include k; K1 records k-world edges |
| 3 | k pass constructs fresh f | pass-owned arena allocation; count nonzero -> first read evaluates f directly in wk, records K1 edges and basis; no K0 probe occurs |
| 4 | pass retries | pinned memos/bases validate by clocks/stages; same world values returned |
| 5 | k root commit | lock view contains rendered prefix; fresh allocations transfer to committed ownership |
| 6 | layout fixup | included+clock skips redundant k lane correction; unconditional committed-for-root comparison equals rendered value because lock-in preceded layout |
| 7 | discard variant | pass-owned fresh records are generation-freed; no subscription/effect escaped |

outcome: both nodes read k on their first render and the mount incurs no
second k render.

residual risk: an accidental K0 fresh-node shortcut; test asserts world-path
counter on first read and arena reclamation on discard.

### C10: late subscription joins the pending token

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | k writes a | `RM(a)`/`TL(k)` receive k even with no watcher |
| 2 | urgent pass mounts W excluding k | exact fold renders old a; subscription records excluded world |
| 3 | layout token loop | k is live/reached but absent from rendered mask/LV; `runInBatch(k,setState)` returns JOINED |
| 4 | React k render | corrective is in k's original lanes, so the render that includes k also includes W; one commit carries both |
| 5a | k retired before layout | no live loop entry; committed comparison sees retired a and issues urgent pre-paint correction |
| 5b | k retires after enumeration | `runInBatch` returns RETIRED; same urgent fallback |
| 6 | edge created after k write | K1 edge-add carry queues the same k correction before commit |

outcome: a live token gets exactly its own-lane correction; a retired token
gets the only possible pre-paint correction.

residual risk: F4 mistakenly spawning a fresh transition; fork tests 12-14
assert token identity and restart behavior.

### C11: full spanning multi-root support

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | spanning k writes | one token/tape schedules reached watchers in roots A and B |
| 2 | A renders k through pin pA | exact world includes k; B may remain on its old world |
| 3 | A commit | F9 for A-owned hooks, then `LVA` re-mints with `(k,pA)`; A DOM and committed-for-A reads agree; k remains live for B/action |
| 4 | later A render excluding k lanes | clause 3 includes k through `LVA`; it cannot contradict A's DOM |
| 5 | A passive effect | committed-for-A uses current `LVA` and observes the prefix A committed |
| 6 | post-await k write s2 | K0/tape newest move; A's `LVA` still caps at pA, so A committed reads do not leak s2; delivery schedules A/B in k |
| 7 | A commits s2 | view advances to pA2/id2; changed-slot TL forces A effects; old same-root pass was discarded first |
| 8 | B commit | `LVB` independently locks B's rendered watermark; visible cross-root skew was allowed, each root internally consistent |
| 9 | global retirement | after both roots and parking close, stamp once, drain each root's affected observers, drop lock entries, recycle slot |

outcome: per-root lock views preserve each root's committed prefix while the
token spans roots and advances.

residual risk: fork-side root/commit facts; tests 7-9 and 21-22 are on the
critical path.

### C12: store-only and async transitions persist

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | `startTransition(()=>a.set(5))` | F1 lazily claims T despite no watcher; append receipt; no React update is required |
| 2 | transition closes | F3 retires T once with `committed=false`; policy still stamps/folds 5 into committed base |
| 3 | later read | K0/base returns 5; persistence did not consult watcher count |
| 4 | async T synchronous prefix set1 | append under parked T; retirement prohibited while returned thenable pending |
| 5 | transformed continuation after await | carrier liveness passes; set2 appends under the same T |
| 6 | settle | F8 unpark then F3 retire; replay set1,set2 in order -> base2 |
| 7 | shimmed timer callback | registration captured T; invocation before settle runs under T; after settle runs ambient+warn |
| 8 | untransformed opaque code | raw write is an ordinary ambient batch, never lost; `scope.set/dispatch` is the supported exact attribution path |

outcome: subscriber-free writes persist, and supported async continuations
remain parked until settlement.

residual risk: build/registrar coverage; per-bundle boot probe and carrier
matrix pin the declared boundary.

### C13: counter and identity lifecycle

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | quiesce episode E | every tape empty, no pass/token/stage/capsule refs; K1 refresh completes |
| 2 | global renumber | rewrite retained base/stamp/id fields, bump episode, reset seq; every memo/basis key contains episode |
| 3 | slot reuse | clear RM/dedup/TL, increment `slotGen`, then zero wc; old receipt/pass mask gen mismatch |
| 4 | node/link reuse | allocator increments gen before reuse; stale K1 edge/memo/watcher rejects |
| 5 | `walkGen` forced wrap | depth is zero; clear every `lastWalk`, reset G=1; no old stamp can compare equal |
| 6 | lock view pool reuse | old view remains until refcount zero; new id plus episode differs |
| 7 | lineage/stage/capsule reuse | lineage and node generations plus episode separate old records; stale thenable settlement checks capsule gen |
| 8 | token serial wrap | allowed only after no live token; token epoch changes and is checked with serial |
| 9 | forced-small test | run all counters at 2- or 3-bit horizons with an old pass, retirement, slot reuse, and Suspense settlement; values must match unbounded oracle |

outcome: every reusable number is paired with an epoch, generation, retained
reference, or whole-column clear.

residual risk: an omitted schema consumer; generated retainer tables and
forced wrap tests fail CI on any unlisted counter field.

### C14: StrictMode and replay

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | double render | reads only create pass-owned memos/K1 additions/stages; K1 additions are idempotent; no render write is allowed |
| 2 | first attempt discarded | memo pins, fresh nodes, and F9 attachments release by generation; F9 emits nothing; lineage stage/capsule records remain for a same-lineage replay |
| 3 | replay with equal deps | lineage record and stage id reuse; same positional capsule/thenable returned |
| 4 | replay with changed deps | new stage id; common basis forces recompute/value validation before capsule reuse |
| 5 | double mount/unmount | refcounts flap but microtask damping starts one observed effect and cleans after stable zero |
| 6 | throwing/suspending getter | sentinel box closes tracking in `finally`; graph contains only completed edges |

outcome: replay is pure, resources retain stable identity, and lifecycle
effects net correctly.

residual risk: Offscreen/StrictMode ordering changes; fork F9 tests and the
React harness run in dev and production builds.

### C15: Suspense across worlds and batch sets

Setup: k makes c suspend; a component mounts in k; later the promise settles.

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | k write/pass | receipt count forces exact world; c evaluates with k atoms and reaches `ctx.use(factory)` |
| 2 | capsule create | key `(cGen,lineageL,position)`; store thenable q and common basis prefix for full k world; React `use` suspends on q |
| 3 | committed/excluding render | exact-evaluates its own world and cannot see L's q or suspension; a non-React core NEWEST getter follows its separately documented newest contract |
| 4 | mount mid-transition | same lineage/world reaches same position; equal basis returns q and suspends on first render |
| 5 | q settles | settlement version dirties the k memo and schedules retry; q identity remains |
| 6 | retry | lineage L stable; basis values equal -> consume q's settled value, no refetch |
| 7 | multi-batch `{k,j}` | F5 gives the joint logical lineage; basis header/mask/clocks distinguish it from k-only without using one token as identity |
| 8 | included write changed input | clock/fingerprint moves; re-fold differs -> drop suffix/refetch once |
| 9 | lock/retire/evaluator id moved but input equal | value revalidation retains old reference, restamps basis, and reuses q |
| 10 | commit | root lock contains rendered prefixes; lineage dies after committed consumers transfer; stale settlements check capsule gen |

outcome: thenable identity survives pure retries, while actual world content
changes invalidate it.

residual risk: deep flattened basis cost and factory purity; typeahead/deep-
prefix gate and lazy-factory tests pin both.

### C16: effects observe committed state only

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | default D writes a | K0 NEWEST becomes new; D receipt live; write queue may note effect E but E's committed snapshot is unchanged |
| 2 | unrelated token retires/flushes | `useSignalEffect` evaluates committed-for-root world whose LV excludes D; exact fold returns old a; basis value equal, so no new-value observation |
| 3 | core effect variant | documented NEWEST contract may read K0 new immediately; separate API, expected |
| 4 | D root commit | LV locks D prefix before effects; D's durable TL forces E revalidation; it now reads new a and runs |
| 5 | D store-only retirement | retirement stamp/TL similarly exposes and flushes committed value even without React work |
| 6 | effect deps change | React native effect re-fire cleans, runs new function, records new K0/K1 dependencies; no F9 staging path |

outcome: React effects never observe applied-but-uncommitted D, then observe it
at the commit/retirement edge that makes it committed.

residual risk: a fast queue bypassing durable trigger enumeration; tests
consume the queue early and require the later TL drain to fire.

### C17: optimistic rollback

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | API inspection | no truncate/rollback method is exported from Atom, transition helpers, fork protocol, or ActionScope |
| 2 | React abandonment | `committed=false` retirement still folds receipts; it is not rollback |
| 3 | attempted internal call | no policy entry point exists; TypeScript and compiled-export snapshots reject it |

outcome: the optional case is closed by deleting the surface; React batches
never truncate signal history.

residual risk: accidental debug export; public API snapshot test pins it.

## 16. Known gaps and unwalked cases

No acceptance case or round-4 docket schedule is unwalked.

The remaining gaps are measurements and implementation existence proofs, not
unstated correctness mechanisms:

- the coarse exact-world gate during long receipt history may fail the React
  1.10x or typeahead gate;
- LOGGED-quiet has a previously measured 2.4-3.8% floor against a 2% contract;
- flattened basis length/value revalidation cost is unmeasured;
- value-blind fan-out, dense retirement, lock-view copy cost, and registrar
  wrapper cost are unmeasured;
- current-generation React implementations of F2 same-root discard ordering,
  F3 per-root watermarks, and F9 Offscreen publication must be built and pass
  the fork tests;
- registrar coverage is intentionally finite. Pre-existing MessagePort
  listeners, cached original host functions, and unlisted schedulers require
  ActionScope or native AsyncContext and warn when detectable.

No fallback mechanism is authorized in this consolidation round. A failed
correctness proof rejects the design; a failed numeric gate rejects the
design or requires an explicit requirement change.
