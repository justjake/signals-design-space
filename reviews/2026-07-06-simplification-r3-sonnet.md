# Simplification review — cosignal / cosignal-react / cosignal-oracle (r3, sonnet)

Scope: READMEs + `src/` top to bottom for the three packages, read directly
(no spec/plans/reviews/research/git history consulted). Findings are ranked
by leverage. Change made to the repo: none.

## Verification (baseline, before any judgment below)

All green at the point this review was written:

- `packages/cosignal`: `pnpm test` — 24 files, 314 passed / 1 skipped.
  `pnpm typecheck` — clean.
- `packages/cosignal-react`: `pnpm test` — 5 files, 62 passed. `pnpm typecheck` — clean.
- `packages/cosignal-oracle`: `pnpm test` — 4 files, 81 passed / 1 skipped. `pnpm typecheck` — clean.
- harness conformance, `FRAMEWORK=cosignal`: 179/179.
- harness conformance, `FRAMEWORK=cosignal-concurrent`: 179/179.

Every "SAFE-SIMPLIFICATION" below is a pure extraction (same behavior, same
call sites, same tests) against this green baseline; none were applied.

## Shape of the whole

This is three layers implementing one behavioral contract three times, on
purpose, plus one accidental fourth repetition. Layer one is a hand-packed
push-pull dependency kernel (`cosignal/src/index.ts`): alien-signals'
algorithm re-expressed over an `Int32Array` arena, one value per atom. Layer
two (`cosignal/src/concurrent.ts`) exists solely because layer one's "one
value per atom" is exactly what breaks under React concurrent rendering, so
it *rides* the kernel for newest-value serving and *re-implements the
kernel's own graph-walk algorithm a second time* — over a second packed
arena format with per-world "shadows" — to serve pass/committed-world reads.
Layer three (`cosignal-oracle`) implements the same contract a third time,
deliberately naively (plain objects, full re-derivation, no caches), whose
entire purpose is to referee layers one and two against each other by
lockstep replay and fuzzing. Two of those three implementations (kernel vs.
arena) are genuinely the same algorithm wearing different storage, and are
the single largest source of "one concept, two mechanisms" in the codebase —
already proven to drift once in a way fuzzing had to catch (cited in finding
1). The third (the oracle) is *supposed* to be an independent reimplementation,
so it is not itself a simplification target — but it independently exhibits
the same smaller-scale duplication pattern the engine does (id-lookup-or-throw
helpers, index-picker helpers), which suggests these are generic authoring
habits rather than one-off oversights: the same tiny fix applies, unchanged
in shape, on both sides of the engine/oracle boundary (finding 4). Elsewhere
the code is unusually disciplined about the exact thing this review is
hunting for: almost every repeated branch, flag check, or `@internal` test
seam already carries a comment naming the measurement or the fuzz seed that
justified it, and `checkInvariants`'s six-way dispatch is a literal 1:1 map
to the six contract clauses stated in the README, not a special-case pile.
The leverage that is left is concentrated in a handful of literal copy-paste
siblings (four index-pickers, six id-lookups, three try/catch listeners, two
dependency-readers) that a one-line generic helper deletes outright, plus one
standing architectural question (kernel vs. arena) the team should keep
choosing consciously rather than re-choosing by accident every time one side
gets patched and the other doesn't.

## Findings, ranked by leverage

### 1. The kernel's push-pull walk is hand-duplicated in the per-world shadow arenas

**What.** `packages/cosignal/src/index.ts:602-993` (`link`, `linkInsert`,
`unlink`, `propagate`, `checkDirty` + its two inlined fast paths, `chainCheck`,
`checkDirtyLoop`, `shallowPropagate`, `isValidLink`) and `:1206-1221`
(`disposeAllDepsInReverse`, `purgeDeps`) implement alien-signals' dependency
algorithm once, over the kernel's arena. `packages/cosignal/src/concurrent.ts:1127-1352`
and `:2946-3044` (`aLink`, `aLinkInsert`, `aUnlink`, `aPropagate`/`aPropagateBoth`,
`aShallowPropagate`/`aShallowBoth`, `aIsValidLink`, `aCheckDirty`,
`aUpdateAndShallow`, `aCheckDirtyLoop`) implement the *same* algorithm a
second time, over a second packed layout (`ShadowArena`), function-for-function
parallel by name (`aLink` ↔ `link`, `aCheckDirtyLoop` ↔ `checkDirtyLoop`, …).

