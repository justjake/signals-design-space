# Fork charter (frozen seed)

The old constraint — "minimal additive patch to React" — is **lifted**. We
own the fork. Depth is allowed; what is scored is size, maintainability, and
seam stability, not shallowness for its own sake.

## Goals, restated as scoreable properties

1. **Fork size**: count of touched reconciler files and lines; count of new
   concepts introduced into reconciler code.
2. **Maintainability**: every hook site edge-triggered from a place the
   reconciler already mutates its own bookkeeping (never sampled state);
   each site documents its invariant in place; the fork carries its own
   reconciler-level test suite that runs on every rebase; inert-when-unused
   (one null-check per site with no listener).
3. **Seam stability** (the co-design goal): the signals library depends only
   on a versioned protocol document (`fork-protocol.md` in the design), not
   on reconciler internals. Judge runs a **rebase drill**: "React renamed
   lanes / moved commit phases / changed update-queue internals — what in
   the signals library changes?" The right answer is "nothing; the fork
   re-implements the same protocol facts."

## Protocol facts known to be required (from the acceptance battery)

- Write classification: is-a-write-right-now deferred; which batch (integer
  token, minted lazily, never reused live; deferred bit in the token).
- Pass lifecycle: start(root, includedBatches) / end — **plus yield/resume
  edges** (C7: handlers run in yield gaps; wall-clock pass scoping is wrong).
- Retirement: exactly once per token, with committed flag; per-root commit
  lock-in for spanning batches (C11); async-action parking (C12).
- Lane-scoped scheduling: run a callback so its updates join an existing
  batch's lanes (`runInBatch`-class; C6, C10).
- A stable render-lineage identity for suspense caches across a batch's
  passes (C15).
- DOM mutation window (unrelated nicety; keep).

Candidates may propose MORE than this list — that is the point of the
charter — but every addition must earn its place against goals 1–3.

## The liberated design space (directions candidates may now take seriously)

- **Deeper observation**: expose the include-set/lineage/yield facts above
  natively rather than reconstructing them.
- **Lane-scoped execution**: richer entanglement/override scopes than a
  single `runInBatch`.
- **React-owned external state** (the wildcard): fiber-detached update
  queues managed by the reconciler itself — atoms whose visibility/rebase
  semantics are literally React's own update-queue code, deleting the
  library's reimplementation of lane filtering and rebasing. If a candidate
  takes this route it must confront honestly: hook queues are per-fiber and
  single-consumer (an atom is many-consumer — closer to context than to a
  hook); non-React reads/effects need a synchronous fold path anyway;
  reconciler surgery at this depth makes rebase cost the dominant risk, so
  goal 2 is the make-or-break axis. License to fail fast: a candidate may
  conclude "explored, not viable, because X" — that conclusion, with the
  schedule/mechanism that kills it, is a valuable round output.

## Hard rules

- No Fiber objects, no lane bitmasks, no update-queue internals cross the
  boundary — integers and documented callbacks only.
- Version-skew: bindings feature-detect the protocol and fail loudly on
  stock React (no silent degraded mode).
- The fork's test suite is part of the design deliverable, not an
  afterthought: every protocol fact gets a reconciler-level test.
