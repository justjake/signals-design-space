# Round 2 — HARDEN: the two-kernel champion with the validity/lifecycle stratum closed

Stance: inherit the round-1 champion (`rounds/round-01/synthesis.md`, D8) and
repair the ENTIRE round-2 docket without moving any load-bearing mechanism.
The architecture is unchanged: donor kernel K0 (closed, monomorphic) + K1
real world edges + always-log tape + clock/epoch validity + per-write
full-reach notification. What changes is the stratum round 1 under-walked:
**what makes a retained world-derived outcome valid, and what every counter,
mask, and arena record does across its whole lifetime.** The I16 family is
repaired as ONE closed change-source enumeration (§8, the auditable table),
not three patches; I17–I20, O13–O17, O14, S15, and the SPK-H/SPK-Q remedies
are each a named section with a walked schedule.

Respected settled decisions: D1–D11 all stand. D9's caveat ("clocks are
necessary, not sufficient — I16 extends the predicate") is exactly what §8
does. No DECISIONS reopened.

## 1. One-page summary (the whole concurrency story)

**Two builds, one engine.** DIRECT (no React) is the donor arena kernel,
verbatim — the DIRECT build's closures contain **zero concurrency
instructions, zero hook callsites, zero routing branches** (SPK-H and SPK-Q
both measured over budget; both are compiled out, §4). Registering the React
bridge — monotonic, never keyed to watcher count (S6) — swaps the engine's
op table once, at an asserted operation boundary, to the LOGGED build: a
logging write path, a world-routing read path, and two inline re-track hooks.

**One value truth plus receipts.** K0's value column holds the newest world.
Every LOGGED write — urgent included (I1) — passes the render-write guard,
appends a receipt `{op, slot, seq}` to the atom's tape, applies to K0
newest, and walks. Any world's value is a fold: base + entries visible under
`(retiredSeq≠0 ∧ retiredSeq≤pin) ∨ (slot∈mask ∧ seq≤pin)`, replayed in seq
order — clause-for-clause React's lane filtering and rebase (D3/I2). All
stamps — write seqs, pins, retirement stamps, and now every validity
fingerprint — mint from ONE monotone counter (I15, extended in §8: a
fingerprint is always a minted stamp, never a value recomputed from mutable
state, so no fingerprint can ever collapse back to a prior encoding).

**Worlds route reads; freshness guards the fast path.** A world = (include
mask over ≤31 slots, pin, per-root lock-in). The fork's pass lifecycle
drives a per-callstack `currentWorld`; yields reset it (I6). Non-NEWEST
reads serve K0 only when the node is unflagged AND servable without
recompute (invariant R); everything else world-evaluates into per-(node,
worldKey) memos, recording real K1 edges. The worldSensitive flag `F` is now
**path-transitive by construction**: every site that flips F 0→1 propagates
the flip through existing K0∪K1 out-edges (`raiseFlag`, §6.4) — equality
cutoff can no longer strand a CLEAN, unflagged, genuinely divergent
downstream node (I17).

**Validity is a CLOSED change-source enumeration.** §8's table lists every
event that can change a world-visible outcome — included-slot writes,
retirement (fold/compaction), evaluation-function identity, thenable
settlement, episode boundaries, world identity, node-identity recycling —
and, per source: the stamp that observes it, the predicate conjunct, the
clear site, and the forced test. One predicate family covers world memos,
thenable cache entries, and effect dep snapshots. Atom fingerprints are
`max(newest-visible seq, baseSeq, reducerStamp)` — monotone across
compaction (judge B1 dead), reducer swaps observed (O16), function identity
a conjunct (TKC-8), settlement an eager kill plus a pending-only belt
(TKC-2). A CI sweep pairs every eval input with a table row.

**Notification is a per-write full-reach walk in the writer's stack** over
K0∪K1, per-(watcher, slot) dedup re-armed on render (I5), no grouped drain
(C6 by construction), value-blind (SPK-N1 decides the cutoff knob). Mount
fixup is reach-based into every live deferred batch **plus an unconditional
committed-world compare fallback** — a batch retiring inside the
render→layout window can no longer make every corrective unreachable (I18).
Retirement and per-root lock-in run their own notification path (I14);
retirement now also **clears the slot's bit from every root's lockedIn mask
before slot release** (I19) — the mask/bit-column lifecycle is a sweepable
table, §15.

**Suspense** keys thenables by fork lineage (D11) with a **content-validity
conjunct**: each positional entry records the dep-fingerprint prefix that
fed the fetch; a pure retry reuses the identity, an included write that
touched the prefix drops the entry and refetches (I20). Settlement
invalidates sentinel memos eagerly, generation-checked (TKC-2).

**Async actions** (O14): the action's token parks until settle; post-await
classification follows the ambient context, exactly like React 19 — raw
post-await writes land in their own default batch (documented, differential-
tested), nested `startTransition` inside a pending action entangles into the
action's token (fork fact F8).

**Lifecycle**: staged fresh nodes reclaim at quiescence via deferred frees +
GEN (S15); the K1 epoch tag wrap-clears its column (tag-wrap was MISSED
notification, not over-notification — O13, claim corrected); globalSeq has a
named saturation guard with forced-small tests; the fork token allocator's
live-skip construction is written out (O13). Quiescence resets everything
behind epoch guards (C13, full table §15).

Numbers: DIRECT = donor verbatim [ARENA]. Gates: logged write ≤2× DIRECT;
LOGGED-quiet tier-0 ≤2% (SPK-L, queued — the residual of the compiled-out
taxes); fixup ≤ live-deferred-count renders + one committed compare per
flagged mount; world-eval cost ∝ flagged/non-fresh region. Unmeasured items
are spikes (§16), never claims.

## 2. Round-2 delta log (docket item → repair → section → walk)

| docket | repair | where | walked at |
|---|---|---|---|
| I16.a judge B1: compaction collapses fingerprints | fingerprints are minted stamps: `baseSeq = max folded seq` at every fold; never recomputed from mutable tape shape | §8.3 | C16-B1, C12 |
| I16.b TKC-2: sentinel memos survive settlement | settlement is change source S4: eager back-ref kill + pending-only belt conjunct; suspension memos never ladder-revalidate | §8.2, §9.3 | C15 steps 2–4 |
| I16.c TKC-8: fnVersion absent from predicate | `fnStamp` (globalSeq-minted) is conjunct #2 of the unified predicate | §8.2 | C1-T9, C14 |
| I16 as one repair | the closed change-source table + CI audit rule | §8.1 | C13 |
| I17 TKC-3B: node-local flag raise | `raiseFlag` propagates every 0→1 flip through existing out-edges; invariant F re-proved with three site classes | §6.4 | C1-T9 |
| I18 TKC-4: mount fallback unreachable | fixup's fallback = unconditional committed-for-root value compare (equality sound: it compares the corrective render's own world) | §11.2 | C10-R |
| I19 TKC-6: lockedIn never cleared | retirement clears bit(slot) from every root's lockedIn before slot release; mask/bit lifecycle table + schema sweep | §15.2 | C11 step 8, C13 |
| I20 CO-codex-4: lineage cache survives intra-batch writes | per-entry dep-fingerprint prefix; pure retry keeps identity, prefix-touching included write refetches | §9.2 | C15 step 5 |
| O14 async attribution | fork fact F8: ambient post-await classification (React-parity), nested-startTransition entanglement, park-until-settle; differential tests | §12 | C12 steps 3–6 |
| SPK-H remedy (measured 1.025–1.035 deep) | hooks exist only in the LOGGED build | §4 | — (gate G-Q/SPK-L) |
| SPK-Q remedy (measured 1.024–1.038 reads) | routing branch exists only in the LOGGED build | §4 | — (gate G-Q/SPK-L) |
| O13 counters | globalSeq renumber margin + hard throw; token live-skip allocator construction; K1 tag width + wrap-clear (missed-notification claim corrected) | §15.3–15.5 | C13 |
| S15 abandoned fresh nodes | staging protocol: per-pass staged list, promote at commit effect, defer-free to quiescence + GEN | §15.6 | C9, C14 |
| O15 fold-callback purity | dev-throw on signal reads/writes inside update()/reducers; prod reads untracked at fold world | §13.2 | C3 residual |
| O16 reducer identity | fold uses current-at-fold-time reducer; `reducerStamp` in the atom fingerprint; dev-warn on swap with pending receipts; declared parity scope + differential | §13.1 | C3, C13 |
| O17 previous + sentinel pins | `ctx.previous` exposed, per-world, R-guarded seeding; NEWEST settlement pinned; RENDER_NEWEST↔world flip = one duplicate fetch / one identity flip max | §13.3, §9.4 | C15 variants |

No load-bearing round-1 mechanism moved: K0/K1, tape/fold math, clocks+
epochs (extended, not replaced), the walk, reach-based fixup (extended),
lineage keys (extended), per-write delivery all stand as judged.

## 3. Concepts (defined before use; champion terms restated where extended)

- **K0** — donor arena kernel (`libs/arena`): one Int32Array plane, stride-8
  interleaved node+link records, alien-v3 push-pull, exact pull counts,
  179/179 [ARENA]. Holds newest values, newest topology, native staleness.
- **K1** — shadow plane of **world edges** only (dep edges recorded by
  non-newest evaluations + E-PRESERVE mirrors): no values, add-only while
  forked, bump-reset at quiescence.
- **DIRECT / LOGGED** — the two generated engine builds (§4). LOGGED entered
  once at bridge registration by op-table swap; monotonic (S6/D1).
- **globalSeq** — ONE 53-bit monotone counter minting write seqs, pass pins,
  retirement stamps, and **every validity stamp** (`baseSeq`, `valueStamp`,
  `fnStamp`, `reducerStamp`, settle generations). Saturation guard §15.3.
- **tape / base / baseSeq** — per-atom append-only receipts `{op, slot, seq,
  retiredSeq}`; base = accumulator of folded (compacted) entries; **baseSeq
  = max seq ever folded into base** (0 if never folded) — the monotone,
  collapse-proof half of the atom fingerprint (§8.3).
- **batch / token / slot** — fork-minted integer token per React batch
  (allocator §15.4), never reused live; interned to ≤31 slots (I10);
  include-sets are 32-bit masks.
- **world** — `(mask, pin, root?)`; visibility math as in §1 (seed-verbatim,
  both pins). **NEWEST** — everything; K0 raw. **RENDER_NEWEST** — a pass
  world whose selection equals newest: K0-routed reads, writes still throw.
- **worldKey** — interned `(mask, pin, rootLockInVariant)`, epoch-scoped.
- **world memo** — `M(node, worldKey) = {kind: VALUE|ERROR|SUSPENSION,
  value/box, valueStamp, seq, epoch, fnStamp, deps[(id, fp)], thRef?}` (§8).
- **fingerprint `fp(d, w)`** — the ladder's per-dep validity stamp: for an
  atom, `max(newest w-visible entry seq, baseSeq, reducerStamp)`; for a
  computed, its valid memo's `valueStamp` (§8.3).
- **worldSensitive flag `F(n)`** — per-node monotone episode bit: "a logged
  write this episode may make some world disagree with newest at or below
  here." **Path-transitive by maintained construction** (§6.4). Routing
  filter only; never the notification mechanism.
- **CLEAN_TRACKED (CT)** — K0 status predicate (one in-plane flags load):
  evaluated, push-maintained, no stale/pending bits — servable with zero
  recompute. Atoms with empty tapes trivially qualify.
- **raiseFlag(n)** — the one routine that flips F(n) 0→1 and propagates the
  flip through n's current K0∪K1 out-edges (§6.4).
