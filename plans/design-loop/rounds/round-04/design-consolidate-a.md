# Round 4 — consolidate-a: the two-kernel champion, consolidated

Stance: inherit the round-3 champion (`rounds/round-03/synthesis.md`, D12
amendment) under the round-4 hard constraint: **no new mechanisms**. Every
repair below either reuses machinery the champion already ships or deletes
machinery. This document is self-contained: it restates the whole design
(the champion incorporated its base by reference; this text does not), then
walks the full battery. Architecture class is unchanged (D8/D12): donor
kernel K0 + receipt tape + world-edge plane K1 + clocks/stamps + value-blind
delivery + co-designed fork.

---

## 0. Consolidation ledger (what this round changed, and in which direction)

The judge's round-3 mechanisms score fell to 5 on accretion, with two
confirmed blockers minted by the round's own repairs. Both blockers are
closed here **by deletion or merge**, not by addition. The full ledger —
every row cites the section that carries the proof:

| # | action | what | where |
|---|---|---|---|
| L1 | **DELETE + MERGE** | The standalone `WORLD_TAINT` per-node column and its routing conjunct are deleted. Taint becomes **bit 31 of the existing `touched` word** and rides the existing mark-propagation walks (write walk, edge-add propagation) plus the existing re-track dep sweep. This *is* the repair for judge blocker 1 (taint failed to propagate through tracked serves): propagation now comes from machinery that already propagates. Fast path drops from 5 conjuncts to 4. | §6.2, §7.2, walk C1-X3 |
| L2 | **DELETE** | The mount-fixup suppression predicate ("committed compare is suppressed when every live touched slot passed the inclusion check") is deleted — it contradicted its own retire-race walk (vacuous universal ⇒ suppress, while the walk required fire). Replaced by **one world, one compare**: evaluate n in the *fast-forwarded rendered world* `w_fx`; inequality fires. No boolean about loop outcomes exists to contradict anything. Judge blocker 2. | §11.2, walks C9/C10 |
| L3 | **MERGE** | The memo ladder's evaluator-stamp vector, the suspense prefix's `(computedId, stamp)` pairs, and (new domain, closing an I35 hole this round found) **reducer stamps** become ONE structure — the flattened evaluator vector, `effStamp = staged-in-this-pass else committed` — with one validity rule and one audit row. `reducerStamp` leaves the atom fingerprint (it lived in two places). | §8.2, §9.2, walk C15 |
| L4 | **RULE FIX (no state change)** | Evaluator staging compares **committed-first**: equal-to-committed deps never stage, never mint. Kills the lineage-stamp oscillation the docket predicted (deps A→B→A minted a fresh stamp for committed-identical state). A stage now exists iff deps ≠ committed's. | §11.1, walk C14 |
| L5 | **RE-SCOPE (shrink)** | Scheduler shims cover registration-time APIs only (timeout/interval/microtask/rAF/idle). The champion's `MessagePort.postMessage` shim is shown to be a **no-op under its own rule** (ports register handlers at boot, token null ⇒ never wrapped), so it is removed from the shim list and the class is documented boundary — **rung-uniform**: AsyncContext's event semantics (registration snapshot) has the identical boundary. | §12.1, walk C12-T |
| L6 | **REPURPOSE + MERGE** | `lastRetireSeq` (champion R8, minted-but-observed-by-nobody: "available to diagnostics") becomes **`committedAdvanceSeq`** — one counter minted at every committed-side truth advance (retirement fold, lock view re-mint, F9 promotion). It is a conservative *no-op detector* (fast-outs for mount fixup and effect pre-filter), **never a validity key** (S20 compliance argued in place). Three would-be checks become one compare. | §5.3, §11.2 |
| L7 | **PROVE, don't add** | Walk reentrancy (docket attack on walkGen): proven impossible — **walk atomicity**: value-blind walks dispatch no user code; fold-frame guards (I28) cover reducer/equality callbacks; effects flush after walks return. One dev assert; zero reentrancy machinery. | §10.2 |
| L8 | **UNIFY** | Promotion re-fold delivery is not a special path: it is the existing fold + reconcile-check + notification-walk + effect-flush machinery run in the committing context. | §11.1 step P3 |
| L9 | **COUNT** | Mechanism inventory 10 → **9**, by counting structures (with state and lifecycle) rather than algorithms over them: the notification walk's only state (`walkGen`, `lastWalk`, dedup bits) lives on planes already counted. The delta is itemized so the judge can audit rather than suspect gaming. | §3 |

Docket coverage map (every round-4 docket line → resolution):

| docket attack | resolution | proof site |
|---|---|---|
| taint through tracked serves (judge blocker, I33/I17) | L1 merge; propagation via existing walks + dep sweep | §6.2, §7.2, C1-X3 |
| taint set/clear races across yield gaps | compaction is pin-gated ⇒ a clear can never strand a live pin; evals are stack-atomic | §6.3, C1-X3 rows 6–8 |
| DIRECT→LOGGED transition caches | base case of TAINT-COMPLETE: pre-LOGGED caches embed committed-only state; `registerReactBridge` throws mid-evaluation | §6.3, §4 |
| walkGen reentrancy (I32) | L7 atomicity proof; wrap row kept | §10.2, C13 row 6 |
| lock-view re-mint vs yielded same-root passes (I34) | fork fact F2 serializes same-root advances with same-root passes (a same-root commit kills the WIP pass — React discards, never resumes across its own commit); cross-root advances shown irrelevant to a captured view | §5.2, §14 F2, C11-A row Y |
| lockTerm fp cost | computed inside the fold that already walks entries — O(entries), not O(31); priced in G-E ledger | §8.1, §16 |
| lineage stamp oscillation (I40) | L4 committed-first ordering | §11.1, C14 |
| cross-lineage stamp reuse | per-(lineage × hookNode) cache; dies at lineage death; renumber row | §11.1, C13 row 8 |
| revalidation through staged evaluators (I35) | L3: reducer effStamps in prefix positions; re-fold uses the pass's effective reducer | §9.2, C15 row 5‴ |
| deep-prefix fold cost | O21/SPK-G8 (whole-mask clock vector fallback stands) | §16, §19 |
| F9 ordering: multi-root commits, pending receipts both sides (I38/I41) | commits are wall-clock serialized; promotion is global-committed state; per-commit F9→folds→layout ordering; walked | C3-M |
| promotion during saturation | force-clear moves bits, never entries/values; promotion walk uses edges, not slot bits | C3-M row 6 |
| shim liveness races, nested registrations (I36/I37) | liveness consulted per continuation entry; single-threaded extent; nested registration inherits pushed token | C12-T rows 6–8 |
| MessageChannel | L5: shown out-of-class under the champion's own rule; documented boundary, rung-uniform | §12.1 |
| saturation force-clear during an open walk (I39) | impossible by L7 atomicity (no write can occur inside a walk) | §10.2, C1-X5 row 5 |
| fastPathDisabled vs RENDER_NEWEST | RENDER_NEWEST reads K0 = newest-applied, unaffected by visibility bookkeeping; new passes pin ≥ clear time; mask-holding yielded passes disarmed by the pin | C1-X5 rows 6–8 |
| mount-fixup skip rule (judge blocker, I43) | L2: w_fx single compare; per-token loop stays value-blind | §11.2, C9/C10 |

---

## 1. One page: the concurrency story that ships

**The bet (unchanged, D8/D12).** The fastest known single-world kernel —
the donor arena kernel, alien-signals v3 semantics on one Int32Array plane
[ARENA] — stays byte-for-byte for the common case. Concurrency lives
*beside* it: a per-atom **receipt tape** for values, a second edge plane
**K1** for per-world topology. A build with no React bridge (DIRECT)
executes zero concurrency instructions (D1, P3); registering the bridge
swaps the op table to LOGGED once, monotonically.

**One value truth plus receipts.** Every LOGGED write appends a receipt
{op, batch slot, seq} to its atom's tape and applies to K0 with stepwise
equality. A *world* — what one render pass may observe — is a fold: base
value + visible receipts replayed in write order (I2). Visibility is
React's lane math verbatim (D3): a receipt is visible if its batch retired,
or is in my pass's include-mask up to my pin, or is locked into my root up
to that slot's watermark. Lock state is captured per pass as an **immutable
per-root lock view**; every lock-in and every watermark advance re-mints
the view and stamps the slot (I34). Retirement stamps touched atoms
(retireVisStamp, I21). All stamps and pins share one monotone counter
(I15). One number — `committedAdvanceSeq` — moves at every committed-side
advance (retirement, lock re-mint, promotion) so cheap fast-outs can prove
"nothing moved" without consulting anything precise.

**Reads route by one word.** A non-newest world may serve K0's cached
answer only when the node's **touched word is zero** (no live batch's cone
reached it through any edge — and no *taint*: bit 31 marks caches that
embed pending state acquired through untracked reads, propagated
downstream by the same walks that propagate slot bits), the cache needs no
recompute, the pass holds no **staged evaluator** for it, and the pass has
not been flipped to world-path-only by slot saturation. Everything else
folds atoms and evaluates computeds into per-(node, worldKey) memos whose
real dependencies land in K1. Memo validity is a closed enumeration (I16):
slot write clocks, retirement/lock stamps, the **flattened evaluator
vector** (computed fns and reducers, staged-else-committed), thenable
settlement, world identity, episode epochs.

**Evaluators are world-scoped state (I22).** A hook's fn/deps/reducer stages
per pass — only when deps differ from the committed evaluator — with
**lineage-stable stamps** (equal deps reuse the stamp, so suspense retries
compare equal, I40). The fork's **F9** emits when the staging hook *becomes
current* (hidden Offscreen included, error-abandoned excluded, stale
alternates CAS-rejected), before that commit's retirement folds and layout
effects (I41/I38c). Promotion installs the staged stamp, dirties the K0
node, and — for reducers with pending receipts — re-folds NEWEST under the
new reducer and notifies through the ordinary fold/reconcile/walk path.

**Notification is per-write, in the writer's stack, value-blind (D5/D10/
D13)**, over K0∪K1 with a per-walk visited generation (unions of per-world
acyclic graphs can cycle, I32). Walks dispatch no user code — that is a
proved property, so walks cannot nest. Per-(watcher, slot) dedup re-arms at
render (I5/C4). New edges propagate touched bits through existing out-edges
and retroactively deliver still-live slots through the new path (I23).
Mount fixup schedules value-blind into every live non-included touched
token (I13), then compares the mount's rendered value against **its own
world fast-forwarded** (`w_fx`: retired-and-locked visibility at now, the
pass's mask at its pin) — inequality is by construction attributable to
committed-side changes the render missed, so firing is always right and
C9 mounts never double-render (I43).

**Suspense** keys thenables by fork lineage (D11) and validates by content:
the flattened prefix of (atom fp + reducer effStamp + value) and (computed,
effStamp) positions; on a stamp move it re-folds and compares *value*
before refetching (I35) — content-neutral flips keep the settled resource.

**Async actions**: parking (retirement waits for the returned thenable) +
continuation identity (the measured twin-build carrier, I30; AsyncContext
when the host ships it; armed registration-time shims on enumerated
schedulers, I36). A carrier token consulted after retirement degrades to
ambient + dev warn (I37). Uncompiled vendor code writing post-await
misattributes to its ambient batch — sound, bounded, dev-warned,
boot-tested, support-matrixed (D17); ActionScope is the precise escape.

**Lifecycle.** Retirement folds only the prefix every live pin sees;
touched slots are retained until swept (I10/I39); saturation force-clears
the oldest fully-retired slot and flips excluded pinned passes to
world-path-only. Quiescence refreshes K1-touched committed-observed nodes
into K0 before K1 resets; twice-writing targets are exempted with their
full reverse-reachable cone carried (I42). Every counter reset pairs with
an epoch/generation guard (I8/I19/C13).

**Numbers.** DIRECT = donor ([ARENA]: deep 0.90×, broad 0.84–0.88×,
diamond 0.89×). LOGGED-quiet floor 2.4–3.8% [SPKHQ→O19] vs the ≤2% gate —
pre-registered renegotiation. Carrier ≈0% unarmed, +12 ns/await armed
(I30). Host-protocol boundary free, storage move 5–12% (I11) — values stay
in-plane. Everything else unmeasured is a named spike (§16).

## 2. Concepts (plain English, defined before use)

- **K0** — the canonical kernel: the donor arena (one Int32Array plane,
  interleaved node+link records, iterative walks). Holds every node's
  *newest-applied* value and the newest-basis dependency edges. Closed and
  monomorphic (D4); identical bytes in DIRECT and LOGGED builds except the
  swapped op table.
- **DIRECT / LOGGED** — the two op tables. DIRECT: donor behavior, zero
  concurrency instructions. LOGGED: writes leave receipts, reads consult
  routing. Swap happens once, at `registerReactBridge()` (monotonic, D1).
- **receipt / tape** — {op, slot, seq} appended per LOGGED write to the
  written atom's per-atom log. `op` is the set value or updater/action.
- **base / baseSeq** — the folded floor of a tape: retired receipts that
  every live pin sees get compacted into base.
- **seq / globalSeq** — one process-wide monotone counter; write seqs,
  pins, stamps, and epochs are all minted from it (I15).
- **batch / token / slot** — a batch is React's unit of work (one event or
  transition); the fork mints an integer token per batch (never reused
  live); ≤31 live tokens (I10) intern into 5-bit **slots**; a pass's
  include-set is a 32-bit **mask** of slots.
- **pin** — the globalSeq value frozen at pass start; the pass observes
  mask-writes only up to its pin.
