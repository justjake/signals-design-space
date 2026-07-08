# The flattening — one arena-based engine

Informal design, revision 3 — FINAL, build from this. Revision 1's
overlay/certificate approach was rejected by the owner (and drew 9 codex
blockers independently). Revision 2 drew 13 codex findings, all accepted
and folded in below; the review round is spent. The referee is tests +
benchmarks + the React verifier, not this document.

Vocabulary: an **arena** is a pre-allocated buffer we allocate from
internally (alt-b calls these "planes"; we do not).

## Goal

Merge the kernel and the concurrent machinery into one engine module with a
data-oriented layout: long-lived graph state in arenas, short-lived episode
state in ordinary JS objects that die in bulk, no object layer for node
data, no manager seams, no kernel/arena walk duplication maintained by
hand-correspondence. Keep every capability cosignals has today, plus SSR.

What dies: `AtomInternals`/`ComputedInternals` objects; `Watcher` and
`Subscription` objects and their managers; the fifteen-module composition
and its deps records; the kernel/engine module boundary; the write-log
compaction machinery (replaced by episode lifecycle, below); per-observer
value snapshots (replaced by clocks, below).

What survives: the public API (`Atom`/`Computed`/`ReducerAtom`, `effect`,
`batch`, `configure`, `ctx.use`); per-world dependency tracking (the owner's
ruling — worlds keep real dependency records; no certificate/validation
scans); the React driver contract (protocol v2, real fork); reclamation's
FinalizationRegistry machinery; the tracer surface; every test suite.

## Decided (owner rulings)

1. **Worlds keep dependency tracking** — the current arena-per-world
   semantic architecture, re-laid-out. No overlay, no certificates.
2. **Node data moves into arenas** — watchers, subscriptions, and the
   engine-side per-node state become arena records + side columns. One
   general `extras` side column (a per-node JS object) holds cold oddments
   that don't earn a dedicated column. Public handles stay as classes with
   the weak backlink discipline (handle pins record, never the reverse).
3. **One module to start.** Clearly defined subsystems inside it, good
   names, good doc comments; the file reads top to bottom with progressive
   disclosure (storage layout → kernel algorithm → worlds → batches/log →
   render integration → policy). Splitting comes later if ever.
4. **Actions/log entries stay in the JS heap.** They are tiny and
   short-lived; data-oriented layout pays for long-lived contiguous state
   (a node + its links), not for eden-lifetime records.
5. **Layout enums are generated from a schema file** (alt-b's
   `tools/schema.ts` approach) — one source of truth for arena geometry,
   and the generator also emits per-column reset/scrub metadata (values,
   fns, extras, clocks), so free/reset correctness is generated, not
   hand-maintained. Growth (owner ruling: EVERY arena must support
   resizing — exhaustion is never fatal): the kernel keeps its
   closure-rebuild growth at operation boundaries; world arenas grow by
   copy (doubling) mid-operation through the shell indirection, with the
   reload-after-allocation discipline confined to the few named allocation
   sites the schema enumerates. Hot paths run on plain fixed-length views
   in both cases — length-tracking resizable-buffer views are banned (a
   measured +56% arena-walk regression). Initial reservations are generous
   named bounds so growth stays rare; growth being rare never licenses an
   exhaustion throw.
