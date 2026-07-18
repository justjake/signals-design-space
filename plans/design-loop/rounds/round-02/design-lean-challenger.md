# Lean challenger: transient views over an episode-union graph

## One-page summary

This design has two graph planes but only one cache that survives ordinary
execution. **K0** is the measured donor arena kernel and is the cache for the
newest state. **K1** is an add-only, edge-only graph containing the union of
dependencies actually read by non-newest React passes during the current
concurrent episode. K1 has no values, dirty states, world slots, or subscriber
dedup bits. At quiescence it is bulk-cleared.

The bindings install three closure-built modes. `DIRECT` is byte-for-byte the
donor hot path and executes no concurrency instruction. `QUIET_LOGGED` is used
after a React bridge exists but before any live history: reads are still the
donor path, while the first write changes mode before mutation. `ACTIVE` is
used while any tape entry, pass, batch, or render lineage is live; render
enter/resume selects a newest or folded-view read closure once, outside the
per-read hot path. Bridge installation is monotonic and
every React-mode write is logged, including urgent and equal writes.

Each atom owns an ordered tape of `{op, token, writeSeq, retiredAt}` records.
One global event sequence numbers every semantic change; writes and retirements
also leave tape fields. A render pass samples
two immutable upper bounds on that same number line and receives a set of
included batch tokens from the fork. Atom reads replay visible operations in
write order: a record is visible if it was written before the write pin and is
either in the include set or retired before the retirement pin. A root's
already-committed live tokens are added to that set. This is React's update
queue arithmetic without lane bits crossing the seam.

A non-newest pass owns a scratch frame. Its first read of a computed evaluates
the function against the pass's atom folds, memoizes the result for that pass
only, and adds the real dependency edges to K1. The frame survives yields and
is never consulted by a different pass. Consequently there is no general
persistent successful-world-value predicate to get retirement compaction or
function replacement wrong; M7 retains only the suspense/error capsule React
needs across retries. Newest clean reads may use K0;
hook-local render functions and any read that would mutate K0 use the scratch
evaluator.

Every semantic change runs one allocation-free reach walk over `K0 union K1`.
The walk advances an event-sequenced input stamp on reached nodes and synchronously calls each
reached committed watcher's React setter in the change's current execution
context. There is no engine dedup: React's own event batching coalesces updates,
and a second write or a different batch always gets another setter call. A
thenable position is cached by render lineage, node/function/position, and an
exact snapshot of the included full-token write clocks plus retirement clock:
pure retries reuse identity, an included write changes the snapshot for a
later pass, and settlement deliberately does not. `ctx.previous` is staged in the
pass and published only for the pass named by a root commit.

The fork seam supplies stable integer batch/root/pass/lineage identities,
write classification (including an async-continuation carrier), render
enter/leave edges, root commit, exactly-once retirement, lineage death,
lane-scoped scheduling, and the DOM mutation window. Yield emits render-leave
and resume emits render-enter, so an event handler in the gap sees newest
state. Root lock-in uses token arrays, not recyclable slot masks. Retirement
persists every write regardless of `committed`, and retirement reconciliation
compares each reached watcher's last-rendered value with its root's now-
committed value before scheduling a correction.

The architecture uses **9 mechanisms** and **9 semantic seam touch-points**.
Its intentional bet is that recomputing only active non-newest passes is
cheaper and safer than maintaining reusable world caches. That bet is a hard
measurement gate: if active-pass recomputation misses the stated gates, this
architecture fails rather than quietly acquiring a tenth mechanism.

---

## 1. Terms and user-visible semantics

**Newest state** is the result of applying every write received so far in
write order, whether or not React has committed the write. K0 represents this
state outside a pinned render.

A **committed-for-root state** contains every globally retired batch plus every
still-live batch that this root has committed. Different roots may therefore
have different committed states for a bounded interval.

A **view** is an immutable recipe for a read: an episode generation, a write
pin, a retirement pin, and a set of included batch tokens. A **pass frame** is
the scratch memory that evaluates one React render pass's view. A **render
lineage** is a fork identity stable across retries/replays of one root and one
logical included-batch set.

An **input stamp** is the global event sequence of the latest event that could change
that node's result. It is not a cache-validity certificate. It invalidates
only positional resources such as `ctx.use`; ordinary non-newest values are
not retained across passes.

### 1.1 Public API

- `new Atom<T>({state, effect?, isEqual?, label?})` creates a writable atom.
  `state` is tracked, `set(value)` is an overwrite, and `update(fn)` appends a
  functional operation. `effect` starts on observed 0-to-1 and its cleanup
  runs on 1-to-0; both edges are microtask-damped.
- `new Computed<T>({fn, isEqual?, label?})` is lazy and cached in K0. In a
  render view it is evaluated at most once per pass. `ctx.previous` is the
  last successfully committed result for that lineage/root, or `undefined`.
  `ctx.use(thenable)` uses the positional resource rule in M7. Throws and
  suspensions are reference-stable sentinel boxes, so graph finalization runs
  in `finally` and a getter cannot strand a re-track cursor.
- `new ReducerAtom<S,A>({state, reducer, isEqual?, label?})` stores actions on
  the tape. Its constructor reducer is immutable. The hook form may receive a
  new reducer per render; a pass replays all visible queued actions with the
  reducer supplied by that render, exactly as `useReducer` uses its rendered
  reducer. The committed pass publishes that reducer and refolds the hook's
  newest K0 state from its uncompacted base/tape before later non-render reads.
- `effect(fn)` observes newest K0 state. With synchronous scheduling it is
  observable before `set` returns; other documented schedulers may enqueue it.
  `batch(fn)` delays only core-effect flushing. It never delays React watcher
  delivery. `untracked(fn)` suppresses dependency edges, not reads.
- `configure({forbidWritesInComputeds, coreEffectScheduler, tracing})` changes
  policy wrappers, never K0's record layout. Signal reads from an updater or
  reducer fold throw in all builds, even through `untracked`; calculate first
  and call `set` if a fold needs an external value. This makes replayed
  callbacks pure and pins O15.
- `useSignal`, `useAtom`, `useReducerAtom`, `useComputed`, and
  `useSignalEffect` require the fork protocol. Stock React or a protocol
  version mismatch throws during module initialization. `useSignal(signal)`
  returns the render-view value and installs a watcher on commit; `useAtom`
  and `useReducerAtom` create one stable staged-then-promoted instance from
  their constructor options; `useComputed` does the same for a render
  function; `useSignalEffect` installs a committed-view effect. No provider
  is used.
- `startSignalTransition(fn)` delegates to the fork's transition entry and
  returns its status. It is a throughput convenience, not a different
  visibility model. There is no truncation/rollback API in v1.

`useComputed(fn, deps, opts)` stages `fn` and `deps` in the pass. They become
the K0 version only if that pass commits. A replaced function gets a new
`fnVersion` and participates in M5/M7. A render-created node remains a staged
scratch node until commit; abandoned passes reclaim it by resetting their
scratch watermark. Thus StrictMode and interrupted mounts do not leak arena
records.

### 1.2 Equality, writes, and effects

K0 retains donor push-pull semantics and exact equality cutoffs. The ACTIVE
React delivery path is intentionally value-blind: a reachable committed
watcher can over-render, but cannot miss a batch. Custom equality is still
used when a pass boxes a result and when retirement reconciliation compares a
watcher's rendered and committed values. SPK-N1 decides whether this
value-blind choice passes; no unmeasured eager cutoff is claimed.

Every React-mode write gets a tape receipt. Even an overwrite equal to K0's
newest value is retained. Functional updaters and reducers may execute more
than once and therefore must be pure, matching React's queue contract.

`useSignalEffect` is different from core `effect`: it stores the values of its
last committed dependency set and runs only after a root-commit or global-
retirement trigger makes at least one committed dependency unequal. Its reads
use that root's committed view. Cleanup precedes a changed rerun and unmount.

## 2. Mechanism inventory (9)

The numbered inventory is: (1) mode-specialized K0, (2) ordered replay
ledger/root registry, (3) full-token content clocks, (4) add-only K1, (5)
immutable pass frames, (6) union reach/change/delivery, (7) committed watcher
lifecycle/fixup, (8) lineage resources/previous, and (9) the fork bridge/batch
registry. For readability below, mechanisms 2 and 3 share the `M2` ledger
implementation group; the clock is labeled `M2-clock` wherever it fires.

### M1. Mode-specialized closed K0

K0 is the full-arena donor kernel: interleaved node/link records, packed
index-aligned value/function columns, exact dynamic re-tracking, iterative
push-pull, and persistent scratch stacks. Closure rebuild selects:

