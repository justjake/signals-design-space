# One Core convergence plan (2026-07-05)

> **AMENDED after adversarial review + owner rulings (same day).**
> Both reviews (codex, fable — see reviews/2026-07-05-one-core-plan-
> review-*.md) converged: Phases 1–2 as originally specified routed
> attempt-lifetime render artifacts through batch-lifetime machinery.
> Owner rulings: **Phase 1 is DROPPED** — `useComputed` keeps
> deps-keyed node recreation (React's own render-artifact lifecycle;
> the stable-node design existed only to serve a suspense posture now
> judged to exceed React). **Phase 2 is REDEFINED** below (per-key
> cache on the living node; two-form `ctx.use`). **Phase 0 landed**
> (f6a109b) with checkpoint 4 REVERTED by experiment — the mount fast
> path is semantic, pinned as scar S43. **New Phase 1b added**: the
> quiet-mode write short-circuit (owner-ratified sync-price
> criterion). Phase 2's original text is superseded by the amendment
> at the end of that section.

Owner mandate: cosignal ships as **One Core** — a concurrency-ready
signals library, sync by default, exactly React's own posture (one
build; never using transitions means never paying for them beyond
predictable branches) — plus **One React Adapter** that is a thin
client of the core. The independent review (2026-07-05) called the
current state "twins all the way down": two engines glued by a
swappable operation table, two write-interception layers, two suspense
implementations, an adapter driven off an allocating event log.
This plan removes the twins.

## Principles (rulings, not aspirations)

1. **Concept convergence.** One mechanism per concern. Where two
   mechanisms exist for one concern, one dies — the glue between them
   was itself complexity.
2. **React parity, not gold-plating.** Match React's *documented*
   contracts; do not exceed them. Precedents: the async-transition cut
   (post-await writes are ambient unless re-wrapped — React's own
   rule), and the rejected suspense request-registry (react.dev:
   "Promises passed to `use` must be cached so the same Promise
   instance is reused across re-renders" — the cache is the
   *framework's* job for a *living* consumer; React itself refetches
   for consumers that die with discarded speculative work, and so may
   we).
3. **Magic lives in core; adapters are clients.** If React needs a
   capability, the capability is a core concept any host could use
   (portability test: a hypothetical non-React host with lanes /
   branch-commit-rebase semantics plugs into the same surface).
4. **Sync by default, one code path.** No twin builds; empty-batch /
   no-host short-circuits as the first test on hot paths. Measure the
   sync-only price honestly; do not game benchmarks with a separate
   simplified core.
5. **Verification first.** The reference model (cosignal-oracle) is
   the referee and models every semantic change *before* engine code;
   every phase lands only with the full battery green: package suites,
   oracle lockstep fuzz corpus, 179-case conformance (three
   configurations), React bindings suite, typechecks.

Kept by explicit ruling (all orthogonal to the convergence): trace
SESSION mode (devtools), `configure({forbidWritesInComputeds})`, the
atom observed-lifecycle `effect` option. The operation-table naming
cleanup remains deferred.

## Phase 0 — One Core merge (IN FLIGHT)

Checkpoints, in order, each fully verified:
1. **One write path.** Operation capture (set vs update(fn) vs
   dispatch(action)) moves into the core's public methods — they have
   the operation in hand by definition. Delete the React shim's
   prototype patching and its recursion guard.
2. **One engine, one entry.** Merge the concurrent engine into the
   single `cosignal` entry. Delete: the `cosignal/logged` entry, the
   swappable-table arming (`__installTwinTable`, the factory swap),
   the read/write routing words. Replace the twin-build isolation test
   with the One Core promise stated behaviorally: with no host
   attached, heavy create/write/read activity mints zero receipts,
   zero tokens, zero worlds, zero events.
3. **Direct listeners.** The adapter subscribes to the bridge's
   load-bearing events via direct callbacks; the event log remains for
   the referee and tracing but allocates only when someone consumes it
   (this was the measured one-object-per-write floor).
4. **Delete the fake mount fast path.** The reviewer proved the code
   computes the expensive reconciliation value unconditionally, so the
   four-condition fast path optimizes nothing; the covered-check
   compare becomes the rule. Behavior must be observably identical
   (the fuzz corpus proves it).

## Phase 1 — useComputed v2: the function is state

Replace deps-keyed node recreation with a **stable node** whose
evaluation function rides an atom:

- The hook holds `{deps, fn}` in an atom with a deps-shallow-equality
  cutoff (fresh closures per render never churn: equal deps ⇒ the
  write drops before minting anything — StrictMode double-renders and
  render replays are free).
- The computed's function reads that atom (a tracked dependency) and
  calls the current closure. Versioning of the function is thereby
  handled by the exact machinery that versions every value: a pending
  world folds its own function version; the committed world folds the
  committed one; discard drops the version with the batch; rebase
  re-renders and re-writes. No parallel versioning channel — the old
  staged-evaluator design (the historical bug factory) failed
  precisely because it versioned functions *beside* the write/world
  machinery instead of through it.
- **New core primitive: the render-phase write.** `fnAtom.set` must be
  legal during render (deferring to an effect would commit one
  incoherent frame: new props beside old-function-derived values).
  Shape mirrors React's own render-phase setState rule: attributed to
  the rendering pass's batch (the host's write-context API says
  which), legal only from the owner (dev-checked), replay-deduped by
  the deps cutoff. The general "writes during render throw" rule
  stays for everything else.
- Order of work: model the render-phase write in the oracle and fuzz
  it; then the engine carve-out; then the hook rewrite; then the full
  React battery. Observable semantics must match recreation except
  where strictly better (surviving subscriptions/caches, no
  per-deps-change node allocation).
