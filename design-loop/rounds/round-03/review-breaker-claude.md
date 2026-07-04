# Review — round-03 design-breaker (two-kernel champion, armored) — Claude reviewer

Design reviewed: `design-loop/rounds/round-03/design-breaker.md`. Method: re-walked
C1–C17 against the design's own mechanisms, attacked every written construction,
then probed mechanism seams (routing × retirement, staging × capsules, effect
queue × per-root lock-in, slots × pins). Findings ranked most-severe first.
Every finding names the mechanisms it defeats and gives a concrete schedule.

---

## F1 — BLOCKER: K0-serve read rule (§7.1 clause b) × retirement touched-column
## clearing (§12.1 step 6) commits a torn frame

**Mechanisms defeated:** Mechanism 6 (K1 routing / freshness-gated read rule)
validated by `touchedSlots`, invalidated by Mechanism 10's retirement sweep —
a classic two-mechanism seam. Also contaminates `ctx.previous`'s "valid seed"
guard (§9.1), which reuses the same cleanliness predicate.

**The seam.** §7.1: a computed may be served from K0 in a non-newest world when
"`touchedSlots(node)==0` and the K0 cache is already clean/current without
invoking its evaluator." §12.1 step 6 / §7.3: retirement sweeps and clears the
slot's touched/watcher columns; §7.2 gates bit clearing on "the token has no
live receipt or retro reference." A retired-but-pin-retained receipt is most
literally not a "live receipt" (retirement stamps all receipts; compaction is
what pins block, per §12.1 step 3), so the bits clear while an open pass whose
pin predates the retirement is still yielded. `touchedSlots==0` then no longer
implies "this node's fold is world-invariant": it excludes exactly the pinned
pass that must NOT see the retired write (visibility clause 1 requires
`retiredSeq <= w.pin`). The atom fold path honors the pin; the K0-serve fast
path consults no stamp, no fp, no pin — only bits and K0 cleanliness.

**Killing schedule (single root, one yield, one click):**

Setup: atom `a=0`; module computed `n = a+10` (committed clean, K0 edge `a→n`);
core `effect(() => n.state)` registered (documented NEWEST observer); committed
components on root A: `E` renders `z.state ? n.state : 0`, `H` renders
`z.state ? a.state : 0` — both subscribed only to `z` (canonical deps).

1. Transition `j`: `z.set(true)`. Pass P starts on A: mask {j}, pin `p`
   (RENDER_NEWEST initially). P renders part of the tree, yields (F2 slice
   exit; retro queue empty).
2. Click in the gap: default batch D: `a.set(1)`. Write path: demotes P to its
   frozen pin-`p` world; appends receipt `s_D > p`; K0 newest `a=1`, `n`
   maybe-dirty; full walk sets `touchedSlots(a)=touchedSlots(n)={D}` and
   enqueues the core effect. No React watcher of `a`/`n` exists, so D has no
   React work on any root.
3. Core effect flushes: reads `n` at NEWEST → K0 pull recomputes `n=11`,
   K0-clean.
4. D retires ("closing with no React work", F3): stamps `retiredSeq = s_r > p`,
   mints `retireVisStamp[a]`; prefix compaction is blocked by P's live pin
   (receipt stays in the tape — correct); step 6 clears D's touched/watcher
   columns → `touchedSlots(n)=0`; slot released.
5. P resumes (its lock view and pin are untouched — no same-root lock advance
   happened, so no discard). P renders `E`: `z` folds true; `n`:
   **clause (b) fires — touched==0, K0 clean → serve 11.** P renders `H`:
   `z` true; `a` is an atom → always folds: `s_r > p` → D invisible → **0**.
6. P completes and commits j's transition.