1. `DIRECT`: donor reads and writes, no tape or concurrency load;
2. `QUIET_LOGGED`: donor reads; a write classifies/claims a token, switches to
   ACTIVE, appends M2, then mutates K0; and
3. `ACTIVE`: `renderEnter`/resume selects `ACTIVE_NEWEST` or `ACTIVE_VIEW`
   once from the pass recipe; `renderLeave` selects `ACTIVE_NONRENDER`.
   There is no per-read world-selection branch, and K0's internal
   link/dirty/recompute loops remain unchanged and hook-free.

The transition between modes occurs only at operation boundaries. This uses
the measured closure-rebuild shape and keeps SPK-H hooks and SPK-Q's branch out
of DIRECT/quiet reads. The closure-constant and operation-boundary choice cites
[GUIDE]; it is not a new measurement.

### M2. Ordered replay ledger and root registry

Each atom's tape is an arena list of fixed records. The same record is also
intrusively linked from its token so retirement and mount fixup can enumerate
the token's source atoms without a second allocation:

```text
{ writeSeq, token, opKind, payloadIndex, retiredAt,
  nextForAtom, nextForToken }
```

`eventSeq` is incremented before every write, retirement, function/policy
replacement, and thenable settlement. Only writes and retirements produce tape
fields; the other events provide ordered M5 stamps. A pass samples
`writePin = eventSeq` and `retirePin = eventSeq` on entry; the distinct fields
make the two visibility clauses explicit even though one atomic sample
initializes both. For a view `V`, entry `e` is visible exactly when:

```text
e.writeSeq <= V.writePin &&
(V.includes(e.token) || (e.retiredAt !== 0 && e.retiredAt <= V.retirePin))
```

Visible operations fold from the atom's base in `writeSeq` order. `set`
replaces the accumulator, `update` calls the pure updater, and a reducer action
calls the view's staged reducer. This is the only world arithmetic.

The root registry stores sorted arrays of full tokens in `locked[root]`; no
slot bit is stored. `rootCommit` inserts each committed live token before
effects run. Global retirement stamps all of the token's entries, then removes
that full token from every root array in the same JavaScript turn. New passes
use `forkIncluded union locked[root]`.

Compaction runs only when there is no open pass. It folds the largest
all-retired prefix of an atom tape into its base and reclaims those records.
A live earlier entry blocks a retired later entry, preserving C3 order.
Compaction changes representation but not the fold function and no persistent
world-value key contains tape shape or a fingerprint.

#### M2-clock. Full-token content clocks (inventory mechanism 3)

Each live full-token registry record stores `lastWriteSeq`. Global
`retireClock` stores the latest retirement event sequence. At pass start M4
copies, beside each full included token, that token's `lastWriteSeq`, and also
copies `retireClock`; later writes cannot mutate the copy. This exact
sorted `{token,clock}[] + retireClock` snapshot is the pass's **view revision**.
M7 compares every element—never a hash—when reusing a suspense/error capsule.
A write in an included token changes the next pass's revision; an excluded
token does not; retirement conservatively changes every later revision. There
are at most 31 pairs, no slot index, and no recyclable mask.

### M3. Add-only K1 union graph

K1 is a separate arena plane with node headers and dependency links only.
Whenever M4 evaluates `node` and reads `source`, it ensures the edge
`source -> node` exists in K1. Edges are never removed during an episode, so
K1 is the union of real dependency paths observed in all non-newest views,
not a guessed sensitivity mark. M5 traverses outgoing links from both K0 and
K1. Edge insertion also catches up the target input stamp to the source's last
change sequence and propagates that stamp through all existing outgoing edges;
if the source changed after the evaluating pass's pin, the frame records its
token for a completion-time interleaved update. At full quiescence—no live
token, pass, completed-pass frame, or lineage resource—every K1-touched node
with a committed watcher is first refreshed through newest K0, so K0 holds its
real next-episode dependencies. K1 is then bulk-reset and `episode` increments.
If such a refresh performs a legal computed write, quiescence has ended and
the reset aborts until the resulting batch retires.

The exception is a staged node with no permanent id: edges touching it remain
in that M4 frame's scratch adjacency and are not linked into K1. M5 includes
the scratch adjacencies of open/completed frames in its union traversal. The
winning commit promotes the node and merges those exact edges into K1;
discard resets them with the frame. No permanent plane pointer can target an
abandoned staged id.

### M4. Immutable pass frames and transient evaluation

`renderEnter(start)` allocates a frame from preallocated scratch with:

```text
{ passId, rootId, lineageId, episode, writePin, retirePin,
  includedTokens, viewRevision, policyVersion,
  memoTable, stagedNodes, stagedPrevious, catchupTokens }
```

The include table is a scratch open-addressed table of full token integers;
M2-clock captures its exact clocks and retirement clock in `viewRevision`.
`ACTIVE_VIEW` atom reads use M2; `ACTIVE_NEWEST` atom reads use K0 because no
event can interleave until a render-leave edge changes the closure. Computed reads use the frame memo or evaluate once, recording
M3 edges. Memo states are EMPTY/EVALUATING/DONE; reading EVALUATING throws the
same cycle error as K0. No other pass can read the memo. `renderLeave(yield)` detaches the
frame from the callstack but retains it; resume reattaches it. Complete frames
are retained read-only until the fork names the winning `passId` at commit;
discarded/losing frames reset their watermarks.

After `renderLeave(complete)` has cleared render callstack truth, M4 schedules
each provisional or committed watcher read by the frame into every recorded
catch-up token. React treats these as interleaved updates and cannot commit the
just-completed stale pass. If `runInBatch` reports that the token retired, M4
uses an urgent dispatcher call instead. A fresh hook's ordinary `useState` dispatcher is
kept in the frame for this purpose; it is not installed as a global
subscription before commit.

At render enter/resume, M4 selects `ACTIVE_NEWEST` only when the frame includes
every live record and `eventSeq === frame.writePin`; otherwise it selects
`ACTIVE_VIEW`. Inside `ACTIVE_NEWEST`, a node may use K0 only when its stable
function is in force and K0 can return a clean cache without recomputation.
The returned box is copied into the frame memo before user code receives it.
Otherwise M4 evaluates without mutating K0. Hook-local render functions always
use M4. A non-newest view always uses M4, so there is no flag-based routing
theorem.

### M5. Unified reach/change/delivery walk

Every tape write runs an iterative, allocation-free traversal from its atom
over the union of K0, K1, and retained-frame staged outgoing edges. Every reached computed receives a
fresh `inputStamp=eventSeq`; every reached committed watcher has its React
setter called synchronously before the writer returns. A per-walk visit ticket
prevents diamond duplicates, but there is no state retained across writes or
tokens. Thus T1 and T2, and two writes in one batch, each run a complete walk.
When the terminal is an uncommitted provisional watcher, M5 records the
writer's token in that frame's `catchupTokens` instead of dispatching to an
unmounted fiber; M4 dispatches it immediately after a successful render leave.

Function replacement starts at the replaced node. Thenable settlement starts
at the settled node, leaves that node's input stamp unchanged, advances its
result stamp, and advances input stamps downstream; this preserves the
settled thenable's identity while invalidating consumers. Retirement starts
from every distinct atom touched by the token and is also the independent
committed-observer trigger required by I14.

When M3 adds an edge whose source has a later change sequence than the target,
the same traversal propagates that existing sequence from the target through
all K0/K1 out-edges. This is a stamp catch-up, not a new semantic event. It is
transitive and records a post-pin token in the current frame as described in
M4, so a path discovered after a write cannot validate an old positional
resource or let the current pass commit stale.

### M6. Committed watcher lifecycle and fixup

A watcher contains its setter, root id, subscribed node, last-rendered boxed
value, and committed dependency/value snapshot for `useSignalEffect`.
Subscription edges change only in layout commit. Observation 0-to-1/1-to-0
uses one microtask ticket so a StrictMode unmount/remount flap nets to one.

At layout subscription, fixup does two checks:

1. For each currently live token, scan its intrusive M2 record chain and start
   one visited union reach query from its written atoms. If any reaches the
   subscribed node, call `runInBatch(token, setter)` without comparing a
   per-token value.
2. Independently evaluate the node in the current committed-for-root view and
   compare it with `lastRendered`. If different, issue an urgent layout
   correction before paint. This check runs even when the live-token list is
   empty or `runInBatch` loses a retirement race.

At root commit, M6 publishes values from the named completed frame and flushes
root effects. At retirement, it reconciles reached watchers against each
root's committed view; already-correct watchers are not scheduled.

### M7. Lineage resources and committed `previous`

For position `p` of `ctx.use` in node `n`, the resource identity is:

```text
(episode, lineageId, n, fnVersion, policyVersion, p, exact viewRevision)
```

