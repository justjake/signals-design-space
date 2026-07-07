# Full-field results: all 16 registered frameworks + react-seam-bench

2026-07-06. Full sweep of every framework registered in
`harness/adapters/index.ts`, plus the react-seam-bench React-consumption
field with two new contenders (`alt-a-uses`, `alt-b-uses`). All numbers
re-measured this session; nothing inherited from implementation agents.

## Executive summary (field standings)

1. **Conformance is green across the entire field**: all 16 registered
   frameworks pass 179/179, including the historical arena variants.
2. **cosignal (DIRECT) and cosignal-concurrent lead the field**: overall
   geomean **0.83x** vs alien-v3 (dynamic 0.78x, sbench 0.49x, cellx 0.81x,
   kairo 1.05x) with memory at 0.85x — the first libraries to beat alien
   broadly rather than on one axis.
3. **arena is second (0.88x overall)**: creation (sbench 0.51x) and dynamic
   (0.85x) wins now outweigh its kairo propagation tax (1.10x).
4. **sweep still owns cellx (0.40x) and kairo geomean (0.91x)** but its
   updateSignals collapse (171x) and wide-dynamic losses (2.6-6.1x) stand.
5. **dalien** sits at 0.93x overall — modest but uniform wins (sbench 0.65x,
   dynamic 0.91x) with near-par kairo (1.06x).
6. **cosignals-alt-a is the field's memory outlier**: 3.84x retained heap on
   signals, 2.47x geomean, and 1.29x overall speed — the concurrent
   write-gate machinery is paid per-node. alt-b is cheaper (1.19x overall,
   1.39x memory) but still behind every sync-only design.
7. **Tier-0 shapes**: cosignal wins reads (0.58x) and isolate (0.81x)
   outright; arena-spkq shows a GC-tail pathology (create gc 92.8 ms,
   p99 6-10x its min) that fastest-of-N reporting hides.
8. **react-seam-bench**: at the uSES seam every signal library is
   indistinguishable (fanout/transition within ±7% of alien-uses); the new
   `alt-a-uses`/`alt-b-uses` contenders land on the baseline cluster.
   cosignal-react's differentiator shows in the tail, not the median:
   urgentMax ~6 ms vs ~11-12 ms for every uSES store (its writes classify
   into the transition; uSES stores force a blocking bulk render).
   baseline-context remains the anti-pattern (7x fanout).
9. **CI**: `.github/workflows/field-bench.yml` (new) adds the weekly/dispatch
   conformance gate (all 16, fail-on-regression) + single-pass kairo/shapes
   ratio bench with artifacts and a step-summary ratio table.
10. Raw outputs in `harness/results/` (stamps below); ratios in this report
    are same-machine, fastest-of-2-interleaved-passes.

## Methodology

- **Machine**: Apple M4 Max (16 cores), macOS arm64 (Darwin 25.5.0), Node
  v24.16.0, pnpm 10.33.0. Lived-in desktop (ambient loadavg ~4-8 from GUI
  apps); load recorded per step below and in each result file's JSON
  metadata.
- **Conformance**: `FRAMEWORK=<fw> pnpm -C harness conformance`
  (reactive-framework-test-suite v0.0.2 via vitest 4.1.6, 179 cases), one
  fresh run per framework, sequential, 2026-07-06 ~14:00.
- **Bench**: `pnpm -C harness bench --timeout 1200000` — all 4 suites
  (kairo incl. molBench, sbench, cellx, dynamic with `testPullCounts`),
  one esbuild-bundled child per (framework, suite) pair under
  `node --expose-gc`. The milomg harness reports fastest-of-N per cell.
  **Two interleaved passes** (each pass runs all 16 frameworks in registry
  order before the next starts); cells below are **fastest-of-2-passes**.
  External interference only ever adds time, so the min is the honest
  estimator — and it automatically lets pass 2 govern any cell that pass
  1's interference window inflated (see caveats).
- **Tier-0 shapes**: `pnpm -C harness exec tsx bench/shapes.ts` with all 8
  shapes (deep/broad/diamond/dynamic/create/write/reads/isolate),
  `--reps 12`, all 16 frameworks in ONE invocation (ratios are
  same-invocation); min-of-reps, p99-of-reps, and GC pause time/count
  inside the timed window (PerformanceObserver 'gc').
