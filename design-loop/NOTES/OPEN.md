# OPEN — live questions (stance sources for the next round)

- **O1. Where does per-world dependency knowledge live?** The axis. Known
  points: second kernel with real head-world tracking (D-style; structural
  obligations, indirection tax); compensated single kernel (A-repaired
  style; semantic completeness obligations, zero kernel tax); per-world
  bits in a separate overlay structure (B's insight without B's hot-walk
  invasion); fork-native (React-owned queues). Round-1 stances should cover
  at least three of these.
- **O2. host-callback indirection tax** — MEASURED (SP1 → INVARIANTS I11):
  >5% on 2 of 3 recompute-dense shapes (deep 1.06×, broad 1.06–1.09×;
  diamond 1.02×), plus +9–16% on quiet read/write paths. The decision rule
  triggered: the codegen-fusion variant (SP1b) must be measured before any
  closed-kernel/two-kernel design is judged on performance. Open residue:
  how much of the tax is call boundary vs entity-table storage (SP1b
  isolates); kairo-scale GC behavior of the entity table untested.
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
| SP1 | O2 host tax | host-protocol kernel extraction; tier-0, one-framework-per-process, ABBA, conformance-gated | >5% recompute-dense → measure fusion variant too | **DONE — rule triggered** (I11; `research/experiments/sp1-host-callback-tax.md`) |
| SP1b | O2 residue: call boundary vs storage | fused variant: same entity-table storage, dispatch spliced into kernel (no upcall); 3-way donor / host / fused | fused ≈ donor ⇒ tax is the call boundary (fusable); fused ≈ host ⇒ tax is the storage change (fusion won't save it) | **running** |
| SP2 | O3 validator cost | prototype brute-force K1-edge cross-check on synthetic forked topologies | >10% forked-mode overhead in dev builds → needs cheaper invariant | blocked on round-1 architecture pick |