The first evaluation stores the supplied thenable; later evaluations with the
same identity return that exact object. A write in any included full token
changes the next pass's exact M2-clock revision; a retirement changes its
retirement clock; function/policy replacement changes an explicit version.
The old pass owns its copied revision, so a later write cannot change its key.
The record stores `{thenable, settledAt, status, result}`. Settlement sets
those fields with a new event sequence but does not change the identity.
A frame treats the resource as pending when `settledAt===0` or
`settledAt>frame.writePin`; otherwise it returns/throws the recorded result.
Thus an old pinned pass still throws the same identity while a retry observes
that same now-settled identity. Downstream nodes are invalidated by the
settlement walk. NEWEST uses a distinguished lineage key; crossing once into
a render lineage can create one alternate positional record, but pure retries
cannot create more.

M7 also retains a **sentinel capsule** for a node that suspended or threw,
under the same identity. While pending, M4 throws the capsule without invoking
the node function again. After settlement, exactly one retry
re-evaluates; its successful box is held in the capsule until commit,
view-revision/function/policy change, or lineage end, so StrictMode replay cannot initiate
another fetch. A normal computation that never suspends has no cross-pass M7
value.

For each `(lineage,node,function,policy,position)`, M7 retains the newest
revision capsule plus capsules referenced by an open/completed pass. Once a
newer revision exists and no frame references an older one, that older record
and payload cell are reclaimed; a late promise ping may still wake React but a
new pass can only request the current copied revision. This bounds storage by
latest suspended identities plus actual retained pass revisions, not writes
over the lineage's lifetime.

`ctx.previous` reads a root/lineage seed plus pass-local staged successes.
Only the completed frame named by `rootCommit` publishes those successes.
Suspended, throwing, yielded, replayed, or discarded frames cannot change
published previous values. `lineageEnd` releases thenables and unpublished
state; episode reset is the final guard.

### M8. Versioned fork bridge and batch registry

M8 owns token minting, async continuation context, render/root/lineage events,
and lane-scoped scheduling. It never exposes fibers, lane bits, or update
queues. Its exact nine touch-points are in section 5.

A token is `serial * 2 + deferredBit`; the safe-integer serial is skipped while
retained and the low bit makes classification auditable without exposing a
lane.

An external-work claim participates in the same pending count read by
`useTransition`. It opens on the first signal write in the scope and closes at
token retirement, so signal-only, mixed React/signal, and async actions expose
the same pending interval as their React work.

Orthogonal wrappers, tracing, schema generation, and arena growth are required
implementation substrate, not additional cooperating concurrency mechanisms.

## 3. Constructions and invariants

### 3.1 Replay invariant

**Claim.** M2 gives the same accumulator as a React update queue for any view.

Base: before the first tape record, both systems return the atom base. Step:
consider the next record in global write order. If its batch is excluded and
not retired by the view's pin, both systems skip it while retaining it for
rebase. Otherwise both apply the same overwrite, updater, or rendered reducer
to the same inductive accumulator. Therefore every prefix agrees, including a
later included update after a skipped one. Prefix-only compaction substitutes
the already-proven fold of an all-retired prefix for its base and leaves the
induction over the suffix unchanged.

### 3.2 Pass immutability invariant

Base: pass start samples both pins and the full-token include set before its
first read, including M2-clock's copied view revision. Step: a pass read consults only those immutable fields, immutable
tape records at or below the pins, and its own memo. A later write has a larger
sequence; a later retirement has a larger retirement stamp; neither satisfies
the pinned predicate. M3 can gain edges and K0 can change, but neither is a
value source for an existing non-newest memo. A clean K0 fast result is copied
into that memo and the fast path closes as soon as `eventSeq` differs from the
pin. A thenable settlement after the pin remains pending to this frame by M7's
`settledAt` check. While `ACTIVE_NEWEST` executes, JavaScript cannot interleave
another event; render-leave swaps the closure before handlers run, and a
changed resume uses M2 to reconstruct the old pinned atom value. Thus every
read in one pass has one view across yields.

### 3.3 Divergent-edge reach invariant

For a computed evaluated in view `V`, every source actually read is linked to
it in K1 before evaluation finalization.

Base: before a node's first V-evaluation it has no V-cache that could become
stale. During that evaluation every tracked source read inserts its K1 or
frame-staged edge before
the source value is returned. Step: after evaluation, any later write to one of
those sources starts M5 at the source and traverses that K1 edge, then all K0
and K1 outgoing edges transitively. Dynamic re-evaluation may add a different
edge but never removes the old one during the episode, so over-reach grows and
under-reach does not. If a branch-changing write occurs before the first
V-evaluation, the first-divergence induction applies: the first differing atom
was read by the canonical evaluation, so K0 reaches and schedules the node;
its resulting V-evaluation then installs the later divergent edges.

### 3.4 Resource validity invariant

Base: a lineage position has no resource before its first successful call to
`ctx.use`. The call stores the capsule under the frame's exact full-token clock
snapshot, retirement clock, function/policy versions, and lineage. Step for a
write: if its token is included, the next pass copies a larger clock and cannot
match; if excluded, that write is not a view input, and its later retirement
changes `retireClock`. This remains true even when the dependency edge is first
discovered after the write, because validity is token-clock coarse rather than
read-set-derived; M3 catch-up separately supplies delivery. Function, reducer,
or policy replacement changes an explicit key version. A changed root include
set changes the exact token vector and fork lineage. Settlement changes the
stored resource state but not identity; `settledAt` prevents an older frame
from seeing the future status. Compaction preserves the proven replay
function, and committed `previous` publication ends or changes the lineage.
Thus every mutable evaluation input either changes the exact revision/version
or is pinned inside the capsule, with no per-read certificate.

### 3.5 Root consistency invariant

Base: a registered root starts with no locked tokens and renders globally
retired state plus the fork's include set. Step at root commit: tokens rendered
by the winning pass are inserted into that root's full-token array before any
effect or new pass. All later views for the root include them. Step at global
retirement: entries receive a retirement stamp before the tokens are removed
from root arrays, so a later view moves from the include clause to the retired
clause without a gap. Therefore a root cannot stop seeing a batch it has
committed.

### 3.6 Episode/counter invariant

Every retained cross-operation identity includes `episode`, uses a full live
token, or is explicitly cleared before reuse. At quiescence all tape entries
are compacted, K1/pass/resource arenas are reset, root token arrays are empty,
and `episode` increments before `eventSeq`, token serials, or input stamps may
restart. Thus the base episode has no old retainer; the reset step changes the
generation checked by every surviving wrapper before a reused integer can
match. Mid-episode saturation never wraps: the next operation throws before
mutation unless quiescence can perform the reset.

## 4. Closed change-source audit

There is no general reusable successful non-newest value memo and no tape
fingerprint. The narrowly retained M7 sentinel capsule uses the closed key and
ordered settlement state specified above. The table enumerates every event
that can change an evaluated outcome:

| source | M2/M2-clock action | M5/M7 action | committed-observer action |
| --- | --- | --- | --- |
| atom `set`/`update`/action | append before K0 mutation; set token `lastWriteSeq` | stamp all reached inputs; edge insertion later catches missed paths up; writer-context setters | defer `useSignalEffect` to commit/retire |
| token retirement | stamp on event number; advance `retireClock`; optional safe prefix compaction | restamp cones of token-touched atoms | reconcile every root; flush effects |
| root lock-in | add full token before observers; next frame's exact vector changes | old lineage ends; no global stamp needed | publish named pass; flush that root |
| computed/hook fn replacement | none | stamp node and downstream; key contains `fnVersion` | publish only if pass commits |
| reducer replacement | winning commit refolds newest base/tape with rendered reducer | same version/stamp rule as fn replacement | pass folds with rendered reducer |
| thenable fulfillment/rejection | event sequence only; no view-revision change | retain capsule identity, set `settledAt`, advance result/downstream inputs | React ping plus reached-observer reconciliation |
| `ctx.previous` publication | none | publication occurs only at commit; next evaluation still needs an external input change | root-local value is the seed |
| custom equality/config replacement | none | version policy wrapper and stamp node | compare using the version rendered |
| tape compaction | logical fold unchanged | no key contains shape/fingerprint; no action | none |
| episode reset | clear all history first | clear K1/resources, then bump episode | root arrays already empty |

The set is closed because a computed result is a pure function only of its
visible atom fold, rendered function/reducer and policy, committed `previous`,
and statuses of thenables supplied at its positions. Each member appears in a
row. No other mutable input is legal: updater signal reads and render writes
throw.

## 5. `fork-protocol` (9 semantic touch-points)

The package feature-detects protocol major version 1 and fails loudly on stock
React. All ids are branded safe integers; arrays contain ids, never lanes.

1. `installBridge(version, sink) -> api` installs one listener and returns the
   callable half. Inert fork sites perform one `sink === undefined` check.
