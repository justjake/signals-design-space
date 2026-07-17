# fm2 — Worlds rented from React's lanes

## How it works

Each atom is a committed base plus a dispatch-ordered queue of ops tagged with a WorldBatch (null = urgent) — a userland mirror of React's updater queue. With no deferred drafts, urgent writes skip the queue and land on base; canonical reads never touch world machinery. startTransitionWrite calls royaleProbeLane inside React.startTransition and keys one engine batch per transition lane; writes inside become drafts. A world is the ordered set of open batches. The fork's render-start event carries lanes: the host sets the ambient world to batches intersecting the pass; commit retires committing-lane batches by marking their ops committed in place and compacting the prefix, so functional updates replay over the urgent-advanced base (rebase arithmetic). Hooks store no values: a useReducer bump counter forces re-render and the render body re-reads under the ambient world. Draft pokes re-dispatch through royaleRunWithLane so corrective renders join the owning transition's commit; layout effects record per-root committed views (only commit-surviving renders record).

## Advantage

The 48-line fork (incumbent: 1510) replaces binding machinery wholesale: StrictMode replays, urgent-interleave rebase, and render-pass consistency fall out of React's own updater-queue replay because values never sit in React state. The canonical path is a plain synchronous signal graph — concurrency cost lands only on readers inside a world. Committed views cost zero on the write path. It passes the latest()-context rule that sank two prior entries. Library is 1734 LOC vs 4689/4909 incumbents.

## Disadvantage

Worst: performance — CI field ratio 1.843x alien (FH2 1.108, cosignal 0.947); creation-heavy suites ~5x. Second: it leaks — a root unmounted with a parked transition leaves its batch and drafts open indefinitely (bounded by 16 lanes, still a reclamation hole). Deep private-API coupling: it pokes shared internals' T field and hard-requires the forked build. Retirement costs one value-equal wasted render per subscriber per transition commit; overlapping transitions on one lane share a coarser batch.

## Room for optimization

The gap is allocation and validation overhead, not the overlay (canonical reads bypass it): per-node Set subscribers iterated every notify, three parallel dep arrays with instanceof checks plus per-read atom-value capture, Check-not-Dirty validation walking deps on every wakeup. Levers: (1) array subscriber lists plus lazy per-node allocation — the entry's own estimate for closing creation from 5x toward parity; (2) drop per-dep value capture, folding revert detection into version stamps; (3) replace string worldKey/worldStamp concatenation with numeric epoch stamps.

## Bugginess

Judge verdict: clean, no gaming; every gate independently reproduced. 179/179 conformance with verified zero skips, 204/204 engine tests, 1200-seed oracle with a working negative control, 5/5 leak audit, 25/25 shared battery on a byte-identical kit, 31/31 real-React gate, 6/6 fork tests, 1140-pass upstream adjacency. Residual edges are disclosed: abandoned-lane batches, committed() canonical fallback before first commit, post-await writes classifying urgent. Benchmarks reported against self-interest. High shipping confidence modulo the leak gap.