- **watcher** — `{setState, lastRendered, lastRenderSeq, notifiedMask}`;
  value fields written at the commit edge only.
- **pass / pin / lineage / retirement / episode** — fork-scoped pass with
  yield/resume; pin = globalSeq at pass start; lineage = fork-minted stable
  id per (root, batch-set) across restarts/replays (D11); retirement =
  exactly-once fold; episode = quiescence to quiescence.
- **staging list** — per-pass list of arena node ids minted during that
  pass's renders; promotion/reclamation protocol §15.6 (S15).
- **fold frame** — the execution frame active while an updater/reducer
  callback runs during any fold; enforces O15's purity rule (§13.2).

## 4. The mode protocol: DIRECT/LOGGED twin builds (SPK-H + SPK-Q remedies)

Both spike rules triggered: SPK-H measured the two per-recompute hook
null-checks at deep 1.025–1.035× min across 3 sessions (>1% rule); SPK-Q
measured the NEWEST routing branch at reads 1.024–1.038× min (>2% rule,
thin margin — the idle-machine rerun stays queued as the cheap challenge).
Both costs are therefore **compiled out of DIRECT**, not branch-hidden. The
rebuild protocol, precisely:

1. **Two generated builds from one template.** The schema/codegen pipeline
   (settled apparatus, D6) emits `buildDirect(state)` and
   `buildLogged(state)` from one annotated source: regions tagged
   `@logged-only` (write logging, routing, hooks, watcher tables) are absent
   from the DIRECT output — not gated, absent. CI: regenerate-and-diff;
   per-build bytecode budgets; a symbol scan asserting the DIRECT bundle
   contains no tape/world/walk/hook identifiers.
2. **State outlives builds.** The state record (plane buffers, side columns,
   free lists, counters) is closure-external; each build binds its fields as
   `const` at build time (the only binding at const parity [GUIDE]). Growth
   already rebuilds closures at operation boundaries; the mode swap is the
   same maneuver.
3. **One mutable dispatch slot.** `engine.ops` is the single mutable field
   on a const engine record; every public entry point (prototype methods on
   Atom/Computed, `effect`, `batch`, `untracked`, `configure`) performs
   exactly one `engine.ops.X(...)` load+call. The donor's measured numbers
   already include this discipline (growth uses it) [ARENA]; user-held
   function identities never change across the swap.
4. **`registerReactBridge()`** asserts no eval frame, no walk, no open
   `batch()` (throws "register the bridge during setup" otherwise);
   allocates LOGGED-only state (empty tapes, K1 plane, clocks, watcher
   tables, staging); sets `engine.ops = buildLogged(state)`; latches the
   mode (monotonic — never back to DIRECT; S6/D1). Pending core-effect
   queues are state, so they carry over.
5. **Growth preserves mode**: `engine.ops = build[mode](grownState)`; a
   conformance test grows the arena under LOGGED and asserts hooks/routing
   still fire (the 179-suite runs inside a synthetic episode both before
   and after growth).
6. **The compiled-out inventory** (what LOGGED bodies add): write body =
   guard + token + receipt + clock + walk (§5.1); read body = one
   `currentWorld` check + §6.2 routing; recompute body = `beforeRetrack` /
   `afterRetrack` inline (guarded by one live-batch check, LOGGED-only);
   watch/unwatch body = watcher table maintenance. DIRECT bodies are donor
   bodies, byte-for-byte modulo codegen whitespace.
7. **The residual is a measured question, not a claim**: LOGGED-quiet (React
   mounted, no transitions) now carries the branch and hook costs that
   DIRECT no longer does. Gate G-Q (≤2% tier-0) binds the LOGGED-quiet
   build; **SPK-L** (§16) measures it. Mitigation ladder if it fails, all
   within-LOGGED: fuse `F∧CT` into one status load; hoist the world check
   into the per-pass entry (routing chosen once per pass segment, not per
   read) — never a watcher-count key (S6).

P3's clause "pure-core users execute zero concurrency instructions" is now
literal: the instructions do not exist in the build they run.

## 5. Value model: tape, folds, retirement

### 5.1 The logged write path (unchanged from champion; restated for §8 refs)

```
write(atom, op):
  if currentPassBinding occupied: throw        // FIRST, before any mutation (C14/R8)
  if foldFrame active: throw                   // O15: no writes inside updaters/reducers
  token = fork.currentBatchToken()             // lazy mint (allocator §15.4)
  slot  = internSlot(token)                    // zeroes slotWriteSeq at first intern
  seq   = ++globalSeq;  slotWriteSeq[slot] = seq
  if atom.tape.length == 0: atom.base = k0.value(atom)   // baseSeq keeps its prior value
  atom.tape.push({op, slot, seq, retiredSeq: 0})         // ALWAYS — equal values too (I1/I7/C8)
  k0.writeNewest(atom, apply(op, k0.value(atom)))        // equality may skip K0 marks only
  notifyWalk(atom, slot)                                 // §10: full reach, writer-context delivery
```

No write-time equality drop in LOGGED (I7's empty-history case is exactly
DIRECT, which keeps the donor skip). `update(fn)` and reducer application at
write time run under a fold frame (§13.2).

### 5.2 World value of an atom

`foldAtom(atom, w)`: base + visible entries in seq order; visibility =
`(retiredSeq≠0 ∧ retiredSeq≤pin) ∨ (slot∈mask ∧ seq≤pin)` (seed math,
both pins, I15). ReducerAtom rides the same tape with actions as ops;
reducer identity rules in §13.1.

### 5.3 Retirement

On `onBatchRetired(token, committed)` — fold either way (D2):

1. Stamp the slot's entries `retiredSeq = ++globalSeq` (shared line, I15).
2. Bump `worldMemoEpoch` (all world memos die; revival is the ladder's job,
   now collapse-proof — §8.3).
3. Per touched atom: fold the compactable prefix into base — an entry
   compacts only if `retiredSeq ≤ min(live pass pins)` and no smaller-seq
   unretired entry sits behind it (pin retention, C7). **On every fold,
   `baseSeq = max(baseSeq, max folded entry seq)`** (I16.a repair — the
   fingerprint an entry contributed while visible is exactly the fingerprint
   base contributes after compaction; no world's fingerprint moves when only
   representation changes, and no fingerprint ever returns to a prior value).
4. Run the retirement notification path (I14): fold-walk for atoms whose
   base moved; reconcile backstop (§11.3); per-root signal-effect flush
   check (§11.4), on an engine microtask for roots React will not commit.
5. **Clear bit(slot) from every root's `lockedIn` mask** (I19 repair —
   committed-for-root worlds now see the batch via the retired clause, so
   the mask's job is done; the stale-bit-into-recycled-slot tear of TKC-6
   becomes unrepresentable). Then release the slot at unswept=0 (I10);
   recycling zeroes its write clock and its watcher bit column.

### 5.4 Quiescence

Live batches = 0 ∧ live passes = 0 ∧ tapes compacted (lineage caches cannot
block it; hung fetches drop with their lineage): bump `episodeEpoch`
(wrap-clear duty §15.5); bump-reset K1; clear F flags; drop
worldKeys/memos; **run the staging reclamation sweep** (§15.6); optional
`globalSeq` renumber when past the saturation margin (§15.3). Every
retainer of old counter values is guarded per the §15 table (I8).

## 6. Worlds, read routing, and the flag invariant (I17 repaired)

### 6.1 Where worlds come from

NEWEST outside passes; pass worlds from fork F2 (`mask ∪ lockedIn(root)`,
pin, per-callstack `currentWorld` across yields — I6); committed-for-root
for effect flushes and fixups; writer's world never materialized. A pass
whose selection equals newest is RENDER_NEWEST: K0-routed reads, writes
throw (guard keys on the pass binding, never world identity).

### 6.2 Read routing (champion §5.2, unchanged)

```
read(node):                       // LOGGED build only; DIRECT read is donor-verbatim (§4)
  w = currentWorld
  if w is NEWEST or RENDER_NEWEST: return k0.pull(node)
  if F(node) = 1:
    if node is atom: return foldAtomMemo(node, w)
    return worldMemoRead(node, w)                             // §8
  if node is atom: return k0.value(node)                      // no live tape (invariant F)
  if k0.status(node) is CLEAN_TRACKED: return k0.value(node)  // invariant R
  return worldMemoRead(node, w)                               // stale/pending/fresh/unwatched
```

### 6.3 Invariant R (routed-serve soundness) — construction unchanged

As the champion §5.3: `F(n)=0 ∧ CT(n)` at a non-NEWEST read ⇒ the cached
value is world-invariant. The proof leans on (a) CT ⇒ zero recompute, (b)
E-PRESERVE basis-edge completeness, (c) **invariant F's path-transitivity**,
(d) computed purity. Round 1 verified (a), (b), (d); round 2 discovered (c)
was not actually maintained by all sites — §6.4 restores it. R's statement
and proof text are unchanged; its precondition is now true.

### 6.4 Invariant F, re-proved with maintained path-transitivity (I17)

**Statement.** For every node p: if a path `x → … → p` exists in the
CURRENT K0∪K1 edge set with `tape(x)` nonempty this episode, then `F(p)=1`.

**The round-1 hole (TKC-3B, schedule walked at C1-T9).** `afterRetrack`
raised F node-locally. A re-track triggered by something that is not a
receipted-write walk — the two real triggers are a **first evaluation** and
an **fnStamp bump** (`useComputed` closure change: no signal write anywhere)
— can acquire a flagged dep while the node's newest value stays equal;
equality cutoff then leaves downstream nodes CLEAN and unflagged, yet a
real flagged path now runs through them. Invariant R's precondition is
false exactly there, and it serves a divergent value.

**Repair — one routine, three site classes.** All F mutations go through:

```
raiseFlag(n):
  if F(n) = 1: return
  F(n) = 1
  for m in K0-out(n) ∪ K1-out(n): raiseFlag(m)     // iterative, scratch stack
```

- **Site class 1 — receipt walks**: `notifyWalk` (§10) flags every visited
  node; it already traverses the full cone, so it IS a propagation.
- **Site class 2 — edge creation, reader side**: when an evaluation (K0
  re-track/first-track via `afterRetrack`, or a world evaluation recording a
  K1 edge d→n) gives n a dep d with `F(d)=1`, it calls `raiseFlag(n)` — not
  a bare bit-set. E-PRESERVE mirrors need nothing: they copy an edge that
  already existed in K0, so the path set is unchanged.
- **Site class 3 — the flip itself propagates**: `raiseFlag` recurses
  through existing out-edges, stopping at already-flagged nodes.

**Induction.** Base: episode start — no tapes, all F=0, invariant holds
vacuously. Step over the four event kinds that can create a qualifying path:
(1) first receipt on x: `notifyWalk(x)` flags x's entire current reach
(class 1). (2) new edge u→v with F(u)=1: class 2 raises v; if v flips,
class 3 propagates to v's existing reach — covering every path that the new
edge completed. (3) new edge u→v with F(u)=0: no new flagged path exists
through it; if u later flips, class 3 crosses this edge then. (4) K0
re-track edge REMOVAL: shrinks the path set; a monotone over-approximation
stays valid. No other event mutates edges or tapes. ∎

**Cost bound.** F is monotone per episode: each node flips at most once, so
`raiseFlag` enqueues ≤ N nodes per episode total; each flipped node scans
its out-edges once; already-flagged stops cost one load per probing edge.
Amortized O(N+E) per episode across ALL raises — the same order as one
notify walk. No hot-path regression class; the per-flip work lands on
re-track/eval paths that are already recompute-priced.

