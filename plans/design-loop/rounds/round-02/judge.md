# Round 2 judgment — synthesis.md (harden + R1–R15 + T8-N)

Judge, round 2. Inputs read: `synthesis.md` (and its incorporated base text
`design-harden.md`, which the synthesis makes part of the final design via
`[=H §n]`), all of SEEDS/, NOTES/INVARIANTS.md, NOTES/SCARS.md,
NOTES/DECISIONS.md, NOTES/OPEN.md. Not read: any review, any prior round.
All walks below are my own re-derivations; where I cite the design's walk I
re-executed it first.

## 1. Battery re-walk

Mandated full-depth cases (C1, C2, C4, C6, C7, C13) executed step by step;
all others verified against the design's own walks for hand-waved steps.

### C1 (full depth) — world-divergent dependency, family of 11 — PASS

Core: (1) k: `flag.set(true)` → guard ok, receipt {true,k,s1}, wc[k]=s1,
K0 newest, walk K0 edge flag→c: TS(flag)|=k, TS(c)|=k, W setState in k's
stack (NM|=k). (2) k pass (mask{k}, pin s1): W re-arms, reads c → TS≠0 →
world eval: flag folds true (K1 flag→c), branch reads a: TS(a)=0, empty
tape → k0.value 0, K1 edge a→c recorded (newBits = TS(a)∅ & ~TS(c) = 0);
M(c,w1)=0 — the trap cache. (3) k: `a.set(1)` → receipt s2, wc[k]=s2;
notifyWalk over K0∪K1 follows the REAL K1 edge a→c → W's re-armed bit k
clear → setState in k's lane. (4) k re-render at pin s2: new worldKey (or
wc[k]=s2 > memo.seq) → fold a = 1 → c=1 in k's lane before commit. (5)
Committed read: fold flag=false → b → 0. Matches Required; the
canonical-topology trap (I3/S2) is dead because the k-world evaluation
itself recorded the divergent edge and the walk traverses both planes.

Variants re-derived: T2 over-invalidation only (per-world valueStamp
cutoff keeps downstream quiet); T3 fold {true@s1,false@s3} → b; T4 U-write
to b invisible in wk (slot∉mask, unretired) → k memo revalidates, U's
render correct; T5 mask-parity (F2) makes the fold answer equal React's
under either scheduling — the honest parity answer; T6 slot hygiene (wc
zeroed at intern, NM/lockedIn/watermark/touched cleared at retire/recycle,
epoch-keyed memos); T7 lineage-scoped suspension dies with the abandoned
joint pass, gen-checked late settle; T8 freshness conjunct (I12) routes
stale-unflagged to world eval; T9 staged-evaluator + delivering
propagation closes both the flag hole (I17) and the delivery hole; T10
(HX-3 schedule) — I re-executed the synthesis trace: the joint eval's edge
acquisition flows bit T1 into c AND queues runInBatch(T1, setState(W)) at
the pass edge, a real pending T1 update surviving the discard; T1's later
render shows c=1 in one consistent commit. T11 dual-closure: U evaluates
with committed f_A, T's resume with staged f_B, yield-gap NEWEST with
committed — no world ever sees an uncommitted closure (HC-F2/HX-1/CX-1
class dead). Residual noted by the design (queued-delivery drain ordering)
is real and pinned to a fork test — acceptable.

### C2 (full depth) — flushSync excludes pending default D — PASS

(1) `a.set(1)` under D: receipt (always-log, I1), wc[D]=s1, K0 newest 1,
walk marks TS(a),TS(c)|=D and delivers in D's context. (2) flushSync pass:
F2 mask excludes D; not RENDER_NEWEST (live excluded receipt ⇒ selection ≠
newest). (3) read a: TS∋D → fold: D's entry retiredSeq=0, slot∉mask,
slot∉lockedIn → invisible → 0. (4) read c: world eval → 10. Both, in one
frame. The two C2 traps are closed by the receipt and by write-time cone
marking. C2-M (mount inside the flushSync pass): fixup loop runs over
touched ∩ ALL live written tokens — default D included (R8) →
runInBatch(D, setState) → one consistent D commit; committed compare is a
no-false-positive fallback. PASS.