- **Memory**: `pnpm -C harness memory` — retained KB through the shared
  adapter (uniform `{read,write}` wrapper overhead; compare relatively,
  not against upstream's raw-API numbers).
- **react-seam-bench**: real `react-dom/client` roots in jsdom against the
  vendored React fork build; one contender per process, 3 interleaved
  rounds per pass, median-of-rounds per cell (package README has the full
  contract). Two passes; cells = min of the two pass medians.
- **Correctness at bench scale**: all 128 bench children (2 passes x 16
  frameworks x 4 suites) exited 0 with zero `console.assert` failures
  (dynamic ran with `testPullCounts: true`); shapes cross-checked
  checksums between frameworks with zero mismatches.
- **Raw outputs** (all in `harness/results/`):
  - bench pass 1: `2026-07-06T14-02-28-<fw>.{json,csv}` + `2026-07-06-field-pass1.log`
  - bench pass 2: `2026-07-06T14-20-11-<fw>.{json,csv}` + `2026-07-06-field-pass2.log`
  - memory: `2026-07-06T23-25-33-memory-<fw>.{json,csv}` + `2026-07-06-field-memory.log`
  - shapes: `2026-07-06-field-shapes.log`
  - react-seam: `2026-07-06-react-seam-pass{1,2}.csv`
  - Ratio tables below were generated with `harness/util/ratio-table.mjs`
    (new; also used by the CI workflow).

### Machine-load discipline (loadavg at step start)

| step | loadavg | notes |
|---|---|---|
| conformance sweep (~14:00) | 4.29, 4.06, 4.06 | ambient only |
| bench pass 1 (14:02) | 4.67, 3.97, 4.00 | first ~10 min shared with light lint/smoke work (caveat below) |
| bench pass 2 (14:20) | 7.17, 6.86, 5.87 | 1-min avg still elevated from pass 1 itself; machine otherwise left alone |
| memory probe (23:25) | 8.14, 7.04, 5.22 | ambient desktop (Slack/Cursor/WindowServer); no compute jobs |
| shapes (23:26) | 6.50, 6.76, 5.19 | same |
| react-seam pass 1 (23:26) | 4.99, 6.34, 5.10 | same |
| react-seam pass 2 (23:27) | 5.01, 6.20, 5.13 | same |

### Caveats

- This is a 16-core desktop with ambient load ~4-8, not an idle lab
  machine. Per-cell minimum across interleaved passes plus
  ratios-vs-same-pass-alien are the defenses; both passes agree within
  normal spread on the cells that matter.
- During the first ~10 minutes of bench pass 1 (alien-v3/control/sweep
  cells) a seam-bench smoke test and an actionlint install ran in
  parallel — one-sided interference; fastest-of-passes defers those cells
  to pass 2 wherever pass 1 was hurt.
- Fastest-of-N hides GC cost (flatters allocation-heavy designs); the
  shapes table's gc/p99 columns exist to show exactly what it hides (see
  arena-spkq).
- Memory is a single run per framework (deterministic modulo GC timing).

## Conformance matrix (2026-07-06, all 16 registered frameworks)

`FRAMEWORK=<fw> pnpm -C harness conformance` — 179 cases; every framework
below exports `untracked`, so the 7 "Untracked / Unsampled Reads" cases run
for real.

| framework | result | exit code |
|---|---|---|
| alien-v3 | **179/179 passed** | 0 |
| control | **179/179 passed** | 0 |
| sweep | **179/179 passed** | 0 |
| arrayd | **179/179 passed** | 0 |
| arena | **179/179 passed** | 0 |
| arena-links | **179/179 passed** | 0 |
| arena-masked | **179/179 passed** | 0 |
| arena-host | **179/179 passed** | 0 |
| arena-host-fused | **179/179 passed** | 0 |
| arena-spkh | **179/179 passed** | 0 |
| arena-spkq | **179/179 passed** | 0 |
| dalien | **179/179 passed** | 0 |
| cosignal | **179/179 passed** | 0 |
| cosignal-concurrent | **179/179 passed** | 0 |
| cosignals-alt-a | **179/179 passed** | 0 |
| cosignals-alt-b | **179/179 passed** | 0 |

