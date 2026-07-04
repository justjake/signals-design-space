# Correctness review: `react-concurrent-signals-arena.md`

- **Reviewer:** Claude (Fable 5, effort: max), 2026-07-04
- **Document:** `react-concurrent-signals-arena.md` @ 8712ab1 (3,043 lines, "final design specification, approved for implementation")
- **Prior art:** `reviews/2026-07-04T08-25-07-0400-codex-react-concurrent-signals-arena-correctness-blockers.md`. I did my analysis before reading it, then deduplicated. Four of my findings coincide with codex's (noted inline, with extensions where my analysis goes further); three blockers below are new (F1, F6, F8), as are several smaller items.

## Verdict

The canonical kernel, the tape/visibility model (10.2), the seq-order rebase semantics (10.7), the retention/sweep rules, and the slot-recycling protocol are sound — I attacked each and they held (see "Verified sound" at the end). The correctness holes are concentrated in three seams:

1. **The fork protocol is missing two facts** the overlay cannot live without: *yield/resume edges on render passes* (F1) and *a way to run grouped broadcasts in a batch's lane context* (F6 — the API exists, `unstable_runInBatch`, but the drain never uses it).
2. **Every "who needs to hear about this write?" mechanism is derived from canonical topology or canonical-time state**, while the thing being notified about is a *world-specific* fact. This one root cause produces F2 (divergent deps never notify), F3 (memo certificates miss eval-time-unlogged sources), F4 (urgent tape creation never marks), and F7 (logging starts only when a watcher exists).
3. **Two lifecycle events don't reset/stamp enough state**: quiescence doesn't bump `overlayEpoch` while it *does* reset the seq counter (F8), and equal-value writes are dropped against a world that other worlds don't share (F5).

None of the fixes below requires a new field in plane `M` or plane `G`, a stride change, or a new flag bit. The integration table at the end shows where each fix lands and which gate absorbs its cost. Two fixes (F1, F6) change the fork protocol / M0 deliverable and one (F2+F3) changes M3's data structures — these are the ones that are expensive to discover later, because the milestones build on top of them.

---

## Blockers

### F1 (new) — The read context is wall-clock-scoped, but render passes yield; as specified, an urgent write during a time-sliced render **throws**

The spec pins these three statements together:

- 10.1 (line 1396): "The context is a module scalar, not a parameter"; RENDER is active "between `onRenderPassStart` and `onRenderPassEnd`" (line 1401).
- 6.3 (line 681): "Yields do **not** end a pass: a pass paused for time-slicing and resumed later is one pass." The fork protocol (6.1) has **no yield/resume callback**.
- 10.8 (line 1650): "Writes during `RENDER` context throw, unconditionally."

Time-slicing means the pass yields to the event loop *while remaining open*. Event handlers, timers, and microtasks run in those gaps — that is the entire point of concurrent rendering. As specified:

- **Failing schedule (crash):** a transition render is in progress and yields; the user types; the input handler calls `atom.set(x)`. The context scalar still reads `RENDER` (pass open, no end delivered) → the write throws. This is the design's flagship scenario — "urgent updates (typing, clicking) can happen *during* that background render" (2.2) — crashing on its first exercise. The 17.6 "interruption and rebase" test would hit it immediately.
- **Failing schedule (stale reads, no crash):** same yield window, handler *reads* `atom.state` to decide something. 10.1's table says event handlers get `NEWEST`; the scalar says `RENDER`, so the read resolves against the pass's pin and include mask — a stale, pinned world leaks into event-handler logic. The equality gate (which compares "newest-visible") also runs against the wrong world.

`unstable_getRenderContext()` (line 598) knows the truth ("undefined outside render") but the engine deliberately never consults the fork per read — that's the right performance call, which is exactly why the scalar must be *kept correct by edges* instead.

