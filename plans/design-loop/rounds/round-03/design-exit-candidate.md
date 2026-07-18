# Round 3 — exit candidate: the two-kernel champion, build-complete

Stance: **exit-candidate**. This document inherits the round-2 champion
(D12: `rounds/round-02/synthesis.md`, itself the round-1 champion lineage
D8 with repairs R1–R15 + T8-N) and produces the exit-quality artifact. The
judge sustained the champion with zero confirmed blockers; SP-F8 resolved
FEASIBLE (I30). Accordingly this round changes **as little substance as
possible**: one substantive integration (the async-transform build surface
that I30 makes a prerequisite), two clarity repairs the judge billed
(one-page story, audit-table consolidation), and a full self-contained
re-walk of the battery. Everything else carries forward unchanged.

## Round-3 delta log (audit line; each substantive change carries a walk)

- **X1 (substance — the only one).** Fork fact F8's continuation carrier
  gains its **build-prerequisite surface** per I30/O20: the async-transform
  spec (§12.1–12.2), the AsyncContext feature-detect ladder (§12.3), the
  loud boot self-test re-specified as a *build* verifier (§12.4), the
  **mixed compiled/uncompiled boundary semantics** — detection limits, the
  documented misattribution bound, and the dev warning (§12.5) — and the
  support-matrix line (§12.6). Walks: C12′ (re-walk, unchanged outcome) and
  **C12-U (new)**. Fork test 19 added; gate **G-A** added with I30's
  measured numbers. No other mechanism moves; the carrier's *runtime*
  semantics (I26, D15) are exactly the champion's.
- **X2 (clarity).** §1 rewritten so the one-page story honestly carries the
  round-2 repairs: visStamps, staged evaluators, retroactive edge-add
  delivery, watermarked lock-in, quiescence refresh (judge explainability
  nit).
- **X3 (clarity).** Lifecycle/validity/mechanism audit tables consolidated
  into one master state inventory (§15.1) cross-keyed to the mechanism
  inventory (§19) and the validity table (§8.1) (judge mechanisms nit).
- **X4 (completeness).** Every battery walk written out in full. The
  round-2 synthesis compressed unchanged walks to citations of its base
  text; an exit artifact must stand alone. Re-walking produced **no new
  findings**; where a walk states a mechanism more precisely than the
  champion's compressed line, the precision is flagged in place.

---

## 1. One page: the whole concurrency story

**The bet (D8).** Keep the fastest known single-world kernel byte-for-byte
for the common case, and give concurrency its own structures *beside* it —
a write log for values, a second edge plane for topology — instead of
threading world-awareness through the hot walks (D4, I9). Two builds:
DIRECT is the donor kernel unchanged — zero concurrency instructions (P3);
registering the React bridge swaps the op-table to LOGGED once,
monotonically, never keyed to watcher count (S6); all state survives.

**One value truth plus receipts.** K0 (the canonical kernel) always holds
the newest value of every atom. In LOGGED mode every write — urgent
included (I1) — passes a guard (throws inside render, world-eval, and fold
frames; first demotes any pass that was reading K0 directly to its real
world — R3), appends a receipt {op, batch-slot, seq} to the atom's tape,
applies to K0 with stepwise equality (old reference kept on equal), and
walks. A world's value is a fold: base + visible receipts replayed in seq
order, the atom's own equality applied stepwise (I2/I29). Visibility is
React's lane math verbatim (D3): retired-by-my-pin, OR in-my-mask-and-
≤-my-pin, OR **locked into my root up to that slot's watermark** — the
watermark (R13) is the committed pass's pin, so an async action's
post-await writes never leak into a root that committed an earlier prefix
(I25). All stamps mint from ONE monotone counter (I15).

**Worlds route reads.** Pass code reads through its (mask, pin) world;
everything else reads K0/NEWEST. The router serves K0's cache to a
non-newest world only when no live batch's influence cone has ever touched
the node (`touchedSlots == 0`) AND no recompute is needed (I12) — a fresh
recompute could acquire a divergent dep through an edge nobody recorded
(S9). Otherwise the read folds atoms and evaluates computeds into
per-(node, worldKey) memos, recording that world's REAL dependencies as
edges in **K1** — the structural answer to C1: the killer schedule's `a→c`
edge exists in K1, so the next write to `a` walks straight to the watcher.

**Notification is per-write, in the writer's stack, value-blind.** Each
write walks K0∪K1 from the atom and calls each watched component's
setState right there, so React assigns the writer's own priority (D5);
per-(watcher, slot) dedup re-arms at render (C4); no grouping anywhere
(D10); no value suppression anywhere (D13/S16). When a world evaluation
records a **new** edge, the edge-add propagates the writer-slot marks down
the node's existing out-edges AND **retroactively delivers** those slots'
setStates through the new edge (`runInBatch` per slot bit — I23): flags
route reads, deliveries schedule React, and both must flow or a bailed-out
render commits a tear (the HX-3 schedule).

**Validity is a closed enumeration (§8).** Every cached world answer
(memo, effect snapshot, thenable prefix) names every source that can
change it: per-slot write clocks (D9); retirement folds; **visibility
flips** — a per-atom `visStamp` minted whenever retirement or per-root
lock-in makes an *older* receipt newly visible, because a max-of-seqs
fingerprint cannot see below its max (I21); **evaluator identity** — a
hook's new fn/deps **stages per pass** and promotes only at that hook's
own commit effect, so no other pass, no NEWEST read, and no discarded
closure is ever evaluated (I22); thenable settlement; episode epochs.

**Suspense** keys thenables by fork-minted lineage (D11) and validates by
content: the flattened (atom, fingerprint) prefix of reads before the
position — retry-stable by purity, moved exactly by included writes and
visibility flips, indifferent to unrelated retirements (I24).

**Async actions.** Identity comes from a continuation carrier: the action
token is captured at async-resource creation, pushed before every
continuation, finally-restored (I26). It is feasible and **measured**
(I30): app code compiles every async function twice — native body when no
action is live (≈0% overhead, inside noise), token-carrying driver while
one is (+12 ns/await) — behind one null check; when AsyncContext ships,
the ladder drops the twin build. A **loud boot self-test** verifies the
transform; untransformed third-party async code writing signals inside an
action is a *documented, bounded* misattribution — the write lands in its
real ambient batch: logged, sound, never lost, never torn, merely earlier
than action semantics — dev-warned (§12.5, walk C12-U).

**Lifecycle.** Retirement folds only the all-retired prefix of each tape
(pin-blocked atoms drain when passes end — R9), mints visStamps, notifies
committed-world observers through its own path (I14), and clears every
mask/bit/watermark it owns before slot recycle (I19). At quiescence,
before K1 resets, every K1-touched node that committed state still watches
is **refreshed** — K0-pulled at NEWEST so its true basis edges live in K0
for the next episode (T8-N): the reach induction's premise is
re-established at every episode boundary.

**Numbers.** DIRECT = donor bytes ([ARENA]: at-or-below alien v3, tier-0,
179/179); LOGGED-quiet floor measured 2.4–3.8% vs the ≤2% gate — pre-
registered renegotiation (O19/SPK-L); carrier ≈0% unarmed, measured (I30).
Everything else unmeasured is a spike (§16), never a claim.

---

## 2. Ground rules inherited (one paragraph each, binding)

- **D1/I1 always-log**: LOGGED appends a receipt for every write; DIRECT
  executes zero concurrency instructions. Activation monotonic (S6).
- **D2 no drop-on-abort**: committed=false batches fold at retirement;
  persistence never depends on subscription (S4).
- **D3/I2 React's visibility/rebase semantics**: replay-in-write-order over
  the pre-batch base; any mechanism must reproduce the seed math.
- **D4 closed kernel**: no per-link world state in K0's hot walks; world
  state lives in separate structures (tape, K1, columns).
- **D5/D10/D13 delivery**: setState synchronously in the writer's context;
  per-write; no implicit grouping; value-blind with per-(watcher, slot)
  dedup only.
- **D6 process apparatus inherited**: oracle-first, frozen-kernel contract
  suite, bytecode budgets, pre-registered experiments, numeric exit gates.
- **D7 co-designed fork**: protocol facts in §14; charter axes scored.
- **D9 validity = clocks + epochs, no per-read certificates** (extended by
  the closed change-source set, I16).
- **D11 suspense key = fork lineage id** (+ content validity, I20/I24).
- **D14/D15/D16**: fold reads throw in all builds; F8 = carrier + parking
  with loud self-test; reducer staging + `ctx.previous` three-way rule +
  lazy `ctx.use`.

## 3. Concepts (plain English, before use)

- **K0** — the canonical kernel: the donor arena (one Int32Array plane,
  stride-8 interleaved node+link records, packed value side column,
  premultiplied ids, DEPS_TAIL re-track cursor, iterative walks, split
  link fast path). Holds every atom's NEWEST value and the newest-basis
  topology. Closed and monomorphic (D4); CI bytecode budgets.
- **DIRECT / LOGGED** — the twin engine builds. DIRECT = donor
  byte-for-byte. LOGGED adds the guard, tape, routing, walks. One
  generated source; op-table swap at `registerReactBridge()`.
- **receipt / tape** — per-atom append-only log entry {op, slot, seq,
  retiredSeq}. `op` is the set value or updater/reducer action. The tape
  plus `base`/`baseSeq` (folded floor value and its max folded seq)
  reconstruct any world's value.
- **globalSeq** — the ONE monotone counter (I15). Mints write seqs, pins,
  retirement stamps, visStamps, fnStamps, epochs.
- **token / slot / mask** — a batch's fork-minted integer identity (F1),
  never reused live; ≤31 live (I10) → interned to a 5-bit **slot**; a
  world's included batches form a 32-bit **mask**. `slotWriteSeq[slot]`
  (write clock, D9) bumps on every write in that slot.
- **pin** — a pass's globalSeq snapshot; the pass sees no seq above it.
- **world / worldKey** — an assignment of values to all atoms, defined by
  (mask, pin, root-lock variant, episode epoch). **NEWEST** = K0's values.
  **committed-for-root(r)** = retired ∪ locked-into-r (watermarked).
  **RENDER_NEWEST** = a pass whose world currently equals NEWEST, served
  from K0 directly; revocable (R3).
- **lockedIn(root)** — per-root set of (slot, **watermark**) pairs; the
  watermark is the pin of the pass whose commit locked that slot on that
  root, advanced at each later commit of the slot there (R13/I25).
- **visStamp(a)** — per-atom stamp minted from globalSeq at every
  retirement fold touching `a` and at every per-root lock-in of a slot
  holding entries of `a` (I21). Joins the fingerprint max.
- **fingerprint** — `fp(atom, w) = max(newest w-visible entry seq,
  baseSeq, reducerStamp, visStamp)`; the atom-grain validity fact.
- **world memo** — `M(node, worldKey)` cached world evaluation with states
  EMPTY/EVALUATING/DONE (EVALUATING read ⇒ R7 cycle throw).
- **K1** — the second edge plane: REAL per-world dependency edges recorded
  by world evaluations, union across worlds, add-only until quiescence;
  record ids carry a 2-bit generation tag (wrap-clear).
- **E-PRESERVE** — when a NEWEST re-track in K0 *removes* an edge while
  any live receipts exist, the removed edge is mirrored into K1 so
  committed/pinned-world reach survives the displacement (dev validator
  SP2; mirrors are exempt from edge-add delivery — their paths already
  existed and already flowed marks).
- **touchedSlots(n)** — int32 cold column: bit k set ⇔ slot k's recorded
  influence cone (K0∪K1, any time this episode) includes n (invariant M).
  **touchedList[slot]** — per-slot append-only node-id list written on
  0→1 transitions; the retainer sweep for clearing and targeting (I19).
- **watcher** — a mounted hook's subscription record: node, component
  setState, last-rendered value, per-slot dedup bits (re-armed on render).
- **staged evaluator** — per-pass table hookNode → {fn, deps, fnStamp}
  (+ staged reducer); consulted only by that pass's evaluations; promoted
  at the hook's own commit effect; dies with the pass (I22). The
  **committed evaluator** is the last promoted one.
