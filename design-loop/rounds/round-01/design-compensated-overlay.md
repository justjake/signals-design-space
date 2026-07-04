# Design: COMPENSATED OVERLAY (round 1)

Stance: one canonical kernel, untouched and fastest; concurrency is an overlay
of write receipts and per-world caches whose invalidation and notification are
COMPENSATED explicitly and completely — designed first-class, not bolted on.
Every completeness obligation is structural and enumerable (checkable by an
invariant sweep); coverage is proven by the first-divergence induction (I4);
the quiescent fast path costs zero overlay instructions in pure-core mode and
one guarded load per read when React is mounted but quiet.

---

## 0. One-page summary (the whole concurrency story)

There is exactly one kernel, **K0**: the proven arena kernel (alien-signals v3
semantics on one Int32Array plane, 179/179 conformant, faster than
alien-signals on every tier-0 shape [ARENA]). K0 stores **canonical** values:
everything retired plus every applied urgent write. Pure-core (no React) users
run K0 and nothing else — zero concurrency instructions (D1, P3).

When the React bridge registers (monotonic, never keyed to watcher count —
S6), every write gains a **receipt**: `{atom, op, batchToken, seq,
retiredSeq}` appended to a per-atom tape (always-log, I1). A **world** is
"retired writes + the writes of an include-set of live batches, up to a pin";
any world's value for an atom is the replay, in global write order, of its
visible receipts over the atom's base record (I2/D3 — this is React's own
lane-filter-and-rebase arithmetic, stated as math). Urgent writes additionally
apply to K0 immediately, so K0 *is* the newest world and quiet reads never
fold.

The rest of the design answers one question two ways — *"which nodes might
disagree with K0 in some world?"* — once for reads, once for notification:

- **Reads.** A per-node **overlay mark** (side plane, one int, O(1) bulk clear
  by era floor) means "a live-or-just-folded write exists in this node's
  canonical cone." Mark clear ⇒ all worlds agree with K0 ⇒ serve K0 directly
  (this implication is proven in §6.3 via the first-divergence induction I4;
  it is the fast path and the zero-cost story). Mark set ⇒ the read resolves
  its world (a per-callstack fork query; handlers in yield gaps get "no
  world" = K0, resolving C7/S7) and goes to the **world memo plane**:
  per-(node, include-mask) cached values, validated in two layers — L1:
  per-slot write clocks + a retirement clock (three loads); L2: the memo's
  **read certificate**.
- **Certificates.** Every world evaluation records its COMPLETE read set
  (S5): an `(atomId, visibleTailSeq-or-0)` entry for every atom it read —
  including atoms with no receipts yet, recorded as tail 0 — plus an
  `(nodeId)` dep-entry for every unmarked computed it served from K0. Child
  certificates flatten into parents. Certificates are indexed into
  **source-keyed buckets**, so a write knows exactly which world caches it
  can affect. This closes C1: the divergent dep `a` has a tail-0 entry; the
  later `a` write hits `bucket[a]`, kills the memo, and notifies in k's lane.
- **Notification.** Every React-mode write (and every retirement fold)
  synchronously walks the written atom's canonical cone in K0 — stamping
  marks, draining dep-entry buckets at clear→marked transitions, and
  delivering watcher `setState` in the writer's execution context (D5), with
  per-(watcher, batch, pass) dedup bits so a second batch (C4) or a
  post-pass-start write (C5) always lands. Canonical cone catches every
  *first* divergence (I4); buckets catch every *subsequent* one; the
  induction over write sequence numbers (§6.3) proves the union is total.

Retirement replays the atom's full tape over its base (never "apply my ops to
current K0" — that is the C3 3-vs-4 bug), stamps marks along the fold, runs a
reconcile check so already-correct committed renders are not re-rendered, and
sweeps every memo/cert/thenable whose mask contains the retiring slot (T6
hygiene: nothing keyed to a slot survives the slot). Per-root committed views
(K0-visible mask per root, fed by fork per-root commit lock-in) give full
multi-root spanning support (C11) and committed-only effects (C16) through
the same world-read machinery.

The fork exposes 8 protocol facts (integers and callbacks only): batch token
of the current write; pass start/end with include-mask + lineage id; a
per-callstack render-context query (true across yields); retirement
(exactly-once, committed flag, async-action parking); per-root commit
lock-in; `runInBatch`; DOM mutation window. The signals library depends only
on the protocol document; the rebase drill answer is "nothing moves."

Mechanism inventory: **11** (§2). Seam touch-points: **8** (§11).

---

## 1. Vocabulary (plain English, before use)

- **K0** — the canonical kernel: the arena from `libs/arena` (stride-8
  interleaved node+link records in one Int32Array; values in one packed
  `unknown[]` column; iterative walks; split link fast path). Closed and
  monomorphic (D4): no per-link world state, no callbacks in its hot walks,
  CI bytecode budgets. Its cached values and dependency edges always describe
  the **canonical world**.
- **Canonical world** — retired writes ∪ applied urgent live writes. K0's
  values embody it.
- **Receipt** — one logged write: `{atomId, opRef, batchSlot, seq,
  retiredSeq}`. `opRef` points into a packed ops column (a set value, an
  updater fn, or a reducer action — R3 actions ride the same tape).
- **Tape** — an atom's receipts in seq order, plus a **base record** (the
  value before the oldest unswept receipt).
- **Batch token / slot** — fork-minted integer identity `(serial<<1)|deferredBit`
  for a batch; interned to a 5-bit **slot** while live (≤31 live, I10).
  Slots recycle only when their unswept-entry count is zero.
- **World key (mask)** — a 32-bit set of live slots. A **world** =
  `(retired ≤ pin) ∪ (receipts with slot ∈ mask and seq ≤ pin)`.
- **Pin** — the seq snapshot taken at pass start; a pass's world must not
  drift across yields.
- **Overlay mark** — per-node int in a side plane (`markPlane[nodeId]`),
  compared against a global **era floor**; "≥ floor" means a live write (or a
  fold since the floor) exists somewhere in this node's canonical cone.
- **World memo** — a cached `(node, mask)` value in the **speculation plane**
  (bump-allocated side plane of fixed-size records + packed value column,
  per-node chains, bulk episode reset).
- **Certificate** — the complete read record of one world evaluation: atom
  entries `(atomId, tailSeq-or-0)` + dep entries `(nodeId)` for unmarked
  K0-served computeds. Stored next to its memo; indexed into buckets.
- **Bucket** — `bucket[sourceId]` → chain of certificate references; the
  reverse index "which world caches read this source."
- **Watcher** — a mounted component's subscription record: a K0 subscriber
  node (so canonical walks reach it) + overlay fields (last-rendered mask,
  pin, epoch; dedup bits; latest certificate).
- **Drain** — this design has no deferred drain: every write is processed
  synchronously in the writer's stack (receipt, apply-if-urgent, walk,
  deliver). "Drain-time re-validation" from the stance is therefore
  *write-time* re-validation; the stance's registries and re-validation are
  the buckets + walk of §7–8.
- **Episode** — the interval between quiescent points (no live batches, no
  open passes). Planes reset and counters restart at episode boundaries,
  epoch-guarded (I8).

## 2. Mechanism inventory (numbered; the judge counts these)

Substrate (not counted): K0, the arena kernel, unchanged; plus the inherited
process apparatus (D6).

1. **M1 Write receipts** — per-atom tape + base record + global `seq`;
   always-log in React mode (I1); fold = full-order replay (I2). §5.
2. **M2 Batch registry** — token mint/intern, slots, include masks, per-slot
   write clocks, retirement clock, per-slot unswept counts, slot lifecycle.
   §5.4, §9.
3. **M3 Write walk** — one synchronous canonical-cone traversal per
   React-mode write and per retirement fold: stamps marks, drains dep-entry
   buckets on clear→marked transitions, checks the written atom's bucket,
   delivers watcher setStates in the writer's context with per-(watcher,
   batch, pass) dedup. §8.
4. **M4 Overlay marks + era floor** — per-node side-plane stamp; O(1) bulk
   clear; the read fast-path gate. §6.
5. **M5 World memo plane** — per-(node, mask) value records with L1 validity
   stamps (slot write clocks + retirement clock). §6.2.
6. **M6 Read certificates + source buckets** — complete-read-set records
   (S5-compliant), flattening, bucket index, L2 validation. §7.
7. **M7 Evaluate-then-recheck** — fresh nodes and first world evaluations
   re-validate their certificate against the tape after evaluating, before
   publishing the memo (closes the eval→register race; C9b). §7.4.
8. **M8 Post-subscribe fixup** — layout-effect re-check of the
   render→subscribe gap; corrective setState scheduled via `runInBatch`
   (retired-token fallback → urgent). Closes C10. §10.4.
9. **M9 Retirement fold + reconcile** — full-order replay into K0 base,
   fold-walk marking, reconcile check against watchers' last-rendered
   (mask, pin), certificate promotion to K0 edges for committed renders,
   per-slot sweep. §9.
10. **M10 Per-root committed views** — `locked[root]` mask table fed by
    per-root commit lock-in; composes every pass world and every effect-flush
    world. Gives full C11 and C16. §10.6.
11. **M11 Per-world thenable cache** — positional thenables keyed by
    `(node, mask, position)` with retirement-bound lifetime and commit-time
    promotion to the node's committed cache. §10.7.

Everything else in the design is one of: K0 itself, plain policy wrappers
(equality/error/suspense sentinel boxes), or process apparatus.

## 3. Modes and activation

- **DIRECT mode** (no React bridge): atoms/computeds/effects compile to K0
  calls only. No receipts, no marks, no walks, no fork queries. Zero
  concurrency instructions (P3). This is the benchmark configuration (R13):
  exact pull counts, synchronous effect flush available via `configure`.
- **REACT mode**: entered once, when `cosignal/react` registers the bridge
  (feature-detects the fork protocol; throws on stock React). Activation is
  monotonic and global for the store, never keyed to watcher count (S6):
  the write/read dispatchers are rebuilt once at registration (closure
  rebuild at an operation boundary — the measured-safe binding pattern
  [GUIDE]). From that moment every write logs a receipt (I1/D1).

