## Shape of the whole

The design has four layers: the packed synchronous kernel; a concurrent overlay of receipt tapes, batch tokens, and per-world shadow arenas; the React protocol shim; and a deliberately slower oracle. The base kernel is compact and coherent. Most maintenance risk sits at the seams, where one fact acquires several representations: writes are scalar pairs, `Op` objects, and packed columns; slot membership is both `Set` and bitmask; committed-root state is mutated by both engine and shim; diagnostic events are objects and packed records; production and referee bridges run different semantics. One rule change can therefore require coordinated edits across engine, oracle, shim, trace schema, and tests.

## Ranked findings

### 1. Root lock-in has two owners — SAFE-SIMPLIFICATION

**What:** The engine’s commit path updates `committedTokens`, `committedBits`, `commitGen`, `cas`, arena invalidation, events, and drains in [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:4695). The shim independently reconciles root reports by mutating only `committedTokens` and `commitGen` in [shim.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:467).

**Why complex:** Those fields are one invariant, but maintainers must remember which subset to update at each entrypoint. If the defensive shim path is reached for a token that already has a slot, `committedBits` remains stale, so committed reads still exclude the token. `cas`, arena fanout, and watcher drains are also bypassed.

**Simpler general form:** Add one bridge operation such as `commitTokens(rootId, tokens)` that owns the complete idempotent state transition. `passEnd` and `onRootCommitted` both call it. Delete the shim’s partial mutation and `reconciled` bookkeeping. This removes one duplicate already-committed arm and the final `reconciled` branch; existence/liveness validation moves to the single owner.

**Cost:** No intended behavior change. Add coverage for a root report containing a live token that `passEnd` did not lock in, especially one with an existing slot. Commit-path performance is effectively irrelevant.

---

### 2. Mount “fast path” is really a second correction policy — QUESTION

**What:** [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:5192) carries `baseline`, `maskTokenRecords`, four quiet predicates, a normal mount-fix world, and a second audit world. The oracle mirrors it in [model.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/model.ts:1303). The documentation says the fast path skips comparison in [FLAGS.md](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/tests/FLAGS.md:55), but the engine always evaluates `vFx` before checking `fastOut` at [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:5224). It therefore skips neither the fold nor the comparison; it changes whether divergence is corrected urgently.

**Why complex:** The representation does not say directly which divergence is durable and which is already covered by a batch-lane corrective. Instead that distinction is inferred through global `cas`, per-root `commitGen`, pass identity, two kinds of clocks, and a second world used only to audit the inference.

**Simpler general form:** Represent the rule directly:

1. Schedule batch-lane correctives.
2. Partition corrected live tokens into those rendered by this committing pass and foreign/already-committed tokens.
3. Compare once against render-at-pin plus committed-now, excluding only foreign live divergence already covered by its corrective.
4. Correct urgently if that durable target differs.

That could delete `cas`, `commitGen`, `WatcherSnapshot.passId`, `maskSlots`, `rootCommitGen`, the baseline parameter, the `maskTokenRecords` array, and the audit-only world. Gross branch removal is the four fast-out predicates plus three nested fast-out/audit conditionals in each implementation—14 mirrored decisions—replaced by one token-membership classification and one final comparison.

**Cost:** This is semantically delicate. It must preserve flag-5 seeds 29 and 173, battery case 9(d′), first-write-after-pin, already-committed async-action late writes, reveal mounts, and retire-at-commit. The owner should confirm the intended general rule: “newly locking post-pin writes correct urgently; late writes from foreign/already-committed live batches may wait for their scheduled lane.”

---

### 3. One write crosses three representations — TRADE

**What:** Public methods produce `(HostOpKind, payload)` in [index.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:1518), the bridge allocates an `Op` through `opOf` in [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:707), the React shim passes that object in [shim.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:536), and the engine converts it back to packed `kind/payload` columns in [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:4043). It consequently has both `applyOp` and `applyOpPacked`.

**Why complex:** Every write operation has two discriminated shapes plus the final storage shape. Recorded writes incur an object allocation exactly where the packed tape is intended to avoid one.

**Simpler general form:** Keep `(kind, payload)` canonical through the host hook, classifier, `bareWrite`, `scopeWrite`, and `write`. Store it directly in `Tape`; materialize an `Op` only for diagnostics or compatibility APIs. This deletes `opOf`, the `Op` allocation, two repacking sites, and one of the two apply implementations.

**Cost:** `Op` and several bridge methods are exported as power-user types, so this is an internal API change unless compatibility wrappers remain. Oracle schedules and React action scopes need mechanical updates. Behavior is unchanged; recorded-write allocation and time should improve.

---

