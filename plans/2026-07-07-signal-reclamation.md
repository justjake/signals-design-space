# Signal reclamation — FinalizationRegistry-driven record recovery

STATUS: DRAFT for adversarial review. Companion to
plans/2026-07-07-great-refactor.md; lands as its stage S5R (immediately after
S5, the always-concurrent merge). Owner directive 2026-07-07: "we currently
leak some signals. We need to fix that." Techniques below are owner-supplied,
validated on the cosignals-alt-a / cosignals-alt-b experiments.

## 1. The leaks (verified against HEAD)

- L1 — kernel records: `Atom` has no dispose path by design; a handle that
  becomes unreachable is collected by the JS GC, but its kernel record (packed
  fields, links, `values` slot) is never freed. Same for a `Computed` that is
  unwatched and then dropped. Nothing observes handle death today —
  FinalizationRegistry appears nowhere in packages/cosignal.
- L2 — engine pinning (the worse one): `AtomNode.handle` is a strong
  reference (concurrent.ts:350/385), and the engine registry (`nodes` map,
  `nodesArr`) strongly holds every adopted node forever — deletion exists only
  on the computed-dispose path (concurrent.ts:2162). Consequence: an adopted
  atom's handle CANNOT die at all (registry → node → handle), so even a
  perfect FR scheme would never fire for it.

L2 is structural to the two-layer design: eager apply re-enters through
`handle.set`, so nodes must hold handles. After the Great Refactor's merge
(S5), the engine writes graph memory directly by id and node→handle dies as a
requirement. That is why this plan is a post-merge stage, not a standalone
pre-refactor campaign (which would build the kernel half twice and still be
unable to fix L2).

## 2. The technique (owner's guide, verbatim findings)

The core insight: the FR cost is not `register()` — it is GC-side weak-target
processing, and it scales with the shape of the dying target (alt-a audit:
237 ms GC vs 84 ms with FR off, while registerHandle itself was 14 ms;
closure-rich handles cost ~+41 ns to process at death vs ~+10 ns for a lean
plain object).

1. Match the registration target to the handle's shape:
   - Closure-rich handles: register a tiny token object owned by the handle
     (one extra field; the token dies in the same GC cycle) so the registry
     only processes lean objects at death.
   - Lean class instances with prototype methods: register the instance
     directly — the token indirection measured WORSE there (23.9% vs 12.9%
     creation overhead) because lean instances don't pay the closure penalty.
   - Cosignal's `Atom`/`Computed` are lean class instances (predicted:
     direct registration, the alt-b outcome) — but the guide's own rule is
     PROFILE FIRST; S5R.1 measures one creation shape before committing.
2. SMI heldValues: the heldValue is a packed number, never an object — bare
   id at generation 0, gen·2^32 + id while the generation fits (a float64,
   still allocation-lighter than an object), an {id, gen} object only in the
   astronomically-rare overflow, so correctness never depends on the packing.
   Post-refactor there is exactly one id space and one generation counter
   (the kernel's), which is what makes this packing trivial.
3. The two correctness patches that make reclamation total:
   - Generation-defused finalization: the finalizer compares the held
     generation against the record's current GEN before freeing; a stale
     callback after deterministic dispose or slot reuse is a no-op.
   - No one-shot loss: a finalizer that fires while the record is still
     guarded must be RETRIED — skipped ids join a retry set re-attempted at
     the natural boundaries. Without this, a guard-skipped callback never
     fires again and the record leaks despite registration.

Measured rejects (do not implement): unregister tokens (+103 ns), WeakRef
schemes (+93 ns), deferred/batched microtask registration (queue pins burst
handles through scavenges they'd otherwise die young in — net worse), and
anything lazy/first-use (leak, therefore bug).

## 3. Cosignal mapping

- Registration site: the `Atom`/`Computed` constructors (never lazy). One
  module-level registry in engine.ts.
- Finalizer action: free the kernel record and clear the engine columns for
  that id — the post-merge free path is one function (graph free + column
  clears + WriteLog drop + arena eviction), shared with deterministic
  disposal.
- GUARDS (the finalizer skips, records the id for retry, when any holds):
  live dependency links (something still reads this record: SUBS or DEPS
  non-empty), a live watcher subscription, observation-index retains, a
  non-empty WriteLog (uncompacted receipts), suspended state, membership in
  any live arena's suspended list, HOST_OWNED/lifecycle flags.
- RETRY BOUNDARIES: `unwatched()` (a record losing its last subscriber),
  the kernel boundary sweep (`sweepPendingFree`/boundary work), WriteLog
  compaction (an atom's log emptying), arena reclamation/quiesce. Each
  boundary drains the retry set entries whose guards have cleared.
- Generation: the held gen is the kernel record GEN (the only generation
  counter after refactor S2). Deterministic dispose paths do NOT unregister
  (rejects list); they rely on gen-defusing.
- The oracle does not model reclamation (memory recovery is unobservable in
  lockstep semantics); the referee for this campaign is the probe suite.

## 4. Probes first (failing tests before implementation)

- P-L1a: create/drop 10k atoms → coax GC → kernel record population returns
  to baseline (via the free-list/watermark stats seam).
- P-L1b: same for computeds after unwatch-then-drop.
- P-L2: adopt 10k atoms through the engine → drop handles → engine registry
  size and column population return to baseline.
- P-RETRY: drop a handle while its record is guarded (subscribed), then
  unsubscribe → the record frees at the unwatch boundary, not never.
- P-ABA: deterministic dispose then id reuse then stale finalizer → no
  double-free, new tenant unharmed (gen-defuse pin).
- Probe harness: vitest node fork with --expose-gc; FR + gc() coaxing loop
  with bounded retries (the alt packages have working patterns to copy).

## 5. Gates

- The probe suite (above) green = the leak is fixed; it joins the standing
  suite as leak-audit companions.
- Bench: creation overhead expected ≈ +13% (alt-b direct-registration
  number) on atom/computed construction microbenches — REPORT the measured
  number to the owner (known cost, accepted in principle when he supplied
  the guide; STOP if it exceeds ~1.25× creation or if ANY read/write-path
  bench moves at all — registration must be construction-only).
- Full standard stack: suites, corpus (unchanged oracle), conformance ×3,
  bytecode budgets (constructors are not budgeted today; add rows if the
  suite grows constructor coverage).

## 6. Open questions (reviewers: attack these)

1. Guard completeness — is there a liveness source not in the §3 list
   (trace retention? settle queue sentinels? ctx.use cache keys? render
   snapshots holding node ids across a yielded render)?
2. Retry-set growth — can a pathological workload (drop-while-subscribed at
   scale) grow the retry set unboundedly between boundaries?
3. Effects/scopes: their records free deterministically via dispose today —
   does FR registration of Atom/Computed handles interact with effect-owned
   computeds (ownership edges) in a way that frees a record an effect will
   still visit?
4. Multiple GC of the same handle generation vs the packed heldValue at
   gen·2^32 + id — float precision ceiling (gen and id both bounded so the
   product stays exact — verify the bound arithmetic).
5. The probe harness's GC coaxing under vitest workers — flake risk; the
   alt packages' pattern reliability.
