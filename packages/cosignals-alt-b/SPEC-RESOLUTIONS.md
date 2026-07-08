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

## §ambient-W0 — ambient read semantics (owner-approved, alt-a/alt-b ONLY)

**Recorded divergence**: mainline cosignal keeps NEWEST-ambient; the alt
family switches ambient reads to W0. Deliberate, per owner decision — never
leak one family's expectation into the other (shared/ported tests must be
parameterized per family: alt = drafts-hidden, cosignal = NEWEST).

1. **Ambient top-level/handler `.state` = W0** (committed + applied urgent).
   Pending DEFERRED batches are INVISIBLE outside their own context until
   commit. Rationale: an urgent handler deriving from `.state` must never
   leak a speculative draft into committed state (the onClick scenario:
   transition `set(1)`; urgent `set(state*2)` computes `0*2` and supersedes
   the transition — pinned in RTL, both gate modes; abort leaves no
   contamination — pinned in overlay + oracle `readOwnDraft`/ambient ops).
2. **Read-your-own-draft**: inside a deferred batch's own write scope
   (`ForkDouble.inBatch`, a React transition scope) or its render pass,
   ambient reads resolve that batch's world. Urgent scopes and `batch()`
   read-own-writes unchanged (their writes are APPLIED — W0 includes them;
   conformance-critical). The gate decides LOGGED vs DIRECT, not visibility —
   asserted in both gate modes. ReactFork probe: `(T === lastMintT)` identity
   on the reconciler's current-transition slot, token recorded at the scope's
   first minting write; reads before any write correctly see W0.
3. **`latest(x)` is THE explicit Wn read (drafts included)** — supersedes the
   earlier deviation where in-render world choice was the only distinction.
   Per-context table (reconciled with alt-a on the top-level outcome):
   - plain top level / handlers / engine effects: **Wn including unapplied
     drafts** (matches alt-a's spec'd outcome);
   - inside a computed/overlay eval: that eval's world (memo-certificate
     integrity — sampling Wn would poison per-world memos);
   - inside a render pass: the pass's world Wp (replay purity; a committed
     pass never tears an in-flight sample — reasoning documented, our call);
   - inside withRootCommitted: the root's committed view.
4. **`committed(x)` / `useCommitted`**: explicit committed-world read over the
   existing withRootCommitted/committed-view machinery (root-refined when a
   root scope is active; global otherwise — the hook is global, since hooks
   do not know their root). Box handling mirrors `.state` + two-level rule.
5. **Perf**: ambient reads under live deferred batches now take the kernel
   fast path (W0 IS the kernel state) instead of overlay resolution — G-8
   ambient-read ratio drops to ~1.0x (see report); the Wn cost is paid only
   by explicit `latest()` and render-pass reads.

## §lazy-init — lazy state initializers (owner-approved feature, both alts)

`new Atom({ state: () => T })` / `new ReducerAtom({ state: () => S, ... })` /
`useAtom({ state: () => T })`:

1. **React useState convention**: function-valued `state` IS the initializer —
   evaluated ONCE, lazily, at first materialization (never at construction).
   Storing a function as state requires the wrap: `state: () => fn`
   (documented on `AtomOptions.state` with the `documentVisible` recipe — an
   SSR-safe environment probe whose module-scope construction never touches
   `document`).
2. **Untracked + graph-pure**: the initializer runs with tracking suppressed
   (its reads link nothing — pinned: a computed that materializes the atom
   does not inherit the initializer's deps) and writes inside it are rejected
   in debug. A throwing initializer re-runs on the next read (React retry
   semantics); a cyclic initializer (reads its own atom) throws a clear error.
3. **Render-context safe**: first read during a render pass materializes —
   it is a pure slot fill (both value slots), not a write: no propagation, no
   watchers, no §10.8 violation. Nothing can have observed the atom before
   materialization, so filling the slot is invisible by construction.
4. **Write-before-first-read (decision: RUN the initializer)** — the write
   path's equality compare (`pendingAtomValue`) materializes first, so
   `set(initValue)` on an untouched lazy atom is correctly dropped by the
   equality contract, and `update(fn)`/`dispatch(a)` receive the initializer
   result. Both gate modes pinned (the gate decides LOGGED vs DIRECT; both
   compare through the same accessor).
5. **Tape/base-snapshot**: `createTape`'s base snapshot reads through
   `pendingAtomValue`, so a DRAFT-world first touch bases the tape on the
   initializer result — canonical base state, never draft-scoped (pinned:
   W0/committed read the init value while the writer world shows the draft).
6. **SSR**: `installState` IS the materialization — the initializer is
   skipped (slot fill + `lazyInit` cleared; sound because an unmaterialized
   atom has no observers).
7. **Mechanism**: a unique symbol sentinel occupies both value slots; the two
   base accessors (`kernelAtomValue`, `pendingAtomValue`) test one identity
   compare on the hot path — every other path (worlds, folds, peeks, watcher
   seeding) routes through them. The initializer lives in the meta column.

## Open API questions

- **`suspend: 'always'` option**: should a computed (or hook call site) be able
  to opt INTO suspension for urgent refetches — i.e. force rule (a) behavior in
  urgent passes, flashing the fallback intentionally (e.g. paginated views that
  must not show stale rows)? Deferred; today the urgent path always serves
  stale, and there is no per-site way to demand a fallback. Recorded
  per owner instruction — do not implement without a decision.
