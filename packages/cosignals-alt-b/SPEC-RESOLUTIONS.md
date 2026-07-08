# Spec resolutions — cosignals-alt-b

Owner/coordinator-supplied resolutions that override or refine
`react-concurrent-signals-arena-alt-b.md` and the Solid-2.0 adaptation notes in
`research/solid2-async-model.md`. Each entry is pinned by tests.

## Solid-2.0 async API set (isPending / refresh / latest)

1. **Two-level suspense rule is CONTEXT-SENSITIVE** (owner amendment,
   supersedes the context-blind first cut):
   - (a) **Inside a transition pass**: `useSignal` ALWAYS hands the node-held
     thenable to React `use()` — even refresh-pending with a `latest`. React
     natively holds old UI for suspends-in-transition (no fallback flash) and
     keeps the transition pending until settlement, aligning signals-side and
     React-side waiters of the same promise into one commit (no early commit
     with stale data). Pinned by: *"signals-side and React-side waiters of one
     promise commit together"* (both gate modes), *"refresh-in-transition
     converges with stale-hold"* (both gate modes), react-real.test.tsx.
   - (b) **Urgent/sync pass with a settled history** (`box.latest !==
     undefined`): serve `latest` through; pending surfaces via `useIsPending`.
     Suspending here would flash the fallback. Pinned by: *"first-load →
     fallback; refetch → stale stays"* (both gate modes).
   - (c) **Never-settled** (`box.latest === undefined`, our UNINITIALIZED):
     always suspend.
   - Per-site opt-outs are `latest()` / `isPending()` — **no new hook
     variants**.
   - The engine never holds transitions itself; React is the single waiter.
     Settlement writes still commit into the requesting batch's world routing.

2. **UNINITIALIZED-clears-at-COMMIT equivalent**: Solid clears
   `STATUS_UNINITIALIZED` when the first real value COMMITS at flush, not when
   the promise resolves. Our equivalent: "uninitialized" is
   `box.latest === undefined`, and it disappears exactly when the settlement
   WRITE replaces the box in the drain (`onThenableSettled` → invalidate →
   materializing re-eval) — commit-time, not resolve-time. Any later re-pend
   folds the settled value into the next box's `latest` (`foldEvalResult`), so
   a once-settled node presents as refresh-pending from then on. Settlement
   MATERIALIZES each waiter canonically (Solid's `_blocked`-rerun equivalent) —
   without it an unobserved node's settled value never lands and its next
   re-pend would masquerade as a first load.

3. **`refresh` and the ctx.use re-registration mechanism**: this engine re-runs
   the fn at settlement, so resource fns must return a STABLE thenable per
   logical request (fresh-promise-per-run fns would livelock). "Clear thenable
   slots" therefore has no positional referent; the ergonomic equivalent is a
   per-node **refresh epoch** exposed as `ctx.refreshEpoch` — resource fns key
   their request cache on `(params, refreshEpoch)` and a refresh mints a fresh
   thenable. `refresh()` = epoch bump + invalidation shaped like the settlement
   write (worlds re-derive; live writer worlds re-decide) + an eager canonical
   eval that starts the refetch and folds the pre-refresh value into
   `box.latest` (refresh-pending, never uninitialized). No-op on atoms.
   Latest-wins: a superseded settlement re-runs the fn, which re-registers the
   CURRENT request.

4. **`latest` world choice is the ambient world** (no staged buffer — world
   reads are the answer): top level = NEWEST (in-flight values visible, the
   Solid staged-read asymmetry); inside a computed/overlay eval = that eval's
   world (world consistency is load-bearing for memo certificates); inside a
   render pass = the pass's world (render purity/replay); inside
   `withRootCommitted` = the root's committed view. Deviation from Solid: a
   committed-pass component cannot sample the in-flight world via `latest`
   (that would tear a pure replay); it uses `useIsPending` instead.

5. **`isPending` deviations from Solid §2.3**: our probe never suspends —
   first-load pending inside a reactive context returns `false` rather than
   rethrowing to suspend the boundary (Solid rethrows for
   uninitialized-first-load). Flip-only is exact: the probe is a cached
   `Computed<boolean>` over box shape; boolean equality suppresses upstream
   value churn.

## Open API questions

- **`suspend: 'always'` option**: should a computed (or hook call site) be able
  to opt INTO suspension for urgent refetches — i.e. force rule (a) behavior in
  urgent passes, flashing the fallback intentionally (e.g. paginated views that
  must not show stale rows)? Deferred; today the urgent path always serves
  stale, and there is no per-site way to demand a fallback. Recorded
  per owner instruction — do not implement without a decision.
