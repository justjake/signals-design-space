# Signal reclamation — FinalizationRegistry-driven record recovery

STATUS: REVISION 3. Round-2 reviews: codex not-ready (6 blockers), fable
another-pass (all round-1 findings verified resolved; remaining items
plan-text). Every round-2 finding is resolved below. Companion to
plans/2026-07-07-great-refactor.md; lands as stage S5R, and §2 SHAPES the
refactor's S5 design.

## 1. The leaks (verified at HEAD)

- L1 kernel records: no dispose path for atoms; unwatched-then-dropped
  computeds never free. FinalizationRegistry appears nowhere in cosignal.
- L2 engine pinning: `AtomNode.handle` is strong; the registry maps hold
  every adopted node; deletion exists only for computeds.
- L3 kernel pins: a `Computed` is stored in its own record's aux value slot
  (ctx.use owner resolution), and lifecycle atoms are rooted by
  `lifecycleStates` whose stored context closes over the handle.

## 2. Prerequisites built into refactor S5

- The aux slot stops storing the handle: ctx.use owner resolution becomes
  id-keyed; the use-cache moves into a nodeIndex-keyed engine column
  (scrubbed at record free — the refactor's column-scrub hook).
- LIFECYCLE, handle-free (round-2 design debt, now specified): the
  lifecycle record lives ON the handle (handle-owned state — an object the
  `Atom` instance references, so it dies with the handle); the engine's
  per-id index holds a **WeakRef** to the handle for the cold shift path
  (watched/unwatched transitions deref it; a dead deref means the handle is
  gone and the lifecycle is over — correct, nothing can observe it).
  Justification vs the rejects list: the +93 ns WeakRef rejection was for
  hot per-registration schemes; lifecycle shift edges are cold
  mount/unmount boundaries. The shift path keeps routing set/update through
  the handle's own methods (the full policy path — equality,
  classification), which the deref supplies.
  KNOWN RESIDUAL, documented: a user lifecycle callback that closes over
  its own atom pins itself only through USER-held structure once the
  engine holds no strong path; if the user's closure is itself only
  reachable from the handle-owned record, handle + record + closure form
  one garbage cycle and collect together. The engine never holds the
  closure strongly.
- `__resetEngineForTest` provides the ENGINE EPOCH (refactor R-6), and the
  reclamation state below is part of R-6's scrub checklist (registry swap,
  retry queues, deferred-cleanup queue).

## 3. The technique (owner's guide; donor-verified)

Core finding unchanged: FR cost lives in GC-side weak-target processing and
scales with the dying target's shape (alt-a audit: 237 ms vs 84 ms GC,
register itself 14 ms; ~+41 ns closure-rich vs ~+10 ns lean death).

1. Registration target by shape, PROFILED PER CLASS (`Atom`, `Computed`,
   `ReducerAtom` — whose post-constructor shape transition is flagged to
   stabilize or profile separately): lean-instance direct registration
   expected (alt-b: 12.9% direct vs 23.9% token); token indirection only
   where a class profiles closure-rich.
2. heldValue packing: bare id while gen = 0; `gen·2^32 + id` while
   `gen < 2^21` (exact ≤ 2^53−1); an `{id, gen}` object beyond. GEN is a
   signed Int32 that wraps — defusing compares by raw int32 EQUALITY
   (wrap-safe); full-cycle generation ABA (2^32 frees of one record between
   registration and finalization) is a documented astronomical residual.
3. PER-EPOCH REGISTRY (round-2 blocker, resolved): the heldValue carries no
   epoch — the EPOCH LIVES IN THE REGISTRY'S CLOSURE. Each engine epoch
   constructs its own registry:
   `const epoch = currentEpoch; reg = new FinalizationRegistry(h => reclaim(h, epoch))`.
   Registration always goes through the current epoch's registry. At
   `__resetEngineForTest` the engine drops the old registry: (a) an
   unreachable registry's pending callbacks are never delivered — mass
   cancellation by dropping one object, with no per-handle unregister cost
   (the rejects list stands); (b) any callback already extracted before the
   drop still runs `reclaim(h, oldEpoch)` and no-ops on the epoch compare —
   belt and suspenders, since delivery-after-drop edge semantics are not
   guaranteed either way. Production never resets: one registry for the
   process lifetime, zero production cost.
4. No one-shot loss: skipped callbacks file `id → {gen, epoch}` entries in
   TARGETED trigger queues drained by the exact site where their guard
   clears (§4), never a globally scanned set.

Measured rejects (binding): per-handle unregister tokens (+103 ns), WeakRef
registration schemes (+93 ns — see §2 for the cold-edge exception), deferred
/batched registration, lazy registration.