**Why complex.** ~300-375 lines on each side, hand-synchronized rather than
shared. Any future change to the push-pull semantics (a new `D`-series kernel
deviation, a new flag) has to be manually re-derived a second time in a
differently-shaped storage layout, by a human remembering the twin exists.
This already went wrong once: `aUpdateAndShallow`'s comment
(`concurrent.ts:2956-2966`) records that the kernel's "only sub is the walker
itself" shortcut is *unsound* under the arena's segregated strong/weak lists
— caught by the fuzz corpus at seed 40, after the port, not by inspection.

**Simpler general form.** Not "delete the duplication." The arena exists
*because* the kernel can hold only one value per atom (the reason this
package exists at all), and the segregated weak/strong subs lists were kept
after an explicit A/B test — a unified list measured 4.9× slower on a
K=100×R=4 write-storm shape (`concurrent.ts:908-916`). A real unification
would need one algorithm parameterized over an abstract record layout, which
is exactly the kind of polymorphism this file fights hard to avoid elsewhere
(the D2/D3 hot/cold splits, the documented "460-byte inline cliff"). I have
no benchmark showing that trade is free, so I'm not sketching a merge. What
*would* reduce the tax without touching either hot loop: make the twinning
obligation explicit (a comment/lint rule/checklist: "a change to
{link,unlink,propagate,checkDirty,shallowPropagate,isValidLink} in index.ts
must be mirrored in concurrent.ts's `a`-prefixed twin, and vice versa") —
today that's tribal knowledge, recovered only after a fuzz failure.

**Cost.** None to flag it. A real merge needs a benchmark on the write/read
paths this file has repeatedly measured (its own "measured ≈parity",
"dalien port study", "4.9×" citations) before it could be called safe — this
is a trade-off for the owner, not a mechanical patch.

**Verdict: QUESTION.** Leaning toward "keep the duplication, but stop relying
on fuzzing alone to catch the next drift."

### 2. Operation-boundary boilerplate repeated across write/passEnd/retire/settleAction/quiesce

**What.** `packages/cosignal/src/concurrent.ts` — `write()` (3974-3988),
`passEnd()` (4614-4622), `retire()` (4859-4876), `settleAction()` (4879-4896)
each wrap their real work in the identical shell
`this.opDepth++; try { …Inner(); } finally { this.opDepth--; } this.arenaOpEpilogue();`.
Inside those bodies (and `quiesce()`, 5401-5438), the exact 2-statement tail
`const tr = this.trace; if (tr !== undefined) tr.opEnd(); this.flushNotify();`
recurs 9 times verbatim: `writeInner`'s four exits (3999-4000, 4027-4028,
4036-4037, 4095-4096), `passEndInner`'s two exits (4672-4673, 4785-4786),
`retire` (4870-4871), `settleAction` (4890-4891), `quiesce` (5435-5436).

**Why complex.** Every one of the five public "compound operation" entry
points must independently remember four invariants — bump/restore `opDepth`,
call `arenaOpEpilogue()` exactly once, mark the trace's `opEnd`, flush queued
notifications — reproduced by hand at 5-9 sites. A new exit path (or a copied
branch inside `writeInner`) can silently skip one with no type error to catch it.

**Simpler general form.**
```ts
private runOp<T>(fn: () => T): T {
  this.opDepth++;
  try { return fn(); } finally { this.opDepth--; }
}
private endOp(): void {
  const tr = this.trace;
  if (tr !== undefined) tr.opEnd();
  this.flushNotify();
}
```
`write()` becomes `this.runOp(() => this.writeInner(tokenId, node, op)); this.arenaOpEpilogue();`;
each of `writeInner`'s four exits becomes `this.endOp(); return;`. Deletes on
the order of 20-25 lines and turns "did every exit remember both invariants"
into "did every exit call `endOp()`."

**Cost.** None — pure extraction. `packages/cosignal/tests/concurrent-*.spec.ts`
and the harness's `cosignal-concurrent` conformance run (both reverified
green above) already exercise every call site.

**Verdict: SAFE-SIMPLIFICATION.**

### 3. Four near-identical "pick an id or throw" functions in the oracle's schedule generator

**What.** `packages/cosignal-oracle/src/schedule.ts:177-199` — `tokenAt`,
`passAt`, `watcherAt`, `effectAt`. Four functions, one body: list a model
map's keys, throw `ScheduleError` if empty, return `ids[index % ids.length]`.

**Why complex.** The only variation is which of `m.tokens`/`m.passes`/
`m.watchers`/`m.reactEffects` is read and the noun in the error — a
special-case-per-entity-kind that needs a new copy every time a schedule op
targets a new entity kind (as it already has four times).