### C3 — rebase parity — PASS (verified walk)

2, 2, 4, 4 re-derived from the fold math; compaction of ×2@s2 blocked
behind unretired +1@s1 (prefix-only rule — CH-4's inversion
unrepresentable); plain-set commits 5. C3-E: stepwise equality-stable
replay returns the correct representative per view (U-only → C, T+U →
stabilized B). I2/D3 hold clause-for-clause.

### C4 (full depth) — two-batch write into stale region — PASS

T1 write: full-reach walk, setState in T1, NM={T1}. T2 write before any
re-render: the walk is per-write with a fresh ticket — touchedSlots is a
routing mark, never a walk-stopper — NM bit T2 clear → setState in T2's
context. Both lanes render W. I5's granularity (per-(watcher, slot),
re-armed on render) is exactly what the case demands; no once-per-staleness
state exists to fail.

### C5 — PASS (verified). Value-blind delivery + unconditional clock bump;
second write invalidates via wc[k]=s2 > memo.seq; ladder recomputes 7.

### C6 (full depth) — grouped notification — PASS (handle-it)

`batch()` defers core-effect flush only; delivery is synchronous per write
in the writer's context (D5/D10): `a.set(1)` delivers under the urgent
event token, `startTransition(() => b.set(2))` delivers inside the
transition scope → transition lanes. No implicit grouping exists anywhere
— stated, and the mechanism inventory contains no coalescer to violate it.

### C7 (full depth) — yielded pass — PASS

Yield flips per-callstack currentWorld to NEWEST (F2/I6): handler read =
k0.pull newest; handler write passes the guard (pass binding empty),
classifies under the click token, delivers urgent. Click retires at sr > p
on the shared line; compaction pin-blocked (sr > min live pin) → base
unmoved. Resumed pass folds under (mask{T}, pin p): click entry fails both
clauses → excluded. One flag from me: after C's retirement, visStamp(a)
mints, so fp′(a, wT) moves and the resumed pass's first read re-folds once
(same value, valueStamp kept) — the harden C7 text's "revalidate WITHOUT
recompute" is stale under R1; the synthesis's own S2b note ("one ladder
re-fold per touching commit, safe direction") is the operative claim.
Correctness unaffected; cost claim honest. C7-D: R3 demotes live
RENDER_NEWEST bindings at the first logged write (original pin retained) —
X and Y read one world at the read level; the demotion is sound because
RENDER_NEWEST classification plus "first logged write demotes" guarantees
K0-served reads before the write equal the pinned fold.

### C8 — PASS (verified). Always-log; U's equal write folds to 1 in U's
world; equality only in stabilized folds/compares (I7/S8 respected).

### C9 — PASS (verified). Existing node: pass-world routing on first
render. Fresh node: no K0 record ⇒ ¬CT ⇒ world-routed by the ordinary
rule (the stated mechanism), K1 edges recorded, staged (S15), promotion
hook-grain — the LX-2 immunity construction (promotion runs iff the
hook's own subtree committed) survives my error-boundary/fallback attack.

### C10 — PASS (verified). runInBatch into every touched live token (no
equality filter, I13); retire-inside-window covered because R11 orders
fold before layout, so the unconditional committed compare (I18) sees
post-fold values; post-completion window covered by F4's stated obligation
(updates into a completed-not-committed pass schedule further work).

### C11 (+C11-W) — PASS at declared FULL-SPANNING scope

Harden steps 1–8 verified (per-root lockedIn, single retirement at last
root, I19 clears). C11-W re-derived: watermark = committed pass's pin;
committed-for-A admits slot-T entries only to seq ≤ min(pin, p1) → the
post-await s2 write (carrier-attributed to parked T) cannot leak into A's
urgent render pre-commit; watermark advances at A's next T-commit; retired
clause takes over at settle. My attack (retired clause unconditional
exposing s2 "early") fails: retirement occurs only at settle+last-commit,
after which global visibility is exactly React's own post-commit
semantics. Sync batches: every write predates first commit ⇒ watermark ≡
plain clause (round-1 behavior preserved) — construction present and true.

