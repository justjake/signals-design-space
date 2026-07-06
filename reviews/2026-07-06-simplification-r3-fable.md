# Simplification & concept-combination review — r3 (fable)

Scope: `packages/cosignal`, `packages/cosignal-react`, `packages/cosignal-oracle` only
(READMEs + sources, top to bottom; test files consulted only to confirm what runtime
affordances they consume). Nothing else read.

Verification baseline (all green before any of the proposals below):

- `packages/cosignal`: `pnpm test` 314 passed / 1 skipped; `pnpm typecheck` clean
- `packages/cosignal-react`: `pnpm test` 62 passed; `pnpm typecheck` clean
- `packages/cosignal-oracle`: `pnpm test` 81 passed / 1 skipped; `pnpm typecheck` clean
- harness conformance: `FRAMEWORK=cosignal` 179/179, `FRAMEWORK=cosignal-concurrent` 179/179

Line numbers refer to the files as of this review.

## Shape of the whole

The system is a four-layer tower over one idea — "state is a fold of receipts, and every
consumer names the world it folds in": the kernel (packed alien-signals transliteration,
`index.ts`), the concurrent engine riding it (`concurrent.ts`), the React adapter
(`cosignal-react`), and the executable oracle (`cosignal-oracle`). The striking property
is how much of the growth is *mirrors rather than branches*: the same graph algorithms
exist twice inside the engine (kernel walks and shadow-arena walks, deliberately, for
perf), the same visibility rule exists three times (engine packed form, oracle object
form, referee model-view form), the same event union twice (BridgeEvent/ModelEvent), the
same field-offset enums twice (NodeField/LinkField vs AF), and the same fold-purity guard
twice (kernel POISON table vs bridge `inFoldCallback`). Most mirrors are priced and
argued in comments — this codebase is unusually explicit about *why* each duplication
exists — so the real simplification surface is not the big mirrors but the sediment
around them: dead state left behind by deleted designs (the memo ladder, K1, priorities),
one rule hand-expanded at 3–6 call sites (equality dispatch, compare-and-correct,
world resolution, cycle-error translation), dual Set/bit representations of slot sets
threaded through pass/watcher/world records, and a public Atom API re-implemented inside
the observed-lifecycle ctx instead of called. Those are safe, local collapses that
shrink the number of places a future change must visit, without touching the priced
hot paths. The one structural question worth a design conversation (not a patch) is how
much referee machinery lives inside the production `CosignalBridge` class (~350 lines of
armed checkers, test seams, and an event-log system production never mints).

## Findings, ranked by leverage

### F1. Slot sets exist as Sets *and* bit words, threaded in parallel — pick the bits
**What:** `packages/cosignal/src/concurrent.ts` — `Pass` carries `maskSlots: Set`,
`capturedCommittedSlots: Set`, *and* `maskBits`/`includedBits: SlotSet` (437–459);
`WatcherSnapshot` carries `maskSlots`/`includedSlots` as Sets (480–485); the `mountFix`
world carries a `Set<SlotId>` (596); `includedSet()` (2203–2206) allocates the union Set
that `includedBits` already encodes; `committedSlotsNow()` (2208–2216) allocates the Set
form of the maintained `RootState.committedBits`; `mountFixup` iterates via a spread
allocation `[...w.snapshot.maskSlots].every(...)` (5217).
**Why complex:** one concept (a set of ≤31 slots) in two representations, both built at
`passStart` (4221–4247), both copied into every watcher snapshot (4294–4299, 4686–4689),
and consumers split by representation: `visibleAt` and `deliver` test bits;
`mountFixup`, the mountFix world, and the audit world use Sets. Every future rule that
touches slot sets must decide which twin to read and whether to update both.
**Simpler general form:** SlotSet (int) everywhere. Deletable: `Pass.maskSlots`,
`Pass.capturedCommittedSlots` (recoverable as `includedBits & ~maskBits` if ever needed),
`includedSet()`, `committedSlotsNow()` (callers read `root(id).committedBits`), the two
snapshot Sets → two ints, the mountFix `maskSlots` Set → int, the spread in `mountFixup`
→ a 31-bit loop. ~8 fields/methods and 3 per-pass/per-snapshot allocations deleted; the
visibility rule's mountFix arm becomes the same bit test as the pass arm.
**Cost:** `tests/model-view.ts` calls `engine.includedSet`/`committedSlotsNow` for the
Receipt-shaped visibility twin, and the bridge-surface types are documented as
"structurally mirror the reference model's" (the oracle keeps Sets — the mirror claim
weakens from field-shape to meaning). Mount-fixup tests that build snapshots by hand
would re-shape. No behavior change; perf neutral-to-better (fewer allocations per pass).
**Verdict:** TRADE (mechanical, but crosses the referee surface; do it with the
model-view updated in the same change).

