# The flattening — one arena-based engine

Informal design, revision 2 (owner rulings applied; the overlay/certificate
approach from revision 1 is dead — the owner rejected it and the first
codex round found 9 blockers in it independently). One codex-sol-max review
round against THIS revision, then build. The referee is tests + benchmarks +
the React verifier, not this document.

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
   `tools/schema.ts` approach) — one source of truth for arena geometry.
6. **`ctx.use` ports as-is; SSR serialize/initialize is in scope** (port
   the design from alt-b's react.ts §13.8 shape).

## The two new mechanisms

### UpdatedAt clocks replace value snapshots

Every node record carries `UpdatedAt: LogicalClock` — bumped **only when a
write or recompute is accepted** (survives the equality check). Per-world
records carry their own clock for world-visible changes. A dependency link
stores the producer's clock at the consumer's last evaluation; an observer
(subscription, watcher) stores the clock at its last delivery.

- Staleness anywhere = one integer compare per link. Subscription
  revalidation stops evaluating in the committed world and comparing
  values; it compares clocks and evaluates only on mismatch.
- The equality gate is load-bearing: equal-value writes are dropped at the
  acceptance decision today (custom `isEqual` included), so they must not
  bump the clock — otherwise observers re-fire on no-op updates and the
  value-gated re-fire contract breaks.
- Clock width: u32 with wrap-aware compare, or an f64 side column — the
  schema decides; the write bench prices it. The constant-store constraint
  on the signal flag word stands: the clock is its own field/column, never
  folded into FLAGS.

### Episode lifecycle replaces compaction

An **episode** runs from the first departure from quiescence (a batch
opens, a render starts) to full quiescence (every world merged or
discarded). During an episode, logs and per-world state only grow — cheap
appends, no fix-ups, no per-entry release, no compaction walks. At
quiescence the episode's storage is thrown away wholesale: JS-heap log
entries and world objects become garbage in one drop (they lived and died
in the GC's young generation), and episode arenas reset by bump-pointer.

Consequences, priced: memory during a long-held transition grows with the
episode and is reclaimed all at once at its end (React episodes are short;
the react-seam bench and wide-mask line price the growth). The whole
compaction subsystem dies — per-entry release, uncompacted-atom tracking,
the log-empty reclamation guard row (the guard becomes "episode active",
cleared at the quiescence drop, which is also its retry trigger).

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

## For the codex round (one round, then build)

Attack: the UpdatedAt clock's interaction with custom equality, functional
updates, and world-fold acceptance (is bump-on-accepted-change sufficient
at every write path: quiet fold, batch write, world replay, effect writes?);
episode lifecycle vs reclamation guards (a node whose only retention was
"episode active" must reclaim at the quiescence drop — is the retry filing
sound?); episode memory growth under adversarial held-open transitions with
high write rates; per-world clock vs committed clock relationships during
multi-root skew (a subscription on root A must not see root B's commits
move its clocks); anything in the current test contract (corrective
deliveries, mount-window fixups, effect-write classification, quiet mode)
that clocks + episodes cannot express; and any underspecification a builder
would improvise.