- **world / worldKey** — one consistent assignment of values: NEWEST (K0),
  a pass world (mask, pin, lock view, epoch), or committed-for-root(r)
  (retired ∪ locked-into-r). The tuple is the memo key.
- **lock view** — immutable pooled record per root: `{slot, slotGen,
  watermark, lockStamp}[≤31]` plus `lockViewId`; re-minted at every
  lock-in and watermark advance (I34). A pass captures its root's view at
  start and keeps it.
- **watermark** — per (root, slot): the highest seq of that slot's writes
  committed into that root (I25 — lock-in is a write-prefix, not token
  membership).
- **wc[s] (slot write clock)** — bumped on every write in slot s (D9).
- **touched(n)** — one int32 per node: bits 0–30 = "slot s's cone reached
  n through a recorded edge"; **bit 31 = TAINT** = "n's K0 cache may embed
  pending state acquired through an untracked read" (§6.2). The fast path
  is exactly `touched(n) == 0 ∧ …`.
- **touchedList[s]** — per-slot list of nodes/effects whose touched word
  gained bit s; the durable enumeration for retirement/lock flushes (I34).
- **CT(n)** — "clean, no recompute needed": donor K0 status says the cache
  is current on the newest basis.
- **taint (bit 31)** — see touched; full rules §6.2.
- **K1** — the world-edge plane: real dependency edges recorded by world
  evaluations (and E-PRESERVE mirrors), add-only to quiescence.
- **E-PRESERVE** — strong reading (champion R10): every edge a K0 re-track
  removes while any live receipt exists anywhere is mirrored into K1.
- **world memo M(n, worldKey)** — cached world evaluation with its
  recorded deps, seq, fingerprints, and evaluator vector.
- **fp(a, w)** — per-atom fingerprint: `max(newest w-visible entry seq,
  baseSeq, retireVisStamp(a), lockTerm(a, w))`. (Reducer identity moved to
  the evaluator vector — L3.)
- **retireVisStamp(a)** — stamp minted at every retirement fold touching a
  (I21).
- **lockStamp / lockTerm** — lockStamp(root, slot) minted at first lock-in
  and every advance; lockTerm(a, w) = max lockStamp over w's lock-view
  slots holding a w-visible entry of a (computed during the fold).
- **evaluator / effStamp / evaluator vector** — an evaluator is a computed
  fn or a reducer. effStamp(e, pass) = the stamp staged in this pass for e,
  else the committed stamp. The vector is the flattened
  [(evaluatorId, effStamp)] traversed by an evaluation (memos and suspense
  prefixes record it; §8.2).
- **staging / lineage stage cache / F9 / promotion** — §11.1. A **lineage**
  is the fork-minted render-lineage identity (per root × batch-set, stable
  across restarts/replays — D11, fork F5).
- **committedAdvanceSeq** — L6: one counter bumped at retirement folds,
  lock view re-mints, and promotions; fast-outs only, never validity.
- **walkGen / lastWalk** — per-walk visited generation and its per-record
  column (I32).
- **fastPathDisabled(pass)** — saturation spillover flag (I39): the pass
  routes every read through the world path.
- **watcher** — a mounted component's subscription record: node, setState,
  lastRendered value, rendered-world snapshot (mask, pin, lockViewId),
  per-slot dedup bits.
- **RENDER_NEWEST** — a pass classification: no live divergence can reach
  this pass (its world ≡ NEWEST), so reads serve K0 directly; revoked
  (demoted to real mask/pin) by the first receipt-creating write or the
  first staged evaluator (S23).
- **carrier / parking / ActionScope** — async-action identity and lifetime
  (§12); rungs: AsyncContext (1) / twin-build transform + shims (2) /
  explicit AsyncLocalStorage opt-in (2b).
- **episode / epoch** — quiescence-to-quiescence span; epochs guard every
  counter reset (I8, C13).
- **core effect / useSignalEffect** — core `effect()` observes NEWEST
  (documented); `useSignalEffect` observes committed-for-root only (C16).

## 3. Mechanism inventory (9)

Counted as structures with state and lifecycle; algorithms over an already
counted structure are listed under it, not separately. Champion delta in
brackets (10 → 9; L9).

1. **K0 donor kernel** — twin builds, closed, monomorphic, CI bytecode
   budgets. [unchanged]
2. **Receipt tape + fold semantics** — per-atom tapes, base/baseSeq, one
   globalSeq line, visibility math, stepwise-equality folds (I29),
   watermarked lock clauses, compaction predicate, world-invariant-op drop
   rule (I38a), retireVisStamp, committedAdvanceSeq. [absorbs the dangling
   lastRetireSeq as committedAdvanceSeq — L6]
3. **Token/slot/mask/pin bookkeeping + immutable per-root lock views** —
   interning, unswept retention gate (I10), saturation force-clear +
   fastPathDisabled (I39), lock views with lockStamps/watermarks (I34).
   [unchanged]
4. **K1 world-edge plane + touched bits + the walks over them** — real
   world edges, E-PRESERVE strong reading, touched(n) (slots ∪ taint bit —
   L1), touchedList, write walk, edge-add propagation with retroactive
   delivery (I23), value-blind notification walk with walkGen (I32),
   per-walk atomicity (L7). [absorbs the separately-counted notification
   walk and the deleted WORLD_TAINT column]
5. **World memos + suspense capsules under the closed validity rule** —
   M(n, worldKey), lineage-positional thenable capsules (D11), the closed
   change-source table with the flattened evaluator vector shared by both
   consumers (L3), value revalidation before refetch (I35). [vector
   unified]
6. **Evaluator staging + F9 publication + promotion** — committed-first
   comparison (L4), lineage stage cache with lineage-stable stamps (I40),
   F9 hook-becomes-current publication with CAS (I41), promotion re-fold
   through the ordinary fold/reconcile/walk path (L8), publication
   ordering before folds (I38c). [rule-tightened]
7. **Watcher/binding records** — per-write synchronous value-blind
   delivery with per-(watcher, slot) dedup (D5/D10/D13), mount fixup =
   value-blind per-token loop + one w_fx compare (L2), reconcile-at-fold
   backstop, durable effect flush triggers via touchedList (I34), effects
   ride native deps re-fire (D18). [fixup simplified]
8. **Fork/build protocol F1–F9 + carrier** — nine protocol facts (§14),
   twin-build transform (I30), armed registration-time scheduler shims
   (re-scoped, L5), retired-token fallback (I37), ActionScope, realm
   affinity, loud boot self-test. [shim list shrunk]
9. **Episode lifecycle** — quiescence refresh with full-cone exemption
   carry (I42), renumber/epoch discipline (I8/I19), the C13 master table.
   [unchanged]

## 4. Modes and activation

DIRECT: donor op table; no tapes, no touched column maintenance, no
routing, no shims — zero concurrency instructions (P3), proven by CI
symbol diff of the DIRECT bundle. LOGGED: activated exactly once by
`registerReactBridge()` (monotonic — never keyed to watcher count, S6).
Activation swaps the op-table binding at operation boundaries (closure
rebuild, the measured-safe pattern [GUIDE]).

Two activation rules (both restrictions are detectable at the throw site):

- `registerReactBridge()` **throws if called while any evaluation, fold,
  or walk frame is open** (the frame already exists for cycle detection
  and I28 guards). Legal composition: register during app setup. This
  closes the mid-evaluation op-table swap hole (docket: DIRECT→LOGGED
  transition caches) without a transition protocol.
- Caches created in DIRECT are legal LOGGED state: no receipts existed, so
  every pre-swap cache embeds committed-only values; touched columns are
  zero-initialized. This is the base case of TAINT-COMPLETE (§6.3) and of
  invariant R (§6.4).

SSR/hydration (R10): hydrate atom state by plain construction/set before
`registerReactBridge()` — DIRECT-mode writes, no receipts; then register.
RSC/Flight out of scope v1.

## 5. Value model

### 5.1 Write path (LOGGED)

A write to atom `a` in ambient batch context b (fork F1; carrier-consulted
per §12, liveness-checked per I37):

1. Classify: token = F1's answer (or the carrier's live token); intern slot
   s (minting/force-clearing per §5.4 if needed).
2. **Drop check (I7/I38a)**: if `tape(a)` is empty AND base has no pending
   history AND the op has world-invariant meaning (plain `set` always;
   updater/reducer only when the atom's evaluator is immutable — plain
   atoms, constructor reducers) AND the op evaluated against base is equal
   → drop (no receipt, no walk). Stageable ReducerAtoms always append.
3. Append receipt {op, s, seq=++globalSeq}; bump wc[s]; apply to K0 with
   the atom's stepwise equality (keep the old reference on equal — I29).
4. Add s to touched(a); **write walk**: propagate bit s from a through
   K0∪K1 out-edges (monotone frontier `newBits & ~touched(n)`), appending
   newly-bitted nodes/effects to touchedList[s].
5. **Delivery** (D5/D10/D13): per-write, synchronous, value-blind: for
   every watcher record reached by the walk whose (watcher, s) dedup bit is
   clear — set the bit, call its setState in the writer's stack (React
   assigns the writer's lane). Core-effect enqueue rides the same walk;
   `batch()` defers only the core-effect *flush* to close (no implicit
   grouping exists — D10).
6. Writes during render-world evaluation throw (R8); writes in yield gaps
   are ordinary (the fork's callstack truth, F2/I6, classifies them).

RENDER_NEWEST passes demote to their real (mask, pin) on the first
receipt-creating write *or staged evaluator* (S23) — demotion data is
captured at pass start, so demotion is O(1).

### 5.2 Visibility (the seed math, verbatim — D3/I15)

Entry e is visible to world w = (mask, pin p, lockView LV):

```
visible(e, w) =  (e.retiredSeq ≠ ∅ ∧ e.retiredSeq ≤ p)            // retired by my pin
              ∨ (e.slot ∈ mask ∧ e.seq ≤ p)                       // included, up to my pin
              ∨ (e.slot ∈ LV ∧ e.seq ≤ LV[e.slot].watermark)      // locked into my root
```

- Pass worlds use the pass's **captured** lock view (immutability is what
  lets a yielded pass keep folding the same world — I34). Fork fact F2
  guarantees no same-root advance can occur while a same-root pass is
  open (a same-root commit discards the WIP pass; React restarts rather
  than resumes — fork test 24 pins this). Cross-root advances re-mint
  *other* roots' views, which this pass never consults.
- committed-for-root(r) worlds use r's **current** view; their worldKey
  includes lockViewId, so every advance re-keys them (no stale
  committed-for-root memo can survive an advance).
- Fold = replay visible entries over base in seq order with stepwise
  equality (I2/I29); reducer ops fold under the world's **effective
  reducer** (staged-in-this-pass else committed — I22/I38). Fold-frame
  callbacks (reducers, equality) run under the I28 guard: signal reads and
  writes throw in all builds.
- `fp(a, w)` and `lockTerm(a, w)` are computed during this same entry scan
  (O(visible entries), no extra pass).

### 5.3 Retirement (fork F3) and the committed-side order

Per retiring token t (exactly once, committed flag; async tokens park
until the returned thenable settles — F3/I26):

1. Within the triggering commit, ordering is fixed (F3/F9 clause, I38c):
   **F9 publications → retirement folds due at this commit → reconcile
   checks and effect flush → layout effects.**
2. Fold: replay t's now-retired receipts into committed truth per §5.2;
   set retiredSeq = ++globalSeq on each entry. **Compaction predicate**
   (normative, both clauses): compaction consumes a **seq-order prefix**
   of the tape — entry e compacts into base iff every entry with seq ≤
   e.seq is retired AND `e.retiredSeq ≤ min(live pins)`. The prefix
   clause preserves replay order (compacting a later ×2 under a pending
   earlier +1 would fold 3 where React commits 4 — C3 row 4); the pin
   clause means every live pin already sees e via the retired clause.
   (The pin-gating is also load-bearing for taint clearing — §6.3.)
3. Mint retireVisStamp(a) for every touched atom; bump
   **committedAdvanceSeq** (L6).