Historical variants (e.g. `arena-masked`) remain green as registered;
reported as-is per scope.

## Benchmarks — ratio vs alien-v3 (fastest-of-2 interleaved passes; <1 = faster)

Baseline column = alien-v3 absolute ms. Geomean row = geometric mean of the
column's ratios (the one-number field standing for that suite).

### kairo (incl. molBench)

| test | alien-v3 (ms) | control | sweep | arrayd | arena | arena-links | arena-masked | arena-host | arena-host-fused | arena-spkh | arena-spkq | dalien | cosignal | cosignal-concurrent | cosignals-alt-a | cosignals-alt-b |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| kairo/avoidablePropagation | 91.24 | 1.04x | 1.07x | 1.08x | 1.21x | 1.38x | 1.34x | 1.27x | 1.27x | 1.31x | 1.28x | 1.18x | 1.17x | 1.22x | 1.45x | 1.50x |
| kairo/broadPropagation | 73.31 | 1.00x | 0.84x | 1.06x | 1.12x | 1.38x | 1.52x | 1.25x | 1.22x | 1.17x | 1.14x | 1.00x | 0.96x | 0.97x | 1.32x | 1.51x |
| kairo/deepPropagation | 32.74 | 0.94x | 0.87x | 0.98x | 1.05x | 1.45x | 1.43x | 1.27x | 1.19x | 1.12x | 1.11x | 0.98x | 0.90x | 0.90x | 1.28x | 1.49x |
| kairo/diamond | 81.81 | 0.98x | 0.87x | 1.06x | 1.00x | 1.18x | 1.23x | 1.03x | 1.06x | 1.06x | 1.06x | 1.09x | 1.07x | 1.08x | 1.09x | 1.29x |
| kairo/mux | 76.81 | 0.99x | 1.02x | 0.98x | 0.96x | 1.21x | 1.19x | 1.03x | 0.99x | 0.99x | 0.98x | 0.88x | 0.86x | 0.87x | 1.07x | 1.15x |
| kairo/repeatedObservers | 12.59 | 0.98x | 1.05x | 0.98x | 1.29x | 1.35x | 1.67x | 1.34x | 1.36x | 1.28x | 1.29x | 1.06x | 1.14x | 1.16x | 1.25x | 1.35x |
| kairo/triangle | 26.25 | 0.97x | 0.88x | 1.17x | 1.00x | 1.17x | 1.22x | 1.03x | 1.01x | 1.03x | 0.99x | 1.09x | 1.01x | 1.01x | 1.07x | 1.25x |
| kairo/unstable | 12.74 | 1.03x | 0.69x | 0.82x | 1.40x | 1.56x | 1.80x | 1.53x | 1.48x | 1.43x | 1.43x | 1.35x | 1.39x | 1.42x | 1.60x | 1.83x |
| kairo/molBench | 14.82 | 0.98x | 0.95x | 0.94x | 0.92x | 0.96x | 0.94x | 0.95x | 0.96x | 1.05x | 1.03x | 0.97x | 1.01x | 0.93x | 0.95x | 0.98x |
| **geomean ratio** | 1.00x | 0.99x | 0.91x | 1.00x | 1.10x | 1.28x | 1.35x | 1.18x | 1.16x | 1.15x | 1.14x | 1.06x | 1.05x | 1.05x | 1.22x | 1.35x |

### sbench

| test | alien-v3 (ms) | control | sweep | arrayd | arena | arena-links | arena-masked | arena-host | arena-host-fused | arena-spkh | arena-spkq | dalien | cosignal | cosignal-concurrent | cosignals-alt-a | cosignals-alt-b |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sbench/createSignals | 9.29 | 0.98x | 0.09x | 1.19x | 0.37x | 0.70x | 0.48x | 0.31x | 0.31x | 0.40x | 0.39x | 0.58x | 0.31x | 0.27x | 3.74x | 1.13x |
| sbench/createComputations | 73.04 | 1.09x | 0.97x | 2.25x | 0.48x | 1.93x | 0.74x | 0.73x | 0.92x | 0.50x | 0.50x | 0.60x | 0.48x | 0.48x | 1.05x | 0.80x |
| sbench/updateSignals | 314.28 | 0.98x | 171.30x | 0.92x | 0.74x | 1.29x | 1.27x | 0.92x | 0.91x | 0.88x | 0.84x | 0.78x | 0.78x | 0.78x | 0.94x | 0.84x |
| **geomean ratio** | 1.00x | 1.01x | 2.46x | 1.35x | 0.51x | 1.20x | 0.77x | 0.59x | 0.64x | 0.56x | 0.55x | 0.65x | 0.49x | 0.47x | 1.54x | 0.91x |

