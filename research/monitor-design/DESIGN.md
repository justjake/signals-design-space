# cosignal, the monitor's cut

One-off design written outside the loop by the loop's monitor, after watching
five rounds, ten adversarial reviews, five measured spikes, and the scope
audit. Goal: **the same correctness with less machine** — every lesson
absorbed as structure where possible, as a declared scope boundary where
structure would be gold-plating, and as a conjunct only where nothing better
exists. Divergences from the loop's acceptance battery are explicit and
argued, not silent.

Status: unreviewed one-shot. It has NOT been through the loop's adversarial
process; the battery walk below is compact, not exhaustive. Treat it as a
candidate, not a champion.

---

## 0. The whole story on one page

A signal write in a React app leaves a **receipt** (always — this is
non-negotiable, because a `flushSync` later in the same event can legally
render a world that excludes an already-applied write, and only receipts can
reconstruct excluded worlds). Receipts carry a global sequence number and
the React batch (an integer token from our fork) that owns them.

There are exactly two dependency engines, both instances of the proven
arena kernel (packed Int32Array plane, values in-plane — measured: moving
values off the plane costs 5–12%, while the kernel's host boundary costs
nothing):

- **K0** tracks the committed-plus-urgent world (BASE). It is the donor
  kernel, untouched. Non-React users get a build of the library that is
  *literally only this* — the React machinery is compiled out entirely
  (measured: even dormant hooks cost 2.5–3.5%, so there are two builds).
- **K1** tracks the pending world (HEAD = BASE + all live deferred writes).
  It is lazily populated during a transition and bulk-reset afterward.
  Crucially, evaluations *in* the head world record their dependencies *in
  K1* — so the pending world has a real topology, and a write to an atom
  that only the pending world reads still reaches every affected component.
  This is the structural answer to the divergent-dependency family; no
  compensating registries or certificates exist because none are needed.

A render pass gets a **pin** (the sequence counter at pass start) and an
**include mask** (which batches it renders, from the fork). A receipt is
visible to a pass iff it retired before the pin, or its batch is included
and it predates the pin — which is, clause for clause, React's own
hook-queue lane filter. Reads during a pass replay receipts under that rule,
memoized per pass; the memo dies with the pass. Passes span yields, and the
fork tells us about yields, so an event handler running in a yield gap reads
the newest world, not the pass's.

Cache validity is one predicate with a **closed, four-row table of change
sources**: a write bumps its batch's clock; a retirement fold stamps each
touched atom; a per-root lock-in stamps once per (root, token); a suspense
settlement bumps its own capsule. Nothing else can change a world-visible
value — because evaluator functions are immutable (changing a hook's
closure creates a *new node*, swapped at that hook's commit, exactly like
`useMemo`), and because untracked reads resolve in the evaluation's own
world. Both of those are design choices made precisely so this table can be
closed with four rows.

Delivery is per-write, synchronous, in the writer's call stack (so React
assigns the writer's lane), value-blind, deduplicated per (watcher, batch)
with a re-arm rule tied to pass starts. Retirement folds the batch's
receipts into K0 in write order — React's rebase arithmetic — and notifies
committed-world observers through K0's own propagation plus a durable
touched-list flush for value-no-op folds.