4. Notify committed observers **durably**: enumerate touchedList[slot(t)]
   (never only the consumable write-time queue — I34/S26); reconcile check
   per watcher (compare lastRendered vs the new committed-for-root value;
   setState only on real difference — the value-compare here is committed
   truth, legal per I35's delivery/validity distinction); flush
   useSignalEffects whose snapshot fingerprints moved.
5. Slot bookkeeping: the slot and its touched bits are **retained** until
   its entry count sweeps to zero (I10/I39; entries sweep when compacted).
   Per-root lock records for t clear only after retirement stamps exist
   (injectivity ordering).
6. Store-only batches (no React work) retire through the same path (D2):
   fold, stamps, durable notification — persistence never depends on
   subscription.

### 5.4 Slot saturation (I39)

`internSlot` with all 31 slots held (live or unswept): force-clear the
oldest slot k* whose token is fully retired — sweep touchedList[k*]
zeroing bit k* on every listed record; set `fastPathDisabled` on every
live pass whose pin < max retiredSeq of k*'s entries; k*'s entries are
**retained** (retired visibility is slot-free: the retired clause tests
retiredSeq, not slot); wc[k*] zeroes at re-intern; slot generation bumps.
A 32nd *live* token is impossible (fork guarantee, I10), so a fully
retired victim always exists. Forced test: input storm during one yielded
transition (walk C1-X5).

### 5.5 Quiescence and episodes

At full quiescence (no live tokens, no live pins, no parked actions):
refresh every K1-touched node holding a committed watcher or effect-dep
snapshot by a K0 NEWEST pull; a node whose refresh twice triggers R8-legal
writes is exempted and its **full reverse-reachable K1 cone** is carried
into the next episode (I42; two-strike rank Σ(2−strikes) terminates a
fixed observed set in ≤2N+1 sweeps). Then: K1 bulk-reset (epoch bump),
plane watermarks reset, counter renumber per the §15 duty list (every
retained stamp rewritten or epoch-guarded — I8). An exemption clears when
a later ordinary K0 NEWEST evaluation of the target completes without
writing.

## 6. Worlds and read routing

### 6.1 Read contexts

- NEWEST (core reads, yield-gap handlers, RENDER_NEWEST passes): K0
  donor-style — pull, recompute if stale. Handlers in yield gaps are
  NEWEST because render-context truth is per-callstack (fork F2, I6/S7).
- Pass worlds and committed-for-root worlds: route per 6.2.
- World evaluations reject writes (R8) and throw on per-world EVALUATING
  re-entry (cycle detection is per-world; K0∪K1 union cycles are legal
  state — I32).

### 6.2 The fast path and the taint bit (L1 — judge blocker 1 repaired)

```
fastPath(n, w, pass) =  touched(n) == 0        // no slot bits AND no taint bit
                     ∧  CT(n)                  // cached, zero recompute needed (I12/S9)
                     ∧  ¬stagedFor(n, pass)    // O(1) pass-frame probe (I31)
                     ∧  ¬fastPathDisabled(pass)
```

else world path: fold atoms per §5.2; consult/evaluate M(n, worldKey);
untracked reads inside world evaluations fold **in-world, edge-free**
(I33's licensed form).

**The taint bit.** touched bit 31 (TAINT) marks: "this node's K0 cache may
embed pending state that arrived through an untracked read" (I33). Its
complete rule set — all reusing existing machinery:

- **Set at evaluation (epilogue).** Every K0 NEWEST evaluation of n
  computes a taint input: (a) any untracked read during the evaluation hit
  an atom with a non-empty tape, or hit a computed with `touched ≠ 0`;
  (b) the post-eval dep sweep (rides the existing DEPS_TAIL re-track scan)
  finds TAINT set on any recorded dep. Input true ⇒ set TAINT; false ⇒
  clear TAINT (bit 31 only).
- **Propagate on 0→1.** When TAINT transitions 0→1 on n (by epilogue or by
  inheritance), propagate bit 31 through n's existing out-edges in K0∪K1
  with the same monotone frontier the write walk and edge-add propagation
  already use (`bit & ~touched(m)` — self-terminating, no walkGen needed).
  This is the repair for the judge's blocker: **tracked serves and
  cutoff-clean downstream nodes now inherit taint through the graph**, per
  I17 (path-transitive invariants must propagate through existing
  out-edges), not only at their own evaluations.
- **Tracked reads need no per-read check.** Slot bits reach tracked
  readers through write walks and edge-add propagation; taint reaches them
  through the 0→1 propagation above and the dep sweep. (If the edge is
  created by the reading evaluation itself, edge-add propagation pushes
  the child's current bits — including TAINT — into the reader; both
  link-then-pull and pull-then-link orders are covered.)
- **Clear sites** (I19): the node's own epilogue computing untainted; bulk
  zero at episode reset. Downstream inherited taint out-lives an upstream
  clear until the downstream node's own re-evaluation — conservative,
  never wrong.
- **Cost**: LOGGED-only. One tape/touched check per *untracked* read; one
  bit-AND per dep in the re-track sweep each recompute; propagation only
  on transitions. G-Q/G-W ledger rows (§16).

### 6.3 TAINT-COMPLETE (the invariant, with its construction)

**Claim.** If `touched(n) == 0 ∧ CT(n)`, then n's K0 cached value is a
function of committed-visible state only (serving it to any world is at
most *temporal* staleness — the kind untracked licenses — never world
leakage).

**Base case.** Episode start / DIRECT-era caches: no receipts exist
anywhere; every cache is a function of committed values; all touched
words are zero. ✓

**Step.** Consider the event that last wrote n's K0 cache (an evaluation
E at NEWEST) and every later event, showing touched(n)=0 survives only if
the property holds:

- *E's tracked atom reads*: an atom with pending receipts has a non-empty
  tape and slot bits; the edge recorded by E delivers those bits to n
  (write walk if the edge predated the write; edge-add propagation if E
  created the edge). Bits ⇒ touched(n) ≠ 0 — contradiction, so all
  tracked atoms were committed-only. ✓
- *E's tracked computed reads*: by induction the child's cache with
  touched=0 embeds committed-only state; a child with touched ≠ 0 passes
  its bits to n (same two walks) or its TAINT via the dep sweep. ✓
- *E's untracked reads*: epilogue rule (a) sets TAINT for a receipted atom
  or any-bits computed — contradiction; so untracked reads saw
  committed-only state. ✓
- *Events after E*: a later write whose cone reaches n through any
  recorded edge sets a slot bit (write walk / edge-add / E-PRESERVE mirror
  — invariant M, §7.3). A later write reaching n only through an
  untracked-read path cannot change n's *cache* (caches change only at
  evaluations) — it changes what n's evaluation *would* produce; the cache
  still embeds only the old committed values, which is temporal staleness,
  licensed. A later upstream evaluation that embeds pending state into a
  *child's* cache sets the child's TAINT (epilogue), whose 0→1 propagation
  reaches n through the existing edge — even if equality cutoff keeps n
  CLEAN (the cutoff horn; this is exactly the path the round-3 text
  missed). A later retirement only moves state pending→committed
  (never the reverse). ✓
- *Clearing events*: bit s clears only at slot recycle gated on swept
  entries (every pin sees them — §5.3 step 2 makes compaction pin-gated)
  or at saturation force-clear, which compensates by fastPathDisabled on
  every excluded pass (§5.4). TAINT clears only at n's own epilogue, whose
  input freshly re-derives the property; "empty tape" is trustworthy at
  that moment because compaction is pin-gated — a tape can only become
  empty when every live pin already sees its former entries, and every
  future pin is minted above them. Evaluations are stack-atomic (JS), so
  no clear can interleave a half-completed derivation. ∎

### 6.4 Invariant R (fast-path soundness — full construction)

**Claim.** The fast path never serves a value that world w's own
evaluation would not produce. Worlds diverge from NEWEST through exactly
four sources (S23's enumeration), each excluded by a conjunct:

1. **Receipts reachable through recorded topology.** By first-divergence
   (I4), the first divergent atom x is a newest-basis dependency at the
   divergence point and holds a live receipt in slot s; bit s reached n by
   the write walk, edge-add propagation, or the E-PRESERVE mirror (§7.3's
   invariant M), so touched(n) ≠ 0 — refused. Fresh-recompute acquisition
   (S9) is excluded by CT(n): only cached, no-recompute serves are legal
   (I12).
2. **Receipts reachable only through untracked reads.** TAINT-COMPLETE
   (§6.3): an untainted, unbitted, CT cache embeds committed-only state;
   any cache that could embed pending state carries TAINT (set at its
   producing evaluation or inherited through propagation/dep-sweep) —
   refused. World evaluations fold untracked reads in-world, so the
   licensed temporal staleness stays per-world.
3. **Evaluator identity (I22/I31).** A staged evaluator for n exists only
   in its pass's frame; the probe refuses the fast path there, and staging
   demoted RENDER_NEWEST (§5.1). Promotion dirties the K0 node, so
   post-promotion NEWEST reads recompute — CT(n) is false until they do.
4. **Slot-bookkeeping erasure.** Bits clear only at swept-gated recycle
   (I10) or saturation force-clear, which sets fastPathDisabled on every
   pass whose pin the cleared slot's retirement postdates — refused
   wholesale (§5.4).

Base case: episode start — no receipts, no stages, no taint, all worlds ≡
NEWEST. Step: every event kind's update site is listed above and in the §7
audit table; each preserves its conjunct. ∎

## 7. K1 and the touched word — one audit table

### 7.1 K1 plane

Integer link records (node→node, generation-tagged), add-only within an
episode, bulk-reset at quiescence (§5.5). World evaluations record their
REAL dependencies here (the pending world has a real topology — the D8
answer to I3/S2/S3). K1 records carry lastWalk (walkGen column).

### 7.2 The touched word — bit audit (the L1 merge's single table)

| bits | meaning | set by | propagated by | cleared by | forced test |
|---|---|---|---|---|---|
| 0–30 (slot s) | slot s's cone reached n | write walk from written atom | write walk; edge-add propagation (new edge inherits source bits, then delivers retroactively — I23); E-PRESERVE mirrors keep paths alive (§7.3) | slot recycle (swept-gated, I10); saturation force-clear via touchedList sweep (+ fastPathDisabled compensation) | C1 core; C1-X5 |
| 31 (TAINT) | K0 cache may embed untracked-acquired pending state | evaluation epilogue (untracked read hit receipted atom / any-bits computed; dep sweep found tainted dep) | 0→1 transition walks existing out-edges (same monotone frontier) | own epilogue deriving untainted; episode bulk zero | C1-X3 (incl. tracked-serve and cutoff rows) |

One invariant governs both ranges: **a zero touched word certifies
committed-only content** (TAINT-COMPLETE §6.3 + source 1 of invariant R).
One consumer rule: iterators over slots mask bit 31 (`touched & SLOTS`);
the fast path and the fixup fast-out test the whole word.

### 7.3 Invariant M (edge knowledge) and E-PRESERVE

**Invariant M.** At every instant, for every node n and live slot s whose
batch wrote atom x such that some world's evaluation of n read x (directly
or transitively) at or before its pin: bit s ∈ touched(n), OR the edge
path from x to n exists in K0∪K1 and a walk is in progress/queued that
will set it. Maintained at: write time (walk), edge-record time (edge-add
propagation + retroactive per-slot delivery in every non-render context;
queued to the pass's yield/end edge when discovered inside a render
slice), and K0 re-track time (E-PRESERVE strong reading: every edge a K0
re-track removes while any live receipt exists anywhere is mirrored into
K1 with both endpoints and generation). When no receipt exists anywhere, a
dropped edge is safe: resurrecting a displaced branch requires a receipt
on the branching dep, whose write re-records the path (walked at C1-V3).
SP2 (dev validator → CI fuzz gate) brute-force checks M on randomized
retrack schedules.

## 8. Validity — the closed change-source table

### 8.1 Sources and observers (I16: closed enumeration, audited as a table)

| # | change source | observer (stamp + conjunct) |
|---|---|---|
| S1 | write in slot s | wc[s] (ladder step 3); fp's newest-visible term |
| S2 | retirement fold/compaction | worldMemoEpoch; baseSeq; committedAdvanceSeq (fast-outs only) |
| S2b | visibility flip below the max (retirement of an older entry; lock-in; watermark advance) | retireVisStamp(a) in fp; lockStamp via lockTerm in fp; lock views are immutable and re-minted so committed-for-root worldKeys re-key on every advance (I21/I34) |
| S3 | evaluator identity (computed fn or reducer) | the flattened **evaluator vector** [(evaluatorId, effStamp)] recorded by every memo and suspense prefix; checked pairwise before any clock-based serve (I31); promotion dirties K0 and re-folds reducer atoms (§11.1) |
| S3b | untracked pending-state embed | TAINT bit inside touched (routing conjunct — §6.2) |
| S4 | thenable settlement | capsule state machine (§9); settlement is a content event, never a world event |
| S5 | episode/renumber | epoch in every worldKey; renumber duty list §15 |
| S6 | world identity | worldKey = (mask, pin, lockViewId, epoch) |
| S7 | node identity recycle | node generation tags on K1 records and memo keys |

### 8.2 The memo ladder (serve M(n, worldKey) when)

1. worldKey matches (mask, pin, lockViewId, epoch — S6/S5).
2. **Evaluator vector pairwise equal**: memo's recorded [(evaluatorId,
   stamp)] vs current effStamps (staged-in-this-pass else committed) —
   int compares; covers nested evaluators and reducers (L3; refuses
   before any clock can serve — I31).
3. Slot clocks: ∀s ∈ mask: wc[s] ≤ memo.seq → serve.
4. Fingerprint recheck per recorded atom dep: all fp(a, w) unmoved →
   re-stamp memo, serve.
5. Re-evaluate in w (record deps in K1, record the evaluator vector,
   flatten child vectors — S5-safe because the recorded read set is
   complete with sentinels, the S5 lesson).

Evaluations triggered from the ladder run under the world-eval frame
(writes throw; per-world EVALUATING cycle throw).

## 9. Suspense (R2 `ctx.use`, R6/C15)

### 9.1 Identity

Thenable capsules key by (fork lineage id, hook position) — D11. Lazy
factory form preferred (eager form guarantees identity stability only —
D16). Capsules are per-world-content validated, never per-pass.

### 9.2 Content validity with value revalidation (I35 + L3)