**Wrong observable outcome:** one committed frame shows `H = 0` (a=0 world) and
`E = 11` (a=1 world). Torn committed frame — matching no world (`{p}` world is
0/10; committed-now is 1/11). No repair path fires: E and H are re-renders, not
mounts, so §10's mount layout fixup (and its unconditional committed compare)
never runs; D scheduled no root-A work, so no lock advance discards P; the K1
edges P records for E/H propagate zero bits (cleared in step 4), so no retro
obligation exists. The design's own fork test 6 ("retirement during a pinned
pass preserves that pass's world") states the requirement this violates, but no
engine mechanism enforces it on the clause-(b) path.

**The dilemma — the other reading also fails.** If instead "no live receipt" is
read charitably as "no tape-resident receipt" (bits and slot retained until
pin-blocked compaction drains), the torn frame closes but slot release now
waits on the oldest live pin. React's ≤31-live-batch bound does not bound
live-tokens *plus* pin-held RETIRING slots: one slow yielded transition pass +
~31 retiring default/urgent batches (mousemove/typing storm during the render)
exhausts the 31 bit positions, and §6.1's `intern(token)` at the next write has
no free slot and no stated behavior — crash or undefined. Neither horn is
walked anywhere (C1-T6 covers reuse hygiene, not exhaustion; §12.3 has no
row for slot-table saturation).

**Judgment: local fix** — this is an I12-family routing-rule repair, not an
architectural collapse: e.g., clause (b) additionally requires
`w.pin >= lastRetirementStamp` (any retirement after the pass's pin disables
the K0-serve fast path for that pass; conservative, cheap, pass-scoped), or
retain touched bits under live older pins while explicitly walking the slot
budget (the exhaustion horn must then be solved, e.g. spill masks / forced
world-evaluation when saturated). S9/I12 kinship should be recorded: "unflagged
⇒ world-safe" broke again, this time because the *invalidator* (retirement
sweep) ran ahead of the flag's remaining consumers (pinned passes), not because
a pull created an unseen edge.

---

## F2 — BLOCKER: per-pass evaluator re-stamping (§9.1) × flattened capsule
## prefixes (§9.2) livelocks suspended transitions (C15/C14 refetch-forever)

**Mechanisms defeated:** Mechanism 8 (evaluator staging) × Mechanism 5
(positional resource capsules). Defeats the design's own §9.2
"identity/content construction," whose premise — "for a pure retry with the
same world content, tracked read order and evaluator stamps are identical" —
is false for staged evaluators.

**The seam.** §9.1: "A hook invocation compares deps with that pass's stage if
present, otherwise with the committed entry. Changed deps mint a new
global-sequence stamp and replace only that pass's stage. A same-pass render
restart repeats this comparison." A Suspense retry is a **new pass** (seed
vocabulary: "a restart is a new pass"; the design's C15 step 4 concedes "retry
may have new pass pin"). So every retry re-compares deps against the
*committed* entry and — whenever deps legitimately changed in the transition —
mints a **fresh** stamp. §9.2 puts "every traversed computed
`(computedId, effectiveEvaluatorStamp)`" in the flattened prefix, and "reuse
requires pairwise prefix equality; mismatch drops this and later positions."

**Killing schedule:**