### C12 — PASS. Fold-on-retirement regardless of subscribers (D2/S4);
async action: carrier attributes the raw post-await write to the parked
token — nothing commits before settle (C12's Required verbatim; HX-5's
parity argument correctly overridden by the frozen seed). Interleaved
actions/clicks keep distinct tokens. The browser feasibility of the
carrier is the honest open risk (below).

### C13 (full depth) — lifecycle soundness — PASS

I inventoried every counter/mask myself: globalSeq (renumber at quiescent
margin rewriting baseSeq/fnStamp/reducerStamp/visStamp/lastRenderSeq;
hard diagnostic throw at the never-quiescent horizon; forced-small builds);
slotWriteSeq (zeroed at intern and recycle); slot ids (unswept=0 gate; NM,
lockedIn bit+watermark, touchedSlots bits via touchedList all cleared at
retire/recycle); worldMemoEpoch (now globalSeq-minted, R10 — inherits the
horizon machinery, HX-8 closed); episodeEpoch + 16-bit K1 tag with
wrap-clear (missed-notification claim corrected); walkTicket wrap; lineage
gens; staged-evaluator tables (die with pass frames); pending-compaction
list (drained at pass-end min-pin advance — HX-7's unreachable-quiescence
closed, forced test named); refresh-exempt carry set (bounded, re-derived
per episode); token serials (live-skip, 31-parked forced test). Every
reset is paired with an epoch/GEN/renumber guard (I8/I19), and the two
§15 tables are schema-sweep-enforced. Cross-episode validation of any
stale record is blocked by epoch-in-key, tags, or column clears. No gap
found.

### C14 — PASS with one flagged assumption. Render-phase writes throw
before any mutation; replays are keyed-idempotent; staged evaluators
re-stage idempotently by deps compare; LX-4's restart mints a new staged
stamp → re-eval. The walk's thenable-identity claim relies on hook/node
identity being stable across same-pass restarts and replays — the design
stipulates the staged table is found again by the restarted render but
gives no construction for how (fiber/hook keying). Within-pass this is a
plausible binding fact; see finding N1 for the cross-pass composition.

### C15 — PASS. Identity = lineage (D11); validity = flattened
receipt-line prefix (R6): I verified retry-stability (new pin does not
move newest-visible seq absent included writes), included-write refetch
(wc + fp′ move), visibility-flip refetch (visStamp, HC-F1 Schedule B),
and unrelated-retirement stability (visStamp is touched-atom-scoped —
LC-F1 starvation excluded). Multi-batch key + lifetime stated. Canonical
never consults lineage caches. Lazy `ctx.use(factory)` fixes LX-7's
double-fetch honestly.

### C16 — PASS. Committed-for-root excludes applied-uncommitted D;
trigger inventory (commit / retirement-microtask / unmount) is I14's
enumeration; B1′ re-walked: k1's late retirement mints visStamp → fp′
moves past the s2 max → re-run sees 15. The lock-in-only variant works
provided the commit-triggered flush seeds from the slot's touchedList —
see finding N3.

### C17 — PASS by deletion (no truncation surface; permitted by the case).

### T8-N — PASS, and the discovery is to the synthesis's credit. I
attacked the refresh scope: watched/effect-dep enumeration is feasible
without a K1 list (watcher/effect registries + K1-column check); unwatched
nodes are safe on read via ¬CT/first-divergence (I4); the K1-only-basis
delivery gap is real (I4 does not apply when no K0 record exists) and the
refresh restores exactly the premise the reach induction needs.
Writing-computed livelock closed by one-retry-then-exempt-carry.

## 2. Construction audit ("by construction" claims)

- **Invariant R (routed serve)** — construction present (CT + E-PRESERVE +
  invariant M + purity + I12 freshness conjunct). Attacked with S9's
  schedule and the yield-gap twin: both route to world eval. HOLDS.
- **Invariant M (per-slot marks, delivering propagation)** — induction
  over four event kinds present; attacked via HX-3's own schedule (closed
  by queued per-bit deliveries), StrictMode re-record (edge-exists probe ⇒
  no duplicate delivery), edge removal (monotone over-approximation).
  HOLDS. Residual: drain ordering at pass edges (fork-test pin, named).
