# Cosignal v1 — concurrent signals co-designed with a forked React

Status: **implementable specification**. This is the merged, self-contained
text of the design the loop produced, with all ratified scope cuts applied
and all post-loop rulings folded in. It supersedes the round documents; an
implementer should never need to read them. Design changes from here
require new evidence (a failing schedule or a measurement), not preference.

Scope of the mission: signals must move through React transitions,
Suspense, time-slicing, and interruptions in lockstep with React's own
state — no `useSyncExternalStore` de-opt, no torn frames — while a build
without React runs at donor-kernel speed. We maintain our own React fork;
the fork protocol in section 4 is part of this specification.

The slot-release rule (5.4) has passed its adversarial verification
(sound with amendments); the verified form — tenancy orderings instead of
a claim guard, identity release decoupled from bookkeeping disposal, an
honest demand bound with a one-line backstop — is baked into this text
directly.

---

## 1. The concurrency story on one page

**The bet.** The fastest known single-world signals kernel — an arena of
packed integer records implementing alien-signals' push-pull semantics —
stays byte-for-byte identical for the common case. Concurrency lives
*beside* it, never inside it. A build without React (DIRECT) executes zero
concurrency instructions. Registering the React bridge swaps the kernel's
operation table exactly once (LOGGED), and from then on every write leaves
a receipt.

**One value truth plus receipts.** The kernel always holds every atom's
newest applied value. Alongside it, each atom carries a tape of receipts —
{operation, batch slot, sequence number} — one per write, unconditionally.
A *world* — the state one render pass is allowed to observe — is never
stored anywhere; it is a fold: start from the atom's committed base and
replay the receipts that world may see, in write order. Which receipts a
world may see is React's own lane arithmetic in two clauses: a receipt is
visible if (1) its batch **retired** at or before the moment the pass
pinned, or (2) its batch is in the pass's **included set** — the batches
the pass renders plus the batches its root has already committed — and the
receipt is no newer than the pass's pin. (Slot recycling needs no third
conjunct: the tenancy orderings make cross-tenant matches harmless.)
Because worlds are folds, React's rebase arithmetic comes free:
replay-in-write-order over the committed base is exactly what React's
updater queues compute.

**Two graphs.** The kernel's edges describe the newest world only, and a
pending world's dependencies can differ (a flag flip routes a computed to
different inputs). So world evaluations record their *real* dependencies
in a second edge plane, and any edge the kernel drops while receipts are
live is mirrored there. A write walks the union of both graphs, marking
every reachable node with the writing batch's slot bit; one more bit marks
caches that may embed pending state acquired through untracked reads. That
one word per node answers routing: a non-newest reader may take the
kernel's cached answer only when the word is zero and the cache is clean;
everything else folds atoms and evaluates into per-(node, world) memos.
Memo validity is a closed enumeration — per-slot write clocks, retirement
stamps, world identity, epochs — checked cheapest first.

**Delivery is per-write, value-blind, synchronous, in the writer's
stack**: a watcher's `setState` runs while React still knows which batch
is writing, so re-renders inherit the writer's priority for free —
transition writes schedule transition renders, urgent writes urgent ones.
Nothing groups writes implicitly, and no equality test ever gates
delivery. A dedup bit per (watcher, slot) suppresses only deliveries that
scheduled-but-unstarted work will fold anyway.

**The seam is seven fork facts**: which batch is writing right now; pass
lifecycle with yield and resume edges (handlers in yield gaps are
correctly "not in render"); retirement exactly once per batch plus each
root's commit of it; scheduling updates into an existing batch's lanes; a
stable render-lineage identity; the DOM mutation window; loud fork
detection. Mounts reconcile late: a value-blind corrective joins each live
non-included batch that touched the node, then one comparison against the
mount's own world fast-forwarded to committed-now catches whatever retired
or locked in during the window — before paint.

**Hooks stay dumb on purpose.** `useComputed` is keyed by its deps like
`useMemo`: changed deps create a *fresh node*; nobody ever swaps a live
node's function, so evaluator identity cannot diverge across worlds.
`ctx.previous` is an optimization hint — the last committed value, read
live, with no recency guarantee. Async actions are React parity: writes
before the first `await` belong to the action; writes after an `await`
land in whatever context runs the continuation — re-wrap them in
`startTransition`, or use the action scope handle, exactly as React's own
docs prescribe (a dev warning points there). A batch frees its identity
slot the moment it retires unless an open render pass still names it; the
slot's routing bits simply outlive the tenancy as conservative dirt, so
correctness never depends on who owns the bit. Slot demand collapses to
React's own live-batch bound plus a small mask-retained residue — the
saturation apparatus is gone, and a one-line backstop covers the
adversarial corner. Retired writes fold into committed state whether or
not anyone was subscribed. At quiescence the second graph resets and every
counter renumbers under epoch guards.

**The price is measured, gated, honest.** DIRECT is the donor kernel at
0.84–0.96× alien-signals on the ranking shapes. Quiet-React read overhead
is gated at ≤3% (ratified; measured floor 2.4–3.8% under load). A logged
write is gated at ≤2× a direct one — the honest price of always logging,
which one user-reachable schedule (`flushSync` excluding a pending default
batch) makes mandatory. Every other hot number is a pre-registered spike
with a designed fallback.

---

## 2. Vocabulary

Plain-English definitions, in dependency order. Everything later in this
document uses these words with exactly these meanings.

- **signal** — a container for a value that remembers who reads it.
- **atom** — a writable signal. **computed** — a signal holding a function
  over other signals; reading it returns a cached result, and the library
  records which signals the function actually read (its dependencies,
  discovered by running it). **effect** — a function re-run automatically
  when signals it read change.
- **push-pull** — a write cheaply marks downstream "possibly stale";
  nothing recomputes until read, and then only what truly changed
  recomputes (exact pull counts). **equality cutoff** — a recompute that
  produces an equal value stops propagation. Both are requirements.
- **tracked read** — a read inside a computed/effect evaluation that
  registers a dependency edge. **untracked read** — a read (via
  `untracked(fn)`) that must not.
- **batch** — the unit of work React renders and retires together: one
  event, or one transition. **urgent** batches render promptly (discrete
  input is sync-priority; timers and network land in a *default* priority
  that renders soon but asynchronously). **deferred** batches
  (transitions) render in the background and commit later.
- **token** — a stable integer identity the fork mints per batch. Never
  reused while live. At most 31 batches are live at once (one per React
  lane).
- **slot** — a 5-bit index a live token is interned into, so batch
  membership fits in one 32-bit mask. **mask** — the bit-set of slots a
  render pass includes.
- **render pass** — one attempt to render a root: fresh stack to
  completion or discard. A pass spans yields; a restart is a new pass.
- **pin** — the global sequence value frozen when a pass starts. The pass
  observes included-batch writes only up to its pin, forever, across
  yields.
- **world** — one self-consistent assignment of values to all atoms: the
  newest world (kernel state), a pass world (its included set at its pin),
  or committed-for-a-root (what that root's committed DOM reflects).
- **receipt / tape** — the {operation, slot, sequence} record appended per
  write, on the written atom's per-atom log.
- **base / base sequence** — the folded floor of a tape: retired receipts
  that every live pin already sees get compacted into the base value.
- **fold** — computing a world's value for an atom: replay its visible
  receipts over base, in sequence order, with stepwise equality.
- **retirement** — a batch leaving React's books (commit everywhere, or
  closing with no React work). Retirement folds the batch's writes into
  committed truth. Whether a write persists never depends on who was
  subscribed.
- **per-root commit (lock-in)** — the moment one root commits a batch.
  The root's committed view includes that batch from then on, even before
  the batch fully retires (it may still be pending on another root).
- **K0, the kernel** — the canonical donor arena: one packed Int32Array
  plane of interleaved node and link records, iterative walks, newest
  values, newest-basis edges. Closed and monomorphic.
- **K1, the world-edge plane** — the second graph: real dependency edges
  recorded by world evaluations (and mirror copies of edges the kernel
  re-track removes while receipts are live). Add-only within an episode.
- **touched word** — one int32 per node. Bits 0–30: "batch in slot s
  reached this node through a recorded edge." Bit 31: **taint** — "this
  node's kernel cache may embed pending state acquired through an
  untracked read."
- **touched list** — per slot, the list of nodes/effects whose touched
  word gained that slot's bit; the durable enumeration retirement and
  per-root commits drain.
- **write clock** — per slot, a counter bumped on every write in that
  slot; the cheap staleness test for world memos.
- **world memo** — the cached result of evaluating a node in a specific
  world, with its recorded dependencies, fingerprints, and sequence.