SSR/hydration (R10): server runs DIRECT; state serializes as base records;
hydration constructs K0 from them. No worlds exist server-side.

## 4. K0, unchanged (the substrate contract)

K0 is `libs/arena` as-is: alien-signals v3 push-pull with exact
re-verification, equality cutoff, re-track on evaluation (DEPS_TAIL cursor),
iterative walks with persistent scratch stacks. The overlay uses exactly
three K0 capabilities, all already public or trivially exposed without
touching hot paths:

- `readCanonical(node)` — normal tracked/untracked read (pull + verify).
- `subscribers(node)` — iterate outgoing edges (used by M3's walk; read-only
  traversal of existing link records).
- `writeCanonical(atom, value)` — normal atom write with kernel dirty
  propagation (used for urgent applies and retirement folds).

No kernel record gains a field; no kernel walk gains a branch (D4). The
overlay's per-node state lives in side planes indexed by the same node ids
(cold parallel columns are not covered by the interleaving hazard — the
1.8×-worse result was for *hot traversal* fields [RESEARCH]; mark loads are
one column touched once per read, gated in §12).

Values, equality, errors, suspense: policy wrappers + sentinel boxes at the
rim (mechanism library, proven shape); K0 compares identities only and stays
monomorphic. A throwing or suspending evaluation stores a sentinel box as the
cached value — in K0 for canonical evaluations, in the memo plane for world
evaluations — so no throw can corrupt graph state (R2).

## 5. Receipts, worlds, and the fold (M1, M2)

### 5.1 The write path (REACT mode)

Every `atom.set/update/dispatch`:

```
token   = fork.currentBatchToken()        // integer; deferred bit inside
slot    = registry.intern(token)          // 5-bit slot; mints on first sight
seq     = ++globalSeq
tape[atom].append({op, slot, seq, retiredSeq: NONE})
writeClock[slot] = seq
if (!deferred(token)) {
  newest = replayNewest(atom)             // §5.3; usually O(1) incremental
  changedK0 = !equalsPolicy(atom, K0value(atom), newest)
  if (changedK0) K0.writeCanonical(atom, newest)   // kernel dirty marks fire
}
M3.walk(atom, token, changedK0?)          // §8: marks, buckets, setStates
```

