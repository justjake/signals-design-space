# The flattening — outcome accounting

Campaign: plans/2026-07-08-the-flattening.md (revision 3 + three owner
amendments). Base compared: main at the campaign's end vs the completed
`flattening-simple-adopted` branch. Interleaved medians of 3 per line, tsx
from the harness; bundles built identically per side.

## What was built

One arena-based engine module (CosignalEngine.ts, eleven sections read in
order) replacing the kernel/concurrent split and the fifteen-module
composition: generated-then-frozen layout with hand-owned coherence
functions; per-root consult-driven UpdatedAt clocks over tagged outcomes;
the episode lifecycle replacing write-log compaction (grow during, drop
wholesale at quiescence, threshold prefix-fold valve for held-open
episodes); the naive array-of-objects write log (chosen by a three-way
benchmark over the chunked tape and the old windowed log); watchers and
subscriptions as arena records with at-least-once clock-gated re-fires;
render integration in-module; world arenas with mid-operation grow-by-copy
and pooled shells. Deferred by owner fast-path ruling: SSR, the
world-storage object-implementation A/B (both clean post-merge units — the
narrow world-access function set the seam needs is already in place).

## The final matrix (adopted vs main)

Concurrent machinery — the product — improved everywhere:

| line | adopted | main | delta |
|---|---|---|---|
| wide-mask lock-in (µs) | 136.4 / 136.8 | 150.7 / 209.9 | **−9% … −35%** |
| cold-render (ns) | 345 / 368 | 365 / 456 | better both rounds |
| logged watch1 | 107.9 | 112.6 | **−4.2%** |
| logged bare | 74.7 | 79.0 | −5.5% (high-variance line; parity-to-better) |
| logged fan8 | 381.0 | 384.6 | −0.9% |
| storm (ns/write) | 142.2 / 131.0 | 143.9 / 134.6 | flat-to-better |
| quiet | 16.07 | 16.05 | flat |
| tsx bare / watch1 / chain3 / fan8 | 6.08 / 37.6 / 78.3 / 277.9 | 6.18 / 37.0 / 75.3 / 266.0 | flat / +1.5% / +4.0% / +4.5% (noise-band lines) |

Bundled artifact: fan8-direct 129.6 vs 131.6 (better), read-poll 2.57 vs
2.54 (flat), atom-create 52.0 vs 51.2 (flat).

## The one priced cost

Bundled bare-write: **4.18 vs 3.70 ns (+0.48 ns)**. Attribution is exact —
the bundles' `write()` differs by one line:

    clocks[s >> 3] = ++clockSource;

the durable-clock bump the design's bump table requires on every accepted
write. It buys the observer fast path: subscription and watcher
revalidation is one float compare per dependency instead of an evaluation
in the committed world — the boundary-heavy wins above already include
paying it. Cheaper variants were considered and rejected: a
skip-when-unobserved guard costs a load+branch (the same price, plus
misprediction risk); an in-column counter is the same operation count; a
lazy consult-time stamp cannot know the acceptance decision. A clock-free
plain-mode engine remains expressible post-merge as a composition-time
variant if plain-mode write latency ever matters more than observer
revalidation cost.

## Ledger dispositions

- Bare-write fused-module displacement (~+0.4 ns at tsx, flagged leg 3):
  resolved — tsx bare measures at parity (6.08 vs 6.18); the bundled
  residual is entirely the clock bump above.
- The "+13% no-gc write-loop residue" (flagged leg 5): mostly the chunked
  tape's cost; retired with the tape. The naive log's bundled/logged
  numbers sit at parity-to-better against main.
- Held-open episode memory: bounded by the prefix-fold valve
  (FOLD_VALVE_THRESHOLD = 1024 entries per atom); batch-record
  accumulation to the close remains the documented episode-lifetime shape.
- Creation: bundled atom-create at parity (the FinalizationRegistry floor
  from the reclamation campaign carries over unchanged).

## Gates at completion

cosignals-first-draft 362 passed | 1 skipped across 30 files (bytecode 46 with the
final re-pinned table; docs-gate 6; leak-audit; reclaim probes; the frozen
fuzz corpora lockstep-green; the battery including the owner's
urgent-write-to-abandoned-branch pin), cosignals-react 72 against the real
fork, conformance 179 ×2 (cosignals-first-draft, cosignals-concurrent), oracle 82 | 1
untouched, typecheck ×3 clean.
