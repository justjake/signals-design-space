# PLAIN — a one-off, simplicity-first co-design (monitor's pen)

> **Not a loop artifact.** This is a one-off design written by the monitor at
> the human's direction, outside the round structure. Loop agents must not
> read it. It deliberately renegotiates seed requirements (§2) under explicit
> human authority: *simplicity now outranks performance and beyond-parity
> capabilities.* It inherits the loop's evidence: all 39 scars are audited in
> §8; every settled decision (D1–D21) is either honored or explicitly
> reopened with the human's mandate cited.

Design goal restated: **one build**, **six thin mechanisms**, no packed
encodings, no counter-wraparound machinery, no compile-time transform, no
twin builds. Performance is spent deliberately and the receipts are itemized
(§9). The correctness bar — no torn committed frame, `useState`/`useReducer`/
`startTransition` parity — is NOT relaxed.

---

## 1. The one-page story

The core library is the unmodified closed donor kernel (alien-signals v3
class): atoms, computeds, effects, exact-pull semantics, monomorphic hot
paths (D4). Call it **K0**. K0 always holds the *newest* values — every
write applies immediately, exactly as in the pure library.

When the React bindings register (one runtime call — there is only one
build), the library arms **receipts**: every atom write, urgent or deferred,
appends `(seq, batch, value-or-op)` to a side list hanging off the atom
(D1/S1). K0 still applies the write immediately. A React render never reads
K0 blindly; it reads through a **view** — "which batches am I allowed to
see, up to which global sequence number?" — and reconstructs the older value
by folding the receipt list backwards (replaying update-ops in write order,
D3). Newest-world reads (event handlers, core effects) use K0 directly.

There are **no cross-pass caches for world values**. A render pass carries a
scratch memo; each computed is evaluated at most once per pass and the
scratch dies with the pass. Recomputing per pass is the deliberate price
that deletes the champion's second kernel, its touched bitmaps, its
invalidation walks, and its memo-validity ladder.

Watcher delivery is per-write, synchronous, value-blind `setState` in the
writer's context (D5/D10/D13). Reads made during a render link the watcher
to what it actually read, *at evaluation time*: the node itself in K0, plus
direct **taps** on the exact leaves a world evaluation visited (because the
world's branch may differ from K0's topology). While anything is pending,
K0 dependency-edge removals are deferred — demoted to notify-only and swept
at quiescence — so no rendering is ever orphaned by newest-world retracking.
Every armed write also pings the fork so React's native interleaved-update
rebase restarts any in-flight pass the write invalidates.

Hook-owned evaluators (`useComputed` closures, hook reducers) are staged per
pass and promoted at the hook's commit effect (D16/I22); committed versions
form a short per-slot chain on the global sequence line, so an old-pinned
pass resolves the version its pin admits (S23/S32). Suspense thenables live
in per-(hook-slot × lineage) capsules keyed by the fork-minted lineage id
(D11), guarded by exact thenable identity (S39) and value revalidation
(S31).

Batch tokens are plain GC'd objects — never recycled integers — and all
sequence counters are float64 with a 2^53 horizon (§4.3), so the entire
lifecycle stratum (renumbering, saturation, wraparound tables) does not
exist. At quiescence, one sweep prunes receipts, demoted edges, version
chains, and dead taps.

Concurrency semantics are **strict React parity, including React's
documented limitations**: state updates after an `await` inside
`startTransition` are not transitions (§2.1). The supported escape hatch is
the explicit `ActionScope.set/dispatch` surface (D21).

---

## 2. Renegotiation ledger (human-authorized deviations from the seeds)

Each entry: what changes, why, and what evidence says the price is real.

### 2.1 SEMANTIC — C12's async half reverts to strict React parity

**Was (champion, D15/D17):** post-`await` signal writes inside
`startTransition(async …)` belong to the action, carried by a compile-time
continuation carrier that forces twin builds (I30/S22), scheduler shims
(I36), a boot self-test, and an AsyncContext feature-detect ladder.

**Now:** signal writes are classified by their synchronous ambient context,
exactly like `setState`. React's own documented caveat applies verbatim:
*"state updates after an await are not marked as Transitions — wrap them in
startTransition again."* The sync prefix of an async action IS transition-
classified; post-await raw writes land in their own default batch and
commit on their own schedule. Users needing writes-after-await to stay in
the action use the explicit surface:

```ts
const scope = useActionScope() /* or actionScope() */
startTransition(async () => {
  scope.set(a, 1)
  await io()
  scope.set(a, 2)   // still in the action's batch — explicit, no ambient magic
})
```

`scope.set`/`scope.dispatch` only (D21 — no `runSync`, no ambient re-entry).
Token lifetime (parking until the action settles, `isPending`) rides React's
own entangled-action machinery, which S22 proved covers *lifetime* — it was
only continuation *identity* that needed the carrier, and identity is now
explicit.

**What this deletes:** the twin build, the bundler transform, rung ladders,
I36 registration-time scheduler shims, the boot self-test, S25's
invocation-capture hazard class, O22 entirely. **What it costs:** the
beyond-parity convenience D15 bought. Reopening D15/D17 is sanctioned by
the human's simplicity mandate, and by parity itself: the product bar says
`startTransition` parity *is* the product, and parity-with-React includes
this caveat. S21's schedule ("post-await write commits before the action
settles") is no longer a violation — it is the documented, parity-exact
behavior, and the sync-prefix writes still hold C12's guarantee.

### 2.2 PERF — P3's zero-instruction clause dies; P2 is kept and argued

**Was:** pure-core users execute *zero* concurrency instructions (P3),
proven by a CI symbol-diff of a separate no-React build.