Setup: transition k sets React state `query` (via `setQuery` inside
`startTransition`) plus atom writes. Component M:
`n = useComputed(fnN, [query])` (deps change in k's world vs committed);
component (or same component) `h = useComputed(fnH, [])` where `fnH` reads
`n.state` and then suspends via `ctx.use(factory)` — an ordinary
derived-then-fetch chain, exactly R6/C15's shape.

1. Pass P1 (lineage L): M's hook `n`: no P1 stage → compare `[query']` vs
   committed → changed → mint stamp `S1`, stage. `h` evaluates in wk,
   traverses `n` → prefix contains `(n, S1)`; suspends at position 0; capsule
   `(hGen, L, 0)` stores thenable X and the prefix.
2. X settles; settlement kills the SUSPENSION memo and asks React to retry.
3. Retry pass P2, same lineage L: `n`'s hook: no P2 stage → compare vs
   **committed** deps → still changed → mint fresh stamp `S2 ≠ S1`. `h`
   re-evaluates, prefix now contains `(n, S2)` → pairwise prefix equality
   FAILS → position 0 dropped, entry generation bumped, factory invoked →
   **new thenable X2** → h suspends again.
4. X2 settles → retry P3 → stamp `S3` → mismatch → refetch → suspend → …

**Wrong observable outcome:** the transition never commits (starvation/hang),
with a duplicate side-effectful fetch per retry — exactly the failure C14/C15
name ("per-world thenable identity is stable across replays … or React
re-suspends forever") and exactly the I24 rule ("stamps must be retry-stable
receipt-line facts") this stamp violates: a per-pass-minted stamp is a
world-instance identity, the S20-adjacent class. The design's C15 step 4 walk
("retry … same receipt-line prefix, so same settled thenable is reused") is
the hand-waved step: it holds only when no staged-evaluator hook computed is
upstream of the suspension point.

**Judgment: local fix** — stamp minting must be lineage-stable for identical
dep values: key re-mints by `(lineage, nodeGen, hookSlot, deps-values)` (reuse
the previous pass's stamp when deps compare equal to that lineage's last
stage), or derive the effective stamp from (committedStamp, depsChangeContent)
rather than from a fresh `++globalSeq` per pass. Staging stays per-pass for
I22; only the stamp's identity rule changes. Note the same re-mint also
guarantees cross-restart world-memo misses for staged nodes, worsening W3's
already-flagged restart cost.

---

## F3 — HIGH: useSignalEffect queue consume/retain rule is unstated; the
## natural reading has no notification path at per-root lock-in (I14, C11)

**Mechanisms defeated:** Mechanism 7 (targeted effect enqueue) × Mechanism 3
(per-root lock-in). I14 requires retirement AND lock-in edges to each have
their own notification path to committed-world observers; the design names
retirement's (§12.1 step 4) but none for lock-in.

**The seam.** §10: writes "enqueue each reached committed signal effect once";
"flush triggers are root commit/lock, retirement, and settlement"; "a moved
fingerprint causes dependency revalidation; the user callback runs only if an
equality-stable dependency value/outcome changed." Nothing states whether a
flushed-but-unchanged queue entry is consumed or retained. Under
consume-on-flush (the natural reading of "enqueues … once" plus W5's "at most
one queued entry per affected effect/retirement"):

**Killing schedule:** token T spans roots A and B (C11 full support is the
declared scope). T writes atom `a`; effect E on root A depends on `a`.
Write-time walk enqueues E once. Before A commits T, any unrelated urgent
retirement fires the flush trigger; E revalidates: `fp(a, committedForRoot(A))`
has not moved (T's receipt is invisible — not retired, not locked) → no
callback → entry consumed. A then commits T's pass:
`tokenCommittedOnRoot(T, A, pass)` advances the watermark and mints a lock
stamp — `fp(a, committedForRoot(A))` moves and the fold now includes T's write
— but E is no longer queued and nothing at lock advance re-enqueues (§12.1's
targeted drain is retirement-only; F3's commit duties are lock bookkeeping,
folds due, F9). **E never observes `a`'s committed-on-A value until T fully
retires — which waits on root B's commit, unboundedly later.** C11's required
"A's passive effects observe k's values after A's commit even though the token
hasn't fully retired" (the design's own C11 walk step 2 asserts "effects A
see 1") is violated.

Under the alternative retention reading (entries persist until a
fingerprint-moved revalidation; every entry eventually sees retireVisStamp
move, so no leak), the schedule passes — but the design must SAY which rule it
means and pin it; the two readings differ in user-visible behavior.

**Judgment: local fix** — state the retention rule (retain until fp-moved
revalidation) or add a lock-advance targeted enqueue mirroring §12.1 step 4.

---

## F4 — MEDIUM: E-PRESERVE's "required basis edges" is ambiguous, and the
## invariant-M proof premise requires the strong reading

§5: "When K0 retracks while K1 is active, E-PRESERVE mirrors required basis
edges." §7.2's edge-removal proof step asserts unconditionally: "Edge removal
is only from K0; K1 retains the union edge until quiescence, so removing
cannot falsify reach." The proof needs EVERY removed K0 edge mirrored into K1
while the episode is active; "required basis edges" invites a cheaper narrow
reading (e.g., only edges of nodes with live touched bits).

**Killing schedule under the narrow reading:** committed `flag=true, x=1`;
`c = flag ? x : y`; W (committed watcher) on c. Transition k1 writes
`flag=false`. A NEWEST evaluation (core effect / untracked handler read)
retracks `c` → K0 drops `x→c`; `x` has **no receipts and no bits** at that
moment, so a bits-scoped E-PRESERVE skips the mirror. Transition k2 writes
`x=5`: walk from `x` finds no out-edge in K0 ∪ K1 → `touchedSlots(c)` never
gets k2's bit → W gets no k2-lane setState; a k2 render (scheduled by other
state) bails W out → committed k2 frame shows sibling k2 state beside W's
stale `c` — torn (k2's world has `flag=true, x=5 → c=5`). This is the S2/S9/
I17 family re-entered through the retrack door.

**Judgment: local fix** — one sentence: "required = every edge removed from K0
while LOGGED, mirrored with both endpoints and generation." The dev validator
(brute-force reach compare) should be promoted to a CI fuzz gate since the
narrow reading is the performance-tempting one.

---

## F5 — MEDIUM: slot-table saturation is never walked (interacts with F1's
## repair)

Even granting the design's literal reading (bits cleared at retirement, slots
released promptly — which is what enables F1's tear), any repair that retains
bits/slots under live pins, and independently any deferred-sweep condition
(`retroRefs`, bridge delivery depth) that outlives a token, makes
live-tokens + held-slots exceed 31 reachable: one yielded transition pass plus
a stream of retiring input batches. §6.1's `intern(token)` has no stated
no-free-slot behavior; §12.3 has no saturation row; masks cannot grow past 31
bits. A design that leans this hard on slot generations owes the exhaustion
walk: either prove writes always find a slot (the drain-at-slice-exit argument
almost does it for the literal reading — write sites can't run mid-slice, so
retro queues are empty in gaps — but it is nowhere written), or define the
saturation fallback (e.g., force world-evaluation semantics for overflow
tokens). Judgment: local fix (write the proof or the fallback).

---

## F6 — NOTE: G-Q cites a "known measured branch floor 2.4–3.8%" with no seed
## provenance

§13 states "numbers marked measured come only from the frozen research facts,"
but research-facts.md contains no LOGGED-quiet branch-floor measurement (D's
indirection tax is explicitly UNMEASURED there, predicted 3–5%). The number is
used against the design's own gate (declaring G-Q AT RISK), so the honesty
direction is right, but the provenance rule is violated as written; either cite
a real artifact or mark it UNMEASURED-predicted.

## F7 — NOTE: retireVisStamp is a cross-root global term; equal-value urgent
## churn on a suspense-prefix atom spuriously refetches

`fp(a,w)` includes the per-atom `retireVisStamp` for every world. When
retirements genuinely change visibility this is sound (retirement is a global
visibility event), but a stream of *value-equal* urgent writes to a prefix atom
(each appends a receipt — history nonempty — then retires) moves fp without
changing any fold, and each move kills the capsule prefix → refetch +
re-suspend of an unrelated suspended transition. Bounded per retirement and
sanctioned by I21's over-invalidation license, but it is a standing exception
to the design's own "cross-root invalidation is not [allowed]" line; worth a
named test and a line in the support/perf docs.

---

## Verified held (attacks attempted and failed)

- **C2 (flushSync excludes default):** always-log + atom-fold + touched route
  hold; the D-live case cannot reach clause (b) because D's bits are still set
  and K0 is dirty. Mount fixup schedules into D. Held.
- **C3 / rebase construction (§6.4):** replay-in-order with prefix-only,
  pin-gated compaction reproduces React's skip/rebase arithmetic including the
  `set 5 → 5` case; I tried compaction-past-a-gap and pin-held folds — blocked
  by "not retained by any live pass pin" and "never compacted past an older
  unretired receipt." Held.
- **C4/C5 pending bits:** per-(watcher, slotGen) bits with render-time re-arm
  deliver the second batch (C4) and cover the interposed-render case (C5);
  S14/S16/S17-class suppression is genuinely absent (delivery is value-blind,
  stamps are per-watcher-slot, not shared). Held.
- **C6:** per-write synchronous delivery under the writer's F1 token; no
  grouped drain exists to reconstruct. Held.
- **C7:** callstack-scoped render truth (F2 slices) + demote-on-first-write
  keeps a resumed pass on its captured world for the *tape* path; handler
  reads route NEWEST. Held (except via F1's clause-(b) hole, filed above).
- **C8/I7:** append-even-when-equal with the empty-tape-only drop. Held.
- **C10/I18/I13:** reach-based mount fixup + unconditional committed compare
  covers the retire-in-window race and the write-in-mount-window (watcher not
  yet registered) case — I attempted an equality-filtered bypass and found
  none. Held for mounts (see F1 for non-mount re-renders).
- **B1 armor:** root-slot lock stamps in immutable views; root A's lock storm
  cannot move B's `fp` (B's world has no A record); retirement stamps are
  atom-scoped. The injectivity construction's retire-then-clear ordering
  (stamp minted before lock removal) survives out-of-order retirement
  permutation. Held.
- **B2/F9:** hidden-Offscreen publication, error-abandoned staging,
  stale-alternate CAS, bailed-out subtrees (no stage exists to orphan),
  publicationsComplete reclamation — all attack angles closed by the
  generation CAS + "hook becomes current" edge. Held.
- **B3 cone carry + termination:** full reverse-reachable cone preserves
  path-transitive reach; R = Σ(2 − failures) strictly decreases per failed
  sweep; refresh pulls create no K1 edges so the worklist cannot grow from
  refresh itself. Held (liveness under continuous app activity is honestly
  not claimed).
- **C13:** effect snapshots and memos carry episodeEpoch (§12.3 rows), so
  seq renumber cannot false-validate them; capsules die with lineages before
  reset. Held.
- **I25 watermark vs urgent (C11 step 4):** exact-include-set gating +
  `max(old, committedPass.pin)` blocks the post-await leak; a pass that folded
  `s2` necessarily has pin ≥ s2, so watermark advance is consistent with what
  committed. Held.
- **Retro queue under discard/recycle:** slice-exit drains before host/commit
  including discard; token+slot+watcher generations reject stale envelopes;
  retroRefs defer recycle. Held.
- **Scar sweep:** S1–S22 — no scar is repeated as designed (S9's letter is
  respected via I12's conjunct; F1 above is a new retirement-side variant of
  its spirit, filed as such, with a schedule).

## Verdict

Two blockers, both at seams between otherwise-sound mechanisms, and both
repairable by rule changes that fit inside the architecture: a
retirement-visibility conjunct on the K0-serve routing clause (with the slot
budget then walked honestly), and lineage-stable evaluator-stamp minting for
retry-crossing capsule prefixes. The receipt/world/lock-view core, the F1–F9
seam, the B1–B4 repairs, and the notification story all survived deliberate
attack, so the architecture class is not invalidated. **Verdict: repairable** —
not implementation-ready until F1/F2 land with pinned tests (fork test 6
extended to the clause-(b) path; a staged-evaluator-upstream-of-suspense retry
test) and F3's retention rule is written down.
