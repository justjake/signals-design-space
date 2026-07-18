# Design: TWO-KERNEL — real pending-world topology in a second kernel plane

Stance: per-world staleness/reach lives in a second kernel instance (K1). The
pending worlds' dependency topology is REAL — world evaluations track their
actual read edges in K1 — lazily populated while forked, bulk-reset at
quiescence. The canonical kernel (K0) stays the closed, monomorphic donor
arena kernel. This spec takes the stance's three named obligations head-on:
the shadow/sync obligation between the two topologies (§6.3
retire-into-shadow), per-batch notification granularity (§8, I5-compliant
delivery dedup), and the kernel/policy indirection cost (§5.3: K0 needs two
null-checked per-recompute hooks, not a per-read host protocol; both SP1
outcomes have a plan, §12.4).

---

## 1. One-page summary (the whole concurrency story)

**Two modes.** DIRECT (no React): the donor arena kernel K0 is the entire
engine; zero concurrency instructions execute (P3/D1). Registering the React
bridge — monotonic, never keyed to watcher count (S6) — rebuilds the kernel
closures once (the arena's existing growth-rebuild machinery) into LOGGED
mode: a logging write function and two null-checked recompute hooks are
swapped in. Nothing else about K0 changes; its plane, walks, and exact-pull
semantics are the donor's.

**One value truth plus receipts.** K0's value column always holds the
*newest* world (every write applied in order). In LOGGED mode every write —
urgent included (I1) — also appends a receipt `{op, batchSlot, seq}` to the
atom's tape; the atom's pre-fork *base* value is preserved on first receipt.
Any world's value of an atom is a fold: base + entries visible under the seed
visibility math (retired ≤ pin, or slot ∈ mask ∧ seq ≤ pin), replayed in seq
order — clause-for-clause React's queue filtering and rebase (D3, I2).

**Worlds route reads.** A world = (include mask over ≤31 batch slots, pin,
per-root lock-in). The engine mirrors the fork's pass lifecycle into a
`currentWorld` pointer (per-callstack truth: yields reset it to NEWEST — I6).
Reads at NEWEST hit K0 raw. Reads in any other world consult a per-node
routing flag: unflagged nodes provably agree with newest and are served by a
native K0 pull; flagged nodes go to per-(node, worldKey) memos.

**K1 makes pending topology real.** World evaluations run policy-side and
record their true read edges in K1, a second bump-allocated kernel plane.
K1 is add-only while forked and bulk-reset at quiescence (epoch-guarded,
C13). When K0 re-tracks a node while forked, its old edges are first
mirrored into K1 (*retire-into-shadow*), so no world's recorded evaluation
basis ever loses its edges — the shadow/sync obligation is one enumerable
site with a written invariant (E-PRESERVE, §6.3).

**Validity is clocks, not certificates.** A world memo is valid iff no
included slot has written since it was made (per-slot write clocks) and no
retirement/quiescence epoch has passed. That is S5-immune by construction
(validity never depends on a recorded read set). A per-memo direct-dep
version recheck (alien's checkDirty transplanted) is layered on top purely
to avoid recomputes.

**Notification is a per-write walk, delivered in the writer's stack.** Each
logged write traverses its K0 ∪ K1 reachable cone once (per-walk visited
stamps, no cross-walk marks) and calls each reached watcher's `setState`
synchronously in the writer's execution context (D5) with per-(watcher,
batch-slot) dedup, re-armed when the watcher's hook renders (I5/C4-safe).
There is no grouped drain, so C6 lane attribution is by construction.
A reach induction (§8.2) proves the walk-or-already-scheduled property.

**The fork speaks seven facts** (§10): write classification (lazy tokens),
pass lifecycle with yield/resume edges + a current-pass query, per-root
retirement/lock-in, `runInBatch` lane-scoped execution, render-lineage ids
(suspense keys), the DOM mutation window, and a version handshake. Bindings
depend only on the protocol document; the rebase drill answer is "the fork
re-implements the facts; the library moves zero lines."

**Lifecycle.** Retirement folds tapes into bases by seq-order replay (C3
parity), runs a committed-context reconcile backstop, respects pass pins
before compacting (C7), locks in per root (C11 full-spanning). Quiescence
resets K1, flags, memos, and counters behind epoch guards (C13).

Numbers: DIRECT = donor kernel, cited [ARENA]. Gates: logged write ≤2×
DIRECT; React-mounted-quiet tier-0 ≤2%; K0 hook tax ≤1% recompute-dense;
world-eval cost ∝ flagged region only. Unmeasured items are spikes (§12.4).

---

## 2. Concepts and vocabulary (all terms defined before use)

- **K0** — the canonical kernel: the donor arena kernel (`libs/arena`),
  one Int32Array plane, stride-8 interleaved node+link records, alien-v3
  push-pull semantics, exact pull counts, 179/179 conformant [ARENA]. Holds
  newest values, newest topology, native staleness flags.
- **K1** — the shadow kernel: a second, smaller plane holding *world edges*
  (dependency edges recorded by non-newest evaluations) and nothing else —
  no values, no recompute machinery. Add-only while forked; bulk-reset.
- **DIRECT / LOGGED** — engine modes. DIRECT = pure core. LOGGED = React
  bridge registered; every write leaves a receipt. Activation is a one-time
  closure rebuild; monotonic for the process lifetime of the bridge.
- **seq** — one global monotonically increasing write ticket (53-bit safe
  integer). Every logged write gets one.
- **tape** — per-atom append-only receipt list `{op, slot, seq}`;
  `op` is `set v` | `update fn` | reducer action. **base** — the atom's
  value with no live receipts folded in (committed accumulator).
- **batch / token / slot** — a batch is React's unit of update+retire; the
  fork mints an integer token per batch (never reused live); the engine
  interns live tokens into ≤31 slots (I10) so include-sets are 32-bit masks.
- **world** — a self-consistent assignment of values to atoms, specified by
  `(mask, pin, root?)`: entries visible iff `(retiredSeq ≠ 0 ∧ retiredSeq ≤
  pin) ∨ (slot ∈ mask ∧ seq ≤ pin)`, where for a root-scoped world `mask`
  additionally contains the root's locked-in slots (C11). **NEWEST** — the
  distinguished world containing everything; served by K0 directly.
- **worldKey** — a small integer interning `(mask, pin, rootLockInVariant)`;
  epoch-scoped (dies at retirement/quiescence).
- **world evaluation** — running a computed's fn with reads resolved by fold
  /memo instead of K0 cache, recording edges into K1.
- **world memo** — cached result of a world evaluation: `{value|sentinel,
  seq, epoch, deps: [(id, version)], fnVersion}` keyed `(node, worldKey)`.
- **worldSensitive flag** — per-node monotone bit (episode-scoped): "a
  logged write this episode may make some world disagree with newest below
  here." Routing filter only — never a notification mechanism (per the
  mechanism-library caveat on overlay marks).
- **watcher** — a mounted hook's subscription record on a node:
  `{setState, lastRendered, notifiedMask, lastRenderSeq}`.
- **pass** — one render attempt; fork-scoped with yield/resume edges;
  carries `(root, mask, pin, lineageId)`.
- **lineage** — fork-minted stable identity for a root × batch-set's render
  attempts across restarts, until commit/abandon; suspense cache key (C15).
- **pin** — the global seq captured at pass start; freezes the pass's world
  across yields (C7).
- **retirement** — a batch leaving React's books; the engine folds its
  receipts into bases (never drops — D2), exactly once per token.
- **episode** — the span between quiescent points (no live batches, no live
  passes, tapes compacted). Quiescence resets K1/flags/memos with epoch
  bumps (C13).

## 3. Value model: tape, folds, and parity

### 3.1 The logged write path (exact sequence)

```
write(atom, op):
  if currentWorld is a render world: throw            // R8/C14; per-callstack truth §7.3
  token = fork.currentBatchToken()                    // lazy mint; sync batch, default, or transition
  slot  = internSlot(token)
  seq   = ++globalSeq;  slotWriteSeq[slot] = seq
  if atom.tape.length == 0: atom.base = k0.value(atom) // preserve pre-fork accumulator
  atom.tape.push({op, slot, seq})                      // ALWAYS — even equal values (I7, C8)
  k0.writeNewest(atom, apply(op, k0.value(atom)))      // native; equality may skip K0 marks only
  notifyWalk(atom, slot)                               // §8: full reach, writer-context delivery
```