sweep's updateSignals remains the known O(live effects)-per-unbatched-write
collapse (the 07-03 first-cut report has the full analysis, including the
harness `withBuild` warmup-leak amplifier that only global-scan designs pay
for). alien-v3's createSignals baseline (9.29) is ~2.7x its 07-03 value
(3.45) in BOTH passes; the ratio columns absorb this, but treat that row's
absolute column with suspicion.

### cellx

| test | alien-v3 (ms) | control | sweep | arrayd | arena | arena-links | arena-masked | arena-host | arena-host-fused | arena-spkh | arena-spkq | dalien | cosignal | cosignal-concurrent | cosignals-alt-a | cosignals-alt-b |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cellx/cellx1000 | 5.85 | 0.96x | 0.44x | 1.04x | 0.81x | 1.15x | 1.03x | 0.95x | 0.97x | 0.86x | 0.83x | 0.98x | 0.80x | 0.78x | 1.69x | 1.12x |
| cellx/cellx2500 | 14.50 | 0.94x | 0.35x | 1.06x | 0.88x | 1.20x | 0.97x | 1.11x | 1.02x | 0.87x | 0.81x | 1.03x | 0.82x | 0.79x | 2.39x | 1.57x |
| **geomean ratio** | 1.00x | 0.95x | 0.40x | 1.05x | 0.84x | 1.17x | 1.00x | 1.03x | 1.00x | 0.86x | 0.82x | 1.01x | 0.81x | 0.78x | 2.01x | 1.33x |

### dynamic (testPullCounts on; exact evaluation counts asserted)

| test | alien-v3 (ms) | control | sweep | arrayd | arena | arena-links | arena-masked | arena-host | arena-host-fused | arena-spkh | arena-spkq | dalien | cosignal | cosignal-concurrent | cosignals-alt-a | cosignals-alt-b |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dynamic/2-10x5 - lazy80% | 142.66 | 1.02x | 1.36x | 1.09x | 0.95x | 1.42x | 1.36x | 1.02x | 1.02x | 0.99x | 0.98x | 1.08x | 0.94x | 0.96x | 1.23x | 1.40x |
| dynamic/6-10x10 - dyn25% - lazy80% | 120.83 | 0.97x | 0.84x | 1.16x | 0.84x | 1.24x | 1.24x | 0.86x | 0.86x | 0.83x | 0.84x | 0.90x | 0.76x | 0.77x | 0.97x | 1.05x |
| dynamic/4-1000x12 - dyn5% | 331.57 | 0.96x | 6.14x | 0.92x | 0.88x | 1.16x | 1.11x | 0.90x | 0.94x | 0.87x | 0.86x | 0.90x | 0.81x | 0.83x | 1.25x | 1.05x |
| dynamic/25-1000x5 | 398.16 | 0.99x | 2.62x | 1.02x | 0.79x | 1.24x | 1.07x | 0.78x | 0.83x | 0.79x | 0.81x | 0.84x | 0.70x | 0.71x | 0.97x | 0.98x |
| dynamic/3-5x500 | 92.95 | 1.11x | 0.87x | 1.01x | 0.81x | 1.24x | 1.09x | 0.82x | 0.86x | 0.80x | 0.82x | 0.90x | 0.72x | 0.70x | 1.15x | 1.00x |
| dynamic/6-100x15 - dyn50% | 200.62 | 0.95x | 0.97x | 1.02x | 0.82x | 1.21x | 1.03x | 0.86x | 0.86x | 0.83x | 0.82x | 0.83x | 0.78x | 0.80x | 1.07x | 1.08x |
| **geomean ratio** | 1.00x | 1.00x | 1.58x | 1.03x | 0.85x | 1.25x | 1.14x | 0.87x | 0.89x | 0.85x | 0.86x | 0.91x | 0.78x | 0.79x | 1.10x | 1.08x |

