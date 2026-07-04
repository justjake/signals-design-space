# OPEN — live questions (stance sources for the next round)

- **O1. Where does per-world dependency knowledge live?** The axis. Known
  points: second kernel with real head-world tracking (D-style; structural
  obligations, indirection tax); compensated single kernel (A-repaired
  style; semantic completeness obligations, zero kernel tax); per-world
  bits in a separate overlay structure (B's insight without B's hot-walk
  invasion); fork-native (React-owned queues). Round-1 stances should cover
  at least three of these.
- **O2. host-callback indirection tax** — UNMEASURED. Spike pre-registered:
  extract a host-protocol kernel from `libs/arena` (delete values/fns/kind
  dispatch; add 4-callback host), run deep/broad/diamond vs donor. Decision
  rule: >5% on recompute-dense shapes → codegen-fusion variant must also be
  measured before a two-kernel design is judged on performance.
- **O3. Shadow-sync completeness cost** (if two-kernel wins): what does the
  dev-mode brute-force validator cost, and can the sync obligation be
  bounded to an enumerable site list with an invariant sweep?
- **O4. React-owned update queues for atoms** (fork-native stance):
  feasible? Hook queues are per-fiber/single-consumer; atoms are
  many-consumer. Must answer: where does the queue live, who processes it
  outside renders (effects, non-React reads), and what is the rebase cost
  on React upgrades. License to fail fast with the killing schedule.
- **O5. Yield/resume protocol shape**: listener edges
  (onRenderPassYield/Resume) vs a cheap per-callstack query — cost per
  read/write in each; who flips what state.
- **O6. Grouped-notification lane preservation** (C6): per-write synchronous
  delivery (ARMED-style dedup, needs per-batch granularity per I5) vs
  drain grouping under fork lane-scoped execution — cost per fan-out shape.
- **O7. Per-root committed views** (C11): where does the per-root
  (pin, locked-in-mask) table live and who consumes it (effect flush
  filter)?
- **O8. Suspense world key** (C15): fork-provided render-lineage id vs
  canonicalized include-mask — define lifetime across pass restarts.
- **O9. Held-open-transition hot reads** (the G-8 class): kernel-cache
  (two-kernel) vs world-memo machinery — if memos exist at all, validate
  with per-slot write clocks (I-grade mechanism, mechanism-library) rather
  than per-read certificates?
- **O10. Coalescing** of same-batch writes during long transitions: legality
  conditions (no open pass?) and whether it's worth its mechanism slot at
  all in each architecture.

## Spike queue

| id | question | method | decision rule | status |
| --- | --- | --- | --- | --- |
| SP1 | O2 host tax | D §16-style M1 extraction; tier-0 deep/broad/diamond, one-framework-per-process, bundled child | >5% recompute-dense → measure fusion variant too | **queued (pre-round-1)** |
| SP2 | O3 validator cost | prototype brute-force K1-edge cross-check on synthetic forked topologies | >10% forked-mode overhead in dev builds → needs cheaper invariant | blocked on round-1 architecture pick |