No write-time equality drop exists in LOGGED mode (I7's safe case — empty
history — is exactly the DIRECT fast path, which keeps the donor kernel's
native equality skip). K0's *internal* propagate may skip marking when the
newest value is unchanged; the notification walk runs unconditionally
because other worlds may still change (C8's schedule is the proof).

### 3.2 World value of an atom

`foldAtom(atom, world)`: start from `atom.base`; apply, in seq order, every
tape entry visible under the visibility math (§2 "world"). This is the seed
math verbatim; by D3 it is clause-for-clause React's lane filtering, and
seq-order replay over the pre-batch base is I2's parity fold. `ReducerAtom`
uses the same tape with actions as ops and the reducer as `apply` (R3
parity comes from identical machinery, tested side-by-side).

Newest is maintained incrementally at write (§3.1), so NEWEST reads never
fold. Committed-for-root is `world(mask = lockedIn(root), pin = now)` where
retired entries are visible by the first disjunct.

### 3.3 Retirement fold and compaction

On `onBatchRetired(token, committed)` (fold happens for *both* committed
values — D2, C12):

1. Stamp every tape entry of the token's slot `retiredSeq = ++retireSeq`.
2. Bump `worldMemoEpoch` (coarse: all world memos die; §7.2 explains why
   this is sound and cheap — retirements are per-batch, not per-write).
3. For each atom in the slot's touched-atom registry: recompute
   `base' = fold of the retired prefix` and **compact** — remove a prefix of
   entries all retired with `retiredSeq ≤ min(live pass pins)` and no
   smaller-seq unretired entry behind them (pin+retention rule; C7's yielded
   pass keeps its pre-click world because the click batch's entries stay on
   the tape, invisible under its pin, until the pass ends).
4. Reconcile backstop (§9.4): for each watcher on a fold-changed atom's
   cone, compare `lastRendered` with the newest value; mismatch → corrective
   setState (urgent). This is a safety net; the per-write walk should have
   already scheduled the right renders.
5. Release the slot when its unswept-entry count reaches 0 (I10) — not
   merely when the token retires.

### 3.4 Quiescence (episode reset)

When live batches = 0 ∧ live passes = 0 ∧ all tapes compacted: bump
`episodeEpoch`; bump-reset the K1 plane and the library→K1 id column; clear
all worldSensitive flags; drop the worldKey intern table and all world
memos; optionally reset `globalSeq` (guarded — every consumer carries an
epoch, C13 walk §13). Cost: O(touched nodes this episode), amortized against
the transition that paid for them; quiet apps quiesce every event.

## 4. Worlds: derivation, routing, and the fast paths

### 4.1 Where worlds come from

- **NEWEST** — the default outside passes; also any pass whose mask covers
  every live slot with pin = now (quiet urgent flow): served raw by K0.
- **Pass worlds** — fork `onPassStart(root, tokens[], lineageId)` → engine
  interns `(mask ∪ lockedIn(root), pin = globalSeq, root)` → sets
  `currentWorld`. Yield → `currentWorld = NEWEST`; resume → restored (§7.3).
- **Committed-for-root** — used by `useSignalEffect` flushes and the C10/
  reconcile checks: `(lockedIn(root) mask, pin = now, root)`.
- **Writer's world** — not materialized; per-write cutoffs are deliberately
  not evaluated (the eager-per-write shape is the known cost trap
  [SYNTH §10.6/G-7]); §8 notification is value-blind.

### 4.2 Read routing (public `.state` getter and world evaluations)

```
read(node):
  w = currentWorld
  if w == NEWEST: return k0.pull(node)          // donor fast path, tracked in K0 if inside a K0 eval
  if !worldSensitive(node): return k0.pull(node) // provably world-agnostic, §4.3; tracked in K1 if inside a world eval
  if node is atom: return foldAtom(node, w)      // memoized per (atom, worldKey), same validity as memos
  return worldMemoRead(node, w)                  // §7
```

The one-branch cost of `w == NEWEST` is the entire quiet-mode read tax
(gate G-Q, §12). `k0.pull` is the donor's native verify/recompute — exact
pull counts preserved.

### 4.3 The worldSensitive routing flag (construction, since we claim
"unflagged ⇒ K0 value is valid for every world")

Flag semantics: `flag(n) = 0` ⇒ no atom with a live-episode receipt has a
K0∪K1 path to `n`, hence every world's fold of `n`'s evaluation basis equals
newest, hence K0's cached/pulled value is correct for every world.

Invariant **F**: if atom `x` has any tape entry this episode and a K0∪K1
path `x → … → n` exists, then `flag(n) = 1`.

Maintenance (induction over events):

- Base: episode start — no tapes, no flags, F holds vacuously.
- Write to `x`: the notification walk (§8) visits the entire current K0∪K1
  reachable cone of `x` and sets flags on every visited node. Paths existing
  at write time are covered.