Render-context writes throw (`fork.renderContext() !== undefined` at write
time → error; R8's render-world rule). Handlers during yields see
`renderContext() === undefined` and write legally (C7, I6/S7).

Equality never drops a receipt when the tape is non-empty (I7/S8/C8);
equality only gates *K0 application* and *urgent notification*, both of which
compare folded values, and the safe empty-history fast path: if the atom has
no receipts and no live batches exist, a value-equal urgent set is a no-op
(the dropped op would hold the lowest seq in every fold — I7's condition).

### 5.2 Visibility rule (the settled math, D3)

A receipt is visible to world `(mask, pin)` iff

```
(retiredSeq !== NONE && retiredSeq <= pin)  OR  (slot ∈ mask && seq <= pin)
```

This is clause-for-clause React's hook-queue lane filtering (mechanism
library, "visibility rule as math"). Every world answer in this design is
computed by this rule; no second definition exists.

### 5.3 Folding

`fold(atom, mask, pin)` = start from the base record; replay visible receipts
in seq order (updaters run against the accumulator; reducer actions run
through the reducer; sets replace). Never "apply this batch's ops to the
current K0 value" — replay-in-write-order over the pre-batch base is the only
React-parity fold (I2; the C3 walk in §14 shows the 4-not-3 arithmetic).
`replayNewest` (urgent apply) is `fold(atom, allLiveUrgentSlots, ∞)`; it
memoizes the last fold position per atom so consecutive urgent writes are
O(1) amortized.

### 5.4 Batch registry lifecycle (M2)

- **mint/intern**: first write naming a token allocates a slot (fails loudly
  past 31 — cannot happen under the fork's one-per-lane discipline, I10).
- **live**: writes bump `writeClock[slot]`; certificates/memos/thenables
  created for masks containing the slot increment `unswept[slot]`.
- **retire** (`fork.onRetire(token, committed)`): exactly once. Fold (§9),
  then sweep: walk `registryChain[slot]` (every memo/cert/thenable whose mask
  contains the slot — they were chained at creation), free them, decrement
  `unswept[slot]` to zero.
- **recycle**: slot returns to the free pool only at `unswept[slot] === 0`
  (I10). A recycled slot's `writeClock` resets; nothing keyed to the old
  tenancy survives (the sweep is the guarantee; a dev invariant sweep asserts
  the chain is empty at recycle).
- **async actions**: the token stays live across `await` (the fork parks it —
  §11); writes after resumption intern to the same slot; retirement fires
  after the action settles (C12).

Tape sweeping: a retired prefix of an atom's tape folds into the base record
only at episode boundaries (no open passes, no live batches) in v1. This is
deliberately coarse — pins and excluded-batch worlds (C2/C16) need retired
receipts with their `retiredSeq` until nobody can exclude them; episode-only
sweeping makes the retention rule trivial. Memory is gated (§12); O10-style
mid-episode coalescing is declared future work with its legality condition
(no open pass may distinguish the coalesced entries; same slot; adjacent in
seq among that atom's receipts).

## 6. Marks and the read path (M4, M5)

### 6.1 The read algorithm

Every tracked or untracked read in REACT mode:

```
if (markPlane[node] < eraFloor) return K0.readCanonical(node)   // fast path
w = currentWorld()      // §6.4: render context, effect context, or NEWEST
if (w === NEWEST) return K0.readCanonical(node)
m = memoLookup(node, w.mask)
if (m && L1valid(m, w))                    return m.value        // 3 loads
if (m && L2certValid(m.cert, w))           { restamp(m); return m.value }
return worldEvaluate(node, w)              // §7
```

- **L1**: `m.stamp >= writeClock[s]` for every `s ∈ w.mask`, and
  `m.stamp >= retirementClock`. (Retirements make previously-hidden receipts
  visible to *excluding* worlds, so any retirement conservatively unstamps
  all memos; masks containing the retired slot are swept outright at
  retirement, so survivors re-validate via L2 or re-evaluate.)
- **L2**: walk the certificate (§7.2). All entries hold → memo value is
  world-correct; refresh `m.stamp`.
- **Atoms** short-circuit: a marked atom's world value is `fold(atom, mask,
  pin)` with a per-(atom, mask) memo of the fold cursor; no certificate
  needed (an atom reads nothing).

### 6.2 Memo storage (M5)

Speculation plane: fixed-size Int32 records `{nodeId, mask, stampSeq,
valueRef, certRef, chainNext, registryNext}` bump-allocated; values and
thenable/sentinel boxes in a packed `unknown[]` column; per-node chain heads
in a side column (`memoHead[nodeId]`); per-slot registry chains for sweep.
Bulk reset at episode end (watermark + closure rebuild, the measured growth
pattern [GUIDE]). Masks actually rendered are few (a pass's mask, its
subsets under T7-style split commits), so chains are short; chain length is
a dev-mode gauge.

### 6.3 The mark invariant and the first-divergence induction (the core proof)

**Invariant MARK**: if `markPlane[n] < eraFloor` (mark clear), then for every
constructible world `w`, `value_w(n) = value_K0(n)`.

**Construction.** Worlds differ from K0 only through receipts that are (a)
live-deferred (in K0's terms: not applied), (b) applied-urgent-but-excluded
(C2-style below-canonical worlds), or (c) retired-after-pin (C7-style folds
during an open pass). Call these **divergence receipts**. Every divergence
receipt was appended by a write or fold that ran `M3.walk(atom, …)`, and the
walk stamps `markPlane[v] = ticket` for the written atom and every transitive
K0 subscriber `v` (§8). So: *every atom holding a divergence receipt, and
every node whose canonical dependency cone contains such an atom, is marked.*

Now the induction (I4, written out). Fix node `n`, world `w`. Consider
evaluating `n` in `w` and in K0, as pure functions of the atom values they
read (computed purity — R2 requires it; render-phase writes throw, R8).

- **Base case**: if no atom holds a divergence receipt for `w` (no live
  writes, nothing excluded, nothing folded past the pin), the two evaluations
  read identical values everywhere, so they return identical values and read
  identical sets. MARK holds vacuously (also: nothing is marked in a
  quiescent era — floor bumps at episode end).
- **Step**: order `w`'s divergence receipts by seq: `r_1 … r_m`. Suppose MARK
  held before `r_i` was appended; show it holds after. Appending `r_i` can
  change `value_w(n)` vs `value_K0(n)` only for nodes `n` whose `w`-evaluation
  reads `atom(r_i)`. Compare `n`'s `w`-evaluation with its canonical
  evaluation, read by read: both are the same pure function, so they coincide
  up to the first read that returns a different value — and that read is of
  an atom that already diverged, i.e. `atom(r_j)` for some `j ≤ i`. In the
  canonical evaluation, every read *up to that point* was identical, so the
  first-divergent atom **is read by the canonical evaluation too**: it is a
  canonical (transitive) dependency of `n`. The walk for `r_j` traversed the
  canonical cone of `atom(r_j)` — which contains `n` — and stamped
  `markPlane[n]`. Marks only clear at era-floor bumps (quiescence: no live
  batches, no open passes, i.e. no constructible diverging world), so `n` is
  still marked. Hence any `n` with a clear mark has *no* first divergence in
  any world: `value_w(n) = value_K0(n)`. ∎

Two subtleties the induction depends on, made structural:

- **Folds stamp marks too** (rule enforced at the single choke point
  `applyToK0`, §9): an open pass excludes receipts retired after its pin, so
  a fold creates type-(c) divergence; the fold-walk marks the cone, keeping
  MARK true for pinned passes. Without this, a canonical re-evaluation could
  change a node's dependency set after a live write was walked past the old
  edges, and a clear mark would lie. (Schedule that kills the lazy version:
  `c = y ? x : 0`, deferred k writes `x` while `c`'s edges are `{y}`; batch j
  writes `y=1` and retires; fold dirties and re-tracks `c` to `{y, x}`; a
  k-world read of `c` with a clear mark would serve K0's `0` instead of
  `x=5`. The fold-walk stamps `c`, closing it.)
- **Stale canonical edges are sufficient**: K0 edges reflect each node's
  *last canonical evaluation*, which is exactly the evaluation its canonical
  cached value came from; K0's own push-pull dirties through those edges on
  any canonical change, and re-tracks on re-evaluation. The induction only
  ever needs the cone *of the evaluation that produced the value being
  served*, which is what the edges are. Dependency sets that would change
  only after a canonical re-evaluation are covered because the re-evaluation
  can only be triggered by a canonical change, whose walk (write or fold)
  stamps marks along the old edges first, and new edges are walked by
  subsequent writes.

**Enumerable obligation** (the stance's burden): MARK has exactly three
maintenance sites — the write walk, the fold walk, the era-floor bump — all
inside two functions (`M3.walk`, `episodeReset`). The dev-mode invariant
sweep re-derives, after every walk in test builds, the set
`{n : some divergence receipt's atom ∈ flattenedCanonicalCone(n)}` by brute
force and asserts every member is marked (SP-B prices this validator; it is
dev-only).

### 6.4 `currentWorld()` — who is asking

- Inside a render callstack: `fork.renderContext()` returns `(root, mask,
  lineageId)`; the engine composes the pass world: `mask' = mask ∪
  locked[root]`, `pin` = the snapshot taken at `onPassStart` (stable across
  yields; a resumed pass reuses it). Per-callstack truth means yield-gap
  handlers get `undefined` here (I6).
- Inside a `useSignalEffect` flush for root r: `(locked[root] mask, pin =
  retirementClock snapshot)` — committed-only (C16).
- Otherwise (event handlers, timers, core `effect()`): **NEWEST** — K0
  directly. Core `effect()`'s documented contract (R13/C16 note): effects
  observe the canonical world (retired + applied urgent); deferred writes
  become visible at retirement. Walked in C16.

Reads never ask the fork anything on the fast path: the mark check comes
first, and `renderContext()` is only consulted for marked reads.

## 7. Certificates and buckets (M6, M7)

### 7.1 What a world evaluation records

`worldEvaluate(node, w)` runs the node's function with a world-scoped
tracking frame. Every read inside it lands in the frame's certificate:

- read of atom `a` (marked or not): **atom entry** `(a, tail_w(a))` where
  `tail_w(a)` = seq of the newest receipt visible to `w`, or **0** if none —
  including atoms with no tape at all. This is the S5 rule: the certificate
  covers the COMPLETE read set, with a sentinel for no-state-yet sources.
  (C1's `a` is recorded as `(a, 0)` — the entry that the legacy design
  missed and died on.)
- read of computed `d` with mark **clear**: served from K0 (fast); the frame
  records a **dep entry** `(d)`. Its meaning: "this memo is valid only while
  `d` is unmarked" — checked structurally, not by version (K0 stays closed;
  no kernel version counters).
- read of computed `d` with mark **set**: recurse `read(d)` in `w` (memo or
  evaluate); **flatten**: merge `d`'s certificate (atom entries and dep
  entries alike) into the parent frame (S5's flatten/merge rule). The memo
  for `d` keeps its own certificate; the parent's copy makes the parent
  independently checkable and independently reachable by buckets.

Watcher renders (components) run under the same frame; a watcher's
certificate additionally records the **direct read list** (the node ids the
component itself touched, in no particular order) — needed only for
commit-time K0 edge promotion (§9.3).

### 7.2 Validation (L2)

A certificate is valid for world `w` iff every atom entry satisfies
`tail_w(a) === recorded` and every dep entry `d` still has a clear mark.
Atom-entry checks are O(1) amortized (per-(atom, mask) fold cursors, §6.1);
dep-entry checks are one mark load. Any failure → re-evaluate (which produces
a fresh certificate). Over-invalidation is sound; under-invalidation is the
sin. Purity gives the converse: if every recorded read would return the same
value, re-running the function returns the same result *and the same read
set*, so an intact certificate proves the memo (this is why completeness —
S5 — is the whole game).

### 7.3 Buckets (the write-side index)

At memo publication, each certificate entry is chained into
`bucket[sourceId]` (open-addressed map → chain in the cert plane), tagged
with the memo's mask. Consumers:

- write to atom `a` in slot `k`: check `bucket[a]`; entries whose mask
  contains `k` (deferred write) or ALL entries (urgent write — urgent joins
  every world; excluded-urgent worlds like C2's are below-canonical and
  re-validate via tails anyway) → invalidate memo + notify its node's
  watchers (§8.3).
- walk visits computed `d` whose mark transitions clear→marked: drain
  `bucket[d]`'s dep entries — invalidate those memos + notify. After this
  instant no new dep entries on `d` can be created (readers now see `d`
  marked and take the overlay path, flattening instead), so dep entries never
  need re-draining — an enumerable one-shot obligation, asserted by the dev
  sweep ("no dep entry on a marked node").

Bucket entries die with their memo (sweep unlinks them; the chain nodes are
plane records freed with the slot's registry chain).

### 7.4 Evaluate-then-recheck (M7)

Between "evaluation read its sources" and "memo + certificate published in
buckets," a concurrent write could land (only via yield gaps or interleaved
events — evaluation itself is synchronous). Rule: after evaluating, before
publishing, re-run L2 on the just-built certificate; if it fails, re-evaluate
(bounded retry; a hostile schedule degenerates to always-fresh evaluation,
which is correct). Fresh nodes (`useComputed` mounted mid-transition, C9b)
are the ordinary case of this rule, not a special case: their first
evaluation runs with no marks/edges/memos existing, the certificate records
what it read (complete, tails-or-0), the recheck closes the race, and bucket
registration makes them reachable for every subsequent divergent write.

## 8. The write walk (M3) — marking, invalidation, delivery in one pass

`M3.walk(atom, token, k0Changed)` runs synchronously in the writer's stack:

1. **Root check**: `bucket[atom]` per §7.3 (this is where C1's second write
   finds `c` and `W` — no canonical edge needed).
2. **Traverse** K0 subscriber edges from `atom` (iterative, persistent
   scratch stack — same discipline as kernel walks, but overlay-owned):
   at each visited node `v`:
   - stamp `markPlane[v] = ticket` (idempotent); on clear→marked transition,
     drain `bucket[v]` dep entries (§7.3);
   - if `v` is a watcher: **deliver** (§8.3).
3. **No K0 dirtying** for deferred writes (canonical values didn't move);
   urgent writes already dirtied K0 via `writeCanonical` before the walk.

The walk repeats per write — marks never stop it (I5: once-per-staleness
dedup loses batch granularity; C4 dies there). Delivery dedup is the only
dedup, and it is per-(watcher, batch, pass):

### 8.3 Delivery

For watcher `W`, write in batch `k`:

- **Cutoff policy**: urgent writes deliver only if `k0Changed` (the folded
  canonical value moved — kernel-staleness + lazy pull is the cheap
  mitigation from the cost warnings; the render itself re-verifies).
  Deferred writes deliver **unconditionally** (no eager per-write world
  evaluation — the expensive shape [SYNTH §10.6]; the k-render reads through
  memos and React commits no DOM change if values are equal). Cost: possible
  spurious background re-renders; gated (§12), never torn.
- **Dedup**: bit `delivered[W][k]` set on delivery; cleared at every
  `onPassStart` whose mask contains `k` (so a mid-pass or post-pass-start
  write re-delivers and React reworks the pass with a fresh pin — C5's
  second write; React's interleaved-update handling is the native backstop).
  Bits are per-slot (32-bit word per watcher) and die with the slot.
- **Context**: `setState(W)` is called synchronously right here, in the
  writer's execution context, so React assigns the writer's lanes (D5). A
  transition write delivers inside the transition scope; an urgent write
  delivers at urgent priority. There is **no implicit grouping**: engine
  `batch()` defers only core-effect flushing, never watcher delivery, so C6's
  trap (implicit grouping losing per-write context) does not exist in this
  design — each write's delivery carries its own context by construction
  (construction: delivery happens inside the write call, which happens inside
  whatever React scope the user's code was in; there is no queue between).
- **Memo-invalidation notifications** (bucket hits) deliver to the memo
  node's watchers the same way, with one addition for the urgent-write case
  (C1-T5): besides the writer-context setState, the engine schedules a
  corrective `fork.runInBatch(k, () => setState(W))` for each live deferred
  `k` in the invalidated memo's mask — deterministic re-render of k's world
  even in the finished-but-uncommitted race window (belt: React's
  interleaved-update rework; suspenders: the lane-scoped corrective).

Fan-out cost: one walk per write over the canonical cone + one setState per
not-yet-delivered watcher. The walk is the same traversal K0's own effect
propagation would do; the delta is the mark store and bucket probe per node
(gated, §12).

## 9. Retirement (M9)

`fork.onRetire(token, committed)` — exactly once per token (fork invariant):

1. **Stamp** every receipt of the token's slot with `retiredSeq =
   ++globalSeq` (they become visible-as-retired to future pins; open passes
   with older pins still exclude them — §5.2's first clause).
2. **Fold**: for each written atom, `newK0 = fold(atom, retiredOnly ∪
   liveUrgent, ∞)` — full-order replay over the base (I2; NOT "apply this
   batch's ops to K0", which computes 3 where React commits 4 — C3). If the
   folded value differs from K0's, `applyToK0(atom, v)`: `K0.writeCanonical`
   + **fold-walk** (M3 with fold semantics: stamps marks — required by MARK,
   §6.3 — drains buckets, delivers with the reconcile check below). D2:
   `committed=false` folds identically — writes never depend on subscribers
   (C12/S4).
3. **Reconcile check**: fold-delivery to watcher `W` is suppressed iff `W`'s
   last committed render already observed these receipts: `lastMask[W] ∋
   slot ∧ lastPin[W] ≥ maxSeq(slot writes) ∧ epoch match`. That makes
   commit-time folding invisible to components the transition itself just
   rendered (no post-commit echo render), while watchers that never rendered
   k's world (e.g. subscribed to an atom k wrote but React skipped their
   subtree — impossible for correct walks, but also portal/other-root
   watchers, C11) get their urgent correction.
4. **Promotion** (watcher edges): for each watcher in the slot's registry
   whose latest render committed with this batch (its layout effect recorded
   `lastMask ∋ slot`), re-track its K0 edges to its certificate's direct
   read list (§7.1). This is what keeps K0's watcher edges equal to "the
   read set of the render the committed DOM shows" — the invariant urgent
   walks rely on. Computed K0 edges never promote (K0 re-tracks them itself
   on its next canonical evaluation; until then MARK covers the gap — §6.3).
5. **Sweep** the slot's registry chain: memos, certificates, bucket links,
   thenable cache entries whose mask contains the slot (T6 hygiene: nothing
   keyed to a slot tenancy survives it); `unswept[slot] → 0`; recycle.
6. **Per-root lock-in** happened earlier at each `onRootCommit(root,
   tokens)`: `locked[root] |= slotBit` (C11). At full retirement the bit
   leaves every `locked` mask (retired receipts are visible to everyone via
   clause 1).
7. **Episode check**: no live slots, no open passes → `episodeReset()`:
   sweep retired tape prefixes into base records, reset planes to
   watermarks, bump `worldEpoch`, bump `eraFloor`, reset `globalSeq` and
   clocks. Every consumer that retains sequence numbers across episodes
   (watcher `lastPin`, fold cursors) stores `worldEpoch` beside them and
   treats a mismatch as "stale, re-derive" (I8; C13 walks the collision).

## 10. React binding (`cosignal/react`)

### 10.1 Hooks (R4)

- `useSignal(sig)` / `useAtom(atom)` / `useReducerAtom(ra)`: subscribe the
  fiber's watcher record to the signals read during render (tracking frame
  around the component render, installed by the fork's pass hooks — no
  provider needed; the bridge is module-level and provider-free, R4's
  preference).
- `useComputed(fn, deps, opts?)`: a fiber-owned computed node; recreated
  (new node id) when `deps` change; reads auto-tracked; evaluated through
  the normal read path (so world routing is free — C9b via M7).
- `useSignalEffect(fn, deps?)`: committed-only effect; flushes with the
  root's committed world (§6.4, C16).
- `useSignalTransition/startSignalTransition` (R5): sugar over React's
  `startTransition` — no separate machinery; writes inside inherit the
  transition token via `currentBatchToken()`.

### 10.2 Watchers

A watcher is a K0 subscriber node (so walks reach it) + overlay record:
`{fiberRef, lastMask, lastPin, epoch, deliveredBits, latestCert}`. Renders:

- **Canonical-world render** (mask ∪ locked = committed view): re-track K0
  edges to this render's direct reads (normal kernel re-track).
- **World render** (any live deferred slot in the mask): K0 edges are left
  untouched (they must keep describing the committed DOM — the §9.4
  invariant; the killing schedule otherwise: branching component W reads
  {flag,a} in k-world, K0 edges re-tracked to {flag,a}, urgent write to
  dropped dep b misses W → torn urgent frame). The render's reads live in
  the watcher's certificate instead, registered in buckets — that is how
  k-writes keep reaching it (C1). Exception: a watcher's **first** render
  ever tracks K0 edges (there is no committed DOM to describe yet; C9a).
- StrictMode replays (C14): world evaluation and memo publication are
  idempotent (purity → value-identical memo; cert registration replaces the
  same (node, mask) entry); K0 mutations during render are only lazy
  canonical pulls, which are alien-signals' normal idempotent semantics;
  render-phase writes throw (§5.1); double-mounted subscriptions net out via
  the microtask-debounced observed-lifecycle (R1's flap-proofing).

### 10.4 Post-subscribe fixup (M8, C10)

Subscription becomes writable state only at commit; a k-write can land in
the render→subscribe gap. The watcher's layout effect re-runs L2 on
`latestCert` against the current tape; on failure it issues a corrective
`setState` inside `fork.runInBatch(k)` — the correction joins k's own lanes
and rides k's single commit (C10's "one commit" requirement; a fresh
`startTransition` would mint a new token and commit separately — not
equivalent). If `runInBatch` refuses (token retired in the race window), the
fallback is the urgent pre-paint correction (we are already in the layout
phase — before paint by construction).

### 10.6 Multiple roots (M10) — declared scope: FULL spanning support

`locked[root]` (mask + epoch) is the entire mechanism; everything else is
the ordinary world machinery. Root A commits spanning batch k → `locked[A] ∋
k` → every subsequent pass and effect flush on A composes k into its world
(§6.4) even though k is still live for B; A never contradicts its own DOM,
A's passive effects observe k's values (C11's hard sub-case) — all through
memos/certs that already exist. B excludes k until its own commit. K0 stays
global and below both (it never contains unretired deferred writes, so no
root's committed view is contradicted by it). Retirement is once, after the
last root (fork counts roots with k-work). Walked in C14 table §14.

### 10.7 Suspense (M11, C15, R6)

`ctx.use(thenable)` inside a world evaluation consults the per-world
positional thenable cache: key `(nodeId, canonicalMask, position)`, where
`canonicalMask` is the pass's mask ∪ locked (the world identity — NOT
passSerial, which re-fetches forever, and NOT the raw token, which is not
enough under multi-batch passes; O8 answered). Lifetime: until any slot in
the mask retires (swept via registry chains) — stable across pass restarts
and StrictMode replays by construction (same mask → same records). A pending
thenable stores a suspension sentinel box as the memo value; the watcher
render throws it to React's `use` protocol. Canonical evaluations never see
it (they read the committed thenable cache). At retirement, settled entries
for masks now fully retired **promote** into the node's committed positional
cache, so the post-commit canonical re-evaluation reuses the settled
thenable instead of re-fetching or re-suspending.

### 10.8 Loop rejection (R7), writes-in-computeds (R8)

React-coupled storms hit React's own update-depth limits (setState delivery
is native, D5 — inherited for free). Signal-only cycles: K0's evaluation
recursion guard (alien semantics) throws on self-referential pulls; world
evaluations run the same guard in their frame. Writes inside computeds:
tolerated when acyclic in core mode per R8 with `configure(...)`; any write
under a render callstack throws (§5.1).

## 11. fork-protocol (the seam — versioned document, 8 touch-points)

Protocol version: `__COSIGNAL_FORK_PROTOCOL__ = 1`. Bindings feature-detect
and throw on stock React (no silent degradation). Integers and documented
callbacks only; no Fiber, no lane bitmask, no update-queue internals cross
the boundary (charter hard rules).

### 11.1 Facts and surfaces

| # | surface | direction | fact it exposes | edge-triggered from | consumed by |
|---|---------|-----------|-----------------|---------------------|-------------|
| 1 | `currentBatchToken(): int` | query | the batch of a write happening NOW: `(serial<<1)|deferredBit`, minted lazily, never reused live | React's own update-lane assignment path (where `requestUpdateLane` already runs) | M1 write path, M2 intern |
| 2 | `onPassStart(root, mask, lineageId, tokens[])` | callback | a render pass begins; which batches it includes | where React resets the WIP stack for a root | pin snapshot; dedup-bit clear (§8.3); world composition |
| 3 | `onPassEnd(root, outcome)` | callback | pass completed / discarded / restarted | work-loop exit sites | pin release; dev sweeps |
| 4 | `renderContext(): {root, mask, lineageId} \| undefined` | query | per-CALLSTACK "is this stack inside a render pass" — true across the pass, false in yield gaps (I6) | React's existing workInProgress/executionContext bookkeeping, which the work loop already sets and clears synchronously around units of work | read routing (§6.4); write-throw (§5.1); C7 |
| 5 | `onRetire(token, committed)` | callback | batch leaves React's books, exactly once; async actions park the token until the action settles (C12) | root commit / lane-entanglement cleanup — the places React already retires lanes | M9 fold+sweep |
| 6 | `onRootCommit(root, tokens[])` | callback | per-root commit lock-in for spanning batches | commitRoot, where React already knows the finished lanes | M10 `locked[root]` (C11, C16) |
| 7 | `runInBatch(token, fn): boolean` | control | run `fn` so its `setState`s join the token's existing lanes; `false` if retired | React's own transition/lane-scoped execution machinery (the same context swap `startTransition` does, parameterized by token) | M8 (C10), §8.3 corrective (C1-T5) |
| 8 | `onDomMutationWindow(root, phase)` | callback | mutation window brackets (kept nicety per charter) | commit mutation phase | tracing (R11), devtools |

Notes: lineage ids (fact for C15) ride surfaces 2/4 — minted at the first
pass for a given batch-set on a root, stable across that set's restarts,
retired with the set; the library keys nothing on `passSerial`. Async-action
parking is not a ninth surface: it is the *absence* of `onRetire` while the
action is pending (fork's existing async-transition tracking).

### 11.2 Fork-side invariants (each documented at its hook site, each tested)

1. Tokens are unique while live; ≤31 live (one per lane); the deferred bit
   never changes after mint (I10).
2. `onRetire` fires exactly once per token, after every root's commit or
   close, after async actions settle; `committed` reflects whether any React
   work committed it.
3. `renderContext()` is truthy iff the current synchronous callstack is
   inside pass work — never during yields, timers, or event handlers that
   interrupt a paused pass (I6/S7). It is implemented by reading state React
   already maintains synchronously around the work loop, not by wall-clock
   pass scoping.
4. `onPassStart` fires before any component of the pass renders, with the
   final include-set (mask) for that attempt; a restart is a new
   `onPassStart` with the same lineageId.
5. `runInBatch(t, fn)`'s updates entangle with `t`'s lanes such that they
   commit in the same commit as `t`'s remaining work (or it returns false).
6. Every surface is inert-when-unused: one null-check per site with no
   listener registered (charter goal 2).

### 11.3 Rebase drill ("React changed X — what moves?")

- *React renames/renumbers lanes*: nothing — tokens are minted integers;
  the fork's token↔lane table is fork-internal.
- *React moves commit phases / splits commitRoot*: surfaces 5/6/8 re-anchor
  to the moved sites; the library sees identical callbacks. Nothing moves.
- *React changes update-queue internals (hook queue layout, rebase code)*:
  nothing — the library never touches update queues; parity is behavioral
  (D3 math), verified by the differential suite, not shared code.
- *React changes the work loop (new yield strategy, prerendering,
  useDeferredValue internals)*: surface 4's implementation re-anchors to
  whatever the loop's synchronous bookkeeping becomes; its *contract*
  (per-callstack truth) is the invariant the fork test suite pins.
- The signals library imports only `fork-protocol.md` types. The answer to
  the drill is: **nothing in the library changes; the fork re-implements the
  same eight facts.**

### 11.4 The fork's own test list (reconciler-level, runs on every rebase)

1. Token mint/uniqueness/deferred-bit under: discrete event, default-lane
   timer, transition, nested transition, async action across `await`.
2. ≤31 live tokens enforced; slot-pressure test (31 parked async actions +
   new transition).
3. `renderContext()` truth table: inside sync render; inside concurrent
   render before/after yield; in a click handler during a yield gap (C7);
   in a passive effect; in a layout effect; inside `flushSync` nested in an
   event.
4. `onPassStart/End` pairing across: completion, discard, restart,
   Suspense retry, StrictMode double render (same lineageId on replay).
5. `onRetire` exactly-once: commit; abandoned transition (no React work —
   committed=false); async action settling late; interleaved urgent commit.
6. `onRootCommit` per-root lock-in for a two-root spanning transition
   (C11's schedule at reconciler level).
7. `runInBatch` joins lanes → single commit (assert one commit containing
   both updates); returns false after retire.
8. `flushSync` excluding a pending default batch fires no spurious
   retire/commit facts (C2's fork-side half).
9. Inert-when-unused: all surfaces null-listener → zero behavior delta on
   React's own test subset (fork carries a React-tests smoke lane).

## 12. Performance: costs against the gates

Gate classes from requirements P1–P4; donor numbers cited from
research-facts.md; UNMEASURED items are spikes, not claims.

| # | path | cost model | gate | status |
|---|------|-----------|------|--------|
| G1 | DIRECT mode, tier-0 | K0 unchanged: deep 0.90×, broad 0.84–0.88×, diamond 0.89×, reads 0.74–0.87×, create 0.96× vs alien-signals [ARENA] | P2: ≤1.0× every shape | measured (donor) |
| G2 | REACT quiet reads | +1 side-plane load + compare per read (§6.1 line 1) | P3: ≤2% tier-0 | **SP-A spike** (predicted <2%: one cold-column load; the 1.8× interleaving hazard was hot traversal fields [RESEARCH], not one probe) |
| G3 | REACT logged write (quiet) | receipt append + clock bump + walk (≈ kernel's own propagate + 1 store + 1 probe per node) | ≤2× DIRECT write [SYNTH G-6] | gate + CI bench |
| G4 | deferred write, active transition | walk O(cone) + bucket hits O(true affected) + setState per undelivered watcher | fan-out shape suite ≤1.5× the equivalent urgent storm [G-7 class] | gate + CI bench |
| G5 | marked read, memo hit | L1: ≤ popcount(mask)+1 loads; typical 3 | ≥10× cheaper than re-evaluation on G-8 held-open-transition shape | gate (O9 answer: memo+clocks, certs only on clock miss) |
| G6 | marked read, L2 | O(|cert|) fold-cursor compares, no user code | ≤0.25× of re-evaluation on kairo shapes | **SP-B spike** (with SP-C: cert size distribution on kairo-scale transitions) |
| G7 | world evaluation | kernel-eval cost + O(reads) cert append + O(entries) bucket links | ≤1.6× canonical eval of same node | gate |
| G8 | retirement | O(slot receipts) fold + O(slot registry) sweep, amortized over the batch | ≤ commit's own O(fibers) work; bench vs react-concurrent-store harness | gate |
| G9 | memory | receipts+memos+certs in planes; heapUsed + plane bytes reported side by side (P4); zero steady-state allocation on re-render traffic (planes are bump/reset, watcher records pooled) | P4 | design property + CI leak test |
| G10 | 10k-subscription mount | watcher = K0 node + pooled record; setState delivery native | P1: ≤15% vs useState | bench (donor kernel creation 0.96× gives headroom) |

Kairo-scale GC-inclusive honest ceiling stays ≤1.4× (donor reality [ARENA]);
nothing in the overlay touches those paths in DIRECT mode. Host-callback
indirection tax (O2/SP1): **not applicable** — this design uses no host
protocol; K0 keeps values in its packed column and calls no callbacks per
recompute.

Spike proposals (pre-registered, decision rules stated):
- **SP-A** mark-probe read tax: add the §6.1 line-1 branch to the donor
  kernel read wrappers; tier-0. >2% → fallback: fold the mark into a spare
  bit of K0's existing flags word via one kernel-approved accessor (a seam
  widening to be re-judged; kernel stays closed otherwise).
- **SP-B** dev-validator cost (the §6.3 brute-force MARK sweep): forked-mode
  dev builds; >10% dev overhead → sampling sweep (every Nth walk).
- **SP-C** certificate size/maintenance on kairo-scale transition write
  storms; blow G6/G7 → **coarse-mode fallback** (designed, not vapor): a
  node whose cert exceeds `CERT_MAX` entries publishes a memo with
  `certRef = COARSE`; L2 always fails (memo lives on L1 clocks only) and the
  node registers in a per-slot coarse chain notified on every slot write —
  sound (strict over-invalidation/over-notification), bounded, and only for
  whale nodes.

## 13. Answers to OPEN questions this stance touches

- **O1**: this design is the "compensated single kernel" point, upgraded:
  the compensation stack (certs + buckets + walk + recheck) is indexed
  (buckets make write-time work O(true affected), not O(registry)), and its
  completeness obligations are the two enumerable invariants MARK (§6.3)
  and CERT-COMPLETE (§7.1), each with a dev sweep.
- **O5**: per-callstack query (`renderContext()`, surface 4) chosen over
  listener-maintained state: reads consult it only when marked; writers
  consult it once per write; listeners (2/3) exist only for pin lifecycle.
- **O6**: per-write synchronous delivery with per-(watcher, batch, pass)
  dedup (I5-compliant); no grouped drain exists; `runInBatch` used only for
  corrective scheduling (C10, C1-T5), not for delivery.
- **O7**: `locked[root]` mask table (M10), consumed by world composition
  (§6.4) and effect flush (C16); one array indexed by root id.
- **O8**: thenable key = `(node, mask ∪ locked, position)`, lifetime = until
  any included slot retires, with commit-time promotion (§10.7).
- **O9**: held-open hot reads are served by memos validated by per-slot
  write clocks (L1) — the I-grade mechanism — with certificates only as the
  L2 backstop on clock movement; per-read certificate checks never run on
  the hot path.
- **O10**: no coalescing in v1; legality condition documented (§5.4).
- O2/O3/O4 are other stances' axes: O2 moot here (no host protocol); O3 has
  an analogue in SP-B (validator pricing); O4 not taken.

## 14. Case walks (acceptance battery)

Notation in tables: `M#` = mechanism inventory numbers (§2); `mk(n)` = mark
stamped on n; `cert{...}` = certificate entries; `⟨W,k⟩` = delivered bit;
`tape(a)` shows receipts as `op@seq/slot`. Worlds written `(mask,pin)`.

### C1 — world-divergent dependency (family of 7)

`flag=false,a=0,b=0; c=flag?a:b; W⊂c; canonical deps of c={flag,b}`.

**T1 (main)**: k: `flag=true` → k-read of c → k: `a=1`.

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | write flag=true in k | M1: tape(flag)=[true@1/k]; deferred → K0 untouched (K0 flag=false); M2: writeClock[k]=1 |
| 2 | M3 walk from flag | bucket[flag] empty; traverse K0 edges flag→c→W: mk(flag),mk(c); W watcher → deliver setState(W) in k's context (transition lane); ⟨W,k⟩ set |
| 3 | k-pass starts | fork onPassStart(root,{k},L1); pin=1; dedup bits for k cleared |
| 4 | k-render of W reads c | mark set → world read ({k},1): no memo → worldEvaluate(c): read flag → marked atom → fold=true (seq1≤pin, k∈mask); read a → **unmarked** → K0 serve 0, cert atom entry (a,0) per §7.1 S5-rule; result c=0; M7 recheck cert ok; memo[(c,{k})]=0, cert{(flag,1),(a,0)} → buckets[flag],[a]; W cert flattens same entries; publish |
| 5 | write a=1 in k | M1: tape(a)=[1@2/k]; deferred, K0 a stays 0; writeClock[k]=2 |
| 6 | M3 walk from a | **bucket[a] hit** (no canonical edge needed): c's memo mask {k}∋k → invalidate memo[(c,{k})]; W's cert hit → deliver setState(W) in k context; ⟨W,k⟩ was cleared at pass start → delivers; if pass mid-flight, React reworks k with fresh pin; K0 subscribers of a: none — walk ends |
| 7 | k re-render reads c | world ({k},2): memo gone → re-evaluate: flag→true, a→marked→fold=1 → c=1; memo/cert republished cert{(flag,1),(a,2)} |
| 8 | committed read of c anytime | mk(c) set → but currentWorld()=NEWEST outside render → K0 read: flag=false → b=0 → c=0 ✓ |
| 9 | k retires | M9: fold flag,a into K0 (replay); fold-walk marks+reconcile: W lastMask∋k, lastPin≥2 → suppressed; sweep memos/certs/buckets of slot k |

outcome: k-world c becomes 1 (step 6 kills the stale 0-memo; step 7 reads 1);
W re-rendered in k's lane before commit (step 6 delivery is in the writer's
transition context, pre-commit); committed world still 0 via b (step 8).
Matches Required.
residual risk: bucket registration order vs concurrent write (closed by M7
recheck); pinned by conformance test `c1-t1` + dev CERT-COMPLETE sweep.

**T2 (write committed-only dep b in k, flag=true in k-world)**:

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | write b=9 in k | tape(b)=[9@3/k]; K0 untouched |
| 2 | M3 walk from b | mk(b); K0 edge b→c exists (canonical dep) → mk(c) (already); bucket[b]: c's cert has **no b entry** (k-eval read flag,a) → no memo invalidation; watcher W reached via cone → deliver ⟨W,k⟩ (unconditional deferred delivery, §8.3) |
| 3 | k re-render reads c | memo[(c,{k})] L1: writeClock[k]=3 > stamp 2 → L2: cert (flag,1) ok, (a,2) ok → **valid**, restamp; c=1 unchanged; W renders same output; React commits no DOM change |

outcome: no k-world value change (memo survives via L2 — exact, not lucky);
over-notification only (allowed: "over-invalidation ok, wrong value not").
residual risk: L2 tail computation must use k-visible tail for b if it HAD
been in the cert; fold-cursor test `c1-t2`.

**T3 (flag flips back in k: flag=false@4/k)**: walk from flag → bucket[flag]
hits c's cert (flag,1): tail_k(flag) now 4 ≠ 1 → invalidate + deliver;
re-eval: flag→fold(true@1,false@4)=false → read b → unmarked… b unmarked in
the T3-standalone schedule → K0 serve 0, cert{(flag,4),(b,0)}; c_k=0 =
canonical ✓ (equal values are fine; worlds agree). outcome: correct value,
notification delivered, memo replaced. residual: none beyond T1's.

**T4 (urgent write b=9)**: M1 logs [9@5/U]; urgent → replayNewest(b)=9 →
K0.writeCanonical(b,9) (kernel dirties c natively); M3 walk: mk(b),mk(c);
k0Changed → deliver setState(W) in **urgent** context; bucket[b]: no k-cert
mentions b → k-memo untouched (k-world c still 1 ✓). Urgent render of W:
world = ({U}∪locked, pin) → c marked → memo[(c,{U…})] absent → evaluate:
flag → fold excludes k (k∉mask, unretired) → false; b → fold: U visible → 9
→ c=9 ✓ committed-view render correct; k-world unchanged. outcome matches
(committed changes, k-world doesn't). residual: mask composition must
exclude k; pinned by `c1-t4` + C2 machinery tests.

**T5 (urgent write a=7)**: logs [7@6/U]; replayNewest(a): base 0, k's set-1
skipped (deferred), U's 7 → K0 a=7; walk from a: K0 subs none; bucket[a]:
c's k-cert (a,2): urgent write → check ALL entries: tail_k(a) = fold over
{k,U…}: receipts 1@2/k, 7@6/U → newest visible seq = 6 ≠ 2 → invalidate
memo + deliver setState(W) urgent context **and** corrective
runInBatch(k, setState(W)) (§8.3 — deterministic even if k's pass had
finished-but-not-committed). k re-render: fold a in ({k},pin≥6): replay 1@2
then 7@6 → 7 → c_k=7 ✓ (pending worlds include applied urgent state).
outcome matches. residual risk: the finished-work race is the sharp edge;
pinned by fork test 7 + harness scenario `t5-interleave`.

**T6 (slot/world-id reuse after k retires)**: retire k → M9 step 5 sweeps
`registryChain[k]`: memo[(c,{k})], certs, bucket links, thenables die;
`unswept[k]=0` → slot recycles; new batch k' interns to the same slot bits.
No surviving structure mentions the slot (the sweep IS the proof; dev sweep
asserts empty chain at recycle). Fold cursors/lastPin retained across
*episodes* carry worldEpoch (I8). outcome: no stale validation possible —
every slot-keyed record is enumerable via the registry chain and swept.
residual: chain completeness; pinned by invariant sweep + `c13` wrap tests.

**T7 (two live batches; joint render; one suspends, one commits alone)**:
k1,k2 live; joint pass mask {k1,k2} → memos keyed ({k1,k2}); c suspends on
k2's data → thenable cache (c,{k1,k2},0), suspension sentinel memo. k1
commits alone: its solo pass used mask {k1} → distinct memos (no
contamination by construction: world key = mask). k1 retires → sweep of
slot k1 kills ALL masks containing k1 including {k1,k2} memos/thenables.
k2 continues: pass mask {k2}, pin > retire(k1) → k1's receipts visible via
retired-clause → k2's world correctly includes committed k1; fresh memos;
fresh thenable (c,{k2}∪locked,0) — the promoted committed cache (§10.7)
already holds k2-independent settled thenables, so only genuinely
k2-dependent fetches re-run. outcome: per-mask views stay self-consistent
through the split. residual risk: thenable identity across the k1
retirement boundary for k2's retry — pinned by react-concurrent-store
scenario battery + `c15-split` test.

### C2 — flushSync excludes a pending default batch

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | event: a.set(1) → default batch D | M1: tape(a)=[1@1/D] (**always-log**, I1 — D is urgent-classified); replayNewest → K0 a=1; kernel dirties c |
| 2 | M3 walk from a | mk(a), mk(c); deliver W_a, W_c in D's (default) context → React schedules default-lane renders |
| 3 | flushSync(setState) | fork mints Sync batch S; sync pass: onPassStart(root, {S}, …), pin=1; world mask = {S}∪locked (D ∉ mask, D uncommitted → D ∉ locked) |
| 4 | sync render reads a | mk(a) set → world read: fold(a, {S}+retired, pin): D's receipt fails both visibility clauses (unretired, D∉mask) → base 0 → **a=0** ✓ |
| 5 | sync render reads c | mk(c) set → worldEvaluate(c in ({S},1)): reads a → 0 → **c=10** ✓; memo[(c,{S})] cert{(a,0…tail_w(a)=0)} |
| 6 | later: D renders/commits | default pass mask {D}: a=1, c=11; commit → locked ∋ D; retire D → fold (K0 already 1), sweep |

outcome: flushSync frame shows a=0 AND c=10 — no torn frame. The two traps
are dead by construction: (a) the receipt exists because logging is
unconditional in REACT mode (I1/D1 — no "is anything concurrent live?"
predicate); (b) c cannot be served from the canonical cache because step 2's
walk marked the downstream cone *at write time*, before any excluding render
could exist.
residual risk: mark stamping must precede any possible same-event sync
render — it does (walk is synchronous inside `set`); pinned by `c2` test +
fork test 8.

### C3 — rebase parity

`a=1`; T: `update(x=>x+1)`; U: `update(x=>x*2)`; then commits U, T.

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | T: +1 | tape(a)=[+1@1/T]; deferred; K0 a=1 |
| 2 | U: ×2 | tape=[+1@1/T, ×2@2/U]; replayNewest = fold(base 1, skip T, ×2) = **2** → K0 a=2; walk delivers urgent |
| 3 | urgent render (excludes T) | world ({U}∪locked, 2): a marked → fold: base1, ×2@2 → **2** ✓ |
| 4 | U commits, retires | receipts of U stamped retiredSeq=3; fold(a, retired∪liveUrgent) = base1 → skip T (live-deferred) → ×2 → 2 = K0 → no K0 change; no spurious delivery |
| 5 | T renders | world ({T},pin≥3): fold: **+1@1 (T∈mask) → 2; ×2@2retired≤pin → 4** — replay in write order over pre-batch base (I2) → shows **4** ✓ |
| 6 | T commits, retires | fold(a, retired) = 1+1=2, ×2 → **4** → K0 a=4 ✓ committed 4 |

Plain-set variant: [+1@1/T, set5@2/U]: urgent world = base1→skip→5 ✓; final
fold = (1+1)=2 → set5 → **5** (not 6) ✓.
outcome: 2, no-op, 4, 4 — exactly React's queue arithmetic; the
apply-and-discard bug (fold T's +1 over K0's 2 → 3) is impossible because
folds NEVER start from current K0 (§5.3, §9.2 — single fold implementation).
residual risk: incremental `replayNewest` cursor must reset when older
receipts change visibility (retirements) — cursor keyed to
(retirementClock, epoch); pinned by `useReducer` side-by-side differential
(process apparatus).

### C4 — two-batch write into an already-stale region

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | T1 writes a | receipt@1/T1; walk: mk cone; deliver ⟨W,T1⟩ setState in T1 context |
| 2 | T2 writes a (before any render) | receipt@2/T2; **walk runs again** — marks are idempotent but the walk never stops at marks (M3, I5); delivery dedup is per-(watcher, batch): ⟨W,T2⟩ unset → deliver setState(W) in **T2's context** |
| 3 | React | W scheduled in both T1's and T2's lanes; T2's render includes W ✓ |

outcome: matches Required — per-write walk + per-(watcher,batch) bits are
exactly the "per-write walk" arm of I5; there is no ARMED-style once-per-
staleness state anywhere in the design (grep-able: the only dedup state is
`deliveredBits`, keyed by slot, cleared per pass-start).
residual risk: bit clearing at pass start (else a T1-pass could eat a
subsequent T1 write); pinned by `c4` + `c5` tests.

### C5 — cutoff-suppressed first write, effective second write (same batch)

`c = a*0 + b`; k writes a=1 then b=7.

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | k: a=1 | receipt@1/k; walk: mk(a),mk(c); deferred delivery is **unconditional** (§8.3 — this design does not evaluate worlds on the write path): ⟨W,k⟩ delivered |
| 2 | k renders | c k-eval: a→1, ×0, b→unmarked K0 0 → c=0 (= canonical); memo[(c,{k})]=0 cert{(a,1),(b,0)}; W re-renders equal output — spurious but sound; **⟨W,k⟩ cleared at this pass's start** |
| 3 | k: b=7 | receipt@2/k; walk from b: bucket[b] hit — cert has (b,0), tail_k(b)=2≠0 → invalidate memo + deliver ⟨W,k⟩ (bit was cleared in step 2) → setState in k's lane ✓ |
| 4 | k re-renders | c k-eval: 1*0+7 = **7**; W shows 7 pre-commit |

outcome: second write reaches the watcher in k's lane; the stale 0 memo
cannot be served (bucket[b] kill in step 3 — cache-validity is
certificate-based, not staleness-mark-based). The case's "first broadcast
suppressed" premise is a with-cutoff design's schedule; this design
over-delivers instead, which strictly contains the required behavior (the
trap — suppression state eating the second notification — has no
representation here).
residual risk: if the k-pass had NOT yet started at step 3, ⟨W,k⟩ is still
set from step 1 and delivery is skipped — sound because the not-yet-started
k render will pin ≥2 and read 7; pinned by `c5-prepass` variant test.

### C6 — lane attribution under grouped notification

Resolution: **Handle it** (no forbidding). Mechanism: per-write synchronous
delivery (M3 runs inside `set`); engine `batch()` groups only core-effect
flushing, never watcher delivery; no implicit grouping exists anywhere
(§8.3 construction).

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | `batch(` opens | core-effect flush deferred; nothing else changes |
| 2 | `a.set(1)` | token=D (event default); receipt; K0 apply; walk delivers a's cone setStates **now**, in the event's urgent/default context |
| 3 | `startTransition(() => b.set(2))` | inside the scope, currentBatchToken()=T; receipt@/T; walk delivers b's cone setStates **inside the transition scope** → React assigns transition lanes; one T commit will carry them |
| 4 | `)` batch closes | core effects flush once (newest world) — React scheduling already happened per-write |

outcome: `b`'s cone re-renders in T's lanes and commits with T; `a`'s cone
gets urgent scheduling — each write's batch context preserved because
delivery *is* the write (nothing is queued across the scope boundary).
Legal compositions all inherit this: `startTransition(()=>batch(...))`,
unbatched writes in transitions, `startSignalTransition` (sugar).
residual risk: core-effect deferral must not delay setStates (they are not
core effects); pinned by `c6` test asserting commit counts and lanes via
fork test hooks.

### C7 — writes and reads during a yielded render pass

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | T-pass renders, yields | onPassStart(root,{T},L,pin=P); React yields — workInProgress bookkeeping cleared on stack exit → renderContext() now undefined (surface 4 invariant 3) |
| 2 | click handler reads a.state | mark check; if marked → currentWorld(): renderContext()=**undefined** → NEWEST → K0 (retired+applied urgent) ✓ newest world, not the pass's pin |
| 3 | handler writes a.set(x) | renderContext() undefined → write legal (no render-write throw); token = click's urgent batch U; receipt@q/U; K0 apply; walk delivers urgent; mk cone |
| 4 | T-pass resumes | renderContext() truthy again; its reads: world ({T}∪locked, **P**) — U's receipt has seq q > P and U∉mask → invisible (§5.2) → pinned world intact; marked nodes route to overlay (K0 moved, but MARK routes every U-touched node away from K0 serve — §6.3 type-(b/c) coverage); unmarked nodes: K0 = pin value (no live write below them, incl. U's — they'd be marked) |

outcome: handler reads newest, write classified under the click's batch and
logged, resumed pass still observes its pinned world. Matches Required; S7's
wall-clock scoping bug is structurally absent (per-callstack query).
residual risk: fork invariant 3 is the load-bearing fact; pinned by fork
test 3 (yield-gap truth table) + `c7` integration test.

### C8 — equality drops must not lose receipts

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | T: a.set(1) | tape(a)=[1@1/T]; K0 a=0 |
| 2 | U: a.set(1) (equal to newest) | tape **non-empty** → I7: receipt appended [1@2/U] unconditionally (write-time equality only gates the empty-history fast path); replayNewest = fold(base0, skip T, 1@2/U) = 1 ≠ K0's 0 → K0 a=1, walk delivers urgent (k0Changed true — note: equality against the *urgent-world fold*, not against "newest incl. T") |
| 3 | U's render (excludes T) | fold(a,{U}∪locked,2): base0 → 1@2 → **1** ✓ |
| 4 | (if T later truncated — N/A) | no truncation surface exists (C17); if T is abandoned, D2 folds it anyway; committed value after both retire = fold(0, 1@1, 1@2) = 1 ✓ |

Two overlapping transitions writing the same value: [1@1/T1, 1@2/T2], K0
stays 0; each walk delivers in its own lane; T1-world=1, T2-world=1,
committed after folds = 1. Each render shows 1 in its own lane ✓.
outcome: matches; the proof of the rule-of-thumb is I7's condition restated:
with any history, the worlds' accumulators differ (here U-world ≠ newest
incl-T world), so equality decisions move to fold/notify time — implemented
as: the ONLY write-time drop requires `tape empty ∧ no live batches`.
residual risk: the empty-history fast path predicate; pinned by `c8` +
property test (random schedules, oracle comparison).

### C9 — mount mid-transition (existing and fresh nodes)

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | k writes atoms | receipts; walk marks cones; deliveries in k |
| 2 | component M mounts during k's pass | renderContext() = (root,{k},L); world ({k}∪locked, pin) |
| 3a | M reads existing computed c over k-touched atoms | c marked (step 1 walk) → overlay: memo hit or worldEvaluate → k-world value on **first render** ✓ no canonical leak (mark routes away from K0), no double render (the read is world-correct immediately) |
| 3b | M's `useComputed` creates fresh node f, reads same atoms | f has no marks/edges/memos; read path: `markPlane[f]` is clear! — **fresh-node rule**: nodes with no canonical evaluation yet skip the mark gate and take the world path directly (a node with no K0 cache cannot be K0-served anyway); worldEvaluate(f): reads atoms — marked ones fold in k-world ✓; cert records COMPLETE read set (marked and unmarked alike, tails-or-0); M7 recheck; memo+buckets published; f's watcher cert flattens f's entries |
| 4 | M's commit | first-render rule (§10.2): K0 edges tracked from this render (no committed DOM predates it); M8 fixup validates cert in layout effect (see C10) |

outcome: both (a) and (b) resolve in the pass's world on first render. The
(b) trap — "first evaluation may run before any world-sensitivity is
discoverable" — is closed by evaluate-then-recheck (M7) + complete
certificates: sensitivity is discovered *by evaluating in the world*, and
the certificate + buckets make the fresh node reachable for every subsequent
divergent write (C1 step-6 machinery).
residual risk: the fresh-node mark-gate bypass predicate ("no canonical
cache") must be cheap and exact — it is a kernel flags read; pinned by
react-concurrent-store scenario 9 (its known-bug case) + `c9` tests.

### C10 — late subscription joins the pending batch

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | k writes a (receipt@1/k) | cone marked; existing watchers delivered in k |
| 2 | component M mounts (urgent render, not k's) | world = ({U}∪locked, pin): excludes k → M renders committed values; cert{(a,0-or-committed-tail)}; subscribes at commit |
| 3 | M8 layout effect (same commit) | L2 on M's cert vs current tape: tail(a) in **k-world**? — fixup checks the cert against every live slot's world (a is in bucket…): recorded committed-tail vs tail_{committed∪k}(a)=1 → divergence detected for k → corrective `runInBatch(k, setState(M))` → M's correction joins **k's own lanes** |
| 4 | k's render+commit | one commit contains k's updates and M's corrected render (fork invariant 5) ✓ |
| 5 | (race) k retired between 2 and 3 | runInBatch returns false → urgent setState in the layout effect = pre-paint correction ✓ |

Why a fresh startTransition is NOT equivalent: it mints a new token T';
React may commit k first and T' later — two commits, and the window between
them shows k's world with M's stale subtree = the torn frame the case
forbids. `runInBatch` entangles into k's existing lanes, so React cannot
commit k without M's correction.
outcome: matches Required including the fallback.
residual risk: fixup must compare against *all live slots'* worlds, not just
the render's own (the divergence is in a world M did not render); pinned by
`c10` + fork test 7.

### C11 — multiple roots (declared scope: FULL spanning support)

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | k spans roots A,B (writes reach watchers on both) | deliveries in k on both roots; fork tracks k-work per root |
| 2 | A's k-pass commits | onRootCommit(A,[k]) → locked[A] ∋ k; k NOT retired (B pending) — K0 unchanged (k's receipts still live-deferred) |
| 3 | later renders on A (any priority) | world = mask ∪ **locked[A]** (∋k), so every A-pass keeps including k → A never contradicts its committed DOM ✓ |
| 4 | A's passive effects | flush world = locked[A]-composed (§6.4) → observe k's values after A's commit, pre-retirement ✓ |
| 5 | B renders/commits k | B's passes: locked[B] ∌ k until its commit → B excludes k (its own DOM consistent); commit → locked[B] ∋ k |
| 6 | fork: last root committed | onRetire(k, true) **exactly once** → M9 fold → K0 moves; reconcile suppresses A/B watchers that already rendered k; sweep; locked bits for k become redundant (retired-clause) and are cleared |

outcome: per-root self-consistency throughout; the "single global committed
world is wrong per root" trap is dead because *committed view* is
`retired ∪ locked[root]` — a per-root mask over one shared receipt store —
while K0 (shared) only ever holds the retired∪urgent floor, which is a lower
bound for every root.
residual risk: fork's per-root k-work accounting (portals must count as the
host root — they are the same FiberRoot, so they do); pinned by fork test 6
+ `c11` two-root integration test.

### C12 — store-only transitions persist

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | `startTransition(() => a.set(5))`, no subscribers | receipt@1/T; walk: cone has no watchers → marks only; no React work exists |
| 2 | T closes with no React work | fork still fires onRetire(T, committed=**false**) (invariant 2) → **D2: fold anyway** → K0 a=5 ✓ |
| 3 | async action: `a.set(1); await io(); a.set(2)` | receipts @1/T,@2/T — same token across the await (fork parks it; surface 5 note); no retire before settle |
| 4 | action settles | onRetire(T, …) → fold replay → K0 a=2; not before the action settled ✓ |

outcome: persistence independent of subscription (the S4 scar's policy,
structural here: fold is unconditional on retire).
residual risk: fork async parking; pinned by fork tests 1/5.

### C13 — counter/world-id lifecycle soundness

Every counter, its references, and its cross-episode guard:

| counter | referenced by | guard at reset |
|---|---|---|
| `globalSeq` | receipts (swept before reset), memo stamps (swept), watcher lastPin, fold cursors | `worldEpoch` stored beside every retained pin/cursor; mismatch ⇒ treat as stale (re-derive / deliver) — I8 |
| `eraFloor` ticket | markPlane stamps | floor is monotonic within an epoch; episode reset bumps floor above all stamps (never resets ticket below existing stamps; ticket itself is epoch-scoped, and markPlane is NOT cleared — only the floor moves) |
| `writeClock[slot]` | memo L1 stamps | memos with slot in mask are swept at slot retire (T6); clock resets only at recycle, after sweep |
| `retirementClock` | memo L1, fold cursors | epoch-guarded with globalSeq |
| slot ids (5-bit) | masks in memos/certs/thenables/locked | recycle gated on `unswept==0` (I10); sweep enumerates via registry chains |
| lineageId | thenable caches | entries die at slot retire (before the id could recur); ids are fork-monotonic u32 |
| node ids / GEN | kernel + overlay side planes | kernel's own deferred-free + GEN discipline (substrate) |

Walk: drive to quiescence → episodeReset(): tapes swept to base, planes to
watermark, `worldEpoch++`, floor above all stamps, seq=1. New episode mints
seq 1,2,… colliding numerically with retained `lastPin`/cursors → every
consumer compares `worldEpoch` first → stale values re-derived; no memo or
cert survived (swept with slots or at reset); marks unreadable below the new
floor. Forced-wraparound tests: (a) seq forced near 2^31 → assert episode
reset renormalizes before overflow (writes between episodes bounded by gate;
overflow mid-episode triggers a forced quiescence flush + epoch bump —
documented degenerate path); (b) slot churn ×10k with live memos (recycle
gate); (c) eraFloor ticket wrap (epoch bump renormalizes markPlane by bulk
clear — the one place the plane IS cleared); (d) lineage u32 wrap under
restart storms.
outcome: no stale structure can validate cross-episode — each row has a
named guard.
residual risk: a future structure retaining seqs without the epoch column;
the schema/codegen sweep (D6) asserts every seq-typed field is paired with
an epoch field at codegen time (structural, enumerable).

### C14 — StrictMode and replayed renders

| concern | mechanism | why it holds |
|---|---|---|
| render-phase purity | world evaluation touches only overlay planes; memo publication idempotent (purity ⇒ identical value/cert; same (node,mask) slot overwritten); discarded passes leave at worst unused memos — value-correct for their mask, reclaimed at sweep | no observable graph mutation across replays; K0 mutations during render are only lazy canonical pulls = alien-signals' normal idempotent read semantics (179-case suite covers) |
| double-fired writes | render-phase writes **throw** (§5.1, renderContext truthy incl. replays) | no write can fire once, let alone twice |
| double mount/unmount | observed-lifecycle (R1 effect) is microtask-debounced; mount-unmount-mount nets to one 0→1 | flap-proof by R1's own contract |
| thenable identity across replays | cache key (node, mask, position); replay = same mask, same positions → same thenables (§10.7) | React re-`use`s identical thenables, no re-suspend loop |
| delivered-bit hygiene | StrictMode double-invokes renders, not writes; bits keyed to pass-start clear per onPassStart (replays share the lineage; each attempt re-clears) | over-delivery at worst |

outcome: matches. residual risk: dev-only double `onPassStart` ordering;
pinned by fork test 4 + running the whole conformance suite under
StrictMode (invisibility tests, D6).

### C15 — suspense across worlds

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | k makes computed c suspend | k-pass world w=({k}∪locked,pin); worldEvaluate(c): `ctx.use(fetch())` → thenable cache miss at key (c, mask(w), 0) → store thenable, memo value = suspension sentinel box; cert records reads so far |
| 2 | component reading c throws to React `use` | React suspends the k-pass; canonical world: K0 never evaluated this (c's canonical cache untouched, unmarked readers unaffected; canonical read of c uses committed thenable cache — no suspension) ✓ |
| 3 | new component mounts mid-transition reading c | same pass/mask → same key → **same thenable** → consistent suspension via `use` protocol ✓ |
| 4 | promise settles | retry pass: onPassStart same lineage; world read of c: memo sentinel invalid (thenable settled — sentinel box checks its thenable) → re-evaluate: `ctx.use` hits cache → settled value → memo = value; watcher renders |
| 5 | k commits | retire: settled entries for masks ⊆ retired **promote** to c's committed positional cache; fold; post-commit canonical re-eval of c reuses the settled thenable → no re-fetch, no canonical suspension ✓ |

The key question answered: world identity for the thenable cache =
**canonicalized include-mask (mask ∪ locked)**, lifetime = until any included
slot retires; multi-batch passes get one cache per mask (T7 walked the
split); passSerial appears nowhere (the re-fetch-forever trap), and a bare
token is never the key (multi-batch passes).
outcome: matches R6 including the react-concurrent-store known-bug case
(mount-mid-transition + suspending pending state = steps 3–5).
residual risk: promotion positional alignment (per-node position counter
must match between world and committed evaluations — same fn, purity);
pinned by the 14-scenario harness + `c15` tests.

### C16 — effects observe committed state only

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | D (default) write applied, uncommitted | K0 a=1; tape [1@1/D]; locked[r] ∌ D; cone marked |
| 2 | unrelated retirement flushes useSignalEffects | effect world = (locked[r], retirementClock snapshot): read a → marked → fold excludes D (unretired, ∉ locked[r]) → **0** ✓ effect sees pre-D state |
| 3 | D commits | onRootCommit → locked[r] ∋ D; effect scheduler re-flushes effects whose certs/deps moved in the newly-locked world → effect re-runs seeing a=1 ✓ |

Core `effect()` contract (documented, walked): flushes against NEWEST (K0 =
retired ∪ applied urgent); in step 1 a core effect already sees a=1; deferred
writes appear at retirement. This is the R13 benchmark-honesty configuration
(synchronous observable effects under `configure`).
outcome: matches (hook effects committed-only via M10; core effects newest,
stated).
residual risk: effect-flush world must use locked[r] of the effect's OWN
root; pinned by `c16` + two-root effect test.

### C17 — optimistic rollback / truncation

This design exposes **no truncation surface**: React batches never truncate,
and no API removes receipts from a live tape. The case is resolved by
deleting the surface (the case's own escape clause). Optimistic UI patterns
are served by R3 reducer atoms + transitions (the action log replays per
world; "rollback" = the transition's world simply never becoming committed
is not expressible — D2 folds everything — so optimistic flows model
compensation as *new writes*, e.g. a reducer action carrying the server
correction). Nothing in the architecture forecloses adding truncation later
(receipts are discrete records; truncation would be a new fold visibility
clause + a forced re-validation of every mask containing the slot — the
sweep machinery already enumerates those), but it is out of v1.

## 15. Known gaps (declared, none hidden)

1. **G2/SP-A unmeasured**: the quiet-React read tax (one mark probe) is
   predicted <2% but not yet measured on tier-0. If it fails, the fallback
   (kernel flags bit via approved accessor) widens the kernel seam — a
   D4-adjacent trade that must be re-judged.
2. **SP-C unmeasured**: certificate size/maintenance under kairo-scale
   transition write storms; coarse-mode fallback is designed (§12) but its
   trigger threshold (`CERT_MAX`) is unpriced.
3. **Walk-per-write on hot fan-out** (G4): unconditional deferred delivery
   can spuriously re-render large k-cones on writes that a value-cutoff
   design would suppress. Bounded by per-(watcher,batch,pass) dedup (≤1
   spurious render per watcher per pass round), but the constant is
   unmeasured; the mitigation if gated out (memo-shared evaluation at
   delivery time) re-introduces the expensive shape and would need its own
   round.
4. **Multi-root full support** leans on fork per-root k-work accounting
   (surface 6) that has no prior-generation existence proof (the registry
   edges proven in the previous fork suite are surfaces 1/2/5-shaped). Fork
   test 6 is therefore on the critical path, and the degraded-multi-root
   posture (locked-mask skew documented) is the designed retreat.
5. **Mid-episode tape memory**: v1 sweeps retired receipts only at episode
   boundaries; a pathological never-quiescent app grows tapes unboundedly.
   Gate G9 watches it; O10 coalescing is the named future fix with its
   legality condition stated (§5.4).

No unwalked cases: C1–C17 all walk above (C17 by surface deletion, as the
case permits).

## 16. Dead-end statement (what kills this stance)

The stance dies if **certificate completeness cannot stay enumerable under
composition** — concretely, if a schedule is found where a world evaluation
reads state through a channel that neither lands an atom entry nor a
dep-entry nor is walked by M3 (candidate channels audited and closed here:
untracked reads — recorded in certs like tracked ones, §7.1; canonical
K0-serve of computeds — dep entries; folds — fold-walk; fresh nodes — M7).
A reviewer who exhibits a fifth channel kills the design, because each new
channel is another semantic completeness obligation and the stance's whole
bet is that the obligation list is closed and sweep-checkable. Second
killer: SP-A + SP-C jointly failing (read tax >2% AND cert costs blowing
G6/G7) leaves no compensated fast path — at that point the structural
alternatives (second kernel / overlay world-bits) win O1 and this document
becomes the record of why.

## 17. Compliance notes

- R1–R13 covered in §4–§10 (R11 tracing adopts the reference §16 bar
  verbatim: lazily-loadable recorder, ring + session modes, one slot check
  per site untraced — nothing in this architecture forces changes; receipts
  give the tracer its causality spine for free).
- DECISIONS D1–D7: D1 §3/§5.1; D2 §9.2/C12; D3 §5.2–5.3; D4 §4 (K0
  untouched; overlay in side planes; SP-A fallback flagged as the one
  potential D4 trade); D5 §8.3; D6 inherited (§2 substrate note, C13
  schema sweep); D7 §11 (co-designed 8-surface protocol).
- E-requirements: pnpm/TS/type-over-interface/undefined-over-null/branded
  ids/`__DEV__`-by-define/const-enum same-file — adopted as written; planes
  follow the measured binding rules (closure-const buffers, rebuild at
  operation boundaries) [GUIDE].

*end of spec*
