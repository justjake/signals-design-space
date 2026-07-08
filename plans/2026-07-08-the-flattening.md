# The flattening — one plane-based engine

Informal design. One codex-sol-max review round, then build. The referee is
tests + benchmarks + the React verifier, not this document.

## Goal

Merge the kernel and the concurrent machinery into one engine with
cosignals-alt-b's architecture: data in typed-array planes, one core module,
no object layer, no manager seams, no kernel/arena walk twins. Keep every
capability cosignals has today. End state ~6-7k code lines (alt-b is the
existence proof: 4.6k code passing conformance + its own lockstep model at
comparable speed).

What dies: `AtomInternals`/`ComputedInternals` objects and the
`nodeIndexToInternals` column of objects; `Watcher` and `Subscription`
objects and their managers; `WorldArena` and both arena walk families (the
kernel-correspondence duplication); the fifteen-module composition with its
deps records; the kernel/engine module boundary itself.

What survives unchanged: the public API (`Atom`/`Computed`/`ReducerAtom`
classes, `effect`, `batch`, `configure`, `ctx.use`); the React driver
contract (`attachDriver`, protocol v2, real fork); reclamation's
FinalizationRegistry machinery (guards re-expressed over plane fields); the
tracer surface; all test suites as the gate.

## Decided

- **Worlds: extend alt-b's overlay; arenas are the written fallback.** See
  the design section — this is the one real bet.
- **Planes** (generated from a schema file, alt-b's `tools/schema.ts`
  approach): M (nodes + links, stride 8), G (write-log records, stride 4,
  per-atom lists threaded through node fields), W (memo records, stride 8),
  CERT (certificate pairs, bump allocator). Side columns keyed off record
  ids: values, fns (callbacks: computed getters, effect bodies, lifecycle,
  subscription refire), plus memo values.
- **Objects: only public handles.** Watchers and subscriptions become plane
  records + side-column callbacks (the dormant-lifecycle-callback pattern,
  already proven). Handles keep the weak backlink discipline (handle pins
  record, never the reverse).
- **One core module** (plus `index.ts` policy/API, the React driver,
  Tracer, graphviz). Same-file const enums inline everywhere; no
  import-cell hot costs; the closure-rebuild growth pattern per plane
  watermarks (alt-b already does exactly this).
- **Write log in-plane** (G records, `LOG_HEAD`/`LOG_TAIL` in node fields),
  replacing per-atom packed column arrays. Log records recycle through the
  plane free list; compaction rethreads lists instead of rewriting arrays.
- **Field budget**: node fields 6/7 are LIFECYCLE and NODE_INDEX today; the
  G-plane needs LOG_HEAD/LOG_TAIL and computeds need MEMO_KEY. Resolution:
  kind-overloading like alt-b (atoms: LOG_HEAD/LOG_TAIL; computeds:
  OVERLAY_STAMP/MEMO_KEY), LIFECYCLE moves to a side Int8 column or stays
  as a NODE_INDEX sign-bit — decided by the schema, measured by the write
  bench (the constant-store constraint on `write()`'s flag word still
  holds; nothing may force it into a read-modify-write).
- **NODE_INDEX likely dies**: with internals objects gone, the dense
  columns it keyed disappear; remaining columns key off record ordinals or
  ids directly. If a dense node-only ordinal is still needed (suspense
  request cache), keep it as a side column, not a node field.

## The overlay design (the bet)

Alt-b's model, extended to overlapping renders. Mechanism recap: a world is
an integer key (`0` newest, `(passSerial << 2) | 1` render worlds,
`(batchId << 2) | 2` pending-batch worlds). A computed's value in a world is
a memo record on the node's chain. A memo's freshness proof is its
certificate: `(atomId, logTailSeq)` pairs recorded at evaluation;
revalidation re-checks that every read atom's log tail is unmoved. A global
`tapeStamp` (bumped on any log mutation) short-circuits scans while nothing
writes.

Extension points that are new design, not transcription:

