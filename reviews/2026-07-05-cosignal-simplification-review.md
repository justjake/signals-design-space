# cosignal / cosignal-react / cosignal-oracle — simplification review

Date: 2026-07-05. Reviewer: external senior engineer, first contact with the code.
Scope: `packages/cosignal`, `packages/cosignal-react`, `packages/cosignal-oracle` — source and
shipped docs only. Verification performed before review: all three package suites pass
(cosignal 163 passed/1 skipped; oracle 74/1 skipped; react 45), `tsc --noEmit` clean, and both
conformance runs pass 179/179 (`FRAMEWORK=cosignal`, `FRAMEWORK=cosignal-logged`).
Grounding benchmarks run: `bench/spkw-direct.mjs` (~3.7 ns/write) and `bench/spkw-logged.mjs`
(~89 ns/write bare, ~133 ns/write with one watcher; ~1–2 `BridgeEvent` objects allocated per write).

Line inventory (source only): cosignal `src/index.ts` 2019, `src/logged.ts` 3087, `src/trace.ts` 873,
`src/graphviz.ts` 86; cosignal-react `src/shim.ts` 1003, `src/hooks.ts` 372, `src/index.ts` 27;
cosignal-oracle `src/model.ts` 1400, `src/schedule.ts` 306, `src/invariants.ts` 201, `src/adapter.ts` 140.
≈9.5K lines of source, ≈5K of tests.

---

## Shape of the whole

The 80% story is three parts: (1) a plain signals core; (2) a concurrent bridge that records every
write as a receipt in a batch, computes "worlds" as visibility-filtered replays, and is driven by
pass/commit/retire events from a patched React; (3) a naive executable model that referees the
bridge under 300+ fuzz seeds, 30 pinned regression schedules, and a lockstep twin driver. Parts
(2) and (3) are the project's soul, and part (3) is genuinely excellent — the oracle is exactly as
simple as it claims, and its existence makes aggressive simplification of the engine unusually
*safe*: almost any refactor of `logged.ts` is refereed step-by-step by machinery that already exists.

The structural finding that frames everything else: **this codebase is twins all the way down, and
each twin pair needs glue that is itself complexity.** The base kernel and the logged bridge are two
complete signals engines — the bridge has its own dependency graph (K1 `outList`/`inList`), its own
memo system (`WorldMemo` ladders), its own cycle detection (`evalMark`), its own effect queues. In
the flagship React deployment, the celebrated packed-Int32Array kernel is nearly inert: it stores
each atom's newest value and runs base-entry `effect()`s, while every render-relevant read goes
through the bridge's ordinary allocating JS (`Map` memo planes, a fresh `WorldMemo` object with
four arrays per computed evaluation). The perf-exotica story (closure rebuilds, const-enum
discipline, hot/slow splits) and the concurrency-correctness story are close to disjoint systems
sharing an atom cell. Beyond that first twin pair: two write-interception layers (the kernel
operation-table seam in `logged.ts` and prototype patching in `shim.ts`), two suspense caches
(`ctx.use` slot/box machinery in `index.ts`; capsules in `shim.ts`), three computed representations
(`Computed`, `ComputedNode`, `BoundComputed`), and dual object/packed forms of `visible`/`applyOp`
inside the engine. Each pair is individually argued for in comments; the *aggregate* is the real
reader burden — a maintainer touching a write must know which of four interception points fires.