## 7. K1: the shadow plane

### 7.1 Layout and population (unchanged)

Per shadow node `{firstOutLink}`; link records `{target, nextOut}`;
bump-allocated; add-only while forked. A cold parallel Int32 column on K0
ids holds `k1IdAndFlag` (bit 0 = F, upper bits = K1 id + episodeEpoch tag)
— cold columns sit outside the interleaving hazard [RESEARCH]. Population:
world evaluations append every dependency actually read (dedup by
link-exists probe); E-PRESERVE mirrors K0 edges before re-track replaces
them (one site, `beforeRetrack`; dev validator priced by SP2).

### 7.2 Tag lifecycle — the corrected claim (O13)

The champion §7.4 claimed a tag-wrap collision yields "at worst a shared
record = over-notification." **That claim is withdrawn — three codex
reviews converged on the refutation, and the schedule is a MISS**: a stale
tag that false-matches after wrap points n's column at a K1 id the reset
plane has not re-minted yet; a world evaluation's dedup probe then reads
virgin/garbage space (or, worse, appends an edge into space a later mint
initializes over), so the REAL edge n→m is recorded nowhere current; the
next write's walk through n follows someone else's list and **misses m** —
missed notification, a torn-frame class, not an over-notify class.

Repair: the tag is 16 bits; when `episodeEpoch mod 2^16` returns to 0 the
quiescence reset **bulk-clears the `k1IdAndFlag` column** (one Int32 fill,
O(N), once per 65,536 episodes) so a stale tag can never false-match.
Forced test: a build with a 2-bit tag drives 5 episodes and asserts (a)
every stale entry re-mints, (b) a seeded pre-wrap edge set still delivers
(differential vs brute-force reach). Row in the §15 table with set/clear
sites (I19 discipline).

## 8. Validity: the closed change-source enumeration (I16 — the centerpiece)

Round 1 shipped "clocks + epochs (+ ladder)" and three independent holes
were found in the same predicate family (judge B1, TKC-2, TKC-8). Per I16,
this section repairs the FAMILY: first the enumeration argument (why the
list below is complete), then the unified predicate, then each fingerprint's
construction. The table is the auditable artifact; a CI sweep keeps it
closed as the code grows.

### 8.1 The enumeration and its closure argument

A retained world-derived outcome is one of: a world memo `M(node, wKey)`, a
thenable cache entry `(node, lineage, pos)`, an effect dep snapshot, or a
commit-recorded watcher comparison value. Each caches some
`outcome = f_node(inputs)` where, by computed purity (R2/C14: render writes
throw; ambient reads other than signals are the user's declared
non-dependencies), the FREE VARIABLES of the outcome are exactly:

- the world-folded values of its tracked signal reads,
- the settled state of thenables passed to `ctx.use`,
- the evaluation function itself (`fn`, and for atoms-as-reducers, the
  reducer),
- `ctx.previous` (memo-internal: changes only when the memo's own value
  changes — no external source, §13.3),
- the world identity it was evaluated in,
- the identity of the node records themselves.

Untracked reads are excluded by contract (§8.5 of the champion, unchanged:
the user opted out of consistency for them, in both planes). Enumerating
the events that can move each free variable gives the closed table:

| # | change source | what it moves | observer (stamp + conjunct) | clear/reset site | forced test |
|---|---|---|---|---|---|
| S1 | write in slot s | folds for worlds with s∈mask; newest | `slotWriteSeq[s]=seq` at write; conjunct `∀s∈w.mask: wc[s] ≤ r.seq`; atom fingerprint's newest-visible-seq term | wc zeroed at intern and recycle | C1, C5 |
| S2 | retirement of a token (visibility flip, base fold, compaction) | every world's fold; fingerprints of folded atoms | `worldMemoEpoch++` (memos die); `baseSeq = max folded seq` keeps fingerprints monotone through compaction (B1 kill) | epoch monotone per episode; baseSeq persists across episodes, renumber-guarded (§15.3) | C16-B1, C12, C3 |
| S3 | evaluation-function identity (useComputed deps/closure; reducer swap) | `f_node` / reducer | `fnStamp` minted `++globalSeq` at swap; conjunct `r.fnStamp == node.fnStamp`; `reducerStamp` term in the atom fingerprint | die with the node (staging §15.6); dev-warn on reducer swap with pending receipts | C1-T9, C14, O16 differential |
| S4 | thenable settlement (fulfill or reject) | correct outcome of SUSPENSION memos and downstream | eager: settle handler kills sentinel memos via back-refs and re-delivers; belt conjunct: `r.kind = SUSPENSION ⇒ r.thenable still pending`; generation-checked late settles no-op | entries/memos die with lineage (commit/abandon) | C15 steps 2–4 + settle-race property test |
| S5 | episode boundary / counter renumber | the number line under every stamp | `episodeEpoch` in worldKey; epoch tag on the K1 column (wrap-clear §7.2); renumber rewrites the retained stamp columns (§15.3); every cross-episode retainer epoch-guarded (I8) | quiescence reset | C13 battery, forced-small builds |
| S6 | world identity (mask, pin, per-root lockedIn) | which fold is being asked for | structural: in the KEY (worldKey interns), never a conjunct | worldKey interns die at retirement/quiescence; lockedIn bits cleared at retirement (§5.3.5) | C11 |
| S7 | node-identity recycle (staged reclaim, free lists) | what `(node, …)` keys denote | GEN-tagged ids (donor free-list discipline); reclamation deferred to quiescence so mid-episode references never dangle (§15.6) | GEN bump at free-list reinsertion | S15 high-water test |

**Closure argument.** The free-variable list is complete by purity (the
evaluator can observe nothing else; `__DEV__` builds assert it by running
evals under a frame that intercepts engine reads). Each free variable's
every mutation path is one of S1–S7: signal values change only by write
(S1) or fold/visibility change (S2) or reducer/function change (S3) on the
one number line whose integrity is S5; thenables change only by settlement
(S4); world identity is the key (S6); record identity is S7. **Audit rule
(CI)**: the world-eval frame's input surface is declared in the schema
(every `ctx` field and every read route); the sweep fails if any input
lacks a table row — adding an eval input without naming its change source
does not compile.

### 8.2 The unified predicate (one family, three retainer kinds)

```
valid(r, node, w):                        // r = memo | thenable entry | effect snapshot
     r.epoch == worldMemoEpoch                        // S2 coarse (+ S5 via epoch monotonicity)
  ∧  r.fnStamp == node.fnStamp                        // S3
  ∧  ∀ s ∈ w.mask: slotWriteSeq[s] ≤ r.seq            // S1 coarse
  ∧  (r.kind ≠ SUSPENSION  ∨  r.thenable is pending)  // S4 belt (eager kill is primary)
                                                      // S6 lives in the key; S7 in id resolution
revalidateByLadder(r, node, w):           // on epoch/clock miss; NEVER for SUSPENSION memos
  if ∀ (d, fp) ∈ r.deps: fingerprint(d, w) == fp:
    r.epoch = worldMemoEpoch; r.seq = globalSeq       // re-stamp, no recompute
  else: recompute
```

Suspension memos never ladder-revalidate: recompute on any miss is cheap,
rare, and closes every settlement-vs-epoch race fail-closed. Effect
snapshots evaluate `w = committed-for-root`. Thenable entries use the
prefix variant (§9.2). The watcher comparator uses direct value comparison
against a fresh fold at reconcile time (no retained fingerprint to rot).

### 8.3 Fingerprints: minted stamps, never recomputed encodings (B1 kill)

```
fingerprint(atom, w)     = max(seq of newest w-visible tape entry (0 if none),
                               atom.baseSeq, atom.reducerStamp)
fingerprint(computed, w) = M(computed, wKey(w)).valueStamp   // recompute dep first if invalid
```

- `baseSeq` moves ONLY forward, at fold time, to the max folded seq (§5.3).
  The B1 collapse — tape empties at compaction, "newest visible entry"
  reverts to 0, matching a pre-write recording — is dead: after compaction
  the base term reports exactly the seq the folded entry reported before.
  Pre/post-compaction fingerprints are IDENTICAL for worlds that saw the
  entry (no spurious recompute) and MOVED for worlds that newly see it via
  the retired clause (necessary recompute). Old-pinned worlds are safe by
  pin-gated compaction: an entry invisible to a live pin cannot compact, so
  its absence can never be misread (C7 walk).
- `valueStamp` is minted `++globalSeq` whenever a recompute produces a
  value not `isEqual` to the memo's previous value (per-world equality
  cutoff), and fresh on memo creation. Because stamps are minted from the
  shared monotone line and never locally reset, a recreated memo can never
  reproduce an older stamp — cross-generation ladder compares fail CLOSED
  (recompute), never open. The champion's unstated hazard (memo death and
  recreation reusing small per-memo version numbers) is unrepresentable.
- `fnStamp` / `reducerStamp`: minted at identity swap (§13.1, §13.3).
- Cost: the atom fingerprint is one tape-tail inspection + two column loads
  + max; the predicate is int compares. Gate G-V (§16.1).

### 8.4 Worked B1 schedule (the fingerprint walk; full C16/C12 walks in §17)

Effect E depends on atom `a` (never written): snapshot records `(a, fp=0)`.
Batch k writes `a=1` (entry seq s1); k retires committed; compaction folds
the entry, tape empties, `baseSeq := s1`. Flush check: `fp(a, committed) =
max(0-none, s1, 0) = s1 ≠ 0` → re-run, effect sees 1. Round-1 predicate
computed `fp = 0` (no visible entry, no base term) `== 0` recorded → effect
never re-ran (C16/C12 silently broken). The repair is structural, not a
special case: no fingerprint is ever derived from a representation that
compaction can revert.

## 9. Suspense: lineage identity × content validity (I20, TKC-2, O17 pins)

### 9.1 The key (D11, unchanged) and the new conjunct

