# cosignal v1 — pre-registered performance gate battery

Date: 2026-07-05. Runner: packages/cosignal/bench/*.mjs (new; nothing in
harness/ touched). Sources of the pre-registered rules: spec/cosignal-v1.md
§7 "Gates and numbers" + §8 "Spike gates" tables; design-loop/NOTES/OPEN.md
"Spike queue". This stage MEASURES AND REPORTS ONLY — no fallback or
optimization was implemented; the eleven TODO(gate:...) sites in
packages/cosignal/src/logged.ts are untouched.

## Machine context (recorded once, before the battery)

- Apple M4 Max, 16 cores, macOS (Darwin 25.5.0), node v24.16.0.
- `uptime`: up 3 days 17:04, load averages 3.99 2.49 2.00 — **NOT an idle
  machine**. Top CPU consumers at start: claude CLI (25.6%), loginwindow
  (9.2%), coreaudiod (8.4%), wezterm-gui (8.3%), MTLCompilerService (8.1%).
- Methodology: one measurement config per child process
  (`node --expose-gc --import tsx`, cwd=harness/ for loader resolution;
  children import src by absolute path — no bundling, module-scope `const`
  preserved). Median of ≥5 process runs unless noted; medians AND
  [min..max] ranges reported; checksums printed in every child to defeat
  DCE. LOGGED children truncate the public `bridge.events` array between
  reps so an earlier rep's event log cannot skew later reps (the per-write
  event *append* stays inside the timed region — it is part of the armed
  write price by construction).

Build note that frames every gate below: the shipped packages/cosignal
LOGGED overlay is the **oracle-shaped reference build** — its walk is
`refreshEdgesAllWorlds()` (re-evaluate every computed in every live world
per write), it has **no walkGen stamp**, no touched-word drains, no §5.6
read routing / §5.7 memo ladder. Those are exactly the three deferred
TODO(gate) families the gates decide about. Gate failures below therefore
read as "the deferred optimization is REQUIRED", not as new information
about the spec's mechanisms.

---

## Gate table (summary — filled in as gates run)

| gate | headline numbers (median) | pre-registered rule | verdict | fallback (named, NOT implemented) |
|---|---|---|---|---|
| SPK-W | logged write 78 ns (bare) … 5362 ns (fan8) vs DIRECT 4.6–230 ns → **17.2×–40.4×** | "Logged write ≤ 2× a DIRECT write" | **FAIL** | inline-2 receipts; tape pooling (spec §8 write-price row) |
| SPK-N1 | propagate 6.7×–34.9× DIRECT (grid), 80.7× (held row); spurious ≤1/(watcher,batch,cycle) everywhere EXCEPT pinned-open-pass interleave = 32 | "propagate ≤ 2× DIRECT; ≤ 1 spurious render per (watcher, slot, cycle)" | **FAIL** (propagate clause; interleave row exceeds spurious bound but those deliveries are §5.9-mandatory) | per-slot-mark dedup (D13); per O24 NOT adoptable without its own walked schedule — report only |
| SPK-R core | retire/token 0.7–0.8× DIRECT batch() (strict comparator); 2.2–4.4× with 8 watchers drained | "retirement engine overhead ≤ 2× a DIRECT batch() on the identical write/effect graph" | **PASS** (strict); watcher-drain variant exceeds — the SPK-N1 drain TODO, disclosed | (comparator already the repaired split form) |
| SPK-R react | 1.26× (N8), 1.15× (N64) vs useState — coarse jsdom+act | "reconciliation ≤ 2× the equivalent useState render/commit for reached watchers" | **PASS** (coarse) | same spike |
| SPK-G8 | burst write cost ∝ total graph (G4→G64: 3.4→40.9 µs unheld) × live worlds; held tax 2.2–7.6×; retention 1281 receipts; typeahead 31.9 µs/key, prefix = 1 receipt/key | "cost ∝ flagged region; restart-heavy typeahead; prefix length" | **FAIL** (cost ∝ whole graph × worlds × retained tape, not flagged region) | pinless-frontier hybrid (O18); whole-mask clock vector (O21) — specced, report only |
| SPK-K1 | gate planes ~2710 MB/h; walk degradation +73.9% over 60 s; +7370 MB/h more if the event stream is retained | ">1 MB/h steady growth or >5% walk degradation ⇒ extend the mid-episode sweep predicate" | **FAIL** (both clauses, ~3 orders of magnitude) | extend the mid-episode sweep predicate (sampled reachability) — report only |
| SPK-L | quiet residual +11.8% (diamond) … +54.2% (broadIsolate); ranges non-overlapping with DIRECT | "LOGGED-quiet ≤ 2%; monitor pre-authorized to renegotiate ≤ 3%" (O19) | **FAIL on this machine** (not attributable to load; idle run still wanted for the certified floor) | mitigation ladder (compile-time splitting of untracked call sites; LOGGED rebuild tiers) |
| SP2 | resolved-by-construction; CI fuzz gate = 984 ms wall (304 seeds, per-step full-snapshot diff) | ">10% dev overhead → sampled validation" | **RESOLVED (no runtime validator exists to price)**; reopens with SPK-N1's incremental walk | sampled validation (only if a dev validator returns in v1.1) |

---

## SPK-W — logged-write price

**Pre-registered rule (verbatim, spec §7):** "Logged write | ≤ 2× a DIRECT
write | UNMEASURED → write-price spike (walk-generation stamp + taint
transitions priced here)". OPEN.md queue row: "SPK-W | logged-write price +
walkGen stamp + staging-walk/restart frequency (R3) + pass-aware dedup
check (R2) | >2× DIRECT → inline-2 receipts / tape pooling".

**Workload.** Mirrored shapes in both builds, one process per (build,
shape), 5 processes each, 7 timed reps/process (2 warmup), gc() between
reps. DIRECT: `atom.set(i)` ×100k/rep with synchronous effect propagation.
LOGGED: `bridge.write(token, atom, set(i))` in windows of 64 writes per
default-priority token, token retired (committed) between windows;
`writeNs` excludes the retire, `amortNs` includes open+retire amortized.
Values always change (no equality suppression). Shapes: bare (atom only),
chain3 (a→c1→c2→c3→core effect), fan8 (a→8 computeds→8 core effects),
watch1 (a→c1→1 committed watcher on one root; DIRECT comparator: effect —
closest notify-one-observer analog, mapping disclosed as approximate).

**Numbers (per-write ns, median [min..max] across 5 processes):**

| shape | DIRECT | LOGGED writeNs | LOGGED amortNs (+open/retire) | ratio | evals/write | events/write | deliveries+suppressed /write |
|---|---|---|---|---|---|---|---|
| bare | 4.6 [4.5..4.7] | 78.1 [76.8..79.6] | 182.0 [177.2..185.6] | **17.2×** | 0 | 1.05 | 0 |
| chain3 | 68.7 [68.1..69.4] | 2771.5 [2752.6..2817.5] | 2847.8 [2831.8..2905.4] | **40.4×** | 9.00 | 2.05 | 0 |
| fan8 | 230.2 [227.9..233.8] | 5361.8 [5314.9..5393.1] | 5439.2 [5411.8..5483.3] | **23.3×** | 16.00 | 9.05 | 0 |
| watch1 | 34.6 [33.9..35.1] | 1245.4 [1236.1..1268.0] | 1335.4 [1307.8..1355.1] | **36.0×** | 2.02 | 2.06 | 0.016 fresh + 0.984 suppressed |

**walkGen stamp cost:** N/A in this build — there is no walkGen stamp; the
staging-walk analog is `refreshEdgesAllWorlds()`. **Staging-walk
frequency: 1 per write** (measured via eval counters: chain3 = 9
evals/write = 6 refresh (memo-free recursive: 1+2+3 down the chain) + 3
core-effect flush re-eval; fan8 = 16 = 8 refresh + 8 flush — all on the
single newest world; each additional root/open pass multiplies the
refresh term, priced in SPK-G8). The bare shape isolates
receipt + K0-apply + event-append + reachability bookkeeping at ~73 ns
over DIRECT; every additional computed adds ~350–900 ns/write of
recomputed-union walk. The window open/retire adds ~100 ns/write amortized
at 64-write windows (bare: 78→182).

**Verdict: FAIL** (17.2×–40.4× ≫ 2× on every shape, ranges nowhere near
overlapping the budget).

**Fallback (named, per the pre-registration — NOT implemented):** inline-2
receipts / tape pooling, i.e. the TODO(gate:SPK-W) sites (int-packed
receipt columns {slot, seq, retiredSeq} + one unknown[] op side column +
tape pooling). Note the decomposition says receipt packing alone cannot
reach 2×: the dominant term on non-bare shapes is the per-write
staging walk (SPK-N1's touched-word family), and on bare the always-
allocated BridgeEvent append (~1 object/write) plus Map/Set bookkeeping
dominate. Per O24, no dedup-related fallback may be adopted without its
own walked schedule; this stage reports only.

---

## SPK-N1 — value-blind fan-out

**Pre-registered rule (verbatim, spec §7):** "Fan-out | propagate ≤ 2×
DIRECT; ≤ 1 spurious render per (watcher, slot, cycle) | UNMEASURED →
fan-out spike (value-blind grid + held-batch row)". OPEN.md queue row:
">2× DIRECT propagate or >1 spurious render/(watcher,batch) →
per-slot-mark dedup (D13)" — and O24: the D13 fallback "may not be adopted
on SPK-N1/SPK-W gate failure without its own walked schedule first (S17
re-entry risk)". On failure: REPORT ONLY.

**Workload.** Grid over (F watchers × B batches × W writes/frame), 30
frames/rep, 5 reps/process, 5 processes per cell. All watchers on one root
watching c=a+1. Frame = W writes round-robin across B fresh
default-priority tokens, values alternating changed/EQUAL (equal writes
exercise value-blindness: LOGGED appends + delivers them; DIRECT
equality-suppresses them) → render pass (renders all watchers, commits) →
retire frame tokens. Propagate ns = the `bridge.write()` call alone.
DIRECT comparator: same graph, F effects, unbatched `a.set` (value-gated
baseline). Extra rows: **held-batch** (one token opened at rep start,
never retired: its unretired first receipt pin-blocks compaction of every
later receipt on the same atom) and **pinned-open-pass interleave** (the
§5.9 scar schedule: writes land while the render pass is yielded with the
written slot in its mask and pin < seq — suppression MUST deliver
interleaved).

**Numbers (median [min..max] across 5 processes):**

| cell | DIRECT prop ns | LOGGED prop ns | ratio | max deliveries /(w,b,cycle) | max spurious /(w,b,cycle) | tape end | held degrade (last5/first5) |
|---|---|---|---|---|---|---|---|
| F1×B1×W8 | 385.4 [284.4..410.6] | 2587.7 [2584.2..2658.5] | **6.7×** | 1 | 0 | 0 | — |
| F8×B1×W8 | 326.1 [316.9..346.5] | 3792.7 [3768.6..3849.6] | **11.6×** | 1 | 0 | 0 | — |
| F64×B1×W8 | 913.9 [896.3..983.9] | 9847.2 [9707.8..9918.1] | **10.8×** | 1 | 0 | 0 | — |
| F8×B4×W8 | 326.1 | 2800.5 [2762.0..3028.7] | **8.6×** | 1 | 1 | 0 | — |
| F8×B4×W64 | 137.3 [132.9..142.8] | 2943.9 [2854.0..2998.4] | **21.4×** | 1 | 1 | 0 | — |
| F64×B4×W64 | 472.7 [471.8..475.3] | 16492.7 [16316.8..17048.7] | **34.9×** | 1 | 1 | 0 | — |
| F8×B2×W64 +held | 137.3 | 11082.8 [10892.4..11315.9] | **80.7×** | 1 | 1 | **1950** | **3.14× [3.08..3.42]** |
| F8×B2×W64 +inter | 137.3 | 5058.3 [5026.9..5116.2] | **36.8×** | **32** | **32** | 0 | — |

**Reading.**
- Propagate clause: **FAIL everywhere** (6.7×–80.7× vs the 2× budget).
  Cost scales with total graph × F (the recomputed-union walk +
  per-watcher deliver bookkeeping), and the held row shows the O(tape)
  fold inflating every committed-world evaluation (3.14× degradation over
  a mere 30 held frames, tape 1950 receipts).
- Spurious-render clause: the per-(watcher,slot) dedup **holds the ≤1
  bound in every closed render cycle** (grid + held rows: max 1 delivery,
  max 1 spurious — the spurious one is an equal-value write's fresh
  delivery, which value-blindness mandates). The interleave row records
  32 deliveries / 32 value-unchanged renders per (watcher,slot,cycle) —
  formally >1, BUT these are the §5.9-mandatory interleaved deliveries of
  post-pin same-slot writes to a started pass (the pinned-open-pass scar:
  suppressing them was a walked kill; "over-notification is priced, never
  wrong"). The letter of the rule flags it; the spec's own §5.9 semantics
  requires it. Both readings reported.

**Verdict: FAIL** (propagate clause, decisively; spurious bound holds in
dedup-governed cycles and is exceeded only where delivery is mandatory).

**Fallback (named, NOT implemented, NOT adoptable yet):** per-slot-mark
delivery dedup per render cycle (D13) — blocked by O24 until it has its
own walked schedule (S17 re-entry risk). The propagate failure itself
points at the TODO(gate:SPK-N1) family (touched-word marking walk +
touched-list drains instead of `refreshEdgesAllWorlds` + full observer
scans), which is the deferred optimization, not the D13 fallback.

---

## SPK-R — dense retirement (SPLIT comparator)

**Pre-registered rules (verbatim, spec §7):** "Retirement (engine) |
retirement engine overhead ≤ 2× a DIRECT `batch()` on the identical
write/effect graph; user callback time reported separately" and
"Retirement (React) | reconciliation ≤ 2× the equivalent useState
render/commit for reached watchers". The old render-relative gate was
DELETED (zero-denominator defect, breaker B4) and was NOT resurrected.
User callbacks in these workloads are trivial `set` ops (no user callback
time to separate).

### G-R-core — engine vs DIRECT batch()

**Workload.** Identical write/effect graph both sides: 4 atoms, 4
computeds (each reads 2 atoms), 4 (core) effects. Burst = K tokens × M=8
writes each (round-robin atoms, always-changing values), then retire all K
committed (dense retirement: stamp receipts, compaction folds — this
build's stand-in for the promotion walk; there are no version chains to
promote, folds recompute — durable drains, per-root row clears, slot
release). DIRECT comparator: K× `batch()` of M writes (effects flush at
close). `+8w` rows add 8 committed watchers on one root — the
advance-drain watcher reconcile surface (a LOGGED-only observer
population; disclosed as beyond the strict "identical graph" letter).
5 processes per config, 7 reps each. Small-K cells carry visible
timing-overhead noise (a K1 rep times a single batch); K24 is the
best-amortized row.

| cell | DIRECT batch() ns | LOGGED retire ns/token | **ratio (the gate)** | LOGGED write ns/token | LOGGED total ns/token | total ratio (context) |
|---|---|---|---|---|---|---|
| K1×M8 | 12500 [11458..15583] | 9000 [8125..9375] | **0.7×** | 77333 | 91750 | 7.3× |
| K8×M8 | 4917 [4667..5089] | 3896 [3776..4099] | **0.8×** | 30615 | 34115 | 6.9× |
| K24×M8 | 2337 [2163..2420] | 1818 [1724..1884] | **0.8×** | 26319 | 28104 | 12.0× |
| K8×M8 +8w | 4917 | 11036 [10667..11563] | **2.2×** | 60375 | 71786 | 14.6× |
| K24×M8 +8w | 2337 | 10361 [10004..10863] | **4.4×** | 64533 | 73488 | 31.4× |

**Verdict: PASS on the pre-registered comparator** (0.7–0.8×, ranges
clear of 2×): the retirement engine itself — stamping, compaction,
release — is cheaper than a DIRECT batch of the same writes. The
watcher-loaded rows exceed the budget (2.2×/4.4×, growing with K) because
`drainCommittedObservers` re-evaluates EVERY observer in the committed
world per retirement — exactly the deferred TODO(gate:SPK-N1) drain site
(logged.ts:1290 "enumerate the slot's touched list instead of every
observer"). Reported as the advance-drain price, not a strict-comparator
failure. The LOGGED write phase (priced by SPK-W, not this gate) dominates
the total either way.

### G-R-react — reconciliation vs plain useState (COARSE)

**Workload.** jsdom + `act` + the linked fork (protocol capabilities 511),
one process per config, 5 processes, 30 rounds each (5 warmup): N
components `useSignal(shared atom)` vs N components with per-cell
`useState` setters all fired in one act (the equivalent render/commit for
N reached watchers). One cosignal round = `act(() => a.set(v))` — write,
delivery, render pass, per-root commit, and the write batch's retirement
all inside the round (steadiness asserted: liveTokens = 0, tape = 0 after
every round). Timing at act() level is COARSE by nature; disclosed.

| cell | useState ms/round | cosignal ms/round | **ratio** |
|---|---|---|---|
| N8 | 0.147 [0.145..0.149] | 0.186 [0.182..0.199] | **1.26×** |
| N64 | 0.502 [0.469..0.517] | 0.579 [0.568..0.591] | **1.15×** |

**Verdict: PASS (coarse)** — 1.15–1.26× ≤ 2×, ranges disjoint from 2×.
The whole-stack number absorbs the naive engine's walk costs and still
clears the budget because React render/commit dominates at this level.

**Fallback:** none to name — the comparator is already the repaired split
form; the strict-comparator and react halves pass.

---

## SPK-G8 — held-open bursts / world evaluation

**Pre-registered rule (verbatim, spec §7):** "World evaluation | cost ∝
flagged region; restart-heavy typeahead; prefix length | UNMEASURED →
world-evaluation spike; pre-named fallbacks: pinless-frontier hybrid;
whole-mask clock vector". OPEN.md adds O18 (typeahead row), O21
(prefix/stamp-vector length + I35 re-fold cost measured here).

**Workload (LOGGED-internal — world evaluation has no DIRECT
comparator).** G computeds where only c0 reads the burst-written atom (the
flagged region is ONE chain; the other G−1 read unrelated atoms), one
committed watcher on c0. Burst rows: 20 frames × 64 writes into fresh
default tokens (retired per frame); `+held` holds a long transition open
across the whole rep (parked action token with one receipt + a YIELDED
pass including it). Typeahead row: 50 keystrokes; each writes the parked
action token T, DISCARDS the open pass, starts+yields a fresh pass
including T; T settles only at the end. 5 processes per config, 5
reps/process.

| row | per-write / per-key ns | held tax | evals/write | retained receipts (tape) |
|---|---|---|---|---|
| burst G4 | 3381 [3363..3452] | 1 (base) | 8.0 | 0 |
| burst G4 +held | 25689 [25634..25726] | **7.60×** | 12.0 | **1281** |
| burst G16 | 10563 [10507..10703] | 1 (base) | 32.0 | 0 |
| burst G16 +held | 42971 [39524..44061] | **4.07×** | 48.0 | **1281** |
| burst G64 | 40899 [40068..41615] | 1 (base) | 128.0 | 0 |
| burst G64 +held | 89112 [88623..89530] | **2.18×** | 192.0 | **1281** |
| typeahead G16, K50 | 31860 [31275..32475] /key | — | 47.7 /key | **50** (= 1/keystroke) |

**Reading.**
- "Cost ∝ flagged region" fails already unheld: the flagged region is
  constant (1 chain) yet write cost grows near-linearly with total G
  (3.4→40.9 µs, 12.1× for 16× nodes; evals/write = worlds × G exactly:
  2G unheld [newest + committed], 3G held). The walk visits everything in
  every live world (`refreshEdgesAllWorlds`), not the flagged region.
- Re-evaluation cost per interruption: each held interruption re-folds
  the pass + committed worlds over the FULL retained tape — at G4+held,
  ~22 µs of the 25.7 µs per write is fold cost over the ~640-receipt
  average tape (≈17 ns per receipt-visibility step), which is why the
  held tax is LARGEST at small G.
- Receipt retention: both retention mechanisms pin the whole burst
  history (the held token's unretired first receipt blocks the prefix
  clause; the held pass's pin blocks the pin clause) → 1281 receipts
  retained across the hold; typeahead retains exactly one receipt per
  keystroke until settlement (prefix length ∝ keystrokes, 50 at K50).
- O21's evaluator-stamp vector length: N/A by construction — this build
  has no stamp vector; the I35 re-fold revalidation cost IS the measured
  per-interruption eval cost above.

**Verdict: FAIL** (cost ∝ whole graph × live worlds × retained tape
length — not ∝ flagged region).

**Fallbacks (pre-named, specced, NOT implemented):** pinless-frontier
hybrid (epoch-keyed frontier memo + pass-local scratch, O18/S18) and the
whole-mask clock vector for suspense prefixes (O21, coarser refetch,
flagged). Also implicated: the TODO(gate:SPK-R) §5.7 memo ladder
(non-newest folds currently always evaluate) and TODO(gate:SPK-N1)
touched-word walk.

---

## SPK-K1 — never-quiescent growth soak

**Pre-registered rule (verbatim, spec §7 / OPEN.md):** "World-graph growth
| K1 + mirrors bounded on the soak, or the declared gap stands documented
| growth soak spike: >1 MB/h steady growth or >5% walk degradation ⇒
extend the mid-episode sweep predicate (sampled reachability)". O25: the
residual of the G9 declared gap is what this measures.

**Workload.** 60 s soak per process, 5 processes (gate config) + 2
supplementary. Never quiescent: two overlapping holder tokens rotate every
5 s (each writes once — a holder receipt pin-blocks its atom's compaction
while held). Topology rotates every 1 s (64 computeds re-target their two
atom reads among 64 atoms — K1 episode edges are add-only until
quiescence, so each rotation strands edges). Traffic: ~1300 frames/s, each
= fresh token + 4 writes + retire; every 16th frame a render pass over 4
watchers commits. Samples every 5 s: gc() then heapUsed, plane counts,
per-write latency window medians. Gate config truncates the diagnostic
`bridge.events` array at each sample so the heap slope isolates the
retained planes; the retain config (n=2, disclosed) leaves it.

**Numbers (median [min..max] across 5 processes; 60 s window
extrapolated):**

| metric | value |
|---|---|
| gate-plane heap growth | **2709.9 MB/h [2704.2..2742.6]** |
| walk degradation (write ns, last vs first 5 s window) | **+73.9% [70.4..75.9]** (62.8 µs → 108.1 µs) |
| K1 edges | +183,040 /h (edge sets; tapes stay bounded: 217 receipts steady) |
| dead token records retained | +3,576,160 /h |
| ended pass records retained | +223,440 /h |
| BridgeEvent allocations | 63.4 M /h (freed in gate config; retained → +7369.7 MB/h [7311.9..7427.5], n=2, walk degrade +71.8%) |

**Reading.** Both clauses fail by ~3 orders of magnitude, and the
dominant growth is NOT the K1 edge plane itself (183k edge-set
entries/h): it is dead-episode bookkeeping that §5.12 reclaims ONLY at
quiescence — retired Token records (3.6 M/h) and ended Pass records
(224k/h) accumulate in maps forever under never-quiescent traffic, and
`openBatch`'s live-token guard scans + `deliver`'s pass loop degrade
linearly with them (hence the 74%/minute walk degradation — the rates are
non-stationary, so per-hour extrapolations are lower bounds on badness in
wall-clock terms while throughput collapses). The always-allocated
BridgeEvent stream adds another ~7.4 GB/h if nothing drains it (in this
reference build nothing does — `log()` pushes unconditionally;
trace-off only means no recorder hooks fire).

**Verdict: FAIL** (both clauses).

**Fallback (pre-registered, NOT implemented):** extend the mid-episode
sweep predicate (sampled reachability) — and this measurement says the
extension must sweep dead token/pass records and bound/ring-buffer the
event stream mid-episode, not just K1 edges. The G9 "declared gap stands
documented" branch is NOT available: the soak numbers exceed the
documented-gap tolerance the rule set.

---

## SPK-L — LOGGED-quiet residual (O19)

**Pre-registered decision (OPEN.md O19 / queue):** "G-Q's ≤2% vs the
measured 2.4–3.8% branch floor [SPKHQ]: SPK-L (idle machine) decides;
pre-registered monitor renegotiation to ≤3% or the mitigation ladder. A
requirements decision, not a defect." Canonical SPK-L wants an idle
machine; this is the pre-authorized best-effort run on THIS machine —
**load disclosed**: at measurement start `uptime` showed load averages
1.72 1.80 1.84 with one foreign renderer process at ~86% CPU (plus the
earlier header context). Results labeled accordingly.

**Workload.** Tier-0-STYLE read/isolate shapes written fresh for this gate
(harness/bench/shapes.ts untouched): readPoll (2M polling reads/rep),
deepPropagate (50-computed chain + effect, 20k writes/rep), broadIsolate
(100 independent atom→computed→effect columns, 200k round-robin writes),
diamond (4-wide join + effect, 200k writes). IDENTICAL shape code injected
into both children; one config per process; 7 processes per config, 9
reps within each (3 warmup). LOGGED-quiet child: `registerReactBridge()`
armed BEFORE workload build, one registered decoy atom+computed (mounted
state), zero receipts/batches/passes during measurement (asserted at
exit); hot loops run on UNREGISTERED plain signals through the armed
operation table — the quiet read tax is the wrapper's
activeBridge/activeWorld checks; the quiet write tax adds the byKernelId
map probe (logged.ts's stated "one map probe per op" promise).

| shape | DIRECT ns/op | LOGGED-quiet ns/op | residual |
|---|---|---|---|
| readPoll | 2.11 [2.02..2.48] | 2.61 [2.51..2.79] | **+23.5%** |
| deepPropagate | 706.61 [698.49..712.48] | 892.19 [865.98..897.94] | **+26.3%** |
| broadIsolate | 41.63 [40.04..44.20] | 64.20 [63.60..65.56] | **+54.2%** |
| diamond | 109.21 [107.38..110.26] | 122.06 [117.85..127.72] | **+11.8%** |

**Reading.** The residual is 11.8–54.2% with process-median ranges that do
NOT overlap between configs (e.g. broadIsolate: DIRECT max 44.2 vs LOGGED
min 63.6), while within-config spread is ±2–4% — the machine's load can
account for the small ranges, not the gap. This is a property of the
shipped seam, not of the environment: the reference logged.ts arms the
seam by wrapping the operation table's `read`/`write` in JavaScript
closures (extra call frame + 2 loads/compares on every read; mode check +
Map probe on every write), where the design-phase SPKHQ floor (2.4–3.8%
under load) priced a kernel-integrated routing-word check. At tier-0 op
sizes (2–110 ns) even a few ns of wrapper is tens of percent.

**Verdict: FAIL on this machine — and NEEDS-IDLE-MACHINE only for the
certified floor, not for the decision.** An idle machine cannot close a
non-overlapping 12–54% gap to ≤3%.

**O19 recommendation:** neither "≤2% stands" nor "renegotiate to ≤3%" is
supported by the shipped seam — the renegotiation question is MOOT at
this residual. The pre-named mitigation ladder is triggered instead:
compile-time splitting of untracked call sites / LOGGED rebuild tiers —
concretely, the quiet path needs the routing check compiled into the
kernel table (twin-build style) rather than closure-wrapped around it.
Recommend: (1) treat the idle-machine run as certification-only, (2) keep
the ≤3% ratified budget as the target the mitigation ladder must hit,
(3) do not ship the closure-wrapper seam as the armed steady state.

---

## SP2 — E-PRESERVE validator disposition (no measurement required)

**Original question (O3 / spec §8 "edge-mirror validator" row):** what
does the dev-mode E-PRESERVE validator cost — the check that kernel (K0)
edge drops never lose an edge the episode's union plane (K1) still needs
— with the pre-registered rule ">10% dev overhead ⇒ sampled validation"?

**Disposition: resolved by construction in the shipped architecture; no
runtime validator exists, so there is nothing to price.** Two structural
facts discharge the question. (1) The shipped engine records REAL K1
edges by re-evaluation (`episodeEdges` re-recorded on every walk in the
fold-everything form, logged.ts §5.5 comment): it never depends on
incrementally-maintained kernel edges, so there is no K0-drop event whose
preservation a dev validator would have to mirror-check. (2) The
E-PRESERVE property itself (strong reading, R10 round-3, "promoted to CI
fuzz gate") is enforced by the twin/diff layer: cosignal-oracle's naive
replay model + `tests/logged-fuzz.spec.ts`, which diffs engine vs model
after EVERY step — op legality, the full observable snapshot (newest,
committed-per-root, every open pass world), and the comparable event
stream — across 300 seeds × 80 steps plus 8 episode-churn seeds × 400
steps, with a shrinker. Measured wall cost of that gate: **984 ms** total
(tests 850 ms) on this machine — a CI-time cost, trivially affordable,
zero runtime overhead. The >10% rule has no denominator at runtime; the
fallback (sampled validation) stays unused.

**v1.1 obligation (the honest residual):** the by-construction discharge
is EXACTLY co-extensive with the fold-everything walk. When
TODO(gate:SPK-N1) lands (incremental K0-mirror + touched-word walk — and
every other gate above says it must), K1 maintenance becomes incremental
and E-PRESERVE stops being structural: SP2 REOPENS at that point. v1.1
should then consider a dev-mode sampled edge-mirror check (the
pre-registered fallback shape) and re-run this spike against it, keeping
the oracle diff as the CI backstop (its documented tolerance relaxation
for the touched-word walk is already written into the SPK-N1 TODO note:
"engine ⊇ required, ⊆ union-conservative").

---

## Battery conclusions

1. **PASS:** SPK-R core (strict split comparator, 0.7–0.8×) and SPK-R
   react (1.15–1.26×, coarse). The retirement machinery's ordering
   (stamp → fold → drain → clear → release) is not the problem.
2. **FAIL, all pointing at the same deferred family:** SPK-W (17–40×),
   SPK-N1 propagate (6.7–81×), SPK-G8 (cost ∝ whole graph × worlds ×
   retained tape), SPK-K1 (2.7 GB/h + 74%/min degradation), and the
   watcher-drain rows of SPK-R (2.2–4.4×). Every failure decomposes into
   the three TODO(gate) families deliberately deferred in logged.ts
   (SPK-W receipt packing / SPK-N1 touched-word walk + touched-list
   drains / SPK-R read routing + memo ladder) plus two liabilities the
   TODOs do NOT yet name: dead token/pass record retention until
   quiescence (§5.12 scope — dominant in the soak) and the
   always-allocated BridgeEvent stream (7.4 GB/h if retained).
3. **SPK-L** fails at 12–54% on this machine with non-overlapping ranges:
   a seam-implementation property (closure-wrapped table), not machine
   noise; O19's 2%-vs-3% renegotiation is moot until the routing check is
   compiled into the kernel table.
4. **No fallback was implemented** (per the stage rules); every fallback
   is named verbatim in its gate section. Per O24, the D13 per-slot-mark
   dedup additionally requires its own walked schedule before any
   adoption.
5. **Decisions needed from Jake:** (a) idle-machine SPK-L certification
   run — scheduling only, the decision itself is not blocked on it; (b)
   whether the perf pass (implementing the TODO(gate) families) proceeds
   under these numbers, re-running this battery as its exit gate; (c)
   whether mid-episode reclamation of dead token/pass records + event
   stream bounding gets specced into the sweep-predicate extension (the
   SPK-K1 numbers say the current predicate scope is insufficient).

## Files

- Results: research/experiments/cosignal-gates.md (this doc).
- Bench scripts (new, self-contained): packages/cosignal/bench/
  util.mjs, spkw{-direct,-logged,}.mjs, spkn1{-direct,-logged,}.mjs,
  spkr-core{-direct,-logged,}.mjs, spkr-react{-cosignal,-usestate,}.mjs,
  spkg8{-logged,}.mjs, spkk1{-logged,}.mjs, spkl{-shapes,-direct,-logged,}.mjs.
  Run any parent with `cd harness && node --import tsx
  ../packages/cosignal/bench/<gate>.mjs` (PROCS env overrides process
  count). Nothing under harness/, src/, vendor/, design-loop/ was
  modified.