- **fingerprint** — per (atom, world): max(newest visible entry sequence,
  base sequence, the atom's retirement stamp). Moves exactly when the
  atom's fold for that world could have moved.
- **retirement stamp** — per atom, minted at every retirement fold that
  touches it; catches visibility flips *below* an already-visible maximum.
- **watcher** — a mounted component's subscription record: node,
  `setState`, last rendered value, rendered-world snapshot, per-slot dedup
  bits.
- **lineage** — the fork-minted render-lineage identity: stable per
  (root × batch-set) across restarts, replays, and Suspense retries; dead
  at commit or abandonment. Suspense caches key on it.
- **newest-equivalent pass** — a pass classification meaning "no live
  divergence can reach this pass, its world is the newest world"; such
  passes read the kernel directly until the first receipt-creating write
  demotes them to their captured (mask, pin).
- **episode / epoch** — a quiescence-to-quiescence span; every counter
  reset pairs with an epoch or generation guard so nothing from a dead
  episode can validate in a live one.
- **DIRECT / LOGGED** — the two operation tables: donor behavior with zero
  concurrency instructions, versus receipts-and-routing. Swapped once, at
  bridge registration.
- **committed-advance counter** — one global counter bumped at every
  committed-side advance (retirement fold touching at least one entry;
  every per-root commit). Used by cheap "nothing moved" fast-outs only —
  never as a validity key.
- **action** — an async function run under `startTransition` (or
  `startSignalTransition`); React keeps the transition pending until the
  returned thenable settles, and the fork retires the token only then
  ("parking").

---

## 3. Public API and contracts

### 3.1 Core surface (framework-free)

- `atom(initial, options?) → Atom` — `.state` reads (tracked inside
  evaluations), `.set(v)` writes, `.update(fn)` writes functionally.
  `options.equals` supplies a policy equality; the kernel itself compares
  reference identity only (wrap values in reference-stable boxes for deep
  equality — the kernel stays monomorphic).
- `reducerAtom(reducer, initial) → ReducerAtom` — `.state`,
  `.dispatch(action)`. **The reducer is fixed at creation.** Dispatches
  append receipts holding the action; folds replay actions through the
  reducer.
- `computed(fn) → Computed` — `.state`. `fn(ctx)` is tracked; see 3.4 for
  `ctx.previous` and 5.8 for `ctx.use`.
- `effect(fn) → dispose` — re-runs when dependencies change. **Contract:
  core effects observe the newest world** (they run after writes, reading
  current kernel state — including applied-but-uncommitted urgent writes).
  This is documented, deliberate, and different from the React effect hook
  (3.2).
- `batch(fn)` — defers **core-effect flushing** to the batch's close.
  Nothing else: delivery to React watchers stays per-write; no implicit
  grouping of any kind exists anywhere in the engine.
- `untracked(fn)` — reads inside register no dependency edges. Untracked
  reads license *temporal* staleness (old values); they never license
  *world leakage* (a pending, excluded write observable through a cache) —
  the engine enforces the distinction (5.5).
- `configure({ forbidWritesInComputeds })` — writes inside computeds are
  tolerated when acyclic by default; this flag rejects them. World
  evaluations always reject writes regardless.

Purity rules that throw in **all** builds: signal reads or writes inside
an `update(fn)` updater or a reducer fold (read before dispatch instead);
signal writes during React render (yield-gap handlers are not "in render"
and are unaffected).

### 3.2 React bindings surface

- `registerReactBridge(fork)` — activates LOGGED mode, once, monotonically
  (never keyed to watcher counts). Throws if called while any evaluation,
  fold, or walk frame is open: register during app setup. Caches created
  before registration are legal LOGGED state (no receipts existed, so they
  embed committed-only values).
- Reading `anAtom.state` / `aComputed.state` during render subscribes the
  component (a watcher) and routes the read through the current pass's
  world. `useSignal(atom)` is the explicit-hook spelling of the same.
- `useComputed(fn, deps)` — see 3.3.
- `useReducerAtom(reducer, initial)` — creates the reducer atom once for
  the component's lifetime. The reducer identity is fixed at creation; a
  render that passes a different reducer function does **not** swap it (dev
  builds warn once). To change reducers, remount with a `key` or create a
  new atom. Exact `useReducer` parity is therefore scoped to stable
  reducers, and the differential test battery pins that scope.
- `useSignalEffect(fn, deps?)` — **contract: observes committed-for-root
  state only.** It evaluates in the committed world of the component's
  root: applied-but-uncommitted writes (e.g. a pending default batch) are
  invisible until they commit. Deps changes ride React's native effect
  re-fire: the effect re-runs at its own commit, re-reads, re-tracks, and
  re-subscribes — the engine never routes effect function changes through
  any other machinery.
- `startSignalTransition(fn(scope))` — starts a transition action and
  passes an **ActionScope**: `scope.set(atom, v)` and
  `scope.dispatch(reducerAtom, action)` classify the write into the
  action's token explicitly, from anywhere, at any point in the action's
  life (generation- and liveness-checked; calls after the action settles
  throw "ActionScope closed"). The scope has no other methods.
- Realm affinity: atoms, tokens, roots, and scopes carry an owner-realm
  nonce. Foreign tokens throw at scheduling; atoms and scopes are not
  structured-cloneable (loud, detectable rejection; ordinary worker
  promises are unaffected).
- There is **no truncation, rollback, or optimistic-revert API** — see
  battery case 17. Optimistic UI composes from separate atoms plus
  actions; a public-API snapshot test forbids accidental export of any
  truncation affordance.
- SSR/hydration: hydrate atom state by plain construction and `.set`
  *before* `registerReactBridge()` (DIRECT-mode writes, no receipts), then
  register. React Server Components / Flight integration is out of scope
  for v1.

### 3.3 `useComputed(fn, deps)` — deps-keyed recreation

`useComputed` has `useMemo` semantics, applied to node identity:

- On first render, the hook creates a computed node capturing `fn`.
- On later renders it compares `deps` pairwise (`Object.is`) with the deps
  stored in hook state. Equal deps: the existing node is returned —
  nothing is created, nothing minted. Changed deps: the hook creates a
  **fresh node** capturing the new closure, stored in the
  work-in-progress hook state.
- A node's evaluating function is immutable for the node's whole life. No
  machinery anywhere swaps a live node's evaluator.

Consequences, all deliberate:

- Cross-world consistency is inherited from React's own hook-state
  machinery. Two concurrent passes with different deps hold *different
  nodes* in their respective hook states; components in the same pass see
  the same node through ordinary props/state plumbing, which React already
  keeps world-correct. If the pass commits, the hook state (and thus the
  new node) becomes current; if it discards, the fresh node dies with the
  pass.
- Fresh nodes allocated during render are **pass-owned**: commit transfers
  them to ordinary ownership; discard or lineage death returns their arena
  records to free lists after a generation increment (stale ids then
  reject everywhere ids are consumed). StrictMode double-invocation and
  mount/abandon churn therefore cannot grow the arena unboundedly.
- Recreating on deps change re-runs downstream consumers exactly like a
  changed `useMemo` value would — that is the contract users already know.

### 3.4 `ctx.previous` — a committed-value hint

`ctx.previous`, available inside a computed's function, **always returns
the node's last committed value, read live at evaluation time**. There is
exactly one previous-value cell per node; world evaluations read the same
cell.

Documented contract, verbatim normative: *no identity, recency, or
per-world determinism is guaranteed; the function must be correct if
`previous` were arbitrarily stale or `undefined`.* `previous` exists for
recompute efficiency (e.g. reusing a previous array when the new one is
equal, bailing out of expensive diffs), never for semantics.
Incremental-accumulator patterns that depend on exact previous values are
unsupported — keep such state in an atom.

### 3.5 Async actions — React parity

The rule is one sentence: **a write belongs to the batch context in which
it executes.**

- Writes in an action's synchronous prefix (before the first `await`)
  execute inside the transition scope: they classify into the action's
  token. The fork retires that token only after the action's returned
  thenable settles ("parking" — React's own pending-transition behavior),
  so those writes fold into committed state only when the action
  completes.
- A raw write *after* an `await` executes on a bare continuation stack
  with no batch context: it classifies **ambient** — into a
  default-priority batch — and commits on that batch's own schedule,
  possibly before the action settles. This is exactly what a raw
  `setState` after `await` does in React.
- To keep a post-await write in the action, do what React's docs
  prescribe: **re-wrap it** — `startTransition(() => a.set(v))` inside the
  continuation (React entangles async-action updates so they render and
  commit with the pending transition) — or use the **ActionScope** handle
  (`scope.set` / `scope.dispatch`), which classifies into the action's
  token explicitly and works across any boundary, compiled or not.
- **Dev warning (heuristic):** in dev builds, a bare-context signal write
  that lands while at least one action is pending logs once per action:
  "a signal write after `await` landed outside the action — wrap it in
  startTransition or use the action scope." It is a lint: bare-context
  writes from unrelated timers during someone's action can trigger it;
  event-handler writes never do (they carry the event's batch context).

There is no compiler transform, no scheduler patching, no boot probe, and
no build prerequisite. Bundling choices cannot change attribution
semantics.

### 3.6 What is rejected at runtime (all detectable at the throw site)

- Writes during render → throw (all builds).
- Reads/writes inside updater/reducer folds → throw (all builds).
- `registerReactBridge` inside an open evaluation/fold/walk frame → throw.
- ActionScope calls after settlement → throw.
- Foreign-realm tokens/atoms/scopes; structured-cloning an atom or scope →
  throw.
- Cyclic evaluation within one world → throw (per-world cycle detection).

---

## 4. The React fork protocol

Hard rules: integers and documented callbacks only. No Fiber objects, lane
bitmasks, or update-queue internals ever cross the boundary. The bindings
feature-detect the protocol and fail loudly on stock React.

### 4.1 The seven facts

**Fact 1 — write classification.** `currentBatchToken(): int` (0 = none):
the batch of the write executing *now*, with a deferred/urgent
classification bit in the token. Tokens are minted lazily, never reused
while live. Invariant: at most 31 live tokens (one per lane).
Edge-triggered where React already tracks its execution context; consults
nothing about lanes across the seam.

**Fact 2 — pass lifecycle with yield edges.**
`passStart(root, mask, pinClaim)` / `passYield` / `passResume` /
`passEnd(commit | discard)`. Truth is **per callstack**: a handler running
in a yield gap observes "not in render" — any design keyed to a
[pass-start, pass-end] wall-clock interval is wrong, because passes span
yields and handlers run in the gaps. A pass frame is open for
[passStart, passEnd), *including* the completed-but-uncommitted period.
**Serialization fact:** no same-root committed-view advance occurs while a
same-root pass is open — a same-root commit implies the WIP pass ended
(React discards and restarts; it never resumes a pass across its own
root's commit). **Capability:** `discardAllWip()` — synchronously abandons
every WIP pass on every root (React re-schedules them; always legal);
returns only when no pass frame is open and no WIP hook retains
render-minted identity. Used by the counter-renumber protocol (5.12).

**Fact 3 — retirement and per-root commit.** Retirement fires exactly once
per token, with a committed flag; committed=false batches (no React work)
retire through the same path — their writes fold identically. Async-action
tokens **park**: retirement waits for the action's returned thenable to
settle. Separately, each root's commit of a batch is reported and updates
that root's committed-batch table (5.3). Intra-commit ordering is fixed —
see 4.2.

**Fact 4 — lane-scoped scheduling.** `runInBatch(token, cb)`: updates
scheduled inside `cb` join the token's lanes — the mechanism that lets a
late subscriber's correction ride *inside* the pending batch and commit
with it, rather than minting a fresh transition React would never entangle
(the seed of exactly one commit in battery case 10). A retired token makes
`cb` run urgent (documented fallback). Work inserted after a pass has
completed (but not committed) forces a pre-commit restart — React's
interleaved-update behavior, asserted by test.

**Fact 5 — render lineage id.** Stable per (root × batch-set) across
restarts, replays, and Suspense retries; dead at commit or abandonment.
Suspense capsules key on it. Single tokens, mask unions, and pass serial
numbers are all wrong keys (they drift, churn, or refetch forever) — the
lineage id is the settled answer.

**Fact 6 — DOM mutation window.** Commit-phase mutation boundary
callbacks (kept per the fork charter; used by devtools/tracing, not by
the engine's correctness).

**Fact 7 — fork detection.** The protocol's entry points exist only on
the fork; bindings feature-detect them and refuse stock React loudly at
startup rather than degrading silently.

### 4.2 Intra-commit ordering (normative)

Within one commit, in order:

1. **Baseline capture** — the root registry snapshots
   {committed-advance counter, root commit generation} at the commit's
   committed-side entry, before anything moves (consumed by the mount
   fixup's fast-out, 5.10).
2. **Retirement folds due at this commit**, and the root's
   committed-batch table update (the per-root commit).
3. **Durable drains** — watcher reconcile checks and effect revalidation,
   enumerated from the touched lists of every slot whose visibility
   flipped (5.9, 5.11). Corrections fire as urgent pre-paint updates.
4. **Layout effects**, then paint.

### 4.3 The rebase drill

"React renamed lanes / moved commit phases / rewrote update-queue
internals — what moves in the signals library?" **Nothing.** The library
consumes tokens, pass edges, retirement/commit edges plus the baseline
capture, `runInBatch`, and lineage ids — all re-implementable protocol
facts. Lane renames touch fact 1's internal minting; commit-phase moves
re-anchor facts 3 and the ordering clause to the events "root committed" /
"before folds/layout"; update-queue changes touch nothing (the library
never sees queues). Each fact carries its invariant in place and a
reconciler-level test; the suite runs on every fork rebase. A stock or
stale React build fails loudly at fork detection.

### 4.4 Fork test list (reconciler-level; on the critical path before bindings)

1–6: classification — event, transition, timer/network (default), inside
`flushSync`, nested scopes, engine-batch close (context preserved
per-write).
7–10: pass lifecycle — yield/resume edges; handler in a yield gap
classifies as not-in-render; wall-clock-scoped "in render" regression
(the scar that motivated per-callstack truth).
11–14: retirement — exactly once; committed flag both ways; async parking
(retire only after the returned thenable settles); per-root committed
table updates as each root commits a spanning batch.
15–17: per-root facts under multi-root schedules (two `createRoot`s, one
transition spanning both; these are the existence proofs the current
React generation has never been asked for — schedule them first).
18: `runInBatch` joins the token's lanes.
19: `runInBatch` retired-token urgent fallback.
20: lineage id stable across restart, replay, retry; dead at
commit/abandon.
21: a discarded pass can never later commit.
22: a same-root urgent commit discards an older yielded same-root pass
before any committed-view advance (serialization fact).
23: root ids stable; portals report the parent root.
24: updates inserted after completed-but-uncommitted work force a
pre-commit restart.
25: a root's commit exposes to its committed view exactly the write set
the committing pass rendered (write-set closure at commit).
26: baseline capture precedes the same commit's folds and table update.
27: `discardAllWip` is synchronous; afterwards no pass frame is open and a
later retry is a fresh pass with a fresh pin.
28: no same-root committed-view advance while a same-root pass frame is
open.

---

## 5. The engine

### 5.1 Build modes and activation

DIRECT: the donor operation table. No tapes, no touched-word maintenance,
no routing, nothing — zero concurrency instructions, proven by a CI symbol
diff of the DIRECT bundle. LOGGED: activated exactly once by
`registerReactBridge()`. Activation swaps the operation-table binding at
an operation boundary via closure rebuild (the measured-safe pattern; see
the storage facts in section 7).

Two activation rules: registration throws inside any open
evaluation/fold/walk frame (the frames already exist for cycle detection
and fold purity); and DIRECT-era caches are legal LOGGED state — no
receipts existed, so every pre-swap cache embeds committed-only values and
zero-initialized touched words are truthful. This is the base case of the
committed-only certificate (5.5).

### 5.2 The kernel

K0 is the donor arena kernel: one packed Int32Array plane, interleaved
node+link records, iterative traversals, alien-signals v3 semantics,
179/179 conformance with exact pull counts. It holds every node's
newest-applied value and the newest-basis edges. It is closed and
monomorphic: no per-link world state in the hot walks, CI-enforced
bytecode budgets on every hot function (V8 stops inlining silently past
its budgets — see section 7). LOGGED-mode writes apply to K0 eagerly with
stepwise equality (an equal result keeps the old reference), so the
newest world is always directly readable at donor speed.

### 5.3 Receipts, visibility, replay

**Write path (LOGGED).** A write to atom `a`:

1. Classify: token = the fork's current batch (fact 1), else the ambient
   default batch; intern the token's slot (claiming a free slot if new —
   5.4).
2. **Drop check.** If `a`'s tape is empty AND evaluating the operation
   against the base value yields an equal result → drop the write
   entirely (no receipt, no walk). Sound because with no history every
   world's fold is identical, and every operation's meaning is
   world-invariant (evaluators are immutable — there is no staged reducer
   anywhere that could make the same operation fold differently in
   another world). With **any** history, always append: equality moves to
   fold time.
3. Append receipt {op, slot, seq = ++globalSeq}; bump the slot's write
   clock; apply to K0 with the atom's stepwise equality.
4. **Marking walk**: propagate the slot's bit from `a` through K0∪K1
   out-edges with the monotone frontier `newBits & ~touched(n)`
   (self-terminating), appending newly-bitted nodes and effects to the
   slot's touched list.
5. **Delivery walk**: the full value-blind notification walk (5.9),
   delivering watcher setStates in the writer's stack and enqueuing core
   effects. The two traversals are distinct and both run per write:
   marking gates routing, delivery reaches watchers; neither ever
   substitutes for the other.
6. Writes during world evaluations throw; writes in yield gaps are
   ordinary (per-callstack truth classifies them). A newest-equivalent
   pass is demoted to its captured (mask, pin) by the first
   receipt-creating write anywhere (demotion data is captured at pass
   start; demotion is O(1)).

**The visibility rule (two clauses).** For a pass world
w = {mask, pin, capturedCommitted} — where `capturedCommitted` is the
root's committed-batch slot set snapshotted at pass start — define the
pass's **included set** = mask ∪ capturedCommitted. Receipt `e` is visible
to w iff:

```
visible(e, w) =  (e.retiredSeq ≠ ∅  ∧  e.retiredSeq ≤ w.pin)   // clause 1: retired by my pin
              ∨ (e.slot ∈ w.includedSet  ∧  e.seq ≤ w.pin)     // clause 2: included, up to my pin
```

For the committed-for-root(r) world (what r's committed DOM reflects,
"at now"):

```
visible(e, r) =  (e.retiredSeq ≠ ∅)                            // committed truth at now
              ∨ (e.slot ∈ r.committedSlots)
```

Notes that carry weight:

- The pin cap on clause 2 is what keeps a paused pass's world from
  drifting across yields: writes that land after the pass pinned — in any
  batch, included or not — are invisible to it.
- Slot reuse needs no guard here. The tenancy orderings (5.4) guarantee
  that a freed slot's *previous* tenant is fully retirement-stamped
  before the slot re-enters the pool, and that anything referencing the
  *new* tenant post-dates the claim. So a cross-tenant clause-2 match is
  either an entry clause 1 already admits (harmless double-admit — folds
  scan the tape once against the visibility predicate, replay by global
  sequence, and nothing double-applies) or is excluded by the seq-vs-pin
  arithmetic already in the clause. Retired-clause visibility never
  consults the slot at all (retirement sequence lives on the entry).
- **Fold** = replay visible entries over base in sequence order with
  stepwise equality. Updater and reducer operations re-evaluate during
  replay under the fold-purity guard (reads/writes throw). Fingerprints
  are computed during this same entry scan — no extra pass.
- **Per-atom fold memos.** Atom folds in non-newest worlds are memoized
  per (atom, worldKey) in the same memo plane as computeds. Within one
  render `a.state === a.state`, always. A retirement or per-root commit
  whose visible prefix equals a committing world's memoized prefix
  installs **that memo's reference** as the committed value (the
  committing render's object becomes the committed object — `useReducer`
  reference parity); store-only retirements fold once, fresh. Stepwise
  equality keeps old references on equal re-folds, so reconcile and
  effect comparisons are reference-stable and cannot ping-pong.

**Retirement.** Per retiring token t (exactly once; parked actions retire
at settlement). The internal order is normative — stamp, fold, drain,
clear rows, and only then release:

1. Ordering per 4.2 (baseline capture precedes; drains follow; layout
   last).
2. **Stamp, then fold**: set retiredSeq = ++globalSeq on every entry of
   t, then fold t's receipts into committed truth. Stamping precedes any
   slot release (tenancy ordering, 5.4), so the un-retired entries
   bearing a slot always belong to exactly its current tenant.
   **Compaction predicate** (both clauses normative):
   compaction consumes a *sequence-order prefix* of the tape — entry e
   compacts into base iff every entry with seq ≤ e.seq is retired AND
   e.retiredSeq ≤ min(live pins). The prefix clause preserves replay
   order (compacting a later ×2 under a pending earlier +1 would fold 3
   where React commits 4); the pin clause means every live pin already
   sees e via the retired clause. Pin-gated compaction is also what makes
   "empty tape" trustworthy wherever it is consulted (taint clearing,
   drop checks).
3. Mint the retirement stamp for every touched atom; bump the
   committed-advance counter.
4. Drain durably: enumerate the slot's touched list (never only a
   consumable write-time queue); reconcile-check each watcher (compare its
   last rendered value against committed-for-its-root *now*; urgent
   pre-paint setState on real difference — this value comparison is
   against committed truth, which is legal; delivery of live writes is
   never value-gated); revalidate effect snapshots (5.11). Watcher sets
   are resolved at drain time, so late subscribers to an already-listed
   node are covered without list surgery.
5. Clear the per-root committed-table rows for t (membership is subsumed
   by the retired clause from here on). **Then, last**, unmap the
   token→slot binding and release the slot — unless an open render pass's
   include mask names it, in which case the release defers and is
   re-evaluated at every pass end, **commit and discard alike** (5.4).
   Parked action tokens are live and never release while parked.
6. Store-only batches (committed=false) retire through this same path:
   fold, stamps, durable drain. Persistence never depends on
   subscription.

**Per-root commit (lock-in).** When root r commits a batch t that is not
yet fully retired (t spans roots, or t is a parked action r has rendered):
add t's slot to r's committed-slot set; bump r's **root commit
generation**; bump the committed-advance counter; drain the slot's
touched list for r's committed observers (same reconcile/revalidate as
retirement, scoped to observers whose committed world changed). The root
commit generation sits in committed-for-root worldKeys — every advance
re-keys those memos — and in effect-snapshot headers, forcing
revalidation. A pass world never consults the *current* table: it
captured its committed set at pass start (immutability across yields);
the serialization fact (4.1, fact 2) guarantees no same-root advance can
occur while a same-root pass is open, and cross-root advances touch
neither its captured set nor its keys.

**Write-set closure.** By the time a root commits batch t, t's signal
write set is closed in the common case: writes classify into t only
during synchronous scopes the fork reports, and a re-wrapped async
continuation establishes a fresh (entangled) batch context rather than
reopening t. The one surface that can append to a still-live committed
token is ActionScope (`scope.set`/`scope.dispatch` on a pending action a
root already committed). Such a write becomes visible to that root's
committed world immediately (membership clause) and schedules the root's
corrective render in the batch's own lanes; the window between is the
same bounded, urgent-corrected window as any late-subscription race, and
is part of the declared degraded multi-root contract (battery case 11).
Note the slot-lifecycle side is clean: a token committed into some root
but not yet fully retired is still *live*, so its slot cannot release
while any per-root row names it — the rows clear at retirement, before
release (verified composition, 5.4).

### 5.4 The slot table: immediate release on retirement

Live tokens intern into 31 slots. This rule set is the adversarially
verified form: identity release is immediate; the slot's bookkeeping has
a *different, longer* lifetime; no visibility guard is needed.

**Release rule.** A batch's slot **identity** releases the moment the
batch retires, **unless an open pass's render mask names that slot** —
then the release defers and is re-evaluated at every pass end, commit and
discard alike. Parked (async-action) tokens are live and never release
while parked. Release happens strictly after the batch's retirement
bookkeeping: receipts stamped, folds done, touched list drained, per-root
committed rows cleared (5.3's step order). The retention gate reads the
**render mask only**: a pass's captured committed set does not retain
slots — a committed-member token that retires mid-pass keeps its entries
visible through clause 2 by the lemma below (entries keep their slot
field and sit below the pin; a new tenant's entries postdate the claim
and hence the pin). The only cost of that recycling is conservative memo
refusal for the affected pass (the new tenant's write clock rises),
never a wrong value.

**The tenancy orderings** (invariants an implementation must enforce —
they are what makes recycling sound):

- **Stamp-before-release.** At tenant X's retirement, every X receipt
  gets its retirement sequence *before* slot s re-enters the pool. At any
  moment, the un-retired entries bearing slot s belong to exactly the
  slot's current tenant.
- **Claim-after-release.** A new tenant Y claims s only after X's
  release, which is at or after X's retirement — so every retirement
  sequence of X's entries precedes every sequence minted after Y's claim.
- **Pin/seq-after-claim.** Any receipt of Y has a sequence above the
  claim; any pass whose mask bit s *means* Y pinned after Y was live,
  i.e. after the claim. (Masks are captured from live tokens at pass
  start; a mid-pass first write's receipts postdate the pin and are
  clause-2-excluded anyway.)

**Tenancy lemma.** For consecutive tenants X → Y of slot s:
retiredSeq(every X entry) < claim(Y) < min(seq of every Y entry, pin of
every pass whose mask names s-as-Y). **Corollary (alias harmlessness):**
for any world with s included, an older tenant's entry is either visible
through the retired clause anyway (its retirement predates the claim,
which predates the pin) — a spurious clause-2 match changes nothing,
since folds scan the tape once against the visibility predicate and
replay by global sequence — or, for a pass that included s as the *old*
tenant, clause 2 is load-bearing and correct: the old entries keep their
slot field and sit below the pin, while any new tenant's entries postdate
the claim and hence the pin, failing clause 2's sequence conjunct. Both
directions are independently sufficient for receipts; no claim-epoch
guard is needed or present (a dev build may assert the compare; no
shipped state). Receipts denormalize their slot at write time, which is
what makes them lemma-covered; nothing else in v1 resolves batch identity
through the live interning table.

**Bookkeeping disposal (identity ≠ dirt).** Releasing the slot ID does
**not** sweep the slot's bookkeeping. Touched bits, touched lists, and
retained receipts keep their existing pin-gated lifetimes and persist as
**tenant-agnostic conservative dirt**: a set bit is only ever a routing
conservatism (it forces the world path, whose folds are entry-accurate
regardless of slot reuse), and a recycled slot's bit simply comes to mean
the new tenant's cone as the new tenant's walks set it. Erasing bits
early is the unsound move — a paused excluding pass *needs* stale dirt to
stay routed off the kernel cache — so nothing erases them early, and
routing behavior is identical to the old full-retention design. Because
the dirt does the routing, **the per-pass world-path-only flag machinery
is deleted along with the rest of the degradation apparatus**. Disposal
sites: at a re-intern of slot s, if min(live pins) ≥ the slot's carried
max retirement sequence (no excluding pass remains, so no world can need
the old dirt), sweep bit s via the touched list and reset the list;
otherwise inherit the dirt and carry the max retirement sequence forward.
Everything bulk-zeroes at episode reset. The write clock zeroes at every
re-intern; per-(watcher, slot) delivery-dedup bits clear at every
re-intern (5.9).

**Deleted with retention** (explicitly, so no residue survives): per-slot
unswept-entry counts and the swept-entries recycling gate; force-clear
victim selection; the per-pass world-path-only flag and every conjunct
that consulted it. Recycling is gated on retirement-stamped ∧ open-mask
exclusion, full stop.

**The demand bound, honestly.** Slot demand = live batches (≤31, React's
lane bound) + retired slots retained by open passes' masks. The retained
term is usually zero to two (see the storm walk, battery case 1) but is
not structurally zero: a yielded pass whose mask names k batches that all
retire mid-pass (entangled lanes with work only on other roots) retains k
slots, and adversarially live + retained can exceed the table.
**Backstop** (small, loud, safe): if the table is full when a new batch
needs a slot, release the oldest mask-retained retired slot anyway, with
a dev log. Safe by the lemma plus persistent dirt: the retained passes'
receipts keep their slot fields and stay clause-2 visible below their
pins; the new tenant's sequences postdate those pins; and the
undisturbed dirt keeps those passes' reads routed off the kernel cache.
In v1 this backstop is unconditionally safe because receipts carry their
slot at mint and no other clause-2 consumer resolves identity through the
interning table.

### 5.5 The world-edge plane and the touched word

**K1** holds integer link records (node→node, generation-tagged),
add-only within an episode, bulk-reset at quiescence. World evaluations
record their real dependencies here — the pending world has a real
topology, and this plane is it. The kernel stays untouched.

**The mirror rule.** Every edge a kernel re-track removes **while any
live receipt exists anywhere** is mirrored into K1 with both endpoints
and generation. When no receipt exists anywhere, a dropped edge is safe:
resurrecting a displaced branch in any world requires a receipt on the
branching dependency, whose own write re-marks the cone and whose world
evaluation re-records the path. A brute-force reachability fuzzer
(randomized re-track schedules, dev validator promoted to a CI gate)
checks the mirror.

**The touched word** — one int32 per node, the single routing authority:

| bits | meaning | set by | propagated by | cleared by |
|---|---|---|---|---|
| 0–30 (slot s) | batch in slot s reached n through a recorded edge | marking walk from the written atom | marking walk; edge-add propagation (a new edge inherits the source's bits, then retroactively delivers each still-live slot through the new path); mirror edges keep paths alive | re-intern sweep of s, only when no excluding pin remains (min live pins ≥ the slot's carried max retirement sequence); episode reset. Never at release — freed-slot bits persist as tenant-agnostic conservative dirt (5.4) |
| 31 (taint) | n's kernel cache may embed pending state acquired through an untracked read | evaluation epilogue (below) | 0→1 transitions walk existing out-edges with the same monotone frontier | the node's own epilogue deriving untainted; episode reset |

**Taint rules** (all reusing existing machinery):

- *Set at evaluation.* Every kernel (newest-world) evaluation of n
  computes a taint input: (a) any untracked read during the evaluation
  hit an atom with a non-empty tape, or a computed with a non-zero
  touched word; (b) the post-evaluation dependency sweep (riding the
  existing re-track scan) found taint on any recorded dep. True ⇒ set
  bit 31; false ⇒ clear it.
- *Propagate on 0→1* through existing out-edges in K0∪K1 — so tracked
  consumers of a tainted cache inherit the refusal even when equality
  cutoff kept them "clean," and even when their own evaluations never
  re-ran.
- *Untracked reads inside world evaluations* fold **in-world,
  edge-free**: the value comes from the world, no edge is recorded, no
  notification will ever fire for it — temporal staleness, which
  untracked licenses; never leakage.
- Cost: LOGGED-only; one tape/word check per untracked read, one bit-AND
  per dep per recompute, propagation only on transitions.

**The committed-only certificate** (the invariant the zero word carries):
if `touched(n) == 0` and the kernel says n's cache is clean, then n's
cached value is a function of committed-visible state only — serving it
to any world is at most temporal staleness, never world leakage.
Construction: base case — episode start and DIRECT-era caches have no
receipts anywhere. Step — consider the evaluation E that last wrote n's
cache and every later event. E's tracked atom reads: a pending atom has
slot bits, and the edge E recorded delivers them to n (marking walk if
the edge predated the write, edge-add propagation if E created it) —
contradiction with the zero word. E's tracked computed reads: by
induction a zero-word child embeds committed-only state; a non-zero
child passes bits through the same two walks or taint through the dep
sweep. E's untracked reads: the epilogue would have set taint.
Later writes reaching n through any recorded edge set a slot bit; later
writes reachable only through untracked paths cannot change the *cache*
(caches change only at evaluations) — the cache still embeds old
committed values, licensed staleness. A later upstream evaluation that
embeds pending state into a child's cache sets the child's taint, whose
0→1 propagation reaches n through the existing edge even if cutoff kept
n clean. Retirement only moves state pending→committed. Clearing: slot
bits clear only at a re-intern sweep gated on min(live pins) ≥ the
slot's carried max retirement sequence — no excluding world survives the
clear — or at episode reset (5.4); taint clears only at n's own
epilogue, whose "empty tape" input is trustworthy because compaction is
pin-gated. Evaluations are stack-atomic, so no clear interleaves a
half-derived certificate. ∎

**The edge-knowledge invariant.** At every instant, for every node n and
live slot s whose batch wrote atom x such that some world's evaluation of
n read x (directly or transitively) at or before its pin: bit s is in
touched(n), OR the x→n path exists in K0∪K1 with a walk in progress or
queued that will set it. Maintained at write time (marking walk), edge
record time (edge-add propagation with retroactive delivery — immediate
in every non-render context, queued to the pass's yield/end edge when
discovered inside a render slice), and kernel re-track time (the mirror
rule).

### 5.6 Read routing: the fast path and its soundness

Read contexts:

- **Newest world** (core reads, yield-gap handlers, newest-equivalent
  passes): straight kernel pull, donor semantics — recompute if stale.
- **Pass worlds and committed-for-root worlds**: route below.
- World evaluations reject writes and throw on per-world re-entry (cycle
  detection is per-world; K0∪K1 union cycles are legal state — see 5.9).

The fast path, two conjuncts:

```
fastPath(n, w) =  touched(n) == 0     // no slot bits, no taint
               ∧  CT(n)               // kernel cache clean, zero recompute needed
```

Everything else takes the world path: fold atoms per 5.3, consult or
evaluate the world memo (5.7).

**Fast-path soundness** (the invariant, with its construction). Claim:
the fast path never serves a value that world w's own evaluation would
not produce. Worlds diverge from the newest world through exactly three
sources, each excluded by a conjunct:

1. **Receipts reachable through recorded topology.** By first-divergence,
   the first divergent atom x is a newest-basis dependency at the
   divergence point and holds a live receipt in slot s; bit s reached n
   by the marking walk, edge-add propagation, or the mirror rule (the
   edge-knowledge invariant) — so touched(n) ≠ 0, refused. Fresh
   recomputes are excluded by CT: only cached, no-recompute serves are
   ever legal on the fast path (a fresh evaluation in the wrong world
   would *acquire* pending state, so it must run as a world evaluation).
2. **Receipts reachable only through untracked reads.** The
   committed-only certificate (5.5): an untainted, unbitted, clean cache
   embeds committed-only state; any cache that could embed pending state
   carries taint — refused. World evaluations fold untracked reads
   in-world, so the licensed temporal staleness stays per-world.
3. **Bookkeeping erasure.** Slot bits clear only at a re-intern sweep
   gated on "no excluding pin remains" (min live pins ≥ the slot's
   carried max retirement sequence) or at episode reset, when no
   receipts, pins, or worlds survive (5.4, 5.12) — so no clear can
   strand a world that still needed the routing. Within an episode a
   recycled slot's persistent stale bits over-route, never under-route.

Evaluator identity is *not* a divergence source in this design: a node's
evaluating function is immutable for its life, and deps-keyed recreation
gives changed closures a fresh node identity, which the node-generation
guard on memos and K1 records already covers. Base case: episode start —
no receipts, no taint, all worlds coincide. Step: every event kind's
update site is enumerated in 5.3–5.5 and preserves its conjunct. ∎

### 5.7 World memos and the validity ladder

`M(n, worldKey)` caches a world evaluation with its recorded deps (in
K1), its evaluation sequence, and per-dep fingerprints. worldKey = (mask,
pin, epoch) for pass worlds — pins are unique, minted from the one global
counter — and (root, root commit generation, epoch) for committed-for-root
worlds, so every per-root commit re-keys that root's committed memos.

**The closed change-source table** (everything that can invalidate a
cached world value, and what observes it):

| change source | observer |
|---|---|
| write in slot s | slot write clock (ladder step 2); fingerprint newest-visible term |
| retirement fold / compaction | base sequence; the entry scan; committed-advance counter (fast-outs only) |
| visibility flip below a visible max (an older entry retires; a per-root commit) | per-atom retirement stamp in fingerprints; root commit generation re-keys committed-for-root worldKeys and effect-snapshot headers |
| thenable settlement | capsule state machine (5.8) — a content event, never a world event |
| episode renumber | epoch in every worldKey |
| world identity | the worldKey itself |
| node identity recycle | generation tags on K1 records and memo keys |
| untracked pending-state embed | taint bit, at routing (5.6) — never reaches memos |

**The ladder** (serve `M(n, worldKey)` when):

1. worldKey matches exactly (identity + epoch).
2. Slot clocks: ∀s ∈ the world's included set: writeClock[s] ≤ memo.seq →
   serve.
3. Fingerprint recheck per recorded atom dep: all unmoved → re-stamp the
   memo, serve.
4. Re-evaluate in w: record real deps in K1, run under the world-eval
   frame (writes throw; per-world cycle throw).

Fingerprint: `fp(a, w) = max(newest w-visible entry seq, baseSeq,
retirementStamp(a))` — computed during the fold's entry scan.

### 5.8 Suspense

**Identity.** Thenable capsules key by (lineage id, hook position) — the
fork's render-lineage identity (fact 5). The lazy factory form of
`ctx.use(() => promise)` is preferred; the eager form guarantees identity
stability only. Capsules are per-world-content validated, never per-pass:
a Suspense retry is a new pass with the *same lineage*, so it finds the
same capsule and consumes the settled value instead of refetching
forever.

**Content validity (v1 rule).** Each capsule records a prefix — in
evaluation order, one position per dependency: atoms as (atomId,
fingerprint), computeds as (computedId, node generation). On retry, the
prefix is checked pairwise; all equal → reuse the capsule (settled value
served). Any mismatch → drop positions from the first mismatch and
refetch (capsule generation bumps). A mismatched position means the
world's receipt-line content genuinely moved (a write, a retirement flip,
a recreated node) — refetching is correct. The refinement that
re-validates *values* before refetching — keeping settled resources
across content-neutral stamp churn — is deferred to v1.1 (appendix A):
under stamp churn v1 may duplicate fetches; it never shows wrong data.

**Settlement.** A settlement callback mutates its capsule iff the
settling thenable **is** (reference identity) the capsule's current
thenable — generation counters do the suffix-drop bookkeeping but are
never the settlement guard, so out-of-order settlement of a superseded
fetch is inert even across counter wrap.

The canonical world never observes a suspension: errors and suspensions
are cached sentinel boxes, per world; a throwing getter never corrupts
graph state; sentinel-embedding caches obey the same touched-word
discipline; settlement is a content event (validity table, 5.7).

### 5.9 Delivery and notification

**Delivery rules** (all settled): per-write, synchronous, in the writer's
stack, value-blind. React assigns the writer's lane to the setState —
that is the entire priority-inheritance mechanism. Per-(watcher, slot)
dedup bits re-arm at the watcher's render.

**Pass-aware suppression.** A delivery reaching watcher W in slot s with
the (W, s) bit already set is suppressed **iff no started-and-uncommitted
pass on W's root includes s (render mask) with pin < the write's
sequence**. Otherwise deliver anyway: React receives the setState as an
interleaved update and schedules a follow-up render at a fresh pin. Why
this is exactly sufficient: the bit means "a setState for (W, s) is
scheduled and unconsumed"; suppression is sound iff the scheduled work
will fold the new write. Scheduled-but-unstarted work pins at a future
passStart ≥ seq — covered, suppress. Started work froze its pin < seq —
not covered, deliver; React's interleaved-update handling guarantees a
follow-up render at pin ≥ seq (a fiber with pending lanes never bails).
"Open" includes completed-but-uncommitted frames (a pass frame lives to
passEnd), and "includes s" means the render mask, never the committed
set — a committed-set-only pass does not consume the pending lane update.
The check is one registry load and two compares, on the suppressed path
only.

**Dedup bits clear at slot re-intern.** When slot s is re-claimed for a
new batch, every per-(watcher, s) dedup bit clears (riding the slot's
touched-list walk at claim). Without this, a bit left set by the previous
tenant could suppress the *new* tenant's first delivery — reachable when
React retires a lane whose only updates sat on hidden fibers, so the
watcher never rendered and the bit never re-armed. Clearing costs at most
one extra value-blind delivery per stale watcher, which is always safe.
(An implementation may equivalently replace the bits with sequence
dedup — deliver iff the last delivered sequence for (watcher, s) is ≤ the
last started pass pin on the watcher's root — which needs no clear site
at all; the suppression semantics above are unchanged either way.)

**Edge-add retroactive delivery.** When a new edge x→n is recorded while
slots are live on x, each still-live slot's delivery replays through the
new path (`runInBatch` per slot) — immediately in every non-render
context; queued to the pass's yield/end edge when discovered inside a
render slice.

**Walk termination.** Value-blind delivery walks over K0∪K1 carry a
per-walk visited generation (one global counter bumped per walk; a
per-record last-walk column; visited ⇒ skip): unions of per-world acyclic
graphs can cycle, and this is the termination that costs one int
load+compare+store per visited record. The marking/edge-add/taint
frontiers need none — `newBits & ~touched` is monotone and
self-terminating.

**Walk atomicity** (a proof, not machinery). No walk can begin while a
walk frame is open, so one global visited generation is sound. Every
instruction class a walk executes: record loads/stores and bit ops (no
dispatch); watcher setState (React enqueues; the fork's scheduler never
renders synchronously inside a setState call, and no user code runs
inside walks that could `flushSync`); core-effect *enqueue* (flushes
drain after the walk returns; a flushed effect that writes starts its
walk after the previous returned, sequentially). Fold-frame callbacks
(updaters, reducers, equality) are the only user-adjacent code near a
walk, and fold frames are never open inside walks; inside fold frames,
signal reads and writes throw. Therefore no write, no evaluation, and no
walk can start from within a walk. ∎ A dev assert (entering a walk with
the walk-active flag set crashes loudly) turns any future violation into
a dev error rather than a silent generation collision.

**Durable drains.** Committed truth flips only at retirements and
per-root commits. Every flip drains the flipped slot's touched list —
watcher reconcile (value-compared against committed-for-root now, urgent
pre-paint setState on difference) and effect revalidation — inside the
committing commit, per the 4.2 ordering. The write-time effect queue is
an optimization; consuming an entry never removes an effect from later
enumerations. Coverage construction: any watcher-node whose
committed-for-root fold changes at t's flip read some atom holding a
flipping t-entry; if the path existed at t's write, the marking walk
listed it; if an evaluation created the path later, edge-add propagation
flowed t's bit and appended it — possible whenever the source still
carries t's bit, which holds for the whole window in which t can still
flip (bits persist through the episode; a fully-retired-and-compacted t
has no future flips). Mid-render edge adds flow bits at the pass's
yield/end edge, which precedes that pass's own commit drain. ∎

### 5.10 Mount fixup

Runs in the mounting component's layout effect, after subscription.
`w_r` = the watcher's rendered-world snapshot {mask, pin, captured
committed set, root commit generation, pass id}; `v_r` = its rendered
value.

```
r = touched(n)
if r == 0 ∧ CT(n): return                       // committed-only content; nothing to do
for each LIVE written token t, slot s = slot(t) ∈ (r & SLOT_BITS):
  if s ∈ w_r.includedSet ∧ writeClock[s] ≤ w_r.pin: continue   // fully included: skip
  fork.runInBatch(t, setStateW)                 // value-blind entanglement — never skipped by value
if w_r.passId == committingPass.id              // rendered BY this commit's pass (generation-checked)
 ∧ commitBaseline.cas ≤ w_r.pin                 // no foreign committed-side motion since my pin
 ∧ commitBaseline.rootCommitGen == w_r.rootCommitGen   // no root committed-view drift since my render
 ∧ ∀t ∈ pass.maskTokens at commit: writeClock[t] ≤ w_r.pin:  // no post-pin write by any included TOKEN [errata 1]
  return
v_fx = evaluate(n, w_fx)
if !isEqual(v_fx, v_r): setStateW()             // urgent pre-paint correction
```

**The fast-forwarded world `w_fx`** — one world, one compare, no
suppression predicate anywhere:

```
visible(e, w_fx) =  (e.retiredSeq ≠ ∅)                          // committed truth at NOW
                 ∨ (e.slot ∈ w_r.mask ∧ e.seq ≤ w_r.pin)        // the render's own inclusions, at its pin
                 ∨ (e.slot ∈ root.committedSlots)               // the root's CURRENT committed set
```

Why this is the right comparator: v_fx − v_r can differ only through
visibility w_fx has and w_r lacked, and w_fx differs from w_r only on the
committed side — retirements that landed after the pin, per-root commits
after capture. Divergence from live included tokens is folded *in*, not
compared against (the mask clause is capped at the rendered pin), so a
mount inside a batch's own pass sees v_fx = v_r by purity and never
double-renders. Post-pin writes by live tokens are excluded from w_fx
exactly because the per-token loop already scheduled their entanglement —
firing urgently for them would tear the pending batch. Divergence from
live non-included tokens is invisible to both sides. So: fire ⟺ the
render missed committed-side truth ⟺ exactly the retire-race window that
mandates a durable pre-paint fallback. The retired clause needs no token
enumeration (retirement sequence is on the entries), so a token that
retired and released in the window is still seen.

The fast-out's four conjuncts, and why each is load-bearing: the baseline
{committed-advance counter, root commit generation} is captured at the
commit's **entry** (4.2 step 0), so the commit's *own* folds and table
update cannot mask foreign motion — a foreign retirement in the
render→commit window bumps the counter past the pin and falls through
(the schedule that killed the naive comparator). The pass-id conjunct
restricts the fast-out to watchers rendered by the committing pass — the
exact population for which own-commit motion is provably value-neutral:
own commits expose exactly the write set the pass rendered (fork
test 25), *provided* no included entry postdates the pin, which the
included-token clock conjunct certifies (a post-pin write folded by the
own-commit retirement falls through and fires; quantified over the
committing pass's mask tokens at commit time, not the captured mask
slots — errata 1 below). Everyone else — an
Offscreen/Activity reveal, any deferred-effect mount — fails the pass-id
conjunct and conservatively takes the compare. Over-firing is impossible
to make unsound (the compare fires a value-true urgent correction);
under-firing is excluded by the case split. ∎

Cost: clean mounts (zero word, clean cache) do zero work. Quiet in-pass
mounts return in ≤ 3 + popcount(mask) int compares, zero evaluations.
Fixups: ≤ |touched ∩ live non-included| corrective schedules plus at most
one world evaluation, only when committed-side state moved in the window.

**Oracle errata (2026-07-05, normative).** The executable model
(`packages/cosignal-oracle`, findings in `tests/FLAGS.md`) checked this
section's fast-out on every mount across the battery, scar, and fuzz
corpora; three corrections bind the implementation:

1. **The clock conjunct quantifies over the committing pass's mask
   tokens at commit time, not the captured mask slots.** A token whose
   first write lands mid-pass interns its slot after the watcher's mask
   capture; a slot-quantified conjunct is then vacuously true, and if
   that token retires at this commit, committed truth moves under a held
   fast-out with no live token left for the corrective loop (fuzz
   seed 29, shrunk to 5 ops). The pseudocode above carries the corrected
   quantifier.
2. **The corrective loop is a premise of the population argument, not an
   optimization.** A live token already in the root's committed set can
   write after the pin: the baseline counter, the root generation, and
   the mask clocks are all silent, yet w_fx's deliberately uncapped
   committed clause folds the write. The sound invariant — asserted by
   the model on every mount — is: fast-out-suppressed divergence must be
   exactly corrective-covered by the per-token loop (fuzz seed 173,
   shrunk to 9 ops).
3. **Legality fact the baseline conjunct leans on:** a retirement folded
   inside a commit must belong to a batch that commit rendered (a mask
   member). A foreign batch retiring inside another pass's commit lands
   after the baseline capture and breaks the fast-out permanently; fork
   tests 22/25 make that schedule unreachable — foreign batches retire
   at their own closure (fuzz seed 97).

Case 9 row 8's original "no false urgent" parenthetical contradicted
correction 2's mechanism and is fixed in place (pinned as oracle battery
case 9 (d′)).

### 5.11 Effects

`useSignalEffect` evaluates in committed-for-root(r) (world path; its
worldKey carries the root commit generation and epoch). Flush triggers,
all durable: every commit on the root **including every per-root
committed-view advance** (enumerate the advanced slot's touched list);
every retirement (touched list); settlement re-checks. Effect snapshots
record (atom, fingerprint) pairs plus a header {root commit generation}:
retirement flips move fingerprints via the retirement stamp; per-root
commits bump the header generation, forcing revalidation (value-compared;
re-run on change). The committed-advance counter is an optional
pre-filter — "unmoved ⇒ skip the fingerprint scan," never the reverse,
and never a validity key.

Core `effect()` observes the newest world — its enqueue rides the write's
delivery walk; flushes drain after the walk returns (or at `batch()`
close). Two effect contracts, both stated, mechanically distinct (world
fold vs kernel read), both conformance-pinned.

Watcher lifecycle: subscribe at layout (before fixup); unsubscribe at
cleanup with microtask-debounced observed-count bookkeeping (StrictMode's
double-mount nets to one subscription). The last rendered value updates
only at committed renders — reconcile never compares a
finished-but-uncommitted tree's values, so drains cannot tear pending
batches. Dedup bits re-arm at render.

### 5.12 Episodes, quiescence, renumbering

**Quiescence** (no live tokens, no live pins, no parked actions): refresh
every K1-touched node holding a committed watcher or effect-dep snapshot
by a kernel pull, so the kernel's newest-basis edges again cover
everything committed observers depend on. A node whose refresh twice
triggers legal writes is exempted, and its **full reverse-reachable K1
cone** (both endpoints of every in-edge path) is carried into the next
episode — carrying only direct in-edges loses transitive paths and was a
walked failure. Termination: a two-strike rank over non-exempt targets
strictly decreases per failed sweep; a fixed observed set resets within
2N+1 attempts; unbounded new observed work belongs to the ordinary loop
budget, not quiescence. An exemption clears when a later ordinary kernel
evaluation of the target completes without writing. Then: K1 bulk-reset
(epoch bump), plane watermarks reset, counters renumbered.

**Renumber duty list** (every retained sequence value rewritten in an
order-preserving pass, or killed by the epoch in its key): tape
sequences and retirement sequences, base sequences, write clocks,
retirement stamps, the committed-advance counter, each slot's carried
max retirement sequence (the dirt-sweep watermark, 5.4), memo sequences,
capsule prefix fingerprints, the last-walk column (swept). Token serials
are a separate, never-renumbered domain. Root commit generations are
epoch-guarded, not renumbered. A schema sweep checks the retainer table
mechanically — prose is not the audit.

**Live renumbering (the horizon protocol).** The global counter carries
an explicit horizon (forced small in tests). The check runs at
**atomic-extent entry** — the operation boundary before entering any
commit, walk, fold, or drain — with a documented, runtime-computable
reserve: for a commit, a schema-constant multiple of (atoms touched by
tokens retiring at this commit) + (roots) + a constant; walks and folds
have constant reserves; CI asserts the constants against the mint-site
table. If the counter plus reserve would cross the horizon: first
`discardAllWip()` (fork fact 2 — synchronous; after it, no
sequence-bearing identity exists outside the library: WIP hooks died with
their passes, committed fibers hold values only, carrier-free tokens are
a separate domain, capsules die by epoch with in-flight thenables inert
under the settlement identity check), then rewrite per the duty list,
then epoch-bump every worldKey and restart counters above the rewritten
range. Live pins are impossible during the rewrite (all passes
discarded). Production horizons sit far below the float53 ceiling with a
≥2³² reserve margin, making mid-extent crossing structurally unreachable;
crossing anyway is a loud invariant throw in all builds — dead code by
the sizing rule, tested by forced-tiny-horizon rows.

**K1 growth honesty.** K1 and its mirror records are add-only until
quiescence; never-quiescent apps grow K1 without bound — memory and
walk-cost degradation, never a wrong value. A bounded mid-episode sweep
collects only the provably-safe subset: records whose recording epoch's
world memos are all dead, whose endpoints hold no committed watcher or
effect-dep snapshot, and which carry no retained touched bits for live
slots. Residual growth is a named soak spike (section 8); the declared
gap stands documented if the spike passes.

### 5.13 Semantics pins (conformance-tested, not re-litigated)

- **Reducers**: fixed at atom creation; dispatch receipts hold actions;
  folds replay through the one reducer; reads/writes inside folds throw.
  The write-path drop check applies to reducer atoms like any other
  (evaluators are immutable, so operation meaning is world-invariant).
- **Equality**: policy wrappers return reference-stable values/boxes; the
  kernel compares identity only. Errors and suspensions are cached
  sentinel boxes; a throwing getter never corrupts graph state.
- **Loop limits**: React storms hit React's own update-depth guards
  (writer-context setState inherits them); engine-only cycles throw
  per-world; signal-only storms hit the flush budget.
- **Writes in computeds**: tolerated when acyclic in core (config flag to
  forbid); world evaluations always reject writes.
- **Tracing**: a lazily loadable recorder (ring + session modes, one slot
  check per site when untraced) hooks the operation-table wrappers;
  orthogonal to everything above.

---

## 6. The acceptance battery, walked

Every case from the frozen acceptance battery, walked against **this**
post-cuts text. Notation: `{v@s, t}` = receipt (value/op, sequence,
token); `TS(n)` = touched slot bits; `WT` = taint bit; `M(n,w)` = world
memo; `cas` = committed-advance counter. Format per case: numbered steps
(actor/mechanism | state), outcome, residual risk.

### Case 1 — world-divergent dependency (the killer; family)

Setup: atoms `flag=false, a=0, b=0`; computed `c = flag ? a : b`;
component W subscribed to c; kernel deps of c = {flag, b}. Deferred batch
k: `flag.set(true)`, then (k-world read of c may cache here), then same
batch: `a.set(1)`. Required: k-world value of c becomes 1; W re-renders
in k's lane before k commits; committed world still reads 0 via b.

```
1 | k: flag.set(true) | receipt {T@s1,k}; wc[k]++; K0 flag:=true; TS(flag)∋k; marking walk K0∪K1: flag→c ⇒ TS(c)∋k; delivery: (W,k) dedup set, setState(W) in k's lane
2 | k-world read of c (pass P_k: mask{k}, pin p) | TS(c)≠0 → world path → M(c,w_k): fold flag=true (k), a in-world = 0 → c=0; K1 records the REAL k-deps flag→c, a→c; memo.seq = now
3 | k: a.set(1) | receipt {1@s2,k}; wc[k]++; K0 a:=1; TS(a)∋k; marking walk: a→c exists IN K1 (step 2) ⇒ c reached although a has NO kernel edge (the trap); delivery: (W,k) bit already set — suppression check: k's pass is open with pin p < s2 → DELIVER anyway (pass-aware rule); React queues the interleaved k-lane update
4 | k render of W | ladder: wc[k] > M.seq → refuse → re-evaluate: flag=true, a=1 → c=1 ✓ W renders 1 in k's lane before k commits
5 | committed world read | fold excluding k: flag=false → b=0 → c=0 ✓
outcome: the k-world cache is invalidated by the slot clock (per-slot clocks are immune to the "state at evaluation time" trap); notification reached W through the real K1 edge; committed intact.
residual: K1 recording is load-bearing → the edge-mirror fuzz gate plus this exact conformance row.
```

Variants, walked:

- **V2 (write to committed-only dep `b` in k):** marking walk from b uses
  the kernel edge b→c ⇒ TS(c), delivery — over-notification; the k render
  re-evaluates (clock moved): flag=true → a-path → value unchanged; React
  re-render emits equal output. Over-render ≤1 per (watcher, slot, cycle)
  — priced, never wrong. ✓
- **V3 (flag flips back in k; the re-track member):** k: flag.set(false)
  → walk flag→c → k-world re-eval: c = b = 0 ✓. Mirror half: if a
  newest-world re-track (flag=true at K0) dropped b→c while receipts
  live, the drop is mirrored into K1; a later batch's write to b walks
  the mirror ⇒ TS(c) gains it ✓. With no receipts anywhere at drop time
  the drop is safe (resurrection requires a receipt on flag, whose write
  re-marks c and re-records the path). ✓
- **V4 (urgent write to b):** committed c (flag=false) = 9 after U
  retires; k-world (flag=true) reads the a-path, unchanged ✓.
- **V5 (urgent write to a; pending worlds include applied urgent
  state):** U: a.set(9)@s5 retires@s6. k's post-restart pass (pin p2 >
  s6) folds a: {1@s2,k} (included clause) + {9@s5, retired ≤ p2} → replay
  in seq order → a=9 → c=9 ✓. A yielded pre-U pass (pin p1 < s5):
  retiredSeq s6 > p1 ⇒ excluded → still sees a=1 ✓ pinned world never
  drifts.
- **V6 (slot/world-id reuse after k retires):** k's entries are stamped
  before its slot releases (tenancy ordering); a new tenant V claims the
  slot afterwards, and any pass whose mask means V pinned after the
  claim. So V-includers see k's old entries through the retired clause
  (retirement predates their pins) — a redundant clause-2 match changes
  no fold, no fingerprint, no replay order (one tape scan, replay by
  global sequence) — and a pass that included k sees V's entries fail
  clause 2's pin conjunct (they postdate the claim, which postdates that
  pass's pin). Old memos die by pin/epoch keys; V's write clock starts
  from zero at claim; (watcher, slot) dedup bits cleared at claim ✓.
  Forced small-counter test.
- **V7 (two live batches; one suspends, one commits alone):** pass P{j,k}
  suspends on c's k-data thenable (capsule keyed by lineage of
  {root × {j,k}}); pass P{j} is a different batch-set ⇒ different
  lineage ⇒ own memos, no shared capsule; j commits alone; the {j,k}
  retry finds its capsule settled ✓. The canonical world never observes
  either suspension (sentinels are per-world cached values).
