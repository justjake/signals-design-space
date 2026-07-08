# Coordinator-supplied spec resolutions (oracle-validated by alt-b; adopt, do not rediscover)

Working notes for the cosignals-alt-a implementation. These override/patch the shared
sections of react-concurrent-signals-arena-alt-a.md where it is ambiguous or defective.

## Seven resolutions

1. **§10.6 vs §17.2 contradiction (urgent-drain decision world).** Implement W0
   decisions PLUS per-live-deferred-world expansion: on urgent drains,
   re-validate/expand every live deferred world's memos.
2. **§9.8 "urgent writes skip the walk" is UNSOUND.** An equal-value urgent write
   onto a tape never propagates via the kernel yet shifts every pending world's
   fold. Applied logged writes must ALWAYS queue a token-0 walk.
3. **First-divergence completeness gap.** An urgent write can CAUSE first
   divergence for world k (branch flip onto k's entries) with no k-memo existing.
   Closed by the same per-live-deferred-world expansion as (1).
4. **Truncation re-notification.** Truncation must re-notify the rolled-back
   batch's lane (spec is silent; otherwise the lane is stale until an unrelated
   drain).
5. **Unmarked-nested-child certificate hole.** Overlay frames must ALWAYS recurse
   via overlayEvaluate — never take the kernel path for children inside an
   overlay frame — else unlogged grandchild sources escape the parent
   certificate.
6. **Fork double: onBatchOpened edge.** §9.1 needs it; §6.1 lacks it. Add
   onBatchOpened to the fork-double interface.
7. **Minor.** (a) Stamp ONE retire-time ticket per retirement (not per entry).
   (b) Missing-world broadcast default = current W0, with subscription-time
   seeding of live deferred worlds.

## Five pitfalls the oracle catches (build right the first time)

- Per-token walk tickets in grouped drains.
- Truncation re-notification (see resolution 4).
- W0-no-op retirement shifting other worlds.
- Snapshot-before-re-evaluate in chain re-validation.
- Re-validation ordered BEFORE broadcast decisions.

## Async model (owner design change, 2026-07-08): Solid-2.0-adapted graph-status suspense

Deviations from spec §11.3/§12.3, adopted per the owner brief (reference:
vendor/solid/packages/solid-signals/src/core/{async,core}.ts):

1. **Pending/error are graph state, not evaluation-attempt state.** The §11.3
   boxes remain the value-space representation, but a computed hitting an
   unresolved async dep now EVALUATES-TO-PENDING: no thrown thenables
   mid-evaluation. `ctx.use` records the pending thenable on the active
   evaluation frame and RETURNS (undefined stand-in), so multiple `ctx.use`
   calls in one evaluation all register before pending surfaces — parallel
   fetches, no throw-created waterfalls.
2. **Thenable identity is node×world, not render-attempt.** §12.3's
   lineage-keyed positional cache is DELETED (with the react bridge's
   synthesized per-container lineage and its interleaved-works aliasing
   limitation). Slots key on: `canon` for canonical evaluations, the pass
   INCLUDE MASK for pass worlds (stable across restarts/retries of one
   logical work; distinct for works with different batch sets — identical
   batch sets are the same world, where sharing is correct), writer token
   for writer worlds, `n` for newest.
3. **Downstream forwards pending by default**: reading a pending computed
   inside another evaluation records the store-held thenable on the reader's
   frame and continues with undefined; the reader's own result becomes the
   pending box. Errors keep §11.3 throw-through-read semantics (caught by
   the wrapper into error state).
4. **Settlement is a normal write**: resolution commits through
   invalidate → propagate (+ the §10.5 epoch bump for world memos).
   Resumption is propagation.
5. **Latest-wins while pending; first-wins once settled.** A pending slot
   occupant is REPLACED by a different incoming thenable (re-evaluations are
   dirty/cert-gated, so a different thenable at a pending position means the
   inputs moved — found by the interleaved-works RTL case: a canonical
   evaluation after an input change must not stay stuck on the stale
   in-flight fetch). Settled occupants stay until the canonical
   settled-completion clear (fresh fetches on the next real input change).
   Cache-less callers may pay one extra fetch per settlement wave; keyed
   data layers make replacement a no-op.
6. `ctx.use` outside a computed evaluation throws (it previously threw a
   raw SUSPEND sentinel through the caller).

## Solid-2.0 async API set (owner brief, 2026-07-08; reference: research/solid2-async-model.md)

7. **Two-level suspense rule** (research §2, adapted for React replay): the
   React boundary (useSignal/readForRender AND top-level class reads) hands
   the store-held thenable to React only when the pending box has NO latest
   (never-settled first load → fallback). Refresh-pending serves the latest
   settled value straight through — stale content stays, no fallback flash.
   SuspendedBox gained `hasLatest`/`latest`, carried from the previous
   committed value (or through chained pending boxes).
   **UNINITIALIZED-clears-at-COMMIT decision**: Solid clears the bit when the
   first real value commits at flush, not at promise resolution. Our
   equivalent: `hasLatest` flips when the settlement WRITE lands the real
   value in the canonical value slot (settlement = invalidate → propagate →
   recompute = our commit) — resolution alone changes nothing until the
   recompute commits the value. Boundary-level `_initialized`/`on`-reset
   nuances (a FRESH boundary around a refreshing source showing fallback)
   are React's own Suspense bookkeeping in our host — not reimplemented.
8. **isPending(x)**: lazily-created cached computed per node over the raw
   box shape (`engine.readComputedRaw` — tracked, unforwarded, never
   refetches, honoring Solid's "probes don't refetch" rule). Boolean
   equality cutoff gives flip-only propagation; per-world correct by
   construction. NON-ADOPTION: Solid's first-load isPending rethrow (probe
   participates in suspense) — in our host, first-load suspension comes from
   useSignal itself; the probe is always a plain boolean.
9. **refresh(x)**: clears the node's thenable slots (all world keys) and
   invalidates through the normal write path; `latest` is preserved via the
   pending box (refresh-pending state). The pendingJoins identity cache is
   KEPT (same source set ⇒ same joined thenable; clearing it would
   spuriously re-broadcast — oracle-caught). No-op on atoms/foreign nodes.
   Refresh races supersede latest-wins (slot replacement + settlement
   no-op guard). Cache-less callers pay one superseded fetch per settlement
   wave (documented above, rule 5).
10. **latest(x)** as WORLD SAMPLING (no new buffers): always samples the
    NEWEST world (Wn — every write visible, our analog of Solid's staged
    `_pendingValue`), in every read context (render included, deliberately
    reading ahead of the pass pin — the loading-indicator pattern). The
    async node itself → `box.latest` (stale committed value, never
    suspends, never registers pending); upstream/sync-derived nodes → the
    in-flight Wn value. Tracked callers subscribe to the sampled node.
