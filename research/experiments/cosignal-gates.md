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


---

## After perf pass P1 (2026-07-05)

Same machine (loaded, non-idle: this is the working-session box, not the
SPK-L-certified idle machine), same runners, same methodology. The pass
implemented the three deferred TODO(gate) families in
packages/cosignal/src/logged.ts plus the SPK-K1 sweep extension:

- **SPK-W family:** int-packed receipt columns (per-atom `Tape` with parallel
  number columns + one payload side column; start-offset window compaction —
  the shrink-in-place form measured ~10µs/drop from V8 dictionary-mode decay,
  the pool IS the arrays), per-token touched-atom lists (retirement stamps
  scan only touched tapes), set/Object.is write fast paths, last-token cache.
  Inline-2 receipts were NOT taken (the packed columns beat the projected
  win; the residual bare floor is the event/op objects, not the receipt).
- **SPK-N1 family:** touched-word marking walk (int32/node, bits 0–30 + taint
  31, monotone frontier), per-slot touched lists + keep-the-dirt sweep at
  re-intern, per-write value-blind delivery walk with the walk-generation
  column, touched-list-scoped durable drains (plus committed-dirty-slot and
  commit-re-staled tracking to match the referee's full-scan reconcile
  timing), dedup bits as int words. `refreshEdgesAllWorlds()` is GONE from
  the write path.
- **SPK-R/L family:** §5.6 read routing (fast path = touched(n)==0 ∧ CT(n)),
  §5.7 memo ladder (per-world memo planes on Pass/Root records + a newest
  plane; slot-clock step 2, fingerprint step 3 with fp = max(visible seq,
  baseSeq, retirementStamp); commitGen re-keys evict committed memos), atom
  fold memos, §5.12 quiescence kernel-pull refresh with post-reset
  re-recording (cone-carry), kernel-integrated-style routing words at the
  table seam (module int + per-record registration bit; the Map probe left
  the quiet write path). NOTE: newest-world computed caching lives in an
  overlay memo plane, NOT in kernel `Computed` records — backing bridge
  computeds with real kernel nodes creates stale cross-evaluation K0 link
  cycles that the frozen kernel's unwatched-dispose walk cannot traverse
  (measured hang; profile: `disposeAllDepsInReverse` 97%).