Each capsule prefix position records, in evaluation order:
- atom positions: (atomId, fp(a, w), effective reducerStamp if a is a
  ReducerAtom, valueRef — the fold's reference-stable value);
- computed positions: (computedId, effStamp).

Retry check per position, in order:
- stamps (evaluator/reducer effStamps) pairwise equal AND fp equal →
  reuse.
- **fp mismatch only** → re-fold that atom in w (under this pass's
  effective reducer) and compare with the atom's equality: equal ⇒
  re-stamp the position in place and continue (content-neutral flip —
  settled resource kept; no duplicate fetch; the S31 class); different ⇒
  drop positions ≥ p, refetch (generation-bumped).
- evaluator effStamp mismatch → content change by definition → drop +
  refetch. Lineage-stable stamps (L4/I40) make suspense retries compare
  equal (a retry stages nothing new: its deps equal the last staging or
  the committed evaluator), and **promotion installs the staged stamp
  unchanged**, so a post-commit retry still compares equal (no S24
  livelock). A *staged reducer* changes fold outcomes with no fp move —
  that is why reducer effStamps live in the positions (the I35 hole this
  round closed; walk C15 row 5‴).

Settlement: per-world capsule resolves; canonical world never observes the
suspension (sentinel boxes are cached values — R2). Cost: one fold per
moved-fp position per retry — SPK-G8/O21 owns the number; fallback =
whole-mask clock vector (coarser refetch, flagged).

## 10. Notification and delivery

### 10.1 Delivery rules (settled: D5/D10/D13, I5, I23)

Per-write, synchronous, in the writer's stack, value-blind. Per-(watcher,
slot) dedup bits re-arm at the watcher's render. Edge-add retroactive
delivery: when a new edge x→n is recorded while slots are live on x,
replay each still-live slot's delivery through the new path (runInBatch
per slot — I23), immediately in every non-render context, queued to the
pass's yield/end edge when discovered inside a render slice. Retirement
and lock-advance triggers enumerate durably via touchedList (I34); the
write-time effect queue is an optimization whose consumption never removes
an effect from later enumerations.

### 10.2 Walk termination and atomicity (I32 + L7)

Value-blind full walks (write notification; retirement notification;
promotion notification) carry walkGen: bump one global counter per walk;
lastWalk(record) == walkGen ⇒ skip. One int load+compare+store per visited
record per walk (G-N/G-W ledger). Mark/edge-add/taint propagations need no
walkGen: their `newBits & ~touched` frontier is monotone and
self-terminating.