2. `api.classifyAndClaimWrite() -> {token, deferred}` returns the exact current
   synchronous or async-continuation batch and lazily gives that token one
   external-work claim. Repeated writes in the scope return the same token.
3. `api.runInBatch(token, fn) -> boolean` executes `fn` under that live token's
   lanes and returns false, without calling `fn`, if retirement won the race.
   An update queued after render completion but before commit invalidates that
   completed pass before host mutation; this is part of the protocol, not an
   assumption about current work-loop timing.
4. `sink.renderEnter({passId, rootId, lineageId, includedTokens, start})`
   starts or resumes render-callstack truth. `start` is true only for the fresh
   stack; included tokens are supplied then.
5. `sink.renderLeave({passId, reason})`, where reason is `yield`, `complete`, or
   `discard`, clears callstack truth on every exit and manages M4 lifetime.
6. `sink.rootCommit({rootId, passId, tokens})` is edge-triggered where React
   already records committed lanes. It names the winning completed pass and
   all live tokens whose work that root committed.
7. `sink.retire({token, committed})` fires exactly once after the scope closes,
   all participating roots finish/abandon, and every returned async-action
   thenable settles. `committed` is diagnostic; M2 persists either value.
8. `sink.lineageEnd(lineageId)` fires once React can neither retry nor commit
   that lineage and releases M7 state.
9. `sink.mutationWindow(open)` brackets DOM mutation for tracing and any
   future dev assertion; it does not participate in visibility.

### 5.1 Async continuation construction

The fork's batch registry stores a dynamically scoped token in a continuation
carrier. Every async resource created while an action callback runs captures
the token; immediately before its continuation executes the carrier pushes
that token, and `finally` restores the prior token. Native promise reactions,
`queueMicrotask`, and platform task callbacks use the fork runtime's host
async-context hook; Node uses `AsyncLocalStorage`. The browser build requires
the bundled PromiseReaction/host-callback hook and fails its startup self-test
instead of silently running without continuation identity.

Base: the synchronous prefix runs with the token pushed by `startTransition`.
Step: scheduling a continuation copies the current token; invoking it restores
that exact copy for its dynamic extent. Two concurrent actions therefore carry
different tokens through interleaved settlements, while an unrelated click
pushes its own event token and restores the parked action afterward. A token's
external claim is released only when the returned action thenable settles, so
store-only actions cannot retire early.

### 5.2 Fork-owned tests

1. lazy token mint/claim, stable within a scope, unique while live;
2. default, discrete, sync, transition, and nested classification, plus
   `useTransition` pending state for signal-only/mixed work;
3. render enter/yield/handler/resume/complete ordering and callstack truth;
4. exact included-token arrays on restart and partial-lane renders;
5. root commit names the winning pass and precedes layout/passive observers;
6. spanning token commits A then B, locks each root, retires exactly once;
7. store-only close and `committed=false` retirement;
8. async action remains live across await; two actions interleave without
   token exchange; unrelated click/timer contexts do not inherit either;
9. `runInBatch` joins the original lanes, invalidates a completed-not-committed
   pass, and returns false after retirement;
10. lineage id stable across replay/retry, changes with logical batch set, and
    ends exactly once;
11. mutation-window edges bracket host DOM writes;
12. protocol absent/version-skew failures and listener-null inert sites.

The proposed, unmeasured fork-size target is at most six production files, 450 added/changed production
lines, and 700 reconciler-test lines. Its four new maintained concepts are the
token/external-claim registry, integer pass/root/lineage adapters, the
continuation carrier, and the installed bridge. Hook sites are only the
existing transition/event classifier, work-loop enter/exit/yield edges,
root-commit bookkeeping, batch close/retirement, and host mutation brackets;
each is edge-triggered where React already changes the corresponding fact.

### 5.3 Rebase drill

If React renames lanes, moves commit phases, or changes update queues, no
signals-library type or algorithm changes. The fork re-identifies the existing
edge-triggered sites that implement the nine facts, updates its adapter and
tests, and continues to emit integer tokens/pass/root/lineage ids. Only a
semantic React change—such as redefining which updates a pass includes—requires
a protocol-version change and a corresponding M2 visibility review.

## 6. Layout, allocation, lifecycle, and tracing

K0 uses one interleaved Int32 plane for nodes and links and packed, never-holey
`unknown[]` value/function columns. K1 uses a separate interleaved edge plane;
placing world fields in K0 is forbidden. Buffers are closure constants and
growth rebuilds closures only at operation boundaries. Fast-path functions
have bytecode budgets below the measured 460/callee and 920/cumulative limits;
same-file non-exported const enums are mandatory. These choices cite the
interleaving, full-arena, closure-binding, bundler, and inlining measurements
in [RESEARCH][LINKS][GUIDE], rather than extrapolating new numbers.

The workspace is pnpm/TypeScript. Public and internal shapes use `type`, ids
are branded, absence is `undefined`, and any unavoidable `null` at a React API
boundary is commented. Development checks are guarded by compile-time
`__DEV__` defines, never a runtime constant.

Tape, K1, pass memos, include tables, traversal stacks, and lineage entries are
arena/pool allocated. After warm capacity, a write, traversal, render read, and
rerender allocate no engine object. Payload references occupy packed side
columns and reclaimed cells are overwritten with `undefined`. Staged nodes are
promoted only for the pass named at commit; abandonment resets a watermark.

Counter inventory:

| counter/id | retained by | reset/clear rule |
| --- | --- | --- |
| fork token serial | tape, root arrays, fork registry, pass/M7 revisions, K1/source last-change metadata | live-skip allocator; reset only at joint quiescence after all listed retainers clear and episode bumps |
| `eventSeq` | tape write/retire fields, node input stamps, open pass pins | increments for every semantic source; never wraps live; reset only after no pass and all tapes compact, with episode bump |
| token `lastWriteSeq` / global `retireClock` | token registry, pass revision copies, M7 capsules | full token record clears only after retirement/lineage release; frame/capsule copies clear at pass/lineage death; episode guards reuse |
| `episode` | frames, K1 ids, resources, wrappers | safe-integer saturation is a fatal startup/restart error; ordinary increments at quiescence |
| pass/root/lineage ids | fork and frames/resources | fork never reuses live; resources cleared at lineage/root death; forced-small allocator skips retained ids |
| M5 walk ticket | visit column during one synchronous walk | at horizon, clear whole visit column between walks; no visit stamp is consulted outside a walk |
| node input/result stamp | K1 catch-up and completed frames | values are event sequences; reset only after K1/frame clear plus episode bump |
| arena generation | staged/promoted wrapper handles | dereference checks `(episode,generation)`; a saturated slot is quarantined until episode reset, never wrapped; forced-small test covers it |
| observation microtask ticket | atom wrapper closure | monotonically compared only within closure; replace closure/ticket before safe-integer horizon |

Tracing is a lazily imported module. Each instrumented site performs one
recorder-slot check. A fixed ring overwrites old events; a lossless session
uses preallocated chunks and refuses start without reserved capacity. Events
carry episode, seq, token, pass/root/lineage, node and causal-parent ids.
Causality queries walk write -> reach -> setter -> pass -> commit/retire edges;
Graphviz renderers operate off-line. Untraced execution allocates nothing.

SSR runs DIRECT against serialized `{atomId, value}` bases. Hydration installs
the bridge only after bases are restored and before the first root render.
RSC/Flight is out of scope.

## 7. Cost model and numeric gates

The donor measurements are evidence for K0's layout, not a claim about new
paths: deep 0.90x, broad 0.84-0.88x, diamond 0.89x, reads 0.74-0.87x, and
creation 0.96x versus alien-signals, with 179/179 and exact pulls
[ARENA][SYNTH section 18.2]. Every new number below is an acceptance gate or
explicit spike. Benchmarks run one framework per process because shared
feedback has measured distortions up to 3x [RESEARCH].

| path | asymptotic/constant work | gate |
| --- | --- | --- |
| DIRECT read/write/recompute | exact donor path; zero concurrency-mechanism instructions | at-or-below alien-signals v3 on every tier-0; 179/179 plus growth and exact pulls |
| QUIET_LOGGED non-render read | exact K0 closure, no routing branch | <=1% donor on tier-0 |
| first React-mode write | one fixed tape record + K0 write + union reach | SPK-W <=2x DIRECT isolated write |
| ACTIVE_NEWEST clean render read | world closure chosen at enter, then K0 clean load + frame memo | React-mounted quiet <=2%; held-transition quiet-read spike |
| non-newest computed read | once-per-pass evaluation, O(actual deps), K1 edge ensure | **new SPK-L1**: signal rerender <=1.10x equivalent useState across deep/broad/diamond and concurrent-store harness |
| write delivery | O(unique K0-union-K1/staged reachable nodes + retained frames + watchers) | SPK-N1 <=2x DIRECT propagation and <=1 spurious render/(watcher,batch) |
| late mount fixup | <=31 token reach queries + one committed evaluation | 10k subscription mount <=1.15x useState; report 1/8/31 live-token grid |
| compaction/reset | O(retired prefix) off read hot path | amortized <=1 fixed tape record reclaimed per retired record; 99p frame budget reported |
| steady rerender | pool resets, no engine allocations | zero engine allocation; report heapUsed and plane bytes separately |