- **Recreation member (replaces the old evaluator-swap member):** a
  transition render passes changed deps to `useComputed` → the WIP hook
  creates fresh node c₂ (pass-owned); consumers in that pass receive c₂
  through props ⇒ uniform; an urgent pass rendering committed props holds
  c₁ ⇒ uniform; commit swaps the hook state to c₂, discard frees it
  (generation increment). No cross-world evaluator state exists to
  diverge — by construction, since no node's function ever changes. ✓
- **Union-cycle member:** worlds record c→d and d→c (per-world acyclic;
  union cyclic). A write's delivery walk stamps each visited record with
  the walk generation and skips stamped records ⇒ terminates; a second
  write is a new generation ⇒ full re-traversal (re-arm semantics
  preserved). ✓
- **Taint member:** `c = b.state + untracked(() => a.state)`; `d`
  tracked on c. T writes a=1 (no edge from a — untracked must not
  notify). U writes b=1; U's world evaluation folds untracked a
  **in-world** = 0 → c=1 ✓. U retires; a newest-world pull of c reads
  b=1, untracked a hits a non-empty tape → taint(c) set; cache c=2; taint
  0→1 propagates to d through the existing edge. A sync render excluding
  T reads d: touched(d)≠0 (taint) → world path → c in-world = 1 → d=2 ✓
  (the fast path would have served the leak). Cutoff horn: if c's
  recompute lands equal (cutoff keeps d "clean"), the epilogue still sets
  taint and the 0→1 propagation still reaches d ✓. Clears: only c's own
  epilogue with an empty tape (trustworthy — compaction is pin-gated) ✓.