Whole mechanisms whose existence (not implementation) I would challenge: the mount-fixup
"fast path" (it is not a fast path — see #1), mid-episode dirt reclamation (#2), the kernel-table
routing half of the interception story (#4), the base build's suspense system (#6), and the trace
SESSION mode (#8). The four-world visibility rule, the receipt/tape/slot lifecycle, and the
retirement ordering are the irreducible core; they are well-factored and well-told — leave them.

---

## Ranked simplification opportunities

### 1. Mount fixup: replace the four-conjunct "fast path" + soundness audit with the covered-check as the rule

**What.** The mount-reconciliation fast path and its audit, implemented twice:
engine `logged.ts:2834-2899` (`clocksQuiet` 2857-2859, `fastOut` 2860-2864, audit 2869-2890),
model `model.ts:1171-1253` (conjuncts 1204-1214, audit 1236-1245). Supporting state threaded
through the system solely for it: `Token.lastWriteSeq` (`logged.ts:383`), the model's
`Token.writeSeqs` (`model.ts:104`), the `baseline {cas, rootCommitGen}` capture in both `passEnd`s
(`logged.ts:2386`, `model.ts:957`), `WatcherSnapshot.rootCommitGen` (`logged.ts:478`,
`model.ts:165`), the commit-time `maskTokenRecords` clock loop (`logged.ts:2362-2365, 2857-2859`),
plus 40% of `tests/FLAGS.md` (flag 5, three findings) and its targeted tests.

**Why it's complex.** This is the single highest concept-density spot in the contract. FLAGS.md
itself documents that the rule was wrong twice (fuzz seeds 29 and 173) before reaching its current
form, and that the fast path is "only sound together with the corrective loop" — a non-local
soundness argument a maintainer must reconstruct to touch any of the five pieces of state above.
And here is the kicker: **it is not a fast path.** Both implementations compute the expensive part —
`vFx`, the full mount-fix world evaluation — *unconditionally, before* consulting `fastOut`
(`logged.ts:2865-2867`, `model.ts:1215-1217`). The four conjuncts never skip work; their only
observable effect is to *suppress the urgent pre-paint correction* when the divergence is believed
to be covered by already-scheduled corrective re-renders. The audit then proves that belief by
evaluating a second world (`vCovered`) and throwing if it fails. So the machinery is: an
approximate predicate (4 conjuncts over 5 pieces of bookkeeping), plus an exact check (`vCovered`)
used only to police the approximation.

**The simpler alternative.** Make the exact check the rule. Delete the conjuncts and the audit;
on divergence, ask directly whether the scheduled correctives cover it:

```ts
private mountFixup(w: Watcher, correctedLive: Set<TokenId>): void {
  // ... per-token corrective loop unchanged ...
  const vFx = this.evaluate(node, { kind: 'mountFix', maskSlots: w.snapshot.maskSlots,
    pin: w.snapshot.pin, root: w.root });
  if (Object.is(vFx, w.lastRenderedValue)) return;                       // clean
  const vCovered = this.evaluate(node, { kind: 'mountFix', maskSlots: w.snapshot.includedSlots,
    pin: w.snapshot.pin, root: w.root, excludeLiveTokens: correctedLive });
  if (Object.is(vCovered, w.lastRenderedValue)) return;                  // covered: let the
                                                                         // correctives land in
                                                                         // their own lanes
  this.log({ type: 'mount-urgent-correction', watcher: w.name, from: w.lastRenderedValue, to: vFx });
  w.lastRenderedValue = vFx;
  w.dedupBits = 0;
}
```

Deleted outright (engine + model + docs): `clocksQuiet`, `fastOut`, the baseline capture and its
threading through both `passEnd`s, `Token.lastWriteSeq`, `Token.writeSeqs`,
`WatcherSnapshot.rootCommitGen`, the commit-time mask-token clock check, the
`BridgeInvariantViolation` audit branch, the `'fast-out' | 'fast-out-covered'` trace dispositions
(`trace.ts:235`, `logged.ts:619-624`), and FLAGS.md findings 2 and 3 (they become vacuous — there
is no captured-slot-set quantifier left to get wrong, and coveredness is checked, not assumed).
Roughly 60–100 lines of code across the two implementations, and the hardest two pages of the
contract's documentation. `maskTokenRecords` stays only for lock-in (`logged.ts:2404`), where it is
locally obvious.

The new rule is also *more consistent*: today, when the conjuncts fail spuriously (e.g. an
unrelated atom's retirement advanced `cas`) but the divergence on this node is fully
corrective-covered, an urgent correction fires anyway — briefly revealing committed state that the
design otherwise says should arrive with its batch. Under the covered-check rule the component
joins the batch in both cases, which is the behavior FLAGS.md flag 5 already argues is correct.

**What it costs.** One extra world evaluation per *differing* mount (`vCovered` — the audit already
performs this evaluation on the fast-out-covered path today; mounts are rare and mount-fix worlds
are one-shot/memo-free, so the cost is noise). Behavior change: strictly fewer
`mount-urgent-correction` events (suppressed exactly when covered). This is a contract change, so
model and engine co-change, and tests that pin dispositions or urgent-correction counts need
re-pinning: `cosignal-oracle/tests/battery.spec.ts` case 9 variants, `tests/flags.spec.ts` flag-5
tests, some of `tests/scars.spec.ts`; their engine twins `cosignal/tests/logged-battery.spec.ts`,
`logged-flags.spec.ts`, `logged-scars.spec.ts`; trace tests naming dispositions
(`cosignal/tests/trace.spec.ts`). One genuine loss: the audit currently doubles as an in-engine
fuzz oracle (it throws on unsoundness); as the rule, it can no longer fail. The external
model-diff harness still referees every outcome, which is the stronger check anyway.

**Verdict: TRADE** — simpler and arguably better behavior, but it rewrites a pinned corner of the
contract in two packages plus FLAGS.md.

### 2. Mid-episode dirt reclamation: slot touched-lists, carried watermarks, and the keep-the-dirt discipline

**What.** The constellation in `logged.ts` that lets conservative per-slot "touched" state be
*cleared before quiescence*: per-slot touched lists (`slotTouched`, `logged.ts:834`; appended in
`applyBits` 1704-1712), the `carriedMaxRetiredSeq` watermark carried across slot tenants
(`logged.ts:421-425`, maintained at 1921), the pin-gated clear at slot re-intern
(`logged.ts:1893-1898`), the keep-the-dirt discipline documented at `logged.ts:829-833` and
referenced at three sites, the `keepMask` interplay inside `sweepK1` (`logged.ts:1618-1633`), and
the drain candidate collection that enumerates flipped slots' touched lists
(`logged.ts:2707-2758`). Sibling precise-dirt trackers ride along: `committedDirtySlots` per root
(`logged.ts:460-466`, fed at 2032-2040) and the `restaled` map (`logged.ts:2686-2705`).

**Why it's complex.** This is the largest block of engine-only invention — none of it exists in the
model, which recomputes reachability from scratch. A maintainer must hold: bits are monotone
within an episode *except* the per-slot clear, which is legal only when `minLivePin() ≥
carriedMaxRetiredSeq`; lists must outlive their writes ("never only a consumable write-time
queue"); `sweepK1` may drop edges but must keep anything with live-slot bits or taint; and drains
must union three sources (touched lists, committedDirtySlots, restaled). Four interlocking
disciplines to answer one question: *which observers might a committed-truth flip have reached?*

**The simpler alternative.** Answer the question at drain time by walking the graph you already
have. A retiring/committing token knows the atoms it wrote (`Token.atomsTouched`,
`logged.ts:386`). At drain time, cone-walk from those atoms over `outList` + `weakOutList` (the
walk body already exists twice: `deliveryWalk` 1745-1787 and the drain's own expansion 2731-2758)
and collect watchers/effects from the cone. For member-slot drift, store the dirty *tokens* per
root instead of slot bits and walk their `atomsTouched` too. Then delete: `slotTouched` and its
appends, the pin-gated clear, `carriedMaxRetiredSeq`, the keep-the-dirt paragraphs, and the
touched-bit half of `sweepK1`'s keep condition. The soundness argument is short: within an
episode K1 is add-only except `sweepK1`, and `sweepK1` preserves every edge on any path to an
observer-holding node — so a drain-time cone from the written atoms reaches every observer any
historical path reached; drains are value-gated, so over-collection is harmless (the same argument
the code already uses for the model's full scan, `logged.ts:2678-2684`).

The per-node touched *words* can then shrink to what the evaluate() fast path actually reads — a
single "some pending write can reach me" condition plus taint (`evaluate` checks only
`word === 0`, `logged.ts:1416-1423`; it never uses per-slot precision). If per-slot bits are kept
only for `deliver()`'s dedup and the fast path, they no longer need lists or watermarks — just
"set until epoch reset."

**What it costs.** Perf inside long non-quiescent episodes: today a slot's bits clear when it is
recycled and no live pin needs them, re-enabling the `touched === 0` fast path mid-episode; under
the simplification a node once touched stays off the fast path until quiescence (memo-ladder
validation still serves it — a fingerprint check, not a refold). Real apps hit quiescence at every
completed interaction, so the window is bounded; a soak/bench run (`bench/spkl-logged.mjs`,
`spkg8-logged.mjs`) should confirm. Behaviorally this should be invisible — drains are value-gated
and the twin/fuzz suites compare outcomes, not internals; the deliverable risk is missed drain
candidates, which is exactly what 300 fuzz seeds × lockstep diffing exists to catch.

**Verdict: TRADE** (perf-motivated machinery exchanged for bounded extra memo validation), with a
**QUESTION** attached: was mid-episode dirt reclamation motivated by a measured workload, or by
symmetry with the kernel's no-growth discipline? The docs assert the discipline but never cite a
workload where episode-long dirt accumulation hurt.

### 3. Delete the dead code and the documentation for mechanisms that don't exist

**What / why complex.** Confirmed dead in `logged.ts` (misleading, not just idle — several carry
detailed doc comments describing behavior the engine does not have):

- `kernelEvalNode` / `kernelEvalTaint` (`logged.ts:852-854`) — declared, never referenced.
- Read-routing "mode 2" (`logged.ts:644-650`) — the docstring describes a three-mode routing word
  ("2 = a bridge kernel evaluation is on stack … records the kernel-acquired dep into K1");
  `routeReads` is only ever assigned 0 or 1 (`logged.ts:912, 961`). The mirror-for-raw-handle-reads
  mechanism it describes does not exist.
- `Pass.pendingEdgeDeliveries` (`logged.ts:449`, initialized at 2176) — never written, never read;
  a remnant of the deliberately-unimplemented edge-add delivery replay (`logged.ts:1562-1569`).
- `renderSlicePass` (`logged.ts:1573`, saved/set/restored at 1445-1446, 1489) — maintained on every
  evaluation ("edge-add queueing context") and never read anywhere.
- `CosignalBridge.reachableFrom` (`logged.ts:1790-1805`) — public, uncalled in src and tests (the
  model's namesake *is* used; the engine's is a copy that nothing drives).
- The `stack?: Set<NodeId>` parameter threaded through `evaluate` → `validateMemo` →
  `validateMemoInner` (`logged.ts:1410, 1276, 1290, 1311`) — always `undefined` at runtime; the
  comment at 1434-1435 admits the mark column is authoritative and the parameter is "surface
  compat" (nothing needs that compat: `snapshotModel`'s cast never passes it).
- `mountFix.maskBits` (`logged.ts:535`) and its branch in `visibleAt` (`logged.ts:1155-1157`) —
  no mountFix world is ever constructed with `maskBits` set (both sites, 2866 and 2877, omit it).

**The simpler alternative.** Delete all of it (~50 lines plus ~25 lines of comments), and rewrite
the `routeReads` doc to describe the two modes that exist.

**What it costs.** Nothing observable. No test references any of these (verified by grep; the
suites pass today without exercising them). Typecheck must stay clean after removing the
`stack` parameter (callers all pass ≤2 args).

**Verdict: SAFE-SIMPLIFICATION.**

### 4. Two write/read interception layers in the React path — pick one

**What.** A public `atom.set()` in a cosignal-react app is intercepted twice, by two independent
mechanisms in two packages:

1. The **operation-table seam**: `index.ts`'s header section "THE OPERATION-TABLE SEAM"
   (`index.ts:97-124`), `__installTwinTable` (`index.ts:1280-1288`), and the logged wrapper —
   `makeLoggedFactory` (`logged.ts:700-740`) with its `regBits` bitmap (`logged.ts:654-679`),
   `routeReads`/`routeWrites` module words, `byKernelId` map, and `armTableOnce`.
2. **Prototype patching**: `installPrototypeRouting` (`shim.ts:209-234`), the `TWIN` and `BOUND`
   symbols (`shim.ts:174-181`), captured originals (`shim.ts:183-186`), and `readState`/`routeRead`
   (`shim.ts:742-774`).

Because both exist, the bridge's own kernel applies need double disarming — `applyToKernel` saves
and clears `bridgeApplying` *and* `routeWrites` (`logged.ts:2073-2084`) while the shim reaches the
kernel through `TWIN`-marked twin handles built with `Object.create(Atom.prototype)`
(`shim.ts:722-727`) so the prototype patch skips them.

**Why it's complex.** A maintainer tracing one write must know four possible entry paths (original
method, prototype patch → `classifyWrite`, table wrapper → `bareWrite`, bridge `write`) and the
precedence between them. The seam also motivates the most exotic machinery in `index.ts`: the
engine-factory binding, the closure-rebuild-at-boundary story, and the shared-mutable-state layout
exist partly for growth (legitimate) and partly so the logged build can splice routing into kernel
ops. Yet in the React deployment the table's read routing is redundant: adopted atoms' reads hit
the prototype getter first and route through the shim frame; the table hook fires only for
raw-handle reads of bridge-registered atoms inside overlay evaluations — which, with the shim
active, means twin handles that deliberately bypass it anyway (`kernelValueOf` even has to
world-suppress around it, `logged.ts:1203-1211`).

**The simpler alternative.** Move the prototype routing into `cosignal/logged` itself (the logged
entry is already the "I opted into concurrency" module; the base entry keeps its isolation) and
delete the table's routing duties: `regBits`, `setRegistered`, `routeReads`/`routeWrites`,
`makeLoggedFactory`'s read/write wrappers, and the `byKernelId` probe on the write path. The
`__installTwinTable` seam then shrinks to (or disappears into) plain growth — `engineFactory` never
needs re-pointing, and index.ts's seam header (≈30 lines of its 174-line preamble) goes with it.
`shim.ts` loses the TWIN dance only if the bridge exposes an unrouted apply instead
(`node.handle` already is the bridge-private handle; a `rawSet` on the bridge would do).

**What it costs.** The armed-but-quiet perf claim changes shape: today an armed bridge costs "one
module-int check" on kernel reads (`logged.ts:688-692`); prototype routing costs a symbol probe +
`getActiveShim()` per public op for all logged-entry users — the cost cosignal-react users already
pay today, but new for bridge-only users (which today means tests). The twin-build tests pinning
armed-table routing (`cosignal/tests/twin-build.spec.ts:106-141`) would be rewritten against the
prototype route; conformance for `cosignal-logged` must stay 179/179 (it should — routing only
engages for registered atoms). Needs one benchmark run (`spkl-logged` vs `spkl-direct`) to verify
the quiet-cost claim survives.

**Verdict: QUESTION** — the duplication is real and expensive to hold in the head, but the choice
between the layers is a measured-performance decision only the owner can confirm. If the table
layer must stay for perf, the shim's prototype layer cannot be removed (it needs render context),
so the question is precisely: *does any supported production path still require the table's
routing?* If no: delete it.

### 5. The bridge event log is three things — split the shim transport out of it

**What.** `CosignalBridge.events` is simultaneously (a) the production transport by which the shim
learns about deliveries/corrections (`withBridge` drains `eventsSince(mark)` after every call,
`shim.ts:526-533`), (b) the oracle-comparison surface (twin `compareStreams`,
`helpers.ts:153-172`; adapter `drainEvents`), and (c) a diagnostics feed (`trace.ts` re-uses it via
`tr.event(e)` at the `log()` waist, `logged.ts:915-925`). Serving (a) forced the ring machinery —
`setEventCapacity`, `eventsBase`, `eventCursor`, amortized `splice` (`logged.ts:858-861, 915-947,
3076-3078`) — and means production writes allocate `BridgeEvent` objects on the hot path
(`logged.ts:2045`, plus delivery/suppression events): measured ~1–2 objects per write
(`spkw-logged` `eventsPerWrite`), on a path whose Tape exists to avoid one allocation per write.

**Why it's complex.** Cursor arithmetic that stays valid across ring drops, a capacity the shim
must remember to set, and a "no allocation on hot paths" story (`README:156-158`, `Tape` doc
`logged.ts:229-234`) that the very next statement in the write path quietly contradicts. The
maintainer must also know which of the 19 event types are load-bearing for React (five: `delivery`,
`mount-corrective`, `mount-urgent-correction`, `reconcile-correction`, `dev-warning` —
`shim.ts:535-560`) versus test-only.

**The simpler alternative.** Give the bridge a direct listener for exactly those five
notifications (scalar args, no object allocation), make the shim subscribe, and gate the event
*log* behind a flag the tests/tools set (like `retainArchive` already is, `logged.ts:855-857`):

```ts
// bridge
onDispatch: ((kind: DispatchKind, watcherId: WatcherId, token: TokenId, slot: SlotId) => void) | undefined;
recordEvents = false; // twin/oracle/trace drivers set it
```

Then delete `setEventCapacity`, `eventsBase`, `eventCursor`, `eventsSince`'s offset math, and the
shim's mark/drain protocol (`withBridge` becomes a plain call); `watcherByName`'s string-parsing
round trip (`shim.ts:562-565`) dies too because the listener gets the id. Production writes stop
allocating event objects entirely; the trace hook already bypasses the array.

**What it costs.** `bridge.events` is empty in production unless enabled — observable only to code
that pokes the bridge directly (no documented consumer besides shim/tests/trace). Twin and oracle
suites set the flag in their drivers (2 lines). The shim tests (`cosignal-react/tests/*`) keep
passing — they assert React-visible behavior. Risk is low; the churn is in `shim.ts`'s
`withBridge` plumbing and every `this.log(...)` site gaining a cheap guard (or `log` checking the
flag once).

**Verdict: TRADE** (a small observable change to an undocumented surface) — with the note that it
converts the README's no-allocation claim from aspiration to fact on the logged write path.

### 6. Two suspense systems: the base build's ctx.use machinery vs the shim's capsules

**What.** `index.ts` ships a complete async-read system for computeds: `SuspendedRead` +
`SentinelBox` + `NO_BOX` mirror (`index.ts:176-241`), `ctxUse` slot protocol (`index.ts:1551-1604`),
`suspenseEvalFn` prologue swap (`index.ts:1612-1630`), `boxThrown`/`attachSettle`/`boxedRead`
(`index.ts:1638-1722`), and four per-instance fields on every `Computed`
(`_slots`, `_slotIndex`, `_settleReplay`, `_box`, `index.ts:1861-1867`). `cosignal-react` ships a
*second, independent* one: capsules keyed by (fn source, deps, use-position, read-value prefix)
(`shim.ts:147-160, 262-273, 832-890`). The React path uses only the second: `useComputed` mints
bridge `ComputedNode`s whose `ctx.use` is `shim.ctxUse`, and `useSignal` *rejects* base `Computed`
instances outright (`hooks.ts:87-97`).

**Why it's complex.** Two implementations of "read a thenable inside a computed" with different
identity semantics (slot position vs. source+deps+value-prefix), different staleness rules
(replay-vs-fresh-attempt hygiene in `suspenseEvalFn` vs. prefix mismatch refetch), and different
settlement plumbing (`attachSettle` invalidation vs. capsule state flips). The shim's doc
(`shim.ts:262-273`) explains convincingly why the React side *cannot* reuse node-keyed slots
(Suspense retries recreate the node). That justifies the capsules; it does not justify the base
system's continued existence — the base system's only consumers are non-React users of
`cosignal`/`cosignal/logged`, an audience the docs never name.

**The simpler alternative.** Decide who the base `ctx.use` is for. If the answer is "nobody yet":
delete it from `index.ts` — keep `SuspendedRead` (the react layer's carrier and error-boxing stay)
and `BOX_ERROR` boxing, drop `BOX_SUSPENDED`, `ctxUse`, `suspenseEvalFn`, `attachSettle`, the
suspended branch of `boxedRead`, and three of the four `Computed` fields (~220 lines plus
`tests/suspense.spec.ts`, 232 lines). `ComputedCtx` shrinks to `{previous}`. If the answer is
"library users without React": keep it, but say so in the README, because today the flagship
integration throws on the class that carries it.

**What it costs.** Public API removal (`ctx.use` on base/logged `Computed`) — a breaking change
for any non-React consumer; `tests/suspense.spec.ts` deleted, `trace-off`/`twin-build` grep tests
unaffected. Zero effect on the react package (verified: it never calls base `ctx.use`; capsules
are self-contained).

**Verdict: QUESTION** — is async-in-computeds a supported base-build feature, or scaffolding that
predates the capsule design? The code cannot answer; the owner can.

### 7. cosignal-react re-exports an API surface its own hooks reject

**What.** `cosignal-react/src/index.ts:26` re-exports the whole logged surface
(`export * from 'cosignal/logged'`), which itself re-exports the whole base surface
(`logged.ts:3087`). Apps therefore import `Computed`, `effect`, `effectScope`, `configure`,
`CosignalBridge`, `Tape`, `AtomNode`, `Watcher`, `BridgeEvent`, `TraceHooks`, … from
`cosignal-react` — including `Computed`, which `useSignal` rejects with a runtime error
(`hooks.ts:93-97`), and the entire bridge-internal type vocabulary, which the cosignal README says
applications normally never touch (`README:160-164`).

**Why it's complex.** Public surface is a promise. Every exported name is something a maintainer
must keep compatible and a user can misuse; the `Computed`-that-throws-in-useSignal trap is the
concrete cost, and the exported engine types (`Tape`, `SlotMeta`, `WorldMemo` adjacents) freeze
internals the engine should be free to repack.

**The simpler alternative.** Curate the re-export: `Atom`, `ReducerAtom`, `batch`, `untracked`,
`SuspendedRead`, maybe `effect`/`effectScope`, plus the hooks and `registerCosignalReact`. Keep
`cosignal/logged` as the power-user path for bridge internals. In `cosignal/logged`, consider
marking the bridge-surface types `@internal` or segregating them under a `/bridge` entry so the
app-facing surface is the base API + `registerReactBridge` only.

**What it costs.** Compile errors for users importing engine types from `cosignal-react` (none in
this repo's tests beyond what the tests import directly from `cosignal/logged` already). No
behavior change.

**Verdict: SAFE-SIMPLIFICATION** for the curation (mechanical, type-level);
**QUESTION** for how much of the bridge vocabulary is intentionally public for engine-adapter
authors (the oracle README implies adapters are written against `cosignal-oracle`, not against
these exports — which argues for shrinking).

### 8. Trace SESSION mode

**What.** `trace.ts` implements two capture modes through one emit path: RING (flight recorder)
and SESSION (lossless chunked capture with a byte budget, truncation markers, sealed-chunk
retention, and a losslessness proof). SESSION-specific machinery: chunk allocation and
budget-degrade in `bufFor` (`trace.ts:375-390`), the truncation-marker re-emit in `recRaw`
(`trace.ts:405-422`), the mode branches in `firstRetained`/`isRetained`/`peek`
(`trace.ts:589-609`), `verifyComplete` (`trace.ts:799-803`), and the session arms of `stats`
(`trace.ts:805-822`) — roughly 90 lines plus a third of the module doc.

**Why it's complex.** Every retention query carries a three-way branch (ring / session /
session-truncated-tail), and the truncation path is subtle enough to need a recursive re-emit.
The RING mode alone satisfies the module's stated mission ("why did this re-render?" — a flight
recorder question); losslessness-with-proof is a second product. Nothing in the three packages
uses SESSION except its own tests (`cosignal/tests/trace.spec.ts`).

**The simpler alternative.** Ship RING only; delete SESSION and `verifyComplete`. Users who need a
bigger window pass a bigger `capacity` (the ring is already power-of-two sized and preallocated).
`stats()` loses `truncated`/`chunks`; `TracerOptions` loses `chunkSize`/`maxBytes`.

**What it costs.** A documented capability disappears; `trace.spec.ts`'s session/truncation tests
are deleted. If provable whole-boot capture is a real support workflow (e.g. attach-before-boot
then export), this is a product regression — but no in-repo consumer exercises it.

**Verdict: TRADE** — real surface reduction against a speculative diagnostic capability.

### 9. The observed-lifecycle option (`AtomOptions.effect`) reaches into the kernel

**What.** The only feature for which the kernel carries policy plumbing: `NodeField.LIFECYCLE`
(D1, `index.ts:325`), the first-subscriber branch in `linkInsert` (`index.ts:622-627`), the
signal branch of `unwatched` (`index.ts:874-878`), and the policy half — `lifecycleStates` map,
microtask flap-damping queue, `AtomCtx` (`index.ts:1376-1448, 1726-1732, 1780-1803`) — ~120 lines
total plus a kernel field on every node record.

**Why it's complex.** It is the one violation of the file's own kernel/policy split (documented as
D1, so the violation is at least honest). Nothing else in the three packages uses it: not the
bridge, not the shim, not the hooks (grep: only `policy.spec.ts` and the README). Its semantics
under the *logged* build are undocumented — observe/unobserve is driven by K0 subscriptions, but
React watchers subscribe in the bridge's K1/watcher tables, so an atom observed only by
`useSignal` never fires its lifecycle effect. That asymmetry is exactly the kind of surprise a
"remote subscription" feature cannot afford.

**The simpler alternative.** If the React story is the product: remove it (delete D1, both kernel
branches, and the lifecycle section) until an equivalent exists at the bridge level where watcher
subscriptions are visible. If the base library is independently a product: keep it, but document
the logged-build caveat.

**What it costs.** Public API removal; `policy.spec.ts` lifecycle tests deleted; kernel records
get their pad field back. No perf change (the branches are on cold paths).

**Verdict: QUESTION** — product-scope decision; the logged-build blind spot should be answered
either way.

### 10. `configure({ forbidWritesInComputeds })`

**What.** A strictness flag checked on every single write (`writeAtom`, `index.ts:1461-1463`)
via a dedicated engine op (`activeIsComputed`, D5, `index.ts:499`), with a documented enforcement
hole: writes wrapped in `untracked()` evade it (`index.ts:1459-1460`).

**Why it's complex.** A global mode that changes write legality is a semantic fork every reader
must consider ("is this app strict?"), it costs a branch on the hottest policy path, and the
pinhole means it cannot be relied on as an invariant anyway — it is a lint with runtime cost.

**The simpler alternative.** Delete the option and the D5 op; keep the always-on rules that carry
real weight (fold purity, cycle throw). Apps wanting the lint can wrap in dev tooling. Deletes
~25 lines and one config axis; `tests/policy.spec.ts`'s forbid tests go.

**What it costs.** A public option disappears. The default behavior (tolerate, settle by lazy
revalidation — conformance-pinned) is unchanged.

**Verdict: TRADE** (small; worth it unless a known consumer sets the flag).

### 11. Engine surface that exists only to satisfy the oracle cast

**What.** The bridge is deliberately "structurally snapshot-compatible" with the model so the twin
can run `checkInvariants(engine as unknown as CosignalModel)` and `snapshotModel(engine as …)`
(`cosignal/tests/helpers.ts:358-368`, `tests/oracle-adapter.ts:170-185`). That contract silently
pins production fields whose only reader is the checker: `SlotMeta.claimSeq` in the engine is
minted and reset but never read by engine logic (`logged.ts:421, 1900, 3010`);
`AtomNode.archiveStore` + `retainArchive` + `shadowFoldAtom` + the materialized `visible`/`applyOp`
object forms exist for the retention invariant (`logged.ts:322-324, 855-857, 1090-1102,
1055-1075, 1190-1199`); `Watcher.dedup` materializes a `Set` from bits for tests
(`logged.ts:502-508`); `AtomNode.tape` materializes receipts (`logged.ts:348-356`).

**Why it's complex.** A reader of `logged.ts` cannot tell load-bearing state from referee surface
without grepping tests; the "one-sided cast" compatibility contract is invisible at the definition
sites (only `helpers.ts` documents it).

**The simpler alternative.** Not deletion — the referee surface is the best thing about this
project — but *labeling and grouping*: move the test/diagnostic accessors (`tape`, `dedup`,
`archive`, `shadowFoldAtom`, `episodeEdges`, `livePins`, `eventsOfType`, `eventsSince`) into one
clearly-marked "referee surface" section (or a `bridge.debug` namespace object), each with a
one-line "read by: twin/invariants/graphviz" note, and comment `claimSeq` as checker-only. Zero
behavior change; large orientation win for the file's next reader.

**What it costs.** Nothing but diff noise.

**Verdict: SAFE-SIMPLIFICATION.**

---

## Where the code is already minimal — leave it

- **`cosignal-oracle` as a whole.** The model does what it says: no caches, recompute everything,
  every rule commented at its enforcement site. `invariants.ts`, `schedule.ts`, and `adapter.ts`
  are tight and single-purpose; the shrinker is 20 lines. The only change I would make is the
  co-change required by #1. This package is the project's asset — its simplicity is the authority
  the README claims, and it held up under adversarial reading.
- **The kernel's algorithmic core** (`index.ts` link/unlink/propagate/checkDirty/notify,
  `index.ts:578-1027`). Dense, but it is a disciplined transliteration of a known algorithm,
  pinned by 179 external conformance cases, and its deviations are enumerated (D1–D7) with
  measurements where perf motivated them. The hot/slow splits (`link`/`linkInsert`,
  `computedRead`/`computedReadSlow`) and the persistent scratch stacks carry stated bytecode/ns
  numbers. Do not "clean this up."
- **The POISON fold-purity table** (`index.ts:1243-1261`). Looks baroque (hidden-class reasoning),
  but it is 20 lines, cold, self-contained, and the alternative (a flag check in every hot op) is
  exactly what the design avoids; the comment cites measurements.
- **`graphviz.ts`** — 86 lines, types-only imports, no notes.
- **`hooks.ts`** — each oddity (microtask-debounced unsubscribe, retired-rec list, reveal
  adoption) maps 1:1 to a documented React behavior (StrictMode double-mount, node identity change,
  Activity). Proportionate.
- **The four-world visibility rule and the retirement ordering** (`logged.ts:1040-1075,
  2542-2610`; `model.ts:370-407, 1049-1092`). This is the design's irreducible core, stated once in
  prose (READMEs), once naively (model), once packed (engine), and cross-checked. The duplication
  here is the methodology, not a smell.

---

## Smells inventory

**Dead or vestigial** (details in #3): `kernelEvalNode`/`kernelEvalTaint`; routing "mode 2" doc;
`Pass.pendingEdgeDeliveries`; `renderSlicePass` (maintained per evaluation, never read);
engine `reachableFrom`; the `stack?` parameter chain; `mountFix.maskBits`.

**Stored but unconsumed by logic:** `Token.priority` — the engine never branches on priority
(grep: stored at `logged.ts:1834`, displayed by trace only); the `'default'` arm of `Priority` is
used only for ambient batches. Engine `SlotMeta.claimSeq` — written, reset, never read outside the
oracle-cast invariant checker.

**Test affordances living in runtime classes:** `Watcher.dedup` Set-materializing getter;
`AtomNode.tape`/`archive` getters; `Tape.materialize`/`entryAt`/`opAt`; `retainArchive` +
`shadowFoldAtom` + the object-form `visible`/`applyOp` twins; `livePins()`; `eventsOfType`.
(See #11 — label, group, or namespace them.)

**Claims vs. code:** the no-allocation write path allocates 1–2 `BridgeEvent`s per write (#5);
`trace.ts`'s "recording an event allocates nothing" is true of the recorder but the engine-side
hook materializes a `Receipt` object per write when a tracer is attached
(`logged.ts:2043` → `tp.entryAt`); the trace module doc's claim is about the wrong side of the
seam.

**Duplication:** the post-await dev-warning heuristic exists twice with different predicates —
`bridge.bareWrite` (`logged.ts:1941-1945`) and `shim.classifyWrite` (`shim.ts:598-614`); neither is
actually gated on a dev build (no `NODE_ENV` check anywhere despite "warns in development" in both
READMEs). The write-kind coercion table exists twice (`schedule.ts:99-107` and
`oracle-adapter.ts:96-104`) — acceptable as deliberate twin-independence, but worth a cross-ref
comment.

**Stringly-typed seams:** bridge events carry watcher *names*; the shim parses `w${id}` back out
(`shim.ts:562-565`) after the hooks mint watchers as `'w?'` and rename them
(`hooks.ts:184-186`) — ids in events would delete the round trip (falls out of #5).
Capsule identity uses `String(fn)` (`shim.ts:806`) — sound only because the `deps` contract
covers captured variables; worth one sentence in the hook doc.

**Odd idioms:** `resubscribeAtLayout` mints a watcher by opening a throwaway pass, mounting,
deferring, and discarding (`shim.ts:956-977`) — a bridge-level `mintDormantWatcher(root, node)`
would say what it means; `handleRootCommitted` reaches into `root.committedTokens`/`commitGen`
directly (`shim.ts:507-517`) rather than through a bridge method — the only site where the shim
mutates bridge internals by hand.

**Portability:** every bench script imports the engine by absolute machine-specific path
(`/Users/jitl/src/...` in `bench/*.mjs`, e.g. `spkw-logged.mjs:6-7`) — they run on exactly one
computer.

**Public-surface gravity:** `cosignal-react` re-exports everything including a class its own hooks
reject (#7); `REQUIRED_CAPABILITIES = 511` is a magic bitmask with no per-bit names
(`shim.ts:78`).

---

## Closing note on method

The strongest property of this codebase is that its safety net is better than its size: 179
external conformance cases on both builds, a lockstep twin on every battery/scars/flags test, 300
fuzz seeds diffed step-by-step against a naive model, invariants after every step, and grep-tests
pinning the module-graph and trace disciplines. Items #1–#5 above are each refactors that this net
referees almost completely. The corollary cuts the other way too: any simplification that requires
weakening the net (deleting the oracle, loosening the twin comparators) is not worth it. Simplify
the engine; keep the referee.