`ctx.use(thenable)` inside a world evaluation resolves through the
positional cache keyed `(node, lineageId, position)` — lineage is fork fact
F5, stable across restarts/replays of one (root, batch-set), distinct
across set changes, dead at commit/abandon. Identity alone was round 1's
answer; I20 showed identity without content validity replays a thenable
fetched from a stale world after an intra-batch write (lineage does not
change when the SET's members write again — that is what it is for).

### 9.2 Content validity: the dep-fingerprint prefix (I20 repair)

Each cache entry additionally records `prefixDeps = [(id, fp)]`: the
tracked reads this evaluation performed BEFORE reaching this `ctx.use`
position, with their §8.3 fingerprints at record time. On a later
evaluation reaching position p:

```
entry = cache[(node, lineage, p)]
if entry exists ∧ entry.gen == lineage.gen
   ∧ pairwise-equal(entry.prefixDeps, thisRun.depsSoFar):   // ids AND fingerprints, in order
  return entry.th                                            // identity stable (pure retry)
else:
  drop cache positions ≥ p for this (node, lineage)
  store fresh entry {th: userThenable, prefixDeps: thisRun.depsSoFar, gen}
  return userThenable                                        // new fetch, new identity — correct
```

Both required properties hold: **stable identity across pure retries**
(purity ⇒ same reads, same order, unmoved fingerprints ⇒ pairwise match);
**invalidate on included write** (a write to any slot in the world's mask
that touched a prefix dep moves that dep's fingerprint ⇒ mismatch ⇒
refetch from the new world's content). Strictly better than coarse: an
included write that provably cannot feed the fetch (not in the read prefix)
keeps identity and does not thrash. `untracked()` reads are invisible to
the prefix by the untracked contract (documented). Determinism of read
order across pure retries is the same purity fact positional caching
already required (C14). Fallback if prefix compares ever measure hot
(they are int compares over short arrays): a whole-run stamp — coarser,
still sound, more refetches — is the degenerate configuration, flagged,
not default.

### 9.3 Settlement (S4; TKC-2 repair)

At first insertion the engine attaches one settle continuation
(generation-tagged). On settle (fulfill OR reject):

1. Generation check: lineage dead or entry replaced → no-op (T6 preserved:
   hung fetches never block quiescence; late settles are inert).
2. Kill sentinel memos via back-refs: each SUSPENSION memo records
   `thRef`; the entry keeps the list of memo keys minted against it; those
   memos are deleted (not epoch-bumped — targeted).
3. Re-deliver: watchers reached by the suspended node's cone get their
   per-(watcher, slot) bits re-checked for the lineage's slots — React's
   own retry (its ping) plus our delivery cover both the React and the
   parked-world observers.
4. The belt conjunct (§8.2) covers the settle→handler race: a read landing
   between settlement and the continuation microtask finds
   `kind=SUSPENSION ∧ !pending` → invalid → re-evaluates; `ctx.use` then
   sees the settled thenable and unwraps synchronously.

Rejection settles into an error box by the same path (R2: errors are cached
sentinel values; a throwing getter cannot corrupt graph state).

### 9.4 NEWEST sentinels and the RENDER_NEWEST↔world boundary (O17 pins)

- **NEWEST settlement pin**: NEWEST evaluations use K0's policy-column
  sentinel cache (donor shape), never lineage caches. Settle of a NEWEST
  thenable marks the node K0-stale and notifies (core effects + watcher
  walk) so the next pull re-evaluates. Stated, tested.
- **Boundary pin**: a pass that suspends while RENDER_NEWEST holds a
  K0-column thenable T_a. If a new write forces the restarted pass into a
  real world w (selection ≠ newest), the lineage cache starts empty at
  position 0 → fresh fetch T_b. That is **at most one duplicate fetch and
  one identity flip per boundary crossing**, after which lineage stability
  holds. The reverse crossing (world → RENDER_NEWEST at another restart) is
  symmetric. Pinned by a conformance test; not a correctness hazard (React
  re-suspends on the new identity — the old world's data was stale anyway).

## 10. Notification: per-write walk, writer-context delivery (unchanged core)

```
notifyWalk(atom, slot):                        // synchronous, writer's stack (D5)
  stack=[atom]; ticket=++walkTicket
  while stack: n=pop
    if visited[n]==ticket: continue
    visited[n]=ticket; raiseFlag-mark(n)       // F(n)=1; walk IS site class 1's propagation
    push K0 out-edges(n); push K1 out-edges(n) // stale-GEN targets dropped (§15.6)
    for watcher W on n:
      if !(W.notifiedMask & bit(slot)):
        W.notifiedMask |= bit(slot); W.setState()   // React assigns the writer's lane
    if core-effect subscribers: enqueue once (NEWEST contract §11.4)
```

Full reach per write; no cross-walk marks (I5; the per-slot-mark fallback
stays specced, activates only if SPK-N1 fails). Dedup per (watcher, slot),
re-armed when the watcher renders in a pass whose mask contains the slot;
the slot-bit column also clears per root at that root's commit of the slot,
and at slot recycle (§15.2). Value-blind delivery is the priced trade
(SPK-N1 grid, O12 — the round's NEEDS-MEASUREMENT adjudication). The reach
induction (champion §9.2) holds verbatim; §6.4 strengthens its edge-
presence premise (path-flagging is now actually maintained at all sites).

## 11. React bindings

### 11.1 Watchers and hooks (unchanged + staging hook)

Hook-instance watcher record + `useState(version)`; reads route through
§6.2 under `currentWorld` (mount mid-transition reads the pass's world on
first render — C9a). `useComputed` mints its node once per hook instance
**into the current pass's staging list** (§15.6); deps-identity change
mints `fnStamp = ++globalSeq` (S3). Fresh nodes need no routing carve-out:
no K0 record ⇒ ¬CT ⇒ world-routed by the ordinary rule, recording real K1
edges. Registration (watcher attach, node promotion) happens in the commit
effect; discarded passes leave only staged (reclaimable) nodes and add-only
K1 edges. `lastRendered`/`lastRenderSeq` are written at the commit edge
only — a discarded render never poisons a comparator.

### 11.2 Mount/subscribe fixup (I18 repaired: reach + committed compare)

In the layout effect of a mounting/subscribing watcher on node n, with
`v_rendered` = the value this hook just rendered:

```
if F(n)=0 ∧ (n is atom with empty tape ∨ CT(n)): return          // invariant R fast-out
for each live deferred token t with slotWriteSeq[slot(t)] ≠ 0:    // reach-based (I13): NO equality filter
  fork.runInBatch(t, () => setState(W))                           // joins t's lanes (C10)
v_now = evaluate(n, world(committed-for-root))                    // memoized world eval, write-rejecting
if !isEqual(v_now, v_rendered): setState(W)                       // UNCONDITIONAL fallback (I18)
```

Why the committed compare is sound where equality FILTERS are not (I13):
I13 forbids equality-filtering of per-token correctives because per-token
projections cannot witness joint multi-batch divergence. The fallback here
compares against the ONE world an urgent corrective render would itself
read (committed-for-root at fixup time); if equal, that render is a
guaranteed no-op (render idempotence), so skipping it drops nothing. The
per-token correctives above it remain equality-free.

Why the fallback is now reachable in every race (TKC-4's hole): the round-1
trigger was `runInBatch` returning false — unreachable when the token
retired BEFORE the loop, leaving the live-token enumeration empty while the
retirement's fold had already moved committed values that the render (taken
in the pre-retire committed world) never saw, and the reconcile backstop
scanned only REGISTERED watchers (this one registers in this very effect).
The unconditional compare closes the window: retire-before-loop ⇒ committed
world moved ⇒ compare fires ⇒ urgent pre-paint correction. Cost: one
memoized world evaluation + isEqual per flagged mount (folded into gate
G-F; R-clean mounts still exit at line 1).

### 11.3 Reconcile-at-fold backstop (unchanged)

At retirement, watchers on fold-changed cones compare commit-recorded
`lastRendered` against a fresh committed fold; mismatch → urgent
corrective. Fires only in races routed elsewhere; a fired backstop in tests
is a bug (telemetry hook).

### 11.4 Effects (I14 triggers, unchanged; fingerprints per §8)

`useSignalEffect` reads in world(committed-for-root); snapshot deps
`[(id, fp)]` (§8.3 fingerprints — the B1 fix applies here, C16-B1 walk).
Re-run decided by fingerprint compare in that world. Triggers, all three:
(1) after each React commit on root r (lockedIn grew); (2) at retirement,
per root, on an engine microtask when React commits nothing (C12/C16); (3)
records drop at unmount. Core `effect()` keeps the donor contract —
observes NEWEST, flush-coalesced, sync-flushable under
`configure({flush:'sync'})` (R13) — the documented C16 divergence.

### 11.5 StrictMode (C14 summary)

Render-phase writes throw at the guard, first line, queue untouched.
Replays re-run world evaluations idempotently (same worldKey + lineage +
fnStamp ⇒ same memos/thenables; deps-identity unchanged between StrictMode
double renders ⇒ same fnStamp). Double mount/unmount: microtask-debounced
observed lifecycle nets to one. Discarded passes leave staged nodes
(reclaimed §15.6), add-only K1 edges (over-notify at worst), early-cleared
NM bits (over-delivery); commit-recorded watcher fields stay clean.

### 11.6 SSR / hydration (R10, unchanged)

Server runs DIRECT; state serializes as atom bases (+ ids/labels).
Hydration builds K0 from bases BEFORE bridge registration; LOGGED begins
with empty tapes; first receipts preserve hydrated bases. Version/schema
validated; RSC/Flight out of scope v1.

## 12. Async actions: attribution constructed (O14)

React 19's own semantics (the parity target, differential-tested): the
transition context is restored only for the synchronous prefix of an async
action; **a raw setState after `await` is NOT a transition** (React's
documented behavior — continuations lose the ambient transition without
AsyncContext); the action's pending state persists until the returned
promise settles; a nested `startTransition` issued while an async action is
pending entangles into the same lane pool.

The fork therefore exposes **F8 — async action scope** (not a reconstruction
from userspace, a reconciler fact):

- `onActionStart(token)` when `startTransition`'s scope returns a thenable;
  the token's retirement PARKS until settle (F3's parking, now with an
  explicit start edge).
- **Classification during a post-await continuation is the ambient
  context** — the fork answers `currentBatchToken()` from whatever
  event/priority context is live, exactly as it does for any other code.
  No "one token across the await" claim exists anymore; the round-1 walk's
  unaccompanied assertion is withdrawn.
- **Nested `startTransition` while an action is pending yields the SAME
  token** — the fork mirrors React's entangled-lane bookkeeping (entangled
  transitions share a lane ⇒ one batch ⇒ one token, I10/F1); this is the
  documented way to put post-await writes into the action.
- `onActionSettle(token, resolved)` → un-park → retirement proceeds.

Signal semantics that fall out (walked at C12): the action-batch's writes
(sync prefix + nested-wrapped continuations) fold at settle, never before;
a raw post-await write is its own default-priority batch and commits on its
own schedule — IDENTICAL to `useState` in the same schedule, which is the
parity requirement, and loudly documented (`startSignalTransition(action)`
helper wraps continuations for users who want everything parked). Fork
tests 13/14 (§14): two concurrent parked actions with interleaved
settlements, differential against React 19 `useState`; nested-entanglement
token identity.

## 13. Semantics pins (O15, O16, O17)

### 13.1 Reducer identity (O16)

The fold uses the reducer **current at fold time** (React uses the rendered
one — same answer for the stable-reducer pattern, and our declared parity
scope). A reducer identity swap (hook re-render with a new inline reducer):

- mints `reducerStamp = ++globalSeq` on the atom (S3): every world's
  fingerprint for that atom moves ⇒ memos/effects that folded old-reducer
  results recompute (no silent stale folds);
- dev-warns when receipts are pending ("ReducerAtom reducer identity
  changed with N queued actions; results may differ from useReducer —
  pass a stable reducer"), because a shared many-consumer atom cannot
  reproduce React's per-fiber rendered-reducer nuance exactly;
- is differential-tested at the declared scope: stable-reducer schedules
  must match `useReducer` step-for-step (C3 side-by-side); swap-with-
  pending-receipts schedules are pinned by our own conformance tests and
  the warning.

### 13.2 Fold-callback purity (O15)

`update(fn)` and reducer applications run under a **fold frame**, at write
time and at every fold/replay:

- Signal WRITES inside → always throw (re-entrant fold corruption;
  detectable at the write guard's second line, §5.1).
- Signal READS inside → `__DEV__` throws ("updater must be pure over its
  argument; read X before writing"); production resolves the read
  **untracked, in the fold's world** (deterministic, no edges, no validity
  entry — documented). React parity note: reducers reading external
  mutable state are equally undefined in React; we reject loudly where we
  can afford to (dev) and stay deterministic where we cannot (prod).
- Enforced by the same frame machinery as render-write guards; dev-only
  branch compiled by `__DEV__` define (E-rules).

### 13.3 `ctx.previous` (O17)

Exposed (donor parity). Definition per evaluation context:

- NEWEST/RENDER_NEWEST: the donor's semantics (last K0 cached value).
- World evaluation of (node, wKey): the prior `M(node, wKey).value` if one
  exists this episode; else K0's cached value IF the §6.3 R-conditions hold
  at that moment (F=0 ∧ CT — the value is proven world-agnostic, so
  seeding from it cannot leak canonical state into the world); else
  `undefined` (documented; conformance note pins the three-way rule).
- Change-source coverage: `previous` is memo-internal — it changes exactly
  when the memo's own value changes, which mints a new `valueStamp` (S-table
  §8.1); no new source row is needed, and the CI audit rule lists
  `ctx.previous` explicitly with that justification.

## 14. fork-protocol (the seam — 8 facts, versioned)

`__COSIGNAL_PROTOCOL__ = 2`; feature-detect, throw on stock React (no
silent degraded mode). Integers, booleans, documented callbacks only; no
Fiber objects, lanes, or queue internals cross the boundary.

- **F1 `getCurrentBatchToken()`** — lazy mint; `(serial<<1)|deferredBit`;
  never reused live (allocator construction §15.4); ≤31 live structural
  (entangled transitions share a lane ⇒ one token).
- **F2 pass lifecycle** — `onPassStart(root, tokens[], lineageId)`,
  `onPassYield/Resume(passId)`, `onPassEnd(passId, discarded)`,
  `getCurrentPassId()`. Flips at work-loop boundaries (per-callstack truth,
  I6/C7); `tokens` = exactly the batches whose updates the pass applies
  (mask parity — fold answers equal React's queue answers under any
  scheduling); restart = new passId, same lineage. `onPassEnd(discarded)`
  additionally drives staging reclamation eligibility (§15.6).
- **F3 retirement + lock-in** — `onBatchCommittedOnRoot(token, rootId)`;
  `onBatchRetired(token, committed)` exactly once.
- **F4 `runInBatch(token, fn): boolean`** — updates join the token's lanes;
  false if retired.
- **F5 lineage** — stable per (root, batch-set) across restarts/replays;
  new id on set change; dead at commit/abandon. The suspense identity key.
- **F6 DOM mutation window** (unrelated nicety; kept).
- **F7 version handshake**.
- **F8 async action scope** (NEW — O14): `onActionStart(token)`,
  `onActionSettle(token, resolved)`; ambient classification for post-await
  continuations; nested-startTransition-while-pending entangles to the same
  token; retirement parks between start and settle.

Rebase drill: lane renames → token registry is fork-internal, bindings
unchanged. Commit-phase moves → F3 edges re-anchor; invariant tests pin.
Update-queue rewrites → nothing (we never touch hook queues; rebase parity
lives in our tape). Scheduler/yield changes → F2 flip sites move with the
work loop; the yield-gap test re-asserts. **Async-action internals change
(the React-19-era surface most likely to move)** → F8's three facts are
re-implemented at the new sites; the library moves zero lines — the
differential test (fork test 13) is the tripwire. Library delta in every
drill: zero lines.

Fork test list (runs on every rebase; ~12 reconciler touch sites):
1 token mint/uniqueness; 2 retire exactly-once + async parking (+ the
per-segment-commit fact); 3 lock-in ordering vs paint/effects; 4 pass mask
parity (differential vs a probe hook); 5 yield truth (handler in gap sees
no pass); 6 restart lineage stability; 7 runInBatch entanglement +
dead-token false; 8 StrictMode replay events; 9 flushSync exclusion;
10 inertness (one null-check per site with no listener); 11 31-token
entanglement pressure (parked actions + new transitions ⇒ shared tokens,
no 32nd slot); 12 commit oracle (dev harness: no mounted watcher's
world-value disagrees with its rendered value at any commit); **13 (NEW)**
two concurrent parked actions, interleaved settlements, raw + nested
post-await writes, differential vs React 19 useState; **14 (NEW)** nested
startTransition during a pending action reports the action's token;
**15 (NEW)** retirement clears lockedIn bits on every root before slot
release (I19 ordering).

## 15. Lifecycle: counters, masks, staging, episodes (C13/I19/O13/S15)

### 15.1 Counter/stamp table (every counter: retainers, reset, guard, test)

| counter/stamp | retained by | reset | guard | forced test |
|---|---|---|---|---|
| `globalSeq` (53-bit; mints seqs, pins, retirement stamps, ALL fingerprints) | tape entries, memo seq/valueStamp, pins, retiredSeq, baseSeq, fnStamp, reducerStamp, settle gens | renumber at quiescence past margin (§15.3) | renumber rewrites retained columns; episodeEpoch guards JS-side retainers; hard throw at horizon if never quiescent | forced-small-margin build: wrap twice; near-2^53 unit |
| `slotWriteSeq[32]` | validity predicate | zeroed at intern AND recycle | recycle gated on unswept=0 (I10) after the retirement epoch bump killed citing memos | re-intern without writes |
| slot ids (5-bit) | notifiedMask bits, tape slots, lockedIn bits | recycle | unswept=0 gate; §15.2 clear discipline | slot churn battery |
| `worldMemoEpoch` | memos/snapshots (`r.epoch`) | never (monotone per episode) | episodeEpoch scopes it | C13 |
| `episodeEpoch` | worldKeys, K1 tag column, effect snapshots | never (monotone; tag wraps mod 2^16) | K1 column wrap-clear (§15.5) | 2-bit-tag build |
| `walkTicket` (int32) | visited stamps | wrap | zero stamp column on wrap | forced wrap |
| K1 ids | `k1IdAndFlag` column | quiescence plane reset | epoch tag + wrap-clear | §7.2 test |
| `lineageId` + entry gens | thenable/memo caches | batch-set commit/abandon | fork-minted serial; late settle gen-checked no-op | C15 |
| `fnStamp` / `reducerStamp` (globalSeq mints) | memos (conjunct), atom fingerprints | die with node / atom | staging GEN (§15.6); renumber rewrite | TKC-8 test; O16 differential |
| `baseSeq` (globalSeq mint at fold) | fingerprints, effect snapshots | never within episode; renumber rewrites | monotone-forward only (max at fold) | C16-B1 |
| token serials (fork, 30-bit) | slot registry, parked actions, lineage sets — LIVE only | wrap with live-skip (§15.4) | dev sweep: no engine table retains a token past its retire callback | 30-bit wrap with 31 parked actions |
| watcher `lastRenderSeq` | diagnostics only (reconcile compares values) | clamped at renumber | comparisons are value-based | renumber unit |

Rule (I8, enforced): every seq-typed field in the schema pairs with an
epoch/GEN/renumber row here; the schema sweep fails on unpaired fields.

### 15.2 Mask/bit-column table (I19 — new discipline)

Every mask or bit column declares set site, clear site, and the identity
recycle it must not outlive; the schema sweep checks declarations exist.

| column | set at | cleared at | outlives-check |
|---|---|---|---|
| `lockedIn(root)` bit(slot) | onBatchCommittedOnRoot | **onBatchRetired, before slot release (§5.3.5)** | slot recycle (TKC-6 dead: a re-interned slot starts clear on every root) |
| watcher `notifiedMask` bit(slot) | notify walk | render re-arm (pass mask ∋ slot); per-root commit of slot; slot recycle | slot recycle |
| `F` bit (k1IdAndFlag bit 0) | raiseFlag sites (§6.4) | quiescence bulk clear | episode (monotone within) |
| K1 tag bits | id mint | quiescence reset (inert via tag) + wrap-clear (§15.5) | episodeEpoch tag wrap |
| visited ticket column | walk | ticket compare (logical); zeroed at ticket wrap | walkTicket wrap |
| staging membership | node mint in a pass | promote (commit effect) or reclaim sweep | pass end + quiescence (§15.6) |

### 15.3 globalSeq saturation (O13 — the named guard)

Margin: `SEQ_RENUMBER_MARGIN = 2^53 − 2^32`. At any quiescence with
`globalSeq > margin`: renumber — tapes are empty and memos dead by
definition of quiescence; the surviving stamp COLUMNS (`baseSeq`,
`reducerStamp`, `fnStamp`, watcher `lastRenderSeq`) are rewritten in one
O(N) pass (order-preserving compaction of live stamps into low integers);
JS-side effect snapshots carry `episodeEpoch` and fail closed (one spurious
re-run each, harmless). If the process somehow reaches `2^53 − 2^16`
without a quiescence (theoretically ~centuries of continuous writes; also
reachable in forced-small builds), the engine throws a diagnostic
("globalSeq horizon; the app never quiesced") — a named, tested behavior,
never silent wraparound. Forced-small builds set margin ≈ 2^10 and drive
both paths (C13 battery).

### 15.4 Fork token allocator (O13 — the live-skip construction)

30-bit serial; mint = `do { serial = (serial+1) & 0x3FFFFFFF; if serial==0
serial=1 } while (serial ∈ liveSerials)`; ≤31 live tokens (I10) bounds the
loop at 33 probes; `liveSerials` includes parked actions (parked = live).
Safety of post-wrap reuse of DEAD serials: by construction no engine
structure retains a token past its retirement callback — the slot registry
entry, reconcile queues, and lineage sets for that token are dropped inside
the retire/abandon edges (dev sweep asserts emptiness at the end of each
retire). Therefore a recycled serial can only ever be compared against
live-token state, which the skip loop guarantees is disjoint. Forced test:
wrap the 30-bit counter with 31 parked actions held live; assert skip
termination and no aliasing.

### 15.5 K1 tag wrap-clear (O13)

As §7.2: 16-bit tag; wrap-clear of the column at `episodeEpoch mod 2^16 ==
0`; O(N) once per 65,536 episodes; kills the missed-notification schedule.
The champion's over-notify-only claim is formally withdrawn in this design.

### 15.6 Staging: abandoned fresh nodes reclaim (S15)

- Minting during any pass appends the node id to `pass.staged`.
- **Promote** at the hook's commit effect (watcher registration): id leaves
  staging; the node is now user-owned (donor lifecycle).
- **Abandon**: `onPassEnd(discarded=true)`, replay supersession, or a
  committed pass whose effect phase ends without promoting the id.
  Abandoned ids move to the deferred-free list.
- **Reclaim at quiescence, not mid-episode**: the deferred-free list
  reinserts into K0's free list (GEN bump per donor discipline) during the
  quiescence sweep, AFTER the K1 plane reset — so no live K1 link can ever
  target a reinserted id mid-episode (dangling references are structurally
  impossible rather than checked per traversal; walks pay nothing).
  Anything keyed by node id (memos, fingerprints) is already dead at
  quiescence; post-reclaim references from stale JS wrappers hit the GEN
  check and throw a dev diagnostic.
- Bound: mid-episode abandoned records are dead-but-unrecycled, bounded by
  the episode's own mount churn; the S15 killing schedule (repeat
  mount-evaluate-abandon) now shows a sawtooth, not monotone growth.
  Forced test: 10k mount-abandon cycles × 100 episodes → plane high-water
  stable; heapUsed + plane bytes reported side by side (P4).
- Core (non-React) API keeps the donor ownership story (explicit lifetime;
  arena records are freed by dispose/scope teardown) — S15's scope is
  render-minted nodes and is fully covered by staging.

## 16. Performance: gates and spikes

### 16.1 Gate table

| gate | class | budget | how |
|---|---|---|---|
| G-D | P2 DIRECT tier-0 | ≤ alien v3 every shape | donor kernel verbatim in the DIRECT build [ARENA]; 179/179, exact pulls |
| G-Q | P3 LOGGED-quiet tier-0 | ≤2% | the residual of §4 (branch+hooks now LOGGED-only); SPK-L measures |
| G-W | logged write | ≤2× DIRECT write | token ask (cached per batch) + push + clock + walk [SYNTH G-6]; SPK-W |
| G-N | notify walk | ≤2× DIRECT propagate; ≤1 spurious render per (watcher, batch) | full-reach walk = donor propagate class; dedup bounds setStates; SPK-N1 grid |
| G-V (new) | validity check | predicate = int compares; ladder ∝ direct deps; fingerprint = tape-tail + 2 loads + max | §8.2/§8.3 shapes; measured inside SPK-G8 |
| G-F | mount fixup | ≤ live-deferred-count extra renders + ONE committed world-eval+isEqual per flagged mount; 0 for R-clean mounts | §11.2; react-concurrent-store harness (O11 stays open pending numbers) |
| G-M | P4 steady re-render | 0 engine allocations | pooled tapes/memos/frames/staging lists; plane bytes + heapUsed side by side |
| G-P1 | P1 vs useState | ≤10%; 10k mount ≤15% | setState + one routed read + record append |
| G-E | world-eval cost | ∝ flagged∪non-fresh region, never whole closure | §6.2 routing; raiseFlag amortized O(N+E)/episode (§6.4); SPK-G8 |

### 16.2 Spike register (unmeasured ⇒ never asserted)

| spike | question | method | decision rule | status |
|---|---|---|---|---|
| SPK-H | K0 hook tax in DIRECT | donor vs hooked | >1% → compile out | **DONE — triggered (deep 1.025–1.035); remedy adopted §4** |
| SPK-Q | quiet-read branch tax in DIRECT | donor + NEWEST branch | >2% → compile out | **DONE — triggered (reads 1.024–1.038, thin margin); remedy adopted §4; idle-machine rerun = cheap challenge** |
| SPK-L (new) | LOGGED-quiet residual (G-Q) | LOGGED build, mounted-idle React, tier-0 + kairo; one-framework-per-process | >2% → §4.7 mitigation ladder (fused status load; per-pass routing hoist) | queued — the SPK-H/Q follow-up OPEN.md names |
| SPK-W | logged-write price (G-W) | set-heavy isolated writes | >2× → inline-2 receipts / tape pooling | queued |
| SPK-N1 | value-blind fan-out grid (O12) | cone 1k; writes/frame 100; suppressed-ratio × watchers {10,100,10k} | fail → per-slot-mark fallback or default-on evaluate-cutoff | queued (the round's adjudication) |
| SPK-G8 | held-open read bursts + G-V | kairo-scale held transition, mixed read/write | fail → per-(atom, worldKey) fold cache | queued |
| SP2 | E-PRESERVE dev validator (O3) | brute-force K1 cross-check on synthetic forked topologies | >10% dev overhead → sampled validation | queued |

Cost concentration (honest): logged write = O(cone) walk per write; first
k-read after a k-write re-validates the flagged region (ladder turns most
into fingerprint compares); retirement = O(slot atoms + watchers on changed
cones) + epoch bump; raiseFlag adds amortized O(N+E) per episode on
recompute-class paths; the I18 fallback adds one world eval per flagged
mount; prefix compares add O(position) int compares per suspense retry.

## 17. Correctness walks — full battery, re-walked against the hardened design

Notation: `tape(x)+={op,slot,seq}`; `wc[k]` slot clock; `M(c,w)` world memo;
`F(n)` flag; `NM(W)` notifiedMask; `K1: a→c` shadow edge; `CT(n)` =
CLEAN_TRACKED; `fp(x,w)` = §8.3 fingerprint; `bS(x)` = baseSeq. Steps
changed by a round-2 repair are marked ‡2. Every case below was re-walked
end to end; the lifecycle/validity stratum gets the same step depth routing
got in round 1.

### C1 — world-divergent dependency (family of 9)

C1: k writes `flag` then `a`; `c = flag ? a : b`; canonical deps {flag, b}.

```
step | actor/mechanism | state touched
1 | k: flag.set(true) §5.1 | guard ✓; tape(flag)+={true,k,s1}; wc[k]=s1; K0 newest flag=true, native mark c
2 | notifyWalk(flag,k) | F: flag,c (walk = class-1 propagation §6.4); W: NM bit k clear → setState in k's context; NM|=k
3 | k pass P1 (F2) | w1=({k},pin s1); currentWorld=w1
4 | W renders; re-arm | reads c: F=1 → world eval: flag folds true (K1: flag→c); a: F=0 atom no-tape → k0.value 0 (K1: a→c); M(c,w1)={0, valueStamp v1, seq s1, epoch e, fnStamp}
5 | k: a.set(1) | tape(a)+={1,k,s2}; wc[k]=s2; K0 newest a=1 (no K0 a-edges)
6 | notifyWalk(a,k) | reaches c via the REAL K1 edge a→c; W bit clear (re-armed) → setState in k's lane
7 | k re-render P2 | w2=({k},s2): predicate on M(c,·): wc[k]=s2 > memo.seq s1 → invalid; ladder: fp(a,w2)=s2 ≠ recorded 0 → recompute → c=1 ✓; new valueStamp
8 | committed/sync read of c | w3=(∅,pin): F=1 → world eval: flag base false → b → c=0 ✓ via b
9 | k commits (F3) | retiredSeq=++globalSeq; fold: bS(flag)=s1, bS(a)=s2 ‡2; epoch++; lockedIn bits cleared at retire ‡2; reconcile: commit-recorded lastRendered 1 == committed 1 → no-op; quiesce
outcome: k-world 1 pre-commit in k's lane; committed 0 via b. Matches.
residual risk: re-arm timing (notify-rearm property test); K1 dedup bug = over-notify only.
```

If step 4 never happened: NM(W) still holds k from step 2 → W scheduled;
its k-render pulls fresh (reach induction case (a)).

- **T2** (k writes committed-only dep b): K0 walk b→c delivers in k's lane;
  k-eval re-runs via clock; value unchanged → old valueStamp kept ‡2
  (per-world cutoff) → downstream ladder-quiet. Over-invalidation only ✓.
- **T3** (k: flag back to false): fold {true@s1,false@s3} → false → c reads
  b → 0; K1 gains b→c (add-only union) ✓.
- **T4** (urgent U writes b): walk b→c delivers in U's context; U render
  (k excluded): c = b-new ✓; k's world: fp(b, wk) moved too (b's write is
  visible in k's mask? U's slot ∉ k-mask and unretired → NOT visible →
  fp(b, wk) unmoved → ladder revalidates k's memo without recompute ✓
  exact-pull discipline preserved).
- **T5** (urgent U writes a=5): walk follows K1 a→c → delivered in U's
  context (spurious for U, priced G-N). k's next render: fold a =
  {1@s2, 5@s9} in seq order under k's mask/pin — U visible iff retired≤pin
  or U∈mask: mask-parity fact F2 makes our answer equal React's under
  either scheduling ✓.
- **T6** (slot/world reuse): slot released at unswept=0 after epoch bump;
  NM bits + lockedIn bits ‡2 cleared at recycle/retire; K1 tags fail
  cross-episode; wc zeroed at re-intern. Forced collision test ✓.
- **T7** (joint render, one suspends, one commits): pass P{j,k} lineage
  Ljk: c suspends → entry (c,Ljk,0) with prefixDeps ‡2; abandon → lineage
  dead, cache dropped, late settle gen-checked no-op; Pk lineage Lk
  separate → k-eval unaffected; k commits; j retries under Lj′ with
  retired-k visible via pin ✓.
- **T8** (the round-1 TK-F1 schedule): unchanged from champion §14 C1-T8 —
  stale-unflagged nodes fail CT → world-evaluate → K1 edges recorded; the
  serve is structurally unreachable (invariant R). Re-verified with §6.4 in
  place (raiseFlag only ADDS flags; R's precondition is monotonically
  stronger). ✓
- **T9 ‡2 (the I17/TKC-3B schedule — new)**:

```
setup | a=0; c = useComputed(f1: () => 5) evaluated → K0 c=5 deps{}; n=c+0 deps{c}; m=g(n) deps{n}; W on m; all CLEAN, F=0 everywhere
1 | k: a.set(7) | tape(a)+={7,k,s1}; a has NO out-edges → walk flags a only; F(c)=F(n)=F(m)=0
2 | hook re-renders: f2 = () => (a.state > 0 ? 5 : 6) | fnStamp(c)=++globalSeq ‡2 (S3); c's memo conjunct dead; K0 c marked for re-eval by fn change
3 | NEWEST pull of c | f2 runs: reads a newest=7 → 5 == old 5 → equality cutoff: n, m stay CLEAN in K0; afterRetrack: new dep a with F(a)=1 → raiseFlag(c) ‡2: F(c)=1, propagate out-edges: F(n)=1 → F(m)=1 (each flip once/episode)
4 | flushSync / committed-world read of m (w=∅) | F(m)=1 ‡2 → world eval: n → c → fold a base=0 → f2 → 6; m=g(6) ✓ consistent with a sibling reading c=6
5 | pre-repair counterfactual | afterRetrack node-local: F(c)=1 only; F(m)=0 ∧ CT(m) → invariant R serves K0 m=g(5) beside sibling c=6 → torn committed frame
outcome: raiseFlag closes the path-transitivity hole equality cutoff opened; divergence via fn identity (no signal write!) is also caught by the fnStamp conjunct at c's memo.
residual risk: a future F-site added without routing through raiseFlag — the invariant-F property fuzz (§19) asserts path-flagging directly.
```

### C2 — flushSync excludes a pending default batch

C2: default D applies `a=1`; flushSync renders SyncLane only.

```
1 | event: a.set(1) → token D | tape(a)+={1,D,s1}; wc[D]=s1; base=0 kept; K0 newest 1
2 | notifyWalk(a,D) | F(a)=F(c)=1; watchers setState in D's context
3 | flushSync → sync pass S | F2 tokens exclude D → w=({}∪lockedIn, pin s1); NOT RENDER_NEWEST (D live, excluded); lockedIn has no D bit (never committed — and bits clear at retire ‡2, so no stale bit can smuggle D in)
4 | read a | F=1 → fold: D invisible (slot∉mask, retiredSeq=0) → 0 ✓
5 | read c | F=1 → world eval: a→0 → 10 ✓
6 | D renders/commits later | mask {D}: 1/11; retirement folds base, bS(a)=s1 ‡2
outcome: (0,10) — the receipt (I1) + write-time cone flagging close both traps.
residual risk: fast-path regression — C2 conformance + invariant-F property test.
```

### C3 — rebase parity

C3: `a=1`; T `update(+1)`; U `update(×2)`.

```
1 | T: a.update(+1) | fold frame ‡2 (O15: fn reads throw in dev); tape+={+1,T,s1}; newest 2; walk delivers in T
2 | U: a.update(×2) | tape+={×2,U,s2}; newest 4; walk delivers in U
3 | U render (mask{U}, pin s2) | fold: base 1; s1 invisible; ×2 → 2 ✓
4 | U commits | retiredSeq(U)=s3; committed view (∅, pin≥s3): 2 ✓; compaction of s2 BLOCKED (unretired s1 behind it) → bS(a) unchanged ‡2 (no fingerprint motion without value motion)
5 | T render (mask{T}, pin≥s3) | fold: +1@s1 (slot) then ×2@s2 (retired≤pin) → 4 ✓ replay in write order (I2)
6 | T commits | fold both in seq order → base 4, bS(a)=s2 ‡2; quiesce
plain-set variant | {+1@T, set5@U}: U render 5; final fold (1+1) then set5 → 5 ✓
outcome: 2, 2, 4, 4 — React's arithmetic; useReducer differential beside it (O16 scope: stable reducer).
residual risk: fold-order bug — replay oracle (D6) + C3 differential; reducer-swap-with-pending-receipts pinned separately (§13.1).
```

### C4 — two-batch write into an already-stale region

```
1 | T1: a.set | walk full reach: W setState in T1; NM={T1}
2 | T2: a.set | walk runs FULL REACH again (no cross-walk marks); NM bit T2 clear → setState in T2's context; NM={T1,T2}
3 | React renders each | W included in both lanes ✓
outcome: per-(watcher, slot) dedup = I5's granularity; once-per-staleness marks don't exist.
residual risk: reintroduction of mark-stopped walks — C4 unit + I5 property test.
```

### C5 — cutoff-suppressed first write, effective second write

```
1 | k: a.set(1) (c value-unchanged) | tape+; wc[k]=s1; K0 equality skips K0 marks only; walk runs UNCONDITIONALLY → W setState in k; NM={k}
2 | k render; re-arm; read c | M(c,wk)={val, seq s1}; c's recompute equal → valueStamp unchanged ‡2 (per-world cutoff at the stamp)
3 | k: b.set(7) | tape+; wc[k]=s2; walk b→c → bit clear → setState in k ✓
4 | k re-render | predicate: wc[k]=s2 > s1 → invalid; ladder: fp(b,wk)=s2 moved → recompute → 7 ✓
outcome: delivery never suppressed at write time; clocks per-slot, stamps per-value-change.
residual risk: a future cutoff knob must keep the clock bump unconditional — C5 unit with knob on.
```

### C6 — lane attribution under grouped notification: HANDLE IT

No grouped drain exists; delivery is synchronous per write (D10).

```
1 | batch() opens | defers core-effect flush ONLY
2 | a.set(1) | token Ua (event urgent); walk delivers NOW in urgent context
3 | startTransition(() => b.set(2)) | token Tb; walk delivers NOW in transition context → transition lanes
4 | batch() closes | core effects flush (NEWEST)
outcome: per-write context by construction (D5/D10); implicit grouping: none exists (stated).
residual risk: a delivery-coalescing "optimization" — C6 two-lane assertion via fork probe.
```

### C7 — writes and reads during a yielded render pass

```
1 | pass P (mask{T}, pin p) starts | currentWorld=wT
2 | yield (F2) | currentWorld=NEWEST; getCurrentPassId()=0
3 | handler: a.state | NEWEST → k0.pull → newest ✓
4 | handler: a.set(x) | pass binding empty → no throw ✓; token C (click); tape+={x,C,sc}; walk delivers urgent
5 | click renders+commits | C retires: retiredSeq=sr on the SHARED line, sr > p; compaction of C's entry BLOCKED (sr > min live pin p) ‡2 → bS(a) unmoved → fp(a, wT) unmoved
6 | P resumes (F2) | currentWorld=wT (same mask, pin p)
7 | P reads a | fold: C's entry visible iff sr ≤ p — FALSE → excluded ✓; memo epoch bumped at 5 → ladder: fp(a,wT) unmoved ‡2 → revalidate WITHOUT recompute, identical folds under p ✓
outcome: newest reads in the gap; click-classified write; undrifted resumed pass; the fingerprint system respects pins because compaction does (pin retention ⇒ fingerprint stability).
residual risk: fork flip-site drift — fork test 5; pin-retention rule — C7 unit.
```

### C8 — equality drops must not lose receipts

```
1 | T: a.set(1) | tape+={1,T,s1}; newest 1
2 | U: a.set(1) | NO write-time drop in LOGGED: tape+={1,U,s2}; wc[U]=s2; K0 1→1 (marks skipped); walk runs
3 | U render (mask{U}) | fold: base 0 + s2 → 1 ✓ (T excluded)
4 | overlapping T1,T2 set 1 | two receipts; each world folds its subset; committed folds both ✓
outcome: I7 enforced in the strongest form; DIRECT keeps the donor equality skip (history cannot exist there).
residual risk: tape coalescing violating I7 — declined (O10); C8 unit.
```

### C9 — mount mid-transition (existing and fresh nodes)

```
(a) | mount render inside k-pass reads existing c | currentWorld=wk; F(c)=1 → world path ✓ first render correct; F=0 ∧ CT → invariant R serve (sound, §6.3); F=0 ∧ ¬CT → world eval (no leak)
(b) | fresh node n (useComputed) | id minted INTO pass.staged ‡2 (S15); no K0 record → ¬CT → world-routed by the ordinary rule: evaluates in wk, records K1 edges, M(n,wk) stored; F(n) OR-in via raiseFlag ‡2 (out-edges empty → trivial)
(b2) | registration at commit effect | promotion out of staging ‡2; watcher attach; discarded/replayed pass leaves staged (reclaimable) nodes + add-only K1 edges
(b3) | post-mount k-write to n's dep | walk reaches n via its K1 edges → delivered in k's lane ✓
outcome: both reads resolve in the pass's world on first render; fresh-node handling is a corollary of routing plus staging.
residual risk: K0 backfill on first NEWEST read must not clobber world memos (separate stores — C9 unit + StrictMode variant); staging promotion ordering — S15 test.
```

### C10 — late subscription joins the pending batch (incl. C10-R ‡2)

```
1 | k: a.set(1) | receipts; cone flagged; existing watchers notified in k
2 | urgent mount render of W′ | world = committed(root): renders v0; no watcher yet
3 | layout fixup §11.2 | F(n)=1 → live-token loop: runInBatch(k, setState) ✓ corrective joins k's lanes
4 | committed compare ‡2 | v_now(committed-for-root) == v0 (k uncommitted) → no extra urgent render ✓ no false positive
5 | React renders k | W′ has pending k-update → renders fresh → reads wk → 1; ONE commit carries k + correction ✓
JOINT variant | c=a&&b, t1 wrote a, t2 wrote b pre-mount: step 3 schedules into BOTH (no equality filter, I13) → the joint {t1,t2} pass re-renders W′ fresh → true ✓; single-token passes re-render W′ to equal values (no DOM change; G-F bound)
outcome: exactly one commit per token with the correction included.

C10-R ‡2: k retires inside the render→layout window (the TKC-4 schedule)
1 | k: a.set(1) | receipts; cone flagged
2 | W′ mount render (urgent) | world committed(root) BEFORE retire → renders v0 (excludes k)
3 | k retires committed (in the window) | fold: base=1, bS=s_r; epoch++; lockedIn bits cleared; reconcile scans REGISTERED watchers — W′ not yet registered → not covered there (by design; the fixup owns this window)
4 | W′ layout fixup | live-token loop EMPTY (k dead) — round-1 design stopped here: torn frame persisted
5 | committed compare ‡2 | v_now = eval(n, committed-for-root NOW) folds base=1 → ≠ v0 → urgent setState pre-paint → W′ re-renders with 1 before paint ✓
outcome: no schedule exists in which every corrective path is unreachable — live token ⇒ runInBatch; retired-in-window ⇒ committed values moved ⇒ the unconditional compare fires (value moved ⟺ correction needed, in the corrective's own world — the I13-safe equality, §11.2).
residual risk: fixup-vs-passive-effect ordering — react-concurrent-store mount-during-commit scenario + fork test 3.
```

### C11 — multiple roots (declared scope: FULL spanning)

```
1 | k writes atoms read on roots A,B | receipts slot k; walks deliver on both roots in k's lane
2 | A's k-render commits | F3: lockedIn(A)|=bit(k); k NOT retired; effect flush for A runs with new lockedIn (§11.4 trigger 1)
3 | urgent render on A | mask {U}∪lockedIn(A)∋k → folds include k ✓ A never contradicts its DOM
4 | A's passive effects | world(committed-for-A) ∋ k ✓ though token live
5 | urgent render on B | lockedIn(B)∌k → excludes k ✓
6 | B commits | last root → onBatchRetired(k, true) → single fold, exactly once
7 | store-only on B variant | fork counts involved roots by scheduled work; retire fires once either way
8 ‡2 | retire clears lockedIn | bit(k) removed from lockedIn(A) AND lockedIn(B) BEFORE slot release (§5.3.5); committed-for-root worlds now see k via the retired clause — same fold answers, no mask dependence; slot recycles clean → the TKC-6 tear (new batch's uncommitted writes rendered against A's DOM through a stale bit) is unrepresentable; fork test 15 pins the ordering
outcome: per-root lock-in masks replace any global "committed"; cross-root skew is React's own commit ordering (permitted); mask lifecycle is closed.
residual risk: lock-in ordering vs paint/effects — fork test 3; fork registry facts need current-generation existence proof (gap G4).
```

### C12 — store-only transitions persist (+ O14 forms ‡2)

```
1 | startTransition(() => a.set(5)), no subscribers | LOGGED since registration (S6): tape+; walk finds no watchers
2 | batch closes, no React work | onBatchRetired(k, false) → FOLD anyway (D2): base=5, bS=s1 ‡2; §11.4 trigger 2 on engine microtask: effect fingerprint compare — fp(a,committed)=s1 ≠ recorded → a useSignalEffect elsewhere re-runs seeing 5 ✓ (and keeps re-running correctly AFTER compaction, the B1 fix)
3 | async action: startTransition(async () => { a.set(1); await io(); … }) | sync prefix: token k2, receipt; F8 onActionStart(k2) → retirement PARKED
4 ‡2 | post-await RAW a.set(2) | ambient classification (F8): default batch D, own token — React-parity (a raw post-await setState is not a transition); D retires on its own schedule → 2 visible before settle, exactly as useState would be (differential, fork test 13)
5 ‡2 | post-await WRAPPED startTransition(() => a.set(2)) | F8 entanglement: pending action ⇒ SAME token k2 (fork test 14) → receipt slot k2 → parked with the action
6 | settle | onActionSettle(k2) → retire → fold in seq order → the ACTION's writes commit now, not before ✓
outcome: persistence never depends on subscription (D2/S4-scar); action-batch writes never commit pre-settle; raw post-await writes match React exactly and are loudly documented (startSignalTransition helper wraps continuations).
residual risk: fork parking/entanglement facts — fork tests 2/13/14 (differential vs React 19 is the tripwire on rebases).
```

### C13 — counter/world-id lifecycle soundness

Walked as the §15 inventory — every counter/stamp (15.1), every mask/bit
column (15.2), saturation (15.3), token allocator (15.4), tag wrap (15.5),
staging GENs (15.6). Episode collision drive: quiesce → force-small reset →
stale memos unreachable (epoch in worldKey), stale K1 entries fail the tag
(and CANNOT false-match post-wrap — wrap-clear), NM/lockedIn bits cleared
at recycle/retire, tapes empty by definition, wc zeroed at intern, baseSeq/
fnStamp/reducerStamp rewritten by renumber, token serials live-skipped.
`outcome:` no cross-episode or cross-recycle validation passes without a
bumped guard (I8/I19); both tables are schema-sweep-enforced, not prose.
`residual risk:` a new column added without a table row — the sweep fails
closed on undeclared seq/mask fields (D6 review gate).

### C14 — StrictMode and replayed renders

```
1 | render-phase write | guard throws FIRST, before token/append/clock — queue untouched (test asserts); yield-gap handler write does NOT throw (per-callstack)
2 | replayed pass | same worldKey + lineage + fnStamp ‡2 (deps identity unchanged between double renders ⇒ same stamp) → identical memos/thenables (prefix match ⇒ same identities ‡2) → no re-suspend loop
3 | discarded pass | staged nodes reclaimed at quiescence ‡2 (S15 — no arena leak); add-only K1 edges (over-notify at worst); early-cleared NM bits (over-delivery); lastRendered untouched (commit-recorded)
4 | double mount/unmount | microtask-debounced observed lifecycle nets to one ✓
outcome: purity holds; render-side mutations are keyed-idempotent, monotone-and-harmless, or staged-and-reclaimed.
residual risk: memo store keyed without lineage for fresh nodes — C14 forced-discard test; staging double-promotion — S15 StrictMode test.
```

### C15 — suspense across worlds (+ settlement, content validity, boundary ‡2)

```
1 | k suspends c | k-pass lineage Lk: ctx.use → entry (c,Lk,0)={th, prefixDeps ‡2, gen}; M(c,wk)=SUSPENSION{thRef}; back-ref entry→memo ‡2; React suspends via use protocol
2 | mount mid-transition reading c | same lineage → prefix matches (pure) → SAME thenable identity → consistent suspension ✓ (react-concurrent-store known bug = passing test)
3 | canonical reads meanwhile | NEWEST path; lineage caches never consulted ✓
4 ‡2 | th settles | S4 handler: gen check ✓ → kills M(c,wk) via back-ref; re-delivery for parked worlds; a read racing the handler hits the belt conjunct (SUSPENSION ∧ !pending → invalid) → recompute either way; retry (same Lk): eval re-runs, prefix matches → same entry → th fulfilled → ctx.use returns value → M(c,wk)={v,…} ✓
5 ‡2 | intra-batch write BEFORE retry (the I20 schedule) | k writes atom d ∈ c's read prefix: wc[k] bumps (memo dies) AND fp(d,wk) moves → retry eval reaches position 0: prefixDeps mismatch → entry dropped → FRESH fetch th′ (new identity — the stale-world thenable is never replayed) ✓; k writes unrelated atom u ∉ prefix: prefix matches → SAME identity, no thrash ✓
6 | k commits | lineage dropped → cache freed; abandon also drops it regardless of settlement; late settle gen-checked no-op
7 ‡2 | RENDER_NEWEST↔world boundary (O17 pin) | pass suspends as RENDER_NEWEST with K0-column thenable T_a; new write forces restart into world wk → lineage cache empty at pos 0 → fetch T_b: ONE duplicate fetch, ONE identity flip, stable thereafter — pinned by conformance test
outcome: identity = lineage (D11); validity = content (I20); settlement = change source S4 (TKC-2); all three conjuncts hold simultaneously; canonical world never observes the suspension.
residual risk: lineage lifetime drift — fork test 6; prefix determinism rests on purity — C14 replay test doubles as its pin.
```

### C16 — effects observe committed state only (+ the B1 walk ‡2)

```
1 | default D: a.set(1) applied, uncommitted | tape entry slot D; newest=1; base=0
2 | unrelated j retires → flush check (trigger 2) | effect world (committed-for-R): D unretired ∧ ∉ lockedIn(R) → fold excludes → 0 ✓
3 | D commits | trigger 1: fp(a, committed) = s1 (entry) ≠ recorded 0 → re-run sees 1 ✓
3′| D retires with no commit on R | trigger 2 on engine microtask → re-run sees 1 ✓
B1 ‡2 | later: D's entry COMPACTS (tape empties, bS(a)=s1) | a second effect E2 whose snapshot recorded fp=0 pre-write: flush check computes fp(a,committed)=max(none, s1, 0)=s1 ≠ 0 → re-runs ✓ — round-1 predicate computed 0==0 and silently never re-ran (the judge-B1 kill, dead by §8.3)
4 | core effect() | documented NEWEST contract: saw 1 at step 1's flush — stated, conformance-tested divergence
outcome: committed world is a first-class world; every edge that changes it notifies (I14); no representation change (compaction) is observable as a validity change.
residual risk: flush world must use the effect's OWN root's lockedIn — C11/C16 cross test; fingerprint-vs-oracle differential in the replay suite.
```

### C17 — optimistic rollback

Not exposed: no truncation surface exists (batches fold on retirement, D2;
React batches never truncate). Optimistic UI composes from ReducerAtom
actions whose fold interprets reconciliation (R3). Surface deleted per the
case's clause; nothing depends on truncation.

## 18. Rejected variants and known gaps

Rejected (kept with reasons; champion rejections R1–R7 all stand — cross-
walk marks, per-read certificates, host-protocol K0, write-time cutoffs,
React-owned queues, equality-filtered fixup, gate-as-correctness):

- **R8: settlement handled by eager kill alone (no belt conjunct)** — the
  settle→handler microtask gap admits a read that serves a settled
  suspension; the belt makes the race fail-closed for one int-compare.
- **R9: whole-run stamps for thenable content validity** — coarser than the
  prefix (any included write refetches, even provably-unrelated ones);
  kept only as the flagged fallback if prefix compares measure hot.
- **R10: value-hash fingerprints** — non-injective and allocating; minted
  monotone stamps are collision-free by construction (§8.3).
- **R11: per-lineage reducer staging (exact React nuance for swapped
  reducers)** — a shared many-consumer atom cannot reproduce per-fiber
  rendered-reducer semantics without per-consumer forks of the fold; the
  declared parity scope + reducerStamp + dev warning buys the honest 99%
  (§13.1); revisit only on a real-world conformance failure.
- **R12: mid-episode staged reclamation (free immediately at pass
  discard)** — requires GEN checks on every K1 link traversal (hot-walk
  tax) to catch dangling shadow edges; deferring reinsertion to quiescence
  makes dangling references structurally impossible at zero walk cost
  (§15.6).

Known gaps (declared):

- **G1** repeated high-fan-out writes re-walk their cone per write (SPK-N1
  decides the fallback; O12).
- **G2** held-open-transition re-validation bursts (SPK-G8; per-(atom,
  worldKey) fold-cache escape hatch specced).
- **G3** union K1 edges over-notify across batches (≤1 spurious render per
  (watcher, batch); G-N asserts).
- **G4** fork registry facts (per-root lock-in, async parking/entanglement,
  mask parity) are proven only in the previous-generation fork; fork tests
  2/3/4/13/14/15 must pass on the current React base before the C11/C12
  walks count as implemented. Still the round's biggest external risk.
- **G5** E-PRESERVE dev-validator cost unknown until SP2 (sampling
  fallback).
- **G6** mount-fixup over-render under many live transitions (≤
  live-deferred count) PLUS the new committed compare (one world eval per
  flagged mount) — G-F measures both in the harness; O11 stays open.
- **G7** first-touch world evaluations for stale-unflagged regions after
  quiescence (memoized thereafter; SPK-G8's shape includes it).
- **G8 (new)** LOGGED-quiet residual tax is unmeasured until SPK-L; G-Q is
  a budget, not a result. If it fails, the §4.7 ladder is specced but
  itself unmeasured.
- **G9 (new)** mid-episode abandoned-node high-water is bounded by
  per-episode mount churn, reclaimed only at quiescence; an app that never
  quiesces AND churns mounts inside one episode grows until quiescence
  (documented; the forced test pins the sawtooth shape).

## 19. Mechanism inventory (10)

1. **K0** — donor arena kernel, closed and monomorphic, shipped as
   DIRECT/LOGGED twin builds with the §4 op-table swap protocol (SPK-H/Q
   remedies live here).
2. **Tape + base/baseSeq + one globalSeq line** — always-log receipts; seed
   visibility math; seq-order folds; retirement stamps and every validity
   fingerprint minted from the same line (§5, §8.3).
3. **Slots/masks/pins + per-root lock-in with closed mask lifecycle** —
   batch bookkeeping over fork tokens; lockedIn cleared at retirement; the
   §15.2 bit-column table (I19).
4. **Closed change-source validity** — the §8.1 table (S1–S7); unified
   predicate + fingerprint ladder covering memos, thenable entries, and
   effect snapshots; CI audit sweep (I16).
5. **World memos + lineage thenable caches with prefix content-validity +
   settlement kill** (§8, §9; I20/TKC-2).
6. **K1 shadow plane + E-PRESERVE + path-transitive F via raiseFlag +
   invariant-R routing** (§6, §7; I17).
7. **Notification walk** — per-write full reach over K0∪K1, writer-context
   setState, per-(watcher, slot) dedup with render re-arm (§10).
8. **Watcher records (commit-recorded) + mount fixup (reach-based +
   committed-compare fallback) + reconcile backstop + retire/lock-in
   effect flush** (§11; I18/I14).
9. **Fork protocol** — 8 facts F1–F8 (~12 reconciler touch sites), incl.
   the async action scope (§14; O14).
10. **Episode lifecycle** — retirement folds/compaction with pin retention,
    staging reclamation (S15), quiescence resets, counter/allocator guards
    with saturation and wrap constructions (§15; O13).

Same count as the champion (10): the docket repairs hardened members 3–6,
8, 10 rather than adding cooperating parts; the only new protocol surface
is F8.

## 20. Test plan (beyond the inherited apparatus, D6)

Inherited wholesale: randomized replay oracle FIRST (fold math vs
brute-force multi-world interpreter + useReducer differential),
frozen-kernel contract suite, bytecode budgets CI (now per twin build),
invisibility tests (179-suite inside a synthetic episode, both builds,
before/after growth), react-concurrent-store 14 scenarios + two-root
scenario, pre-registered spikes (§16.2). Round-1 additions kept: invariant-F
and invariant-R property tests, basis-edge completeness fuzz (SP2),
notify-rearm property, walk-reach differential, joint-mask mount battery,
episode collision battery, StrictMode write-throw queue-untouched test,
fork suite 1–12. Round-2 additions:

- **Change-source audit sweep (CI)**: every world-eval input in the schema
  maps to an §8.1 row; every seq-typed field maps to a §15.1 row; every
  mask/bit column to a §15.2 row. Fails closed on undeclared fields.
- **Fingerprint-vs-oracle differential**: random schedules; assert
  ladder-revalidated memos equal brute-force folds — with forced
  compaction between validation points (the B1 regression pin).
- **raiseFlag path-invariant fuzz**: random graphs, writes, re-tracks,
  fnStamp bumps, equality cutoffs; assert reachable-from-taped ⇒ flagged
  after every event (the I17 pin, C1-T9 included).
- **Settle-race property test**: settle vs read interleavings at every
  microtask boundary; assert no read ever returns a suspension backed by a
  settled thenable (TKC-2 pin).
- **Thenable identity/content battery**: pure-retry identity stability,
  prefix-touching write refetch, unrelated-write identity stability,
  boundary-crossing single-flip (I20/O17 pins).
- **Fixup window battery**: fork test hook forces retirement at every point
  in the render→layout window; assert exactly one pre-paint correction and
  zero torn commits (I18 pin, C10-R).
- **Mask lifecycle battery**: slot churn with spanning batches; assert
  lockedIn/NM/wc all clear per §15.2 (I19 pin, incl. fork test 15).
- **Staging high-water test**: 10k mount-evaluate-abandon × 100 episodes;
  plane high-water stable; StrictMode double-mount promotes exactly one
  (S15 pin).
- **Counter horizon battery**: forced-small globalSeq margin (renumber +
  hard-throw paths), 30-bit token wrap under 31 parked actions, 2-bit K1
  tag wrap-clear (O13 pins).
- **O15/O16/O17 pins**: dev-throw on reads/writes in updaters; reducer-swap
  differential at declared scope; `ctx.previous` three-way rule conformance.
- **SPK-L registered** before any LOGGED-quiet performance claim is made.

*End of hardened design. 10 mechanisms; 8 protocol facts (~12 reconciler
sites); all C1–C17 walked (C1 a family of 9); docket items I16–I20, O13–O17,
O14, S15, SPK-H/Q all repaired in-architecture; 7 spikes registered (2 done,
5 queued); zero unwalked cases.*