**Fix (fork + bridge; no engine data change).** Add two listener callbacks to 6.1: `onRenderPassYield(container)` / `onRenderPassResume(container)` — edge-triggered where the work loop already knows it is leaving/re-entering (the `shouldYield` exit from `workLoopConcurrent`, and pass resumption in `performWorkOnRoot`). Same inertness rule as the other hooks (one null-check when unsubscribed). The bridge flips the context scalar `RENDER ↔ NEWEST` on these edges; `passPin`/`passIncludeMask`/`passSerial` persist untouched across yields, so resumed reads still resolve Wp exactly as designed. Debug builds can additionally assert `getRenderContext() !== undefined` whenever a read runs in RENDER. This belongs in M0 (it is protocol) and its absence invalidates 10.1's context table as written.

### F2 (confirms codex #1; adds a completeness argument and the urgent-write closure) — World-divergent dependencies have **no notification path** to watchers; the spec's own T1 asserts behavior no specified mechanism produces

- Overlay evaluations are untracked and never touch topology (10.5, by design and for good reason).
- The notify walk traverses canonical subscriber edges only (8.7.2).
- Therefore an atom that is read *only* in some world's evaluation (never canonically) has an empty subscriber list, and a deferred write to it stamps nothing and collects nobody.

T1 (17.4, lines 2574–2577) requires exactly this to work: after `flag=true` diverges world k down the `a` branch, `a.set(1)` in k must invalidate the cached k-evaluation **and** notify the watcher in k's lane. The walk from `a` reaches nothing — `a` has no canonical subscribers (`c` canonically reads `flag, b`; the k-world read of `a` was untracked). The watcher is never told; k's render omits the component; k commits a torn frame (siblings show k's world, this component shows its stale render); absorption then corrects it one frame late with an urgent re-render. This is the tear class the appendix claims the design is "immune by construction" to (Decision record #5).

**Fix (overlay side-tables + drain step; no plane changes).**

1. **Registry:** per batch slot, a side list `slotNodes[slot]: number[]` of node ids that currently hold a writer's-world memo for that slot's world. Registration happens inside `overlayEvaluate` when it creates/refreshes a memo with a writer's-world key (dedup by scanning the node's own memo list for an existing key — no new node field needed). Cleared at slot release and quiescence.
2. **Drain step:** after the notify walk(s), re-validate registered nodes' memos (the F3 certificate check — a handful of integer loads per node): on a **deferred** drain for batch k, re-validate `slotNodes[k]` only (a k-write can only change k's own writer's world; pass worlds are pinned, Wn self-checks at read time). On an **urgent** drain, re-validate every live deferred slot's list — because APPLIED entries are visible in *every* writer's world ("RETIRED or APPLIED or batch = B", 10.2), an urgent write changes pending worlds too; codex's review notes this half and it is correct. For each invalidated node: re-evaluate in that world (memoized on the node as usual), walk that node's subscriber list for IMMEDIATE watchers, apply the 10.6 cutoff per watcher.
3. **Why this is complete (the first-divergence induction).** Worry: a node that has *never* been evaluated in world k has no memo to re-validate — can it be stale at k's commit? No. Its k-evaluation and its canonical evaluation are the same deterministic function; they read identical atom prefixes until the first atom whose k-value differs from its canonical value. That first-divergence atom is therefore read by the canonical evaluation too — i.e., it **is** a canonical dependency — so the write that made it diverge reaches the node through the ordinary canonical walk, collects its watchers, and the resulting evaluation registers the node in `slotNodes[k]`. From then on, step 2 covers it. So: canonical walks catch the *first* divergence; the registry catches every *subsequent* divergent-dep write. (This argument leans on computed purity — already a contract — and on F3 fixing the certificate, since re-validation is only as good as the certificate it checks.)

Cost: bounded by *distinct watched nodes actually evaluated in that world* (not by watcher count — memo sharing already collapses fan-out), i.e., the atoms/nodes a transition actually touched. Same cost class as the walk itself. G-7's fan-out shapes should add a registered-node dimension so this is priced, not presumed.

