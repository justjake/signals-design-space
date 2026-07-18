# Round 2 synthesis — HARDEN repaired (two-kernel champion; validity, evaluator-identity, and delivery-completeness strata closed)

Synthesis agent, round 2. Inputs: three designs (harden, cost-hardened,
lean-challenger), two adversarial reviews each. Output: adjudication of all
39 formal findings (+9 notes), the round's repaired final design, and the
spike list. Winner: **harden** (the champion lineage), repaired in place,
with five transplants from the competitors and one synthesis-discovered
hole closed (cross-episode notification, §T8-N below).

Convention: `[=H §n]` = unchanged from `design-harden.md` §n (one-line
restatement; harden is this round's base text, itself a strict extension of
the round-1 champion). `‡S` marks synthesis-changed steps in walks.

---

## Part I — Adjudication (every finding; no silent drops)

Verdicts: CONFIRMED = I re-derived the failing schedule (breaking step
quoted). REFUTED = none this round — every formal finding re-walked true.
NEEDS-MEASUREMENT = 3 number-turning disputes registered as spikes (they
arise from cost-hardened's Part-I attack claims and the G-Q floor, not from
a wrong-value schedule).

### design-harden (reviews: claude 4 findings + 3 notes; codex 8 findings)

| id | sev | verdict | breaking step (re-derived) | disposition |
|---|---|---|---|---|
| HC-F1 ≡ HX-2 | BLOCKER | **CONFIRMED** (both-model: two independent schedules, same arithmetic) | `fp(a,w)=max(newest w-visible seq, baseSeq, reducerStamp)` is monotone but **not injective over visibility flips**: an OLDER entry becoming visible under a newer one (k1 +5@s1 retires/locks after k2 ×3@s2 committed) moves the fold 0→15 (or 2→4 in HX-2's C3-shaped form) while max stays s2 → effect snapshot revalidates, never re-runs; same hole serves a stale thenable via the §9.2 prefix (claude Schedule B). The §8.3 claim "MOVED for worlds that newly see it" is true only when the newly seen entry IS the max. | **Repaired R1**: per-atom `visStamp` minted `++globalSeq` at every retirement fold touching the atom AND at every per-root lock-in of a slot holding entries for it; joins the fingerprint max. §8.3′, walks C16-B1′, C15 step 5′. |
| HC-F2 ≈ HX-1 ≈ CX-1 | BLOCKER (codex) / HIGH (claude) | **CONFIRMED** (both-model, three schedules, one stratum) | A hook's fn/deps swap is a render-phase mutation of ONE shared mutable evaluator: (a) discarded pass leaves f2 installed → committed-world effect flush evaluates f2 → effect observes a value no world committed (HC-F2); (b) two live passes need two closures at once — either U runs T's closure or T's resume runs U's → torn frame either way (HX-1); (c) yield-gap NEWEST read recomputes with T's uncommitted closure (CX-1). `fnStamp` versions the evaluator; it cannot select between concurrently-needed evaluators. | **Repaired R2**: staged evaluator identity — per-pass staged `(fn, deps, fnStamp)` consulted by that pass's evaluations; NEWEST/committed/effect/fixup evaluations use the committed evaluator; promotion at the hook's own commit effect (hook-grain, so LX-2's pass-grain hole is unrepresentable); reducer identity same treatment. §11.1′, walks C1-T9′, C1-T11, C14′. |
| HC-F3 | MEDIUM | **CONFIRMED** | RENDER_NEWEST has no demotion edge: a yield-gap write drifts `k0.pull`; resumed pass reads two worlds at the read level (X read 0, Y reads 1 in one pass) — C7's "still observes its original pinned world" violated even though claude's variants were all paint-rescued by fixup/backstop (accidental coverage). | **Repaired R3**: the logged write path demotes live RENDER_NEWEST pass bindings to their real (mask, pin) worlds — one global counter check, ≤ live passes iterated, original pin retained. Walk C7-D. |
| HC-F4 | MEDIUM | **CONFIRMED** | Guard checks pass-binding + fold-frame only; effect-flush/fixup/reconcile world evals run outside both → an R8-legal writing computed writes mid-world-eval → walk re-entrancy inside an evaluation frame + memoized outcome with side effects. | **Repaired R4**: the world-eval frame joins the guard's first line (one restricted-frame bitcheck). §6.2′. |
| HC-N1 | note | CONFIRMED (hygiene) | Fixup soundness at a deferred mount's own commit needs lock-in before that commit's layout effects. | Folded into R8 (F3 ordering clause) + fixup-window battery row. |
| HC-N2 | note | CONFIRMED (hygiene) | §9.3 step 3 "re-checked" names an undefined operation. | Replaced by a defined observer: settle enqueues a flush re-check for effect snapshots whose outcome was SUSPENSION; React's own ping covers passes; memo kill covers reads. §9.3′. |
| HC-N3 | note | CONFIRMED (hygiene) | World-eval recursion lacks a cycle mark. | Memo states EMPTY/EVALUATING/DONE per (node, worldKey); reading EVALUATING throws R7's cycle error (lean's M4 rule). §8.1′. |
| HX-3 | BLOCKER | **CONFIRMED** | K1 edge recorded AFTER a write never replays that write's lane delivery: T1 writes `a` (no edges) → W unscheduled in T1; joint {T1,T2} eval records `a→c` then is discarded (legal, C1-T7); T2 commits alone; T1's later render bails out on W → torn T1 commit, corrected only post-retirement (S2's kill signature). raiseFlag propagates FLAGS, not deliveries; the reach induction's "basis edges present" premise is false for receipts that predate the edge. | **Repaired R5 (transplant)**: cost-hardened's per-slot `touchedSlots` marks + propagate-on-new-edge **with queued per-bit deliveries** (`runInBatch`) replaces scalar F/raiseFlag. Verified held by both cost-hardened reviewers (its pruning/cutoff, NOT its propagation, is what died there). §6.4′, walk C1-T10. |
| HX-4 | BLOCKER | **CONFIRMED** | `fp(computed)=M(...).valueStamp` is minted fresh per memo, and a retry's new pin mints a new worldKey → new memo → new stamp → prefix mismatch → drop entry → refetch → suspend, forever (C15 livelock). | **Repaired R6**: thenable content-validity prefix is **flattened to receipt-line facts**: the ordered transitive (atomId, atom-fingerprint) reads plus (computedId, committed/staged fnStamp) of evaluators traversed before the position — retry-stable by purity, moved exactly by included writes and (via R1's visStamp) by visibility flips. Whole-mask clock vector stays the flagged coarse fallback. §9.2′, walk C15′. |
| HX-5 | BLOCKER | **CONFIRMED** | F8's ambient post-await classification retires a raw post-await `a.set(2)` in its own default batch → visible before the action settles — C12's frozen Required ("the writes commit... not before the action settles") covers both writes; documentation is not the preamble's thrown-rejection escape, and the fork CAN track continuations (lean proves the construction). | **Repaired R7 (transplant)**: lean's continuation carrier — dynamic token carrier captured at async-resource creation, pushed before each continuation, `finally`-restored; Node ALS / bundled host promise-reaction hook; **loud startup self-test**, never silent misclassification. Parking = lifetime; carrier = identity (O14's two duties separated). §12′, walk C12′. |
| HX-6 | BLOCKER | **CONFIRMED** | Fixup enumerates live **deferred** tokens only; a live default batch D (wrote `a`, excluded by a flushSync mount pass) is skipped, and the committed compare also excludes unretired-unlocked D → no corrective; D's later render bails out on W → torn D commit. | **Repaired R8**: the corrective loop runs over `touchedSlots(n) ∩ ALL live written tokens` (deferred and default); committed compare stays as the retired-race fallback. §11.2′, walk C2-M. |
| HX-7 | HIGH | **CONFIRMED** | Retirement is the only compaction site; a pass pin that blocked compaction never triggers a retry after the pass ends → "tapes compacted" precondition of quiescence unreachable → unbounded growth + seq horizon. | **Repaired R9**: pin-release sweep — retirement queues pin-blocked atoms; `onPassEnd`/lineage-death advance min-live-pin and drain the queue, then re-check quiescence. §15.1′ row + forced test. |
| HX-8 | HIGH | **CONFIRMED** | `worldMemoEpoch` has no reset/wrap/saturation row (O13's own rule: physically-remote horizons still need a named guard; effect snapshots retain epochs across episodes). | **Repaired R10**: epochs mint from `++globalSeq` (the ONE line, I15) — inherits renumber/horizon machinery and forced-small builds. §15.1′ row. |

### design-cost-hardened (claude 8 findings + 3 notes; codex 7 findings)

| id | sev | verdict | breaking step | disposition |
|---|---|---|---|---|
| CH-1 | BLOCKER | **CONFIRMED** | Frontier prune fires at the stamped written atom itself; suppressed node below is never re-reached → same-slot second write never re-runs the cutoff → torn committed frame; §9.1 pseudocode and G-C gate describe two different algorithms (CC-N3). | Mechanism **rejected** (frontier pruning + suppression do not enter the synthesis); the cost question returns to SPK-N1 with the per-slot-marks fallback (delivery dedup, not value cutoff). Scar proposed. |
| CH-2 ≡ CX-6 | BLOCKER | **CONFIRMED** (both-model) | One scalar `deliveredEra` per node: another slot's delivery overwrites the stamp after k's re-arm → prune eats a needed k delivery → k commits stale. Era-wrap variant: zeroed eras with retained bits prune immediately. | Same rejection. |
| CH-3 | BLOCKER | **CONFIRMED** | Quiescence-via-touched-lists cannot reach memos on TS=0 nodes; maskId interns reset to colliding small ints; optional seq reset inverts the row-1 window → a stale world value validates in the new episode (I8's exact class). | Pinless keys + ring **rejected**; synthesis keeps pin-in-key + epoch-in-key (harden §12 row) where the collision is unrepresentable. W3's cost claim survives as NEEDS-MEASUREMENT (below). |
| CH-4 | HIGH | **CONFIRMED** (doc-level) | The ‡H5 note times `baseSeq(a)=s2-fold` at U's retirement while older unretired s1 exists — folding a LATER op into base is unreconstructible: C3 yields 3-not-4, plain-set 6-not-5. | Synthesis states the prefix-only rule explicitly (harden §5.3 already had it; its C3 walk step 4 blocks the fold) and adds the reviewer's regression pin to the replay oracle. |
| CH-5 | HIGH | **CONFIRMED** | Retirement-fold/lock-in vs layout-effect ordering is load-bearing for I18/C9/C10 and unpinned; fold-after-layout breaks the race walk, fold-before-layout is a protocol fact needing a test. | **Repaired R11 (transplant of the pin)**: F3 ordering clause — per-root lock-in bookkeeping and (when the last root commits) the retirement fold complete before that root's layout effects run; fork test 16. |
| CH-6 | MEDIUM | **CONFIRMED** | Ring windows widen past R=64 under the design's own W3 workload → fail-closed mass re-fold cliff returns. | Moot (ring rejected); recorded as rejection evidence. |
| CH-7 | MEDIUM | **CONFIRMED** | "Retirement runs the notification path" is ambiguous; the pruned-walk reading breaks C12 (store-only cone pruned at root → effects never enqueued). | Synthesis has no prune/suppression; retirement fold-walk is the plain full walk and says so. §5.3′ step 4. |
| CH-8 | MEDIUM | **CONFIRMED** | "Quiescence zeroing is exact" is false for K1 records minted by world evals of untouched nodes (on no list) → cross-episode K1 growth + false invariant. | Synthesis keeps harden's tag+wrap-clear K1 id story (§7.2), which has no list-enumeration dependence. |
| CX-1 | BLOCKER | **CONFIRMED** | (= HC-F2 stratum, NEWEST face.) | Repaired by R2. |
| CX-2 | BLOCKER | **CONFIRMED** | Evaluate-cutoff compares the writer-world value against **commit-recorded** `lastRendered`; a finished-but-uncommitted T subtree holds c=1 while T's world returns to 0 → suppression leaves React free to commit the stale finished tree; parity with useState broken (React would re-render on the second update). Suppression basis lacks pending-render knowledge. | Cutoff **rejected** (with CH-1 this is the second independent kill); value-blind delivery + per-(watcher, slot) dedup stands (D10); SPK-N1 owns the cost with the per-slot-marks fallback. Scar proposed. |
| CX-3 | BLOCKER | **CONFIRMED** | O15's prod branch (updater reads resolve untracked-at-fold-world) creates an invisible dependency: no edge, no validity entry → fold caches stale, no notification → wrong committed value. Harden's prod branch shares the hole. | **Repaired R12 (transplant)**: lean's rule — signal reads (and writes) inside `update(fn)`/reducer folds **throw in all builds**, even through `untracked` (legitimate interface restriction: detectable at the read site inside a fold frame; legal composition = read before dispatch; replay purity is load-bearing for I2 and every validity argument). O15 settled. |
| CX-4 | BLOCKER | **CONFIRMED** | First half (write-time cutoff mints sentinel memos with no lineage → synthetic-thenable sharing breaks C15 identity) dies with the cutoff. Second half stands alone: entry validity lacking evaluator identity lets evaluator B reuse evaluator A's thenable. | Cutoff rejected; R6's prefix includes the owner node's (staged) fnStamp and traversed computeds' fnStamps. |
| CX-5 | BLOCKER | **CONFIRMED** | Pinless single-slot memo overwrite feeds root B's outcome (3) into root A's resumed pass as `ctx.previous` → one pass reads two values of one pinned world. | Dies with pinless keys; harden's per-(node, worldKey) memos keep `previous` pass/world-scoped (worldKey has pin + root variant). O17 rule restated §13.3. |
| CX-7 | HIGH | **CONFIRMED** | cost-hardened's seq-saturation guard waits for a quiescence that a held transition prevents; no terminal behavior. | Harden's §15.3 construction adopted (renumber at quiescent margin; **hard diagnostic throw** at the never-quiescent horizon; forced-small builds drive both paths, including codex's non-quiescent episode). |
| CC-N1 | note | moot (pruning rejected) | per-slot era truth vs G-M budget. | Recorded with the rejection. |
| CC-N2 | note | **NEEDS-MEASUREMENT** | G-Q's measured 2.4–3.8% branch floor vs P3's ≤2% is a requirements decision, not a schedule. | Spike **SPK-L** (idle-machine LOGGED-quiet tier-0); pre-registered rule: >2% confirmed → monitor renegotiates to ≤3% or the §4 mitigation ladder (fused status load; per-pass routing hoist) is built and re-measured. |
| CC-N3 | note | CONFIRMED (hygiene) | Pseudocode vs gate table = two algorithms. | Rejection evidence for CH-1. |

### design-lean-challenger (claude 3 findings + 3 notes; codex 9 findings)

| id | sev | verdict | breaking step | disposition |
|---|---|---|---|---|
| LC-F1 | HIGH | **CONFIRMED** | Global `retireClock` in every capsule key: each unrelated urgent retirement re-keys every suspense capsule → refetch + re-suspend per interaction → transition starvation + duplicate side-effectful fetches. | Feeds I24 (retirement components of resource keys must be relevance-filtered). R6's flattened prefix moves only on prefix-atom visStamps (touched-filtered) — starvation-free by construction; walked C15′ step 6. |
| LC-F2 | MEDIUM | **CONFIRMED** | Retirement reconciliation = O(reached watchers × committed evaluation) in one turn, unpriced (10k-watcher stall). | Synthesis adopts gate **G-R** + spike **SPK-R** (10k-atom retire × 5k effects ≤2× the batch's own render cost) and cost-hardened's targeted effect enqueue (walk targets, not registry scans). |
| LC-F3 | MEDIUM | **CONFIRMED** | Quiescence refresh × R8-legal writing computed = fixed-point livelock: refresh writes → new batch → retry → writes again; episode never resets; K1 grows forever. | The refresh IS transplanted (see T8-N — the champion needs it), with the guard: one retry, then the writing node is refresh-exempt and its K1 in-edges are carried into the next episode (over-notification only; bounded by the exempt cone). §5.4′. |
| LC-F4/F5/F6 | notes | CONFIRMED (hygiene, lean-scoped) | Reset sweeps unpriced; node→frame index unnamed; refresh scope wording. | F6's scope rule (refresh includes effect-dep nodes) is adopted verbatim into §5.4′; F4/F5 die with the design. |
| LX-1 | BLOCKER | **CONFIRMED** — and **it transfers to the synthesis the moment O14's carrier lands** | Full-token lock-in admits a committed token's FUTURE writes: async T locked into `locked[A]` at first commit; post-await continuation write seq2 under T; urgent render on A unions locked[A] → folds seq2 pre-commit → A contradicts its own committed DOM. Lock-in must be a write-prefix, not token membership. | **Repaired R13**: per-root lock-in **watermarks** — `onBatchCommittedOnRoot(token, root)` records `lockedSeq[r][slot] = committed pass's pin`; committed-for-root and pass-world composition use `slot ∈ lockedIn(r) ∧ seq ≤ min(pin, lockedSeq[r][slot])`; F2-supplied pass tokens keep the plain clause (mask parity untouched); retired clause unconditional. Walk C11-W. |
| LX-2 | BLOCKER | **CONFIRMED** (vs lean) | `rootCommit(P)` publishes every staged previous/node from P although error-boundary/suspended subtrees inside P never committed → speculative state published; retries double-apply. | Synthesis is hook-grain (promotion in the hook's own commit effect, which runs iff its subtree committed) — immune by construction; stated at §11.1′. |
| LX-3 | BLOCKER | **CONFIRMED** (mechanism-doesn't-run; blast radius bounded on re-walk) | `catchupTokens` recorded after `renderLeave(complete)` are never drained (no second leave) — lean's designed corrective is unreachable; coverage silently falls to the M6 fixup (which lean-claude's held-#2 walk shows does cover mounting watchers; committed watchers get direct delivery). | Lean-scoped. Synthesis walks the post-completion window explicitly in C10-R′ (corrective = in-lane runInBatch via fixup + committed compare; F4 gains the obligation note that post-completion updates schedule further work for that lane). |
| LX-4 | BLOCKER | **CONFIRMED** | Render-phase `setState` restarts a component within one pass; once-per-pass memo (DONE) returns the old fn's value while React commits new state. | Synthesis: R2's staging re-compares deps per invocation — a same-pass restart with new deps mints a new staged fnStamp → memo conjunct fails → re-eval. Walk C14′ step 5. |
| LX-5 | BLOCKER | **CONFIRMED** (vs lean) | ACTIVE_NEWEST copies one K0 box into two roots whose committed `previous` seeds legally diverge → both roots wrong. | Synthesis: RENDER_NEWEST `ctx.previous` is the donor's global previous, **documented** (O17 three-way rule, conformance-pinned); per-root previous exists only in world memos (worldKey has root variant). No shared committed-seed surface exists. |
| LX-6 | BLOCKER | **CONFIRMED** (vs lean) | Late settlement callback has no generation guard; reclaimed record reused → callback overwrites the wrong world's resource. | Synthesis already generation-tags settle continuations (harden §9.3 step 1); kept. |
| LX-7 | BLOCKER | **CONFIRMED** (API-truth; applies to every positional-cache design) | `ctx.use(makeRequest())` evaluates the factory before the cache is consulted: the retry re-invokes fn → a second request fires even though the cached identity is returned — "cannot initiate another fetch" is false as stated. | **Repaired R14**: `ctx.use` gains the lazy form `ctx.use(factory)` (factory invoked only when no valid entry exists); the eager-thenable form stays legal with the honest contract (identity stability guaranteed; suppression of the caller's own side effects is not). Conformance-pinned. |
| LX-8 | HIGH | **CONFIRMED** (applies to the synthesis fold too) | With custom equality, "set replaces the accumulator" returns the wrong representative: U-only must yield C, T+U must keep stabilized B; post-fold equality cannot recover both. | **Repaired R15**: equality-stable folds — each replayed op applies the atom's `isEqual` against the view's current accumulator and keeps the old reference on equal, exactly as the live K0 write path did (deterministic, matches donor semantics). Walk C3-E. |
| LX-9 | MEDIUM | **CONFIRMED** (vs lean's claim wording) | Discarded-pass K1 edges cause extra committed renders — observable counts; lean claimed unobservable. | Synthesis keeps the honest phrasing (over-delivery possible, priced under G3/G-N); no purity claim is made about render counts. |

### Cross-review resolutions and the three NEEDS-MEASUREMENT registrations

- **lean-claude (0 blockers) vs lean-codex (7)**: resolved by walks, not
  votes — every codex schedule re-derived true; claude's held-item-2 walk
  survives as the *bound* on LX-3's blast radius (the fixup covers what the
  dead catch-up path was for). Lean's clean claude review reflects real
  strengths (its constructions are the source of R7, R12, R14, and §5.4′)
  but the codex kills land on its two central bets.
- **NM-1 (O12 / cost-hardened W1)**: value-blind delivery under a held
  batch re-delivers per render cycle — the champion's G-N bound is per
  cycle, unbounded per batch. Soundness of the proposed cutoff is dead
  (CH-1/CX-2); the COST is measurable → **SPK-N1** grid gains the
  held-batch × writes/frame row; decision rule: fail → per-slot marks
  fallback (render-cycle delivery dedup — dedup, not value cutoff; immune
  to CX-2's basis problem), never an equality cutoff.
- **NM-2 (cost-hardened W3)**: pin-in-worldKey makes every transition
  restart re-evaluate its flagged region (ladder cannot help across a KEY
  change). Pinless keys died (CH-3/CX-5/CH-6). → **SPK-G8** gains the
  restart-heavy typeahead row; decision rule: fail → the specced
  pinless-frontier hybrid (shared (mask, lockVar, epoch)-keyed frontier
  memo advanced monotonically by the newest pin + pass-local scratch for
  pinned stragglers) is designed as the fallback, not the default.
- **NM-3 (CC-N2 / G-Q floor)**: SPK-L as above.

**Totals: 39 formal findings — 39 CONFIRMED, 0 REFUTED; 3 NEEDS-MEASUREMENT
registrations (SPK-N1 row, SPK-G8 row, SPK-L) from the attack/gate
disputes; 9 notes all confirmed-as-hygiene or moot.**

---

## Part II — Choice and rejections

**Winner: harden.** One sentence: it is the only design whose confirmed
defects all have cell-level repairs inside its own audit-table discipline —
both its reviewers judged every blocker locally repairable in-architecture
(and its base survived round 1's full-depth judging) — whereas each
competitor's *new load-bearing mechanism* took kill-class schedules
(cost-hardened: frontier pruning CH-1/CH-2, evaluate-cutoff CX-2, pinless
keys CH-3/CX-5; lean: full-token lock-in LX-1, pass-grain publication
LX-2). Secondary: harden preserved every measured-safe cost posture (values
in-plane per I11; twin builds per SPK-H/Q; no per-link kernel state per D4)
and its centerpiece disciplines (change-source table, mask lifecycle,
allocator constructions, staging) were verified held by both reviewers.

**Rejected, per design (negative space):**

From **cost-hardened**: frontier pruning with shared per-node eras (CH-1/
CH-2/CX-6 — cross-write delivery-elision state is the new scar class);
evaluate-cutoff suppression (CH-1 strand + CX-2 commit-basis — value
suppression cannot see finished-uncommitted work); pinless maskId keys +
retire ring (CH-3/CX-5/CH-6 — reachability of "kill the memos" was never
enumerated); inline-2 tape (fine idea, deferred to SPK-W's remedy list to
keep this round's delta auditable). Adopted from it: touchedSlots +
propagate-on-new-edge-with-delivery (R5), targeted effect flush (G-R),
the F3 commit-ordering pin (R11), the honest G-Q AT-RISK framing, and the
W1/W2/W3 adversarial workloads as permanent CI perf rows.

From **lean-challenger**: transient-only world values (its bet dies not on
elegance but on LX-1/LX-2 — the lock-in and publication grains were wrong,
and repairing them rebuilds exactly the persistent machinery it deleted);
full-token root arrays (LX-1); pass-grain publication (LX-2); global
retireClock resource keys (LC-F1); the never-drained completion catch-up
(LX-3). Adopted from it: the continuation carrier + loud self-test (R7),
throw-on-fold-reads in all builds (R12), the quiescence refresh with
carry-exempt guard (§5.4′), the lazy `ctx.use` factory (R14),
equality-stable folds (LX-8→R15), hook/commit-grain staging discipline
(already harden's; lean's walk sharpened its statement), and protocol
point-3's obligation phrasing for F4.

From **harden** itself: the max-only fingerprint (HC-F1), the global
mutable evaluator (HC-F2), ambient post-await classification (HX-5 — its
React-parity argument was true of React state but the seed's C12 governs
signal writes), deferred-only fixup enumeration (HX-6), and the
per-memo-instance prefix stamps (HX-4).

---

# The repaired design

Stance unchanged (D8): canonical donor kernel K0 (closed, monomorphic,
twin-built) + K1 real world edges + always-log tape + clock/epoch validity
+ per-write full-reach notification in the writer's stack. This document =
`design-harden.md` with repairs R1–R15 applied. No load-bearing mechanism
moved; the delta is: one new fingerprint term (visStamp), one column
upgrade (scalar F → per-slot touchedSlots with delivering propagation),
evaluator staging, watermarked lock-in, the carrier F8, and six seam rules.

## 1. One-page summary (the whole concurrency story)

**Two builds, one engine** [=H §4]. DIRECT is the donor byte-for-byte
(SPK-H/Q remedies: hooks and routing exist only in the LOGGED build; swap
at bridge registration, monotonic, S6). LOGGED-quiet carries the residual
tax; G-Q is a budget with a measured floor risk (SPK-L; renegotiation rule
pre-registered).

**One value truth plus receipts** [=H §5]. Every LOGGED write — urgent
included (I1) — passes the guard (which now also rejects writes inside any
world-eval or fold frame, and demotes live RENDER_NEWEST passes), appends
a receipt, applies to K0 newest, and walks. A world's value is a fold:
base + entries visible under the seed math, replayed in seq order with
**per-op equality stabilization** (R15) — clause-for-clause React's queue
arithmetic (D3/I2). All stamps — seqs, pins, retirement stamps, epochs,
and every validity fingerprint — mint from ONE monotone counter (I15).

**Lock-in is a write-prefix** (R13). `lockedIn(root)` pairs each slot bit
with a watermark = the committed pass's pin. Committed-for-root worlds and
pass-world compositions admit a locked slot's entries only up to its
watermark; the pass's own F2-supplied tokens use the plain clause (mask
parity untouched); the retired clause is unconditional. An async action's
post-await writes (which the carrier attributes to the parked token, R7)
therefore stay invisible to roots that committed earlier prefixes — C11-W.

**Worlds route reads; freshness guards the fast path** [=H §6]. Invariant
R unchanged with `touchedSlots(n) = 0` as the unflagged test. The
worldSensitive scalar is now **per-slot touchedSlots** maintained by
walks, world evals, and **propagate-on-new-edge with queued per-bit
deliveries** (R5): recording an edge d→n flows `touched(d) & ~touched(n)`
down n's existing out-edges AND delivers those slots' setStates to watched
nodes reached (runInBatch per bit; immediate in the writer's stack, queued
to the pass yield/end edge inside renders). Flags without deliveries were
the HX-3 tear; this is the I17 repair and the delivery-completeness repair
in one mechanism.

**Validity is a CLOSED change-source enumeration** [=H §8] with two new
rows: **S2b visibility flips** — a per-atom `visStamp` minted at every
retirement fold touching the atom and at every per-root lock-in of a slot
holding its entries, joined into the atom fingerprint's max (R1; kills the
HC-F1/HX-2 non-injectivity) — and **S3′ staged evaluator identity** — a
hook's fn/deps/reducer swap stages per pass and promotes at the hook's
commit effect; NEWEST/committed evaluations use the committed evaluator
(R2). Epochs mint from globalSeq (R10).

**Suspense** keys thenables by fork lineage (D11) with content validity =
the **flattened prefix**: ordered (atomId, fp) transitive reads +
(computedId, fnStamp) evaluators before the position (R6) — retry-stable,
moved exactly by included writes and visibility flips, indifferent to
unrelated retirements (LC-F1's starvation class excluded by construction).
`ctx.use(factory)` is the recommended lazy form (R14). Settlement kills
sentinel memos by generation-checked back-refs; effect snapshots holding
SUSPENSION outcomes get a settle-time flush re-check (HC-N2 resolved).

**Notification** [=H §10]: per-write full-reach walk over K0∪K1, setState
in the writer's context, per-(watcher, slot) dedup re-armed on render, no
grouped drain (D10), value-blind (SPK-N1 owns the cost; the fallback is
per-slot-mark delivery dedup, never value cutoff — CX-2's scar). Signal
effects are walk targets (committed channel): retirement flushes drain a
touched-effect queue, O(affected) (G-R). Mount fixup runs over
`touchedSlots(n) ∩ ALL live written tokens` — default batches included
(R8) — plus the unconditional committed-compare fallback (I18).

**Async actions** (R7): fork F8 = continuation carrier. Post-await writes
classify under the parked action token; two interleaved actions keep
distinct tokens; unsupported hosts fail a loud startup self-test. C12's
"not before the action settles" holds for raw post-await writes.

**Lifecycle** [=H §15] plus: pin-release compaction sweep (R9), the
quiescence **refresh** (before K1 resets, every K1-touched node with a
committed watcher or effect-dep snapshot is K0-pulled at NEWEST so its
real basis edges live in K0 for the next episode — closes the
cross-episode notification gap T8-N; a refresh that triggers a legal
computed write retries once, then exempts the node and carries its K1
in-edges forward), staging (S15) extended to evaluator identity, K1 tag
wrap-clear, token live-skip allocator, globalSeq renumber + hard horizon
throw.

Numbers: DIRECT = donor verbatim [ARENA]. Gates §16; unmeasured items are
spikes, never claims.

## 2. Repair log (delta against design-harden.md)

- **R1** visStamp change-source row S2b; fingerprint = `max(newest
  w-visible seq, baseSeq, reducerStamp, visStamp)` (§8.3′; C16-B1′, C15′).
- **R2** staged evaluator identity: per-pass staged (fn, deps, fnStamp)
  and staged reducer; committed evaluator elsewhere; promote at hook
  commit effect; re-compare per invocation (LX-4) (§11.1′; C1-T9′/T11,
  C14′).
- **R3** RENDER_NEWEST demotion on the logged write path (§6.1′; C7-D).
- **R4** world-eval frame joins the write guard's first line (§6.2′).
- **R5** touchedSlots + propagate-on-new-edge with queued per-bit
  deliveries replaces scalar F/raiseFlag (§6.4′; C1-T10).
- **R6** flattened-atom (+evaluator) thenable prefix; coarse mask-clock
  vector = flagged fallback (§9.2′; C15′).
- **R7** F8 = continuation carrier + parking + loud self-test (§12′;
  C12′).
- **R8** fixup loop over touched ∩ all live written tokens (§11.2′; C2-M,
  C10′).
- **R9** pin-release compaction sweep (§15′; C13).
- **R10** epochs mint from globalSeq (§15′).
- **R11** F3 ordering clause: lock-in/retirement fold before that root's
  layout effects; fork test 16 (§14′).
- **R12** fold-frame signal reads throw in all builds (O15 settled)
  (§13.2′).
- **R13** watermarked per-root lock-in (§5.2′; C11-W).
- **R14** `ctx.use(factory)` lazy form + honest eager contract (§9.1′).
- **R15** equality-stable folds (§5.2′; C3-E).
- **T8-N** quiescence refresh with exempt-carry guard (§5.4′; walk below).
- Hygiene: EVALUATING cycle marks in world memos (HC-N3); settle-time
  effect re-check (HC-N2); targeted effect enqueue + G-R (LC-F2/W5);
  lock-in-before-layout battery row (HC-N1).

## 3. Concepts (delta over harden §3)

- **touchedSlots(n)** — int32 cold column replacing the F bit: bit k set ⇔
  slot k's recorded influence cone (K0∪K1, any time this episode) includes
  n. Monotone per (episode × slot generation); cleared per-slot at recycle
  via the slot's touched list, bulk at quiescence. Routing tests
  `touchedSlots(n) == 0`; fixup and retirement targeting test bits.
- **touchedList[slot]** — per-slot append-only id list, written on 0→1 bit
  transitions; consumers: retirement fold seed, per-slot bit clear at
  recycle (I19 sweep), effect-queue targeting, quiescence column zeroing
  assistance. (K1 id lifecycle keeps harden's tag + wrap-clear — CH-8's
  enumeration hole does not apply to tags.)
- **visStamp(a)** — per-atom stamp minted `++globalSeq` at (i) any
  retirement fold that stamps/folds entries of `a`, (ii) any per-root
  lock-in of a slot holding entries of `a`. Fingerprint term (S2b).
- **lockedIn(root)** — set of (slot, watermark) pairs; watermark = the pin
  of the pass whose commit locked the slot on this root; watermark
  advances at each later commit of that slot on the root; bit + watermark
  cleared at retirement before slot release (I19).
- **staged evaluator** — per-pass table hookNode → {fn, deps, fnStamp} (+
  staged reducer); consulted by that pass's evaluations only; promoted at
  the hook's commit effect; discarded with the pass. Committed evaluator =
  the node's last promoted one.
- **flattened prefix** — ordered list [(atomId, fp(atom, w)) …] ∪
  [(computedId, fnStamp)] accumulated by the eval frame for reads
  performed before a `ctx.use` position; child evaluations merge their
  lists into the parent (S5's flatten rule).
- Everything else — K0/K1, DIRECT/LOGGED, globalSeq, tape/base/baseSeq,
  tokens/slots/masks/pins, world/worldKey (pin + root-lock variant +
  epoch), memos, CT, watcher, pass/lineage/episode, staging list, fold
  frame — as harden §3.

## 4. Mode protocol [=H §4]

Twin generated builds; op-table swap at `registerReactBridge()`;
state-outlives-builds; compiled-out inventory; SPK-L owns the LOGGED-quiet
residual with the mitigation ladder and the pre-registered G-Q
renegotiation (NM-3).

## 5. Value model

### 5.1 The logged write path (guard extended: R3/R4/R12)

```
write(atom, op):
  if restrictedFrame():        throw   // pass binding | world-eval frame | fold frame — FIRST, before any mutation
  if liveRenderNewestCount>0:  demoteRenderNewestPasses()   // R3: flip routing to their real (mask, pin)
  token = fork.currentBatchToken()     // carrier-aware (R7); lazy mint
  slot  = internSlot(token)            // zeroes slotWriteSeq at first intern
  seq   = ++globalSeq;  slotWriteSeq[slot] = seq
  if atom.tape.length == 0: atom.base = k0.value(atom)
  atom.tape.push({op, slot, seq, retiredSeq: 0})   // ALWAYS (I1/I7/C8)
  k0.writeNewest(atom, applyStable(op, k0.value(atom)))  // equality keeps old ref, skips K0 marks only
  notifyWalk(atom, slot)
```

`update(fn)`/reducer application runs under a fold frame; **signal reads
inside throw in all builds** (R12; legal composition: read before
dispatch; conformance-pinned).

### 5.2 Folds: equality-stable replay + watermark math (R13/R15)

`foldAtom(atom, w)`: acc = base; for each visible entry in seq order:
`next = apply(op, acc); acc = isEqual(acc, next) ? acc : next` (R15 —
reference stability matches the live K0 write path; C3-E).

Visibility of entry e for world w = (mask M from F2 tokens, per-root
locked set L(r), pin p):

```
(e.retiredSeq ≠ 0 ∧ e.retiredSeq ≤ p)                       // retired clause, unconditional
∨ (e.slot ∈ M ∧ e.seq ≤ p)                                  // pass's own tokens: plain clause (mask parity)
∨ (e.slot ∈ L(r) ∧ e.seq ≤ min(p, lockedSeq[r][e.slot]))    // locked tokens: WATERMARKED (R13)
```

For sync batches every write predates the first commit, so watermark ≡
full clause (round-1 behavior unchanged); only carrier-attributed
post-await writes exercise the bound (C11-W). ReducerAtom rides the same
tape; fold uses the committed reducer except inside a pass with a staged
one (R2).

### 5.3 Retirement [=H §5.3 + R1/R9/CH-7 clarity]

1. Stamp `retiredSeq = ++globalSeq`; `worldMemoEpoch = ++globalSeq` (R10).
2. Per touched atom (via touchedList[slot]): fold the compactable
   **all-retired prefix only** (blocked at the first unretired entry; pin
   retention per C7 — CH-4's ordering is unrepresentable);
   `baseSeq = max(baseSeq, max folded seq)`; **mint visStamp(a)** (R1).
   Pin-blocked atoms enqueue on the pending-compaction list (R9).
3. Run the retirement notification path — the **plain full walk** (no
   prune/suppression exists to consult; CH-7) for atoms whose base moved,
   the reconcile backstop, and the per-root effect flush draining the
   touched-effect queue (targeted; G-R).
4. Clear bit(slot) + watermark from every root's lockedIn before slot
   release (I19); recycle zeroes wc, watcher bit column, touched bits via
   touchedList[slot].
5. Ordering (R11): steps 1–4's per-root bookkeeping (lock-in watermarks,
   fold when this commit retires the token) complete before that root's
   layout effects run — fork F3 clause, test 16.

`onPassEnd`/lineage death advance min-live-pin and drain the
pending-compaction list, then re-check quiescence (R9 — HX-7 closed).

### 5.4 Quiescence (refresh added — T8-N)

Precondition as harden (live batches/passes = 0, tapes compacted — now
reachable by R9). Then, **before** K1 reset:

- **Refresh (T8-N)**: for every K1-touched node with a committed watcher
  or an effect-dep snapshot (LC-F6's scope), K0-pull at NEWEST — legal
  (no worlds exist), re-tracks the node's true basis into K0, donor
  recursion fixes stale upstream. Why required — the walked gap: ep1
  world-evaluates w (basis edges only in K1); quiesce clears K1; ep2's
  write to w's real dep x has no K0 edge x→…→w → walk reaches nothing →
  W never scheduled → torn ep2 commit. The champion's reach induction
  presumes basis edges present; the refresh restores that premise at
  every episode boundary. If a refresh pull performs an R8-legal computed
  write, quiescence has ended: finish the sweep, retry once at the next
  quiescence; a node that writes again is **refresh-exempt** — its K1
  in-edges are carried into the fresh plane (over-notification only;
  LC-F3's livelock closed).
- Then: bump episodeEpoch (tag wrap-clear duty), bump-reset K1, zero
  touchedSlots/lists, drop worldKeys/memos (epoch-in-key makes stragglers
  unreachable — CH-3's class unrepresentable), staging reclamation sweep,
  optional globalSeq renumber past the margin (§15).

## 6. Worlds, routing, marks

### 6.1 Worlds [=H §6.1 + R3]

NEWEST outside passes; pass worlds from F2 (mask ∪ watermarked
lockedIn(root), pin, per-callstack across yields — I6); committed-for-root
for effects/fixups. RENDER_NEWEST classification is now **revocable**: the
first logged write while any RENDER_NEWEST binding is live demotes those
bindings to their real (mask, pin) worlds (original pins retained) — C7-D.

### 6.2 Read routing [=H §6.2]

Unchanged, with `touchedSlots(n) == 0` as the unflagged test and world
memos carrying EVALUATING marks (cycle throw, R7 of requirements; HC-N3).
**Every world evaluation runs under the world-eval frame, which the write
guard rejects (R4).** Invariant R's statement and proof are harden §6.3
verbatim (I12 freshness conjunct intact; the proof's flag premise now
reads invariant M).

### 6.4′ Invariant M: per-slot marks with delivering propagation (R5)

**M:** if atom x has a live-episode receipt in slot k and a path x→…→n
exists in K0∪K1 at any time while the bit is live, then
`touchedSlots(n) ∋ k`.

Maintenance sites: (1) walks OR the walk's slot bit into every visited
node (0→1 appends to touchedList); (2) world evaluations OR the union of
their deps' bits into the evaluated node; (3) **edge recording** (K1
append from a world eval; K0 re-track acquisition at `afterRetrack`;
E-PRESERVE mirrors are exempt — they copy K0 edges whose paths already
existed): `newBits = touched(d) & ~touched(n)`; if nonzero — OR in, append
to lists, recurse through n's existing K0∪K1 out-edges, and **for every
watched node reached, deliver each bit's setState via
fork.runInBatch(token(bit), setState)** — immediately when in the writer's
stack; queued to the pass's yield/end edge when inside a render (each
queued delivery carries its own token — D10's per-write context preserved;
retired tokens fall back per the fixup rule). Induction over the four
event kinds as harden §6.4, with step (2)-new-edge now carrying both the
mark and the retroactive delivery — the HX-3 schedule's T1 receipt reaches
W the moment the joint evaluation records a→c (walk C1-T10). Cost: each
node gains each bit ≤ once per slot generation; amortized
O(live-slots × touched region) per episode; deliveries bounded by
watched-nodes × slots with dedup.

## 7. K1 [=H §7]

Layout, population, E-PRESERVE (SP2), id tag + wrap-clear all unchanged
(CH-8 avoided by tags, not lists).

## 8. Validity: the closed table, extended (R1/R2/R10)

### 8.1 Change-source table [=H §8.1] with amended rows

| # | change source | observer (stamp + conjunct) | notes |
|---|---|---|---|
| S1 | write in slot s | `slotWriteSeq[s]`; conjunct ∀s∈mask: wc[s] ≤ r.seq; fingerprint newest-visible term | [=H] |
| S2 | retirement (fold/compaction) | `worldMemoEpoch = ++globalSeq` (R10); `baseSeq` monotone max | [=H] |
| **S2b** | **visibility flip below the max** (retirement or lock-in makes an OLDER entry visible) | **visStamp(a) minted at retire-fold and per-root lock-in; term in fp's max** | R1 — HC-F1/HX-2 dead; over-invalidation = one ladder re-fold per touching commit, safe direction |
| S3 | evaluator identity | staged per pass, promoted at hook commit (R2); `fnStamp`/`reducerStamp` conjuncts; committed evaluator for NEWEST/committed evals | HC-F2/HX-1/CX-1/LX-4 dead |
| S4 | thenable settlement | eager gen-checked back-ref kill + pending-only belt; **settle-time flush re-check for SUSPENSION effect snapshots** (HC-N2) | [=H+] |
| S5 | episode/renumber | epoch-in-worldKey; renumber rewrites stamp columns incl. visStamp; hard horizon throw | [=H] |
| S6 | world identity | in the key (mask, pin, root-lock variant, epoch) | pinless keys rejected (CH-3/CX-5) |
| S7 | node identity recycle | staging + GEN | [=H] |

Unified predicate and ladder as harden §8.2; `fingerprint(atom, w) =
max(newest w-visible entry seq, baseSeq, reducerStamp, visStamp)` (§8.3′).
The B1 walk and both HC-F1 schedules are re-walked at C16-B1′ and C15′.

## 9. Suspense (R6/R14 + [=H §9])

### 9.1′ `ctx.use(thenableOrFactory)`

Positional cache keyed `(node, lineageId, position)` (D11). The lazy form
`ctx.use(() => makeRequest())` invokes the factory only when no valid
entry exists — the retry's cache hit fires no user side effect (LX-7).
The eager form remains legal with the documented contract: identity
stability is guaranteed; the caller's own eager side effects are not
suppressed.

### 9.2′ Content validity: the flattened prefix (R6)

Entry records `prefix = [(atomId, fp(atom, w)) in read order] ∪
[(computedId, effectiveFnStamp)]` — accumulated by the eval frame across
nested evaluations (children merge into parents; S5's flatten rule), for
all tracked reads before the position; untracked reads excluded by
contract. Reuse iff pairwise equal; else drop positions ≥ p, store fresh
(gen-bumped). Properties: **retry-stable** — purity ⇒ same reads; atom fps
and fnStamps are receipt-line facts, indifferent to memo/worldKey/pass
churn (HX-4 dead) and to unrelated retirements (visStamp is
touched-atom-scoped — LC-F1's starvation dead); **content-sensitive** —
an included write moves the newest-visible term; a visibility flip moves
visStamp (HC-F1 Schedule B dead); an evaluator swap moves fnStamp (CX-4
second half dead). Fallback if prefix compares measure hot: whole-mask
clock vector + visStamp sum (coarser, more refetches, flagged non-default).
Settlement (gen-checked kill + belt + effect re-check) as §8-S4;
RENDER_NEWEST↔world boundary pin unchanged (one duplicate fetch, one
identity flip max).

## 10. Notification [=H §10 + R5 delivery + targeted effects]

Walk pseudocode as harden §10 with `touchedSlots |= bit` in place of
raiseFlag-mark, and signal-effect subscribers enqueued into the per-root
touched-effect queue (drained by flush triggers; O(affected) — G-R). No
pruning, no suppression, no cross-walk marks; per-(watcher, slot) dedup
with render re-arm; per-slot-marks fallback stays specced, activates only
on SPK-N1 failure.

## 11. React bindings

### 11.1′ Watchers, hooks, staged evaluators (R2)

Hook-instance watcher record + `useState(version)`; reads route under
`currentWorld`. `useComputed` per invocation: compare incoming deps
against **this pass's staged entry, else the committed evaluator**;
changed → stage {fn, deps, fnStamp: ++globalSeq} in the pass (burned seqs
on discard are unobservable — C14′); same-pass render restarts re-compare
(LX-4). Pass evaluations of the node use its staged evaluator; NEWEST,
committed-world, fixup, and effect evaluations use the committed one
(HC-F2/CX-1 dead — an uncommitted closure is unreachable outside its
pass). Promotion at the hook's commit effect (with node promotion out of
staging, S15) — hook-grain, so a fallback-committing root pass publishes
nothing for abandoned subtrees (LX-2 unrepresentable). Reducer identity:
constructor reducers immutable; hook reducers stage/promote identically
(O16: differential at stable-reducer scope; dev-warn on swap with pending
receipts).

### 11.2′ Mount/subscribe fixup (R8 + I18)

```
r = touchedSlots[n]
if r == 0 ∧ (atom-empty-tape ∨ CT(n)): return          // invariant R fast-out
for each LIVE WRITTEN token t with slot(t) ∈ r:        // deferred AND default (HX-6); reach-based, no equality filter (I13)
  fork.runInBatch(t, () => setState(W))
v_now = evaluate(n, committed-for-root)                 // write-rejecting world eval (R4)
if !isEqual(v_now, v_rendered): setState(W)             // unconditional fallback (I18)
```

Bound: |touched ∩ live| correctives (cost-hardened's narrowing argument,
verified held there) + one committed eval. Windows: retire-inside-window →
compare fires (fold precedes layout by R11); post-completion writes →
in-lane runInBatch corrective (C10-R′; LX-3's class).

### 11.3–11.6 [=H §11.3–11.6]

Reconcile backstop; effect triggers (fingerprints now visStamp-aware);
StrictMode (staged evaluators re-stage idempotently by deps compare); SSR.

## 12. Async actions: F8 = continuation carrier (R7)

The fork's batch registry keeps a dynamically-scoped token carrier: every
async resource created while an action scope runs captures the current
token; immediately before a continuation executes the carrier pushes it;
`finally` restores. Node: AsyncLocalStorage; browser: the fork runtime's
bundled promise-reaction/host-callback hook; **startup self-test fails
loudly on hosts without continuation identity** (never silent
misclassification — the pre-registered degraded rule). Parking (F3) is
lifetime; the carrier is identity (O14's duties separated). Nested
`startTransition` while an action pends entangles to the action token
(≤31 structural). Retirement parks until the returned thenable settles.
Fork tests 13/14 (two interleaved actions; interleaved click; differential
vs React 19 on the React-state side) + SP-F8 (carrier overhead +
host-hook feasibility). Signal semantics: ALL writes in the action —
sync prefix and post-await — fold at settle (C12 verbatim), which is what
creates the watermark obligation R13 repairs.

## 13. Semantics pins

- **O15 (R12)**: fold-frame signal reads/writes throw in all builds.
- **O16**: committed/staged reducer identity as §11.1′.
- **O17**: `ctx.previous` exposed; NEWEST/RENDER_NEWEST = donor global
  previous (documented — LX-5's per-root divergence is a stated contract,
  not a leak); world evals = prior M(node, worldKey).value (pass/world-
  scoped — CX-5's overwrite unrepresentable), else R-guarded K0 seed,
  else undefined; conformance-pinned three-way rule.

## 14. fork-protocol (8 facts, versioned; ~12 reconciler sites)

[=H §14] F1 tokens; F2 pass lifecycle (mask parity; yield truth); F3
retirement + per-root lock-in **with watermark data (token, rootId,
passPin) and the ordering clause: per-root lock-in bookkeeping and
last-root retirement fold complete before that root's layout effects
(R11/R13)**; F4 runInBatch (**obligation: an update scheduled into a
completed-not-committed pass's lanes schedules further work for those
lanes — it is never silently absorbed into the finished tree**); F5
lineage; F6 mutation window; F7 handshake; F8 **action scope via the
continuation carrier (R7)**. Rebase drill answers unchanged (library moves
zero lines; F8 re-anchors at the host async hook, test 13 is the
tripwire). Fork tests 1–15 as harden plus: **16** lock-in/retirement-fold
before layout effects (R11); **17** watermark visibility (C11-W's
schedule); **18** carrier matrix (native await, timers, clicks,
interleaved actions, self-test failure path).

## 15. Lifecycle tables [=H §15 + new rows]

New/changed rows (all others as harden §15.1–15.6):

| item | retained by | reset/clear | guard + forced test |
|---|---|---|---|
| `visStamp` column (globalSeq mints) | fingerprints, prefixes, effect snapshots | never within episode; renumber rewrites | monotone; C16-B1′ + out-of-order-retirement differential |
| `worldMemoEpoch` (= globalSeq mint, R10) | memo/snapshot `r.epoch` | renumber rewrites | inherits §15.3 horizon; forced-small battery |
| lockedIn watermarks | committed-for-root folds | advance per commit; cleared with bit at retire (I19) | fork test 17; stale-watermark battery |
| pending-compaction list (R9) | pin-blocked atoms | drained at pass-end/lineage-death min-pin advance | forced test: yield-held pin → pass ends → compaction + quiescence proceed (HX-7) |
| staged evaluator tables | pass frames | promote at hook commit; drop at pass discard | C14′ StrictMode re-stage test; LX-4 restart test |
| touchedSlots/touchedList | routing, fixup, retirement targeting | per-slot at recycle (list sweep); bulk at quiescence | recycle battery: recycled slot sees zero bits anywhere |

globalSeq saturation (§15.3), token allocator (§15.4), K1 tag wrap-clear
(§15.5), staging (§15.6) unchanged; refresh added to the quiescence
sequence (§5.4′).

## 16. Gates and spikes

| gate | budget | note |
|---|---|---|
| G-D | ≤ alien v3 every tier-0 shape; 179/179 + growth + exact pulls | DIRECT = donor bytes; CI symbol check |
| G-Q | ≤2% LOGGED-quiet tier-0 — **AT RISK: measured 2.4–3.8% branch floor [SPKHQ]** | SPK-L; pre-registered renegotiation ≤3% or mitigation ladder (NM-3) |
| G-W | logged write ≤2× DIRECT | SPK-W (inline-2 receipts = named remedy) |
| G-N | ≤2× DIRECT propagate; ≤1 spurious render per (watcher, slot, render cycle) | SPK-N1 grid + W1 held-batch row (NM-1); fallback = per-slot marks (dedup) |
| G-V | predicate = int compares; fingerprint = tape-tail + 3 loads + max; prefix = O(position) compares | inside SPK-G8 |
| G-F | ≤ \|touched ∩ live\| correctives + one committed eval per flagged mount; 0 for R-clean | react-concurrent-store + W2 row |
| G-E | world-eval ∝ flagged region; **restart-heavy amortization measured** | SPK-G8 + W3 row (NM-2); fallback = pinless-frontier hybrid (specced, non-default) |
| G-R | retirement ≤2× the batch's own render cost; effect flush O(affected) | SPK-R (W5 row) |
| G-M / G-P1 | 0 steady allocations; ≤10% vs useState, 10k mount ≤15% (with 10 live transitions) | harness |

Spikes: **SPK-L** (LOGGED-quiet residual + activation cost, idle machine),
**SPK-N1** (fan-out grid + held-batch row), **SPK-G8** (held-open +
restart-heavy typeahead), **SPK-W** (logged write), **SPK-R** (retirement/
effect-flush targeting), **SP2** (E-PRESERVE validator), **SP-F8** (carrier
overhead + browser host-hook feasibility). Decision rules in the rows
above; unmeasured ⇒ never asserted.

## 17. Correctness walks — full battery against the repaired design

Notation as harden §17 (`TS(n)` = touchedSlots; `vS(a)` = visStamp;
`fp′` = R1 fingerprint). Steps changed by a synthesis repair are ‡S.
Unchanged harden walks are compressed to their outcome line with the
harden section cited — each was re-executed against the repaired
mechanisms and no repair regressed it (repairs only add stamps, staging
indirection, delivery, and clauses that are no-ops in those schedules).

### C1 — world-divergent dependency (family of 11)

Core walk = harden C1 steps 1–9 with TS bits for F ‡S (step 2: TS(flag),
TS(c) |= k; step 9 adds `vS(flag), vS(a)` mints at retire ‡S). Outcome:
k-world 1 pre-commit in k's lane; committed 0 via b. ✓

- T2–T8: as harden (re-run; TS substitution only). ✓
- **T9 (I17/TKC-3B)** ‡S: harden's walk with propagation now also
  **delivering**: step 3's edge acquisition (c gains dep a with
  TS(a)∋k) flows bit k through c→n→m AND queues runInBatch(k, setState)
  for watched m — the flag-only counterfactual and the delivery hole are
  both closed. ✓
- **T10 (the HX-3 schedule — new)** ‡S:
```
setup | flag=false, a=0, c=flag?a:0; W on c (K0 dep {flag}); T1 has unrelated React work
1 | T1: a.set(1) | tape(a)+={1,T1,s1}; a has no out-edges → walk marks a only; W NOT scheduled in T1
2 | T2: flag.set(true) | K0 walk flag→c → W scheduled in T2; TS(c)∋T2
3 | joint {T1,T2} pass evaluates c | fold: flag=true, a=1 → 1; K1 edge a→c recorded ‡S: newBits = TS(a){T1} & ~TS(c){T2} = {T1} → TS(c)|=T1; c watched → queue delivery bit T1 (in-render → drains at the pass's yield/end edge): runInBatch(T1, setState(W)) — a REAL pending update in T1's lanes, surviving pass discard
4 | pass discarded; T2 renders alone | W re-renders via its T2 update: c in wT2 = flag(true)?a(0-excl-T1):0 = 0 ✓ commits 0; T2 retires (vS mints)
5 | T1 renders | W's T1 update pending (step 3) → re-renders fresh → wT1 = {T1}∪retired: flag=true, a=1 → c=1 ✓ ONE consistent T1 commit — no bailout tear
outcome: edge-add propagation carries retroactive lane delivery; the reach induction's premise is restored by construction.
residual: queued-delivery drain ordering — fork test 14-class pin; retired-in-queue → fixup/backstop fallback.
```
- **T11 (staged evaluator; HX-1's dual-closure schedule)** ‡S: T renders
  hook with new prop → stages f_B in T's frame (node keeps committed f_A);
  T yields. U renders same fiber with committed props: deps == committed →
  no stage → evaluates M(c, wU) with f_A → commits A-consistent frame ✓.
  Yield-gap NEWEST read (CX-1): k0.pull uses the committed evaluator f_A ✓.
  T resumes: its staged f_B; M(c, wT) records staged fnStamp → c per B ✓.
  T commits → hook commit effect promotes f_B. Discard variant (HC-F2):
  staged table dies with the pass; committed-world effect flush evaluates
  f_A — the uncommitted closure is unreachable ✓.

### C2 — flushSync excludes a pending default batch

As harden C2 ✓; **C2-M (the HX-6 mount variant)** ‡S: W mounts inside the
flushSync pass; fixup: TS(a)∋D, D live+written (default!) → loop includes
D → runInBatch(D, setState(W)) → D's later render re-renders W fresh →
reads {D}∪locked → 1 → one consistent D commit ✓ (was: bailout tear).

### C3 — rebase parity (+ C3-E)

As harden C3: 2, 2, 4, 4; plain-set 5; compaction of s2 blocked behind
unretired s1 (CH-4's rule stated, oracle-pinned) ✓. **C3-E (LX-8)** ‡S:
custom group-equality; fold(U-only): base A → set C: ¬isEqual(A,C) → C ✓;
fold(T+U): A → set B → set C: isEqual(B,C) → keep B (ref-stable, equals
K0 newest) ✓ both representatives correct by stepwise stabilization.

### C4 / C5 / C6 — as harden ✓ (no prune/suppression exists; per-write
full walks; per-(watcher, slot) dedup; D10 delivery; C6 handle-it by
construction).

### C7 — yielded pass (+ C7-D)

As harden C7 (shared line, pin retention → fingerprints stable under live
pins) ✓. **C7-D (HC-F3)** ‡S: React-state-only transition → RENDER_NEWEST;
fresh X reads a=0 via K0; yield; click writes a=1 → write path demotes the
binding ‡S → resume routes wT=(mask, original pin): Y's read
world-evaluates → folds a=0 (click excluded by pin) → X and Y agree ✓ the
pass observes ONE world at the read level; no reliance on fixup rescue.

### C8 — as harden ✓ (always-log; equality lives in stabilized folds and
delivery-vs-rendered compares only).

### C9 — mount mid-transition — as harden ✓ (staging now also carries the
evaluator; fresh nodes world-route by ¬CT; promotion hook-grain — LX-2's
fallback-commit publishes nothing for the abandoned subtree, walked:
error-boundary fallback commits → X's hook effects never run → staged
node+fn reclaimed at pass/lineage death; retry evaluates fresh ✓).

### C10 — late subscription (+ C10-R′)

As harden C10 (fixup now over touched ∩ all-live-written) ✓. C10-R′: k
retires inside the mount window → R11 guarantees the fold precedes layout
→ committed compare sees post-fold values → pre-paint urgent correction ✓.
Post-completion write window (LX-3 class): write lands after W′'s pass
completed, before commit — walk reaches the node; W′ unregistered → no
setState; at layout the fixup's live-token loop schedules runInBatch(t) —
F4's obligation makes it real work for t's lanes → t's render includes W′
✓; the just-landed commit is internally consistent (pre-write world) — not
torn; C10-R's bounded-correction bar met.

### C11 — multiple roots, full spanning (+ C11-W)

As harden C11 steps 1–8 (I19 clear now includes watermarks) ✓.
**C11-W (LX-1)** ‡S:
```
1 | async action T writes a=1 @s1 | carrier scope; parked
2 | root A renders {T} at pin p1 ≥ s1; commits | lockedIn(A) += (slotT, watermark=p1) ‡S; effects on A see a=1 ✓
3 | post-await continuation: a.set(2) @s2 | carrier restores T (R7) → slot T, seq s2 > p1; walk delivers W setStates in T's lanes
4 | urgent render on A | world {U} ∪ locked(A): T-clause admits seq ≤ min(pin, p1) → s1 only → a=1 ✓ A never contradicts its committed DOM (was: s2 leaked pre-commit)
5 | A renders T's new update; commits | watermark advances to that pass's pin ≥ s2 → a=2 committed-for-A ✓
6 | action settles; T retires everywhere | retired clause takes over unconditionally; fold; vS mints; bits+watermarks cleared before slot release ✓
outcome: lock-in is a write-prefix; store-only post-await writes on uninvolved roots surface only at retirement (C12-consistent).
residual: watermark source must equal the committed pass's pin — fork test 17.
```

### C12 — store-only + async actions (R7) ‡S

Steps 1–2 as harden (fold on committed=false; targeted effect flush sees
5, and keeps re-running correctly after compaction — visStamp + baseSeq).
3′: sync prefix under token k (carrier pushed); post-await **raw**
`a.set(2)`: carrier restores k → receipt slot k, **parked** — nothing
commits before settle ✓ (C12's Required verbatim; HX-5 closed). Two
interleaved actions keep distinct tokens; a click between continuations
classifies under its own event token (lean's carrier walk, adopted).
Settle → retire → fold in seq order → 2 ✓.

### C13 — lifecycle soundness

Walked as the §15 inventory: adds visStamp (renumber-rewritten), epoch
mints (globalSeq line), watermarks (cleared with bits at retire),
pending-compaction drain (HX-7's schedule: pass-held pin → retire blocked
→ pass ends → sweep folds → quiescence proceeds ✓), staged-evaluator
tables (die with frames), refresh-exempt carry set (bounded, re-derived
each episode). Forced batteries: episode collision, seq renumber + hard
horizon (including codex's never-quiescent variant — the throw is the
named behavior), token wrap under 31 parked actions, K1 2-bit tag, slot
recycle with watermarks. ✓

### C14 — StrictMode (+ LX-4)

As harden C14 ✓ plus ‡S: staged evaluators — double render re-compares
deps against the staged entry → idempotent (same staged stamp); discarded
sibling's staging dies with its pass; **render-phase setState restart**
(LX-4): the restart render's deps compare against the pass's staged entry
→ new stage + new stamp → memo conjunct fails → re-eval with the new
closure → committed output matches committed state ✓. Render-phase signal
writes still throw at the guard's first line (queue untouched).

### C15 — suspense across worlds (R6/R14) ‡S

```
1 | k suspends c | lineage Lk: entry (c,Lk,0) = {th, prefix=[(a, fp′(a,wk))...]+[evaluator stamps], gen}; M(c,wk)=SUSPENSION{thRef, back-ref}
2 | mount mid-transition reads c | same lineage; pure → same reads → prefix pairwise-equal → SAME thenable ✓ (known-bug parity)
3 | intra-batch write to prefix dep d | wc[k] bumps; retry eval: fp′(d) moved → prefix mismatch at position 0 → entry replaced, fresh fetch (factory invoked — R14), old settle gen-checked no-op ✓ (I20); write to non-prefix atom → identity stable, no thrash ✓
4 | settle → retry | gen check → kill M(c,wk) via back-ref; belt covers the race; retry: NEW pass, new pin/worldKey — prefix compares receipt-line facts, all unmoved ‡S → SAME entry → settled value, same identity ✓ (HX-4's livelock dead)
5 | cross-batch retirement between fetch and retry (HC-F1 Schedule B) ‡S | D retires; D touched prefix-atom a → vS(a) minted → fp′(a) moved → prefix mismatch → refetch from the moved world ✓ (stale-world replay dead)
6 | unrelated urgent retirement (LC-F1's storm) ‡S | retired slot touched NO prefix atom → no vS mint on them → prefix stable → SAME entry, no refetch, transition commits ✓ starvation excluded by construction
7 | commit/abandon; RENDER_NEWEST boundary | lineage drop regardless of settlement; one duplicate fetch/identity flip max at the boundary — as harden ✓
outcome: identity = lineage; validity = receipt-line content; all three C15 traps (passSerial, mask drift, global-clock starvation) excluded.
residual: prefix determinism rests on purity (C14 pins); factory contract — R14 conformance test.
```

### C16 — effects observe committed state only (+ C16-B1′) ‡S

Steps 1–3′ as harden ✓. **B1′/HC-F1-A**: k1(+5@s1) pending, k2(×3@s2)
commits on R → flush re-runs, snapshot [(a, fp′=s2)]. k1 then
commits/retires ‡S: vS(a) minted → fp′(a) = max(s2, bS, rS, vS) = vS ≠ s2
→ re-run → effect sees 15 ✓ (was: silent forever-stale). Lock-in-only
multi-root variant: the lock-in mints vS too ✓. Compaction variant (judge
B1) unchanged ✓. Targeted flush: only enqueued effects compare (G-R).

### C17 — optimistic rollback

Not exposed [=H]: no truncation surface; ReducerAtom composes optimistic
UI; nothing depends on truncation.

### T8-N — cross-episode notification (synthesis-discovered; walked)

```
setup ep1 | cnd=true committed; w's basis edges recorded only in K1 (w never K0-evaluated this episode); quiescence approaches
1 | quiescence sweep ‡S | refresh: w is K1-touched with a committed watcher → k0.pull(w) at NEWEST → K0 re-tracks x→u→v→w (donor recursion through stale upstream); THEN K1 resets
2 | ep2: k writes x | walk follows the refreshed K0 edges → W delivered in k's lane ✓ (without the refresh: no edges anywhere → silent torn k-commit — the schedule that motivates the transplant)
3 | writing-computed variant | refresh pull writes → token minted → quiescence ends; sweep finishes; next attempt: same node writes again → refresh-exempt: its K1 in-edges carried into the fresh plane → reach preserved (over-notify only); episode resets ✓ (LC-F3's livelock dead)
outcome: the reach induction's basis-edge premise holds at every episode boundary.
residual: refresh cost O(touched watched nodes) at quiescence — priced in G-R's class; exempt-set growth bounded by writing-computed count (dev-warned).
```

## 18. Rejected variants and known gaps

Rejected (this round's additions to harden §18's list): frontier pruning
(CH-1/CH-2); evaluate-cutoff suppression (CX-2 + CH-1 — proposed scar);
pinless memo keys + retire ring as defaults (CH-3/CX-5/CH-6 — survives
only as SPK-G8's specced fallback hybrid); full-token lock-in (LX-1);
pass-grain publication (LX-2); global retireClock resource keys (LC-F1);
ambient post-await classification (HX-5); prod untracked fold reads
(CX-3); max-only fingerprints (HC-F1); single mutable evaluators (HC-F2).

Known gaps: G1 (fan-out re-walk cost — SPK-N1, NM-1), G2 (restart-heavy
revalidation — SPK-G8, NM-2), G3 (union-K1 over-notification, priced),
G4 (fork registry facts need current-generation proof — tests 2/3/4/13/
16/17/18 on the critical path; still the biggest external risk), G5 (SP2),
G6 (fixup bound in harness), G7 (first-touch world evals), G8 (LOGGED-
quiet residual — SPK-L, NM-3), G9 (mid-episode abandoned-node sawtooth),
G10 (browser carrier host-hook feasibility — SP-F8; loud-failure rule if
a host cannot support it).

## 19. Mechanism inventory (10)

1. **K0 donor kernel, twin builds** (DIRECT = donor bytes; LOGGED op-table
   swap) — §4.
2. **Tape + base/baseSeq + one globalSeq line + equality-stable folds** —
   §5.1–5.2 (R15).
3. **Slots/masks/pins + watermarked per-root lock-in + closed mask
   lifecycle** — §5.2–5.3 (R13, I19).
4. **Closed change-source validity** — table S1–S7 + S2b visStamp + staged
   S3 + globalSeq epochs; unified predicate + ladder; CI audit sweep —
   §8 (R1/R2/R10).
5. **World memos (EVALUATING marks) + lineage thenable caches with
   flattened-prefix content validity + lazy factory + settlement kill** —
   §9 (R6/R14).
6. **K1 + E-PRESERVE + touchedSlots/propagate-with-delivery + invariant-R
   routing + RENDER_NEWEST demotion** — §6 (R3/R5).
7. **Notification walk** — per-write full reach, writer-context setState,
   per-(watcher, slot) dedup, targeted effect enqueue — §10.
8. **Watcher records + mount fixup (touched ∩ all-live + committed
   compare) + reconcile backstop + retire/lock-in effect flush** — §11
   (R8).
9. **Fork protocol F1–F8** — carrier F8, F3 ordering, F4 obligation; 18
   fork tests — §12/§14 (R7/R11).
10. **Episode lifecycle** — retirement folds with pin retention +
    pin-release sweep, quiescence refresh + resets, staging (node +
    evaluator), counter/allocator guards — §5.3–5.4/§15 (R9, T8-N, R2).

## 20. Test plan (delta over harden §20, inherited whole)

Adds: fingerprint-vs-oracle differential **with cross-batch out-of-order
retirements and lock-in-only variants** (HC-F1's ask); staged-evaluator
battery (dual-pass, discard, StrictMode restart — HC-F2/HX-1/LX-4);
edge-add retroactive-delivery fuzz (reachable-receipt ⇒
delivered-or-scheduled — HX-3/C1-T10); prefix identity/content battery
(retry stability across pins, visibility-flip refetch, unrelated-
retirement stability — HX-4/HC-F1-B/LC-F1); watermark battery (C11-W +
fork test 17); carrier matrix (fork test 18 + self-test failure); fixup
window battery incl. default-batch mounts (HX-6) and
mount-inside-own-commit (HC-N1); pin-release compaction + never-quiescent
horizon (HX-7/CX-7); fold-equality per-view differential (LX-8); fold-read
throw conformance (CX-3); W1/W2/W3/W5 as permanent CI perf rows.

---

*End of repaired design. 10 mechanisms; 8 protocol facts (~12 reconciler
sites, 18 fork tests); battery walked in full (C1 a family of 11, plus
C2-M/C3-E/C7-D/C11-W/T8-N); adjudication: 39 findings — 39 confirmed, 0
refuted, 3 needs-measurement registrations; 7 spikes; repairs R1–R15 +
T8-N, all inside the champion architecture.*