**Simpler general form.**
```ts
function pickId<K>(ids: Iterable<K>, index: number, what: string): K {
  const arr = [...ids];
  if (arr.length === 0) throw new ScheduleError(`no ${what} yet`);
  return arr[index % arr.length]!;
}
```
Call sites become `pickId(m.tokens.keys(), op.token, 'tokens')`, etc. Deletes
3 of the 4 functions (roughly 15 of 23 lines).

**Cost.** None — every `applyOneOp` branch is covered by
`tests/fuzz.spec.ts`'s seeded corpus and `tests/battery.spec.ts`; a mistake
in the generic form fails on the next fuzz run, deterministically.

**Verdict: SAFE-SIMPLIFICATION.**

### 4. "Look up by id or throw" duplicated six ways across the engine and the oracle

**What.** The same two-line shape — `Map.get(id)`, throw a descriptive error
if absent — is written out as six dedicated one-line-body methods:
`packages/cosignal/src/concurrent.ts` `token()` (3802-3806), `nodeById()`
(3808-3812), `pass()` (4259-4263); `packages/cosignal-oracle/src/model.ts`
`token()` (602-606), `nodeById()` (608-612), `pass()` (833-837). Four more
sites inline the identical check ad hoc instead of reusing a helper:
`concurrent.ts` `adoptMount` (4329) and `removeSubscription` (4506);
`model.ts` `adoptMount` (902), `removeReactEffect` (954), `replayReactEffect` (965).

**Why complex.** Two files, ten sites, one idea. The four ad hoc sites show
the cost of not naming it: they don't get the same treatment as
`token`/`pass`/`nodeById` for no reason other than nobody reached for a
shared helper when writing them.

**Simpler general form** (the identical patch, applied independently in each
file — they must stay independent implementations, but the internal hygiene
fix is the same on both sides of the boundary):
```ts
private mustGet<K, V>(map: Map<K, V>, id: K, what: string): V {
  const v = map.get(id);
  if (v === undefined) throw new BridgeScheduleError(`unknown ${what} ${id}`); // ScheduleError in model.ts
  return v;
}
```
`token`/`pass`/`nodeById` collapse to one-line bodies; the four ad hoc sites
gain the same message shape for free. Deletes roughly 20 lines total, no
behavior change.

**Cost.** None; both files' full suites (the concurrent-* specs and the
oracle's battery/scars/flags/fuzz suites, all reverified green above) drive
every one of these lookups already.

**Verdict: SAFE-SIMPLIFICATION.**

### 6. Two dependency-readers in the bridge duplicate an 8-line "read this dep" body

**What.** `packages/cosignal/src/concurrent.ts:2138-2166` —
`kernelTrackedReader` and `kernelUntrackedReader` both contain the identical
body: "if the dep is an atom, read it off the kernel; else try the kernel
computed read, translating a `CycleError` into a `BridgeScheduleError`." The
only real difference is that the tracked reader also pushes to `obsCapture`
and the untracked reader wraps the call in `untracked(() => …)`.

**Why complex.** 8 lines duplicated for what is, once the capture/untracked
wrapping is factored out, one operation: "read this dependency the kernel way."

**Simpler general form.**
```ts
private kernelReadDep(dep: AnyNode): Value {
  if (dep.kind === 'atom') return this.kernelValueOf(dep.handle);
  try { return __kernelComputedRead(dep.handle); }
  catch (err) {
    if (err instanceof CycleError) throw new BridgeScheduleError(`cyclic evaluation of ${dep.name} within one world — a computed may not depend on itself`);
    throw err;
  }
}
```
`kernelTrackedReader` drops to 3 lines, `kernelUntrackedReader` to 1. Deletes
roughly 8 lines.

**Cost.** None; both readers are exercised by every bridge-created-computed
test in `tests/graph-consumers.spec.ts` and the concurrent battery.

**Verdict: SAFE-SIMPLIFICATION.**

### 7. The arena's "walk both subs lists" shape has two established helpers and three ad hoc re-derivations

**What.** `concurrent.ts` already names the right abstraction twice —
`aPropagateBoth` (1305-1311) and `aShallowBoth` (1333-1340), each running a
per-list function over the arena's strong AND weak subs lists — but three
more sites re-derive the same "strong list, then weak list" shape by hand:
`aEvictShadow`'s two back-to-back `while` loops (2630-2641), and a
`for (let list = 0; list < 2; list++) { … list === 0 ? W[sh+AF.SUBS] : a.weakSubs[…] … }`
dispatch duplicated verbatim in the `dependencyEdges` getter (1633-1649) and
in `drainCommittedObservers` (5125-5141).