### F3 (confirms codex #2; adds the nested-frame flattening requirement) — The memo validity certificate omits exactly the reads that make worlds diverge

`srcAtoms` records "the LOGGED atoms this evaluation read" (10.5, line 1513) — logged **at evaluation time**. In T1, `a` is unlogged when world k first reads it (its first write comes later), so `a` never enters the certificate, and T1's own justification — "the cached 0 must have been invalidated by the tail-seq check on `a`" (line 2576) — is false under the spec's own definition. The stale memo then also poisons F2's re-validation and the 10.6 cutoff (broadcast compares a stale value, suppresses the setState, and the batch commits without the component).

**Fix (memo shape only — heap objects in the existing `memos` column):**

1. Record **every atom the evaluation read**, with `srcSeqs[i] = tail seq if LOGGED at read time, else 0`. Validity check becomes: `(LOGGED(aᵢ) ? tailSeq(aᵢ) : 0) === srcSeqs[i]`. An atom that becomes logged after the eval now mismatches (0 ≠ tail) and invalidates — which is precisely T1.
2. **Flatten nested evaluations into every open certificate.** A parent overlay evaluation that reads a marked child computed either re-evaluates it (child's atom reads must land in the parent's certificate too, not just the child's) or hits the child's memo (the child's `srcAtoms/srcSeqs` must be merged into the parent's). Otherwise a grandchild-source append invalidates the child memo but leaves the parent memo "valid," and a parent-level read serves the stale composition. The cheap implementation is a single flat collector array with per-frame base indices (same save/restore discipline as the scratch stacks), recording into all open frames; merging on memo hit is the alternative. The spec currently specifies neither.
3. **Promise settlement must invalidate writer's-world memos** holding a `SuspendedBox` (nothing moves an atom tail when a thenable settles; pass worlds are rescued by React's own retry, writer's-world cutoff memos are not). Cheapest sound rule: bump `overlayEpoch` on settlement of a thenable that any live overlay memo captured.

Certificate arrays get longer (all reads, not just logged ones): ~one int pair per dependency per overlay evaluation, allocated only on evaluations (never per read), reclaimed at sweep — the existing memo cost model. The validity check stays a short integer loop.

### F4 (confirms codex #5; adds the post-eval re-check, which the mark-on-creation fix alone does not cover) — The mark invariant is never established for urgent-created tapes, and can be established *too late* for the read that triggers it

Two sub-defects:

**(a) Urgent tape creation never marks.** Only deferred writes run the notify walk (9.8, line 1351); `appendLog` explicitly notifies nobody (9.3, line 1205); yet the urgent path claims "the region's marks are already maintained (the tape-creating write marked it…)" (line 1385) — true only if the tape happened to be created by a *deferred* write. In LOGGED mode the common case is the opposite: every ordinary event-handler write urgently creates a tape. Downstream computeds stay unmarked, so `readComputed` takes the kernel path and serves **W0** to contexts that must exclude applied-unretired entries:
- the spec's own 9.1 flushSync case, one node downstream: default-lane `a.set(1)` (applied, unretired, tape-created, *no walk*) → `flushSync` render excludes batch D → direct reads of `a` correctly replay to the old value, but `c = a + 10` is unmarked → kernel path → shows the new value. **Torn frame inside the exact scenario the always-log rule exists to serve.**
- any `COMMITTED` read (useSignalEffect, SSR-adjacent paths) of an unmarked computed over an atom with applied-unretired entries observes uncommitted state.

Fix: on `LOG_HEAD: 0 → nonzero`, run a **mark-only** cone walk (reuse `notifyWalk` with watcher-collection disabled; fresh ticket; same `OVERLAY_STAMP`) regardless of write classification. Urgent broadcast/cutoff duties stay with kernel propagation exactly as designed. Amortization: once per (atom, era) — marks are monotonic until quiescence, so steady urgent traffic to an already-logged atom never re-walks. G-6 should split its measurement into first-logged-write (walk included, cone-size dimension) vs steady logged write (the existing ≤2×).

**(b) Mark repair fires mid-evaluation — one read too late.** `readComputed` checks the stamp *before* evaluating; 8.7.3's repair stamps the consumer only when the canonical evaluation **links** a logged/marked producer — i.e., after the kernel path was already chosen, and the canonical (W0) result is then returned to a world-sensitive reader. Two reachable shapes:
- A fresh `useComputed` node mounts during a transition render: never walked (stamp 0), unmarked → kernel evaluation → reads the deferred-written atom kernel-internally at its **old** canonical value → returns the wrong value for Wp. This undercuts 13.2's mount-mid-transition guarantee for freshly created nodes.
- An old computed whose canonical re-evaluation takes a *new branch* into a logged atom mid-era: same one-read window.

Fix (one branch, no data): in world-sensitive contexts (RENDER, COMMITTED, writer's-world, and NEWEST while `unappliedEntries > 0`), after a `kernelComputedRead` that ran an update, **re-check the stamp**; if the node became marked during the evaluation (repair fired), discard the returned value and `overlayEvaluate` in the caller's context. The canonical cache/topology the evaluation produced remains valid canonical maintenance — only the answer for this reader is replaced. Cost: one Int32 load + compare on a path that just ran a user recomputation (noise), zero on the memo/fast paths.

### F5 (confirms codex #4; adds the empty-log soundness proof that preserves the fast path) — Equality-gating writes against the newest world drops receipts other worlds need

Lines 288, 499, 1690: equal-vs-`NEWEST` writes are dropped before logging. Codex's counterexample stands: base 0; pending transition T writes `SET 1`; urgent write `SET 1` compares against Wn = 1 → dropped → the urgent render (which excludes T) reads 0. The urgent write is *lost from its own world*. Symmetric failures exist for two overlapping transitions, and truncation (optimistic rollback) makes dropped-duplicate scenarios worse. React never conditions enqueueing on current value except when the queue is provably empty — that exception is the salvageable part:

**Fix with the fast path kept:** the write-time equality drop is sound **iff `LOG_HEAD === 0`** — and then it is sound even for `UPDATE`/`DISPATCH`: a dropped entry would have carried the lowest seq of any future tape, so *every* possible world's fold evaluates it against the base snapshot; evaluate the fn/reducer once against the current (base-to-be) value, and if equal, no world could ever observe a difference. With a non-empty log, never drop — append unconditionally; equality then lives where the spec already half-placed it: in the 10.6 broadcast cutoff (suppress setState, not history), in replay folds (`acc = isEqual(acc, next) ? acc : next`, preserving reference stability), and at absorption (11.2, already specified). Unlogged atoms — the overwhelming majority — keep the O(1) early-out, so G-6 is unaffected on the shapes that matter.

### F6 (new) — Grouped broadcast drains call `setState` outside the writer's transition scope: lane inheritance silently breaks exactly where the design batches for throughput

The whole lane-inheritance story rests on "call the watcher's `setState` in the writer's stack" (line 520). That holds for the unbatched path (write → drain before returning, inside the `startTransition` scope). It does **not** hold for the two grouped paths 9.8 names (lines 1359–1361):

- `batch(() => { a.set(1); startTransition(() => b.set(2)) })` — the drain runs at batch close, *after* the `startTransition` scope ended. The watcher `setState` for b's cone runs there → `requestUpdateLane` assigns the **urgent** lane. Consequence chain: the urgent re-render's mask excludes T (reads old values, wasted); T's own render has no T-lane update for the watcher, so it skips the component; T commits a frame where React-state driven by the same transition is new and every signal-driven component is stale — a torn commit, corrected one frame later by absorption's urgent broadcast.
- "React's own event-handler scope where the bindings batch broadcasts" — the mechanism for this batching is never specified (what closes the group?), and any deferral to a scope boundary or microtask detaches *every* setState from *every* writer's scope.

**Fix (uses an existing fork API; policy-layer only).** The broadcast queue already knows each collected watcher's provoking batch token (the drain evaluates per writer's world, so the token is in hand). Group the drain by token; for each **deferred** token group, wrap the setState loop in `unstable_runInBatch(token, () => …)` — that is precisely the lane-override primitive 6.5 built for 13.2, and its retired-token `false` return falls back to the plain urgent setState, which is the correct semantic there for the same reason as 13.2's fallback. Urgent groups run bare (they are in an urgent context already, or lane-equivalent). Also: specify the event-scope grouping trigger explicitly (safest: only engine `batch()`/`startSignalTransition` group; plain writes drain in-stack), because G-7's "once per drain" amortization is load-bearing and currently rests on an unspecified mechanism. One `runInBatch` call per distinct token per drain — negligible against the evaluations the drain already does.

### F7 (confirms codex #3; independently verified) — `writeMode` flips to LOGGED only when the first watcher mounts; the receipt for the first transition is already lost by then

Line 1134. `startTransition(() => { atom.set(1); setShow(true) })` with no watcher yet: the write goes DIRECT (canonical, no tape, no base snapshot), so no later mechanism can exclude it from urgent renders or reconstruct the pre-transition world for the mounting component. Mount-during-transition (13.2's marquee case) is broken for the app's first transition, and re-broken any time the "last watcher unmounts" reversion fires before a burst that re-mounts. Codex's fix is right and I'd sharpen it to: **LOGGED is a monotonic consequence of bridge activation** (first import/registration of `cosignal/react`), never of watcher count; the DIRECT reversion exists only for pure-core teardown scenarios (tests), not as a runtime oscillation. This also de-risks E1 (the write-gate experiment): the gate stops oscillating per subscription pattern, which is the exact polymorphism hazard E1 worries about.

---

## High

### F8 (new) — Quiescence resets the seq counter but not `overlayEpoch`; surviving memo lists can falsely validate across eras

- 9.7 (line 1309): `seqCounter` resets to 1 at quiescence. Seq values therefore **repeat across eras**.
- `overlayEpoch` bumps only on retirement and truncation (line 929) — not at quiescence.
- Memos are "abandoned," not cleared, at quiescence, and 14.2 (line 2032) explicitly says a previously-marked computed "may retain one small dead list until its next overlay use — bounded, documented, harmless."

Not harmless: era 1 leaves a newest-world memo (key 0, epoch E, `srcSeqs = [7]`) on `c`'s list, created *after* the era's last retirement (so its epoch is current) — e.g., by a NEWEST read during the sweep window. Era 2 begins (no retirement yet: epoch still E); a transition writes `a` seven times (open pass blocks coalescing, or several batches); `a`'s tail seq is again 7; a NEWEST read of `c` walks the surviving list: key matches, epoch matches, `LOGGED(a)` ✓, tail 7 === 7 → **stale era-1 value served**. Narrow, but it violates the design's central memo claim ("can never serve a stale value") and randomized fuzzing with small counters will find it.

**Fix: one integer store — bump `overlayEpoch` as part of the 9.7 quiescence reset.** Every surviving memo entry becomes structurally invalid, which is what "abandoned" was supposed to mean. (Add it to the 8.8/14.3 quiescence postconditions and the 17.2 forced-counter cases.)

### F9 (concur with codex #6) — `COMMITTED` is a global view, but commits are per root

Verified: with a batch spanning roots (6.2's lock-in), root A commits while the token is still pending on root B; root A's passive `useSignalEffect`s read retired-only (line 1425) and see values older than root A's own DOM; the engine-pathway re-run fires only at full retirement. The fix belongs where codex put it — a per-root committed view in the bindings (committed pin + locked-in batch mask per container, the same data the fork's committed-set already tracks) — not in node records. I'd add: the microtask effect flush needs to run per root commit, filtered by that root's view, not once per token retirement.

### F10 (concur with codex #7, with the key-stability constraint made explicit) — The suspense thenable cache has no coherent key for multi-token passes

12.3 (line 1808) keys pass-world thenable caches by "the batch token," but a pass's world is `(pin, include mask)` and masks are legitimately multi-token (entangled transitions, per-root lock-ins; T7 tests exactly this). Note the constraint that makes this genuinely awkward: the key must be **stable across passes** (React's suspend/replay re-renders arrive as *new* passes — keying by `passSerial`, as value memos do, would re-fetch forever), which is why the spec reached for the token; but a single token under-identifies the world. The fix needs a fork-provided render lineage (e.g., a stable id per (root, lane-set) work-in-progress lineage, redelivered across its restarts) or a defined canonicalization of the mask with documented aliasing behavior. This is a protocol-surface decision → resolve before M0 freezes 6.1.

---

## Lower severity

### F11 (new) — Plane G may not grow while a pass is open, which manufactures a spurious mid-transition exhaustion throw

14.1 (line 2010): G's watermark "also counts open passes (never reallocate G while a pass could hold log ids…)". But growth is copy-into-doubled-buffer with `.set` — **ids are indices and survive doubling unchanged**; nothing a pass holds (pin, mask, memo srcSeqs — all values, not pointers) is invalidated by a G rebuild at `enterDepth === 0`. Meanwhile writes during yields are exactly when long transitions allocate log records, and a held-open pass can starve G until the "throws rather than corrupt" path fires. Drop the open-pass condition; allow G boundary work at any true operation boundary, including yield gaps. (If the intent was "don't rebuild while an engine frame is mid-replay," `enterDepth === 0` already says that.)

### F12 (new) — 13.2's first fixup check, read literally, misfires whenever the rendered world includes still-pending batches

"Committed value moved past what we rendered" (line 1899): a component that just rendered *inside* transition k's pass compares rendered (Wp ∋ k) against committed (∌ k) — unequal without any race. In the single-root case retirement precedes layout effects, masking it; in the multi-root lock-in case the token is still live at root A's commit and the literal comparison fires a spurious urgent `setVersion`. The lock-in mask (6.2) makes that re-render read the same values — so no tear, just a wasted pre-paint render — but the spec should state the world-aware comparison: re-resolve the node **in the watcher's remembered rendered world, now** and compare against the remembered value; use the committed comparison only as the retired-token fallback.

### F13 (wording) — 10.6's last line contradicts its own rule

"For unmarked nodes … the watcher broadcasts unconditionally" (line 1611) — the broadcast queue is filled by `propagate` at *possibly-stale* time, before any cutoff is known, so an unconditional setState would re-render on equal-value writes (the storm the section exists to prevent, since `setVersion` always changes state). The operative rule is the paragraph above it: evaluate (for unmarked nodes: the plain kernel read, which pull-verifies) and compare against `lastBroadcast`. Rewrite "unconditionally" as "without overlay evaluation — kernel value, then the same lastBroadcast compare."

### F14 (concur with codex's closing note) — `update(fn)` / reducer purity needs a contract line

Replays run per world and at absorption time; an updater/reducer that reads other signals would observe *whatever context is live at replay time*. The contract must be: pure function of its arguments and immutable captures; signal reads inside updaters/reducers are unsupported (debug builds could assert by tripping on tracked reads during replay).

---

## Holistic integration: where every fix lands (the packed-layout audit)

The design's constraint is real: plane records have no spare atom fields (+6/+7 are `LOG_HEAD/LOG_TAIL`), and every hot function has a bytecode budget. The fixes were chosen to respect that. Summary:

| fix | layer | new data | hot-path delta | gate that prices it |
| --- | --- | --- | --- | --- |
| F1 yield/resume edges | fork + bridge | none (2 listener callbacks, 1 existing scalar) | zero per read/write; 2 calls per yield | G-4 (mounted-quiet), 17.6/17.7 |
| F2 slot registry + drain re-validation | overlay | `slotNodes: number[][]` side table (32 slots); registration dedup via existing memo lists | zero outside drains; per-drain: certificate checks over registered nodes | G-7 (add registered-node dimension) |
| F3 full certificates + frame flattening + settlement epoch | overlay (memo objects) | longer `srcAtoms/srcSeqs`; a flat collector with frame bases (scratch discipline) | validity loop covers all deps, not just logged; still integer loads | G-8 |
| F4a mark-on-tape-creation | overlay → kernel walk reuse | none (reuses `notifyWalk`, ticket, `OVERLAY_STAMP`) | one cone walk per (atom, era) on first logged write | G-6 (split first-write vs steady) |
| F4b post-eval stamp re-check | overlay read path | none | 1 Int32 load + branch, only after a real recomputation in world-sensitive contexts | G-5/G-8 (noise) |
| F5 equality drop only when `LOG_HEAD === 0` | policy | none | logged atoms lose the early-out (append instead); unlogged atoms unchanged | G-6 |
| F6 drain grouped by token under `runInBatch` | bindings/policy | token field already in hand per queue entry | one `runInBatch` per distinct token per drain | G-7 |
| F7 monotonic LOGGED activation | policy | none | none (removes an oscillation; helps E1) | G-4 |
| F8 epoch bump at quiescence | overlay | none | one store per quiescence | — |
| F9 per-root committed view | bindings | small per-container table | effect-flush filter | — |
| F10 render-lineage key | fork | one stable integer per WIP lineage | map lookup at suspend sites only | — |
| F11 allow G growth in yield gaps | kernel alloc | none | none (removes a throw) | growth-stress suite |

Notably absent, on purpose: per-node world metadata in plane M (the rejected versioned-core's tax), overlay edges inside the canonical intrusive lists (would poison `propagate`/`checkDirty` monomorphism and exact pull counts), and any change to the flags word. If the F2 registry ever shows up in profiles, the escalation path is codex's suggestion — a third quiescence-reset overlay plane for (source, world) edges — but the registry should be proven insufficient first; it is bounded by *touched nodes per live world*, which transitions keep small.

Process note: the spec's own verification plan would catch much of this late (T1 catches F2/F3 at M3; 17.6 catches F1/F6 at M5), and M0/M1 would already have frozen the fork protocol and gate definitions by then. F1, F6, and F10 are protocol-surface changes — fix them in section 6 before M0 exits; F2/F3 change M3's memo record and drain loop — fix 10.5/10.6/9.8 before the oracle is built, so the oracle models the *corrected* semantics (the naive model in 17.2 as written would faithfully reproduce F2's omission: it, too, "re-derives watcher decisions" — make sure the oracle's watcher set is derived from *world values*, not from any walk).

## Verified sound (attacked, held)

- **Visibility rule 10.2** including clause-1 retire-time keying across paused/resumed passes; the base-record unconditional apply (a pass pinned before tape creation reads the correct snapshot because in LOGGED mode nothing moves an unlogged atom's kernel value without creating the tape first).
- **Seq-order rebase** (10.7) and absorption's fold-including-other-batches'-applied-entries maintaining the W0 invariant; retire-order vs seq-order interleavings.
- **Sweep/retention**: leading-run-only folding, `RETIRED_SEQ ≤ every open pin` deadness, mid-pass absorption safety via pin retention.
- **Slot recycling**: `batchEntryCount` counts unswept (not unretired) entries, so a slot id inside any live tape record always denotes its original token.
- **Coalescing legality** (no-open-pass guard + tail-seq rewrite invalidating memos + writer's-world/committed invariance).
- **Pass-world memo validity** ("key + epoch suffice") given pins — with F3/F8 in place.
- **`readAtom`'s `allVisibleAndApplied` shortcut** (visible-set = W0-set implies kernel answer) in all four contexts.
- **Walk-ticket/era-floor mark clearing** and the walkCounter safety valve; 31-bit id/seq headroom claims.
- **Multi-root include-mask lock-in** (6.2) preventing self-tear against a root's own committed DOM — it also rescues F12 from being a tear.

*No repository files other than this review were changed.*