- **LX-2 unrepresentable (hook-grain promotion)** — construction: commit
  effects run iff the subtree committed. Attacked with error-boundary
  fallback commit: staged state dies with the pass. HOLDS.
- **C6 by construction** — no grouping mechanism exists in the inventory;
  per-write synchronous delivery. HOLDS.
- **Watermark ≡ plain clause for sync batches** — every sync write
  predates first commit; arithmetic checks. HOLDS.
- **CH-3 class unrepresentable (epoch-in-key)** / **TKC-6 unrepresentable
  (bit+watermark cleared before slot release)** / **B1 dead (minted
  monotone stamps)** — all present; B1 additionally needs visStamp to mint
  on stamp-only (pin-blocked) retirements — §3's "stamps/folds" wording
  covers it but §5.3's step 2 reads fold-anchored (finding N2).
- **LC-F1 starvation excluded** — visStamp touched-scoped; verified at
  C15 step 6. HOLDS.
- **R6 retry-stability by purity** — movers enumerated (S1/S2b/S3);
  matches the closed table. HOLDS.

No unaccompanied by-construction claim found.

## 3. Findings (0 confirmed blockers; 5 notes)

- **N1 (plausible, cross-case composition)**: a FRESH `useComputed` node
  that itself suspends on initial mount mid-transition. Suspense retries
  are new passes; staged evaluator tables and (per C9b2/C14) staged node
  mints die with the pass; if React/the fork does not preserve hook-cell →
  node identity across retry passes, the (node, lineage, position) key
  churns per retry → new thenable each retry → C14's "or React re-suspends
  forever" arm. The battery's C15 uses an existing computed and C9's fresh
  nodes do not suspend, so no specified case fails — but the design's C14
  walk silently assumes node-identity stability it only stipulates
  within-pass. Ask: one sentence of mechanism (e.g., node keyed by
  (lineage, fiber, hookIndex) or a fork-guaranteed hook-state retention
  fact) + a battery row. Not counted as a confirmed blocker: the fork owns
  the needed fact and every stated schedule walks.
- **N2 (wording)**: visStamp must mint on retirements whose compaction is
  pin-blocked (visibility still flips for unpinned worlds). §3 says
  "stamps/folds"; §5.3 step 2 can be read fold-only. Make the mint
  unconditional per touched atom at retirement and add the pin-blocked
  variant to the C16-B1′ battery.