**Why complex.** The segregated-list representation (kept for the measured
4.9× win — see finding 1) makes "for both lists" a recurring operation. The
codebase already invented the right abstraction twice but didn't reach for
it at the other three sites, so there are now two competing idioms for one
idea.

**Simpler general form.**
```ts
private static subHeads(a: ShadowArena, sh: number): readonly [number, number] {
  return [a.W[sh + AF.SUBS]!, a.weakSubs[sh >> A_SHIFT]!];
}
```
used by all five call sites (the two existing helpers plus the three ad hoc
ones). Deletes roughly 10-12 lines and leaves exactly one place that knows
"there are two lists."

**Cost.** None — `dependencyEdges` is diagnostics-only and `aEvictShadow`/
`drainCommittedObservers` are boundary-only; none of the three sites are on
the per-write hot path `aPropagate`/`aCheckDirty` already own.

**Verdict: SAFE-SIMPLIFICATION.**

### 8. `Atom`/`Computed`'s host-seam checks repeat a 4-way "ask the hook, else fall to the kernel" shape — on the hottest path in the library

**What.** `packages/cosignal/src/index.ts` — `Atom.state` (2297-2306),
`Atom.set` (2309-2314), `Atom.update` (2323-2330), `Computed.state`
(2419-2428) each open with a 3-6 line "if a host hook is armed, ask it
first; fall through to the kernel on `__HOST_MISS` or no hook" check,
structurally identical across all four (the two read forms differ only in
which hook/sentinel; the two write forms differ only in the op-kind literal).

**Why complex.** Four copies of one idea, sitting on the single hottest call
path in the whole package — every public signal read and write goes through
one of these four bodies.