control's `3-5x500` +11% is the same deep-graph regression flagged in the
first-cut report (was +18%); still real, still unexplained.

### Overall (geomean across all 20 suite cells)

| alien-v3 | control | sweep | arrayd | arena | arena-links | arena-masked | arena-host | arena-host-fused | arena-spkh | arena-spkq | dalien | cosignal | cosignal-concurrent | cosignals-alt-a | cosignals-alt-b |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.00x | 0.99x | 1.15x | 1.06x | **0.88x** | 1.25x | 1.14x | 0.96x | 0.97x | 0.92x | 0.91x | 0.93x | **0.83x** | **0.83x** | 1.29x | 1.19x |

## Tier-0 shapes (--reps 12; min-of-reps ratio vs alien-v3; GC + p99 columns)

Cell = ratio vs alien-v3 (baseline column absolute) · total GC pause
time/count inside the 12-rep window · p99 ms across reps. Checksums matched
across all 16 frameworks on every shape. Full fixed-width table (absolute
ms everywhere) in `harness/results/2026-07-06-field-shapes.log`.

| shape | alien-v3 | control | sweep | arrayd | arena | arena-links | arena-masked | arena-host | arena-host-fused | arena-spkh | arena-spkq | dalien | cosignal | cosignal-concurrent | cosignals-alt-a | cosignals-alt-b |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deep | 3.8ms · gc 2.1ms/24 · p99 4.5 | 1.07x · gc 0.4ms/1 · p99 4.7 | 1.21x · gc 0.3ms/1 · p99 5.1 | 1.02x · gc 0.4ms/1 · p99 4.3 | 0.87x · gc 0 · p99 4.0 | 1.24x · gc 0.3ms/1 · p99 5.7 | 1.03x · gc 0 · p99 4.6 | 0.87x · gc 0 · p99 5.2 | 0.90x · gc 0 · p99 5.5 | 0.86x · gc 0 · p99 3.9 | 0.89x · gc 0 · p99 13.9 | 0.84x · gc 0 · p99 3.9 | 0.74x · gc 0 · p99 3.4 | 0.75x · gc 0 · p99 3.5 | 1.20x · gc 0.3ms/1 · p99 5.3 | 1.38x · gc 0.7ms/1 · p99 6.1 |
| broad | 3.9ms · gc 0.1ms/1 · p99 4.9 | 1.15x · gc 0.3ms/1 · p99 5.8 | 1.01x · gc 0.2ms/1 · p99 4.6 | 1.12x · gc 0.2ms/1 · p99 4.6 | 0.99x · gc 0 · p99 4.4 | 1.26x · gc 0.2ms/1 · p99 5.2 | 1.20x · gc 0.3ms/1 · p99 5.3 | 1.07x · gc 0.4ms/1 · p99 4.6 | 1.07x · gc 0 · p99 4.4 | 0.96x · gc 0.3ms/1 · p99 4.2 | 1.20x · gc 0.8ms/1 · p99 18.3 | 0.93x · gc 0.2ms/1 · p99 4.1 | 0.86x · gc 0 · p99 3.8 | 0.88x · gc 0 · p99 3.9 | 1.11x · gc 1.5ms/3 · p99 4.9 | 1.21x · gc 0 · p99 5.3 |
| diamond | 1.4ms · gc 0.1ms/1 · p99 1.8 | 1.07x · gc 0 · p99 2.0 | 1.06x · gc 0 · p99 1.9 | 1.31x · gc 0 · p99 2.2 | 0.88x · gc 0.5ms/2 · p99 2.6 | 1.27x · gc 0.1ms/1 · p99 2.1 | 1.05x · gc 0.5ms/2 · p99 2.7 | 0.88x · gc 0.5ms/2 · p99 2.7 | 0.88x · gc 0.7ms/2 · p99 2.7 | 0.85x · gc 0.6ms/2 · p99 2.7 | 1.17x · gc 2.0ms/2 · p99 6.5 | 0.91x · gc 0.6ms/2 · p99 2.6 | 0.84x · gc 0.5ms/2 · p99 2.8 | 0.82x · gc 0.5ms/2 · p99 2.6 | 1.00x · gc 0.3ms/1 · p99 2.6 | 1.09x · gc 0.6ms/1 · p99 3.1 |
| dynamic | 0.3ms · gc 0.1ms/1 · p99 0.5 | 1.12x · gc 0.2ms/1 · p99 0.7 | 1.20x · gc 0.1ms/1 · p99 0.4 | 1.11x · gc 0.2ms/1 · p99 0.6 | 0.96x · gc 0 · p99 0.5 | 1.32x · gc 0 · p99 0.7 | 1.08x · gc 0 · p99 0.5 | 1.07x · gc 0 · p99 0.5 | 1.02x · gc 0 · p99 0.5 | 1.03x · gc 0 · p99 0.5 | 1.05x · gc 1.9ms/1 · p99 3.0 | 1.04x · gc 0.4ms/1 · p99 0.5 | 0.92x · gc 0 · p99 0.6 | 0.99x · gc 0 · p99 0.5 | 1.30x · gc 0 · p99 0.6 | 1.34x · gc 0 · p99 0.7 |
| create | 5.4ms · gc 14.9ms/7 · p99 13.0 | 2.24x · gc 27.3ms/11 · p99 23.4 | 2.13x · gc 33.8ms/11 · p99 23.4 | 2.14x · gc 26.4ms/11 · p99 23.6 | 0.93x · gc 29.6ms/7 · p99 12.0 | 2.55x · gc 12.0ms/10 · p99 24.5 | 0.98x · gc 32.5ms/9 · p99 11.4 | 1.07x · gc 23.3ms/8 · p99 12.5 | 1.06x · gc 24.4ms/8 · p99 12.6 | 0.93x · gc 29.8ms/7 · p99 12.4 | 1.01x · gc 92.8ms/7 · p99 35.5 | 1.08x · gc 31.4ms/9 · p99 13.6 | 1.01x · gc 31.0ms/8 · p99 14.9 | 0.99x · gc 28.7ms/8 · p99 14.5 | 2.54x · gc 74.5ms/13 · p99 36.7 | 1.37x · gc 52.7ms/8 · p99 16.7 |
| write | 2.1ms · gc 0 · p99 3.1 | 1.12x · gc 0 · p99 3.5 | 1.00x · gc 0 · p99 2.4 | 0.95x · gc 0 · p99 3.2 | 1.06x · gc 0 · p99 2.8 | 0.95x · gc 0.2ms/1 · p99 2.7 | 0.88x · gc 0 · p99 2.8 | 1.18x · gc 0 · p99 2.9 | 1.23x · gc 0 · p99 2.9 | 1.06x · gc 0 · p99 2.8 | 1.20x · gc 0 · p99 29.3 | 0.96x · gc 4.9ms/2 · p99 3.0 | 0.87x · gc 0 · p99 3.4 | 1.36x · gc 0 · p99 3.9 | 2.26x · gc 0 · p99 6.0 | 2.18x · gc 6.0ms/1 · p99 5.6 |
| reads | 6.1ms · gc 0 · p99 6.6 | 1.13x · gc 0 · p99 7.5 | 1.01x · gc 0 · p99 6.7 | 1.03x · gc 0 · p99 6.6 | 0.94x · gc 0 · p99 6.7 | 1.00x · gc 0 · p99 6.8 | 1.16x · gc 0 · p99 7.5 | 1.05x · gc 0 · p99 7.3 | 1.03x · gc 0 · p99 7.2 | 0.96x · gc 0 · p99 6.5 | 0.99x · gc 0 · p99 15.8 | 0.96x · gc 0 · p99 6.2 | 0.58x · gc 0 · p99 4.2 | 0.57x · gc 0 · p99 3.8 | 1.05x · gc 4.1ms/1 · p99 6.7 | 1.16x · gc 0 · p99 7.4 |
| isolate | 3.8ms · gc 1.6ms/1 · p99 4.3 | 1.11x · gc 0 · p99 4.5 | 1.54x · gc 0 · p99 6.3 | 0.99x · gc 0 · p99 4.2 | 0.90x · gc 0 · p99 4.0 | 1.12x · gc 0 · p99 5.1 | 1.01x · gc 0 · p99 4.6 | 1.02x · gc 0 · p99 4.3 | 1.00x · gc 0 · p99 4.3 | 0.88x · gc 0 · p99 4.1 | 0.93x · gc 0 · p99 4.2 | 1.06x · gc 0 · p99 4.7 | 0.81x · gc 0 · p99 3.7 | 0.84x · gc 0 · p99 3.8 | 1.02x · gc 0 · p99 4.2 | 1.41x · gc 0 · p99 6.1 |

