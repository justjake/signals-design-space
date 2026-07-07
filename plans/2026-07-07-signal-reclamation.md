# Signal reclamation — FinalizationRegistry-driven record recovery

STATUS: REVISION 2, for re-review. Revision 1 was reviewed by codex
(not-ready: 6 blockers, 4 majors — including donor-transcription errors
caught by reading cosignals-alt-a/alt-b directly); every finding is resolved
below. Companion to plans/2026-07-07-great-refactor.md; lands as stage S5R,
and its §3 requirements SHAPE the refactor's S5 design (lifecycle rooting,
aux-slot backreferences, the engine epoch).

## 1. The leaks (verified at HEAD)

- L1 kernel records: no dispose path for atoms; unwatched-then-dropped
  computeds never free. FinalizationRegistry appears nowhere in cosignal.
- L2 engine pinning: `AtomNode.handle` is strong; the registry maps hold
  every adopted node; deletion exists only for computeds. An adopted atom's
  handle cannot die at all.
- L3 (review finding — the kernel pins too): a `Computed` is stored in its
  own record's aux `values` slot (owner resolution for ctx.use), and
  lifecycle atoms are rooted by `lifecycleStates` whose stored context
  closes over the handle. Even with L2 fixed, FR would never fire for
  these.

## 2. Prerequisites built into refactor S5 (this plan's requirements)

- No engine/kernel machinery holds a strong handle reference:
  - ctx.use owner resolution becomes id-keyed (the evaluation knows its
    node id); the use-cache moves off the handle into an ordinal-keyed
    engine column. The aux slot stops storing the handle.
  - lifecycle state is id-keyed and handle-free; a user callback that wants
    the handle closes over it in userland (user-held references SHOULD pin —
    that is correct liveness).
- `__resetEngineForTest` carries an ENGINE EPOCH (refactor R-6); the
  reclamation registry records the epoch at registration.

## 3. The technique (owner's guide; donor-verified transcription)

Unchanged core: FR cost lives in GC-side weak-target processing and scales
with the dying target's shape (alt-a audit: 237 ms vs 84 ms GC, register
itself 14 ms; ~+41 ns closure-rich vs ~+10 ns lean death processing).

1. Registration target by shape, PROFILED PER CLASS (review finding: one
   shape cannot choose for all three) — `Atom`, `Computed`, and
   `ReducerAtom` (whose shape changes after its base constructor — flag to
   stabilize or profile as its own class) each measured; lean-instance
   direct registration expected (the alt-b outcome: 12.9% direct vs 23.9%
   token), token indirection only where a class profiles closure-rich.
2. heldValue packing: bare id while gen = 0; `gen·2^32 + id` while
   `gen < 2^21` (exact ≤ 2^53−1 for id < 2^32 — verified arithmetic);
   an `{id, gen, epoch}` object beyond. CORRECTIONS (review): GEN is a
   signed Int32 that wraps — defusing compares by raw int32 EQUALITY (wrap-
   safe), never ordering; the packed form is used only while gen is in the
   exact-positive range; full-cycle generation ABA (2^32 frees of one
   record between registration and finalization) is documented as an
   accepted astronomical residual, with the engine epoch guarding the
   realistic variant (test resets — see 4).
3. Generation-defused, EPOCH-DEFUSED finalization: the callback checks the
   engine epoch first (a pre-reset callback against a post-reset engine is
   a no-op — review reproduced this ABA against the alt-b bundle), then the
   record's GEN.
4. No one-shot loss: skipped callbacks retain `id → {gen, epoch}` (an id
   alone cannot re-run the defuse — review finding) in TARGETED per-boundary
   trigger queues (the donors' noteReclaimRetry pattern), NOT a global set
   scanned at every boundary (O(N·M) rejected).

Measured rejects (unchanged, still binding): unregister tokens (+103 ns),
WeakRef schemes (+93 ns), deferred/batched registration, lazy registration.

## 4. Guards and boundaries (donor-corrected)

A finalizer FREES unless one of these liveness sources holds (then it files
a retry entry on that source's trigger queue):

- incoming subscribers: kernel SUBS non-empty (something reads this record);
- a watcher on the node — live OR mounted-in-an-open-render (review
  finding: pending mounts retain the node before liveness flips);
- membership in any open render's arena, or any arena's suspended list;
- observation-index retains;
- a non-empty WriteLog (uncompacted entries).

NOT guards (review corrections): outgoing DEPS (the record's own reads —
reclamation DISPOSES them, donor pattern; guarding them makes every
never-subscribed computed permanently unreclaimable), HOST_OWNED (permanent
metadata), the lifecycle marker (cleared only by free — guarding it pins
every lifecycle atom forever; the lifecycle STATE cleanup is part of the
free path instead).

Retry trigger queues drain at the boundary where their guard clears:
`unwatched()` (last subscriber), watcher release (the `live` flip and
`removeWatcher` — review finding: this clears observation retains without
any kernel boundary firing), WriteLog compaction, render end (open-render
membership), settlement drain (suspended-list exits — review finding),
arena release/quiesce, the kernel boundary sweep.

Free-path totality (review finding): reclamation NEVER runs user code
synchronously inside the GC callback. Disposing a reclaimed computed's
owned effects defers their cleanup into the existing pending-free/boundary
queue; a cleanup exception routes to `reportError` and never aborts the
sweep mid-structure. Pinned by a throwing-cleanup test.

Deterministic dispose paths do NOT unregister (rejects list); they rely on
epoch+gen defusing.

## 5. Probes (donor pattern, corrected)

- Plateau assertions, not exact baseline (review finding: FR delivery has no
  fixed-collection guarantee): the alt-b pattern — bounded gc()+timer
  rounds, accept a one-round plateau — with population deltas, run in a
  forked --expose-gc vitest project.
- P-L1a/b, P-L2, P-RETRY as revision 1, restated against plateaus; P-RETRY
  variants per boundary (watcher release, settlement, compaction).
- P-ABA and P-EPOCH use a deterministic callback-simulation seam
  (`__simulateReclaimForTest`, the alt-b precedent) — real GC cannot
  schedule a stale callback deterministically.
- A never-subscribed evaluated computed (the DEPS-guard counterexample)
  is its own probe: drop → reclaim → owned deps disposed, no retry-set
  residence.

## 6. Gates

- The probe suite green = the leaks are fixed; it joins the standing suite.
- Bench, three-sided (review finding — the dominant cost is death-side):
  (a) creation per class: expected ≈ +13% direct-registration; formal
  budget +15% target / +25% STOP — an EXPLICIT exception to the refactor's
  flat-or-stop rule, owner-flagged for veto since he supplied the guide's
  numbers; (b) read/write/quiet benches: FLAT (registration is
  construction-only); (c) GC-side: the alt-a audit methodology (GC time
  under churn with FR on/off) reported with the landing — target within
  the donors' measured envelope.
- Full standard stack; the oracle is untouched (reclamation is unobservable
  in lockstep semantics; the probes are the referee).

## 7. Open questions for re-review

1. The guard list after correction — any liveness source still missing
   (trace retention of node names? render snapshots across yields — covered
   by open-render membership?).
2. The per-boundary trigger-queue bookkeeping cost on hot boundaries
   (watcher release is warm; compaction is warm).
3. ReducerAtom's post-constructor shape change vs per-class profiling.
4. The deferred owned-effect cleanup ordering — can a deferred cleanup
   observe a world that already forgot the record?
5. Epoch + gen defusing — any third resurrection axis (growth rebuild
   reallocating record memory without epoch bump — does R-6's epoch cover
   growth, or only reset?).