I looked for a benchmark covering exactly this spot and didn't find one. This
is the same file that measured and documented real inlining regressions from
changes far smaller than a shared-helper extraction (the D2/D3 hot/slow
splits, the "460-byte inline cliff," "~9ns per `instanceof` … 2.4× on
read-heavy workloads"). I can't responsibly claim a helper here is free
without the same kind of measurement this file uses everywhere else, so I'm
not sketching a merged form.

**Cost.** Unknown without a benchmark; these four sites run on every
`.state` read and every `.set`/`.update` call in the library.

**Verdict: QUESTION** — worth a short benchmark before touching, not a
blind recommendation either way.

### 9. `arenaInitInts` doesn't follow the class's own test-seam naming convention

**What.** `concurrent.ts:2500` — `arenaInitInts = 8192;`, a bare **public**
mutable field, doc-commented "tests shrink it to force mid-op growth." Every
other test-facing knob on `CosignalBridge` is either `private` with a
dedicated `__setXForTest()` mutator (e.g. `settleCap` / `__setSettleCapForTest`,
3138-3143) or itself `__`-prefixed and `@internal`-tagged (the roughly ten
`ForTest`-suffixed methods this review also cites in finding 4's neighborhood).
`arenaInitInts` alone follows neither convention, so a reader of the public
class surface can't tell whether it's a supported production tuning knob
(like `index.ts`'s `configure({ initialRecords })`) or a test-only lever.

**Simpler general form.** Either give it a `configure()`-style production
setter (if it's meant to be app-tunable) or make it `private` with a
`__setArenaInitIntsForTest()` mutator, matching `settleCap`.

**Cost.** None — a naming/visibility fix, not a behavior change.

**Verdict: QUESTION** — which convention applies is a product decision I
shouldn't guess at.

### 10. Two declared protocol hooks are never wired

**What.** `packages/cosignal-react/types/react-fork.d.ts:18-19` declares
`onBeforeMutation`/`onAfterMutation` on the external-runtime protocol;
`shim.ts`'s `unstable_subscribeToExternalRuntime({...})` call (221-230)
wires the other six listeners but never mentions these two.

**Cost.** None either way — this is documenting a *host* protocol surface,
not cosignal's own design, so declaring more than this driver currently uses
may be intentional forward documentation.

**Verdict: QUESTION** — worth a one-line "unused by this driver" comment if
that's deliberate, otherwise harmless as-is.

## Already minimal (checked, no finding)

- `cosignal/src/trace.ts` — single-purpose encode/decode module; the
  `event()`/`decode()` switch-per-kind pairing is an intentional dual (one
  encodes, one decodes the same record), not accidental duplication.
- `cosignal/src/graphviz.ts` — two small pure rendering functions, no shared
  state, nothing to collapse.
- `cosignal-oracle/src/invariants.ts` — six named checks, 1:1 with the six
  contract clauses stated in the package README; already the minimal
  decomposition, not a special-case pile.
- `cosignal-oracle/src/adapter.ts` — a ~140-line diff harness with no special
  cases at all.
- The kernel/policy split in `cosignal/src/index.ts` (the file's own header
  vocabulary) — policy-and-mechanism separation already applied on purpose:
  monomorphic integer ops in the kernel, ordinary cold JS for equality/errors/
  suspension/observed-lifecycle in the policy layer, enforced behaviorally by
  `tests/one-core.spec.ts`.
- The `__`-prefixed / `ForTest`-suffixed seams throughout `concurrent.ts` —
  consistently named, narrowly scoped, doc-commented, and (`arenaInitInts`
  aside, finding 9) zero-cost when unused. Hunt item 5 ("test-only
  affordances in runtime") came back essentially clean.
- `mountFixup`'s four-conjunct fast path (`concurrent.ts:5192-5259`, mirrored
  in `model.ts:1303-1385`) reads like over-engineering at first glance, but
  each conjunct is individually fuzz-motivated (`tests/FLAGS.md`, flag 5) and
  the fast path carries its own runtime soundness audit that throws
  `BridgeInvariantViolation` if it is ever unsound. I challenged this one
  directly (hunting for hunt item 3, "deep nesting a representation change
  would flatten") and it held up: flattening it would remove the audit's
  ability to name which conjunct failed, for a domain-inherent (React
  concurrent-rendering) piece of state, not an accidental one.

## Ranked one-liners

1. QUESTION — kernel push-pull algorithm hand-duplicated in the shadow
   arenas (~300-375 lines/side); already caused one real bug (fuzz seed 40);
   keep it, but stop relying on fuzzing alone to catch the next drift.
2. SAFE — 5 public bridge operations repeat an opDepth/try-finally/
   arenaOpEpilogue shell and a 9-times-repeated opEnd+flushNotify tail;
   extract `runOp`/`endOp` (~20-25 lines deleted).
3. SAFE — `mustGet(map, id, what)` collapses 6 dedicated + 4 inline
   "look up or throw" sites across `concurrent.ts` and `model.ts` (~20 lines).
4. SAFE — `pickId(ids, index, what)` collapses schedule.ts's
   tokenAt/passAt/watcherAt/effectAt into one generic function (~15 lines).
5. SAFE — Shim's onDelivery/onMountCorrective/onCorrection should call the
   Shim's own existing `guard()` instead of re-rolling try/catch (also fixes
   a missing disposed-check).
6. SAFE — `kernelTrackedReader`/`kernelUntrackedReader` share an 8-line body;
   extract `kernelReadDep()` (~8 lines).
7. SAFE — extend the existing `aPropagateBoth`/`aShallowBoth` pattern to the
   3 remaining hand-rolled "walk both subs lists" sites (~10-12 lines).
8. QUESTION — Atom/Computed's 4 host-seam checks sit on the hottest path in
   the library; benchmark before touching, don't merge blind.
9. QUESTION — `arenaInitInts` is the one test-knob that doesn't follow the
   class's own `__...ForTest` naming convention; rename or promote it.
10. QUESTION — two declared-but-unwired protocol hooks in `react-fork.d.ts`;
    likely fine, worth a one-line comment if deliberate.


**What.** `packages/cosignal-react/src/shim.ts:200-220` — `bridge.onDelivery`,
`bridge.onMountCorrective`, `bridge.onCorrection` each hand-roll
`try { this.bumpInBatch(...) } catch (error) { this.errors.push(error); }`.
The identical policy already exists as `private guard(fn)` at
`shim.ts:247-254` (used for the six `unstable_subscribeToExternalRuntime`
listeners a few lines below) — with one extra check the ad hoc copies lack:
`if (this.disposed) return;`.

**Why complex.** One error-handling policy, written twice, and the second
writing is missing a guard the first has. Not a live bug today —
`bumpInBatch` degrades safely post-dispose because `dispose()` clears
`this.targets`, so the call becomes a no-op — but it is exactly the kind of
divergence that stops being harmless the next time either function changes.

**Simpler general form.**
`bridge.onDelivery = (w, token) => this.guard(() => this.bumpInBatch(w.id, token.id));`
(same shape for the other two). Deletes 6 lines and closes the disposed-check gap.

**Cost.** None; `packages/cosignal-react/tests/*.spec.tsx` (62 passing,
reverified above) drive `onDelivery`/`onMountCorrective`/`onCorrection`
through real render/commit cycles.

**Verdict: SAFE-SIMPLIFICATION.**
