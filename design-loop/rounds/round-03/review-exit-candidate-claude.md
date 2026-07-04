# Review: round-3 exit candidate — Claude (adversarial correctness)

Reviewed: `design-loop/rounds/round-03/design-exit-candidate.md` (two-kernel
champion, build-complete). Read per the reviewer prompt: background, the
design, correctness-cases, requirements/fork-charter/research-facts,
SCARS/INVARIANTS. No other designs, legacy specs, or prior-round reviews were
read. Method: re-walked the battery, attacked every written construction,
enumerated mechanism pairs sharing state, ran lifecycle and fork audits.

Scar scan: none of S1–S22 is repeated (freshness conjunct present, no value
suppression, pins in world keys, watermarked lock-in, hook-grain promotion,
carrier not promise-patching, staging over arena records). No measured fact
is contradicted without a new measurement (G-Q's 2.4–3.8% overage is owned
with a pre-registered renegotiation, not asserted away).

---

## Findings (most severe first)

### F1 — BLOCKER — Staged evaluator identity is invisible to read routing: the fast path and RENDER_NEWEST serve the committed closure to a pass that staged a new one

**Defeats:** invariant R routing (§6.2, line "if touchedSlots(n) == 0 and
CT(n): serve K0's cached value") + RENDER_NEWEST classification (§6.1)
versus staged evaluator identity (§11.1, I22); also K0 cache validity at
promotion.

**The false premise, quoted.** Invariant R's written construction opens:
"worlds diverge from NEWEST only through receipts (folds differ from K0
only in visible entries; base is shared)." That premise is false under the
design's own I22: a pass holding a staged evaluator for computed `c` has a
world-value of `c` (staged `f_B` over deps) that diverges from K0's cache
(committed `f_A` over the same deps) with **zero receipts anywhere**. The
routing gate has only two conjuncts — `touchedSlots(n) == 0` (receipt
cones) and `CT(n)` (donor-clean cache) — and neither can see evaluator
divergence: no receipt exists, and the donor's staleness marks know nothing
of hook fn identity (D4 closed kernel). Nothing in §6, §8, or §11 routes a
staged-evaluator node off the fast path; T11's own walk (step 4) asserts
"M(c,wT) records staged fnStamp2" without ever establishing why routing
took the world path — that unexplained step is exactly where the schedule
below breaks it.

**Failing schedule A (RENDER_NEWEST — ordinary code, wrong committed
frame).** Setup: quiet app, zero receipts. Component X owns
`useComputed(() => filterList(items.state, filter), [filter])` → node `c`,
committed evaluator `f_A` (filter='a'). Sibling Y reads `c` via
`useSignal(c)`.

```
1 | startTransition(() => setFilter('b')) — React-state-only, no signal write | zero live receipts → pass P classified RENDER_NEWEST (§6.1), binds K0 directly
2 | P renders X; hook invocation | deps ['b'] ≠ committed ['a'] → stage {f_B, ['b'], fnStamp2} in P's frame (§11.1). X's read of c: RENDER_NEWEST → K0 serve → f_A's cached value (donor-clean; no dep changed in K0). Staging is not a write → no R3 demotion (§5.1 demotes on logged writes only)
3 | P renders Y; reads c | same K0 serve → f_A's value
4 | P completes, commits | screen shows the 'a'-filtered list against filter='b' props — wrong committed frame. Hook commit effect promotes f_B + fnStamp2
5 | post-commit NEWEST reads of c | K0's donor cache still holds f_A's value and is donor-CLEAN (no dep write); the S3 fnStamp conjunct guards world MEMOS only; nothing in §11.1 dirties K0 at promotion → f_A's value served indefinitely, until an unrelated write to items
outcome: wrong value in a committed frame, with NO correction path — no receipt, no walk, no backstop (backstops key on writes/retirements/settlements; none occurred)
```

**Failing schedule B (real world + sibling tear inside one pass).** Same
components; transition k writes unrelated atom `z` (so P has a real world
`wk`, not RENDER_NEWEST), and k's React state changes `filter`.
`TS(c) = 0` (z's cone doesn't touch c) ∧ `CT(c)` → fast path. If the hook's
own render read is charitably treated as "a pass evaluation" using `f_B`
(populating `M(c,wk)`), sibling Y's read still routes through §6.2 first —
fast path serves `f_A`'s K0 value (memos are only consulted on the world
path) → **X and Y render different values of `c` in the same pass** — a
torn frame within one render pass. If the hook's read is NOT special-cased,
both render `f_A` and schedule A's wrongness applies. Either reading loses.