Shape notes:

- **cosignal's reads/isolate wins (0.58x/0.81x)** replicate its
  hot/slow-split computedRead result from the implementation phase; they
  are the biggest clean-read margins in the field.
- **arena-spkq GC-tail pathology**: min-ms looks fine (par with arena) but
  its p99 spikes 6-10x (deep 13.9, broad 18.3, write 29.3, create 35.5)
  with create GC at 92.8 ms — 3x any sibling. Fastest-of-N tables would
  never show this.
- **sweep isolate 1.54x** is the designed loss (global-epoch revalidation
  under unrelated writes); alien/arena keep B-reads O(1).
- **alt-a write 2.26x / alt-b 2.18x**: the concurrent write gate is paid on
  every unobserved write.
- The `create` shape's 2.1-2.2x on control/sweep/arrayd vs alien is
  scope-teardown dominated (effectScope dispose); arena's bulk-free wins it.

## Memory (retained KB through shared adapter; single run; ratio vs alien-v3)

| metric | alien-v3 (kb) | control | sweep | arrayd | arena | arena-links | arena-masked | arena-host | arena-host-fused | arena-spkh | arena-spkq | dalien | cosignal | cosignal-concurrent | cosignals-alt-a | cosignals-alt-b |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| signals-10k | 3059.69 | 1.00x | 0.92x | 1.26x | 1.07x | 1.08x | 1.07x | 1.24x | 1.24x | 1.07x | 1.07x | 1.28x | 0.91x | 0.91x | 3.84x | 1.23x |
| computeds-10k | 3535.08 | 1.02x | 1.09x | 1.18x | 1.01x | 1.02x | 1.01x | 1.14x | 1.14x | 1.01x | 1.01x | 1.03x | 0.94x | 0.94x | 3.85x | 1.74x |
| effects-10k | 3861.07 | 1.00x | 1.45x | 0.76x | 0.74x | 0.69x | 0.62x | 0.73x | 0.72x | 0.73x | 0.74x | 0.92x | 0.74x | 0.74x | 1.01x | 1.14x |
| grid-100x100 | 7120.87 | 1.01x | 1.27x | 1.05x | 0.85x | 0.83x | 0.77x | 0.92x | 0.91x | 0.85x | 0.85x | 0.96x | 0.82x | 0.82x | 2.50x | 1.55x |
| **geomean ratio** | 1.00x | 1.01x | 1.17x | 1.04x | 0.91x | 0.89x | 0.85x | 0.99x | 0.98x | 0.90x | 0.91x | 1.04x | 0.85x | 0.85x | 2.47x | 1.39x |

