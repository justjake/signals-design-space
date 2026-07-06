Disposition: **another item**. P2.S-A is not ready pending RUL-5 alone; settlement-boundary semantics remain blocking.

HEAD reviewed: `6298635bd1e7`. No files changed.

## Per-item verdicts

1. **Codex blocker 1 — settlement notification: PARTIALLY.**  
   The key-A/key-B trigger is repaired: R caches sentinel-A, newest caches B, and A’s shared listener now calls `settleTap(A)` independently of kernel C’s cached outcome; the suspended-list identity match marks R’s C for refold ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1136)). That closes the original stale-guard miss. It remains partial because marking does not itself guarantee the drain/refire required to finish settlement; see finding 1.

2. **Codex blocker 2 — fp-100/seq-50 provenance: CLOSED.**  
   Site-(b) marks now unconditionally refold on consumption, with no fingerprint consulted. Thus seq-50 becomes visible beneath fp-100 and can change the folded value despite an unchanged maximum ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:637)). This directly eliminates the missing cause bit.

3. **Codex blocker 3 — mixed tracked/untracked transitions: CLOSED.**  
   First occurrence resets reused-link mode, later tracked reads upgrade weak→strong, and later untracked reads cannot downgrade. Therefore both within-evaluation orders and both cross-evaluation transitions produce the required delivery behavior. Strong-only observation capture also matches HEAD, where capture happens in `recordEdge` but not `recordWeakEdge` ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:844), [HEAD](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:1833)).

4. **Codex blocker 4 — root-churn retention: CLOSED for the original schedule.**  
   Mount→commit→unmount-all→quiesce now releases the arena, cached payloads, links, and lists; remount reconstructs it before post-commit writes need routing ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1252)). No mount race appears under HEAD: watcher creation requires an open pass, while `quiesce()` requires no open pass ([logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:2669), [logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:3608)). Never-quiescing apps and immortal root records remain explicitly scoped to RUL-6.

5. **Codex blocker 5 — lifetime-table exactness modulo RUL-5: PARTIALLY.**  
   The three foot-block rows are honestly deferred to RUL-5. But the non-foot rows are still not semantically exact: committed arenas, marks, and outcomes are labeled L1 while being destroyed at zero-consumer quiescence or consumed/evicted ([table](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1345)). The contract says anything classified L1 must survive subscriber absence and “survive everything” ([contract](/Users/jitl/src/alien-signals-opt/spec/react-compliance-contract.md:110)). These are consumer-scoped caches/mechanism state, not L1 state. RUL-5 must cover them too, or the table remains invalid.

6. **Fable N-1 — ID reuse under GEN tenancy: CLOSED.**  
   Old shadow/side-column generation `g` fails against the reused node’s `g+1`, becomes cold, and cannot serve the old value/function. HEAD confirms free increments GEN before the ID returns to `nodeFreeHead` ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1098), [HEAD](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:530)).

7. **Fable N-2 — read-site pull/self-heal: CLOSED.**  
   A clean suspended shadow now probes the thenable status before serving; after `await`, it refolds synchronously instead of rethrowing pending. This transliterates HEAD’s `boxedRead` behavior ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1169), [HEAD](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:1827)).

8. **Fable N-3 — synchronous firing context: PARTIALLY.**  
   Deferring mutation while an arena walk is open addresses corruption, but the queue is not integrated with every possible outer boundary and the synchronous-listener ordering is incomplete. The exact drain-compare pin therefore does not yet follow from the written mechanism.

## New findings, ranked

1. **BLOCKER — deferred settlement does not form a complete boundary/fixed point.**  
   If settlement occurs during a watcher drain, the queue is applied after that drain has already passed. If it occurs during `revalidateCommittedSubs`, the proposed “before revalidate” point has already passed; HEAD proceeds directly to `flushNotify` ([logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:2972)). Standalone `committedValue`/`passValue` reads have no operation epilogue at all ([logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:3706)). At-rest `settleTap` likewise specifies marking but no settlement drain. A background-only suspended watcher/effect can therefore remain dirty until an unrelated operation, contrary to SU5.

2. **MAJOR — settlement-list dedup and synchronous sentinel creation are underspecified.**  
   The suspended list says “append” but gives no append-on-0→1 or equivalent uniqueness invariant, so repeated pending evaluations can make scanning O(suspending evaluations), not O(current suspensions). Idempotent marks do not deduplicate list entries. More seriously, a custom thenable may invoke HEAD’s listener synchronously before `unwrapThenable` reaches the statement that mints `t.sr` ([index.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:1641)); the plan queues “the sentinel” at that earlier callback without saying who creates it. Also, the lifetime claim that queued sentinels “retain no thenables” is false: `SuspendedRead` strongly holds its thenable ([index.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:187)).

3. **MAJOR — the fp-deletion cost ledger and gate do not agree with HEAD.**  
   Removing the separate fp pre-scan is genuinely cheaper than scan-then-fold. But “reuse `foldAtom` verbatim” does not mean no fingerprint computation: HEAD’s fold computes and stores `lastFoldFp` during every scan ([logged.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:1404)). The plan must choose between truly deleting that work and verbatim reuse. Separately, the wide-mask S-A “gate” has no acceptance threshold or failure disposition, and §8 still says P2 benches run at S-D despite §4.8/§4.9 moving gates into S-A/S-B ([gate](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1549), [summary](/Users/jitl/src/alien-signals-opt/plans/2026-07-06-effects-unification-and-nf2.md:1797)).

**One-line disposition:** **another item — do not start P2.S-A until settlement has an executable outermost/fixed-point drain and list invariant; lifetime classification also needs correction beyond the current RUL-5 foot block.**