- **N3 (under-specified seeding)**: with the targeted effect queue (G-R),
  commit-triggered (lock-in/watermark-advance) flushes must seed from
  touchedList[slot] for the committing slot — otherwise a write-time queue
  entry consumed by an earlier unrelated flush leaves the later lock-in
  flush with nothing to compare (I14's exact class, lock-in face). The
  retirement path states its seeding; the commit path should state it too.
  The B1′ lock-in variant depends on it.
- **N4 (design-flagged)**: R5's queued in-render deliveries — drain
  ordering and retired-token fallback are correctly pinned to fork tests;
  keep them on the critical path.
- **N5 (ordering hygiene)**: within the hook's commit effect, promotion
  must precede the fixup's committed-world evaluation, or a fresh node's
  committed evaluator is undefined at compare time. Consistent with the
  text; deserves an explicit sentence + the S15 ordering test.

## 4. Scores

- **correctness = 9.** All 17 cases + the design's extensions walk; I
  re-derived the six mandated cases at full depth plus C3, C5, C8–C12,
  C14–C16, T8-N and found no wrong-value schedule. The repairs are real:
  every round-2 kill class I could reconstruct (visibility-flip
  fingerprints, dual closures, edge-after-receipt delivery, watermark
  prefix, carrier attribution, default-batch fixup) is closed by a walked
  mechanism, not prose. Withheld point: N1's unpinned identity assumption
  and N2/N3's load-bearing wording — each is one sentence plus one test
  away, but each sits under a torn-frame or livelock class.
- **mechanisms = 7.** My own count at the granularity INVARIANTS uses:
  ~13 cooperating concurrency parts (tape/folds; slots+watermarked
  lock-in; clock/epoch/fingerprint validity; K1 edges; touchedSlots with
  delivering propagation; routing + RENDER_NEWEST demotion; notification
  walk + dedup; fixup + backstop + effect flush; lineage/prefix suspense
  caches; staged evaluators; carrier F8; episode lifecycle incl. refresh;
  twin builds) — the inventory's "10" is fair only at coarse grain. The
  redeeming quality is that the obligations are overwhelmingly structural:
  a closed change-source table with a CI sweep, two sweepable lifecycle
  tables, an induction over four event kinds, an enumerated trigger
  inventory. Genuine completeness-prayers are few and named (purity
  closure argument with a DEV assert; E-PRESERVE under SP2; fork facts
  under G4). It is a large machine whose proofs are auditable — high for
  enumerability, penalized for sheer part count and their coupling (R5
  alone couples marks, walks, and lane delivery).
- **seam = 8.** All six charter-required protocol facts present and
  versioned (F1–F5 + parking; F6 kept); additions (F7 handshake, F8
  carrier, watermark data, R11 ordering clause, F4 obligation) each earn
  their place against a battery case. Rebase drill answered per scenario
  with "library moves zero lines" and named tripwire tests; ~12 touch
  sites; 18 reconciler tests; inertness and loud version-skew per the
  hard rules. Withheld: F8's carrier reaches beyond the reconciler into
  host async machinery (the least stable seam surface, G10), and G4 is an
  honest admission that the registry facts are proven only on the
  previous-generation fork.
- **performance = 8.** Every hot mechanism carries a numeric gate wired
  to a spike with a decision rule; DIRECT = donor bytes is the strongest
  possible P2 answer and is measured [ARENA]; always-log ≤2× and the
  fan-out warnings match research-facts; I11 is respected (values stay
  in-plane; no storage migration). Honesty is exemplary: G-Q is declared
  AT RISK against P3's ≤2% with a measured 2.4–3.8% floor and a
  pre-registered renegotiation — flagged, not wished away. Withheld: five
  of seven spikes are still queued, one requirement-level gate is at
  risk, and visStamp's over-invalidation (one re-fold per touching
  commit on pinned worlds) is priced only qualitatively.
- **explainability = 7.** The one-page summary does cover all ten
  inventory items I counted, in order, and the concepts section defines
  terms before use. Penalized: the final design is a delta document — a
  reader must interleave synthesis §n′ with harden §n to get one
  mechanism's full statement (the C7 cost claim I caught stale is a
  symptom); and the summary leans on house vocabulary (visStamp,
  lock-in, fold) faster than a newcomer can absorb. A consolidated
  restatement next round would buy a point.

## 5. Open architecture-relevant spikes

**1 — SP-F8** (browser continuation-carrier feasibility, gap G10). The
carrier is the load-bearing mechanism for C12's frozen Required; the
rejected alternative (ambient classification) is a confirmed blocker
(HX-5), and no in-architecture fallback exists — "loud startup failure"
forfeits R5 async parity on the primary deployment target. If a browser
host cannot provide continuation identity (native-await continuations are
not intercept-able from userspace JS without AsyncContext), the async
attribution architecture changes. This is the one spike whose failure
moves architecture rather than swapping a specced fallback (SPK-N1 →
per-slot-mark dedup and SPK-G8 → pinless-frontier hybrid are pre-designed
mechanism swaps; SPK-L → gate renegotiation is a requirements decision).

## 6. Verdict

```
VERDICT
new_confirmed_blockers: 0
scores: correctness=9 mechanisms=7 seam=8 performance=8 explainability=7
open_spikes_that_could_change_architecture: 1
exit_recommended: no   # blockers=0, but SP-F8 (carrier feasibility) is architecture-relevant and open; G4 fork facts also unproven on the current base
one_line: The champion's round-2 repairs all hold under independent re-walk — zero confirmed blockers across the full battery — but the async-action carrier's browser feasibility (SP-F8) is an open, architecture-relevant spike, so the design is sound on paper and not yet exit-ready.
```