cosignal and arena-masked tie for best memory geomean (0.85x). alt-a's
3.84x/3.85x on nodes is the field outlier — per-node handles plus metadata
for the concurrent engine; alt-b's typed-array planes keep nodes near par
(1.23x) but pay 1.74x on computeds.

## react-seam-bench (7 contenders, 2 passes x 3 interleaved rounds; min of pass medians)

fanout = median single-cell write-to-commit; transition = p95 urgent
update-to-commit during a 2000-cell `startTransition` rewrite; mount =
median mount+first-commit of the 5000-cell tree. Ratios vs **alien-uses**
(the uSES-style baseline). jsdom: JS-side cost only.

| contender | fanout (ms) | transition (ms) | mount (ms) | fanout vs alien-uses | transition vs alien-uses | mount vs alien-uses |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cosignal-react | 1.84 | 1.64 | 72.57 | 1.00x | 1.03x | 1.38x |
| alien-uses | 1.84 | 1.59 | 52.51 | 1.00x | 1.00x | 1.00x |
| dalien-uses | 1.82 | 1.54 | 51.86 | 0.99x | 0.97x | 0.99x |
| baseline-context | 12.98 | 2.06 | 52.99 | 7.05x | 1.30x | 1.01x |
| baseline-local | 1.68 | 1.74 | 54.85 | 0.91x | 1.09x | 1.04x |
| alt-a-uses (NEW) | 1.80 | 1.55 | 54.95 | 0.98x | 0.97x | 1.05x |
| alt-b-uses (NEW) | 1.71 | 1.49 | 53.28 | 0.93x | 0.94x | 1.01x |