1. **Multiple open passes.** Pass serials are already unique across roots,
   so keys don't collide. Consequences to build for: memo chains hold up to
   one record per live world per node (React reality: a handful); the
   tombstone sweep must be per-world (a pass's memos die at its
   commit/discard — thread each pass's memos on a per-pass list exactly the
   way alt-b threads writer's-world memos per batch slot with
   `W_SLOT_NEXT`, and bulk-tombstone at pass end); `tapeStamp` degrades to
   certificate scans whenever any writes land while passes are open — the
   scan is a handful of Int32 compares per memo, and the wide-mask bench
   plus the react-seam bench price exactly this.
2. **Render-world stability.** A pass's world must be frozen at renderStart
   (committed base + its included batches). Certificates over log tails are
   conservative: an urgent write appending to a read atom invalidates the
   pass's memo even though the entry is invisible to that pass;
   re-evaluation in the pass's world reproduces the same value and
   re-certifies. Correct by construction, priced by re-evaluation
   frequency. If the react-seam bench shows pathological re-evaluation
   under urgent-write storms during long transitions, the certificate pair
   gains a per-world visible-tail variant ((atomId, visibleTailSeq): tail
   of the last entry visible to this world) — costlier to record, immune
   to invisible appends. Start conservative; the variant is the named
   escape hatch.
3. **Watchers and committed reads.** `useSignal`'s committed-world reads
   and subscriptions' committed revalidation ride the same memo/certificate
   path with the root's committed world key. Mount-window fixups keep their
   semantics: the fixup compares against committed-as-of-now, which is a
   memo lookup + certificate check instead of an arena read.
4. **Retirement and settlement.** Batch retirement mutates logs
   (compaction) → bumps `tapeStamp` → invalidates exactly the memos whose
   atoms compacted (their tails moved). Settlement re-evaluations follow
   the existing boundary discipline; the drain loops port as-is.
5. **Reclamation guards over planes.** The six guard rows re-express as:
   SUBS field ≠ 0 (unchanged); watcher membership = per-node watcher
   refcount side column (the watcher index is gone; its clearing site is
   the retry trigger as today); render membership = "node has a live memo
   keyed by an open pass" via the per-pass memo lists; lifecycle ACTIVE
   (unchanged, id-keyed map); observation refcount (unchanged, column);
   non-empty log = LOG_HEAD ≠ 0 with compaction's list-empty transition as
   the trigger. Two-phase free, epoch registry, heldValue packing all
   port unchanged.
6. **Quiet mode.** The quiet derivation (no batches, no passes, logs
   compacted) and the standalone fast arm are untouched concepts; quiet
   writes skip the G plane exactly as they skip the log today.

## Fallback

If the overlay extension fails a named gate — the multi-root skew battery,
the frozen-corpus lockstep, or the bench floors — re-express today's arena
semantics as plane records instead (per-pass shadow planes). That still
kills the object layer, the managers, and the module seams; it keeps the
walk twins. The fallback is a reduction of this design, not a new one, and
the decision point is after the overlay's first full gate run.

## Gate (all must hold before merge to main)

- cosignals suite (incl. reclaim probes, leak audit, docs-gate, bytecode
  budgets re-pinned for the new shapes), oracle lockstep with the frozen
  300-seed + long-seed corpus, react 72 against the real fork, conformance
  ×4, the daishi concurrent verifier, fork protocol suites.
- Bench: no family regresses beyond noise vs today's HEAD artifact
  (tsx and bundled); no steady-state deopts; the inlining floor checks.
- The style directives apply from the first line written (this repo's
  docs-gate runs against the new module).

## Execution

One big-bang build on a branch (owner's ruling: no stage-ladder, commit
size irrelevant). Builders work from this document plus alt-b's source as
the architectural reference and cosignals' current tests as the contract.
SSR serialize/initialize (alt-b has it, we don't) is the first follow-up
after the merge, not part of it.

## For the codex round (one round, then build)

Attack the overlay extension specifically: per-pass memo tombstoning vs
pass discard/restart; certificate conservativeness under urgent-write
storms during held-open transitions (is the visible-tail variant needed on
day one?); memo-chain length under many roots with long-lived committed
worlds; interaction of in-plane logs with reclamation's log-empty guard;
anything in the current test contract (multi-root skew, corrective
deliveries, effect-write classification) the overlay model cannot express.
