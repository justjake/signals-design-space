# Review: TWO-KERNEL — Claude reviewer, round 1

Design reviewed: `design-loop/rounds/round-01/design-two-kernel.md`
Method: re-walked C1–C17 against the design's own mechanisms; attacked every
"by construction" claim with counter-schedules; enumerated mechanism pairs
sharing state (routing×staleness, fixup×pass-masks, visibility×counters,
clocks×resets, re-arm×dedup, E-PRESERVE×re-track); ran the lifecycle and
fork-honesty audits. Findings ranked most-severe first; every finding
carries a failing schedule. Verified-held attacks listed after.

---

## F1 — BLOCKER: unflagged-but-K0-stale nodes serve newest-basis recomputes into excluded worlds (torn frame)

**Defeats:** §4.2 read routing × §4.3 flag consequence × §3.4 quiescence
(flag clear) × K0 native lazy staleness. Invariant F itself *survives* —
which is the proof that F is too weak to justify the routing claim built on
it ("hence K0's cached/**pulled** value is correct for every world").

The gap: flags are episode-scoped (bulk-cleared at quiescence; nonexistent
before bridge registration), but K0 staleness marks are not episode-scoped —
they persist until the next pull. A stale node's `k0.pull` is not a cache
read; it is a *fresh evaluation against newest values*, and with dynamic
dependencies it can acquire a this-episode-taped atom through a path that
did not exist at any write's walk time. The flag check ran before the pull;
`afterRetrack` fixes the flags *during* the pull — after the routing
decision, before the wrong value is returned.

**Failing schedule** (LOGGED throughout, single root):

Setup (episode 0): atoms `cnd=false, x=0, m=0`; computeds `u = x*2`
(created, never yet evaluated — no K0 edges), `v = cnd ? u : m` (evaluated
once; K0 deps {cnd, m}), `w = v+1` (evaluated once; K0 deps {v}). No current
watcher on `w` (its reader unmounted, or `w` is only read by urgent renders
later).

1. Episode 1: urgent `cnd.set(true)` → receipt, walk from `cnd` flags
   {cnd, v, w}; K0 natively marks `v`, `w` stale. Nobody re-reads `w`.
   Batch retires (fold `base(cnd)=true`); tapes compact; **quiescence:
   flags cleared**. K0's stale marks on `v`, `w` persist.
2. Episode 2: `startTransition(() => x.set(5))` → token k:
   `tape(x)+={set 5,k,s1}`; `wc[k]=s1`; K0 newest `x=5`. `notifyWalk(x,k)`:
   `x` has **no K0/K1 out-edges** (`u` was never evaluated) → walk flags
   only `F(x)=1` and stops. `F(v)=F(w)=0`. Invariant F holds: no K0∪K1 path
   x→…→w exists at this moment.
3. Before k renders: any urgent pass (unrelated setState or a mount) runs
   with world `wU = (mask{U}∪lockedIn, pin)` — k ∉ mask, so not NEWEST.
   A component reads `w`: §4.2 → `F(w)=0` → `k0.pull(w)`. `w` is stale →
   recompute chain: `v` reads `cnd=true` (newest), takes the `u` branch →
   first-evaluates `u`, which reads **K0-newest `x=5`** → `u=10, v=10,
   w=11`. (`beforeRetrack(v)` mirrors old edges into K1; `afterRetrack`
   sets `F(v)=F(w)=1` — too late; the pull returns 11.) Component renders
   `w=11`.
4. A sibling in the same pass reads `x`: `F(x)=1` → fold → base `0` →
   renders `0`.

**Wrong observable outcome:** one committed urgent frame shows `x=0` next
to `w=11 = x*2+1 ⇒ x=5` — k's pending write leaked into a world that
excludes k. Torn frame, C2-class. Neither safety net catches it: the C10
layout fixup compares the rendered value against `world(k ∪ committed)`
where 11 is "correct" (no mismatch), and the §9.4 backstop fires only at
k's retirement — a correction at least one frame late (the S2-class
outcome).

**Variant triggers (same hole):** (a) K0 staleness left by pre-bridge
DIRECT writes — no episode boundary needed; first transition after
activation + one urgent read reproduces it. (b) If the donor kernel unlinks
a computed's subscriber edges when it loses its last watcher (alien-family
libraries do this to avoid leaks), walks can never reach/flag that cone,
and its later re-evaluating pull has the same wrong-world serve; the design
must pin the donor's unwatch semantics either way.