### 4. Tracing duplicates the event protocol and perturbs what it observes — SAFE-SIMPLIFICATION

**What:** The tracer claims zero per-event allocation and no perturbation in [trace.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/trace.ts:1). Attaching it sets `eventsOn` and recomputes quiet mode in [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:1398); quiet mode explicitly requires `!eventsOn` in [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:1604). Trace attachment therefore changes quiet writes into token/receipt writes. It also causes object literals to be allocated for `BridgeEvent`, after which the tracer repacks them through an 18-label switch in [trace.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/trace.ts:455). Receipt tracing additionally materializes a `Receipt` object.

**Why complex:** There are two diagnostic protocols—object events and packed trace events—with a conversion layer between them. Observation changes engine mode and invalidates the stated performance rationale.

**Simpler general form:** Make one scalar event vocabulary canonical. The tracer consumes scalars directly into packed records; referee retention materializes `BridgeEvent` objects only when explicitly requested. Give quiet writes their own trace record instead of disabling quiet mode. This deletes the 14 conversion arms plus four ignored labels in `Tracer.event`, removes trace-time event-object construction, and removes `eventsOn` from the semantic quiet predicate.

**Cost:** Trace format tests and causal-event mapping need updates, including a quiet-write record. Referee event logs remain available. Production behavior becomes more stable and tracing gets closer to its documented allocation claim.

---

### 5. Referee policy lives inside the production engine — SAFE-SIMPLIFICATION

**What:** `__newBridgeForTest` enables retained events and disables quiet semantics in [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:784). Runtime state consequently includes `quietWrites`/`setQuietWrites` in [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:1580), hot probe increments such as [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:268), and an `arenaCheckOn` branch in every operation epilogue at [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:3268).

**Why complex:** The main lockstep suite does not exercise production-default quiet semantics; it tests a second engine mode. Test controls also add writes and branches to production execution.

**Simpler general form:**

- Model quiet folding in the oracle; explicitly open batches in schedules intended to exercise receipt machinery.
- Remove `quietWrites` and its setter.
- Have the schedule driver call `__checkArenas()` after each operation instead of arming an engine flag.
- Replace hot activity probes with test-visible seam-state assertions or a testing-only entrypoint.

This deletes two production flag branches and five probe increments, while making the referee test the real semantics.

**Cost:** Significant harness updates. Randomized schedules may cover fewer receipt cases unless generation deliberately opens batches first. Arena checking remains equally strong if the driver calls it after every applied step.

---

### 6. Slot membership is stored twice — SAFE-SIMPLIFICATION

**What:** A pass stores `maskSlots` and `capturedCommittedSlots` as sets alongside `maskBits` and `includedBits` in [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:437). Watcher snapshots return to sets in [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:477). `includedSet` reconstructs a new set with two spreads at [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:2202).

**Why complex:** Slots are constrained to 31 specifically so one integer is the canonical set, yet the engine repeatedly allocates and synchronizes object sets for the same membership.

**Simpler general form:** Use `SlotSet` everywhere in production: `Pass.maskBits`, `Pass.includedBits`, and `WatcherSnapshot.includedBits`. At pass start, `includedBits = maskBits | root.committedBits`. Mount-fix worlds should also carry bits. Delete both pass slot sets, `includedSet`, and the per-mount/per-rerender set copies.

**Cost:** No behavior change. Tests and trace/debug views that want sets can materialize them off-path. This reduces allocation at pass start and watcher render.

---

### 7. Atom and computed host reads duplicate one routing state machine — TRADE

**What:** The kernel has separate `hostRead` and `hostComputedRead` hooks and setters in [index.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:1528), with almost identical getter plumbing at [index.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:2297) and [index.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:2419). The bridge repeats world/capture/provider resolution in [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:1747) and [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:1795).

**Why complex:** Atom and computed are one `Signal` concept at this boundary. Their genuine difference is only newest serving and adoption policy, but five routing decisions are duplicated around that difference.

**Simpler general form:** One hook receives a small signal-kind code and handle, resolves world/capture once, then dispatches atom versus computed serving. Delete one hook, one setter, duplicate arming, and roughly five duplicated decision points; add one kind branch only after routing is active.

**Cost:** Routed reads are hot during React rendering, so benchmark the added kind branch against the removed second function path. Unregistered applications still pay exactly one undefined-hook check.

---

### 8. The oracle’s semantic cache is an out-of-band second representation — SAFE-SIMPLIFICATION

**What:** `ComputedNode` contains only `fn` in [model.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/model.ts:76), while newest-world state lives in a separate `newestSamples` map and `samplingStack` set in [model.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/model.ts:301). This contradicts the README’s “no caches, always replay” claim in [README.md](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/README.md:269).