- **SPK-K1 (re-scoped, flagged):** the pre-registered wording ("extend the
  mid-episode sweep predicate — sampled reachability") now covers BOTH the
  measured dominators and the original plane: dead token/pass record
  reclamation (retired ∧ slot fully released ∧ no open mask ∧ no
  un-compacted receipts ⇒ record drops; pass records drop at pass end),
  event-stream cursor/ring (`eventCursor()`, `setEventCapacity()`; the
  react shim marks with the cursor and caps at 64k), archive retention made
  opt-in (`retainArchive`, on in test drivers only), AND the K1-edge sweep
  itself (every 256 recorded edges: reverse reachability from
  watcher/effect-holding nodes; edges to unreachable, live-bit-free,
  taint-free targets drop; touched WORDS persist — keep-the-dirt).

Verification state at these numbers: cosignal 163+1 (incl. 308-seed fuzz),
oracle 74+1, cosignal-react 45, conformance 179/179 × {cosignal,
cosignal-logged, arena}, tsc clean. Fuzz/twin comparators relaxed to the
oracle README's documented delivery tolerance ONLY (see the P1 report).

### Gate table (before → after)

| gate | before (2026-07-05 pre-P1) | after P1 | pre-registered rule | verdict |
|---|---|---|---|---|
| SPK-W | 17.2×–40.4× DIRECT | bare **18.9×** (87.7ns; event+op-object floor), chain3 **4.9×** (367ns), fan8 **4.1×** (1023ns), watch1 **2.6×** (98.5ns) | ≤ 2× DIRECT write | **FAIL, 4–10× closer**; residual = per-write BridgeEvent/op allocation + eval-frame cost (see notes) |
| SPK-N1 | 6.7×–34.9× grid; 80.7× held | **1.3×–3.2×** grid (B1 rows 1.3–2.2×, W64 rows 2.9–3.2×); held **2.9×** (tape 1950 by §5.3 design, degrade gone: last5/first5 ≈ 0.75); spurious ≤1 everywhere except the §5.9-mandated interleave 32 (unchanged) | propagate ≤ 2×; ≤1 spurious/(w,slot,cycle) | **PARTIAL** — B1 rows pass, W64 rows marginally exceed (per-write suppressed-event logging floor); spurious clause as before |
| SPK-R core | 0.7–0.8× strict; 2.2×/4.4× +8w | **0.5×–1.1×** strict; **1.7×/2.5×** +8w | retirement engine ≤ 2× DIRECT batch() | **PASS** (strict; +8w rows improved, K24+8w 2.5× disclosed as before) |
| SPK-R react | 1.26×/1.15× | **1.31×/1.20×** (coarse jsdom noise) | ≤ 2× useState render/commit | **PASS** |
| SPK-G8 | cost ∝ whole graph × worlds × tape (3.4→40.9µs by G; held tax 2.2–7.6×; typeahead 31.9µs/key) | **~170ns/write FLAT across G4/G16/G64**, held tax **0.98–1.04×**, typeahead **2.4µs/key**; retention unchanged by design (1281 held receipts; 1/keystroke prefix) | cost ∝ flagged region | **PASS** (evals/write 0 — the write pays only its marked cone) |
| SPK-K1 | 2710 MB/h; +73.9%/min walk degradation, unbounded | fit says **150 MB/h** — but the trace is a bounded SAWTOOTH: floors flat ~35–40MB, peaks = the §5.3 pin-blocked holder window (tape/tokens spike then compact+reclaim at rotation); tokens/passes steady 1–2 outside windows; K1 edges steady ~250 (swept); walk **plateaus at 334ns** (+60% over the first window incl. JIT ramp; NO growth after t≈30s). RETAIN liability now ~360GB/h at 123k frames/s (was 7.4GB/h at 1.3k frames/s) — cured by `setEventCapacity`, which the shim applies | ≤1 MB/h steady growth AND ≤5% walk degradation | **FAIL by metric letter, structurally bounded** — residual is the pin-blocked-window sawtooth (spec-mandated retention) aliasing the sampler, plus the plateaued walk tax; see notes |
| SPK-L | +11.8%–54.2% | readPoll **+14.9%**, deepPropagate **+25.4%**, broadIsolate **+34.4%**, diamond **+8.6%** | ≤2% (O19 renegotiable ≤3%) | **FAIL** — the routing-word check landed but the seam still pays a closure call frame per op around `inner.read/write`; the 2.4–3.8% SPKHQ floor assumed the check compiled INTO the kernel table (a build-tier change, out of P1 scope) |
| SP2 | resolved-by-construction | **REOPENED as scheduled** — the incremental walk landed; the CI fuzz gate now runs the documented delivery tolerance (engine ⊆ union-conservative cumulatively; exact snapshots/corrections/effects) | >10% dev overhead → sampled validation | tracked for v1.1 per the original disposition |

### Notes and residuals

1. **SPK-W bare floor.** Per-write remaining cost ≈ one BridgeEvent object
   (the public, indexable diagnostic stream tests/benches/shim consume), the
   caller-allocated op object (bench shape), the kernel apply, and packed
   pushes. Getting bare to ≤2× (≈9ns) requires packing/lazifying the event
   stream itself (a public-surface change: `events` is an indexed array the
   fuzz harness, benches, and shim read) — a P2 decision.
2. **SPK-N1 W64 rows.** At 64 writes/frame most writes hit armed dedup bits
   and log a `suppressed` event per reached watcher per write (§5.9's priced
   over-notification): the event allocation dominates (same floor as note 1).
3. **SPK-K1 honest shape.** The old failure mode (unbounded token/pass/event
   growth + linear walk decay) is gone; what remains is (a) the sampler
   aliasing the §5.3-mandated pin-blocked window (a 2–5s sawtooth whose
   amplitude is holder-period × write rate — receipts that MUST be retained
   while the holder's first receipt is unretired), and (b) a walk-cost
   plateau (+60% incl. warm-up) from the steady-state stale-edge population
   between 256-edge sweeps and the larger token map inside blocked windows.
   Bench methodology fixes (flagged): the truncate config caps the
   diagnostic stream at 64k events (its stated intent — isolating the
   retained planes — was drowned by inter-sample event backlogs at ~100×
   the reference frame rate); the retain liability row runs 10s and
   extrapolates (an unbounded stream OOMs inside 60s at this speed);
   short-run guards for `samples[2]`. Runs here: PROCS=1, 120s gate soak,
   HOLD_MS=2000.
4. **§5.9 edge-add retroactive delivery replay is NOT implemented** (bit
   propagation IS). The replay synthesizes deliveries the referee model
   never produces anywhere, so it cannot be validated inside the documented
   "⊆ union-conservative" tolerance; its only lost effect is catch-up lane
   scheduling for late-discovered paths (required correctness is carried by
   durable drains + pass folds — fuzz/battery/scars all green). Revisit with
   the real fork's `runInBatch` (P2).
5. **Delivery-decision timing** now follows evaluation-site edge discovery
   (spec §5.5) instead of the model's eager per-write union refresh; the
   twin/fuzz comparators implement the oracle README's documented tolerance
   for exactly {delivery, suppressed, mount-corrective}: cumulative
   multiset ⊆ the model's, keyed (type, watcher, token, slot); everything
   else — legality, full snapshots, corrections, effect runs, counters —
   stays exact per step. The §5.10 errata-2 audit (in-engine
   BridgeInvariantViolation) enforces the corrective ⊇ floor on every mount.

## One Core re-baseline (2026-07-05)

Post-convergence honest numbers: One Core at HEAD (single `cosignal`
entry: f6a109b One Core merge + 3ca5f3f two-form ctx.use/quiet-mode +
d076402 observe-union, plus the Phase-3 adoption convergence in the
working tree) vs the **pre-convergence base entry at 7c9c5ae** ("grind
1", the last two-entry commit). Baseline ran from a `git archive` export
of 7c9c5ae at /tmp/cosignal-base with the benches' absolute import paths
rewritten to the export (same runners otherwise — the bench drivers
differ from 7c9c5ae only in import lines). Same methodology as the rest
of this file: one config per child process (`node --expose-gc --import
tsx`, cwd=harness/), medians + [min..max] across processes, checksums
against DCE. PROCS: 7 for SPK-L, 5 elsewhere.

**Machine load disclosure:** the working-session M4 Max, NOT idle — load
averages 4.16→4.75 (1-min) across the run (claude CLI + editors
resident); node v24.16.0. HEAD and BASE alternated within one sitting
(18:48–18:50), so both sides saw the same load regime. Treat ±5% as
noise; the SPK-L-certified idle floor is a separate exercise.

**Instrumentation caveat (One Core posture change):** production bridges
no longer mint BridgeEvents (the log is gated on referee/tracer
attachment), and deliveries reach the host through direct listeners. The
event-derived columns (eventsPerWrite, deliveries/spurious per
(watcher,batch)) therefore read 0 at HEAD — not because nothing is
delivered but because the diagnostic stream no longer allocates;
delivery decisions are policed by the fuzz/twin comparators instead.
Base rows still pay and show per-write event minting. This is the
intended production posture on both sides of the comparison, not a
benchmark trick: the base entry's registered path always minted events;
One Core's doesn't.

### (a) Sync-only direct shapes (SPK-L set; per-op ns, unregistered)

| shape | base entry @7c9c5ae | One Core @HEAD | Δ median | armed-idle residual base → HEAD |
|---|---|---|---|---|
| readPoll | 2.38 [2.29..2.65] | 2.43 [2.39..2.63] | +2.1% | +4.96% → **+0.23%** |
| deepPropagate | 776.4 [766.6..782.4] | 773.6 [763.9..783.6] | −0.4% | +24.02% → **+0.54%** |
| broadIsolate | 45.0 [43.9..47.8] | 48.6 [47.1..49.2] | **+7.9%** | +32.43% → **+17.98%** |
| diamond | 115.0 [114.3..121.5] | 118.0 [114.6..128.6] | +2.6% | +24.89% → **+2.04%** |

Reading: the old "your bundle carries zero concurrency code" build is
gone; its replacement — one entry whose public read/write methods carry
the host-seam branches — prices at **noise (±3%) on three of four
shapes**. broadIsolate (write-heavy over many isolated atoms) shows
+7.9% with barely non-overlapping ranges: a small real regression on
this machine, disclosed, not explained away. The armed-but-idle residual
(registered bridge, unregistered signals — the old SPK-L/O19 metric)
collapsed on three shapes (≤2%, meeting the O19 target the P1 pass
failed) but broadIsolate still pays ~18%.

### (b) Quiet-mode registered writes (Phase 1b; per-write ns)

HEAD `spkw-quiet`: bridge registered, atom REGISTERED, nothing pending —
vs the raw kernel write (HEAD spkw-direct), and vs what the same
registered write cost at 7c9c5ae (always-receipt logged path, windowed;
its closest pre-quiet equivalent).

| shape | HEAD direct | HEAD quiet | quiet overhead | @7c9c5ae registered | improvement |
|---|---|---|---|---|---|
| bare | 5.06 [5.02..5.34] | 12.58 [12.28..12.89] | **+148.7% (2.5×)** | 83.3 [72.6..91.5] | **6.6× cheaper** |
| chain3 | 78.1 [76.6..84.0] | 85.2 [84.3..88.0] | +9.1% | 367.9 [364.2..382.9] | 4.3× cheaper |
| fan8 | 254.4 [250.2..256.8] | 265.3 [257.8..266.6] | +4.3% | 1029.4 [1019.3..1046.2] | 3.9× cheaper |
| watch1 | 40.2 [39.4..40.8] | 45.0 [43.9..47.7] | +12.1% | 99.5 [98.5..109.0] | 2.2× cheaper |

Reading: with real propagation attached the quiet fold sits within
~4–12% of the kernel write. The bare atom pays the seam's fixed ~7.5 ns
(stamp check + quiet branch + committed-base advance) over a 5 ns write
— **+148.7% relative, failing the spkw-quiet-run header's ~10% aspiration
on the ratio while being small in absolute terms**; published as
measured. Versus the pre-convergence registered write, quiet writes are
2.2–6.6× cheaper across shapes.

### (c) Armed/concurrent shapes

SPK-W (windowed batched writes + retirement; per-write ns):

| shape | base loggedNs | HEAD loggedNs | Δ | base amortNs | HEAD amortNs | eventsPerWrite base → HEAD |
|---|---|---|---|---|---|---|
| bare | 83.3 [72.6..91.5] | 79.0 [76.3..89.2] | −5.2% | 102.5 | 102.2 | 1.05 → 0 |
| chain3 | 367.9 [364.2..382.9] | 356.6 [340.7..370.4] | −3.1% | 389.3 | 377.7 | 2.05 → 0 |
| fan8 | 1029.4 [1019.3..1046.2] | 938.0 [935.6..952.3] | **−8.9%** | 1056.0 | 960.7 | 9.05 → 0 |
| watch1 | 99.5 [98.5..109.0] | 105.0 [99.4..125.8] | +5.5% (ranges overlap) | 126.2 | 133.6 | 2.06 → 0 |

SPK-N1 (delivery fan-out grid; loggedPropNs, per write):

| cell | base @7c9c5ae | One Core @HEAD | Δ |
|---|---|---|---|
| F1xB1xW8 | 512.9 [491.5..592.2] | 537.8 [535.3..577.2] | +4.9% |
| F8xB1xW8 | 717.8 [690.1..794.3] | 777.1 [722.7..830.4] | **+8.3%** |
| F64xB1xW8 | 2107.7 [2051.4..2309.2] | 1712.2 [1653.6..1790.2] | **−18.8%** |
| F8xB4xW8 | 694.3 [664.6..1203.8] | 692.6 [675.6..715.1] | −0.2% |
| F8xB4xW64 | 457.1 [441.6..525.8] | 382.7 [371.2..398.3] | **−16.3%** |
| F64xB4xW64 | 1505.4 [1452.5..1570.9] | 1155.3 [1125.4..1180.7] | **−23.3%** |
| F8xB2xW64+held | 404.7 [401.1..412.7] | 355.2 [333.8..367.7] | −12.2% |
| F8xB2xW64+inter | 393.0 [382.6..435.2] | 371.0 [344.7..390.4] | −5.6% |

Reading, plainly: **what got faster** — event-heavy armed paths, because
the per-write BridgeEvent/suppressed-event allocation floor is gone
(fan8 −8.9%; every W64/F64 fan-out row −12% to −23%; exactly the rows P1
diagnosed as event-floor-bound). **What got slower** — the small
low-fan-out N1 cells (+5–8%: the direct-listener queue's fixed cost is
not amortized over fan-out there) and SPK-L broadIsolate (+7.9% direct,
+18% armed-idle). **What's noise** — SPK-W bare/chain3/watch1 deltas and
SPK-N1 F8xB4xW8 (overlapping ranges on a loaded box). tapeLenEnd 1950
and heldDegrade ≤1.0 on the held row match the P1 shape (§5.3 retention
by design, no degradation regression).

Verification state at these numbers: cosignal 188+1 skipped, oracle
74+1 skipped, cosignal-react 53, conformance 179/179 ×
{cosignal, cosignal-logged, arena}, both package tscs clean.

---

**Rename note (2026-07-06):** `packages/cosignal/src/logged.ts` is now
`concurrent.ts` ("logged" referred to the deleted twin-build concept; the
file is the concurrency engine), and the harness adapter
`cosignal-logged` is now `cosignal-concurrent` — conformance runs are
invoked as `FRAMEWORK=cosignal-concurrent` from here on. The run notes
and tables above predate the rename and keep the old names verbatim;
`cosignal-logged` in any historical "conformance 179/179 × {…}" line is
the same gate as today's `cosignal-concurrent`. (S-D extended the rename
to the runtime mode value: `bridge.mode` is now `'direct' | 'concurrent'`;
the bench `config: 'logged'` labels in child @@ROW output are file-name
tags, not the mode value, and keep their names.)

## NF2 final numbers (2026-07-06)

The NF2 closing battery at P2.S-D (working tree: S-C @70c6eb3 + the S-D
items — `lastFoldFp` deleted, pool/wrap hardening + clock-wrap guards,
mode rename) vs the **pre-NF2-transfer anchor 981491c** (the last commit
before S-B moved routing authority to the arenas; S-A's dual bookkeeping
is INSIDE the anchor, so these deltas price S-B + S-C + S-D end to end).
Anchor ran from a `git archive` export at /tmp/cosignal-prenf2 with the
benches' absolute import paths rewritten to the export (same runners,
same harness cwd/tsx/node_modules). Interleaved A/B: HEAD then ANCHOR
back-to-back per gate within one sitting (13:14–13:18), world gates ×3
alternated runs per side; medians + [min..max] across processes (PROCS 7
for SPK-L, 5 elsewhere, 3 for the spkg8 re-check); checksums equal
across trees everywhere compared (world gates 716400/388800/14821200;
spkw chain3 115203; spkn1 F8xB4xW64 5769).

**Machine load disclosure:** the working-session M4 Max, NOT idle — load
averages 3.2–6.2 (1-min) across the battery (claude CLI + editors
resident); node v24.16.0. Both sides saw the same load regime; treat ±5%
as noise. The spkg8 burst regression was re-confirmed with two extra
tightly-interleaved rounds (PROCS 3) on a 3.2-load window.

### World-evaluation gates (COSIGNAL_ROOT two-tree; medians of 3, ≤1.4× required)

| gate | metric | anchor 981491c | NF2 final | ratio |
|---|---|---|---|---|
| cold-pass (N=200) | perComputedColdReadNs | 712.9 [681.7..757.5] | 381.5 [378.8..410.4] | **0.54×** |
| wide-mask lock-in (W=200) | commitDrainUs | 196.6 [188.5..231.3] | 150.4 [143.7..195.6] | **0.76×** |
| untracked-fan (K=100×R=4) | writeStormNsPerWrite | 167.9 [150.1..168.2] | 181.1 [171.6..207.3] | 1.08× |

All three ≤ 1.4× — PASS. (Cold-pass 0.54× vs this anchor confirms the
stage-composed ~0.60× vs the original pre-S-A anchor from the S-C
report; S-D added nothing measurable on top, as intended.)

### SPK-L — armed-idle residual (per-op ns, unregistered signals)

| shape | anchor direct | anchor residual | NF2 direct | NF2 residual |
|---|---|---|---|---|
| readPoll | 2.51 [2.33..2.75] | −0.19% | 2.53 [2.36..2.71] | −1.77% |
| deepPropagate | 705.4 [693.1..722.2] | +3.12% | 709.9 [704.7..719.9] | +0.15% |
| broadIsolate | 44.8 [44.1..46.0] | +16.85% | 44.9 [43.9..45.6] | +16.48% |
| diamond | 117.9 [110.9..120.1] | +2.27% | 128.2 [116.0..133.9] | +5.26% |

No new idle tax from S-B/S-C/S-D. The broadIsolate ~16–17% armed-idle
residual predates NF2 (One Core era: ~18%) and is unchanged.

### SPK-W — armed windowed write price (per-write ns; W=64 windows, eager cone evals included)

| shape | anchor loggedNs | NF2 loggedNs | Δ | anchor amortNs | NF2 amortNs |
|---|---|---|---|---|---|
| bare | 89.4 [73.0..91.2] | 79.4 [72.8..89.0] | −11.2% (ranges overlap) | 110.9 | 99.0 |
| chain3 | 380.3 [376.2..390.4] | 214.0 [205.8..227.0] | **−43.7%** | 400.2 | 233.6 |
| fan8 | 1020.3 [1000.7..1055.0] | 521.4 [519.9..541.1] | **−48.9%** | 1040.4 | 542.7 |
| watch1 | 110.6 [106.4..112.0] | 119.7 [116.7..136.6] | **+8.2%** | 157.4 | 172.9 |

Direct baselines matched across trees (±2%). evalsPerWrite identical
(chain3 3.00, fan8 8.00 both sides): the same work, roughly half the
price on computed-cone shapes — the arena serving/refold path vs the
anchor's memo ladder.

### SPK-W-quiet — quiet-mode registered write (per-write ns)

| shape | anchor quiet | NF2 quiet | anchor overhead vs direct | NF2 overhead |
|---|---|---|---|---|
| bare | 12.80 [12.71..15.26] | 15.00 [12.72..16.91] | +160.7% | +199.9% |
| chain3 | 84.4 [80.3..88.2] | 85.1 [83.9..86.3] | +19.6% | +14.0% |
| fan8 | 243.1 [242.2..250.3] | 248.2 [247.9..253.2] | +1.5% | +3.1% |
| watch1 | 44.2 [43.2..45.0] | 44.4 [43.9..48.1] | +18.7% | +22.8% |

Quiet writes are NF2-neutral: chain3/fan8/watch1 within noise; bare's
median moved +2.2 ns on overlapping ranges (the seam's fixed cost over a
5 ns write — the known Phase-1b ratio artifact, not an NF2 change).

### SPK-N1 — delivery fan-out (loggedPropNs, per write)

| cell | anchor | NF2 final | Δ |
|---|---|---|---|
| F1xB1xW8 | 449.7 [435.1..598.9] | 473.9 [452.5..716.3] | +5.4% (overlap) |
| F8xB1xW8 | 784.0 [759.7..885.1] | 751.7 [717.2..832.8] | −4.1% (overlap) |
| F64xB1xW8 | 1680.7 [1570.5..1757.7] | 1618.6 [1606.4..1676.1] | −3.7% (overlap) |
| F8xB4xW8 | 637.7 [618.5..960.6] | 655.3 [637.3..690.3] | +2.8% (overlap) |
| F8xB4xW64 | 393.9 [377.3..445.9] | 474.4 [467.5..479.1] | **+20.4%** |
| F64xB4xW64 | 1183.0 [1137.7..1234.8] | 1202.3 [1181.7..1205.8] | +1.6% (overlap) |
| F8xB2xW64+held | 354.1 [343.2..389.6] | 440.1 [422.9..487.1] | **+24.3%** |
| F8xB2xW64+inter | 381.8 [371.3..386.1] | 455.4 [443.0..465.5] | **+19.3%** |

tapeLenEnd 1950 on the held row, both sides (§5.3 retention unchanged).

### SPK-R — dense retirement (per-token ns)

| cell | anchor retire | NF2 retire | Δ | anchor total | NF2 total | Δ |
|---|---|---|---|---|---|---|
| K1xM8 | 18375 | 15917 | −13.4% (overlap) | 78834 | 73792 | −6.4% |
| K8xM8 | 3339 | 3510 | +5.1% (overlap) | 18948 | 17099 | −9.8% |
| K24xM8 | 1481 | 1637 | +10.5% (overlap) | 10160 | 8675 | −14.6% |
| K8xM8+8w | 12500 [11896..14250] | 17849 [16672..18891] | **+42.8%** | 32510 | 41542 | **+27.8%** |
| K24xM8+8w | 9078 | 8332 | −8.2% | 19545 | 19967 | +2.2% (overlap) |

Watcher-less retirement is flat-to-better. The +8w rows are
NON-MONOTONIC: K8+8w regressed +43% on retire (non-overlapping ranges)
while K24+8w improved −8% on the same machine minutes apart — the
K8-watcher reconcile shape hits some arena-drain cost the K24 shape
amortizes; recorded as a residual, not explained away.

### SPK-G8 — held-open bursts / typeahead (per-write / per-key ns)

| row | anchor | NF2 final | Δ |
|---|---|---|---|
| burst G4 | 183 [177..199] | 221 [212..235] | **+20.8%** |
| burst G4+held | 183 (tax 1.00) | 237 (tax 1.07) | **+29.5%** |
| burst G16 | 186 [181..214] | 216 [215..238] | **+16.1%** |
| burst G16+held | 186 (tax 1.00) | 233 (tax 1.08) | **+25.3%** |
| burst G64 | 181 [170..184] | 225 [213..242] | **+24.3%** |
| burst G64+held | 175 (tax 0.97) | 230 (tax 1.02) | **+31.4%** |
| typeahead G16xK50 (per key) | 2954 [2776..3024] | 3022 [2979..3091] | +2.3% (overlap) |

Re-confirmed ×2 interleaved rounds (G16: 213–215 vs 179–184, +17%).

### Plain-language summary

**What NF2 bought** (vs 981491c, i.e. S-B + S-C + S-D composed):

- **World evaluation is the headline**: cold-pass 0.54× (nearly 2×
  faster per cold computed read), wide-mask commit+drain 0.76×. The
  stage-composed cold-pass vs the ORIGINAL pre-S-A anchor is ~0.60× —
  NF2 ends cheaper than the tree it started from, with the §4.4.8
  fast-path deletion and the memo ladder gone.
- **Armed writes with computed cones ~2× cheaper**: spkw chain3 −44%,
  fan8 −49% per write at identical eval counts — the arena
  serving/refold path replacing memo validation.
- **Watcher-less retirement flat-to-better** (totals −6..−15%).
- **No new idle or quiet tax**: spkl residuals and quiet-mode overheads
  unchanged within noise.
- **ONE computed API** (kernel `Computed` under any world, F5 split
  dead), the historical hang fixed at its root, `lastFoldFp` and the
  memo machinery deleted — the architectural point of NF2; the numbers
  above say it was bought without paying on the headline shapes.

**What it cost** (residuals, disclosed):

- **High-writes-per-frame fan-out marking**: spkn1 W64 cells +19..24%,
  spkg8 bursts +16..31% (held rows worst; heldTax 1.02–1.08 vs ~1.00).
  The per-write site-(a) fanout now marks every committed arena on
  every write; at W=64 writes per frame the anchor's cheaper
  invalidation amortized better. Typeahead (restart-heavy, the shape
  these bursts feed) stays within noise — the tax is per-write marking,
  not end-to-end latency on the composed schedule.
- **spkw watch1 +8%** (watcher delivery on a bare atom write).
- **spkr-core K8xM8+8w +43% retire** (non-monotonic — K24+8w improved;
  see the table note).
- **untracked-fan 1.08×** (weak-link visits on the storm walk; gate
  headroom 1.4×).

### S-D B5 insurance notes (dalien rows 4/9, audit level)

- **keepNames bench-harness audit — NO-OP CONFIRMED.** The bench
  children run `node --import tsx`; probe (tsx-compiled module source +
  `effect()` disposers): no `__name` helper injected, disposers stay
  anonymous (`.name === ""`), no `defineProperty(fn,'name')` wrap —
  the ~120 ns named-closure tax does not apply to this toolchain.
  (Full `effect()` create+dispose measures ~102 ns — that is the mount/
  teardown lifecycle, not a naming tax.)
- **Monomorphic-array spot check — new S-B/S-C arrays all clean.**
  Element-kinds probe after real traffic (200 committed writes over a
  40-atom/41-computed mixed strong/weak cone): `suspIdx`, `walk`,
  `weakSubs`, `weakSubsTail`, `byNode`, `dirty`, `suspended`,
  `nodeGen`, `obsRefs` are PACKED_SMI; `vals`/`nodesArr` PACKED
  object-elements (they hold values/objects by design). One PRE-NF2
  (P1-era) table is HOLEY: `watchersByNode` (sparse `[node.id] =`
  writes at mount). It sits on warm paths (decay consult, consumer
  count, settlement cone drain), not the read/write hot path; the
  densify is a one-liner at `indexNode` (mirror `nodeGen`'s dense
  fill) — left un-touched here because it predates NF2's scope and the
  battery above prices the tree as it stands. Recorded for the next
  perf pass.

Verification state at these numbers: cosignal 303+1 skipped (incl. the
new S-D pool/wrap + stale-loading-wart pins), oracle 81+1, cosignal-react
62, bytecode budgets 45/45 (aUpdateComputed pinned 486 > the 460 inline
limit — the pin stands), conformance 179/179 × {cosignal,
cosignal-concurrent, arena}, armed fold-truth corpus zero diffs, three
package tscs clean. Mode value renamed: `bridge.mode` `'logged'` →
`'concurrent'` engine+oracle in lockstep; `tests/logged-*.spec.ts` →
`concurrent-*.spec.ts`.