### F2. The compare-and-correct block is hand-expanded at four sites
**What:** `packages/cosignal/src/concurrent.ts` — the six-line "evaluate committed →
`changedValue` → log + `lastRenderedValue = now` + `dedupBits = 0` + `queueNotify(2)`"
block appears in the settlement cone drain (3243–3255), `quietDrain` (3921–3932), and
`drainCommittedObservers` (5154–5165); `mountFixup`'s corrected arm (5250–5256) is the
same block with a different event and source world.
**Why complex:** "urgent pre-paint correction" is one concept, but its invariants (which
fields must reset together — notably the `dedupBits = 0` re-arm) are enforced by copy
discipline. The settlement-drain copy already drifted cosmetically (it hardcodes
`cause: 'retirement'`).
**Simpler general form:** one
`private correctWatcher(w, now, cause: 'retirement' | 'per-root-commit' | 'quiet' | 'mount')`
owning the compare, the field resets, the event, and the notify. The three candidate-
selection strategies (all live watchers / per-root / dirty-walk + restaled) stay where
they are — only the correction body collapses. Deletes ~25 lines and makes "what happens
when a watcher is corrected" answerable in one place.
**Cost:** none observable; event payloads must be kept byte-identical (lockstep compares
them). SAFE-SIMPLIFICATION.