**Now:** one build; hook sites are permanent `bridge === null` checks and
the read path keeps its routing branch. The measured price (both spikes
run, both "triggered" under the champion's rules): SPK-H dormant hook tax
2.5–3.5% on cheap-recompute chains (up to +7% kairo deep), ~0% on
read/create; SPK-Q read-routing branch 2.4–3.8% on quiet reads. Combined
always-on tax ≈ **3–6% on adversarial shapes vs the donor kernel**.
Because the donor starts 10–26% *ahead* of alien-signals v3 on tier-0
([ARENA]: deep 0.90×, broad 0.84–0.88×, reads 0.74–0.87×), **P2
("at-or-below alien-signals v3") is kept as a gate and expected to pass**;
the claim PLAIN renounces is the champion's "DIRECT equals donor numbers."
SP1b's license is what makes the rest free: the kernel/policy call
boundary costs 0.99–1.02×, and receipts/taps/chains are side tables — K0
records gain zero fields (SP1's 5–12% storage tax is never paid).
React-mounted-but-quiet: ≤**4%** (was ≤2%; the measured SPKHQ floor is
2.4–3.8%, so the old gate was already dead — O19). The armed/logged read
price is unmeasured and strictly higher than dormant: SPK-P2 (§10) gates
it.

### 2.3 PERF — world reads recompute per pass (S37's price, paid knowingly)

While any receipt is live anywhere, render reads take the world path:
computeds re-derive once per pass (pass scratch), leaf reads scan short
receipt lists. S37 died because its author declared a failed gate rejects
the design; PLAIN inverts the stance: the gate is renegotiated up front
(P1 within **25%** of `useState` during pending-transition windows, within
10% when quiet), and a named refinement ladder exists if measurement
demands it (§9): per-atom receipt presence check (an atom with an empty
receipt list short-circuits to K0 even mid-window) is already in the base
fold; the next rung is a per-node "leaves currently receipt-free" epoch
check — an optimization, adoptable without semantic change.

### 2.4 SCOPE — C17 truncation surface deleted

Sanctioned by the case text itself. React batches never truncate; no
truncation API exists in PLAIN.

### 2.5 SCOPE — tracing (R11) inherits the reference spec unchanged

One slot-check per site, lazily loadable. Nothing in PLAIN forces changes;
out of scope for this document.

**Not renegotiated:** every torn-frame requirement, per-root
self-consistency (R9 — PLAIN declares FULL spanning support, §7 C11),
write persistence (D2), replay-in-write-order parity (D3/C3), value-blind
delivery (D13), reducer/`useReducer` conformance, suspense parity (R6),
exact pull counts in DIRECT mode (P2 semantics).

---

## 3. Cut list vs the round-4 champion

| Champion mechanism | Fate in PLAIN | What pays for it |
|---|---|---|
| K0 + allocation lists | **Kept** (unchanged donor kernel, D4) | — |
| Receipt tape + fold + packed columns | Kept as **plain per-atom lists**, naive backward scan, op replay | fold is O(list) not O(1); lists pruned aggressively (§4.2) |
| Token/slot/lock-views (interned masks, lockViewId minting) | Replaced by **object tokens + per-root committed Sets + watermark** | Set lookups instead of bitmask AND; no interning ⇒ no saturation/renumbering (S13/S29/S38 void) |
| K1 second kernel + touched words + delivery/mark walks + walkGen | **Deleted.** Eval-time taps + deferred edge removal + per-pass recompute | recompute per pass (§2.3); over-delivery (value-blind, safe) |
| World memos + validity ladder (clocks, visStamps, epochs) | **Deleted.** Pass-local scratch only | recompute; no cross-pass reuse |
| Evaluator chains + staging | Kept, **thinner**: per-slot chain (fn, committedAtSeq), pass stage table, restart-with-seed (§4.5) | chain scan per computed eval (usually length 1) |
| Watcher records + w_fx mount fixup + retirement drains | Replaced by **eval-time linking + φ5 rework ping**; no separate fixup pass (§4.4, walk C10) | one fork call per armed write |
| Fork + continuation carrier + shims + twin builds | Fork kept (9 facts, §6); **carrier stratum deleted** (§2.1) | the D15 capability |
| Episode lifecycle (wraparound tables, saturation, renumber, capsuleGen) | **Deleted.** Float64 seqs + object identity + quiescence sweep (§4.3) | none — this is a pure simplification win; 2^53 horizon declared with a dev assert |

Mechanism count: **6** (K0; receipts/views; batches/roots/retirement;
delivery; pass context + evaluator chains; capsules). Each is describable in
one section with no sub-ladders.

---

## 4. Mechanisms

### 4.1 K0 — the donor kernel (unchanged)

alien-signals v3 class: closed, monomorphic, CI bytecode budgets, exact pull
counts, no per-link world state (D4). PLAIN adds **zero fields** to K0
records (SP1b: storage changes carry the tax; side tables don't). The
bridge hook is a single module-level `bridge` reference; every mutation and
tracked-read site does `if (bridge !== null)` — one branch, one build.

DIRECT mode (bridge null) is bit-for-bit the pure library: equality drops at
write, normal retracking, zero receipts. Arming is **monotonic on bridge
registration** (D1/S6): registering the React bindings arms logging before
any React work can schedule; there is no watcher-count keying.
`registerReactBridge()` throws if any evaluation, fold, or delivery walk
frame is open — a mid-evaluation swap would leave half-consistent caches
(champion M1's rule, kept verbatim). The kernel keeps the donor's layout
discipline (one interleaved plane, closure-const buffer binding with
rebuild-on-grow, one packed value column — the measured mandatory floor
per LAYOUT facts); the growth closure-rebuild mechanism exists anyway, but
PLAIN never uses rebuilds for mode arming.

### 4.2 Receipts and views

**Receipt** = `{ seq: number, token: Batch, kind: 'set'|'op', payload }`,
appended to `receiptsByAtom.get(atom)` (a side map, K0 untouched) on every
armed write. `'op'` holds the updater fn / reducer action (C3/D3);
`'set'` holds the value. The atom's **base** (pre-first-receipt value) is
recorded when the list transitions empty→nonempty.

**View** = `{ committed: per-root Set<Batch> snapshot + watermark, mask:
Set<Batch> (the pass's included pending batches), pin: number }`. A receipt
is **visible** to a view iff:

```
visible(r, view) =
  r.seq <= view.pin  AND  (
    r.token ∈ view.mask
    OR (r.token ∈ view.committed AND r.seq <= view.watermarkFor(r.token))
    OR (r.token.retired AND r.token.retiredSeq <= view.pin)      // S12/I15
  )
```

**fold(atom, view):**
1. list empty → return K0 value (the universal fast path — per-atom, so
   quiet atoms stay fast even mid-window).
2. all receipts visible → return K0 value (single pass over the list; the
   common case for urgent renders).
3. else replay: start from base, apply visible receipts in seq order
   (`set` overwrites; `op` applies the updater under the reducer version
   the view's pin admits, §4.5). Custom equality applies **stepwise
   against the view's accumulator, keeping the old reference on equal**,
   exactly as the live write path did (I29 — post-fold equality picks the
   wrong representative for T+U vs U-only views). Updater/reducer fns
   executed during replay run under the fold-purity guard: signal reads
   and writes inside them throw in all builds (I28/D14). Return the
   result. No caching outside the pass scratch.

**Fold identity (I48):** the pass scratch memoizes **atom folds too**, so
`a.state === a.state` within one render. Across passes, replay produces
fresh references for the same logical value; this is React's own rebase
behavior (React re-runs updater queues per render attempt) and is
documented as parity. When all receipts are visible (cases 1–2), the
returned reference is K0's — identity-stable across renders in the quiet
and urgent common cases. A per-(atom, view) cross-pass memo is a named
refinement rung (§9), not a mechanism.

Equality never drops an armed write (C8/S8: with any history, worlds
disagree about the accumulator; the receipt always appends — I7's sound
half, stated without the "empty history" carve-out because DIRECT mode owns
that case). Computed cutoffs (`isEqual`) operate at evaluation, never at
delivery (D13).

**Pruning (no episodes, no wraparound):** a receipt is dead when its token
is retired everywhere, `retiredSeq < minLivePin`, and it is not the last
receipt keeping `base` meaningful — dead prefixes fold into `base`.
Checked opportunistically at append when a list exceeds 8 entries, and
exhaustively at the quiescence sweep (§4.3). Growth under never-quiescent
traffic is bounded by the append-time prune; the residual (a workload that
never retires its oldest batch) is declared and spiked (§10, SPK-P1).

### 4.3 Batches, roots, retirement

**Batch token** = a plain object minted by the fork per classification
context (φ2): transition scope, default event batch, sync. Object identity
⇒ cross-episode collision is impossible by construction; C13's T6 hygiene
case is discharged with no interning, no slot recycling, no generation
tags. All seqs (`globalSeq`, pins, watermarks, `retiredSeq`,
`committedAtSeq`) are float64 doubles; horizon 2^53 writes (dev assert at
2^50: at 10^7 writes/sec that is ~3.5 years of continuous writes; the
assert message tells the user to file a bug and restart the world; C13's
"forced wraparound test" obligation becomes a single dev-assert test).

**Per root:** `{ committed: Set<Batch>, watermark: Map<Batch, seq> }`.
At a root's commit the fork reports the committing pass's pin (φ3); the
root's committed set gains the pass's batches with watermark = that pin
(I25 — every reported watermark equals the committing pass's pin; S19a is
dodged because a post-commit `scope.set` write carries seq > watermark and
stays invisible to that root until a later commit).

**Retirement:** the fork signals token lifecycle (φ4): a token retires when
every root that received its work has committed it and (for async actions)
the action settled — for store-only batches (C12), at scope
end/settlement, with **fold-not-drop** semantics always (D2/S4: writes
persist regardless of subscription). `retiredSeq` stamps at retirement;
pin-gated inclusion (§4.2) keeps resumed passes coherent (S12).

**Quiescence sweep:** when `liveReceipts == 0 ∧ livePasses == 0 ∧
livePendingBatches == 0` at the end of a delivery or commit: prune demoted
edges, empty version-chain history, dead taps, capsule pools. The sweep
walks dirty-lists only (atoms-with-receipts, demoted-links,
chains-with-history) — never the whole graph.

### 4.4 Delivery — links, taps, deferred removals, and the rework ping

Four rules, all value-blind (D13), all per-write-synchronous in the
writer's context (D5/D10 — lane inheritance; engine `batch()` defers
core-effect flush only; **no implicit grouping exists**, resolving C6 by
the "handle it" arm).

1. **K0 links.** A tracked read during any evaluation links reader→node in
   K0 at read time, exactly as the pure library does. A watcher hook's read
   links the watcher to the node it read *at evaluation time* — before
   commit, closing the mount-subscription gap (walk C9/C10).

2. **Taps.** When an evaluation runs as a *world* evaluation (fold path),
   the world's branch may not match K0 topology (C1's trap), so the
   evaluation additionally records its **exact leaf read set** and installs
   direct `leaf → watcher` taps, also at evaluation time. Taps are kept per
   (hook, rendering): the in-flight pass's tap set is keyed by lineage id
   and dies with the lineage (commit swaps it in as the committed set;
   abandon drops it); the committed tap set is replaced only when a *newer*
   rendering of that hook commits, and dropped at unmount (S33's retention
   lesson: state that covers a rendering lives as long as the rendering).
   StrictMode double-render installs taps idempotently (set semantics);
   discarded-pass taps linger harmlessly (value-blind over-delivery) until
   lineage death (C14 purity: no *observable* divergence — the only effect
   is a spurious, correct-valued re-render).

2b. **Retro-delivery at installation (I23/I18/I47 in one rule).** A tap or
   watcher link is installed by an evaluation at pin p — but the leaf may
   already hold receipts with `seq > p` whose write-time delivery ran
   before this watcher existed. At installation, scan the leaf's receipt
   tail for `seq > p` and, per distinct token t:
   - t live → `fork.runInBatch(t, () => setState(watcher))` — the
     corrective joins t's **own** lanes, so t's render includes it in one
     commit (C10's requirement; a fresh `startTransition` is not
     equivalent). If t is in the current pass's own mask, this is an
     interleaved update on the rendering lane and React restarts the pass
     pre-commit at a fresh pin — the native rebase path.
   - t retired → urgent setState (the seed's own sanctioned fallback:
     "urgent pre-paint correction"), covering the edge-discovered-after-
     writer-retired family (I47/S35 variant) with no drain machinery.
   The scan is O(receipt tail past the pin) — receipts newer than a live
   pin are few by construction. Over-delivery is the designed failure
   mode; under-delivery is impossible while the rule holds (the leaf's
   full receipt list was either visible to the fold or retro-delivered).

3. **Deferred edge removal.** While `liveReceipts > 0 ∨ livePasses > 0`,
   K0 retracking never unlinks: a removed dependency edge is demoted to
   *notify-only* (delivery walks traverse it; validity/pulls ignore it).
   Swept at quiescence — at which point committed = newest everywhere, so
   dropped edges can orphan no one (dodges the S2/S3 class where newest
   retracking silently disconnects a committed-world rendering; see walk
   C1-T4).

4. **Write procedure** (armed):
   ```
   write(atom, payload, token=currentClassification()):
     appendReceipt(atom, token, payload)         // §4.2
     applyToK0(atom, payload)                    // newest semantics
     walk K0 out-edges from atom (incl. notify-only), collecting watchers;
       union with taps(atom); setState each in the writer's context
     fork.noteWrite(token, seq)                  // φ5 rework ping
   ```
   `noteWrite` marks the token's lanes updated on every root where the
   token has scheduled work; React's native interleaved-update rebase then
   restarts any in-flight pass whose view the write invalidates — including
   the zero-linked-watcher case where no `setState` fired (walk C10,
   variant "no subscriber yet"). Delivery has **no suppression state of any
   kind**: no dedup bits, no ARMED flags, no frontier stamps — S16, S17,
   S33 are structurally void; the cost is redundant `setState` calls, which
   React coalesces per fiber/lane. The delivery walk unions K0 edges,
   demoted edges, and taps; a union of per-world-acyclic edge sets can
   cycle (I32), so the walk carries a per-walk visited stamp (a float64
   node field, same no-wrap rule as every counter). Note what the write
   path does **not** do: no world evaluation, no cutoff computation, no
   memo maintenance — the known-bad eager-write-eval shape
   (COST-eager-write-eval) has no foothold.

Promotion of an evaluator/reducer version (§4.5) is itself a delivery event:
it walks the node's cone value-blind (S32's second lesson: an equality gate
on the NEWEST value must never guard cross-world notification, S14).

### 4.5 Pass context, evaluator chains, staging

The fork exposes per-callstack render truth (φ1, S7): inside a pass,
`{ root, mask, pin, lineage, stageTable, scratch }`; in the gaps (yields,
handlers), reads see NEWEST and writes classify by ambient sync context
(C7). `scratch` memoizes each computed once per pass attempt; replays and
restarts get fresh scratch (C14).

**Evaluator resolution** for a hook-owned computed/reducer at evaluation:

```
fn = pass.stageTable.get(slot)            // staged this pass?
  ?? chainResolve(slot, pass.pin)         // newest version with committedAtSeq <= pin
```

- **Chains:** per-slot list of `(fn, committedAtSeq)`; almost always length
  1; old versions prunable when `minLivePin > committedAtSeq` of the next
  version (and at the sweep). Constructor `Computed`/reducer fns are
  immutable (D16) and never chain.
- **Staging:** a render that materializes a changed hook evaluator stages it
  in the pass's `stageTable` (I22). Promotion happens at the hook's commit
  effect, ordered **before that commit's folds**, via the φ7 publication
  edge (I41/S28): CAS on the slot, `committedAtSeq = commit seq`; hidden/
  Offscreen and error-abandoned subtrees never publish (φ7's contract).
  Promotion re-folds the NEWEST K0 value of affected reducer atoms under
  the newly committed versions (I38 — the K0 in-place value must equal
  a fold of all receipts under committed-current semantics) and delivers
  value-blind (§4.4).
- **Shared-node staging order (S34):** if a pass evaluates a shared
  hook-owned node *before* the owning component stages a new version, the
  stage records a conflict and the fork restarts the pass **seeded** with
  the stage table (φ5b). The re-attempt reads the staged version uniformly.
  Termination: at a fixed pin, the owner's deps and props are fixed, so the
  staged fn is identical on the re-attempt — the conflict cannot recur
  (A/B/A oscillation requires the pin to move, which is a new pass by
  definition). One restart per newly-staged shared evaluator, bounded by
  React's own update-depth limits (R7).
- `update(fn)`/reducer folds reject signal reads/writes inside the fn in
  all builds (D14). Render-phase writes throw (C14). `ctx.previous`
  follows D16's three-way rule; with no cross-pass world memos the
  per-(node, worldKey) arm reduces to per-(node, pass) scratch.
- **`untracked()` inside a world evaluation folds in-world, edge-free**
  (I33's content): untracked suppresses dependency recording (no link, no
  tap), never visibility — the value still comes from `fold(atom, view)`.
  A world evaluation can therefore never embed newest-only state (the
  taint family is void on both horns: no cross-pass caches to poison, and
  no view-inconsistent reads to poison them with). Later writes to the
  untracked atom don't notify this watcher — that staleness is the
  documented `untracked` contract, identical to DIRECT mode.
- **World evaluations never write K0 caches.** K0 caches are updated only
  by NEWEST evaluations (pulls outside any pass, or the §5 quiet serve,
  which validates in K0 itself). K0 = newest is an invariant, not a
  convention.

### 4.6 Suspense capsules

Per (hook slot × lineage id) — the lineage id is fork-minted per
(root × batch-set), stable across restarts and replays, dead at
commit/abandon (D11/φ6). A capsule stores `{ thenable, readLog:
[(atom, foldedValue)] }`.

- **Reuse rule:** on retry under the same lineage, re-fold each `readLog`
  atom in the pass's view and compare with the stored value via the atom's
  `isEqual` — all equal ⇒ same thenable (identity-stable across retries,
  C14/S24); any differ ⇒ re-run the factory (content-guarded refetch, I35/
  S31 — stamps and visibility handovers that don't change values cannot
  cause refetch, because no stamp appears anywhere in the rule).
- **Settlement** is guarded by **exact thenable identity** (I50/S39): a
  late settlement of a superseded thenable finds itself no longer
  installed and is ignored. No generation counters exist to wrap.
- **Keys carry no clocks** (S20): unrelated retirements move no key
  component; they can only change folded *values*, which is precisely what
  the reuse rule checks.
- The canonical world never observes a suspension: `ctx.use` in a NEWEST
  evaluation (core effect, handler read) follows R2's sentinel-box
  contract, not the React `use` protocol.

---

## 5. Read algorithm (one place, all conjuncts)

```
read(node, ctx):
  if bridge === null: return k0Read(node)                    // pure library
  if ctx is NEWEST (handler, core effect, no pass): return k0Read(node)
      // K0 is newest by construction; reducer K0 values kept
      // committed-current by promotion re-fold (§4.5)
  // world read inside a pass:
  if (s := ctx.scratch.get(node)) !== undefined: return s
  fn := resolveEvaluator(node, ctx)                          // §4.5
  if fn === node.k0EvalVersion
     AND liveReceipts === 0:                                 // coarse gate, §2.3
    v := k0Read(node)                                        // pulls/validates in K0
  else:
    v := evaluate fn, leaf reads via fold(atom, ctx.view)    // §4.2
         recording leaf set; install taps (§4.4)
  ctx.scratch.set(node, v); link watcher→node in K0; return v
```

The single evaluator conjunct (`fn === node.k0EvalVersion`) sits on the
**only** K0-serving surface — there is exactly one fast path in the design,
so I31's "every surface needs the conjunct" discipline has one surface to
discipline (S23's routing horn; the cache horn is void because there are no
cross-pass world caches to embed a version).

`useSignalEffect` bodies read through the root's **committed view**
(`{ committed set, watermark, pin = watermark }`) — C16 by construction;
core `effect()` reads NEWEST (documented contract, stated per C16's
requirement).

### 5.1 Chrome coverage (the requirements not otherwise discussed)

- **R7 loops:** signal-driven React storms are `setState` storms — React's
  own update-depth limits apply (φ9); signal-only cycles use the donor
  kernel's cycle detection, unchanged.
- **R8 writes inside computeds:** tolerated when acyclic in DIRECT/NEWEST
  evaluation (donor semantics + `configure({forbidWritesInComputeds})`);
  any world evaluation rejects writes unconditionally (render worlds are
  read-only by construction — the write path has no view parameter).
- **R10 SSR/hydration:** serialized atom state hydrates as plain K0
  initialization before the bridge registers — no receipts exist yet, so
  hydration is the pure library path.
- **R13 benchmark integrability:** DIRECT mode *is* the donor kernel —
  exact pull counts, checksum contracts, synchronous-effect configuration
  inherited unchanged; 179/179 conformance is a frozen contract suite.
- **Hooks are provider-free** (module-level bridge; the fork is the
  provider). ≤31 concurrent transition lanes is React's own bound; PLAIN's
  object tokens don't encode into lane bits, and multiple tokens may share
  a lane under React entanglement — token sets, not masks, so lane reuse
  needs no library-side saturation protocol.
- **Process (D6/E):** oracle-first sequencing, frozen-kernel contract
  suite, bytecode budgets, pre-registered spikes — inherited wholesale,
  including the react-concurrent-store 14-scenario harness and its known
  bug as a required passing test (R6).

---

## 6. The seam — nine fork facts

| id | fact | needed for |
|---|---|---|
| φ1 | Per-callstack pass truth: `{root, mask, pin, lineage, stageTable}` exposed inside render, absent in yield gaps; yields/resumes visible | C7, S7 |
| φ2 | Batch token minting + write classification (transition scope, default, sync); token = object; async-action lifetime rides entangled actions | C6, C12, §2.1 |
| φ3 | Commit notification with watermark = committing pass's pin | I25, C11, S19 |
| φ4 | Token lifecycle: per-root commit tracking, retirement signal (incl. store-only scope-end, action-settle) | C12, §4.3 |
| φ5 | Lane-scoped scheduling + rework: `runInBatch(token, cb)` inserts cb's update into the live token's lanes (returns RETIRED for a dead token → caller falls back to urgent); `noteWrite(token)` ⇒ interleaved-update rework of in-flight passes (React-native rebase), incl. (a) same-lane writes with zero setStates, (b) same-root commit-during-yield restart, (c) restart-with-seed for stage conflicts | C1, C10, §4.4.2b, S34, S35 |
| φ6 | Lineage id per (root × batch-set), stable across restarts/replays, dead at commit/abandon | D11, C15, S24 |
| φ7 | Hook publication edge: staged evaluator/reducer becomes-current at the hook's commit effect, publication-before-folds, CAS, no publication from hidden/abandoned subtrees | I41, S28, §4.5 |
| φ8 | Replay/StrictMode signals: pass identity for scratch; discarded passes distinguishable | C14 |
| φ9 | React's update-depth limits apply to signal-driven storms (delivery is setState, so this is inheritance, asserted by test) | R7 |

No Fiber/lane/queue objects cross the boundary; all facts are integers,
object tokens, or callbacks. **The carrier stratum (champion F8) is gone**;
φ5 is React-native behavior asserted as a guarantee rather than new fork
machinery. Rebase drill: lane renames touch φ2 only; commit-phase
reshuffles touch φ3/φ7 anchoring; update-queue internals never cross.
Existence-proof risk carried over from the loop (O7/O23): φ3's per-root
watermark and φ7's publication edge need current-generation React tests on
the critical path — PLAIN inherits that risk unchanged and does not add to
it (φ5 is the interleaved-update path React already exercises).

---

## 7. Battery walks

Format per the seed; condensed where the mechanism firing order is already
given above. **Bold** marks the load-bearing step.

### C1 — world-divergent dependency (the killer)

Atoms `flag=false, a=0, b=0`; `c = flag ? a : b`; W subscribed to `c`;
canonical deps {flag, b}.

| step | actor/mechanism | state |
|---|---|---|
| 1 | k: `flag.set(true)` | receipt (s1,k,true); K0 flag=true; walk flag's K0 edges → c → W: setState in k's lane; noteWrite(k) |
| 2 | k's pass P1 (mask {k}, pin p1>s1) renders W; read c | scratch miss; evaluator unstaged, chain len 1 ⇒ fn = k0EvalVersion, but liveReceipts>0 ⇒ **world path**: fold(flag)=true → branch a → fold(a)=0 ⇒ c=0; **taps installed on {flag, a} at eval time**; W↔c linked in K0 |
| 3 | k: `a.set(1)` (entangled later write or `scope.set`) | receipt (s2,k,1); K0 a=1; K0 edges from a: none to c (canonical) — **tap a→W fires**: setState in k's lane; noteWrite(k) ⇒ φ5 reworks P1 (pin p2>s2) |
| 4 | P1′ re-renders W at p2 | fresh scratch; fold(flag)=true, fold(a)=1 ⇒ **c=1 rendered in k's lane before k commits** |
| 5 | committed world (urgent render, mask ∅) | fold(flag): receipt s1 not visible ⇒ false → branch b → c=0 ✓ |

outcome: matches Required — no torn commit; pass-local scratch cannot serve
step-2's 0 to step-4 (scratch died with P1).
residual risk: tap installation timing (eval vs commit) — pinned by a test
that writes between eval and commit; φ5 coverage of the zero-setState case.

Variants: **T2** (k writes `b`): over-delivery via K0 edge b→c (value-blind,
allowed); k-world value unchanged ⇒ same rendered output; no wrong value.
**T3** (k: `flag=false` again): receipts fold back to committed branch;
taps from step 2 over-deliver harmlessly. **T4** (urgent write to `b` after
c retracked to {flag,a} on NEWEST): the b→c edge was **demoted, not
removed** (§4.4.3) ⇒ delivery still walks b→c→W in the urgent lane;
committed render folds to new b ✓ — this is the walk that kills the S2/S3
class. **T5** (urgent write to `a`): visible to k's view (urgent ∈
committed-or-applied, seq≤pin on next attempt); pending worlds include
applied urgent state ✓. **T6**: tokens are objects; no reuse exists.
**T7** (two live batches, one suspends, one commits alone): views are
per-pass sets; capsule keyed by lineage of the multi-batch pass; the
committing batch's root gains only its own token at its watermark ✓.

### C2 — flushSync excludes a pending default batch

a=0→D writes 1: receipt (s1,D,1), K0 a=1, delivery in D's context.
flushSync pass: mask ∅ (SyncLane only), committed set excludes D, pin now.
read a: **fold: receipt invisible (D ∉ mask ∪ committed)** ⇒ base 0 ✓.
read c: liveReceipts>0 ⇒ world path ⇒ fold(a)=0 ⇒ c=10 ✓. Both correct;
this case is why receipts exist for *every* armed write (S1).

### C3 — rebase parity

a=1. T: `update(x=>x+1)` — receipt(s1,T,op+1), K0=2… **K0 must stay
newest**: apply op ⇒ K0 a=2. U: `update(x=>x*2)` — receipt(s2,U,op×2),
K0=4. Urgent render (excludes T, includes U, pin>s2): fold: base 1, replay
visible ops in write order: skip T's +1 (invisible), apply ×2 ⇒ **2** ✓.
U commits (fold no-op vs canonical — K0 already newest). T's render (mask
{T}, pin>s2): replay +1 then ×2 over base 1 ⇒ **4** ✓ (write order, not
inclusion order). T commits ⇒ committed value 4 ✓. `set 5` after pending
`+1`: replay: +1 then set 5 ⇒ 5 ✓. `useReducer` side-by-side: same replay
rule as React's queue — conformance-pinned.

### C4 — two-batch re-notify

T1 writes a: delivery (T1 lane). T2 writes a before any re-render:
**delivery has no dedup/suppression state** — full walk again, setState in
T2's lane ✓. The trap (once-per-staleness marks) cannot exist here:
there are no marks.

### C5 — suppressed first write, effective second

k writes a (c's value unchanged — cutoff at *evaluation*, delivery still
fired value-blind); k writes b=7: fresh walk, setState in k's lane ✓.
Scratch from any earlier pass died with it; the new pass folds b=7 ✓.

### C6 — lane attribution

Per-write synchronous delivery in the writer's context; `batch()` defers
core-effect flush only. `a.set(1)` delivers urgent; `b.set(2)` inside the
transition scope delivers under the transition token (φ2) ✓. No implicit
grouping exists anywhere (stated; D10).

### C7 — writes/reads during a yielded pass

Handler read in the gap: φ1 says no pass on this callstack ⇒ NEWEST = K0 ✓.
Write classifies under the click's batch (φ2), receipts + delivery + 
noteWrite as usual; **the resumed pass keeps pin p** — the new receipt has
seq>p ⇒ invisible ⇒ original pinned world preserved ✓ (if the write is in
the pass's own lane, φ5 reworks it at a fresh pin instead — React's rule,
either way coherent).

### C8 — equality never drops armed writes

T: a.set(1) — receipt. U: a.set(1) — **equal to newest, still appended**
(§4.2). U's render (excludes T): fold ⇒ base 0, U's set 1 ⇒ **1** ✓.
Overlapping same-value transitions: two receipts, two tokens, each view
folds its own ✓.

### C9 — mount mid-transition

(a) existing computed: mount render inside k's pass ⇒ world path ⇒ folds
k's writes on first render ✓ (no double render; K0 link + taps at eval).
(b) **fresh node** (`useComputed` created now): its first evaluation runs
inside the pass ⇒ eager world routing by construction (the read algorithm
has no "new node" special case — evaluation context decides); taps installed
at eval; K0 record allocated but its cache is not written from a world eval
(world results live in scratch only), so no canonical leak ✓. Reclamation
of abandoned fresh records: pass-owned, commit transfers, lineage-death
frees (D19/S15).

### C10 — late subscription joins the pending batch

Mount after k's write, before k's commit — three sub-cases, all closed by
§4.4's rules:

1. **W evaluates after the write** (pass pin p < write seq, or a pass that
   excludes k): W's fold renders its view-consistent value AND
   installation retro-scans the leaf: receipt seq > p, token k live ⇒
   `runInBatch(k, setState(W))` ⇒ the corrective is in **k's own lanes** ⇒
   exactly one commit carries k's updates and W's correction ✓ (a fresh
   startTransition would mint new lanes — never used).
2. **W evaluated before the write** (taps already installed): the write's
   delivery hits the tap ⇒ setState in k's lane ✓; if the write is in the
   rendering pass's own lane, φ5 restarts pre-commit (test-32 class) ✓.
3. **k retires in the race window**: the retro-scan finds a receipt whose
   token is retired ⇒ **urgent pre-paint setState** — exactly the seed's
   sanctioned fallback ✓. Pin-gated retirement (retiredSeq ≤ pin) keeps
   any resumed pass that pinned k out coherent meanwhile (S12).

No separate fixup pass exists to mis-fire (the champion's Blocker-A class
— a fixup fast-out wrongly skipping — has no home: there is no fast-out
because there is no fixup; installation-time retro-delivery is
unconditional).

### C11 — multiple roots (declared: FULL spanning support)

k spans A and B. A commits k: A.committed += k @ watermark. B pending: B's
views exclude k ✓ per-root sets. A's later renders: k ∈ A.committed ✓
never contradicts its DOM. A's passive effects: committed view includes k
✓ (§5). B commits later; k retires once when both roots committed + action
settled (φ4) ✓. Cross-root skew is visible and sanctioned (C11 text).
Root-B in-flight pass during A's evaluator promotion: B renders uniformly
at its pin (old versions — chain resolve), self-consistent; converges on
B's next pass (S32 walk below).

### C12 — store-only transitions persist

`startTransition(() => a.set(5))`, no subscribers: receipt + K0 applied;
no React work ⇒ token retires at scope end (φ4) ⇒ receipts prunable;
committed views include it via retiredSeq ≤ pin ✓. Async action: sync
prefix writes carry the token; retirement waits for settlement (φ4,
entangled-action lifetime) ⇒ not before the action settles ✓. Post-await
raw writes: separate default batch by §2.1 (documented parity semantics).
Persistence never consults subscription (D2) ✓.

### C13 — lifecycle soundness

Counters: `globalSeq` (float64, monotonic, never reset, dev-assert at
2^50); per-slot `committedAtSeq` (same line); `retiredSeq` (same line);
walk epoch for delivery recursion (float64, same rule). **No counter is
ever reused, reset, or interned; batch tokens and lineage ids are objects.**
Cross-episode collision requires seq reuse or object resurrection, neither
of which exists. Forced-wrap tests are replaced by the single horizon
dev-assert test. Structures retaining seqs (receipts, chains, capsules via
lineage) are pruned by liveness rules (§4.2/§4.5/§4.6), each stated with
its guard.

### C14 — StrictMode and replays

Render reads: pure (scratch per attempt φ8; taps idempotent; the only
render-phase graph effect is link/tap installation, whose sole observable
consequence is value-blind delivery — documented, and pinned by a test
that a discarded replay causes no value change and no double effect).
Render-phase writes throw (φ1 truth). Double-mounted effects: subscription
flap is microtask-damped (R1 contract). Thenable identity: capsule keyed
by lineage, stable across replays ✓ (§4.6).

### C15 — suspense across worlds

k causes `c` to suspend: world eval reaches `ctx.use` ⇒ capsule
(slot × lineage) stores thenable + readLog. Mount mid-transition reading
`c`: same lineage ⇒ same capsule ⇒ same thenable via React `use` ✓.
Settles ⇒ retry pass: readLog re-folds equal ⇒ **same thenable identity**
⇒ React resumes ✓. Canonical world: NEWEST eval uses sentinel boxes, never
the `use` protocol ✓. Key = lineage id (per root × batch-set): multi-batch
passes share it; it outlives restarts, dies at commit/abandon (D11) —
passSerial-forever-refetch and token-set churn are both avoided ✓.

### C16 — effects observe committed state only

Walked in §5: `useSignalEffect` reads through the root's committed view;
D's applied-but-uncommitted write is invisible (D ∉ committed) ✓; after
D commits, the pending delivered setState/effect re-run observes it ✓.
Core `effect()`: NEWEST, documented ✓.

### C17 — deleted surface (§2.4) ✓ (API snapshot test pins its absence).

### S32 replay (shared ReducerAtom, evaluator promotion mid-yield)

r0=±1 staged→r1=±10; receipts X:inc, Y:dec. Root-B pass folds X-world = 1
under r0 (chain resolve at pin q), yields. Root A commits r1: φ7 publishes
(CAS, committedAtSeq = sA > q), **promotion re-folds K0 NEWEST under r1
and walks the cone value-blind** (even though NEWEST 0→0). B's watchers
get setState (committing context's lane). B resumes at pin q: sibling
folds X-world under **chainResolve(slot, q) = r0** ⇒ 1 — same version as
the first sibling ⇒ **one frame, one reducer version** ✓ (self-consistent
old world; converges next pass). The round-4 Blocker-B surface (fast path
serving the new version to an old pin) is closed by the single-surface
conjunct in §5.

---

## 8. Scar audit — all 39, one line each

| scar | PLAIN's answer |
|---|---|
| S1 no-log urgent | every armed write receipts (§4.2); C2/C3 walk |
| S2 canonical-topology-only invalidation | taps at eval (§4.4.2) + C1 walk |
| S3 canonical-only notify walks | same; world leaf sets are recorded, not inferred |
| S4 drop-on-abort | fold-not-drop retirement (φ4, D2) |
| S5 partial validity records | no cross-pass validity records exist; scratch is per-pass |
| S6 watcher-count-keyed arming | arming monotonic on bridge registration (§4.1) |
| S7 wall-clock render scope | φ1 per-callstack truth; C7 walk |
| S8 equality-gated writes | armed writes always append (§4.2, C8) |
| S9 unflagged⇒canonical routing | one fast path, gated on liveReceipts==0 + evaluator conjunct (§5) |
| S10 equality-filtered late-join fix | no fixed comparison set; φ5 rework + eval-time taps (C10) |
| S11 commit-gate trigger lists | no commit gate; delivery + rework are unconditional |
| S12 retirement without watermark | retiredSeq ≤ pin inclusion rule (§4.2) |
| S13 per-(world,batch) frontier retention | no world caches; nothing retained per batch-set |
| S14 canonical-value cutoffs gating cross-world notify | delivery & promotion walks value-blind (§4.4) |
| S15 GC-fodder arena discards | pass-owned fresh records, D19 (C9b) |
| S16 value-based delivery suppression | no suppression exists |
| S17 cross-write elision stamps | no elision state exists |
| S18 pinless shared world memos | no shared world memos exist |
| S19 full-token lock-in / pass-grain publication | watermarked lock-in (φ3); hook-grain publication (φ7) |
| S20 retire-clocks in capsule keys | keys = slot × lineage only (§4.6) |
| S21 ambient post-await classification | renegotiated to React parity §2.1; explicit scope API; sync-prefix writes still action-bound |
| S22 promise-patching carriers | no carrier exists; lifetime rides entangled actions (proven sufficient for lifetime by S22 itself) |
| S23 evaluator-blind fast paths | single fast path, single conjunct (§5); no caches to embed versions |
| S24 per-pass stamps in retry keys | lineage-stable keys; readLog values, not stamps (§4.6) |
| S25 invocation-time carrier capture | no carrier |
| S26 consumable-queue-only triggers | no consumable queues; delivery + commit drive effects (C16) |
| S27 empty-tape equality drops | armed writes always append, incl. dispatches (§4.2) |
| S28 unordered evaluator publication | φ7 publication-before-folds + promotion re-fold (§4.5) |
| S29 touched-column clearing / unbounded slots | no columns, no interning; receipts prune by liveness |
| S30 in-edge-only refresh carry | no refresh exemption machinery; delivery covers via taps + demoted edges |
| S31 stamp-move ⇒ refetch | value revalidation only (§4.6) |
| S32 live-sampled committed evaluators | pin-resolved chains + value-blind promotion walk (§7 S32 walk) |
| S33 render-armed delivery dedup | no dedup state; every write delivers |
| S34 hook-time-only stage gating | conflict ⇒ seeded restart (§4.5), termination argued |
| S35 retirement-only watcher reconcile | eval-time taps deliver immediately; late-discovered edges retro-deliver at installation (§4.4.2b), retired→urgent |
| S36 immediate slot release | receipts retained by liveness rule; no slots to release |
| S37 coarse receipt gate as sole routing | adopted **with renegotiated gates + named refinement ladder** (§2.3) — the scar's terms (author declared failure fatal) do not transfer |
| S38 renumbering | no renumbering exists (float64 + objects) |
| S39 generation-only settlement guards | exact thenable identity (§4.6) |

---

## 9. Performance expectations (honest, gated, renegotiated)

| path | expectation | gate (renegotiated) |
|---|---|---|
| DIRECT (no bridge) | one dead branch per site | within 2% of alien-signals v3, tier-0 (was: at-or-below) |
| React-mounted, quiet (no receipts) | branch + liveReceipts==0 check + evaluator compare per computed read | ≤4% vs DIRECT (was ≤2%; SPKHQ floor 2.4–3.8%) |
| urgent render, receipts live | fold short-circuit case 2 (all-visible scan) per touched atom | ≤10% vs useState-equivalent (P1 kept for quiet; see next row for windows) |
| render inside pending-transition window | full world path: re-derive per pass + fold scans | within 25% of useState during the window (new gate; spike SPK-P2) |
| write, armed | append + K0 apply + cone walk + setStates + noteWrite | ≤2× DIRECT write on tier-0 fan-outs (spike SPK-P3) |
| memory | receipts + taps + chains, all liveness-pruned; zero steady-state alloc when quiet (P4 kept for quiet paths) | soak test: bounded under S15-style mount/abandon churn and never-quiescent traffic (spike SPK-P1) |

Refinement ladder if SPK-P2/P3 fail their gates (pre-named, in-class, no
semantic change): (1) per-node "receipt-free leaves" epoch short-circuit;
(2) per-root liveReceipts split; (3) inline-2 receipt storage on a side
record to kill Map hops; (4) per-(atom, view) fold-reference memo (§4.2's
identity rung). **No rung reintroduces cross-pass world caches for
computeds or delivery suppression** — those are scarred classes (S16–S18,
S23), and the ladder is bounded above by them.

---

## 10. Open risks (declared, spiked)

1. **SPK-P1** — receipt/tap/demoted-edge growth under never-quiescent
   traffic (the G9-class residual). Gate: >1 MB/h steady growth or >5%
   degradation on soak ⇒ extend the append-time prune predicate.
2. **SPK-P2/P3** — the §9 window and write gates. Failure ⇒ ladder, not
   redesign (stance opposite to S37's author).
3. **φ5 existence proof** — that React's interleaved-update path can be
   asserted for (a) zero-setState writes via `noteWrite`, (b) seeded
   restarts (S34), and (c) `runInBatch` invoked from *inside a render*
   (retro-delivery fires during evaluation; React must accept a
   render-phase update scheduled into another lane, or the retro-delivery
   defers to a microtask before paint — either is implementable, one must
   be tested). This joins the loop's O7/O23 fork-test critical path. If
   (b) is unimplementable as a native rebase, the fallback is the
   champion's R3 seeding walk — a known, walked mechanism.
4. **Taps-at-eval purity** (C14) — the claim that render-phase tap
   installation is unobservable-modulo-spurious-redelivery needs a
   StrictMode + discarded-pass test battery.
5. **Parity renegotiation acceptance** (§2.1) — a product decision the
   human has pre-authorized here, but it must be surfaced in user docs as
   loudly as React documents its own caveat.
6. **Fold-reference identity across passes** (§4.2/I48) — the parity
   argument (React re-runs updater queues per attempt) is believed but
   should be differential-tested against `useReducer` under interleaving;
   the per-(atom, view) memo rung stands ready if a schedule falsifies it.

---

## 11. Why this is simpler (the count, honestly)

Champion: 9 mechanisms, ~2200 lines of normative spec across two documents,
a compile-time build split, three counter-wraparound protocols, a
suppression predicate, a fixup pass with its own blocker history.

PLAIN: 6 mechanisms, one document, one build, zero wraparound protocols,
zero suppression state, zero fixup passes, zero compile steps. Two
capabilities were sold to pay for it (post-await ambient classification;
cross-pass world-read speed), and both buyers are named in §2 with the
human's signature.
