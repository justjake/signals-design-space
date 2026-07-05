# cosignal / cosignal-react / cosignal-oracle — independent simplification review (2)

Reviewer posture: first contact, no history, sources + READMEs only (plus the documented
verification commands). Scope: `packages/cosignal`, `packages/cosignal-react`,
`packages/cosignal-oracle`.

Verification record (all green before review):
- `packages/cosignal` vitest: 188 passed, 1 skipped (12 files); tsc clean.
- `packages/cosignal-oracle` vitest: 74 passed, 1 skipped; tsc clean.
- `packages/cosignal-react` vitest: 53 passed; tsc clean.
- harness: `FRAMEWORK=cosignal pnpm conformance` 179/179; `FRAMEWORK=cosignal-logged` 179/179.

Size map (src only): cosignal 6,534 lines (index 2,168 / logged 3,407 / trace 873 / graphviz 86);
cosignal-react 1,251 (+50 ambient d.ts); cosignal-oracle 2,047.

## Up-front question 1 — one coherent core + one thin React adapter?

**The sync half of the story holds; the concurrent half does not.** `index.ts` really is one
core with a dormant feature: the host seams (`index.ts:1274-1347`) are two nullable hooks, the
zero-cost claim is behaviorally pinned (`tests/one-core.spec.ts`), and quiet mode extends the
posture credibly. But `logged.ts` is not a rider on that core — it is a **second, complete
reactive system**: its own node ids and name registry, its own dependency graphs (strong K1
`outList`/`inList` at logged.ts:930-936 *plus* a weak plane at :1903-1916), its own memoization
(WorldMemo ladder + a separate newest-memo plane, :1460-1575), its own computeds with a
*different public shape* (`ComputedFn = (read, untracked) => Value`, :367 — vs the kernel's
ctx-based `Computed`), its own effects (`CoreEffect`/`ReactEffect`), its own cycle detection and
equality handling. The kernel is used only as (a) the newest-value store for atoms and (b) the
sync-world scheduler. The comment at logged.ts:1460-1471 documents that unifying computeds was
tried and produced kernel link cycles — so the split may be forced, but the result is two
reactive engines in one entry, and every reader pays for both.

The seam is app-visible: `useSignal` **rejects** kernel `Computed` (hooks.ts:93-97) and
`useComputed` returns a `BoundComputed` that only works under React. So "one library" ships two
computed APIs and — counting the shim — **three effect systems** (kernel `effect()`; bridge
`CoreEffect`/`ReactEffect`; shim `EffectRec`). And the adapter is not thin: 1,251 lines, with
its own effect-revalidation subsystem (shim.ts:592-654) that *duplicates* one the engine carries
but production never calls (finding 2).

## Up-front question 2 — the 80% story; which mechanisms' existence is the complexity

The 80%: **atoms + kernel computeds/effects for sync apps; receipts/worlds/passes in the bridge
for concurrent React; useSignal/useComputed/startSignalTransition on top; the oracle as
referee.** All of that earns its place. The existence-level complexity is the *fourth copy* of
several concepts and the referee plumbing fused into the production classes:

1. Bridge `ReactEffect`/`CoreEffect` — production-dead; the shim has its own effect system.
2. The `BridgeEvent` log subsystem — production-dead channel #3 (listeners and trace hooks are
   #1/#2), with a quiet-mode interlock and an unbounded-growth trap.
3. "Referee surface" members baked into `CosignalBridge`/`AtomNode`/`Watcher` so tests can cast
   the engine to the model type.
4. `ReducerAtom` + the third `Op` variant (useReducer parity, replicated through five layers).
5. The observed-lifecycle union (`AtomOptions.effect`) tentacled through kernel, policy, bridge,
   and shim.
6. Renumbering-at-quiescence (engine + model + tests) purchased against an SMI/int32 cliff.
7. The dev-warning lint promoted into the formal behavioral contract.
8. Dead public surface (`startBatch`/`endBatch`, `setEventCapacity`, `Priority`,
   `unstable_isCurrentWriteDeferred`) and 24 spike-named bench scripts.

---

## Ranked findings