**Why this is a blocker:** `useComputed` with changing deps inside a
transition or any urgent re-render is bread-and-butter usage (useMemo
parity); the outcome is a stale/torn committed frame with no repair
trigger. The battery rule also applies: invariant R's by-construction claim
is written but its premise omits a divergence source the design itself
names as world-scoped state (I22).

**Judgment: local fix** (the architecture stands; the routing rule and two
lifecycle rules change):
1. Routing gate gains a third conjunct: fast path only if additionally *no
   staged evaluator/reducer for n exists in the current pass frame* (O(1)
   staged-table probe — it is already per-pass and keyed by hookNode).
2. Staging demotes RENDER_NEWEST for that pass (or equivalently: staged
   nodes always world-route; a RENDER_NEWEST pass retains its real
   (mask, pin) for exactly this, per R3's demotion data).
3. Promotion at the hook's commit effect marks the K0 node stale
   (commit-phase, render-pure), so NEWEST re-evaluates with the promoted
   evaluator instead of serving the pre-promotion cache.
4. Invariant R's construction gains evaluator identity as a fourth
   divergence leg, discharged by (1); T11 step 4 re-written to cite it.

### F2 — HIGH — Watermark ADVANCE is a visibility flip that neither the fingerprint nor the flush triggering provably observes: committed-channel effects miss re-runs for the lifetime of an async action; committed-for-root memos can serve stale

**Defeats:** S2b's visStamp mint-site definition (§3/§8.1) + effect flush
triggering (§11.4's consumable touched-effect queue) + worldKey "root-lock
variant" under-specification (§3), at the R13/I25 watermark seam.

The design mints visStamp "at every retirement fold touching `a` and at
every per-root lock-in of a slot holding entries of `a`". Every walk
exercises only the retire-fold and the FIRST lock-in (C16-B1 step 3;
C11-W step 5 advances the watermark but never walks effects or memos at
that step). A watermark **advance** admits entries in (oldWatermark,
newWatermark] — which can be *older than the already-visible max from
another slot*: the I21 non-injectivity shape one level up. Whether an
advance mints visStamp is nowhere stated; and the commit-time flush drains
a queue whose entry for the effect may already have been consumed by an
earlier same-atom flush.

**Failing schedule.** Root A; atom `a=0` (updater ops); `useSignalEffect`
E reads `a`; async action token T; urgent batch U.

```
1 | action T: a.update(x=>x+1)@s1; A renders {T} at pin p1, commits | lockedIn(A)=(T, watermark p1); vS(a)=v1 (first lock-in); flush: E runs, sees 1; snapshot fp=max(s1,v1)
2 | post-await (carrier): a.update(x=>x*2)@s2 — parked under T | walk enqueues E into A's touched-effect queue; setStates in T's lanes
3 | urgent U: a.update(x=>x+100)@s3; U commits on A and retires | compaction blocked at unretired s1; vS(a)=v2 minted at the retire-fold; committed-for-A = {s1 locked≤p1, s3 retired} → (0+1)+100 = 101; the U-targeted drain compares E (E is U-touched via s3) → fp moved → E re-runs, sees 101; snapshot fp=max(s3,v2); E's queue entry CONSUMED ("dedup per flush window")
4 | A renders T's pending s2 update at pin p4 ≥ s3; commits | onBatchCommittedOnRoot(T,A,p4) advances watermark p1→p4 → s2 newly visible to committed-for-A, BELOW the already-visible max s3. Fold now {s1,s2,s3} = ((0+1)*2)+100 = 102; A's DOM shows 102
5 | passive flush at this commit | E's queue entry was consumed at step 3 and no write walk re-enqueued it → E never compared. Even if enumerated: fp = max(newest-visible s3 [unmoved], baseSeq [unmoved], rS, vS) — moves ONLY if the advance mints vS, which no line states and no walk shows
6 | E stays at 101 while committed-for-A and the DOM show 102 — until the action settles (final retirement's fold mints vS; its targeted flush re-runs E, IF that flush enumerates via touchedList[T] rather than the same consumable queue — also unstated)
outcome: missed effect re-run after a commit made new state visible on the root — C16's contract violated at the watermark-advance commit — for a window bounded only by the action's io latency (unbounded, user-controlled)
```

**Same root cause, second surface (memos).** A committed-for-root(A) memo
of a computed over `a`, recorded at step 3: at step 4 there is no
retirement (no worldMemoEpoch mint) — the memo survives the ladder's epoch
check. If the worldKey's "root-lock variant" does not incorporate watermark
*values*, the key is unchanged; step-3 fingerprint re-check: newest-visible
still s3, baseSeq unmoved, vS unmoved (absent the advance mint) → "all
unmoved ⇒ re-stamp, serve" → **stale committed value served** (excludes
s2) to effects/fixups/reconcile after A's own DOM committed 102.

**Judgment: local fix**, three explicit rules (all inside the existing
mechanisms): (1) every `onBatchCommittedOnRoot` — first lock-in AND each
watermark advance — mints visStamp for atoms whose entries the advance
newly admits (or conservatively: all slot-held atoms, over-invalidation
safe); (2) commit/retirement effect flushes target via touchedList[slot]
(durable) rather than solely the consumable queue — this is I14's own scar
rationale ("write-time queue entries get consumed by earlier flushes")
applied to the lock-in trigger; (3) state that worldKey's "root-lock
variant" incorporates watermark values. Fork test 17 should gain the
advance-with-interleaved-urgent-writes schedule above.

### F3 — MEDIUM — The per-write notification walk over K0∪K1 has no named termination discipline, and the union of per-world-acyclic graphs can cycle: an ordinary two-flag program hangs the write path

**Defeats:** notification walk (§10: "per-write full-reach walk over K0∪K1
... No pruning, no cross-walk marks") + K1 union-across-worlds (§7).

Each world's dependency graph is acyclic (R7's EVALUATING throw is
per-(node, worldKey)), but K1 is the **union across worlds**, and unions of
acyclic graphs cycle. Construction with ordinary code: `c = f1 ? d : x`,
`d = f2 ? c : y`. World A (f1=true, f2=false) records edge d→c; world B
(f1=false, f2=true) records edge c→d. Union: c→d→c. Now any write to `x`
(or `y`) walks x→c→d→c→d→… — the walk is specified with *no pruning* (a
deliberate D13/C4 property: marks must not stop walks, and re-delivery
dedup is per-(watcher, slot), not per-visit). Without a per-walk visited
mechanism the write path livelocks — a hang is a crash-class outcome. The
donor's iterative K0 walk terminates via donor staleness short-circuits
that do not exist for this walk, and "no cross-walk marks" permits but does
not name a within-walk visited column; nothing prices it (it is a hot-path
cost: one column write + one compare per visited record, every write).

**Judgment: local fix** — name the mechanism (e.g., per-walk epoch stamp
column: bump one global walk counter per write, mark visited records,
compare-and-skip) and add it to G-W/G-N's priced instruction budget; add a
union-cycle row to the edge-add/notification fuzz battery.

---

## Notes (no failing schedule as written, or safe under either reading — but the spec must pick)

- **N1 (§12.4).** The boot self-test's verdict necessarily arrives a
  microtask after `registerReactBridge()` returns (the probe awaits).
  "Throws at boot" should state the window semantics: bridge arms LOGGED
  regardless, verdict-throw is async-loud, and an action started inside
  that one-microtask window is covered by the same §12.5 bound.
- **N2 (§6.3 site 3).** Delivery contexts are enumerated as "immediately
  when in the writer's stack; queued ... when inside a render." World
  evaluations also run from effect flushes, mount fixups, and the reconcile
  backstop (committed-for-root evals). State that edge-add deliveries fire
  immediately (runInBatch is context-establishing) there too — an
  implementation reading the two contexts as exhaustive would skip
  HX-3-class retroactive deliveries discovered during a committed-world
  evaluation.
- **N3 (C9(a) vs §11.2).** The C9 walk adds "AND no pending update exists"
  to the committed compare; §11.2's pseudocode is unconditional. Under R11
  both readings are safe (the fixup runs after that root's lock-in, so
  v_now matches for mounts committing with their own pass), but the drift
  invites implementing a hybrid that re-opens I18's retire-race. Pick one
  normatively; I recommend the unconditional §11.2 form.
- **N4 (§5.3 step 2).** "Blocked below any live pass pin" should be stated
  as a predicate: compact entry e into base iff `e.retiredSeq ≤
  min(live pins)`. My base-inclusion attack (folding an entry a pinned pass
  legitimately excludes — its retiredSeq exceeds that pin — into the shared
  base, silently changing the pinned world's fold) fails only under exactly
  that reading; C7 step 4's "can't fold below live pin p" is too loose to
  pin an implementation.
- **N5 (§12.4 probe scope, documentation).** The plugin-injected probe
  proves the plugin ran over the chunk graph that contains the probe — not
  over a second bundler's output in a hybrid build. The §12.5 dev warning
  covers the residual; the support matrix line could say "per bundle
  pipeline" to keep the shipped contract honest.

---

## Verified held (attacked and survived)

1. **Invariant M induction + E-PRESERVE.** Attacked with re-track
   displacement during live receipts, edge-adds through cutoff-CLEAN
   downstream nodes (T9), and retroactive delivery under discard (T10):
   the three legs + site-3 propagation held; mirrors' delivery exemption is
   sound (their paths pre-flowed both bits and deliveries).
2. **Watermarked lock-in (I25).** C11-W held under multi-root skew,
   settle-before-rerender (retired clause + reconcile backstop closes the
   DOM-contradiction window pre-paint), and post-await write ordering. The
   watermark-as-committed-prefix construction (base/step) is correct for
   render/world visibility; F2 is about its *observers*, not the rule.
3. **Compaction prefix rule.** Attacked by trying to fold entries excluded
   from a live pinned world into the shared base: blocked under the N4
   reading (retiredSeq ≤ min-live-pin on I15's single number line); CH-4's
   3-not-4 stays unrepresentable.
4. **Mid-pass world drift via lock-in.** Attempted a schedule where L(r)
   gains a slot while a pass on r is yielded (locked clause newly admitting
   old seqs): unreachable — commits on r are serialized with r's passes,
   and global retirements stamp above the pass pin (I15). Verified held.
5. **Per-(watcher, slot) dedup.** C4/C5 held; recycle hygiene held (dedup
   columns zeroed at slot release — T6/I19); wholesale re-arm at render
   errs only toward duplicate setStates.
6. **RENDER_NEWEST revocation for writes.** C7-D held: demotion precedes
   the first receipt, so pre-demotion K0 serves equal the real world's
   values — for value divergence. (Evaluator divergence is F1.)
7. **Carrier + parking (§12).** C12/C12-U held; the §12.5 misattribution
   bound is honestly derived (write lands in a real batch; every structural
   invariant applies to it); interleaved actions/timers covered by the
   measured 74-matrix (I30); S21/S22 not repeated.
8. **C2/flushSync.** Held — the always-log receipt plus the step-1 write
   walk marking the downstream cone answers both traps; load-bearing fact
   is fork test 12 (mask parity incl. microtask backfill), correctly
   flagged as G4 critical-path risk.
9. **C3 rebase parity + C3-E stepwise fold equality.** Arithmetic re-walked
   including the blocked-compaction step and the plain-set 5-not-6 variant;
   I2/I29 satisfied.
10. **T8-N quiescence refresh scope.** Attacked with an unwatched
    intermediate whose newest basis lives only in K1 feeding a watched
    downstream node: site-3 propagation forces the watched node onto the
    world path during the episode, making it K1-touched and thus refreshed;
    donor recursion re-tracks the stale upstream. Held.
11. **Suspense prefix (§9.2).** Retry-stability (receipt-line facts),
    content-sensitivity (included write / visibility flip / evaluator
    swap), and starvation-freedom (mint-site relevance filter) all held
    under retirement-storm and intra-batch-write attacks; settlement
    generation-check + belt held (TKC-2 class).
12. **Lifecycle master table (§15.1).** Probed renumber-with-heap-held
    snapshots, K1 tag wrap, 31-parked-actions, slot recycle with
    watermarks, staged-table death: each retained value has a paired guard;
    C13 held.
13. **Activation monotonicity (S6)** and **store-only persistence (D2/S4)**
    held; **C6** held by per-write delivery in the writer's context with
    grouped drains structurally absent; **C17** deletion is legitimate (no
    truncation surface exists).

Fork honesty: facts are edge-triggered at named reconciler sites; the
rebase drill answers are concrete; mask crossing the boundary is slot bits,
not lane bits (hard rule respected). Cost honesty: every gate carries a
number or a queued spike with a named fallback; G-Q's overage is owned, not
hidden. F3 adds one unpriced hot-path column to that ledger.

---

## Verdict

The two-kernel architecture again survived the battery's traps and my
counter-schedules at every receipt-carrying seam, but it has one blocker at
a seam its own invariants name and its construction premise excludes:
staged evaluator identity is world divergence with no receipt, and the
routing fast path / RENDER_NEWEST serve the committed closure to passes
holding a staged one — a wrong or torn committed frame in bread-and-butter
`useComputed` code (F1), plus a HIGH under-observed visibility flip at
watermark advances (F2) and a MEDIUM unpriced walk-termination mechanism
(F3). All three repairs are rule changes inside the existing mechanism set
(a routing conjunct + staging/promotion staleness rules; explicit vS mint
and durable flush targeting; a per-walk visited column), none invalidates
K0/K1, the tape, visibility math, or the fork protocol. **Verdict:
repairable** — not implementation-ready until F1's routing conjunct,
promotion-dirties-K0 rule, and F2's three clarifications are folded in and
re-walked (T11 and C11-W step 5 are the walks that must change).