SPK-L1 is pre-registered one-framework-per-process on V8 and JSC, with 1, 2,
8, and 31 live batches, yield/restart, and expensive-computed variants. Failure
of SPK-L1 or the 10k mount gate rejects this nine-mechanism architecture; a
persistent world memo or touched-cone index is not smuggled in as a local fix.
Kairo's measured <=1.4x ceiling remains the honest ceiling and <=1.25x remains
a target, not an assertion.

## 8. Correctness battery

### C1: a pending branch acquires a non-canonical dependency

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | setup/M1 | K0 has `flag=false,a=0,b=0,c=0`; K0 edges are `flag->c,b->c,c->W`; K1 is empty |
| 2 | k writes `flag=true`/M2,M1 | append `(seq1,k,set true)`; K0 newest flag is true and c is dirty |
| 3 | M5 | union walk follows K0 `flag->c->W`; `c.inputStamp=s1`; W setter runs synchronously in k, so React queues k lanes |
| 4 | optional k pass/M4,M3 | frame `{k,pin=seq1}` folds flag=true and a=0, evaluates c=0, adds K1 `flag->c,a->c` |
| 5 | k writes `a=1`/M2,M1 | append `(seq2,k,set 1)`; K0 newest a is 1; committed-for-root still excludes k |
| 6 | M5 | union walk now follows K1 `a->c`, stamps c, and calls W's setter again in k; any old frame remains pinned at seq1 |
| 7 | replacement pass/M4 | pin seq2, include k: `c=flag?a:b=1`; a committed/excluding pass folds flag=false,a=0,b=0 and gets c=0 |

outcome: the divergent edge is real before the later write and W joins k before
commit; the committed view never reads a K0 value for this non-newest pass.

residual risk: an omitted K1 edge insertion or union-walk leg; C1 plus a dev
edge oracle compares every pass read set with K1 after finalization.

#### C1 variants T2-T7

| variant step | actor/mechanism | state touched |
| --- | --- | --- |
| T2 | k writes committed-only `b` | K0 edge may over-notify c; k frame follows flag->a and still yields 1; no wrong value |
| T3 | k sets `flag=false` | receipt seq3; M5 reaches by both planes; next k frame follows b and records/retains both historical K1 branches |
| T4 | urgent U writes `b` | receipt is included/retired according to pins; k's true branch ignores b; over-notification cannot alter its fold |
| T5 | urgent U writes `a` | after U is included or retired, k's replay sees U in seq order; K1 `a->c` schedules k again and c sees the urgent value |
| T6 | k retires and system quiesces | tape compacts, K1/resources clear, episode increments before integer reuse; no old edge/cache key validates |
| T7 | passes include `{t1,t2}` and `{t1}` | each gets independent pins/include table/memo; K1 unions both actual read sets; root commit locks only t1; t2's suspended lineage/resource remains separate |

outcome: all seven family members use replay for values and the add-only union
only for conservative reach; neither can substitute for the other.

residual risk: multi-batch include-set transcription; fork tests 4/6 and the
randomized replay oracle pin it.

### C2: `flushSync` excludes a pending default batch

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | D writes `a=1`/M2 | append `(seq1,D,set 1)` before K0 becomes 1; mode is ACTIVE |
| 2 | M5 | watchers are scheduled in D's default lanes |
| 3 | Sync pass/M8,M4 | fork includes Sync but not D; frame pins seq1 and its include table lacks D |
| 4 | atom read/M2 | D is live and excluded, so a folds from base to 0 |
| 5 | computed read/M4 | view is non-newest, so it cannot use K0's newest cache; scratch evaluates `c=0+10=10` and records `a->c` in K1 |

outcome: the same frame returns `a=0,c=10`; always-log supplies the excluded
history and transient evaluation prevents a canonical-cache leak.

residual risk: an incorrect newest fast-path predicate; C2 asserts both sibling
values and a dev assertion forbids K0 service to a non-newest frame.

### C3: skipped deferred updater rebases around urgent updater

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | T `update(+1)`/M2 | base=1; append `(seq1,T,+1)`; K0 newest becomes 2 |
| 2 | U `update(*2)`/M2 | append `(seq2,U,*2)`; K0 newest becomes 4 |
| 3 | urgent pass/M4,M2 | include U, exclude live T: skip seq1, apply seq2 to base 1 => 2 |
| 4 | U retires/M2 | `seq2.retiredAt=seq3`; seq1 is a live earlier prefix so compaction cannot move seq2 into base |
| 5 | T pass/M4,M2 | include T and see retired U: apply seq1 then seq2 => `(1+1)*2=4` |
| 6 | T retires/compaction | both-record prefix is retired; fold once to base=4 and reclaim it |
| 7 | overwrite variant | tape `(+1 T),(set 5 U)` folds to 5 in any view containing/retiring both, never 6 |

outcome: every frame matches `useReducer`/`useState` queue arithmetic at each
step because operations are filtered but never reordered.

residual risk: reducer identity or illegal updater reads; differential tests
replace reducers per pass and assert the all-build fold-read error.

### C4: a second batch writes an already-stale region

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | T1 writes a/M2,M5 | receipt T1; full union walk; W setter called under T1 |
| 2 | no render occurs | K0 may remain dirty; M5 retains no cross-write armed/dedup state |
| 3 | T2 writes a/M2,M5 | second receipt; a fresh walk ticket traverses the same cone; W setter called under T2 |

outcome: React has updates for W in both lane sets regardless of K0 staleness.

residual risk: accidental notification dedup added for speed; C4 asserts two
setter invocations and their distinct fork tokens.

### C5: an equal first write cannot block an effective second write

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | k writes `a=1` | M2 logs; M5 walks `a->c->W`, advances input stamp, and may over-render W even though c remains b |
| 2 | walk ends | its visit ticket is dead; no node remains armed for k |
| 3 | k writes `b=7` | M2 logs; a fresh M5 walk follows `b->c->W`, stamps again, and calls W's setter in k |
| 4 | k pass/M4 | replay gives a=1,b=7; c evaluates 7 |

outcome: the architecture deliberately chooses value-blind over-notification
for step 1, but the required effective second delivery and value are present.

residual risk: SPK-N1 may reject the over-render cost; correctness is pinned by
C5 and the architecture is rejected, not patched with once-stale dedup.

### C6: nested transition inside engine `batch`

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | outer `batch` begins | only core-effect flush depth increments; no React delivery queue opens |
| 2 | `a.set(1)`/M8,M5 | classify returns urgent/default token A; receipt and setter calls happen immediately in A context |
| 3 | `startTransition` then `b.set(2)` | continuation carrier/current scope returns T; receipt and setter calls happen immediately in T context |
| 4 | transition and outer batch close | T and A React updates already have correct lanes; outer close flushes newest core effects only |
| 5 | legal forms | `startTransition(()=>batch(...))` classifies all writes T; unbatched transition writes classify T; `startSignalTransition` uses the same entry |

outcome: mixed contexts are handled; no grouped drain exists, implicit or
explicit, so lane attribution cannot be lost.

residual risk: a future batching optimization; C6 records setter call tokens
at the call site and forbids a binding-owned delivery queue.

### C7: handler activity in a yielded render gap

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | transition pass starts/M8,M4 | frame P pins its two sequence bounds and attaches to callstack |
| 2 | fork yields/M8 | `renderLeave(yield)` detaches P; P scratch and pins remain |
| 3 | click reads a/M1 | no render frame is attached, so read uses newest K0, not P |
| 4 | click writes a/M8,M2,M5 | classify returns click token U; receipt is sequenced after P's pins; union walk calls setters under U; write is legal |
| 5 | fork resumes P | `renderEnter(start=false)` reattaches P; prior memo and later first reads use old pins, excluding the new write unless it was already in P's immutable include/pin recipe |

outcome: the handler sees/writes newest state while the resumed pass remains
internally consistent.

residual risk: a missing scheduler exit edge; fork test 3 forces a real event
between yield and resume and asserts library context at each point.