## 4. Guards, triggers, and the free path

A finalizer FREES unless a liveness source holds; each source that can hold
is also the TRIGGER that re-attempts when it clears (per-id, at the clearing
site — round-2 correction: boundaries alone miss clears that happen inside
other operations):

| Guard (skip while true) | Trigger (re-attempt here) |
|---|---|
| kernel SUBS non-empty (something reads this record) | `unwatched()` — the last-subscriber unlink |
| the node has ANY entry in the watcher index (covers live, mounted-in-an-open-render, and reveal-deferred watchers uniformly — round-2: deferMount leaves a watcher in the indexes while neither live nor mounted) | watcher index removal (`removeWatcher`, unmount teardown) |
| membership in any open render's arena or any arena's suspended list | render end; settlement drain; arena release/quiesce |
| observation-index retains (`obsRefs > 0`) | the obs RELEASE-TO-ZERO site itself — wherever it happens: dependency recapture, subscription teardown, watcher release (round-2: these clear without any listed boundary firing) |
| a non-empty WriteLog | WriteLog compaction (edge-triggered: the tape-empty transition files the check, so the warm compaction path pays a size-0 bail otherwise) |

NOT guards: outgoing DEPS (reclamation DISPOSES them — donor pattern; a
never-subscribed computed must reclaim), HOST_OWNED (permanent metadata),
the lifecycle marker (lifecycle cleanup is part of the free path).

FREE-PATH TOTALITY (two-phase; round-2: `pendingFree` stores bare ids and
cannot carry this): reclamation never runs user code in the GC job. Phase 1
(the FR callback): verify epoch+gen, verify guards, unlink structure,
dispose owned deps; any owned effect's user cleanup is NOT run — it is
filed as a DEFERRED-CLEANUP entry `{id, gen, cleanups[]}` in a dedicated
queue, and the record's free is queued BEHIND that entry. Phase 2 (the next
boundary sweep): run the cleanups with `reportError` isolation (a throw
never aborts the sweep or skips the free), then free the record. The record
cannot be reused before phase 2 completes because the free — hence the
free-list insertion — IS phase 2's last step. Pinned by a throwing-cleanup
probe. Deterministic dispose paths do NOT unregister; they rely on
epoch+gen defusing.

Trigger-queue discipline: every warm trigger site opens with a size-0 bail;
filing is edge-triggered (on the guard's clearing transition, not per
operation).

## 5. Probes (failing first; donor plateau pattern)

- Plateau assertions (bounded gc()+timer rounds, one-round plateau
  tolerance) in a forked --expose-gc vitest project; never exact-baseline.
- P-L1a/b (kernel records: atoms; unwatch-then-drop computeds), P-L2
  (engine columns/maps), P-RETRY per trigger row of §4's table, P-DEPS
  (never-subscribed evaluated computed reclaims and disposes its deps),
  P-CLEANUP (throwing owned-effect cleanup: reported, sweep completes,
  record frees), P-ABA and P-EPOCH via the deterministic
  `__simulateReclaimForTest` seam (real GC cannot schedule a stale callback
  deterministically).

## 6. Gates

- The probe suite green = the leaks are fixed; it joins the standing suite.
- Bench, four-sided: (a) creation per class — expected ≈ +13%; budget +15%
  target / +25% STOP (an explicit owner-flagged exception to flat-or-stop);
  (b) read/write/quiet — FLAT (registration is construction-only);
  (c) GC-side — the alt-a audit methodology (GC time under churn, FR
  on/off), within the donors' envelope; (d) CHURN (round-2): unmount-storm,
  subscription-churn, and compaction-heavy lines price the trigger-queue
  bookkeeping — flat modulo the size-0 bails.
- Full standard stack; the oracle untouched (reclamation is unobservable in
  lockstep; the probes are the referee). The trace decoder tolerates and
  labels freed ids in old records (cold, S6-adjacent).

## 7. Open questions for the verification pass

1. The guard/trigger table — a clearing site not listed (anything that
   drops obsRefs, watcher-index entries, or arena membership outside the
   named paths)?
2. Per-epoch registry delivery semantics across JS engines the test suite
   runs on (the belt-and-suspenders closure check makes this safety-
   neutral; the question is probe flakiness only).
3. The WeakRef cold-edge exception (§2): any hot path that derefs the
   lifecycle index?
4. Phase-2 ordering vs the boundary sweep's existing work (sweepPendingFree
   interleaving).
5. The +15%/+25% creation budget vs the per-class profile outcomes.