- **flattened prefix** — for a suspense position: the ordered transitive
  [(atomId, fp(atom, w))…] of tracked reads plus [(computedId,
  effectiveFnStamp)] of evaluators traversed before the position; child
  evaluations merge into parents (S5's flatten rule).
- **pass / lineage / episode** — pass: one render attempt, spanning
  yields (F2, per-callstack truth — I6). Lineage: fork-minted id per
  (root × batch-set), stable across restarts/replays, dead at
  commit/abandon (F5, D11). Episode: bridge-registration or quiescence to
  the next quiescence; epoch-bumped.
- **staging (S15)** — arena records minted during a pass live on a
  staging list until their hook's commit effect promotes them;
  pass/lineage death reclaims unpromoted records (no arena leak).
- **fold frame / world-eval frame / pass binding** — the three restricted
  frames the write guard rejects (R12/R4/render-purity).
- **carrier** — the async-action token continuation carrier: module
  variable `currentToken`; captured at async-resource creation, pushed
  before each continuation, finally-restored (I26). Realized by the
  **twin-build async transform** (§12) or platform AsyncContext.
- **CT(n)** — "committed-clean": for a computed, K0 holds a cached value
  the donor pull would return without re-evaluating; for an atom, the
  tape is empty. The freshness half of invariant R.

## 4. Mode protocol

Twin generated builds from one source (SPK-H/SPK-Q both TRIGGERED — the
hooks and routing cost >1%/>2% if compiled into DIRECT; the remedy is
structural, not a flag). `registerReactBridge()` swaps the op-table once;
the plane, values, and topology carry over; no state migration. LOGGED
mode is permanent for the process (monotonic — S6's first-transition-leak
schedule is unrepresentable: the bridge exists before any React write can
happen, because writes classify through fork facts that only exist after
registration). LOGGED-quiet residual: measured 2.4–3.8% branch floor
[SPKHQ]; gate G-Q AT RISK with the pre-registered renegotiation (O19,
SPK-L; mitigation ladder = fused status load, per-pass routing hoist).
DIRECT-mode users get donor bytes: G-D's CI symbol check diffs the DIRECT
bundle against the donor per commit.

## 5. Value model

### 5.1 The logged write path

```
write(atom, op):
  if restrictedFrame(): throw            // pass binding | world-eval frame | fold frame — FIRST, before any mutation
  if liveRenderNewestCount > 0: demoteRenderNewestPasses()   // R3: flip to real (mask, pin); original pins retained
  token = fork.currentBatchToken()       // carrier-aware (§12); lazy mint; microtask backfill (F1)
  slot  = internSlot(token)              // zeroes slotWriteSeq at first intern
  seq   = ++globalSeq;  slotWriteSeq[slot] = seq
  if atom.tape.length == 0: atom.base = k0.value(atom); atom.baseSeq = 0
  atom.tape.push({op, slot, seq, retiredSeq: 0})   // ALWAYS (I1/I7/C8) — equal values included
  k0.writeNewest(atom, applyStable(op, k0.value(atom)))   // stepwise equality: keep old ref, skip K0 marks only
  notifyWalk(atom, slot)                 // unconditional; value-blind (D13)
```

`update(fn)` and reducer application run under a **fold frame**: signal
reads and writes inside throw in ALL builds, even through `untracked`
(R12/I28/D14; legal composition = read before dispatch; conformance-
pinned). Equal-value writes still append receipts: with any history,
worlds disagree about the accumulator (I7); with no history the write may
be short-circuited after one evaluation against base (the only legal
drop).

### 5.2 Folds: equality-stable replay + watermarked visibility

`foldAtom(atom, w)`: `acc = base`; for each visible entry in seq order:
`next = apply(op, acc); acc = atom.isEqual(acc, next) ? acc : next`
(R15/I29 — reference stability identical to the live K0 write path).
ReducerAtom rides the same tape; the fold uses the committed reducer
except inside a pass holding a staged one (I22/D16).

Visibility of entry e for world w = (mask M from F2, root r, pin p):

```
  (e.retiredSeq ≠ 0 ∧ e.retiredSeq ≤ p)                       // retired clause — unconditional (I15: same number line)
∨ (e.slot ∈ M ∧ e.seq ≤ p)                                    // pass's own tokens — plain clause (mask parity)
∨ (e.slot ∈ L(r) ∧ e.seq ≤ min(p, lockedSeq[r][e.slot]))      // locked tokens — WATERMARKED (R13/I25)
```

For synchronous batches every write predates the first commit, so the
watermark equals the full clause; only carrier-attributed post-await
writes exercise the bound (walk C11-W). Both pins sit on the globalSeq
line (I15) — a private retire counter is unrepresentable here.

### 5.3 Retirement (fold; exactly once per token — F3)

1. Stamp every entry of the token `retiredSeq = ++globalSeq`; mint
   `worldMemoEpoch = ++globalSeq` (R10).
2. Per touched atom (enumerated via touchedList[slot]): fold the
   compactable **all-retired prefix only** — blocked at the first
   unretired entry (CH-4's 3-not-4 fold is unrepresentable) and blocked
   below any live pass pin (C7 retention); `baseSeq = max(baseSeq, max
   folded seq)`; **mint visStamp(atom)** (R1/I21). Pin-blocked atoms go on
   the pending-compaction list (R9).
3. Run the retirement notification path — the **plain full walk** from
   each touched atom whose committed value moved (no pruning exists to
   consult — CH-7), the reconcile backstop (§11.3), and the per-root
   targeted effect flush (§11.4) — I14's three triggers.
4. Clear bit(slot) + watermark from every root's lockedIn **before** slot
   release; recycle zeroes slotWriteSeq, dedup columns, touched bits via
   touchedList[slot] (I19).
5. Ordering (R11): steps 1–4's per-root bookkeeping (lock-in watermark,
   fold when this commit retires the token) complete **before that root's
   layout effects run** — fork F3 clause, fork test 16.

`onPassEnd`/lineage death advance min-live-pin and drain the
pending-compaction list, then re-check quiescence (R9 — a pass-held pin
can never permanently strand compaction, HX-7).

### 5.4 Quiescence (episode boundary)

Precondition: live batches = 0, live passes = 0, tapes compacted
(reachable by R9). Then, **before** K1 reset:

- **Refresh (T8-N).** For every K1-touched node with a committed watcher
  or an effect-dep snapshot (scope includes effect deps — LC-F6), K0-pull
  at NEWEST — legal (no worlds exist), re-tracks the node's true basis
  into K0; donor recursion fixes stale upstream. Why: the reach induction
  (§6.4) presumes basis edges present; a node whose current basis exists
  only in K1 would strand when K1 clears — next episode's write to its
  real dep reaches nothing → torn commit. The refresh restores the
  premise at every boundary. If a refresh pull performs an R8-legal
  computed write, quiescence has ended: finish the sweep, retry once at
  the next quiescence; a node that writes again is **refresh-exempt** —
  its K1 in-edges are carried into the fresh plane (over-notification
  only, bounded by the exempt cone, dev-warned; LC-F3's livelock closed).
- Then: bump episodeEpoch (K1 tag wrap-clear duty at tag wrap), bump-reset
  K1, zero touchedSlots + lists, drop worldKeys/memos (epoch-in-key makes
  stragglers unreachable), staging reclamation sweep, optional globalSeq
  renumber past the quiescent margin (§15.2).

## 6. Worlds, routing, marks

### 6.1 World bindings

Reads outside any pass binding resolve NEWEST (K0). Pass bindings come
from F2 — (mask, pin, lineage, root) — pushed at pass start/resume and
popped at yield/end (**per-callstack truth**, I6: handlers in yield gaps
are outside the binding — S7's wall-clock scoping is unrepresentable).
Effects and fixups bind committed-for-root(r). RENDER_NEWEST: a pass
whose visible set covers every live receipt at pass start (conservative
test: every live slot ∈ mask ∪ locked(r), every live seq ≤ pin, no
watermark bound below a live seq — or simply zero live receipts) binds
K0 directly; **revocable**: the first logged write while any
RENDER_NEWEST binding is live demotes those bindings to their real
(mask, pin) worlds, original pins retained (R3; walk C7-D).

### 6.2 Read routing (invariant R)

A tracked or untracked read of node n under world w ≠ NEWEST:

```
if touchedSlots(n) == 0 and CT(n):  serve K0's cached value   // fast path
else:                                world path
```

World path: atoms fold (§5.2); computeds consult `M(n, worldKey)` —
EMPTY → evaluate under a **world-eval frame** (write guard rejects writes
inside it — R4), reading deps recursively under w, recording every read
as a K1 edge, storing DONE + value + validity record; EVALUATING → R7
cycle throw; DONE → validity ladder (§8.2), serve or re-evaluate.

**Invariant R (the routing soundness claim), with its construction.**
Claim: the fast path never serves a value that world w's own evaluation
would not produce. Construction: worlds diverge from NEWEST only through
receipts (folds differ from K0 only in visible entries; base is shared).
Suppose w's value of n differs from K0's cache. By first-divergence (I4):
n's w-evaluation and NEWEST evaluation read identical prefixes up to the
first atom x whose w-value ≠ newest value; x necessarily holds a live
receipt in some slot s, and x is a dependency of n *on the newest basis
at that point*. Then bit s reached n through one of exactly three legs:
(leg 1) the write walk from x over K0∪K1 at the time of x's write, if a
path existed then; (leg 2) edge-add propagation (§6.4 site 3), if the
path was created later by any evaluation; (leg 3) E-PRESERVE, if a K0
re-track displaced the path while receipts lived (the mirror keeps it
walkable). So touchedSlots(n) ∋ s ≠ 0 — the fast path refused. The
**freshness conjunct CT(n)** (I12) closes the remaining hole (S9): if
K0's cache needed a recompute, serving would trigger a *fresh
newest-basis evaluation* that can acquire a receipted atom through an
edge no plane recorded *before the pull itself creates it* — legs 1–3
cover recorded paths only, so only cached, no-recompute serves are legal.
Base case: episode start — no receipts, all worlds ≡ NEWEST, any serve
correct. Step: every event kind preserves the M-invariant (§6.4
induction). ∎

### 6.3 Invariant M: per-slot marks with delivering propagation

**M:** if atom x has a live-episode receipt in slot k and a path x→…→n
exists in K0∪K1 **at any time while the bit is live**, then
`touchedSlots(n) ∋ k`.

Maintenance sites (the induction over event kinds):

1. **Write walk** — ORs the writing slot's bit into every visited node
   (0→1 appends to touchedList[slot]).
2. **World evaluation** — ORs the union of its deps' bits into the
   evaluated node (covers paths traversed by evaluation order).
3. **Edge recording** — a K1 append from a world eval, or a K0 edge
   acquired at re-track (`afterRetrack`); E-PRESERVE mirrors exempt
   (their paths pre-existed → bits already flowed):
   `newBits = touched(d) & ~touched(n)`; if nonzero — OR in, append to
   lists, recurse through n's **existing** K0∪K1 out-edges, and **for
   every watched node reached, deliver each new bit's setState via
   fork.runInBatch(token(bit), setState)** — immediately when in the
   writer's stack; queued to the pass's yield/end edge when inside a
   render (each queued delivery carries its own token — D10 per-write
   context; a token retired while queued falls back to the fixup/
   committed-compare rule). This is R5/I23: **flags route reads;
   deliveries schedule React** — the HX-3 tear needs both.
4. **Retirement/recycle/quiescence** — clears are paired with the
   identity recycle they outlive (I19): per-slot clear via touchedList at
   slot release; bulk zero at episode reset (after the refresh).

Induction: base — episode start, all bits 0, no receipts, M holds
vacuously. Step — a new receipt (site 1 walks its cone as of now); a new
path (site 3 flows every live bit of the source across the new edge and
onward through existing out-edges, delivering to watchers); an evaluation
(site 2 unions); a displaced path (E-PRESERVE keeps it). Bits are never
cleared while their slot lives (monotone per episode × slot generation).
∎ Cost: each node gains each bit ≤ once per slot generation — amortized
O(live-slots × touched region) per episode; deliveries bounded by
watched-nodes × slots with per-(watcher, slot) dedup.

## 7. K1 (the world edge plane)

Same-plane layout class as K0's links (I9: interleaving, closure-bound
buffer, bump allocation); separate plane so K0's walks stay closed (D4).
Populated only by world evaluations (each records its REAL read set) and
by E-PRESERVE mirrors. Union across worlds, add-only to quiescence —
over-notification is priced (G3), never wrongness (delivery is
value-blind; React bails out on equal renders). Record ids carry a 2-bit
generation tag; quiescence bump-resets the plane and bumps the tag; a
retained id from a prior episode fails its tag check; every fourth
episode (tag wrap) runs the full clear sweep of retained-id columns
(CH-8's enumeration hole does not apply to tags). Memory ~128 KiB warm,
reused. Dev-mode E-PRESERVE validator (SP2): brute-force compare
committed-world evals against a shadow graph; >10% dev overhead → sampled
validation (O3).

## 8. Validity: the closed change-source enumeration

### 8.1 The table (I16: closed, audited by CI sweep against the schema)

| # | change source | observer (stamp + conjunct) | killed schedule |
|---|---|---|---|
| S1 | write in slot s | `slotWriteSeq[s]`; record valid only if ∀s ∈ mask: wc[s] ≤ r.seq; fingerprint newest-visible term | C1 memo half, C5 |
| S2 | retirement (fold/compaction) | `worldMemoEpoch` mint (R10, from globalSeq); `baseSeq` monotone max | judge-B1 compaction |
| S2b | **visibility flip below the max** (retirement or lock-in exposes an OLDER entry) | **visStamp(a)** minted at retire-fold and per-root lock-in; term in fp's max | HC-F1/HX-2 (I21) |
| S3 | evaluator identity | staged per pass, promoted at hook commit (I22); fnStamp/reducerStamp conjuncts; committed evaluator for NEWEST/committed/effect/fixup evals | HC-F2/HX-1/CX-1/LX-4 |
| S4 | thenable settlement | generation-checked back-ref kill + pending-only belt + settle-time flush re-check for SUSPENSION effect snapshots | TKC-2, HC-N2 |
| S5 | episode / renumber | epoch-in-worldKey; renumber rewrites persistent stamp columns; heap-held snapshots epoch-guarded (stale ⇒ treated as moved, safe direction); hard horizon throw | C13/I8 |
| S6 | world identity | in the key: (mask, pin, root-lock variant, epoch) | S18 pinless kills |
| S7 | node identity recycle | staging (S15) + GEN generation checks | S15 arena leak, LX-6 |

`fingerprint(atom, w) = max(newest w-visible entry seq, baseSeq,
reducerStamp, visStamp)` — over-invalidates on unrelated same-atom flips
(one ladder re-fold; safe direction), never under-invalidates: every
outcome-changing source has a row, and the rows' stamps all mint from
globalSeq (I15).

### 8.2 The ladder (memo revalidation, cheap-first)

1. epoch equal? (int) — else dead.
2. per-slot clocks: ∀s ∈ mask: wc[s] ≤ r.seq (≤31 int compares, usually
   1–2) — pass ⇒ serve.
3. else fingerprint re-check per recorded atom dep (tape-tail + 3 loads +
   max each): all unmoved ⇒ re-stamp r.seq, serve (recompute avoided).
4. else re-evaluate (record fresh edges/memo).

## 9. Suspense

### 9.1 `ctx.use(thenableOrFactory)` — positional, per-lineage

Cache key `(node, lineageId, position)` (D11: lineage is per
root × batch-set, stable across restarts/replays — passSerial re-fetches
forever, mask keys drift, live-set ids churn; all three excluded by the
key's definition). The **lazy form** `ctx.use(() => makeRequest())`
invokes the factory only when no valid entry exists — a retry's cache hit
fires no user side effect (R14). The eager form stays legal with the
honest contract: identity stability guaranteed; the caller's own eager
side effects are not suppressed. Per-world positional identity satisfies
R2/C14 (same positional thenable per world across replays).

### 9.2 Content validity: the flattened prefix

Entry records `prefix = [(atomId, fp(atom, w)) in read order] ∪
[(computedId, effectiveFnStamp)]` for all tracked reads before the
position, child evaluations merged into parents (S5 flatten; O21 owns the
length risk — fallback: whole-mask clock vector + visStamp sum, coarser,
flagged non-default). Reuse iff pairwise equal; else drop positions ≥ p,
store fresh (generation-bumped). Properties, each with its witness:
**retry-stable** — purity ⇒ same reads; fps and fnStamps are
receipt-line facts, indifferent to memo/worldKey/pass churn (HX-4's
livelock dead); **content-sensitive** — an included write moves the
newest-visible term (I20), a visibility flip moves visStamp (HC-F1-B
dead), an evaluator swap moves fnStamp (CX-4 dead); **starvation-free** —
unrelated retirements touch no prefix atom ⇒ no visStamp mint on them ⇒
prefix stable (LC-F1/S20 excluded *by the mint sites' definition*: vS
mints only at folds/lock-ins touching that atom). Settlement: eager
generation-checked back-ref kills the sentinel memo; a pending-only belt
sweep covers the race; effect snapshots holding SUSPENSION outcomes get a
settle-time flush re-check (S4 row).

## 10. Notification

Per-write full-reach walk over K0∪K1 out-edges from the written atom, in
the writer's synchronous stack (D5): watched node ⇒
`setState(watcher)` — React assigns the writer's priority, batches,
entangles, and applies its own loop limits (R7's React half). Per-
(watcher, slot) dedup bits on the watcher record, set at delivery,
cleared when the component renders (re-arm ⇒ C4's second batch and any
post-render same-slot write re-deliver). Value-blind (D13): no equality
check anywhere on the delivery path — S16/S17's suppression scars.
Signal-effect subscribers are enqueued into their root's touched-effect
queue (dedup per flush window); flush triggers drain it targeted,
O(affected) (G-R). No pruning, no cross-walk marks. The specced fallback
if SPK-N1's grid fails: per-slot-mark **delivery dedup** per render cycle
(dedup, never a value cutoff — D13). Engine `batch()` defers core-effect
flushing only (D10); no watcher grouping exists to preserve context
across, and no implicit grouping exists anywhere (C6's second trap
answered by absence).

## 11. React bindings (`cosignal/react`, provider-free)

Bridge is module-global + a root registry keyed by fork rootId (R9 full
spanning scope — C11). Hooks: `useSignal`/`useAtom`/`useReducerAtom`
subscribe a watcher record + `useState(version)`; reads route under the
current binding (§6.1). `useComputed(fn, deps)` mounts a hook-owned node
(staged until its commit effect — S15). `useSignalEffect` registers a
committed-channel effect with a dep snapshot.

### 11.1 Staged evaluator identity (I22)

Per invocation: compare incoming deps against **this pass's staged entry,
else the committed evaluator**; changed ⇒ stage {fn, deps, fnStamp:
++globalSeq} in the pass frame (burned seqs on discard are unobservable);
a same-pass render restart re-compares and re-stages (LX-4 ⇒ new stamp ⇒
memo conjunct fails ⇒ re-eval). Pass evaluations of the node use its
staged evaluator; NEWEST, committed-world, fixup, and effect evaluations
use the committed one — an uncommitted closure is unreachable outside its
pass **by construction**: the staged table is keyed by the pass frame and
consulted only through it (base: no staged entry ⇒ committed everywhere;
step: the only readers of the staged table are evaluations holding that
pass's binding). Promotion at the hook's OWN commit effect — hook-grain,
which runs iff its subtree committed, so a fallback-committing root pass
publishes nothing for abandoned subtrees (LX-2 unrepresentable: there is
no pass-grain publication site in the design). Reducer identity:
constructor reducers immutable; hook reducers stage/promote identically
(D16; differential at stable-reducer scope; dev-warn on swap with pending
receipts).

### 11.2 Mount/subscribe fixup (the render→subscribe gap; I18/I13)

```
r = touchedSlots(n)
if r == 0 ∧ CT(n): return                              // invariant R fast-out
for each LIVE WRITTEN token t with slot(t) ∈ r:        // deferred AND default (R8-fix/HX-6); reach-based, no equality filter (I13/S10)
  fork.runInBatch(t, () => setState(W))
v_now = evaluate(n, committed-for-root(r))             // write-rejecting world eval (R4)
if !isEqual(v_now, v_rendered): setState(W)            // unconditional fallback (I18) — covers retire-in-window
```

Bound: |touched ∩ live| correctives + one committed eval per flagged
mount; 0 for R-clean mounts (G-F). The corrective joins the batch's OWN
lanes (a fresh startTransition would be a different lane → a separate
commit → a torn window — C10's explicit why-not). Windows walked: token
retires inside render→layout ⇒ the committed compare fires (the fold
precedes layout by R11); write lands after a pass completed but before
commit ⇒ the walk delivers, and for not-yet-registered watchers the
layout fixup's runInBatch plus F4's obligation (further work scheduled
for those lanes, never absorbed silently) covers it (C10-R).

### 11.3 Reconcile backstop (retirement-fold invisibility)

At retirement, for each watcher on a touched node: compare its
last-rendered value against the new committed value before bumping —
already-correct components see nothing (urgent-applied folds are value
no-ops); divergent ones get an urgent pre-paint correction (I14's
third trigger; with R11 this runs before that root's layout effects).

### 11.4 Effects

`useSignalEffect` (committed channel): runs post-commit; records snapshot
[(atomId, fp(atom, committed-for-root))] (+ epoch). Re-run check at each
flush trigger: any snapshot fp moved ⇒ re-run. Triggers (I14, all three):
commits on the root (passive phase drains the root's touched-effect
queue); retirements — including committed=false store-only batches (the
fold moved committed state with no commit anywhere); settlement re-checks
for SUSPENSION snapshots. visStamp makes visibility flips move snapshots
(C16-B1). Core `effect()` (non-React): documented contract = observes
NEWEST, flushed synchronously at write (or at `batch()` close / microtask
per `configure`) — stated and walked in C16 step 4; this is the
benchmark-integrability configuration (R13).

### 11.5 StrictMode / replays

Render-phase reads are pure (memoized world evals; K1 edge re-records
dedup against the node's existing adjacency; staging + GEN make discarded
mounts reclaimable — S15). Render-phase writes throw (guard first line).
Double-mounted effects net to one subscription via R1's microtask-
debounced observed-lifecycle (flap-proof). Per-world thenable identity is
positional per lineage — stable across replays (F5). Staged evaluators
re-stage idempotently by deps compare.

### 11.6 SSR/hydration (R10)

Serialized committed atom state loads into K0 at construction (DIRECT);
bridge registration precedes or follows hydration render — either order
is safe (no receipts exist pre-registration; hydration reads NEWEST).
RSC/Flight out of scope v1.

### 11.7 Tracing (R11)

Inherited from the reference bar: lazily-loadable recorder (ring +
lossless), causality queries, Graphviz renderers; untraced cost = one
slot check per site, both builds, inside the donor budget (the
architecture does not force changes; per R11 the reference design is
reused).

## 12. Async actions: F8 = carrier + parking, build-complete (X1)

Duties separated (I26): **parking** (lifetime — F3 holds retirement until
the action's returned thenable settles; React's own entangled-action
machinery already observes settlement) and **identity** (which token a
post-await write belongs to — only a continuation carrier can know;
promise-patching is correctness-dead, S22, measured: `await` never calls
a patched `.then`).

### 12.1 The async transform (bundler twin-build; I30, measured)

Ships as a first-party bundler plugin (vite/rollup/webpack/swc backends,
one shared core, maintained in-repo with the fork). For **every** async
function (declaration, expression, arrow, method — and async generators
via the wrap-async-generator driver shape, covering `for await` and
post-`yield` resumptions) in app code — and, recommended, in bundled
node_modules — emit:

- `nativeBody` — the original function, untouched semantics;
- `genBody` — the standard async-to-generator lowering (Babel
  `_asyncToGenerator` driver shape) plus four lines: capture
  `t = currentToken` at generator instantiation (async-resource
  creation); before each `gen.next(v)`/`gen.throw(e)`: push `t`;
  `finally` restore the previous token — including on throw, so `catch`/
  `finally` blocks and escaped rejections observe the action token and
  the ambient restores to null afterward (74/74 matrix, I30);
- `wrapper(...a) = currentToken === null && armedActions === 0
  ? nativeBody.apply(this, a) : genBody.apply(this, a)` — one
  monomorphic null-check dispatch per async call site; `this`,
  `new.target`, `arguments`, `super`, name/length preserved per the
  standard lowering rules.

The driver runs **only while an action token is live** (armed). Measured
(I30, provenance `research/experiments/spf8-continuation-carrier.md`,
74/74 correctness incl. Promise.all with mixed native promises, timers,
async generators, catch/finally restore, two interleaved actions with
zero bleed): unarmed ≈0% (−1.6%..+0.6% across 23 paired processes, inside
the ±1.5% noise floor of a 100%-promise-machinery worst case); armed
+24–26% of promise-machinery time ≈ **+12 ns/await** — cheaper than
Node's AsyncLocalStorage (+38%) on the same shape. Code size ≈2× async-fn
body bytes (async fns only); a plugin mode scopes twinning to
action-reachable code; unconditional twinning is the simple correct mode.
The plugin also **injects the probe module** (§12.4) and stamps
`__COSIGNAL_ASYNC_TRANSFORM__ = <protocol version>`.

### 12.2 Runtime carrier semantics (unchanged from the champion)

`fork.currentBatchToken()` consults the carrier first: non-null ⇒ the
action's token (receipt classifies under it, **parked**); null ⇒ React's
current event/update context (lazy mint, microtask backfill). Action
scope: `startTransition(async fn)` mints/enters token T; the sync prefix
runs under T; every continuation of compiled async code restores T
(§12.1); `armedActions` increments at scope entry, decrements at
settle/reject (ambient token null after — matrix-checked). Nested
`startTransition` while an action pends entangles to the action token
(≤31 structural, I10; when React multiplexes transitions onto one lane
they are ONE batch and ONE token — parity by construction: tokens are
per lane-batch, not per call). Two interleaved actions hold distinct
tokens with zero bleed (matrix). Retirement parks until the returned
thenable settles (F3); the watermark rule (§5.2) is what makes the
parked token's post-await writes safe on roots that committed earlier
prefixes (I25; walk C11-W). Carrier identity construction (why the token
is present at every resumption): base — captured at instantiation while
the scope runs; step — every resumption of a compiled async fn passes
through its driver's push/finally-restore bracket, and every async
resource *created* during a bracketed span captures the bracketed token;
uncompiled resumptions are exactly the §12.5 boundary. ∎

### 12.3 The feature-detect ladder (what ships, in order)

1. **Platform AsyncContext** (TC39 Stage 4, ES2026 — shipped nowhere as
   of 2026-07, I30): if `AsyncContext.Variable` exists and passes a
   behavioral probe, the carrier is a native Variable; the twin build is
   unnecessary (the plugin may still be installed; its dispatch collapses
   to the native branch); §12.5's boundary vanishes (host-level context
   flows through uncompiled code too).
2. **Twin-build carrier** (the bridge, today's default): §12.1 transform
   verified by the boot self-test (§12.4).
3. **Explicit `configure({asyncActions: 'unsupported'})`**: the
   async-action surface is disabled loudly — `startTransition` (ours)
   whose callback returns a thenable **throws** with a clear message
   (detectable at the point of rejection: the returned value is a
   thenable and the mode is 'unsupported'). Legal compositions that
   remain, each walked or trivially reducible: synchronous transitions
   (C1–C11 unaffected), sync writes before the first await of an
   un-scoped async flow (they classify by ambient context as ordinary
   writes), and store-only sync transitions (C12 first half). This is
   the preamble-sanctioned interface restriction; it never forbids
   behavior the user doesn't control (async actions are user-authored).
4. **Neither transform nor AsyncContext nor explicit opt-out** ⇒
   `registerReactBridge()` **throws at boot** (§12.4). Never a silent
   rung (I26/D15).

### 12.4 The loud boot self-test (build verifier — the meaning shift I30)

At `registerReactBridge()`: (a) ladder-detect AsyncContext (rung 1); else
(b) look up the **plugin-injected probe** — an async probe function that
lives in *app-built* code (injected by the plugin, so its presence proves
the plugin ran over the app bundle; a library-shipped probe would only
prove the library's own build) — and run it inside a synthetic action
scope: the probe awaits a resolved promise and reports the observed
carrier token; token ≠ probe scope's token ⇒ transform missing or
misapplied ⇒ **throw** (with the support-matrix message and the plugin
version stamp vs protocol version); no probe registered and no rung-3
opt-out ⇒ same throw. One-time cost, ≤1 ms class (one await + microtask
drain; G-A). The self-test verifies the *build*, not the host — I30's
prerequisite relocation, stated: "the platform prerequisite becomes a
build prerequisite."

### 12.5 Mixed compiled/uncompiled boundary semantics (the honest edge)

What exactly happens when **untransformed** third-party async code writes
signals inside an action (rung 2 only; rung 1 has no boundary):

- **Mechanics.** The vendor fn's internal `await` resumes via native
  machinery — no driver, no push — so `currentToken` is null there. A
  post-await `a.set(2)` in that frame classifies by ambient context: a
  real (usually default-priority) token D. The write is **logged under D,
  applied to K0, walked, and retires with D** — every invariant of §5–§10
  holds for it, because D is an ordinary batch.
- **The bound (documented misattribution bound).** The deviation is
  *attribution only*: the write commits at D's retirement — possibly
  **before the action settles** (C12's timing for that write is not met)
  — and it does not ride the action's world (T's renders exclude it;
  urgent renders include it sooner). It is byte-for-byte the behavior of
  the same write issued from a plain `setTimeout` callback. **Never**: a
  lost write (D2/I1 — it has a receipt), a torn frame (all folds/worlds
  remain self-consistent; delivery walks run), a stuck world, or a
  lifecycle leak. Blast radius = the semantics of that one write's batch
  membership.
- **Detection limits, stated.** At the write site, token-null-during-
  pending-action is *indistinguishable* from a legitimate concurrent
  event write (a click during a pending action is also token-null) — so
  runtime rejection is impossible without false positives, and the design
  does not throw (a throw would ban ordinary concurrent input — preamble
  rule (c)). Instead: **dev warning** on any logged write with carrier
  token null while ≥1 action token is parked — imprecise by construction
  (over-warns on legitimate concurrent events; the message says so and
  names the vendor-transform remedy), catching the residual class in
  development (I30's rule). The whole-app-untransformed case never
  reaches this edge: §12.4 threw at boot.
- **Remedies, in order**: apply the plugin to node_modules (bundlers can;
  recommended default), wrap the vendor call's post-await work in
  `fork.runInBatch(actionToken, …)` at the boundary (manual, precise), or
  wait for rung 1 (AsyncContext erases the class).
- Walk: **C12-U** (§17).

### 12.6 Support matrix (the shipped line)

| host/build | async actions |
|---|---|
| AsyncContext host (future) | native carrier; no build requirement; no boundary class |
| bundled app + cosignal transform (today) | full support; untransformed vendor async code writing signals post-await inside an action misattributes to its ambient batch — sound, dev-warned, bounded (§12.5) |
| unbundled/untransformed (raw ESM dev server), no AsyncContext | `registerReactBridge()` fails loudly; opt-out rung 3 disables async actions loudly |

Everything else in this section — parking, entanglement, retirement,
watermark interaction — is the champion's §12 verbatim.

## 13. Semantics pins (conformance-tested contracts)

- **Fold purity (D14/I28)**: signal reads/writes inside `update(fn)`/
  reducer folds throw in all builds, through `untracked` too. Legal
  composition: read before dispatch.
- **Reducer identity (D16)**: constructor reducers immutable; hook
  reducers stage per pass, promote at the hook's commit effect;
  differential vs `useReducer` at stable-reducer scope; dev-warn on swap
  with pending receipts.
- **`ctx.previous` (D16 three-way)**: NEWEST/RENDER_NEWEST = donor global
  previous (documented, conformance-pinned; per-root divergence of the
  committed seed is a stated contract, not a leak); world evals = prior
  `M(node, worldKey).value` (pass/world-scoped); else R-guarded K0 seed,
  else undefined.
- **`ctx.use` forms (D16/R14)**: lazy factory = full caching contract;
  eager thenable = identity stability only.
- **Core `effect()` contract**: NEWEST, synchronous under the documented
  benchmark configuration (R13); `useSignalEffect` = committed-for-root
  only (C16).
- **R8**: writes inside computeds tolerated when acyclic on NEWEST
  evaluations only; `configure({forbidWritesInComputeds})` hard-throws;
  world evals always reject (R4); quiescence-refresh interaction per
  §5.4.

## 14. fork-protocol (versioned document; the seam)

Eight facts; ~12 reconciler touch sites; integers and callbacks only (no
Fiber, no lane bitmask, no queue internals cross the boundary). Bindings
feature-detect via F7 and fail loudly on stock React.

- **F1 — write classification.** `currentBatchToken()`: the carrier's
  token if non-null (§12), else the current event/update context's token
  — minted lazily `(serial<<1)|deferredBit`, never reused live, ≤31 live
  (I10); microtask backfill finalizes lane assignment for tokens claimed
  before React scheduled. Transitions multiplexed onto one lane share one
  token (parity by construction). Sites: dispatch entry, transition
  scope, registry mint/backfill.
- **F2 — pass lifecycle.** `onPassStart(root, mask, pin, lineageId)` /
  `onPassYield` / `onPassResume` / `onPassEnd(complete|discard)` —
  per-callstack truth (I6): the binding pops at yield, re-pushes at
  resume; handlers in gaps are outside it. Invariant: mask == the lane
  set React renders (mask parity — the plain visibility clause depends
  on it). Sites: workLoop entry/exit, shouldYield boundary.
- **F3 — retirement + lock-in + parking.** Exactly once per token, with
  committed flag; `onBatchCommittedOnRoot(token, rootId, passPin)` per
  root (watermark data — R13); **ordering clause (R11): per-root lock-in
  bookkeeping and, when the last root commits, the retirement fold
  complete before that root's layout effects run**; async actions park
  retirement until the returned thenable settles (React's entangled-
  action settlement is the trigger). Sites: commitRoot, action-settle.
- **F4 — `runInBatch(token, cb)`.** cb's updates join token's lanes.
  **Obligation:** an update scheduled into a completed-not-committed
  pass's lanes schedules further work for those lanes — never silently
  absorbed into the finished tree (C10-R's post-completion window).
  Retired token ⇒ documented error return (caller falls back per §11.2).
  Site: priority-override scope.
- **F5 — lineage.** `lineageId` per (root × batch-set): minted at first
  pass for the set, stable across restarts/replays/yields, dead at
  commit/abandon (D11). Site: root render session.
- **F6 — mutation window.** Brackets around the commit mutation phase
  (kept per charter). Site: commit mutation phase.
- **F7 — handshake.** Protocol version export + capability record
  (includes carrier rung, §12.3); mismatch/absence ⇒ loud failure.
- **F8 — action scope.** Enter/exit + the continuation carrier contract
  (§12): scope entry publishes the token to the carrier; the fork
  guarantees parking; the **build layer** guarantees continuation
  identity (rung 2) or the host does (rung 1). The self-test (§12.4) is
  part of this fact's conformance.

**Rebase drill** ("React changed X — what moves?"): the library moves
zero lines in every drill; the fork re-implements the fact and its test
is the tripwire. Lanes renamed/renumbered ⇒ F1/F2's token↔lane registry
only (tests 1–2). Commit phases reordered ⇒ F3's ordering clause
re-anchors (test 16). Update-queue internals rewritten ⇒ nothing (no
queue internals cross the seam). Async-action internals changed ⇒ F8
parking re-anchors at the new settle edge (test 13); the carrier is
build-side and does not move. Scheduler yield mechanics changed ⇒ F2's
yield/resume edges re-anchor (test 5).

**Fork test list (reconciler-level, run on every rebase):**
1 token mint/classify per update kind; 2 mask parity (pass include-set ==
React's lane decision, incl. flushSync exclusion); 3 retirement
exactly-once + committed flag; 4 async parking (close vs settle); 5
yield/resume edges (handler in gap sees no binding); 6 runInBatch joins
live lanes; 7 runInBatch on retired token errors; 8 lineage stable across
restart/replay; 9 lineage dead at commit/abandon; 10 mutation-window
brackets; 11 handshake + stock-React loud failure; 12 flushSync excludes
pending default batch (C2 shape); 13 action parking differential vs
React 19 (React-state side); 14 queued edge-add deliveries drain at
yield/end in token order; 15 per-root lock-in event carries (token,
rootId, passPin); 16 lock-in/retirement-fold precede that root's layout
effects (R11); 17 watermark equals the committed pass's pin (C11-W
schedule); 18 carrier matrix (native await, timers, clicks between
continuations, interleaved actions, ambient-null restore); **19 (new)
build self-test: missing-transform boot throw; probe-pass path;
uncompiled-boundary dev-warn fires on token-null write during parked
action and names the vendor remedy**.

## 15. Lifecycle: the consolidated state inventory (X3)

### 15.1 Master audit table — every stateful item, at a glance

Columns: mech# keys into §19; every row names its clear site paired with
the identity it outlives (I19) and its forced test (C13).

| state item | mech# | minted/set by | observed by | cleared/reset by | forced test |
|---|---|---|---|---|---|
| tape entries {op, slot, seq, retiredSeq} | 2 | write path | folds, fingerprints, compaction | retire-fold prefix compaction; pin-release sweep (R9) | C3 prefix block; HX-7 pin-release |
| base/baseSeq | 2 | first receipt; retire folds | folds, fingerprints | episode end (tapes empty) | out-of-order retirement differential |
| globalSeq | 2 | every stamp mint | everything | renumber at quiescent margin; hard throw at never-quiescent horizon | forced-small builds, both paths |
| slotWriteSeq[slot] | 3 | write path | ladder step 2 | zeroed at slot intern | T6 reuse hygiene |
| tokens/slots/masks | 3 | F1 mint/intern | visibility, routing bits | slot recycle gated on zero unswept entries (I10) | 31-parked-actions wrap |
| pins | 3 | F2 pass start | visibility, retention | pass end (min-live-pin advance) | C7 retention |
| lockedIn bits + watermarks | 3 | F3 per-root commit (pin) | committed-for-root folds | cleared with bit at retire, before slot release | test 17; stale-watermark battery |
| visStamp column | 4 | retire-fold + lock-in touching the atom | fingerprints, prefixes, snapshots | never in-episode; renumber rewrites | C16-B1; C15 step 5 |
| worldMemoEpoch | 4 | retirement (globalSeq mint) | memo epoch conjunct | renumber rewrites | forced-small battery |
| world memos M(node, worldKey) | 5 | world evals | reads, `ctx.previous` | epoch-in-key at episode reset; ladder invalidation | S18 collision battery |
| thenable entries + flattened prefixes | 5 | `ctx.use` | retries, settlement | lineage death; prefix mismatch drop; settle kill (gen-checked) | C15 battery |
| staged evaluator tables | 4 | hook render (deps compare) | that pass's evals | promote at hook commit effect; drop at pass discard | C14 re-stage; LX-4 restart |
| committed fnStamp/reducerStamp | 4 | hook commit promotion | NEWEST/committed evals, prefixes | node death (staging/GEN) | evaluator battery |
| K1 edges + 2-bit tags | 6 | world evals; E-PRESERVE | walks, routing | bump-reset at quiescence; tag check; wrap ⇒ full sweep | K1 tag wrap |
| touchedSlots / touchedList | 6 | walks, evals, edge-adds | routing, fixup, retirement targeting | per-slot at recycle (list sweep); bulk at quiescence | recycled-slot zero-bits battery |
| watcher records + dedup bits | 7/8 | mount; delivery | delivery dedup | re-arm at render; unmount (flap-damped) | C4; C14 double-mount |
| touched-effect queue | 7 | write/retire walks | flush triggers | drained per flush window | C16; G-R harness |
| effect snapshots (epoch, fps) | 8 | effect run | re-run compare | effect cleanup; stale epoch ⇒ treated moved | C16-B1 |
| staging list + GEN | 10 | pass-minted records | promotion; reclamation | hook-commit promote; pass/lineage death sweep | S15 mount-abandon soak |
| pending-compaction list | 10 | pin-blocked retire folds | quiescence precondition | drained at min-pin advance | HX-7 forced test |
| refresh-exempt set | 10 | second refresh write | next-episode carry | re-derived each episode | LC-F3 livelock test |
| carrier token + armedActions | 9 | action scope; compiled drivers | write classification; dispatch | finally-restore; settle/reject decrement | test 18/19; 74-matrix |
| episodeEpoch | 10 | quiescence | worldKeys, K1 tags, snapshots | monotone | episode collision battery |

### 15.2 Counter horizons (C13 discipline)

globalSeq: renumber at the quiescent margin rewrites every persistent
stamp column (baseSeq, retiredSeq of live entries — none at quiescence —
visStamp, fnStamps); heap-held snapshot fps are epoch-guarded (stale
epoch ⇒ moved, safe). Never-quiescent horizon ⇒ **hard diagnostic
throw** (the named terminal behavior; forced-small builds drive both
paths, including the non-quiescent variant). Token allocator live-skips;
K1 tags wrap-clear; slots recycle only at zero unswept entries. Every
reset row above pairs with its epoch/generation guard (I8).

## 16. Gates, numbers, spikes (nothing unmeasured is asserted)

| gate | budget | status/provenance |
|---|---|---|
| G-D | DIRECT ≤ alien v3 on every tier-0 shape; 179/179 + growth stress + exact pulls | MEASURED — donor: deep 0.90×, broad 0.84–0.88×, diamond 0.89×, reads 0.74–0.87×, create 0.96× [ARENA]; CI symbol diff pins DIRECT = donor |
| G-Q | LOGGED-quiet ≤2% tier-0 | **AT RISK — measured 2.4–3.8% branch floor [SPKHQ]**; SPK-L (idle machine) decides; pre-registered renegotiation ≤3% or mitigation ladder (O19) |
| G-W | logged write ≤2× DIRECT write | UNMEASURED → SPK-W (inline-2 receipts = named remedy) |
| G-N | propagate ≤2× DIRECT; ≤1 spurious render per (watcher, slot, render cycle) | UNMEASURED → SPK-N1 grid + held-batch × writes/frame row; fallback = per-slot-mark delivery dedup (D13) |
| G-V | validity predicate = int compares; fingerprint = tape-tail + 3 loads + max; prefix = O(position) compares | construction; measured inside SPK-G8 |
| G-F | ≤ \|touched ∩ live\| correctives + 1 committed eval per flagged mount; 0 when R-clean | react-concurrent-store harness + W2 row |
| G-E | world-eval cost ∝ flagged region; restart-heavy amortization | UNMEASURED → SPK-G8 (typeahead row); fallback = pinless-frontier hybrid, specced non-default (O18) |
| G-R | retirement ≤2× the batch's own render; effect flush O(affected); quiescence refresh in class | UNMEASURED → SPK-R (10k atoms × 5k effects) |
| G-M/G-P1 | 0 steady-state engine allocations; re-render ≤10% vs useState; 10k mount ≤15% (10 live transitions) | harness (P1/P4) |
| **G-A (new)** | async dispatch unarmed ≤0.5% event overhead; armed ≤ +15 ns/await; boot self-test one-time ≤1 ms class | **MEASURED (I30): unarmed ≈0% (−1.6..+0.6%, 23 paired processes); armed +12 ns/await; beats ALS +38%** |

Host-protocol context: the closed-kernel call boundary itself is free
(0.99–1.02×); only storage moves cost 5–12% — values stay in-plane (I11).
Spikes queued: SPK-L, SPK-N1, SPK-G8, SPK-W, SPK-R, SP2. Done: SP1/SP1b
(I11), SPK-H/Q (remedy shipped: twin builds), **SP-F8 (I30 — this
round's integration)**.

## 17. OPEN questions touched (disposition)

| O | disposition here |
|---|---|
| O1 | K1 real edges stand (D8/D12); compensated single kernel remains the named fallback only on SPK-* failure |
| O3 | SP2 queued; >10% dev ⇒ sampled validation (§7) |
| O7 | watermarked lock-in in the bindings' root registry; fork tests 15–17 on the critical path (G4) |
| O12 | value-blind fan-out cost → SPK-N1; fallback restricted to per-slot-mark dedup (D13) |
| O18 | pin-in-worldKey default; SPK-G8 typeahead row; pinless-frontier hybrid specced fallback |
| O19 | G-Q AT-RISK framing + SPK-L + pre-registered renegotiation (§16) |
| O20 | **CLOSED — integrated**: §12 build surface (X1) |
| O21 | prefix length measured inside SPK-G8; whole-mask clock-vector fallback flagged (§9.2) |

---

## 18. Correctness walks — the full battery (X4)

Format per seed. Notation: `TS(n)` touchedSlots; `vS(a)` visStamp;
`fp(a,w)` §8's fingerprint; `wc[s]` slot write clock; `M(n,w)` world
memo; `L(r)` lockedIn(root); receipts written `{op@seq, slot}`. "Walk"
always means the K0∪K1 per-write reach walk (§10).

### C1 — world-divergent dependency (family of 11)

**Core.** flag=false, a=0, b=0; c = flag ? a : b; W on c; canonical deps
of c = {flag, b}.

```
C1: k-world cache of c must die when k writes a (no canonical a→c edge); W re-rendered in k's lane pre-commit.
step | actor/mechanism | state touched
1 | k: flag.set(true) — write path | receipt(flag){true@s1, k}; K0 flag=true (c marked stale in K0); wc[k]=s1; walk flag→c (K0): TS(flag)|=k, TS(c)|=k, lists appended; W watched → setState(W) in k's context (k's lanes); dedup(W,k) set
2 | k render pass P1 (mask {k}, pin p1≥s1) evaluates c | routing: TS(c)≠0 → world path; M(c,wk) EMPTY → world-eval frame: fold flag in wk = true (slot k ∈ M, s1≤p1); c reads a → fold a = 0 (empty tape) → c=0; K1 edges recorded: flag→c, a→c (REAL k-world deps); edge-add a→c: TS(a)=0 → no new bits; M(c,wk)={0, r.seq=eval stamp}
3 | k: a.set(1) — write path | receipt(a){1@s2, k}; K0 a=1; wc[k]=s2; walk from a over K0∪K1: K1 edge a→c reaches c → W watched: if W has rendered since step 1, dedup re-armed → fresh setState in k's lanes; else the step-1 update is still pending in k's lanes — either way k's next render includes W
4 | k render (fresh pass or restart, pin p2≥s2) | M(c,wk) validity ladder: wc[k]=s2 > r.seq → invalid → re-evaluate: flag=true, a=1 → c=1; W renders 1 in k's lane BEFORE k commits — no torn commit
5 | committed reads meanwhile | fold flag committed = false (k unretired/unlocked) → c via b = 0 ✓
outcome: matches Required — K1 gives the walk a real a→c path (I3 answered structurally); wc kills the stale memo; delivery is in k's own lanes.
residual risk: K1 edge recording must happen on every world eval (no fast path skips it) — pinned by the C1 conformance family + edge-record assertion in dev.
```

**T2 (write to committed-only dep b in k).**
```
1 | k: b.set(9) | receipt(b){9@s3,k}; walk b→c (K0 edge) → TS(c)|=k; W scheduled in k's lane (dedup governs)
2 | k render | M(c,wk): wc[k] moved → re-fold: flag true → c reads a → unchanged value 1 (or 0 pre-T5) — over-invalidation only
3 | committed | c = b: still old committed b until k retires ✓ wrong value nowhere
outcome: over-invalidation + possible bailout render — allowed; values correct per world.
residual: none beyond G-N cost (spurious render bounded by dedup).
```

**T3 (shared dep flips back: k writes flag=true then flag=false).**
```
1 | receipts flag{true@s1,k}{false@s4,k}; K0 flag=false (stepwise equality: true→false both applied)
2 | k render | M(c,wk) invalid (wc) → re-eval: fold flag wk = replay true,false → false → c = fold b = 0; K1 gains b→c (union keeps old a-edge — over-notify only)
3 | committed | flag=false → c=b=0 ✓ both worlds 0; earlier k-cache (c=a) dead via wc
outcome: replay-in-order handles flip-back; K1 union never misroutes (bits ⇒ world path).
residual: K1 growth per re-track — G3/priced.
```

**T4 (urgent write to b).**
```
1 | U: b.set(5) | receipt(b){5@s5,U}; K0 b=5; walk b→c → W setState in U's context (urgent)
2 | U render (mask {U}) | c: world path (TS≠0): fold flag=false → c=b=5 ✓ committed cone moves
3 | U retires | fold: base(b)=5, baseSeq=s5; vS(b) minted
4 | k render (pin p≥retire stamp) | wk: flag=true → c=a → b's change irrelevant to c's k-value ✓ (k-world c "doesn't change")
outcome: committed changes, k-world c unaffected — per-world folds.
residual: none.
```

**T5 (urgent write to a — pending worlds include applied urgent state).**
```
1 | U: a.set(7) | receipt(a){7@s6,U}; K0 a=7; walk over K0∪K1: K1 a→c reaches c → W setState URGENT; TS(c)|=U
2 | U render | committed c = b (flag false) → unchanged → React bails cheaply ✓
3 | U commits/retires | fold a: base=7 (prefix rules permitting), vS(a) minted → fp(a,·) moves
4 | k render, new pass pin p≥U's retire stamp | M(c,wk): ladder — fp(a) moved (vS) → re-eval: flag=true, a: retired clause → 7 → c=7 ✓ k-world sees applied urgent state
outcome: matches Required; if k's earlier pass had finished-uncommitted, U's urgent delivery + React's restart re-render it fresh (value-blind delivery — no suppression exists to consult, S14/S16 dead).
residual: over-delivery cost (G-N).
```

**T6 (slot/world-id reuse hygiene after k retires).**
```
1 | k retires | entries stamped; prefix folded; vS mints; lockedIn bits+watermarks cleared on every root; slot k released at zero unswept entries: touchedList[k] sweep zeroes TS bits; dedup column zeroed; wc[k] zeroed at next intern
2 | new token j interns slot k | fresh wc; masks referencing old k-token are dead worldKeys (pin+epoch make them unreachable — no live pass holds them); effect snapshots are fp-based (atom-grain), not slot-based → immune
3 | stale M(c, old-wk) straggler | unreachable: worldKey contains old pin; ladder never consulted for it; episode reset drops it wholesale
outcome: no cross-identity validation path exists (I19's paired-clear discipline; §15.1 rows).
residual: the recycled-slot battery pins it.
```

**T7 (two live batches render together; one suspends; one commits alone).**
```
setup | c = flag ? use(fetch(a)) : b; k1 flips flag, k2 writes b
1 | joint pass (mask {k1,k2}, lineage L12) | M(c, w12): flag true → ctx.use position 0 under L12 → entry((c,L12,0)) minted; pass suspends
2 | React abandons joint; renders k2 alone (mask {k2}, lineage L2) | separate worldKey w2 → M(c,w2): flag false (k1 excluded) → c = b(new) → commits ✓ single-batch view coexists (distinct memo, distinct lineage)
3 | k2 retires | folds; vS mints; L12 dead at abandon → its entries dropped
4 | k1 retried (mask {k1}∪retired, lineage L1) | suspends via entry((c,L1,0)); settle → retry same lineage → same thenable (prefix stable) → settled value; k1 commits ✓
5 | canonical throughout | flag=false → b — never suspends ✓
outcome: per-worldKey memos + per-lineage caches give multi-batch and single-batch views over the same nodes without interference.
residual: lineage death ordering at abandon — fork test 9.
```

**T8-E (re-track displacement — E-PRESERVE leg).**
```
setup | committed flag=false (c=b canonically); k live with receipt on flag; NEWEST pull of c re-tracks K0 deps to {flag, a} (flag=true in K0) — b→c edge displaced from K0
1 | K0 re-track drops b→c | live receipts exist → E-PRESERVE mirrors b→c into K1 (exempt from delivery — path pre-existed, bits already present)
2 | new batch j: b.set(4) | walk from b: K1 mirror reaches c → TS(c)|=j; W setState in j's lanes ✓
3 | j render | committed+j world: flag=false → c=b=4 ✓
outcome: committed-world reach survives newest re-tracks — the third leg of invariant R's construction.
residual: E-PRESERVE correctness is dev-validated (SP2); its absence would break invariant R's leg 3 — the validator is on the critical path.
```

**T9 (edge-acquisition propagation through existing out-edges — I17).**
```
setup | c→n→m existing (K0), m watched by Wm; equality cutoff left n CLEAN and unflagged; k writes a (TS(a)∋k); later a k-world eval of c records NEW K1 edge a→c
1 | edge-add a→c | newBits = TS(a){k} & ~TS(c) = {k} → TS(c)|=k; recurse c's existing out-edges: TS(n)|=k, TS(m)|=k (n's CLEAN status irrelevant — marks flow through, not stopped by cutoff); m watched → deliver runInBatch(k, setState(Wm)) (queued to yield/end if in-render)
2 | any world read of n/m for a k-including world | TS≠0 → world path → correct fold ✓ (flag-only counterfactual: m unflagged → fast path → stale K0 serve — the I17 hole)
outcome: node-local fixup is insufficient (I17); propagation + delivery close both the routing and the scheduling halves.
residual: propagation recursion cost — bounded once per (node, slot) per episode (§6.3).
```

**T10 (retroactive delivery — the HX-3 schedule).**
```
setup | flag=false, a=0, c=flag?a:0; W on c (K0 dep {flag}); T1 holds unrelated React work
1 | T1: a.set(1) | receipt(a){1@s1,T1}; a has NO out-edges → walk marks a only; W NOT scheduled in T1 (nothing reaches it — yet)
2 | T2: flag.set(true) | walk flag→c → W scheduled in T2; TS(c)|=T2
3 | joint {T1,T2} pass evaluates c | fold: flag=true, a=1 → c=1; K1 edge a→c recorded → newBits = TS(a){T1} & ~TS(c){T2} = {T1} → TS(c)|=T1; c watched → QUEUED delivery bit T1 (in-render) → drains at the pass's yield/end edge: runInBatch(T1, setState(W)) — a REAL pending update in T1's lanes, surviving pass discard
4 | pass discarded; T2 renders alone | W re-renders via its T2 update: wT2: flag=true, a=0 (T1 excluded) → c=0 → T2 commits 0 ✓; T2 retires (vS mints)
5 | T1 renders | W's T1 update pending (step 3) → re-renders: wT1 = {T1}∪retired: flag=true, a=1 → c=1 → ONE consistent T1 commit — no bailout tear
outcome: edge-add propagation carries retroactive lane delivery; the reach induction's premise (basis edges present when receipts land) is restored by construction the moment the edge exists.
residual: queued-delivery drain ordering — fork test 14; token retired while queued → fixup/committed-compare fallback (§11.2).
```

**T11 (staged evaluator — dual closures, one fiber).**
```
setup | useComputed hook node c; committed evaluator f_A; transition T renders with new prop → would install f_B
1 | T's render invokes hook | deps ≠ committed → stage {f_B, deps, fnStamp2} in T's pass frame; node keeps committed f_A; T yields
2 | urgent U renders same fiber (committed props) | deps == committed → no stage in U's frame → M(c,wU) evaluates with f_A → U commits an A-consistent frame ✓ (dual-closure need met — two passes, two evaluators, zero shared mutation)
3 | yield-gap NEWEST read | k0.pull uses the committed evaluator f_A ✓ (uncommitted closure unreachable outside its pass — §11.1 construction)
4 | T resumes | its staged f_B; M(c,wT) records staged fnStamp2 → c per f_B ✓
5 | T commits | hook's commit effect promotes f_B (+fnStamp2) — hook-grain; discard variant: staged table dies with the pass; committed-world effect flush evaluates f_A ✓
outcome: evaluator identity is world-scoped state (I22); every face of the HC-F2/HX-1/CX-1 stratum walked.
residual: promotion ordering vs other layout effects — hook-effect order is React's own; the differential battery pins it.
```

### C2 — flushSync excludes a pending default batch (+ C2-M)

```
C2: after a default-batch write, a flushSync render must read a=0 AND c=10.
setup | a=0, c=a+10; Wa on a, Wc on c
1 | event: a.set(1) | fork classifies → default token D; receipt(a){1@s1,D}; K0 a=1; wc[D]=s1; walk: a→c → Wa, Wc setState in D's context (default lanes); TS(a)|=D, TS(c)|=D
2 | same event: flushSync(setState X) | React renders SyncLane only — F2 mask excludes D (fork test 12); pin p≥s1
3 | Wa read | TS(a)∋D → world path: fold a: entry slot D ∉ M, unretired, unlocked → invisible → 0 ✓
4 | Wc read | TS(c)∋D → M(c, wSync) EMPTY → world-eval: reads a → 0 → c=10 ✓ BOTH old — no torn frame
5 | D renders later (mask {D}) | a=1, c=11; commits; retires → fold: base(a)=1; vS(a) minted
outcome: matches Required — the receipt (always-log, I1) makes the older world reconstructible; TS marks route BOTH a and its downstream cone off the canonical fast path (trap (b) answered by invariant M: the write walk marked c at step 1).
residual risk: fork test 12 (mask parity under flushSync) is the load-bearing fact.

C2-M (mount inside the flushSync pass — default batches in fixup):
1 | W mounts in the sync pass reading c | first render: world path → 10 ✓
2 | layout fixup | TS(c)∋D; D is LIVE and WRITTEN (default INCLUDED — the R8-fix) → runInBatch(D, setState(W)); committed compare: v_now=10 == rendered → no urgent corrective
3 | D's render | includes W fresh → 11 → one consistent D commit ✓ (deferred-only enumeration would have bailed out W → torn D commit)
outcome: fixup enumerates ALL live written tokens (HX-6 closed).
residual: fixup-window battery row.
```

### C3 — rebase parity (+ C3-E)

```
C3: T:+1 then U:×2 over a=1 must show 2 (urgent), commit 2, then T shows 4, commits 4; plain set 5 commits 5.
1 | T: a.update(x=>x+1) | fold frame applies +1 to K0 newest (reads inside would throw — R12): receipt{+1@s1,T}; K0 a=2
2 | U: a.update(x=>x*2) | receipt{×2@s2,U}; K0 a=4
3 | urgent render (mask {U}, pin≥s2) | fold: base 1; skip s1 (T∉M); apply ×2 → 2 ✓
4 | U commits/retires | retiredSeq(s2)=s3; compaction: all-retired PREFIX only — s2 sits behind unretired s1 → fold BLOCKED (base stays 1; CH-4's 3-not-4 unrepresentable); vS(a) minted; committed world: retired clause admits s2 → 1×2=2 ✓
5 | T render (mask {T}∪retired) | fold: base 1; +1@s1 → 2; ×2@s2 (retired≤pin) → 4 ✓ replay in write order (I2)
6 | T commits/retires | prefix now fully retired → base=4, baseSeq=s2; committed 4 ✓; useReducer differential matches at steps 3–6
7 | plain-set variant | pending +1@s1(T); U: set 5@s2 → U view: base 1 → set 5 → 5; commit 5; T view: 1+1=2 → set 5 → 5; final 5 ✓ (not 6)
outcome: replay-in-write-order over the pre-batch base (I2); apply-and-discard folds are structurally absent (nothing ever discards — S1).
residual: compaction prefix rule — oracle regression pin (CH-4).

C3-E (custom equality — stepwise stabilization, I29):
setup | isEqual = group equality; committed A; T: set B (¬eq A); U: set C with isEqual(B,C), ¬isEqual(A,C)
1 | live path | T: K0 A→B; U: applyStable(C vs B): equal → KEEP B ref (marks skipped); receipt appended anyway (I7 — history non-empty)
2 | fold(U-only) | base A → set C: ¬eq(A,C) → C ✓ (U's render shows C)
3 | fold(T+U) | A → B (¬eq) → C: eq(B,C) → keep B ✓ (matches live K0 ref)
outcome: each view gets its own correct representative; post-fold equality could satisfy only one (LX-8 dead).
residual: per-view fold-equality differential test.
```

### C4 — two-batch write into an already-stale region

```
C4: W (on c over a) must be scheduled in T2's lane after T1 already made the region stale.
1 | T1: a.set(1) | receipt; walk a→c → W setState in T1's context; dedup(W,T1) set; TS|=T1
2 | (no render yet) T2: a.set(2) | receipt slot T2; walk a→c → dedup is PER-(watcher, SLOT): (W,T2) unset → setState(W) in T2's context ✓ both lanes hold W updates
3 | T2's render includes W | wT2 = {T2}∪retired: a=2 (T1 excluded) ✓; T1's render later: a=1 ✓
outcome: per-slot dedup has no once-per-staleness collapse (I5); marks never gate delivery (they gate routing only).
residual: dedup column cleared with slot (I19; §15.1 row).
```

### C5 — cutoff-suppressed first write, effective second write

```
C5: c = a*0 + b; k writes a=1 (c's value unchanged) then b=7; watcher must see 7 in k's lane.
1 | k: a.set(1) | receipt; K0 a=1, c recomputes on demand to 0 (equal → K0 cutoff stops donor marks); walk a→c is VALUE-BLIND → W setState in k's lane anyway (no suppression exists — D13); dedup(W,k)
2 | (optional) k-world eval of c | M(c,wk) = 0, r.seq=eval stamp ≥ s1
3 | k: b.set(7) | receipt{7@s2,k}; wc[k]=s2; walk b→c: dedup(W,k) set and W not yet rendered → no duplicate setState — the PENDING k-lane update from step 1 already guarantees W renders in k; if W HAD rendered between (re-arm cleared dedup) → fresh setState ✓ either way W renders in k after s2
4 | k render | M(c,wk): wc[k]=s2 > r.seq → invalid → re-eval: 1*0+7 = 7 ✓ first evaluation's 0 cannot be served
outcome: value-blind delivery + per-slot clocks — the "suppressed broadcast" premise never arises, and cache validity is write-clock-gated.
residual: G-N spurious-render bound (the step-1 delivery may cause one equal render — priced, never wrong).
```

### C6 — lane attribution under grouped notification (HANDLE IT)

```
C6: batch(() => { a.set(1); startTransition(() => b.set(2)) }) — per-write context must survive.
1 | a.set(1) inside batch() | engine batch() defers CORE-EFFECT flush only (D10) — watcher delivery is per-write: fork.currentBatchToken() → event token U; walk delivers a's cone setStates NOW, in U's context → urgent lanes ✓
2 | startTransition(() => b.set(2)) | inside the transition scope, currentBatchToken() → T; walk delivers b's cone setStates NOW, inside the scope → React assigns transition lanes ✓ one T commit carries them
3 | batch() closes | core effects flush once (NEWEST contract); no watcher work remains
outcome: named mechanism = per-write synchronous delivery in the writer's context (D5/D10) — there is no grouped drain to preserve context across. Implicit grouping: NONE EXISTS anywhere in the design (delivery is per-write; the only deferral is core-effect flush, which carries no lane context) — the trap's second half answered by absence.
residual: none; C6 conformance test pins both lanes' commits.
```

### C7 — writes and reads during a yielded render pass (+ C7-D)

```
C7: yield-gap handler reads newest, writes under the click's batch; resumed pass keeps its pinned world.
1 | T's pass P (mask {T}, pin p) yields | F2 yield edge pops P's binding (per-callstack truth, I6)
2 | click handler: a.state | no pass binding on this stack → NEWEST → K0 value (includes T's applied write — newest by definition) ✓
3 | click handler: a.set(5) | guard: no restricted frame → ok; token = click's U; receipt{5@s9,U}; walk delivers in U's context ✓ no throw, correct classification (S7's wall-clock scoping is structurally absent)
4 | P resumes | binding re-pushed: (mask {T}, pin p); reads fold with seq ≤ p → s9 excluded → original pinned world ✓; retirement compaction can't fold below live pin p (C7 retention, §5.3 step 2)
outcome: matches Required on all three clauses.
residual: fork test 5 (handler-in-gap) is the load-bearing fact.

C7-D (RENDER_NEWEST demotion — HC-F3):
setup | React-state-only transition (zero live receipts) → P classified RENDER_NEWEST; component X reads a=0 straight from K0; P yields
1 | click: a.set(1) | write path: liveRenderNewestCount>0 → DEMOTE P to its real (mask {T}, pin p — original, captured at pass start) BEFORE appending the receipt; then receipt{1@s1,U}, K0 a=1
2 | P resumes; Y reads a | P now routes world path: fold a at pin p → s1 > p → 0 ✓ X and Y agree — the pass observes ONE world at the read level (not a fixup rescue)
outcome: RENDER_NEWEST is revocable (R3); one global counter check on the write path when no such pass lives.
residual: demotion is O(live RENDER_NEWEST passes) per first write — bounded by live passes; G-W includes it.
```

### C8 — equality drops must not lose receipts

```
C8: T: a.set(1); then U: a.set(1) (equal to newest). U's world must show 1.
1 | T: a.set(1) | tape was empty → base=0 recorded; receipt{1@s1,T}; K0 0→1
2 | U: a.set(1) | history NON-empty → receipt appended unconditionally {1@s2,U} (I7); applyStable: equal → keep ref, skip K0 marks; walk still runs (value-blind)
3 | U render (mask {U}) | fold: base 0; skip s1; set 1 @s2 → 1 ✓
4 | T retires committed=false later (or commits) | fold in seq order → 1; committed 1 ✓ (no truncation surface exists — C17 — so "T truncated" is unrepresentable; retirement folds regardless of committed flag, D2)
5 | two overlapping transitions writing 1 | receipts s1(T1), s2(T2); each world folds its visible subset → 1; committed after both retire → 1 ✓
outcome: equality lives in fold stabilization and rendered-value compares only; write-time drops happen only on empty history (the one legal case, evaluated once against base).
residual: C8 conformance rows incl. the empty-history drop's functional-op variant.
```

### C9 — mount mid-transition (existing and fresh nodes)

```
C9: both an existing computed and a freshly created node must read the pass's world (incl. k) on FIRST render.
setup | k wrote atoms (receipts, walks done); k's pass P (mask {k}, pin p) rendering; component mounts inside P
(a) existing computed c over k-touched atoms
1 | mount render reads c under P's binding | TS(c)∋k → world path → M(c,wk) (fresh or shared with siblings) → k-world value on FIRST render ✓ no canonical leak, no double render
2 | layout fixup | runInBatch(k, setState) corrective is redundant for a mount rendered inside k's own pass → React bails (bounded by G-F); committed compare: v_now(committed) vs v_rendered(k-world) may differ → hmm: the compare guards the RETIRE race; k live → live-token loop already covers k; the unconditional compare fires setState only if v_now ≠ v_rendered AND no pending update exists — W already has the k update → absorbed ✓
(b) fresh node n (useComputed created during this render)
1 | node minted → staging list (S15); no K0 cache → ¬CT(n) | routing: TS(n)=0 BUT ¬CT → fast path REFUSED (freshness conjunct) → world path: evaluate under wk, record K1 edges, memo ✓ first evaluation is world-routed eagerly — the "no marks yet" trap is closed by the CT half of invariant R, not by marks
2 | edge recording during that eval | any dep with TS bits propagates bits+deliveries to n per §6.3 site 3 ✓ n joins the influence cones it read from
3 | commit | hook commit effect promotes n out of staging; discard/StrictMode-abandon → pass/lineage death reclaims the record (S15 — no arena leak)
outcome: (a) memo path; (b) eager world-routing for fresh nodes via ¬CT — the stated mechanism.
residual risk: staging promotion ordering with the fixup (both in the hook's commit window) — battery row.
```

### C10 — late subscription joins the pending batch (+ C10-R)

```
C10: W mounts after k's write, before k commits; ONE commit must carry k's updates + W's correction.
1 | k: a.set(1) | receipt; walk (W not mounted — nothing delivered to it); TS(a)|=k
2 | W mounts in an urgent pass; first render reads a | committed world → 0 (k unretired/unlocked) — W rendered 0
3 | layout fixup | TS(a)∋k; k LIVE+WRITTEN → fork.runInBatch(k, setState(W)) — the corrective joins k's OWN lanes → React's k render includes W's update → ONE commit carries k's writes and W's correction ✓ (a fresh startTransition would mint a different lane → React may commit it separately → a frame where k's world landed but W still shows 0 — the explicit why-not)
4 | committed compare | v_now(committed)=0 == rendered → no urgent corrective ✓
outcome: matches Required via F4.
residual: F4's semantics under lane retirement — test 7.

C10-R (races):
(i) k retires inside the render→layout window | live-token loop finds nothing; R11 guarantees the retirement fold completed BEFORE this layout effect → committed compare: v_now includes k (=1) ≠ rendered 0 → setState(W) urgent → pre-paint correction ✓ (I18's fallback is value-based, not liveness-based)
(ii) write lands after W's pass completed, before its commit | walk reaches n; W's watcher not yet registered → no direct setState; at layout the fixup's live-token loop schedules runInBatch(k) → F4's obligation: real further work for k's lanes (never absorbed into the finished tree) → k's next render includes W ✓; the just-landed commit is internally consistent (pre-write world) — bounded correction, not a tear
outcome: both windows close with in-lane or pre-paint corrections.
residual: fork tests 15/16 + the fixup-window battery.
```

### C11 — multiple roots: FULL spanning scope (+ C11-W)

```
C11: batch k spans roots A and B; A commits while B pends; A must keep including k; k retires exactly once.
1 | k writes a=1 | receipt{1@s1,k}; walks deliver on both roots' watchers in k's lanes
2 | A's k-pass (pin pA≥s1) commits | F3: onBatchCommittedOnRoot(k, A, pA) → lockedIn(A) += (slot k, watermark pA); NO retirement (B pends); R11: lock-in bookkeeping precedes A's layout effects
3 | urgent render on A | world {U} ∪ L(A): k's entries admitted up to min(pin, pA) → a=1 included ✓ A never contradicts its committed DOM
4 | A's passive effects | committed-for-root(A) = retired ∪ L(A) → see a=1 ✓ (even though k not fully retired)
5 | renders on B meanwhile | B's k-passes: mask {k} plain clause → 1 ✓; B's OTHER renders: k ∉ L(B), unretired → excluded → B stays self-consistent with ITS committed DOM ✓ (no single global committed world — committed-for-root is per-root by construction: the L(r) sets are disjoint state)
6 | B commits k | lockedIn(B) += (k, pB); last root → k retires EXACTLY ONCE (F3): fold, vS mints, bits+watermarks cleared from BOTH roots' lockedIn before slot release (I19)
outcome: full spanning support with per-root self-consistency; retirement exactly once.
residual: fork tests 3/15/16; O7's fork-side existence proof (G4 — biggest external risk, on the critical path).

C11-W (watermark — post-await writes must not leak into A):
1 | async action T writes a=1@s1 | carrier scope; parked
2 | root A renders {T} at pin p1≥s1; commits | lockedIn(A) += (T, watermark p1); effects on A see a=1 ✓
3 | post-await continuation: a.set(2)@s2 | carrier restores T (§12) → receipt slot T, s2 > p1; walk delivers W setStates in T's lanes
4 | urgent render on A | {U} ∪ L(A): T-clause admits seq ≤ min(pin, p1) → s1 only → a=1 ✓ A never contradicts its committed DOM (full-token lock-in would leak s2 pre-commit — S19a)
5 | A renders T's new update; commits | watermark advances to that pass's pin ≥ s2 → committed-for-A a=2 ✓
6 | action settles; T retires everywhere | retired clause unconditional; fold → 2; vS mints; bits+watermarks cleared ✓
outcome: lock-in is a write-PREFIX (I25); construction: the watermark is exactly the maximal seq any committed-on-A pass has shown, so committed-for-A never admits a seq no A-commit carried — base: first commit sets it to that pass's pin; step: only later A-commits advance it.
residual: watermark source == committed pass's pin — fork test 17.
```

### C12 — store-only transitions persist (+ C12-U, new)

```
C12: writes commit at retirement regardless of subscribers; async-action writes not before settle.
1 | startTransition(() => a.set(5)), zero subscribers | receipt{5@s1,T}; walk reaches no watchers (none exist) — delivery is not persistence
2 | T closes with no React work | F3 close: committed=false → retirement fold ANYWAY (D2): base=5, vS(a) minted; targeted effect flush drains a's touched effects → they see 5 ✓ persistence never keyed to subscription (S4 dead)
3 | async action: startTransition(async () => { a.set(1); await io(); a.set(2) }), no React work | scope enters token k (carrier armed); receipt{1@s1,k} — PARKED (F3): no retirement while the returned thenable pends
4 | await io() resumes (compiled driver) | carrier pushes k → raw a.set(2): currentBatchToken()=k → receipt{2@s2,k} — parked; NOTHING committed before settle ✓
5 | action settles | F3 retires k: fold in seq order → committed 2 ✓ not before (S21 dead — no ambient classification exists on this path)
6 | interleavings | two actions hold distinct tokens (74-matrix); a click between continuations classifies under its own event token (carrier null on that stack — finally-restored) ✓
outcome: C12's Required verbatim, both halves.
residual: carrier matrix = fork test 18; the §12.5 boundary is the ONLY path around step 4 — walked next.

C12-U (NEW — untransformed third-party async code inside an action; X1's walk):
setup | rung 2 (twin build); action token k armed; action body calls vendorSave() — an UNTRANSFORMED async fn from a non-bundled vendor chunk; boot self-test PASSED (app code is transformed; the vendor chunk escaped)
1 | action enters | carrier: currentToken=k; armedActions=1
2 | vendorSave() called | no wrapper (untransformed) → native async fn; its body runs synchronously to its first await with currentToken=k — a PRE-await vendor write here would classify under k correctly ✓
3 | vendor-internal await resumes | native machinery — no driver, no push → currentToken=null on that stack
4 | vendor post-await: a.set(9) | write path: currentBatchToken(): carrier null → ambient context → default token D minted; receipt{9@s3,D}; K0 applies; walk delivers in D's context; DEV: armedActions>0 ∧ carrier null → console warning naming the callsite class + the node_modules-transform / runInBatch remedies (imprecise by design — a concurrent click write would also warn; documented)
5 | D renders/commits/retires | committed a=9 BEFORE the action settles — the bounded deviation: attribution + timing of THIS write only; identical to the same write from a setTimeout callback
6 | soundness check | receipt exists (I1 ✓ never lost); folds for every world remain the seed math over well-formed receipts ✓ no torn frame anywhere (D is an ordinary batch; C2/C3-class walks apply to it verbatim); action k still parks ITS writes (s1... under k) → they commit at settle ✓
7 | remedy paths | bundler transform over node_modules (vendor chunk gains drivers → step 3 pushes k → full C12 semantics), or fork.runInBatch(k, …) wrapping the vendor continuation, or rung 1 AsyncContext (boundary class vanishes)
outcome: detection at the write site is impossible without banning legitimate concurrent input (stated limit); the failure is a DOCUMENTED MISATTRIBUTION BOUND — batch membership of the uncompiled write only; every structural invariant holds.
residual risk: the dev warning's false-positive rate in busy apps — test 19 pins the warning + message; the support matrix (§12.6) is the shipped contract.
```

### C13 — counter/world-id lifecycle soundness

```
C13: no stale bookkeeping from a previous episode may validate in a new one; every counter names its guard.
walk = the §15.1 master table, row by row (each row: retained-by / cleared-at / guard / forced test). The schedules:
1 | episode collision | drive to quiescence (refresh runs, K1 resets, epoch bumps); seed a straggler M(c, old worldKey) → unreachable: epoch-in-key mismatch (S18's class unrepresentable) ✓
2 | forced-small globalSeq | renumber at quiescent margin rewrites baseSeq/visStamp/fnStamp columns; heap snapshots epoch-guarded (stale ⇒ moved ⇒ one safe re-run); never-quiescent variant (held transition) → HARD DIAGNOSTIC THROW at the horizon — the named terminal behavior ✓ (CX-7's silent wait is absent)
3 | token wrap under 31 parked actions | allocator live-skips; 32nd transition entangles (F1 multiplexing = one token per lane-batch) ✓
4 | K1 tag wrap (4 episodes) | full clear sweep of retained-id columns at wrap ✓
5 | slot recycle with watermarks | retire clears bit+watermark on every root BEFORE release; touchedList sweep zeroes TS bits; wc zeroed at next intern (T6) ✓
outcome: every reset is paired with an epoch/generation guard on everything that retained the old values (I8/I19); the inventory is the closed list.
residual: the forced-wraparound battery must run per structure — CI-enforced from the schema sweep.
```

### C14 — StrictMode and replayed renders

```
C14: replayed renders pure; double mounts net one subscription; per-world thenable identity stable.
1 | double render of a component | reads route through memos (M(n,w) DONE → same value); K1 re-record of the same edge dedups against the node's adjacency; staged evaluator: deps re-compare → SAME staged stamp (idempotent) ✓ no observable graph mutation
2 | discarded sibling pass | staged evaluators + staged nodes die with the pass frame; lineage death reclaims staging (S15) ✓
3 | render-phase write attempt | guard's first line throws (pass binding) BEFORE any mutation → no double-fired writes ✓
4 | double mount/unmount of effects + observed lifecycle | R1's observed 0→1/1→0 is microtask-debounced → flap nets to one subscription; useSignalEffect double-invoke re-runs vs its snapshot (pure re-read) ✓
5 | render-phase setState restart (LX-4) | restart render re-compares deps against the pass's staged entry → new deps ⇒ NEW staged fnStamp ⇒ memo conjunct fails ⇒ re-eval with the new closure → committed output matches committed state ✓
6 | thenable identity across replays | positional cache keyed (node, lineageId, position); replay = same lineage (F5) → same entry → SAME thenable → React's use() re-suspends against one identity ✓
outcome: purity holds at every replay surface.
residual: StrictMode battery incl. the restart row; F5 stability = fork test 8.
```

### C15 — suspense across worlds

```
C15: mount-mid-transition suspends on the k-world thenable with stable identity; canonical never suspends; the world key is stated.
key & lifetime | identity = (node, lineageId, position) — lineage per (root × batch-set), minted at first pass, stable across restarts/replays, dead at commit/abandon (D11; NOT a token set — mask drift; NOT passSerial — refetch-forever; NOT mask∪locked — churn). Content validity = flattened prefix (§9.2).
1 | k suspends c | lineage Lk: entry(c,Lk,0) = {th, prefix=[(a, fp(a,wk))…]+[(c, fnStamp)], gen}; M(c,wk)=SUSPENSION{thRef, gen back-ref}
2 | component mounts mid-transition reading c | same pass lineage; purity ⇒ same reads ⇒ prefix pairwise-equal ⇒ SAME thenable → React use() suspends on the identical identity ✓ (react-concurrent-store's known bug = passing test)
3 | intra-batch write to a prefix dep d | wc[k] bumps; retry: fp(d,wk) moved → prefix mismatch at its position → drop positions ≥ it, fresh entry (lazy factory invoked — R14: no duplicate side effect from cache HITS; the miss legitimately re-fetches); old settle arrives → generation check → no-op ✓ (I20); write to a non-prefix atom → prefix stable → identity stable ✓
4 | settle → retry | back-ref kills M(c,wk) (gen-checked; belt sweep covers the race); retry runs a NEW pass (new pin, new worldKey, new memo) — but the prefix compares RECEIPT-LINE facts (fps, fnStamps), all unmoved → SAME entry → settled value, same identity ✓ (per-memo-instance stamps would livelock — HX-4)
5 | cross-batch retirement between fetch and retry touching prefix atom a | vS(a) minted at its fold → fp(a) moved → prefix mismatch → refetch from the moved world ✓ (stale-world replay dead — I21)
6 | unrelated urgent retirement storm | retired slot touched NO prefix atom → no vS mint on them → prefix stable → no refetch; the transition commits ✓ starvation excluded by the mint-site definition (S20 dead)
7 | canonical world | never routes through wk; c's committed value is the sentinel-free fold — no suspension observable ✓; commit/abandon drops the lineage (entries reclaimed); RENDER_NEWEST↔world boundary: one duplicate fetch / identity flip max (documented)
outcome: identity = lineage; validity = receipt-line content; all three trap keys excluded by construction (stated at "key & lifetime").
residual: prefix length on deep chains — O21/SPK-G8; determinism rests on purity (C14 pins).
```

### C16 — effects observe committed state only (+ B1)

```
C16: an applied-but-uncommitted default write must be invisible to useSignalEffect; visible after commit.
1 | D: a.set(1) (applied to K0, receipt, D pending) | walk enqueues a's effect subscribers into the root's touched-effect queue
2 | unrelated batch j retires → flush | drain is TARGETED: only j-touched effects compare; an effect E on a alone isn't in j's drain → E does not run ✓; if E first-runs at its own mount commit: committed-for-root fold excludes D (unretired, unlocked) → E reads OLD value ✓
3 | D commits/retires | fold: base=1, vS(a) minted; flush drains E: snapshot fp(a) moved → E re-runs seeing 1 ✓
4 | core effect() contract | documented NEWEST: sees a=1 at its synchronous flush point (or batch-close per configure) — stated, different, and walked ✓ (R13 benchmark integrability)
outcome: committed channel = committed-for-root folds + fp snapshots; the three flush triggers are I14's inventory.
residual: G-R flush targeting cost (SPK-R).

C16-B1 (visibility flip below the max — the I21 schedule):
1 | k1: a.update(+5)@s1 pending; k2: a.update(×3)@s2 commits on R | flush: E re-runs under committed(R) → sees 0×3=0; snapshot [(a, fp=s2)]
2 | k1 then commits/retires | fold makes the OLDER s1 newly visible beneath s2 — max of seqs unmoved (still s2) — but vS(a) mints at the fold → fp(a) = max(s2, baseSeq, rS, vS) = vS ≠ s2 → snapshot moved → E re-runs → sees (0+5)×3=15 ✓ (max-only fingerprint would sleep forever — HC-F1)
3 | lock-in-only variant (multi-root: k1 locks into R without global retirement) | the per-root lock-in ALSO mints vS → same re-run ✓
4 | compaction variant (judge-B1) | retirement compaction collapses entries → baseSeq + worldMemoEpoch move → S2 row already covers ✓
outcome: S2b closes the non-injectivity; over-invalidation is one extra compare per touching commit (safe direction).
residual: out-of-order-retirement differential in CI.
```

### C17 — optimistic rollback

Not exposed. The design has **no truncation surface** — React batches
never truncate, and D2 forbids drop-on-abort; ReducerAtom composes
optimistic UI in userspace (dispatch a compensating action). Nothing in
§5–§15 depends on truncation; the case is closed by deletion (the seed's
own escape), with C8's "if T is later truncated" branch therefore
unrepresentable.

### T8-N — cross-episode notification (quiescence refresh)

```
T8-N: a node whose basis edges live only in K1 must survive the K1 reset.
setup ep1 | committed cnd=true; w world-evaluated (basis edges x→…→w recorded in K1 only; never K0-pulled this episode); w has a committed watcher W
1 | quiescence sweep | REFRESH: w is K1-touched with a committed watcher → k0.pull(w) at NEWEST (legal — zero worlds live) → K0 re-tracks x→u→v→w (donor recursion fixes stale upstream); THEN K1 bump-resets, TS zeroes, epoch bumps
2 | ep2: k writes x | walk follows the REFRESHED K0 edges → reaches w → W delivered in k's lane ✓ (without refresh: no edge in any plane → silent torn k-commit — the schedule that forced the transplant)
3 | writing-computed variant | refresh pull triggers an R8-legal write → a token mints → quiescence has ENDED: finish the sweep, retry at the next quiescence; the node writes AGAIN → refresh-EXEMPT: its K1 in-edges carry into the fresh plane (over-notification only, bounded by the exempt cone, dev-warned) → reach preserved; episode resets ✓ (LC-F3's livelock dead — at most one retry per node per boundary, then carry)
outcome: the reach induction's basis-edge premise holds at EVERY episode boundary (the missing base-case restoration, now explicit in invariant R's step).
residual: refresh cost O(touched watched nodes) at quiescence — G-R class; exempt-set growth dev-warned.
```

## 19. Rejected variants and known gaps

**Rejected** (accumulated negative space; the schedule that killed each
lives in SCARS/round-2 Part I): no-log urgent writes (S1); canonical-only
topology for worlds (S2/S3); drop-on-abort (S4); evaluation-time-only
certificates (S5); watcher-count activation (S6); wall-clock render
scoping (S7); write-time equality gates (S8); routing without freshness
(S9); equality-filtered per-token correction (S10); commit-gate safety
nets (S11); unwatermarked shared folds (S12); per-(world, batch) frontier
retention (S13); canonical-value gates on cross-world notification (S14);
GC-fodder discards over arena records (S15); value-based delivery
suppression (S16); cross-write elision stamps (S17); pinless shared memos
(S18); full-token lock-in + pass-grain publication (S19); global
retire-clocks in resource keys (S20); ambient post-await classification
(S21); promise-patching carriers (S22 — measured); max-only fingerprints
(HC-F1); shared mutable evaluators (HC-F2); deferred-only fixup (HX-6);
per-memo-instance prefix stamps (HX-4); frontier pruning + evaluate-
cutoff + retire rings (CH-1/2/3, CX-2).

**Known gaps** (each owned, none hidden):
- **G1** fan-out re-walk cost under held batches — SPK-N1 (fallback:
  per-slot-mark delivery dedup, D13).
- **G2** restart-heavy revalidation (pin-in-key) — SPK-G8 (fallback:
  pinless-frontier hybrid, specced non-default).
- **G3** union-K1 over-notification — priced, never wrong.
- **G4** fork registry facts lack a current-generation existence proof —
  fork tests 2/3/4/13/15/16/17/18/19 on the critical path; the biggest
  external risk.
- **G5** E-PRESERVE validator cost — SP2.
- **G6** fixup bound in the react-concurrent-store harness — G-F.
- **G7** first-touch world-eval cost on huge graphs — G-E.
- **G8** LOGGED-quiet residual vs P3's ≤2% — SPK-L + O19 renegotiation.
- **G9** mid-episode abandoned-node sawtooth (staging reclaims at lineage
  death, not instantly) — bounded by lineage lifetime.
- **G10** browser carrier host-hook — **CLOSED by I30** (twin build);
  residual is G11.
- **G11 (new, X1)** uncompiled-vendor misattribution — bounded + dev-
  warned + boot-tested + support-matrixed (§12.5, walk C12-U); erased at
  AsyncContext (rung 1). Not a correctness gap in the battery's sense
  (no walk fails); a documented semantics bound.

## 20. Mechanism inventory (10 — the judge-countable list)

1. **K0 donor kernel, twin builds** (DIRECT = donor bytes; LOGGED
   op-table swap at bridge registration) — §4.
2. **Tape + base/baseSeq + ONE globalSeq line + equality-stable
   watermarked folds** — §5.1–5.2.
3. **Tokens/slots/masks/pins + watermarked per-root lock-in + closed
   mask lifecycle** — §5.2–5.3, §15.
4. **Closed change-source validity** (S1–S7 + S2b visStamp + S3 staged
   evaluators; unified predicate + ladder; CI audit sweep) — §8.
5. **World memos (EVALUATING marks) + lineage thenable caches with
   flattened-prefix content validity + lazy factory + settlement kill** —
   §9.
6. **K1 + E-PRESERVE + touchedSlots/touchedList + delivering edge-add
   propagation + invariant-R routing + RENDER_NEWEST demotion** — §6–§7.
7. **Notification walk** — per-write full reach, writer-context setState,
   per-(watcher, slot) dedup with render re-arm, targeted effect
   enqueue — §10.
8. **Watcher records + mount fixup (touched ∩ ALL live written +
   committed compare) + reconcile backstop + effect flush triggers** —
   §11.
9. **Fork protocol F1–F8** — incl. the carrier and its build substrate
   (twin-build async dispatch, boot self-test, ladder — §12; the
   transform realizes F8's carrier rather than adding a new runtime
   cooperator: the runtime state is still one token variable + one
   armed counter); 19 fork tests — §14.
10. **Episode lifecycle** — retirement folds with pin retention +
    pin-release sweep, quiescence refresh + resets, staging (node +
    evaluator), counter/allocator guards — §5.3–5.4, §15.

## 21. Test plan (inherited + this round's additions)

Inherited whole (D6): randomized replay oracle BEFORE machinery;
invisibility suite (179-case conformance inside a synthetic episode,
forced arena growth, exact pull counts); frozen-kernel contract suite;
bytecode budgets CI; useReducer/useState side-by-side differentials;
react-concurrent-store 14-scenario harness (incl. the known-bug row);
fingerprint-vs-oracle differential with cross-batch out-of-order
retirements and lock-in-only variants; staged-evaluator battery
(dual-pass, discard, StrictMode restart); edge-add retroactive-delivery
fuzz (reachable-receipt ⇒ delivered-or-scheduled); prefix
identity/content battery; watermark battery; fixup-window battery incl.
default-batch mounts; pin-release compaction + never-quiescent horizon;
fold-equality per-view differential; fold-read throw conformance;
W1/W2/W3/W5 permanent CI perf rows; forced-wraparound batteries per
§15.1 row.

Round-3 additions (X1): fork test 19 (boot self-test throw path;
probe-pass path; boundary dev-warn content); the SP-F8 74-check carrier
matrix promoted into CI (compiled-await identity, Promise.all, timers,
async generators, catch/finally restore, interleaved actions,
ambient-null restore); a C12-U conformance row (untransformed probe fn ⇒
ambient attribution + warning, with the runInBatch remedy asserted);
plugin snapshot tests (transform output per fn shape; probe injection;
version stamp); G-A perf row (unarmed dispatch at the noise floor,
armed ≤ +15 ns/await).

---

*Exit candidate. 10 mechanisms; 8 protocol facts (~12 reconciler sites,
19 fork tests); battery walked in full and self-contained (C1 family of
11, C2+C2-M, C3+C3-E, C4–C6, C7+C7-D, C8, C9, C10+C10-R, C11+C11-W,
C12+C12-U, C13–C16+B1, C17-by-deletion, T8-N); round-3 delta = X1 (I30
build surface: transform spec, ladder, boot self-test, boundary
semantics + bound, support matrix — walked at C12-U) + X2/X3/X4 clarity
and completeness; zero substantive mechanism changes otherwise; 6 open
spikes with pre-registered decision rules; unmeasured numbers are spikes,
never claims.*