### F3. `AtomCtx.set/update` re-implements `Atom.set/update` instead of calling them
**What:** `packages/cosignal/src/index.ts:2249–2273` — the observed-lifecycle ctx built
in the `Atom` constructor duplicates the bodies of `Atom.set` (2309–2314) and
`Atom.update` (2323–2330), including the `hostWrite` seam interception and the
`runFold` wrapper, with `self` already in scope.
**Why complex:** the host-seam interception rule ("a host-attributable write is captured
whole") now lives in three places (set, update, ctx) instead of two; a change to the
write path (e.g. a new op kind, a new guard) must remember the ctx copy. This is exactly
the "public methods are the one write path" invariant the file header states — violated
by an internal caller.
**Simpler general form:** `ctx = { get state(){...}, set: (v) => self.set(v),
update: (fn) => self.update(fn) }`. Deletes ~12 lines and one copy of the seam rule.
**Cost:** behavior identical today. One nameable delta: a user subclass overriding
`set`/`update` would now be honored by the lifecycle ctx (currently bypassed) — arguably
a fix; no test pins the bypass. SAFE-SIMPLIFICATION.

### F4. Atom-equality dispatch (`eqIsDefault ? Object.is : inCallback(equals)`) at five sites
**What:** `packages/cosignal/src/concurrent.ts` — `foldAtom` (2260–2266), `__quietWrite`
(3894), `writeInner`'s drop check (4022–4040, as *two arms*: a `set && eqIsDefault` fast
arm and a general arm), the eager kernel apply (4079–4087, again two arms), and
`compactAtom` (5028–5031).
**Why complex:** one policy (how this atom compares values, under the fold-purity guard
for custom comparators) expanded by hand five times; the two-arm sites additionally
special-case `set` ops to skip `applyOp`, so the drop rule reads as four branches where
it is one sentence ("a write may drop only when the tape is empty and the op evaluates
equal against base").
**Simpler general form:** `private eqAtom(atom, a, b): boolean` used at all five sites;
optionally fold each two-arm site into its general arm (`applyOp` already returns
`op.value` for sets). Deletes 4–6 branches.
**Cost:** the collapsed drop check pays one `applyOp` dispatch + `inCallback` flag
save/restore on tape-empty plain sets — a path quiet mode already short-circuits in
production (quiet bridges never reach it; referee bridges run with quiet off, where the
cost is noise). Keep the two eager-apply arms if the write bench regresses; the helper
extraction alone is free. SAFE-SIMPLIFICATION.

### F5. Dead state: shim `rootsById` + `lineageId`; oracle `carriedMaxRetiredSeq`, `Token.priority`, `writeSeqs`
**What:**
- `packages/cosignal-react/src/shim.ts:146,286` — `rootsById` is written, never read.
  `RootRec.lineageId` (114, 281, 349) is written from the `onRenderPassStart` param
  (222–223, 330) and never read — a protocol parameter threaded through two layers into
  a field nothing consumes.
- `packages/cosignal-oracle/src/model.ts:119,330,656,1470` — `SlotMeta.carriedMaxRetiredSeq`
  is initialized, maxed at release, zeroed at quiesce, and never read.
- `model.ts:28,92,586` + `schedule.ts:40,112,207,211` — `Token.priority` is generated,
  plumbed through `ScheduleOp` → `applyOneOp` → `openBatch` → the Token record, and
  consulted by zero model logic (the engine's Token has no priority at all — the header
  explicitly says the engine never consults lane priority). One test line reads it
  (`scars.spec.ts:309` asserts the ambient batch's default).
- `model.ts:100` — `Token.writeSeqs: number[]` accumulates every seq but only its last
  element is ever read (`mountFixup`, 1338–1341); the engine's twin is already the
  scalar `lastWriteSeq`.
**Why complex:** each is fossil plumbing that makes readers hunt for a consumer that no
longer exists (the priority one actively suggests the model schedules by priority — it
does not).
**Simpler general form:** delete `rootsById`, `lineageId` (ignore the protocol param),
`carriedMaxRetiredSeq`; replace `writeSeqs` with `lastWriteSeq`; drop `priority` from the
model (Token field + `openBatch` param) and from `ScheduleOp`/`generateSchedule`, fixing
the one scar assertion. ~25 lines and one whole concept (Priority) deleted from the
oracle's contract surface.
**Cost:** removing the `priorities[pick(3)]` draw changes the RNG stream, so historical
failing-seed numbers stop reproducing byte-identically (keep a discarded `pick(3)` if
seed stability matters); `ScheduleOp` shape changes any pasted shrunk-schedule JSON.
`rootsById`/`lineageId`/`carriedMaxRetiredSeq`/`writeSeqs` have no cost at all.
**Verdict:** SAFE-SIMPLIFICATION (priority arm: SAFE with the seed-stream caveat named).

### F6. World-resolution preamble duplicated across the two host read hooks (and the stamp rule across the two resolvers)
**What:** `packages/cosignal/src/concurrent.ts` — `hostRead` (1747–1783) and
`hostComputedRead` (1795–1824) begin with the same 14 lines: fold-purity throw, then
activeWorld → captureFrame (mint committed world) → worldProvider, then the
cap-deps push at the tail. Likewise `nodeFor` (1938–1945) and `nodeForComputed`
(1833–1842) are the same stamp-validate + registry-probe + re-stamp sequence, which the
comments themselves call "the ONE stamp-validate + registry-probe rule".
**Why complex:** the read-routing order (evaluation world outranks capture frame
outranks provider) is a load-bearing rule stated in comments at both sites; two copies
means the next routing tweak (e.g. a new frame kind) is a two-site edit with a silent-
divergence failure mode — precisely the class of bug the capture-frame work just landed.
**Simpler general form:** `private resolveRoutedWorld(): { world: World | undefined;
cap: CaptureFrame | undefined }` used by both hooks; a
`private resolveStamped<N>(handle, kind): N | undefined` used by both resolvers.
Deletes ~20 lines; the "one rule" claim becomes literally true.
**Cost:** none; these are cold-to-warm paths and the helper is monomorphic.
SAFE-SIMPLIFICATION.

### F7. One cycle error, six construction sites; one kernel-read body, two readers
**What:** `packages/cosignal/src/concurrent.ts` — the
`CycleError → BridgeScheduleError('cyclic evaluation of X within one world…')`
translation appears at 2144–2148, 2160–2165, 2448–2451, and the same message is built
independently at 2396–2398 (`evaluate`), 2748–2750 (`aServe`), 3539–3541 (`naiveValue`).
`kernelTrackedReader` (2138–2150) and `kernelUntrackedReader` (2156–2166) share their
entire body modulo the `untracked()` wrapper and the capture push.
**Simpler general form:** `private cycleErrorFor(name): BridgeScheduleError` +
`private kernelReadOf(dep): Value`; the untracked reader becomes
`(dep) => untracked(() => this.kernelReadOf(dep))`. Deletes ~25 lines.
**Cost:** none (readers are persistent closures; one extra call frame on a cold-ish
path). SAFE-SIMPLIFICATION.

### F8. The kernel's field offsets are mirrored by hand into `AF`, and the mirror is load-bearing for three kernel-buffer walks
**What:** `packages/cosignal/src/concurrent.ts:822–875` defines `AF`/`AFlag` "record
stride and flag values mirroring the kernel's (index.ts NodeField/NodeFlag — const enums
are not exported; values are asserted stable by the suite)". Three functions then walk
the *kernel's* arena using the arena's enums: `kernelStrongDepsOf` (2179–2189),
`newestReaches` (4178–4191), `closureOverKernel` (5293–5305) — e.g.
`M[node.handle._id + AF.DEPS]`, `M[l + AF.L_DEP]`, `(M[depKid + AF.FLAGS] & AFlag.K_COMPUTED)`.
**Why complex:** a cross-file layout contract enforced only by a test assertion and a
comment; a kernel field reorder that keeps the kernel green would corrupt these walks in
ways only the lockstep suite might catch. The coincidence that the shadow-arena layout
matches the kernel's is essential for these three sites and incidental everywhere else.
**Simpler general form:** export a tiny plain-const view from `index.ts` for cold
kernel-buffer walks (e.g. `export const KERNEL_LAYOUT = { DEPS: 1, L_DEP: 1, L_NEXT_DEP: 6,
L_NEXT_SUB: 4, FLAGS: 0, K_COMPUTED: 256 } as const` next to the enums, with a one-line
comment tying them together in the same file), and use it at the three sites. The AF
mirror then only has to match the *spike layout*, not the kernel — the suite assertion
and the "mirrored constants" caveats (2179, 4177, 5292) delete.
**Cost:** cross-file `const` object access is a property load after bundling (the
same-file inlining note, index.ts:300–310). `kernelStrongDepsOf` and `closureOverKernel`
are cold (per obsEnter / per mount); `newestReaches` runs per write *per newest-policy
subscription* — warm but already doing a DFS with Set allocation-ish overhead
(`newestReachSeen`), so a property load is noise. TRADE, small and worth it.

### F9. ~350 lines of referee machinery live inside the production bridge class
**What:** `packages/cosignal/src/concurrent.ts` — the armed divergence checker
`__checkArenas` (3454–3522) + its fold-truth evaluator `naiveValue`/`naiveStack`
(3530–3571) + the structural validator `aValidate` (3308–3359); the test seams
`__arenaForTest`, `__arenaPoolForTest`, `__bumpNodeGenForTest`, `__arenaStats`,
`__arenaLinkMode`, `__arenaLinkIdForTest`, `__arenaLinkNextDepForTest`,
`__setSettleCapForTest` (3370–3439, 3141); the retained-event system (`events`,
`eventsOfType`, `eventsSince`, `eventCursor`, `setEventCapacity`, `eventsBase`,
1386–1424, 1844–1888, 5459–5468) which production never mints (bindings consume direct
listeners; the log requires a referee or tracer); and the One Core `probes` (694–702).
Two of these leak into hot paths: `atomValue` (2351–2352) and `evaluate` (2384) test
`this.aOnly !== undefined` (production: arena refolds — earns its place) *and*
`this.naiveFold !== undefined` (test-only: the armed checker's routing override) on
every routed read.
**Why complex:** the class is the engine *and* its own test harness; a reader auditing
the public surface must classify each member by the "Referee surface" comments. The
naiveFold branch is the one place the referee costs production reads.
**Simpler general form (two independent steps):**
1. Fold `naiveFold` into the existing override slot: `aOnly` and `naiveFold` are both
   "serve override for the current frame" and are never both set — one field
   `serveOverride: ShadowArena | NaiveWorldToken | undefined` (or reuse `aOnly` with a
   sentinel arena whose serve delegates to `foldAtom`) deletes one hot-path branch and
   one field.
2. Move `__checkArenas`/`naiveValue`/`aValidate` out of the class into a test-side
   module that receives the few internals it needs through one `@internal`
   `__refereeInternals()` accessor (aServe is the only private it truly needs; the rest
   is public). ~180 lines leave the production file.
**Cost:** (1) is behavior-neutral but touches the most-audited read path — needs the
cold-pass bench re-run. (2) enlarges the @internal surface by one accessor while
shrinking the class; the checker's discipline ("arena side runs FIRST") must survive the
move. The event-log system should stay: it is the tracer's channel (production
diagnostics), already gated to zero cost by `eventsOn`. TRADE.

### F10. `BridgeEvent` and `ModelEvent` are the same 17-variant union maintained by hand in two packages
**What:** `packages/cosignal/src/concurrent.ts:609–627` vs
`packages/cosignal-oracle/src/model.ts:233–251` — field-for-field identical
discriminated unions (only the `Seq`/`number` aliases differ). The lockstep harness
compares them by JSON, so drift shows up as a fuzz diff, not a type error.
**Why complex:** the mirror is the comparison contract, but nothing mechanical pins it;
adding an event means editing two unions plus `COMPARED_EVENTS` (adapter.ts:25–36).
**Simpler general form:** the packages are deliberately independent (the oracle must
referee alternative engines), so *importing* is the wrong fix. Cheapest pin: one
type-level assertion in `packages/cosignal/tests` (which already depends on the oracle):
`type _Pin = [Assert<Extends<BridgeEvent, ModelEvent>>, Assert<Extends<ModelEvent, BridgeEvent>>]`
— drift becomes a typecheck failure. Zero runtime, deletes nothing but converts a
convention into a check.
**Cost:** none. SAFE-SIMPLIFICATION (of the maintenance burden, not the line count).
QUESTION alongside it: `visibleAt` now exists three times (engine packed form
concurrent.ts:2288–2311, oracle model.ts:414–434, referee twin tests/model-view.ts:86–106).
The engine and oracle copies are the design; the model-view copy could be deleted by
exporting the oracle's rule as a standalone
`visible(receipt, world, {includedSlots, committedSlots})` function and having
model-view call it — one canonical Receipt-shaped rule instead of two.

### F11. `useSignal`'s three render arms each hand-wrap the same two-layer read
**What:** `packages/cosignal-react/src/hooks.ts:164–190` — mount, re-render, and reveal
arms all wrap their read as `readSuspending(() => shim.evaluateSuspending(() => …))`,
plus a fourth at the defensive newest arm; `readSuspending` (106–113) and
`Shim.evaluateSuspending` (shim.ts:657–664) are two halves of one concept
("a hook-initiated read may legally suspend: bump the depth, rethrow the thenable").
**Simpler general form:** one `shim.hookRead(fn)` that owns both the depth bump and the
`SuspendedRead → throw thenable` translation; the four sites become one-liners. Deletes
~10 lines and merges a split concept.
**Cost:** none. SAFE-SIMPLIFICATION.

### F12. `writeInner` special-cases `set`+default-equality twice
**What:** `packages/cosignal/src/concurrent.ts:4022–4041` (drop check) and 4079–4087
(eager kernel apply) each split into a `kind === SET && eqIsDefault` fast arm and a
general arm that would also handle the fast case.
**Why complex:** two extra branches on the recorded-write path whose only purpose is to
skip an `applyOp` dispatch and the `inCallback` flag toggle for plain sets — but the
recorded-write path only runs while something is pending (quiet mode owns the steady
state), and the general arm is a handful of instructions.
**Simpler general form:** keep only the general arms (folds into F4's `eqAtom`). Deletes
2 branches; the drop rule becomes one comparison site.
**Cost:** a few ns per recorded plain-set write; if the SPK write-storm gates care, keep
the eager-apply fast arm and collapse only the drop check. SAFE-SIMPLIFICATION
(bench-gated).

### F13. `rendered ⊇ mounted` forces skip-checks and a double-visit
**What:** `packages/cosignal/src/concurrent.ts:4306–4308` — `mountWatcher` adds the new
watcher to both `p.mounted` and `p.rendered`; `passEndInner` then filters it back out
(`p.mounted.includes(wid)`, 4684 — O(mounted) per rendered watcher) and later iterates
`[...p.rendered, ...p.mounted]` (4765), visiting mounted watchers twice (idempotent, but
only by luck of the loop body). The oracle mirrors the same overlap (model.ts:876–877,
1093).
**Simpler general form:** keep the two sets disjoint (`rendered` = re-renders only) and
delete the skip-check and the concat double-visit; the re-staled loop's intent ("every
watcher this pass produced") becomes an explicit union where it *means* union.
**Cost:** contract-shape change mirrored in the oracle — engine and model must move
together, and any pinned scar that inspects `pass.rendered` re-baselines. QUESTION
(worth it only if this area is touched again anyway).

### F14. `flushNewestSubs`'s reach walk vs "just evaluate" (the model's own shape)
**What:** `packages/cosignal/src/concurrent.ts:4153–4191` — per write, for each live
newest-policy subscription, a DFS (`newestReaches`, with a module `Set` cleared per sub)
over the kernel's dep links decides whether to evaluate; `directFlushCoreEffects`
(4197–4207) is the same loop without the reach test, used at reach-free boundaries.
**Why complex:** two flush forms for one subscription policy, plus a recursive
kernel-buffer walk (see F8) — and the reach test guards an evaluation that is *already*
cheap when the sub is unaffected (an unaffected computed's kernel read is a clean cached
read; `checkDirty` resolves without running user code). The value gate makes extra
evaluations silent.
**Simpler general form:** delete `newestReaches` + `newestReachSeen` and call the
value-gated evaluate loop at writes too (optionally keeping the model's `reached`-set
analogy by passing the written node for a one-level cheap check). Deletes ~40 lines and
one recursion.
**Cost:** semantic subtlety — an evaluation is observable when the sub's computed was
*already stale from this same write's kernel propagation*: identical outcome either way;
but a computed stale for an unrelated reason would now re-derive (and untracked-sample)
at this write instead of the next boundary. The lockstep corpus compares
`core-effect-run` events, so any real divergence would surface immediately; still, this
changes *when* sampling happens in corner cases. QUESTION — try it under the fuzz corpus
before believing it.

## Small fry (each a few minutes, all SAFE unless noted)

- `concurrent.ts:600–605` — `SlotBits` is a one-member enum for the literal `1`;
  `(bits >>> slot) & 1` reads better than the indirection (subsumed by F1 if taken).
- `concurrent.ts:2671` — `aEqAtom(_atom, prev, next)` takes an unused parameter purely
  as documentation; the comment already carries the argument — drop the param or the
  method (it is `Object.is` with a rationale).
- `concurrent.ts:3796, 4250` vs `recomputeQuiet()` — quiet is falsified directly at two
  sites and recomputed at six; make all eight `recomputeQuiet()` calls (the derivation is
  five scalar compares) so `quiet` has one writer.
- `index.ts:1571–1575` vs `1870–1872` — the `forbidWritesInComputeds` check + message is
  duplicated between `__assertHostWritable` and `writeAtom`; have `writeAtom` call the
  seam function.
- `hooks.ts:52–55` — `dispose()`'s `if (getActiveShim() === undefined) setActiveShim(undefined)`
  works only because a disposed shim reads as undefined; `if (activeShim-is-this-shim)`
  (an `unregister(shim)` in shim.ts) states the intent ("don't clobber a successor").
- `hooks.ts:318` + `shim.ts:691` — the `'root-unknown'` sentinel string appears in two
  files; hoist one constant.
- `hooks.ts:359–374` — `scope.dispatch` re-derives the reducer-as-update closure that
  `ReducerAtom.dispatch` (index.ts:2351–2354) already encodes; a
  `ReducerAtom.__opFor(action)`-style helper (or just `scope.dispatch` delegating to a
  shared fn) keeps the "dispatch ≡ update(s ⇒ reduce(s, action))" rule in one place.
- `schedule.ts:177–181` — `tokenAt` is typed `number | undefined` but never returns
  undefined (it throws); fixing the return type deletes the `!` at five call sites.
- `concurrent.ts:342, 3898` — `AtomNode.retirementStamp`'s doc says "memo fingerprints
  must incorporate it" and `__quietWrite`'s comment says "move the memo clocks" — the
  memo ladder is deleted (S-C/S-D); the stamp now serves only intra-retirement dedup and
  `baseSeq` only the referee's model view. Re-doc both so the next reader doesn't hunt
  for fingerprint consumers.
- `concurrent.ts:3765–3767` — `liveTokens()` allocates `[...values].filter(...)` per
  call; the shim calls it inside the post-await dev-warn heuristic on every classified
  write (shim.ts:571) — `liveTokenCount`/a parked counter answers `some(parked)` without
  the array. (Perf-only; dev-path.)

## Already minimal — weighed and left alone

- **Kernel walks vs arena walks (the big mirror).** `aLink/aPropagate/aCheckDirtyLoop/…`
  (concurrent.ts:1127–1352, 2946–3044) re-state the kernel's algorithms (~450 lines).
  A shared parametrized walker would cost the kernel its closure-constant, const-enum,
  monomorphic compiled form — the package's entire performance thesis (index.ts header,
  the bundling notes, the measured inline-budget splits). The mirror is priced,
  tested (arena-freelist, arena-sa*), and diverges for real reasons (weak-subs second
  list, VALID/BOX bits, guard counters). Leave it; F8 trims its one fragile edge.
- **POISON table vs `inFoldCallback` (two fold-purity mechanisms).** The kernel swaps an
  operation table so hot paths carry zero fold instructions (index.ts:1461–1494, with a
  measured hidden-class rationale); the bridge uses a boolean because its entry points
  are already cold-checked (concurrent.ts:1699–1701). One concept, two mechanisms, both
  justified where they sit.
- **Oracle naivety.** `refreshEdgesAllWorlds` per write, full-scan drains, memo-free
  evaluation, `dependencyClosureOf`'s O(V·E) loop (model.ts:537–566, 1387–1405) — the
  model's authority *is* this waste; do not optimize it.
- **`Watcher` class vs `Subscription` record.** The effects unification deliberately
  stopped at `run`-action consumers (concurrent.ts:541–565 states the boundary);
  merging deliver-action watchers in would trade two small shapes for one large one with
  more dead fields, not fewer.
- **The shim's ambient-retirement policy** (`maybeRetireAmbient`, shim.ts:440–465) —
  policy correctly lives host-side (no protocol event names the ambient batch), and the
  engine keeps only the mechanism. Good policy/mechanism split; the three call sites are
  the three window-closing events, each argued.
- **`holdingRefires`/`heldRefires`** (shim.ts:152–167, 498–509) — a genuinely host-phase
  concern (React's re-pend classification vs pass-end ordering), correctly quarantined
  as the one adapter-side piece of effect machinery.
- **Defensive-unreachable branches with pinned rationale** — `classifyWrite`'s token-0
  arm (shim.ts:541–555), the slot backstop (concurrent.ts:3826–3839), `passStart`'s
  stale-open-pass discard (shim.ts:332–338): each documents why it should never fire and
  what happens if it does; that is the right shape for protocol-edge defense.
- **`Tape` as six parallel columns + materialize()** (concurrent.ts:248–321) — the
  packed/materialized split is the no-allocation discipline meeting the referee surface;
  both halves are load-bearing.
- **Trace's two channels (event waist + dedicated hooks)** with its per-kind ownership
  table (concurrent.ts:629–680, trace.ts:455–460) — the four skip-cases are the cost of
  reusing the referee stream instead of double-instrumenting; documented and tested
  (trace-off). Borderline, but collapsing to hooks-only would force production event
  minting or a second vocabulary.
- **18 `@internal` host seams in index.ts** (1500–1667 + lifecycle/settle/ctxUse) — a
  wide waist, but each seam is one line, hot ones must stay direct module bindings for
  V8, and bundling them into an object would cost property loads exactly where it hurts.
  The count is the honest price of "one core, one entry".

## Ranked summary

1. F1 (TRADE): collapse Set/bit slot-set twins onto SlotSet ints — deletes ~8
   fields/methods and per-pass allocations; touches model-view.
2. F2 (SAFE): extract the 4× compare-and-correct block into `correctWatcher`.
3. F3 (SAFE): `AtomCtx.set/update` should call `Atom.set/update`, not re-implement them.
4. F5 (SAFE): delete dead state — shim `rootsById`/`lineageId`; oracle
   `carriedMaxRetiredSeq`, `Token.priority` plumbing (seed-stream caveat), `writeSeqs`→scalar.
5. F4+F12 (SAFE, bench-gated): one `eqAtom` helper for the 5× equality dispatch; merge
   `writeInner`'s set-fast arms into the general arms.
6. F6 (SAFE): extract the shared world-resolution preamble and the stamp-resolve rule.
7. F8 (TRADE): export named kernel-layout constants for the three kernel-buffer walks;
   retire the AF-mirrors-kernel contract.
8. F9 (TRADE): fold `naiveFold` into the serve-override slot (one hot branch deleted);
   move the armed checker + validator (~180 lines) out of the production class.
9. F10 (SAFE): type-level pin for BridgeEvent ≡ ModelEvent; optionally share the oracle's
   Receipt-shaped `visible` with model-view (3 copies → 2).
10. F11 (SAFE): merge `readSuspending`/`evaluateSuspending` into one `shim.hookRead`.
11. F7 (SAFE): one cycle-error constructor (6 sites); one kernel-read body (2 readers).
12. F14 (QUESTION): reach-walk vs value-gated evaluate for newest subs — fuzz first.
13. F13 (QUESTION): disjoint `rendered`/`mounted` — only with a coordinated oracle change.
