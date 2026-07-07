# The Great Refactor — outcome accounting (S7)

Campaign: plans/2026-07-07-great-refactor.md + plans/2026-07-07-signal-reclamation.md.
Baseline: `ba20495` (the parent of S0 — the last pre-campaign commit).
Measured tree: post-S6 working state (S7 ride-alongs included).
Methodology: one co-evolved bench file drives both sides (feature-detected
acquisition + a pass→render alias shim for the pre-rename baseline);
interleaved A/B from the harness cwd under tsx; medians of 3 processes.
Machine noise on these lines is ±5%; single-line swings inside that band
are not called.

## Stages landed

| stage | commit | what |
|---|---|---|
| S0 | 274d3ec | dead code, named bounds, checker seam |
| S1 | db4a285…0c1c278 | the renames (arena, batch, RenderPass, WriteLog) — byte-identity proven |
| S2 | f3cd7bc | one id space (kernel record id is THE NodeId) |
| S3 | fork da7a2366 + 0cacd90 | protocol v2 — driver-supplied BatchId, mapping tables deleted |
| S4 | 22822b9, bcce617, c0a2e30 | fifteen mechanism modules extracted |
| S5 | 96ab192 | the always-concurrent merge — hooks/registration/adoption die |
| S5R | b65a3e0 | total signal reclamation (FinalizationRegistry) |
| S6 | 6ac7c0c | documentation campaign |

## The definitive matrix (current vs pre-refactor baseline)

Concurrent machinery — the campaign's subject — improved across the board:

| line | current | baseline | delta |
|---|---|---|---|
| cold-render (ns/computed) | 385 | 428 | **−9.8%** |
| wide-mask lock-in (µs) | 166 | 178 | **−6.8%** |
| untracked-fan storm (ns/write) | 140 | 161 | **−13.4%** |
| spkn1 logged propagation (8 shapes) | — | — | **−0.4% … −14.0%** (7 of 8 better) |
| spkw logged watch1 | 111.5 | 114.7 | −2.8% |
| spkw logged bare/chain3/fan8 | — | — | +1.1…+9.4% (bare +9.4% carries the direct-entry cost below) |
| quiet folds (all 4 shapes) | — | — | −0.1…+2.0% (flat) |
| spkg8 (7 shapes) | — | — | −6.3…+3.6% (flat) |
| spkr-core end-to-end (5 shapes) | — | — | −18.7…+11.7% mixed (noisy frame-scale lines; totals net negative) |
| spkk1 retention: walk degrade | **0.00%** | 12.28% (max 24.6%) | **eliminated** |
| spkk1 retention: RETAIN MB/h | 11220 | 11426 | −1.8% |
| spkn1 spurious deliveries | identical | identical | 0 |

Plain direct paths (no batches, no driver — the alien-signals-compatible
mode) carry small absolute costs:

| line | current | baseline | delta |
|---|---|---|---|
| bare write | 6.1–6.5 ns | 5.05–5.2 ns | **≈ +1.0–1.3 ns** |
| readPoll | 2.86 ns | 2.53 ns | +0.33 ns |
| fan8 direct | 267–269 | 243–244 | +9.7…+10.1% (≈ +2.9 ns per effect run) |
| chain3 / watch1 / spkl walks | — | — | +2.2…+4.8% |

Attribution (each priced when landed): the content-lazy `_node` check on
every write (the always-concurrent design), the `standaloneQuiet` guard,
reclamation's one-flag boundary arm, and — under the tsx loader — cyclic
import-cell reads that an esbuild bundle collapses. The V8-level fix round
at S5 (singleton compares instead of truthiness tests, `var` flags,
store-on-change setters, writeAtom re-homed) already recovered ~2.3 ns of
an initially +2.6 ns entry cost; what remains is the design's honest price
plus loader tax. **S8's ledgered question: measure the published (bundled)
artifact — if the direct-line deltas collapse there, the npm story is
flat-to-better everywhere.**

Creation (reclamation's priced cost; STOP finding accepted at S5R —
research/experiments/2026-07-07-s5r-creation-budget-finding.md): Atom
≈ 59 vs 26–43 ns, Computed ≈ 65 vs 21–31, ReducerAtom ≈ 72 vs 46–49.
`FinalizationRegistry.register` alone is +14.2 ns on this V8; death-side
cost sits below the primitive's own no-op-finalizer floor. Leak-freedom is
the absolute rule; the primitive's price is documented, not negotiable
away.

## Bytecode re-pin (S7)

All 46 checks green. Annotations refreshed to Node 24.16 measured values;
budgets tightened where the merge shrank functions structurally: write
180→130 (measured 96, was 152), writeAtom 120→90 (67), foldAtom 350→190
(142 — the equality unification), shadowFor 310→210 (163), arenaUnlink
380→340 (276), arenaSyncObsAfterRefold 130→90 (65). One budget loosened:
arenaShallowPropagate 140→160 (measured 112→127, reclamation's obs-release
trigger). New guard: a scope-merge collision assertion — if esbuild ever
renames a budgeted function to `name2`, the suite fails instead of
measuring the wrong symbol.

## Ledger dispositions

- **quiet ≤14 ns (S2 ledger)** — CLOSED, mis-anchored: the 12.9 ns figure
  came from a different-era bench metric. On the identical co-evolved
  bench, baseline quiet = 16.85–17.5 ns and current = 17.2 ns: flat.
- **fan8 +5% (E5/E6 ledger)** — CONFIRMED as the direct-line residual
  (+9.7% vs baseline including the entry costs above); rides S8's
  bundled-artifact measurement.
- **cold-render (S5 ledger)** — CLOSED better: −9.8% vs baseline.
- **bare +0.31 ns (S5) and creation floor (S5R)** — open, owned by S8's
  bundled-artifact pass.
- Five formerly bit-rotted `-logged` bench files were repaired with
  feature detection at S5 (timed loops byte-identical) — retire/repair
  RESOLVED as repair.
- spkk1's metric label "gate planes MB/h" predates the vocabulary ruling;
  bench metric names stay stable for results continuity.