### C8: equality cannot erase a necessary receipt

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | T sets 1 | append T receipt; K0 newest 1 |
| 2 | U sets 1 | append U receipt even though K0 already equals 1 |
| 3 | U-only pass | skip live T, apply U overwrite to base 0 => 1 |
| 4 | T abandons/retires false | M2 stamps and persists it; U receipt independently continues to produce 1 |
| 5 | two-transition variant | T1-only and T2-only views each apply their own overwrite; combined view applies both and remains 1 |

outcome: equality is never a write-time deletion in React mode, so every
world has its own operation.

residual risk: a tempting equal-write fast path; C8 asserts tape length and
all three subset folds, not only newest value.

### C9: existing and fresh nodes mount mid-transition

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | k writes atoms | M2 receipts exist and M5 schedules existing watchers |
| 2 | k pass mounts existing reader | M4 folds k's view on first read, ignores any non-newest K0 value, and adds actual K1 edges |
| 3 | `useComputed` creates fresh node | node and source adjacency live in pass scratch; its first evaluation uses the same frame and M5 can scan those edges while retained |
| 4 | pass completes/commits | fork names passId; staged node is promoted, exact staged edges merge into K1, previous value publishes, watcher subscribes |
| 5 | pass abandons instead | watermark reset reclaims staged node and links; no permanent K0/K1 arena record remains |

outcome: both nodes return k's value on their first render without a canonical
round trip, and abandoned fresh nodes do not leak.

residual risk: promotion copying the wrong pass; StrictMode and interrupt
loops assert generation, winning passId, and stable first-render value.

### C10: a late subscription joins the pending batch

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | k writes a before W exists | M2 records k; K0/K1 reach may have no W, which is allowed |
| 2 | W mounts in another view | completed frame records `lastRendered`; layout commit installs W on its node |
| 3 | M6 reach fixup | scan k's written atom a; K0-union-K1 reaches W's node, so equality-blind fixup calls `runInBatch(k,W.setter)` |
| 4 | fork scheduling | call succeeds while k is live; correction uses k's exact existing lanes, not a newly minted transition |
| 5 | retirement race variant | if step 3 returns false or k vanished from the live scan, the independent committed-for-root evaluation differs from `lastRendered`; layout setter runs urgently before paint |

outcome: in the ordinary race there is one k commit containing its data and
W's correction; in the won-retirement race the root receives a bounded urgent
pre-paint correction.

residual risk: reach-query cost and commit ordering; O11's 1/8/31-token mount
grid and a paint observer pin both.

### C11: full multi-root support with per-root lock-in

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | spanning k writes | one full token and tape receipts; fork associates work with roots A and B |
| 2 | A renders/commits k | rootCommit names A's pass; M2 inserts full k in `locked[A]` before M6 effects; B has no lock |
| 3 | later A render/effect | include set unions `locked[A]`, so A and its effects continue to see k |
| 4 | B remains pending | B views include k only when the fork's pass includes it; B's committed effects still exclude it |
| 5 | B commits | full k enters `locked[B]`; B effects now see k |
| 6 | global retirement | entries get `retiredAt=++eventSeq`; only then k is removed from both arrays; future A/B folds include via retirement; callback occurs once |

outcome: cross-root commit times may skew, but each root agrees with its own
DOM throughout and the token retires exactly once.

residual risk: fork root/token bookkeeping; fork test 6 interleaves passive
effects and extra renders between A and B commits.

### C12: store-only and async transitions persist

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | store-only transition sets 5 | `classifyAndClaimWrite` mints k despite zero watchers; M2 appends receipt |
| 2 | scope closes with no React work | fork retires k once, possibly `committed=false`; M2 stamps rather than drops; base compacts when safe |
| 3 | later read | K0 newest and any new committed view return 5 |
| 4 | async action starts/awaits | token q is captured by M8 carrier; set 1 logs q; external claim remains parked |
| 5 | continuation resumes | carrier restores q before set 2; second receipt uses q; two concurrent actions restore their own distinct tokens |
| 6 | returned thenable settles | only now q can retire; both operations persist in sequence order; no subscriber fact is consulted |

outcome: persistence is a property of the ledger and scope lifetime, never of
notification or root work.

residual risk: host async-context coverage; startup self-test plus fork test 8
exercise native await, nested promises, timers, clicks, and interleaved actions.

### C13: counter and id lifecycle cannot cross episodes

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | episode E becomes quiescent | no live token/pass/lineage; refresh K1-touched watched nodes through newest K0, compact tapes, verify root arrays empty, then clear K1/resources/staged arenas |
| 2 | reset/M2-M7 | increment episode to E+1 before restarting event/input/walk counters; arena generations increment |
| 3 | forced collision | test build gives new counters the exact old numeric suffix; resource/frame/wrapper checks include E+1 or new generation, so old references fail |
| 4 | mid-episode horizon | allocator either skips every retained full id or throws before mutation; it never wraps into a live/retained value |
| 5 | walk-ticket horizon | between complete synchronous walks, clear visit stamps and restart; no persistent structure treats the ticket as identity |

outcome: each retained counter has a clear site, generation guard, or no
cross-operation lifetime, as listed in section 6.

residual risk: a new generated column omitted from the retainer table; schema
CI requires a reset/guard annotation and forced-small test for every counter.

### C14: StrictMode and replayed renders

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | render/replay | clean stable K0 results are copied without mutation; dirty/global, hook-function, staged-node, previous, and non-newest work stays in M4 scratch; K1 may retain only semantically hidden over-reach |
| 2 | render write attempt | attached frame is exact callstack truth; setter throws before tape/K0 mutation |
| 3 | discard/replay | first frame watermark resets; no `previous` publishes; the same lineage/view revision throws the M7 capsule without rerunning the function or starting another fetch |
| 4 | double mount cycle | layout unsubscribe schedules observed cleanup by microtask ticket; immediate remount cancels it; net observer count is one |
| 5 | final unmount | no remount cancels ticket; cleanup runs once and arena handle generation invalidates staged ownership |

outcome: replay has no user-observable graph/lifecycle write, render writes
cannot double-fire, and suspense identity is stable.

residual risk: an internal K0 mutation becoming observable through lifecycle;
StrictMode tests count atom starts/cleanups and compare graph/output after
discard. K1 is not inspectable, does not affect observed counts/effects/values,
and can only schedule a later pure render; hook-local functions are never
installed before commit.

### C15: suspension is isolated by world content and lineage

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | k pass evaluates c | M4 folds k; tracked reads install/catch up K1 edges; `ctx.use` position p stores a capsule under `(episode,lineage,n,fnVersion,policyVersion,p,exact viewRevision)` and throws its thenable |
| 2 | component mounts in same transition | same logical lineage and exact token/retirement-clock revision throws the same M7 capsule/thenable without rerunning the fetch and suspends through React `use` protocol |
| 3 | another write | a write in an excluded token leaves this revision unchanged; any intra-k write advances k's clock and invalidates the next pass's capsule, conservatively even when graph-unrelated |
| 4 | promise settles | resource records `settledAt=eventSeq`; an older pinned frame still treats it pending; M5 leaves n's input stamp, advances downstream inputs, and React pings the suspended k lanes |
| 5 | retry | fork preserves lineage and samples a pin after `settledAt`; c reevaluates once, position p returns the same now-settled result, and M7 holds the success through replay; a committed/excluding root view has a different/no resource and never observed k's suspension |
| 6 | multi-batch view | lineage is fork-minted for root x logical `{t1,t2}`; its exact revision contains both full-token clocks plus retireClock, not one token or passSerial |

outcome: identity is stable across pure retries, invalid across included-world
content changes, and settlement becomes visible without leaking worlds.

residual risk: classifying a settlement as input replacement; C15 asserts same
object across settlement and a different object after an included write.

### C16: React effects read committed-for-root state only

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | default D writes | M2/K0 newest move; M5 marks reached effect watcher, but M6 does not execute it |
| 2 | unrelated token retires | M6 builds committed frame for the effect's root; D is live and neither included nor locked, so M2 folds the old value |
| 3 | effect comparison | committed dependency snapshot is equal; effect does not run and remains pending/reachable |
| 4 | D root commits | D enters `locked[root]` before M6 flush; committed fold now contains D, dependency differs, cleanup/run observes new value |
| 5 | core effect contrast | core `effect` is flushed by configured core scheduler against K0 newest and may have observed D before React commit |

outcome: `useSignalEffect` never mistakes newest/applied for committed, while
the core contract stays explicit and benchmark-integrable.

residual risk: consuming an effect-dirty bit at step 2; tests retain the
dependency snapshot until a changed committed fold, rather than using a
one-shot queue bit.

### C17: optimistic truncation is absent

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
| --- | --- | --- |
| 1 | API inspection | no truncate, rollback, abort-write, or mutable tape handle is exported |
| 2 | React abandons work | fork may retire with `committed=false`; M2 still stamps/persists all operations |