- Edge added later (u→v):
  - world evaluation of `v` reading `u`: at evaluation end, `flag(v) |=
    flag(u)` (and `v`'s memo is fresh, so no stale serve in the gap);
  - K0 re-track of `v` (newest evaluation): the `afterRetrack(v)` hook (§5.3)
    ORs the flags of `v`'s new deps into `flag(v)`;
  - in both cases, if `flag(u)` becomes 1 only *later*, that later write's
    walk traverses the now-existing edge u→v and flags `v`. Either order is
    covered, so F holds after every event. ∎
- Flags are monotone within an episode (no clearing ⇒ no re-arm coherence
  hazard; over-set flags cost routing precision, never correctness) and are
  bulk-cleared at quiescence.

Consequence for cost: world evaluation only interprets the *flagged* region
(touched this episode); unflagged subgraphs resolve through native K0 pulls.
This is the G-8 mitigation: held-open-transition reads pay ∝ |touched cone|,
not ∝ |closure| (§12.3).

## 5. K0: the canonical kernel, and everything it does NOT do

### 5.1 What K0 is

The donor arena kernel, unmodified in layout and algorithm: stride-8
interleaved node+link records on one plane, DEPS_TAIL re-track cursor,
iterative walks with persistent scratch stacks, split `link()`/`linkInsert`
[ARENA][GUIDE]. It owns: newest values, newest topology, native staleness,
core `effect()` scheduling, cycle detection (R7 engine half). DIRECT mode
is K0 alone: the conformance suite and tier-0 benches run on the donor
numbers (deep 0.90×, broad 0.84–0.88×, diamond 0.89×, reads 0.74–0.87×,
create 0.96× vs alien-signals v3 [ARENA][SYNTH §18.2]).

### 5.2 Mode activation = closure rebuild (P3's literal zero)

The arena kernel already rebuilds its closures at growth boundaries (buffers
as closure constants [GUIDE]). Bridge registration reuses exactly that
machinery once: rebuild with (a) the LOGGED write function (§3.1) and (b)
two hook callsites (§5.3) compiled in. DIRECT closures contain no
concurrency code at all — not even dead branches — so "pure-core users
execute zero concurrency instructions" is literal (P3). The plane, ids, and
values survive the rebuild (same buffers). Activation is monotonic (S6):
receipts begin at bridge registration, before any watcher exists.

### 5.3 The two hooks (the kernel/policy seam inside the engine)

LOGGED-mode K0 recomputation gains two null-checked callsites, both
per-*recompute* (never per-link, never per-read):

- `beforeRetrack(n)` — fires when K0 is about to replace `n`'s dep set.
  While forked (any live batch), policy mirrors `n`'s *old* K0 edges into
  K1 (§6.3 retire-into-shadow).
- `afterRetrack(n)` — fires after the new dep set is linked. Policy ORs
  new-dep worldSensitive flags into `flag(n)` (§4.3) — one cold-column load
  per new dep.

Cost class: recomputes are O(nodes-per-wave), links are O(fan-in × nodes);
two predictable branches per recompute is the fork-charter "inert when
unused" pattern applied to the engine. Predicted ≪1%; gated and spiked
(SPK-H, §12.4), never asserted. This is deliberately NOT the four-callback
host protocol (values stay in-plane; no `refresh` indirection on the hot
path), which is how this design stays safe under either SP1 outcome (§12.4).

## 6. K1: the shadow kernel (the stance's core)

### 6.1 Layout and population

K1 is a second, smaller plane: per shadow node `{firstOutLink}`, link
records `{target, nextOut}` — bump-allocated, add-only, no values, no
flags, no re-track cursor (nothing is ever evaluated *in* K1; it is reach
structure for walks). A cold parallel Int32 column on K0 ids holds
`k1IdAndFlag` (bit 0 = worldSensitive, upper bits = K1 id + epoch tag);
cold parallel columns are outside the measured interleaving hazard
[RESEARCH][SYNTH §7.1 — the 1.8× loss was for hot traversal fields].

Population sources (all lazy):

1. **World evaluations** (§7.1): every dependency actually read by a
   non-newest evaluation adds edge dep→node in K1 (dedup per (edge, episode)
   via a link-exists probe on insert; add-only thereafter).
2. **Retire-into-shadow** (§6.3): old K0 edges of a forked re-track.

K1 never shrinks mid-episode. Precision loss from union/add-only edges is
over-*notification* only (a spurious setState re-render, bounded by the
per-(watcher,slot) dedup to ≤1 per watcher per batch per render cycle) —
never a missed delivery and never a wrong value (values come from folds and
memos, not from K1).

### 6.2 Why real edges (what this buys structurally)

C1's trap is that `a` has no canonical edge to `c` once `c`'s pending-world
evaluation read `{flag, a}`. In this design that evaluation *itself* wrote
edge a→c into K1 at the moment it read `a` — the pending world's topology is
as real as K0's. The C1 family, C4's second-batch re-notify, and the
mount-mid-transition reach cases all reduce to "walk K0 ∪ K1" plus the
delivery dedup. No compensation stack (registries, full certificates, drain
re-validation) exists to keep complete — the completeness obligation is
discharged by construction at the read site (a read cannot happen without
leaving its edge).

### 6.3 Retire-into-shadow: the shadow/sync obligation, bounded

The one way a recorded evaluation basis can lose edges is K0 re-tracking a
node while forked (newest evaluations legitimately replace dep sets; the
DEPS_TAIL cursor drops stale links). The rule:

> **E-PRESERVE.** While any batch is live, before K0 replaces node `n`'s
> dep set, every current K0 edge d→n is mirrored into K1 (skip if already
> present). Fires at exactly one site: the `beforeRetrack` hook (§5.3).

Invariant maintained (**basis-edge completeness**): for every value any
world could still be served (a K0 cached value, or a world memo), every
direct dependency edge of the evaluation that produced it is present in
K0 ∪ K1 at all times until quiescence.

- Base: at fork start (first live batch), all cached values are K0 values
  whose edges are K0-present.
- Step (world eval): records its own edges in K1; K1 is add-only ⇒ they
  persist to quiescence. Memos die at quiescence with the epoch bump, so
  lifetime is covered.
- Step (K0 re-track): the only edge-dropping event; E-PRESERVE mirrors the
  dropped set first. New basis's edges are K0-present. ∎

Dev-mode validator (O3, SP2): after each world evaluation, brute-force
recompute the node's read set by re-running the fn with a recording context
and assert every read has a K0∪K1 edge; after each K0 re-track while
forked, assert the mirrored set. Cost is dev-only; SP2 measures it; if
>10% in dev builds, the fallback is sampling (validate 1/N evaluations) —
the invariant is one site, so coverage loss is bounded and the invariant
sweeper (inherited apparatus, D6) still checks plane-level consistency.

### 6.4 Memory and reset

K1 capacity: watermark-sized like the donor plane; ~128 KiB warm steady
state, reused across episodes (bump pointer reset; ids re-minted lazily
against `episodeEpoch` so a stale `k1IdAndFlag` column entry from a prior
episode can never dereference into the new plane — the tag mismatch routes
to re-mint; C13 walk).

## 7. Per-world values: memos, clocks, and the recheck ladder

### 7.1 World evaluation

`worldMemoRead(node, w)`:

1. Memo hit and valid (§7.2) → return value (sentinel boxes re-thrown per
   R2: errors and suspensions are cached values; a throwing getter never
   corrupts graph state — the eval frame is popped and the sentinel stored
   before rethrow).
2. Else evaluate: push a world-eval frame (world w, K1-tracking, explicit
   stack — no engine recursion), run `fn(ctx)`; every tracked read routes
   through §4.2 *inside w* (atoms fold; unflagged nodes K0-pull; flagged
   computeds recurse); each read appends its K1 edge and its
   `(depId, depVersion)` pair; store memo `{value, seq = globalSeq, epoch,
   deps, fnVersion}`; `flag(node) |= OR(dep flags)` (§4.3); pop.

Render-world frames reject writes (R8: "render-world evaluation always
rejects writes" — detection is the frame bit, per-callstack, S7-safe).
Cycles: the eval stack carries a visiting set; revisit → throw (R7).

### 7.2 Validity (sound core): write clocks + epochs

Memo valid iff:

```
memo.epoch == worldMemoEpoch                    // no retirement/quiescence since
∧ ∀ slot s ∈ w.mask: slotWriteSeq[s] ≤ memo.seq // no included-slot write since
```

- Soundness: a world's fold result can only change via (a) a write in an
  included slot — caught by its clock; (b) a retirement changing base/
  visibility — caught by the epoch; (c) nothing else (mask and pin are part
  of the worldKey; a different pass is a different key). S5-immunity: the
  check never consults a recorded read set, so an atom that acquires its
  first receipt *after* an evaluation cannot be missed — its write bumped
  the slot clock (always-log), which invalidates every memo whose mask
  contains that slot regardless of what the evaluation read.
- Coarseness is the accepted trade (per O9's guidance): any k-write kills
  all k-mask memos. The recheck ladder restores recompute-avoidance:
  on clock failure, walk the memo's direct deps first — atoms re-fold
  (cheap; version = seq of newest visible entry, sentinel 0 for tape-free),
  computed deps recurse — and if every `(depId, version)` matches, refresh
  `memo.seq` without recomputing (alien's checkDirty, transplanted; equality
  cutoff per world falls out: an equal re-fold keeps the version). This is
  a *performance* layer; correctness never depends on it.

### 7.3 currentWorld truth across yields (I6/S7)

The fork flips pass state at the reconciler's own work-loop boundaries
(§10 F2): enter/resume set `(passId, world)`, yield/exit clear to NEWEST.
Because the flip sites are the code the reconciler already executes when it
actually starts/stops working, the value is per-callstack truth, not
wall-clock scoping: a click handler in a yield gap sees NEWEST (C7 reads),
its writes classify under the click's own batch (fork F1), and the resumed
pass restores its pinned world untouched.

### 7.4 Suspense values (R2/C15)

`ctx.use(thenable)` inside a world evaluation consults the positional
thenable cache keyed `(node, lineageId, positionIndex)`. Same world lineage
⇒ same thenable identity across replays and restarts (StrictMode C14,
retry C15). NEWEST evaluations cache suspension sentinels as values in K0's
policy column (R2) and never consult lineage caches. Lineage caches drop at
batch-set commit/abandon (fork F5 lifetime).

## 8. Notification: per-write walk, writer-context delivery

### 8.1 The walk

`notifyWalk(atom, slot)` — runs synchronously inside the write (§3.1), in
whatever React execution context the writer occupies (D5: lane inheritance
is free):

```
stack = [atom]; ticket = ++walkTicket
while stack not empty:
  n = pop
  if visited[n] == ticket: continue
  visited[n] = ticket
  flag(n) = 1                                   // §4.3 F-maintenance
  for each K0 out-edge n→m: push m              // policy reads K0 plane directly
  for each K1 out-edge n→m: push m
  for each watcher W on n:
    if !(W.notifiedMask & bit(slot)):
      W.notifiedMask |= bit(slot)
      W.setState()                              // synchronous; React assigns writer's lane
  if n has core-effect subscribers: enqueue once (flush-coalesced; NEWEST contract §9.5)
```

Properties: full reach per write (no cross-walk marks — the mark-stop
coherence hazards with add-only edges are documented in §14 as the rejected
optimization); per-walk visited stamps only; delivery dedup is per
(watcher, slot) — I5's required granularity — and is the only cross-walk
memory.

Re-arm rule: when a watcher's hook runs during a pass, it clears its
`notifiedMask` bits for every slot in the pass's mask and records
`lastRenderSeq = pass.pin`. Clearing early is safe (over-delivery only —
React dedups scheduled work); the hazard direction is under-delivery, which
the induction below excludes. Unmount removes the watcher record. Slot
recycle clears the slot's bit column (gated on unswept = 0, I10).

### 8.2 Reach induction (the "walk-or-already-scheduled" construction)

Claim: for every watcher W, batch k, and moment t: if W's k-world value at t
differs from what W last rendered for a world including k (or will be asked
to render), then either (a) `W.notifiedMask` has k's bit set — W is
scheduled in k's lane and its render will pull fresh values (memo validity
§7.2 cannot serve the stale value: the diverging write bumped
`slotWriteSeq[k]`), or (b) a future k-write will set it, per this induction.

- Base: before any k-write, W's k-world value equals its rendered world's
  value extended by k = ∅ — no divergence, claim vacuous.
- Step: consider the next k-write, to atom x, given the claim held before.
  If bit already set → (a) persists (bit clears only at a render *in a pass
  including k*, which re-reads through invalidated memos and repins — after
  which "last rendered for k" is current again).
  If bit clear: W's basis (the evaluations its rendered value came from) has
  every direct edge present in K0 ∪ K1 (basis-edge completeness, §6.3).
  If x is outside the basis's transitive read set, replaying the basis in
  k-world reads the same atoms with the same values (purity, R2/C14; only
  x changed among visible entries) — no divergence introduced. If x is
  inside, the walk from x follows recorded edges (present, per E-PRESERVE)
  to W and sets the bit — (a) now holds. ∎

Corollaries: C1's `a.set(1)` reaches W through the K1 edge recorded by the
k-world evaluation; C4's T2 write delivers because T2's bit is distinct;
a second same-batch write after W re-rendered (bit re-armed) re-delivers
because the walk is full-reach (no stale stop can absorb it).

### 8.3 What notification deliberately does not do

No value evaluation at write time (the eager writer's-world cutoff is the
measured-expensive shape [SYNTH §10.6/G-7]). Consequence: a watcher whose
world value is ultimately unchanged (C5's first write; T4/T5 cross-world
over-reach) takes one spurious re-render per (watcher, batch). That is the
priced trade (gate G-N, §12): useState parity is the bar, and useState
re-renders on every set too. An optional policy knob (`notifyCutoff:
'evaluate'`) may pull the watcher's world value before setState for
fan-out-heavy apps; it is off by default and carries the fan-out gate.

## 9. React bindings

### 9.1 Watchers and hooks

`useSignal(sig)` / `useAtom` / `useComputed(fn, deps)` share one shape: a
hook-instance watcher record + `useState(version)` for scheduling + reads
routed through §4.2 under `currentWorld` (the pass's world during render —
so first render of a mount mid-transition reads k's world with no special
case, C9a). `useComputed` mints its node once per hook instance; `deps`
changes swap the fn and bump `fnVersion` (memos keyed with it, §2).

Fresh nodes (C9b): a node created during a render has no K0 value, no K1
edges, no flags. Its first evaluation is *eager world-routed*: it runs as a
world evaluation in the pass's world (never against K0), recording real K1
edges immediately. It is registered (watcher attached, node retained) only
in the commit effect; a discarded or replayed pass leaves only an
unregistered node whose memos die with the lineage (C14 purity: no
observable graph mutation — K1 edges from discarded evaluations cause at
most over-notification, §6.1).

### 9.2 Subscribe-gap fixup (C10)

Render reads happen before subscription (React contract). In the layout
effect, for each live batch token t (≤31): compare the hook's rendered
value against `read(node)` in world(t ∪ committed(root)); on mismatch,
`fork.runInBatch(t, () => setState())` — the corrective update joins t's
lanes, so exactly one commit carries t's updates and the correction. A
fresh `startTransition` is not equivalent: it mints new lanes, so React
could commit t's render (torn: siblings show t's world, W shows stale) and
the correction one commit later. If t retired inside the race window,
`runInBatch` reports dead-token and the fixup falls back to an urgent
setState (pre-paint, layout-effect timing).

### 9.3 useSignalEffect (C16) and core effect()

`useSignalEffect` flushes after commit per root, reading in
world(committed-for-root) — applied-but-uncommitted batches are excluded by
the visibility math (their slots are neither retired nor locked-in for the
root). Effect records keep `(depId, version)` lists; retirement folds
schedule a flush check per root; versions decide re-run (equality cutoff at
the committed world). Core `effect()` keeps the donor kernel's contract —
observes NEWEST, flush-coalesced, synchronously flushable under
`configure({flush:'sync'})` (R13 benchmark integrability) — stated
explicitly as the documented C16 divergence for the non-React API.

### 9.4 Reconcile-at-fold backstop

At retirement (§3.3 step 4), watchers on fold-touched cones compare
`lastRendered` to the committed value; mismatch → urgent corrective
setState. By the reach induction this fires only in races the design
already routes elsewhere (C10 dead-token fallback, C11 degraded skew—
which full-spanning avoids); it exists as a safety net and a telemetry
hook (a fired backstop in tests is a bug).

### 9.5 StrictMode (C14 summary)

Render-phase writes throw (§3.1 guard, per-callstack). Replayed renders
re-run world evaluations idempotently (same worldKey + lineage ⇒ same memos,
same positional thenables). Double mount/unmount: watcher attach/detach and
R1 observed-effects are microtask-debounced (flap-proof). Discarded passes
leave only add-only K1 edges and unregistered fresh nodes — over-notify or
GC fodder, never semantics.

## 10. fork-protocol (the seam — versioned document, not internals)

Protocol version: `__COSIGNAL_PROTOCOL__ = 1`. Bindings feature-detect and
throw on stock React or version mismatch (no silent degraded mode). All
values crossing the boundary are integers, booleans, or documented
callbacks — no Fiber, no lane bitmask, no update-queue internals.

### F1. Write classification
`getCurrentBatchToken(): token` — mints lazily on first ask inside a batch;
`token = (serial << 1) | deferredBit`, never reused while live; ≤31 live
(I10). Invariant: two writes in one React batch get one token; a write
outside any React context gets the urgent-sync token of the event React
would create for it (parity with setState's own classification).
Edge-triggered at: the reconciler's existing `requestUpdateLane` seam.

### F2. Pass lifecycle (with yields)
`onPassStart(root, tokens: int[], lineageId, pin?)`,
`onPassYield(passId)`, `onPassResume(passId)`,
`onPassEnd(passId, discarded: bool)`, plus query
`getCurrentPassId(): id | 0`.
Invariants: yield/resume fire at the work-loop's own enter/exit points
(per-callstack truth — a handler running in a yield gap observes
`getCurrentPassId() == 0`, I6/C7); `tokens` is exactly the batch set whose
updates the pass will apply (D3 parity: our fold mask equals React's
renderLanes filter); a restart is a new passId under the same lineage.
Edge-triggered at: `renderRootConcurrent`/`renderRootSync` entry/exit and
the `workLoopConcurrent` yield return.

### F3. Retirement and per-root lock-in
`onBatchCommittedOnRoot(token, rootId)` — fires at each root's commit that
includes the token (C11 lock-in);
`onBatchRetired(token, committed: bool)` — exactly once per token, after
the last involved root commits, or when the batch closes with no React work
(`committed=false` still folds, D2/C12); async actions park retirement
until the action scope settles (C12's `await` case) — the fork already
tracks the entangled async action; the callback fires on settle.
Edge-triggered at: `commitRootImpl` and the root-scheduler's
lane-retirement bookkeeping.

### F4. Lane-scoped execution
`runInBatch(token, fn): boolean` — runs `fn` so its setStates join the
token's lanes; returns false if the token is retired (caller falls back to
urgent, C10). Invariant: updates scheduled inside `fn` entangle with the
batch's existing render/commit (one commit, C10's requirement).
Edge-triggered at: the same transition/priority context stack React uses
for `startTransition` — the fork pushes the token's lane context.

### F5. Render lineage
`lineageId` (in F2) — stable across restarts and replays of the same
(root, batch-set) attempt; new id when the batch-set changes; dead after
that set commits or is abandoned (then its thenable/memo caches drop).
This is C15's cache key; a bare passSerial re-fetches forever, a bare token
under-keys multi-batch passes — both rejected by construction here.

### F6. Mutation window
`onMutationPhase(root)` — the commit's DOM-mutation window (kept per
charter; used by tracing/devtools overlays, not by core semantics).