- **New contenders**: `alt-a-uses` and `alt-b-uses`
  (`packages/react-seam-bench/src/adapters/alt{A,B}.ts`, 63/67 lines) bind
  cosignals-alt-a/alt-b as plain uSES-style stores — subscribe via
  `effect`, snapshot via `.state`, bulk writes via `startBatch`/`endBatch`.
  **Documented limitation**: neither variant's concurrent API maps to real
  React — alt-b's `startSignalTransition` throws without an attached
  ForkDouble, and alt-a's world routing also lives behind its fork-double
  adapter — so `writeManyInTransition` is the plain-store
  `startTransition(() => writeMany(...))` shape, which React demotes to a
  blocking render per the useSyncExternalStore caveat. They are directly
  comparable to alien-uses/dalien-uses, and land exactly on that cluster.
- **Medians hide the transition story; the tail shows it**: per-round
  urgentMax for cosignal-react was ~6.0-6.1 ms across all rounds vs
  ~11-12.5 ms for every uSES store (alien/dalien/alt-a/alt-b) —
  cosignal-react's writes classify into the transition, so no urgent
  update ever waits behind the 2000-cell blocking flush.
  baseline-local/baseline-context (native state) also sit at ~5.4-5.8 ms
  max. The p95 medians in the table are within noise of each other in this
  jsdom field because only 1-2 of 30 urgent updates collide with the flush.
- cosignal-react's mount 1.38x is the cost of registering its binding per
  cell at first commit; fanout parity says the steady-state seam is free.
- baseline-context fanout 7x: every one of the 5000 consumers re-renders
  per single-cell write (meanCellRendersPerWrite = 5000 vs 1 for stores).

## CI

`.github/workflows/field-bench.yml` (NEW; named field-bench because
`bench.yml` already exists and is owned by the cosignal gate-bench
workstream). Triggers: `workflow_dispatch` (with `react_seam` boolean and
`shapes_reps` inputs) and weekly cron (Mon 06:17 UTC). Jobs:

- **plan**: derives the framework matrix from `harness/adapters/index.ts`
  so CI can never drift from the registry.
- **conformance** (the blocking gate): 179-case suite per framework,
  16-way matrix, fails on any regression.
- **bench**: kairo (per-process) + all tier-0 shapes for every framework,
  single pass on one runner; emits RATIOS vs alien-v3 (via
  `harness/util/ratio-table.mjs`, NEW) to the job summary — never absolute
  thresholds; uploads JSON/CSV artifacts. Committed baseline results are
  cleared from the CI workspace so only same-runner numbers enter the
  table.
- **react-seam** (input-gated): inits vendor/react, builds the fork via
  `fork/build-react.sh`, full root install, runs the seam field, publishes
  the CSV.

Targeted submodule init everywhere: `milomg-reactivity-benchmark`,
`upstream-alien-signals` (built before install — the harness consumes it
via `file:`), plus `packages/dalien-signals` (the dalien adapter imports
its TS source and the root lockfile carries its workspace importer);
`vendor/react` only in the seam job. Validated with actionlint (clean).

NOTE for whoever commits this: `packages/react-seam-bench/package.json`
gained `cosignals-alt-a`/`cosignals-alt-b` workspace deps. This session
deliberately did not write `pnpm-lock.yaml` (installed with
`--config.lockfile=false`), but a concurrent root `pnpm install` by other
work in this tree later folded the two new importers into the lockfile
(mixed with unrelated churn: `packages/dalien-signals-userspace`). Commit
the react-seam-bench manifest and the lockfile importer lines together so
the CI seam job's frozen install stays consistent.