- Known boundary carried forward: the atom itself is hook state, so a
  *mount* inside discarded speculative work still re-mints per attempt
  — mount reconciliation continues to cover it, unchanged.

## Phase 2 — One suspense implementation

With stable nodes, the node-scoped `ctx.use` cache (the base design)
satisfies React's documented contract by construction: the consumer
lives across re-renders, so the same Promise instance is reused.

- The core's node-scoped `ctx.use` becomes THE implementation.
- Delete the adapter's capsule system wholesale, including the
  `String(fn)` and value-prefix identity inference.
- The adapter keeps exactly one suspense job: translate the thrown
  not-ready marker into React Suspense.
- Document the React-parity boundary: a brand-new node mounting inside
  discarded speculative work re-issues its requests per attempt —
  identical to React's own uncached-promise story; apps that care use
  their data layer's cache (react-query/SWR/Relay compose inside
  computeds).

## Phase 2 as amended (owner rulings, post-review)

- `useComputed` recreation STAYS (Phase 1 dropped): React versions its
  render artifacts per fiber and clears aborted ones; recreation
  delegates function-version selection to that machinery instead of
  duplicating it.
- `ctx.use` becomes two forms, both exact React parity:
  1. `ctx.use(promise)` — the caller cached the promise (in their data
     layer or component state); we unwrap settled values and suspend on
     pending ones. This is React's `use()` contract verbatim.
  2. `ctx.use(key, factory)` — the batteries-included form: the node
     keeps a per-key map for its own lifetime; same key ⇒ same
     promise/value (safe across worlds — the key carries the
     world-varying inputs, and a request cache is monotone), different
     keys coexist. This is the "framework-provided cache" role React's
     docs assign to frameworks, scoped to the living consumer exactly
     as React requires ("the same Promise instance is reused across
     re-renders").
- The bare positional-factory form (no key) is DELETED — it is the
  "uncached promise" footgun react.dev warns about, and the reviews
  proved it world-unsound (one positional slot collides across worlds
  asking different queries).
- The adapter's capsule system deletes wholesale (String(fn) and
  value-prefix identity included). The adapter's one suspense job:
  translate the thrown not-ready marker to React.
- Re-pin to parity: the mount-retry test (`fetches === 1` across a
  discarded initial mount) changes to React's own behavior — a
  discarded mount attempt may re-run the factory; apps that need
  cross-death dedup cache the promise in their data layer and use
  form 1.
- Honest referee note: the reference model has no thenable vocabulary,
  so this phase is policed by the engine suite + bindings battery, not
  lockstep fuzz. Extending the model with a thenable op is follow-up
  work, justified only if suspense schedules keep finding bugs.

## Phase 1b (new) — quiet-mode writes (owner-ratified criterion)

While no deferred batch is live and no render pass is open, a write to
a registered atom folds directly (no receipt, no tape, no delivery
walk, no event) — the concurrency pipeline arms only while something
is actually pending, so a React app that never starts a transition
pays raw-kernel prices plus one branch. Acceptance: a benchmark
criterion (host-attached sync write within a small budget of the
kernel write) plus fuzz/battery schedules covering transitions arming
and disarming around quiet writes (a transition starting after quiet
writes begins from committed base — there is no history to
reconstruct).

## Phase 3 — One React Adapter

`cosignal-react` shrinks to hooks + host-event wiring. Anything
engine-shaped remaining in the shim migrates down into core as a
host-agnostic concept or dies. Exit review: the host contract
(open batch / pass start-yield-resume-end with dispositions / per-root
commits with generations / retire / deliver-into-batch) reads as a
documented, host-agnostic protocol.

## Phase 4 — Re-baseline and close

- Honest benchmark table: sync-only price of One Core vs the old base
  entry, plus the concurrent-path numbers; publish whatever the
  numbers are.
- README/doc updates for the converged architecture (npm-standalone,
  define-before-use standards apply).
- A second no-priors simplification review over the converged result;
  grind residuals.

## Sequencing and safety

Phases land in order, each as its own verified commit series. The
oracle package is untouchable throughout (its adapter may be rewired
mechanically; comparison semantics never weaken). Conformance pins
sync semantics; the bindings battery (including the
mid-transition-suspense case) pins React semantics; the fuzz corpus
polices every engine change. Any phase that surfaces a contract
question stops for an owner ruling rather than inventing semantics.

## Open risks (stated for adversarial review, not hidden)

1. Render-phase writes are the plan's one new engine primitive. Attack
   surfaces: speculative-write discipline (a discarded pass's fn write
   must vanish with it), multiple concurrent passes writing different
   function versions to the same atom, interaction between the deps
   cutoff and the exceptional-outcome flag-delta in the recompute
   cutoff, ownership enforcement, and whether the carve-out can leak
   legality to general user writes during render.
2. Node stability is an *update-path* claim; React may still discard
   and re-mint on mounts. If any UPDATE-path schedule exists where
   React discards the fiber but the batch survives with the fn write
   in it, the stable-node assumption needs a walked schedule.
3. Phase 0's empty-state short-circuits must genuinely be first tests
   on the hot paths, or the sync-only price shows up in the read/write
   benches.
4. Capsule deletion removes cross-node-death request dedup; the
   parity argument says that's correct — the risk is a React behavior
   (e.g. an act()/retry pattern in the existing 45-test battery) that
   silently depended on it.
5. The event log's consume-gated allocation must not starve the
   referee (lockstep tests) or tracing when they ARE attached.
