/**
 * One Core probes (referee surface): one module-wide counter record proving
 * the zero-cost promise behaviorally — with no bridge registered, heavy
 * signal traffic must leave every field at its baseline
 * (tests/one-core.spec.ts). Engine logic never reads the counters; each
 * mutation site lives beside the machinery it counts (log-entry appends in
 * WriteLog.ts, batch creation in Batch.ts, world evaluations and bridge
 * construction in concurrent.ts), and the snapshot reader is
 * `__coreProbes()` in concurrent.ts.
 */
export const probes = { logEntries: 0, batches: 0, worldEvals: 0, bridges: 0 };