outcome: the optional schedule is outside the v1 surface and React abandonment
cannot produce a half-removed batch.

residual risk: later policy demand; adding truncation requires a new design
round and atomic ledger-generation protocol, not a local method.

## 9. Scar schedule walks

### S1: no-log urgent write arithmetic

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | T `+1`, U `*2` | M2 appends both, including urgent U |
| 2 | U-only/T-after-U frames | M2 folds 2 then 4 exactly as C3; C2 can exclude a logged D |

outcome: the identity of S1 is absent; urgent writes are replayable records.

residual risk: equal/urgent fast-path deletion; tape-shape assertions pin it.

### S2: canonical topology claimed for every world

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | k reads branch a | M4 inserts real K1 `a->c` even though K0 has `b->c` |
| 2 | later a write | M5 traverses K1 and schedules c/W |

outcome: K0 is never claimed complete for non-newest dependencies.

residual risk: missed tracked-read hook; pass read-set oracle pins it.

### S3: canonical-only notification bolted onto an overlay

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | non-newest evaluation | it is tracked into K1, not an untracked value overlay |
| 2 | notification | M5 explicitly traverses both planes at every outgoing node |

outcome: the notification graph contains the dependency that produced the
world value.

residual risk: traversal accidentally selecting one plane; a mixed-edge chain
test alternates K0/K1 edges at every level.

### S4: dropping a `committed=false` batch

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | store-only set 5 | M2 receipt exists without a watcher |
| 2 | retire false | `retiredAt` is stamped; no drop branch exists; later fold/base is 5 |

outcome: diagnostic commit status cannot affect persistence.

residual risk: cleanup conflated with policy; fork retirement test asserts
base/tape after both flag values.

### S5: certificates omit not-yet-concurrent atoms

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | k evaluation reads currently ordinary a | read immediately inserts K1 edge regardless of a's tape state |
| 2 | a later gains first receipt | M5 starts at a and follows that pre-existing edge |

outcome: there is no per-read certificate or concurrency-state filter.

residual risk: edge insertion conditionalized for speed; schema/test forbids a
tape-state branch at M3 insertion.

### S6: activation keyed to watcher count

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | bridge installs with zero watcher | mode becomes QUIET_LOGGED permanently, independent of observation |
| 2 | transition writes then mounts first watcher | first write switches ACTIVE and logs before mutation; mount frame/fixup sees it |

outcome: a first watcher cannot predate the receipt it needs.

residual risk: a tree-shaking path bypassing bridge mode; first-watcher
transition test runs production bundles.

### S7: wall-clock render context across a yield

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | yield | `renderLeave(yield)` removes the attached pass immediately |
| 2 | handler then resume | handler uses newest/write context; resume explicitly reattaches old pins |

outcome: context follows executing callstack, not pass lifetime.

residual risk: a new scheduler exit kind; fork test requires every exit path to
balance enter/leave and asserts an empty context between them.

### S8: equality against newest drops an excluded-world write

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | T set 1 then U set 1 | M2 allocates two records despite newest equality |
| 2 | U-only fold | U's own overwrite changes base 0 to 1 |

outcome: equality is never used as receipt existence policy.

residual risk: optimizer coalescing tape records; coalescing is forbidden in
v1 and replay-oracle operation counts pin it.

### S9: reach flag used without cache freshness

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | stale/never-evaluated node in a non-newest pass | M4 always evaluates; no sensitivity flag can route to K0 |
| 2 | newest pass | K0 is used only if its cache is already clean and stable; otherwise M4 evaluates |
| 3 | new dependency | M3 records it before a resource/cache can survive |

outcome: the failed implication `unflagged => canonical` does not exist.

residual risk: widening K0 fast routing; S9 asserts dirty and never-evaluated
nodes take M4 under urgent exclusion and yield-gap schedules.

### S10: per-token equality misses joint divergence

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | t1 writes x1, t2 writes x2 | both receipts and cone edges exist |
| 2 | component subscribes to `x1&&x2` | M6 independently asks whether each token's written atoms reach node; both do |
| 3 | correction | setters join t1 and t2 without evaluating singleton projections |

outcome: the joint `{t1,t2}` divergence cannot be filtered by equal singleton
values.

residual risk: mount cost, not completeness; joint-divergence harness asserts
both `runInBatch` calls.

### S11: a small commit-gate trigger list

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | default-mask retrack/yield-gap sync | pass pins plus M3/M5 handle values and reach; there is no commit gate |
| 2 | retirement mid-pass | both pins exclude the post-pin retirement; compaction waits for zero open pass |
| 3 | spanning first-root commit | full token remains in only that root's lock array until global retirement |

outcome: safety does not depend on detecting a short list of commit hazards.

residual risk: fork emits wrong edge facts; corresponding fork tests 3, 5,
and 6 are rebase gates.

### S12: global queue without a retirement watermark

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | P pins before token retirement | `retirePin` is lower than the later `retiredAt` |
| 2 | P resumes and first-reads another node | M2 still excludes that token unless P included it; compaction cannot run while P is open |

outcome: sibling reads cannot straddle a retirement.

residual risk: treating current retirement state as a shortcut; pass folds are
required to use stored pin fields in production assertions.

### S13: powerset of retained per-world graphs

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | n batches produce many actual include sets | K1 remains one union graph; it does not clone per set |
| 2 | React opens a pass | only that actual pass receives scratch values; discard/commit resets or publishes then releases it |
| 3 | no pass for a subset | no value graph/cache/frontier for that subset exists |

outcome: storage is O(union edges + concurrently actual pass work), never a
proactively retained 2^n family.

residual risk: React itself may hold many completed alternatives; fork lineage
tests and memory telemetry report actual frame count, and architecture has no
correctness-preserving cap hidden in the proof.

### S14: canonical equality gates a cross-world notification

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | T `+1` renders, urgent `set 3` equals K0 | urgent receipt is appended |
| 2 | M5 | union walk/delivery runs without consulting K0's changed/equal result |
| 3 | T replacement pass | M2 replays visible operations and observes its moved world before commit |

outcome: a canonical cutoff cannot suppress world invalidation or delivery.

residual risk: reusing donor `changed` boolean around M5; S14 asserts setter
count when K0 reports equality.

### S15: abandoned arena nodes called GC fodder

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | render creates/evaluates fresh node | record and links live under M4 scratch watermark, not permanent K0/K1 bump pointers |
| 2 | render abandons | watermark and packed payload cells reset/clear; handle generation changes |
| 3 | render commits | only winning pass promotes exact records to permanent arenas |

outcome: repeated mount-evaluate-abandon has bounded high-water memory.

residual risk: a constructor path allocating K0 before owner detection;
allocation counters run the repeated abandonment schedule for every public and
hook creation API.

## 10. Round-2 blocker docket walks

### Docket 1: I16 validity sources—compaction, settlement, function identity

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | retirement compacts a prefix | compaction waits for zero open pass, substitutes an equal folded base, and no reusable world value/fingerprint exists to validate falsely |
| 2 | thenable settles | resource gains an ordered `settledAt`; source input basis/identity remains stable; old pins still suspend, while result/downstream stamps advance and a later-pinned retry reevaluates transiently |
| 3 | `useComputed` fn or hook reducer changes | eventSeq/fnVersion advance; M5 stamps node and downstream; M7 key contains fnVersion; staged code publishes only on winning commit |
| 4 | audit | section 4 lists every pure evaluation input and its one mutation path; illegal fold reads/render writes are rejected |

outcome: the three champion holes do not receive three general-cache patches;
the reusable successful-world validity object and tape fingerprint are
deleted, while the required suspension capsule has one closed content key.

residual risk: an unlisted policy input; generated wrappers must declare their
change-source row and tests mutate each source without an atom write.

### Docket 2: I17 path-transitive propagation after retrack

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | evaluation inserts new `source->n` | M3 compares `source.lastChangeSeq` with `n.inputStamp` |
| 2 | source is newer | M5 raises n to that sequence and continues through every existing K0 and K1 out-edge, including CLEAN downstream d |
| 3 | source changed after pass pin | frame records its token; after render leave, M4 calls provisional/committed setters in that token so stale completed work cannot commit |
| 4 | later source write | ordinary union walk follows the now-real path directly |

outcome: no node-local flag claims a transitive property; the propagation is
the same full graph walk used for writes.

residual risk: calling stamp catch-up without continuing out-edges; an
equality-cutoff test keeps d clean, inserts the upstream edge, and asserts d's
stamp plus interleaved setter.

### Docket 3: I18 retirement inside the mount window

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | W renders old value; k retires before layout | live-token enumeration can be empty |
| 2 | layout/M6 | token loop does nothing, then mandatory committed-for-root evaluation runs independently |
| 3 | compare/correct | retired receipt is visible by retire pin; differing boxed value triggers urgent layout setter before paint |