**Why complex:** A computed’s semantic state is split between the node and two global registries. The model’s rationale overstates its independence: sampled-untracked newest behavior is explicitly memoized and mirrors kernel-style recursive validation.

**Simpler general form:** Put optional `{ deps, value, evaluating }` newest state directly on `ComputedNode`. Delete the map and cycle set; `sampledNewest` reads and updates the node it already has. Update the README to call this a semantic cache required by the `untracked` contract, while retaining cache-free replay for pass/committed worlds.

**Cost:** No intended behavior change. Re-run untracked sampling, cycle, equality-cutoff, and core-effect tests.

---

### 9. A dev-only warning performs production hot-path allocation — TRADE

**What:** Every qualifying urgent write evaluates `bridge.liveTokens().some(...)` in [shim.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:568). `liveTokens()` allocates an array with spread/filter in [concurrent.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/concurrent.ts:3765). The warning is described as development-only, but no development guard exists; `devWarnings`, a dedup set, and console output are retained in every build at [shim.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:135).

**Why complex:** An approximate lint that admits false positives contributes five predicate decisions, a full live-token scan, and an allocation to normal writes.

**Simpler general forms:**

- Smallest: delete the heuristic and its retained warning state.
- If the warning is important: maintain a scalar `parkedActionCount` and guard the check behind an actual development build condition.

**Cost:** The first option loses only developer guidance. The second preserves it but adds lifecycle bookkeeping and build-mode policy. No signal semantics change.

---

### 10. React maintains an “unreachable” ambient mode — QUESTION

**What:** `classifyWrite` says token zero is unreachable after renderer registration but implements ambient batching anyway in [shim.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:536). That requires `maybeRetireAmbient` and calls from multiple protocol events at [shim.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:440). `startSignalTransition` separately threads an optional token and repeats two “no context” guards in [hooks.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/hooks.ts:359). Pass-start also repairs a protocol state the comment says cannot occur at [shim.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:330).

**Why complex:** The adapter has both a fail-fast protocol requirement and fallback semantics for protocol absence/desynchronization.

**Simpler general form:** If protocol v1 guarantees a provider after the required setup order, treat zero-token or overlapping-pass input as a protocol error. Keep ambient batches only in the host-agnostic engine. This deletes nine adapter conditionals: three optional-transition-token decisions, the classify fallback, four ambient-retirement guards, and stale-pass repair.

**Cost:** Calls made before `react-dom/client` registration would throw instead of limping into ambient mode. The owner needs to decide whether that setup mistake is supported; the README currently favors fail-fast behavior.

---

### 11. Two local copies can disappear immediately — SAFE-SIMPLIFICATION

**What:** `RootRec.container`, `lineageId`, `lastCommitGeneration`, and the entire `rootsById` map are written but never read in [shim.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:108). Separately, the observed-lifecycle `AtomCtx.set/update` implementations copy the public atom methods in [index.ts](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:2243).

**Why complex:** Dead adapter state suggests protocol concepts that do not affect behavior. The copied atom methods duplicate host interception, fold purity, equality, and write plumbing.

**Simpler general form:** Remove the four unused root artifacts. Implement lifecycle context methods as `self.set(value)` and `self.update(fn)`. That deletes two duplicate host-write branches and one copied fold/write path.

**Cost:** No behavior change expected. Check whether unused root fields were intended as future diagnostics before deleting them.

## Already minimal

- `Tape`’s parallel packed columns and amortized prefix dropping are an appropriate canonical runtime representation; the simplification belongs before writes reach it, not inside it.
- The base kernel’s split hot/slow read and graph-walk functions are genuinely performance-sensitive. Generalizing kernel and shadow-arena walks through a shared polymorphic helper would add storage indirection and obscure their real differences: weak links, world-local values, pooling, and suspension state.
- Strong versus weak shadow links are separate semantics, not merely duplicated names: deliveries traverse strong links, while invalidation and durable drains require both.
- One open pass per root, one integer dedup word per watcher, and the direct listener callbacks are small, direct mechanisms.
- `graphviz.ts` is already appropriately tiny and isolated. The trace recorder’s packed storage is also compact; the problem is the object-event conversion before it.
- Oracle invariant checks are straightforward and appropriately separate. Their allocation-heavy style is acceptable because they are exhaustive referee work, not runtime hot paths.

## Verification

No code was changed.

- `cosignal`: 24 test files passed; 314 passed, 1 skipped.
- `cosignal-react`: 5 test files passed; 62 passed.
- `cosignal-oracle`: 4 test files passed; 81 passed, 1 skipped.
- All three package typechecks passed.
- Both `cosignal` and `cosignal-concurrent` conformance runs passed 179/179.