- **Retention member (paused pass across a foreign retirement; the
  release rule at work):** `n = a+10` kernel-clean; core effect on n;
  transition pass P (pin p=100, mask {T}) yields; a gap click's urgent
  batch U (slot 5) writes a=1 @110 (TS(a), TS(n) gain bit 5; touched
  list appended; no React watcher). Core-effect flush reads newest → 11
  (documented core contract). U retires: entries stamped rs=112, then
  pin-blocked from compaction (112 > p = a live pin); slot 5 ∉ any open
  mask → **the slot identity releases immediately**; the *dirt does
  not*: bit 5 persists on n's cone (5.4 disposal). P resumes; reads n:
  touched(n)≠0 → world path → fold a at pin 100: clause 1 fails
  (112>100), clause 2 fails (5 ∉ {T}) → a=0 → n=10 ✓ one frame, one
  world — the persistent dirt is exactly what kept P off the kernel
  cache embedding a=1. A later tenant V claims slot 5 and writes a=2
  @120: P still excludes it (120 > 100); a fresh pass Q (pin 130, mask
  {V}) folds U's entry via the retired clause (112 ≤ 130) then V's via
  clause 2 — replay by sequence, 110 before 120 ✓ nothing
  double-applies.
- **Saturation member: the scenario cannot occur.** The overload that
  previously demanded a degradation apparatus was pin-held retired slots
  accumulating until interning starved. Under the release rule, slot
  demand = live batches (≤31, React's lane bound) + slots retained by
  open masks. The storm schedule, walked: one yielded transition P (pin
  100, mask {T}) plus 40 urgent keystroke batches during the yield —
  each one mints a token, claims a slot at first write, renders,
  commits, retires (rs > 100), passes the release check (retired ✓, not
  in {T} ✓, no other open mask ✓), and returns its slot to the pool. At
  any instant the table holds T (live, mask-retained) plus the current
  urgent and at most a couple of in-flight defaults — four or five
  entries, the same two or three ids recycling forty times, never
  approaching 31; no victim selection, no degradation mode. All forty
  batches' receipts stay on the tapes (pin 100 blocks compaction) — the
  pre-existing held-transition tape cost, unchanged; only slot-identity
  demand collapsed. The one adversarial corner — a yielded pass whose
  mask names many batches that all retire mid-pass while fresh live
  batches need slots — is covered by the loud backstop (5.4), which is
  safe by the tenancy lemma plus persistent dirt.
```
outcome (family): divergence is excluded at routing (touched word), validity (clocks/fingerprints), notification (real edges + value-blind delivery), and identity (fresh nodes); the committed world is never contaminated; slot recycling is sound by the tenancy orderings alone.
residual: the pinned regression rows named per member, including the recycling schedules (paused-pass exclusion, mid-pass retirement of an included batch, post-recycle fold/mount, recycled-tenant writer's world, storm, backstop corner).
```

### Case 2 — flushSync excludes a pending default batch (why always-log)

```
1 | event: a.set(1) lands in default batch D | receipt {1@s1,D} (ALWAYS logged — urgency never skips history); wc[D]++; K0 a:=1; TS(a)∋D; walk: a→c ⇒ TS(c)∋D; watcher setStates in D's context
2 | flushSync(setState) renders SyncLane only | pass P_s: mask ∅ (D excluded), pin p
3 | P_s reads a | TS(a)≠0 → world path → fold: D not retired, not included ⇒ invisible → a=0 ✓
4 | P_s reads c | TS(c)≠0 → world path → M(c,w_s): a in-world 0 → c=10 ✓ BOTH old — no torn frame
5 | D renders/commits later | retirement fold → committed a=1, c=11; committed observers drained via D's touched list
outcome: matches Required. The receipt existed although the write was urgent-classified — this schedule is the proof that every write needs a receipt in React mode — and the write-time marking kept the canonical cache off the excluding render's path.
residual: the always-log price is the logged-write gate; this exact schedule is a pinned conformance row.
```

Mount variant: a component mounting inside the flushSync render has
w_r = (∅, p); fixup loop: D live, D ∉ included set ⇒ `runInBatch(D,
setState)` — the corrective joins D's own lane; D's render includes it in
one commit ✓.

### Case 3 — rebase parity (React's updater-queue arithmetic)

```
1 | a=1; deferred T: update(x=>x+1) | tape empty; evaluated vs base: 2≠1 → APPEND {+1@s1,T}; K0 a:=2
2 | urgent U: update(x=>x*2) | tape non-empty ⇒ always append {×2@s2,U}; K0 := 4
3 | urgent render (mask{U}, pin p) | fold: base 1; T excluded; ×2 → 2 ✓
4 | U commits/retires | committed fold: only U visible → 2 ✓; compaction: the seq-order prefix rule — s1 (unretired) blocks s2 from compacting (replay order preserved; folding ×2 into base under a pending +1 would commit 3 where React commits 4)
5 | T renders (pin p2 > retire(U)) | mask{T} ∪ retired U → replay s1, s2: (1+1)×2 = 4 ✓
6 | T commits | fold → 4 ✓ side-by-side useReducer matches at steps 3–6
outcome: replay-in-write-order over the pre-batch base; apply-and-discard is unrepresentable (K0 is newest-applied but never the fold source). Committed references: the committing render's folded object installs as the committed value (per-atom fold memos), so reference identity matches React's own commit.
residual: the differential useReducer battery (stable-reducer scope — reducer swap is out of v1's surface, 3.2); fold purity pins updater replay determinism.
```

Plain-set variant: T pending {+1}; U: `set(5)`: tape non-empty ⇒ append;
U-world: 5 ✓; T+U world and final commit: +1 then set-5 → **5, not 6** ✓.

### Case 4 — two-batch write into an already-stale region (re-notify)

T1 writes a ⇒ walk ⇒ (W, slot(T1)) dedup set, setState in T1's lane.
Before any re-render, T2 writes a ⇒ a new delivery walk (fresh walk
generation) ⇒ (W, slot(T2)) bit is clear ⇒ setState in **T2's lane** ✓.
Dedup is per-(watcher, slot) — never once-per-staleness; marks gate
routing, never delivery. Bits re-arm at W's render.
outcome ✓. residual: fan-out gate grid; walk generations change traversal
bookkeeping, not dedup semantics.

### Case 5 — cutoff-suppressed first write, effective second write (same batch)

k writes a=1 (c's value unaffected: `c = a*0 + b`): delivery is
value-blind ⇒ setState (W, k) fires anyway (≤1 spurious render — priced);
the k-world memo is refused via the slot clock ⇒ re-eval → equal output.
k writes b=7: if W already re-rendered, its dedup bit re-armed ⇒ fresh
setState in k's lane; if not, suppression is legal only while the
scheduled render will fold s(b=7) — a pending unstarted render pins ≥ seq
and reads the *current* k-world (clock moved again ⇒ ladder refuses ⇒
re-eval) → the 7-based value ✓. Cache validity never serves the first
evaluation (slot clock). The trap (marks that stop walks + once-armed
bits) is structurally absent: nothing value-gates delivery, and validity
is clock-based.
outcome ✓. residual: spurious-render bound in the fan-out gate; the
value-blind rule is pinned by decision (no equality cutoff on delivery,
ever — the only admissible fan-out fallback is per-slot-mark dedup per
render cycle, and only with its own walked schedule).

### Case 6 — lane attribution under grouped notification

Resolution: **handled** — no implicit grouping exists anywhere.
`batch(() => { a.set(1); startTransition(() => b.set(2)) })`: engine
`batch()` defers only core-effect flushing. a.set(1): the fork reports
the ambient event batch (urgent) ⇒ delivery NOW, urgent context.
b.set(2): the fork reports the transition token ⇒ delivery NOW, in
transition context ⇒ watcher setStates inherit the transition's lanes;
one transition commit carries b's cone ✓. Engine-batch close: core
effects flush reading newest (documented). Nothing user-visible was
forbidden; per-write context is preserved by construction.
outcome ✓. residual: mixed-context batch conformance row; core-effect
flush timing row.

### Case 7 — writes and reads during a yielded render pass

```
1 | transition pass P (mask{T}, pin p) yields | fork passYield ⇒ per-callstack truth: not-in-render
2 | click handler reads a.state | NEWEST (kernel, newest-applied — includes T's applied write) ✓ the newest world, not the pass's pin
3 | handler writes a.set(x) | no throw; the fork classifies it into the click's batch U; receipt {x@s,U} ✓
4 | P resumes | folds honor (mask{T}, pin p): U's seq > p ⇒ excluded; even if U retires mid-yield, retiredSeq > p ⇒ excluded ✓ pinned world stable
outcome: render truth is per-callstack (passes span yields; handlers run in the gaps); the pass's world cannot drift (pin + entry-level retirement sequences + retained routing bits).
residual: fork tests 7–10 (yield edges); the wall-clock-scope regression row.
```

Newest-equivalent variant: the write path demotes open newest-equivalent
passes to their captured (mask, pin) *before* appending the first
receipt ⇒ the demoted pin predates the write ⇒ excluded ✓.

Included-batch mid-pass retirement variant: P's mask names T, and T
retires during P's yield (possible only when T's remaining React work
lives on other roots — a batch whose work *is* this pass cannot leave
React's books before the pass ends, and a discarded pass leaves its
lanes pending). T wrote b=7 @95 before P pinned at 100; T's retirement
stamps rs=105 > 100. The release check finds slot(T) ∈ P's mask ⇒
release **blocked** — which matters, because clause 1 now fails
(105 > 100) and clause 2 is load-bearing: mask ∋ T ∧ 95 ≤ 100 ⇒ P still
sees 7 ✓. A post-pin T-attributed write @103 stays excluded (103 > 100)
✓. When P ends — commit or discard — the deferred release re-evaluates
and the slot frees ✓.

### Case 8 — equality drops must not lose receipts

a=0. T: `set(1)`: tape empty, evaluated vs base 1≠0 ⇒ append. U: `set(1)`
— equal to the *newest* value: tape NON-empty ⇒ **always append**
{1@s2,U}. U's render (excluding T): base 0 + U's set → 1 ✓. T
abandonment = retirement fold (committed=false folds identically) —
either way U's receipt independently commits 1 ✓. Two overlapping
transitions writing 1: both append; every world folds to 1 ✓. The legal
drop, walked: quiescent tape-free `a.set(0)` (equal against base) ⇒
dropped — safe because with no history every world's fold is identical.
Since every atom's evaluator is immutable, operation meaning is
world-invariant and the empty-tape drop is legal for all operation kinds;
with any history, equality lives at fold time only.
outcome ✓. residual: these rows in the conformance battery.

### Case 9 — mount mid-transition (existing and fresh nodes)

```
(a) existing computed c, mount inside k's own pass P_k (w_r = mask{k}, pin p)
1 | render read | TS(c)∋k ⇒ world path ⇒ M(c,w_k) ⇒ the k-world value on the FIRST render ✓ no canonical leak, no double render
2 | layout fixup loop | t=k live, slot ∈ w_r.includedSet ∧ wc[k] ≤ p ⇒ SKIP (inclusion+clock — never value equality)
3 | fast-out | passId matches ∧ baseline.cas ≤ p ∧ rootCommitGen matches ∧ wc[k] ≤ p ⇒ return — zero evaluations (pinned cost row)
(b) fresh node — useComputed created during this render
4 | first evaluation | no cache ⇒ CT false ⇒ fast path impossible (a fresh evaluation is never a legal fast-path serve) ⇒ world-path eval directly in w_k; K1 edges recorded; touched bits inherited from deps via edge-add propagation; the node is pass-owned (freed on discard)
5 | fixup for (b) | rows 2–3 ✓ one render total
(c) foreign retirement in the render→commit window
6 | store-only default D writes a and RETIRES during P_k's yield; W not yet subscribed | committed truth moves; cas := s_D > p (baseline captured at THIS commit's entry shows it)
7 | fixup | loop: D retired ⇒ not enumerated; fast-out: baseline.cas > p ⇒ FAILS ⇒ v_fx (retired-at-now ∋ D) ≠ v_r ⇒ urgent pre-paint setState ✓ (the mandated fallback — reachable because the baseline is captured before this commit's own folds)
(d) own-commit fold of a post-pin included write
8 | a k-attributed write @s2 > p lands mid-yield (e.g. scope.set); k retires AT P_k's commit | retired clause would admit s2 to committed truth while W rendered without it; fast-out conjunct ∀s∈mask: wc[s] ≤ p FAILS (wc[k]=s2) ⇒ fall through ⇒ v_fx folds s2 ≠ v_r ⇒ fire ✓ (if k stays live instead, the commit's own table update precedes layout, so w_fx's uncapped committed clause folds s2 and the compare FIRES value-true — committed truth really moved; the loop's runInBatch reconciles the pending side; one bounded eval — corrected per 5.10 errata, oracle battery case 9 (d′))
(e) reveal-shaped mount (Offscreen/Activity)
9 | watcher rendered by an older pass mounts during an unrelated commit whose folds move truth | passId conjunct FAILS ⇒ conservative fall-through ⇒ w_fx compare corrects pre-paint ✓
outcome: both reads resolve in the pass's world on first render; included tokens never double-render; every committed-side in-window motion corrects before paint.
residual: the fixup-window battery (included / retired-in-window / post-pin / reveal rows); the fast-out cost row.
```

### Case 10 — late subscription joins the pending batch (entanglement)

```
1 | k writes a; W not yet mounted | receipt; marking walk; no watcher record yet
2 | urgent pass mounts W on c-over-a (w_r excludes k) | TS(c)∋k ⇒ world path ⇒ committed value rendered ✓
3 | layout: subscribe, then fixup | loop: k live, slot(k) ∉ w_r.includedSet ⇒ fork.runInBatch(k, setStateW) — the corrective joins k's OWN lanes. A fresh startTransition would mint a token React never entangles with k ⇒ it could commit separately (torn) — that is exactly why the lane-scoped scheduling fact exists
4 | k's render | includes W ⇒ k-world value ⇒ ONE commit carrying k's updates and W's correction ✓
5 | race (i): k retires in the render→layout window | loop sees no live k; fast-out fails (cas moved past the baseline) ⇒ v_fx (retired ∋ k) ≠ v_r ⇒ urgent pre-paint setState ✓
6 | race (ii): k's pass already completed when the corrective lands | inserted-after-completion updates force a pre-commit restart (fork test 24) ⇒ k re-renders including W before its commit ✓
outcome: exactly one commit in the normal path; both races close with a named mechanism.
residual: fork tests 18/19/24; the fixup-window battery.
```

### Case 11 — multiple roots (declared scope: degraded multi-root)

Declared scope, explicit: **roots are supported; a spanning batch may
commit per-root at different times with visible cross-root skew; each
root remains self-consistent** — no root ever contradicts its own
committed DOM; corrections are urgent-scheduled, bounded, and documented.
Cross-root frame simultaneity is not promised (React itself commits roots
at different times, even for one transition). Nothing below forecloses a
future watermark-precision upgrade; v1 does not carry it.

```
1 | batch k writes atoms; spans roots A and B | receipts; marking; deliveries in k's lane on both roots
2 | A commits k first | per-root table: A.committedSlots gains k; A's root commit generation bumps; cas bumps; drain of k's touched list reconciles A's committed observers; k does NOT retire (B pending)
3 | later urgent render on A | its world: retired ∪ mask{U} ∪ A's captured committed set (∋ k) ⇒ k's writes included ⇒ A never contradicts its own DOM ✓
4 | A's passive effects after A's commit | committed-for-A ∋ k ⇒ observe k's values, before k fully retires ✓
5 | B still pending | committed-for-B ∌ k ⇒ B's urgent renders exclude k ⇒ cross-root skew is VISIBLE (the declared, documented loss) but B is self-consistent ✓
6 | B commits k | B's table gains k; k now committed everywhere ⇒ the fork retires k EXACTLY ONCE ⇒ fold, retirement stamps, durable drains; per-root table entries for k clear (subsumed by the retired clause); the slot releases unless an open pass still includes it
outcome: per-root self-consistency at every commit; a single global "committed" world never exists during the window (per-root tables); retirement is exactly once.
residual: the late-write window on a committed-but-live token (ActionScope surface, 5.3) is documented and urgent-corrected. The slot-lifecycle composition is verified clean: per-root rows key on (root, token) and clear at retirement before any release, and a token committed on one root while pending on another is still live and unreleasable — no per-root row can ever name a freed slot. Fork tests 15–17 are the per-root existence proofs, on the critical path.
```

Accidental second roots (modals, microfrontends, devtools overlays) are
therefore *supported*, not silently wrong; portals are the same root and
report the parent (fork test 23).

### Case 12 — store-only transitions persist; async is React parity

```
1 | startTransition(() => a.set(5)), no subscribers | receipt {5,T}; no React work ⇒ T closes committed=false ⇒ the SAME retirement path: fold ⇒ committed 5 ✓ persistence never depends on subscription
2 | action T: a.set(1) in the synchronous prefix | fork reports T ⇒ receipt {1@s1,T}; T parks (retires only when the returned thenable settles)
3 | await io(); continuation runs bare; a.set(2) RAW | fork reports NO batch ⇒ ambient default D ⇒ receipt {2@s2,D}; dev warning (action pending ∧ bare-context write): "wrap in startTransition or use the action scope"
4 | D retires on its own schedule | committed world folds retired entries: {2@s2} → a=2 — BEFORE the action settles. This is the ratified React-parity behavior: a raw setState after await does exactly this in React. (The original battery required post-await writes to wait for settlement; that requirement was cut with the carrier — the walk now documents the parity outcome.)
5 | T settles ⇒ retires | s1 retires; full prefix now retired ⇒ compaction replays base→set(1)→set(2) in seq order ⇒ base=2 ✓ committed value stays 2 (write order wins — matching React)
6 | re-wrap variant: await io(); startTransition(() => a.set(2)) | the inner transition context classifies the write ⇒ it renders and commits with the pending action (React entangles them) ⇒ settlement-timed commit ✓ — React's own prescribed composition
7 | scope variant: startSignalTransition(async (scope) => { scope.set(a,1); await io(); scope.set(a,2) }) | both receipts carry T explicitly (liveness-checked); T parks; fold at settlement ⇒ committed 2, not before ✓
outcome: store-only batches persist unconditionally; raw post-await writes are ambient (React parity, dev-warned); precise action timing is one re-wrap or one scope call away.
residual: the warning is a heuristic (bare-context writes from unrelated timers during a pending action can trigger it) — documented dev lint; fork tests 11–13 pin parking.
```

### Case 13 — counter/world-id lifecycle soundness

Walked against the lifecycle master table; every counter names its guard;
forced-small-counter and wraparound tests per row.

```
1 | quiescence → episode reset | renumber duty list rewrites every retained seq/stamp; epoch bump ⇒ every worldKey/capsule from the old episode mismatches in the new one ✓
2 | K1 bulk reset | cone carry first (quiescence walk below); K1 record generations bump ⇒ stale ids cannot validate ✓
3 | mid-episode slot recycle | immediate release under the tenancy orderings (stamp-before-release, claim-after-release, pin/seq-after-claim — 5.4); write clock zeroes and (watcher, slot) dedup bits clear at claim; touched dirt persists with its carried max retirement sequence until a safe re-intern sweep or episode reset; masks disambiguated by pin (V6) ✓
4 | per-root tables | root commit generations are epoch-guarded; committed-for-root worldKeys carry them ✓
5 | retirement stamps / cas / carried slot watermarks | renumber rewrites; all minted from the one global line ✓
6 | walk-generation wrap | renumber sweeps the last-walk column; forced-wrap test ✓
7 | node identity recycle | generation tags on K1 records and memo keys; pass-owned allocations gen-bump before free-list reuse (StrictMode mount/abandon soak) ✓
8 | capsule generations | suffix-drop bookkeeping only; settlement validates thenable REFERENCE identity, so a stale thenable settling after wrap is inert ✓
9 | live horizon | reserve check at atomic-extent entry; discardAllWip-first renumber; forced-tiny-horizon rows (oversized commit at low reserve observes the PRE-entry renumber; the mid-extent throw stays dead code) ✓
10 | token serials | separate, never-renumbered domain; retired tokens are never re-interned ✓
outcome: no stale cache entry, mark, or world record from a previous episode can validate in a new one; the retainer audit is a schema-checked table, not prose.
residual: the forced-wraparound suite; the whole conformance suite run inside a synthetic late-counter episode.
```

### Case 14 — StrictMode and replayed renders

```
1 | double-invoked render | world reads hit the same memos (pure); K1 edge adds idempotent; no observable graph mutation across the discarded twin ✓
2 | render-phase write | frame check ⇒ throw (all builds) ⇒ no double-fired writes ✓
3 | double-mounted effects | microtask-debounced observed-count nets one subscription ✓
4 | useComputed, second invoke | hook-state deps compare: equal ⇒ same node reused; the double-created first-mount node (React keeps the second result) is pass-owned and freed at discard with a generation bump — the mount/evaluate/abandon soak pins the reclamation ✓
5 | discard + replay | deps equal committed ⇒ committed node reused (no recreation); deps genuinely changed ⇒ a fresh node again, freed again if discarded ✓ idempotent at every stratum
6 | thenable identity | lineage-positional capsules; the lineage id is stable across replays ⇒ the SAME thenable per world ⇒ React's retry settles — never re-suspends forever ✓
outcome: replays are idempotent across memos, nodes, capsules, and subscriptions.
residual: StrictMode rows in the React-integration harness.
```

### Case 15 — Suspense across worlds (the kept hard case)

```
1 | transition k: c suspends on k-world data | capsule (lineage L, position) minted lazily; prefix records [(atom, fp)…, (computed, nodeGen)…]; the pass suspends via the React use protocol
2 | a component mounts mid-transition reading c | same root × batch-set ⇒ same lineage L ⇒ the SAME capsule/thenable ⇒ consistent suspension; the canonical world never evaluates the k-capsule (per-world memos; sentinels are cached values) ✓ — this is the react-concurrent-store known-bug schedule, kept and handled
3 | promise settles; React retries | new pass, same lineage; no evaluator stamps exist to drift (evaluators immutable; deps unchanged ⇒ same node) ⇒ prefix pairwise-equal ⇒ settled value consumed ⇒ render completes ✓ no refetch livelock
4 | k commits with the settled value ✓
5 | a cross-batch retirement touches a prefix atom between fetch and retry | retirement stamp moves the fp ⇒ prefix mismatch ⇒ drop from that position and REFETCH from the moved world (generation-bumped; settlement guarded by thenable reference identity) ✓ correct — and v1 accepts that a content-NEUTRAL flip (equal folded value) also refetches: duplicate fetch, never wrong data (the value-revalidation refinement is deferred — appendix A)
6 | the world key for multi-batch passes | the lineage id is per (root × batch-set) — single tokens drift on unrelated commits, live-set ids churn, pass serials refetch forever; lineage is the settled key, dead at commit/abandon
outcome: identity = lineage; validity = receipt-line content; canonical isolation by per-world sentinels.
residual: prefix length and refetch frequency ride the world-evaluation spike; purity pins retry determinism (case 14).
```

### Case 16 — effects observe committed state only

```
1 | default D applied-not-committed: a.set(1) | receipt; K0 a=1
2 | an unrelated retirement flushes useSignalEffects | effect e evaluates committed-for-root: D not retired, not in the root's table ⇒ a=0 ✓ excluded
3 | D commits | fold; retirement stamp on a; D's touched list ∋ e ⇒ e re-runs ⇒ sees 1 ✓
4 | older entry becomes visible beneath a visible max (a retirement flip) | the retirement stamp moves e's snapshot fingerprint ⇒ re-run ✓
5 | a per-root commit flips the root's committed view | the root commit generation bumps ⇒ e's snapshot header mismatches at the drain ⇒ revalidate by value ⇒ re-run on change ✓
core | core effect() contract | NEWEST, documented: it observed a=1 at step 1's flush — stated, walked, conformance-pinned
outcome: two effect contracts, both stated, mechanically distinct (world fold vs kernel read); the cheap pre-filter (committed-advance counter) may only skip work when nothing moved, never suppress a moved-fingerprint re-run.
residual: the effect conformance rows incl. the pre-filter-never-suppresses test. Deps changes ride React's native re-fire (3.2): cleanup, re-run, re-track, re-subscribe — later writes reach the new subscription through the ordinary walk.
```

### Case 17 — optimistic rollback

**The feature is deleted.** No truncation surface exists: React batches
never truncate, and committed=false batches fold. A public-API snapshot
test forbids accidental export of any truncation affordance. Optimistic
UI composes from separate atoms plus actions (documented pattern:
render `optimisticAtom ?? baseAtom`; clear the optimistic atom when the
action settles).
outcome: the case is discharged by interface restriction; detection = the
API surface test.

### Supplementary walk — quiescence refresh with cone carry

```
1 | quiescence: no live tokens/pins/parked actions | refresh set = K1-touched nodes holding committed watchers or effect-dep snapshots: one kernel pull each ⇒ committed basis edges restored in K0 (the reach induction's basis premise for the next episode)
2 | node w's refresh WRITES (legal in core) twice | exempt w; carry its FULL reverse-reachable K1 cone (both endpoints of every in-edge path x→u, u→w) into the next episode — direct-in-edge carry loses x→u and was a walked kill
3 | episode reset | epoch bump; K1 cleared except the carried cone; counters renumbered (case 13)
4 | new episode: k writes x | the walk follows the carried x→u→w ⇒ the watcher is delivered in k's lane ✓ no tear
5 | termination | the two-strike rank strictly decreases per failed sweep; a fixed observed set resets in ≤2N+1; unbounded new observed work belongs to the ordinary loop budget
outcome: exemption preserves the induction; the cone is finite, traced, dev-warned on growth.
residual: cone-size soak; permanent-writer retention is a declared gap.
```

---

## 7. Gates and numbers

Nothing unmeasured is asserted; every number below is measured in this
repository or its sibling (exact provenance keys in appendix C). Rankings
are only valid one framework per process — feedback pollution skews
results up to 3×.

| gate | budget / comparator | status |
|---|---|---|
| DIRECT parity | DIRECT ≤ alien-signals v3 on every tier-0 shape; 179/179 conformance + arena-growth stress + exact pull counts | **MEASURED**: deep 0.90×, broad 0.84–0.88×, diamond 0.89×, reads 0.74–0.87×, create 0.96×. Kairo-scale GC-inclusive reality ≤1.4× (honest ceiling; ≤1.25× is a target with no named mechanism). CI symbol diff proves zero concurrency instructions in the DIRECT bundle |
| Idle overhead | LOGGED-mounted-quiet ≤ **3%** on tier-0 (ratified budget) | Measured floor 2.4–3.8% under load; the idle-machine measurement is demoted to informational; the mitigation ladder ships only if a clean idle number exceeds 3%. Instruction ledger: routing word test (1 load+cmp), untracked-read taint check (1 tape/bits test, LOGGED only), re-track taint sweep (1 AND per dep per recompute), suppression registry check (suppressed path only), fixup fast-out compares |
| Logged write | ≤ 2× a DIRECT write | UNMEASURED → write-price spike (walk-generation stamp + taint transitions priced here) |
| Fan-out | propagate ≤ 2× DIRECT; ≤ 1 spurious render per (watcher, slot, cycle) | UNMEASURED → fan-out spike (value-blind grid + held-batch row) |
| Mount fixup | clean mount: zero work; else ≤ \|touched ∩ live non-included\| correctives + ≤1 world eval only when committed-side state moved; fast-out ≤ 3 + popcount(mask) compares; 10k mounts ≤ 15% | UNMEASURED → mount-storm workload (incl. 10k mounts inside a committing transition; reveal-shaped mounts pay one eval each) |
| World evaluation | cost ∝ flagged region; restart-heavy typeahead; prefix length | UNMEASURED → world-evaluation spike; pre-named fallbacks: pinless-frontier hybrid; whole-mask clock vector for suspense prefixes |
| Retirement (engine) | retirement engine overhead ≤ 2× a DIRECT `batch()` on the identical write/effect graph; user callback time reported separately | UNMEASURED → retirement spike (A/B; the split comparator — a render-relative gate has a zero denominator on store-only batches and is dead) |
| Retirement (React) | reconciliation ≤ 2× the equivalent useState render/commit for reached watchers | same spike |
| Memory / re-render | 0 steady-state allocations; signal re-render ≤ 10% vs useState | harness |
| World-graph growth | K1 + mirrors bounded on the soak, or the declared gap stands documented | growth soak spike: >1 MB/h steady growth or >5% walk degradation ⇒ extend the mid-episode sweep predicate (sampled reachability) |

**The twin-build requirement.** DIRECT and LOGGED are two bundles sharing
kernel bytes with a swapped operation table; the DIRECT bundle must
contain zero concurrency instructions (CI symbol diff). This exists
because the read-branch and dormant-hook taxes were measured and
triggered their gates: the remedy is build-time, not runtime.

**Storage must stay packed** (measured facts an implementation must not
regress):

- Record interleaving beats parallel arrays for hot traversal fields:
  naive one-array-per-field measured **1.8× worse than objects** on deep
  chains. Cold, rarely-touched parallel columns are not covered by that
  result.
- Nodes and links share one plane: −2% deep / −8% diamond vs split
  planes. A links-only arena (object nodes + integer links) **loses**:
  the id→object→flags hop adds a dependent load per traversed link —
  kairo 1.2–1.6×, creation ~1.7× vs alien. Full-arena (flags/topology
  in-plane) is required for the traversal win.
- Buffers as closure constants are the only binding at const parity;
  segment tables +35–40% per access, resizable ArrayBuffers +66–83%
  traversal, mutable `let` +34–43%, per-function aliases +26–30%. Growth
  = closure rebuild at operation boundaries.
- Bundlers demote module-scope `const` → `var`: +15–21% on kairo through
  a bundled child. Same-file non-exported `const enum` inlines everywhere
  that matters; cross-file does not.
- V8 inlining: ~460 bytecodes/callee, 920 cumulative, greedy ≤27;
  typed-array access ≈2× the bytecode of property loads. The monolithic
  475-bytecode link function silently never inlined; the split 168-byte
  fast path won 8–13% on traversal shapes. Budgets are CI-enforced.
- Value storage: one packed `unknown[]` side column beats type-segregated
  columns; never holey.
- JSC (bun) inverts some V8-tuned rankings; the arena still wins there,
  but V8-specific tunings don't travel — rank per engine.

**Cost-model compliance:** eager per-write world evaluation is the
expensive shape and is avoided (walks mark and deliver; folds are lazy);
always-log is priced at the write gate, not wished away; the host
boundary is free but the storage move costs 5–12% — values stay
in-plane.

---

## 8. Testing plan

**Oracle first.** Before any machinery: a naive replay-model oracle — an
obviously-correct implementation that stores every write and computes
every world by brute-force fold — driven by randomized schedules
(interleaved batches, yields, retirements, mounts, forced-small
counters). Every engine milestone diffs against it. This is the designed
next verifier: the loop's residual defect class was repairs minting seam
bugs, which executable verification catches and paper review had stopped
catching.

**Pinned scar scenarios** (each was a walked kill somewhere in this
design's history; each is a named regression test):

- flushSync excluding a pending default batch (case 2, exact schedule).
- Rebase arithmetic: 4-not-3; plain set commits 5-not-6 (case 3).
- Two-batch re-notify in the second batch's lane (case 4).
- Cutoff-suppressed first write, effective second write (case 5).
- Yield-gap same-slot write against a pinned open pass (the pass-aware
  suppression schedule), including the completed-but-uncommitted frame
  variant.
- Equal write after a pending write; overlapping equal transitions
  (case 8).
- Foreign retirement in the render→commit mount window; own-commit fold
  of a post-pin included write; reveal-shaped mount (case 9 rows).
- Late-subscription races (i) and (ii) (case 10).
- Store-only persistence, committed=false fold; async action with the
  raw-ambient row, the re-wrap row, and the scope row (case 12).
- Union-cycle walk termination fuzz + walk-generation wrap row.
- The untracked-taint family including the tracked-serve and
  equality-cutoff horns (case 1 taint member).
- The slot-recycling family (the verification's attack schedules, all
  pinned): paused-pass exclusion after release (the excluding pass must
  keep world-routing off the recycled slot's dirt); mid-pass retirement
  of an *included* batch (release blocked; clause 2 load-bearing;
  deferred release re-checked at passEnd, commit and discard); a new
  pass folding both tenants' history after recycling (replay order, no
  double-apply, no spurious mount correction); the recycled tenant's
  writer's world plus the dedup-clear-at-claim row (a stale bit must
  never suppress the new tenant's first delivery); sweep/compaction
  interplay (compaction is slot-blind); the multi-root composition
  (per-root rows clear before release); the keystroke storm; the
  full-table backstop corner.
- Forced-tiny-horizon renumber rows; out-of-order thenable settlement
  across capsule-generation wrap.
- StrictMode mount/evaluate/abandon arena-reclamation soak.
- Mount-mid-transition with suspending pending state (the
  react-concurrent-store known bug, case 15 row 2).

**Fork tests before bindings.** The reconciler-level suite of section 4.4
is on the critical path: the per-root facts (tests 15–17, 25) and the
serialization/insertion facts (22, 24, 28) have no current-generation
React existence proof. Build these against the fork before writing the
bindings that consume them; they re-run on every fork rebase.

**Conformance surfaces:** the 179-case reactive-semantics suite with
exact pull counts, under forced arena growth; the
react-concurrent-store harness's 14 scenarios; differential
useState/useReducer batteries (stable-reducer scope) asserting value
*and* reference parity at every step; the API snapshot test (no
truncation surface).

**Spike gates** (pre-registered decision rules; fallbacks are designed,
never improvised):

| spike | decides | fallback on failure |
|---|---|---|
| idle-tax measurement | informational only (the ≤3% budget is ratified); ships the mitigation ladder only if a clean idle number exceeds 3% | compile-time splitting of untracked call sites; LOGGED rebuild tiers |
| fan-out spike | propagate gate; spurious-render bound | per-slot-mark delivery dedup per render cycle — adoptable **only with its own walked schedule** (equality cutoffs on delivery are dead forever) |
| write-price spike | logged-write gate | inline-2 receipts; tape pooling |
| world-evaluation spike | held-open bursts, typeahead restarts, prefix length | pinless-frontier hybrid; whole-mask clock vector |
| retirement spike | both retirement comparators | (comparator is already the repaired split form) |
| edge-mirror validator | mirror overhead in dev/CI | >10% dev ⇒ sampled validation |
| growth soak | world-graph growth honesty | extend the mid-episode sweep predicate |

---

## 9. Build order

1. **Oracle** — the replay model + randomized schedule driver + the
   pinned scar list as its first corpus.
2. **Fork reconciler tests** — section 4.4 against the fork; the
   existence proofs gate everything downstream.
3. **Kernel port** — K0 donor arena, twin builds, CI symbol diff,
   bytecode budgets, 179/179 + growth stress. DIRECT parity gate here.
4. **Tape and slots** — receipts, visibility, folds, compaction,
   retirement, the per-root table, immediate slot release under the
   tenancy orderings, the dirt-disposal and dedup-clear rules, the
   backstop. Oracle-diffed.
5. **Routing** — K1, the touched word, taint, marking/delivery walks,
   the fast path. Oracle-diffed under randomized world reads.
6. **Memos** — worldKeys, the ladder, fingerprints, per-atom fold memos,
   committed-reference installation.
7. **Bindings** — watchers, per-write delivery with pass-aware dedup,
   mount fixup, effects, the hooks (`useComputed` recreation,
   `useReducerAtom`, `useSignalEffect`). Differential batteries live
   here.
8. **Suspense** — lineage capsules, prefixes, settlement identity.
9. **Actions** — parking integration, ActionScope, the dev-warn
   heuristic.
10. **Lifecycle** — episodes, quiescence refresh + cone carry, renumber
    + horizon protocol, growth sweep.
11. **Gates** — run every spike at its milestone; apply pre-registered
    fallbacks on failure; soak suites last.

---

## Appendix A — deferred to v1.1

- **Suspense refetch-avoidance (value revalidation).** On a prefix
  fingerprint mismatch, re-fold that atom in the capsule's world and
  compare values before refetching: equal ⇒ re-stamp the position in
  place and keep the settled resource (no duplicate fetch under
  content-neutral stamp churn — e.g. an unrelated retirement touching a
  prefix atom without changing this world's fold); different ⇒ drop and
  refetch as v1 does. Correctness in v1 is unaffected; only duplicate
  fetches are at stake. The refinement must keep the rule that a
  genuinely moved world refetches, and must stay retry-stable.
- Not scheduled, explicitly not foreclosed: watermark-precision
  multi-root (per-root write-prefix visibility restoring cross-root
  spanning exactness).

## Appendix B — editorial flags

Genuine ambiguities met while merging; each is one sentence, none is
decided in the body beyond what coherence required.

1. **Per-root generation:** the multi-root cut deleted lock views and
   their version id but committed-for-root memos, effect-snapshot
   headers, and the fixup fast-out still need a per-root re-keying
   version, so this text carries a minimal "root commit generation" in
   the kept per-root table — the smallest analog of the deleted id, not
   explicitly specified by any input.
2. **Reducer identity post-cut:** the recreation cut names `useComputed`
   only; this text generalizes "constructor reducers are immutable" to
   all reducer atoms (reducer fixed at creation, changed identity
   dev-warned and ignored), which forfeits React's swap-the-reducer
   parity — the narrowed differential scope is stated in 3.2 but the
   generalization itself is editorial.
3. **Write-set closure at commit:** token-membership lock-in is exact
   only if a batch's write set is closed by first commit; the surviving
   late-write surface (ActionScope on a pending, already-committed
   token, and whatever token the fork assigns re-wrapped continuations)
   is documented in 5.3 with urgent-corrected behavior, but the fork's
   token identity for re-wrapped continuations was not re-derived by any
   input post-cuts (the slot-lifecycle side is verified).
   MODEL-CHECKED (2026-07-05): consistent — the surviving surface
   composes cleanly with the slot lifecycle, but it is invisible to
   every fast-out conjunct and is sound only via corrective coverage;
   see the 5.10 errata, correction 2.
4. **Pass-world membership pin cap:** rendering "token membership" for
   pass worlds as (slot ∈ captured committed set ∧ seq ≤ pin) is an
   editorial composition to preserve pinned-world stability across
   yields; no input states the clause post-cuts, though the slot
   verification's tenancy arithmetic leans on exactly this seq-vs-pin
   exclusion.
   MODEL-CHECKED (2026-07-05): correct — removing the cap makes a
   yielded pass's value drift when a committed-member live token writes
   after the pin, precisely the forbidden drift.
5. **Fixup fast-out conjunct set:** the ratified five-conjunct fast-out
   lost its abandoned-stages conjunct (staging deleted) and had its
   lock-view conjunct re-anchored to the per-root generation; the
   four-conjunct population argument in 5.10 is re-checked editorially,
   not by an adversarial round.
   MODEL-CHECKED (2026-07-05): three normative corrections — the clock
   conjunct quantifies over mask TOKENS at commit time; the corrective
   loop is a stated premise (invariant: suppressed divergence must be
   exactly corrective-covered); case 9 row 8's parenthetical was wrong.
   All folded into 5.10 (errata block) and pinned in
   packages/cosignal-oracle (tests/FLAGS.md, fuzz seeds 29/173/97).
6. **Horizon reserve formula:** the commit reserve lost its
   staged-hooks term with the staging deletion; the remaining terms are
   carried unchanged and the schema constants still need CI derivation.
7. **Backstop without the pass flag:** the slot verification sketched a
   pass-flagging compensation for its sweep-at-release disposal variant;
   this text adopts the keep-the-dirt disposal, under which the
   persistent bits already route retained passes conservatively — so the
   backstop ships flag-free and the degradation machinery stays deleted,
   a reconciliation made editorially from the verification's own
   analysis.
   MODEL-CHECKED (2026-07-05): correct — with receipts denormalizing
   their slot at mint, a forced release changes no pinned fold; the
   retained pass's world is byte-identical across the backstop
   (receipt-level half verified under fuzzing; the keep-the-dirt half is
   engine-side and lands with the LOGGED build).

## Appendix C — traceability

The body cites nothing; this table maps it to the genome for auditors.

| spec section | sources |
|---|---|
| 1 (story) | consolidate-a §1; round-5 §"story" paragraph; cuts C1–C6 applied |
| 2 (vocabulary) | SEEDS/background.md; consolidate-a §2 |
| 3.1–3.2 (API) | consolidate-a §11.5/§13; D14, D18, D21; C17 deletion |
| 3.3 (useComputed) | cut C3 (ratified); D19/T1 (pass-owned allocation); replaces I22/I31/I40/I41, R1/R3, RS1/RS2/RS4, F9 |
| 3.4 (previous) | D24 (replaces D16's three-way rule) |
| 3.5 (async) | cut C1 (ratified); D17-era ActionScope retained per D21; replaces I26 carrier half/I30/I36/I37 transform+shims+boot-test; parking = F3 fact |
| 3.6 (rejections) | I28 (D14), R8-render-writes, realm affinity (round-3 ActionScope armor) |
| 4 (fork) | consolidate-a §14 F1–F7 (F8 deleted with C1, F9 with C3); RS6 (discardAllWip); Δ5/RS3 capture-at-entry (test 26); fork tests renumbered from the merged 1–36 list minus F8/F9/carrier/saturation rows |
| 5.1 | consolidate-a §4; D1; S6 |
| 5.2 | D4; [ARENA]; I11 |
| 5.3 | consolidate-a §5.1–5.3; D2, D3, D9, I2/I7/I15/I21/I25(replaced by membership)/I29; R9 (fold memos); RS7 (cas mint sites); C1+C2 cuts simplify visibility to two clauses; L6 (committedAdvanceSeq) |
| 5.4 | **D25** as amended by its passed adversarial verification (design-loop/monitor-checks/c5-slot-release-verification.md: A1–A4 applied, A5 guard dropped for the Monotone Tenancy Lemma, A6 vacuous post-C3 since no version entries exist); deletes I10/I39 retention+saturation, R5, C1-X5, fastPathDisabled |
| 5.5 | consolidate-a §6.2–6.3, §7 (L1 taint merge; I17/I23/I33; E-PRESERVE strong reading = R10 round-3); TAINT-COMPLETE construction |
| 5.6 | consolidate-a §6.4 invariant R, reduced: source 3 (evaluators) vacated by cut C3; source 4 (erasure) rewritten under D25; I4/I12 |
| 5.7 | consolidate-a §8 (I16 closed table; ladder) minus the evaluator vector (L3) per cut C3 |
| 5.8 | consolidate-a §9; D11/D16(ctx.use); R10 round-4 (settlement identity); cut C6 defers I35 value revalidation |
| 5.9 | D5/D10/D13; consolidate-a §10 (walkGen I32; atomicity L7); R2 + Δ6 (pass-aware dedup); verification A1 (dedup clear at re-intern); R4 + RS1-drain-time clarification (durable drains); R14 (two traversals); I23 |
| 5.10 | consolidate-a §11.2 (L2 w_fx); R6 (per-clause bound, reduced); R12→Q2→Q2′/RS3 (conjuncts 0–3 post-cuts); I13/I18/I43; K2a/K2b/K3 schedules |
| 5.11 | consolidate-a §11.3–11.4; C16 contracts; D18; S20 (cas never validity); T2's header duty re-anchored (flag 1) |
| 5.12 | consolidate-a §5.5 + R8 + RS5 + RS6 (renumber/horizon); R13 (G9 growth + sweep); I8/I19/I42; §15 master table post-cuts |
| 5.13 | consolidate-a §13 minus reducer staging (C3 cut); R7/R8/R11 pins |
| 6 case 1 | consolidate-a C1 core/V2–V7 + X2/X3/X4 rewritten; X1 replaced (C3 cut); X5 deleted (D25); retention/saturation members re-walked from the verification's schedules (its §4.1, §4.3–4.4, §4.7) |
| 6 cases 2–10 | consolidate-a §17 + round-4 R2/R4/R6 amendments + round-5 Q2′ rows (K2a/K2b/K3), post-cut conjuncts; case 7's included-batch variant = verification §4.2 |
| 6 case 11 | seed C11 degraded option per cut C2; consolidate-a C11 walk minus watermarks |
| 6 case 12 | cut C1: React-parity rewrite; D2; parking F3 |
| 6 cases 13–14 | consolidate-a C13/C14 + R7/R8/RS5 rows, post-cut state list |
| 6 case 15 | consolidate-a C15 minus L3 stamps (C3) and minus I35 revalidation (C6); D11; R10 |
| 6 case 16 | consolidate-a C16/C16-D/B1; flag 1's header substitution |
| 6 case 17 | consolidate-a C17 (deletion + snapshot test) |
| 6 quiescence | consolidate-a T8-N; I42; R16 round-3 |
| 7 (gates) | research-facts.md ([ARENA][SYNTH][GUIDE][LINKS][RESEARCH]); [SPKHQ→O19]; **D26** (≤3%); G-A deleted (C1); G-* table post-cuts; SPK-L/N1/G8/W/R/SP2/SPK-K1 renamed plainly |
| 8 (testing) | D6 (oracle-first); O7/O23 (fork tests first); SCARS-derived pinned list; O24 (D13-fallback obligation); react-concurrent-store bar |
| 9 (build order) | EXIT-CASE implementation phase; **D27** (green-light) |
| A (deferred) | cut C6 wording; C2 non-foreclosure line |
| B (flags) | this merge |

Spike-name map: idle-tax = SPK-L; fan-out = SPK-N1; write-price = SPK-W;
world-evaluation = SPK-G8; retirement = SPK-R; edge-mirror validator =
SP2; growth soak = SPK-K1. Provenance keys: [ARENA] libs/arena results;
[GUIDE] research/packed-structs-guide.md; [LINKS] libs/arena-links A/B;
[RESEARCH] research/RESEARCH.md; [SPKHQ] the kernel-hook-tax experiment
(recorded in NOTES/OPEN.md item O19); measured carrier numbers (I30) are
moot post-cut. Decision registry: design-loop/NOTES/DECISIONS.md
(D1–D27); ratified cuts: design-loop/EXIT-CASE.md (C1–C6, as amended by
D24/D25); slot-release verification:
design-loop/monitor-checks/c5-slot-release-verification.md
(sound-with-amendments, 2026-07-05).

*End of specification.*