6. **`ctx.use` ports as-is; SSR serialize/initialize is in scope** (port
   the design from alt-b's react.ts §13.8 shape).

## The two new mechanisms

### UpdatedAt clocks: a fast negative guard, not a replacement

Clocks let observers skip work when nothing moved; they cannot replace
dirty-state, value baselines, or delivery metadata. The codex round proved
each of those claims wrong in revision 2; the corrected mechanism:

- **Dirty-state stays.** Lazy computeds do not bump clocks until someone
  evaluates them. An observer may skip only when the producer is CLEAN and
  its clock matches; if dirty/pending, evaluate first, then compare.
- **Observer re-fires are AT-LEAST-ONCE (owner ruling, post-review).** The
  earlier value-baseline design (keep `lastValue` per dependency and gate
  re-fires on `isEqual(previous, current)`) is repealed: observers store
  only `lastValidatedAt`. Clock mismatch on a clean producer means re-fire
  — a net-no-change sequence (A→B→A is two accepted changes, two bumps)
  re-fires spuriously, and that is accepted semantics. Custom `isEqual`
  still gates WRITE ACCEPTANCE and per-root refold bumps (the clock only
  moves on changed results), so the spurious class is exactly multi-write
  flip-flops. The `lastValidatedAt` advance rule is unchanged: only after a
  committed render, an urgent correction, or a completed recapture — never
  on notification enqueue. The reference model co-evolves to the same rule
  (per-node accepted-change counters — a sanctioned oracle edit), and the
  value-gated re-fire pins are rewritten to at-least-once pins explicitly.
  `useSignalEffect`'s documented contract becomes: re-fires when a durable
  accepted change touched a value it read; equal-value round trips may
  re-fire.
- **Write receipts and value clocks are different fields.** The normative
  bump table:

  | Event | Behavior |
  |---|---|
  | Standalone/quiet accepted write | bump the durable clock once, after its sole equality gate |
  | Retained logged write | always allocate a write sequence; delivery stays value-blind |
  | Eager newest application | bump the newest clock only if newest's result changed |
  | Committed-member write, root commit, retirement | dirty affected roots only; bump each root's clock after that root refolds to a changed result |
  | Render world | pin-frozen; post-pin writes never move its clock |
  | Computed evaluation | re-track dependencies every evaluation; bump only if the tagged outcome changed |

- **Per-root committed clocks, never one global clock**: root A's
  subscriptions must not observe root B's commits (multi-root skew).
- **Clocks are over tagged outcomes** (value / thrown / suspended): a
  throw-to-return transition with an identity-equal payload is a change,
  matching the kernel's existing box semantics.
- **Clock representation**: process-monotone f64, or an
  `(episodeGeneration, counter)` pair compared as a pair — never a bare
  wrapping u32 (observers legally survive arbitrarily long episodes). The
  constant-store constraint on the signal flag word stands: clocks live in
  their own field/column, never in FLAGS.
- **Corrective delivery and mount fixups keep their causal metadata** —
  per-write sequence/batch/slot, per-batch touched-node membership, watcher
  pins/masks/included slots/commit generations. Clocks replace none of it;
  they only gate value re-comparison.

### Episode lifecycle replaces compaction

An **episode** runs from the first pending durable work (a batch opens, an
action parks, a render starts — never inferred from writes or call depth)
to full quiescence (every batch retired, every world closed, queues
drained). What is episode-lifetime and what is not:

- **Episode-lifetime**: write/action records (JS heap, append-only),
  render-attempt worlds, batch bookkeeping. Dropped wholesale at the
  quiescence boundary, after operation/notification/settlement queues
  drain.
- **NOT episode-lifetime**: committed-root routing structure (a mounted
  watcher's dependency cone is current routing state — it persists across
  quiescence exactly as today's committed arenas do), observer records and
  their baselines, dependency edges anywhere (edges purge and re-link on
  every re-track; append-only applies to write records ONLY).
- **Durable handoff before the drop**: the long-lived node value is
  canonical newest/durable state; each touched atom's episode tape carries
  an immutable episode-start base plus its entries; worlds replay from the
  tape base. Once everything retires and closes, canonical newest IS the
  durable result and the tape vanishes. This repeals one pinned contract
  explicitly: compaction's per-entry custom-equality re-invocation at
  retirement dies with compaction (the acceptance-decision equality
  semantics are untouched); the equality-count pin in
  equality-semantics.spec.ts is rewritten to the new mechanism, not
  silently broken.
- **Bounded memory under held-open episodes** (a parked action can hold an
  episode open indefinitely): logs live in fixed-size sealed chunks; a
  chunk whose entries are all retired and below every live render pin
  folds into base and drops WHOLE. Appends stay cheap; there is no
  per-entry fix-up; the bench prices the fold. A hard entry budget with
  documented backpressure is the fallback if chunk folding measures badly.
- **Reclamation**: the episode guard is per-record membership
  (`episode.holds` — the episode-owned map itself), not a global flag; the
  teardown order is: readers unreachable, episode references detached, the
  owner dropped and membership cleared, THEN the wholesale retry sweep at
  the next boundary. The old log-empty guard row becomes this membership
  row, with the drop as its retry trigger.
- **Boundary revalidation table** (unchanged semantics, restated): per-root
  commit revalidates that root; retirement/settlement revalidates all
  roots even if the retiring batch wrote nothing; a quiet accepted fold
  revalidates all roots; same-root open frames defer refires to
  commit/discard; effect writes classify by pending durable work (a quiet
  eager effect-write cascade stays quiet; any live batch means ambient
  classification) — the effect-write-classify contract is unchanged.

## Layout sketch (the schema's starting point)

- **Node arena** (stride-8 Int32, ids premultiplied): FLAGS, DEPS,
  DEPS_TAIL, SUBS, SUBS_TAIL, GEN, LIFECYCLE, UPDATED_AT (or the clock in a
  side column if 32 bits is ruled too narrow — schema decides; NODE_INDEX
  dies with the object columns it keyed, unless the suspense request cache
  still wants a dense ordinal, in which case it is a side column).
- **Link arena** (stride-8): upstream layout + LAST_SEEN_UPDATED_AT
  replacing the VERSION dedup field's spare space (schema decides the
  exact packing; the intra-run dedup stamp is still required).
- **Per-world dependency records**: the current WorldArena record design,
  re-derived under the schema with clocks; one arena per open world,
  pooled and bump-reset (this part of today's design was already right).
- **Side columns**: values, fns (getters, effect bodies, lifecycle
  callbacks, subscription refire), extras (general per-node object),
  clock column if not in-record.
- **JS heap**: log entries (per-atom lists on the atom's extras or a
  per-episode map — builder's choice), batch/render bookkeeping,
  subscriptions' episode state. All episode-lifetime, all dropped at
  quiescence.

## Gate (all must hold before merge to main)

- cosignals suite (reclaim probes, leak audit, docs-gate, bytecode budgets
  re-pinned for the new shapes), oracle lockstep with the frozen corpus,
  react 72 against the real fork, conformance ×4, the daishi concurrent
  verifier, fork protocol suites, SSR round-trip tests (new).
- Bench: no family regresses beyond noise vs today's HEAD artifact (tsx
  and bundled); no steady-state deopts; inlining floors. The eden
  lifecycle must show flat-or-better on retirement/settlement lines
  (compaction work disappears) and bounded growth on held-open-transition
  shapes.
- Style directives apply from the first line (docs-gate runs on the new
  module).

## Execution

One big-bang build on a branch (owner's ruling: no stage-ladder). Builders
work from this document, alt-b's source for the arena techniques that
transfer (schema generation, bump/reset discipline, free-list defrag —
already ported), and cosignals' current tests as the contract. SSR lands
inside the campaign as its final piece.

## Review disposition

The single codex round (13 findings: 8 blockers, 5 design gaps) is spent;
every finding was accepted and is folded into the two mechanism sections
above. Build from this revision.
