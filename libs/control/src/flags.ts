/**
 * Optimization flags for @lab/control ("tuned alien-v3").
 *
 * Each optimization sits behind a module-level const so it can be measured
 * in isolation: edit the const, re-run bench/conformance (each bench run is
 * its own child process, so no rebuild step is needed).
 *
 * Both optimizations are semantics-preserving; the conformance suite stays
 * green in all four flag combinations.
 */

/**
 * Optimization 1 — persistent scratch stacks.
 *
 * Replaces the heap-allocated `{value, prev}` cons-cell stacks in
 * `propagate()` and `checkDirty()` (one allocation per branch point per
 * traversal) with module-level array stacks reused across calls.
 *
 * Re-entrancy: `checkDirty` -> `update()` -> user getter -> reads other
 * computeds -> re-enters `checkDirty` (and `propagate`, via inner writes).
 * Each call saves a base pointer on entry and works strictly above it
 * (anod's CTOP discipline, vendor/anod/src/core.js), publishing its cursor
 * before the user-code entry points and restoring the base when they throw
 * — via a catch at the two update() call sites, NOT a try/finally around
 * the hot loops, which measured +25% on the smallest kairo cases. The
 * arrays grow by appending at the top index (V8 grows packed-element
 * backing stores geometrically) and are never truncated, so steady state
 * allocates nothing.
 */
export const USE_PERSISTENT_STACKS: boolean = true;

/**
 * Optimization 2 — global quiet-epoch fast path.
 *
 * A global counter bumped whenever a signal write actually changes
 * `pendingValue`. Each computed records the epoch captured *before* its
 * last verification (recompute or checkDirty-clean); in `computedOper`'s
 * Pending path, `verifyEpoch === currentEpoch` clears Pending without
 * running `checkDirty`.
 *
 * Soundness (see the "QUIET EPOCH SOUNDNESS" comment in index.ts): stamps
 * capture the epoch before any user code can run, and every `propagate`
 * call site bumps first, so a stamp can never satisfy the fast path
 * unsoundly. The same argument proves the path is UNREACHABLE in this
 * architecture (alien-v3 pushes Pending to every subscriber, so the flag
 * already encodes strictly better information than a global counter), and
 * measurement agrees: zero fires across the conformance suite, the unit
 * tests, and kairo+sbench, with per-suite deltas inside run noise.
 *
 * Default OFF: sound but provably inert — the control baseline should not
 * carry dead-code overhead (one compare per Pending read, one store per
 * recompute, one increment per changing write, +8 B per computed).
 * Flipping it on is conformance-green and safe; see quiet-epoch.test.ts.
 */
export const USE_QUIET_EPOCH: boolean = false;
