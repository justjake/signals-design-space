# Measured facts (frozen seed; provenance required to cite)

Numbers below are measured in this repo or its sibling; cite them rather than
re-deriving. UNMEASURED items are flagged — treat them as spike targets, not
facts. Provenance keys: [RESEARCH] `research/RESEARCH.md` + sources/,
[GUIDE] `research/packed-structs-guide.md` / `packed-authoring-practices.md`,
[ARENA] `libs/arena` results, [LINKS] `libs/arena-links` A/B,
[SYNTH] `react-concurrent-signals-arena.md` §7/§15/§18, [JUDGE]
`research/specs/JUDGING.md`, [SPECS] `research/specs/*`.

Note: [SYNTH]/[JUDGE]/[SPECS] targets (and `reviews/*`) are deliberately
removed from the working tree to prevent anchoring (see LOOP.md "Attic");
they are historical citations, recoverable from git by the monitor. Loop
agents cite the keys and trust the numbers; they do not chase these paths.

## Kernel / layout (the settled substrate)

- Donor arena kernel vs alien-signals v3 (one-framework-per-process, tier-0):
  deep 0.90×, broad 0.84–0.88×, diamond 0.89×, reads 0.74–0.87×, create
  0.96×; 179/179 conformance with exact pull counts. Kairo-scale GC-inclusive
  reality ≤1.4× (honest ceiling; ≤1.25× is a target with no named mechanism
  yet). [ARENA][SYNTH §18.2]
- Record interleaving ≫ parallel arrays for hot traversal fields: naive
  one-array-per-field measured 1.8× WORSE than objects on deep chains.
  Cold/rarely-touched parallel columns are not covered by this result.
  [RESEARCH][SYNTH §7.1]
- Nodes+links share one plane: −2% deep / −8% diamond vs split planes.
  [SYNTH §7.1]
- Buffers as closure constants are the only binding at const parity; segment
  tables +35–40%/access, resizable ArrayBuffers +66–83% traversal, mutable
  `let` +34–43%, per-function aliases +26–30%. Growth = closure rebuild at
  operation boundaries. [GUIDE][SYNTH §14.1]
- Bundlers demote module-scope `const` → `var`: +15–21% on kairo through a
  bundled child. Same-file non-exported `const enum` inlines everywhere that
  matters; cross-file does not. [GUIDE][SYNTH §15]
- V8 inlining: ~460 bytecodes/callee, 920 cumulative, greedy ≤27; typed-array
  access ≈2× bytecode of property loads. The monolithic `link()` at 475
  bytecodes silently never inlined; split fast path 168 → −8–13% on
  traversal shapes. Budgets must be CI-enforced. [GUIDE][SYNTH §18.3]
- One-framework-per-process or feedback pollution skews results up to 3×.
  [RESEARCH]
- Links-only arena (object nodes + integer link records) LOSES: the
  id→nodesById→flags hop adds a dependent load per traversed link — kairo
  1.2–1.6×, creation ~1.7× vs alien. Full-arena (flags/topology in-plane)
  is required for the traversal win. [LINKS]
- JSC (bun) inverts some V8-tuned rankings; arena still wins there, but
  V8-specific tunings don't travel. Rank per-engine. [repo commit 0d3371f]
- Value storage: one packed `unknown[]` side column beats type-segregated
  columns (Float64 + tags measured worse). Never holey. [RESEARCH][SYNTH §7.1]

## Concurrency architecture facts (from the arena round + re-judgment)

- React's own model: setState appends lane-tagged updates to per-hook queues;
  renders apply included lanes and rebase the rest; urgent-applied results
  become the base only for *unskipped* prefixes — replay-in-write-order over
  the pre-batch base is the parity-correct fold (C3's 4-not-3 arithmetic).
  [SPECS b §10.2 kill][JUDGE]
- Canonical-topology-only invalidation/notification is unsound under
  world-divergent dependencies (C1). Verified architectural in candidate C;
  verified present-but-compensable in synthesized A; solved structurally in
  B (per-link world bits + per-slot write clocks) and D (second kernel whose
  edges are the head world's real topology). [re-judgment 2026-07-04, both
  reviews, SPECS]
- Per-slot write clocks (B): cached per-world value valid iff its seq ≥ every
  included slot's write clock — coarse, sound, no per-atom certificates.
  [SPECS b §8.1/§9.5]
- D's two-kernel model: K1 lazily shadowed, bulk-reset at unfork; head
  evaluations re-track real head deps in K1. Its `host.refresh` indirection
  tax is **UNMEASURED** (predicted ≤3–5% on recompute-dense shapes; fusion
  fallback designed). Spike pre-registered. [SPECS d §14/§15]
- Fork facts an engine cannot get from userspace: current write's batch +
  deferred classification; a pass's included batches + lifecycle; retirement
  (exactly once); lane-scoped scheduling into an existing batch
  (`runInBatch`); DOM mutation window. Passes span yields; **handlers run in
  yield gaps** — any [pass-start, pass-end]-scoped "in render" state is wrong
  there (C7). [SYNTH §6][review 08-52]
- ≤31 live batches (one per lane) — slot/mask encodings of live batches are
  sound; entries outlive slots only if recycling is gated on unswept counts.
  [SYNTH §6.2/§9.2]

## Cost model warnings (paid before, don't repeat)

- Eager per-write world evaluation on the write path (watcher cutoffs) is
  the expensive shape; kernel-staleness + lazy pull, or memo-shared
  evaluation, are the two known mitigations — price whichever you pick
  (fan-out gates). [SYNTH §10.6/G-7][SPECS d]
- Always-log in React mode is the honest price of C2; gate the logged write
  at ≤2× DIRECT rather than wishing it away. DIRECT mode (no React) must
  execute zero concurrency instructions. [SYNTH §9.1/G-6][JUDGE]