Async actions follow **React's documented semantics, not more**: writes
after `await` are ambient unless the user re-wraps (`ActionScope.run` is
sugar for exactly the inner `startTransition` React's docs prescribe).
Because of that single scope decision, a batch's write set is frozen when
its scheduling window closes — which is what makes per-root lock-in plain
token membership, deletes the watermark/lock-view machinery, and removes
the loop's only build-tool prerequisite.

---

## 1. Scope charter (what this design refuses to do, and why)

Each cut names the behavior users lose. In every case it is behavior React
users already live without.

| cut | rule | what users lose |
| --- | --- | --- |
| **Post-await auto-attribution** | Writes after `await` land in their own ambient batch (exactly like a bare `setState` after `await`). `ActionScope.run(fn)` ≡ an inner `startTransition(fn)` — a NEW token, entangled by React's own action machinery. No bundler transform, no scheduler shims, no host self-test, no build prerequisite. | Nothing React provides. React's docs literally instruct the inner re-wrap. |
| **Cross-root simultaneity** | Multi-root scope is *degraded*: each root is self-consistent (never contradicts its own DOM — per-root lock-in + per-root committed views), but a batch spanning roots may show skew between roots for a frame. | Nothing — React itself commits roots at different times. |
| **Optimistic truncation / rollback API** | Not exposed. React batches never truncate; every batch retires by folding. | A speculative-rollback API no requirement asked for. |
| **`ctx.previous`** | Not exposed in v1. (The kernel's internal previous-value equality cutoff is unaffected.) | An incremental-computed nicety; re-addable later with a defined world rule. |
| **Mutable evaluators** | A computed's function is immutable for the node's lifetime. `useComputed(fn, deps)` creates a NEW node when `deps` change, swapped at the hook's commit (useMemo semantics). `ReducerAtom` reducers are fixed at construction; `useReducerAtom` dev-warns on reducer identity change and keeps using the original. | Hot-swapping a reducer/closure over live pending state — behavior React's own `useReducer` handles so subtly that its replay semantics are a known footgun. |
| **`ctx.use` lazy-factory form** | Eager form only; contract is identity stability per world. | A convenience; v1.1. |
| **Write coalescing** | None. Retirement compaction bounds tape growth. | Nothing observable. |
| **>31 concurrent batches** | An input storm that exhausts batch slots force-retires the oldest fully-retired slot and pokes any pass pinned before it to restart (a corrective update in that pass's own lanes — reusing the delivery mechanism), with a dev warning. No spillover bookkeeping. | Graceful handling of a pathology; behavior degrades to an extra render, loudly. |
| **RSC / Flight** | Out of scope (inherited from the seeds). | — |

Two battery cases are therefore answered by *declared scope* rather than
machinery: C12's async clause applies to a batch's own in-scope writes only
(post-await writes are ambient by design), and C17 is deleted along with
the truncation surface. C11 is walked at the declared degraded scope. All
three resolutions use the battery's own preamble rule (restriction is
legitimate where the pattern is avoidable user code or absent from React
itself), with detection where applicable.

---

## 2. Builds and the kernel

- **DIRECT build**: the donor arena kernel (`libs/arena`), verbatim. Zero
  React or concurrency instructions — not dormant, *absent* (SPK-H: dormant
  hook sites alone cost 2.5–3.5% on deep chains; SPK-Q: even the read-routing
  branch costs 2.4–3.8%). This is the benchmark and non-React artifact, and
  it preserves the donor's measured wins (deep 0.90×, broad 0.84–0.88×,
  diamond 0.89× vs alien-signals) by construction.
- **REACT build**: the same kernel template stamped with (a) the read-routing
  check and (b) the recompute hook sites, armed. Selected by a closure
  rebuild when `cosignal/react` registers its bridge — **monotonic**: once
  React mode, always React mode (scar S6: keying activation to watcher
  count leaks the first transition's writes).
- Values stay **in-plane** (SP1b: the packed-column→object-table storage
  change carries the entire measured tax; the protocol boundary is free).
  K1 uses the same discipline on its own plane. The tape (receipts) is
  policy-side objects in v1 — it runs only during React-mode transitions,
  off the canonical hot path; packing it (the plane-W sketch) is a gated
  optimization if held-transition read benchmarks demand it, not a default.

---

## 3. Worlds

| world | definition | served by |
| --- | --- | --- |
| BASE | committed state + applied urgent writes, per React's own update-queue behavior | K0 (kernel pull; never a stale cache — see §6 rule 1) |
| HEAD | BASE + every live deferred write, newest-wins | K1 pull over head values (in-plane on K1's plane) |
| PASS(pin, mask, lineage) | receipts visible under the visibility rule | tape replay + per-pass memos (die with the pass) |
| NEWEST | HEAD while ≥1 deferred batch is live ("forked"), else BASE | routing check (REACT build only) |
| committed-for-root R | retired ∪ tokens locked into R | tape replay filtered per root; used by `useSignalEffect` and the fixup fallback |

**Visibility rule** (frozen; it is React's): receipt `e` is visible to
PASS(pin, mask) iff `(e.retired ∧ e.retiredSeq ≤ pin) ∨ (e.token ∈ mask ∧
e.seq ≤ pin)`. Replay is always in seq order over the pre-batch base —
apply-and-discard folds compute 3 where React commits 4 (candidate B's
kill); this design never discards an urgent op because *every* op is a
receipt.

**Read contexts**: render (pass world), event handlers/timers (NEWEST —
including during yield gaps, which the fork signals), `useSignalEffect`
(committed-for-root), kernel-internal (the evaluating world). **Untracked
reads resolve in the evaluation's world** — untracked means "no edge,"
never "different world." This one rule is what keeps K0 caches free of
pending state (dissolves the taint machinery; see §7).

---

## 4. K1: the pending world has a real topology

- Lazily populated per episode: an atom/computed is shadowed into K1 on its
  first head-world touch (write or read); shadow ids are epoch-guarded
  (counter-reset lesson I8).
- Head-world evaluations run with K1 as the tracking kernel: their reads
  record real K1 edges. When a transition flips a flag and a computed starts
  reading atom `a` that the canonical world never reads, the edge `a → c`
  exists in K1 *because the evaluation created it*. A later write to `a`
  propagates through K1 and reaches c's watcher. No registries, no
  certificates, no canonical-walk compensation (scars S2/S3/S5 vacuous by
  construction).
- **First-divergence induction** (the load-bearing construction, kept):
  a node's head evaluation and canonical evaluation read identical atom
  prefixes up to the first atom whose head value differs from its base
  value; that atom is therefore also a canonical dependency, so K0
  propagation catches the *first* divergence and K1's recorded edges catch
  every subsequent one. Requires evaluation purity — which fold-callback
  purity (writes/reads inside `update(fn)`/reducers throw, all builds)
  also guarantees.
- K1 delivery walks carry a per-walk generation stamp (a union of per-world
  acyclic graphs can cycle; value-blind walks need visited state — I32,
  kept as a one-counter detail, priced in the walk gate).
- Unfork (last deferred batch retires, no pinned pass): K1 plane bump-reset,
  epoch++. **No refresh/exemption machinery** — see §7 dissolution 2.

---

## 5. Writes, delivery, retirement

**Write path (REACT build):**

1. Classify via the fork: deferred? current token? (Two calls; the fork's
   own cost class.)
2. Append the receipt (op, payload, token, seq). Empty-tape equality drop
   is legal for every op kind — with immutable evaluators all ops are
   world-invariant, and a dropped op would have held the lowest seq in
   every possible fold (I7). Non-empty tape: always append (scar S8).
3. Urgent: also apply through K0 (BASE moves; this is React's own eager
   behavior for non-transition updates). Deferred: apply through K1 head
   values + K1 propagate. K0 untouched by deferred writes, ever.
4. Deliver, synchronously, in this stack (lane inheritance): walk the
   writing kernel's edges from the atom; for each watcher, per-(watcher,
   slot) dedup — deliver iff `lastDeliverySeq[w,s] ≤ lastStartedPassPin[root(w)]`
   (i.e., every prior delivery has been consumed by a pass that actually
   started; a delivery no started pass has covered is still pending with
   React and needs no duplicate). Value-blind, always (D13: value cutoffs
   cannot see finished-but-uncommitted React work; suppression state
   strands re-deliveries). This one rule covers both the two-batch
   re-notify case and the same-slot post-pin case (C4, I44).

**Retirement** (`onBatchRetired(token, committed)` — exactly once, after
per-root lock-ins):

1. Stamp receipts retired (retiredSeq from the same global seq line —
   scar S12: retirement stamps and pins must share one monotone line).
2. Fold per touched atom: replay visible history in seq order over the
   pre-batch base; write the result through K0 (propagates staleness,
   reaches committed watchers via K0's own edges). `committed=false` folds
   identically — write persistence never depends on subscription (scar S4).
3. Mint a visStamp per touched atom (change-source row 2) — this is what
   lets validity fingerprints see an *older* receipt becoming visible
   beneath a newer one (I21's non-injectivity lesson).
4. Flush committed-world observers from the batch's touched list (durable
   enumeration — consumable write-time queues get eaten by earlier flushes,
   and urgent-applied folds are value-no-ops that propagate nothing; I14).
5. Sweep receipts not needed by any pinned pass (`retiredSeq ≤ every open
   pin` — the retention rule that keeps a yielded pass consistent when an
   unrelated batch retires mid-pass).

**Per-root lock-in**: when root R commits token T while T is pending
elsewhere, R's later passes keep including T (else R contradicts its own
DOM), and committed-for-root(R) gains T. One visStamp per (root, token),
minted once — sound because **T's write set is frozen at its close edge**
(the ActionScope decision: no post-await writes ever join T; correctives
via `runInBatch` schedule React updates, never signal receipts). No
watermarks, no immutable lock views (see §7 dissolution 3).

**Parking**: a store-only async action parks its token on the scope's
promise (close edge re-decides at settle) — the action's own in-scope
writes commit at settle, never before. Post-await writes are separate
ambient batches by scope charter.

---

## 6. Validity: one predicate, four change sources

A cached world-value (pass memo, HEAD computed cache, suspense capsule) is
valid iff its recorded fingerprints match. Fingerprints are:

- per-batch **write clocks** (`slotClock[s]`, bumped on every write in s) —
  a cached value for a world including s revalidates against s's clock.
  Coarse, sound, no per-read certificates (D9; certificates died twice).
- per-atom **visStamps** for visibility flips (retirement folds; per-root
  lock-ins) — relevance-filtered: a capsule/memo revalidates only against
  the stamps of atoms it actually touched (scar S20: global retirement
  clocks starve transitions under unrelated traffic).
- the **capsule's own settlement slot** (a suspense capsule's correct
  outcome changes when its thenable settles, with no signal write — I16's
  third hole, given its own table row instead of a patch).

The closed table (audited as a table, per I16):

| change source | fingerprint moved | minted at |
| --- | --- | --- |
| write in batch s | slotClock[s] | write path step 2 |
| retirement fold | visStamp[atom] per touched atom | retirement step 3 |
| per-root lock-in | visStamp[atom] per entry atom, once per (root, token) | lock-in |
| thenable settlement | the capsule's slot | settle handler |

There is no evaluator row (evaluators are immutable) and no untracked-read
row (untracked reads resolve in-world). That is why the table closes.

Two serving rules make the predicate sufficient:

1. **K0 is never served stale to anyone.** Every BASE read is a kernel pull
   (normal lazy verification); world-sensitive contexts never bypass the
   pull to grab a cached K0 value via reachability flags. There is no
   "unmarked ⇒ serve anywhere" fast path (scar S9's entire family). The
   REACT build's routing check decides *which* engine/tape answers; it
   never substitutes a cache for a pull.
2. Pass memos die with their pass; pins make them valid for the pass's
   whole life without any seq checks (appends carry seqs above the pin;
   retirements stamp above the pin; the pass world cannot drift).

---

## 7. The dissolution ledger

What this design makes vacuous by construction, and by which decision —
the section the loop never had.

1. **Evaluator-identity machinery** (staged evaluators, promotion edges,
   hidden-Offscreen/error-boundary publication, lineage-stable evaluator
   stamps, reducer re-folds: I22, I31, I38b/c, I40, I41, scars S23/S24/S28)
   — dissolved by *immutable evaluators + node recreation at hook commit*.
   A "fourth divergence source with no receipt" cannot exist if evaluators
   cannot change. Fresh nodes created by a pass live on a pass-owned
   allocation list and are freed wholesale on discard (which also answers
   the arena-leak scar S15 structurally).
2. **Quiescence refresh + full-cone exemption carry** (I27, I42, S30, the
   livelock rank proof) — dissolved by serving rule 1 plus the
   first-divergence induction: retirement folds propagate every changed
   atom through K0; a watched node's K0 edges from its own last canonical
   evaluation always contain the first divergence point; and since no path
   serves a K0 cache without a pull, a stale-but-marked node is recomputed
   on its next canonical read. Nothing needs refreshing *at* quiescence
   because nothing downstream trusts K0 blindly *after* it.
3. **Watermarked lock-in and immutable lock views** (I25, I34's lock-view
   half, scar S19a) — dissolved by the frozen-write-set lemma: cutting
   post-await auto-attribution means a token's receipts are complete at
   its close edge, so "locked-in" is a stable set and token membership
   needs no high-water mark. (I34's stamp-every-flip half survives as the
   visStamp table rows — that lesson was real.)
4. **Untracked-read taint** (I33, the taint set/clear races) — dissolved by
   resolving untracked reads in the evaluation's world. A K0 evaluation
   cannot embed pending state because it never reads pending state.
5. **The carrier subsystem** (I26's carrier half, I30, I36, I37's rung
   ladder, S21's repair, S22's alternative, SP-F8's transform, shims,
   self-test, support matrix) — dissolved by scope: React parity plus
   `ActionScope` ≡ inner `startTransition`. I37's ambient fallback becomes
   the *rule*, not the fallback.
6. **Certificates / registries / drain re-validation** (S3, S5, the
   compensated-overlay stack) — dissolved by K1's real topology, as in the
   champion; restated here because it's the reason two kernels earn their
   keep.

What survives as honest conjuncts, because nothing better exists: the
dedup re-arm rule (I44), the K1 walk generation stamp (I32), visStamps
(I21), touched-list flushes (I14), the retention sweep rule (I15), epoch
guards on every reset counter (I8), the saturation poke, and always-log
itself (I1). That is the residual weight, and each item traces to a walked
schedule.

---

## 8. Fork protocol (six facts, observation + one override)

1. Write classification: `isCurrentWriteDeferred()`, `getCurrentWriteBatch()`
   (integer token, minted lazily, never reused while live; ≤31 live —
   slot interning with unswept-gated recycling).
2. Pass lifecycle: `onRenderPassStart(root, includedTokens, lineageId)` /
   `onRenderPassYield` / `onRenderPassResume` / `onRenderPassEnd`. Yields
   are first-class (event handlers run in the gaps; wall-clock pass scoping
   was scar S7). `lineageId` is stable across a batch-set's restarts and
   retries on one root, dead at commit/abandon — the suspense capsule key
   (D11; masks drift, pass serials re-fetch forever).
3. Retirement: `onBatchRetired(token, committed)` exactly once, after
   per-root `onBatchLockedIn(root, token)` events; async-action parking on
   the close edge.
4. `runInBatch(token, fn)`: schedule React updates into an existing batch's
   lanes (late-subscribe correctives); returns false if retired → caller
   falls back to the urgent path.
5. DOM mutation window (unrelated nicety, kept).
6. Loud version-skew failure on stock React.

No async-context hook (cut), no per-root committed queries beyond lock-in
events (the engine derives committed-for-root from lock-in + retirement).
Smaller than every loop candidate's fork. Every fact edge-triggered from
reconciler bookkeeping sites; the fork carries its own reconciler test
suite; rebase drill answer: the library depends only on these six facts.

---

## 9. Battery walk (compact)

- **C1 (divergent deps, T1–T7):** k writes `flag` → K1 propagate reaches c
  (canonical edge), watcher delivered in k's lane; k-world eval of c reads
  `a` in HEAD → K1 edge `a→c` recorded; k writes `a` → K1 propagate reaches
  c and watcher (real edge), memo invalid via slotClock[k]. Committed reads
  untouched (K0 never sees deferred writes). T4/T5 urgent writes: applied
  to K0 *and* mirrored into K1 head values (HEAD ⊇ BASE), propagating in
  both. T6 slot reuse: unswept gate + epoch guards. T7 multi-batch masks:
  pass replay is mask-driven; capsule keys are lineage-based.
- **C2 (flushSync excludes default):** the default-batch write left a
  receipt (always-log) and applied to K0. The flushSync pass's mask excludes
  D → replay from the pre-write base → `a=0`; computed `c` reads in the pass
  world via replay (no K0 cache is served without a pull, and pass reads
  don't pull K0 values as answers for excluded worlds — routing rule 1).
  Both `a` and `c` show the pre-D world.
- **C3 (rebase 4-not-3):** receipts `+1@T(deferred)`, `×2@U(urgent,applied)`.
  Urgent pass: base ⊕ ×2 = 2. T's pass: replay in seq order (1+1)×2 = 4.
  T's fold: 4 → K0. Never discards the urgent op — it's a receipt.
- **C4/C5 (re-notify):** delivery is per-write; dedup key is (watcher,
  slot); the re-arm rule delivers again once a pass with pin < seq has
  started. Second batch = different slot = independent dedup ⇒ delivered in
  its own lane. Same-slot second write after a started pass ⇒ delivered
  (rule ≤ lastStartedPassPin). Value-blind, so a cutoff-suppressed first
  write cannot strand the second (no value state exists to strand).
- **C6 (lane attribution):** delivery is synchronous per write in the
  writer's stack — a write inside `startTransition` delivers inside it.
  Engine `batch()` defers only core-effect flushing, never watcher
  delivery; there is no implicit grouping anywhere (D10).
- **C7 (yields):** fork yield/resume edges flip the read context scalar;
  handler reads resolve NEWEST, handler writes classify via the fork and
  never throw; the resumed pass keeps its pin, and retention (retirement
  sweep rule) preserves any receipts its pin needs.
- **C8 (equality drops):** drop only on empty tape (sound for all op kinds
  under immutable evaluators — the dropped op would head every possible
  fold); otherwise append. Equality lives in fold/delivery... delivery is
  value-blind, so equality lives in fold and in K0/K1's own recompute
  cutoffs. Stepwise per-view application with reference-keeping (I29).
- **C9 (mounts, incl. fresh nodes):** render reads resolve the pass world;
  a fresh `useComputed` node evaluates against the pass world from birth
  (fresh-node path — it has no K0 cache to mis-serve), allocated on the
  pass's allocation list; adopted at the hook's commit (K0 pull at NEWEST +
  K1 shadow if forked) or freed wholesale on discard. Corrective skipping
  at mount: skip token t iff slot(t) ⊆ rendered mask∪lock and
  slotClock[t] ≤ rendered pin (inclusion+clock, never equality — I43/S10).
- **C10 (late subscribe):** fixup compares the rendered world's value now vs
  then; corrective updates scheduled into each divergent live batch via
  `runInBatch` (reach-based, over-render accepted — I13); `runInBatch`
  returning false ⇒ token retired ⇒ compare against committed-for-root and
  issue a pre-paint urgent correction (value-compare fallback, never
  live-token enumeration alone — I18).
- **C11 (multi-root, declared degraded scope):** per-root lock-in keeps a
  root's later passes including tokens its DOM already shows; effects read
  committed-for-root; cross-root skew is documented and permitted; tokens
  retire once after the last root. Frozen write sets make lock-in
  membership stable.
- **C12 (persistence, declared scope on the async clause):** store-only
  transition writes fold at retirement regardless of subscription or the
  committed flag. A store-only *async* action parks and folds at settle.
  Post-await writes are ambient batches (scope charter §1) — they commit
  on their own schedule, exactly as an unwrapped post-await `setState`
  does in React.
- **C13 (lifecycle):** one global seq line for writes, pins, retiredSeqs;
  every resettable counter (K1 epoch, slot recycling) pairs with a
  generation guard; token serials never reuse live values; saturation has
  a named behavior (force-retire + pass poke + warn) and a forced test.
  Renumber-and-hard-throw at the far seq horizon.
- **C14 (StrictMode):** render reads are pure (pass memos; fresh nodes on
  discard-lists); double-mounts net one subscription via microtask flap
  damping; per-world thenable identity is lineage-keyed, stable across
  replays.
- **C15 (suspense mid-transition):** capsule key = (lineageId, hook slot);
  identity stable across retries (lineage survives restarts); content
  validity via touched-atom fingerprints from the §6 table; settlement is
  its own change-source row; canonical world never observes the suspension
  (head/pass evaluation only). Equal-value refetch on relevant-atom churn
  is accepted in v1 (noted optimization: stepwise value revalidation).
- **C16 (effects see committed only):** `useSignalEffect` reads
  committed-for-root; applied-but-unretired urgent receipts are excluded by
  the replay filter; retirement folds + touched-list flushes re-run
  affected effects after the owning root's commit.
- **C17:** deleted with the truncation surface (§1).

---

## 10. Costs, mapped to measurements

| claim | basis |
| --- | --- |
| DIRECT build = donor numbers exactly | it *is* the donor build (twin-build per SPK-H/Q) |
| REACT-quiet read tax | the SPK-Q branch, only in the REACT build; gate target renegotiated to ≤3% per O19, pending an idle-machine run |
| logged urgent write | receipt append + K0 write; gate ≤2× DIRECT write (tape is objects in v1; pack only if the gate fails) |
| deferred write | receipt + K1 shadow-on-first-touch + K1 propagate + per-write delivery with dedup; gate = the SPK-N1 grid |
| held-open transition reads | K1 kernel caches (no memo machinery on the HEAD path at all); pass worlds pay replay+memo only when masks differ from HEAD/BASE |
| retirement | fold linear in touched atoms + one K0 propagation per changed atom; SPK-R comparators |
| memory | K1 plane (reused, warm) + receipts (swept; bounded by retention) + pass memos (die with pass); zero residue at quiescence |

Testing inherits the loop's process wholesale: naive oracle before the
machinery, frozen-kernel contract suite, bytecode budget CI, the
react-concurrent-store harness, forced-counter tests, and the battery as
pinned scenarios — plus differential tests for the two declared-scope
divergences (post-await ambient behavior against real React; degraded
multi-root against per-root snapshots).

## 11. What I'd attack first, if I were the reviewer

Honesty section. (1) The delivery re-arm rule (§5 step 4) is the newest
untested math here — the champion needed three tries at this seam.
(2) "Untracked resolves in-world" changes donor `untracked()` semantics in
head evaluations; the conformance suite runs in DIRECT where it is
unobservable, but a React-mode test family is needed. (3) Fresh-node
adoption at hook commit under error boundaries and Offscreen — I claim
node-recreation dodges the evaluator publication swamp; a reviewer should
try to drag it back in through the adoption edge. (4) The saturation poke
relies on `runInBatch` for a pass the engine wants restarted — verify the
fork can express "poke this root's pending lanes." (5) The frozen-write-set
lemma assumes no engine path appends receipts under a token after its close
edge — audit every `runInBatch` call site to confirm they schedule React
updates only.