### F1. The bridge's ReactEffect/CoreEffect machinery is production-dead; the shim reimplements it — TRADE
**What:** logged.ts:554-571 (`ReactEffect`/`CoreEffect` types), :2604-2637 (`mountReactEffect`/
`mountCoreEffect`), :2416-2443 (effect flush), the effect halves of `drainCommittedObservers`
(:3116-3124) and `quietDrain` (:2212-2218). cosignal-react never calls any of it (grep:
`mountReactEffect|mountCoreEffect` — zero hits in `cosignal-react/`). Production
`useSignalEffect` runs on the shim's own `EffectRec` system: `shim.registerEffect` /
`captureEffectRun` / `revalidateEffects` (shim.ts:592-654), re-checked from `handleBatchRetired`,
`handleRootCommitted`, and `classifyWrite`.
**Why it's complex:** two implementations of "committed-world effect revalidation" with
different shapes: the engine's is single-node, oracle-validated, unused; the shim's is
multi-dep-snapshot, production-load-bearing, validated only by the 53 React tests. A reader
tracing "what re-fires useSignalEffect" lands in the wrong (heavily documented) implementation
first. The oracle's `react-effect-run` events referee a mechanism the product doesn't run.
**Simpler alternative:** pick one owner. Either (a) extend the contract so an effect observes a
node and the shim synthesizes a bridge computed per effect-run whose fn replays the captured
deps — then delete the shim's `EffectRec`/`revalidateEffects`; or (b) accept the shim as the
effect owner and delete `ReactEffect` (+ its drain/quiet branches) from the engine, re-scoping
the oracle's `react-effect-run` comparison to the model-only suites. (b) deletes ~120 engine
lines and one whole concept; the model keeps its version as contract documentation.
**Cost:** (b) breaks the twin/lockstep specs that mount react effects (`logged-battery`,
`logged-scars`, `logged-fuzz` via the schedule's `reactEffect` op) — those op arms would need to
drop from the *engine* adapter while remaining in the model, weakening lockstep coverage of
committed-observer timing. That timing is exactly where FLAGS.md found bugs, so this is a real
trade, not a free deletion. Minimum honest fix if the machinery stays: rename/tag it
"lockstep-only" the way "Referee surface" members are tagged, and say in cosignal-react's README
that useSignalEffect does NOT ride it.

### F2. The BridgeEvent log is a third notification channel, production-dead, with an unbounded-growth trap — TRADE (with one SAFE bug-fix inside)
**What:** logged.ts:599-617 (`BridgeEvent`), :815 (`events`), :842-850 (`eventsOn`/
`setRetainEvents`), :1149-1160 (`log()`), :1015-1018 + :1166-1182 (capacity/cursor/
`eventsSince`), ~40 `if (this.eventsOn) this.log(...)` sites. Consumers: tests (retain mode) and
the tracer (`tr.event(e)` at the log waist). The bindings use direct listeners; production apps
mint zero events (asserted by quiet-mode/one-core specs).
**Why it's complex:** three parallel channels out of the engine (event log, TraceHooks, queued
direct listeners) carrying overlapping information — the tracer even *skips* three event kinds
because its dedicated hooks cover them better (trace.ts:456-462). The log also couples into
quiet mode ("an event consumer disarms quiet", logged.ts:829-849), so understanding the
performance posture requires understanding the diagnostics wiring. **Concrete trap:** `log()`
pushes into `this.events` unconditionally when called; `eventCapacity` is `undefined` by default
and `setEventCapacity` has **zero callers** in all three packages — so attaching a tracer
(which sets `eventsOn`) makes `bridge.events` grow without bound for the life of the session,
directly contradicting trace.ts's "RING: fixed memory" story (trace.ts:44-46).
**Simpler alternative:** delete the log from the engine. Tests that retain events install a
listener-shaped recorder (the twin already compares via `ModelEvent[]`; an adapter can build
that array outside the class — the pattern exists in `tests/oracle-adapter.ts`). The tracer
consumes only dedicated hooks (add the ~6 missing kinds as hooks). Then `eventsOn`,
`setRetainEvents`, `eventCapacity`, `eventCursor`, `eventsSince`, `eventsOfType`, `eventsBase`
all vanish, and quiet mode loses one conjunct.
**Cost:** mechanical but wide — every `eventsOn` site, the twin comparator, trace.spec,
quiet-mode.spec. If the full deletion is unwanted, the SAFE two-line subset: have `attachTracer`
set a default event capacity (or stop routing tracer input through the log), restoring the
bounded-memory claim. Name the tests: `trace.spec.ts`, `trace-off.spec.ts`, `quiet-mode.spec.ts`.