**Walk atomicity (the reentrancy answer — proof, not machinery).** Claim:
no walk can begin while a walk frame is open, so one global walkGen is
sound. Construction — enumerate every instruction class a walk executes:
record loads/stores and bit ops (no dispatch); watcher setState (React
enqueues; our fork's scheduler never renders synchronously inside a
setState call — flushSync inside a walk would require user code, and none
runs); core-effect *enqueue* (no run — flushes drain after the write's
walk returns; a flushed effect that writes starts its walk after the
previous walk returned, sequentially). The only user-adjacent code near a
walk is fold-frame callbacks (reducers, equality) — and fold frames are
never open inside walks (folds happen at reads/retirement processing, and
retirement's fold step completes before its notification step begins);
inside fold frames, signal reads/writes throw (I28). Therefore no write,
no evaluation, and no walk can be initiated from within a walk. ∎
Dev assert: entering a walk with `walkActive` set crashes loudly (turns
any future violation of this construction into a dev error, not a silent
gen collision). walkGen wrap: renumber sweep row (§15).

This same atomicity answers the docket's saturation attack: force-clear
runs only inside `internSlot`, which runs only inside the write path,
which cannot be inside a walk — so no walk can observe a half-swept
touchedList (C1-X5 row 5).

## 11. React bindings

### 11.1 Evaluator staging, F9, promotion (I22/I31/I38/I40/I41; L4/L8)

**Staging (per hook invocation with incoming (fn, deps)):**

```
1. deps pairwise-equal (Object.is) to the COMMITTED evaluator's deps
     → use committed {fn, stamp}; no stage, no mint, no demotion.   // L4
2. else deps equal to this pass frame's staged entry → reuse it.
3. else deps equal to the lineage stage cache entry → reuse its
     {fn, stamp}; stage it into this pass's frame.
4. else mint {fn, deps, stamp: ++globalSeq}; stage into the pass frame;
     update the lineage stage cache.
Staging (cases 2–4) additionally: demotes a RENDER_NEWEST pass to its
real (mask, pin); registers the F9 publication id on the WIP hook.
```

Properties: a stage exists iff deps ≠ committed's (L4) — so deps
oscillation A→B→A lands back on the committed evaluator with zero mints;
suspense retries and StrictMode replays hit case 1 or 3 and reuse stamps
(lineage-stable, I40); the lineage stage cache is per-(lineage ×
hookNode), dies at lineage death, stamps renumber per §15.

**Promotion = F9 emission** (the hook *becomes current*: hidden Offscreen
included, error-abandoned subtrees excluded, stale alternates rejected by
generation CAS — I41), ordered before the same commit's retirement folds
and layout effects (I38c). Steps:

- P1: install the staged {fn, deps, stamp} as the committed evaluator —
  **the stamp is installed unchanged, never re-minted** (so recorded
  vectors/prefixes that saw the staged stamp still compare equal — §9.2).
- P2: dirty the K0 node (commit-phase, render-pure) so the next NEWEST
  read re-evaluates under the promoted closure (S23's backstop half); bump
  committedAdvanceSeq.
- P3 (ReducerAtom with pending receipts): re-fold K0 NEWEST under the new
  committed reducer — the **ordinary** fold path with stepwise equality;
  if the value moved, the **ordinary** notification walk + reconcile
  checks + effect flush run in the committing context (L8; delivery lane
  = the committing context's, per D5). Dev-warn retained (perf note);
  differential battery keeps its swap-with-pending rows.
- P4: `publicationsComplete(passId)` reclaims unpublished stages; discard
  and lineage death reclaim without promotion.

`useSignalEffect` fn/deps changes take **no F9 path** (D18): React's own
deps contract re-fires the effect at its commit, which re-reads,
re-tracks, and re-subscribes (walk C16-D).

### 11.2 Mount/subscribe fixup (L2 — judge blocker 2 repaired)

Runs in the mounting component's layout effect, after subscription.
`w_r` = the watcher's rendered-world snapshot (mask, pin, lockViewId,
captured lock view); `v_r` = its lastRendered value.

```
r = touched(n)
if r == 0 ∧ CT(n): return                    // committed-only content (§6.3); nothing to do
for each LIVE written token t with slot s = slot(t) ∈ (r & SLOTS):
  if s ∈ w_r.mask ∪ w_r.lockView ∧ wc[s] ≤ w_r.pin: continue   // fully included (I43): skip
  fork.runInBatch(t, setStateW)              // value-blind entanglement (I13 — never skipped by value)
if committedAdvanceSeq ≤ w_r.pin ∧ root.lockViewId == w_r.lockViewId:
  return                                     // fast-out: nothing committed-side moved (L6)
v_fx = evaluate(n, w_fx)                     // the rendered world, fast-forwarded (below)
if !isEqual(v_fx, v_r): setStateW()          // urgent pre-paint correction (C10's mandated fallback)
```

**w_fx (one world, no suppression predicate).** Visibility:

```
visible(e, w_fx) =  (e.retiredSeq ≠ ∅)                                  // committed truth at NOW
                 ∨ (e.slot ∈ w_r.mask ∧ e.seq ≤ w_r.pin)               // the render's own inclusions, at its pin
                 ∨ (e.slot ∈ LV_now ∧ e.seq ≤ LV_now[e.slot].watermark) // root's CURRENT lock view
```

Evaluators: committed (post-F9-of-this-commit, so a stage published by
the mounting pass itself compares as what it rendered with — F9 precedes
layout, I41). All comparisons stay on the one globalSeq line (I15's
letter: two thresholds, one number line).

**Why this is the I43 reconciliation (construction).** v_fx − v_r can
differ only through visibility w_fx has and w_r lacked — and w_fx differs
from w_r *only* on the committed side: retirements that landed after the
pin (retired clause at NOW), lock-ins/advances after capture (current
view), promotions (committed evaluators). Divergence from **live included
tokens is folded IN, not compared against** (mask clause kept at the
rendered pin), so a C9 mount inside a batch's own pass sees v_fx = v_r by
purity and never double-renders; post-pin writes by live tokens are
excluded from w_fx exactly because the per-token loop already scheduled
their entanglement (firing urgently for them would tear the pending
batch). Divergence from live non-included tokens is invisible to both
sides (not retired, not in mask, not locked). So: fire ⟺ the render
missed committed-side truth ⟺ exactly the retire-race/advance/promotion
window I18 mandates a durable fallback for. The retired clause needs no
token enumeration — retiredSeq is on the entries — so a token that
retired and swept in the window is still seen (I18). S10/I13 are
respected: value equality never *suppresses* a live-token corrective (the
loop is value-blind and runs first); the value compare only gates the
urgent committed-side correction, where equality means "no correction
exists to make" — and it compares the one *joint* fast-forwarded world,
so S10's per-token-projection subset trap cannot arise. ∎

Cost: G-F. R-clean mounts (touched == 0 ∧ CT): zero work. Fixups: ≤
|touched ∩ live non-included| runInBatch calls + (only when
committedAdvanceSeq/lockViewId moved) one world evaluation.

### 11.3 Watcher lifecycle

Subscribe at layout (before fixup); unsubscribe at cleanup with
microtask-debounced observed-count effects (R1 flap-proofing; C14
double-mount nets to one). lastRendered updates at every committed render
of the watcher; dedup bits re-arm at render (C4). The reconcile-at-fold
backstop (§5.3 step 4) compares against lastRendered — committed-truth
value compare, legal (I35 delivery/validity distinction).

### 11.4 Effects

`useSignalEffect` evaluates in committed-for-root(r) (world path; worldKey
carries lockViewId). Flush triggers, all durable (I14/I34): root commits
including every per-root lock-in/watermark advance (enumerate
touchedList[advanced slot]); retirements (touchedList[slot]); settlement
re-checks. Snapshot fingerprints include lockTerm, so an advance moves
them; committedAdvanceSeq is an optional pre-filter (unmoved ⇒ skip the fp
scan — never the reverse, S20). Core `effect()` observes NEWEST
(documented contract, walked in C16).

### 11.5 Hooks surface (R4)

`useSignal`/`useAtom`/`useReducerAtom`/`useComputed(fn, deps)` — reads
route per §6; `useComputed` staging per §11.1. Provider-free: the bridge
is module-level (one fork handshake); roots register at first mount
(per-root lock views live in the root registry — O7). `useSignalEffect`
per §11.4. Render-phase writes throw (C14; the world-eval and render
frames are distinct — yield-gap handlers are not "in render", I6).

## 12. Async actions (C12 family; D15/D17, I26/I30/I36/I37)

### 12.1 Carrier rungs and scheduler shims (L5 re-scope)

- **Rung 1 — AsyncContext** (feature-detected): native carrier; no build
  requirement.
- **Rung 2 — twin-build transform** (I30, measured: ≈0% unarmed,
  +12 ns/await armed): each async fn compiles to native body +
  token-carrying generator driver behind a one-null-check dispatch.
  **Armed registration-time shims** (I36) on: `setTimeout`, `setInterval`,
  `queueMicrotask`, `requestAnimationFrame`, `requestIdleCallback` — at
  *registration*, if currentToken ≠ null, the callback is bracketed
  (push(token)/finally-restore at invocation, liveness-checked per §12.2).
  Unarmed or token-null registrations are never wrapped.
  **MessagePort/postMessage is not shimmed** (L5): port handlers register
  at boot with token null, so the champion's own registration rule already
  never wrapped them — the send-time flow is a *different* semantics that
  AsyncContext's event model (registration-snapshot) also does not carry.
  The class is documented boundary, dev-warned, rung-uniform; ActionScope
  is the precise escape. Not an S22 repeat: the transform still carries
  every await; shims cover explicit host registration only.
- **Rung 2b — Node AsyncLocalStorage, explicit opt-in** (server; +38%
  promise-machinery cost noted, never auto-selected).

**Carrier induction.** Base: the token is ambient during the action's
synchronous prefix. Step: (i) every resumption of a compiled async fn
passes through its driver's push/restore; (ii) every compiled async fn
invoked while the token is ambient instantiates its generator under it;
(iii) every callback registered through a shimmed scheduler while the
token is ambient is bracketed at invocation. Residual (documented, D17):
unshimmed registrars; uncompiled async functions' internal awaits. ∎

### 12.2 Retired-token fallback (I37)

Every carrier consult checks liveness: a token that is not live-parked
(retired/settled) is treated as null — ambient classification — with a dev
warning ("action continuation outlived its action"). Uniform across rungs.
Parking stays keyed to the returned thenable (React parity: a late
un-awaited child's update lands in its own batch). Liveness races are
closed by stack-atomicity: the consult and the receipt append are one
synchronous extent; retirement is also synchronous code, so no interleave
exists mid-extent; each *continuation* re-enters through its own consult.

### 12.3 ActionScope and realm affinity

`startSignalTransition(fn(scope))`: `scope.set(atom, v)` /
`scope.dispatch(ra, action)` supply the captured token explicitly
(generation- and liveness-checked); `scope.runSync(fn)` enters the carrier
for the synchronous extent; calls after settlement throw ("ActionScope
closed"). Realm affinity: atoms, tokens, roots, scopes carry an
owner-realm nonce; foreign tokens throw at runInBatch; Atom/ActionScope
are not structured-cloneable (detectable restriction; ordinary worker
promises unaffected).

### 12.4 Boot self-test and support matrix

`registerReactBridge()` arms LOGGED synchronously; the transform probe
verdict lands one microtask later and throws async-loud on failure
(support-matrix message); the probe covers a shimmed-scheduler round trip,
per bundle pipeline. Support matrix:

| composition | status |
|---|---|
| AsyncContext host (future) | native carrier; no build requirement |
| bundled app + transform; transformed code awaits anything; only transformed code writes after awaits; async callbacks via shimmed schedulers | supported (C12 verbatim) |
| uncompiled post-await code uses ActionScope.set/dispatch | supported |
| uncompiled code performs a raw post-await signal write | misattributes to its ambient batch — sound, bounded, dev-warned (D17); transform node_modules, use ActionScope, or rung 1 |
| unshimmed registrar (incl. MessagePort) hands an async callback across an action | same bounded class, dev-warned (L5) |
| raw token/Atom/ActionScope structured clone; foreign-realm token | rejected loudly (realm affinity) |
| unbundled/untransformed, no AsyncContext, no opt-in | boot failure (async-loud) |

## 13. Semantics pins (carried; conformance-tested, not re-litigated)

- **Reducers** (D14/D16/I38): reads/writes inside `update(fn)`/reducer
  folds throw in all builds (I28); constructor reducers immutable; hook
  reducers stage per pass and promote at F9; stageable ReducerAtoms always
  append (no empty-tape drop); promotion re-folds NEWEST with pending
  receipts and publishes before same-commit folds.
- **ctx.previous** (D16): donor-global at NEWEST (conformance-pinned);
  per-(node, worldKey) in world evaluations; K0 seed only when
  invariant-R-cleared, else undefined.
- **Equality**: policy wrappers returning reference-stable values/boxes;
  the kernel compares identity only (stays monomorphic). Errors and
  suspensions are cached sentinel boxes (R2) — a throwing getter never
  corrupts graph state; sentinel-embedding caches obey the same touched
  discipline (settlement is validity source S4).
- **Loop limits** (R7): React storms hit React's own update-depth guards
  (setState in writer's context inherits them — D5); engine-only cycles
  throw per-world EVALUATING; signal-only storms hit the flush budget.
- **Writes in computeds** (R8): tolerated when acyclic in core;
  `configure({forbidWritesInComputeds})`; render-world evaluation always
  rejects writes.
- **Tracing** (R11): the synthesized reference design carries (lazily
  loadable recorder, ring + session modes, one slot check per site when
  untraced); its hook points are op-table wrappers, orthogonal to this
  round.

## 14. fork-protocol (the seam — versioned document; nine facts)

Hard rules honored: integers and documented callbacks only; no Fiber
objects, lanes, or queue internals cross the boundary; bindings
feature-detect (F7) and fail loudly on stock React.

- **F1 — write classification.** `currentBatchToken(): int` (0 = none):
  the batch of the write executing *now*, deferred bit in the token;
  minted lazily, never reused live; consults nothing about lanes across
  the seam. Edge-triggered where React already tracks its execution
  context. Invariant: ≤31 live tokens (I10).
- **F2 — pass lifecycle with yield edges.** `passStart(root, mask, pin
  claim)` / `passYield` / `passResume` / `passEnd(commit|discard)`.
  Per-callstack truth (I6): handlers in yield gaps observe "not in
  render". **Serialization fact**: no same-root lock view advance occurs
  while a same-root pass is open — a same-root commit implies the WIP
  pass ended (React discards and restarts; it never resumes across its
  own commit). Fork test 24 asserts it.
- **F3 — retirement.** Exactly once per token, committed flag; per-root
  commit lock-in with **watermark = the committed pass's pin** (I25);
  watermark advances on later commits; async-action parking (retire only
  after the returned thenable settles). Ordering clause: within a commit,
  F9 publications → retirement folds due at that commit → layout effects
  (I38c/I41).
- **F4 — lane-scoped scheduling.** `runInBatch(token, cb)`: cb's updates
  join the token's lanes; retired token → cb runs urgent (documented
  fallback, used by fixup races). Work inserted after a pass completes
  schedules new work (the C10-R(ii) obligation).
- **F5 — render lineage id.** Stable per (root × batch-set) across
  restarts/replays/retries; dead at commit/abandon (D11). Suspense
  capsules and lineage stage caches key on it.
- **F6 — DOM mutation window.** Commit-phase mutation boundary callbacks
  (kept per charter).
- **F7 — protocol handshake.** Version + capability bits (F8 shim/carrier
  capabilities, F9 publication). Bindings refuse silently-degraded modes.
- **F8 — action boundary contract.** The carrier/parking capability and
  boot-probe hooks (D15/D17); scheduler-shim capability bit; probe row.
- **F9 — hook publication.** Render attaches an opaque publication id to
  the exact WIP hook; commit emits ids for hooks made current (hidden
  Offscreen included) **before retirement folds and layout effects**;
  `publicationsComplete(passId)` sweeps; discarded/error-abandoned/stale-
  alternate hooks never publish (generation CAS). (O23: fork tests 20–23
  are the existence proof on the critical path.)

**Rebase drill.** "React renamed lanes / moved commit phases / changed
update-queue internals — what moves in the signals library?" Nothing: the
library consumes tokens, pass edges, retirement edges, runInBatch, lineage
ids, and publication ids — all re-implementable facts. Lane renames touch
F1's internal minting; commit-phase moves re-anchor F3/F9 to the events
"root committed"/"hook became current before folds/layout"; update-queue
changes touch nothing (the library never sees queues). Each fact carries
its invariant in place and a reconciler-level test; the suite runs on
every rebase.

**Fork test list.** 1–6 F1 classification (event/transition/timer/
flushSync/nested/batch-close); 7–10 F2 lifecycle + yield/resume + handler
classification + wall-clock-scope regression (S7); 11–14 F3 retirement
exactly-once, committed flag, parking, per-root lock-in watermarks; 15–17
per-root facts under multi-root schedules (O7); 18 runInBatch joins lanes;
19 runInBatch retired-token fallback; 20 hidden-Offscreen commit publishes
before reveal/folds/layout; 21 error-abandoned child publishes nothing,
sibling CASes; 22 stale alternate cannot overwrite winner; 23
F9-before-fold ordering (the C3-R schedule); 24 same-root lock advance vs
open pass serialization; 25 shim carrier rows (async cb via setTimeout/
queueMicrotask/rAF inside an action; unshimmed registrar dev-warn;
**MessagePort documented-boundary row** — L5); 26 retired-carrier fallback
(fire-and-forget child, pre/post settlement); 27 saturation force-clear +
fastPathDisabled; 28 F5 lineage stability across restart/replay/retry.

## 15. Lifecycle master table (C13 audit; I8/I19)

| state item | minted/set by | observed by | cleared/reset by | forced test |
|---|---|---|---|---|
| globalSeq | every mint site | everything | episode renumber (rewrite duty list below) | C13 wrap |
| tape entries {op, slot, seq, retiredSeq} | writes; retirement stamps | folds, fp, prefixes | compaction (pin-gated §5.3); episode reset | C13; C1-X4 |
| base/baseSeq | compaction | folds, fp | episode reset | C13 |
| wc[s] | writes in s | ladder step 3 | zeroed at slot re-intern | C13 |
| touched bits 0–30 + touchedList[s] | write walk; edge-add; E-PRESERVE | routing; fixup; retirement/lock flush enumeration | slot recycle (swept-gated); saturation force-clear sweep | C1-X5 |
| touched bit 31 (TAINT) | eval epilogue; 0→1 propagation | routing; fixup fast-out | own epilogue; episode bulk zero | C1-X3 |
| retireVisStamp(a) | retirement folds touching a | fp, prefixes, snapshots | never in-episode; renumber rewrites | C16-B1 |
| lock views {slot, gen, watermark, lockStamp} + lockViewId | F3 lock-in/advance (immutable re-mint) | visibility clause 3; lockTerm; worldKeys; fixup fast-out | record cleared after retirement stamps exist; pooled view retained until last holding pass drops; id gen-bumped | C11-A; fork test 24 |
| committedAdvanceSeq | retirement folds; lock re-mints; F9 promotions | fixup/effect fast-outs only (never validity — S20) | renumber rewrites | C9 rows; C11-A |
| walkGen + lastWalk column | each value-blind walk | per-walk visited skip | renumber sweep at wrap | C1-X2; wrap row |
| fastPathDisabled(pass) | saturation force-clear | routing conjunct | pass end | C1-X5 |
| lineage stage cache {deps, fn, stamp} | staging (deps ≠ committed — L4) | later same-lineage stagings; effStamp | lineage death; renumber rewrites stamps | C14 rows 4–5; C15 |
| committed evaluator {fn, deps, stamp} | F9 promotion (stamp installed unchanged) | effStamp; folds | node death | C3-R |
| publication ids / stage serials | stage use | F9 CAS | publicationsComplete sweep; discard; lineage death | fork tests 20–23 |
| watcher records (dedup bits, lastRendered, w_r snapshot) | mount/render | delivery dedup; fixup; reconcile | unmount (debounced) | C4; C9/C10 |
| per-world memos M(n, worldKey) | world evaluations | ladder | key drift (mask/pin/lockViewId/epoch); episode reset | C13; S18 regression |
| suspense capsules + prefixes | ctx.use | retry validation | lineage death; generation bump on refetch | C15 |
| K1 records (gen-tagged) | world evals; E-PRESERVE | walks; routing legs | episode bulk reset (cone carry first — I42) | T8-N |
| carrier token cells | driver push/shim bracket | classification | finally-restore; liveness fallback (I37) | C12-T/F |
| slots/interning | token mint | masks, wc, touched | recycle (swept-gated); force-clear (§5.4) | C1-X5; C13 |
| realm nonces | construction | runInBatch/scope/clone checks | n/a | clone-rejection tests |

Renumber duty list (§5.5): tape seqs/retiredSeqs, baseSeq, wc, stamps
(retireVis, lock, evaluator, committedAdvanceSeq), memo seqs, prefix fps,
lastWalk sweep, lineage-cache stamps. Every reset paired with the epoch in
worldKeys (I8); schema sweep checks the retainer table, not prose (I19).

## 16. Gates and numbers (P1–P4; nothing unmeasured asserted)

| gate | budget / comparator | status |
|---|---|---|
| G-D | DIRECT ≤ alien v3 on every tier-0 shape; 179/179 + growth stress + exact pull counts | MEASURED [ARENA]; CI symbol diff proves zero concurrency instructions |
| G-Q | LOGGED-mounted-quiet ≤2% tier-0; measured floor 2.4–3.8% [SPKHQ→O19] | AT RISK — SPK-L (idle machine) + pre-registered renegotiation to ≤3% or mitigation ladder. Instruction ledger: routing word test (1 load+cmp), staged probe (per world-path read), untracked-read taint check (1 tape/bits test, LOGGED only), re-track dep taint sweep (1 AND per dep per recompute), lockTerm (inside the entry scan), fixup fast-out (1 cmp) |
| G-W | logged write ≤2× DIRECT write | UNMEASURED → SPK-W (walkGen stamp + taint-transition propagation priced here) |
| G-N | propagate ≤2× DIRECT; ≤1 spurious render per (watcher, slot, cycle) | UNMEASURED → SPK-N1 (breaker W1 workload; held-batch row; walkGen priced) |
| G-F | R-clean mount: 0 fixup work; else ≤ \|touched ∩ live non-included\| correctives + 1 w_fx eval only when committedAdvanceSeq/lockViewId moved; 10k mount ≤15% (P1) | UNMEASURED → W2 workload |
| G-E | world-eval cost ∝ flagged region; restart-heavy typeahead; prefix/vector length; I35 re-fold cost | UNMEASURED → SPK-G8 (O18/O21; fallbacks pre-named: pinless-frontier hybrid, whole-mask clock vector) |
| G-R-core | retirement engine overhead ≤2× DIRECT `batch()` on the identical write/effect graph (user callback time reported separately) | UNMEASURED → SPK-R (breaker W5 A/B; split comparator per D12-amendment) |
| G-R-react | retirement reconciliation ≤2× equivalent useState render/commit for reached watchers | SPK-R |
| G-M/G-P1 | 0 steady-state allocs (P4); signal re-render ≤10% vs useState (P1) | harness |
| G-A | carrier unarmed ≈0%, armed ≤+15 ns/await (MEASURED I30); boot probe ≤1 ms class; shims: not installed on unarmed path (0), armed = one wrap per registration | core MEASURED; shim rows in matrix (O22) |

Cost-model compliance: eager per-write world evaluation is avoided (the
walk marks and delivers; folds are lazy — the [SYNTH §10.6] warning);
always-log is priced at G-W, not wished away (I1); the closed-kernel
boundary is free but values stay in-plane (I11).

## 17. Battery walk (every case; required format)

Notation: `{v@s, t}` = receipt (value/op, seq, token t); `TS(n)` =
touched(n) slot bits; `WT` = touched bit 31; `LV` = lock view; `vSr` =
retireVisStamp; `M(n,w)` = world memo; `cas` = committedAdvanceSeq.

### C1 — world-divergent dependency (family: core + V2–V7 + X1–X5)

(V2–V7 are the seed's required variants T2–T7, in order; X1–X5 are this
design's own divergence members: staged evaluator, union cycle, taint,
pinned-pass retention, saturation.)

**C1 core**: k flips `flag` then writes `a`; `c = flag ? a : b`; canonical
deps {flag, b}; W on c.
```
step | actor/mechanism | state
1 | k: flag.set(true) | receipt {T@s1,k}; wc[k]++; K0 flag:=true (changed); TS(flag) ∋ k; write walk K0∪K1: flag→c ⇒ TS(c) ∋ k, c K0-stale; delivery: (W,k) dedup set, setState(W) in k's lane
2 | k-world read of c (pass P_k: mask{k}, pin p) | fastPath: TS(c)≠0 → world path → evaluate M(c,w_k): fold flag=true (k), read a in-world: fold a = 0 (no receipts) → c=0; K1 records REAL k-deps flag→c, a→c; vector [(c, committedStamp)]; memo.seq = now
3 | k: a.set(1) | receipt {1@s2,k}; wc[k]++; K0 a:=1; TS(a) ∋ k; write walk: a→c exists IN K1 (step 2) ⇒ reached although a has NO canonical edge (the trap); TS(c) already ∋ k; delivery: (W,k) dedup already set AND W's k-render still pending → that render reads fresh (row 4)
4 | k render of W | world path; ladder: step 3 wc[k] > M.seq → refuse → re-evaluate: flag=true, a=1 → c=1 ✓ W renders 1 in k's lane before k commits
5 | committed world read | fold excl k: flag=false → b=0 → c=0 ✓
6 | no-early-read variant | if step 2 never happened, no k-cache exists; k's first read evaluates fresh post-s2 → 1 ✓
outcome: k-world cache invalidated by the slot clock (D9 — clocks are per-slot, immune to the "atoms with state at eval time" trap, S5); notification reached W through the REAL K1 edge; committed intact.
residual: K1 edge recording is load-bearing → SP2/E-PRESERVE fuzz + conformance C1 row.
```

**C1-V2** (k writes committed-only dep b while k-world reads a-path):
walk from b: K0 b→c ⇒ TS(c), delivery (W,k) — over-notification; k render
re-evaluates (wc[k] moved): flag=true → a=1 → c=1 unchanged → React
re-render emits equal output; committed unaffected. outcome ✓ (over-render
≤1 per (watcher,slot,cycle) — G-N bound; wrong value impossible).
residual: G-N spurious-render gate.

**C1-V3** (flag flips back; the re-track/E-PRESERVE member): k:
flag.set(false) → walk flag→c (K0 edge retained) → re-eval in k: c = b = 0
✓. E-PRESERVE half: suppose NEWEST re-track (flag=true at K0) dropped
b→c; live receipts exist ⇒ the dropped edge is mirrored into K1 (strong
reading §7.3); later k2 write to b walks the mirror ⇒ TS(c) ∋ k2 ✓. If NO
receipt existed anywhere at drop time, the drop is safe: resurrecting the
b-branch in any world requires a receipt on branching dep flag, whose own
write re-marks c and whose world evaluation re-records b→c in K1 (this
walk). outcome ✓. residual: SP2 CI fuzz gate (randomized retracks).

**C1-V4** (urgent write to b): U: b.set(9) → receipt, K0 b:=9, walk ⇒
committed-path watchers get urgent setState; U commits/retires → vSr(b),
committed c (flag=false) = 9 ✓; k-world (flag=true) reads a-path →
unchanged 1 ✓ (fold of b never consulted in k's c). outcome ✓.

**C1-V5** (urgent write to a; pending worlds include applied urgent
state): U: a.set(9)@s5 retires@s6. k's post-restart pass pin p2 > s6:
fold a in w_k: visible = {1@s2,k} (mask), {9@s5,U retired ≤ p2} → replay
seq order: 1 then 9 → a=9 → c=9 ✓. Yielded pre-U pass (pin p1 < s5):
retiredSeq s6 > p1 ⇒ excluded → resumed pass still sees a=1 ✓ pinned
world never drifts (the pass-stability requirement). outcome ✓.

**C1-V6** (slot/world-id reuse after k retires): k retires; entries
compact when `retiredSeq ≤ min(live pins)`; slot sweeps → recycle: wc[s]
zeroed at re-intern, slot gen bumps, touched bits swept at recycle. Old
memos keyed (mask∋s, pin_old, …): a new token in slot s mints entries with
seq > every old pin, and new passes hold pin > old memos' pins ⇒ no
worldKey collision (pin term differs); old-epoch survivors die at the
epoch key (C13). outcome ✓. residual: forced small-counter test (C13).

**C1-V7** (two live batches, one suspends, one commits alone): pass
P{j,k} suspends on c's k-data thenable (capsule keyed lineage L_jk);
pass P{j} (mask {j}) is a different batch-set ⇒ different lineage L_j ⇒
own memos M(c, w_j) and own capsule (if it suspends) — it doesn't (j's
world has no k-data): world path folds j-only → completes → j commits
alone; k's capsule untouched; retry of P{j,k} on settle: lineage stable →
same capsule → settled value ✓. Canonical never observes either
suspension (sentinels are per-world cached values). outcome ✓.

**C1-X1** (staged evaluator; S23/I31):
```
1 | T renders X; useComputed deps changed vs committed f_A | stage {f_B, stamp2} (case 4); lineage cache updated; F9 id attached; T pass demoted from RENDER_NEWEST to (mask{T}, pin)
2 | X reads c | stagedFor(c, T) TRUE → world path → M(c, w_T) evaluated under f_B; vector records (c, stamp2)
3 | sibling Y (same pass) reads c | same frame → same probe → same memo → same value (no intra-pass tear)
4 | urgent pass U same fiber | no stage in U's frame; probe false; TS/WT/CT govern → f_A's value ✓ two passes, two evaluators, zero shared mutation
5 | yield-gap NEWEST read | committed evaluator f_A; K0 clean → f_A value ✓
6 | T commits | F9 (hook becomes current, before folds/layout): committed := {f_B, stamp2 unchanged}; K0 node dirtied; cas bump → next NEWEST read re-evaluates under f_B ✓; discard variant: no emission; stages reclaimed at publicationsComplete
7 | same-pass restart, deps re-equal committed | case 1: committed, NO stage, no mint (L4) ✓; deps still changed: lineage cache reuse, same stamp → memos recorded under stamp2 stay valid ✓
outcome: evaluator divergence excluded at routing (probe), classification (demotion), validity (vector step 2), and promotion (K0 dirty) — the four S23 surfaces.
residual: G-Q probe ledger row; fork tests 20–23 (O23).
```

**C1-X2** (union cycle; I32): worlds record `c→d` and `d→c` (per-world
acyclic; union cyclic).
```
1 | J writes b | walk: walkGen:=++G; visit b, d, c; c's out-edge d has lastWalk==G → skip → terminate; deliveries dedup per (watcher, slot)
2 | second J write | new gen → full re-traversal (C4 re-arm semantics intact)
outcome: termination without pruning semantics; cost = one stamp+cmp per visited record (G-N/G-W).
residual: union-cycle fuzz; wrap row (C13 row 6); atomicity assert (§10.2).
```

**C1-X3** (untracked taint — judge blocker 1; I33/I17):
```
setup | c = b.state + untracked(()=>a.state); d = c*2 (tracked); K0: c=0, d=0; edges b→c→d only
1 | T writes a=1 | receipt {1,T}; NO edge from a: TS(c) unchanged (untracked must not notify) ✓
2 | U writes b=1; U render world-evals c | fold b=1 (U), untracked a folds IN-WORLD: a=0 (T ∉ w_U) → c=1 ✓ world path never consults K0's cache
3 | U retires; NEWEST pull of c | eval: b=1 tracked; untracked a: tape(a) NON-empty → epilogue sets WT(c); cache c=2, CT true; WT 0→1 PROPAGATES out-edges: touched(d) |= WT (d's cache f(c_old) may embed the same pending state — the tracked-serve leg the round-3 rule missed)
4 | sync render excluding T reads d | touched(d)≠0 (WT) → world path → M(d, w_sync): c in-world: b=1 (retired), a=0 → c=1 → d=2 ✓ (K0 would serve 4 — leak dead)
5 | cutoff horn | c′=b′+untracked(a′), d′=f(c′); base b′=5: c′ cache 5; U′: b′:=4 (bits on c′,d′); T′: a′:=1 (no edge); NEWEST re-eval of c′: 4+1=5 equal ⇒ CUTOFF (d′ not dirtied, stays CT); epilogue: WT(c′):=1; 0→1 propagation ⇒ WT(d′) ✓; U′ retires+sweeps (slot bits clear); w excl T′ reads d′: WT ⇒ world path ⇒ c′_w=4 ⇒ f(4) ✓ (fast path would have served f(5))
6 | clear race across a yield gap | pinned pass P (pin p) excludes T′; T′ retires during the gap; gap NEWEST pull of c′: compaction predicate refuses (retiredSeq > p = a live pin) ⇒ tape(a′) still non-empty ⇒ WT stays set ⇒ P's resumed reads world-route ✓ — a taint clear cannot strand a live pin BECAUSE clears require empty tapes and tapes empty only via pin-gated compaction (§5.3.2)
7 | clear, legally | P ends; compaction runs; next NEWEST pull: untracked read hits empty tape, deps untainted ⇒ WT(c′):=0; d′ clears at ITS next re-eval (dep sweep sees WT(c′)=0); until then d′ over-refuses (safe)
8 | DIRECT→LOGGED | pre-swap caches: no receipts existed ⇒ committed-only content, touched=0 correct (TAINT-COMPLETE base case); registerReactBridge inside an open eval/fold/walk frame throws (§4) ⇒ no half-instrumented evaluation exists
outcome: pending state is never observable through untracked reads in an excluding world — at the reading node, downstream through tracked serves, or under equality cutoff; temporal staleness (licensed) preserved per world.
residual: taint conservatism (a never-re-pulled node stays refused — perf only); G-Q ledger rows; the row-5 schedule is the pinned regression test.
```

**C1-X4** (pinned pass vs retirement bookkeeping; I39 horn 1):
```
setup | n = a+10 K0-clean; core effect on n; W_E (z ? n : 0), W_H (z ? a : 0) with z=false…z flips in j; transition j pass P (pin p) yields
1 | gap click, default D: a.set(1) | receipt {1@s_D>p, D}; TS(a)=TS(n)={D}; no React watcher reached (z=false) ⇒ D closes with no React work
2 | core effect flush | NEWEST read n → 11 (core effect() = NEWEST, documented C16 contract)
3 | D retires | fold: entry retiredSeq > p = live pin ⇒ compaction REFUSED; slot D unswept ⇒ slot + bits RETAINED (I10); vSr(a); cas bump
4 | P resumes; reads n, a | TS≠0 ⇒ world path: M(n,w_P): fold a at pin p → 0 → n=10; a → 0 ✓ one frame, one world (10/0)
outcome: horn 1 closed by retention — the pass's exclusion survives retirement because bits and entries outlive it (pin-gated compaction + unswept slots).
residual: retention pressure feeds X5; SPK-N1 held-batch row.
```

**C1-X5** (saturation; I39 horn 2 + docket rows):
```
1 | one yielded transition P (pin p) + input storm | 31 slots live-or-unswept
2 | new write needs a slot | internSlot exhausted → force-clear oldest fully-retired k*
3 | sweep touchedList[k*] | zero bit k* on every listed record; ENTRIES RETAINED (retiredSeq intact — retired visibility is slot-free); wc[k*] zeroed at re-intern; slot gen bumps
4 | flag passes | every live pass with pin < maxRetiredSeq(k*) gets fastPathDisabled ⇒ P world-routes everything (conservative, correct)
5 | force-clear vs open walk | impossible: force-clear runs in internSlot ⊂ write path; walks dispatch no user code ⇒ no write can occur inside a walk (§10.2 atomicity) ⇒ no walk observes a half-swept list
6 | RENDER_NEWEST pass R | unaffected: R reads K0 = newest-applied values; force-clear moves BITS, never values/entries; R's classification never consulted bits
7 | new pass after the clear | pin ≥ now > retiredSeq(k*) ⇒ k*'s entries visible via the retired clause; needs no bits ✓
8 | yielded pass Q with mask ∋ k* (k* retired mid-yield) | Q's fold: mask clause (s ∈ mask ∧ seq ≤ pin) still admits k*'s entries — entries carry the slot id and Q's pin excludes the recycled slot's NEW entries (their seq > Q.pin) ✓; Q also flagged by row 4 iff its pin predates the retirement ⇒ world-path only ✓
outcome: no crash, no tear, bounded degradation; a 32nd LIVE token is impossible (fork I10) so a victim always exists.
residual: spillover frequency unmeasured — forced test pins correctness; frequency in SPK-N1's held-batch row.
```

### C2 — flushSync excludes a pending default batch

```
1 | event: a.set(1) → default D | receipt {1@s1,D} (ALWAYS-LOG, I1); wc[D]++; K0 a:=1; TS(a) ∋ D; walk: a→c ⇒ TS(c) ∋ D; watcher setStates in D's context
2 | flushSync(setState) renders SyncLane only | pass P_s: mask ∅ (D excluded), pin p
3 | P_s reads a | TS(a)≠0 → world path → fold: D not retired/mask/locked ⇒ invisible → a=0 ✓
4 | P_s reads c | TS(c)≠0 → world path → M(c, w_s): a in-world 0 → c=10 ✓ BOTH old
5 | D renders/commits later | retirement fold → committed a=1, c=11; committed observers via touchedList[D]
outcome: matches Required — the receipt existed although the write was urgent-classified (I1), and the cone was marked at write time so no canonical cache could serve c=11 into the excluding render.
residual: the always-log price is G-W's gate; regression = this exact schedule in the conformance battery.
```
**C2-M** (mount inside the flushSync render): w_r = (∅, p); fixup: TS(c) ∋
D, D live, D ∉ mask∪LV ⇒ `runInBatch(D, setState)` — corrective in D's own
lane; D's render includes W in one commit ✓ (the I43 skip correctly does
NOT fire — D was not included).

### C3 — rebase parity

```
1 | a=1; T: update(x=>x+1) | tape empty; updater on immutable-evaluator atom: evaluate vs base → 2≠1 → APPEND {+1@s1,T}; K0 a:=2
2 | U: update(x=>x*2) | tape non-empty ⇒ append {×2@s2,U}; K0 := 4
3 | urgent render (mask{U}, pin p) | fold: base 1; T excluded; ×2 → 2 ✓
4 | U commits/retires | fold committed world: only U visible → 1×2 = 2 ✓; COMPACTION: seq-order prefix rule — s1 (unretired) blocks s2 from compacting into base (replay order preserved); s2 stays, retired-visible
5 | T renders (new pass, pin p2 > retire(U)) | mask{T} ∪ retired U → replay s1,s2: (1+1)×2 = 4 ✓
6 | T commits | fold → 4 ✓ useReducer side-by-side matches at steps 3–6
outcome: replay-in-write-order over the pre-batch base (I2); apply-and-discard is unrepresentable (K0 is newest-applied but never the fold source).
residual: differential useReducer battery; fold-frame purity (I28) pins updater replay determinism.
```
**C3-E** (plain set after pending update): T pending {+1}; U: set(5): tape
non-empty ⇒ append (no drop, I7); U-world: 1→5 ✓; T+U world and final
commit: +1 then set5 → 5 (not 6) ✓.
**C3-R** (staged reducer; I38): as §11.1: T dispatches A under committed
r0 (always-append — stageable atom, no drop even on empty tape); K0 newest
= r0(0,A) = 1; urgent React-only render stages r1 and commits → F9 BEFORE
folds: committed := r1 (stamp installed unchanged); pending receipts ⇒
re-fold NEWEST under r1 → 10; ordinary walk+reconcile+effect flush in the
committing context → NEWEST readers see 10 ✓ one newest, one value; T's
later render folds A under committed r1 (or its own stage if it staged) →
10 ✓; fold-before-publication is unrepresentable (fork test 23).
**C3-M** (multi-root + saturation):
```
1 | ra committed r0; T_A locked to A {act@s1}; T_B locked to B {act@s2} | two lock views, two watermarks
2 | A's commit stages+publishes r1 (F9) | install stamp; dirty K0; cas bump; re-fold NEWEST under r1; walk+reconcile+flush ✓
3 | same commit's due retirement folds | run AFTER F9 (I38c) ⇒ fold under r1 ✓
4 | B's later commit | committed-for-B fold: s1,s2 per B's view under committed r1 (promotion is global-committed; commits serialize on one thread) ✓ no r0/r1 mix
5 | B's stale committed-for-B memos | evaluator vector mismatch (r1 stamp) ⇒ ladder step 2 refuses ✓ (B's lockViewId unchanged — the vector, not the key, catches it)
6 | promotion during saturation | promotion walk uses EDGES (K0∪K1), not slot bits ⇒ unaffected by force-clear sweeps; fastPathDisabled passes world-route and fold under effStamp (staged-else-committed) ✓; force-clear moved no entries ⇒ folds unchanged ✓
outcome: F9 ordering is per-commit and commits are serialized; the vector catches cross-root staleness.
residual: fork tests 20–24; differential swap-with-pending rows.
```

### C4 — two-batch write into an already-stale region

T1 writes a ⇒ walk ⇒ (W, slot(T1)) dedup set, setState in T1's lane. T2
writes a before any re-render ⇒ new walk (new walkGen) ⇒ (W, slot(T2))
clear ⇒ setState in T2's lane ✓ (dedup is per-(watcher, slot), I5 — never
once-per-staleness). W renders in each lane; dedup bits re-arm at render.
outcome ✓. residual: G-N grid; walkGen does not change dedup semantics
(C1-X2 row 2).

### C5 — cutoff-suppressed first write, effective second write

k writes a=1 (c's value unaffected: c = a*0 + b): delivery is VALUE-BLIND
(D13) ⇒ setState (W,k) fires anyway (≤1 spurious render — priced, G-N);
memo for w_k refused via wc[k] ⇒ re-eval → same value; if W renders here,
output equal. k writes b=7: if W already re-rendered, dedup re-armed ⇒
fresh setState in k's lane; if not, the pending k-render reads the CURRENT
k-world (wc[k] moved again ⇒ ladder refuses ⇒ re-eval) → 7-based value ✓.
Cache-validity never serves the first evaluation (slot clock). outcome ✓
— the trap (marks that stop walks + armed bits) is structurally absent:
nothing value-gates delivery, and validity is clock-based. residual: G-N
spurious-render bound; D13 pins the rule.

### C6 — lane attribution under grouped notification

Resolution: **handled** — no implicit grouping exists anywhere (D10).
`batch(() => { a.set(1); startTransition(() => b.set(2)) })`: engine
`batch()` defers only core-effect flushing. a.set(1): F1 says ambient
event batch (urgent) ⇒ delivery NOW in the urgent context. b.set(2)
inside the transition scope: F1 says transition token ⇒ delivery NOW in
transition context ⇒ watcher setStates inherit the transition's lanes;
one transition commit carries b's cone ✓. Engine-batch close: core
effects flush reading NEWEST (documented). No user-visible grouping was
forbidden; per-write context is preserved by construction (per-write
synchronous delivery). outcome ✓. residual: conformance row: mixed-context
batch; core-effect flush timing row (R13 benchmark integrability).

### C7 — writes and reads during a yielded render pass

```
1 | transition pass P (mask{T}, pin p) yields | F2 passYield ⇒ callstack truth: not-in-render
2 | click handler reads a.state | NEWEST (K0, newest-applied — includes T's applied write) ✓ newest world, not the pin
3 | handler writes a.set(x) | no throw; F1 classifies into the click's batch U; receipt {x@s,U} ✓
4 | P resumes | folds honor (mask{T}, pin p): U's seq > p ⇒ excluded; even if U retires mid-yield, retiredSeq > p ⇒ excluded ✓ pinned world stable
outcome: per-callstack render truth (I6/S7); the pass's world cannot drift (pin + retained bits, C1-X4).
residual: fork tests 7–10 (yield edges); wall-clock-scope regression test.
```
**C7-D** (RENDER_NEWEST + gap write): the write path demotes open
RENDER_NEWEST passes to their captured (mask, pin) BEFORE appending the
first receipt ⇒ the demoted pin < s ⇒ excluded ✓. Staging demotes only its
own pass (stages are pass-local; other RENDER_NEWEST passes correctly see
committed evaluators via K0) ✓.

### C8 — equality drops must not lose receipts

a=0. T: set(1): tape empty, plain set, 1≠0 ⇒ append. U: set(1): tape
NON-empty ⇒ **always append** (I7) {1@s2,U}. U's render (excl T): base 0 +
U's set 1 → 1 ✓. T truncation does not exist (C17); T abandonment =
retirement fold (D2) — either way U's receipt independently commits 1 ✓.
Two overlapping transitions writing 1: both append; every world folds to
1; committed 1 ✓. Legal drop walked: quiescent tape-free a.set(0) (equal,
world-invariant op) ⇒ dropped — safe because with no history every
world's fold is identical (I7's construction). Stageable ReducerAtoms
never drop (I38a; C3-R row E schedule pinned). outcome ✓. residual:
C8 conformance rows incl. the reducer-drop regression.

### C9 — mount mid-transition (existing and fresh nodes)

```
(a) existing computed c, mount inside k's own pass P_k (w_r = mask{k}, pin p, LV_r)
1 | render read | TS(c) ∋ k ⇒ world path ⇒ M(c, w_k) ⇒ k-world value on FIRST render ✓ no canonical leak
2 | layout fixup | loop: t=k live, slot ∈ w_r.mask ∧ wc[k] ≤ p ⇒ SKIP (I43 inclusion+clock — no runInBatch, no double render)
3 | fast-out | cas ≤ p ∧ lockViewId unchanged ⇒ return — zero extra work ✓
(b) fresh node (useComputed created this render)
4 | first evaluation | no cache ⇒ CT false ⇒ fast path impossible (I12: fresh evaluation is never a legal serve) ⇒ world-path eval directly in w_k; K1 edges recorded; touched inherited from deps via edge-add propagation; staging: no committed evaluator ⇒ stage {f, stamp} + F9 id
5 | fixup for (b) | same as rows 2–3 ✓ one render total
(c) in-window commit-side motion
6 | k retires AT this commit (its own commit) before layout | loop: k not live ⇒ no corrective; fast-out fails (cas moved); v_fx: k's writes visible via the RETIRED clause; v_fx = v_r (same values through a different clause) ⇒ isEqual ⇒ NO fire ✓ still one render
7 | unrelated D retired in the window | v_fx = w_r's mask at p ∪ retired-now ⇒ difference exactly D's writes ⇒ FIRE urgent pre-paint setState toward the fast-forwarded world ✓ (the I18 fallback; no contradiction with row 2 — no suppression rule exists to contradict, L2)
outcome: both reads resolve in the pass's world on first render; included tokens never double-render; committed-side in-window motion corrects pre-paint.
residual: fixup-window battery (included, retired-in-window, mixed rows); G-F fast-out ledger.
```

### C10 — late subscription joins the pending batch

```
1 | k writes a; W not yet mounted | receipt; walk marks cone; no watcher record yet
2 | urgent pass mounts W on c-over-a (w_r excludes k) | TS(c) ∋ k ⇒ world path ⇒ committed value ✓
3 | layout: subscribe, then fixup | loop: k live, slot(k) ∉ w_r.mask∪LV ⇒ fork.runInBatch(k, setStateW) — the corrective joins k's OWN lanes (F4). A fresh startTransition would mint a new token/lane set React never entangles with k ⇒ could commit separately (torn) — that is why F4 exists
4 | k's render | includes W ⇒ k-world value ⇒ ONE commit with k's updates + W's correction ✓
5 | race (i): k retires in the render→layout window | loop sees no live k; fast-out fails (cas moved) ⇒ v_fx (retired ∋ k) ≠ v_r ⇒ urgent pre-paint setState ✓ (the mandated fallback)
6 | race (ii): k's pass already completed when the corrective lands | F4 obligation: work inserted after completion schedules new work (fork test 18/19) ⇒ k re-renders including W before its commit ✓
outcome: exactly one commit in the normal path; both races close with the named mechanism.
residual: fork tests 18/19; the fixup-window battery.
```

### C11 — multiple roots (declared scope: FULL spanning support)

```
1 | batch k spans roots A and B | writes marked; both roots' watchers delivered in k's lane
2 | A commits k first | F3 lock-in: LV_A re-minted {(k, watermark=p_A, lS1)}, new lockViewId; cas bump; committed-for-A re-keys
3 | later urgent render on A | world: retired ∪ LV_A(k ≤ watermark) ∪ mask{U} ⇒ k's writes included ⇒ A never contradicts its own DOM ✓
4 | A's passive effects post-commit | evaluate committed-for-A ⇒ observe k's values (token not fully retired) ✓
5 | B pending | committed-for-B has no k ⇒ B's urgent renders exclude k ✓ per-root self-consistency both sides (cross-root skew is permitted by the case)
6 | B commits | LV_B gains k; k now fully committed ⇒ F3 retires EXACTLY ONCE ⇒ folds, vSr, lock records cleared after stamps exist ✓
outcome: full spanning walked at the declared scope; a single global "committed" world never exists (per-root views).
residual: fork tests 15–17 (O7 — per-root facts need the current-generation existence proof; critical path).
```
**C11-W** (watermark = write-prefix, I25): parked action k committed on A
at p1; post-await write s9 > p1 ⇒ lock clause fails ⇒ invisible to
committed-for-A until a later A commit advances the watermark ✓ no leak
before any commit carries it.
**C11-A** (advance observers + the yielded-pass docket row):
```
1 | action T: a.update(+1)@s1; A commits {T} at p1 | LV_A v1 (T, p1, lS1); effect E sees 1; snapshot fp incl lockTerm=lS1
2 | post-await a.update(×2)@s2 (parked) | write-time queue notes E (fast path)
3 | urgent U: a.update(+100)@s3 commits+retires on A | vSr(a); committed-for-A = (0+1)+100 = 101; retirement flush enumerates touchedList[U] ∋ E (durable) ⇒ E re-runs → 101 (queue entry consumed — irrelevant, S26 dead)
4 | A renders T's s2 at p4; commits | F3 ADVANCE: LV_A v2 (T, p4, lS2) — new id, new stamp (every advance mints, I34); cas bump; fold = ((0+1)×2)+100 = 102 → DOM 102
5 | passive flush at this commit | lock-advance trigger enumerates touchedList[T] ∋ E; E's fp: lockTerm lS1→lS2 moved ⇒ re-run → 102 ✓
6 | committed-for-A memo from step 3 | worldKey holds v1 ≠ v2 ⇒ unreachable ⇒ fresh fold ✓
Y | yielded same-root pass across step 4? | impossible: F2 serialization — a same-root commit implies the WIP pass ended (React discards + restarts; never resumes across its own root's commit); the committing pass ends AT the commit. Cross-root: B's open pass keeps ITS captured LV_B; A's re-mint touches neither B's fp terms (lockTerm scans only the world's own view) nor B's worldKeys ⇒ no cross-root starvation (I34 root-scoping) ✓ fork test 24
outcome: every advance is a stamped, durably-flushed, re-keyed visibility flip; captured views stay coherent for exactly as long as a pass can live.
residual: fork test 24; per-advance re-mint cost (≤31-entry pooled record per commit-with-lock-change) in G-R ledger.
```

### C12 — store-only transitions persist (+ C12-U/T/F)

```
1 | startTransition(() => a.set(5)), no subscribers | receipt {5,T}; no watchers ⇒ no React work ⇒ F3 closes T committed=false ⇒ SAME retirement path (D2): fold ⇒ committed 5 ✓
2 | async action: a.set(1); await io(); a.set(2) | T parks on the returned thenable (F3/I26); set(1) receipt; continuation carries T (I30 transform); set(2): carrier live-parked ⇒ receipt under T; io settles ⇒ action settles ⇒ retire ⇒ fold 1,2 ⇒ committed 2, not before settlement ✓
outcome: persistence never depends on subscription (D2/S4); timing exact (parking).
residual: fork tests 11–13; boot self-test (transform verification, D17).
```
**C12-U**: flushSync render mid-action excludes T ⇒ reads 0 ✓ (I1).
**C12-T** (host scheduler + docket rows):
```
1 | action T: await new Promise(res => setTimeout(async () => { a.set(1); res() }, 0)) | —
2 | setTimeout called while currentToken = T | SHIM: registration under non-null token ⇒ callback bracketed with T
3 | timer fires on a bare stack | bracket: liveness(T) = parked-live ✓ ⇒ push T; async cb's driver instantiates under T
4 | a.set(1) | carrier ⇒ T ⇒ receipt parked ✓ (was: ambient default, early commit — S25 dead)
5 | res(); gate settles; T retires; fold commits 1 | C12 timing exact ✓
6 | liveness race: T settles while the timer is queued | bracket at fire: liveness FAILS ⇒ push nothing (ambient) + dev warn ("continuation outlived its action", I37) ⇒ write lands in its own default batch — React parity ✓
7 | nested registration inside the bracketed cb | currentToken = T (pushed) ⇒ inner setTimeout wraps with T; recursion sound; at any depth a retired T degrades ambient+warn uniformly ✓
8 | MessagePort (L5) | port.onmessage registered at boot (token null) ⇒ never wrapped — the registration rule itself; postMessage inside T ⇒ handler runs bare ⇒ armed ∧ carrier-null ⇒ ambient + DEV WARN; documented boundary; AsyncContext rung has the same event semantics (registration snapshot) ⇒ rung-uniform; precise escape: ActionScope.set/dispatch (generation+liveness-checked) ✓
outcome: clause (iii) of the carrier induction holds on the enumerated shims; the residual class is enumerated, detected (dev warn), and rung-uniform — never silent.
residual: shim coverage matrix (O22, fork/build test 25); rung 1 erases the in-app class.
```
**C12-F** (fire-and-forget child; I37): child driver captured T (invoked
under T); outer settles ⇒ T retires (exactly once, fold commits) ⇒
childGate resolves ⇒ child driver pushes T ⇒ liveness fails ⇒ ambient +
dev warn; child's write lands in its own default batch (React parity for
a late un-awaited setState) ✓; pre-settlement variant: parked-live ⇒
attributed to T ✓. Never intern, never crash, never contaminate; fork
test 26.

### C13 — counter/world-id lifecycle soundness

Walked against the §15 master table; forced-small-counter and wraparound
tests per row:
```
1 | quiescence → episode reset | renumber duty list rewrites every retained seq/stamp; epoch bump ⇒ every worldKey/capsule from ep1 mismatches in ep2 ✓
2 | K1 bulk reset | cone carry first (T8-N); K1 record generations bump ⇒ stale ids cannot validate ✓
3 | mid-episode slot recycle | wc zeroed at intern; bits swept; masks disambiguated by pin (C1-V6) ✓
4 | lock views | pooled, gen-bumped before reuse; stale lockViewId in any key ⇒ mismatch ✓
5 | vSr/lockStamp/cas | renumber rewrites; all minted from the one globalSeq line (I15) ✓
6 | walkGen wrap | renumber sweep zeroes lastWalk; next walk fresh; forced-wrap test ✓
7 | publication serials | generation CAS + publicationsComplete sweep (fork test 22) ✓
8 | lineage stage cache | dies at lineage death; stamps renumbered; lineage ids fork-minted fresh per episode (F5) — no cross-episode reuse ✓
9 | saturation | entries survive force-clear with retiredSeq intact; recycled wc zeroed; fastPathDisabled dies with its pass ✓
10 | carrier tokens | retired tokens are never re-interned (I37 fallback) ✓
outcome: every counter names its guard; the retainer audit is the §15 table checked by schema sweep (I19), not prose.
residual: forced-wraparound suite; invisibility test (whole conformance suite inside a synthetic episode).
```

### C14 — StrictMode and replayed renders

```
1 | double-invoked render | world reads hit the same memos (pure); K1 edge adds idempotent; no observable graph mutation across the discarded twin ✓
2 | render-phase write | frame ⇒ throw (all builds) ✓ no double-fired writes
3 | double-mount effects | microtask-debounced observed 0→1/1→0 nets one subscription (R1) ✓
4 | staged evaluator, second invoke | deps equal the pass frame ⇒ reuse (case 2) — same stamp, idempotent ✓
5 | discard + remount replay | deps equal committed ⇒ case 1, NO stage, no mint (L4 — oscillation dead); deps genuinely changed ⇒ lineage cache reuse (case 3), same stamp as the discarded pass ⇒ memos/prefixes recorded under it stay valid ✓
6 | thenable identity | lineage-positional capsules; same lineage across replays (F5) ⇒ same thenable per world ⇒ React retries settle, never re-suspends forever ✓
outcome: replays are idempotent at every stratum (memos, stages, capsules, subscriptions).
residual: StrictMode rows in the react-concurrent-store harness; C14 conformance family.
```

### C15 — suspense across worlds

```
1 | transition k: c suspends on k-world data | capsule (lineage L, position) minted lazily; prefix records [(a, fp, reducerEffStamp?, vRef)…, (upstream computeds, effStamp)]; pass suspends via React use protocol
2 | component mounts mid-transition reading c | same root × batch-set ⇒ same lineage L ⇒ SAME capsule/thenable ⇒ consistent suspension; canonical world never evaluates the k-capsule (per-world memos; sentinels are cached values) ✓
3 | promise settles; React retries | new pass, same lineage; staging: deps equal ⇒ same effStamps (L4/I40) ⇒ prefix pairwise-equal ⇒ settled value consumed ⇒ render completes ✓ (S24 livelock dead)
4 | k commits with the settled value | ✓
5′ | cross-batch retirement touched a prefix atom | vSr moved ⇒ fp mismatch ⇒ re-fold in THIS world ⇒ value changed ⇒ drop ≥ position, refetch from the moved world (generation-bumped) ✓ I20/I21
5″ | content-neutral flip (lock→retired handover; equal-value churn) | fp moved ⇒ re-fold ⇒ isEqual TRUE ⇒ re-stamp in place ⇒ settled resource kept — no duplicate fetch, no starvation (S31 dead) ✓
5‴ | staged reducer through the prefix (the I35 hole, closed by L3) | P1 recorded (ra, fp, r0-stamp, v); P2 stages r1: position check: reducer effStamp r1 ≠ r0 ⇒ content change ⇒ drop + refetch folded under the staged r1 ✓ (fp alone would NOT move — round-3's rule served the stale capsule); P2's next retry: effStamp equal ⇒ reuse ✓
6 | worldKey for multi-batch passes | lineage id per (root × batch-set) — D11; single tokens, mask∪locked, and passSerial keys remain dead (drift/churn/refetch-forever)
outcome: identity = lineage; validity = receipt-line content with value revalidation; evaluator/reducer identity rides the same vector as memos (L3).
residual: prefix length + re-fold cost (O21/SPK-G8); purity pins determinism (C14 row 1).
```

### C16 — effects observe committed state only

```
1 | default D applied-not-committed: a.set(1) | receipt; K0 a=1
2 | unrelated retirement flushes useSignalEffects | effect e evaluates committed-for-root: D not retired/locked ⇒ a=0 ✓ excluded
3 | D commits | fold; vSr(a); touchedList[D] ∋ e ⇒ e re-runs ⇒ sees 1 ✓
B1 | older entry becomes visible beneath a visible max (retirement/lock flip) | vSr/lockStamp minted at the flip ⇒ snapshot fp moved ⇒ re-run (I21/I34) ✓
core | core effect() contract | NEWEST, documented: it observed a=1 at step 1's flush (C1-X4 row 2) — stated, walked, conformance-pinned
outcome: two effect contracts, both stated and mechanically distinct (world fold vs K0 read).
residual: C16 conformance rows; effect fast-out (cas) must never suppress a moved-fp re-run (test).
```
**C16-D** (deps change): React's native effect re-fire at its own commit
re-runs, re-reads, re-subscribes (D18); later writes reach the new
subscription via the ordinary walk ✓. No F9 involvement (a staged-effect
path would leave the new dep edge-less — the S28/BCX-3 grave).

### C17 — optimistic rollback

No truncation surface exists (closed by deletion — React batches never
truncate; D2 folds committed=false batches). A public-API snapshot test
forbids accidental export of any truncation affordance. Optimistic UI
composes from separate atoms + actions (documented pattern). outcome:
case discharged by interface restriction, detection = API surface test.

### T8-N — quiescence refresh with cone carry

```
1 | quiescence: no live tokens/pins/parked actions | refresh set = K1-touched nodes with committed watchers or effect-dep snapshots: K0 NEWEST pull each ⇒ committed basis edges restored in K0 (the reach induction's basis premise, I27)
2 | node w's refresh WRITES (R8-legal) twice | exempt w; carry its FULL reverse-reachable K1 cone (both endpoints of every in-edge path: x→u, u→w) into the next episode (I42; direct-in-edge carry loses x→u — S30's schedule, dead)
3 | episode reset | epoch bump; K1 cleared except the carried cone; counters renumbered (C13)
4 | ep2: k writes x | walk follows carried x→u→w ⇒ watcher delivered in k's lane ✓ no tear
5 | termination | rank Σ(2−strikes) strictly decreases per failed sweep; fixed observed set resets in ≤2N+1; unbounded new observed work is the ordinary loop budget's domain, not quiescence's
outcome: exemption preserves the induction; cone finite, traced, dev-warned on growth.
residual: cone-size soak; permanent-writer retention (known gap G3).
```

## 18. Rejected / deleted (this round's negative space)

- The standalone WORLD_TAINT column + fifth routing conjunct (L1 — merged
  into touched bit 31; the separate column had no propagation story and
  its conjunct was the blocker).
- The fixup suppression predicate and its "allExplained" universal (L2 —
  vacuously wrong on retire-race; replaced by the w_fx world definition).
- reducerStamp as a fingerprint term (L3 — it now lives once, in the
  evaluator vector).
- Lineage-cache-first staging comparison (L4 — minted stamps for
  committed-identical state; committed-first kills the class).
- The MessagePort shim (L5 — provably a no-op under its own registration
  rule; the class is documented boundary, uniformly with AsyncContext).
- lastRetireSeq as a diagnostics-only counter (L6 — repurposed as
  committedAdvanceSeq or it would have been deleted outright).
- Any walk-reentrancy machinery (L7 — atomicity is proved instead).
- A special promotion-delivery path (L8 — ordinary fold/walk/reconcile).
- Carried from prior rounds (still dead, with their scars): per-token
  equality-filtered corrections (S10), value-based delivery suppression
  (S16/D13), pinless shared memos (S18), global retirement clocks in
  identity keys (S20), promise-patching carriers (S22), evaluator-blind
  fast paths (S23), per-pass stamps in retry keys (S24),
  invocation-time-only capture (S25), consumable-queue-only triggers
  (S26), write-time drops for stageable ops (S27), effect-grain/unordered
  publication (S28), retirement-time column clearing and unbounded
  retention (S29), in-edge-only carry (S30), stamp-move⇒refetch (S31).

## 19. Known gaps (all declared; none hidden)

- **G1 (O19).** LOGGED-mounted-quiet floor 2.4–3.8% [SPKHQ] vs the ≤2%
  gate — SPK-L on an idle machine decides; pre-registered renegotiation to
  ≤3% or the mitigation ladder. A requirements decision, not a defect.
- **G2 (D17/O22).** Uncompiled vendor post-await writes and unshimmed
  registrars (incl. MessagePort — L5) misattribute to their ambient batch:
  sound, bounded, dev-warned, boot-tested; erased at rung 1. The support
  matrix is the contract.
- **G3.** Permanent-writer refresh exemptions retain their cones across
  episodes (dev-warned growth; soak-tested; T8-N row 5's budget bounds the
  blast radius, not the retention).
- **G4 (O12/O21).** Unmeasured hot-path numbers: value-blind fan-out
  (SPK-N1), logged-write price (SPK-W), restart-heavy world evaluation +
  prefix/vector length + I35 re-fold cost (SPK-G8), dense retirement
  (SPK-R), E-PRESERVE validator cost (SP2). Each has a pre-named fallback
  (D13 per-slot-mark dedup; whole-mask clock vector; O18 pinless-frontier
  hybrid) — adopted only on gate failure.
- **G5 (O7/O23).** Fork-side per-root facts and the F9 publication edge
  have no current-generation React existence proof — fork tests 15–17 and
  20–24 are on the critical path before any milestone exit.
- **G6.** Taint conservatism: a tainted node that is never re-pulled at
  NEWEST world-routes forever (correct, slower); untracked-heavy graphs
  pay G-Q's taint rows. If SPK-L attributes measurable cost to taint
  checks, the enumerated mitigation is compile-time splitting of untracked
  call sites (twin-build), not a semantics change.
- **G7.** Saturation spillover frequency (forced tests pin correctness;
  frequency rides SPK-N1's held-batch row).
- **G8.** Multi-root spanning commits interleaved with saturation and
  promotion are walked (C3-M, C11-A, C1-X5) but the combinatorial forced-
  test matrix is large; the randomized replay oracle (D6) is the
  backstop, built before the machinery it checks.

No unwalked cases: C1–C17 and T8-N are all walked above at the declared
scope (C11 = full spanning; C17 = discharged by deletion).

---

*Consolidate-a complete. 9 mechanisms (was 10 — L9 itemizes the merge); 9
fork facts / ~16 reconciler sites / 28 fork-build tests; both judge
blockers closed by DELETE/MERGE (L1, L2); every round-4 docket attack
re-derived with its resolution mapped in §0; zero new mechanisms — every
repair reuses existing machinery (touched-word bits, mark propagation,
world folds, the evaluator vector, F2/F4 fork facts, committedAdvanceSeq's
existing counter) or deletes machinery (suppression predicate, MessagePort
shim, duplicate reducer stamps, oscillation mints).*