### F7. Version handshake
`__COSIGNAL_PROTOCOL__` export + `assertProtocol(min, max)`.

### Rebase drill (charter goal 3)

React renames lanes → tokens are minted integers in the fork's registry
module; the mapping is fork-internal; bindings unchanged. React moves
commit phases → F3's edges re-anchor inside the fork; invariant tests
("exactly once", "lock-in before retired", "effects after lock-in") pin
behavior; bindings unchanged. React changes update-queue internals → this
design never touches hook queues (watcher notification is public setState;
rebase parity lives in *our* tape, not React's queues); nothing moves.
React changes the scheduler/yield mechanics → F2's flip sites move with
the work loop; the per-callstack invariant is re-asserted by the fork test
"handler in yield gap sees passId 0"; bindings unchanged.

### Fork test list (reconciler-level, runs on every rebase)

1. Token mint: one token per batch; deferred bit correct for transitions,
   default, sync; never reused while live; 32nd concurrent batch queues.
2. Retire exactly once per token; committed=false on no-work close; async
   action parks until settle (C12 schedule).
3. Per-root lock-in order: `onBatchCommittedOnRoot` precedes
   `onBatchRetired`; two-root spanning batch fires two lock-ins, one retire
   (C11 schedule).
4. Pass mask parity: for a render with lanes L, `tokens` = exactly the
   batches whose updates React applied (differential against a probe hook
   component reading its own updater queue).
5. Yield truth: throttled scheduler; click handler during yield observes
   `getCurrentPassId() == 0`; resumed pass completes with its original
   mask/pin (C7 schedule).
6. Restart lineage: forced restart (higher-pri interrupt) keeps lineageId;
   adding a batch to the set changes it; commit drops it (C15 schedule).
7. `runInBatch` entanglement: corrective setState inside commits in the
   same commit as the batch (C10 schedule); dead token returns false.
8. StrictMode double-render: F2 events fire per replay with same lineage;
   no double token mint (C14).
9. flushSync excluding default: F2 tokens for the sync pass exclude the
   pending default batch (C2 schedule).
10. Inertness: with no listener registered, every hook site is a single
    null-check (assert via instruction-count harness on the fork build).

Seam touch points: 7 protocol facts; ~10 reconciler sites (F1: 1, F2: 4,
F3: 2, F4: 1, F5: shares F2's site, F6: 1, F7: module export).

## 11. Lifecycle: counters, guards, and episode hygiene (C13 inventory)

Every counter, who retains its values, and the guard that makes reuse safe:

| counter | retained by | reset point | guard |
| --- | --- | --- | --- |
| `globalSeq` (53-bit) | tape entries, memo.seq, pins | optional at quiescence | `worldMemoEpoch`/`episodeEpoch` bump precedes any reset; tapes are empty at quiescence by definition; forced-wrap test drives seq near 2^53 and at forced small-reset |
| `slotWriteSeq[32]` | memo validity checks | slot recycle | recycle gated on unswept=0 (I10) AND memos referencing the slot are dead first (epoch bumped at the retirement that freed the slot) |
| slot ids (5-bit) | notifiedMask bits, tape slots | recycle | same gate; recycle clears the slot's watcher bit column; tape entries with the slot are compacted before release |
| `worldKey` interns | memos | retirement/quiescence | epoch in the key; stale key lookup misses |
| `walkTicket` (int32) | visited stamps | wrap | on wrap: zero the stamp column, continue (test forces wrap) |
| K1 ids | `k1IdAndFlag` column | quiescence plane reset | `episodeEpoch` tag in the column value; stale tag re-mints (C1-T6 test) |
| `lineageId` | thenable/memo caches | batch-set commit/abandon | fork-minted serial; caches keyed by it are dropped on F3 events; forced-reuse test in fork suite |
| `retireSeq` | tape retiredSeq stamps | quiescence | entries carrying it are compacted before reset |
| `fnVersion` (per hook) | memos | hook unmount | memos die with node |

Quiescence detection: `liveBatchCount == 0 && livePassCount == 0 &&
uncompactedTapeCount == 0` — all three maintained incrementally; the reset
runs at the microtask boundary after the last retirement (never inside a
walk or eval).

## 12. Performance: costs against the gate classes

### 12.1 Gate table

| gate | class (requirements) | budget | how |
| --- | --- | --- | --- |
| G-D | P2 DIRECT tier-0 | ≤ alien v3 on every shape | donor kernel verbatim: deep 0.90×, broad 0.84–0.88×, diamond 0.89×, reads 0.74–0.87×, create 0.96× [ARENA][SYNTH §18.2]; 179/179, exact pull counts |
| G-Q | P3 mounted-but-quiet tier-0 | ≤2% | reads: one `currentWorld == NEWEST` branch on public getters only (kernel-internal reads untouched); writes: see G-W; quiescence per event keeps tapes empty |
| G-W | logged write | ≤2× DIRECT write | §3.1: token ask (cached per batch) + push + clock bump + walk; [SYNTH §9.1/G-6] names this the honest C2 price |
| G-N | notify walk | ≤2× DIRECT propagate on tier-0 fan-out; ≤1 spurious re-render per (watcher, batch) | full-reach walk is the same O(cone edges) class as the donor's shallow propagate; dedup bounds setState count |
| G-H | K0 hook tax | ≤1% recompute-dense DIRECT→LOGGED delta | two null-checked per-recompute sites (§5.3); SPK-H measures |
| G-M | P4 steady re-render | 0 engine allocations | quiet mode touches K0 only; transition mode uses pooled tapes/memos/frames (pool high-water reported as plane bytes + heapUsed side by side) |
| G-P1 | P1 signal re-render vs useState | ≤10%; 10k-mount ≤15% | watcher = one setState + one read through §4.2; mount = record append; measured on the react-concurrent-store harness |
| G-E | world-eval cost | ∝ flagged region (never whole closure) | §4.3 routing; SPK-G8 measures held-open-transition read bursts |

### 12.2 Where the costs concentrate (honest accounting)

- Logged write = O(cone) walk per write. Repeated writes into one large
  cone re-walk it (no cross-walk marks). Mitigation intentionally rejected
  (§14 R1) pending SPK-N1; fallback design (per-slot node marks with
  edge-add propagation and render-coherent clearing) is specified there
  with its coherence rules if the gate fails.
- First k-read after a k-write re-validates the flagged region (clock
  failure → dep-version recheck ladder §7.2). Amortized one re-validation
  wave per write burst per world — alien's own verify class, but over the
  touched region only (§4.3).
- Retirement = O(slot's touched atoms + watchers on changed cones) + coarse
  memo epoch bump (re-validation waves are lazy, next read).
- Memory: K1 plane ~128 KiB warm; tapes/memos pooled, high-water sized by
  the largest episode; all reported per G-M.

### 12.3 Held-open transitions (O9/G-8)

A transition held open for minutes with steady k-writes: every k-write
invalidates k-mask memos (coarse clocks) but (a) only the flagged region
re-validates, (b) the dep-version ladder turns most re-validations into
version compares, no recompute, (c) NEWEST traffic is untouched (K0). If
SPK-G8 shows recompute storms on realistic shapes, the escape hatch is
per-atom fold-version memoing (atom folds already carry versions §7.2 —
promote them to a small per-(atom, worldKey) cache; no new invariant).

### 12.4 The SP1 stance (host-tax; both outcomes planned)

This design does NOT adopt the four-callback host protocol on K0's hot
path: values stay in-plane; world evaluation is a policy-side interpreter
that never runs inside K0. The only kernel indirection is §5.3's two
per-recompute null-checks (SPK-H, predicted ≪1% — recomputes are an order
rarer than link traversals; a per-recompute branch is the fork charter's
own inert-when-unused pattern).

- If SP1 measures the full host protocol ≤5% on recompute-dense shapes:
  optionally unify the world evaluator and K0's refresh through the host
  seam in a later milestone (code dedup, one evaluator) — a simplification,
  not a dependency.
- If SP1 measures >5%: nothing here changes; the two-hook variant is the
  design, and SPK-H gates it independently.
Either way no correctness property depends on SP1's number.

### 12.5 Spike register (unmeasured → never asserted)

| spike | question | method | decision rule |
| --- | --- | --- | --- |
| SPK-H | §5.3 hook tax | donor vs hooked build, tier-0 + kairo, one-framework-per-process, bundled child [RESEARCH] | >1% → move hooks behind the closure rebuild so DIRECT builds compile them out entirely (already planned §5.2; then re-measure LOGGED only) |
| SPK-W | G-W logged write | micro: set-heavy tier-0 isolated writes | >2× → tape pooling/inline-2 receipts in the atom record |
| SPK-N1 | G-N repeated-write walks | adversarial: 1k-fan-out cone, 100 writes/frame | fail → §14 R1 fallback marks design |
| SPK-G8 | §12.3 read bursts | held-open transition, kairo-scale graph, mixed read/write | fail → per-(atom, worldKey) fold cache |
| SP2 | §6.3 dev validator | per O3 | >10% dev overhead → sampled validation |

## 13. Correctness walks (every case, required format)

Notation in traces: `tape(x)+={...}`, `wc[k]` = slotWriteSeq for slot k,
`M(c,w)` = world memo, `F(n)` = worldSensitive flag, `NM(W)` = watcher W's
notifiedMask, `K1: a→c` = shadow edge. Committed base values written `base`.

### C1 — world-divergent dependency (family of 7)

`C1: k writes flag then a; c = flag ? a : b must reach 1 in k's world and W re-renders in k's lane pre-commit.`

Setup: flag=false, a=0, b=0; c canonical (K0) deps {flag, b}; W watches c.

```
step | actor/mechanism | state touched
1 | k: flag.set(true) §3.1 | tape(flag)+={set true,k,s1}; wc[k]=s1; base(flag)=false kept; K0 newest flag=true, native mark c
2 | notifyWalk(flag,k) §8.1 | visits flag,c (K0 edge flag→c): F(flag)=F(c)=1; W: NM bit k clear → setState in k's context (transition lane); NM(W)|=k
3 | k render pass P1 starts (fork F2) | world w1=(mask{k},pin=s1); currentWorld=w1
4 | W renders; hook re-arm §8.1 | NM(W) &= ~maskOf(P1)={} ; reads c → F(c)=1 → world eval §7.1
5 | world eval c in w1 | reads flag: fold base false + {s1 visible} = true → K1: flag→c; reads a: tape empty → k0.pull(a)=0 → K1: a→c; M(c,w1)={0, seq=s1, deps[(flag,vs1),(a,v0)]}
6 | k: a.set(1) §3.1 | tape(a)+={set 1,k,s2}; wc[k]=s2; base(a)=0 kept; K0 newest a=1 (no K0 a-edges: canonical deps of c are {flag,b})
7 | notifyWalk(a,k) §8.1 | visits a, then c via K1 a→c (step 5's REAL edge); W: NM bit k clear (re-armed step 4) → setState in k's lane; NM(W)|=k
8 | k re-render pass P2 | w2=(mask{k},pin=s2); W reads c: M(c,w1) keyed w1 — new key; eval: flag=true, a: fold base 0+{s2}=1 → c=1; K1 edges already present
9 | any committed-world read (other component, sync pass excluding k) | w3=(mask{},pin): F(c)=1 → eval: flag folds base=false → reads b=0 → c=0 ✓ via b
10 | k commits; fork F3 | retire k: retiredSeq stamps; fold: base(flag)=true, base(a)=1; epoch++; reconcile: W.lastRendered=1 == committed c=1 → no-op; quiescence: K1/flags/memos reset
outcome: k-world c=1 cached-then-invalidated correctly (wc[k] bump at s2 kills M(c,w1) even for same-key reads); W re-rendered in k's lane pre-commit via the K1 edge (step 7); committed reads 0 via b (step 9). Matches Required.
residual risk: re-arm timing (step 4) — pinned by notify-rearm property test + C4/C5 units; K1 edge insert dedup bug would only over-notify.
```

The trap addressed explicitly: `a` never has a canonical edge; step 7's
reach is the K1 edge recorded at step 5 — the pending topology is real, not
derived. If step 5 never happened (no k-read before step 6), then NM(W)
still holds k from step 2 (never re-armed — W never rendered in a k-pass),
so W is already scheduled and its eventual k-render pulls fresh (reach
induction §8.2 case (a)).

Variants:

- **T2 (k writes committed-only dep b)**: walk from b follows K0 b→c → W
  delivered in k's lane (or bit already set); k-eval of c re-runs (wc[k]
  bumped): flag=true → a → value 1 unchanged. Over-invalidation, correct
  value. Committed world unaffected until retirement. ✓
- **T3 (k: flag.set(false) back)**: walk flag→c (K0+K1) delivers; k-eval:
  flag folds true→false? fold: base false + {set true s1, set false s3} =
  false → c reads b → 0; K1 gains b→c (add-only union {flag,a,b}→c). ✓
- **T4 (urgent U writes b)**: walk b→c (K0) delivers W in U's context
  (urgent lane). U's render (mask {U}, excludes k): c eval: flag=false,
  b=9 → 9 — U's world genuinely changed. k's next pass (pin > U's
  retirement) folds b=9 but c reads a → k-value unchanged (1); memo epoch
  bump at U's retirement forces one re-eval → equal → version ladder stops
  recompute of c's dependents. Committed changes, k-world doesn't. ✓
- **T5 (urgent U writes a=5)**: walk from a follows K1 a→c → deliver in
  U's context. U-world eval of c: flag=false → b → 0 (unchanged; one
  spurious re-render, §8.3 priced). k's next render: fold a: base 0 +
  {k:set1 (s2), U:set5 (s9, retired ≤ pin)} in seq order → 5 → c=5: the
  k-world sees applied urgent state exactly as React's queue replay would
  ((set1 then set5) → 5; D3/I2 parity). ✓
- **T6 (slot/world-id reuse after k retires)**: slot k released only at
  unswept=0 (I10) after epoch bump killed every memo/worldKey citing it;
  NM bit column cleared at recycle; K1 ids carry episodeEpoch tags — a
  stale `k1IdAndFlag` from last episode fails the tag check and re-mints
  (§6.4). Forced test: two episodes with forced same slot+small seq. ✓
- **T7 (two batches render together; one suspends; one commits alone)**:
  pass Pj,k = (mask {j,k}, pin, lineage Ljk): c's eval suspends on j's
  data → thenable cached (c, Ljk, 0); React abandons the joint set,
  renders Pk = (mask {k}, lineage Lk): separate worldKey AND lineage —
  c's k-eval doesn't suspend (j's data not included), value from k-fold;
  k commits (lock-in, fold of k only; j's entries stay live). j retries
  later under Lj' including retired k via pin. Same nodes, two live views,
  no shared cache confusion (worldKey separates values; lineage separates
  thenables). ✓
```
residual risk (family): union K1 edges over-notify across worlds (T5) — bounded by NM dedup; pinned by a per-batch setState-count assertion in the arena harness.
```

### C2 — flushSync excludes a pending default batch

`C2: a=0→1 in default batch D; flushSync render must see a=0 AND c=10.`

```
step | actor/mechanism | state touched
1 | event: a.set(1) | fork classifies → token D (default, urgent-class); tape(a)+={set 1,D,s1}; wc[D]=s1; base(a)=0; K0 newest a=1, native mark c (K0 edge a→c)
2 | notifyWalk(a,D) | F(a)=F(c)=1; watchers on a,c get setState in D's (event) context; NM |= D
3 | flushSync(setState) → sync pass S | fork F2: tokens exclude D (SyncLane only) → w=(mask{}∪lockedIn, pin=s1... mask has no D); currentWorld=w
4 | component reads a | F(a)=1 → fold: base 0; D's entry: slot D ∉ mask, retiredSeq=0 → invisible → a=0 ✓
5 | component reads c | F(c)=1 (step 2 walked the cone) → world eval: reads a via fold = 0 → c=10 ✓; M(c,w) stored; K1 a→c added
6 | later: D renders/commits | D's pass (mask {D}) folds a=1, c=11; retirement folds base(a)=1
outcome: flushSync frame shows (0,10) — both. The always-log receipt (step 1, I1) makes the older world reconstructible; the cone walk (step 2) flags c so it cannot be served from K0's canonical cache (11) — both C2 traps closed.
residual risk: a fast-path regression that serves unflagged-but-affected nodes — pinned by the C2 conformance test + invariant-F property test (random graphs, random writes, assert F on reachable cones).
```

### C3 — rebase parity

`C3: a=1; T:+1 then U:×2 must render 2 (urgent), commit 2, then T renders and commits 4.`

```
step | actor/mechanism | state touched
1 | T: a.update(+1) | tape(a)+={fn +1,T,s1}; wc[T]=s1; base=1; newest=2; walk delivers in T's lane
2 | U: a.update(×2) | tape(a)+={fn ×2,U,s2}; wc[U]=s2; newest=4; walk delivers in U's lane
3 | U render (mask{U},pin s2) | fold a: base 1; s1 invisible (T∉mask); s2 visible → 1×2 = 2 ✓
4 | U commits; fold | s2 retiredSeq=r1; base recompute: retired prefix = {s2}? s1 (unretired, smaller seq) blocks compaction; committed view = fold(base1 + visible retired s2) = 2 ✓ (base slot unchanged until s1 clears — visibility math serves committed correctly meanwhile)
5 | T render (mask{T},pin) | fold a: base 1; s1 (T∈mask) → 2; s2 (retired ≤ pin) → ×2 → 4 ✓ replay in write order (I2)
6 | T commits | s1 retired; compaction folds s1,s2 in seq order over base 1 → base=4; tapes empty; quiescence
outcome: 2, 2, 4, 4 — React's updater-queue arithmetic exactly (D3/I2); useReducer differential runs beside it. A plain `set 5` after pending `+1`: fold {set5} ignores accumulator → commits 5 ✓ (op semantics, §3.2).
residual risk: fold-order bug (mask-order instead of seq-order) — pinned by the randomized replay oracle (D6) and the C3 differential.
```

### C4 — two-batch write into an already-stale region

`C4: T1 writes a (W notified in T1); T2 writes a before any render; W must also be scheduled in T2's lane.`

```
step | actor/mechanism | state touched
1 | T1: a.set(..) | tape+={..,T1,s1}; walk: W setState in T1 context; NM(W)={T1}
2 | T2: a.set(..) | tape+={..,T2,s2}; walk runs FULL REACH again (no cross-walk marks §8.1); at W: NM bit T2 clear → setState in T2's context; NM(W)={T1,T2}
3 | T2 render | includes W (its lanes have W's update) ✓; T1 render likewise
outcome: per-(watcher,slot) dedup is exactly I5's required granularity; once-per-staleness marks (the trap) do not exist in this design.
residual risk: an optimization reintroducing cross-walk marks (§14 R1) — the C4 unit + I5 property test (N batches → N distinct-lane setStates) pin it.
```

### C5 — cutoff-suppressed first write, effective second write

`C5: k writes a (c value-unchanged), then k writes b=7; watcher must render c=7 in k's lane.`

```
step | actor/mechanism | state touched
1 | k: a.set(1) | tape(a)+={..,k,s1}; wc[k]=s1; newest c unchanged (K0 equality skips K0 marks); notifyWalk runs UNCONDITIONALLY (§3.1): W setState in k's lane; NM(W)={k}
2 | k render; W re-arms, reads c | M(c,wk) = {b-based value, seq=s1}; W.lastRendered set; NM(W)={}
3 | k: b.set(7) | tape(b)+={set7,k,s2}; wc[k]=s2; walk from b: K0/K1 b→c → W: bit k clear → setState in k's lane ✓
4 | k re-render | M(c,·) invalid (wc[k]=s2 > s1) → re-eval → 7 ✓
outcome: second write reaches the watcher in k's lane; cache cannot serve the first evaluation (write clocks are per-slot, not per-value). Note: this design never suppresses delivery at write time (§8.3) — step 1 delivers; the case's required property holds a fortiori, and if steps run before any render (NM still {k} at step 3) the dedup skip is safe because W's scheduled k-render pulls through the invalidated memo (reach induction case (a)).
residual risk: adding write-time value cutoffs later (notifyCutoff knob) must keep the clock bump unconditional — pinned by C5 unit with the knob on.
```

### C6 — lane attribution under grouped notification

`C6: batch(() => { a.set(1); startTransition(() => b.set(2)) }) — each write's cone must render in its own batch's lanes.`

Resolution: **Handle it.** There is no grouped drain to mis-attribute:
delivery is synchronous per write (§8.1).

```
step | actor/mechanism | state touched
1 | batch() opens | engine batch = core-effect flush deferral ONLY (documented); watcher delivery unaffected
2 | a.set(1) | classified by fork: current event's urgent token Ua; walk delivers a's cone setStates NOW, in the urgent context → urgent lanes
3 | startTransition(() => b.set(2)) | inside the scope, fork classifies token Tb (deferred); walk delivers b's cone setStates NOW, inside the transition → transition lanes; one commit carries Tb's cone (React's own batching)
4 | batch() closes | core effects flush (NEWEST contract §9.5); no watcher work remains
outcome: a's cone urgent, b's cone transition — each write's batch context preserved because delivery happens in the writer's stack (D5). Implicit grouping: none exists — the engine never coalesces broadcasts across writes in React mode (stated per the case's preamble demand).
residual risk: someone "optimizing" delivery into a deferred drain — the C6 unit (two lanes asserted via fork probe) pins it.
```

### C7 — writes and reads during a yielded render pass

`C7: transition pass yields; click handler reads a, writes a; resumed pass keeps its pinned world.`

```
step | actor/mechanism | state touched
1 | pass P (mask{T}, pin p, lineage L) starts | currentWorld=wT (fork F2 onPassStart)
2 | scheduler yields | fork F2 onPassYield → currentWorld=NEWEST; getCurrentPassId()=0
3 | click handler: a.state | read §4.2: NEWEST → k0.pull → newest value (not the pin) ✓
4 | click handler: a.set(x) | not a render world → no throw ✓; fork classifies under the click's sync token C; tape+={..,C,sc}; wc[C]=sc; walk delivers in click context (urgent)
5 | click batch renders+commits synchronously | retirement fold of C; epoch++; BUT compaction blocked: C's entries have retiredSeq r > nothing… pin p of live pass P < sc ⇒ pin+retention (§3.3.3) keeps C's entries on tape
6 | pass P resumes | fork onPassResume → currentWorld=wT (same mask, same pin p)
7 | P reads a | fold: base + entries: C's entry has retiredSeq=r; visible iff r ≤ p — false (r minted after p) → excluded → P sees its original world ✓; memos: epoch bumped at step 5 → re-validate lazily → folds under pin reproduce identical values (waste bounded, correctness unaffected)
outcome: handler reads newest, write classified+logged under the click's batch, resumed pass world unchanged. The per-callstack flip (fork F2) is what makes steps 2–4 sound — no [passStart,passEnd] scalar exists (S7).
residual risk: fork flip-site drift on rebase — fork test 5 pins it; retention-rule bug — C7 unit asserts pre-click values after resume.
```

### C8 — equality drops must not lose receipts

`C8: T: a.set(1); U: a.set(1) equal to newest — U's render (excluding T) must show 1; T truncation is N/A (no truncation surface).`

```
step | actor/mechanism | state touched
1 | T: a.set(1) | tape+={set1,T,s1}; newest=1
2 | U: a.set(1) | LOGGED mode has no write-time equality drop (§3.1): tape+={set1,U,s2}; wc[U]=s2; K0 newest 1→1 (K0 marks skipped — newest cone truly unchanged); walk still runs (worlds excluding T changed: 0→1)
3 | U render (mask{U}) | fold a: base 0 + s2 → 1 ✓
4 | overlapping transitions T1,T2 both set 1 | two receipts; each world folds its own subset; committed folds both (idempotent sets) ✓
outcome: U's world has its write; I7's rule is enforced in the strongest form (never drop while LOGGED; DIRECT keeps donor equality-skip where history cannot exist).
residual risk: a "tape coalescing" optimization violating I7 — O10 declined (§15); C8 unit pins.
```

### C9 — mount mid-transition (existing and fresh nodes)

`C9: while k renders, a component mounts reading (a) existing computed, (b) freshly created useComputed — both must see k's world on first render.`

```
step | actor/mechanism | state touched
(a)1 | mount render inside pass Pk | currentWorld=wk; read c → F(c) set (k's earlier writes walked its cone) → world memo/eval in wk ✓ first render correct
(a)2 | if F(c)=0 | then no logged write reaches c (invariant F §4.3) ⇒ k-value = newest value ⇒ k0.pull correct ✓ (no canonical leak by construction)
(b)1 | fresh node n created during Pk | no K0 value, no edges; §9.1: first evaluation is eager world-routed in wk: reads fold/route per §4.2; K1 edges recorded; M(n,wk) stored
(b)2 | watcher registration deferred to commit effect | discarded/replayed pass (C14) leaves only an unregistered node + add-only K1 edges (over-notify at worst)
(b)3 | post-mount k-write to n's dep | walk reaches n via its K1 edges → its watcher (registered at commit) delivered in k's lane
outcome: both reads resolve in the pass's world on first render — (a) by routing+flag invariant, (b) by eager world-routing (the fresh-node mechanism the case demands stated: evaluate world-first, register at commit).
residual risk: fresh-node K0 backfill (first NEWEST read later) must not clobber world memos — they are separate stores; pinned by C9 unit + StrictMode variant.
```

### C10 — late subscription joins the pending batch

`C10: k writes a; component mounts (urgent) after the write, before k commits; k's world differs from its render.`

```
step | actor/mechanism | state touched
1 | k: a.set(1) | receipts; watchers-so-far notified in k's lane
2 | urgent mount render | world = committed(root) (k excluded): renders a=0-derived value; subscribes watcher W' in layout... render first: no watcher yet
3 | layout effect fixup §9.2 | for each live token t∈{k}: read(node) in world(k∪lockedIn) = 1 ≠ rendered 0 → fork.runInBatch(k, setState(W'))
4 | React renders k | W' included (its update is in k's lanes) → reads wk → 1; ONE commit carries k's updates + correction ✓
5 | race: k retired between 2 and 3 | runInBatch returns false → urgent setState pre-paint (layout timing) → correction commits before paint ✓
outcome: exactly one commit; fresh startTransition rejected because new lanes ⇒ separate commit ⇒ a frame where siblings show k and W' shows stale (why stated, per the case).
residual risk: fork F4 entanglement semantics on rebase — fork test 7; fixup cost (≤31 comparisons) gated in G-P1 mount bench.
```

### C11 — multiple roots (declared scope: FULL spanning support)

`C11: batch k spans roots A and B; A commits k while B is pending; A must keep including k; k retires once.`

```
step | actor/mechanism | state touched
1 | k writes atoms read by components in A and B | receipts slot k; walks deliver watchers on both roots in k's lane
2 | A's k-render commits | fork F3 onBatchCommittedOnRoot(k, A) → lockedIn(A) |= k; k NOT retired (B pending)
3 | urgent render on A | pass world = (mask{U} ∪ lockedIn(A) ∋ k, pin) → folds include k's entries → A never contradicts its committed DOM ✓
4 | A's passive effects flush | world(committed-for-A) = lockedIn(A) ∋ k → observe k's values ✓ though token live
5 | urgent render on B | lockedIn(B) ∌ k → excludes k ✓ B self-consistent with its own DOM
6 | B's k-render commits | lock-in B; last root → fork F3 onBatchRetired(k, committed=true) → single fold, exactly once (registry refcount)
7 | store-only atoms (no B work) | B never renders k? then React's own root scheduling retires k after A (fork counts involved roots by scheduled work) — retire fires once either way
outcome: per-root lock-in masks (O7: table lives in the bindings' root registry; consumed by pass-world derivation §4.1 and effect flush §9.3) replace any single global "committed" — the case's trap. Cross-root skew (A shows k, B not yet) is React's own commit ordering, permitted.
residual risk: fork emits lock-in after paint or before effects — ordering pinned by fork test 3; registry refcount vs portals — portal = same root, test included.
```

### C12 — store-only transitions persist

```
step | actor/mechanism | state touched
1 | startTransition(() => a.set(5)), no subscribers | LOGGED since bridge registration (monotonic, S6): tape+={set5,k,s1}; walk finds no watchers (fine)
2 | React sees no work; batch closes | fork F3 onBatchRetired(k, committed=false) → FOLD anyway (D2): base=5 ✓
3 | async action: startTransition(async () => { a.set(1); await io(); a.set(2) }) | receipts under one token k' (fork keeps the async scope's token across the await — React's own async-action entanglement); retirement PARKED until settle (F3)
4 | io resolves; action settles | onBatchRetired(k') → fold in seq order → 2 ✓ and not before (no retirement event existed earlier)
outcome: persistence never depends on subscription (D2; S4's scar closed at the policy level — the fold branch has no watcher predicate).
residual risk: fork async-action parking on rebase — fork test 2 pins.
```

### C13 — counter/world-id lifecycle soundness

Walked as the inventory table in §11 — every counter, retainer, reset,
guard, plus forced-wrap tests. The episode-reset schedule: drive to
quiescence (§3.4), start a new episode, force `globalSeq` reset small and
slot serials to collide: stale memos are unreachable (epoch in worldKey),
stale K1 column entries fail the episodeEpoch tag (§6.4), stale NM bits
were cleared at slot recycle (I10 gate), tape seqs from the old episode do
not exist (tapes empty at quiescence by definition).
`outcome:` no cross-episode validation is possible without passing an
epoch/generation check that the reset bumped (I8 discharged per structure).
`residual risk:` a NEW structure added later that caches seq without an
epoch — the C13 checklist ("every counter row must name its guard") is a
review gate in the inherited process (D6).

### C14 — StrictMode and replayed renders

```
step | actor/mechanism | state touched
1 | render-phase write attempted | currentWorld is a render world → throw (§3.1) — per-callstack, so a yield-gap handler write does NOT throw (C7) ✓
2 | pass replayed (double render) | same worldKey+lineage → world evals recompute identical memos (purity R2); thenables: (node, lineage, position) identical → same identity ✓ no re-suspension loop
3 | pass discarded | leaves: add-only K1 edges (over-notify only), unregistered fresh nodes (GC via lineage drop), NM bits cleared early at re-arm (over-delivery only) — no value, tape, or clock was touched by rendering ⇒ no observable graph mutation ✓
4 | double mount/unmount | watcher attach/detach microtask-debounced; R1 observed-effect 0→1→0→1 nets to one run (flap-proof) ✓
outcome: purity holds because renders only read folds/memos and append idempotent cache entries; every render-side mutation is either keyed by (worldKey|lineage) (idempotent) or monotone-and-harmless (K1 edges, flags).
residual risk: a memo store keyed without lineage for fresh nodes — C14 double-render test with forced discard pins.
```

### C15 — suspense across worlds

```
step | actor/mechanism | state touched
1 | k makes c suspend | k-pass Pk (lineage Lk): world eval of c calls ctx.use(thenable) → cache[(c,Lk,0)] = th; M(c,wk) = suspension sentinel; React suspends via `use` protocol on th
2 | component mounts mid-transition reading c | same pass/lineage → same sentinel/thenable identity → mounts suspended on the SAME th ✓ (the react-concurrent-store known bug becomes a passing test: no divergent thenable identities between existing and fresh readers)
3 | canonical world reads c meanwhile | NEWEST eval: K0 caches its own sentinel or value; lineage cache never consulted (§7.4) → canonical never observes k's suspension ✓
4 | th settles; React retries | new pass, SAME lineage Lk (fork F5: restart within batch-set) → cache hit → settled value → M(c,wk') evaluates through it → render completes
5 | k commits | fold; lineage Lk dropped → thenable cache freed
outcome: the world key for thenables is the fork's render-lineage id — stable across restarts/replays of one batch-set, distinct across batch-set changes (T7), dead at commit. A pass with multiple batches shares one lineage (key = the SET, not a token); passSerial-forever-refetch and single-token under-keying both excluded by construction (F5).
residual risk: lineage lifetime drift on rebase — fork test 6; positional index stability under conditional use() — R2's positional contract tested per world.
```

### C16 — effects observe committed state only

```
step | actor/mechanism | state touched
1 | default batch D: a.set(1) applied, not committed | tape entry slot D; newest=1; base=0
2 | unrelated batch j retires → effect flush for root R | useSignalEffect reads in world(committed-for-R): D unretired ∧ D ∉ lockedIn(R) → fold excludes → effect sees a=0 ✓
3 | D commits | retirement fold: base(a)=1; effect dep versions compare (a's committed version moved) → effect re-runs seeing 1 ✓
4 | core effect() | documented NEWEST contract (§9.5): saw 1 at step 1's flush — stated, walked, and conformance-tested as the core/React divergence
outcome: matches Required; the committed world is a first-class world (same fold math), not a special code path.
residual risk: effect flush using a stale lockedIn snapshot — C11/C16 cross test pins.
```

### C17 — optimistic rollback

Not exposed. This design has **no truncation surface**: batches fold on
retirement (committed or not, D2); React batches never truncate; optimistic
UI composes from ReducerAtom actions whose *fold* interprets server
reconciliation (R3), not from receipt deletion. Surface deleted per the
case's instruction; nothing else in the design depends on truncation.

## 14. Rejected variants and known gaps (nothing hidden)

Rejected, with reasons kept:

- **R1: cross-walk notification marks (per-slot dirty masks with
  mark-stop).** Rejected for round 1: with add-only K1 edges, the mark-stop
  invariant "marked ⇒ downstream marked" breaks at every later edge-add,
  and repairing it needs edge-add downward propagation plus render-coherent
  per-slot clearing — two coherence obligations bought to optimize repeated
  writes into one cone. Comes back only if SPK-N1 fails its gate; the
  fallback spec (propagate-on-edge-add with stop-on-subsumption; clear a
  slot's marks only at that slot's render re-arm) is written here so the
  gate failure has a plan, not a scramble.
- **R2: per-read certificates for memo validity.** Write clocks + direct-dep
  versions dominate: S5-immune, no completeness obligation (O9 answered).
- **R3: full host-protocol K0.** Not needed for the architecture (§12.4);
  revisit as a code-dedup refactor only if SP1 says it's free.
- **R4: write-time watcher cutoffs.** The measured-expensive shape; §8.3.
- **R5: React-owned atom queues (O4).** Out of stance; noted as the
  neighboring bet. This design's answer to its motivating question (who
  reimplements lane filtering?) is: nobody — the tape+visibility math IS
  the reimplementation, ~60 lines, oracle-tested against useReducer.

Known gaps (declared):

- **G1 (perf, not correctness):** repeated high-fan-out writes re-walk
  their cone per write (SPK-N1 gates; R1 fallback specced).
- **G2:** held-open-transition read bursts re-validate the flagged region
  per write burst (SPK-G8 gates; §12.3 escape hatch specced).
- **G3:** union K1 edges over-notify across concurrent batches (T5 walk) —
  bounded to one spurious re-render per (watcher, batch); accepted, gated
  by the setState-count assertion in G-N.
- **G4:** the fork's per-root lock-in + async parking exist in the
  previous-generation fork's registry [mechanism-library "registry edges…
  proven"], but THIS protocol's exact event ordering must be re-proven by
  fork tests 2/3 on the current React base before the C11/C12 walks count
  as implemented — flagged, not assumed.
- **G5:** dev-validator cost for E-PRESERVE unknown until SP2; sampling
  fallback stated (§6.3).

## 15. OPEN.md answers touched by this stance

- **O1:** answered — per-world dependency knowledge lives in K1 as real
  edges; values in memos validated by clocks; the compensated-single-kernel
  is this design's explicit fallback if K1 costs disqualify (the walk
  structure and delivery dedup survive that swap unchanged).
- **O2:** §12.4 — no hot-path host protocol; two per-recompute hooks;
  SPK-H; both SP1 outcomes have plans.
- **O3:** §6.3 — the sync obligation is ONE site (beforeRetrack) with
  invariant E-PRESERVE; SP2 measures the brute-force validator; sampling
  fallback.
- **O5:** both: F2 edges maintain engine state; the query
  (`getCurrentPassId`) is one flag the fork flips at work-loop boundaries;
  reads/writes pay one engine-local load, zero fork calls (§7.3).
- **O6:** per-write synchronous delivery (no drain); C6 handled by
  construction; fan-out cost gated (G-N), knob for cutoff evaluation §8.3.
- **O7:** per-root lock-in table lives in the bindings' root registry,
  consumed by pass-world derivation (§4.1), effect flush (§9.3), and C10
  fixup worlds (§9.2).
- **O8:** fork-provided lineage id; lifetime = one (root, batch-set) from
  first pass to commit/abandon, stable across restarts (F5, C15 walk).
- **O9:** per-slot write clocks + direct-dep version ladder; no per-read
  certificates (§7.2); held-open reads priced §12.3.
- **O10:** coalescing declined — with always-log and cheap folds the win is
  a shorter tape, but legality (no open pass; no smaller-seq foreign entry;
  I7) buys three preconditions for one array-shortening: not worth a
  mechanism slot. Compaction at retirement covers tape growth.

## 16. Mechanism inventory (numbered; the concurrency story's moving parts)

1. **K0** — donor arena kernel (closed, monomorphic) + LOGGED closure
   rebuild with two null-checked per-recompute hooks (§5).
2. **Tape + base + globalSeq** — always-log receipts; visibility math;
   seq-order folds (§3).
3. **Slots/masks/pins + per-root lock-in** — batch bookkeeping over fork
   tokens (§2, §4.1, C11).
4. **Per-slot write clocks + epochs** — world-memo/fold validity, sound
   core (§7.2).
5. **World memos + dep-version ladder + lineage thenable caches** —
   per-world values and suspense identity (§7).
6. **K1 shadow plane + retire-into-shadow + worldSensitive column** — real
   pending topology, edge preservation, read routing (§6, §4.3).
7. **Notification walk** — per-write full reach over K0∪K1, writer-context
   setState, per-(watcher, slot) dedup with render re-arm (§8).
8. **Watcher records + C10 layout fixup + reconcile backstop** (§9).
9. **Fork protocol** — 7 facts F1–F7 (§10).
10. **Episode lifecycle** — retirement folds/compaction with pin retention,
    quiescence reset, counter guards (§3.3–3.4, §11).

## 17. Test plan (beyond the inherited apparatus, D6)

Inherited wholesale: randomized replay oracle FIRST (fold math vs a
brute-force multi-world interpreter, plus useReducer differential),
frozen-kernel contract suite, bytecode budgets CI, invisibility tests
(whole 179-suite inside a synthetic episode), react-concurrent-store's 14
scenarios, pre-registered spikes (§12.5). Added, specific to this design:

- Invariant-F property test: random graphs/writes/evals; assert every
  node reachable from a taped atom is flagged (§4.3).
- Basis-edge completeness fuzz: random K0 re-tracks while forked; assert
  E-PRESERVE mirrored sets (dev validator, SP2's subject).
- Notify-rearm property: random write/render interleavings; assert
  per-(watcher, batch) delivery exactly-once-per-render-cycle (I5/C4/C5).
- Walk-reach differential: every logged write, compare walk's reached
  watcher set against brute-force "whose world value could change" oracle
  (over-reach allowed, under-reach fatal — the §8.2 induction, executable).
- Episode collision battery: forced small counters, slot reuse, K1 id
  reuse (C13; T6).
- Fork suite: the 10 tests of §10, run on every rebase.

Line count target respected; density over bulk.