### F3. Referee/model structural compatibility is fused into the production classes — SAFE-SIMPLIFICATION (mechanical, medium effort)
**What:** the members tagged "Referee surface" that exist so `checkInvariants(bridge as unknown
as CosignalModel)` and `snapshotModel(bridge as ...)` typecheck/run: `AtomNode.archiveStore`/
`archive`/`origin` (+ `retainArchive` gating growth, logged.ts:325-364, :966-969),
`shadowFoldAtom` (:1434-1443), the `tape` materializing getter (:353-357), `Watcher.dedup`
set-materializer (:545-552), `livePins()` (:2039-2046), `SlotMeta.claimSeq` ("engine mints/
resets but never reads", :427-431), `episodeEdges` map-materializer (:1021-1032), the `visible()`
object-form twin of `visibleAt()` (:1296-1316), and the five `probe*` counters (:684-697).
**Why it's complex:** the production class must stay shape-compatible with the naive model
forever; every future engine change has to thread the referee mirror. Readers cannot tell
load-bearing state from mirror state without the tags (the tags are good; the need for them is
the smell). `Tape` even carries `materialize()`/`entryAt()` allocating paths adjacent to the
hot packed columns.
**Simpler alternative:** a test-side `ModelView` adapter (~80-120 lines in `tests/`) that wraps
a bridge and *presents* the model shape — materializing tapes/archives/dedup sets from packed
state, computing `livePins` from `openPassByRoot`, carrying the archive itself keyed off
compaction callbacks or by replaying schedule ops (the fuzz path's `oracle-adapter.ts` already
mirrors entity registries this way). Delete the referee members from `logged.ts` proper.
**Cost:** rewrites `tests/helpers.ts` (`verify()`, stream compare) and the specs that poke
`w.dedup`/`atom.tape` (`logged-battery`, `logged-scars`); the archive would need a hook to
observe compaction (one optional callback vs today's `retainArchive` flag — net-neutral there).
No behavior change; the invariant coverage is preserved because the adapter feeds the same
checker. Probes could shrink to a single test-only counter object behind one export.

### F4. Who retires the ambient batch in production? — QUESTION (possible liveness/memory gap)
**What:** logged.ts:2225-2247 (`bareWrite` mints an ambient token when not quiet);
`maybeReclaimToken` explicitly skips the ambient token (:2812); `retireInternal` clears
`ambientToken` only when the token is retired (:2924). The shim retires only tokens with
protocol counterparts (`handleBatchRetired`, shim.ts:477-487) — the ambient bridge batch has no
fork token, so **no production code path ever retires it**.
**Why it matters:** the reachable sequence is: a transition/action is pending (quiet off) → any
context-free write (`unstable_getCurrentWriteBatch() === 0`, e.g. a timer or post-await write —
exactly the case the dev-warning anticipates) → ambient batch minted, stays `live` forever →
`liveTokenCount` never reaches 0 → quiet never re-arms, `quiesce()` is unreachable, and the
ambient receipts at each tape's head block compaction of everything behind them (compactAtom's
prefix clause, :2961-2965) → tapes grow for the app's remaining lifetime. The oracle never sees
this because its schedules explicitly `retire` every token index, ambient included
(schedule.ts:241-245) — i.e. the contract assumes a driver that retires ambient, and the real
driver doesn't.
**Owner question:** is `forkToken === 0` unreachable in production after registration (does the
patched build guarantee a write batch for every task)? If yes, `bareWrite`'s ambient arm is
dead-in-production and should say so; if no, the shim needs an ambient retirement policy (e.g.
retire the ambient batch at the next `onBatchRetired`/root commit, or make non-quiet bare writes
open-and-retire a one-shot batch). Either answer deletes ambiguity; today the code supports an
unbounded state no test exercises.

### F5. Two computed APIs (kernel `Computed` vs bridge `ComputedNode`/`BoundComputed`) — QUESTION (design), plus one SAFE doc fix
**What:** `Computed` (index.ts:2003-2048, ctx-based, packed, push-pull) vs `ComputedFn`
(logged.ts:366-374, `(read, untracked)`), surfaced as `BoundComputed` (hooks.ts:70-97) which
`useSignal` accepts while rejecting kernel `Computed` outright.
**Why it's complex:** the flagship "ONE CORE" narrative (index.ts:101-123, README "one package,
one build") holds for atoms but not computeds: a shared data layer cannot define one derived
value usable both from a plain `effect()` (needs kernel `Computed`) and from React (needs
`useComputed`). Reader burden: the ctx.use/suspense story exists twice (kernel policy layer
:1592-1831; shim `makeComputedNode` + `previousCells` :680-737) sharing only `__ctxUse`.
**What would make it sane:** the constraint is documented — kernel computed records re-tracked
across worlds leave stale links that hang the kernel's dispose walk (logged.ts:1460-1471). The
code *establishes* that a naive unification fails; it does not establish that module-level
derived values must be un-routable under React (an `adoptComputed(fn)` that mints a bridge node
from a kernel-computed's getter would give one authoring surface, kernel node unused while
React-bound).
**Owner question:** is "module-scope derived state readable in a render's world" a v1 goal? If
no — say so loudly in both READMEs (today only the `useSignal` error message admits it). If yes,
the bridge node factory is the cheap seam. SAFE part: the READMEs should stop implying a single
signal vocabulary; the exclusion is discoverable only by hitting the throw.

### F6. Dead and decorative public surface — SAFE-SIMPLIFICATION
**What / alternative (all delete-and-see):**
- `startBatch`/`endBatch` (index.ts:2101-2110): exported "for binding authors"; no binding, test,
  or bench uses them (`batch()` covers users). Delete.
- `setEventCapacity` (logged.ts:1180-1182): zero callers anywhere. Delete (or wire it into
  `attachTracer` per F2).
- `Token.priority` / `Priority` (logged.ts:194, model.ts:28): stored, threaded through
  `openBatch`, the shim, the schedule generator, and the trace encoder — **never branched on**
  by engine or model (only re-encoded for trace records). Scheduling priority lives in React's
  lanes via the forkToken map; this field is a label. Collapse to a debug string or delete from
  the contract (touches oracle types + twin streams — cheap, mechanical).
- `unstable_isCurrentWriteDeferred` (react-fork.d.ts:35): declared, never called (the shim reads
  `forkToken & 1`). Delete the declaration or use it instead of the bit-peek (one source of truth).
- `export * from './logged.js'` (index.ts:2168): ships `__newBridgeForTest`, `__coreProbes`,
  `Tape`, `AtomNode`, `Watcher`, every internal type to every consumer of the package root, while
  cosignal-react curates its re-exports precisely. A curated export list (the README's own
  "remaining engine exports" enumeration) shrinks the public API and makes the `@internal` tags
  enforceable. Cost: tests import from `../src/logged.js` directly already — no test churn.
- `ReducerAtomOptions<S>` alias (index.ts:1975) — alias of `AtomOptions<S>`; inline it.
**Cost:** none observable; `one-core.spec.ts` asserts only the package-exports map (`.`,
`./trace`, `./graphviz`), which is untouched.

### F7. `bench/` — 24 spike-named workbench scripts inside the package — SAFE-SIMPLIFICATION
**What:** `packages/cosignal/bench/spk{g8,k1,l,n1,r,w}*.mjs` + `util.mjs`; not referenced by
`package.json` scripts, tests, or docs; names are opaque spike ids (`spkw-quiet-run`,
`spkr-core-logged`, ...), several with `-logged`/`-direct` twins that predate the one-core merge.
**Why:** a first-time reader must decide whether these are load-bearing (they are not) — 24
files of unowned surface in a package whose README never mentions them.
**Alternative:** delete or move to a workbench directory outside the package; keep at most one
documented perf harness. **Cost:** none to tests; loses ad-hoc repro scripts (recoverable from
history).

### F8. ReducerAtom / the `dispatch` Op variant — TRADE (state it)
**What:** `ReducerAtom` (index.ts:1983-2000), `HostOpKind` 2, `OpKind.DISPATCH`, `Op.dispatch`
in engine + model + tape + adapter + schedule (`WriteKind` coercions), `useReducerAtom`
(hooks.ts:281-291), `scope.dispatch`, `AtomNode.reducer` + adoption wiring (logged.ts:1231-1236).
**Why:** semantically, `dispatch(action)` ≡ `update(s => reduce(s, action))` — both are pure
whole-op replays; the reducer adds no replay capability `update` lacks. Its existence multiplies
every op-shaped switch (about 12 sites across the three packages) by a third arm.
**Trade:** deleting it loses `useReducer` API parity and the "reducer fixed at creation" guard
(a per-dispatch closure could accidentally capture a changing reducer; the fixed-reducer rule is
enforceable only because the reducer is a declared entity). If parity is a product requirement,
keep it — but it is the single cheapest whole-concept deletion on offer (~150 lines across five
files + test arms in battery/fuzz).

### F9. Renumbering at quiescence — QUESTION (owner: is the SMI/int32 cliff worth ~200 lines?)
**What:** `renumber()` engine (logged.ts:3341-3372) + model (model.ts:1338-1371), the retained-
set/rewrite dance, plus the quiesce-time kernel-pull refresh interplay. Distinct from the K1/
epoch reset (which *is* required to bound edge logs — keep that).
**Why suspicious:** seqs are JS numbers; correctness never overflows. The real stakes are (a)
V8 SMI-packing of tape/seq arrays past 2^30 (a perf cliff needing a billion+ writes per episode
— but seqs are *global*, so long-lived apps do accumulate) and (b) int32 trace-record fields.
Neither is stated where the mechanism lives; the model says only "counters stay small… instead
of growing toward overflow" (model.ts:1300-1303), which is wrong-ish for doubles and is exactly
the kind of asserted-not-established rationale this review was told to challenge.
**Alternative:** delete renumbering from both sides; keep epoch reset. Trace fields store seqs
mod 2^31 (they are a chronicle already; the docs admit cross-epoch seqs read stale).
**Cost:** scars/battery cases pinning renumbering (S38/S43 halves, `epoch-reset` assertions) and
the "seq restarts low" property; if the owner confirms the SMI concern is measured, keep and
document the actual number.

### F10. Dev-warning lint inside the formal contract — QUESTION
**What:** the post-await heuristic exists three times: model (`bareWrite`, model.ts:653-659),
engine (`bareWrite`, logged.ts:2239-2245), shim (`classifyWrite`, shim.ts:548-565 — a *different*
trigger predicate, self-described as over-triggering). The twin comparator diffs `dev-warning`
events exactly (helpers.ts:157-163), so the oracle now pins a console lint's firing schedule.
**Why:** a dev-only ergonomics warning has become contract surface: changing its wording or
trigger breaks lockstep. Policy (a lint) is fused into mechanism (the referee).
**Alternative:** own the lint in the shim only (it already has `devWarn` + dedupe); drop
`dev-warning` from `ModelEvent`/`BridgeEvent` and the twin diff. Deletes the engine/model copies
and one event kind. **Cost:** the model README's claim that bare-writes-while-parked warn moves
from "contract" to "bindings behavior"; two twin assertions update.

### F11. Observed lifecycle (`AtomOptions.effect`) — TRADE (real feature, widest tentacles per line)
**What:** kernel field D1 + `linkInsert`/`unwatched` branches (index.ts:620-627, :873-877),
policy union refcount + microtask flap-damping (:1427-1536), `Watcher.live` setter coupling
(logged.ts:516-543), shim claim/sweep/debounce discipline routed through it.
**Why:** one option's plumbing crosses all four layers and forces the "union of two consumer
kinds" concept on every reader of the watcher lifecycle. It is the only `AtomOptions` member
with kernel fields named after it.
**Trade:** it is a genuine feature (remote-subscription mounting, jotai `onMount`-class) with
its own spec (`observe-union.spec.ts`) and React test. If usage is speculative, deleting it
removes D1, ~110 policy lines, and the `__lifecycleRetain/Release` seam; if it is a product
requirement, it is well-built — the microtask coalescing is the right call. Owner call on
whether the feature is real. Leave the implementation alone either way.

### F12. Small SAFE cleanups inside otherwise-sound mechanisms
- `kernelValueOf` (logged.ts:1447-1458) saves/restores `worldProvider` + `activeWorld` (two
  seam writes) around every newest atom read, to dodge the bridge's own read hook through public
  `Atom.state`. A core-internal newest-read export (sibling of `__hostApplySet`,
  index.ts:1345-1347) reduces it to one call and deletes the dance.
- `resubscribeAtLayout` (shim.ts:787-808) opens a throwaway pass and immediately discards it
  purely to mint a watcher ("degenerate pass"). The bridge API wants a direct
  `mountDetachedWatcher(root, node)`; the hack works but reads as protocol abuse and executes a
  full discard path per reveal-without-render.
- `Tape.drop`'s empty-window `else if` (logged.ts:298-308) duplicates the reset the rebase branch
  would reach; harmless, but two of the three arms exist for one amortization idea — a comment
  pointing at the measured 10µs dictionary-mode drop is already there; fine, leave after noting.
- `hostWriteImpl`'s stamp-vs-map fallback (logged.ts:733-736) and `nodeForAtom`'s re-stamp
  (shim.ts:669-678) are two implementations of the same resolution rule — the shim's could call
  a bridge method so the rule lives once.

## Smells inventory
- **Repetition:** visibility rule ×3 (`visible`, `visibleAt`, model — third is by design; the
  first two are an object/packed pair whose object form serves only referees, see F3);
  op-application ×4 (`applyOp`, `applyOpPacked`, model `applyOp`, quiet-write inline);
  `opOf` duplicated verbatim in logged.ts:702 and shim.ts:163; post-await lint ×3 (F10);
  effect revalidation ×2 (F1); ctx/suspense wiring ×2 (F5).
- **Vestigial:** `bench/` spikes (F7); `startBatch`/`endBatch`, `setEventCapacity`,
  `unstable_isCurrentWriteDeferred`, `Priority` (F6); `ReducerAtomOptions` alias.
- **Over-general machinery:** event log capacity/cursor system with no production consumer (F2);
  `Priority` as a three-valued enum used as a label (F6); trace ref-ring `refCapacity: 0` mode
  (defensible; used by tests).
- **Test affordances in runtime:** every "Referee surface" member (F3); `__coreProbes` counters
  incremented on hot paths; `__newBridgeForTest` exported from the package root (F6);
  `retainArchive` growth path in the production write/compact cycle.
- **Shrinkable public surface:** `export *` of logged internals (F6); bridge internals reachable
  from the `cosignal` root while cosignal-react carefully hides them.
- **Doc/behavior gaps:** trace "ring = fixed memory" vs unbounded `bridge.events` while attached
  (F2); READMEs imply one signal vocabulary vs the useSignal rejection of kernel `Computed` (F5);
  renumbering rationale asserted, not established (F9).

## Already minimal — leave it
- **The kernel** (index.ts §3): a disciplined alien-signals transliteration; the exotica (POISON
  table hidden-class argument, closure rebuild, same-file const enums, link/computedRead
  hot/slow splits) each carry a measured rationale and are pinned by 179×2 conformance runs plus
  behavioral one-core probes. The D1 lifecycle field is the only tenant I'd evict (see F11).
- **The visibility rule, slot lifecycle, retirement ordering, mount fixup + audit, pin-gated
  compaction** (logged.ts core semantics): every subtle clause traces to a FLAGS.md finding or a
  scar; the in-production fast-out audit (BridgeInvariantViolation) is cheap and load-bearing.
- **cosignal-oracle**: the model is exactly what it claims — naive, replay-everything, rationale
  at point of enforcement; invariants/schedule/adapter are compact and single-purpose. Its only
  contract-level excesses are the ones imported from the engine's world: `dispatch` (F8),
  `priority` (F6), `dev-warning` (F10), renumbering (F9).
- **trace.ts recorder mechanics** (ring/session/causality register): self-contained, zero-cost-
  off is source-asserted; the only real issue is the log-channel coupling (F2).
- **graphviz.ts**: 86 lines, type-only imports, fine.
- **hooks.ts** `useSignal`/`useComputed` render-path logic: dense but each branch (mount /
  re-render / reveal-adopt / defensive newest) maps 1:1 to a React lifecycle reality and is
  tested; the StrictMode microtask-debounce is the standard solution.

## Meta
The documentation is unusually good and unusually *load-bearing*: the system is only navigable
because every mechanism carries its rationale. That is also the tell — where a library needs
this much prose per line, the prose is compensating for four overlapping vocabularies (kernel,
bridge, shim, model). The highest-leverage simplifications are not in any algorithm; they are
deletions of whole duplicate concepts (F1, F2, F3, F6-F8, F10) that would shrink the reading
surface by roughly a quarter of logged.ts and a fifth of the shim without touching the semantics
the oracle pins.