outcome: fallback reachability does not depend on finding a live token.

residual risk: an early return after an empty token list; test asserts the
committed comparison call and paint output with zero live tokens.

### Docket 4: I19 stale lock-in masks at slot recycle

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | root commits k | sorted array stores full never-reused-live token k, not a slot bit |
| 2 | k retires | stamp entries, remove exact integer k from each array |
| 3 | later q reuses an internal React lane | q is a different full token; no binding column can interpret k's former lane/slot as q |

outcome: the failed mask and recycle operation do not exist.

residual risk: token serial wrap; safe-integer guard and forced-small live-skip
allocator test reject reuse until all retainers clear and episode changes.

### Docket 5: I20 stale positional thenable after an intra-batch write

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | lineage L evaluates position p | M4 copied k's clock q into the exact view revision; M7 stores the capsule under that revision |
| 2 | same batch writes any atom | M2-clock advances k to s>q, and M5 delivers through every currently known union path |
| 3 | old pinned pass | retains copied q and its pass memo/capsule; later registry mutation cannot drift it |
| 4 | replacement pass in same lineage | copies k clock s, so exact revision comparison rejects the old capsule even if the dependency edge was unknown at write time |
| 5 | late edge variant | M3 catch-up propagates delivery stamps and records a post-pin interleaved update; validity already changed coarsely through k's clock |

outcome: lineage supplies retry identity while the exact full-token clock
revision supplies content identity; neither is asked to do both jobs.

residual risk: reading live clocks instead of the pass copy; tests write during
yield both before and after the dependency's first K1 insertion.

### Docket 6: O14 post-await action attribution

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | action A and B start | M8 pushes/captures distinct tokens and parks both external claims |
| 2 | B continuation runs first | continuation carrier restores B; `classifyAndClaimWrite` returns B; finally restores prior context |
| 3 | click runs between continuations | click callback pushes U, so its write is U, then restores no-action context |
| 4 | A continuation runs | carrier restores A; write is A; A/B retire only after their own returned thenables settle |

outcome: parking supplies lifetime and the continuation carrier supplies
identity; they are separate stated duties.

residual risk: an uninstrumented native async source; startup self-test fails
loudly and the fork matrix covers each supported host callback class.

### Docket 7: SPK-H hooks must compile out of DIRECT

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | package starts without bridge | closure points at donor DIRECT functions; no refresh/notify/watched hook or null check exists inside K0 |
| 2 | bridge installs | operation-boundary closure changes write entry, not K0 recompute/link loops |
| 3 | ACTIVE write | M5 runs after the ordinary K0 write as a separate traversal |

outcome: the measured two-hook tax has no instruction site in DIRECT.

residual risk: code generation accidentally sharing ACTIVE bodies; bundled
bytecode diff CI requires DIRECT hot functions to match donor budgets.

### Docket 8: SPK-Q routing branch must move behind closure rebuild

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | DIRECT or quiescent bridge | DIRECT/QUIET_LOGGED read closure invokes K0 with no world test |
| 2 | first claimed write/pass history | operation boundary swaps to ACTIVE before receipt/mutation; render enter/resume selects newest or view closure once |
| 3 | last history/pass/lineage clears | after compaction and K1/resource reset, closure swaps back to QUIET_LOGGED |

outcome: the NEWEST/view choice is paid once at a render edge, and no routing
branch exists in DIRECT or QUIET_LOGGED reads.

residual risk: switching quiet while a retainer exists; mode transition asserts
the full quiescence predicate and a stress test keeps one retainer of each kind.

## 11. Remaining open-question decisions

- **D9:** M2-clock is the settled coarse world-resource validity mechanism:
  exact full-token clocks plus episode/retirement epochs, with no per-read
  certificate. M4's ordinary pass values need no cross-pass validation.
- **O1:** K1 remains the second real-edge plane, but it is edge-only and one
  union per episode. SPK-L1, not preference, decides whether deleting its
  reusable values is viable.
- **O3:** the dev E-PRESERVE validator records every M4 read set, verifies
  its K1/per-frame staged edge plus transitive stamp catch-up, and brute-force
  checks the quiescence K0 refresh before clear. SP2's existing >10% rule selects
  sampled validation; production behavior does not change.
- **O7:** root lock-in is the exact full-token array in M2. Fork tests 3/4/6
  are mandatory before library integration and are rebase gates.
- **O11:** fixup uses exact reach scans, no bloom/index. The 10k mount and
  1/8/31-token grid is a release gate; failure rejects this architecture.
- **O12:** delivery is value-blind by choice. SPK-N1's published thresholds
  are hard; `notifyCutoff:'evaluate'` is not designed into v1.
- **O13:** safe-integer saturation, full-token live-skip, episode reset, and
  visit-column clear rules are in section 6. K1 has no narrow tag; handles use
  arena generation checked on dereference.
- **O14:** the continuation carrier plus parked claim is specified and tested
  in M8; neither duty is inferred from the other.
- **O15:** updater/reducer callbacks cannot read signals in any build. Pure
  arithmetic, props closed over at dispatch, and precomputed `set` remain
  legal.
- **O16:** a constructor ReducerAtom's reducer is immutable. The hook variant
  stages the reducer per pass and replays all visible actions with that
  rendered version; differential tests replace it between T and U.
- **O17:** `ctx.previous` is public and root/lineage-specific, staged then
  published only on winning commit. At the NEWEST-to-render-view boundary the
  lineage seed can cause at most one identity switch; settlement retains the
  source thenable and may cause one downstream reevaluation.

## 12. Core graph, errors, cycles, and observation

DIRECT K0 is the 179-case/exact-pull-count semantics oracle. Dynamic
dependencies are re-tracked with the donor cursor and stale links are removed
only in K0. Errors and suspensions are boxed values finalized through the same
`try/finally` path as successful values. Custom equality lives in wrappers, so
K0 compares stable references and remains monomorphic.

Writes in a K0 computed are allowed when `forbidWritesInComputeds` is false.
The donor evaluation stack detects re-entry; a write whose propagation reaches
an evaluating ancestor throws a signal-cycle error. With the flag true, any
computed-depth write throws before M2. In an attached render frame every write
throws regardless of the flag. React-coupled update storms otherwise use
React's own setter limits because M5 uses ordinary state dispatchers.

Tracked reads add K0 or K1 edges according to evaluator. `untracked` suppresses
that edge in either evaluator. It does not suppress M2 replay, input stamps, or
the fold-read prohibition. Atom observed effects count committed subscriptions,
core effects, and live computed consumers; speculative K1 edges alone do not
start resources.

## 13. Verification sequence

The inherited process order is unchanged:

1. build the randomized M2 replay oracle and differential against
   `useReducer`, including function replacement;
2. freeze K0 with 179/179, exact pulls, growth stress, bundled bytecode budgets,
   and one-framework-per-process tier-0 baselines;
3. implement fork tests 1-12 before consuming the seam;
4. implement M4/M3 and compare every pass read set against the union graph;
5. add M5 delivery, forced-small counters, edge-catch-up, and all C1 variants;
6. add M6/M7, react-concurrent-store's 14 scenarios plus the known-bug mount
   suspension case, StrictMode abandonment, and multi-root skew;
7. run every C/S/docket trace as a deterministic scheduler test; and
8. run SPK-W, SPK-N1, SPK-G8, SPK-L1, 10k mount, P1/P3/P4, V8/JSC rankings,
   then report heapUsed and plane bytes separately.

Production admission requires all functional cases, 179/179 under forced
growth, exact pull counts, P1 within 10% of `useState`, mount within 15%,
DIRECT at-or-below alien-signals on each tier-0 shape, quiet React within 2%,
and zero steady engine allocation. A benchmark failure is not converted into
an undocumented mechanism.

## 14. Known gaps and declared non-surfaces

**Unwalked correctness cases: none.** All C1-C17 cases, C1 T2-T7, S1-S15,
and the eight round-2 blockers are traced above.

The architecture has release-gated measurement risks, not correctness gaps:
SPK-W logged writes, ACTIVE_NEWEST quiet reads, SPK-G8/SPK-L1 active-pass
recomputation, O11 late-mount reach scans, and SPK-N1 value-blind fan-out.
Their failure criteria are explicit and reject this architecture. Browser async-context support is a platform prerequisite with a
loud startup self-test; a host that cannot preserve native continuation
identity is unsupported rather than silently incorrect.

V1 deliberately omits optimistic truncation, RSC/Flight, a provider fallback,
cross-root simultaneous paint, `effectScope`, notification coalescing, and
write coalescing. Multiple roots themselves are fully supported with per-root
consistency.