**Judgment: local fix, but mandatory and currently unwritten** — the stated
routing construction is false as written, and by battery rule a defective
construction on the central fast path is a blocker. Two candidate repairs
inside the architecture:

- (i) Route on `flag ∨ not-provably-fresh`: a non-NEWEST read of an
  unflagged node whose K0 record cannot be served without recompute
  (dirty / pending / never-evaluated / unlinked — one in-plane status load)
  goes to world evaluation instead of `k0.pull`. In the schedule above the
  world eval of `w` correctly folds `x → base 0` (`w=1`) and records the
  real K1 edges so later k-writes reach it. Costs only on
  stale∧unflagged∧non-NEWEST reads.
- (ii) Post-pull recheck: allow the routed pull but observe (via the §5.3
  hooks, which fire on every re-track/first-track) whether any visited
  node's flag transitioned 0→1 during it; on transition, discard the routed
  result (K0's newest cache remains valid as newest) and re-dispatch as a
  world evaluation.

Either needs its own invariant ("a routed pull is valid only if it
completed flag-quiet / fresh") plus tests: the cross-episode schedule
above, the pre-bridge variant, and a donor-semantics test pinning unwatch
behavior.

## F2 — HIGH: C10 fixup checks single-token worlds; joint transition renders can commit torn

**Defeats:** §9.2 subscribe-gap fixup × multi-batch pass masks (F2 tokens
are a set; React renders all pending transition lanes together) × React
bailout.

**Failing schedule:**

Setup: atoms `a=0, b=0`; computed `c = a && b` (any divergence visible only
jointly); component S subscribed to `c` since before the writes; component
W' not yet mounted.

1. Transition t1: `a.set(true)` → S notified in t1's lane.
2. Transition t2: `b.set(true)` → S notified in t2's lane.
3. W' mounts (urgent) reading `c`: renders committed world → `c=false`.
4. Layout fixup §9.2, per live token: `world(t1∪committed)`:
   `true && false = false` = rendered → no correction. `world(t2∪committed)`:
   `false && true = false` = rendered → no correction. **No corrective
   update exists in either lane.**
5. React renders the pending transition work: `getNextLanes` takes both
   transition lanes → one pass, mask {t1,t2}. S has updates in those lanes
   → re-renders, reads `c` in world({t1,t2}) → `true`. W' has no update in
   those lanes and its parent didn't re-render → React bails out on W'.
6. Commit: S shows `c=true`, W' shows `c=false`.

**Wrong observable outcome:** torn committed frame for the joint render.
The §9.4 backstop corrects only at retirement — one frame late. The
design's C10 walk is correct for the single-token case the battery states,
but the design claims multi-batch passes as the norm everywhere else
(masks, T7, F2 tokens array), so the fixup must cover the masks React will
actually render.

**Judgment: local fix.** Options: also check the union world of all live
tokens *and* every mask the root has scheduled (needs no new fork fact if
the engine checks the union plus each single token — but AND-shaped
divergence can hide in any strict subset of size ≥2, so subset masks that
React may render after abandonment (T7) need either enumeration of
scheduled masks (small protocol addition) or the conservative repair:
when `flag(node)=1` at mount, `runInBatch(t, setState)` into *every* live
batch — over-renders ≤ live-token count, always sound). Pick one and walk
it.

## F3 — HIGH: `retiredSeq` is minted from the wrong counter — visibility math and compaction are internally inconsistent, and the literal reading breaks C7

**Defeats:** §2 visibility (disjunct 1: `retiredSeq ≤ pin`) and §3.3.3
compaction (`retiredSeq ≤ min(live pass pins)`) × §3.3.1
(`retiredSeq = ++retireSeq`) and §11's `retireSeq` row (a separate counter,
reset at quiescence). Pins are globalSeq captures; comparing a private
retire counter against pins is comparing incommensurable number lines.

**Failing schedule (literal implementation of §3.3.1/§11):**

1. Bridge active for a while: `globalSeq = 100`. Transition pass P starts:
   pin `p=100`, yields.
2. Click batch C: `a.set(x)` → seq 101; C renders and commits
   synchronously; retirement stamps C's entries `retiredSeq = ++retireSeq
   = 1` (first retirement this episode).
3. Compaction check: `retiredSeq(1) ≤ min(live pins)(100)` → true → C's
   entries fold into `base(a)` while P is live. Even if compaction is
   skipped, P resumes and reads `a`: visibility disjunct 1:
   `retiredSeq ≠ 0 ∧ 1 ≤ 100` → **visible**.

**Wrong observable outcome:** the resumed pass P observes the click's
write — pinned-world drift mid-pass, exactly C7's forbidden outcome (the
design's own C7 step 7 asserts the opposite: "r minted after p — false",
which is only true if retire stamps share the globalSeq line). As written
the spec contains both readings; an implementer following §3.3.1 + §11
ships the bug (the C7 unit would catch it, but the spec text is the
authority under review).

**Judgment: local fix, one line plus bookkeeping:** mint retirement stamps
from the shared monotone line (`retiredSeq = ++globalSeq` at retirement),
delete/repurpose §11's separate `retireSeq` row, and re-audit the optional
globalSeq reset against retire stamps (tapes are empty at quiescence, so
stamps die with entries — fine). T5's and C3's walks already assume the
shared-line reading and stay correct under it.

## F4 — MEDIUM: `slotWriteSeq` survives the optional globalSeq reset (and slot re-intern) with no epoch guard — I8 violation as written; permanent fail-closed re-validation

**Defeats:** §7.2 clock validity × §3.4 optional `globalSeq` reset × slot
interning. §11's guard inventory misses that `slotWriteSeq[32]` *retains
globalSeq values* across the reset; the table's row guards recycle, not
reset.

**Failing schedule:**

1. Episode 1 runs `globalSeq` to 10,000; slot 3's last write leaves
   `slotWriteSeq[3] = 9,876`. Quiescence: epoch bumps, tapes empty, and the
   guarded optional reset sets `globalSeq = 0`. Nothing resets
   `slotWriteSeq` (per §11 that happens only at slot recycle, and interning
   is not specified to write it).
2. Episode 2: batch k (React-state updates only — no signal write ever
   calls `internSlot` via §3.1) is interned into slot 3 at `onPassStart`
   for mask derivation. World evals in k-passes store memos with
   `memo.seq ≈ 50`.
3. Validity: `∀ s ∈ mask: slotWriteSeq[3](9,876) ≤ memo.seq(50)` → false →
   every memo whose mask contains slot 3 is invalid forever (until a real
   k-write overwrites the clock, which may never come). The ladder re-walks
   deps on every read; refreshed `memo.seq` never exceeds the stale clock.

**Wrong observable outcome:** none on values (validity fails closed —
correct results, verified both directions: no stale-clock false-validation
is constructible since old memos died with the epoch). The cost is
unbounded re-validation waste on every read of the region, and a
discipline breach: I8 demands a named guard for every structure retaining
old counter values, and the design's own C13 checklist ("every counter row
must name its guard") misses this row.

**Judgment: local fix:** `internSlot(token)` sets
`slotWriteSeq[slot] = globalSeq` (or 0); add the C13 row; add a
forced-reset test that interns a slot without writes.

---

## Notes (no schedule ⇒ not findings; recorded for the author)

- **N1 — K1 id-column reset story is stated twice, differently.** §3.4
  says quiescence bump-resets "the library→K1 id column"; §6.4 says ids
  are "re-minted lazily against episodeEpoch" via a tag. Pick one. I walked
  the lazy-tag variant's worst case (tag wrap collision): edge inserts and
  walks use the same colliding id, so a collision yields a shared record —
  over-notification and over-flagging only, never a missed edge. Safe
  either way, but the tag width and the choice must be pinned.
- **N2 — SP1 is written as pending; INVARIANTS I11 records it measured**
  (boundary 0.99–1.02×, storage move 5–12%). No contradiction — the design
  keeps values in-plane, which is exactly I11's requirement — but §12.4
  should cite the settled number instead of re-planning both outcomes.
- **N3 — R10 (SSR/hydration) has no section.** Likely trivial (hydrate
  bases before bridge registration/first write), but the requirement is in
  the contract and the spec is silent.
- **N4 — Multi-root suspense duplicates fetches**: lineage is per
  (root, batch-set), so a computed suspending under a spanning batch keys
  separate thenable caches per root — duplicate async work, not wrongness
  (identity within each root's retry loop is stable, which is all R2/C15
  require).

---

## Verified held (attacked and survived)

- **§7.2 clock validity is genuinely S5-immune.** Attacked with the S5
  schedule (atom acquires its first receipt after the evaluation): the
  always-log write bumps the slot clock, which invalidates every memo whose
  mask contains the slot with no dependence on the recorded read set. Also
  attacked the recheck ladder: dep lists are recorded at read time for
  *every* read (unflagged pulls included), atom versions are
  visibility-scoped to the memo's pinned world so a ladder refresh cannot
  absorb a write the pin excludes, and computed versions bump only on value
  change (per-world cutoff falls out). Held.
- **§8.2 reach induction (the reach half).** Attacked via: divergence
  through an unflagged K0-pulled dep inside a world eval (the K1 edge from
  the unflagged pull is recorded — load-bearing and present in §4.2's
  comment); basis edges dropped by re-track (E-PRESERVE mirrors first);
  dedup-bit-set-but-consumed states (React's own queue holds the scheduled
  update until a committing render that includes the lane re-renders the
  hook, which re-arms — under-delivery requires a set bit with no queued
  update, which I could not construct). Held, except where F1's *value*
  routing (not reach) is the defect.
- **Per-write walk + per-(watcher, slot) dedup + re-arm** (C4, C5, C6, C8):
  attacked with discarded passes (re-arm early-clear is over-delivery
  only), mid-yield async-action writes to a live slot (pin math excludes
  them from the resumed pass), unmount/remount (fresh watcher record), and
  slot recycle (bit column cleared at recycle, gated on unswept=0). I5's
  granularity holds by construction; C6 has no grouped drain to
  mis-attribute. Held.
- **C3 fold parity**, including a three-batch interleave (T pending, U1 ×2
  retires, U2 set-10 retires): seq-order replay over pre-batch base gives
  React's answers at every step; the compaction blocking rule ("no
  smaller-seq unretired entry behind") keeps live-pass folds identical
  across base recomputes (under F3's corrected counter line). Held.
- **§6.3 E-PRESERVE** for what it covers: attacked with writes inside
  computeds mid-re-track (dep-set replacement is link-then-truncate; the
  mirror at eval start covers the full old set either way) and re-tracks
  with a live batch but no live pass ("any live batch" is the guard). The
  unwatch-unlink question is F1's, not E-PRESERVE's. Held.
- **C7 per-callstack world flips** (given F3's fix): attacked with
  root-interleaved yields (root B renders inside root A's yield gap — F2
  edges fire at work-loop boundaries, so the flips nest correctly) and
  writes in yield gaps (classified under the click's token; pin excludes
  them from the resumed pass). Held.
- **C9(b) fresh nodes**: eager world-routing + commit-time registration +
  StrictMode discard (unregistered node, add-only K1 edges = over-notify
  only) + K0-backfill separation from world memos. Held.
- **C11 full spanning**: post-lock-in k-writes on the committed root
  re-deliver and re-commit consistently; effects pre-retirement read
  lockedIn correctly via either visibility disjunct. Held modulo G4, which
  the design itself flags as needing fork-test re-proof.
- **C12/C16/C15**: fold-on-retire regardless of committed flag (S4
  closed); committed-for-root worlds for effect flushes checked in both
  the lock-in→retire window orderings; lineage keying survives T7
  (batch-set change ⇒ new lineage ⇒ separate thenables and worldKeys).
  Held.
- **C13**: every counter row checked; only `slotWriteSeq` (F4) and the N1
  ambiguity found. `worldMemoEpoch` wrap is unreachable-by-construction (a
  memo is invalid after one bump); walkTicket wrap zeroes the stamp
  column; K1 tags walked in N1. Held otherwise.
- **Scar audit**: S1–S8 each checked against the design's mechanisms —
  none repeated (always-log incl. urgent; real K1 edges; K0∪K1 walks; fold
  on committed=false; clock validity not certificates; monotonic
  activation; per-callstack render truth; no LOGGED equality drops).
- **Cost honesty**: every hot mechanism I checked carries a gate and the
  two known cost traps (eager per-write cutoffs; always-log price) are
  respected, with fallbacks pre-specified (§14 R1, §12.3). The one
  research-facts tension (cold column becoming walk-hot in LOGGED mode) is
  covered by G-W/G-N gates.

## Verdict

The two-kernel architecture itself — real K1 edges, always-log tape,
clock-based validity, per-write full-reach walks — survived every direct
attack I made on the mechanisms in isolation; the failures are all at
seams, and each has a rule-change repair that leaves the central mechanisms
intact. But F1 falsifies the design's stated fast-path routing construction
(torn frame in an ordinary quiesce→transition→urgent-read schedule), and
F2/F3 produce torn or drifted frames as written, so the spec is not
implementable as it stands. **Repairable** — implementation-ready once the
routing recheck (or stale-conservative routing) is specified with its own
invariant and tests, the C10 fixup covers joint masks, and the
retiredSeq/pin counter line is unified.
